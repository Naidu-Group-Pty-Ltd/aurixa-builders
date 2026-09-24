/**
 * "BROCHURE DETAILS DON'T MATCH THIS PROPERTY" — the one refusal a builder
 * can fix, said in words that name the fix.
 *
 * THE DEFECT. `Lot 1037 · VANTA 20` links a brochure that reads `NEX 20 —
 * Lot 1307 Fuchsia Street`: a second copy of the sibling row's file. The
 * election opened it, read it to the end, correctly refused to put another
 * house's facade on this card, and recorded exactly that. What the builder
 * was shown was a chip reading "No picture found" over a line of grey prose —
 * the same thing a brochure with no photograph in it shows, and the same
 * thing a brochure of floor plans shows. Three different problems, one shrug,
 * and only one of the three is something the person holding the sheet can
 * correct in a minute.
 *
 * WHAT IS ASSERTED HERE. That the mismatch is drawn prominently against the
 * property with both identities beside each other and a step to take; that
 * the OTHER refusals keep exactly the wording they have; and that nothing in
 * this change can move which images are accepted.
 *
 * THE CLASS COMES FROM THE SERVER AS A CODE. Nothing in the component reads
 * the recorded sentence to decide what to draw — a rule spelled in prose is
 * one nobody can see and every rewording breaks — so the tests drive the
 * component with the field the pipeline writes, and drive that field with the
 * pipeline's own classifier.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BuilderStockItem } from '@/lib/builderStock';
import { stockItemIdentity } from '@/lib/builderStock';
import {
  hasDocumentIdentityMismatch, stockDocumentNotes, STOCK_DOCUMENT_MISMATCH_COPY,
} from '../../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  statedOtherLotDesignation,
} from '../../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';
import {
  DOCUMENT_IDENTITY_MISMATCH, recordNoDeterministicImage,
} from '../../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';

// ---------------------------------------------------------------------------
// The page, with its data replaced and nothing else.
// ---------------------------------------------------------------------------

/*
 * `vi.mock` factories are hoisted above every top-level binding, so the
 * mutable record the tests swap lives in `vi.hoisted` and everything else is
 * built inside the factory. Only the DATA is replaced: the page, its layout,
 * its copy and every rule it draws are the real ones.
 */
const state = vi.hoisted(() => ({
  held: [] as unknown[],
  confirmCalls: [] as unknown[],
  undoCalls: [] as unknown[],
}));

