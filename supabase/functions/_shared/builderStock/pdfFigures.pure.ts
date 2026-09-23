/**
 * ===========================================================================
 * BUILDER STOCK — THE SMALL PICTURES ON A PROPERTY'S OWN PAGE THAT MAY STATE
 * A FIGURE, AND WHEN THEY ARE ASKED.
 * ===========================================================================
 *
 * A brochure can print a fact only as a picture. MEASURED 23 SEPTEMBER 2026 on
 * `Lot 101 - PICO - BROCHURE v002.pdf`: the house's size is printed once, in a
 * 231 x 166 raster of its area schedule drawn across 3.3% of the page that
 * prices the property. The photograph rules refuse it on sight — it is below
 * their pixel floor and their page-share floor, correctly, because it is not a
 * photograph — so nothing downstream ever saw it.
 *
 * WHAT IS A CANDIDATE (`figureCandidatesFrom`). A raster a JPEG or a PNG can
 * be made of without interpretation (`DCTDecode`, or raw samples under
 * `FlateDecode`); large enough to carry rows of type (120 x 60 pixels) and
 * small enough to be an inset rather than a photograph (a megapixel, and 8% of
 * the page); of a table's proportions; and drawn once, on one page, because a
 * letterhead or a logo is drawn everywhere. It is a statement about SHAPE only.
 * Whether it states anything is decided by reading it.
 *
 * WHEN THEY ARE ASKED (`figuresToRead`), and every condition is a refusal
 * rather than a preference:
 *
 *   • the document was read as ONE property, so a figure cannot be attributed
 *     to the wrong one;
 *   • that property's row states NO building size, so a picture never speaks
 *     over the text — and the reader did not DISPUTE one, because a picture
 *     must never settle what two statements could not;
 *   • the picture is on a page that states the PRICE, which is the property's
 *     own page (`measurementAuthority.pure.ts`); a document that states no
 *     price has no such page, and nothing is asked;
 *   • and at most three, in the page's reading order, because each is a
 *     recognition and they are read in an isolate that parsed nothing.
 *
 * Nothing here decodes a pixel. The candidates travel as byte offsets into the
 * document, and the isolate that reads them slices the bytes out of the same
 * document its hand-off is bound to (`importHandover.pure.ts`).
 *
 * Pure: no IO, no clock.
 */
import type { DrawnImage, Rect } from './pdfPageImages.pure.ts';
import type { ScheduleProof } from './areaSchedulePicture.pure.ts';

/** Large enough to carry rows of type. */
const MIN_FIGURE_PIXELS = { width: 120, height: 60 };
/** A megapixel, past which it is a photograph or a page, not an inset. */
const MAX_FIGURE_PIXELS = 1_000_000;
/** An inset, not a photograph. */
const MAX_FIGURE_PAGE_SHARE = 0.08;
/** A table's proportions, never a banner or a spine. */
const MIN_FIGURE_ASPECT = 0.25;
const MAX_FIGURE_ASPECT = 6;
/** Each is a recognition in an isolate that parsed nothing. */
export const MAX_FIGURES_READ = 3;

/** A picture a figure may be read from, as the hand-off carries it. */
export interface PdfFigure {
  /** 1-based, the page a person counts. */
  page: number;
  objectNumber: number;
  width: number;
  height: number;
  /** Offsets of the raw stream in the document's bytes. */
  start: number;
  end: number;
  /** The stream is compressed with `FlateDecode` and must be inflated. */
  flate: boolean;
  /**
   * Where the page draws it, in points, in the page's own user space. Read
   * for two things only — the size it is printed at, which sets how far it is
   * enlarged for recognition, and its place in reading order — and never
   * compared with text. Null where a stored hand-off did not carry it.
   */
  drawn: Rect | null;
  /** SHA-256 of the raw stream, so the reader proves it sliced the same bytes. */
  sha256: string;
}

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * The figures a stored hand-off carries, each checked for the type the reader
 * slices by. An entry that is not exactly a figure is dropped, never repaired:
 * an offset this build cannot trust is a picture it does not read.
 */
export function readPdfFigures(stored: unknown): PdfFigure[] {
  if (!Array.isArray(stored)) return [];
  const figures: PdfFigure[] = [];
  for (const entry of stored.slice(0, MAX_FIGURES_READ)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const figure = entry as Record<string, unknown>;
    const { page, objectNumber, width, height, start, end, flate, drawn, sha256 } = figure;
    if (!finiteNumber(page) || !Number.isInteger(page) || page < 1) continue;
    if (!finiteNumber(objectNumber) || !finiteNumber(width) || !finiteNumber(height)) continue;
    if (!finiteNumber(start) || !finiteNumber(end) || !Number.isInteger(start)
      || !Number.isInteger(end) || start < 0 || end <= start) continue;
    if (typeof flate !== 'boolean') continue;
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) continue;
    let rect: Rect | null = null;
    if (drawn !== null && drawn !== undefined) {
      const box = drawn as Record<string, unknown>;
      if (!finiteNumber(box.x) || !finiteNumber(box.y)
        || !finiteNumber(box.width) || !finiteNumber(box.height)) continue;
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    figures.push({ page, objectNumber, width, height, start, end, flate, drawn: rect, sha256 });
  }
  return figures;
}

/** A figure candidate as one page's drawing instructions present it. */
export interface FigureOnPage {
  drawn: DrawnImage;
  pageAreaShare: number;
  /** How many times this page draws it. */
  placements: number;
}

