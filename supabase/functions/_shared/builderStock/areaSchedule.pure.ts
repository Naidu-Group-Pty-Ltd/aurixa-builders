/**
 * ===========================================================================
 * BUILDER STOCK — THE HOUSE'S OWN AREA SCHEDULE, AND ITS TOTAL.
 * ===========================================================================
 *
 * A builder's package brochure states the size of the house as a schedule of
 * its parts and their sum:
 *
 *     House Specifications
 *     Enclosed:   91.91m²
 *     Garage:     38.10m²
 *     Porch:       3m²
 *     Total:     129.5m²
 *
 * MEASURED 23 SEPTEMBER 2026: the production brochure for `LOT 4327` states
 * its house's size in exactly this form and NOWHERE else, and the card read
 * `HOME —`. Its sibling `LOT 717` carries a siting page stating
 * `Build Area: 131.55 m2` as well, and read that.
 *
 * WHY THIS WAS REMOVED ONCE, AND WHY IT IS BACK AS A FALLBACK ONLY. A first
 * version took the section's `Total:` as the building size unconditionally,
 * and was deleted because the production brochure for Lot 315 stated
 * `Total: 117.50m²` on its cover and `Build Area: 119.16 m2` on its siting
 * page — two figures for one field, the stated one from a LABEL that names the
 * build and the other from a schedule's sum. Both of those still hold, and
 * nothing here overrules either: the schedule is asked only where the whole
 * document has stated no building size at all, and never where two statements
 * of one were found and dropped. It is not a second opinion; it is the only
 * opinion the document offers.
 *
 * ONE EXCEPTION, AND IT IS A STATEMENT ABOUT PAGES, NOT ABOUT SCHEDULES.
 * MEASURED 23 SEPTEMBER 2026 on `LOT 927`: the house's `Total: 129.5m²` sits on
 * the page that prices the property, and a siting consultant's `Build Area:
 * 131.6 m2` on the page after it — so the siting's label won and the card read
 * `HOME 132 m²`. The page that prices a property is its own statement of what
 * is on offer, so a schedule on THAT page is asked before any other page's
 * label (`measurementAuthority.pure.ts`). It still never speaks over a figure
 * its own page labels, and never where its own page disputes one.
 *
 * WHAT MAKES IT A HOUSE'S SCHEDULE AND NOT ANY TOTAL. Every row is a label
 * this module recognises as a PART OF A DWELLING (`Enclosed`, `Ground Floor`,
 * `Garage`, `Porch`, `Alfresco` …) beside an area in square metres, set in one
 * column, and the run closes with exactly one `Total` row. A land schedule
 * (`Lot 1`, `Lot 2`, `Total`) names no part of a dwelling; a price schedule
 * (`Land`, `Build`, `Total`) states money, and money is never an area.
 *
 * AND THE SUM MUST BE THE SUM OF SOMETHING. The total may not be smaller than
 * its largest part, and it must sit within a quarter of what the parts add up
 * to. That is loose on purpose: the production brochure itself states parts
 * of 133.01 m² and a total of 129.5 m², a builder's own arithmetic slip, and
 * the figure the builder published as the house's total is the one a reader
 * of that page takes away. What it refuses is a `Total` that belongs to some
 * other list.
 *
 * Pure: no IO, no clock, no network.
 */

/** A unit of a page, as the brochure reader produces them. */
export interface ScheduleUnit {
  text: string;
  row: number;
  x: number;
}

/** The parts of a dwelling an area schedule lists, and nothing else. */
const DWELLING_PART = new RegExp('^(?:'
  + 'enclosed|enclosed\\s+area|living|living\\s+area|internal|internal\\s+area'
  + '|ground|ground\\s+floor|first|first\\s+floor|upper|upper\\s+floor|lower|lower\\s+floor'
  + '|level\\s*\\d|dwelling|residence|house|home|unit'
  + '|garage|carport|porch|portico|entry|alfresco|balcony|deck|decking|verandah|veranda'
  + '|terrace|patio|courtyard|court|outdoor|outdoor\\s+living|storage|store'
  + ')$', 'i');

/** The row that closes a schedule. */
const SCHEDULE_TOTAL = /^total(?:\s+(?:area|floor\s+area|size|house|home))?$/i;

/**
 * The same two vocabularies, for the schedule a brochure prints as a PICTURE
 * (`areaSchedulePicture.pure.ts`). Named once, here, so what counts as a part
 * of a dwelling cannot come to mean one thing in text and another in pixels.
 */
export function isDwellingPartLabel(label: string): boolean {
  return DWELLING_PART.test(String(label ?? '').replace(/\s+/g, ' ').trim());
}
export function isScheduleTotalLabel(label: string): boolean {
  return SCHEDULE_TOTAL.test(String(label ?? '').replace(/\s+/g, ' ').trim());
}