vi.mock('@/lib/builderStockQueries', () => {
  const noop = () => {};
  const idle = {
    mutate: noop, mutateAsync: async () => undefined, isPending: false, reset: noop,
  };
  const mutation = () => idle;
  return {
    useBuilderStockItems: () => ({
      data: { records: [], pagination: { total: 0, page: 1, page_size: 25 } },
      isLoading: false, isError: false,
    }),
    useBuilderStockHeldItems: () => ({ data: { records: state.held }, refetch: noop }),
    useBuilderStockUploads: () => ({
      data: { records: [], pagination: { total: 0, page: 1, page_size: 25 } },
      refetch: noop, isError: false, isLoading: false,
    }),
    useBuilderStockSelections: () => ({
      data: { records: [], pagination: { total: 0, page: 1, page_size: 25 } },
    }),
    useBuilderStockImageProgress: () => ({
      data: {
        records: [{
          upload_id: 'upload-1', total: 2, photos_ready: 1, failed: 1,
          working: 0, published: false,
        }],
      },
    }),
    useAcknowledgeStockSelection: mutation,
    useArchiveBuilderStockItem: mutation,
    useDeleteBuilderStockSource: mutation,
    useEnrichPendingStockImages: mutation,
    useRecoverStockSourceImages: mutation,
    useRefreshBrochureLinks: mutation,
    useReprocessStockSource: mutation,
    useRetryStockSource: mutation,
    useSetBuilderStockAvailability: mutation,
    useSetBuilderStockManualStats: mutation,
    useSupplyBuilderStockImage: mutation,
    useConfirmBrochureImage: () => ({
      ...idle,
      mutate: (vars: unknown, options?: { onSuccess?: () => void }) => {
        state.confirmCalls.push(vars);
        options?.onSuccess?.();
      },
    }),
    useUndoBrochureImage: () => ({
      ...idle,
      mutate: (vars: unknown, options?: { onSuccess?: () => void }) => {
        state.undoCalls.push(vars);
        options?.onSuccess?.();
      },
    }),
    importBuilderStockUrl: noop,
    uploadBuilderStockFile: noop,
    builderStockImageUrl: () => null,
  };
});
vi.mock('@/components/builder-portal/BuilderPortalShell', () => ({
  BuilderPortalShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));

// eslint-disable-next-line import/first
import BuilderStockList from '../BuilderStockList';

type Note = NonNullable<BuilderStockItem['source_document_notes']>[number];

/** The production row, as the portal projects it. */
const lot1037 = (notes: Note[]): BuilderStockItem => ({
  id: 'item-1037',
  organisation_id: 'org-1',
  address_line: 'Lot 1037 Wollert Rise',
  lot_number: '1037',
  house_design: 'VANTA 20',
  suburb: 'Wollert', state: 'VIC', postcode: '3750',
  development_name: 'Wollert Rise',
  lifecycle_status: 'staged',
  primary_image_id: null,
  image_work_stage: 'settled',
  source_documents: 1,
  source_documents_unprocessed: 0,
  source_documents_unreachable: 0,
  source_document_notes: notes,
  images: [],
} as unknown as BuilderStockItem);

function draw(items: BuilderStockItem[]) {
  state.held = items;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><BuilderStockList /></QueryClientProvider>,
  );
}

/** The whole rendered page as a person reads it, whitespace collapsed. */
const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------

describe('a brochure that names a different property says so', () => {
  const mismatch: Note = {
    document: 'Lot-1307-Fuchsia-NEX-20.pdf',
    detail: 'That document does not present a page as this property’s package cover, '
      + 'so it names no image for it. Its first page reads “NEX 20 — Lot 1307 '
      + 'Fuchsia Street”.',
    finding: 'identity_mismatch',
    states: 'Lot 1307',
    quote: 'NEX 20 — Lot 1307 Fuchsia Street',
  };

  it('1 — Lot 1037 / VANTA 20 against a brochure page reading Lot 1307 / NEX 20', () => {
    draw([lot1037([mismatch])]);
    const text = pageText();

    expect(text).toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
    expect(text).toContain(STOCK_DOCUMENT_MISMATCH_COPY.body);
    expect(text).toContain(STOCK_DOCUMENT_MISMATCH_COPY.action);
  });

  it('2 — surfaces BOTH identities, so the error is obvious without opening the file', () => {
    draw([lot1037([mismatch])]);
    const text = pageText();

    // The listing's own, composed from the row rather than from the document.
    expect(text).toContain('Lot 1037 · VANTA 20');
    // And what the document says instead, in the words the election recorded.
    expect(text).toContain('Lot 1307');
    expect(text).toContain('NEX 20 — Lot 1307 Fuchsia Street');
    expect(text).toContain(STOCK_DOCUMENT_MISMATCH_COPY.listingLabel);
    expect(text).toContain(STOCK_DOCUMENT_MISMATCH_COPY.documentLabel);
  });

  it('is drawn against the property itself, under the status chip, not in a tooltip', () => {
    draw([lot1037([mismatch])]);
    const heading = screen.getByText(STOCK_DOCUMENT_MISMATCH_COPY.heading);
    // Rendered text, not a `title` attribute on something else.
    expect(heading).toBeTruthy();
    const plate = heading.closest('.builder-stock-list-plates > li');
    expect(plate, 'the explanation is not inside the property it is about').not.toBeNull();
    const drawn = plate?.textContent ?? '';
    expect(drawn).toContain('Lot 1037, Wollert Rise \u00b7 VANTA 20');
    // The chip the builder already had is still there, and the explanation is
    // below it rather than instead of it.
    expect(drawn).toContain('No picture found');
    expect(drawn.indexOf('No picture found'))
      .toBeLessThan(drawn.indexOf(STOCK_DOCUMENT_MISMATCH_COPY.heading));
  });

  it('says nothing about the pipeline that reached it', () => {
    draw([lot1037([mismatch])]);
    const text = pageText().toLowerCase();
    for (const word of [
      'source_provenance_result', 'no_deterministic_image', 'inspected',
      'election', 'provenance', 'branch', 'exhaustion', 'identity_mismatch',
    ]) {
      expect(text, `the builder is shown the internal term "${word}"`).not.toContain(word);
    }
  });

  it('names the mismatch in the list-level warning rather than the contents', () => {
    draw([lot1037([mismatch])]);
    const text = pageText();
    expect(text).toContain('do not match');
    expect(
      text,
      'the banner still describes the document’s CONTENTS when the problem '
      + 'is which document was linked',
    ).not.toContain('name no photograph of the property');
  });
});

