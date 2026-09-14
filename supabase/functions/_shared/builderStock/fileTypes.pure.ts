/**
 * Builder stock lists — what a builder may upload, and how each kind is read.
 *
 * This is NOT a PDF pipeline with other formats bolted on. A stock list
 * arrives as whatever the builder's sales team keeps it in, and the four
 * shapes below cover what actually turns up: a spreadsheet, a delimited
 * export, a word-processed schedule, and a rendered document or photograph.
 *
 * The declared content type is a claim by the uploader. It is used to reject
 * early and cheaply; the DETECTED type (from the bytes, via
 * `_shared/immutableDocuments.ts`) is what decides how the file is read.
 */

/** 25 MB, matching MAX_BUILDER_DOCUMENT_BYTES and the bucket's own ceiling. */
export const MAX_STOCK_FILE_BYTES = 25 * 1024 * 1024;

export const STOCK_LIST_BUCKET = 'builder-stock-lists';
export const STOCK_IMAGE_BUCKET = 'builder-stock-images';
export const STOCK_LIST_STORAGE_PREFIX = 'stock-lists/';

/** How a file will be read. */
export type StockFileKind =
  | 'delimited'     // .csv .tsv .txt — parsed directly
  | 'spreadsheet'   // .xlsx .xlsm .xls — parsed directly, media extracted
  | 'word'          // .docx .doc — tables parsed directly, prose read by a model
  | 'pdf'           // text extracted, then read by a model
  | 'image'         // read by a model with vision
  | 'opendocument'  // .ods .odt — OpenDocument zip, content.xml read directly
  | 'presentation'  // .pptx — slide XML read for tables and text
  | 'richtext'      // .rtf — control words stripped, then a model
  | 'markup'        // .html .htm — tables and readable text
  | 'structured'    // .json .xml — arrays/records mapped straight onto rows
  | 'unsupported';

export interface StockFileClassification {
  kind: StockFileKind;
  extension: string;
  /** Present when kind is 'unsupported'. Safe to show the uploader. */
  reason?: string;
}

/**
 * Extensions we accept, grouped by how they are read. The browser's file
 * picker is generated from this list, so the two cannot drift.
 */
export const STOCK_EXTENSIONS: Record<Exclude<StockFileKind, 'unsupported'>, string[]> = {
  delimited: ['csv', 'tsv', 'txt'],
  spreadsheet: ['xlsx', 'xlsm', 'xls'],
  word: ['docx', 'doc'],
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  // Every kind below is read by machinery this module already had — the
  // OpenDocument and presentation readers are the same JSZip the .docx reader
  // uses, and the markup reader is the same string work. Nothing here added a
  // dependency to claim a format.
  opendocument: ['ods', 'odt'],
  presentation: ['pptx'],
  richtext: ['rtf'],
  markup: ['html', 'htm'],
  structured: ['json', 'xml'],
};

/** Declared content types the upload endpoint will accept. Advisory only. */
export const STOCK_ALLOWED_DECLARED_MIME: ReadonlySet<string> = new Set([
  'text/csv', 'text/tab-separated-values', 'text/plain', 'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf', 'text/rtf',
  'text/html', 'application/xhtml+xml',
  'application/json', 'text/json',
  'application/xml', 'text/xml',
  // Browsers routinely send this for a file they cannot type. The bytes
  // decide, so refusing it here would reject valid spreadsheets.
  'application/octet-stream', '',
]);

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Reject traversal, absolute paths and anything outside the stock prefix.
 * A storage path is caller-supplied, so it is treated as hostile.
 */
export function isAcceptableStockStoragePath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false;
  if (path.length > 400) return false;
  return path.startsWith(STOCK_LIST_STORAGE_PREFIX);
}

