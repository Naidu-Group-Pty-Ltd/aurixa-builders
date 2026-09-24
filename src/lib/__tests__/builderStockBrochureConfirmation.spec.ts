/**
 * A BUILDER MAY CONFIRM THAT A BROCHURE IS THIS PROPERTY'S, AND THE
 * CONFIRMATION RELAXES THE LOT AND NOTHING ELSE.
 *
 * MEASURED 24 SEPTEMBER 2026. Lot 1037 · Vanta 20 links its own brochure: page
 * 2, the floor plan, states "Lot 1037" and "Vanta 20". Page 1, the cover,
 * prints "Lot 1307" — the same digits in a different order. The cover rule
 * refused it, correctly, because a cover that states another lot is exactly
 * how another house reaches a client's card, and the builder was told "Brochure
 * details don't match this property". What they could not do was say "it is
 * mine, use it".
 *
 * WHAT A CONFIRMATION IS. A builder's statement, recorded with who and when,
 * that ONE brochure linked on ONE property may designate ONE other lot. The
 * cover rule then accepts that lot as this property's — and every other test
 * it has still applies: the page must still be a package cover (two package
 * facts), still corroborate the property (its estate or suburb), still name
 * no THIRD lot of its own, and the picture still has to present one prominent
 * photograph and pass the display checks. Nothing about the document's own
 * words is changed or ignored.
 *
 * THE DATA BELOW IS INVENTED, same shape as the production document: a
 * two-page flyer whose cover transposes its lot's digits and whose floor plan
 * states the lot and the design correctly.
 *
 * Held out: written before the change, against the modules as they stand. The
 * blocks marked GUARD hold on both sides of it; the rest fail before it.
 */
import { describe, expect, it } from 'vitest';

import * as cover from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';
import * as wire from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';
import * as negative from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import * as branches from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import * as evidence from '../../../supabase/functions/_shared/builderStock/suppliedEvidence.pure';
import * as progress from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import { PROVENANCE_VERSION } from '../../../supabase/functions/_shared/builderStock/provenanceVersion.pure';
import { RUNTIME_VERSION } from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The new parameters are passed to functions whose declared signatures do not
// have them yet — that is what makes this file a held-out test.
const c = cover as any;

// ---------------------------------------------------------------------------
// The invented listing and its brochure
// ---------------------------------------------------------------------------

/** `stockRecordLabel` of a row with a lot and a suburb and no address line. */
const LABEL = 'Lot 2046, Brindabella Park';
const HINTS = ['Kestrel Rise'];
const DESIGN = 'Orion 22';

/** The cover: the lot's digits transposed, everything else right. */
const COVER = [
  'PACKAGE PRICELot 2064 Saltbush Street,',
  'Kestrel Rise',
  'FULL TURNKEY INCLUSIONS',
  'House & Land Package',
  '$612,500',
  'Land Size 350m2',
  '4 Bed 2 Bath 2 Car',
].join('\n');

/** The floor plan: the lot and the design, correctly, and one package fact. */
const PLAN = [
  'Lot 2046 ORION 22 Kestrel Rise',
  'GARAGE MASTER BED 1 KITCHEN LIVING MEALS',
  'Land Size 350m2',
].join('\n');

const PAGES = [COVER, PLAN];

// ---------------------------------------------------------------------------

describe('GUARD — without a confirmation the rule is exactly as it was', () => {
  it('refuses the transposed cover and finds no cover page at all', () => {
    expect(cover.findPropertyCoverPages(PAGES, LABEL, HINTS)).toEqual([]);
    expect(cover.coverIdentityRefusal(COVER, LABEL, HINTS)).toBe('the page does not state this lot');
    expect(cover.coverSearchPages({ label: LABEL, pageTexts: PAGES, design: DESIGN, identityHints: HINTS }))
      .toEqual([]);
  });

  it('still names the lot the cover states instead', () => {
    expect(cover.statedOtherLotDesignation(COVER, LABEL)).toBe('2064');
  });

  it('an empty confirmation changes nothing', () => {
    expect(c.findPropertyCoverPages(PAGES, LABEL, HINTS, false, [])).toEqual([]);
    expect(c.coverIdentityRefusal(COVER, LABEL, HINTS, false, [])).toBe('the page does not state this lot');
    expect(c.statedOtherLotDesignation(COVER, LABEL, [])).toBe('2064');
  });
});

