/**
 * Builder stock lists — what a BUILDER is told when the assisted reader fails.
 *
 * Separate from `modelExtractionFailure.pure.ts` on purpose. That module says
 * what went wrong with the model; this one says what to put in front of the
 * person who uploaded the document, and the two are different questions
 * because the answer to the second depends on WHAT KIND OF DOCUMENT it was.
 *
 * The defect this exists to end, measured 20 September 2026: a builder
 * uploaded `LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf`, a 6.8 MB property
 * brochure, and was told
 *
 *   "Its columns were not recognised as a stock list … If the file lists one
 *    property per row, giving it column headings lets it import without
 *    assistance."
 *
 * A brochure has no columns. The sentence was written for a spreadsheet whose
 * headings we did not recognise and was then shown for every source type,
 * including the ones the assisted reader exists BECAUSE they are not tables.
 * It asked a builder to repair a document that was never the problem, for a
 * credential this deployment had never been given.
 *
 * Two rules carry this module.
 *
 * **A remedy is offered only where the reader could act on it.** The
 * column-heading hint is true and useful for a CSV or a workbook — those
 * genuinely are one property per row and naming the columns really does let
 * the deterministic parser take them without the model. It is meaningless for
 * a PDF, a photograph, a Word brochure, a slide deck or an RTF, so
 * `SOURCE_HAS_COLUMNS` decides, and a test asserts no message drawn for a
 * document kind can contain the word "column".
 *
 * **A failure of ours never reads as a finding about the document.** Every
 * sentence here says what WE could not do, and — where the next attempt might
 * work — says so, because the alternative is a builder deleting and
 * re-uploading a file that was always fine.
 */
import type { ModelExtractionFailureCode } from './modelExtractionFailure.pure.ts';
import type { StockFileKind } from './fileTypes.pure.ts';

/**
 * Source kinds that are a GRID — one property per row, under headings.
 *
 * These are the only kinds for which "give it column headings" is a real
 * remedy: the deterministic readers parse exactly these shapes, so recognised
 * headings genuinely remove the need for the model.
 *
 * Everything else — `pdf`, `image`, `word`, `richtext`, `presentation` — is a
 * DOCUMENT. The assisted reader is not a fallback for those, it is the
 * intended path, and telling their uploader about headings is telling them to
 * turn their brochure into a spreadsheet.
 */
export const SOURCE_HAS_COLUMNS: ReadonlySet<StockFileKind> = new Set<StockFileKind>([
  'delimited',
  'spreadsheet',
  'structured',
  'markup',
  'opendocument',
]);

export interface AssistedReaderFailureInput {
  code: ModelExtractionFailureCode;
  /** Shapes the noun: a file a builder uploaded, or a page we fetched. */
  sourceKind: 'file' | 'url';
  /**
   * How the source was classified. Absent for a URL source whose kind was
   * never settled, which is treated as a document — the conservative side,
   * since a wrong column hint is worse than a missing one.
   */
  classificationKind?: StockFileKind;
}

export interface AssistedReaderFailure {
  /**
   * Stable and machine-readable. Written to `builder_stock_uploads.error_code`
   * and never reworded — support, the UI's retry affordance and any future
   * reader key on it.
   *
   * `assisted_reader_unavailable` keeps its existing spelling because rows,
   * logs and a standing test already carry it; the two new codes are additive.
   */
  code:
    | 'assisted_reader_unavailable'
    | 'assisted_reader_timeout'
    | 'assisted_reader_invalid_response'
    | 'ai_budget_exhausted'
    | 'assisted_reader_refused';
  /** Safe to show the builder. */
  message: string;
  status: number;
  /**
   * Is trying again, unchanged, a reasonable thing for the builder to do?
   *
   * True for the two infrastructure readings. False when a model answered and
   * the answer was unusable — that is ours to fix and a second identical
   * request would produce the same thing, so offering a retry would be a
   * button that cannot work.
   */
  retryable: boolean;
}

/** "that file" / "that page", so one sentence serves an upload and a fetch. */
function noun(sourceKind: 'file' | 'url'): string {
  return sourceKind === 'url' ? 'page' : 'file';
}

/**
 * The column-heading hint, for the grid sources it is true of, and nothing at
 * all for the rest.
 *
 * Deliberately a sentence that stands alone rather than a clause spliced into
 * the failure: it is a separate statement about the document, offered beside
 * a statement about us, and the two must not read as cause and effect.
 */
