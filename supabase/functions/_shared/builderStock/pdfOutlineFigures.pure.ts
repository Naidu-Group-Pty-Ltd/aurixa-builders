/**
 * ===========================================================================
 * BUILDER STOCK — TEXT A PAGE DRAWS AS SHAPES, AND WHEN IT IS READ.
 * ===========================================================================
 *
 * MEASURED 24 SEPTEMBER 2026 on `LOT 326 - NEX 20 - BROCHURE.pdf` and the same
 * template's `LOT 324 - NEX 20 - V002.pdf`. The house's size is printed in
 * exactly one place, an area schedule on the page that prices the property:
 *
 *     AREA SCHEDULE
 *     LIVING:   151.22m²   16.28sq
 *     GARAGE:    23.93m²    2.58sq
 *     PORCH:      3.08m²    0.33sq
 *     TOTAL:    178.23m²   19.19sq
 *
 * and neither reader could see it. The heading is a PICTURE (a 690 x 440
 * raster that recognition reads as `AREA SCHEDULE` and nothing else), and the
 * four rows are not in the picture and not in the text layer: the exporter
 * converted them to CURVES — each word a filled path, one sub-path per glyph —
 * and drew them over the picture's frame. A text layer cannot contain them, a
 * picture's pixels do not contain them, and the page shows them to anyone who
 * opens it. The card read `HOME —`.
 *
 * WHAT IS A CANDIDATE (`outlineRegionsFrom`). Filled paths whose size is the
 * size of type (a glyph is not a rule, a box or a photograph's frame), set in
 * rows that share a baseline band, stacked into a block of at least two rows
 * the way a table's rows are. It is a statement about SHAPE only, exactly as
 * `pdfFigures.pure.ts` says of a picture: whether the block states anything is
 * decided by reading it, and whether that is believed by the schedule's own
 * arithmetic (`areaSchedulePicture.pure.ts`, which is the SAME reader and the
 * same proofs a picture answers to — parts that add to the total, or squares
 * that restate it).
 *
 * WHEN THEY ARE ASKED (`outlinesToRead`): exactly when a picture would be —
 * one property, no building size stated and none disputed, on a page that
 * prices the property — and never more than `MAX_OUTLINES_READ`.
 *
 * WHAT TRAVELS. The paths themselves, flattened to polygons and quantised to a
 * tenth of a point, relative to the block. The isolate that parsed the PDF
 * decodes nothing and recognises nothing; the isolate that recognises (the
 * picture successor) never opens the PDF — it draws the polygons it was
 * handed (`rasteriseOutlines`, below) and recognises the drawing. A glyph is
 * geometry, so drawing it is arithmetic, not decoding: no engine, no asset and
 * no second parser. Every bound below is a refusal, never a truncation that
 * reads part of something.
 *
 * WHAT IT NEVER DOES: read a figure that is not proved, speak over the text, or
 * draw anything the page did not paint. Strokes, clips and fills of the size
 * of a box are not drawn, because a filled rectangle behind white type would
 * turn the whole block black; what is drawn is ink the size of letters, in
 * black on white, whatever colour the page painted it.
 *
 * Pure: no IO, no clock.
 */
import type { Matrix, Rect } from './pdfPageImages.pure.ts';

// ---------------------------------------------------------------------------
// Bounds. Each is a refusal: past it, nothing is read from that page or block.
// ---------------------------------------------------------------------------

/** Only the pages a property is priced on in every measured brochure. */
export const MAX_OUTLINE_PAGES = 3;
/** Tokens interpreted per content stream before a page is judged a drawing. */
const MAX_TOKENS = 400_000;
/** Painted paths considered per page. A site plan paints thousands. */
const MAX_PAINTED_PATHS = 6_000;
/** Polygon points collected per page. */
const MAX_POINTS_PER_PAGE = 250_000;
/** Blocks handed on per document, and read. */
export const MAX_OUTLINES_READ = 2;
/** Points a block may carry across the hand-off (about 100 KB of JSON). */
const MAX_POINTS_PER_BLOCK = 12_000;
/**
 * Recognitions one figure crossing makes, pictures and blocks together. The
 * crossing is priced like every figure read (`importResumeBudget.pure.ts`):
 * the engine once, 700 ms, and 500 ms a recognition — four of them is
 * 2,700 ms, inside the 3,000 ms ceiling, and a fifth is not.
 */
