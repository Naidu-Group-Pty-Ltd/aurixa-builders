/**
 * Builder stock — HOW MUCH ONE ISOLATE MAY DO, AND WHO STARTS THE NEXT ONE.
 *
 * ===========================================================================
 * THE MEASUREMENT THIS MODULE IS.
 * ===========================================================================
 *
 * MEASURED 22 SEPTEMBER 2026 in production, on one ordinary single-property
 * PDF (`Lot 52 - Bishop 258 - Property Package.pdf`, upload `c5f139b9`). The
 * customer waited **370 seconds** between the upload being accepted and the
 * property being published. About **28 seconds** of that was work. The rest
 * was recovery from ONE event:
 *
 *     08:25:19.958  source       -> eligibility   "stored 3, matched 1"
 *     08:25:20.499  eligibility  -> sanitization  "assessed 0 of 1"
 *     08:25:21.498  *** CPU Time exceeded ***  + shutdown
 *
 * and everything after it is the cost of a worker that died holding a claim:
 *
 *     +120 s  the dead worker's lease runs its full term
 *      +30 s  the watchdog's grace (`claim_until < now() - 30 seconds`)
 *      +11 s  waiting for the next `* * * * *` tick to run the watchdog
 *      +30 s  the failure backoff the watchdog writes (30·2^0)
 *      +30 s  waiting for the next tick to dispatch a worker
 *     ------
 *      221 s  before the third stage of a four-stage ladder was even attempted
 *
 * and then 121 s more, because the killed worker had stamped the one image's
 * `sanitization_attempt` before dying — that stamp is deliberately written
 * BEFORE the work, and it carries a ten-minute cooldown — so the pass that
 * finally ran answered `repaired 0, cleared 0, refused 0` and settled the
 * property with no photograph. Only an unrelated upload-level sweep, which
 * re-read the whole document a second time, replaced `source_detail` and took
 * the cooldown with it, let the real work happen at 08:31:05.
 *
 * ===========================================================================
 * WHY THE EXISTING ALLOWANCE COULD NOT SEE IT.
 * ===========================================================================
 *
 * The settler budgets WALL CLOCK (`BUDGET_MS = 100_000`) and counts DOCUMENTS
 * (`HEAVY_DOCUMENTS_PER_INVOCATION = 3`, measured 7 September 2026 against the
 * ~256 MB isolate ceiling: 50 → 173 → 236 → 247 → 254 → 287 → 318 MB over six
 * brochures, the fifth crossing). Both of those are real and neither is the
 * constraint that fired here.
 *
 * The invocation that died had been alive **3.6 seconds** and had used far
 * less than one document of its allowance. Wall clock does not separate it
 * from the invocation at 08:30:12 that ran **6,877 ms** and finished cleanly.
 * What separates them is what they SPENT THE CPU ON:
 *
 *   08:25:17.9  KILLED   opened a document (`source`), decoded a photograph
 *                        (`eligibility`), began a full-resolution decode
 *                        (`sanitization`) — three CPU-heavy operations
 *   08:30:12    ok       opened a document and nothing else
 *   08:29:03    ok       two metadata stages, no decode
 *   08:31:06    ok       one decode and one metadata stage
 *
 * Every invocation in that window that survived spent its CPU on ONE KIND of
 * heavy work. The only one that mixed a document with a decode is the only
 * one the runtime killed. That is one observation and it is stated as one —
 * but it is the observation the allowance did not have a name for, and an
 * allowance that cannot name a resource cannot bound it.
 *
 * ===========================================================================
 * THE RULE.
 * ===========================================================================
 *
 * An isolate commits to ONE CLASS of expensive work.
 *
 *   `document`  `source` — opens a PDF, walks its page tree, flattens pages,
 *               extracts every raster and uploads them. Bounded by MEMORY,
 *               at the figure the 7 September measurement chose.
 *   `decode`    `eligibility` and `sanitization` — download a stored
 *               photograph and decode it; sanitization decodes at full
 *               resolution, reconstructs and decodes again. Bounded by CPU.
 *   `metadata`  `fallback` and anything else — reads rows and decides.
 *               Decodes nothing, opens nothing.
 *
 * A document invocation does not then decode, and a decode invocation does
 * not then open a document. Metadata rides along with either.
 *
 * AND THE LATENCY THAT WOULD COST IS NOT PAID, because of the second half:
 *
 * ===========================================================================
 * AN INVOCATION THAT STOPS WITH WORK LEFT STARTS ITS OWN SUCCESSOR.
 * ===========================================================================
 *
 * The ladder is four stages and the whole orchestration was
 * `* * * * *` cron: a property crossed a stage boundary only when a minute
 * boundary came round, so a four-stage ladder cost up to four minutes of
 * clock for five seconds of work. Splitting the allowance by class would make
 * that worse — more invocations, each waiting for a minute.
 *
 * So it does not wait. A settler that advanced something and leaves work
 * claimable dispatches the next settler itself, through the dispatcher the
 * cron tick already uses. A fresh isolate has a fresh allowance and a fresh
 * CPU budget, which is the whole point: bounded work per isolate, immediate
 * hand-off between isolates, and the minute tick demoted to what it should
 * always have been — the recovery clock, not the transport.
 *
 * TWO BOUNDS MAKE THE CHAIN TERMINATE, and they are not timers.
 *
 *   • ONLY AN INVOCATION THAT ADVANCED SOMETHING MAY RE-ARM. `settled` is the
 *     number of stages this invocation actually completed. An invocation that
 *     claimed nothing, or handed everything back, returns and leaves the queue
 *     to the tick. So an unbounded chain would require unbounded real
 *     progress, which is a queue draining rather than a loop.
 *   • AND ONLY WHILE SOMETHING IS CLAIMABLE. `builder_stock_dispatch_image_workers`
 *     refuses when the claimable count is zero, so the last invocation of an
 *     import starts nobody.
 *
 * Neither of them is a sleep, a poll or a retry, which is the property the
 * whole change exists for: nothing on the SUCCESS path waits for a clock.
 *
 * Pure: no IO and no clock.
 */

