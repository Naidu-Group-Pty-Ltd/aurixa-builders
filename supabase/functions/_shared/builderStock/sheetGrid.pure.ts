/**
 * BUILDER STOCK — THE SAME WORKSHEET, READ FROM A GRID INSTEAD OF A WORKBOOK.
 *
 * A builder shares a Google Sheet and nothing else. That is the whole of what
 * they do, and it is not going to change to suit this product — so every route
 * to their brochure links has to work with the document exactly as they left
 * it. Two representations carry a cell's link target:
 *
 *   the XLSX export   Drive converts the document and the workbook keeps
 *                     `cell.l.Target` beside the displayed value. It is the
 *                     representation this pipeline already parses.
 *
 *   the grid          `spreadsheets.get` returns `CellData.hyperlink` beside
 *                     `formattedValue`, cell by cell.
 *
 * THE EXPORT IS NOT ALWAYS AVAILABLE AND THAT IS THE BUILDER'S RIGHT. Turning
 * off "viewers can download, print, copy" is an ordinary, sensible thing for a
 * builder to do with a price list, and Drive honours it: `files.export` has no
 * URL to offer and the workbook cannot be fetched at all. Reading CELLS is a
 * different permission from DOWNLOADING A FILE, so the grid answers where the
 * export refuses — on the same document, with the same credential, for a
 * reader who was already allowed to see it.
 *
 * So this converts a grid into the shape the workbook reader already produces.
 * It is an ADAPTER, NOT A SECOND PARSER: `matchWorksheet` still decides which
 * tab, `hyperlinkTargetOf` still decides what a cell points at, and
 * `mergeHyperlinkColumns` still puts a row's own link beside it. Those rules
 * are why a brochure lands on the right lot, and there is exactly one copy of
 * each of them.
 *
 * Pure: no IO, no clock, no network.
 */
import { hyperlinkTargetOf, type WorkbookSheet } from './sheetHyperlinks.pure.ts';

/**
 * PROTO3 OMITS A ZERO, AND THAT HAS COST THIS FEATURE A DAY ALREADY.
 *
 * Google's JSON leaves out any scalar equal to its type's default, so a range
 * beginning at row 0 or column 0 carries no `startRow`/`startColumn` at all —
 * exactly as `sheetId: 0` was omitted for the stocklist tab and made gid 0
 * unmatchable. `Number(undefined)` is NaN and every index built from it is
 * wrong, so an absent offset is read as the zero it means.
 */
function offsetOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * A ceiling on how much grid may be turned into rows.
 *
 * The callback's body limit is the transport's guard and is deliberately not
 * raised to make a large sheet fit. This is the SHAPE guard behind it: a
 * builder list far beyond anything seen in production still converts, and
 * something pathological is refused rather than expanded into memory. 400,000
 * cells is ~10,000 rows of 40 columns; the real list that motivated this is
 * 129 rows of 23.
 */
export const MAX_GRID_CELLS = 400_000;

/** A grid that is too large to convert, kept separate from one we cannot read. */
export class GridTooLargeError extends Error {
  constructor() {
    super('grid_too_large');
    this.name = 'GridTooLargeError';
  }
}

/**
 * Every worksheet in a `spreadsheets.get` response, as the workbook reader
 * would have returned it.
 *
 * THE ROW INDEX IS THE ROW INDEX. A worksheet is matched against the CSV the
 * import already proved, cell for cell at the same coordinates, and a row's
 * link is read at THIS row and THIS column — so an empty row has to occupy its
 * slot rather than being skipped. Google sends one as a `rowData` entry with
 * no `values` at all (the stocklist has one between Lot 605 and Lot 606), and
 * dropping it would shift every row beneath it by one and hand each property
 * the next one's brochure. Ranges are placed at their own offsets for the same
 * reason.
 *
 * BOTH WAYS A CELL CAN POINT SOMEWHERE, decided by the one rule that decides
 * it everywhere: `hyperlink` is what Insert > Link writes, and a cell that IS
 * `=HYPERLINK("…","Brochure")` may carry its target only inside the formula.
 * `hyperlinkTargetOf` is handed both and keeps http(s) alone.
 */
export function gridToWorkbookSheets(grid: unknown): WorkbookSheet[] {
  const sheets = (grid as { sheets?: unknown } | null)?.sheets;
  if (!Array.isArray(sheets)) return [];

  let cells = 0;
  const out: WorkbookSheet[] = [];

  for (const raw of sheets) {
    const sheet = raw as {
      properties?: { title?: unknown };
      data?: unknown;
    } | null;

    const name = String(sheet?.properties?.title ?? '').trim();
    const values: (string | null)[][] = [];
    const links: (string | null)[][] = [];

    const ranges = Array.isArray(sheet?.data) ? sheet!.data as unknown[] : [];
    for (const rangeRaw of ranges) {
      const range = rangeRaw as {
        startRow?: unknown; startColumn?: unknown; rowData?: unknown;
      } | null;
      const startRow = offsetOf(range?.startRow);
      const startColumn = offsetOf(range?.startColumn);
      const rowData = Array.isArray(range?.rowData) ? range!.rowData as unknown[] : [];

      for (let r = 0; r < rowData.length; r += 1) {
        const rowIndex = startRow + r;
        const cellsOfRow = (rowData[r] as { values?: unknown } | null)?.values;
        const rowCells = Array.isArray(cellsOfRow) ? cellsOfRow as unknown[] : [];

        cells += rowCells.length;
        if (cells > MAX_GRID_CELLS) throw new GridTooLargeError();

        // An empty row still occupies its slot; see the header.
        while (values.length <= rowIndex) { values.push([]); links.push([]); }
        const valueRow = values[rowIndex];
        const linkRow = links[rowIndex];

        for (let c = 0; c < rowCells.length; c += 1) {
          const columnIndex = startColumn + c;
          const cell = rowCells[c] as {
            formattedValue?: unknown;
            hyperlink?: unknown;
            userEnteredValue?: { formulaValue?: unknown } | null;
          } | null;

          while (valueRow.length <= columnIndex) valueRow.push(null);
          while (linkRow.length <= columnIndex) linkRow.push(null);

          const text = cell?.formattedValue;
          valueRow[columnIndex] = text === null || text === undefined ? null : String(text);
          linkRow[columnIndex] = hyperlinkTargetOf({
            link: typeof cell?.hyperlink === 'string' ? cell.hyperlink : null,
            formula: typeof cell?.userEnteredValue?.formulaValue === 'string'
              ? cell.userEnteredValue.formulaValue : null,
          });
        }
      }
    }

    out.push({ name, values, links });
  }

  return out;
}