export const MAX_FIGURE_RECOGNITIONS = 4;
/** `q` nesting a content stream may reach before its state is not trusted. */
const MAX_STATE_DEPTH = 64;

/** Type, not a rule, a box or a picture: the height a line of text can have. */
const MIN_GLYPH_HEIGHT = 1.5;
const MAX_GLYPH_HEIGHT = 40;
/** A filled rectangle longer than this is a rule; wider than this, a box. */
const MAX_RULE_LENGTH = 12;
const MAX_STROKE_WIDTH = 4;
/** A block is at least two rows, as a table is. */
const MIN_BLOCK_ROWS = 2;
const MIN_BLOCK_PATHS = 4;
/** Flattening tolerance for a curve, in points. */
const CURVE_STEP = 0.6;
const MAX_CURVE_STEPS = 24;

/** One painted path: its fill rule and its closed rings, in page points. */
export interface FilledPath {
  evenOdd: boolean;
  /** Each ring a flat `[x0, y0, x1, y1, …]`, page user space, y up. */
  rings: number[][];
  box: Rect;
  /** Every ring is an axis-aligned rectangle. */
  rectangular: boolean;
}

/** What a content stream painted, and the forms it drew. */
export interface OutlineScan {
  paths: FilledPath[];
  /** `Do` operations, for descending into forms: the name and the matrix. */
  forms: Array<{ name: string; ctm: Matrix }>;
  /** A bound was reached; nothing from this stream should be trusted. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// The content stream, read as drawing instructions
// ---------------------------------------------------------------------------

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` then `b`, as a content stream composes `cm` onto the matrix in force. */
export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelimiter = (c: number) =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93
  || c === 123 || c === 125 || c === 47 || c === 37;

/** A name operand (`/Fm0`); the one kind of operand besides a number read here. */
interface NameToken { name: string }

/**
 * The tokens of a content stream, with strings, dictionaries and inline image
 * data stepped over rather than read — a `(m)` in a text run, or the bytes of
 * an inline picture, must never be taken for a drawing instruction. Numbers
 * come back as numbers, names as names (only `Do` reads one), every other
 * operand as `null`, and an operator as its string.
 */
function* contentTokens(content: string): Generator<number | string | NameToken | null> {
  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 37) { // % comment, to the end of the line
      while (i < n && content.charCodeAt(i) !== 10 && content.charCodeAt(i) !== 13) i++;
      continue;
    }
    if (c === 40) { // ( literal string ), balanced, with escapes
      let depth = 0;
      for (; i < n; i++) {
        const d = content.charCodeAt(i);
        if (d === 92) { i++; continue; }
        if (d === 40) depth++;
        else if (d === 41 && --depth === 0) { i++; break; }
      }
      yield null;
      continue;
    }
    if (c === 60) { // << or <hex>
      if (content.charCodeAt(i + 1) === 60) { i += 2; continue; }
      const close = content.indexOf('>', i + 1);
      i = close < 0 ? n : close + 1;
      yield null;
      continue;
    }
    if (c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 41) { i++; continue; }
    if (c === 47) { // /Name
      const from = ++i;
      while (i < n && !isSpace(content.charCodeAt(i)) && !isDelimiter(content.charCodeAt(i))) i++;
      yield { name: content.slice(from, i) };
      continue;
    }
    const start = i;
    while (i < n && !isSpace(content.charCodeAt(i)) && !isDelimiter(content.charCodeAt(i))) i++;
    const word = content.slice(start, i);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) { yield Number(word); continue; }
    if (word === 'ID') {
      // Inline image data runs to `EI` on a token boundary; none of it is read.
      const end = content.slice(i).search(/\sEI(?=\s|$)/);
      i = end < 0 ? n : i + end + 3;
      continue;
    }
    yield word;
  }
}

/** A cubic from p0 to p3, flattened into the ring as points after p0. */
function flattenCubic(
  ring: number[],
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
): void {
  const span = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1)
    + Math.hypot(x3 - x2, y3 - y2);
  const steps = Math.max(2, Math.min(MAX_CURVE_STEPS, Math.ceil(span / CURVE_STEP)));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    ring.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
  }
}

