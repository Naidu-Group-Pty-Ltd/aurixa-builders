/**
 * Builder stock — finding the PROPERTY PHOTOGRAPH inside a builder's brochure.
 *
 * `extract.ts` refuses to take rasters out of a PDF, and it is right to: an
 * image XObject in an estate brochure cannot be tied to a stock row. This
 * module exists for the one case where the document itself IS the row — a
 * package PDF named for one lot and one house design, reached through that
 * row's own link.
 *
 * WHAT CHANGED, AND WHY. The first version took "the first JPEG on page one",
 * which is a statement about object order rather than about the document. A
 * brochure page holds a logo, a QR code, icons, a floorplan and a photograph,
 * and object order says nothing about which is which. This reads the page's
 * own CONTENT STREAM instead — the drawing instructions — so every candidate
 * is judged on where it is actually drawn and how big it actually appears:
 *
 *   • the photograph is the largest raster DRAWN on the page, by drawn area,
 *     not by object order, pixel count or position in the file;
 *   • it has to cover a real share of the page, so a logo, an icon, a QR code
 *     and a footer rule are excluded by measurement rather than by name;
 *   • it has to be a photographic encoding (DCT), which is what separates a
 *     render or a photograph from the line art a floorplan or a site plan is
 *     drawn as;
 *   • and it has to be on the page the document LEADS with, which is what
 *     keeps the estate masterplan on page 5 out of it.
 *
 * Anything unparseable yields NOTHING. An empty result means no image is
 * attached at all, which is a correct outcome; a wrong image is not.
 *
 * Pure: no imports, no IO, no clock. The one thing it cannot do is inflate a
 * compressed content stream — the caller does that and passes the text back in.
 */

/** A rectangle in PDF user space, y up from the bottom-left of the page. */
export interface Rect { x: number; y: number; width: number; height: number }

/** An image XObject the page's resources name. */
export interface PdfImage {
  /** The resource name the content stream draws it by (`/X13`). */
  name: string;
  objectNumber: number;
  width: number;
  height: number;
  /** Offsets of the raw stream data in the PDF bytes. */
  start: number;
  end: number;
  filters: string[];
  /** Component count implied by the colour space, when it is a plain one. */
  components: number | null;
  bitsPerComponent: number;
}

/**
 * A form XObject the page's resources name.
 *
 * A form is a content stream of its own with its own resources, and every
 * serious exporter uses one: the whole of a Canva or InDesign page arrives as
 * a single `/Fm0 Do`. A reader that looks only at the page's own resources
 * finds no images at all on such a page and concludes the brochure has no
 * pictures — which is what the live Donnybrook contract did.
 */
export interface PdfForm {
  name: string;
  objectNumber: number;
  /** The form's own content stream. The caller inflates it. */
  start: number;
  end: number;
  flate: boolean;
  /** `/Matrix`, which maps the form's space into the space that draws it. */
  matrix: Matrix;
  /** What the form's OWN resources name. Scoped: names may collide with the
   *  page's, and two forms may use `/X0` for different pictures. */
  images: PdfImage[];
  forms: PdfForm[];
}

/** Where the content stream actually drew one of them. */
export interface PdfPlacement {
  name: string;
  /** The image's rectangle on the page, in points. */
  drawn: Rect;
  /** The clip in force when it was drawn, when the page set one. */
  clip: Rect | null;
  /** Order of appearance in the content stream. */
  index: number;
  /** The full matrix in force at the `Do`, so a form can be descended into. */
  ctm: Matrix;
}

export interface PdfFirstPage {
  /** `/MediaBox`, normalised so width and height are positive. */
  width: number;
  height: number;
  images: PdfImage[];
  /** Form XObjects the page draws. Their contents are read by the caller. */
  forms: PdfForm[];
  /** Content stream slices, in order. The caller inflates what needs it. */
  contents: Array<{ start: number; end: number; flate: boolean }>;
  /** Visible widget annotations, each an appearance the page also shows. */
  widgets: PdfWidget[];
}

/**
 * A FOURTH place a page's picture can be, and the one that emptied three of
 * six sampled Luxton brochures.
 *
 * A brochure produced by filling a template carries its facade render inside a
 * form field's APPEARANCE STREAM — `/Subtype /Widget`, `/FT /Btn`, `/T (Facade
 * image)`, `/AP << /N … >>` — and the page's own `/Resources /XObject` names
 * nothing at all. Every reader here looked at the content stream and the forms
 * it draws, found no raster on the page whose fields state the lot, the
 * address and the price, and refused; the render was a 2000x1250 JPEG one
 * dictionary away, in a field the builder had named for it.
 *
 * An appearance is an ordinary form XObject, so it is READ as one and joins
 * the same descent, the same floors and the same repetition rules as anything
 * else on the page. What it needs extra is where the page PUTS it: an
 * appearance is placed by mapping its own bounding box onto the widget's
 * rectangle, which the content stream never mentions, so the rectangle travels
 * with it and `widgetBaseMatrix` performs that mapping.
 */
export interface PdfWidget {
  /** The `/AP /N` appearance, read exactly as a drawn form XObject is. */
  form: PdfForm;
  /** `/Rect`, normalised — where on the page the appearance is shown. */
  rect: Rect;
  /** The appearance's own `/BBox`, normalised. */
  bbox: Rect;
}

/** Anything that can name images and forms: a page, or a form inside one. */
export interface PdfScope { images: PdfImage[]; forms: PdfForm[] }

const decoder = new TextDecoder('latin1');

interface PdfObject { number: number; start: number; end: number; header: string }

