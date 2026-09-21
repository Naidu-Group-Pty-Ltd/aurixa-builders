/**
 * WHEN BOTH READERS REFUSE, THE ONE THAT READ SOMETHING IS THE ANSWER.
 *
 * MEASURED 21 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property Package.pdf`
 * (1,951,962 bytes, 7 pages, 3,962 characters of text extracted cleanly),
 * from this deployment's own import log:
 *
 *     deterministic_status     "ambiguous"
 *     deterministic_reason     "two_cells_in_one_column"
 *     deterministic_fields     []
 *     deterministic_candidates 0
 *     → assisted reader → openrouter/openai/gpt-5.6-luna: refused 402
 *     → import FAILED, zero properties, customer told their file could not
 *       be imported
 *
 * A TABLE's refusal, about a document that holds no table. The brochure
 * reading was computed and thrown away — with its `provisional` rows, its
 * fields, its unplaced lines and their coordinates — so `runImport`'s
 * deterministic fallback, which exists precisely so a model outage cannot
 * fail a readable import, was handed an empty `provisional`.
 *
 * `mayHoldSchedule` has been hardened against this class twice already. Both
 * fixes narrowed WHICH documents reach the table parser; neither fixed what
 * happens when it refuses one, which is why the next template did it again.
 */
import { describe, expect, it } from 'vitest';
import {
  moreEvidencedRefusal,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

type Reading = Parameters<typeof moreEvidencedRefusal>[0];

const reading = (over: Partial<Reading> & {
  mode?: 'table' | 'brochure' | 'none';
  fieldsRead?: string[];
  candidates?: number;
}): Reading => ({
  status: 'ambiguous',
  rows: [],
  provisional: [],
  strategy: null,
  reason: 'unset',
  ignored: [],
  placement: [],
  unaccounted: [],
  ...over,
  diagnostics: {
    mode: over.mode ?? 'none',
    pages: 7,
    fieldsRead: over.fieldsRead ?? [],
    candidates: over.candidates ?? 0,
  },
} as Reading);

/** The table parser's account of Lot 37: it established nothing. */
const LOT_37_SCHEDULE = reading({
  mode: 'table', reason: 'two_cells_in_one_column', fieldsRead: [], candidates: 0,
});

/** What the brochure reader had in hand when it stood down. */
const LOT_37_BROCHURE = reading({
  mode: 'brochure',
  reason: 'unaccounted_specification_lines',
  fieldsRead: ['lot_number', 'house_design', 'price'],
  candidates: 1,
  provisional: [{ lot_number: '37', house_design: 'Miami 190', price: 640000 }],
  ignored: ['MIAMI 190'],
  placement: ['p1 r0 x36'],
  unaccounted: ['SOME LINE THE READER COULD NOT PLACE'],
});

describe('the Lot 37 refusal', () => {
  it('returns the reading that established something', () => {
    const out = moreEvidencedRefusal(LOT_37_SCHEDULE, LOT_37_BROCHURE);
    expect(out.reason).toBe('unaccounted_specification_lines');
    expect(out.diagnostics.mode).toBe('brochure');
  });

  /*
   * The whole point: `runImport`'s deterministic fallback reads this, and an
   * empty one is what turned a 402 from an unpaid vendor into a failed
   * import.
   */
  it('carries the provisional record a model outage must not discard', () => {
    expect(moreEvidencedRefusal(LOT_37_SCHEDULE, LOT_37_BROCHURE).provisional)
      .toEqual([{ lot_number: '37', house_design: 'Miami 190', price: 640000 }]);
  });

  it('carries the evidence that says WHY a field is missing', () => {
    const out = moreEvidencedRefusal(LOT_37_SCHEDULE, LOT_37_BROCHURE);
    expect(out.diagnostics.fieldsRead).toEqual(['lot_number', 'house_design', 'price']);
    expect(out.ignored).toEqual(['MIAMI 190']);
    expect(out.placement).toEqual(['p1 r0 x36']);
    expect(out.unaccounted).toEqual(['SOME LINE THE READER COULD NOT PLACE']);
  });

  /* A document that really did hold a broken table still says so. */
  it('keeps the losing account in the log', () => {
    expect(moreEvidencedRefusal(LOT_37_SCHEDULE, LOT_37_BROCHURE).diagnostics.alsoTried)
      .toEqual({ mode: 'table', reason: 'two_cells_in_one_column' });
  });
});

describe('what it must not do', () => {
  /*
   * Two readers' rows are two readings of one page. Splicing them would
   * invent a record neither reader would stand behind.
   */
  it('chooses an account whole and never merges two', () => {
    const schedule = reading({
      mode: 'table', reason: 'two_cells_in_one_column',
      fieldsRead: ['suburb'], candidates: 1,
      provisional: [{ suburb: 'Mernda' }],
    });
    const out = moreEvidencedRefusal(schedule, LOT_37_BROCHURE);
    expect(out.provisional).toHaveLength(1);
    expect(out.provisional[0]).not.toHaveProperty('suburb');
  });

  /*
   * A refusal may never carry rows — that rule predates this and stands.
   * `provisional` is the separate field the one permitted caller reads.
   */
  it('never turns a refusal into importable rows', () => {
    const out = moreEvidencedRefusal(LOT_37_SCHEDULE, LOT_37_BROCHURE);
    expect(out.rows).toEqual([]);
    expect(out.status).not.toBe('complete');
    expect(out.strategy).toBeNull();
  });

  /*
   * Where neither established anything, a document the screen says holds a
   * table and which the table parser refused is best described by the table
   * parser. Today's behaviour, unchanged.
   */
  it('leaves the schedule refusal standing where neither read anything', () => {
    const bare = reading({ mode: 'brochure', reason: 'no_property_candidate' });
    const out = moreEvidencedRefusal(LOT_37_SCHEDULE, bare);
    expect(out.reason).toBe('two_cells_in_one_column');
    expect(out.diagnostics.mode).toBe('table');
  });

  it('prefers a real table reading over a thinner brochure one', () => {
    const schedule = reading({
      mode: 'table', reason: 'two_cells_in_one_column',
      fieldsRead: ['lot_number', 'price', 'land_size_sqm'], candidates: 4,
      provisional: [{ lot_number: '1' }, { lot_number: '2' }],
    });
    expect(moreEvidencedRefusal(schedule, LOT_37_BROCHURE).diagnostics.mode).toBe('table');
  });

  /* Fields break a tie only when neither produced a provisional record. */
  it('ranks provisional records above field count', () => {
    const wordy = reading({
      mode: 'table', reason: 'two_cells_in_one_column',
      fieldsRead: ['a', 'b', 'c', 'd', 'e'], candidates: 9,
    });
    expect(moreEvidencedRefusal(wordy, LOT_37_BROCHURE).diagnostics.mode).toBe('brochure');
  });
});