function boxOf(rings: number[][]): Rect {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k += 2) {
      if (ring[k] < minX) minX = ring[k];
      if (ring[k] > maxX) maxX = ring[k];
      if (ring[k + 1] < minY) minY = ring[k + 1];
      if (ring[k + 1] > maxY) maxY = ring[k + 1];
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Is this ring an axis-aligned rectangle (four corners, closed or not)? */
function ringIsRectangle(ring: number[]): boolean {
  const points = ring.length / 2;
  const closed = points === 5 && ring[0] === ring[8] && ring[1] === ring[9];
  if (points !== 4 && !closed) return false;
  for (let k = 0; k < 4; k++) {
    const x0 = ring[k * 2]; const y0 = ring[k * 2 + 1];
    const x1 = ring[((k + 1) % 4) * 2]; const y1 = ring[((k + 1) % 4) * 2 + 1];
    if (Math.abs(x0 - x1) > 1e-6 && Math.abs(y0 - y1) > 1e-6) return false;
  }
  return true;
}

/**
 * Read a content stream's FILLED paths, in page space, and the forms it
 * draws. A minimal interpreter: `q`/`Q`, `cm`, the path construction
 * operators and the painting ones, and `Do`. Text, colour, clipping, strokes
 * and shadings are not drawing ink this cares about and are ignored — this is
 * not a renderer, it answers one question, which is what shapes were FILLED
 * and where.
 */
export function scanFilledPaths(content: string, base: Matrix = IDENTITY): OutlineScan {
  const paths: FilledPath[] = [];
  const forms: Array<{ name: string; ctm: Matrix }> = [];
  const stack: Matrix[] = [];
  let ctm = base;
  let operands: number[] = [];
  let lastName: string | null = null;
  let rings: number[][] = [];
  let ring: number[] | null = null;
  // The current point and the sub-path's start, in page space.
  let cx = 0; let cy = 0; let sx = 0; let sy = 0;
  let points = 0;
  let tokens = 0;
  let truncated = false;

  const at = (x: number, y: number): [number, number] => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
  const endRing = () => {
    if (ring && ring.length >= 6) rings.push(ring);
    ring = null;
  };
  const clearPath = () => { ring = null; rings = []; };

  for (const token of contentTokens(content)) {
    if (++tokens > MAX_TOKENS) { truncated = true; break; }
    if (typeof token === 'number') { operands.push(token); continue; }
    if (token === null) { operands.push(Number.NaN); continue; }
    if (typeof token === 'object') {
      operands.push(Number.NaN);
      lastName = token.name;
      continue;
    }
    const take = (count: number): number[] | null => {
      if (operands.length < count) return null;
      const slice = operands.slice(-count);
      return slice.every(Number.isFinite) ? slice : null;
    };
    switch (token) {
      case 'q':
        if (stack.length >= MAX_STATE_DEPTH) { truncated = true; break; }
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? ctm;
        break;
      case 'cm': {
        const m = take(6);
        if (m) ctm = multiplyMatrix(m as Matrix, ctm);
        break;
      }
      case 'm': {
        const p = take(2);
        if (!p) break;
        endRing();
        [cx, cy] = at(p[0], p[1]);
        sx = cx; sy = cy;
        ring = [cx, cy];
        points++;
        break;
      }
      case 'l': {
        const p = take(2);
        if (!p || !ring) break;
        [cx, cy] = at(p[0], p[1]);
        ring.push(cx, cy);
        points++;
        break;
      }
      case 'c':
      case 'v':
      case 'y': {
        const p = take(token === 'c' ? 6 : 4);
        if (!p || !ring) break;
        let c1: [number, number];
        let c2: [number, number];
        let end: [number, number];
        if (token === 'c') {
          c1 = at(p[0], p[1]); c2 = at(p[2], p[3]); end = at(p[4], p[5]);
        } else if (token === 'v') {
          c1 = [cx, cy]; c2 = at(p[0], p[1]); end = at(p[2], p[3]);
        } else {
          c1 = at(p[0], p[1]); end = at(p[2], p[3]); c2 = end;
        }
        const before = ring.length;
        flattenCubic(ring, cx, cy, c1[0], c1[1], c2[0], c2[1], end[0], end[1]);
        points += (ring.length - before) / 2;
        [cx, cy] = end;
        break;
      }
      case 'h':
        if (ring) { cx = sx; cy = sy; endRing(); }
        break;
      case 're': {
        const p = take(4);
        if (!p) break;
        endRing();
        const [x, y, w, h] = p;
        const corners = [at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)];
        rings.push(corners.flat());
        points += 4;
        [cx, cy] = corners[0];
        sx = cx; sy = cy;
        break;
      }
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*': {
        endRing();
        if (rings.length && paths.length < MAX_PAINTED_PATHS) {
          paths.push({
            evenOdd: token.endsWith('*'),
            rings,
            box: boxOf(rings),
            rectangular: rings.every(ringIsRectangle),
          });
        } else if (rings.length) {
          truncated = true;
        }
        clearPath();
        break;
      }
      case 'S':
      case 's':
      case 'n':
        clearPath();
        break;
      case 'Do':
        if (lastName && forms.length < 256) forms.push({ name: lastName, ctm });
        break;
      default:
        break;
    }
    operands = [];
    lastName = null;
    if (points > MAX_POINTS_PER_PAGE) { truncated = true; break; }
  }
  return { paths, forms, truncated };
}

