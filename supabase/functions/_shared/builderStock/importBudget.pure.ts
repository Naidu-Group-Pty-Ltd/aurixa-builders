/**
 * BUILDER STOCK — ONE CLOCK FOR THE WHOLE IMPORT, AND A CEILING ON WHAT IT
 * WILL TAKE ON.
 *
 * WHY THIS EXISTS. `importStock.ts` already states the right rule and states
 * it well: "`room()` is asked BEFORE each expensive step rather than after it,
 * so the step that would exceed the budget is the one that does not run.
 * Anything it declines is recorded as outstanding rather than dropped." That
 * budget governs the phase that STORES pictures. It governs nothing else, and
 * two things follow that were measured in production.
 *
 * FIRST, THE PHASE IN FRONT OF IT IS ON NO BUDGET AT ALL. `extractStockFile`
 * reads a PDF's text and then decompresses EVERY image on EVERY page through
 * `discoverPdfSourceAssets` — the most expensive single act in an import —
 * before `importStockRecords` has been called and before any deadline exists.
 *
 * SECOND, THE BUDGET THAT DOES EXIST STARTS FROM ZERO AFTER IT.
 * `imageDeadlineAt` defaulted to `Date.now() + IMAGE_BUDGET_MS` computed at
 * the top of `importStockRecords`, and no caller had ever passed one — so the
 * eight seconds began counting only once the unbudgeted phase had finished
 * spending. The run's total was unbounded by construction.
 *
 * MEASURED, 21 SEPTEMBER 2026, on `builder-portal-stock`
 * (`function_edge_logs` for the status, `function_logs` for the cause):
 *
 *   bytes       images  wall    outcome
 *   13,833,454       0   6.4 s  546 CPU Time exceeded, INSIDE extraction;
 *                                no property and no image written; the row
 *                                is still `parsing`
 *    9,553,638       9  12.9 s  546 CPU Time exceeded, NINE MILLISECONDS
 *                                after logging its own success; property and
 *                                all nine images written
 *    8,634,881      10   8.6 s  completed
 *    8,425,036       9  14.3 s  completed
 *    7,182,031       4  12.1 s  completed
 *      752,737       3   9.6 s  completed
 *
 * `extract.ts`'s size contract says enumeration "completes within one
 * invocation" and that a larger count "changes duration, never outcome". Both
 * failures are inside its stated 25 MB ceiling and both changed the outcome,
 * one of them to nothing at all.
 *
 * WHAT THE MEASUREMENTS SEPARATE ON, AND WHAT THEY DO NOT. Wall clock does
 * NOT separate them: 14.3 s completed and 12.9 s was killed. It cannot, and
 * this is the load-bearing fact — the kill is on CPU, and wall time counts
 * the database and storage waits that cost no CPU at all. Nor does image
 * count (9 either side) or stored image bytes (the 8.4 MB document stored
 * 6.9 MB of pictures and lived; the 9.5 MB one stored 2.2 MB and died). The
 * ONE variable that separates every observation is the size of the document
 * itself, and it is also the only one known BEFORE the spending starts.
 *
 * SO THE CEILING IS A PROXY AND IS NAMED AS ONE. It is not a measurement of
 * cost; it is the conservative end of a gap in six observations, one per
 * document. Nothing that has been measured to complete is above it, and both
 * things measured to die are below — which is the most a corpus this size can
 * honestly support, and why a number derived from it is written here, once,
 * where that sentence sits beside it.
 *
 * THE REMEDY IS THE ONE `extract.ts` ALREADY NAMES. Its own contract says the
 * expensive half "already resumes across invocations through the settlement
 * sweeps' budgets and idempotent upserts", and that is not a hope:
 * `repairSourceImagesForUpload` re-reads the SAME source through the SAME
 * extractor and attaches imagery to properties that already exist, creating
 * nothing, and the settler runs it for every upload whose
 * `source_images_settled_version` is below the current provenance. It ran for
 * the 9.5 MB document unprompted and stamped 26 while that upload's own run
 * lay dead. Imagery this import declines is therefore not lost work; it is
 * work a component designed for it does anyway, one document per invocation,
 * behind `withPdfDecodeSlot`.
 *
 * Declining costs the builder a wait they are already told about —
 * `imageryOutstanding` is a state the product models and the page renders as
 * "Images are still being found — you can close this page." Proceeding
 * without room costs them the whole import.
 *
 * Pure: no IO, no clock of its own — the caller supplies `now`.
 */

