/**
 * AN IMPORT STOPS TAKING ON EXPENSIVE WORK BEFORE IT RUNS OUT.
 *
 * Every number under test comes from six production runs of
 * `builder-portal-stock` on 21 SEPTEMBER 2026 — `function_edge_logs` for the
 * status, `function_logs` for the cause. Two were killed with
 * `CPU Time exceeded`; four completed.
 */
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_ELAPSED_LIMIT_MS,
  discoveryRefusal,
  IMAGE_BUDGET_MS,
  INLINE_DISCOVERY_MAX_BYTES,
  openImportBudget,
  storageDeadlineFrom,
} from '../../../supabase/functions/_shared/builderStock/importBudget.pure.ts';

/** The corpus, verbatim. Bytes and outcome are both from production. */
const RUNS = [
  { name: 'LOT 810 - NEX 20 - BROCHURE V002', bytes: 13_833_454, killed: true },
  { name: 'LOT 309 - NEX 20 - BROCHURE V002', bytes: 9_553_638, killed: true },
  { name: 'LOT 324 - NEX 20 - V002', bytes: 8_634_881, killed: false },
  { name: 'LOT 717 - ENZO 10.5 MODERN', bytes: 8_425_036, killed: false },
  { name: 'LOT 315 - ENZO 8.5 LUCA', bytes: 7_182_031, killed: false },
  { name: 'LOT 36 - ZIMI - FLYER', bytes: 752_737, killed: false },
];

const NOW = 1_758_436_000_000;

describe('the ceiling against the runs it was drawn from', () => {
  it('defers every document that was killed', () => {
    for (const run of RUNS.filter((entry) => entry.killed)) {
      expect(
        discoveryRefusal(openImportBudget(NOW, run.bytes), NOW),
        `${run.name} was killed in production and would still read its images inline`,
      ).toBe('document_too_large');
    }
  });

  /*
   * AND CHANGES NOTHING THAT WORKS. This is the constraint that chose the
   * number: a fix which defers a document that completes today buys nothing
   * and costs that builder a wait.
   */
  it('leaves every document that completed exactly as it was', () => {
    for (const run of RUNS.filter((entry) => !entry.killed)) {
      expect(
        discoveryRefusal(openImportBudget(NOW, run.bytes), NOW),
        `${run.name} completed in production and would now be deferred`,
      ).toBeNull();
    }
  });

  it('sits inside the gap the corpus leaves, on both sides', () => {
    const largestSuccess = Math.max(...RUNS.filter((r) => !r.killed).map((r) => r.bytes));
    const smallestFailure = Math.min(...RUNS.filter((r) => r.killed).map((r) => r.bytes));
    expect(INLINE_DISCOVERY_MAX_BYTES).toBeGreaterThan(largestSuccess);
    expect(INLINE_DISCOVERY_MAX_BYTES).toBeLessThanOrEqual(smallestFailure);
  });
});

describe('the elapsed backstop', () => {
  /*
   * IT MUST NOT FIRE ON ANYTHING MEASURED TO WORK. The longest completed run
   * is 14.3 seconds END TO END and discovery begins well before a run ends,
   * so no measured success can have reached that point with this much spent.
   * A backstop that fires inside the working envelope is not a backstop, it
   * is a second ceiling nobody argued for.
   */
  const LONGEST_SUCCESSFUL_RUN_MS = 14_300;

  it('cannot fire inside the envelope of any measured success', () => {
    expect(DISCOVERY_ELAPSED_LIMIT_MS).toBeGreaterThan(LONGEST_SUCCESSFUL_RUN_MS);
  });

  it('declines a small document whose run has already spent the time', () => {
    const budget = openImportBudget(NOW, 500_000);
    expect(discoveryRefusal(budget, NOW + DISCOVERY_ELAPSED_LIMIT_MS)).toBe('run_budget_spent');
  });

  it('names the size first where both are true', () => {
    // The two reasons send an operator to different places, and the size is
    // the one that describes this document rather than this run.
    const budget = openImportBudget(NOW, 20_000_000);
    expect(discoveryRefusal(budget, NOW + DISCOVERY_ELAPSED_LIMIT_MS))
      .toBe('document_too_large');
  });
});

describe('a caller that kept no clock behaves exactly as it does today', () => {
  /*
   * `repairSourceImagesForUpload` is the whole reason this is opt-in: its
   * invocation IS one document, and it must never decline the imagery it
   * exists to attach.
   */
  it('proceeds with no budget, at any size', () => {
    expect(discoveryRefusal(null, NOW)).toBeNull();
    expect(discoveryRefusal(undefined, NOW)).toBeNull();
  });

  it('leaves the storage phase on its own default', () => {
    expect(storageDeadlineFrom(null, NOW)).toBeUndefined();
    expect(storageDeadlineFrom(undefined, NOW)).toBeUndefined();
  });
});

describe('the storage phase is held to the smaller of two bounds', () => {
  it('keeps its own allowance on a run with room to spare', () => {
    // A document that finishes inside its eight seconds today is untouched.
    const budget = openImportBudget(NOW, 1_000_000);
    expect(storageDeadlineFrom(budget, NOW + 1_000)).toBe(NOW + 1_000 + IMAGE_BUDGET_MS);
  });

  it('is cut short by a run that has nearly spent itself', () => {
    // The defect this replaces: eight seconds measured from the moment this
    // phase begins granted eight MORE to a run that had already spent thirty.
    const budget = openImportBudget(NOW, 1_000_000);
    const late = budget.deadlineAt - 1_000;
    expect(storageDeadlineFrom(budget, late)).toBe(budget.deadlineAt);
    expect(storageDeadlineFrom(budget, late)).toBeLessThan(late + IMAGE_BUDGET_MS);
  });

  it('can only ever shorten a run, never lengthen one', () => {
    const budget = openImportBudget(NOW, 1_000_000);
    for (const elapsed of [0, 5_000, 15_000, 29_000, 40_000]) {
      const at = NOW + elapsed;
      expect(storageDeadlineFrom(budget, at)!).toBeLessThanOrEqual(at + IMAGE_BUDGET_MS);
    }
  });
});