// ---------------------------------------------------------------------------
// Which painted shapes are type, and which of them form a block of rows
// ---------------------------------------------------------------------------

/** Is this painted shape the size and kind of a letter? */
export function isGlyphLike(path: FilledPath): boolean {
  const { width, height } = path.box;
  if (!(height >= 0.2) || !(width >= 0.2)) return false;
  if (path.rectangular) {
    // A letter's bar or a full stop, never a rule and never a box.
    return Math.max(width, height) <= MAX_RULE_LENGTH && Math.min(width, height) <= MAX_STROKE_WIDTH;
  }
  return height >= MIN_GLYPH_HEIGHT && height <= MAX_GLYPH_HEIGHT && width <= MAX_GLYPH_HEIGHT * 12;
}

interface Row { paths: FilledPath[]; box: Rect; height: number }

const bottomOf = (r: Rect) => r.y;
const topOf = (r: Rect) => r.y + r.height;
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

/** A block of type rows: where it is, what is in it, and how tall its rows are. */
export interface OutlineRegion {
  box: Rect;
  paths: FilledPath[];
  rows: number;
  rowHeight: number;
}

/**
 * The blocks of type a page paints as shapes, in reading order. See the
 * header: shape only, and nothing here decides a block says anything.
 */
/** A page painting more letter-sized shapes than this is a page of outlined prose or a drawing. */
const MAX_GLYPH_SHAPES = 3_000;

