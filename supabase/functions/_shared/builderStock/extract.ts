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
import {
  discoveryRefusal, IMAGERY_DEFERRED_WARNING, storageDeadlineFrom,
  type DiscoveryRefusal, type ImportBudget,
} from './importBudget.pure.ts';
import { attachRowHyperlinks, hyperlinkTargetOf } from './sheetHyperlinks.pure.ts';
/*
 * ORDINARY OCR, at the one seam where a PDF's own text is found wanting.
 * Static imports of the POLICY (pure, tiny) and the recogniser's entry point;
 * the recogniser itself imports the engine and the 3.9 MB language module
 * DYNAMICALLY, so an import that never meets a scan pays nothing.
 */
import { mergeRecognisedPages, planOcr } from './ocr/ocrPolicy.pure.ts';
import type { ScanRasterLocation } from './ocr/scanRaster.pure.ts';
import {
  OCR_MAX_PAGES, isFinalOcrRefusal, recogniseScannedPages,
} from './ocr/recogniseScan.ts';
import { OCR_PAGE_MS, remainingExpensiveMs } from './importResumeBudget.pure.ts';
import { MAX_GRID_CELLS } from './sheetGrid.pure.ts';
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
import {
  countIn, recordStage, type ImportStage, type ImportStageLedger,
} from './importStageLedger.pure.ts';
import type { PdfPhotoProvenance } from './pdfSourcePhoto.ts';
import type { PdfMediaPlacement } from './pdfPrimaryImage.pure.ts';
import type { PdfFigure } from './pdfFigures.pure.ts';
import type { PdfOutlineFigure } from './pdfOutlineFigures.pure.ts';
import type {
  PdfDeterministicReading, PdfTextLayoutPage,
} from './pdfDeterministicRows.pure.ts';

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

/**
 * WHAT AN IMPORT SPENDS IS RECORDED BY `importStageLedger.pure.ts`.
 *
 * `ExtractionTimings` used to be declared here, flat: `document_extract_ms`
 * covered the text layer AND the positioned layout, which are two different
 * costs over the same bytes with no way to tell which one is expensive. The
 * 22 September CPU kill needed exactly that distinction, so the ledger is now
 * shared with `runImport` and split at the stage boundaries — one account of
 * one run rather than two that have to be reconciled.
 *
 * DIAGNOSTICS AND PROGRESS ONLY. Milliseconds, counts and stage names; never
 * a byte of the customer's document.
 */
export interface StockExtraction {
  /** See `importStageLedger.pure.ts`. Diagnostics and progress; never a decision. */
  timings?: ImportStageLedger;
  /** Recorded on the upload row so a support question has an answer. */
  strategy: string;
  rows: Array<Record<string, unknown>>;
  text: string | null;
  /** Images to show a vision model, base64 without the data: prefix. */
  visionImages: Array<{ base64: string; contentType: string }>;
  media: ExtractedMedia[];
  /**
   * Set when this run declined to decompress the document's images inline
   * because its budget was spent, so the caller can report the imagery as
   * outstanding rather than as absent. Absent on every unbudgeted path.
   */
  imageryDeferred?: DiscoveryRefusal | null;
  /**
   * The pages recognition still owes this document, after everything this
   * invocation and its predecessors have settled.
   *
   * THE HAND-OFF SIGNAL, AND THE ONLY ONE. A non-empty list means a successor
   * invocation has something worth doing that cannot be done anywhere else —
   * imagery goes to the settler, row writes are free, and recognition is the
   * one stage with nowhere else to go. An empty list, or absent, means this
   * document is finished with the recogniser.
   *
   * Absent on every document that needed no recognition, which is almost all
   * of them.
   */
  ocrOutstanding?: number[];
  /**
   * Where each owed page's picture is, with the digest of every stream named —
   * set by `handoff` alone, and only where a page is owed. The recognition
   * isolates make each picture from this and never parse the document. See
   * `ocr/scanRaster.pure.ts`.
   */
  ocrRasters?: ScanRasterLocation[];
  /**
   * What text RECOGNITION did, where the PDF's own text layer was wanting.
   *
   * Absent on every document whose pages state their own text, which is
   * almost all of them. Present it is the honest account of a scan: how many
   * pages were attempted, how many were read, which were refused and why, and
   * whether the engine was available at all — so "this scan imported nothing"
   * can never be indistinguishable from "this scan was never looked at".
   */
  ocr?: {
    attempted: number;
    read: number;
    /** 1-based pages whose text came from recognition. */
    recognisedPages?: number[];
    refusals: Array<{ page: number; reason: string }>;
    available: boolean;
    ms: number;
    imageOnly: boolean;
    error?: string;
  } | null;
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
  /**
   * What the deterministic PDF reader made of this document, set by the PDF
   * branch alone.
   *
   * DIAGNOSTIC AND NEVER A DECISION. The pipeline reads `rows` to decide
   * whether the assisted reader runs, exactly as it always has; this is here
   * so the import log can say WHY a document went to a model — "its labels
   * carried no values", "it stated two prices" — instead of a support question
   * having no answer. It carries counts, status words and canonical field
   * NAMES only, so it is safe to log.
   */
  deterministicReading?: PdfDeterministicDiagnostics;
  /**
   * Insets a PDF draws that may state a figure only as a picture — an area
   * schedule printed as a raster — as offsets into the document, never
   * decoded here. Which are read, and by which isolate, is decided once the
   * property is known. See `pdfFigures.pure.ts`. Absent for every other format.
   */
  pdfFigures?: PdfFigure[];
  /**
   * Blocks of type a PDF paints as shapes — rows the exporter converted to
   * curves — as polygons, never drawn or recognised here. Read, where they
   * are, under the same rules as `pdfFigures`. See `pdfOutlineFigures.pure.ts`.
   */
  pdfOutlines?: PdfOutlineFigure[];
  /**
   * The record the deterministic reader HAD when it stood down.
   *
   * SEPARATE FROM `deterministicReading` ON PURPOSE. That field is the
   * safe-to-log projection — counts, field names and status words, never a
   * value the document stated — and putting a read record inside it would put
   * a builder's price in an import log. This carries the values; nothing logs
   * it, and only `runStockImport` reads it.
   *
   * Empty unless the reader refused AND what it had still identified a
   * property. See `provisionalFrom` in `pdfDeterministicRows.pure.ts`.
   */
  deterministicProvisional?: Array<Record<string, unknown>>;
  /**
   * The lines the deterministic reader could not account for, verbatim and
   * bounded. Document text, so it is kept out of `deterministicReading` (the
   * safe-to-log projection) and travels only to the upload row's internal
   * `error_detail`. See the field's note in `pdfDeterministicRows.pure.ts`.
   */
  deterministicUnaccounted?: string[];
  /**
   * The lines the reader attributed to NOTHING, verbatim and bounded. Document
   * text, so it travels only to the upload row's internal `error_detail` and
   * never into `deterministicReading`, which is the safe-to-log projection.
   */
  deterministicIgnored?: string[];
  /** Where each of those lines was drawn, aligned by index. Numbers only. */
  deterministicPlacement?: string[];
  /**
   * The property regions a page carried, where the document was read region by
   * region. Empty or absent on everything else, which is every document this
   * reader has handled until now.
   *
   * It exists to answer one question downstream: a page carrying three
   * property cards draws three renders, and which is whose is a question the
   * page NUMBER cannot answer. `anchor` is the same `pdf:page{N}#r{i}` the
   * row carries, so the two meet without either knowing about the other;
   * `text` is the region's own text, which is what the imagery path asks its
   * "does this property's page state its identity" questions of once the page
   * has been divided.
   *
   * DOCUMENT TEXT, so it is kept out of `deterministicReading` exactly as
   * `deterministicIgnored` is — that field is the safe-to-log projection and
   * this is never logged.
   */
  pdfRegions?: Array<{ page: number; index: number; anchor: string; text: string }>;
}