/**
 * The one full-document scan, DONE ONCE PER DOCUMENT.
 *
 * WHY THIS IS MEMOISED, MEASURED. `indexPdfObjects` decodes the WHOLE buffer
 * to a latin1 string and walks it with a global regex — ~450 ms of pure CPU on
 * the live 13.9 MB Mandalay brochure — and it used to run again for every
 * caller: once inside `recoverCompressedObjects`, once for the page-order
 * check, and once per `readPdfPage`, of which one recovery makes up to twelve.
 * Fourteen-odd full scans put that document at ~5.9 s of parser CPU, which is
 * past what an edge worker is allowed: Lot 6706 died there on every attempt
 * (`CPU Time exceeded`, `Memory limit exceeded`), was retired operationally,
 * and sat blank while its brochure read perfectly well. The 10.6 MB brochure
 * beside it (~5.1 s) survived only sometimes, which is what a limit looks like
 * from just underneath.
 *
 * The scan depends on the BYTES ALONE — `recovered` only fills gaps in the
 * result, and that merge is a ~300-entry loop — so the scan is keyed on the
 * buffer identity in a WeakMap: one recovery passes one `bytes` object
 * through its whole pipeline, every stage after the first pays the merge and
 * nothing else, and the entry dies with the buffer. Callers with different
 * buffers (or a re-fetched document) never share an entry, and the returned
 * map is COPIED by `indexPdfObjects` before recovered objects are merged in,
 * so no caller can see another's merge.
 */
const scannedObjects = new WeakMap<Uint8Array, ReadonlyMap<number, PdfObject>>();

function scanPdfObjects(bytes: Uint8Array): ReadonlyMap<number, PdfObject> {
  const memo = scannedObjects.get(bytes);
  if (memo) return memo;

  const text = decoder.decode(bytes);
  const objects = new Map<number, PdfObject>();
  const pattern = /(?:^|[^0-9])(\d{1,7})\s+(\d{1,5})\s+obj\b/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const number = Number(match[1]);
    const start = match.index + match[0].indexOf(match[1]);
    const endIndex = text.indexOf('endobj', start);
    const end = endIndex < 0 ? text.length : endIndex;
    objects.set(number, { number, start, end, header: text.slice(start, Math.min(start + 4096, end)) });
  }

  scannedObjects.set(bytes, objects);
  return objects;
}

/**
 * Every `N 0 obj … endobj`, as offsets plus a decoded header.
 *
 * Only the first 4 KB of each object is decoded: a dictionary is small and an
 * image stream is megabytes, and decoding those to text would cost more than
 * the rest of the import put together.
 *
 * `recovered` carries the objects that are NOT written that way — the ones a
 * PDF 1.5+ writer packs into a compressed object stream. They have no offsets
 * in the file, so they contribute a header and nothing else, which is all the
 * page tree needs. They fill gaps only: an object written literally in the file
 * body is the later, authoritative copy in an incrementally updated document.
 */
export function indexPdfObjects(
  bytes: Uint8Array,
  recovered: ReadonlyMap<number, string> = new Map(),
): Map<number, PdfObject> {
  const objects = new Map(scanPdfObjects(bytes));

  for (const [number, header] of recovered) {
    if (objects.has(number)) continue;
    // No stream of its own: an object stream holds dictionaries, never image
    // data, so start === end is correct rather than a placeholder.
    objects.set(number, { number, start: 0, end: 0, header: header.slice(0, 4096) });
  }
  return objects;
}

/**
 * The compressed object streams a document carries, as slices to inflate.
 *
 * WHY THIS EXISTS, AND WHAT IT COST. A PDF 1.5 writer may pack every
 * non-stream object — including the PAGE TREE — into a `/Type /ObjStm` whose
 * contents are Flate-compressed. `indexPdfObjects` scans raw bytes for
 * `N 0 obj`, so those objects simply do not exist for it, and the live Lot 537
 * contract is exactly that document: its `/Pages` root is object 1098, which
 * lives in an object stream. The catalogue resolved to nothing, the page walk
 * produced nothing, and `pageObjectsInOrder` fell through to its last resort —
 * every `/Type /Page` sorted by OBJECT NUMBER, which is not page order.
 *
 * The consequence was not subtle. That document's cover page was added by a
 * later incremental update, so its page object is numbered 1105 while the rest
 * are 1…229: sorting by number put the property's own cover LAST of twenty,
 * beyond the twelve pages a document is searched, and shifted every other page
 * up by one — so the image drawn on visible page 3 was recorded, and shown to
 * a person, as "page 2".
 *
 * Pure, so it only locates them; the caller inflates and calls
 * `parseObjectStream`.
 */
export function objectStreamSlices(bytes: Uint8Array): Array<{
  objectNumber: number;
  /** Byte offsets of the compressed stream data. */
  start: number;
  end: number;
  flate: boolean;
  /** `/N`: how many objects it holds. `/First`: where their bodies begin. */
  count: number;
  first: number;
}> {
  const out: Array<{
    objectNumber: number; start: number; end: number;
    flate: boolean; count: number; first: number;
  }> = [];
  let objects: Map<number, PdfObject>;
  try {
    objects = indexPdfObjects(bytes);
  } catch {
    return out;
  }

  for (const object of objects.values()) {
    if (!/\/Type\s*\/ObjStm\b/.test(object.header)) continue;
    if (out.length >= MAX_OBJECT_STREAMS) break;
    const count = Number(/\/N\s+(\d+)/.exec(object.header)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(object.header)?.[1] ?? 0);
    if (!count || !first) continue;
    const slice = streamSlice(object, bytes);
    if (!slice) continue;
    out.push({ objectNumber: object.number, ...slice, count, first });
  }
  return out;
}

/** A cost guard. A stock document is not a book of object streams. */
const MAX_OBJECT_STREAMS = 64;
/** And no single stream may contribute more than this. */
const MAX_OBJECTS_PER_STREAM = 4096;

/**
 * The objects one inflated object stream holds, as `number → header`.
 *
 * The stream begins with `count` pairs of `objectNumber offset`, then the
 * bodies at `first + offset`. Anything malformed contributes nothing rather
 * than throwing: a document we cannot fully read must still be read as far as
 * it goes.
 */
export function parseObjectStream(
  text: string,
  input: { count: number; first: number },
): Map<number, string> {
  const out = new Map<number, string>();
  const count = Math.min(Math.max(0, input.count), MAX_OBJECTS_PER_STREAM);
  if (!count || input.first <= 0 || input.first > text.length) return out;

  const pairs = text.slice(0, input.first).trim().split(/\s+/).map(Number);
  if (pairs.length < count * 2) return out;

  for (let index = 0; index < count; index++) {
    const number = pairs[index * 2];
    const offset = pairs[index * 2 + 1];
    if (!Number.isFinite(number) || !Number.isFinite(offset)) continue;
    const start = input.first + offset;
    const nextOffset = index + 1 < count ? pairs[index * 2 + 3] : null;
    const end = Number.isFinite(nextOffset as number) && nextOffset !== null
      ? input.first + (nextOffset as number)
      : text.length;
    if (start < 0 || start >= text.length || end <= start) continue;
    out.set(number, text.slice(start, Math.min(end, start + 4096)));
  }
  return out;
}

