/**
 * Builder stock — WHERE A SCANNED PAGE'S PICTURE IS, WRITTEN DOWN BY THE
 * ISOLATE THAT PARSED THE DOCUMENT FOR THE ISOLATE THAT RECOGNISES IT.
 *
 * ===========================================================================
 * WHY A SCANNED PAGE IS LOCATED IN ONE ISOLATE AND READ IN ANOTHER.
 * ===========================================================================
 *
 * Recognising a page is the most expensive thing an import does, and the
 * hosted runtime would not start the worker `tesseract.js` recognises in
 * (measured in production, 23 September 2026: `Not implemented:
 * Worker.prototype.constructor`, and a fully scanned brochure refused
 * `pdf_no_text_layer`). The engine now runs in the isolate that asks, which
 * puts its whole cost in that isolate — so it must not be the isolate that
 * parsed the PDF, for the rule the picture hand-off already keeps
 * (`documentRead.pure.ts`): AN ISOLATE THAT PARSED A PDF DECODES NONE OF ITS
 * PICTURES.
 *
 * So the parsing isolate FINDS each owed page's picture — which raster the
 * page leads with, or the one flattened raster it is, and where its stream
 * sits in the document's bytes — and decodes nothing. A recognition isolate,
 * holding the same bytes (its checkpoint is bound to their digest), slices
 * the stream out by the offsets recorded here, proves it is the one that was
 * recorded, and makes the picture EXACTLY as the single-isolate path made it:
 * `pdfSourcePhoto.ts` splits one function into these two halves, so the
 * raster a recognition isolate reads is the raster the old pass read, by
 * construction rather than by agreement.
 *
 * Pure: no IO. The shape and its reader live here so the checkpoint, which is
 * pure, can hold one without importing a module that inflates streams.
 */

/** The raster a page's layout leads with, taken whole — the first path. */
export interface EmbeddedScanRaster {
  start: number;
  end: number;
  /** The stream is `FlateDecode`d: raw samples, wrapped losslessly as PNG. */
  flate: boolean;
  width: number;
  height: number;
  objectNumber: number;
  resourceName: string;
  pageAreaShare: number;
  /** SHA-256 of the raw stream, where it was recorded for another isolate. */
  sha256?: string;
}

/** The page's one flattened raster, which the photograph is cut out of — the second path. */
export interface FlattenedScanRaster {
  start: number;
  end: number;
  width: number;
  height: number;
  /**
   * Samples per pixel, where the document stated them. Only 1 and 3 are ever
   * decoded; anything else, and an unstated count, is refused.
   */
  components: number | null;
  objectNumber: number;
  resourceName: string;
  /** SHA-256 of the raw stream, where it was recorded for another isolate. */
  sha256?: string;
}

/**
 * Where one page's picture is. Either path, both, or — never stored — neither.
 * The recognition isolate tries them in the order the single pass did.
 */
export interface ScanRasterLocation {
  /** 1-based, the page a person counts. */
  page: number;
  embedded: EmbeddedScanRaster | null;
  flattened: FlattenedScanRaster | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isReal = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** A stream's offsets, checked for the type the slice is taken by. */
function readSpan(entry: Record<string, unknown>): { start: number; end: number } | null {
  const { start, end } = entry;
  if (!isCount(start) || !isCount(end) || end <= start) return null;
  return { start, end };
}

function readEmbedded(stored: unknown): EmbeddedScanRaster | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const entry = stored as Record<string, unknown>;
  const span = readSpan(entry);
  const { flate, width, height, objectNumber, resourceName, pageAreaShare, sha256 } = entry;
  if (!span || typeof flate !== 'boolean' || !isCount(width) || !isCount(height)) return null;
  if (!isCount(objectNumber) || typeof resourceName !== 'string' || !isReal(pageAreaShare)) return null;
  if (!isDigest(sha256)) return null;
  return { ...span, flate, width, height, objectNumber, resourceName, pageAreaShare, sha256 };
}

function readFlattened(stored: unknown): FlattenedScanRaster | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const entry = stored as Record<string, unknown>;
  const span = readSpan(entry);
  const { width, height, components, objectNumber, resourceName, sha256 } = entry;
  if (!span || !isCount(width) || !isCount(height)) return null;
  if (components !== null && !isCount(components)) return null;
  if (!isCount(objectNumber) || typeof resourceName !== 'string') return null;
  if (!isDigest(sha256)) return null;
  return { ...span, width, height, components, objectNumber, resourceName, sha256 };
}

/**
 * A stored location, checked for every type the recognition isolate slices
 * and decodes by, or null.
 *
 * DROPPED, NEVER REPAIRED — the rule `readPdfFigures` keeps: an offset this
 * build cannot trust is a picture it does not read. And a STORED location
 * must carry the digest of each stream it names, because the digest is how
 * the isolate that reads it proves it sliced the bytes that were recorded.
 */
export function readScanRasterLocation(stored: unknown): ScanRasterLocation | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const entry = stored as Record<string, unknown>;
  const { page } = entry;
  if (!isCount(page) || page < 1) return null;
  const embedded = entry.embedded == null ? null : readEmbedded(entry.embedded);
  const flattened = entry.flattened == null ? null : readFlattened(entry.flattened);
  // A path that was stored and does not read is a location this build cannot
  // trust at all, not a location with one path fewer.
  if (entry.embedded != null && !embedded) return null;
  if (entry.flattened != null && !flattened) return null;
  if (!embedded && !flattened) return null;
  return { page, embedded, flattened };
}
