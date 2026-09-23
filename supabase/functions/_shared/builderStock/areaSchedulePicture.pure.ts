/**
 * ===========================================================================
 * BUILDER STOCK — AN AREA SCHEDULE PRINTED AS A PICTURE, AND THE ONE TOTAL OF
 * IT THIS PRODUCT TAKES: A TOTAL THE PICTURE'S OWN ARITHMETIC PROVES.
 * ===========================================================================
 *
 * MEASURED 23 SEPTEMBER 2026 on `Lot 101 - PICO - BROCHURE v002.pdf`: the
 * property page states its house's size in exactly one place, a 231 x 166
 * raster of a table —
 *
 *     AREA SCHEDULE
 *     DWELLING:    90.11m²    9.70sq
 *     GARAGE:      22.59m²    2.43sq
 *     COURT:        4.69m²    0.50sq
 *     PORCH:        7.11m²    0.77sq
 *     TOTAL:      124.50m²   13.40sq
 *
 * — which no text reader can see, and the card read `HOME —`. The text layer
 * was traced in full, and a 300 dpi render of every page read by Tesseract;
 * the figure is printed nowhere else.
 *
 * WHY RECOGNITION IS NOT ENOUGH ON ITS OWN. Text a PDF states is exact;
 * recognition misreads characters, and a misread digit in a building size is a
 * figure on a client's card that the builder never printed. The text schedule
 * reader (`areaSchedule.pure.ts`) can afford a loose check — a quarter either
 * side of the parts, because the digits are the document's own. This one
 * cannot, so it asks the picture to PROVE the figure it reads, twice over,
 * with statements the picture itself makes independently of that figure:
 *
 *   SQUARES. Australian builders print each area in square metres AND in
 *   squares (one square is 100 square feet, 9.290304 m²). Two columns, two
 *   renderings of one quantity: `124.50 / 9.290304 = 13.401`, printed
 *   `13.40`. A misread digit in either column breaks the identity — `124.30`
 *   is `13.38`, `724.50` is `77.98` — so a total whose squares agree to the
 *   printed hundredth is the total the builder printed, to within a tenth of a
 *   square metre.
 *
 *   PARTS. A schedule is its parts and their sum. Where every part is legible
 *   and they add to the total within the rounding the printed decimals allow,
 *   the total is proved by figures read separately from it.
 *
 * AND THE SQUARES PLACE A POINT RECOGNITION LOST. Measured on the production
 * picture with the product's own engine, the total's decimal point — the
 * smallest mark it prints — came back as `12450` or `124 50` under most
 * preparations, while its squares came back as `13.40` under every one. The
 * placements of five digits differ by powers of ten, so at most one can
 * restate the printed squares, and that one is taken only where it is the
 * only one (`areaProvedBySquares`). The digits are never changed; a misread
 * digit still breaks the identity.
 *
 * EITHER PROOF IS SUFFICIENT AND NEITHER IS OPTIONAL. A total neither proves
 * is refused, however clearly it was recognised, and so is anything that is
 * not recognisably a HOUSE's schedule: at least one row must name a part of a
 * dwelling (the same vocabulary the text reader uses, imported rather than
 * restated), and a picture that states two different totals states none.
 *
 * WHAT IT NEVER DOES: invent, round towards, or choose. It returns the digits
 * recognised on the total's own row, or a reason it would not. It never
 * speaks where the document's text stated a build size — that is the
 * caller's rule (`pdfFigures.pure.ts`), and it is the whole reason this runs.
 *
 * Pure: no IO, no clock.
 */
import { isDwellingPartLabel, isScheduleTotalLabel } from './areaSchedule.pure.ts';

/** One square, the unit a builder's schedule prints beside square metres. */
export const SQUARE_METRES_PER_SQUARE = 9.290304;

/** A house's total floor area, bounded like a house is. */
const MIN_HOUSE_M2 = 30;
const MAX_HOUSE_M2 = 2000;

/** Two decimals compared as the integers they are, clear of float noise. */
const hundredths = (value: number) => Math.round(value * 100);

/** Parts printed to two decimals can sum to a hair either side of their total. */
const PARTS_TOLERANCE_PER_PART = 0.006;

export interface PictureScheduleRow {
  /** The row's label, lower-cased. */
  label: string;
  total: boolean;
  /**
   * The area's figure as recognition wrote it — `124.50`, or `12450` and
   * `124 50` where it lost the decimal point, which is the smallest mark a
   * picture prints and the first one recognition drops.
   */
  written: string | null;
  /** The area, where recognition KEPT the decimal point. */
  area: number | null;
  /** The same area in squares, where the picture prints one and its point was kept. */
  squares: number | null;
}