function headingsHint(input: AssistedReaderFailureInput): string {
  if (!input.classificationKind) return '';
  if (!SOURCE_HAS_COLUMNS.has(input.classificationKind)) return '';
  return ` If the ${noun(input.sourceKind)} lists one property per row, giving it`
    + ' column headings lets it import without assistance.';
}

/**
 * What the row records and what the builder reads, for one model failure.
 */
export function assistedReaderFailure(
  input: AssistedReaderFailureInput,
): AssistedReaderFailure {
  const what = noun(input.sourceKind);
  const hint = headingsHint(input);

  switch (input.code) {
    case 'model_timeout':
      return {
        code: 'assisted_reader_timeout',
        // Names the one thing that DID work, so a builder is not left thinking
        // the document was rejected.
        message: `We read that ${what}, but the assisted property reader ran out of time`
          + ` before it finished. Try reading this source again shortly.${hint}`,
        status: 503,
        retryable: true,
      };

    case 'model_invalid_response':
    case 'model_missing_tool_call':
      return {
        code: 'assisted_reader_invalid_response',
        /*
         * NO RETRY PROMISE HERE. The model answered; the answer was not usable.
         * "Try again shortly" would be false — the same request produces the
         * same answer — and `retryable: false` keeps the UI from drawing a
         * button that cannot work.
         *
         * AND IT NO LONGER CLAIMS AN ALERT. This said "Our team has been
         * alerted", under a comment asserting that was true. Nothing in this
         * repository alerts on it: the only trace is a `console.error` in the
         * edge log and `error_detail` on the row, which nothing watches and
         * `get_upload` projects away. A promise the product does not keep is
         * worse than no promise, because it tells a builder to stop looking.
         * What IS true is that the attempt is recorded against this stock
         * list, where whoever administers the workspace can see it.
         */
        message: `We read that ${what}, but the assisted property reader did not return a`
          + ` usable answer. The attempt is recorded against this stock list for`
          + ` whoever administers this workspace.${hint}`,
        status: 502,
        retryable: false,
      };

    case 'model_refused':
      return {
        code: 'assisted_reader_refused',
        /*
         * NOT "try again shortly". The provider turned the request away on
         * credentials or credit, and neither is something waiting fixes or
         * the builder can act on.
         *
         * AND IT NAMES WHICH KIND, because the two remedies are different
         * people. Measured 21 SEPTEMBER 2026: every assisted read on this
         * deployment answered `refused 402` — an account with no credit — and
         * the sentence a builder got, "the assisted property reader is not
         * currently able to run for this workspace", describes a broken
         * feature rather than an unpaid bill and sends nobody anywhere. The
         * builder still cannot act on it, so the wording stays calm and
         * blameless; what changes is that it points at the account rather
         * than at the product, and it no longer claims an alert nothing
         * sends.
         */
        message: `We read that ${what}, but the assisted property reader was turned away`
          + ` — its account for this workspace needs credentials or credit before it`
          + ` can run. The attempt is recorded against this stock list for whoever`
          + ` administers this workspace.${hint}`,
        status: 503,
        retryable: false,
      };

    case 'model_budget_exhausted':
      return {
        code: 'ai_budget_exhausted',
        /*
         * SAYS WHAT HAPPENED WITHOUT NAMING A PRICE. A builder is not the
         * party who sets this ceiling and cannot raise it, so the sentence
         * tells them the read did not happen and that it is being looked at —
         * never a figure, never an invitation to try again, because trying
         * again before the month turns over produces exactly this.
         */
        message: `We read that ${what}, but the assisted property reader has reached its`
          + ` monthly limit for this workspace, so it was not read. The attempt is`
          + ` recorded against this stock list for whoever administers this`
          + ` workspace.${hint}`,
        status: 503,
        retryable: false,
      };

    case 'model_unavailable':
    default:
      return {
        code: 'assisted_reader_unavailable',
        message: `We read that ${what}, but the assisted property reader was temporarily`
          + ` unavailable. Try reading this source again shortly.${hint}`,
        status: 503,
        retryable: true,
      };
  }
}

/**
 * The upload error codes a builder may usefully retry from.
 *
 * Read by the portal to decide whether to offer "Read again" on a failed
 * source. Exported as data rather than re-derived in the UI, because a second
 * copy of "which failures are retryable" is how the button and the server come
 * to disagree about the same row.
 */
export const RETRYABLE_UPLOAD_ERROR_CODES: readonly string[] = [
  'assisted_reader_unavailable',
  'assisted_reader_timeout',
];
