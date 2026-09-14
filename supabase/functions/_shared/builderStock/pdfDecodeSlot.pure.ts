/**
 * BUILDER STOCK — ONE DOCUMENT DECODE AT A TIME PER ISOLATE.
 *
 * WHY THIS EXISTS. The settler deliberately fans out: the scheduler offers it
 * several turns a minute and each invocation claims EXACTLY ONE property
 * (`claimOneImageWorkItem`, FOR UPDATE SKIP LOCKED), because a batch inside
 * one invocation dies as a batch. What that design never priced in is that
 * concurrent invocations of one function share an ISOLATE, and the isolate
 * has one memory ceiling. Five light items in flight cost nothing worth
 * naming; five LINKED-PACKAGE items each holding a ~14 MB brochure while
 * flattening pages and decoding rasters for classification stack five
 * documents' buffers into that one ceiling.
 *
 * MEASURED, 5 SEPTEMBER 2026. The v16 requeue drained 76 of 81 properties and
 * stalled on exactly the five rows of one CSV upload whose images come from
 * per-row linked brochures. Every minute, five settler POSTs landed within
 * ~120 ms of each other, each claimed one of the five, and the worker died
 * 546 (WORKER_LIMIT) with `image_work_last_error` NULL — a kill writes no
 * error — so all five backed off in lockstep and the queue never moved.
 * Each of those documents elects in under three seconds ALONE; the same five
 * ran for an hour without one completion TOGETHER. The resource being
 * exhausted is the isolate's, so the guard lives at the isolate: a
 * module-level slot that lets one document decode at a time and queues the
 * rest.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a lease and not a lock row — the
 * settlement lease already serialises the upload WALK, and a database lock
 * for an in-memory ceiling would outlive the worker that died holding it
 * (this repository has paid for that once: a killed worker runs no
 * `finally`). A promise chain dies with its isolate, which is exactly the
 * lifetime the protected resource has. And not a queue with a depth bound —
 * a caller that waits its turn still runs inside its own invocation budget,
 * and the claim it holds expires on its own if the wait outlives the worker.
 *
 * A REJECTION MUST NOT WEDGE THE CHAIN. The tail the next caller waits on is
 * settled-to-void, so one failed decode releases the slot exactly as a
 * successful one does; the failure itself still reaches the caller that owns
 * it.
 */

let tail: Promise<void> = Promise.resolve();

/** Run `work` once every previously queued decode has finished, releasing the
 *  slot whether `work` resolves or rejects. The caller's own outcome is
 *  returned (or thrown) untouched. */
export function withPdfDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test seam: how many callers are queued behind the live one is not
 *  observable from outside, but whether two decodes can OVERLAP is — see
 *  `builderStockPdfDecodeSlot.test.ts`, which asserts the ordering. */
