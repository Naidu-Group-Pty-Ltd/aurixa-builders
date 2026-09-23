/**
 * ===========================================================================
 * THE PIPELINE MUST NOT WAIT FOR A CLOCK TO ADVANCE SUCCESSFUL WORK.
 * ===========================================================================
 *
 * ## What was measured
 *
 * MEASURED 22 SEPTEMBER 2026 in production, upload `c5f139b9`, one ordinary
 * single-property PDF with one photograph. Upload accepted 08:24:56.189,
 * property published 08:31:06.281: **370 seconds**, of which about **28** was
 * work. The other 342 were, in order:
 *
 *   120 s  a dead worker's lease running its full term
 *    30 s  the watchdog's grace after it
 *    30 s  the failure backoff the watchdog wrote for OUR kill
 *   152 s  four separate waits for the `* * * * *` tick, because nothing but
 *          cron ever started a settler
 *
 * The kill is in the log as `CPU Time exceeded` at 08:25:21.498, 3.6 seconds
 * into a 100-second wall-clock budget, in an isolate that had opened one
 * document, decoded one photograph and begun a second decode.
 *
 * ## What this file pins
 *
 * Three properties, each of which was false on the day and each of which
 * would be silently easy to make false again:
 *
 *   1. AN ISOLATE COMMITS TO ONE CLASS OF EXPENSIVE WORK. A document and a
 *      decode in the same isolate is the combination the runtime killed.
 *   2. AN INVOCATION THAT ADVANCED SOMETHING AND LEAVES WORK CLAIMABLE
 *      STARTS ITS SUCCESSOR, and one that advanced nothing does not — which
 *      is what makes the chain terminate without a timer.
 *   3. NO DELAY IS WRITTEN ON A SUCCESS PATH. Every `retryAfterSeconds` the
 *      settler passes is either zero or a named consequence of a real fault.
 *
 * The third is asserted against the SOURCE, because the settler is an edge
 * handler whose imports do not resolve under Node — the same way this
 * repository already pins `repairSourceImages`' two attach sites.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  mayTakeStage, newAllowance, shouldRearm, spendStage, workClassOf,
  DOCUMENTS_PER_INVOCATION, DECODES_PER_INVOCATION,
} from '../../../supabase/functions/_shared/builderStock/workAllowance.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const SETTLER = 'supabase/functions/builder-stock-image-settler/index.ts';

describe('an isolate commits to one class of expensive work', () => {
  it('names the three classes by what the stage does', () => {
    expect(workClassOf('source')).toBe('document');
    expect(workClassOf('eligibility')).toBe('decode');
    expect(workClassOf('sanitization')).toBe('decode');
    expect(workClassOf('fallback')).toBe('metadata');
    // An unknown stage is metadata: it opens nothing and decodes nothing
    // until somebody says otherwise, and a new stage must not silently
    // inherit a document's allowance.
    expect(workClassOf('something_new')).toBe('metadata');
  });

  it('refuses the exact combination the runtime killed', () => {
    /*
     * The measured sequence: `source`, then `eligibility`, then the start of
     * `sanitization`. Under this allowance the isolate stops after the
     * document and the decodes go to a fresh one.
     */
    const spent = newAllowance();
    expect(mayTakeStage('source', spent)).toBe(true);
    spendStage('source', spent);
    expect(mayTakeStage('eligibility', spent)).toBe(false);
    expect(mayTakeStage('sanitization', spent)).toBe(false);
    // And metadata still rides along, because it costs neither resource.
    expect(mayTakeStage('fallback', spent)).toBe(true);
  });

  it('refuses it in the other order too', () => {
    // A decode invocation must not then open a document: the ceiling is the
    // isolate's, not the stage order's.
    const spent = newAllowance();
    spendStage('eligibility', spent);
    expect(mayTakeStage('source', spent)).toBe(false);
    expect(mayTakeStage('sanitization', spent)).toBe(true);
  });

  it('still bounds each class on its own', () => {
    const documents = newAllowance();
    for (let n = 0; n < DOCUMENTS_PER_INVOCATION; n += 1) {
      expect(mayTakeStage('source', documents)).toBe(true);
      spendStage('source', documents);
    }
    expect(mayTakeStage('source', documents)).toBe(false);

    const decodes = newAllowance();
    for (let n = 0; n < DECODES_PER_INVOCATION; n += 1) {
      expect(mayTakeStage('sanitization', decodes)).toBe(true);
      spendStage('sanitization', decodes);
    }
    expect(mayTakeStage('sanitization', decodes)).toBe(false);
  });

  it('keeps the document ceiling the memory measurement chose', () => {
    // 7 September 2026: the FIFTH document in one isolate crosses ~256 MB.
    // Three stops two before the crossing. Lowering it is fine; raising it
    // needs a new measurement, not an argument.
    expect(DOCUMENTS_PER_INVOCATION).toBeLessThanOrEqual(3);
  });
});