/**
 * The diagnostic projection of a deterministic reading, and the WHOLE of what
 * travels out of this module.
 *
 * Named and exported because `runImport` carries it to the import log, and a
 * caller that restates the shape restates it slightly differently: typing that
 * field as the full `PdfDeterministicReading` is exactly what CI caught, and
 * widening this to satisfy it would have pushed `rows` — a builder's own
 * stated values — into a field whose entire purpose is to be safe to log.
 */
export interface PdfDeterministicDiagnostics {
  status: PdfDeterministicReading['status'];
  reason: string;
  diagnostics: PdfDeterministicReading['diagnostics'];
}

const MAX_ROWS = 5000;
const MAX_TEXT_CHARS = 120_000;
/**
 * EMBEDDED-MEDIA ENUMERATION IS COMPLETE; the safeguards are BYTES.
 *
 * There is no media COUNT ceiling any more. Every count this had — 40, then
 * 150 — was arbitrary against the requirement it kept breaking: a list whose
 * document embeds one photograph per row hits the number and the properties
 * past it have their own photographs refused unread, which the invariant then
 * (correctly, loudly) turns into a blocked publication. A count also never
 * guarded the resource it claimed to: photographs sit in their container
 * already compressed, so the bytes a ≤25 MB upload can decompress to are
 * bounded by the byte caps below whatever the count says.
 *
 * THE SUPPORTED SIZE CONTRACT, stated once, here, where it is enforced:
 *   • a stock-list FILE — uploaded or linked — is admitted to 25 MB
 *     (`MAX_STOCK_FILE_BYTES` / `MAX_SOURCE_BYTES`); larger is refused at the
 *     door with the limit named, never queued and never silent;
 *   • a linked brochure PDF is read and its cover elected IN-PROCESS to that
 *     same 25 MB; above it the document is UNSUPPORTED — the refusal names
 *     the size, and no optional worker extends the limit;
 *   • one embedded image may decompress to `MAX_MEDIA_BYTES` (8 MB); larger
 *     parts are skipped and counted, which flags the enumeration truncated;
 *   • one container's media may decompress to `MAX_MEDIA_TOTAL_BYTES` in
 *     total — 40 MB, above anything a legitimate 25 MB container can hold
 *     (its images are stored compressed), so the only thing that can reach
 *     it is a decompression bomb, and hitting it is the same LOUD,
 *     publication-blocking truncation it always was.
 *
 * Enumeration is a single pass over a ≤25 MB container and completes within
 * one invocation; what takes real time — storing and judging each image —
 * already resumes across invocations through the settlement sweeps' budgets
 * and idempotent upserts, so a larger count changes duration, never outcome.
 */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_TOTAL_BYTES = 40 * 1024 * 1024;

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
  let totalBytes = 0;
  for (const name of names) {
    const contentType = mediaContentType(name);
    if (!contentType) { skipped += 1; continue; }
    const content: Uint8Array = await zip.files[name].async('uint8array');
    if (!content.length || content.length > MAX_MEDIA_BYTES) { skipped += 1; continue; }
    // The bomb guard, not a working limit: a legitimate container cannot
    // reach it (see the contract on `MAX_MEDIA_TOTAL_BYTES`).
    if (totalBytes + content.length > MAX_MEDIA_TOTAL_BYTES) { capped = true; break; }
    totalBytes += content.length;
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
  options: {
    baseUrl?: string;
    organisationName?: string | null;
    /**
     * WHAT THE DOCUMENT IS CALLED, as distinct from `filename`, which is the
     * upload's display label and is what a URL import shows in a list.
     *
     * Only the deterministic PDF reader takes this, and it takes it because
     * it uses a name as EVIDENCE. `filename` still serves everything that
     * merely wants an extension — a bare image's content type and its media
     * name — where a display label is perfectly good and a missing document
     * name would be a regression.
     *
     * Absent falls back to `filename`, which is correct for every caller
     * that holds a real file (the repair sweep, re-reads) and is why this is
     * additive: only the URL import states it, and it states the truth,
     * including the truth that a URL named no document. See
     * `documentName.pure.ts`.
     */
    documentName?: string | null;
    /**
     * The run's own clock, when the caller keeps one.
     *
     * ABSENT MEANS UNBUDGETED, and unbudgeted means exactly today's
     * behaviour — which is what keeps this invisible to the repair sweep,
     * whose whole invocation is one document and which must never decline
     * the imagery it exists to attach. See `importBudget.pure.ts`.
     */
    budget?: ImportBudget | null;
    /**
     * The run's ledger, when the caller keeps one across stages.
     *
     * A RESUMED import passes the ledger it already has, so the stages this
     * invocation runs are added to the account of the ones a previous
     * invocation ran rather than starting a second one. Absent means a fresh
     * run, which is every caller that does not resume.
     */
    ledger?: ImportStageLedger | null;
    /**
     * Commit the ledger. Awaited at every stage boundary; see `timed`.
     *
     * Absent means nothing is persisted and the extraction behaves exactly as
     * it did — which is what keeps the repair sweep, the re-read and every
     * test caller unchanged.
     */
    onStage?: ((ledger: ImportStageLedger) => Promise<void>) | null;
    /**
     * WHAT A PREVIOUS INVOCATION ALREADY RECOGNISED, and where to put what
     * this one recognises.
     *
     * Recognition is the one document-class stage measured to exceed any sane
     * CPU budget on its own — 9,223 ms over three pages, ~3,100 ms each — and
     * it is the only stage in this extractor whose work cannot be handed to
     * another component. So it is the only one that is checkpointed, and this
     * is the whole of that mechanism from the extractor's side: pages it is
     * handed are not re-read, pages it reads are handed back one at a time,
     * and pages it could not afford are named so a successor knows what is
     * still owed.
     *
     * ALL THREE ABSENT MEANS TODAY'S BEHAVIOUR, exactly: one pass, as far as
     * the deadline allows, nothing carried and nothing reported.
     */
    ocrCarried?: ReadonlyMap<number, string> | null;
    ocrSettled?: ReadonlySet<number> | null;
    mayRecognisePage?: (() => boolean) | null;
    onRecognisedPage?: ((page: number, text: string) => Promise<void> | void) | null;
    onRefusedPage?: ((page: number) => Promise<void> | void) | null;
    /**
     * WHERE RECOGNITION HAPPENS, which only the caller can know.
     *
     *   `inline`  — here, one page deep: a caller no successor can reproduce
     *               (a linked source), and every caller that says nothing.
     *   `handoff` — never here: the owed pages' pictures are LOCATED and
     *               returned in `ocrRasters`, with nothing decoded, and the
     *               reading waits for a successor that holds every page.
     *   `carried` — never here, and nothing located: the document is read
     *               with what `ocrCarried` holds. The isolate that finishes a
     *               stored import, and the image settler's re-read.
     */
    ocrMode?: 'inline' | 'handoff' | 'carried';
    /** `carried` only: the attempt found no recogniser, and says so. */
    ocrUnavailable?: boolean;
  } = {},
): Promise<StockExtraction> {
  const result: StockExtraction = {
    strategy: classification.kind,
    rows: [],
    text: null,
    visionImages: [],
    media: [],
    rowAssets: [],
    warnings: [],
    timings: options.ledger ?? {},
  };
  const timings = result.timings!;
  /**
   * Run one stage, record what it cost, and COMMIT the ledger before the next
   * one starts.
   *
   * The commit is the whole point and it is awaited. A worker killed inside
   * the next stage must leave a row saying this one finished and what it
   * spent — which is the difference between an eight-second CPU kill you can
   * account for and the `stage_timings: null` the 22 September one left.
   */
  const timed = async <T>(stage: ImportStage, run: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      recordStage(timings, stage, Date.now() - startedAt);
      if (options.onStage) await options.onStage(timings);
    }
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
      const range = (() => {
        try {
          return XLSX.utils.decode_range(String(sheet['!ref'] ?? 'A1'));
        } catch {
          return null;
        }
      })();
      /*
       * `!ref` IS THE WORKBOOK'S OWN CLAIM ABOUT ITS SIZE, and it arrives
       * inside the file the builder uploaded. `sheet_to_json` below walks the
       * DECLARED rectangle and so does the link pass after it, so a one-row
       * sheet that declares `A1:XFD1048576` is seventeen billion cells of work
       * and a row array per declared row before either finds a real value. The
       * ceiling is the grid reader's own `MAX_GRID_CELLS` — the same bound on
       * the same shape — and it is tested BEFORE anything walks the range,
       * which is the only place testing it helps.
       */
      if (range && (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > MAX_GRID_CELLS) {
        throw new StockExtractionError(
          'spreadsheet_too_large',
          'That spreadsheet declares far more cells than it uses. Save it with just the rows you are listing and upload it again.',
        );
      }
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
      const pages = await timed('native_text', async () => {
        countIn(timings, 'document_parses');
        return await readPdfPageTexts(bytes);
      });
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
    /*
     * ==================================================================
     * A PAGE WITH NO TEXT IS READ RATHER THAN REFUSED.
     * ==================================================================
     *
     * A scanned brochure is a PDF whose pages are photographs of paper, so
     * `readPdfPageTexts` returns empty strings and the refusal below was the
     * whole of this product's answer to it. Recognition is what turns those
     * pixels into the page text every reader downstream already consumes —
     * the SAME `pageTexts`, through the SAME normalisation, the SAME
     * evidence model, the SAME typed validators and the SAME identity,
     * image and publication path. There is no OCR reader and no OCR
     * vocabulary; nothing below this line knows which pages were recognised.
     *
     * PER PAGE, NEVER PER DOCUMENT, which is what makes a MIXED document
     * work: a scanned contract page inside a native brochure leaves the
     * native pages their own exact text and recognises only the scan.
     *
     * AND IT IS NOT A MODEL. Recognition can misread a character and says so
     * in its confidence; a generative model asked to read a brochure writes
     * a plausible one, and the failure mode is a property that does not
     * exist. See `ocr/recogniseScan.ts`.
     */
    const plan = planOcr(result.pageTexts ?? []);
    if (!plan.sufficient) {
      try {
        /*
         * WHAT A PREVIOUS INVOCATION ALREADY SETTLED IS NOT ASKED AGAIN.
         *
         * `ocrSettled` carries the pages a successor must not spend CPU on:
         * the ones already recognised, and the ones refused for a reason that
         * is about the PAGE rather than about an attempt. See
         * `FINAL_OCR_REFUSAL_REASONS` — an `out_of_time` page is deliberately
         * NOT in it, because that refusal is a statement about a budget and
         * re-asking is the entire point of resuming.
         */
        const settled = options.ocrSettled ?? new Set<number>();
        /*
         * AND WHAT THE RASTERISER CAN NEVER REACH IS NOT OWED EITHER.
         * `extractPdfPhotosByPage` visits the first `OCR_MAX_PAGES` pages and
         * no others — the reach the single pass always had — so a plan page
         * beyond it can never yield a raster. It is settled here, in the pass
         * that knows it, rather than costing an isolate apiece to find out.
         */
        const beyondReach = plan.pages
          .filter((page) => page > OCR_MAX_PAGES && !settled.has(page));
        const stillOwed = plan.pages
          .filter((page) => page <= OCR_MAX_PAGES && !settled.has(page));
        /*
         * THE ONE PARSE A SCAN'S PICTURES COST, whichever isolate asks for it:
         * finding each page's raster means reading the page again. Counted as
         * `ocr` rather than as image work, because that is what it is — these
         * rasters exist only to be recognised — and counted as a PARSE, which
         * is what the isolation rule is judged on.
         */
        const parseForScans = <T>(run: () => Promise<T>): Promise<T> =>
          timed('ocr', async () => {
            countIn(timings, 'document_parses');
            return await run();
          });
        /*
         * THE CARRIED PAGES ARE PART OF THE READING, whichever mode read them.
         * A successor that recognised page 5 and was handed pages 1 and 3 by
         * its predecessor must produce the same document as one invocation
         * that read all three — otherwise resuming would change what the
         * deterministic reader sees, which is the one thing a resume may
         * never do.
         */
        const adoptRecognised = (everyPage: ReadonlyMap<number, string>): void => {
          if (!everyPage.size) return;
          result.pageTexts = mergeRecognisedPages(result.pageTexts ?? [], everyPage);
          const recognised = (result.pageTexts ?? []).join('\n');
          result.text = recognised.trim()
            ? recognised.slice(0, MAX_TEXT_CHARS) : result.text;
        };
        const unavailableWarning = 'This PDF looks like a scan and text recognition was not '
          + 'available in this deployment, so its pages could not be read.';
        const mode = options.ocrMode ?? 'inline';

        if (mode === 'handoff') {
          /*
           * ═══════════════════════════════════════════════════════════════
           * THE ISOLATE THAT PARSED THE DOCUMENT RECOGNISES NONE OF IT.
           * ═══════════════════════════════════════════════════════════════
           *
           * The engine runs in the isolate that asks now (`ocr/engine.ts`),
           * because the hosted runtime would not start the worker the old
           * library ran it in — measured 23 September 2026, `Not implemented:
           * Worker.prototype.constructor`, and a fully scanned brochure
           * refused `pdf_no_text_layer`. That puts recognition's whole cost
           * in the asking isolate, so it must not be this one: the rule the
           * picture hand-off keeps, that an isolate which parsed a PDF decodes
           * none of its pictures (`documentRead.pure.ts`), holds here too.
           *
           * So this pass only FINDS each owed page's picture — the raster the
           * page leads with, or the one flattened raster it is — and where its
           * stream sits in the bytes, with the stream's digest. Nothing is
           * decoded. Each page is then recognised by an isolate of its own
           * that parses nothing (`runImport.ts`), from exactly the picture
           * the single pass would have made (`photoAtLocation`), and the
           * document is read by an isolate that recognises nothing.
           *
           * Every owed page is located at once, because locating is a parse
           * and costs tens of milliseconds: a page with no picture is settled
           * here, as the single pass settled it, rather than costing an
           * isolate to find out.
           */
          const { locatePdfPhotosByPage, recordedScanRaster } = await import('./pdfSourcePhoto.ts');
          const located = stillOwed.length
            ? await parseForScans(() => locatePdfPhotosByPage(bytes, {
              maxPages: OCR_MAX_PAGES, pages: stillOwed,
            }))
            : [];
          const locatedPages = new Set(located.map((location) => location.page));
          // The same final refusal the single pass gave a page it could not
          // rasterise, given here for the page no picture was found on.
          const refusals = [...beyondReach, ...stillOwed.filter((page) => !locatedPages.has(page))]
            .map((page) => ({ page, reason: 'no_raster' as const }));
          if (options.onRefusedPage) {
            for (const refusal of refusals) await options.onRefusedPage(refusal.page);
          }
          const everyPage = new Map<number, string>(options.ocrCarried ?? []);
          result.ocr = {
            attempted: plan.pages.length,
            read: everyPage.size,
            recognisedPages: [...everyPage.keys()].sort((a, b) => a - b),
            refusals,
            available: true,
            ms: 0,
            imageOnly: plan.imageOnly,
          };
          adoptRecognised(everyPage);
          result.ocrOutstanding = [...locatedPages].sort((a, b) => a - b);
          if (located.length) {
            countIn(timings, 'ocr_located', located.length);
            result.ocrRasters = await timed('ocr', () => Promise.all(
              located.map((location) => recordedScanRaster(bytes, location))));
            /*
             * AND THE READING WAITS. A document whose recognition is owed has
             * not been read, and everything below this line reads it — so it
             * is read once, by the isolate that holds every page, and not here
             * on a partial text that would be thrown away.
             */
            return result;
          }
        } else if (mode === 'carried') {
          /*
           * NEVER RECOGNISES — READS WITH WHAT WAS RECOGNISED BEFORE.
           *
           * The isolate that reads a document whose pages were recognised
           * elsewhere; the one that finishes an import past its crossing bound
           * or after the recogniser stopped; and the image settler's re-read,
           * which decodes pictures and must never add an engine to that. A
           * page nobody recognised is named as unread for this attempt, never
           * settled: it is a statement about the attempt, not the page.
           */
          const everyPage = new Map<number, string>(options.ocrCarried ?? []);
          const unread = options.ocrUnavailable ? 'engine_unavailable' as const : 'out_of_time' as const;
          const refusals = [
            ...beyondReach.map((page) => ({ page, reason: 'no_raster' as const })),
            ...stillOwed.map((page) => ({ page, reason: unread })),
          ];
          if (options.onRefusedPage) {
            for (const refusal of refusals) {
              if (isFinalOcrRefusal(refusal)) await options.onRefusedPage(refusal.page);
            }
          }
          result.ocr = {
            attempted: plan.pages.length,
            read: everyPage.size,
            recognisedPages: [...everyPage.keys()].sort((a, b) => a - b),
            refusals,
            available: !options.ocrUnavailable,
            ms: 0,
            imageOnly: plan.imageOnly,
          };
          result.ocrOutstanding = [];
          adoptRecognised(everyPage);
          if (options.ocrUnavailable) result.warnings.push(unavailableWarning);
        } else {
          /*
           * RECOGNISED HERE, BECAUSE NO SUCCESSOR CAN REPRODUCE THIS READ.
           *
           * A linked source is read in one isolate or not at all: a successor
           * re-reads stored bytes and nothing else, while a link's name,
           * address and row assets are evidence the reader uses
           * (`resumableFromStoredBytes` in `runImport.ts`). So a linked scan is
           * recognised where it was parsed — the exception a linked source's
           * figures already take (`mayReadFigures`), bounded as it always was:
           * the one page this invocation's allowance reaches, and the rest left
           * unread. A caller that states no mode lands here too, which is what
           * keeps a script or a unit test reading exactly as it did.
           */
          const { extractPdfPhotosByPage } = await import('./pdfSourcePhoto.ts');
          /*
           * RASTERISE ONLY WHAT THIS INVOCATION CAN AFFORD TO RECOGNISE.
           *
           * Decompressing a page is charged to the same allowance recognising it
           * is, and it happens FIRST — so without this, an invocation could
           * rasterise eight pages, discover it has nothing left, recognise none
           * of them and hand off; and its successor would do exactly the same,
           * for ever, until the crossing bound stopped it. Ten isolates spent
           * decompressing the same pages over and over is the worst outcome
           * available here and it is produced by the mechanism meant to prevent
           * it.
           *
           * AT LEAST ONE, ALWAYS — and by the measured numbers, exactly one. The
           * allowance is 3,000 ms and a page is charged 3,100, so a fresh
           * invocation can afford one page and never two; the floor is what
           * makes that one rather than none, because an invocation that makes no
           * progress is a crossing wasted. A linked scan is therefore recognised
           * one page deep, which is the price of never being killed. (This said the
           * floor "never binds in practice". It binds on every invocation, and
           * believing otherwise is how a page that could never be settled went
           * unnoticed — see below.)
           */
          const affordable = Math.max(1, Math.floor(
            remainingExpensiveMs(options.ledger) / OCR_PAGE_MS));
          const outstanding = stillOwed.slice(0, affordable);
          const wanted = new Set(outstanding);
          /*
           * COUNTED AS `ocr` RATHER THAN AS IMAGE WORK, because that is what it
           * is: these rasters exist only to be recognised and are thrown away
           * afterwards. Filing them under image extraction was the flat
           * ledger's doing and it made a scanned document look like one with
           * lots of pictures.
           *
           * AND ONLY THE PAGES THE PLAN WANTS ARE DECOMPRESSED. Measured
           * 22 September 2026: this call took a page COUNT, rasterised pages
           * 1..n and the filter below threw away what the plan had not asked
           * for — 4,408 ms on `stress-many-images` to recognise none of them.
           */
          const photos = outstanding.length
            ? await parseForScans(() => extractPdfPhotosByPage(bytes, {
              maxPages: OCR_MAX_PAGES, pages: outstanding,
            }))
            : [];
          const rasters = photos
            .filter((entry) => wanted.has(entry.page))
            .map((entry) => ({
              page: entry.page,
              bytes: entry.photo.bytes,
              width: entry.photo.provenance.sourceWidth,
              height: entry.photo.provenance.sourceHeight,
            }));
          countIn(timings, 'rasterisations', rasters.length);
          const reading = await timed('ocr', () => recogniseScannedPages(rasters, {
            deadlineAt: options.budget
              ? storageDeadlineFrom(options.budget, Date.now()) : undefined,
            mayRecognise: options.mayRecognisePage ?? null,
            onPage: options.onRecognisedPage ?? null,
          }));
          /*
           * A PAGE THE RASTERISER COULD NOT REACH IS SETTLED, NEVER OWED.
           *
           * The recogniser settles every page it is HANDED — too large, no
           * raster, unreadable. A page the plan asked for and the rasteriser
           * found no image on was never handed to it, so it was neither read nor
           * refused, and stayed owed. Measured 23 September 2026:
           * `stress-heavy-brochure` logged `outstanding: 1, recognised: 0` on
           * every crossing up to the bound — eleven isolates and forty-four
           * document parses for a brochure that reads in one — and because each
           * crossing takes the FIRST owed page, such a page also stood in front
           * of every readable page behind it: `stress-many-images` sat at six
           * owed pages for five crossings without attempting one of them.
           * Before the continuation existed the page was simply passed over in
           * the one pass there was. `no_raster` is the final refusal that says
           * so, and it is final because the same bytes carry the same images
           * every time they are read.
           */
          const rasterised = new Set(rasters.map((raster) => raster.page));
          const refusals = [
            ...[...beyondReach, ...outstanding.filter((page) => !rasterised.has(page))]
              .map((page) => ({ page, reason: 'no_raster' as const })),
            ...reading.refusals,
          ];
          /*
           * A REFUSAL THAT IS ABOUT THE PAGE IS REPORTED SO IT IS NEVER ASKED
           * AGAIN. One that is about the attempt is not — it stays outstanding
           * and a successor retries it with a fresh allowance.
           */
          if (options.onRefusedPage) {
            for (const refusal of refusals) {
              if (isFinalOcrRefusal(refusal)) await options.onRefusedPage(refusal.page);
            }
          }
          const everyPage = new Map<number, string>(options.ocrCarried ?? []);
          for (const [page, text] of reading.text) everyPage.set(page, text);
          countIn(timings, 'ocr_pages', reading.text.size);
          result.ocr = {
            attempted: plan.pages.length,
            read: everyPage.size,
            recognisedPages: [...everyPage.keys()].sort((a, b) => a - b),
            refusals,
            available: reading.available,
            ms: reading.ms,
            imageOnly: plan.imageOnly,
          };
          /*
           * PAGES THIS DEPLOYMENT STILL OWES — the plan's pages that neither
           * this invocation nor any before it has settled. A non-empty list is
           * the extractor saying "a successor has something worth doing"; an
           * empty one is what lets the run finish.
           */
          result.ocrOutstanding = plan.pages
            .filter((page) => !everyPage.has(page)
              && !settled.has(page)
              && !refusals.some((r) => r.page === page && isFinalOcrRefusal(r)));
          adoptRecognised(everyPage);
          if (!reading.available) result.warnings.push(unavailableWarning);
        }
      } catch (error) {
        // Recognition can never fail an import. A document it could not read
        // is a document with no text, which the refusal below already says
        // honestly.
        result.warnings.push('The scanned pages of this PDF could not be recognised.');
        result.ocr = {
          attempted: plan.pages.length, read: 0, refusals: [],
          available: false, ms: 0, imageOnly: plan.imageOnly,
          error: String((error as Error)?.message ?? error).slice(0, 200),
        };
      }
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
    /*
     * DECOMPRESSING EVERY IMAGE ON EVERY PAGE IS THE MOST EXPENSIVE SINGLE
     * ACT IN AN IMPORT, AND IT RAN ON NO BUDGET.
     *
     * `importStock.ts` has always asked whether there is room BEFORE each
     * expensive step. This is the step in front of all of them, and the
     * question was never put to it: on 21 September 2026 a 13.8 MB brochure
     * was killed inside this pass at 6.4 seconds having written nothing at
     * all, and a 9.5 MB one reached the end of every phase and died on the
     * write after them.
     *
     * Declining leaves the document's pictures to `repairSourceImagesForUpload`,
     * which re-reads this same source through this same extractor and attaches
     * them to the properties this run is about to write — one document per
     * invocation, behind the decode slot, with a marker that makes a kill
     * recoverable. The properties still import. See `importBudget.pure.ts`.
     */
    const refusal = discoveryRefusal(options.budget, Date.now());
    if (refusal) {
      result.imageryDeferred = refusal;
      result.warnings.push(IMAGERY_DEFERRED_WARNING);
    } else {
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
      const found = await timed('image_discovery', async () => {
        countIn(timings, 'document_parses');
        return await discoverPdfSourceAssets(bytes);
      });
      result.pageOrderAuthoritative = found.pageOrderAuthoritative;
      result.pdfFigures = found.figures;
      result.pdfOutlines = found.outlines;
      let pdfSkipped = 0;
      let pdfCapped = false;
      let pdfTotalBytes = 0;
      for (const asset of found.assets) {
        if (asset.bytes.length > MAX_MEDIA_BYTES) { pdfSkipped += 1; continue; }
        // Same bomb guard as the zip containers; a count would refuse real
        // pages, bytes only ever refuse what a 25 MB file cannot honestly hold.
        if (pdfTotalBytes + asset.bytes.length > MAX_MEDIA_TOTAL_BYTES) { pdfCapped = true; break; }
        pdfTotalBytes += asset.bytes.length;
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
    }

    /*
     * AND A DOCUMENT WE DID NOT LOOK AT IS NOT A DOCUMENT WITH NO PHOTOGRAPH.
     *
     * This sentence is a finding about the bytes, so it may only be written
     * where the bytes were read. Drawn over a deferred discovery it states
     * the opposite of what happened — the pictures are on their way — and it
     * is the same rule this repository has paid for in the report programme:
     * an absence may not be reported where nothing asked.
     */
    if (!result.media.length && !result.imageryDeferred) {
      // Accurate, and it promises nothing: no other imagery is displayable, so
      // saying where a substitute will come from would be a lie.
      result.warnings.push('No property photograph could be identified in this PDF.');
    }

    /**
     * THE MISSING MIDDLE: what this document SAYS, before anything is asked.
     *
     * Every branch above this one produces rows when the file holds a table
     * and prose when it does not. The PDF branch has only ever produced prose
     * — it has never once written to `result.rows` — so `runImport`'s
     * `if (!rows.length && extraction.text)` was satisfied by every PDF ever
     * uploaded and the assisted reader was reached by construction rather
     * than by judgement. A brochure stating its lot, its estate, its design,
     * its price and its bed/bath/car count in so many words was sent to a paid
     * provider to be told what it already said.
     *
     * NOTHING ABOVE THIS POINT CHANGES. `pageTexts`, `text`, `media`,
     * `pageOrderAuthoritative` and every warning are already settled and are
     * left exactly as they were — the reading below is additive, and on
     * anything but a confident answer this function returns precisely what it
     * returned before.
     *
     * ONLY `complete` SETS ROWS. `incomplete`, `ambiguous` and `unsupported`
     * all mean the same thing here: the deterministic reader could not prove
     * it had read the document, so it says nothing and the existing model path
     * runs. That is fail-closed in the only direction that matters — a refusal
     * costs what today costs, and a wrong acceptance writes a property into a
     * builder's marketplace.
     */
    try {
      const { readPdfDeterministicRows } =
        await import('./pdfDeterministicRows.pure.ts');

      /*
       * THE POSITIONS ARE READ FOR EVERY PDF.
       *
       * They used to be read only where the flattened text suggested a
       * heading row, because only the schedule parser used them. A BROCHURE
       * needs them at least as much: flattening a page to lines is what turns
       *
       *     LAND        HOUSE
       *     350 m²      210 m²
       *
       * into two labels over two values with no way to say which belongs to
       * which, and what turns a label drawn beside its value into one
       * unreadable string. The screen that kept a brochure away from the
       * TABLE parser has moved into `readPdfDeterministicRows`, where it
       * still does exactly that job — so the cost of this is one extra parse
       * of a document already in memory, and no brochure is offered to the
       * schedule reader that was not offered to it before.
       */
      /*
       * `result.pageTexts`, NOT the `pages` const above: that one is declared
       * inside the try block that reads it, and a name read outside the block
       * that declares it is the defect class this repository makes fatal.
       * These are the same strings — the line that set it is thirty above.
       */
      const pageTexts = result.pageTexts ?? [];
      const { readPdfTextLayout } = await import('./pdfTextLayout.ts');
      const layout = await timed('positioned_layout', async () => {
        countIn(timings, 'document_parses');
        return await readPdfTextLayout(bytes);
      });
      const positionedPages: PdfTextLayoutPage[] | null = layout.ok ? layout.pages : null;

      const readerStartedAt = Date.now();
      const reading = readPdfDeterministicRows({
        pageTexts,
        positionedPages,
        /*
         * A page read off its pixels is read as flattened text: its positioned
         * runs describe only whatever native fragment shared it. See the seam
         * in `readPdfBrochure`.
         */
        recognisedPages: result.ocr?.recognisedPages ?? null,
        organisationName: options.organisationName ?? null,
        /*
         * The name the builder gave the file, read only to CLASSIFY a name
         * the document itself printed. It can fill no field of its own.
         *
         * The DOCUMENT'S name, never the upload's display label — those are
         * the same string for a file and are not for a URL, where the label
         * carries the publisher's hostname. See `documentName.pure.ts`.
         */
        filename: options.documentName !== undefined
          ? (options.documentName ?? '')
          : filename,
      });
      /*
       * SEGMENTATION IS SUBTRACTED FROM THE READER RATHER THAN NESTED IN IT.
       * The two run in one synchronous call, so timing them as parent and
       * child would double-count the child against the run's total — and the
       * total is what decides whether a stage boundary is needed.
       */
      const segmentationMs = typeof reading.diagnostics.segmentationMs === 'number'
        ? reading.diagnostics.segmentationMs : 0;
      const normalisationMs = typeof reading.diagnostics.normalisationMs === 'number'
        ? reading.diagnostics.normalisationMs : 0;
      recordStage(timings, 'segmentation', segmentationMs);
      recordStage(timings, 'normalisation', normalisationMs);
      recordStage(timings, 'property_reader',
        Math.max(0, (Date.now() - readerStartedAt) - segmentationMs - normalisationMs));
      if (options.onStage) await options.onStage(timings);
      result.deterministicReading = {
        status: reading.status,
        reason: reading.reason,
        diagnostics: reading.diagnostics,
      };
      // Values, kept out of the projection above and read by one caller.
      if (reading.provisional.length) {
        result.deterministicProvisional = reading.provisional;
      }
      if (reading.unaccounted.length) {
        result.deterministicUnaccounted = reading.unaccounted;
      }
      if (reading.ignored.length) {
        result.deterministicIgnored = reading.ignored;
        result.deterministicPlacement = reading.placement;
      }
      /*
       * `<= MAX_ROWS` rather than a slice. Every other branch truncates at the
       * ceiling and is right to — it has no second reader behind it — but
       * truncating HERE would suppress the assisted reader as well, so the
       * rows past the ceiling would be lost with nothing saying so. A schedule
       * that long goes to the model exactly as it does today.
       */
      if (reading.status === 'complete' && reading.rows.length && reading.strategy
        && reading.rows.length <= MAX_ROWS) {
        result.rows = reading.rows;
        result.strategy = reading.strategy;
        /*
         * ==============================================================
         * AND THE PICTURES FOLLOW THE PROPERTIES, OR THEY FOLLOW NOBODY.
         * ==============================================================
         *
         * Every picture above was anchored to its PAGE, which is the whole
         * of what a page-per-property document has to say. On a page
         * carrying three cards that anchor names all three, and
         * `attributeDocumentMedia` would resolve it to none of them or, worse,
         * fall through to counting — the cross-assignment this whole path
         * exists to prevent.
         *
         * So where the reading divided a page, the pictures drawn on it are
         * re-anchored to the REGION that contains them, and a picture whose
         * ownership cannot be established loses its anchor entirely. That is
         * the deliberate outcome: an unanchored picture is stored against the
         * upload and shown against nobody. A page-wide banner, a logo in the
         * margin, a graphic straddling two cards and a page crop all land
         * there, and each of them should.
         *
         * INSIDE THE ROW GATE ON PURPOSE. A reading whose rows were refused
         * by the ceiling above did not produce the properties these anchors
         * name, so re-anchoring to them would point every picture at nothing.
         */
        if (reading.regions?.length) {
          const { regionForImage } = await import('./propertyRegions.pure.ts');
          const { pdfAnchorPage } = await import('./pdfRowAnchors.pure.ts');
          const regions = reading.regions;
          for (const media of result.media) {
            const page = pdfAnchorPage(media.anchor);
            if (page === null) continue;
            const onPage = regions.filter((region) => region.page === page);
            // A page that did not divide keeps the page anchor it has always
            // had, and everything about it behaves exactly as it did.
            if (!onPage.length) continue;
            const drawn = media.placement?.drawn ?? null;
            const owner = drawn ? regionForImage(onPage, drawn) : null;
            media.anchor = owner ? owner.anchor : null;
          }
          result.pdfRegions = regions.map((region) => ({
            page: region.page, index: region.index,
            anchor: region.anchor, text: region.text,
          }));
        }
      }
    } catch {
      /*
       * A READING THAT THREW IS NO READING. The document's text and images are
       * already in hand and the assisted reader is still in front of it, so
       * this can never be worth an upload — and it deliberately adds no
       * warning, because a builder has nothing to do about it.
       */
    }
    countIn(timings, 'images_extracted', result.media.length);
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
