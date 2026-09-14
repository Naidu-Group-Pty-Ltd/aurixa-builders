/**
 * Builder stock lists — reading the file.
 *
 * One entry point, `extractStockFile`, which turns whatever the builder
 * uploaded into at most three things:
 *
 *   rows          a keyed table, when the file HAS a table. Normalised
 *                 deterministically — no model is involved and nothing can be
 *                 invented.
 *   text          prose, when it does not. Read by a model afterwards, under a
 *                 schema, with the same "never invent" rule.
 *   media         imagery the file itself carried. Stage 1 of the three-stage
 *                 enrichment, and the only stage whose provenance is the
 *                 builder's own document.
 *
 * Every parser dependency is imported DYNAMICALLY inside its own branch. A
 * spreadsheet upload must not fail because the PDF library could not be
 * fetched, and this function runs in an edge worker where a cold import is a
 * real failure mode.
 */
import { keyRowsByHeader, parseDelimited } from './table.pure.ts';
import { attachRowHyperlinks, hyperlinkTargetOf } from './sheetHyperlinks.pure.ts';
import { readHtmlSource } from './htmlSource.pure.ts';
import { readOpenDocument, readPresentation, readRichText, readStructured } from './otherFormats.pure.ts';
import type { StockFileClassification } from './fileTypes.pure.ts';
import {
  docxRowAnchor, htmlRowAnchor, odfRowAnchor, parseDocxTableImages, parseDrawingAnchors,
  parseOdfTableImages, parseRelationships, parseSlideImages, parseWorkbookSheets,
  relsPathFor, resolveOoxmlPath, sheetRowAnchor, slideAnchor,
} from './documentAnchors.pure.ts';
import {
  SOURCE_ANCHOR_HEADER, settleRowAssetRoles, type AnchoredAssets,
} from './sourceAssets.pure.ts';
import { noPrimaryEvidence } from './sourceImageRole.pure.ts';
import type { PdfPhotoProvenance } from './pdfSourcePhoto.ts';
import type { PdfMediaPlacement } from './pdfPrimaryImage.pure.ts';

export interface ExtractedMedia {
  /** Path inside the container, or the filename for a bare image. */
  name: string;
  bytes: Uint8Array;
  contentType: string;
  /**
   * Where the CONTAINER said this image sits — a sheet row, a table row, a
   * slide. Null when the format stated nothing — and only a document that
   * stated nothing anywhere, for its one imported property, is ever
   * attributed without one.
   */
  anchor?: string | null;
  /**
   * What the enumeration that produced this entry looked like, so a truncated
   * read is a recorded fact rather than a silent one. `discovered` counts the
   * image parts the container held; `kept` how many survived the caps; a
   * truncated list changes `media.length`, and `media.length` used to be one
   * side of a count-equality test that decided which property a picture
   * belonged to.
   */
  enumeration?: { discovered: number; kept: number; index: number; truncated: boolean };
  /**
   * How this picture was taken out of the document, when the format can say —
   * which page, which object, what it hashes to, what was done to it. Recorded
   * against the stored image so "the builder supplied this" is provable rather
   * than asserted. Only the PDF reader states it today.
   */
  provenance?: PdfPhotoProvenance | null;
  /**
   * How a PAGINATED source placed this picture — its visible page, and how
   * often the document draws it.
   *
   * Carried because discovery and role assignment happen at different moments:
   * a PDF's pictures are read here, and which property the document is about is
   * only known once its prose has been read into rows. This travels between the
   * two so the bytes are never read twice and the two cannot disagree.
   */
  placement?: PdfMediaPlacement | null;
}

