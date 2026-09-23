/**
 * Builder stock — HOW MUCH EXPENSIVE WORK ONE IMPORT INVOCATION MAY TAKE ON.
 *
 * ===========================================================================
 * THIS REPLACES A PROXY WITH A MEASUREMENT.
 * ===========================================================================
 *
 * `importBudget.pure.ts` says of its own byte ceiling, in writing, that "it is
 * not a measurement of cost; it is the conservative end of a gap in six
 * observations". That was the most those six observations could honestly
 * support. There is now a real one.
 *
 * MEASURED 22 September 2026 through the real stack, eight stress documents,
 * timings read back out of `builder_stock_uploads.stage_timings`
 * (`docs/builder-portal/54-what-the-importer-spends.md`):
 *
 *   • EXACTLY TWO STAGES ARE EXPENSIVE. `ocr` reaches 9,223 ms and
 *     `image_store` reaches 9,388 ms. Every other stage — opening the
 *     document, its text layer, the positioned layout, normalisation,
 *     segmentation, the property reader, image discovery — is TENS of
 *     milliseconds on every document in the corpus, including the 5.63 MB
 *     one. The whole `metadata` class is 485 ms across all eight documents.
 *
 *   • A STORED IMAGE COSTS ABOUT 1.5 SECONDS. 1,486 ms for one, 1,509 for
 *     one, 1,474 for one, 9,388 for eight — decode, classify, assess, upload.
 *
 *   • AN OCR PAGE COSTS ABOUT 3 SECONDS. 9,223 ms over three recognised
 *     pages, plus the rasterisation in front of them.
 *
 * ===========================================================================
 * WHERE THE CEILING COMES FROM, AND WHY IT IS NOT A ROUND NUMBER PICKED.
 * ===========================================================================
 *
 * The platform does not expose its CPU meter. `546` names no resource and no
 * amount, so nothing here can measure the actual allowance — which means the
 * ceiling has to be derived from the other end: from what has been observed to
 * die.
 *
 * The SHORTEST production run measured to be killed is 6.4 seconds of WALL
 * CLOCK (`importBudget.pure.ts`'s own table, a 13.8 MB document killed inside
 * extraction). Compute is a subset of wall clock, so whatever the allowance
 * is, it is at most 6,400 ms of the ledger's own measure and probably well
 * under it.
 *
 * The rule that matters is `importStock.ts`'s: a step that would exceed the
 * budget is the one that does not run — so the test is asked BEFORE a step,
 * and the worst case is therefore `ceiling + the largest single step`. The
 * largest single step measured is an OCR page at ~3,100 ms. So:
 *
 *     ceiling + 3,100  <  6,400      =>      ceiling  <  3,300
 *
 * `EXPENSIVE_SPEND_CEILING_MS` is 3,000. That is a derivation from two
 * measurements and one inequality, and it is stated here rather than tuned:
 * if the step costs change, the ceiling moves with them.
 *
 * AND PRODUCTION HAS SINCE SHOWN IT TO BE AN UPPER BOUND, NOT A MEASUREMENT.
 * 23 September 2026: the same brochure was killed five more times after this
 * shipped — twice on the portal's paths, three times in the settler's re-read
 * of the same bytes — and the one ledger the runtime left read 1,155 ms of
 * document stages and 485 ms of decode — well under 3,000 — because the
 * platform charges CPU this ledger cannot see: the isolate's start-up, the
 * download, the engine's cold passes.
 * So it is no longer what keeps a PDF alive. A paginated document's pictures
 * are not decoded in the isolate that parsed it at all
 * (`importHandover.pure.ts`), which needs no number; the isolates that decode
 * them take one budgeted batch of kinds each, and the one that attaches them
 * decodes at most the image settler's measured three
 * (`DECODES_PER_INVOCATION`). This ceiling still governs recognition and a
 * container's inline pictures, and it is stated here, beside its derivation,
 * that production found the derivation loose.
 *
 * WHAT IT COSTS TO BE CONSERVATIVE, AND WHY IT IS THE RIGHT SIDE. Overshoot
 * kills the invocation. Undershoot hands work to a component built for it —
 * the image settler, which is CPU-class-aware, claimed per item and fanned out
 * six wide immediately — or to a successor invocation, which starts with a
 * fresh allowance. The penalty for being early is one dispatch; the penalty
 * for being late is the whole import.
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO.
 * ===========================================================================
 *
 * IT DOES NOT BOUND CHEAP WORK. `metadata` never enters the reckoning, and
 * nor do the tens-of-milliseconds document stages. A document that fits must
 * not pay for a document that does not: a single-property native brochure
 * spends 0.15–0.35 s in total and therefore crosses no isolate, takes no
 * checkpoint and behaves in every respect as it does today.
 *
 * IT IS NOT A WALL CLOCK. `IMPORT_RUN_BUDGET_MS` and
 * `DISCOVERY_ELAPSED_LIMIT_MS` remain, and remain wall clock, because they
 * bound a run's total LATENCY. This bounds its COMPUTE, which is the resource
 * that actually kills it, and the two are not interchangeable — the 22
 * September table's 14.3 s completion and 12.9 s kill are the proof.
 *
 * Pure: no IO and no clock. The caller supplies the ledger.
 */
import {
  classSpendMs, type ImportStageLedger, type ImportWorkClass,
} from './importStageLedger.pure.ts';

