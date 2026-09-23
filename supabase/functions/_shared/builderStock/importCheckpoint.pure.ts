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
 *     WHAT PRODUCTION CORRECTED, 23 SEPTEMBER 2026: the settler does NOT
 *     attach what the importer declines, for the document that matters most.
 *     Its source repair re-reads an uploaded brochure without the evidence the
 *     importer reads it with, matches none of the brochure's properties, and
 *     stores the pictures against nobody — measured on every single-property
 *     brochure in the acceptance corpus, `stored 0, matched 0`. The importer's
 *     own attach is the only one that attributes a brochure's pictures, and
 *     it cannot run where the brochure was parsed (`documentRead.pure.ts`).
 *     So the import itself crosses once more: the isolate that read the
 *     document writes the read down — the ENCODED pictures exactly as the
 *     document carries them, never a decoded raster — and its successor
 *     attaches them. What this checkpoint holds of that is a TOKEN naming the
 *     read and a count of the crossings it has cost; the read is
 *     `builder_stock_document_reads`, and it is discarded when the import is
 *     over.
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
 * past them, nothing is stored. Where a document is read in the isolate that
 * recognised it — a linked source — that page is simply recognised again.
 * Where it is read by ANOTHER isolate, which is every stored upload now, the
 * checkpoint is the only way a page's text reaches the reading, so a page
 * past a bound is REFUSED and named (`runImport.ts`) rather than recognised
 * beside the parse. Measured, a dense A4 page recognises to about 2,000
 * characters, a sixteenth of the per-page bound. Paying 3 seconds of CPU twice
 * is a cost; writing a megabyte into a row on every stage boundary is a fault.
 *
 * Pure: no IO and no clock.
 */

import { MAX_KIND_CANDIDATES } from './documentRead.pure.ts';
import { readFigureVerdict, type FigureVerdict } from './pdfFigures.pure.ts';
import { readScanRasterLocation, type ScanRasterLocation } from './ocr/scanRaster.pure.ts';

/** The shape's own version, so a reader can refuse one it does not know. */
export const IMPORT_CHECKPOINT_VERSION = 1;

/** The most recognised text one page may contribute. */
export const MAX_CHECKPOINT_PAGE_CHARS = 32_000;
/** The most recognised text the whole checkpoint may hold. */
export const MAX_CHECKPOINT_TOTAL_CHARS = 256_000;
/**
 * How many times one upload may be continued before it stops.
 *
 * `OCR_MAX_PAGES` is 8, and every page is recognised in an isolate of its own
 * that parsed nothing (`ocr/scanRaster.pure.ts`): one crossing out of the
 * isolate that located the pages, one out of each isolate that recognised one,
 * the last of them into the isolate that reads the document. Eight pages is
 * therefore nine crossings, and a page the recogniser refuses costs the same
 * crossing a page it reads does. One spare.
 */
export const MAX_IMPORT_CONTINUATIONS = 10;

/**
 * How many crossings the PICTURES of one import may cost.
 *
 * DERIVED, NOT CHOSEN: one crossing hands the read to a successor; at most
 * one more reads the insets that may state a figure the text does not
 * (`pdfFigures.pure.ts` — asked once per hand-off, and its verdict recorded
 * whatever it was); and every crossing after that learns at least one
 * picture's kind (`planKindDecodes` always takes one) out of at most
 * `MAX_KIND_CANDIDATES` — so an import whose kinds are all recorded cannot need
 * more than this, and one that reaches it has failed to RECORD its kinds
 * rather than failed to learn them. Past it the import finishes where it
 * stands, which is the rule `mayContinue` states for recognition.
 *
 * Counted apart from `continuations` because the two answer different
 * questions: a deployment with no recogniser (`ocr.unavailable`) must never
 * be asked to recognise again, and that is no reason to decode a picture in
 * the isolate that parsed the document.
 */