describe('with the lot the builder confirmed, the cover is this property\'s', () => {
  it('finds the cover page', () => {
    const found = c.findPropertyCoverPages(PAGES, LABEL, HINTS, false, ['2064']);
    expect(found.map((p: { page: number }) => p.page)).toEqual([1]);
  });

  it('refuses it for no reason', () => {
    expect(c.coverIdentityRefusal(COVER, LABEL, HINTS, false, ['2064'])).toBeNull();
  });

  it('is searched, so its pictures are decoded', () => {
    expect(c.coverSearchPages({
      label: LABEL, pageTexts: PAGES, design: DESIGN, identityHints: HINTS,
      confirmedLots: ['2064'],
    })).toEqual([1]);
  });

  it('recognises the confirmed lot however the cover typesets it', () => {
    // Glued to the heading (above), set on its own line, or split by the
    // exporter into two runs: the builder confirmed the NUMBER.
    const own = COVER.replace('PACKAGE PRICELot 2064', 'PACKAGE PRICE\nLot 2064');
    const split = COVER.replace('PACKAGE PRICELot 2064', 'PACKAGE PRICE\nLot 206 4');
    for (const page of [own, split]) {
      expect(c.findPropertyCoverPages([page, PLAN], LABEL, HINTS, false, ['2064'])
        .map((p: { page: number }) => p.page), page).toEqual([1]);
    }
  });

  it('no longer reports the confirmed lot as another property\'s', () => {
    expect(c.statedOtherLotDesignation(COVER, LABEL, ['2064'])).toBeNull();
  });

  it('elects the cover\'s photograph and says in the record that the builder confirmed it', () => {
    const roles = c.assignPdfMediaRoles({
      label: LABEL,
      pageTexts: PAGES,
      pageOrderAuthoritative: true,
      media: [
        { page: 1, name: 'Im0', placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.58 },
        { page: 2, name: 'Im1', placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.61 },
      ],
      visualKinds: ['photo', 'floorplan'],
      design: DESIGN,
      identityHints: HINTS,
      confirmedLots: ['2064'],
    });
    expect(roles[0].role).toBe('primary_property');
    expect(roles[1].role).not.toBe('primary_property');
    // The page states 2064; the record must not claim it stated 2046.
    expect(roles[0].evidence).toContain('2064');
    expect(roles[0].evidence).toContain('confirmed by the builder');
  });
});

