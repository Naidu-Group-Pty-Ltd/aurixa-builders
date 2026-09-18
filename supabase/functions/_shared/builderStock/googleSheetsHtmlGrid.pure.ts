/**
 * BUILDER STOCK — THE LINK TARGETS OF A SHEET WHOSE OWNER LOCKED EXPORT.
 *
 * WHAT THIS READS, AND WHY IT HAS TO EXIST. A Google Sheet shared "anyone with
 * the link can view" does not necessarily export: the live VG master stock
 * list answers 401 to every `export?format=…` (csv, xlsx, tsv, zip, pdf) while
 * `gviz/tq` serves its rows happily. `gviz` output carries VALUES ONLY — the
 * cell reads `Brochure` and the address underneath it is gone — so for such a
 * document the workbook-export hyperlink enrichment can never run, and every
 * one of the builder's documents used to vanish at the door.
 *
 * MEASURED, 2 SEPTEMBER 2026, spreadsheet `1bPh8W2Bujp…` gid 0: fourteen
 * property rows, each carrying FOUR live links (Brochure, Siting/Masterplan,
 * Estate Brochure, Stage Plan/POS — all Google Drive files), fifty-six
 * anchors in total. Of the public representations probed — export csv/xlsx/
 * tsv/zip/pdf (401), gviz csv/html/json (values only), `htmlview` (an empty
 * JS shell), `pubhtml` (401) — exactly ONE carries the targets:
 *
 *     https://docs.google.com/spreadsheets/d/<id>/htmlview/sheet?gid=<gid>
 *
 * a server-rendered HTML table whose cells wrap their links in
 * `https://www.google.com/url?q=<target>&…`. This module parses that table
 * into the SAME `WorkbookSheet` shape `readWorkbookSheets` produces, so the
 * one existing merge — `matchWorksheet` to prove the tab, `alignWorksheetRows`
 * to prove each row, `mergeHyperlinkColumns` to lay each row's own targets
 * beside it — serves both sources. A second merge is how two link sources
 * would come to attribute a brochure to different rows.
 *
 * THE GID IS HONOURED, WHICH IS BETTER THAN GVIZ MANAGES. Measured on the
 * same document: an unknown gid (4294967290) answers HTTP 400, and a missing
 * gid answers 400 — no substitution, no silently-different tab. The content
 * check still runs regardless, because this module's output goes through
 * `matchWorksheet` like any workbook: a tab that is not decisively the CSV's
 * tab lends no links, whatever endpoint served it.
 *
 * WHAT THIS IS NOT. It is not a scraper of arbitrary pages — the input is one
 * Google-rendered grid for a document the builder supplied, fetched through
 * the same guarded fetch as everything else. And it is not a browser: the
 * table is static server HTML, parsed with bounded regex passes, no script
 * evaluated.
 *
 * Pure: no IO, no clock, no network. The caller performs the fetch.
 */
import type { WorkbookSheet } from './sheetHyperlinks.pure.ts';
import type { SheetsTab } from './googleSheetsSource.pure.ts';

export type { SheetsTab };

/** The one public representation that carries link targets when export is refused. */
export function htmlViewSheetUrl(spreadsheetId: string, gid: string | null): string {
  // `htmlview/sheet` REQUIRES a gid (a missing one answers 400). Callers now
  // hand in the tab the DATA read resolved (`SheetsTabPlan.gid`), so this and
  // the CSV can no longer disagree about which tab "no gid" meant — the defect
  // §"one document, two tabs" in `googleSheetsSource.pure.ts` records. The
  // `?? '0'` remains only for a caller that genuinely has no plan, and the
  // content match downstream still decides either way.
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview/sheet?gid=${gid ?? '0'}`;
}

/** Where the tab list lives. Not `htmlview/sheet`, which carries one grid. */
export function htmlViewDocumentUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`;
}

/**
 * THE TABS A PERSON CAN SEE, IN THE ORDER THEY SEE THEM.
 *
 * WHY THIS EXISTS. `gviz/tq` with no gid does not serve "the first tab" in the
 * sense anybody means it: it serves the document's first SHEET, hidden sheets
 * included. Measured on the reported document, 18 September 2026 — a gid-less
 * read and a read for the impossible gid 4294967290 returned byte-identical
 * payloads (sha256 `ddf60eeb…`), a HIDDEN "VERV AGENT PORTAL" brochure page,
 * while the tab a person opening that link actually sees, "STOCKLIST V002",
 * is gid 0 and holds all 47 properties. A builder pasted the address their
 * browser showed and the import read a tab they cannot even open.
 *
 * `/htmlview` renders a page switcher listing exactly the VISIBLE tabs, in
 * order, each with its gid — which is the same set, in the same order, that
 * the browser draws along the bottom of the sheet. That is the authority this
 * module publishes, and it is why nothing here has to guess.
 *
 * Deliberately tolerant: an unparseable or absent switcher returns an EMPTY
 * list rather than throwing, because "we could not read the tabs" must reach
 * the caller as an absence it can fall back from, never as a failed fetch.
 */