/** An area written at the START of a value: `129.5m2`, `91.91 m²`, `36.0sqm`. */
const LEADING_AREA = /^(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:m2|m²|sqm|sq\s?m)(?![a-z])/i;

/** Two parts of one schedule sit in one column: their labels start together. */
const SAME_COLUMN = 12;

/** How many rows a schedule may skip between two of its lines. */
const MAX_ROW_GAP = 3;

/** How far from the sum of its parts a total may sit and still be theirs. */
const TOTAL_TOLERANCE = 0.25;

interface ScheduleLine {
  row: number;
  x: number;
  label: string;
  area: number;
  /** The value as the document wrote it, for the record. */
  written: string;
  total: boolean;
}

/** A label and an area on one row, or null. */
function scheduleLine(cells: readonly ScheduleUnit[]): ScheduleLine | null {
  if (!cells.length) return null;
  const first = cells[0];
  let label: string;
  let value: string;
  const text = String(first.text ?? '').trim();
  const colon = text.indexOf(':');
  if (colon > 0 && text.slice(colon + 1).trim()) {
    // `Enclosed: 91.91m2` drawn as one cell.
    label = text.slice(0, colon);
    value = text.slice(colon + 1);
  } else if (cells.length >= 2) {
    // `Enclosed:` | `91.91m2` — a label cell and the value cell beside it.
    label = text.replace(/:\s*$/, '');
    value = String(cells[1].text ?? '');
  } else {
    // `Garage 36.0m2`, a label and a value with no colon between them.
    const split = text.match(/^([A-Za-z][A-Za-z\s]*?)\s+(\d.*)$/);
    if (!split) return null;
    label = split[1];
    value = split[2];
  }
  label = label.replace(/\s+/g, ' ').trim();
  const total = SCHEDULE_TOTAL.test(label);
  if (!total && !DWELLING_PART.test(label)) return null;
  const written = value.trim();
  const figure = written.match(LEADING_AREA);
  if (!figure) return null;
  const area = Number(figure[1].replace(',', '.'));
  if (!Number.isFinite(area) || area <= 0) return null;
  return { row: first.row, x: first.x, label: label.toLowerCase(), area, written, total };
}

export interface AreaScheduleTotal {
  /** The total exactly as the document wrote it. */
  value: string;
  /** How many parts the schedule listed. */
  parts: number;
}

/**
 * The total of the one dwelling area schedule a document draws, or null.
 *
 * NULL WHERE THERE IS ANY DOUBT: no schedule, a schedule with fewer than two
 * parts, a total that is not the schedule's last line, a total its parts do
 * not account for, or two schedules that disagree about the answer. A
 * document that prints the same schedule twice has one answer, and gives it.
 */
export function readAreaScheduleTotal(
  pages: ReadonlyArray<ReadonlyArray<ScheduleUnit>>,
): AreaScheduleTotal | null {
  const totals = new Map<string, AreaScheduleTotal>();
  let refused = false;

  for (const units of pages) {
    const byRow = new Map<number, ScheduleUnit[]>();
    for (const unit of units) {
      const row = byRow.get(unit.row);
      if (row) row.push(unit);
      else byRow.set(unit.row, [unit]);
    }
    const lines: ScheduleLine[] = [];
    for (const [, cells] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const line = scheduleLine(cells.slice().sort((a, b) => a.x - b.x));
      if (line) lines.push(line);
    }

    /*
     * RUNS IN ONE COLUMN. A schedule's lines start together and follow one
     * another within a few rows; a floor plan's labels on the other side of
     * the sheet may sit between them and are simply not schedule lines.
     */
    const used = new Set<ScheduleLine>();
    for (const start of lines) {
      if (used.has(start) || start.total) continue;
      const run: ScheduleLine[] = [start];
      used.add(start);
      for (const next of lines) {
        if (used.has(next)) continue;
        const last = run[run.length - 1];
        if (next.row <= last.row) continue;
        if (next.row - last.row > MAX_ROW_GAP) break;
        if (Math.abs(next.x - start.x) > SAME_COLUMN) continue;
        run.push(next);
        used.add(next);
        if (next.total) break;
      }

      const closing = run[run.length - 1];
      if (!closing.total) continue;
      const parts = run.slice(0, -1);
      if (parts.some((line) => line.total)) { refused = true; continue; }
      if (new Set(parts.map((line) => line.label)).size < 2) continue;

      const sum = parts.reduce((total, line) => total + line.area, 0);
      const largest = Math.max(...parts.map((line) => line.area));
      if (closing.area < largest) { refused = true; continue; }
      if (Math.abs(closing.area - sum) > sum * TOTAL_TOLERANCE) { refused = true; continue; }
      totals.set(String(closing.area), { value: closing.written, parts: parts.length });
    }
  }

  if (refused || totals.size !== 1) return null;
  return [...totals.values()][0];
}