/**
 * The point past which this invocation stops taking on new expensive work.
 * Derived above; changing it means re-deriving it from the step costs.
 */
export const EXPENSIVE_SPEND_CEILING_MS = 3_000;

/**
 * What one more step of each kind is expected to cost. MEASURED, not assumed,
 * and named so the arithmetic in the header can be checked against them.
 */
export const RASTER_STEP_MS = 1_500;
export const OCR_PAGE_MS = 3_100;

/**
 * The classes that count against the ceiling.
 *
 * `metadata` is excluded because it was measured at 485 ms across eight
 * documents — charging it would shorten every import to protect against
 * something that has never cost anything.
 */
const CHARGED: readonly ImportWorkClass[] = ['document', 'raster'];

/** What this run has spent on work that can kill it. */
export function expensiveSpendMs(ledger: ImportStageLedger | null | undefined): number {
  if (!ledger) return 0;
  return CHARGED.reduce((total, workClass) => total + classSpendMs(ledger, workClass), 0);
}

/**
 * May this invocation begin a step expected to cost `stepMs`?
 *
 * ASKED BEFORE THE STEP. The question is not "have we overspent" — by then it
 * is too late — but "would beginning this take us past the ceiling". A run
 * with 2,900 ms spent may still take a 1,500 ms image, and that is deliberate:
 * the ceiling is set so that the worst overshoot stays inside what has been
 * observed to survive.
 *
 * A null ledger answers YES. A caller that has not opted in behaves exactly as
 * it does today — the same rule `discoveryRefusal` follows, and what keeps
 * this invisible to the repair sweep, whose whole invocation is one document
 * and which must never decline the imagery it exists to attach.
 */
export function mayBegin(
  ledger: ImportStageLedger | null | undefined,
  stepMs: number,
): boolean {
  if (!ledger) return true;
  return expensiveSpendMs(ledger) < EXPENSIVE_SPEND_CEILING_MS
    && stepMs <= EXPENSIVE_SPEND_CEILING_MS + RASTER_STEP_MS;
}

/** May this invocation store another picture inline? */
export const mayStoreImage = (ledger: ImportStageLedger | null | undefined): boolean =>
  mayBegin(ledger, RASTER_STEP_MS);

/** May this invocation recognise another page? */
export const mayRecognisePage = (ledger: ImportStageLedger | null | undefined): boolean =>
  mayBegin(ledger, OCR_PAGE_MS);

/**
 * What decoding a picture to decide its role costs, per megapixel. MEASURED
 * in production, where it matters: about 1 s for a 2,000×1,250 hero (2.5 MP)
 * and 3.1 s for a 3,556×2,000 one (7.1 MP), both recorded in
 * `assessSourceImage.ts` — so 440 ms a megapixel, the slower of the two. The
 * acceptance machine decodes at about half that (4,854 ms for 22.1 MP), and
 * the production rate is the one used, because an estimate that errs low is
 * the one that kills the worker.
 */
export const ROLE_DECODE_MS_PER_MEGAPIXEL = 440;

/** What deciding the roles of pictures totalling `pixels` should cost. */
export const roleDecodeMs = (pixels: number): number =>
  (Math.max(0, pixels) / 1_000_000) * ROLE_DECODE_MS_PER_MEGAPIXEL;

/**
 * May this invocation decide the roles of a document's pictures here?
 *
 * WHOLE OR NOT AT ALL, AND PRICED BEFORE IT BEGINS. A stored picture and a
 * recognised page are steps of a known size; this one's size is the
 * document's choice — up to `MAX_VISION_DECODES` pictures in one pass that
 * cannot be divided, because roles decided on part of the set are decided on
 * partial evidence. It ran with no gate at all until 23 September 2026, when
 * `stress-multi-property` spent 4,854 ms in it after the document had already
 * been read: the unguarded loop `mayStoreImage` was written to close, one
 * call earlier.
 *
 * So it must fit INSIDE the ceiling rather than be allowed one step past it,
 * as `mayBegin` allows a known step: an estimate is exactly where the error
 * is, and the margin between the ceiling and the shortest measured kill is
 * what absorbs it. Declining costs nothing but a dispatch — the settler
 * decides the same roles, whole, in an isolate of its own.
 */
export function mayDecideRoles(
  ledger: ImportStageLedger | null | undefined,
  pixels: number,
): boolean {
  if (!ledger) return true;
  return expensiveSpendMs(ledger) + roleDecodeMs(pixels) <= EXPENSIVE_SPEND_CEILING_MS;
}

/**
 * How many milliseconds of expensive work are left before the ceiling.
 *
 * For the one caller that needs a DEADLINE rather than a yes/no — the image
 * phase, whose loop is inside `attachDocumentMedia` and which reads a
 * wall-clock instant. Converting the remaining allowance into an instant at
 * the moment the phase begins is sound because that phase does almost nothing
 * BUT compute: it decodes, classifies and uploads, and the upload wait is the
 * only part that is not CPU. Erring by counting that wait against the ceiling
 * makes the phase stop EARLIER, which is the safe direction.
 */
export function remainingExpensiveMs(
  ledger: ImportStageLedger | null | undefined,
): number {
  if (!ledger) return Number.POSITIVE_INFINITY;
  return Math.max(0, EXPENSIVE_SPEND_CEILING_MS - expensiveSpendMs(ledger));
}
