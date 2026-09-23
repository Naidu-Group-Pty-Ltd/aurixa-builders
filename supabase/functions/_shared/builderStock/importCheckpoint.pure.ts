/**
 * Builder stock — THE MINIMUM DURABLE STATE THAT STOPS AN IMPORT PAYING TWICE.
 *
 * ===========================================================================
 * WHAT IS IN HERE, AND WHY ALMOST NOTHING IS.
 * ===========================================================================
 *
 * A resumable import is only worth having if resuming is CHEAPER than
 * starting again. The measurement
 * (`docs/builder-portal/54-what-the-importer-spends.md`) says what is
 * expensive and the list is two items long: recognising a scanned page
 * (~3,100 ms each) and storing a picture (~1,500 ms each). Everything else in
 * the pipeline — opening the document, its text layer, the positioned layout,
 * normalisation, segmentation, the deterministic reader — is tens of
 * milliseconds, and re-deriving it costs less than reading it back.
 *
 * So only ONE of the two is checkpointed here, and the other is not
 * checkpointed at all:
 *
 *   • RECOGNISED PAGE TEXT is stored. A few kilobytes stand for three seconds
 *     of CPU, it cannot be re-derived any other way, and there is nowhere else
 *     for the work to go.
 *
 *   • PICTURES ARE NOT STORED HERE. They already have somewhere better to go.
 *     The image settler is CPU-class-aware, claims work per item and is
 *     dispatched immediately by `builder_stock_kick_image_work`; an image this
 *     import declines is not lost work, it is work a component designed for it
 *     does anyway. Persisting decoded rasters to resume them would be exactly
 *     the "giant useless blob stored to avoid computation" this design is
 *     told not to write.
 *
 * ===========================================================================
 * THE RULE THAT MAKES IT SAFE: A CHECKPOINT BELONGS TO ONE DOCUMENT.
 * ===========================================================================
 *
 * The checkpoint carries the SHA-256 of the bytes it was taken from, and a
 * checkpoint whose digest does not match the bytes in hand is DISCARDED
 * whole — never merged, never partly trusted.
 *
 * That is not defensive tidiness. `reprocess_upload` re-reads a link, and a
 * linked stock list is linked precisely because the builder keeps editing it
 * (`49-re-importing-a-linked-stock-list.md`). Recognised text from yesterday's
 * version of a sheet, merged into today's, is a property described by a
 * document that no longer says that. The digest is what makes re-reading a
 * changed source indistinguishable from a first read.
 *
 * ===========================================================================
 * AND IT IS BOUNDED, FAILING TOWARDS RE-COMPUTATION.
 * ===========================================================================
 *
 * A checkpoint that grows without limit becomes a row nobody can read and an
 * UPDATE nobody can afford. Both bounds below fail in the same direction:
 * past them, nothing is stored and the page is recognised again. Paying 3
 * seconds of CPU twice is a cost; writing a megabyte into a row on every
 * stage boundary is a fault.
 *
 * Pure: no IO and no clock.
 */

/** The shape's own version, so a reader can refuse one it does not know. */
export const IMPORT_CHECKPOINT_VERSION = 1;

/** The most recognised text one page may contribute. */
export const MAX_CHECKPOINT_PAGE_CHARS = 32_000;
/** The most recognised text the whole checkpoint may hold. */
export const MAX_CHECKPOINT_TOTAL_CHARS = 256_000;
/**
 * How many times one upload may be continued before it stops.
 *
 * `OCR_MAX_PAGES` is 8 and a hand-off recognises at least one page, so eight
 * crossings covers the worst document the recogniser will accept. Two spare,
 * because a crossing can also be spent on a page the recogniser refuses.
 */
export const MAX_IMPORT_CONTINUATIONS = 10;

export interface ImportCheckpoint {
  v: number;
  /** The digest of the document this checkpoint describes. */
  sha256: string;
  /** How many times this import has been continued. */
  continuations: number;
  ocr?: {
    /** Recognised text, by 1-based page number. */
    pages: Record<string, string>;
    /** Pages the recogniser was asked for and refused, so it is not re-asked. */
    refused?: number[];
    /** The recogniser reported itself unavailable in this deployment. */
    unavailable?: boolean;
  };
}

/** An empty checkpoint for a document. */
export function openCheckpoint(sha256: string): ImportCheckpoint {
  return { v: IMPORT_CHECKPOINT_VERSION, sha256, continuations: 0 };
}

/**
 * The checkpoint a stored value offers for THESE bytes, or null.
 *
 * Null for: nothing stored, an unreadable shape, a version this build does not
 * know, and — the one that matters — a digest that is not this document's.
 */