/**
 * The largest document whose imagery this run will decompress inline.
 *
 * 9 MiB sits inside the gap between the largest document measured to complete
 * (8,634,881 bytes) and the smallest measured to be killed (9,553,638). It is
 * deliberately NOT `MAX_STOCK_FILE_BYTES`: a 25 MB file is still admitted,
 * still imported and still gets its pictures — from the sweep rather than
 * from the request. What changes above this line is WHERE the imagery is
 * read, never WHETHER.
 */
export const INLINE_DISCOVERY_MAX_BYTES = 9 * 1024 * 1024;

/**
 * And the backstop for a document that is small but slow.
 *
 * CHOSEN SO IT CANNOT FIRE ON ANYTHING MEASURED TO WORK. The longest
 * completed run above is 14.3 seconds END TO END, and discovery begins well
 * before a run ends, so no measured success can have reached this point with
 * 15 seconds already spent. It exists for the document the byte ceiling does
 * not describe — a small file that is expensive for some other reason — and
 * it is a backstop rather than the instrument, because wall clock demonstrably
 * does not separate the cases this module was written for.
 */
export const DISCOVERY_ELAPSED_LIMIT_MS = 15_000;

/**
 * The image phase's own allowance, unchanged, and now named where the run's
 * other bounds are.
 *
 * MOVED RATHER THAN COPIED — `importStock.ts` imports it from here. Two
 * spellings of one budget is how the two come to disagree, which is the whole
 * subject of this module.
 */
export const IMAGE_BUDGET_MS = 8_000;

/**
 * The bound on the run as a whole, which is what the storage phase is held to
 * as well as its own allowance.
 *
 * An edge invocation is capped at roughly 150 seconds of wall clock and these
 * runs die on CPU long before that, so this is not the platform's ceiling
 * restated — it is the point past which this import stops taking on new
 * expensive work and lets the sweep finish the job.
 */
export const IMPORT_RUN_BUDGET_MS = 30_000;

/**
 * How long the FIELD COMPLETION may take, and how much room it needs to start.
 *
 * MEASURED, 21 SEPTEMBER 2026, and this is a defect this module already
 * existed to prevent — committed three merges after it was written, by the
 * change that added the completion.
 *
 *   08:59:13.663  field completion unavailable — detail: "model_refused"
 *   08:59:16.717  CPU Time exceeded
 *
 * `runStockImport` handed the completion `Date.now() + MODEL_BUDGET_MS` —
 * NINETY seconds, three times the whole run's own bound — at the point where
 * the run is closest to its ceiling, having already read the document and
 * stored its imagery. Building the request, estimating its tokens and
 * reserving against the ledger is real CPU, and the chain then attempts two
 * providers. On this deployment every attempt ends in the same 402, so the
 * run spent its last seconds discovering something it could not change and
 * was killed doing it.
 *
 * TWO BOUNDS, AND THE FIRST IS THE ONE THAT MATTERS. A phase that cannot
 * finish inside what remains must not START — the rule `importStock.ts` has
 * always stated and the reason `room()` is asked before each expensive step,
 * not after it. `COMPLETION_MIN_ROOM_MS` is what "enough to be worth
 * beginning" means here.
 */
export const COMPLETION_BUDGET_MS = 12_000;
export const COMPLETION_MIN_ROOM_MS = 6_000;