export const MAX_PICTURE_CROSSINGS = 2 + MAX_KIND_CANDIDATES;

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
    /**
     * WHERE EACH OWED PAGE'S PICTURE IS, by 1-based page, as the isolate that
     * parsed the document located it — so the isolates that recognise them
     * never parse it. See `ocr/scanRaster.pure.ts`.
     */
    rasters?: Record<string, ScanRasterLocation>;
    /**
     * Pages an isolate has BEGUN recognising. Written before the engine is
     * asked and cleared when the pass ends, so a page still here, neither read
     * nor refused, is one whose isolate never reported back.
     */
    begun?: number[];
    /**
     * Pages whose recognition was begun and never reported back. Settled for
     * the rest of this attempt — a page is never recognised twice — and the
     * attempt recognises nothing more. See `lostRecognitions`.
     */
    lost?: number[];
  };
  /**
   * The read this import handed to a successor to attach its pictures, and
   * the crossings that has cost. Present only between the hand-off and the
   * end of the import. See `MAX_PICTURE_CROSSINGS`.
   */
  pictures?: {
    /** Names the `import` read in `builder_stock_document_reads`. */
    handover: string;
    crossings: number;
    /**
     * What reading the hand-off's figures came to, once they have been read.
     * Absent until then — and absent for good where there were none to read.
     */
    figures?: FigureVerdict;
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
  const figures = row.pictures && typeof row.pictures === 'object'
    ? readFigureVerdict((row.pictures as { figures?: unknown }).figures) : null;
  const pictures = row.pictures && typeof row.pictures === 'object'
    && !Array.isArray(row.pictures)
    && typeof row.pictures.handover === 'string' && row.pictures.handover.length > 0
    ? {
      handover: row.pictures.handover,
      crossings: Number.isFinite(row.pictures.crossings) ? Number(row.pictures.crossings) : 0,
      ...(figures ? { figures } : {}),
    }
    : null;
  return {
    v: IMPORT_CHECKPOINT_VERSION,
    sha256,
    continuations: Number.isFinite(row.continuations) ? Number(row.continuations) : 0,
    ...(pictures ? { pictures } : {}),
    ...(pages || row.ocr ? {
      ocr: {
        pages: pages ?? {},
        refused: pageList(row.ocr?.refused),
        unavailable: row.ocr?.unavailable === true,
        ...readOcrHandOff(row.ocr),
      },
    } : {}),
  };
}

/** A stored list of 1-based pages, keeping only what is one. */
function pageList(stored: unknown): number[] {
  return Array.isArray(stored)
    ? stored.filter((page) => Number.isInteger(page) && page > 0).map(Number)
    : [];
}

/**
 * What a stored checkpoint says about recognition handed between isolates.
 * Each part is read on its own terms and an unreadable part is absent, never
 * repaired — an absent raster is a page the parsing isolate locates again.
 */