export function parseHtmlViewTabs(html: string): SheetsTab[] {
  const source = String(html ?? '');
  const tabs: SheetsTab[] = [];
  const seen = new Set<string>();

  /*
   * The switcher is emitted as a run of `items.push({name: …, pageUrl: …,
   * gid: "N", initialSheet: …})` calls inside an inline script. Read the pair
   * off each call rather than the surrounding JavaScript: the name is a
   * double-quoted string that may carry escaped quotes, and the gid is always
   * a bare run of digits in its own quoted field.
   */
  for (const match of source.matchAll(
    /items\.push\(\{\s*name:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,4000}?gid:\s*"(\d{1,20})"/g,
  )) {
    const gid = match[2];
    if (seen.has(gid)) continue;
    seen.add(gid);
    tabs.push({ gid, name: unescapeJsString(match[1]).slice(0, 200) });
    if (tabs.length >= 500) break;
  }
  return tabs;
}

/** Google escapes the switcher's strings for JavaScript, not for HTML. */
function unescapeJsString(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hard ceilings, so a hostile or absurd grid cannot balloon memory. */
const MAX_ROWS = 20_000;
const MAX_CELLS = 400_000;

/**
 * The real address behind Google's interstitial redirector.
 *
 * Every anchor in an htmlview grid points at `https://www.google.com/url?q=…`
 * with the true target percent-escaped inside `q`. The target is what the
 * BUILDER wrote in their sheet; the wrapper is Google's, says nothing, and
 * must not become the branch URL — a provenance record keyed on the wrapper
 * would stop matching the moment Google reworded its params.
 *
 * Anything that is not that exact redirector is returned as it stands, so a
 * grid that one day carries direct anchors keeps working unchanged.
 */
export function unwrapGoogleRedirect(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const host = url.hostname.toLowerCase();
  if ((host === 'www.google.com' || host === 'google.com') && url.pathname === '/url') {
    const target = url.searchParams.get('q');
    if (target && /^https?:\/\//i.test(target)) return target;
  }
  return href;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function unescapeHtml(value: string): string {
  return value
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d{1,7});/g, (_, code) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : '';
    });
}

function cellText(body: string): string {
  return unescapeHtml(body.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cellLink(body: string): string | null {
  const anchor = body.match(/<a\b[^>]*\bhref="([^"]+)"/i);
  if (!anchor) return null;
  const href = unwrapGoogleRedirect(unescapeHtml(anchor[1]));
  return /^https?:\/\//i.test(href) ? href : null;
}

function spanOf(attrs: string, name: 'colspan' | 'rowspan'): number {
  const match = attrs.match(new RegExp(`\\b${name}="(\\d{1,4})"`, 'i'));
  const span = match ? Number(match[1]) : 1;
  return Number.isFinite(span) && span >= 1 ? Math.min(span, 1000) : 1;
}

/**
 * The served tab as a workbook sheet: every cell's visible text, and the link
 * it carries, at the COLUMN INDEX the spreadsheet gives it.
 *
 * COLUMN INDICES ARE THE CONTRACT. `mergeHyperlinkColumns` reads a link at
 * [row][column] and writes it beside the CSV cell at the same column, so a
 * parser that let a merged heading shift everything after it one place left
 * would file every brochure under its neighbour's column. Colspans are
 * therefore expanded — the value in the first covered cell, blanks in the
 * rest, which is exactly how the CSV export writes a merged cell — and
 * rowspans reserve their column in the rows below the same way.
 *
 * Row-header `<th>` cells (the 1, 2, 3 … gutter) are not cells of the sheet
 * and are skipped; a `<th>` inside the body (a frozen header row) is kept.
 *
 * Returns null when the payload carries no parseable grid at all — an error
 * page, the JS shell, an empty document — so the caller can tell "no table"
 * from "a table with nothing in it".
 */
export function parseHtmlViewGrid(html: string): WorkbookSheet | null {
  const source = String(html ?? '');
  const tableAt = source.indexOf('<table');
  if (tableAt < 0) return null;
  const tableEnd = source.indexOf('</table>', tableAt);
  const table = tableEnd > tableAt ? source.slice(tableAt, tableEnd) : source.slice(tableAt);

  const values: (string | null)[][] = [];
  const links: (string | null)[][] = [];
  /** Columns still covered by a rowspan from an earlier row. */
  const carry = new Map<number, number>();
  let cells = 0;

  for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (values.length >= MAX_ROWS) break;
    const valueRow: (string | null)[] = [];
    const linkRow: (string | null)[] = [];

    const advance = () => {
      // Skip columns a rowspan above still owns, leaving them blank here.
      while (carry.get(valueRow.length)) {
        carry.set(valueRow.length, (carry.get(valueRow.length) ?? 1) - 1);
        if (!carry.get(valueRow.length)) carry.delete(valueRow.length);
        valueRow.push(null);
        linkRow.push(null);
      }
    };

    for (const cellMatch of rowMatch[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const [, tag, attrs, body] = cellMatch;
      /*
       * THE CHROME IS NOT THE SHEET. The row-number gutter (`row-headers-…`,
       * one per row), the column-letter strip (`column-headers-…`, the whole
       * first row) and the freeze-bar corner are the grid's own furniture;
       * treating the letter strip as a data row would hand `alignWorksheetRows`
       * a row reading A, B, C … that no CSV contains — harmless, but noise —
       * and treating the gutter as column 0 would shift every link one column
       * right, which is not harmless at all.
       */
      if (tag === 'th' && /row-header|column-header|freezebar|grid-sticky/i.test(attrs)) continue;
      advance();
      const text = cellText(body);
      const link = cellLink(body);
      const colspan = spanOf(attrs, 'colspan');
      const rowspan = spanOf(attrs, 'rowspan');
      for (let span = 0; span < colspan; span += 1) {
        if (rowspan > 1) carry.set(valueRow.length, rowspan - 1);
        valueRow.push(span === 0 && text ? text : null);
        linkRow.push(span === 0 ? link : null);
        cells += 1;
        if (cells > MAX_CELLS) return null;
      }
    }
    advance();
    values.push(valueRow);
    links.push(linkRow);
  }

  if (!values.length || values.every((row) => row.every((cell) => !cell))) return null;
  return { name: 'htmlview', values, links };
}