describe('every other refusal keeps the wording it has', () => {
  const plain = (detail: string): Note => ({ document: 'Their-brochure.pdf', detail });

  it('3 — a document we could not read shows no mismatch wording', () => {
    /*
     * An operational refusal never reaches a note at all — `stockDocumentNotes`
     * gates on `inspected`, server-side — so the row draws the counts it always
     * did and nothing else.
     */
    const item = lot1037([]);
    draw([{
      ...item, source_documents_unreachable: 1, source_document_notes: [],
    } as BuilderStockItem]);
    expect(pageText()).not.toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
  });

  it('4 — a brochure with no usable photograph shows its own reason, not a mismatch', () => {
    const detail = 'That document’s pages carry no extractable text and its first page '
      + 'presents no single photograph, so it could not be read.';
    draw([lot1037([plain(detail)])]);
    const text = pageText();
    expect(text).toContain(detail);
    expect(text).not.toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
  });

  it('5 — a plan-and-graphic-only cover shows its own reason, not a mismatch', () => {
    const detail = 'Every picture on the property cover is a plan or a graphic rather '
      + 'than a photograph of the property.';
    draw([lot1037([plain(detail)])]);
    const text = pageText();
    expect(text).toContain(detail);
    expect(text).not.toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
  });

  it('a finding with no evidence beside it is never drawn as a mismatch', () => {
    // A claim that a builder's file is the wrong file, with nothing to show
    // for it, is worse than the wording it replaces.
    draw([lot1037([{ ...plain('read in full'), finding: 'identity_mismatch' } as Note])]);
    expect(pageText()).not.toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
  });
});

// ---------------------------------------------------------------------------
// THE CLASSIFIER, AND WHAT IT MAY NEVER MOVE
// ---------------------------------------------------------------------------

