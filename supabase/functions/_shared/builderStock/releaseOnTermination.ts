/**
 * Builder stock — GIVING THE CLAIM BACK WHEN THE RUNTIME TAKES THE WORKER.
 *
 * ===========================================================================
 * WHAT THIS COSTS WHEN IT IS NOT THERE.
 * ===========================================================================
 *
 * MEASURED 22 SEPTEMBER 2026, production, upload `c5f139b9`. A settler was
 * killed with `CPU Time exceeded` one second after completing a stage, while
 * holding a fresh claim on the same property. No `finally` runs on a killed
 * isolate, so the claim stood, and the recovery cost the customer
 *
 *     120 s  the lease's full term
 *      30 s  the watchdog's grace after it
 *      11 s  the next `* * * * *` tick, which is what runs the watchdog
 *      30 s  the failure backoff the watchdog writes for the reclaim
 *      30 s  the next tick, which is what dispatches a worker
 *
 * on a property that had done nothing wrong and a stage that takes 1.3 s.
 *
 * ===========================================================================
 * WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT.
 * ===========================================================================
 *
 * The Supabase edge runtime raises `beforeunload` on the worker before it
 * terminates one for a resource limit, with the reason in the event. This
 * registers a listener that does two things and nothing else:
 *
 *   1. LOGS THE REASON. That is the half that is guaranteed to work, and it
 *      is the half this subsystem has never had. Every previous investigation
 *      into a killed settler had to infer the resource from wall-clock
 *      timings — which, on 22 September, pointed at the wrong one: the
 *      invocation that died had run 3.6 s of a 100 s budget while a longer
 *      one beside it finished cleanly. A line naming `cpu` ends that class of
 *      guesswork for good.
 *   2. ASKS FOR THE CLAIM BACK, best effort. The request is issued and NOT
 *      awaited, because the runtime does not promise the handler time to
 *      finish — so this is an OPTIMISATION and never a guarantee.
 *
 * THE WATCHDOG REMAINS THE GUARANTEE. Nothing here replaces the lease, the
 * grace or the reclaim: a worker that dies without raising the event at all —
 * an out-of-memory abort, a host that vanishes — is recovered exactly as it
 * was before this file existed. What changes is that the ordinary case, where
 * the runtime does give notice, costs a second instead of three and a half
 * minutes.
 *
 * AND THE RELEASE IS NOT A FAILURE REPORT. It clears the lease and leaves the
 * property claimable now, without incrementing `image_work_failures` — the
 * rule the claim itself already answers to, in its own words: "a property
 * would be penalised for our clock rather than for anything about itself".
 * A property that genuinely kills every worker it meets still accumulates
 * failures through the watchdog, which sees the leases this handler failed to
 * release, and still reaches the terminal ceiling.
 */

export interface TerminationRelease {
  /**
   * Hold this claim; a runtime termination will try to give it back.
   *
   * The stage is carried for the LOG only — the release itself names no
   * stage, deliberately. See `p_next_stage` below.
   */
  hold(itemId: string, stage: string): void;
  /** The claim is settled and recorded. Nothing to give back. */
  clear(): void;
}

/**
 * Register the listener once and hand back the holder the caller updates.
 *
 * ONE LISTENER PER ISOLATE, not one per claim: `addEventListener` accumulates,
 * and a handler registered per property would run once for every property the
 * isolate had ever touched, releasing claims that belong to somebody else by
 * now. The claim travels in a mutable holder instead.
 */
export function releaseClaimOnTermination(db: any, tag: string): TerminationRelease {
  let held: { itemId: string; stage: string } | null = null;

  const onTermination = (event: unknown) => {
    const reason = String(
      (event as { detail?: { reason?: unknown } } | null)?.detail?.reason ?? 'unknown');
    try {
      console.warn(`[${tag}] the runtime is terminating this worker`, {
        phase: 'runtime_termination',
        reason,
        stock_item_id: held?.itemId ?? null,
        stage: held?.stage ?? null,
        holding_a_claim: held !== null,
      });
    } catch { /* the release matters more than the line */ }
    if (!held) return;
    try {
      /*
       * ISSUED, NOT AWAITED. There is no promise of time here, and awaiting
       * inside a termination handler is how a handler that would have logged
       * the reason logs nothing at all.
       *
       * `.then()` RATHER THAN `void`, and this is not a style choice: a
       * supabase-js builder is a thenable that does not send anything until
       * something subscribes to it, so a bare `void` on the builder composes
       * the request and never issues it — a release that silently did nothing,
       * which is worse than not having one because it would read as working.
       * The empty handlers are what keep a rejection from becoming an
       * unhandled one on an isolate that is already being torn down.
       */
      db.rpc('complete_builder_stock_image_work', {
        p_item_id: held.itemId,
        /*
         * NULL, WHICH THE COMPLETION READS AS "LEAVE THE STAGE WHERE IT IS"
         * (`coalesce(p_next_stage, i.image_work_stage)`), AND THAT IS THE
         * WHOLE POINT.
         *
         * The first version of this passed `held.stage` — the stage the claim
         * was taken at. Between the settler's completion resolving and its
         * `termination.clear()` there is a window, small but real, in which
         * that value is STALE: the completion has already advanced the
         * property to the next rung, and a release firing there would write
         * the old rung back and walk it down the ladder. A release exists to
         * hand back a LEASE; it has no business having an opinion about which
         * stage a property is on, and saying nothing is the only reading that
         * is correct in both windows.
         */
        p_next_stage: null,
        p_result: `released: worker terminated by the runtime (${reason})`,
        p_error: null,
        p_retry_after_seconds: 0,
        // The stage was never entered. The property did nothing to earn a
        // backoff and must not be walked out of the queue for our clock.
        p_reset_attempts: true,
      }).then(() => {}, () => {});
    } catch { /* the watchdog is the guarantee; this is the shortcut */ }
  };

  try {
    (globalThis as { addEventListener?: (t: string, h: (e: unknown) => void) => void })
      .addEventListener?.('beforeunload', onTermination);
  } catch {
    /*
     * A runtime that does not raise it. Nothing degrades: every claim is
     * still recovered by the lease, the grace and the watchdog, which is
     * where this subsystem was before.
     */
  }

  return {
    hold(itemId: string, stage: string) { held = { itemId, stage }; },
    clear() { held = null; },
  };
}