export interface StockExtraction {
  /** Recorded on the upload row so a support question has an answer. */
  strategy: string;
  rows: Array<Record<string, unknown>>;
  text: string | null;
  /** Images to show a vision model, base64 without the data: prefix. */
  visionImages: Array<{ base64: string; contentType: string }>;
  media: ExtractedMedia[];
  /**
   * Imagery the source published as a URL against ONE of its rows — an `<img>`
   * inside a stock table's row, and the same shape a Notion collection
   * produces. Fetched and stored by `sourceImages.ts`, never linked to.
   */
  rowAssets: AnchoredAssets[];
  /**
   * Prose split the way the document paginates it, when the format paginates
   * at all. `text` is these joined; this is kept alongside so a property read
   * out of the prose can be tied back to the page it was described on.
   */
  pageTexts?: string[];
  /**
   * Did the DOCUMENT's own page tree establish the page order?
   *
   * False means "page 3" is the third-lowest object number rather than the
   * third page, so no page may be read as a property's cover and no page number
   * may be shown to a person. Absent for formats that do not paginate.
   */
  pageOrderAuthoritative?: boolean;
  warnings: string[];
  /** A document/page title, when the format carries one. */
  title?: string | null;
}

const MAX_ROWS = 5000;
const MAX_TEXT_CHARS = 120_000;
const MAX_MEDIA = 40;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** UTF-8, falling back to UTF-16 when the bytes say so. */
function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function mediaContentType(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

/** esm.sh types the module as the JSZip class itself, so the default export
 *  has to be reached through the namespace rather than destructured. */
async function openZip(bytes: Uint8Array): Promise<any> {
  const zipModule = await import('https://esm.sh/jszip@3.10.1') as unknown as
    { default: { loadAsync(data: Uint8Array): Promise<any> } };
  return await zipModule.default.loadAsync(bytes);
}

/**
 * Compare two media part names the way the documents number them: digit runs
 * numerically, everything else byte-wise — so `image2.png` sorts before
 * `image10.png`. Written out rather than `localeCompare(..., { numeric })`
 * because the order of an import must not depend on a runtime's locale data.
 */
export function compareMediaPartNames(a: string, b: string): number {
  const pattern = /(\d+)|(\D+)/g;
  const left = a.match(pattern) ?? [];
  const right = b.match(pattern) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    const ln = /^\d/.test(l) ? Number(l) : null;
    const rn = /^\d/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln - rn;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/**
 * Pull the image parts out of a zip container, IN DOCUMENT ORDER.
 *
 * Parts the document references (the `anchors` map is built by walking the
 * document, so its insertion order IS the document's) come first, in that
 * order; unreferenced parts follow, by a numeric-aware name compare — a plain
 * lexicographic sort put `image10.png` before `image2.png`, which was
 * harmless while attribution was structural and load-bearing the moment
 * anything read the list as an ordering. Deterministic for byte-identical
 * files either way; this makes it also mean something.
 *
 * A truncated read says so: it is recorded on every entry and pushed as a
 * warning, because the caps change `media.length` silently and a silent count
 * is what a count coincidence is made of.
 */
async function readZipMedia(
  zip: any,
  prefix: string,
  anchors?: Map<string, string | null>,
  warnings?: string[],
): Promise<ExtractedMedia[]> {
  const media: ExtractedMedia[] = [];
  const referenced = new Map<string, number>();
  if (anchors) {
    let order = 0;
    for (const key of anchors.keys()) referenced.set(key, order++);
  }
  const names = Object.keys(zip.files)
    .filter((name: string) => name.startsWith(prefix) && !zip.files[name].dir)
    .sort((a: string, b: string) =>
      (referenced.get(a) ?? Number.MAX_SAFE_INTEGER)
        - (referenced.get(b) ?? Number.MAX_SAFE_INTEGER)
      || compareMediaPartNames(a, b));

  let skipped = 0;
  let capped = false;
  for (const name of names) {
    if (media.length >= MAX_MEDIA) { capped = true; break; }
    const contentType = mediaContentType(name);
    if (!contentType) { skipped += 1; continue; }
    const content: Uint8Array = await zip.files[name].async('uint8array');
    if (!content.length || content.length > MAX_MEDIA_BYTES) { skipped += 1; continue; }
    media.push({ name, bytes: content, contentType, anchor: anchors?.get(name) ?? null });
  }

  const discovered = names.length;
  const truncated = capped || skipped > 0;
  media.forEach((entry, index) => {
    entry.enumeration = { discovered, kept: media.length, index, truncated };
  });
  if (truncated && warnings) {
    warnings.push(`Only ${media.length} of ${discovered} images embedded in this file `
      + 'were read; the rest were skipped as oversize or unsupported, or fell past '
      + 'the per-file ceiling.');
  }
  return media;
}

/** Read a part as text, or null when the container does not carry it. */
async function zipText(zip: any, path: string): Promise<string | null> {
  const entry = zip.file(path);
  return entry ? await entry.async('string') as string : null;
}

/**
 * Record an anchor for a media part, and REFUSE an ambiguous one.
 *
 * One picture reused against two rows — an estate logo dropped beside every
 * lot — states no relationship at all, so the second sighting demotes it to
 * null rather than letting the first arbitrarily win.
 */
function noteAnchor(map: Map<string, string | null>, path: string, anchor: string): void {
  if (!map.has(path)) { map.set(path, anchor); return; }
  if (map.get(path) !== anchor) map.set(path, null);
}

/** Where each image part of a workbook is anchored: `sheet:<name>#<row>`. */
async function readSpreadsheetAnchors(zip: any): Promise<Map<string, string | null>> {
  const anchors = new Map<string, string | null>();
  const workbookXml = await zipText(zip, 'xl/workbook.xml');
  const workbookRelsXml = await zipText(zip, 'xl/_rels/workbook.xml.rels');
  if (!workbookXml || !workbookRelsXml) return anchors;

  const workbookRels = parseRelationships(workbookRelsXml);
  for (const sheet of parseWorkbookSheets(workbookXml)) {
    const target = workbookRels[sheet.rid];
    if (!target) continue;
    const sheetPart = resolveOoxmlPath('xl/workbook.xml', target);
    const sheetRelsXml = await zipText(zip, relsPathFor(sheetPart));
    if (!sheetRelsXml) continue;
    const sheetRels = parseRelationships(sheetRelsXml);

    for (const [, relTarget] of Object.entries(sheetRels)) {
      if (!/drawings\/drawing\d*\.xml$/i.test(relTarget)) continue;
      const drawingPart = resolveOoxmlPath(sheetPart, relTarget);
      const drawingXml = await zipText(zip, drawingPart);
      const drawingRelsXml = await zipText(zip, relsPathFor(drawingPart));
      if (!drawingXml || !drawingRelsXml) continue;
      const drawingRels = parseRelationships(drawingRelsXml);

      for (const anchor of parseDrawingAnchors(drawingXml)) {
        const mediaTarget = drawingRels[anchor.rid];
        if (!mediaTarget) continue;
        noteAnchor(
          anchors,
          resolveOoxmlPath(drawingPart, mediaTarget),
          sheetRowAnchor(sheet.name, anchor.row),
        );
      }
    }
  }
  return anchors;
}

/** The whole document text of a .docx, plus every table it contains. */
async function readDocx(zip: any): Promise<{
  /** Each table with the RAW `<w:tbl>` / `<w:tr>` indexes an image anchor uses. */
  tables: Array<{ matrix: string[][]; tableIndex: number; rowIndexes: number[] }>;
  text: string;
  xml: string;
}> {
  const entry = zip.file('word/document.xml');
  if (!entry) return { tables: [], text: '', xml: '' };
  const xml: string = await entry.async('string');

  const cellText = (cellXml: string): string =>
    (cellXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map((run) => run.replace(/<[^>]+>/g, ''))
      .join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  // Indexes are kept over the RAW `<w:tbl>` / `<w:tr>` order, because that is
  // the order an image's relationship is anchored in. Tables and rows the
  // matrix drops would otherwise shift every anchor after them.
  const tables: Array<{ matrix: string[][]; tableIndex: number; rowIndexes: number[] }> = [];
  (xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []).forEach((tableXml, tableIndex) => {
    const matrix: string[][] = [];
    const rowIndexes: number[] = [];
    (tableXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []).forEach((rowXml, rowIndex) => {
      const cells = (rowXml.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(cellText);
      if (cells.length) { matrix.push(cells); rowIndexes.push(rowIndex); }
    });
    if (matrix.length > 1) tables.push({ matrix, tableIndex, rowIndexes });
  });

  // Paragraph text, one line per paragraph, so a schedule laid out as prose
  // still reads sensibly to a model.
  const paragraphs = (xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [])
    .map(cellText)
    .filter((line) => line.length > 0);

  return { tables, text: paragraphs.join('\n'), xml };
}

/**
 * Last resort for a legacy binary .doc: pull the printable runs out.
 *
 * Word 97 stores its text largely as readable UTF-16 in the WordDocument
 * stream, so this recovers a usable transcript from most of them. It is
 * explicitly a fallback and says so in `warnings` — the honest answer to an
 * unreadable one is to ask for a .docx.
 */
function readLegacyDocText(bytes: Uint8Array): string {
  const out: string[] = [];
  let run = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 13 || code === 10 || code === 7) {
      if (run.trim().length > 3) out.push(run.trim());
      run = '';
      continue;
    }
    if (code >= 32 && code < 0xd800) { run += String.fromCharCode(code); continue; }
    if (run.trim().length > 3) out.push(run.trim());
    run = '';
  }
  if (run.trim().length > 3) out.push(run.trim());
  return out.join('\n').slice(0, MAX_TEXT_CHARS);
}

/** Stamp a keyed row with the anchor its source row carries. */
function anchorRows(
  rows: Array<Record<string, unknown>>,
  rowIndexes: number[],
  anchorFor: (sourceIndex: number) => string,
): void {
  rows.forEach((row, index) => {
    row[SOURCE_ANCHOR_HEADER] = anchorFor(rowIndexes[index]);
  });
}

export async function extractStockFile(
  bytes: Uint8Array,
  filename: string,
  classification: StockFileClassification,
  options: { baseUrl?: string } = {},
): Promise<StockExtraction> {
  const result: StockExtraction = {
    strategy: classification.kind,
    rows: [],
    text: null,
    visionImages: [],
    media: [],
    rowAssets: [],
    warnings: [],
  };

  if (classification.kind === 'delimited') {
    const text = decodeText(bytes);
    const keyed = keyRowsByHeader(parseDelimited(text));
    if (keyed) {
      result.strategy = 'delimited_table';
      result.rows = keyed.rows.slice(0, MAX_ROWS);
    } else {
      result.strategy = 'delimited_text';
      result.text = text.slice(0, MAX_TEXT_CHARS);
      result.warnings.push('No column headings were recognised, so the file was read as text.');
    }
    return result;
  }

  if (classification.kind === 'spreadsheet') {
    const XLSX = await import('https://esm.sh/xlsx@0.18.5');
    const workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
    const sheetTexts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      if (result.rows.length >= MAX_ROWS) break;
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      /**
       * BLANK ROWS ARE KEPT, and that is not cosmetic. A drawing is anchored
       * to an absolute sheet row; drop the blanks and every anchor below the
       * first gap points at the property one line up. `keyRowsByHeader` skips
       * them anyway, so the keyed rows are identical — only the indexes change,
       * and the indexes are the whole point.
       */
      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1, raw: false, defval: null, blankrows: true,
      }) as unknown[][];
      if (!matrix.length) continue;
      const range = (() => {
        try {
          return XLSX.utils.decode_range(String(sheet['!ref'] ?? 'A1'));
        } catch {
          return null;
        }
      })();
      const origin = range?.s.r ?? 0;

      /*
       * AND WHERE THE CELLS POINT, read in the same pass and indexed the same
       * way as `matrix` above.
       *
       * `sheet_to_json` returns what a cell DISPLAYS. A stock list's brochure
       * column displays the word "Brochure" and carries its address as a link
       * — so an uploaded workbook arrived with every document it names
       * discarded, and thirteen of the twenty-six live properties reached the
       * image pipeline with no source at all. The reader that does see targets
       * has existed here all along (`readWorkbookSheets`), and ran only for a
       * Google Sheets URL, which fetches `…/export?format=xlsx` to obtain a
       * workbook this branch was already holding.
       *
       * Both ways a builder can write a link are read, because both occur:
       * `cell.l.Target` is what Insert > Link writes, and a cell that IS
       * `=HYPERLINK("…","Brochure")` carries no link record at all. See
       * `hyperlinkTargetOf`.
       */
      const links: (string | null)[][] = [];
      if (range) {
        for (let r = range.s.r; r <= range.e.r; r += 1) {
          const linkRow: (string | null)[] = [];
          for (let c = range.s.c; c <= range.e.c; c += 1) {
            const cell = sheet[XLSX.utils.encode_cell({ r, c })];
            linkRow.push(hyperlinkTargetOf({
              link: cell?.l?.Target ?? null,
              formula: cell?.f ?? null,
            }));
          }
          links.push(linkRow);
        }
      }

      // A wider scan than the default: the blank rows now count towards it.
      const keyed = keyRowsByHeader(matrix, { maxScan: 25 });
      if (keyed) {
        /*
         * The targets become ORDINARY COLUMNS on the row — `DOWNLOAD URL`
         * beside `DOWNLOAD` — under the same `LINK_COLUMN_SUFFIX` the Google
         * Sheets path uses, so a builder's brochure reaches the same place
         * whether they pasted a link to their sheet or dragged in the file.
         * Nothing downstream is taught anything new: an unrecognised heading
         * lands in `unmapped`, and `rowSourceBranches` already reads every
         * address out of there.
         */
        const attached = attachRowHyperlinks({
          rows: keyed.rows,
          rowIndexes: keyed.rowIndexes,
          headers: keyed.headers,
          links,
        });
        if (attached.linksResolved) {
          result.warnings.push(
            `Read ${attached.linksResolved} link target(s) from ${sheetName}.`);
        }
        anchorRows(keyed.rows, keyed.rowIndexes,
          (sourceIndex) => sheetRowAnchor(sheetName, origin + sourceIndex));
        result.rows.push(...keyed.rows.slice(0, MAX_ROWS - result.rows.length));
      } else {
        sheetTexts.push(`# ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet)}`);
      }
    }

    result.strategy = result.rows.length ? 'spreadsheet_table' : 'spreadsheet_text';
    if (!result.rows.length && sheetTexts.length) {
      result.text = sheetTexts.join('\n\n').slice(0, MAX_TEXT_CHARS);
      result.warnings.push('No column headings were recognised, so the sheets were read as text.');
    }

    // Embedded renders and facade photographs live here in a .xlsx, anchored
    // to the cell the builder dropped them on. A legacy .xls is not a zip and
    // carries none we can reach.
    try {
      const zip = await openZip(bytes);
      const anchors = await readSpreadsheetAnchors(zip).catch(() => new Map<string, string | null>());
      result.media = await readZipMedia(zip, 'xl/media/', anchors, result.warnings);
    } catch {
      result.warnings.push('Images inside the spreadsheet could not be read.');
    }
    return result;
  }

  if (classification.kind === 'word') {
    let handled = false;
    try {
      const zip = await openZip(bytes);
      const { tables, text, xml } = await readDocx(zip);
      handled = true;
      for (const section of tables) {
        if (result.rows.length >= MAX_ROWS) break;
        const keyed = keyRowsByHeader(section.matrix);
        if (!keyed) continue;
        anchorRows(keyed.rows, keyed.rowIndexes,
          (sourceIndex) => docxRowAnchor(section.tableIndex, section.rowIndexes[sourceIndex]));
        result.rows.push(...keyed.rows.slice(0, MAX_ROWS - result.rows.length));
      }
      result.strategy = result.rows.length ? 'word_table' : 'word_text';
      if (!result.rows.length && text) result.text = text.slice(0, MAX_TEXT_CHARS);
      try {
        // A picture in a table cell belongs to that cell's row, and Word says
        // so through the relationship id inside the `<w:tr>`.
        const anchors = new Map<string, string | null>();
        const relsXml = await zipText(zip, 'word/_rels/document.xml.rels');
        if (relsXml) {
          const rels = parseRelationships(relsXml);
          for (const image of parseDocxTableImages(xml)) {
            const target = rels[image.rid];
            if (!target) continue;
            noteAnchor(anchors, resolveOoxmlPath('word/document.xml', target),
              docxRowAnchor(image.table, image.row));
          }
        }
        result.media = await readZipMedia(zip, 'word/media/', anchors, result.warnings);
      } catch {
        result.warnings.push('Images inside the document could not be read.');
      }
    } catch {
      handled = false;
    }

    if (!handled) {
      const text = readLegacyDocText(bytes);
      result.strategy = 'legacy_word_text';
      result.text = text || null;
      result.warnings.push(
        'This is an older Word format, so only its text could be recovered. A .docx or PDF reads more reliably.',
      );
    }
    return result;
  }

  if (classification.kind === 'pdf') {
    result.strategy = 'pdf_text';
    try {
      // One implementation, shared with the linked-package path, so a brochure
      // uploaded here and the same brochure reached through a row's own link
      // cannot number their pages differently. See `pdfText.ts`.
      const { readPdfPageTexts } = await import('./pdfText.ts');
      const pages = await readPdfPageTexts(bytes);
      if (!pages.length) throw new Error('no text layer');
      result.pageTexts = pages;
      const merged = pages.join('\n');
      result.text = merged.trim() ? merged.slice(0, MAX_TEXT_CHARS) : null;
    } catch (error) {
      result.warnings.push('The PDF text layer could not be read.');
      result.text = null;
      throw new StockExtractionError(
        'pdf_text_extraction_failed',
        'This PDF could not be read. If it is a scan, upload the spreadsheet it came from, or a clearer copy.',
        error,
      );
    }
    if (!result.text) {
      throw new StockExtractionError(
        'pdf_no_text_layer',
        'This PDF has no readable text — it looks like a scan. Upload the source spreadsheet or a text-based PDF.',
      );
    }

    // The images the builder put in their own document, page by page. Same
    // extractor a package PDF reached through a Notion row goes through, so a
    // brochure uploaded here and the same brochure reached through a link
    // cannot disagree about which picture is the property.
    try {
      const { discoverPdfSourceAssets } = await import('./pdfSourcePhoto.ts');
      const { pdfPageAnchor } = await import('./pdfRowAnchors.pure.ts');
      /**
       * EVERY picture, not one per page.
       *
       * This used to take a single photograph per page — the largest — which
       * silently decided which of a cover's pictures the product would ever see
       * before anything had asked what they were. Discovery now hands over all
       * of them and the role is settled where the property is known.
       */
      const found = await discoverPdfSourceAssets(bytes);
      result.pageOrderAuthoritative = found.pageOrderAuthoritative;
      let pdfSkipped = 0;
      let pdfCapped = false;
      for (const asset of found.assets) {
        if (result.media.length >= MAX_MEDIA) { pdfCapped = true; break; }
        if (asset.bytes.length > MAX_MEDIA_BYTES) { pdfSkipped += 1; continue; }
        /**
         * THE OBJECT NUMBER IS PART OF THE NAME, and it has to be.
         *
         * A resource name means whatever the resources that drew it say it
         * means, so `/Im0` inside one form and `/Im0` inside another are two
         * different pictures — and a real exporter emits exactly that. The live
         * Donnybrook contract draws two of them on its third page. Naming both
         * `page3:Im0` made them one row: the storage key and the upsert key are
         * this string, so the second silently replaced the first and one
         * discovered asset vanished.
         */
        const suffix = asset.provenance.method === 'page_crop'
          ? `crop(${asset.provenance.crop?.top}-${asset.provenance.crop?.bottom})`
          : `${asset.provenance.resourceName ?? 'img'}#${asset.provenance.objectNumber ?? 0}`;
        result.media.push({
          // 1-based and the page a PERSON sees, which is what `page` in the
          // provenance record has to mean.
          name: `page${asset.page}:${suffix}`,
          bytes: asset.bytes,
          contentType: asset.contentType,
          // The page IS the anchor. Attribution is by page number and never by
          // the order images happen to appear in the file.
          anchor: pdfPageAnchor(asset.page),
          provenance: asset.provenance,
          placement: asset.placement,
        });
      }
      // A truncated read is a recorded fact, exactly as it is for the zip
      // containers: the caps change the count silently otherwise.
      if (pdfCapped || pdfSkipped > 0) {
        result.media.forEach((entry, index) => {
          entry.enumeration = {
            discovered: found.assets.length, kept: result.media.length,
            index, truncated: true,
          };
        });
        result.warnings.push(`Only ${result.media.length} of ${found.assets.length} `
          + 'images discovered in this PDF were read; the rest were oversize or fell '
          + 'past the per-file ceiling.');
      }
    } catch {
      result.warnings.push('Images inside this PDF could not be read.');
    }

    if (!result.media.length) {
      // Accurate, and it promises nothing: no other imagery is displayable, so
      // saying where a substitute will come from would be a lie.
      result.warnings.push('No property photograph could be identified in this PDF.');
    }
    return result;
  }

  if (classification.kind === 'opendocument') {
    // ODS and ODT are zip containers like .docx, read with the same JSZip and
    // the same table-then-prose order.
    const zip = await openZip(bytes);
    const entry = zip.file('content.xml');
    if (!entry) {
      throw new StockExtractionError(
        'opendocument_unreadable',
        'That OpenDocument file could not be read. Save it as XLSX, DOCX or PDF and try again.',
      );
    }
    const xml: string = await entry.async('string');
    const { tableSections, text } = readOpenDocument(xml);

    for (const section of tableSections) {
      if (result.rows.length >= MAX_ROWS) break;
      const keyed = keyRowsByHeader(section.matrix);
      if (!keyed) continue;
      anchorRows(keyed.rows, keyed.rowIndexes,
        (sourceIndex) => odfRowAnchor(section.tableIndex, section.rowIndexes[sourceIndex]));
      result.rows.push(...keyed.rows.slice(0, MAX_ROWS - result.rows.length));
    }
    result.strategy = result.rows.length ? 'opendocument_table' : 'opendocument_text';
    if (!result.rows.length && text) result.text = text.slice(0, MAX_TEXT_CHARS);

    try {
      // `<draw:frame>` inside a `<table:table-row>` names the row it sits in.
      const anchors = new Map<string, string | null>();
      for (const image of parseOdfTableImages(xml)) {
        noteAnchor(anchors, image.href, odfRowAnchor(image.table, image.row));
      }
      result.media = await readZipMedia(zip, 'Pictures/', anchors, result.warnings);
    } catch {
      result.warnings.push('Images inside the document could not be read.');
    }
    return result;
  }

  if (classification.kind === 'presentation') {
    const zip = await openZip(bytes);

    // Slides are numbered files; read them in order so a schedule split over
    // several slides stays in sequence.
    const slideNames = Object.keys(zip.files)
      .filter((name: string) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a: string, b: string) =>
        (Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0)));

    const slideXml: string[] = [];
    for (const name of slideNames) slideXml.push(await zip.files[name].async('string'));
    const { tableSections, text } = readPresentation(slideXml);

    for (const section of tableSections) {
      if (result.rows.length >= MAX_ROWS) break;
      const keyed = keyRowsByHeader(section.matrix);
      if (!keyed) continue;
      // The SLIDE is the anchor: a picture and a schedule on one slide are
      // about one property, and which row of the slide's table an image sits
      // beside is not something the format states.
      anchorRows(keyed.rows, keyed.rowIndexes, () => slideAnchor(section.slideIndex));
      result.rows.push(...keyed.rows.slice(0, MAX_ROWS - result.rows.length));
    }
    result.strategy = result.rows.length ? 'presentation_table' : 'presentation_text';
    if (!result.rows.length && text) result.text = text.slice(0, MAX_TEXT_CHARS);

    try {
      const anchors = new Map<string, string | null>();
      for (const [slideIndex, name] of slideNames.entries()) {
        const relsXml = await zipText(zip, relsPathFor(name));
        if (!relsXml) continue;
        const rels = parseRelationships(relsXml);
        for (const rid of parseSlideImages(slideXml[slideIndex])) {
          const target = rels[rid];
          if (!target) continue;
          noteAnchor(anchors, resolveOoxmlPath(name, target), slideAnchor(slideIndex));
        }
      }
      result.media = await readZipMedia(zip, 'ppt/media/', anchors, result.warnings);
    } catch {
      result.warnings.push('Images inside the presentation could not be read.');
    }
    return result;
  }

  if (classification.kind === 'richtext') {
    const text = readRichText(decodeText(bytes));
    result.strategy = 'richtext_text';
    // An RTF table is a run of \cell control words rather than a grid, so the
    // deterministic reader is tried on the recovered lines first.
    const keyed = keyRowsByHeader(parseDelimited(text, '\t'));
    if (keyed) {
      result.strategy = 'richtext_table';
      result.rows = keyed.rows.slice(0, MAX_ROWS);
    } else {
      result.text = text.slice(0, MAX_TEXT_CHARS) || null;
    }
    if (!result.rows.length && !result.text) {
      throw new StockExtractionError(
        'richtext_empty', 'No readable text could be recovered from that RTF file.');
    }
    return result;
  }

  if (classification.kind === 'markup') {
    const html = decodeText(bytes);
    const baseUrl = options.baseUrl ?? 'https://example.invalid/';
    const { tableSections, text, title } = readHtmlSource(html, baseUrl);
    for (const [tableIndex, section] of tableSections.entries()) {
      if (result.rows.length >= MAX_ROWS) break;
      const keyed = keyRowsByHeader(section.matrix);
      if (!keyed) continue;
      anchorRows(keyed.rows, keyed.rowIndexes,
        (sourceIndex) => htmlRowAnchor(tableIndex, sourceIndex));

      /**
       * The images this row CONTAINS, kept with the row.
       *
       * The page-wide `imageUrls` list is still gathered for provenance, but
       * it cannot be attributed to anything — which is why it used to be
       * dropped and the property fell through to Google. Containment is a
       * relationship the markup states, so it is honoured.
       */
      keyed.rowIndexes.forEach((sourceIndex, rowIndex) => {
        if (rowIndex >= keyed.rows.length) return;
        const urls = section.rowImageUrls[sourceIndex] ?? [];
        if (!urls.length) return;
        result.rowAssets.push({
          anchor: htmlRowAnchor(tableIndex, sourceIndex),
          // LEVEL 3: the markup states containment, so a row holding ONE
          // photograph has designated it. A row holding several has not, and
          // `settleRowAssetRoles` answers that with no primary rather than the
          // first one in DOM order.
          assets: settleRowAssetRoles(
            urls.slice(0, 6).map((url, position) => ({
              url,
              reference: url.slice(0, 400),
              origin: 'html_row_image' as const,
              provider: 'source_page',
              pageUrl: options.baseUrl ?? null,
              position,
              // An ordinary published URL: if the bytes will not come to us,
              // the link is still something a browser can load.
              linkFallback: true,
              role: noPrimaryEvidence('settled from the row that contains it'),
            })),
            {
              container: 'the property row that contains it',
              designation: 'property image',
            },
          ),
        });
      });

      result.rows.push(...keyed.rows.slice(0, MAX_ROWS - result.rows.length));
    }
    result.strategy = result.rows.length ? 'html_table' : 'html_text';
    result.title = title;
    if (!result.rows.length && text) result.text = text.slice(0, MAX_TEXT_CHARS);
    if (!result.rows.length && !result.text) {
      throw new StockExtractionError(
        'html_empty', 'That page had no readable content.');
    }
    return result;
  }

  if (classification.kind === 'structured') {
    const raw = decodeText(bytes);
    const { rows, text } = readStructured(raw, classification.extension);
    if (rows.length) {
      result.strategy = 'structured_rows';
      result.rows = rows.slice(0, MAX_ROWS);
    } else {
      result.strategy = 'structured_text';
      result.text = text.slice(0, MAX_TEXT_CHARS) || null;
      if (!result.text) {
        throw new StockExtractionError(
          'structured_empty', 'That file contained no readable records.');
      }
    }
    return result;
  }

  if (classification.kind === 'image') {
    result.strategy = 'image_vision';
    const contentType = mediaContentType(filename) ?? 'image/jpeg';
    result.visionImages.push({ base64: bytesToBase64(bytes), contentType });
    // The uploaded photograph IS the document, so it is also stage-1 imagery.
    result.media.push({ name: filename, bytes, contentType });
    return result;
  }

  throw new StockExtractionError(
    'unsupported_file_type',
    classification.reason ?? 'That file type cannot be read.',
  );
}

/** An extraction failure with a message that is safe to show the uploader. */
export class StockExtractionError extends Error {
  readonly code: string;
  readonly safeMessage: string;
  /** Not `cause`: that is a member of `Error` itself and overriding it here
   *  would need an `override` modifier the Deno check insists on. */
  readonly underlying?: unknown;
  constructor(code: string, safeMessage: string, underlying?: unknown) {
    super(`${code}: ${safeMessage}`);
    this.name = 'StockExtractionError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.underlying = underlying;
  }
}