describe('the classification is positive evidence or nothing', () => {
  const LABEL = 'Lot 1037, Wollert Rise, Wollert [VANTA 20]';

  it('reads the live cover, whose text layer glues the word to the run before it', () => {
    // Measured: `PACKAGE PRICELot 1307 Fuchsia Street,` — `tokenise` splits on
    // non-alphanumerics, so the token `lot` never appears and a token-only
    // read finds nothing on exactly the document this exists for.
    expect(statedOtherLotDesignation('PACKAGE PRICELot 1307 Fuchsia Street,', LABEL))
      .toBe('1307');
    expect(statedOtherLotDesignation('NEX 20\nLot 1307 Fuchsia Street', LABEL)).toBe('1307');
  });

  it('claims nothing where the page designates no lot at all', () => {
    expect(statedOtherLotDesignation('Fuchsia Street, Wollert VIC', LABEL)).toBeNull();
    expect(statedOtherLotDesignation('', LABEL)).toBeNull();
  });

  it('claims nothing where the page designates OUR lot', () => {
    expect(statedOtherLotDesignation('Lot 1037 Wollert Rise', LABEL)).toBeNull();
    // Among others, too: a page that names ours is not a mismatch claim.
    expect(statedOtherLotDesignation('Lot 1037 and Lot 1038, Wollert', LABEL)).toBeNull();
  });

  it('claims nothing where the exporter split OUR number across runs', () => {
    // `Lot 103 7` is lot 1037 typeset badly, not lot 103. The fused reading is
    // the identity rule's own, and reporting that as somebody else's lot would
    // accuse a builder of linking the wrong file over a glyph run.
    expect(statedOtherLotDesignation('Lot 103 7 Wollert Rise', LABEL)).toBeNull();
  });

  it('claims nothing where the listing names no lot to contradict', () => {
    expect(statedOtherLotDesignation('Lot 1307 Fuchsia Street', 'Wollert Rise [VANTA 20]'))
      .toBeNull();
  });

  it('reports the whole number where a page split the OTHER lot', () => {
    expect(statedOtherLotDesignation('Lot 130 7 Fuchsia Street', LABEL)).toBe('1307');
  });
});

describe('6 — nothing here can move which images are accepted or rejected', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
  const ELECTION = 'supabase/functions/_shared/builderStock/pdfElection.ts';
  const IDENTITY = 'supabase/functions/_shared/builderStock/pdfPrimaryImage.pure.ts';

  it('classifies only AFTER the refusal is already composed', () => {
    const source = read(ELECTION);
    const call = source.indexOf('statedOtherLotDesignation(pageTexts[0]');
    expect(call).toBeGreaterThan(0);
    // It is called exactly once, and inside the `not_identified` return alone.
    expect(source.match(/statedOtherLotDesignation\(/g) ?? []).toHaveLength(1);
    const refusal = source.lastIndexOf('status: \'not_identified\'', source.length);
    expect(refusal).toBeGreaterThan(call);
  });

  it('is read by nothing that decides anything', () => {
    // `pageStatesIdentity`, the cover rule and the role rules never see it.
    const identity = read(IDENTITY);
    const decision = identity.slice(0, identity.indexOf('export function statedOtherLotDesignation'));
    expect(decision).not.toContain('statedOtherLotDesignation');
    expect(decision).toContain('function pageStatesIdentity(');
    expect(decision).toContain('export function findPropertyCoverPages(');
  });

  it('adds a field to the banked record and changes no other byte of it', () => {
    const question = {
      provenanceVersion: 26, packageReference: 'https://x/y.pdf', sourceAnchor: null,
    };
    const clock = () => new Date('2026-09-20T00:00:00.000Z');
    const plain = recordNoDeterministicImage(question, 'read in full', 'inspected', clock);
    const classified = recordNoDeterministicImage(question, 'read in full', 'inspected', clock,
      { finding: DOCUMENT_IDENTITY_MISMATCH, evidence: { states: 'Lot 1307', quote: 'NEX 20' } });

    const { finding, finding_evidence: evidence, ...rest } = classified;
    expect(rest).toEqual(plain);
    expect(finding).toBe(DOCUMENT_IDENTITY_MISMATCH);
    expect(evidence).toEqual({ states: 'Lot 1307', quote: 'NEX 20' });
  });

  it('refuses a finding on an answer about OUR failure', () => {
    const record = recordNoDeterministicImage(
      { provenanceVersion: 26, packageReference: 'https://x/y.pdf', sourceAnchor: null },
      'could not be read', 'operational', () => new Date(),
      { finding: DOCUMENT_IDENTITY_MISMATCH, evidence: { states: 'Lot 1307', quote: '' } },
    );
    expect(record.finding).toBeUndefined();
    expect(record.finding_evidence).toBeUndefined();
  });
});

