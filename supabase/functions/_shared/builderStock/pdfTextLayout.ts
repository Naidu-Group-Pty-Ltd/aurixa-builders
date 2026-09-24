/**
 * Builder stock — WHERE a PDF drew each run of text, not just what it said.
 *
 * WHY THIS EXISTS SEPARATELY FROM `pdfText.ts`. That module is the one reader
 * of a PDF's prose and two callers depend on it numbering pages identically;
 * its contract is a string per visible page, and it is deliberately untouched.
 * But a string per page is exactly what cannot hold a table: the reader
 * collapses every horizontal gap to a single space, so a schedule's row comes
 * back as `"Palomino Estate 315 Enzo 8.5 4 2 2 350 $863,850"` — ten tokens
 * under eight headings with no recoverable boundary between them. Measured
 * 20 September 2026 on documents drawn at known coordinates: columns 21 to 62
 * units apart, every one of them one space on the way out.
 *
 * The positions are not lost, only discarded on that path. `getTextContent`
 * gives each run its own transform and advance — and it emits the gaps as runs
 * of their own, carrying their width — so the column structure is right there
 * in the item list. This reads it, and nothing else.
 *
 * THREE RULES.
 *
 * IT JUDGES NOTHING. Items out, exactly as the reader gave them. Every
 * decision about what is a cell, what is a column and what is a property is
 * `pdfDeterministicRows.pure.ts`'s, where it can be proved against a fixture
 * of coordinates instead of against a PDF.
 *
 * IT CAN NEVER FAIL AN IMPORT. Every outcome is `{ ok: false }` and the caller
 * carries on with the text it already has. A missing reader, an encrypted
 * document, a page that throws — none of them is worth an upload, because the
 * assisted reader is still there and this is an optimisation in front of it.
 *
 * IT IS BOUNDED. A document with more pages or more runs than a stock schedule
 * could honestly have is not read rather than being read slowly: this runs
 * inside the same edge invocation as the import it is trying to make cheaper.
 *
 * pdf.js takes OWNERSHIP of the array it is handed and leaves the buffer
 * detached — the defect that once emptied the very bytes the photographs are
 * read out of — so it is given its own copy here too.
 */
import type { PdfTextItem, PdfTextLayoutPage } from './pdfDeterministicRows.pure.ts';

export type { PdfTextItem, PdfTextLayoutPage };

export type PdfTextLayoutResult =
  | { ok: true; pages: PdfTextLayoutPage[] }
  | { ok: false; reason: string };

/**
 * A stock schedule that runs past this is not a document this reader is going
 * to reconstruct correctly anyway, and the cost of trying is charged to an
 * invocation that has an import to finish.
 */
export const MAX_LAYOUT_PAGES = 40;
/** Runs, not characters. A page of dense prose is well under this. */
export const MAX_LAYOUT_ITEMS_PER_PAGE = 6000;

/**
 * The SAME pin as `pdfText.ts`. Two versions of the reader would mean the
 * positions and the prose came from different parsers, and a disagreement
 * between them would be invisible.
 */
function loadPdfReader() {
  return import('https://esm.sh/unpdf@0.12.1');
}

/** Every run of text on every page, with where it was drawn. */
export async function readPdfTextLayout(bytes: Uint8Array): Promise<PdfTextLayoutResult> {
  let reader: Awaited<ReturnType<typeof loadPdfReader>>;
  try {
    reader = await loadPdfReader();
  } catch (error) {
    return { ok: false, reason: `pdf layout reader unavailable: ${short(error)}` };
  }

  try {
    const pdf = await reader.getDocumentProxy(bytes.slice()) as {
      numPages?: number;
      getPage(index: number): Promise<unknown>;
    };
    const total = Number(pdf?.numPages ?? 0);
    if (!Number.isFinite(total) || total < 1) {
      return { ok: false, reason: 'pdf layout reader returned no pages' };
    }
    if (total > MAX_LAYOUT_PAGES) {
      return { ok: false, reason: `pdf has ${total} pages, past the layout ceiling` };
    }

    const pages: PdfTextLayoutPage[] = [];
    for (let index = 0; index < total; index++) {
      pages.push({ page: index + 1, items: await itemsOnPage(pdf, index + 1) });
    }
    return { ok: true, pages };
  } catch (error) {
    return { ok: false, reason: `pdf layout extraction failed: ${short(error)}` };
  }
}

