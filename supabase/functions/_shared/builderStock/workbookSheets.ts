/**
 * BUILDER STOCK — READING A WORKBOOK'S VALUES AND ITS LINK TARGETS.
 *
 * ONE READER, TWO CALLERS. The import reads a workbook to enrich the CSV it
 * already proved; the hyperlink recovery reads one that Make fetched with an
 * authorised Google connection. They must agree about what a cell says and
 * where it points, so this is the single place that decodes a workbook and
 * both import it rather than each carrying its own copy.
 *
 * It was extracted from `fetchSource.ts` unchanged when the recovery needed
 * it. A second spreadsheet parser is how two paths come to disagree about a
 * builder's brochure.
 */
import { hyperlinkTargetOf, type WorkbookSheet } from './sheetHyperlinks.pure.ts';

/**
 * Every worksheet's visible values and its hyperlink targets.
 *
 * SheetJS surfaces a link as `cell.l.Target` beside the displayed `cell.v`, so
 * a labelled cell that carries no link is distinguishable from one that does
 * rather than inferred. The reader is the one this repository already loads
 * for spreadsheet sources; nothing new is introduced into the runtime.
 */
export async function readWorkbookSheets(bytes: Uint8Array): Promise<WorkbookSheet[]> {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true });

  return workbook.SheetNames.map((name: string) => {
    const sheet = workbook.Sheets[name];
    const values: (string | null)[][] = [];
    const links: (string | null)[][] = [];
    if (!sheet || !sheet['!ref']) return { name, values, links };

    const range = XLSX.utils.decode_range(String(sheet['!ref']));
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const valueRow: (string | null)[] = [];
      const linkRow: (string | null)[] = [];
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        valueRow.push(cell ? String(cell.w ?? cell.v ?? '') : null);
        /*
         * BOTH WAYS A CELL CAN POINT SOMEWHERE. `cell.l.Target` is the link
         * RELATIONSHIP, which is what Insert > Link writes; a cell that IS
         * `=HYPERLINK("…","Brochure")` carries no relationship at all and its
         * target is an argument inside `cell.f`. Reading only the first
         * dropped every brochure a builder typed as a formula.
         */
        linkRow.push(hyperlinkTargetOf({
          link: cell?.l?.Target ?? null,
          formula: cell?.f ?? null,
        }));
      }
      values.push(valueRow);
      links.push(linkRow);
    }
    return { name, values, links };
  });
}
