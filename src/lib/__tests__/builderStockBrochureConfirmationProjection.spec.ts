/**
 * "USE BROCHURE IMAGE" — what the builder's screen is told, and what a card
 * may be drawn from, once a confirmation exists.
 *
 * The held-out suites fixed the rules before the code; these pin the parts the
 * implementation had to decide: which mismatch offers the choice, what a
 * confirmation reads as on a row that no longer links its brochure, and that a
 * picture reached under a confirmation stands only while the confirmation does.
 */
import { describe, expect, it } from 'vitest';

import {
  brochureConfirmationStates, brochureConfirmationViews, withConfirmationChoices,
  STOCK_BROCHURE_CONFIRMATION_COPY, type StockDocumentNote,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  keepStanding, standingUnderConfirmations, isMissingConfirmationsTable, confirmationsByItem,
} from '../../../supabase/functions/_shared/builderStock/brochureConfirmation';
import {
  electionProtocolFor, OLDEST_PDF_ELECTION_PROTOCOL, PDF_ELECTION_PROTOCOL,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';

const OWN = 'https://drive.google.com/file/d/1Qx7brochureLot2046aB/view?usp=drive_link';
const SIBLING = 'https://drive.google.com/file/d/1SiblingBrochureLot3185x/view?usp=drive_link';
const FOLDER = 'https://drive.google.com/drive/folders/1Fo1derOfLotBrochures9';

const mismatch = (key: string, states: string): StockDocumentNote => ({
  document: 'A document on drive.google.com',
  detail: 'That document does not present a page as this property’s package cover.',
  finding: 'identity_mismatch',
  states,
  quote: `PACKAGE PRICE${states}`,
  document_key: key,
});

const recovered = { result: 'image_recovered', provenance_version: 27 };

describe('which mismatch offers "Use brochure image"', () => {
  const listings = [
    {
      id: 'item-3185', lot_number: '3185', house_design: 'Halo 24', lifecycle_status: 'active',
      suburb: 'Wattlebank', source_provenance_result: { branches: { [SIBLING]: recovered } },
    },
    {
      id: 'item-2064', lot_number: '2064', house_design: 'Juniper 18', lifecycle_status: 'staged',
      suburb: 'Wattlebank', source_provenance_result: { branches: {} },
    },
  ];

  it('offers it on the builder\'s own brochure and names nothing else', () => {
    const [note] = withConfirmationChoices([mismatch(OWN, 'Lot 3999')], {
      stockItemId: 'item-2046', suburb: 'Wattlebank', listings,
    });
    expect(note.confirmable).toBe(true);
    expect(note.in_use_by).toBeUndefined();
    expect(note.stated_lot_listing).toBeUndefined();
  });

  it('refuses it where another listing already uses the brochure, and names that listing', () => {
    const [note] = withConfirmationChoices([mismatch(SIBLING, 'Lot 3185')], {
      stockItemId: 'item-3158', suburb: 'Wattlebank', listings,
    });
    expect(note.confirmable).toBe(false);
    expect(note.in_use_by).toEqual({ stock_item_id: 'item-3185', identity: 'Lot 3185 · Halo 24' });
    // The refusal already names the listing; a caution beside it would repeat it.
    expect(note.stated_lot_listing).toBeUndefined();
  });

  it('cautions, and still offers, where a listing merely has the stated lot', () => {
    const [note] = withConfirmationChoices([mismatch(OWN, 'Lot 2064')], {
      stockItemId: 'item-2046', suburb: 'Wattlebank', listings,
    });
    expect(note.confirmable).toBe(true);
    expect(note.stated_lot_listing).toEqual({ stock_item_id: 'item-2064', identity: 'Lot 2064 · Juniper 18' });
  });

  it('never offers it on a folder, whose file is chosen by the listing\'s own lot', () => {
    const [note] = withConfirmationChoices([mismatch(FOLDER, 'Lot 2064')], {
      stockItemId: 'item-2046', listings,
    });
    expect(note.confirmable).toBe(false);
  });

  it('offers it where the listings could not be read, because the act re-checks them', () => {
    const [note] = withConfirmationChoices([mismatch(OWN, 'Lot 3185')], {
      stockItemId: 'item-2046', listings: null,
    });
    expect(note.confirmable).toBe(true);
    expect(note.in_use_by).toBeUndefined();
    expect(note.stated_lot_listing).toBeUndefined();
  });

  it('GUARD — leaves every other note exactly as it was', () => {
    const plain: StockDocumentNote = { document: 'Plan.pdf', detail: 'no photograph in it' };
    const [note] = withConfirmationChoices([plain], { stockItemId: 'item-1', listings });
    expect(note).toEqual(plain);
  });
});

describe('a confirmation on a row that no longer links its brochure', () => {
  const confirmation = { id: 'conf-1', document: OWN, lot: '2064' };
  const stored = { branches: { [OWN]: { result: 'no_deterministic_image', exhaustion: 'inspected' } } };

  it('says so, rather than reading "pending" about a brochure nothing will read', () => {
    const [reading] = brochureConfirmationStates(stored, [confirmation], {
      linkedDocuments: new Set([SIBLING]),
    });
    expect(reading.state).toBe('unlinked');
    expect(STOCK_BROCHURE_CONFIRMATION_COPY.unlinked).toMatch(/no longer linked/);
  });

  it('reads as it always did while the row still links it', () => {
    const [reading] = brochureConfirmationStates(stored, [confirmation], {
      linkedDocuments: new Set([OWN]),
    });
    expect(reading.state).toBe('pending');
  });

  it('says nothing about links it was not told', () => {
    const [reading] = brochureConfirmationStates(stored, [confirmation]);
    expect(reading.state).toBe('pending');
  });

  it('names the document and the lot the way the rest of the page does', () => {
    const [view] = brochureConfirmationViews(stored, [{
      ...confirmation, confirmed_by: 'Alex Builder', confirmed_at: '2026-09-24T09:30:00.000Z',
    }]);
    expect(view).toMatchObject({
      id: 'conf-1', document: 'A document on drive.google.com', document_key: OWN,
      lot: '2064', states: 'Lot 2064', confirmed_by: 'Alex Builder', state: 'pending',
    });
  });
});

describe('a picture reached under a confirmation stands only while it does', () => {
  const plain = { id: 'a', source_detail: { role: 'primary_property' } };
  const stamped = (id: string) => ({
    id: `img-${id}`, source_detail: { role: 'primary_property', identity_confirmation: { id, lot: '2064' } },
  });

  it('keeps every image nobody confirmed, and only the stamps that stand', () => {
    expect(keepStanding([plain, stamped('live'), stamped('undone')], new Set(['live'])))
      .toEqual([plain, stamped('live')]);
  });

  it('asks nothing where no image carries a stamp', async () => {
    const db = { from: () => { throw new Error('no query may be made'); } };
    const result = await standingUnderConfirmations(db, 'item-1', [plain]);
    expect(result).toEqual({ rows: [plain], unknown: false });
  });

  const answering = (answer: { data?: unknown; error?: unknown }) => ({
    from: () => ({ select: () => ({ eq: () => ({ is: async () => answer }) }) }),
  });

  it('drops a stamp whose confirmation has been undone', async () => {
    const result = await standingUnderConfirmations(
      answering({ data: [{ id: 'live' }], error: null }), 'item-1',
      [plain, stamped('live'), stamped('undone')]);
    expect(result).toEqual({ rows: [plain, stamped('live')], unknown: false });
  });

  it('decides nothing where the check could not be made', async () => {
    const rows = [plain, stamped('live')];
    const result = await standingUnderConfirmations(
      answering({ data: null, error: { code: '57014', message: 'canceling statement' } }), 'item-1', rows);
    expect(result.unknown).toBe(true);
    expect(result.rows).toEqual(rows);
  });

  it('reads a table that does not exist yet as "nobody has confirmed anything"', async () => {
    expect(isMissingConfirmationsTable({ code: 'PGRST205', message: 'x' })).toBe(true);
    expect(isMissingConfirmationsTable({ code: '42P01' })).toBe(true);
    expect(isMissingConfirmationsTable({ code: '57014', message: 'timeout' })).toBe(false);
    const result = await standingUnderConfirmations(
      answering({ data: null, error: { code: 'PGRST205', message: 'not in the schema cache' } }),
      'item-1', [plain, stamped('live')]);
    expect(result).toEqual({ rows: [plain], unknown: false });
  });
});

describe('the settler\'s view of the confirmations', () => {
  it('groups them by property and link, and drops anything it cannot vouch for', () => {
    const byItem = confirmationsByItem([
      { id: 'c1', stock_item_id: 'i1', document_reference: OWN, confirmed_lot: '2064',
        confirmed_by_name: 'A', confirmed_at: '' },
      { id: 'c2', stock_item_id: 'i1', document_reference: SIBLING, confirmed_lot: 'Lot 9',
        confirmed_by_name: 'A', confirmed_at: '' },
    ]);
    expect(byItem.get('i1')?.get(OWN)).toEqual({ id: 'c1', lot: '2064' });
    expect(byItem.get('i1')?.has(SIBLING)).toBe(false);
  });
});

describe('the protocol an election is asked under', () => {
  it('is the oldest for any context that confirms nothing, whatever else it carries', () => {
    expect(electionProtocolFor({})).toBe(OLDEST_PDF_ELECTION_PROTOCOL);
    expect(electionProtocolFor({ label: 'Lot 1', confirmedLots: [] })).toBe(OLDEST_PDF_ELECTION_PROTOCOL);
    expect(electionProtocolFor({ confirmedLots: 'not a list' })).toBe(OLDEST_PDF_ELECTION_PROTOCOL);
  });

  it('is the newest only where a confirmation is carried', () => {
    expect(electionProtocolFor({ confirmedLots: ['2064'] })).toBe(PDF_ELECTION_PROTOCOL);
  });
});
