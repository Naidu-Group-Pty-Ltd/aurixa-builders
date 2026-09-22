/**
 * ===========================================================================
 * SEGMENTATION IS A FACT ABOUT A PDF PAGE, AND IT MAY NOT REACH A TRANSPORT.
 * ===========================================================================
 *
 * `propertyRegions.pure.ts` divides a PDF page that carries several property
 * cards. Everything it decides is read off the page's own drawing — where a
 * run of text sits, where a picture is drawn, what a band states. None of
 * that is knowledge about a source, and none of it is evidence ABOUT a
 * source.
 *
 * A Google Sheet, a Notion database and a linked URL each supply something a
 * PDF cannot: the row a property came from, the cell a picture was anchored
 * to, the database record that owns it, the `Content-Disposition` that names
 * the document. That context is stronger than anything a page's geometry can
 * propose, and it arrives BEFORE a document is ever read. The rule this file
 * pins is therefore a rule about ORDER as much as about scope:
 *
 *   A ROW THAT ARRIVED WITH ITS OWN ANCHOR KEEPS IT.
 *
 * Which is not a new rule. `importStockRecords` has always written a page
 * anchor only where the record carried none —
 * `if (!record.source_anchor && anchors[index])` — and the region work is
 * built on that same line rather than beside it. These tests exist so a later
 * change cannot quietly turn it into an overwrite.
 *
 * WHAT IS PROVED BY RUNNING AND WHAT IS PROVED AT THE SOURCE. Every format
 * whose reader is a local pure module — CSV, TSV, the HTML grid a published
 * Google Sheet serves — is put through the REAL `extractStockFile` in this
 * process and its answer compared field by field. The PDF branch reaches
 * pdf.js through an esm.sh URL that does not resolve in Node, so the
 * properties that concern it are pinned where this repository already pins an
 * Edge handler it cannot import: at the source, by reading the file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const callLLM = vi.fn();
vi.mock('../../../supabase/functions/_shared/llmRouter.ts', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

// eslint-disable-next-line import/first
import { extractStockFile } from '../../../supabase/functions/_shared/builderStock/extract';
// eslint-disable-next-line import/first
import { classifyStockFile } from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';
// eslint-disable-next-line import/first
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
// eslint-disable-next-line import/first
import {
  pdfAnchorPage, pdfAnchorPageOrRegion, pdfPageAnchor,
} from '../../../supabase/functions/_shared/builderStock/pdfRowAnchors.pure';
// eslint-disable-next-line import/first
import {
  pdfAnchorRegion, pdfRegionAnchor,
} from '../../../supabase/functions/_shared/builderStock/propertyRegions.pure';
// eslint-disable-next-line import/first
import {
  docxRowAnchor, htmlRowAnchor, odfRowAnchor, sheetRowAnchor, slideAnchor,
} from '../../../supabase/functions/_shared/builderStock/documentAnchors.pure';
// eslint-disable-next-line import/first
import { withNotionRowAnchors } from '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure';
// eslint-disable-next-line import/first
import { SOURCE_ANCHOR_HEADER } from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SHARED = 'supabase/functions/_shared/builderStock';
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// 1 — the sheet transports read exactly as they did
// ---------------------------------------------------------------------------

/**
 * A stock list as a published Google Sheet serves it.
 *
 * `gviz/tq` answers CSV and the HTML view answers a table; both land in
 * `extractStockFile` as the format below. Nothing about this document is a
 * PDF, and the assertion is that nothing about the reading of it has moved.
 */
const SHEET_CSV = [
  'Lot,Home Design,Land Size,Build Size,Price,Estate',
  '412,Wren 18,350,182,684000,Brookhaven Rise',
  '418,Marlow 22,448,224,812500,Brookhaven Rise',
  '419,Marlow 22,448,224,812500,Brookhaven Rise',
].join('\n');

const SHEET_HTML = `<table>
  <tr><th>Lot</th><th>Home Design</th><th>Land Size</th><th>Price</th></tr>
  <tr><td>101</td><td>Hawke 20</td><td>375</td><td>706000</td></tr>
  <tr><td>102</td><td>Ridley 23</td><td>448</td><td>798000</td></tr>
</table>`;