describe('the note carries the class out of the stored record', () => {
  const stored = (branch: Record<string, unknown>) => ({
    branches: { 'https://dropbox.com/Lot-1307.pdf': branch },
  });

  it('carries a classified inspected refusal', () => {
    const notes = stockDocumentNotes(stored({
      result: 'no_deterministic_image', exhaustion: 'inspected', detail: 'read in full',
      finding: 'identity_mismatch', finding_evidence: { states: 'Lot 1307', quote: 'NEX 20' },
    }));
    expect(notes).toHaveLength(1);
    expect(notes[0].finding).toBe('identity_mismatch');
    expect(notes[0].states).toBe('Lot 1307');
    expect(hasDocumentIdentityMismatch(notes)).toBe(true);
  });

  it('carries an unclassified one exactly as it did before', () => {
    const notes = stockDocumentNotes(stored({
      result: 'no_deterministic_image', exhaustion: 'inspected', detail: 'read in full',
    }));
    expect(notes).toEqual([{ document: 'Lot-1307.pdf', detail: 'read in full' }]);
    expect(hasDocumentIdentityMismatch(notes)).toBe(false);
  });

  it('never lets an operational refusal out, classified or not', () => {
    expect(stockDocumentNotes(stored({
      result: 'no_deterministic_image', exhaustion: 'operational', detail: 'a timeout',
      finding: 'identity_mismatch', finding_evidence: { states: 'Lot 1307', quote: '' },
    }))).toEqual([]);
  });
});

describe('the listing states its own identity from its own row', () => {
  it('reads the lot and the design, and nothing about any document', () => {
    expect(stockItemIdentity({
      unit_number: null, lot_number: '1037',
      address_line: 'Lot 1037 Wollert Rise', house_design: 'VANTA 20',
    } as never)).toBe('Lot 1037 · VANTA 20');
  });

  it('states only what the row holds', () => {
    expect(stockItemIdentity({
      unit_number: null, lot_number: '1037', address_line: 'Lot 1037 Wollert Rise',
      house_design: null,
    } as never)).toBe('Lot 1037');
    expect(stockItemIdentity({
      unit_number: null, lot_number: null, address_line: 'Wollert Rise', house_design: null,
    } as never)).toBe('');
  });
});


// ---------------------------------------------------------------------------
// "USE BROCHURE IMAGE" — THE BUILDER MAY CONFIRM, AND MAY UNDO
// ---------------------------------------------------------------------------
/*
 * HELD OUT: written before the change. The refusal above is right to refuse —
 * a cover that states another lot is how another house reaches a client's
 * card — and it is also sometimes wrong about the builder's own brochure: Lot
 * 1037 · Vanta 20's brochure states "Lot 1037" and "Vanta 20" on page 2 and
 * mistypes the lot on its cover. So the builder is offered one professional
 * choice, beside the explanation rather than instead of it, behind a
 * confirmation that names both identities; and it is NOT offered where the
 * product knows the brochure is another listing's own.
 */