/** A filename that is safe to put in an object path. */
export function safeObjectName(filename: string): string {
  const extension = extensionOf(filename);
  const stem = filename.replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${stem || 'stock-list'}${extension ? `.${extension}` : ''}`;
}

/**
 * Decide how to read the file.
 *
 * The detected MIME wins where it is decisive. Two cases it cannot settle,
 * both real:
 *   • legacy Office containers (`d0cf11e0…`) are one signature for .xls and
 *     .doc alike, so the extension breaks the tie;
 *   • a .tsv is plain text and indistinguishable from prose by signature.
 */
export function classifyStockFile(
  filename: string,
  detectedMime: string | null,
  detectionReason?: string,
): StockFileClassification {
  const extension = extensionOf(filename);

  if (detectedMime === 'application/pdf') return { kind: 'pdf', extension };
  if (detectedMime && detectedMime.startsWith('image/')) {
    if (detectedMime === 'image/tiff') {
      return { kind: 'unsupported', extension, reason: 'TIFF images cannot be read. Save the page as PNG, JPG or PDF.' };
    }
    return { kind: 'image', extension };
  }
  if (detectedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return { kind: 'spreadsheet', extension };
  }
  if (detectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return { kind: 'word', extension };
  }
  if (detectedMime === 'text/csv' || detectedMime === 'text/plain') {
    // Text sniffing cannot tell markup, JSON or a CSV apart — they are all
    // UTF-8 with no signature — so the extension decides which reader gets it.
    // Only a text-shaped extension is honoured here; anything else falls
    // through to the delimited reader, which finds no header row and hands the
    // content to the model as prose.
    if (STOCK_EXTENSIONS.markup.includes(extension)) return { kind: 'markup', extension };
    if (STOCK_EXTENSIONS.structured.includes(extension)) return { kind: 'structured', extension };
    if (STOCK_EXTENSIONS.richtext.includes(extension)) return { kind: 'richtext', extension };
    return { kind: 'delimited', extension };
  }

  // OOXML and OpenDocument are both `application/zip` by signature. The
  // detector already distinguishes Word and Excel by looking inside the
  // archive; these are the containers it reports as ambiguous, and the
  // extension is the only thing left that separates a spreadsheet from a
  // presentation.
  if (detectionReason === 'unsupported_or_ambiguous_zip') {
    if (STOCK_EXTENSIONS.opendocument.includes(extension)) return { kind: 'opendocument', extension };
    if (STOCK_EXTENSIONS.presentation.includes(extension)) return { kind: 'presentation', extension };
    if (STOCK_EXTENSIONS.spreadsheet.includes(extension)) return { kind: 'spreadsheet', extension };
    if (STOCK_EXTENSIONS.word.includes(extension)) return { kind: 'word', extension };
    return {
      kind: 'unsupported', extension,
      reason: 'That archive is not a stock list we can read. Upload the spreadsheet, document or PDF inside it.',
    };
  }

  if (detectionReason === 'ambiguous_legacy_office_container') {
    if (STOCK_EXTENSIONS.spreadsheet.includes(extension)) return { kind: 'spreadsheet', extension };
    if (STOCK_EXTENSIONS.word.includes(extension)) return { kind: 'word', extension };
    return {
      kind: 'unsupported', extension,
      reason: 'This looks like an old Office file we cannot identify. Save it as .xlsx, .docx or .pdf and upload again.',
    };
  }

  if (detectionReason === 'executable_signature') {
    return { kind: 'unsupported', extension, reason: 'That file is a program, not a document.' };
  }

  // Nothing in the bytes was decisive. Fall back to the extension rather than
  // refusing outright — a UTF-16 CSV, for instance, sniffs as binary.
  for (const [kind, extensions] of Object.entries(STOCK_EXTENSIONS)) {
    if (extensions.includes(extension)) return { kind: kind as StockFileKind, extension };
  }

  return {
    kind: 'unsupported', extension,
    reason: 'That file type cannot be read. Upload a spreadsheet (XLSX, XLS, ODS, CSV), '
      + 'a document (DOCX, ODT, RTF, PDF), a web page (HTML), data (JSON, XML), '
      + 'a presentation (PPTX) or a photograph of the schedule.',
  };
}

/**
 * Decide how to read something the server FETCHED rather than something a
 * builder uploaded.
 *
 * Same policy, one extra input. A URL has no filename to lean on, so three
 * signals are combined in order of trustworthiness:
 *
 *   1. the bytes — a PDF is a PDF whatever the link said;
 *   2. the response's own Content-Type — the server's claim about its body,
 *      which is the only thing that distinguishes `text/html` from `text/csv`
 *      when both sniff as plain text;
 *   3. the extension on the final URL — last, because a link ending `.xlsx`
 *      that serves an HTML login page is the common failure this ordering is
 *      designed to survive.
 */
export function classifyFetchedSource(input: {
  detectedMime: string | null;
  detectionReason?: string;
  declaredContentType?: string | null;
  finalUrl: string;
  /** True when the body opens with a doctype or an <html> tag. */
  looksLikeHtml?: boolean;
}): StockFileClassification {
  const declared = String(input.declaredContentType ?? '').toLowerCase().split(';')[0].trim();

  let pathExtension = '';
  try {
    pathExtension = extensionOf(new URL(input.finalUrl).pathname);
  } catch {
    pathExtension = '';
  }

  // (1) The bytes, whenever they are decisive. `detectDocumentMime` returns
  // text/plain or text/csv for anything UTF-8, which is not decisive, so those
  // fall through to the claim and the path.
  const byteDecisive = input.detectedMime
    && input.detectedMime !== 'text/plain'
    && input.detectedMime !== 'text/csv';
  if (byteDecisive || input.detectionReason === 'executable_signature'
    || input.detectionReason === 'ambiguous_legacy_office_container'
    || input.detectionReason === 'unsupported_or_ambiguous_zip') {
    return classifyStockFile(`source.${pathExtension}`, input.detectedMime, input.detectionReason);
  }

  // (2) The server's claim about its own body.
  const byDeclared: Record<string, StockFileKind> = {
    'text/html': 'markup',
    'application/xhtml+xml': 'markup',
    'text/csv': 'delimited',
    'application/csv': 'delimited',
    'text/tab-separated-values': 'delimited',
    'application/json': 'structured',
    'text/json': 'structured',
    'application/xml': 'structured',
    'text/xml': 'structured',
    'application/rtf': 'richtext',
    'text/rtf': 'richtext',
  };
  const declaredKind = byDeclared[declared];
  if (declaredKind) {
    // `structured` needs to know which of the two it is; the URL's extension
    // decides, defaulting to JSON because that is what an API serves.
    const extension = declaredKind === 'structured'
      ? (declared.includes('xml') ? 'xml' : 'json')
      : (pathExtension || defaultExtensionFor(declaredKind));
    return { kind: declaredKind, extension };
  }

  // (3) The path, when it names something we read.
  if (pathExtension) {
    for (const [kind, extensions] of Object.entries(STOCK_EXTENSIONS)) {
      if (extensions.includes(pathExtension)) return { kind: kind as StockFileKind, extension: pathExtension };
    }
  }

  // Nothing claimed anything useful. A body that opens like markup is markup —
  // this is the ordinary case for a page served as `application/octet-stream`
  // or with no Content-Type at all.
  if (input.looksLikeHtml) return { kind: 'markup', extension: 'html' };

  // Text of unknown shape: the delimited reader tries a table and hands prose
  // to the model, which is the right fallback for a plain-text schedule.
  if (input.detectedMime === 'text/csv' || input.detectedMime === 'text/plain') {
    return { kind: 'delimited', extension: pathExtension || 'txt' };
  }

  return {
    kind: 'unsupported', extension: pathExtension,
    reason: 'That address did not return a stock list we can read.',
  };
}

function defaultExtensionFor(kind: StockFileKind): string {
  const first = STOCK_EXTENSIONS[kind as Exclude<StockFileKind, 'unsupported'>];
  return first ? first[0] : '';
}

/** The `accept` attribute for the upload control. Derived, never typed twice. */
export function stockFileAcceptAttribute(): string {
  return Object.values(STOCK_EXTENSIONS).flat().map((extension) => `.${extension}`).join(',');
}