function readOcrHandOff(stored: ImportCheckpoint['ocr'] | undefined): Partial<NonNullable<ImportCheckpoint['ocr']>> {
  const out: Partial<NonNullable<ImportCheckpoint['ocr']>> = {};
  const rasters = stored?.rasters;
  if (rasters && typeof rasters === 'object' && !Array.isArray(rasters)) {
    const kept: Record<string, ScanRasterLocation> = {};
    for (const [key, value] of Object.entries(rasters)) {
      const location = readScanRasterLocation(value);
      if (location && String(location.page) === key) kept[key] = location;
    }
    if (Object.keys(kept).length) out.rasters = kept;
  }
  const begun = pageList(stored?.begun);
  if (begun.length) out.begun = begun;
  const lost = pageList(stored?.lost);
  if (lost.length) out.lost = lost;
  return out;
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

/**
 * Pages this checkpoint says not to ask for again: read, refused, or — for
 * the rest of this attempt — begun by an isolate that never reported back.
 */
export function checkpointSettledPages(
  checkpoint: ImportCheckpoint | null | undefined,
): Set<number> {
  const settled = new Set<number>(checkpointPages(checkpoint).keys());
  for (const page of checkpoint?.ocr?.refused ?? []) settled.add(page);
  for (const page of checkpoint?.ocr?.lost ?? []) settled.add(page);
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
  // A page whose isolate never reported back ends recognition for the attempt:
  // one such loss is one killed worker, and the next would be another.
  if (checkpoint.ocr?.lost?.length) return false;
  return checkpoint.continuations < MAX_IMPORT_CONTINUATIONS;
}

/**
 * A FRESH ATTEMPT at an upload, from the checkpoint a previous one left.
 *
 * The recognised pages are kept, because they are facts about the bytes, and
 * so are the pages refused for a reason about the page. The crossing count
 * starts again, because it bounds an ATTEMPT. And the picture hand-off is
 * dropped, because it names a read a previous attempt DECIDED — its rows, its
 * strategy — and a fresh attempt decides for itself: a stale hand-off adopted
 * here would write yesterday's decision on today's request.
 *
 * So is everything recognition learned about the ATTEMPT rather than the
 * page: where the owed pictures were located (the fresh attempt's own parse
 * locates them again), which pages were begun or lost, and whether the
 * recogniser was available — a statement about a deployment on a day, which
 * a person pressing "Read again" is entitled to have asked again.
 */
export function freshAttempt(checkpoint: ImportCheckpoint): ImportCheckpoint {
  const { pictures: _dropped, ...rest } = checkpoint;
  if (!rest.ocr) return { ...rest, continuations: 0 };
  const { rasters: _rasters, begun: _begun, lost: _lost, ...ocr } = rest.ocr;
  return { ...rest, continuations: 0, ocr: { ...ocr, unavailable: false } };
}

/**
 * Record where each owed page's picture is, for the isolates that will
 * recognise them. Replaces what an earlier parse of this attempt recorded:
 * the locations are a fact about these bytes, and the latest is the whole of it.
 */
export function withScanRasters(
  checkpoint: ImportCheckpoint, locations: readonly ScanRasterLocation[],
): ImportCheckpoint {
  const ocr = checkpoint.ocr ?? { pages: {}, refused: [], unavailable: false };
  const rasters: Record<string, ScanRasterLocation> = {};
  for (const location of locations) rasters[String(location.page)] = location;
  return { ...checkpoint, ocr: { ...ocr, rasters } };
}

/**
 * The located pages still owed a recognition, in page order: located, and
 * neither read, refused nor lost.
 */
export function scanRastersOwed(
  checkpoint: ImportCheckpoint | null | undefined,
): ScanRasterLocation[] {
  const settled = checkpointSettledPages(checkpoint);
  return Object.values(checkpoint?.ocr?.rasters ?? {})
    .filter((location) => !settled.has(location.page))
    .sort((a, b) => a.page - b.page);
}

/** Record that this isolate is about to begin recognising these pages. */
export function withRecognitionBegun(
  checkpoint: ImportCheckpoint, pages: readonly number[],
): ImportCheckpoint {
  const ocr = checkpoint.ocr ?? { pages: {}, refused: [], unavailable: false };
  return { ...checkpoint, ocr: { ...ocr, begun: [...new Set([...(ocr.begun ?? []), ...pages])] } };
}

/**
 * The pass is over: every page it began is read, refused, or put back for a
 * successor. Nothing begun remains to be mistaken for a lost one.
 */
export function withRecognitionEnded(checkpoint: ImportCheckpoint): ImportCheckpoint {
  if (!checkpoint.ocr?.begun?.length) return checkpoint;
  const { begun: _ended, ...ocr } = checkpoint.ocr;
  return { ...checkpoint, ocr };
}

/**
 * Pages whose recognition an isolate began and never reported: begun, and
 * neither read nor refused. The only way to leave one is for the worker to
 * die mid-page — which on the hosted runtime means the page cost more than an
 * invocation may spend.
 */
export function lostRecognitions(
  checkpoint: ImportCheckpoint | null | undefined,
): number[] {
  const done = new Set<number>(checkpointPages(checkpoint).keys());
  for (const page of checkpoint?.ocr?.refused ?? []) done.add(page);
  for (const page of checkpoint?.ocr?.lost ?? []) done.add(page);
  return (checkpoint?.ocr?.begun ?? []).filter((page) => !done.has(page));
}

/**
 * Settle pages whose isolate never reported back, and end recognition for the
 * attempt. NEVER RECOGNISED AGAIN in it: a page that killed one worker is one
 * the next worker would die on too, and the recovery that restarts a dead
 * import is bounded — so a page recognised twice is how a document with a few
 * heavy scans would end up read by nobody. Not a refusal of the page: a fresh
 * attempt asks again (`freshAttempt`).
 */
export function withRecognitionLost(
  checkpoint: ImportCheckpoint, pages: readonly number[],
): ImportCheckpoint {
  const ocr = checkpoint.ocr ?? { pages: {}, refused: [], unavailable: false };
  const { begun: _ended, ...rest } = ocr;
  return { ...checkpoint, ocr: { ...rest, lost: [...new Set([...(ocr.lost ?? []), ...pages])] } };
}

/** The read a previous invocation of this attempt handed on, or null. */
export function pictureHandover(
  checkpoint: ImportCheckpoint | null | undefined,
): string | null {
  return checkpoint?.pictures?.handover ?? null;
}

/**
 * The token of a hand-off a stored checkpoint names, WHATEVER its document.
 *
 * Read from the raw stored value rather than through `readCheckpoint`,
 * because the one caller is discarding what a previous attempt left — and a
 * previous attempt at a document since replaced is exactly the read that
 * `readCheckpoint` would refuse to describe.
 */
export function storedPictureHandover(stored: unknown): string | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const pictures = (stored as { pictures?: { handover?: unknown } }).pictures;
  return pictures && typeof pictures.handover === 'string' && pictures.handover
    ? pictures.handover : null;
}