export interface ImportBudget {
  /** When the run began, by the caller's clock. */
  startedAt: number;
  /** When the run stops taking on new expensive work. */
  deadlineAt: number;
  /** How large the document is, which is what the ceiling above is about. */
  byteSize: number;
}

/** The one clock, established once at the top of a run. */
export function openImportBudget(now: number, byteSize: number): ImportBudget {
  return { startedAt: now, deadlineAt: now + IMPORT_RUN_BUDGET_MS, byteSize };
}

/**
 * Why inline discovery was declined, or null when it may proceed.
 *
 * A REASON RATHER THAN A BOOLEAN. "This document is larger than we read
 * inline" and "this run had already spent its time" are different facts about
 * a deployment, and the telemetry line that has to answer "why did this
 * import take two passes" cannot answer it from a flag.
 */
export type DiscoveryRefusal = 'document_too_large' | 'run_budget_spent';

/**
 * May this run decompress the document's images inline?
 *
 * Asked BEFORE the pass, never after — the rule `importStock.ts` already
 * states, applied to the phase that lacked it.
 *
 * `budget` absent means no caller established one, and that answers YES: a
 * path that has not opted in behaves exactly as it does today. That is what
 * keeps this invisible to `repairSourceImagesForUpload`, whose whole
 * invocation is one document and which must never decline the imagery it
 * exists to attach.
 */
export function discoveryRefusal(
  budget: ImportBudget | null | undefined,
  now: number,
): DiscoveryRefusal | null {
  if (!budget) return null;
  if (budget.byteSize >= INLINE_DISCOVERY_MAX_BYTES) return 'document_too_large';
  if (now - budget.startedAt >= DISCOVERY_ELAPSED_LIMIT_MS) return 'run_budget_spent';
  return null;
}

/**
 * The deadline the STORING phase is held to.
 *
 * THE SMALLER OF ITS OWN ALLOWANCE AND WHAT IS LEFT OF THE RUN, which is the
 * half of this defect that HAD a budget: eight seconds measured from the
 * moment that phase begins bounds that phase and nothing in front of it, so a
 * run that had already spent thirty seconds getting there was granted eight
 * more. Taking the minimum can only ever shorten a run, never lengthen one —
 * a document that finishes inside its eight seconds today is untouched.
 */
export function storageDeadlineFrom(
  budget: ImportBudget | null | undefined,
  now: number,
): number | undefined {
  if (!budget) return undefined;
  return Math.min(now + IMAGE_BUDGET_MS, budget.deadlineAt);
}

/**
 * The sentence a builder is shown when imagery was left to the sweep.
 *
 * Says what happened and what happens next, and never asks them to do
 * anything: there is nothing for them to do, and a notice that reads like an
 * instruction with no action is how a working state is reported as a fault.
 */
export const IMAGERY_DEFERRED_WARNING =
  'This document was large enough that its pictures are being read separately. '
  + 'The properties are imported; their images will appear shortly.';

/**
 * When the field completion must stop, or null where it may not begin.
 *
 * THE SMALLER OF ITS OWN ALLOWANCE AND WHAT IS LEFT OF THE RUN, and null
 * below the floor — because a completion is the least important thing an
 * import does. It fills absences on a record that is already correct and
 * already about to be written, so spending the run's last seconds on it
 * risks the whole import to improve a card, which is a trade this product
 * should never make.
 *
 * `budget` absent means no caller established one, which answers with the
 * plain allowance: a path that has not opted in behaves as it did.
 */
export function completionDeadlineFrom(
  budget: ImportBudget | null | undefined,
  now: number,
): number | null {
  if (!budget) return now + COMPLETION_BUDGET_MS;
  if (budget.deadlineAt - now < COMPLETION_MIN_ROOM_MS) return null;
  return Math.min(now + COMPLETION_BUDGET_MS, budget.deadlineAt);
}
