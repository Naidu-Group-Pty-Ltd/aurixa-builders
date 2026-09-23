/**
 * Builder stock — "THIS INVOCATION RAN OUT AND HANDED THE REST ON".
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE RATHER THAN A FEW LINES IN `runImport.ts`.
 * ===========================================================================
 *
 * Two reasons, and the second is the one that forced it.
 *
 * FIRST, IT IS NEITHER A SUCCESS NOR A FAILURE and every caller has to be
 * able to say so. A caller that collapsed it onto a failure would fail an
 * import that is about to complete; one that collapsed it onto a success
 * would write `records_detected: 0` over a document that has not been read
 * yet — which is exactly the lie the 22 September kill left on the row. There
 * is therefore one predicate, and callers use it rather than spelling
 * `.continued === true` themselves.
 *
 * SECOND, `runImport.ts` PULLS IN THE WORLD. It imports the extractor, the
 * model chain, `unpdf`, `xlsx`, `tesseract.js` — all from `https://esm.sh/…`,
 * which a Node test runner cannot load. The reader sweep needs the predicate
 * and deliberately imports everything else from `runImport.ts` as a TYPE
 * only; importing the guard as a value from there turned a passing suite red
 * with `Only URLs with a scheme in: file and data are supported`.
 *
 * So the shape and its guard live where anything may import them, and
 * `runImport.ts` re-exports both so a caller need not know that.
 *
 * Pure: no IO, no clock, no remote import.
 */

export interface RunImportContinuation {
  ok: true;
  continued: true;
  /**
   * What is still owed. Named, so a new reason cannot be silent:
   *
   *   `ocr_outstanding`       pages recognition still has to read;
   *   `pictures_outstanding`  a paginated document's pictures, handed with the
   *                           read to an isolate that did not parse it — see
   *                           `importHandover.pure.ts`.
   */
  reason: 'ocr_outstanding' | 'pictures_outstanding';
  /** How many pages, or pictures, are still owed. */
  outstanding: number;
  /** How many crossings this import has spent, for either reason. */
  continuations: number;
}

/** Is this the hand-off rather than an outcome? */
export function isImportContinuation(
  result: { ok: boolean },
): result is RunImportContinuation {
  return result.ok === true
    && (result as RunImportContinuation).continued === true;
}