describe('an invocation starts its successor, and only when it should', () => {
  it('re-arms when it advanced something and work is still claimable', () => {
    expect(shouldRearm({ settled: 1, claimable: 1 })).toBe(true);
  });

  it('does not re-arm when it advanced nothing', () => {
    /*
     * THE TERM THAT MAKES THE CHAIN TERMINATE. Without it an invocation that
     * can do nothing starts another that can do nothing, for ever — and it
     * would look exactly like a healthy busy deployment.
     */
    expect(shouldRearm({ settled: 0, claimable: 9 })).toBe(false);
  });

  it('does not re-arm when nothing is claimable', () => {
    // The last invocation of every import would otherwise pay for one more.
    expect(shouldRearm({ settled: 4, claimable: 0 })).toBe(false);
  });
});

describe('the settler asks for exactly one successor, through the existing dispatcher', () => {
  const source = read(SETTLER);

  it('re-arms through the dispatcher the cron tick already uses', () => {
    // Not a new invocation path: the same signed call, the same ceiling, the
    // same best-effort contract. A second way to start a worker is a second
    // set of concurrency rules to keep in step.
    expect(source).toContain("rpc('builder_stock_dispatch_image_workers', { p_max: 1 })");
  });

  it('asks only behind `shouldRearm`', () => {
    /*
     * THE SHAPE, not merely the two names in the same file. A dispatch that
     * drifts out from under the guard is an invocation that starts a
     * successor having advanced nothing, which is the one way this chain
     * fails to terminate.
     */
    expect(source).toContain(
      'if (shouldRearm({ settled: settledCount, claimable: pending.claimable })) {');
    const guard = source.indexOf('if (shouldRearm({');
    const call = source.indexOf("rpc('builder_stock_dispatch_image_workers'");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
    // Nothing else between them but the `try` that keeps it best-effort.
    const between = source.slice(guard, call);
    expect(between.split('\n').length).toBeLessThan(6);
    expect(between.slice('if (shouldRearm({'.length)).not.toContain('if (');
  });

  it('never fails a tick over it', () => {
    const call = source.indexOf("rpc('builder_stock_dispatch_image_workers'");
    expect(source.slice(call - 400, call)).toContain('try {');
  });
});

describe('no delay is written on a path where nothing failed', () => {
  const source = read(SETTLER);

  it('passes a retry delay only where it names the fault', () => {
    /*
     * EVERY `retryAfterSeconds` IN THE SETTLER, checked by value. Zero is the
     * success path and the handback (the property did nothing wrong, and the
     * completion resets the attempt counter beside it). The only non-zero one
     * is `STALLED_RETRY_SECONDS`, which is a stage reporting progress it did
     * not make — a real fault, and the guard that turned an unbounded spin
     * into one wasted claim.
     */
    const values = [...source.matchAll(/retryAfterSeconds:\s*([A-Za-z0-9_]+)/g)]
      .map((match) => match[1]);
    expect(values.length).toBeGreaterThanOrEqual(4);
    for (const value of values) {
      expect(['0', 'STALLED_RETRY_SECONDS']).toContain(value);
    }
  });

  it('leases only for as long as this invocation can hold one', () => {
    /*
     * It was `Math.ceil(BUDGET_MS / 1000) + 20` — 120 seconds on every claim
     * however late it was taken, so a worker killed holding one parked a
     * healthy property for two minutes before the watchdog's grace began.
     */
    expect(source).toContain(
      'leaseSeconds: Math.ceil((startedAt + BUDGET_MS - Date.now()) / 1000) + 15');
    expect(source).not.toContain('leaseSeconds: Math.ceil(BUDGET_MS / 1000) + 20');
  });

  it('gives the claim back when the runtime says it is taking the worker', () => {
    // Best effort and never the guarantee: the lease, the grace and the
    // watchdog still recover a worker that dies without notice.
    expect(source).toContain('releaseClaimOnTermination(supabase');
    expect(source).toContain('termination.hold(');
    expect(source).toContain('termination.clear();');
    const release = read('supabase/functions/_shared/builderStock/releaseOnTermination.ts');
    expect(release).toContain("'beforeunload'");
    // The release is not a failure report: nothing here raises the ledger.
    expect(release).toContain('p_reset_attempts: true');
    expect(release).not.toContain('p_failed');
    /*
     * AND IT IS ACTUALLY ISSUED. A supabase-js builder is a thenable that
     * sends nothing until something subscribes, so discarding it with a bare
     * `void` would compose the request and never make it — a release that
     * silently did nothing, which is worse than none because it would read
     * as working.
     */
    expect(release).toContain('.then(() => {}, () => {});');
    expect(release).not.toContain('void db.rpc(');
    /*
     * AND IT NAMES NO STAGE. The completion reads a null `p_next_stage` as
     * "leave the stage where it is". Passing the stage the claim was taken at
     * is stale the instant the settler's own completion resolves, and a
     * release firing in that window would write the old rung back and walk
     * the property DOWN its ladder. A release hands back a lease; it has no
     * opinion about which stage a property is on.
     */
    expect(release).toContain('p_next_stage: null,');
    expect(release).not.toContain('p_next_stage: held.stage');
  });
});