/** What an item's stage spends, in the terms the runtime actually limits. */
export type WorkClass = 'document' | 'decode' | 'metadata';

/**
 * Which class a ladder stage belongs to.
 *
 * NAMED BY WHAT THE STAGE DOES, never by how long it has been observed to
 * take: `eligibility` is a fast stage and a decode all the same, and the
 * invocation that died died on the CPU an `eligibility` decode spends rather
 * than on the time it takes.
 */
export function workClassOf(stage: string): WorkClass {
  if (stage === 'source') return 'document';
  if (stage === 'eligibility' || stage === 'sanitization') return 'decode';
  return 'metadata';
}

/**
 * Documents one isolate may open. MEMORY, measured 7 September 2026 — see the
 * settler's own header, which this number is taken from unchanged.
 */
export const DOCUMENTS_PER_INVOCATION = 3;

/**
 * Photographs one isolate may decode.
 *
 * DELIBERATELY NOT DERIVED FROM THE KILL, because the kill is one
 * observation and it was a MIXED invocation — it says a document plus two
 * decodes is too much and says nothing about three decodes on their own. So
 * this is the conservative reading of the same evidence: the surviving
 * decode invocation in that window did one, and three leaves room for an
 * ordinary property's `eligibility` and `sanitization` in a single isolate
 * with one to spare. It is a ceiling to be lowered if the runtime reports
 * another kill, not a target.
 */
export const DECODES_PER_INVOCATION = 3;

/**
 * Metadata stages one isolate may run. Generous, because they open nothing
 * and decode nothing; bounded at all only so a pathological queue cannot
 * make one invocation run for ever.
 */
export const METADATA_ITEMS_PER_INVOCATION = 12;

export interface AllowanceSpent {
  documents: number;
  decodes: number;
  metadata: number;
}

export const newAllowance = (): AllowanceSpent => ({ documents: 0, decodes: 0, metadata: 0 });

/** May this isolate take on a claim at this stage? */
export function mayTakeStage(stage: string, spent: AllowanceSpent): boolean {
  switch (workClassOf(stage)) {
    case 'document':
      return spent.decodes === 0 && spent.documents < DOCUMENTS_PER_INVOCATION;
    case 'decode':
      return spent.documents === 0 && spent.decodes < DECODES_PER_INVOCATION;
    default:
      return spent.metadata < METADATA_ITEMS_PER_INVOCATION;
  }
}

/** Record that this isolate has run a stage. Mutates, and returns the same object. */
export function spendStage(stage: string, spent: AllowanceSpent): AllowanceSpent {
  switch (workClassOf(stage)) {
    case 'document': spent.documents += 1; break;
    case 'decode': spent.decodes += 1; break;
    default: spent.metadata += 1; break;
  }
  return spent;
}

/**
 * Why this invocation refused a claim it had already taken. Rendered into the
 * completion's `result`, because a handback with no reason is the state this
 * subsystem has already spent a week reading as a stall.
 */
export function refusalFor(stage: string, spent: AllowanceSpent): string {
  const workClass = workClassOf(stage);
  if (workClass === 'document' && spent.decodes > 0) {
    return 'deferred: this isolate has decoded and may not also open a document';
  }
  if (workClass === 'decode' && spent.documents > 0) {
    return 'deferred: this isolate has opened a document and may not also decode';
  }
  return `deferred: this isolate has spent its ${workClass} allowance`;
}

export interface RearmInput {
  /** Stages this invocation actually completed. */
  settled: number;
  /** What the queue says is claimable now, after the last claim was released. */
  claimable: number;
}

/**
 * Should this invocation start its successor rather than leave the queue to
 * the minute tick?
 *
 * BOTH TERMS ARE REQUIRED and each closes a different failure. Without
 * `settled > 0` an invocation that could do nothing would start another one
 * that can do nothing, for ever. Without `claimable > 0` the last invocation
 * of every import pays for one more.
 */
export function shouldRearm(input: RearmInput): boolean {
  return input.settled > 0 && input.claimable > 0;
}