export function readCheckpoint(
  stored: unknown, sha256: string,
): ImportCheckpoint | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const row = stored as Partial<ImportCheckpoint>;
  if (row.v !== IMPORT_CHECKPOINT_VERSION) return null;
  if (typeof row.sha256 !== 'string' || row.sha256 !== sha256) return null;
  const pages = row.ocr && typeof row.ocr === 'object' && row.ocr.pages
    && typeof row.ocr.pages === 'object' && !Array.isArray(row.ocr.pages)
    ? row.ocr.pages as Record<string, string> : null;
  return {
    v: IMPORT_CHECKPOINT_VERSION,
    sha256,
    continuations: Number.isFinite(row.continuations) ? Number(row.continuations) : 0,
    ...(pages || row.ocr ? {
      ocr: {
        pages: pages ?? {},
        refused: Array.isArray(row.ocr?.refused)
          ? row.ocr!.refused.filter((page) => Number.isFinite(page)).map(Number) : [],
        unavailable: row.ocr?.unavailable === true,
      },
    } : {}),
  };
}

/** The recognised pages a checkpoint holds, as the recogniser's own map. */
export function checkpointPages(
  checkpoint: ImportCheckpoint | null | undefined,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, text] of Object.entries(checkpoint?.ocr?.pages ?? {})) {
    const page = Number(key);
    if (Number.isFinite(page) && page > 0 && typeof text === 'string') out.set(page, text);
  }
  return out;
}

/** Pages this checkpoint says not to ask for again. */
export function checkpointSettledPages(
  checkpoint: ImportCheckpoint | null | undefined,
): Set<number> {
  const settled = new Set<number>(checkpointPages(checkpoint).keys());
  for (const page of checkpoint?.ocr?.refused ?? []) settled.add(page);
  return settled;
}

/** How much recognised text a checkpoint is already carrying. */
function totalChars(checkpoint: ImportCheckpoint): number {
  return Object.values(checkpoint.ocr?.pages ?? {})
    .reduce((sum, text) => sum + text.length, 0);
}

/**
 * Fold a recognised page in, or leave the checkpoint alone.
 *
 * RETURNS A NEW OBJECT rather than mutating, so a caller cannot commit half a
 * fold. Declines silently past either bound — see the header: past a bound the
 * page is recognised again, which is a cost, where an unbounded row is a
 * fault.
 */
export function withRecognisedPage(
  checkpoint: ImportCheckpoint, page: number, text: string,
): ImportCheckpoint {
  if (!Number.isFinite(page) || page <= 0) return checkpoint;
  if (typeof text !== 'string' || text.length > MAX_CHECKPOINT_PAGE_CHARS) return checkpoint;
  if (totalChars(checkpoint) + text.length > MAX_CHECKPOINT_TOTAL_CHARS) return checkpoint;
  const ocr = checkpoint.ocr ?? { pages: {}, refused: [], unavailable: false };
  return {
    ...checkpoint,
    ocr: { ...ocr, pages: { ...ocr.pages, [String(page)]: text } },
  };
}

/** Record that the recogniser was asked for a page and would not read it. */
export function withRefusedPage(
  checkpoint: ImportCheckpoint, page: number,
): ImportCheckpoint {
  if (!Number.isFinite(page) || page <= 0) return checkpoint;
  const ocr = checkpoint.ocr ?? { pages: {}, refused: [], unavailable: false };
  if ((ocr.refused ?? []).includes(page)) return checkpoint;
  return { ...checkpoint, ocr: { ...ocr, refused: [...(ocr.refused ?? []), page] } };
}

/**
 * Record that this deployment has no recogniser.
 *
 * A DIFFERENT FACT FROM A REFUSED PAGE, and a successor has to be able to tell
 * them apart: a refused page is a statement about that page, and an
 * unavailable recogniser is a statement about the deployment, which means
 * there is no point continuing at all.
 */
export function withRecogniserUnavailable(
  checkpoint: ImportCheckpoint,
): ImportCheckpoint {
  const ocr = checkpoint.ocr ?? { pages: {}, refused: [], unavailable: false };
  return { ...checkpoint, ocr: { ...ocr, unavailable: true } };
}

/** One more crossing spent. */
export function withContinuation(checkpoint: ImportCheckpoint): ImportCheckpoint {
  return { ...checkpoint, continuations: checkpoint.continuations + 1 };
}

/**
 * May this import be continued again?
 *
 * A BOUND, NOT A TARGET. An import that has crossed ten isolates and still has
 * work is one this design has failed to describe, and the right answer is to
 * finish with what it has rather than to keep dispatching for ever — the
 * properties are already written, their imagery is already the settler's, and
 * the recogniser has already been given more pages than it accepts.
 */
export function mayContinue(
  checkpoint: ImportCheckpoint | null | undefined,
): boolean {
  if (!checkpoint) return true;
  if (checkpoint.ocr?.unavailable) return false;
  return checkpoint.continuations < MAX_IMPORT_CONTINUATIONS;
}