describe('the heartbeat stays the recovery clock and stops being the transport', () => {
  it('still runs the housekeeping on every exit', () => {
    const source = read(SETTLER);
    const housekeeping = source.split('runTickHousekeeping(supabase').length - 1;
    // The definition plus both exits. Losing one is how an import strands at
    // `enriching` with nothing reporting it — measured 19 September 2026.
    expect(housekeeping).toBeGreaterThanOrEqual(3);
  });

  it('keeps the watchdog, the publication sweep and the reopens on the tick', () => {
    const tick = read(
      'supabase/migrations/20260921080000_a_stranded_finalisation_keeps_the_tick_alive.sql');
    expect(tick).toContain('PERFORM public.builder_stock_image_watchdog();');
    expect(tick).toContain('PERFORM public.publish_ready_builder_stock_uploads();');
    expect(tick).toContain('PERFORM public.reopen_builder_stock_stranded_items();');
  });

  it('starts the ladder from the import rather than from the next minute', () => {
    // This already existed and is what the re-arm continues: the import
    // kicks, and from then on each invocation hands off to the next.
    expect(read('supabase/functions/_shared/builderStock/runImport.ts'))
      .toContain("rpc('builder_stock_kick_image_work'");
  });
});

describe('the first lease expiry is ours and the second is the property\'s', () => {
  const migration = read(
    'supabase/migrations/20260922100000_a_worker_we_killed_must_not_bill_the_property.sql');

  it('makes a once-expired lease claimable immediately', () => {
    expect(migration).toContain('WHEN i.image_work_failures = 0 THEN now()');
  });

  it('keeps the bounded ladder for every expiry after it', () => {
    expect(migration).toContain(
      'ELSE now() + public.builder_stock_failure_backoff(i.image_work_failures + 1)');
  });

  it('still counts the failure, so the terminal ceiling is unchanged', () => {
    expect(migration).toContain('image_work_failures = i.image_work_failures + 1');
    expect(migration).toContain("image_work_stage = 'failed'");
  });

  it('is proved by effect rather than by reading the function back', () => {
    expect(migration).toContain('scripts/ops/probe-watchdog-backoff.mjs');
    const probe = read('scripts/ops/probe-watchdog-backoff.mjs');
    expect(probe).toContain('select public.builder_stock_image_watchdog();');
    expect(probe).toContain('image_work_next_attempt_at');
    // And it removes exactly what it made.
    expect(probe).toContain('delete from public.builder_stock_items');
    expect(probe).toContain('LEFT');
  });
});

describe('the diagnostics say what was spent and what was waited for', () => {
  it('records both numbers on every stage', () => {
    const source = read(SETTLER);
    expect(source).toContain('scheduler_wait_ms: claimWaitMs(claimed)');
    // The class the claim was TAKEN as — for a PDF's `source` stage that is
    // where its document's read stands, not the stage's name. See
    // `resolveClaimClass`.
    expect(source).toContain('work_class: claimedClass.workClass,');
    expect(source).toContain(
      'image_work_timings: [...priorTimings, timing].slice(-12)');
    // APPENDED, not overwritten: a ladder that crosses isolates would
    // otherwise report only its last isolate's stages, losing exactly the
    // `source` timing a document question needs. The history rides back on
    // the claim, so it costs no extra read.
    expect(source).toContain('claimed.image_work_timings');
  });

  it('counts the times a run opened the document', () => {
    /*
     * FOUR SITES, because the OCR branch rasterises from its own parse: the
     * text layer, the positioned layout, the image discovery and — only for a
     * scan — the page photographs. A native single-property PDF therefore
     * reports three and a scanned one four, which is exactly the distinction
     * the count exists to make visible.
     */
    const extract = read('supabase/functions/_shared/builderStock/extract.ts');
    expect(read('supabase/functions/_shared/builderStock/importStageLedger.pure.ts'))
      .toContain("'document_open'");
    expect((extract.match(/countIn\(timings, 'document_parses'\)/g) ?? []))
      .toHaveLength(4);
  });

  it('never fails an import over a diagnostic', () => {
    const run = read('supabase/functions/_shared/builderStock/runImport.ts');
    const write = run.indexOf('stage_timings: {');
    expect(write).toBeGreaterThan(-1);
    expect(run.slice(write - 300, write)).toContain('try {');
  });
});