/** Record a hand-off of the pictures to a successor, and the crossing it costs. */
export function withPictureHandover(
  checkpoint: ImportCheckpoint, handover: string,
): ImportCheckpoint {
  return {
    ...checkpoint,
    pictures: { handover, crossings: (checkpoint.pictures?.crossings ?? 0) + 1 },
  };
}

/** One more crossing spent on the same hand-off: a batch of kinds learned. */
export function withPictureCrossing(checkpoint: ImportCheckpoint): ImportCheckpoint {
  if (!checkpoint.pictures) return checkpoint;
  return {
    ...checkpoint,
    pictures: { ...checkpoint.pictures, crossings: checkpoint.pictures.crossings + 1 },
  };
}

/**
 * What this hand-off's figures came to, or null where they have not been read.
 * See `pdfFigures.pure.ts`.
 */
export function figureVerdictOf(
  checkpoint: ImportCheckpoint | null | undefined,
): FigureVerdict | null {
  return checkpoint?.pictures?.figures ?? null;
}

/**
 * Record what reading the hand-off's figures came to. Only a hand-off has
 * figures, so a checkpoint without one is returned as it came.
 */
export function withFigureVerdict(
  checkpoint: ImportCheckpoint, verdict: FigureVerdict,
): ImportCheckpoint {
  if (!checkpoint.pictures) return checkpoint;
  return { ...checkpoint, pictures: { ...checkpoint.pictures, figures: verdict } };
}

/** Is there room for the pictures to cross once more? See `MAX_PICTURE_CROSSINGS`. */
export function mayCrossForPictures(
  checkpoint: ImportCheckpoint | null | undefined,
): boolean {
  return (checkpoint?.pictures?.crossings ?? 0) < MAX_PICTURE_CROSSINGS;
}

/** How many crossings this import has cost, recognition and pictures together. */
export function crossingsSpent(checkpoint: ImportCheckpoint | null | undefined): number {
  return (checkpoint?.continuations ?? 0) + (checkpoint?.pictures?.crossings ?? 0);
}