describe('GUARD — the confirmation relaxes the lot and nothing else', () => {
  it('a THIRD lot on the page is still another property', () => {
    const page = `${COVER}\nLot 3001 Saltbush Street`;
    expect(c.findPropertyCoverPages([page], LABEL, HINTS, false, ['2064'])).toEqual([]);
  });

  it('however the third lot is typeset', () => {
    // The reading that accepts a glued confirmed lot must also SEE a glued
    // lot that is nobody's, or a confirmation would widen what a page may say.
    const page = `${COVER}\nRELEASE PRICELot 3001 Saltbush Street`;
    expect(c.findPropertyCoverPages([page], LABEL, HINTS, false, ['2064'])).toEqual([]);
  });

  it('the page must still corroborate the property', () => {
    const bare = COVER.replace('Kestrel Rise', 'Somewhere Else');
    expect(c.findPropertyCoverPages([bare], LABEL, HINTS, false, ['2064'])).toEqual([]);
  });

  it('the page must still be a package cover', () => {
    const thin = 'Lot 2064 Saltbush Street, Kestrel Rise\nArtist impression only';
    expect(c.findPropertyCoverPages([thin], LABEL, HINTS, false, ['2064'])).toEqual([]);
  });

  it('a confirmation of one lot is not a confirmation of another', () => {
    expect(c.findPropertyCoverPages(PAGES, LABEL, HINTS, false, ['2604'])).toEqual([]);
    expect(c.statedOtherLotDesignation(COVER, LABEL, ['2604'])).toBe('2064');
  });

  it('a confirmation is digits, never a word a page could echo', () => {
    for (const lots of [['lot'], ['Kestrel'], [''], ['2064a']]) {
      expect(c.findPropertyCoverPages(PAGES, LABEL, HINTS, false, lots), JSON.stringify(lots))
        .toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// THE WIRE — the rules run in the PDF worker, which deploys on its own lane
// ---------------------------------------------------------------------------

const CONTEXT = {
  label: LABEL,
  identifiedBy: 'direct_link' as const,
  design: DESIGN,
  identityHints: HINTS,
  documentName: 'the linked document',
  url: 'https://drive.google.com/uc?export=download&id=fixture-2046',
};
const decode = (raw: string) => wire.decodeElectionContext(raw) as any;
const encoded = (fields: Record<string, unknown>) => wire.bytesToBase64(
  new TextEncoder().encode(JSON.stringify({
    ...CONTEXT, provenanceVersion: PROVENANCE_VERSION, ...fields,
  })));

describe('GUARD — an election with no confirmation is asked exactly as before', () => {
  it('is sent under protocol 2, which every deployed worker speaks', () => {
    expect(decode(wire.encodeElectionContext(CONTEXT))?.protocol).toBe(2);
  });
});

describe('an election under a confirmation carries the lot and says so', () => {
  it('speaks protocol 3', () => {
    expect(wire.PDF_ELECTION_PROTOCOL).toBe(3);
  });

  it('is sent under protocol 3 with the confirmed lot', () => {
    const decoded = decode((wire.encodeElectionContext as any)({ ...CONTEXT, confirmedLots: ['2064'] }));
    expect(decoded?.protocol).toBe(3);
    expect(decoded?.confirmedLots).toEqual(['2064']);
  });

  it('a worker built now still answers an election asked under protocol 2', () => {
    const decoded = decode(encoded({ protocol: 2 }));
    expect(decoded).not.toBeNull();
    expect(decoded.protocol).toBe(2);
    expect(decoded.confirmedLots).toEqual([]);
  });

  it('a protocol-2 context cannot smuggle a confirmation', () => {
    expect(decode(encoded({ protocol: 2, confirmedLots: ['2064'] }))?.confirmedLots).toEqual([]);
  });

  it('a protocol-3 context with no confirmation is accepted', () => {
    expect(decode(encoded({ protocol: 3 }))?.confirmedLots).toEqual([]);
  });

  it('refuses a confirmation it cannot vouch for rather than electing without it', () => {
    for (const confirmedLots of [
      ['20a4'], ['123456'], [2064], '2064', ['1', '2', '3', '4', '5'], [''], [null],
    ]) {
      expect(decode(encoded({ protocol: 3, confirmedLots })), JSON.stringify(confirmedLots))
        .toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// WHICH STORED ANSWERS A CONFIRMATION REOPENS
// ---------------------------------------------------------------------------

const URL = 'https://drive.google.com/file/d/fixture-2046/view?usp=drive_link';
const QUESTION = {
  provenanceVersion: PROVENANCE_VERSION,
  runtimeVersion: RUNTIME_VERSION,
  packageReference: URL,
  sourceAnchor: null,
};
const MISMATCH = negative.recordNoDeterministicImage(QUESTION,
  'That document does not present a page as this property\'s package cover, so it names '
    + 'no image for it. Its first page reads “PACKAGE PRICELot 2064 Saltbush Street,”.',
  'inspected', () => new Date('2026-09-24T00:00:00.000Z'),
  {
    finding: negative.DOCUMENT_IDENTITY_MISMATCH,
    evidence: { states: 'Lot 2064', quote: 'PACKAGE PRICELot 2064 Saltbush Street,' },
  });
const PLAIN_REFUSAL = negative.recordNoDeterministicImage(QUESTION,
  'Every picture on the property cover is a plan or a graphic.', 'inspected');
const OPERATIONAL = negative.recordNoDeterministicImage(QUESTION, 'a timeout', 'operational');

const confirmed = (id: string, lot = '2064') => ({ id, lot });
const stamped = (record: object, id: string, lot = '2064') => ({
  ...record, identity_confirmation: { id, lot },
});
const stands = (record: unknown, identityConfirmation?: unknown) =>
  negative.negativeProvenanceStillStands(record, { ...QUESTION, identityConfirmation } as any);

describe('GUARD — no confirmation, no change', () => {
  it('every banked answer stands as it did', () => {
    expect(stands(MISMATCH)).toBe(true);
    expect(stands(PLAIN_REFUSAL)).toBe(true);
    expect(stands(OPERATIONAL)).toBe(true);
  });

  it('a confirmation reopens nothing it is not about', () => {
    // Another lot: the refusal on record is not the one the builder confirmed.
    expect(stands(MISMATCH, confirmed('c1', '2604'))).toBe(true);
    // A refusal that was never about identity, and our own failure.
    expect(stands(PLAIN_REFUSAL, confirmed('c1'))).toBe(true);
    expect(stands(OPERATIONAL, confirmed('c1'))).toBe(true);
  });

  it('an answer reached under a confirmation stands while it holds', () => {
    expect(stands(stamped(PLAIN_REFUSAL, 'c1'), confirmed('c1'))).toBe(true);
  });
});

describe('a confirmation reopens exactly the refusal it is about', () => {
  it('the mismatch the builder confirmed is asked again', () => {
    expect(stands(MISMATCH, confirmed('c1'))).toBe(false);
  });

  it('an answer reached under a confirmation that no longer holds is asked again', () => {
    // Undone.
    expect(stands(stamped(PLAIN_REFUSAL, 'c1'), null)).toBe(false);
    // Replaced by another.
    expect(stands(stamped(PLAIN_REFUSAL, 'c1'), confirmed('c2'))).toBe(false);
  });
});

describe('the settler and the evidence reader agree about the branch', () => {
  const branch = { url: URL, column: 'Brochure URL', kind: 'drive_file' as const };
  const store = (record: object) => ({ branches: { [URL]: record } });
  const recovered = branches.recordImageRecovered(QUESTION, 'the linked document#page1:Im0');
  const active = (id: string) => new Map([[URL, confirmed(id)]]);
  const open = (stored: unknown, confirmations?: unknown) => (branches.openBranches as any)(
    stored, [branch], PROVENANCE_VERSION, null, RUNTIME_VERSION, confirmations);
  const read = (stored: unknown, identityConfirmations?: unknown) =>
    evidence.readSuppliedEvidence({
      branches: [branch], stored, provenanceVersion: PROVENANCE_VERSION,
      runtimeVersion: RUNTIME_VERSION, sourceAnchor: null, identityConfirmations,
    } as any).state;

  it('GUARD — unconfirmed, the mismatch is finished and the property exhausted', () => {
    expect(open(store(MISMATCH))).toEqual([]);
    expect(read(store(MISMATCH))).toBe('exhausted');
  });

  it('confirmed, the mismatch is open again for BOTH readers', () => {
    expect(open(store(MISMATCH), active('c1'))).toEqual([branch]);
    expect(read(store(MISMATCH), active('c1'))).toBe('pending');
  });

  it('GUARD — a picture delivered under a confirmation that holds is finished', () => {
    expect(open(store(stamped(recovered, 'c1')), active('c1'))).toEqual([]);
    expect(read(store(stamped(recovered, 'c1')), active('c1'))).toBe('exhausted');
  });

  it('a picture delivered under an undone confirmation is open again for BOTH readers', () => {
    expect(open(store(stamped(recovered, 'c1')), new Map())).toEqual([branch]);
    expect(read(store(stamped(recovered, 'c1')), new Map())).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// WHAT THE BUILDER'S SCREEN IS TOLD
// ---------------------------------------------------------------------------

describe('the note carries what a confirmation needs, and only on a mismatch', () => {
  const store = (record: object) => ({ branches: { [URL]: record } });

  it('a mismatch note names the link it is about, so the builder can confirm it', () => {
    const [note] = progress.stockDocumentNotes(store(MISMATCH)) as any[];
    expect(note.finding).toBe('identity_mismatch');
    expect(note.document_key).toBe(URL);
  });

  it('GUARD — any other note is exactly what it was', () => {
    expect(progress.stockDocumentNotes(store(PLAIN_REFUSAL))).toEqual([{
      document: 'A document on drive.google.com',
      detail: 'Every picture on the property cover is a plan or a graphic.',
    }]);
  });

  it('a mismatch the builder has confirmed is not shown as a mismatch any more', () => {
    const notes = (progress.stockDocumentNotes as any)(store(MISMATCH), undefined, {
      confirmations: [{ id: 'c1', document: URL, lot: '2064' }],
    });
    expect(notes).toEqual([]);
  });

  it('a confirmation reads as waiting, used, or not used', () => {
    const states = (progress as any).brochureConfirmationStates;
    expect(typeof states).toBe('function');
    const conf = [{ id: 'c1', document: URL, lot: '2064' }];
    expect(states(store(MISMATCH), conf)[0].state).toBe('pending');
    expect(states(store(stamped(recovered(), 'c1')), conf)[0].state).toBe('applied');
    const refused = states(store(stamped(PLAIN_REFUSAL, 'c1')), conf)[0];
    expect(refused.state).toBe('not_applied');
    expect(refused.detail).toBe('Every picture on the property cover is a plan or a graphic.');
    // A record reached under ANOTHER confirmation says nothing about this one.
    expect(states(store(stamped(recovered(), 'c0')), conf)[0].state).toBe('pending');
  });

  function recovered() {
    return branches.recordImageRecovered(QUESTION, 'the linked document#page1:Im0');
  }
});
