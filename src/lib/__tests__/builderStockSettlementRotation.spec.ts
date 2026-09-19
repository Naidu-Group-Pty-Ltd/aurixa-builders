/**
 * THE SETTLEMENT PHASE ROTATION ADVANCES ONCE A TICK — pinned.
 *
 * `choosePhase` derives its index from the clock rather than from stored
 * state, and its own contract names the one property that makes that sound:
 * "the only property required is that consecutive ticks land on consecutive
 * indices". The period it was handed was `5 * 60 * 1000` while
 * `ensure_builder_stock_settlement_scheduled` schedules the job `* * * * *`.
 *
 * So `Math.floor(now / 300000)` changed once every five minutes and FIVE
 * consecutive ticks took the same phase. Nothing was skipped — rotation
 * "costs ticks and never coverage" — but a phase deferred at 10:00 waited
 * until 10:05 for its turn, and with all three outstanding a full rotation
 * took fifteen minutes rather than three. On an import whose upload markers
 * are all unstamped that is most of the tail.
 *
 * Measured on 19 September 2026: cron job 12 started at 11:44, 11:45, 11:46,
 * 11:47, 11:48, 11:49, 11:50 and 11:51 — one minute apart, no gaps.
 *
 * WHAT THIS FILE DOES NOT ASSERT, because none of it moved: which phases
 * exist, their order, what each settles, item claiming, worker concurrency,
 * leases, per-invocation budgets, image eligibility or publication.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SETTLEMENT_PHASES, choosePhase,
} from '../../../supabase/functions/_shared/builderStock/settlementPhase.pure';

const SETTLER = 'supabase/functions/builder-stock-image-settler/index.ts';
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The cron this job is actually scheduled on. */
const ONE_MINUTE = 60 * 1000;

/** Every phase outstanding — the shape a fresh import presents. */
const ALL_OUTSTANDING = [{
  needsProvenance: true, needsEligibility: true, needsSanitization: true,
}];

const ticks = (count: number, from: number, period: number) =>
  Array.from({ length: count }, (_, n) => choosePhase(ALL_OUTSTANDING, from + n * period, period));

describe('the rotation period matches the cron it rotates on', () => {
  it('is one minute in the settler', () => {
    const source = read(SETTLER);
    expect(source).toMatch(/const TICK_ROTATION_MS = 60 \* 1000;/);
    expect(
      source.includes('const TICK_ROTATION_MS = 5 * 60 * 1000;'),
      'the rotation period went back to five minutes against a one-minute cron, '
      + 'so five consecutive ticks take the same phase again',
    ).toBe(false);
  });

  it('is what choosePhase is handed', () => {
    const source = read(SETTLER);
    expect(source).toContain('choosePhase(candidates, startedAt, TICK_ROTATION_MS)');
  });
});

describe('consecutive one-minute ticks rotate through the outstanding phases', () => {
  /** An arbitrary minute boundary; the rule must not depend on which. */
  const START = Date.UTC(2026, 8, 19, 11, 44, 0);

  it('takes a different phase on each of the next three ticks', () => {
    const [first, second, third] = ticks(3, START, ONE_MINUTE);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('covers all three phases within three ticks, whenever it starts', () => {
    for (let offset = 0; offset < 7; offset += 1) {
      const seen = new Set(ticks(3, START + offset * ONE_MINUTE, ONE_MINUTE));
      expect(seen.size).toBe(SETTLEMENT_PHASES.length);
      expect([...seen].sort()).toEqual([...SETTLEMENT_PHASES].sort());
    }
  });

  it('repeats with a period of three ticks', () => {
    const run = ticks(9, START, ONE_MINUTE);
    expect(run.slice(0, 3)).toEqual(run.slice(3, 6));
    expect(run.slice(0, 3)).toEqual(run.slice(6, 9));
  });

  /**
   * THE DEFECT ITSELF, stated as a test so it cannot return quietly.
   *
   * Five one-minute ticks can cross at most ONE five-minute boundary, so under
   * the old period they reach at most two of the three phases however they are
   * aligned — and reach only one whenever they fall inside a single bucket.
   * Under the cron's own period the same five ticks reach all three.
   */
  it.each([0, 1, 2, 3, 4])(
    'reaches every phase in five ticks where five minutes reached at most two (offset %i)',
    (offset) => {
      const from = START + offset * ONE_MINUTE;
      const atFive = Array.from({ length: 5 }, (_, n) =>
        choosePhase(ALL_OUTSTANDING, from + n * ONE_MINUTE, 5 * 60 * 1000));
      expect(new Set(atFive).size).toBeLessThanOrEqual(2);

      expect(new Set(ticks(5, from, ONE_MINUTE)).size).toBe(SETTLEMENT_PHASES.length);
    },
  );
});

describe('what the shorter period must not change', () => {
  it('still rotates only through phases that have work', () => {
    const only = [{ needsSanitization: true }];
    const run = ticks(6, Date.UTC(2026, 8, 19, 11, 44, 0), ONE_MINUTE);
    expect(new Set(run).size).toBe(SETTLEMENT_PHASES.length);

    const narrowed = Array.from({ length: 6 }, (_, n) =>
      choosePhase(only, Date.UTC(2026, 8, 19, 11, 44, 0) + n * ONE_MINUTE, ONE_MINUTE));
    expect(new Set(narrowed)).toEqual(new Set(['sanitization']));
  });

  it('still answers provenance when there is no work at all', () => {
    expect(choosePhase([], Date.now(), ONE_MINUTE)).toBe('provenance');
  });

  it('keeps the three phases and their order', () => {
    expect([...SETTLEMENT_PHASES]).toEqual(['provenance', 'eligibility', 'sanitization']);
  });

  /**
   * The rotation is the ONLY thing this pass touched in the settler. These are
   * the neighbours it would have been easy to tune at the same time, and the
   * brief said not to.
   */
  it('leaves the budgets, the concurrency and the leases alone', () => {
    const source = read(SETTLER);
    expect(source).toContain('const BUDGET_MS = 100_000;');
    expect(source).toContain('const MAX_UPLOADS_PER_TICK = 6;');
    expect(source).toContain('const MAX_QUEUE_ROWS = 100;');
    expect(source).toContain('const HEAVY_DOCUMENTS_PER_INVOCATION = 3;');
    expect(source).toContain('const LIGHT_ITEMS_AFTER_DOCUMENTS = 8;');
    expect(source).toContain('const LIGHT_STAGE_RESERVE_MS = 20_000;');
    expect(source).toContain('leaseSeconds: Math.ceil(BUDGET_MS / 1000) + 20');
  });
});