function firstReference(fragment: string): number | null {
  const match = /(\d{1,7})\s+\d{1,5}\s+R/.exec(fragment);
  return match ? Number(match[1]) : null;
}

/**
 * The body of the `<< … >>` that begins at `from`, with nesting honoured.
 *
 * A lazy `<<([\s\S]*?)>>` stops at the first `>>` it meets, which in a real
 * page is the end of `/ExtGState << … >>` — so the `/XObject` entry two keys
 * later is never seen and the page appears to draw nothing. Depth counting is
 * the difference between reading a brochure and concluding it has no pictures.
 */
function balancedDictionary(text: string, from: number): string {
  const open = text.indexOf('<<', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length - 1; i++) {
    if (text[i] === '<' && text[i + 1] === '<') { depth += 1; i += 1; continue; }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 2, i);
      i += 1;
    }
  }
  return '';
}

/** Resolve `/Key 12 0 R` or an inline `<< … >>` to a dictionary's text. */
function dictionaryFor(
  header: string,
  key: string,
  objects: Map<number, PdfObject>,
): string {
  const at = new RegExp(`/${key}\\b`).exec(header);
  if (!at) return '';

  const after = header.slice(at.index + at[0].length);
  const indirect = /^\s*(\d{1,7})\s+\d{1,5}\s+R/.exec(after);
  if (indirect) {
    const target = objects.get(Number(indirect[1]))?.header ?? '';
    return balancedDictionary(target, 0);
  }
  return balancedDictionary(header, at.index);
}

/**
 * The pages, in the order the catalogue's own page tree lists them.
 *
 * Not the `/Type /Page` objects in file order: object order and page order are
 * different things, and a brochure whose pages were written out of order would
 * otherwise be read from the middle. The tree is walked depth-first, which is
 * what "page 2" means in a document that nests its pages.
 */