describe('the builder may use the brochure image, deliberately', () => {
  const URL = 'https://drive.google.com/file/d/brochure-1037/view?usp=drive_link';
  const confirmable: Note = {
    document: 'A document on drive.google.com',
    detail: 'That document does not present a page as this property’s package cover, '
      + 'so it names no image for it. Its first page reads “PACKAGE PRICELot 1307 '
      + 'Fuchsia Street,”.',
    finding: 'identity_mismatch',
    states: 'Lot 1307',
    quote: 'PACKAGE PRICELot 1307 Fuchsia Street,',
    document_key: URL,
    confirmable: true,
  } as Note;

  const button = () => screen.queryByRole('button', { name: 'Use brochure image' });

  it('offers "Use brochure image" on a brochure whose details do not match', () => {
    state.confirmCalls = [];
    draw([lot1037([confirmable])]);
    expect(button()).not.toBeNull();
    // Beside the explanation, never instead of it.
    expect(pageText()).toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
    expect(pageText()).toContain(STOCK_DOCUMENT_MISMATCH_COPY.action);
  });

  it('GUARD — offers nothing on any other refusal', () => {
    draw([lot1037([{ document: 'Their-brochure.pdf', detail: 'no photograph in it' }])]);
    expect(button()).toBeNull();
  });

  it('does not offer it where the brochure is another listing\'s own', () => {
    draw([lot1037([{
      ...confirmable, confirmable: false, in_use_by: { identity: 'Lot 1307 · Nex 20' },
    } as Note])]);
    expect(button()).toBeNull();
    const text = pageText();
    expect(text).toContain('Lot 1307 · Nex 20');
    expect(text).toContain('already uses');
  });

  it('asks first, naming both identities', () => {
    draw([lot1037([confirmable])]);
    fireEvent.click(button()!);
    const dialog = screen.getByRole('alertdialog');
    const text = (dialog.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Use the image from this brochure?');
    expect(text).toContain('Lot 1037 · VANTA 20');
    expect(text).toContain('Lot 1307');
    // The two numbers share their digits: said as a possibility, never as a
    // conclusion, because a transposition is also how a sibling's brochure
    // comes to be linked on the wrong row.
    expect(text).toMatch(/same digits in a different order/);
    expect(text).toMatch(/can undo/i);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('says so where another listing has the lot the brochure states', () => {
    draw([lot1037([{ ...confirmable, stated_lot_listing: { identity: 'Lot 1307 · Nex 20' } } as Note])]);
    fireEvent.click(button()!);
    const text = (screen.getByRole('alertdialog').textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Lot 1307 · Nex 20');
    expect(text).toMatch(/also in your stock list/);
  });

  it('confirms exactly the brochure and the lot the builder was shown', () => {
    state.confirmCalls = [];
    draw([lot1037([confirmable])]);
    fireEvent.click(button()!);
    fireEvent.click(within(screen.getByRole('alertdialog'))
      .getByRole('button', { name: 'Confirm and use image' }));
    expect(state.confirmCalls).toEqual([{
      stockItemId: 'item-1037', documentKey: URL, states: 'Lot 1307',
    }]);
  });

  it('nothing is confirmed by cancelling', () => {
    state.confirmCalls = [];
    draw([lot1037([confirmable])]);
    fireEvent.click(button()!);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(state.confirmCalls).toEqual([]);
  });
});

describe('a confirmed brochure says who confirmed it, and can be undone', () => {
  const URL = 'https://drive.google.com/file/d/brochure-1037/view?usp=drive_link';
  const withConfirmation = (over: Record<string, unknown>) => ({
    ...lot1037([]),
    brochure_confirmations: [{
      id: 'conf-1', document: 'A document on drive.google.com', document_key: URL,
      lot: '1307', states: 'Lot 1307', confirmed_by: 'Alex Builder',
      confirmed_at: '2026-09-24T09:30:00.000Z', state: 'pending', ...over,
    }],
  } as unknown as BuilderStockItem);

  it('names who confirmed it, and no longer shows the mismatch', () => {
    draw([withConfirmation({})]);
    const text = pageText();
    expect(text).toContain('Brochure image confirmed by Alex Builder');
    expect(text).not.toContain(STOCK_DOCUMENT_MISMATCH_COPY.heading);
    expect(screen.queryByRole('button', { name: 'Use brochure image' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('says why, where the confirmed brochure\'s image still could not be used', () => {
    draw([withConfirmation({
      state: 'not_applied',
      detail: 'Every picture on the property cover is a plan or a graphic.',
    })]);
    expect(pageText()).toContain('Every picture on the property cover is a plan or a graphic.');
  });

  it('undoes only after asking, and undoes exactly that confirmation', () => {
    state.undoCalls = [];
    draw([withConfirmation({ state: 'applied' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const dialog = screen.getByRole('alertdialog');
    expect((dialog.textContent ?? '')).toContain('Undo brochure confirmation?');
    expect(state.undoCalls).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo confirmation' }));
    expect(state.undoCalls).toEqual([{ stockItemId: 'item-1037', confirmationId: 'conf-1' }]);
  });
});