describe('a Google Sheet still reads as a Google Sheet', () => {
  it('reads the CSV a published sheet serves, unchanged', async () => {
    const out = await extractStockFile(
      bytes(SHEET_CSV), 'stock.csv',
      classifyStockFile('stock.csv', 'text/csv', 'test'));

    expect(out.strategy).toBe('delimited_table');
    expect(out.rows).toHaveLength(3);
    const records = out.rows.map((row) => normaliseStockRow(row));
    expect(records.map((r) => r?.lot_number)).toEqual(['412', '418', '419']);
    expect(records.map((r) => r?.house_design)).toEqual(['Wren 18', 'Marlow 22', 'Marlow 22']);
    expect(records.map((r) => r?.price)).toEqual([684000, 812500, 812500]);
    expect(records.map((r) => r?.development_name))
      .toEqual(['Brookhaven Rise', 'Brookhaven Rise', 'Brookhaven Rise']);

    /*
     * AND NO REGION TRAVELS WITH IT. `pdfRegions` is the one new thing a
     * reading can carry, and a spreadsheet must never carry one: a row IS
     * the property here, and a page geometry has nothing to add to that.
     */
    expect(out.pdfRegions).toBeUndefined();
  });

  it('reads the HTML view a shared sheet serves, unchanged', async () => {
    const out = await extractStockFile(
      bytes(SHEET_HTML), 'sheet.html',
      classifyStockFile('sheet.html', 'text/html', 'test'));

    expect(out.strategy).toBe('html_table');
    const records = out.rows.map((row) => normaliseStockRow(row));
    expect(records.map((r) => r?.lot_number)).toEqual(['101', '102']);
    expect(records.map((r) => r?.price)).toEqual([706000, 798000]);
    expect(out.pdfRegions).toBeUndefined();
  });

  it("keeps the HTML grid's own row anchors on the rows it produced", async () => {
    const out = await extractStockFile(
      bytes(SHEET_HTML), 'sheet.html',
      classifyStockFile('sheet.html', 'text/html', 'test'));
    /*
     * THE SOURCE'S OWN IDENTITY FOR A ROW, which is what a picture in that
     * row is attached by. A PDF page anchor can never be one of these and
     * must never replace one.
     */
    const anchors = out.rows.map((row) => String(row[SOURCE_ANCHOR_HEADER] ?? ''));
    for (const anchor of anchors) {
      expect(anchor).toMatch(/^html:tbl\d+#\d+$/);
      expect(pdfAnchorPage(anchor)).toBeNull();
      expect(pdfAnchorPageOrRegion(anchor)).toBeNull();
      expect(pdfAnchorRegion(anchor)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — Notion's row identity is its own and is never a page
// ---------------------------------------------------------------------------

describe("a Notion database's rows keep their own identity", () => {
  it('stamps each row with its Notion row id, which is not a PDF anchor', () => {
    const matrix = [
      ['Lot', 'Home Design', 'Price'],
      ['412', 'Wren 18', '684000'],
      ['418', 'Marlow 22', '812500'],
    ];
    const rowIds = ['b1e4', 'c7f2'];
    const out = withNotionRowAnchors(matrix, rowIds, SOURCE_ANCHOR_HEADER);

    // The header gained the reserved column and nothing else moved.
    expect(out[0].slice(0, 3)).toEqual(['Lot', 'Home Design', 'Price']);
    expect(out[0]).toContain(SOURCE_ANCHOR_HEADER);
    const column = out[0].indexOf(SOURCE_ANCHOR_HEADER);
    expect(out[1][column]).toBe('notion:b1e4');
    expect(out[2][column]).toBe('notion:c7f2');

    for (const anchor of ['notion:b1e4', 'notion:c7f2']) {
      expect(pdfAnchorPage(anchor)).toBeNull();
      expect(pdfAnchorPageOrRegion(anchor)).toBeNull();
      expect(pdfAnchorRegion(anchor)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — every other transport's anchor vocabulary is untouched by both readers
// ---------------------------------------------------------------------------

describe('the anchor vocabularies stay separate', () => {
  /*
   * WHY THE WHOLE LIST. `pdfAnchorPageOrRegion` is the one reader that was
   * WIDENED by this work — it answers for `pdf:page3` and for `pdf:page3#r1`
   * alike, so a segmented document counts as one whose pictures the document
   * anchored. Widening a matcher is exactly how a matcher starts answering
   * for something it was never meant to, and the fallback it governs decides
   * whether a spreadsheet's pictures are attributed BY ORDER. So every
   * anchor this product mints is put through it.
   */
  const foreign = [
    sheetRowAnchor('STOCKLIST V002', 4),
    sheetRowAnchor('Sheet1', 0),
    docxRowAnchor(1, 7),
    odfRowAnchor(0, 2),
    slideAnchor(3),
    htmlRowAnchor(0, 5),
    'notion:2a4f9c11',
    'notion:attachment:2a4f9c11:cover.jpg',
    'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
    '',
  ];

  it('answers for no anchor but a PDF page or a PDF region', () => {
    for (const anchor of foreign) {
      expect(pdfAnchorPage(anchor)).toBeNull();
      expect(pdfAnchorPageOrRegion(anchor)).toBeNull();
      expect(pdfAnchorRegion(anchor)).toBeNull();
    }
  });

  it('answers for both PDF forms, and tells them apart', () => {
    expect(pdfAnchorPage(pdfPageAnchor(3))).toBe(3);
    expect(pdfAnchorPageOrRegion(pdfPageAnchor(3))).toBe(3);
    // A PAGE anchor is not a REGION anchor: whose a picture is has to be
    // asked of the strict reading, or a card's render is attributed to the
    // sheet it was printed on.
    expect(pdfAnchorRegion(pdfPageAnchor(3))).toBeNull();

    expect(pdfAnchorRegion(pdfRegionAnchor(3, 1))).toEqual({ page: 3, region: 1 });
    expect(pdfAnchorPageOrRegion(pdfRegionAnchor(3, 1))).toBe(3);
    // And a region anchor is not a page anchor, for the same reason read the
    // other way round.
    expect(pdfAnchorPage(pdfRegionAnchor(3, 1))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4 — the rules, pinned at the source
// ---------------------------------------------------------------------------

describe('where the region reader is allowed to reach', () => {
  it('is imported by the PDF reader and the extractor, and by nothing else', () => {
    /*
     * A module nothing outside the PDF path imports cannot change what a
     * spreadsheet or a Notion database does, whatever it decides. This is the
     * containment stated as a property of the repository rather than as an
     * intention in a comment.
     */
    const importers = [
      'extract.ts', 'importStock.ts', 'runImport.ts', 'linkedSource.ts',
      'notionPublicContent.ts', 'notionRecordMap.pure.ts',
      'googleSheetsSource.pure.ts', 'googleSheetsHtmlGrid.pure.ts',
      'sheetGrid.pure.ts', 'sheetHyperlinks.pure.ts', 'workbookSheets.ts',
      'linkRecovery.pure.ts', 'requestLinkRecovery.ts', 'sourceImages.ts',
      'repairSourceImages.ts', 'pdfDeterministicRows.pure.ts',
    ];
    const allowed = new Set(['extract.ts', 'pdfDeterministicRows.pure.ts']);
    for (const file of importers) {
      let source: string;
      try {
        source = read(`${SHARED}/${file}`);
      } catch {
        continue;                       // a module that does not exist here
      }
      const imports = source.includes('propertyRegions.pure');
      expect(
        imports,
        `${file} ${imports ? 'imports' : 'does not import'} propertyRegions.pure`,
      ).toBe(allowed.has(file));
    }
  });

  it('never overwrites a source anchor the row already carried', () => {
    /*
     * THE ONE LINE THE WHOLE GUARD RESTS ON. A Notion row id and a sheet cell
     * reach `importStockRecords` on the record itself; the PDF page anchoring
     * that runs below them is conditional on there being none. A change from
     * `if (!record.source_anchor && …)` to an unconditional assignment would
     * replace a source's own identity with a page number, and the pictures
     * that source anchored would follow the wrong properties.
     */
    const source = read(`${SHARED}/importStock.ts`);
    expect(source).toContain(
      'if (!record.source_anchor && anchors[index]) record.source_anchor = anchors[index];');
  });

  it('applies page anchoring only to a paginated source', () => {
    // `pageTexts` is set by the PDF branch and by nothing else, so the whole
    // anchoring block is unreachable for a spreadsheet or a Notion database.
    const source = read(`${SHARED}/importStock.ts`);
    const block = source.slice(source.indexOf('if (input.pageTexts?.length) {'));
    expect(block.slice(0, 600)).toContain('anchorPdfRowsToPages(');
  });

  it("substitutes a property's page only where the reading divided one", () => {
    /*
     * `regionPageViews` is the one place a property's view of its own pages
     * differs from the document's. It must answer undefined wherever there
     * are no regions, because `assignPdfMediaRolesPerProperty` falls back to
     * `input.pageTexts` on undefined — which is the behaviour every source
     * that is not a segmented PDF has always had.
     */
    const source = read(`${SHARED}/importStock.ts`);
    const start = source.indexOf('function regionPageViews(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 900);
    expect(body).toContain("if (!regions?.length || !pageTexts?.length) return undefined;");
    expect(body).toContain('return views.size ? views : undefined;');

    const roles = read(`${SHARED}/pdfPrimaryImage.pure.ts`);
    expect(roles).toContain('input.pageTextsByItemId?.get(itemId) ?? input.pageTexts');
  });

  it('re-anchors a picture only inside the PDF branch and only on a divided page',
    () => {
      const source = read(`${SHARED}/extract.ts`);
      const start = source.indexOf('if (reading.regions?.length) {');
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start, start + 1200);
      // A page that did not divide keeps the anchor it has always had.
      expect(body).toContain('if (!onPage.length) continue;');
      // And a picture whose owner cannot be established loses its anchor
      // rather than being handed to a neighbour.
      expect(body).toContain('media.anchor = owner ? owner.anchor : null;');
      // Ownership is asked of geometry, never of order or of a name.
      expect(body).toContain('regionForImage(onPage, drawn)');
    });

  it('reads the transport-independent inputs only', () => {
    /*
     * SAME BYTES, SAME DOCUMENT, WHICHEVER TRANSPORT CARRIED THEM. The
     * segmented reader is handed the page texts, the positions, the
     * recognised pages and the organisation's own name — and the one input
     * that DOES differ between a file and a URL, the document's name, is
     * deliberately not passed to it, because a document naming several
     * properties has a name that describes the document.
     */
    const source = read(`${SHARED}/pdfDeterministicRows.pure.ts`);
    const start = source.indexOf('const segmented = readSegmentedDocument(');
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf('});', start));
    expect(call).toContain('recognisedPages: input.recognisedPages');
    expect(call).toContain('organisationName: input.organisationName');
    expect(call).not.toContain('filename');
  });
});
