/**
 * AN IMPORT STOPS TAKING ON EXPENSIVE WORK BEFORE IT RUNS OUT.
 *
 * Every number under test comes from six production runs of
 * `builder-portal-stock` on 21 SEPTEMBER 2026 — `function_edge_logs` for the
 * status, `function_logs` for the cause. Two were killed with
 * `CPU Time exceeded`; four completed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPLETION_BUDGET_MS,
  COMPLETION_MIN_ROOM_MS,
  completionDeadlineFrom,
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

describe('the field completion is the least important thing an import does', () => {
  /*
   * A DEFECT THIS MODULE EXISTED TO PREVENT, COMMITTED THREE MERGES AFTER IT
   * WAS WRITTEN — by the change that added the completion.
   *
   *   08:59:13.663  field completion unavailable — detail: "model_refused"
   *   08:59:16.717  CPU Time exceeded
   *
   * `runStockImport` handed it `Date.now() + MODEL_BUDGET_MS` — ninety
   * seconds against a thirty-second run bound — at the point where the run is
   * closest to its ceiling, having already read the document and stored its
   * imagery. Every attempt on this deployment ends in the same 402, so the
   * run spent its last seconds discovering something it could not change and
   * was killed doing it. A whole import lost to filling in a card.
   */
  const NOW = 1_758_436_000_000;

  it('does not begin where the run cannot afford it', () => {
    const budget = openImportBudget(NOW, 1_000_000);
    const nearlySpent = budget.deadlineAt - (COMPLETION_MIN_ROOM_MS - 1);
    expect(completionDeadlineFrom(budget, nearlySpent)).toBeNull();
  });

  it('begins where there is room, and is held to the run', () => {
    const budget = openImportBudget(NOW, 1_000_000);
    const at = budget.deadlineAt - (COMPLETION_BUDGET_MS - 1_000);
    const deadline = completionDeadlineFrom(budget, at)!;
    expect(deadline).toBe(budget.deadlineAt);
    expect(deadline).toBeLessThan(at + COMPLETION_BUDGET_MS);
  });

  it('keeps its own allowance early in a run', () => {
    const budget = openImportBudget(NOW, 1_000_000);
    expect(completionDeadlineFrom(budget, NOW)).toBe(NOW + COMPLETION_BUDGET_MS);
  });

  it('can never outlive the run, at any point in it', () => {
    const budget = openImportBudget(NOW, 1_000_000);
    for (const elapsed of [0, 5_000, 15_000, 24_000, 29_000]) {
      const deadline = completionDeadlineFrom(budget, NOW + elapsed);
      if (deadline === null) continue;
      expect(deadline).toBeLessThanOrEqual(budget.deadlineAt);
    }
  });

  /*
   * AND IT IS A FRACTION OF THE READER'S ALLOWANCE, not a copy of it. The
   * completion fills absences on a record that is already correct and already
   * about to be written; the reader's ninety seconds are for reading a
   * document there is otherwise no reading of.
   */
  it('is far smaller than the allowance for reading a document', () => {
    const MODEL_BUDGET_MS = 90_000;
    expect(COMPLETION_BUDGET_MS).toBeLessThan(MODEL_BUDGET_MS / 4);
    expect(COMPLETION_MIN_ROOM_MS).toBeLessThan(COMPLETION_BUDGET_MS);
  });
});

describe('the import reports what the reader saw before it can be killed', () => {
  const run = readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock/runImport.ts'), 'utf8');

  /*
   * The import's own telemetry line is written after everything else has run,
   * so a worker killed later takes the reading's account with it. That is
   * exactly what upload `6d195db5` did at 08:59 on 21 September 2026: the run
   * died during the field completion and left NOTHING anywhere saying what
   * the deterministic reader had made of the document.
   */
  it('logs the reading as soon as the extractor returns', () => {
    const at = run.indexOf("phase: 'deterministic_read'");
    expect(at).toBeGreaterThan(0);
    // Before the model path, the completion and the row write — so any kill
    // after extraction still leaves the account behind.
    expect(at).toBeLessThan(run.indexOf('const budget = createAiBudget'));
    expect(at).toBeLessThan(run.indexOf("phase: 'field_completion'"));
  });

  it('carries what is needed to act, and no value the document stated', () => {
    const block = run.slice(run.indexOf("phase: 'deterministic_read'"),
      run.indexOf('// A table is normalised deterministically'));
    for (const key of ['status', 'reason', 'fields_read', 'visual_only',
      'count_evidence', 'unaccounted_lines']) {
      expect(block).toContain(key);
    }
    // Names and counts only: `diagnostics` carries no stated value by
    // contract, and nothing else is read here.
    expect(block).not.toContain('rows');
    expect(block).not.toContain('extraction.text');
  });
});