export type PictureScheduleRefusal =
  | 'no_schedule'   // no row names a part of a dwelling
  | 'no_total'      // parts, but no total row with a figure
  | 'two_totals'    // two totals that disagree
  | 'implausible'   // a total no house has
  | 'unproved';     // a total neither its squares nor its parts account for

export type ScheduleProof = 'squares' | 'parts';

export interface PictureScheduleReading {
  /** The total's digits, as the proof placed them: `124.50`. */
  value: string;
  area: number;
  /** Which of the picture's own statements proved it. Never empty. */
  provedBy: ScheduleProof[];
  /** Part rows whose area is known. */
  parts: number;
}

export interface PictureScheduleResult {
  reading: PictureScheduleReading | null;
  refusal: PictureScheduleRefusal | null;
  rows: PictureScheduleRow[];
}

/**
 * An area and its unit. Recognition's spellings of `m²` — the superscript is
 * what it misreads: `m2`, `m²`, `m?`, `m*`, `m®`, `m'`, `m"`, `mz`, and `sqm`
 * or `sq m`. The figure is taken as written (`124.50`), with its point read
 * as a space (`124 50`), or with its point lost (`12450`).
 */
const AREA = /(\d{1,4}[.,]\d{1,2}|\d{1,4} \d{2}|\d{1,6})\s*(?:sq\s?m|m(?:2|²|z|[?*'"°º`’”®])?)(?![A-Za-z0-9])/;
/**
 * `13.40sq`, `13.40 sq`, `13.40sqs`. Always with its decimal point, because
 * the squares are what place the area's — and never the `sq` of
 * `124.50 sq m`, which is square metres written out.
 */
const SQUARES = /(\d{1,3}[.,]\d{1,2})\s*sq(?:s|uares?)?(?![A-Za-z])(?!\s?m(?![A-Za-z]))/i;
/** A label: letters and spaces, up to its colon or its first figure. */
const LABEL = /^\s*([A-Za-z][A-Za-z ]{1,30}?)\s*[:;.,]?\s*(?=\d|$)/;

const decimal = (text: string) => text.replace(',', '.');
const positive = (value: number | null) =>
  value !== null && Number.isFinite(value) && value > 0 ? value : null;

/** One recognised line, as a schedule row, or nothing. */
export function scheduleRowOf(line: string): PictureScheduleRow | null {
  const text = String(line ?? '')
    // A table's cell borders survive recognition as bars and brackets.
    .replace(/[|[\]{}]/g, ' ')
    // `1,234.50` is one number; `22,59` stays a decimal comma.
    .replace(/(\d),(\d{3})(?=\.\d)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  const labelled = text.match(LABEL);
  if (!labelled) return null;
  const label = labelled[1].replace(/\s+/g, ' ').trim();
  const total = isScheduleTotalLabel(label);
  if (!total && !isDwellingPartLabel(label)) return null;

  const rest = text.slice(labelled[0].length);
  // The squares first, so their digits can never be taken for the area.
  const squaresMatch = rest.match(SQUARES);
  const withoutSquares = squaresMatch ? rest.replace(squaresMatch[0], ' ') : rest;
  const areaMatch = withoutSquares.match(AREA);
  const written = areaMatch ? decimal(areaMatch[1]) : null;
  const kept = written !== null && written.includes('.');
  return {
    label: label.toLowerCase(),
    total,
    written,
    area: kept ? positive(Number(written)) : null,
    squares: squaresMatch ? positive(Number(decimal(squaresMatch[1]))) : null,
  };
}

/**
 * Do these squares restate this area, EXACTLY as the picture printed them?
 *
 * The squares must be the area in squares ROUNDED to the hundredth — or cut
 * off at it, for a publisher who truncates — and nothing else. A tolerance
 * here is a band a misread can land in: measured on a schedule picture, one
 * preparation read `129.59` as `129.50`, which is 13.94 squares against the
 * printed 13.95, and a hundredth's leeway would have taken it. What the exact
 * identity still admits is a misread inside the resolution of the squares
 * themselves — under five hundredths of a square metre, below the whole metre
 * a card prints.
 */
export function squaresRestate(area: number, squares: number): boolean {
  const exact = area / SQUARE_METRES_PER_SQUARE;
  const printed = hundredths(squares);
  return hundredths(exact) === printed || Math.floor(exact * 100 + 1e-9) === printed;
}

/**
 * Where a lost decimal point could have been: every placement of the digits,
 * from none to three decimals. `12450` is 12450, 1245.0, 124.50 or 12.450.
 */
function placements(written: string): Array<{ value: string; area: number }> {
  const digits = written.replace(/\D/g, '');
  const out: Array<{ value: string; area: number }> = [];
  for (let decimals = 0; decimals <= Math.min(3, digits.length - 1); decimals++) {
    const value = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
    const area = positive(Number(value));
    if (area !== null) out.push({ value, area });
  }
  return out;
}

/**
 * The area this row's own squares prove, and its digits as they place it.
 *
 * WHERE RECOGNITION KEPT THE POINT, the squares must restate that reading.
 * WHERE IT LOST THE POINT — measured on the production picture, whose total
 * came back as `12450` or `124 50` under most preparations while its squares
 * came back as `13.40` under every one — the squares say where the point was:
 * the placements of the digits differ by powers of ten, so at most one can
 * restate the printed squares. That placement is taken only where it is the
 * only one; the digits themselves are never changed, and a misread digit
 * still breaks the identity. Without squares, a figure with no point proves
 * nothing, because nothing says how large it is.
 */
export function areaProvedBySquares(
  row: PictureScheduleRow,
): { value: string; area: number } | null {
  if (row.squares === null || row.written === null) return null;
  const squares = row.squares;
  const candidates = row.area !== null
    ? [{ value: row.written, area: row.area }]
    : placements(row.written);
  const proved = candidates.filter((candidate) => squaresRestate(candidate.area, squares));
  return proved.length === 1 ? proved[0] : null;
}

/** A row's area where it is known: as its squares prove it, or as written with its point. */
function knownArea(row: PictureScheduleRow): { value: string; area: number; bySquares: boolean } | null {
  const bySquares = areaProvedBySquares(row);
  if (bySquares) return { ...bySquares, bySquares: true };
  return row.area !== null && row.written !== null
    ? { value: row.written, area: row.area, bySquares: false }
    : null;
}

/**
 * The total of the area schedule recognised in one picture, or the reason
 * there is none.
 */
export function readPictureSchedule(text: string): PictureScheduleResult {
  const rows = String(text ?? '').split(/\r?\n/).map(scheduleRowOf)
    .filter((row): row is PictureScheduleRow => row !== null);
  const parts = rows.filter((row) => !row.total);
  if (!parts.length) return { reading: null, refusal: 'no_schedule', rows };
  const totalRows = rows.filter((row) => row.total && row.written !== null);
  if (!totalRows.length) return { reading: null, refusal: 'no_total', rows };

  const totals = totalRows.map(knownArea)
    .filter((known): known is NonNullable<typeof known> => known !== null);
  // Digits with no point and no squares to place it: a figure of no known size.
  if (!totals.length) return { reading: null, refusal: 'unproved', rows };
  if (new Set(totals.map((known) => known.area)).size > 1) {
    return { reading: null, refusal: 'two_totals', rows };
  }
  const closing = totals.find((known) => known.bySquares) ?? totals[0];
  if (closing.area < MIN_HOUSE_M2 || closing.area > MAX_HOUSE_M2) {
    return { reading: null, refusal: 'implausible', rows };
  }

  const provedBy: ScheduleProof[] = [];
  if (totals.some((known) => known.bySquares)) provedBy.push('squares');
  /*
   * THE PARTS PROVE A TOTAL ONLY IF EVERY PART'S SIZE IS KNOWN — written with
   * its point or placed by its own squares. A part whose point was lost and
   * which prints no squares is a figure of unknown size, and a sum over it
   * could agree at the wrong magnitude: `901 + 225 + 47 + 72 = 1245`.
   */
  const partAreas = parts.map(knownArea);
  if (partAreas.length >= 2 && partAreas.every((known) => known !== null)) {
    const areas = partAreas.map((known) => (known as { area: number }).area);
    const sum = areas.reduce((acc, area) => acc + area, 0);
    if (closing.area >= Math.max(...areas)
      && Math.abs(sum - closing.area) <= PARTS_TOLERANCE_PER_PART * areas.length + 0.001) {
      provedBy.push('parts');
    }
  }
  if (!provedBy.length) return { reading: null, refusal: 'unproved', rows };
  return {
    reading: {
      value: closing.value,
      area: closing.area,
      provedBy,
      parts: partAreas.filter((known) => known !== null).length,
    },
    refusal: null,
    rows,
  };
}