/** The encodings a picture file can be made from without interpretation. */
function streamIsReadable(filters: string[]): boolean {
  if (filters.length === 1) return filters[0] === 'DCTDecode' || filters[0] === 'FlateDecode';
  // A JPEG compressed again: inflate, and what is left is the JPEG.
  return filters.length === 2 && filters[0] === 'FlateDecode' && filters[1] === 'DCTDecode';
}

/**
 * The pictures a page draws that have the SHAPE of an inset that could state
 * a figure. See the header; nothing here decides that one does.
 */
export function figureCandidatesFrom(
  drawn: DrawnImage[],
  pageWidth: number,
  pageHeight: number,
): FigureOnPage[] {
  const pageArea = pageWidth * pageHeight;
  if (pageArea <= 0) return [];
  const byObject = new Map<string, FigureOnPage>();
  for (const entry of drawn) {
    const { image, placement } = entry;
    if (!streamIsReadable(image.filters)) continue;
    if (image.width < MIN_FIGURE_PIXELS.width || image.height < MIN_FIGURE_PIXELS.height) continue;
    if (image.width * image.height > MAX_FIGURE_PIXELS) continue;
    const aspect = image.width / image.height;
    if (aspect < MIN_FIGURE_ASPECT || aspect > MAX_FIGURE_ASPECT) continue;
    const share = (placement.drawn.width * placement.drawn.height) / pageArea;
    if (!(share > 0) || share > MAX_FIGURE_PAGE_SHARE) continue;
    const key = `${image.objectNumber}:${image.name}`;
    const existing = byObject.get(key);
    if (existing) existing.placements += 1;
    else byObject.set(key, { drawn: entry, pageAreaShare: share, placements: 1 });
  }
  return [...byObject.values()];
}

/** Does this row state a building size? An empty value states nothing. */
function statesBuildingSize(row: Record<string, unknown>): boolean {
  const value = row.building_size_sqm;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * The figures worth reading for THIS decision, in reading order, or none.
 * See the header for why each condition refuses.
 */
export function figuresToRead(input: {
  figures: readonly PdfFigure[];
  rows: ReadonlyArray<Record<string, unknown>>;
  /** 1-based pages that stated the price. */
  pricePages: readonly number[];
  disputedFields: readonly string[];
}): PdfFigure[] {
  if (input.rows.length !== 1) return [];
  if (statesBuildingSize(input.rows[0])) return [];
  if (input.disputedFields.includes('building_size_sqm')) return [];
  const pages = new Set(input.pricePages);
  if (!pages.size) return [];
  return input.figures
    .filter((figure) => pages.has(figure.page))
    .slice()
    // The page's reading order: page, then top to bottom, then left to right.
    .sort((a, b) => (a.page - b.page)
      || ((b.drawn ? b.drawn.y + b.drawn.height : 0) - (a.drawn ? a.drawn.y + a.drawn.height : 0))
      || ((a.drawn?.x ?? 0) - (b.drawn?.x ?? 0)))
    .slice(0, MAX_FIGURES_READ);
}

/**
 * What reading a document's figures came to. Recorded once per hand-off (in
 * the import's checkpoint) so it is asked once and applied by whichever
 * isolate finishes the import.
 */
export type FigureVerdict =
  | {
    state: 'read';
    /** The house's total as the schedule printed it: `124.50`. */
    buildingSizeSqm: string;
    provedBy: ScheduleProof[];
    page: number;
  }
  | {
    state: 'refused';
    /** One refusal word per figure read, in order: why each said nothing. */
    reasons: string[];
  }
  | {
    state: 'unavailable';
    /** Recognition itself could not run here. Nothing was learned. */
    reason: string;
  };

const PROOFS: ReadonlySet<string> = new Set(['squares', 'parts']);
const SIZE_DIGITS = /^\d{1,4}(?:\.\d{1,2})?$/;

/** A stored verdict, if it is one this build can trust; otherwise null. */
export function readFigureVerdict(stored: unknown): FigureVerdict | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const verdict = stored as Record<string, unknown>;
  if (verdict.state === 'read') {
    const size = verdict.buildingSizeSqm;
    const proved = verdict.provedBy;
    const page = Number(verdict.page);
    if (typeof size !== 'string' || !SIZE_DIGITS.test(size)) return null;
    if (!Array.isArray(proved) || !proved.length
      || !proved.every((proof) => typeof proof === 'string' && PROOFS.has(proof))) return null;
    if (!Number.isInteger(page) || page < 1) return null;
    return { state: 'read', buildingSizeSqm: size, provedBy: proved as ScheduleProof[], page };
  }
  if (verdict.state === 'refused') {
    const reasons = verdict.reasons;
    if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) return null;
    return { state: 'refused', reasons: reasons as string[] };
  }
  if (verdict.state === 'unavailable') {
    return typeof verdict.reason === 'string'
      ? { state: 'unavailable', reason: verdict.reason } : null;
  }
  return null;
}

/**
 * The rows with a read figure applied: the building size of the ONE row, and
 * only where that row still states none. Everything else is returned as it
 * came, and the same array where nothing changes.
 */
export function withFigureApplied(
  rows: Array<Record<string, unknown>>,
  verdict: FigureVerdict | null | undefined,
): Array<Record<string, unknown>> {
  if (!verdict || verdict.state !== 'read') return rows;
  if (rows.length !== 1 || statesBuildingSize(rows[0])) return rows;
  return [{ ...rows[0], building_size_sqm: verdict.buildingSizeSqm }];
}
