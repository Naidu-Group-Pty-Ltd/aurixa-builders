/**
 * Builder stock — NAMING THE RESOURCE THAT KILLED AN IMPORT.
 *
 * ===========================================================================
 * WHAT THIS EXISTS TO ANSWER.
 * ===========================================================================
 *
 * MEASURED 22 September 2026, production, a real customer upload:
 *
 *     10:05:56.792  processing started
 *     10:06:01.915  deterministic reading complete — 11 fields read
 *     10:06:04.895  POST builder-portal-stock -> 546  CPU Time exceeded
 *
 * `546` is the platform's front door saying the worker went away. It does not
 * say WHICH resource ran out, and for an import that spends its time on three
 * very different things — walking a page tree, decoding photographs, writing
 * rows — that is the only question worth asking. The settler learned the same
 * lesson a few hours earlier and the runtime answered it: a `beforeunload`
 * listener is handed the reason, and on the settler's first production run it
 * said `cpu` during a stage that had been alive 3.46 seconds.
 *
 * So the importer asks too. One listener per isolate, holding a mutable
 * reference to the stage ledger, so the line it prints names:
 *
 *   • the resource the runtime is reclaiming (`cpu`, `wall_clock`, `memory`,
 *     `early_drop`, or whatever it says);
 *   • the last stage that COMPLETED, which the ledger already commits;
 *   • what that stage and every stage before it cost.
 *
 * The stage AFTER the last completed one is the stage that killed the run.
 * That is the whole diagnosis, in one line, on the run that died.
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT DO.
 * ===========================================================================
 *
 * IT WRITES NOTHING TO THE DATABASE. The settler's equivalent hands a claim
 * back, because a claim is a lease somebody else is waiting on. An import's
 * progress is already durable — the ledger is committed at every stage
 * boundary, before the next one starts — so there is nothing here that a
 * write could save, and a write issued from a terminating isolate is a race
 * against a successor that may already be running. See
 * `importStageLedger.pure.ts`.
 *
 * IT IS NOT A GUARANTEE. A worker that dies without notice — an out-of-memory
 * abort, a host that vanishes — prints nothing, and the committed ledger plus
 * the claim's own expiry remain the recovery. This makes the ordinary case
 * legible; it does not make the pipeline depend on being told.
 */

import type { ImportStageLedger } from './importStageLedger.pure.ts';

export interface ImportTerminationWatch {
  /** Point the watch at the ledger this run is filling. */
  watch(ledger: ImportStageLedger): void;
  /** The run finished normally; a termination now is an ordinary drop. */
  done(): void;
}

/**
 * Register the listener once and hand back the holder the caller updates.
 *
 * ONE LISTENER PER ISOLATE, not one per import: `addEventListener`
 * accumulates, and a handler registered per upload would fire once for every
 * upload the isolate had ever handled and print a line about each of them.
 */
export function watchImportTermination(tag: string): ImportTerminationWatch {
  let held: ImportStageLedger | null = null;

  const onTermination = (event: unknown) => {
    /*
     * SILENT WHEN NOTHING IS IMPORTING, and that is not tidiness.
     *
     * An edge isolate is reclaimed after serving many requests, so
     * `beforeunload` fires on every teardown whether an import was running or
     * not. Measured over one profiling run: TWELVE lines reading
     * `reason: "unknown", importing: false, ledger: null` — each one a
     * "the runtime is terminating this worker" warning about nothing.
     *
     * A diagnostic that prints on every ordinary shutdown is how the ONE line
     * that names a real kill gets scrolled past. The holder is null exactly
     * when no run is in flight, so that is the test.
     */
    if (held === null) return;
    const reason = String(
      (event as { detail?: { reason?: unknown } } | null)?.detail?.reason ?? 'unknown');
    try {
      console.warn(`[${tag}] the runtime is terminating this worker`, {
        phase: 'import_termination',
        reason,
        /*
         * THE STAGE THAT FINISHED, AND THEREFORE THE ONE THAT DID NOT.
         * The ledger names the last completed stage; the stage after it is
         * the one holding the CPU when the runtime came for the worker.
         */
        last_completed_stage: held.stage ?? null,
        importing: true,
        ledger: held,
      });
    } catch { /* a diagnostic must not throw inside a teardown */ }
  };

  try {
    (globalThis as { addEventListener?: (t: string, h: (e: unknown) => void) => void })
      .addEventListener?.('beforeunload', onTermination);
  } catch {
    /*
     * A runtime that does not raise it. Nothing degrades: the ledger is
     * committed at every stage boundary regardless, so the last entry still
     * names how far the run got — this only adds the resource's name.
     */
  }

  return {
    watch(ledger: ImportStageLedger) { held = ledger; },
    done() { held = null; },
  };
}