/**
 * One page's runs.
 *
 * A page that throws contributes NO items rather than failing the read — the
 * same rule `fieldTextByPage` answers to — because the schedule reader's own
 * "a page with table rows and no heading refuses the document" test then does
 * the right thing with the gap instead of this inventing one.
 */
async function itemsOnPage(
  pdf: { getPage(index: number): Promise<unknown> },
  pageNumber: number,
): Promise<PdfTextItem[]> {
  try {
    const page = await pdf.getPage(pageNumber) as {
      getTextContent?: () => Promise<{ items?: unknown[] }>;
    };
    if (typeof page?.getTextContent !== 'function') return [];
    const content = await page.getTextContent();
    const raw = Array.isArray(content?.items) ? content.items : [];

    /*
     * A PAGE WHOSE TEXT IS NOT UPRIGHT HAS NO LAYOUT THIS READER CAN USE.
     *
     * MEASURED 24 SEPTEMBER 2026: a landscape brochure is often stored as a
     * PORTRAIT page with `/Rotate 90`, its text drawn turned a quarter so the
     * page reads upright once a viewer applies the rotation. Taken as drawn,
     * every line of such a page shares one x and steps along it, so the rows
     * below became ONE row and the reader merged the page into a single cell
     * with no spaces in it — `LOT 64 Currawong StreetBox Hill NSW 2765…` —
     * and read nothing at all from a page whose flattened text is perfect.
     *
     * So a page whose text is mostly not upright contributes no runs, and the
     * brochure reader reads it as the flattened lines it already has, which is
     * exactly what it does for a page this module could not read. A page of
     * upright text is untouched, byte for byte, and so is an upright page that
     * also sets a label sideways: only where most of the page's characters run
     * some other way is the layout withheld.
     */
    if (!mostlyUpright(raw.slice(0, MAX_LAYOUT_ITEMS_PER_PAGE))) return [];

    const items: PdfTextItem[] = [];
    for (const entry of raw.slice(0, MAX_LAYOUT_ITEMS_PER_PAGE)) {
      const item = entry as { str?: unknown; width?: unknown; transform?: unknown };
      if (typeof item?.str !== 'string') continue;
      const transform = item.transform;
      if (!Array.isArray(transform) || transform.length < 6) continue;
      const x = Number(transform[4]);
      const y = Number(transform[5]);
      const width = Number(item.width);
      /*
       * The run's drawn height, from the transform's vertical scale.
       *
       * It is what tells a SUPERSCRIPT from a line of its own: a brochure
       * writes `321m²` as `321m` and a raised `2` at 58% of the type size,
       * three units up, and without the height the reader has to guess
       * whether a run slightly above another is an exponent or a new line.
       * Absent or unreadable it contributes 0, which makes the superscript
       * rule decline rather than fire — see `layoutLines`.
       */
      const height = Math.abs(Number(transform[3]));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      items.push({
        text: item.str,
        x,
        y,
        height: Number.isFinite(height) ? height : 0,
        // A run with no stated advance contributes no width, which can only
        // make a gap look WIDER — so cells split rather than merge, and a
        // split cell is refused by the alignment test rather than imported.
        width: Number.isFinite(width) ? width : 0,
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Does most of this page's text run left to right along the page?
 *
 * A run is upright when its baseline points along +x: the transform's first
 * term is positive and its second is negligible beside it. Skew (italic) is
 * the third term and is not asked. Characters, not runs, are counted, so one
 * long sideways caption outweighs a scatter of short upright page numbers and
 * the reverse.
 */
export function mostlyUpright(raw: readonly unknown[]): boolean {
  let upright = 0;
  let total = 0;
  for (const entry of raw) {
    const item = entry as { str?: unknown; transform?: unknown };
    if (typeof item?.str !== 'string' || !Array.isArray(item.transform)) continue;
    const length = item.str.trim().length;
    if (!length) continue;
    const a = Number(item.transform[0]);
    const b = Number(item.transform[1]);
    total += length;
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && Math.abs(b) <= a * 0.05) upright += length;
  }
  return total === 0 || upright * 2 >= total;
}

function short(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).slice(0, 160);
}