export function outlineRegionsFrom(paths: readonly FilledPath[]): OutlineRegion[] {
  const glyphs = paths.filter(isGlyphLike);
  if (glyphs.length > MAX_GLYPH_SHAPES) return [];
  // Rows are made from the shapes the height of type; a full stop or a bar
  // joins whatever row it sits in once the rows exist.
  const tall = glyphs.filter((path) => path.box.height >= MIN_GLYPH_HEIGHT)
    .slice()
    .sort((a, b) => (topOf(b.box) - topOf(a.box)) || (a.box.x - b.box.x));

  const rows: Row[] = [];
  for (const path of tall) {
    const centre = path.box.y + path.box.height / 2;
    const row = rows.find((candidate) => {
      const middle = candidate.box.y + candidate.box.height / 2;
      const band = Math.max(candidate.height, path.box.height) * 0.5;
      const ratio = Math.max(candidate.height, path.box.height)
        / Math.max(0.1, Math.min(candidate.height, path.box.height));
      return Math.abs(middle - centre) <= band && ratio <= 3;
    });
    if (row) {
      row.paths.push(path);
      row.box = union(row.box, path.box);
      row.height = Math.max(row.height, path.box.height);
    } else {
      rows.push({ paths: [path], box: { ...path.box }, height: path.box.height });
    }
  }

  // A row is one line of type only while its shapes are near each other.
  const lines: Row[] = [];
  for (const row of rows) {
    const ordered = row.paths.slice().sort((a, b) => a.box.x - b.box.x);
    let current: Row | null = null;
    for (const path of ordered) {
      const gap = current ? path.box.x - (current.box.x + current.box.width) : 0;
      if (!current || gap > row.height * 4) {
        current = { paths: [path], box: { ...path.box }, height: path.box.height };
        lines.push(current);
      } else {
        current.paths.push(path);
        current.box = union(current.box, path.box);
        current.height = Math.max(current.height, path.box.height);
      }
    }
  }
  lines.sort((a, b) => (topOf(b.box) - topOf(a.box)) || (a.box.x - b.box.x));

  // Lines stacked one under the next, overlapping in x, are one block.
  const blocks: Array<{ lines: Row[]; box: Rect }> = [];
  for (const line of lines) {
    const block = blocks.find((candidate) => {
      const last = candidate.lines[candidate.lines.length - 1];
      const gap = bottomOf(last.box) - topOf(line.box);
      const height = Math.max(last.height, line.height);
      const overlaps = line.box.x <= candidate.box.x + candidate.box.width + height
        && line.box.x + line.box.width >= candidate.box.x - height;
      return gap >= -height * 0.5 && gap <= height * 1.5 && overlaps;
    });
    if (block) {
      block.lines.push(line);
      block.box = union(block.box, line.box);
    } else {
      blocks.push({ lines: [line], box: { ...line.box } });
    }
  }

  const regions: OutlineRegion[] = [];
  for (const block of blocks) {
    if (block.lines.length < MIN_BLOCK_ROWS) continue;
    const rowHeight = Math.max(...block.lines.map((line) => line.height));
    const pad = rowHeight * 0.3;
    const box: Rect = {
      x: block.box.x - pad, y: block.box.y - pad,
      width: block.box.width + pad * 2, height: block.box.height + pad * 2,
    };
    // Every letter-sized shape inside the block, the full stops included.
    const inside = glyphs.filter((path) =>
      path.box.x >= box.x && path.box.y >= box.y
      && path.box.x + path.box.width <= box.x + box.width
      && path.box.y + path.box.height <= box.y + box.height);
    if (inside.length < MIN_BLOCK_PATHS) continue;
    regions.push({ box, paths: inside, rows: block.lines.length, rowHeight });
  }
  return regions.sort((a, b) => (topOf(b.box) - topOf(a.box)) || (a.box.x - b.box.x));
}

// ---------------------------------------------------------------------------
// What travels across the hand-off
// ---------------------------------------------------------------------------

/** A block of type drawn as shapes, as the hand-off carries it. */
export interface PdfOutlineFigure {
  kind: 'outlines';
  /** 1-based, the page a person counts. */
  page: number;
  /** Where the page paints the block, in points, page user space. */
  drawn: Rect;
  /** The height of the block's tallest row, in points. */
  rowHeight: number;
  /**
   * Each painted shape: its fill rule and its rings, every ring a flat list of
   * integer TENTHS OF A POINT measured from the block's lower-left corner.
   */
  paths: Array<{ evenOdd: boolean; rings: number[][] }>;
}

const tenths = (value: number) => Math.round(value * 10);