function pageObjectsInOrder(objects: Map<number, PdfObject>): PdfObject[] {
  let root: PdfObject | null = null;
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Catalog\b/.test(object.header)) continue;
    const pages = /\/Pages\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(object.header);
    if (pages) root = objects.get(Number(pages[1])) ?? null;
    break;
  }
  if (!root) {
    /**
     * A catalogue we could not follow. Object number is the only ordering
     * left, and it is NOT page order — see `objectStreamSlices` for what that
     * cost on the Lot 537 contract. It is kept because some order beats none
     * for a damaged file, and everything that depends on the page number being
     * the page a person sees now checks `pageOrderIsAuthoritative` first.
     */
    return [...objects.values()]
      .filter((object) => /\/Type\s*\/Page\b(?!s)/.test(object.header))
      .sort((a, b) => a.number - b.number);
  }

  const out: PdfObject[] = [];
  const seen = new Set<number>();
  const walk = (node: PdfObject, depth: number): void => {
    if (depth > 16 || out.length >= MAX_PAGES || seen.has(node.number)) return;
    seen.add(node.number);
    if (/\/Type\s*\/Page\b(?!s)/.test(node.header)) { out.push(node); return; }
    const kids = /\/Kids\s*\[([\s\S]{0,8000}?)\]/.exec(node.header);
    if (!kids) return;
    for (const entry of kids[1].matchAll(/(\d{1,7})\s+\d{1,5}\s+R/g)) {
      const child = objects.get(Number(entry[1]));
      if (child) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** A stock list is not a book; nothing beyond this is a property's cover. */
const MAX_PAGES = 200;

/** `/MediaBox [0 0 594.96 841.92]`, inherited from the page tree if absent. */
function mediaBoxOf(page: PdfObject, objects: Map<number, PdfObject>): Rect | null {
  let node: PdfObject | null = page;
  for (let depth = 0; depth < 8 && node; depth++) {
    const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(node.header);
    if (box) {
      const [x1, y1, x2, y2] = box.slice(1, 5).map(Number);
      return {
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
      };
    }
    const parent = /\/Parent\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(node.header);
    node = parent ? objects.get(Number(parent[1])) ?? null : null;
  }
  return null;
}

function streamSlice(
  object: PdfObject,
  bytes: Uint8Array,
): { start: number; end: number; flate: boolean } | null {
  const streamMatch = /stream\r?\n/.exec(object.header);
  if (!streamMatch) return null;
  const start = object.start + streamMatch.index + streamMatch[0].length;

  const window = Math.max(start, object.end - 64);
  const tail = decoder.decode(bytes.subarray(window, object.end));
  const endstream = tail.lastIndexOf('endstream');
  let end = endstream < 0 ? object.end : window + endstream;
  while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
  if (end <= start) return null;

  return { start, end, flate: /\/FlateDecode\b/.test(object.header) };
}

const COMPONENTS_BY_COLOUR_SPACE: Record<string, number> = {
  DeviceRGB: 3, DeviceGray: 1, DeviceCMYK: 4, CalRGB: 3, CalGray: 1,
};

/** The first page. The overwhelmingly common case, and its own name. */
export function readFirstPage(
  bytes: Uint8Array,
  recovered: ReadonlyMap<number, string> = new Map(),
): PdfFirstPage | null {
  return readPdfPage(bytes, 0, recovered);
}

/** How many pages the document's own page tree lists. */
export function countPdfPages(
  bytes: Uint8Array,
  recovered: ReadonlyMap<number, string> = new Map(),
): number {
  if (bytes.length < 32) return 0;
  try {
    return pageObjectsInOrder(indexPdfObjects(bytes, recovered)).length;
  } catch {
    return 0;
  }
}

/**
 * Did the document's OWN page tree decide this order?
 *
 * The difference between "page 3" meaning the third page a person sees and
 * "page 3" meaning the third-lowest object number. A provenance record that
 * shows a human-visible page number, and every rule that reads a page as a
 * property's cover, is only entitled to do so when this is true.
 */
export function pageOrderIsAuthoritative(
  bytes: Uint8Array,
  recovered: ReadonlyMap<number, string> = new Map(),
): boolean {
  if (bytes.length < 32) return false;
  try {
    const objects = indexPdfObjects(bytes, recovered);
    for (const object of objects.values()) {
      if (!/\/Type\s*\/Catalog\b/.test(object.header)) continue;
      const pages = /\/Pages\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(object.header);
      return !!(pages && objects.get(Number(pages[1])));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * One page: its size, the images its resources name, and the content streams
 * that draw them.
 *
 * `pageIndex` is zero-based over the page tree's own order. A directly
 * uploaded stock PDF can put the property's photograph on any page, so this
 * takes an index where the brochure path only ever needed the first.
 */
export function readPdfPage(
  bytes: Uint8Array,
  pageIndex: number,
  recovered: ReadonlyMap<number, string> = new Map(),
): PdfFirstPage | null {
  if (bytes.length < 32 || pageIndex < 0) return null;

  let objects: Map<number, PdfObject>;
  try {
    objects = indexPdfObjects(bytes, recovered);
  } catch {
    return null;
  }

  const page = pageObjectsInOrder(objects)[pageIndex];
  if (!page) return null;
  const box = mediaBoxOf(page, objects);
  if (!box || box.width <= 0 || box.height <= 0) return null;

  const scope = readScope(page.header, bytes, objects, 0);

  const contents: Array<{ start: number; end: number; flate: boolean }> = [];
  const contentsRef = /\/Contents\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(page.header);
  const contentsArray = /\/Contents\s*\[([\s\S]{0,2000}?)\]/.exec(page.header);
  const numbers: number[] = [];
  if (contentsRef) numbers.push(Number(contentsRef[1]));
  if (contentsArray) {
    for (const entry of contentsArray[1].matchAll(/(\d{1,7})\s+\d{1,5}\s+R/g)) {
      numbers.push(Number(entry[1]));
    }
  }
  for (const number of numbers) {
    const object = objects.get(number);
    const slice = object ? streamSlice(object, bytes) : null;
    if (slice) contents.push(slice);
  }

  return {
    width: box.width, height: box.height,
    images: scope.images, forms: scope.forms, contents,
    widgets: readWidgets(page.header, bytes, objects),
  };
}

/** How many widgets one page may contribute. A cost guard, not a rule. */
const MAX_WIDGETS_PER_PAGE = 24;

/**
 * The visible widget annotations a page carries, with their appearances read.
 *
 * TWO RULES, and both are about what a person actually sees.
 *
 * A HIDDEN WIDGET IS NOT ON THE PAGE. `/F` bit 2 is Hidden and bit 6 is
 * NoView; a template's working fields are exactly the ones set that way, and a
 * picture nobody is shown must not be able to become a property's photograph.
 *
 * AND ONLY THE NORMAL APPEARANCE. `/AP` may also carry `/D` (what the widget
 * looks like while it is being clicked) and `/R` (while the pointer is over
 * it). Neither is what the page shows at rest, and a document that gave them
 * different pictures would otherwise contribute both.
 */
function readWidgets(
  pageHeader: string,
  bytes: Uint8Array,
  objects: Map<number, PdfObject>,
): PdfWidget[] {
  const widgets: PdfWidget[] = [];
  const annots = arrayFor(pageHeader, 'Annots', objects);
  if (!annots) return widgets;

  for (const entry of annots.matchAll(/(\d{1,7})\s+\d{1,5}\s+R/g)) {
    if (widgets.length >= MAX_WIDGETS_PER_PAGE) break;
    const annotation = objects.get(Number(entry[1]));
    if (!annotation) continue;
    if (!/\/Subtype\s*\/Widget\b/.test(annotation.header)) continue;

    const flags = Number(/\/F\s+(\d{1,6})\b/.exec(annotation.header)?.[1] ?? 0);
    // bit 2 (value 2) Hidden, bit 6 (value 32) NoView.
    if ((flags & 2) !== 0 || (flags & 32) !== 0) continue;

    const rect = rectangleFrom(/\/Rect\s*\[([^\]]{0,120})\]/.exec(annotation.header)?.[1]);
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;

    const appearances = dictionaryFor(annotation.header, 'AP', objects);
    const normal = /\/N\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(appearances);
    if (!normal) continue;
    const stream = objects.get(Number(normal[1]));
    if (!stream || !/\/Subtype\s*\/Form\b/.test(stream.header)) continue;
    const slice = streamSlice(stream, bytes);
    if (!slice) continue;
    const bbox = rectangleFrom(/\/BBox\s*\[([^\]]{0,120})\]/.exec(stream.header)?.[1]);
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) continue;

    const numbers = /\/Matrix\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/
      .exec(stream.header);
    const matrix: Matrix = numbers
      ? numbers.slice(1, 7).map(Number) as Matrix
      : [...IDENTITY] as Matrix;

    const inner = readScope(stream.header, bytes, objects, 1);
    widgets.push({
      form: {
        // Named for the field so a provenance record says where it came from.
        name: /\/T\s*\(([^)]{0,64})\)/.exec(annotation.header)?.[1] ?? 'Widget',
        objectNumber: stream.number,
        start: slice.start,
        end: slice.end,
        flate: slice.flate,
        matrix: matrix.every(Number.isFinite) ? matrix : [...IDENTITY] as Matrix,
        images: inner.images,
        forms: inner.forms,
      },
      rect,
      bbox,
    });
  }
  return widgets;
}

/**
 * Resolve `/Key [ … ]` or `/Key 12 0 R` to an ARRAY's text.
 *
 * `/Annots` is an array, not a dictionary, and a writer may put it inline or
 * behind a reference — Adobe's own exporter uses the reference. Reading it
 * with `dictionaryFor` returns the empty string for the indirect form, which
 * is indistinguishable from a page carrying no annotations at all: the widgets
 * are simply never seen, which is the shape of this bug the first time it was
 * written.
 */
function arrayFor(
  header: string,
  key: string,
  objects: Map<number, PdfObject>,
): string {
  const at = new RegExp(`/${key}\\b`).exec(header);
  if (!at) return '';
  const after = header.slice(at.index + at[0].length);
  const indirect = /^\s*(\d{1,7})\s+\d{1,5}\s+R/.exec(after);
  const text = indirect ? (objects.get(Number(indirect[1]))?.header ?? '') : after;
  const open = text.indexOf('[');
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') { depth += 1; continue; }
    if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

/** `[x1 y1 x2 y2]` as a rectangle, normalised so the sides are positive. */
function rectangleFrom(literal: string | undefined): Rect | null {
  if (!literal) return null;
  const numbers = literal.trim().split(/\s+/).map(Number);
  if (numbers.length < 4 || !numbers.slice(0, 4).every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = numbers;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** How deep a form may nest before we stop looking. Layouts are not fractals. */
const MAX_FORM_DEPTH = 4;
/** A ceiling on how many forms one page may contribute, as a cost guard. */
const MAX_FORMS_PER_SCOPE = 24;

/**
 * The images and forms ONE dictionary's `/Resources` name.
 *
 * Used for a page and, recursively, for every form the page draws — a form
 * carries its own `/Resources`, and resolving those is how the pictures inside
 * an exporter's single `/Fm0` are reached at all. Names are kept SCOPED rather
 * than flattened: `/X0` inside one form and `/X0` inside another are two
 * different pictures, and merging them would attach the wrong one.
 */
function readScope(
  header: string,
  bytes: Uint8Array,
  objects: Map<number, PdfObject>,
  depth: number,
): PdfScope {
  const resources = dictionaryFor(header, 'Resources', objects);
  const xobjects = dictionaryFor(resources || header, 'XObject', objects);

  const images: PdfImage[] = [];
  const forms: PdfForm[] = [];
  const pattern = /\/([^\s/<>[\]]+)\s+(\d{1,7})\s+\d{1,5}\s+R/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xobjects)) !== null) {
    const object = objects.get(Number(match[2]));
    if (!object) continue;

    if (/\/Subtype\s*\/Form\b/.test(object.header)) {
      if (depth >= MAX_FORM_DEPTH || forms.length >= MAX_FORMS_PER_SCOPE) continue;
      const slice = streamSlice(object, bytes);
      if (!slice) continue;
      const numbers = /\/Matrix\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/
        .exec(object.header);
      const matrix: Matrix = numbers
        ? numbers.slice(1, 7).map(Number) as Matrix
        : [...IDENTITY] as Matrix;
      const inner = readScope(object.header, bytes, objects, depth + 1);
      forms.push({
        name: match[1],
        objectNumber: object.number,
        start: slice.start,
        end: slice.end,
        flate: slice.flate,
        matrix: matrix.every(Number.isFinite) ? matrix : [...IDENTITY] as Matrix,
        images: inner.images,
        forms: inner.forms,
      });
      continue;
    }

    if (!/\/Subtype\s*\/Image\b/.test(object.header)) continue;

    const width = Number(/\/Width\s+(\d+)/.exec(object.header)?.[1] ?? 0);
    const height = Number(/\/Height\s+(\d+)/.exec(object.header)?.[1] ?? 0);
    if (!width || !height) continue;

    const slice = streamSlice(object, bytes);
    if (!slice) continue;

    /**
     * How many bytes a pixel is.
     *
     * Named colour spaces say so directly; an ICC profile says so through its
     * `/N`. Getting this wrong on a crop would shear the picture into stripes,
     * so an unresolvable colour space stays null and the caller refuses rather
     * than assuming.
     */
    let colourSpace = /\/ColorSpace\s*\/(\w+)/.exec(object.header)?.[1] ?? '';
    let components: number | null = COMPONENTS_BY_COLOUR_SPACE[colourSpace] ?? null;
    if (components === null) {
      // `/ColorSpace 5 0 R` → `[ /ICCBased 10 0 R ]` → `<< /N 3 … >>`. Two
      // hops, because that is how a real exporter writes it.
      let profile = '';
      const indirect = /\/ColorSpace\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(object.header);
      if (indirect) profile = objects.get(Number(indirect[1]))?.header ?? '';
      const icc = /\/ICCBased\s+(\d{1,7})\s+\d{1,5}\s+R/.exec(profile);
      if (icc) profile = objects.get(Number(icc[1]))?.header ?? profile;

      const named = /\/(DeviceRGB|DeviceGray|DeviceCMYK|CalRGB|CalGray)\b/.exec(profile)?.[1] ?? '';
      const n = Number(/\/N\s+(\d)\b/.exec(profile)?.[1] ?? 0);
      if (n === 1 || n === 3 || n === 4) components = n;
      else if (named) { colourSpace = named; components = COMPONENTS_BY_COLOUR_SPACE[named]; }
    }

    images.push({
      name: match[1],
      objectNumber: object.number,
      width,
      height,
      start: slice.start,
      end: slice.end,
      filters: [...object.header.matchAll(/\/(DCTDecode|FlateDecode|JPXDecode|CCITTFaxDecode|LZWDecode|RunLengthDecode|ASCII85Decode)\b/g)]
        .map((entry) => entry[1]),
      components,
      bitsPerComponent: Number(/\/BitsPerComponent\s+(\d+)/.exec(object.header)?.[1] ?? 8),
    });
  }

  return { images, forms };
}

// ---------------------------------------------------------------------------
// Where the page actually draws them
// ---------------------------------------------------------------------------

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(matrix: Matrix, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

/** The unit square through a matrix, as an axis-aligned rectangle. */
function unitSquareRect(matrix: Matrix): Rect {
  const corners = [apply(matrix, 0, 0), apply(matrix, 1, 0), apply(matrix, 0, 1), apply(matrix, 1, 1)];
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Read the page's drawing instructions and report where each image landed.
 *
 * A minimal interpreter: the operand stack, `q`/`Q`, `cm`, `re … W n` for the
 * clip, and `Do`. Text, paths, shadings and colour are ignored — this is not a
 * renderer, it answers one question, which is how big each picture appears.
 *
 * `base` is the matrix already in force when this stream begins. It is the
 * identity for a page, and the composed matrix for a form drawn inside one, so
 * a picture nested three forms deep still reports the area it covers ON THE
 * PAGE rather than inside its own little coordinate system.
 */
export function parseImagePlacements(content: string, base: Matrix = IDENTITY): PdfPlacement[] {
  const placements: PdfPlacement[] = [];
  const stack: Array<{ ctm: Matrix; clip: Rect | null }> = [];
  let ctm: Matrix = base;
  let clip: Rect | null = null;
  let operands: string[] = [];
  let pendingRect: Rect | null = null;

  // Strings and inline dictionaries are skipped so a `(Do)` inside a text run
  // cannot be read as an operator.
  const tokens = content.match(/\([^)]*\)|<[^>]*>|\/[^\s/<>[\]()]+|-?[\d.]+|[A-Za-z*'"]+/g) ?? [];

  for (const token of tokens) {
    if (/^-?[\d.]+$/.test(token)) { operands.push(token); continue; }
    if (token.startsWith('/') || token.startsWith('(') || token.startsWith('<')) {
      operands.push(token);
      continue;
    }

    switch (token) {
      case 'q':
        stack.push({ ctm, clip });
        break;
      case 'Q': {
        const previous = stack.pop();
        if (previous) { ctm = previous.ctm; clip = previous.clip; }
        break;
      }
      case 'cm': {
        const numbers = operands.slice(-6).map(Number);
        if (numbers.length === 6 && numbers.every(Number.isFinite)) {
          ctm = multiply(numbers as Matrix, ctm);
        }
        break;
      }
      case 're': {
        const numbers = operands.slice(-4).map(Number);
        if (numbers.length === 4 && numbers.every(Number.isFinite)) {
          const [x, y, width, height] = numbers;
          const corner = apply(ctm, x, y);
          const opposite = apply(ctm, x + width, y + height);
          pendingRect = {
            x: Math.min(corner[0], opposite[0]),
            y: Math.min(corner[1], opposite[1]),
            width: Math.abs(opposite[0] - corner[0]),
            height: Math.abs(opposite[1] - corner[1]),
          };
        }
        break;
      }
      case 'W':
      case 'W*':
        if (pendingRect) clip = pendingRect;
        break;
      case 'Do': {
        const name = operands[operands.length - 1];
        if (name && name.startsWith('/')) {
          placements.push({
            name: name.slice(1),
            drawn: unitSquareRect(ctm),
            clip,
            index: placements.length,
            ctm,
          });
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return placements;
}

// ---------------------------------------------------------------------------
// Which of them is the property's photograph
// ---------------------------------------------------------------------------

/** Photographic encodings. A plan, a logo and a QR code are not drawn as JPEG. */
const PHOTOGRAPHIC_FILTERS = new Set(['DCTDecode', 'JPXDecode']);
/**
 * And the LOSSLESS one, which carries photographs too.
 *
 * A LOSSY ENCODING IS EVIDENCE, NOT A REQUIREMENT. "Is it a DCT raster" was the
 * whole test, and it is a good proxy — an exporter reaches for JPEG when the
 * content is continuous-tone — but it is only a proxy, and Lot 60434
 * Cloverton's package is where it costs a card: the document holds a 3508x4961
 * JPEG of the FLOOR PLAN and a 2400x1400 Flate raster of the HOUSE. The rule
 * admitted the plan and refused the photograph, which is the wrong way round in
 * both directions at once.
 *
 * The detail floor below is what actually separates a photograph from a wash,
 * and it works just as well on a lossless stream — better, because a lossless
 * encoder cannot spend bytes on noise it was told to discard. It has to be a
 * DIFFERENT NUMBER, though: the two encodings are not measured in comparable
 * units, and reusing the lossy floor would admit every diagram in every
 * document.
 */
const LOSSLESS_FILTERS = new Set(['FlateDecode', 'LZWDecode']);

/** A picture smaller than this on the page is a logo, an icon or a rule. */
const MIN_PAGE_AREA_SHARE = 0.06;
/**
 * Below this it is not a photograph of a house whatever else it is.
 *
 * 360x270, DOWN FROM 600x400, AND THE DIFFERENCE IS A REAL FACADE. Measured,
 * 6 September 2026, on the Luxton Thornhill Gardens brochures uploaded as a
 * stock list: the designated cover page draws the property's facade render
 * from a 480x339 JPEG at 17% of the page — nearly three times the share
 * floor, with photographic detail (0.206 bytes/pixel) — and the pixel floor
 * refused it, so the whole document answered "no image" about a page whose
 * photograph a person sees instantly. The card that render draws at 480px is
 * sharper than the card is large.
 *
 * WHAT THE OLD NUMBER WAS CARRYING, AND WHAT CARRIES IT NOW. Everything else
 * on that same page is refused by the floors that actually describe it: four
 * icons at 47px and under die on the 6% share floor (0.000), the 3423x1588
 * logo lockup dies on the same floor (0.028) and on lossy detail (0.031),
 * and the floor plan that now clears the pixel floor is excluded at the
 * election by its own pixels (`mayLeadCard`), which did not exist when
 * 600x400 was priced. A pixel floor only has to refuse what could never
 * draw a card, and 360x270 (0.097 MP) still does.
 *
 * TWO FLOORS, BECAUSE ONLY ONE PATH READS THE PIXELS. This floor serves
 * `qualifyingPhotographsFrom`, whose candidates are classified before the
 * election (`documentVisualKinds` → `mayLeadCard`), so a floor plan that now
 * clears it is refused downstream by what it IS.
 * `selectPropertyPhotographFrom` is the legacy largest-by-drawn-area answer
 * with no vision behind it — on the Lot 537 cover its only defence against
 * the 369x811 floor plan WAS the pixel floor — so it keeps the old number
 * below. Lowering both together is how a plan would have re-entered through
 * the one door with no gate.
 */
const MIN_PIXELS = { width: 360, height: 270 };
/** For the ungated legacy selection alone. See the paragraph above. */
const MIN_PIXELS_UNGATED = { width: 600, height: 400 };
/** A banner or a spine, not a photograph. */
const MIN_ASPECT = 0.3;
const MAX_ASPECT = 4;
/**
 * Encoded bytes per pixel, below which the picture carries no detail.
 *
 * A DESIGNER'S BACKGROUND IS NOT A PHOTOGRAPH, and it is bigger than one. The
 * live Donnybrook contract's cover draws a grey faceted wash across the whole
 * bleed — 1300×698, larger on the page than anything else — and every rule
 * above admits it: it is a DCT raster of ample size and ordinary shape. What
 * separates it from a render is that it is nearly empty, and a lossy encoder
 * says so in the only unit available without decoding the image: 10 KB for
 * 907,000 pixels, which is 0.011 bytes each.
 *
 * Measured, not guessed. Across the builder documents this was fitted to:
 * decorative washes and repeated banner strips sit at 0.011–0.013, and every
 * verified property render sits at 0.034 or above — the Donnybrook interiors
 * at 0.034–0.043, the Stradbroke package's facade at 0.32. The floor is set
 * between the two, and it fails towards no image rather than towards a grey
 * rectangle on a client's card.
 */
const MIN_ENCODED_DETAIL = 0.02;

/**
 * The same floor for a LOSSLESS stream, and it is nowhere near the same number.
 *
 * Measured the same way — the production images, decoded and re-compressed
 * losslessly, in bytes per pixel:
 *
 *   solid brand plate                       0.003
 *   gradient wash                           0.003
 *   line art at plan density                0.011
 *   Lot 60434's floor plan, the real one    0.042
 *   ------------------------------------ floor 0.5
 *   Lot 60434's facade, the real one        1.675
 *   Lot 36 Miami 190 cover facade           2.156
 *   Lot 36 Echo 236 cover facade            2.048
 *   the four other Sandpiper renders   1.423-1.887
 *
 * Every photograph in the set is above 1.4 and everything that is not one is
 * below 0.05 — a separation of more than thirty times, with the floor an order
 * of magnitude clear of the highest non-photograph and three times below the
 * least detailed photograph. It fails towards no image, exactly as the lossy
 * floor does.
 */
const MIN_LOSSLESS_DETAIL = 0.5;

/**
 * How much detail this picture's encoding has to show before it can be a
 * photograph — or null when the encoding is one no photograph is written in.
 */
function detailFloorFor(filters: string[]): number | null {
  if (filters.some((filter) => PHOTOGRAPHIC_FILTERS.has(filter))) return MIN_ENCODED_DETAIL;
  if (filters.some((filter) => LOSSLESS_FILTERS.has(filter))) return MIN_LOSSLESS_DETAIL;
  return null;
}

export interface PhotographChoice {
  image: PdfImage;
  placement: PdfPlacement;
  /** Share of the page the picture covers, for the provenance record. */
  pageAreaShare: number;
}

/**
 * A candidate, and how many times the page drew it.
 *
 * `placements` is the discriminator the layout itself provides: a property's
 * hero is placed once, and a background wash, a banner strip or a letterhead
 * rule is placed repeatedly. On the live Lot 537 cover the grey faceted wash is
 * drawn three times and passes every floor here — it is a 1950×1050 DCT raster
 * covering 47% of the page, LARGER than the facade beside it.
 */
export interface PhotographCandidate extends PhotographChoice {
  placements: number;
}

/** One picture, and where on the page it was actually drawn. */
export interface DrawnImage { image: PdfImage; placement: PdfPlacement }

/**
 * Match a scope's placements to the images that scope names.
 *
 * Scoped deliberately: a name means whatever the resources that drew it say it
 * means, so this is never called across two scopes at once.
 */
export function resolveDrawnImages(scope: PdfScope, placements: PdfPlacement[]): DrawnImage[] {
  const byName = new Map(scope.images.map((image) => [image.name, image]));
  const out: DrawnImage[] = [];
  for (const placement of placements) {
    const image = byName.get(placement.name);
    if (image) out.push({ image, placement });
  }
  return out;
}

/**
 * The matrix a form's own content stream begins under.
 *
 * The form's `/Matrix` first, then whatever was in force where it was drawn —
 * which is what puts a picture nested inside it back on the page.
 */
export function formBaseMatrix(form: PdfForm, placement: PdfPlacement): Matrix {
  return multiply(form.matrix, placement.ctm);
}

/**
 * Where on the page a widget's appearance is actually drawn.
 *
 * PDF 32000-1 12.5.5, and it is not optional arithmetic: an appearance stream
 * is authored in its own coordinates and the viewer FITS it to the widget's
 * rectangle. Skipping this and using the identity would report a 2000x1250
 * facade as covering whatever the appearance's own bounding box happened to
 * say, which the page-area floor then accepts or rejects for a reason
 * unrelated to what the page shows.
 *
 * The transformed bounding box maps onto the rectangle; a degenerate box
 * (zero-width after the matrix, which a malformed appearance can produce)
 * falls back to the rectangle's own placement rather than dividing by zero.
 */
export function widgetBaseMatrix(widget: PdfWidget): Matrix {
  const { form, rect, bbox } = widget;
  const corners: Array<[number, number]> = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x, bbox.y + bbox.height],
    [bbox.x + bbox.width, bbox.y + bbox.height],
  ];
  const [a, b, c, d, e, f] = form.matrix;
  const xs = corners.map(([x, y]) => a * x + c * y + e);
  const ys = corners.map(([x, y]) => b * x + d * y + f);
  const left = Math.min(...xs);
  const bottom = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - bottom;
  if (!(width > 0) || !(height > 0)) {
    return multiply(form.matrix, [1, 0, 0, 1, rect.x, rect.y]);
  }
  const sx = rect.width / width;
  const sy = rect.height / height;
  const fit: Matrix = [sx, 0, 0, sy, rect.x - left * sx, rect.y - bottom * sy];
  return multiply(form.matrix, fit);
}

/** The forms a scope's placements actually drew, with their base matrices. */
export function resolveDrawnForms(
  scope: PdfScope,
  placements: PdfPlacement[],
): Array<{ form: PdfForm; base: Matrix }> {
  const byName = new Map(scope.forms.map((form) => [form.name, form]));
  const out: Array<{ form: PdfForm; base: Matrix }> = [];
  for (const placement of placements) {
    const form = byName.get(placement.name);
    if (form) out.push({ form, base: formBaseMatrix(form, placement) });
  }
  return out;
}

/**
 * The page's principal photograph, or nothing.
 *
 * Largest DRAWN area wins, which is what "the picture this page leads with"
 * means in a layout. Everything else is a floor: too small on the page, too
 * few pixels, too extreme a shape, or not a photographic encoding at all.
 */
export function selectPropertyPhotograph(
  page: PdfFirstPage,
  placements: PdfPlacement[],
): PhotographChoice | null {
  return selectPropertyPhotographFrom(
    resolveDrawnImages(page, placements), page.width, page.height);
}

/**
 * A raster that IS the page is not a picture ON the page.
 *
 * A brochure exported as page images draws one raster over the whole sheet —
 * the facade, the type and the price panel in one bitmap — and serving that as
 * a property photograph puts a page of marketing on a client's card. That is
 * what `pdfFlattenedPhoto.pure.ts` exists to prevent, by cutting the photograph
 * out of the builder's own pixels instead.
 *
 * It only ever worked because such a page is drawn losslessly and the
 * candidate rules admitted lossy encodings alone, so a flattened page could
 * never be mistaken for a placed picture. Admitting lossless rasters — which
 * carry real photographs, and is why they are admitted — removes that accident,
 * so the exclusion has to be stated: Covella's three brochure pages and
 * Cloverton's own package both came out as whole pages the moment it was not.
 */
function withoutTheFlattenedPage(
  drawn: DrawnImage[],
  pageWidth: number,
  pageHeight: number,
): DrawnImage[] {
  const page = flattenedPageImageFrom(drawn, pageWidth, pageHeight);
  if (!page) return drawn;
  return drawn.filter((entry) => entry.image !== page.image);
}

/**
 * Every picture on the page that COULD be a photograph, with how often the
 * page draws it.
 *
 * THIS IS DISCOVERY, NOT SELECTION, and the distinction is the whole point.
 * The floors below reject: a logo is too small, a QR code is not a DCT raster,
 * a 300-pixel thumbnail is not a render. None of them can say which surviving
 * picture is the PROPERTY's — "largest JPEG" is a fact about a file, and a
 * bedroom render is a large, detailed, perfectly proportioned JPEG. What the
 * image is FOR is decided from the source's own semantics, in
 * `pdfPrimaryImage.pure.ts`, out of the candidates this returns.
 *
 * Repeated placements of one picture collapse into a single candidate carrying
 * its `placements` count, because a page that draws the same raster three times
 * is drawing furniture — a bleed wash, a banner, a rule — and the count is the
 * document saying so.
 */
export function qualifyingPhotographsFrom(
  drawn: DrawnImage[],
  pageWidth: number,
  pageHeight: number,
): PhotographCandidate[] {
  const pageArea = pageWidth * pageHeight;
  if (pageArea <= 0) return [];

  const byObject = new Map<string, PhotographCandidate>();
  for (const { image, placement } of withoutTheFlattenedPage(drawn, pageWidth, pageHeight)) {
    const floor = detailFloorFor(image.filters);
    if (floor === null) continue;
    if (image.width < MIN_PIXELS.width || image.height < MIN_PIXELS.height) continue;

    const aspect = image.width / image.height;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;

    // Detail, in the only unit available without decoding it. See the header.
    const detail = (image.end - image.start) / (image.width * image.height);
    if (detail < floor) continue;

    const share = (placement.drawn.width * placement.drawn.height) / pageArea;
    if (share < MIN_PAGE_AREA_SHARE) continue;

    const key = `${image.objectNumber}:${image.name}`;
    const existing = byObject.get(key);
    if (!existing) {
      byObject.set(key, { image, placement, pageAreaShare: share, placements: 1 });
      continue;
    }
    existing.placements += 1;
    if (share > existing.pageAreaShare) {
      existing.placement = placement;
      existing.pageAreaShare = share;
    }
  }
  return [...byObject.values()];
}

/**
 * The same judgement over pictures gathered from the page AND from every form
 * it draws, which is where a real exporter puts them.
 *
 * LARGEST-BY-DRAWN-AREA, AND THAT IS NOT AUTHORITY OVER THE PRIMARY IMAGE.
 * Kept for the one thing it is entitled to answer — "does this page present a
 * photograph at all", which the flattened-page fallback needs — and used by
 * nothing that decides what a client sees on a card.
 */
export function selectPropertyPhotographFrom(
  drawn: DrawnImage[],
  pageWidth: number,
  pageHeight: number,
): PhotographChoice | null {
  const pageArea = pageWidth * pageHeight;
  if (pageArea <= 0) return null;

  let best: PhotographChoice | null = null;
  for (const { image, placement } of withoutTheFlattenedPage(drawn, pageWidth, pageHeight)) {
    const floor = detailFloorFor(image.filters);
    if (floor === null) continue;
    if (image.width < MIN_PIXELS_UNGATED.width || image.height < MIN_PIXELS_UNGATED.height) continue;

    const aspect = image.width / image.height;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;

    // Detail, in the only unit available without decoding it. See the header.
    const detail = (image.end - image.start) / (image.width * image.height);
    if (detail < floor) continue;

    const drawnArea = placement.drawn.width * placement.drawn.height;
    const share = drawnArea / pageArea;
    if (share < MIN_PAGE_AREA_SHARE) continue;

    if (!best || share > best.pageAreaShare) {
      best = { image, placement, pageAreaShare: share };
    }
  }
  return best;
}

/**
 * Is this page a single flattened raster rather than a composed layout?
 *
 * A brochure exported as page images draws one picture over the whole page and
 * nothing else that matters. Recognising that is what allows the photograph to
 * be looked for INSIDE the pixels — see `pdfFlattenedPhoto.pure.ts` — rather
 * than the whole page being served as if it were a photograph of a house.
 */
export function flattenedPageImage(
  page: PdfFirstPage,
  placements: PdfPlacement[],
): DrawnImage | null {
  return flattenedPageImageFrom(
    resolveDrawnImages(page, placements), page.width, page.height);
}

/** The same test over pictures gathered from the page and its forms. */
export function flattenedPageImageFrom(
  drawn: DrawnImage[],
  pageWidth: number,
  pageHeight: number,
): DrawnImage | null {
  const pageArea = pageWidth * pageHeight;
  if (pageArea <= 0) return null;

  const covering = drawn.filter((entry) =>
    (entry.placement.drawn.width * entry.placement.drawn.height) / pageArea >= 0.9);

  if (covering.length !== 1) return null;
  const only = covering[0];
  // Raw pixels only: a flattened page we cannot decode without a JPEG decoder
  // is one we will not be cropping.
  if (only.image.filters.some((filter) => filter !== 'FlateDecode')) return null;
  if (only.image.bitsPerComponent !== 8) return null;
  return only;
}