/** A region as the hand-off carries it, or null past the block's bound. */
export function outlineFigureFrom(region: OutlineRegion, page: number): PdfOutlineFigure | null {
  let total = 0;
  const paths: PdfOutlineFigure['paths'] = [];
  for (const path of region.paths) {
    const rings: number[][] = [];
    for (const ring of path.rings) {
      const quantised: number[] = [];
      for (let k = 0; k < ring.length; k += 2) {
        quantised.push(tenths(ring[k] - region.box.x), tenths(ring[k + 1] - region.box.y));
      }
      total += quantised.length / 2;
      rings.push(quantised);
    }
    paths.push({ evenOdd: path.evenOdd, rings });
  }
  if (total > MAX_POINTS_PER_BLOCK) return null;
  return {
    kind: 'outlines',
    page,
    drawn: {
      x: Math.round(region.box.x * 10) / 10,
      y: Math.round(region.box.y * 10) / 10,
      width: Math.round(region.box.width * 10) / 10,
      height: Math.round(region.box.height * 10) / 10,
    },
    rowHeight: Math.round(region.rowHeight * 10) / 10,
    paths,
  };
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * The blocks a stored hand-off carries, each checked for exactly the shape the
 * successor draws. An entry that is not exactly that is dropped, never
 * repaired, and a block past its bound is dropped whole.
 */
export function readPdfOutlineFigures(stored: unknown): PdfOutlineFigure[] {
  if (!Array.isArray(stored)) return [];
  const out: PdfOutlineFigure[] = [];
  for (const entry of stored.slice(0, MAX_OUTLINES_READ)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const figure = entry as Record<string, unknown>;
    if (figure.kind !== 'outlines') continue;
    const page = figure.page;
    if (!finite(page) || !Number.isInteger(page) || page < 1) continue;
    const drawn = figure.drawn as Record<string, unknown> | null | undefined;
    if (!drawn || !finite(drawn.x) || !finite(drawn.y)
      || !finite(drawn.width) || !finite(drawn.height)
      || !(drawn.width > 0) || !(drawn.height > 0)) continue;
    if (!finite(figure.rowHeight) || !(figure.rowHeight > 0)) continue;
    if (!Array.isArray(figure.paths) || !figure.paths.length) continue;
    let total = 0;
    let valid = true;
    const paths: PdfOutlineFigure['paths'] = [];
    for (const raw of figure.paths) {
      const path = raw as Record<string, unknown>;
      if (!path || typeof path.evenOdd !== 'boolean' || !Array.isArray(path.rings)) { valid = false; break; }
      const rings: number[][] = [];
      for (const ring of path.rings) {
        if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 !== 0
          || !ring.every((value) => Number.isInteger(value))) { valid = false; break; }
        total += ring.length / 2;
        rings.push(ring as number[]);
      }
      if (!valid) break;
      paths.push({ evenOdd: path.evenOdd, rings });
    }
    if (!valid || total > MAX_POINTS_PER_BLOCK) continue;
    out.push({
      kind: 'outlines',
      page,
      drawn: { x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height },
      rowHeight: figure.rowHeight,
      paths,
    });
  }
  return out;
}

/** Does this row state a building size? An empty value states nothing. */
function statesBuildingSize(row: Record<string, unknown>): boolean {
  const value = row.building_size_sqm;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * The blocks worth reading for THIS decision, in reading order, or none —
 * under exactly the conditions a picture is read under (`figuresToRead`).
 */
export function outlinesToRead(input: {
  outlines: readonly PdfOutlineFigure[];
  rows: ReadonlyArray<Record<string, unknown>>;
  pricePages: readonly number[];
  disputedFields: readonly string[];
}): PdfOutlineFigure[] {
  if (input.rows.length !== 1) return [];
  if (statesBuildingSize(input.rows[0])) return [];
  if (input.disputedFields.includes('building_size_sqm')) return [];
  const pages = new Set(input.pricePages);
  if (!pages.size) return [];
  return input.outlines
    .filter((figure) => pages.has(figure.page))
    .slice()
    .sort((a, b) => (a.page - b.page)
      || ((b.drawn.y + b.drawn.height) - (a.drawn.y + a.drawn.height))
      || (a.drawn.x - b.drawn.x))
    .slice(0, MAX_OUTLINES_READ);
}

/**
 * The blocks one crossing may read beside the pictures it reads, so the two
 * together stay inside `MAX_FIGURE_RECOGNITIONS`. The pictures come first:
 * they are what the crossing has always read, and a block only adds to them.
 */
export function outlinesWithinRecognitionBudget(
  figureCount: number,
  outlines: readonly PdfOutlineFigure[],
): PdfOutlineFigure[] {
  return outlines.slice(0, Math.max(0, MAX_FIGURE_RECOGNITIONS - figureCount));
}

// ---------------------------------------------------------------------------
// Drawing the block, for recognition
// ---------------------------------------------------------------------------

/** Recognition's native density, as for a picture (`figureRaster.pure.ts`). */
const OUTLINE_DPI = 400;
/** And the cost bound on what is drawn. */
const MAX_OUTLINE_PIXELS = 4_000_000;
/** Samples per pixel edge: the drawing is antialiased by averaging them. */
const SUPERSAMPLE = 3;
/** White margin around the block, in pixels, which recognition expects. */
const MARGIN = 24;

export interface OutlineRaster {
  width: number;
  height: number;
  /** One byte per pixel, 0 black to 255 white, row-major, top row first. */
  pixels: Uint8Array;
}

/**
 * Draw a block's shapes in black on white, antialiased, at about 400 dpi.
 *
 * A scanline fill of each painted shape under its own fill rule, on a grid
 * `SUPERSAMPLE` times finer than the output, averaged down. Every shape is
 * drawn in the same ink: what the page painted it in is colour, and colour
 * carries nothing a figure needs.
 */
export function rasteriseOutlines(figure: PdfOutlineFigure): OutlineRaster | null {
  const widthPt = figure.drawn.width;
  const heightPt = figure.drawn.height;
  if (!(widthPt > 0) || !(heightPt > 0)) return null;
  let scale = OUTLINE_DPI / 72;
  if (widthPt * heightPt * scale * scale > MAX_OUTLINE_PIXELS) {
    scale = Math.sqrt(MAX_OUTLINE_PIXELS / (widthPt * heightPt));
  }
  const inner = { w: Math.max(1, Math.ceil(widthPt * scale)), h: Math.max(1, Math.ceil(heightPt * scale)) };
  const fine = { w: inner.w * SUPERSAMPLE, h: inner.h * SUPERSAMPLE };
  const coverage = new Uint8Array(fine.w * fine.h);
  // Tenths of a point to fine pixels, and y flipped so the top row is first.
  const k = (scale * SUPERSAMPLE) / 10;

  for (const path of figure.paths) {
    const edges: Array<{ x0: number; y0: number; x1: number; y1: number; dir: number }> = [];
    for (const ring of path.rings) {
      const count = ring.length / 2;
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const x0 = ring[i * 2] * k;
        const y0 = fine.h - ring[i * 2 + 1] * k;
        const x1 = ring[j * 2] * k;
        const y1 = fine.h - ring[j * 2 + 1] * k;
        if (y0 === y1) continue;
        edges.push(y0 < y1
          ? { x0, y0, x1, y1, dir: 1 }
          : { x0: x1, y0: y1, x1: x0, y1: y0, dir: -1 });
      }
    }
    if (!edges.length) continue;
    let top = Infinity; let bottom = -Infinity;
    for (const edge of edges) {
      if (edge.y0 < top) top = edge.y0;
      if (edge.y1 > bottom) bottom = edge.y1;
    }
    const rowFrom = Math.max(0, Math.floor(top));
    const rowTo = Math.min(fine.h - 1, Math.ceil(bottom));
    const crossings: Array<{ x: number; dir: number }> = [];
    for (let row = rowFrom; row <= rowTo; row++) {
      const y = row + 0.5;
      crossings.length = 0;
      for (const edge of edges) {
        if (y < edge.y0 || y >= edge.y1) continue;
        const t = (y - edge.y0) / (edge.y1 - edge.y0);
        crossings.push({ x: edge.x0 + t * (edge.x1 - edge.x0), dir: edge.dir });
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let c = 0; c < crossings.length - 1; c++) {
        winding = path.evenOdd ? winding ^ 1 : winding + crossings[c].dir;
        if (winding === 0) continue;
        const from = Math.max(0, Math.ceil(crossings[c].x - 0.5));
        const to = Math.min(fine.w - 1, Math.floor(crossings[c + 1].x - 0.5));
        const offset = row * fine.w;
        for (let x = from; x <= to; x++) coverage[offset + x] = 1;
      }
    }
  }

  const width = inner.w + MARGIN * 2;
  const height = inner.h + MARGIN * 2;
  const pixels = new Uint8Array(width * height).fill(255);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < inner.h; y++) {
    for (let x = 0; x < inner.w; x++) {
      let ink = 0;
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        const offset = (y * SUPERSAMPLE + dy) * fine.w + x * SUPERSAMPLE;
        for (let dx = 0; dx < SUPERSAMPLE; dx++) ink += coverage[offset + dx];
      }
      if (ink) pixels[(y + MARGIN) * width + x + MARGIN] = 255 - Math.round((255 * ink) / samples);
    }
  }
  return { width, height, pixels };
}
