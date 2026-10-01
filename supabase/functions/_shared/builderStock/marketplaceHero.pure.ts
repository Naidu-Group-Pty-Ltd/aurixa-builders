/**
 * ===========================================================================
 * THE MARKETPLACE HERO STANDARD — how a card frames the property.
 * ===========================================================================
 *
 * WHAT IT REPLACES. Since 30 September 2026 a card showed every picture
 * whole unless its shape was within 3% of 16:9 (`cardPictureFit`). That rule
 * was right about one thing — a blind crop cuts houses — and wrong about the
 * rest: a 2500×2800 render was drawn as a narrow strip of mostly sky, a
 * brochure crop kept the brochure's white page around it, and a house low in
 * a tall frame stayed low. The owner's standard of 1 October 2026 replaces it:
 * every card is 16:9, the property is the obvious subject, and nothing about
 * the builder's file is altered or invented to get there.
 *
 * WHAT THIS MODULE IS. A pure, deterministic PLANNER: it reads the decoded
 * thumbnail every other judgement here already reads (`sourceImageRaster.ts`,
 * ≤400px on the long side) and writes a PLAN — the photographic region, the
 * building's bounds, and a crop in the served image's own pixels. Nothing is
 * re-encoded: both portals draw the stored plan over the bytes they already
 * serve, so the original is never touched and an already-good picture is
 * never recompressed. The rendering side (`src/lib/marketplaceHero.ts`)
 * applies a plan and computes nothing of its own.
 *
 * THE FOUR RULES THE PLAN OBEYS, in the order they can refuse.
 *
 *   1  CANVAS IS NOT PHOTOGRAPH. Uniform white, black or neutral bands at an
 *      edge (a brochure's page, a letterbox) are trimmed — but only where they
 *      end at a clean photographic edge, so a flat grey sky above a sparse
 *      roofline is never mistaken for a margin.
 *   2  THE BUILDING IS NEVER CUT. Its bounds are found from structure (long
 *      vertical edges — walls, jambs, frames) joined to the edge-dense region
 *      above it (the roof). The crop must contain them in full; a frame that
 *      cannot is not drawn as a crop at all.
 *   3  NO CROP WITHOUT A SUBJECT. A picture whose subject cannot be found is
 *      never cropped beyond the old 3% allowance; it is shown whole.
 *   4  ZOOM IS EARNED. Only a high-confidence subject is enlarged, never past
 *      1.67× and never below 960 source pixels across, so a tiny house is
 *      helped where the file can bear it and left alone where it cannot.
 *
 * And the one that governs everything else: THIS IS PRESENTATION. A plan
 * that cannot be made leaves the card exactly as it was. Nothing here reads
 * or writes eligibility, identity, publication or the primary pointer.
 *
 * Pure: no IO, no clock.
 */

/**
 * The version the sweep plans at, and the only one it treats as CURRENT —
 * raise it when the planner's output for the same pixels would change. A plan
 * of an older version that still validates is drawn until it is re-planned,
 * so raising it never blanks a card; it only makes every plan owed again.
 */
export const HERO_PLAN_VERSION = 3;
/** The first pass alone (v2): the original planner, kept byte for byte. */
const HERO_FIRST_PASS_VERSION = 2;
/** The fit rescue (v3): a second look wherever the first pass answers `fit`. */
export const HERO_RESCUE_VERSION = 3;
/** Whether `planHero` runs the rescue unless told otherwise. */
export const HERO_RESCUE_DEFAULT = HERO_PLAN_VERSION >= HERO_RESCUE_VERSION;
/** The oldest stored plan a card may still draw, and the newest any reader understands. */
export const HERO_PLAN_MIN_VERSION = 2;
export const HERO_PLAN_MAX_VERSION = HERO_RESCUE_VERSION;

/** The frame. One place; a second spelling is how two portals drift. */
export const HERO_ASPECT_W = 16;
export const HERO_ASPECT_H = 9;
export const HERO_ASPECT = HERO_ASPECT_W / HERO_ASPECT_H;

/**
 * Is this rectangle 16:9 to within one pixel of rounding? A crop is chosen in
 * whole pixels, so an exact 16:9 exists only at multiples of 16 — and a
 * building that spans a photograph 2,142 px wide must not be refused a frame
 * for want of two pixels. One pixel of aspect is invisible, and the card
 * draws with \`object-fit: cover\`, so nothing is ever stretched.
 */
export function isHeroAspect(w: number, h: number): boolean {
  return w > 0 && h > 0 && Math.abs(w * HERO_ASPECT_H - h * HERO_ASPECT_W) <= HERO_ASPECT_W;
}

/** The old rule's allowance: a shape this close to 16:9 may be covered. */
export const HERO_SHAPE_TOLERANCE = 0.03;
/** A picture this close to 16:9, untrimmed and unzoomed, is already right. */
export const HERO_ALREADY_FRAMED_TOLERANCE = 0.015;

/** The building's share of the crop's width the standard aims for. */
export const HERO_TARGET_MIN_SHARE = 0.55;
export const HERO_TARGET_MAX_SHARE = 0.90;
/** Never enlarge past this, and never below this many source pixels across. */
export const HERO_MAX_ZOOM = 1 / 0.6;
export const HERO_MIN_CROP_SOURCE_PX = 960;

export interface PixelRect { x: number; y: number; w: number; h: number }
export type HeroMode = 'original' | 'crop' | 'fit';
export type HeroConfidence = 'high' | 'medium' | 'low';

/**
 * Why a picture is shown whole. Every v3 `fit` names exactly one, and there is
 * no catch-all: a fit nobody can explain is a defect, not an outcome.
 *
 *   building_too_wide       the connected building is wider than any 16:9
 *                           frame of the photograph (a long terrace)
 *   building_too_tall       … or taller (a tall house in a 4:3 or portrait)
 *   subject_confidence_low  no building could be told apart from what stands
 *                           beside it — or none was found
 *   photo_region_uncertain  where the photograph ends could not be settled
 *   minimum_resolution      the frame that holds the building is too few
 *                           pixels across to fill a card well
 *   safe_frame_unavailable  a frame was computed and failed the plan's own
 *                           checks, so none is drawn
 */
export type HeroFitReason =
  | 'building_too_wide' | 'building_too_tall' | 'subject_confidence_low'
  | 'photo_region_uncertain' | 'minimum_resolution' | 'safe_frame_unavailable';
export const HERO_FIT_REASONS: readonly HeroFitReason[] = [
  'building_too_wide', 'building_too_tall', 'subject_confidence_low',
  'photo_region_uncertain', 'minimum_resolution', 'safe_frame_unavailable',
];

/** What the fit rescue saw and did — geometry and counts, never pixels. */
export interface HeroRescueRecord {
  outcome: 'promoted' | 'refused';
  /** The photographic region was narrowed past the first pass's. */
  photoRegionChanged: boolean;
  /** Canvas, a letterbox, a banner or a frame line was proven and removed. */
  canvasDetected: boolean;
  /** The connected facade differs from the first pass's building box. */
  boxChanged: boolean;
  /** Disconnected structure (trees, poles, neighbours, graphics) left out. */
  excludedGroups: number;
  /** Low structure (a fence, landscaping) trimmed from the facade's ends. */
  trimmedEnds: number;
  /** The first pass's answer, which is the v2 planner's for the same bytes. */
  firstPass: { mode: HeroMode; reason: string; usable: PixelRect; focal: PixelRect | null; crop: PixelRect };
}

/** A fit refused by the rescue never frames smaller than this. */
export const HERO_RESCUE_MIN_CROP_SOURCE_PX = 640;

export interface HeroPlan {
  version: number;
  /**
   * `original` the picture is already 16:9 and is drawn as it is;
   * `crop`     the 16:9 rectangle `crop` is drawn;
   * `fit`      no 16:9 frame can hold the property safely, so `crop` (the
   *            photographic region, any shape) is drawn WHOLE on a plain ground.
   */
  mode: HeroMode;
  confidence: HeroConfidence;
  /** The served image's own pixel size; every rectangle below is in it. */
  source: { width: number; height: number };
  /** The photographic region, after brochure canvas and letterboxing. */
  usable: PixelRect;
  /** The building's bounds, or null where no subject could be found. */
  focal: PixelRect | null;
  /** What a card draws. Exactly 16:9 unless `mode` is `fit`. */
  crop: PixelRect;
  reasons: string[];
  /** v3: why a `fit` is a fit. Present on every v3 fit and on nothing else. */
  fitReason?: HeroFitReason;
  /** v3: what the fit rescue did, where it ran. */
  rescue?: HeroRescueRecord;
  measures: {
    trimmed: boolean;
    /** The building's width over the crop's, where a building was found. */
    focalWidthShare: number | null;
    /** The crop's area over the source's. */
    cropAreaShare: number;
    zoom: number;
  };
}

/** The thumbnail shape `sourceImageRaster.ts` produces. */
export interface HeroThumbnail {
  width: number;
  height: number;
  /** RGB triples. */
  pixels: ArrayLike<number>;
  sourceWidth: number;
  sourceHeight: number;
}

/* ------------------------------------------------------------------------ */
/* 1  The photographic region                                                */
/* ------------------------------------------------------------------------ */

const LINE_UNIFORM_SHARE = 0.97;
const LINE_TOLERANCE = 14;
const BAND_DRIFT = 18;
const MAX_TRIM_SHARE = 0.4;
const EDGE_BREAK_SHARE = 0.5;

type Rgb = [number, number, number];

function pixelAt(t: HeroThumbnail, x: number, y: number): Rgb {
  const i = (y * t.width + x) * 3;
  return [t.pixels[i] as number, t.pixels[i + 1] as number, t.pixels[i + 2] as number];
}

/** Mean colour of a line and the share of its pixels near that mean. */
function lineStats(t: HeroThumbnail, vertical: boolean, index: number, from: number, to: number) {
  let r = 0, g = 0, b = 0;
  const n = Math.max(1, to - from);
  for (let k = from; k < to; k += 1) {
    const [pr, pg, pb] = vertical ? pixelAt(t, index, k) : pixelAt(t, k, index);
    r += pr; g += pg; b += pb;
  }
  const mean: Rgb = [r / n, g / n, b / n];
  let near = 0;
  for (let k = from; k < to; k += 1) {
    const p = vertical ? pixelAt(t, index, k) : pixelAt(t, k, index);
    if (distance(p, mean) <= LINE_TOLERANCE) near += 1;
  }
  return { mean, uniform: near / n };
}

function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** White page, black bar or neutral grey canvas — never a coloured field. */
function isCanvasColour([r, g, b]: Rgb): boolean {
  const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
  return lo >= 222 || hi <= 35 || hi - lo <= 10;
}
const isPureCanvas = ([r, g, b]: Rgb) => Math.min(r, g, b) >= 245 || Math.max(r, g, b) <= 12;

/**
 * How many lines of canvas lie at one edge, walking inward. Zero unless the
 * band is canvas-coloured, uniform, and ENDS at a line that is mostly not
 * canvas — a clean photographic edge. A pure white or black band is accepted
 * without that test, because nothing photographic is that flat.
 */
function trimEdge(
  t: HeroThumbnail, side: 'top' | 'bottom' | 'left' | 'right',
  span: { from: number; to: number }, limit: number,
): number {
  const vertical = side === 'left' || side === 'right';
  const extent = vertical ? t.width : t.height;
  const indexAt = (step: number) =>
    side === 'top' || side === 'left' ? step : extent - 1 - step;
  const first = lineStats(t, vertical, indexAt(0), span.from, span.to);
  if (first.uniform < LINE_UNIFORM_SHARE || !isCanvasColour(first.mean)) return 0;

  let steps = 1;
  const cap = Math.floor(limit * MAX_TRIM_SHARE);
  while (steps < cap) {
    const line = lineStats(t, vertical, indexAt(steps), span.from, span.to);
    if (line.uniform < LINE_UNIFORM_SHARE || distance(line.mean, first.mean) > BAND_DRIFT) break;
    steps += 1;
  }
  if (steps >= cap) return 0;
  if (isPureCanvas(first.mean)) return steps;

  // The line after the band must be mostly NOT the band: a photograph's edge.
  let differs = 0;
  const index = indexAt(steps);
  for (let k = span.from; k < span.to; k += 1) {
    const p = vertical ? pixelAt(t, index, k) : pixelAt(t, k, index);
    if (distance(p, first.mean) > LINE_TOLERANCE * 2) differs += 1;
  }
  return differs / Math.max(1, span.to - span.from) >= EDGE_BREAK_SHARE ? steps : 0;
}

export function findUsableRegion(t: HeroThumbnail): PixelRect {
  let left = 0, right = 0, top = 0, bottom = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const rows = { from: top, to: t.height - bottom };
    left = Math.max(left, trimEdge(t, 'left', rows, t.width));
    right = Math.max(right, trimEdge(t, 'right', rows, t.width));
    const cols = { from: left, to: t.width - right };
    top = Math.max(top, trimEdge(t, 'top', cols, t.height));
    bottom = Math.max(bottom, trimEdge(t, 'bottom', cols, t.height));
  }
  const w = t.width - left - right, h = t.height - top - bottom;
  // A "photograph" that is a sliver of the file is a misreading, not a crop.
  if (w < t.width * 0.25 || h < t.height * 0.25 || w * h < t.width * t.height * 0.2) {
    return { x: 0, y: 0, w: t.width, h: t.height };
  }
  return { x: left, y: top, w, h };
}

/* ------------------------------------------------------------------------ */
/* 2  The building                                                           */
/* ------------------------------------------------------------------------ */

const EDGE_THRESHOLD = 30;
const VERTICAL_EDGE = 30;
const ACTIVE_DENSITY = 0.06;
const STRUCTURE_SHARE = 0.025;

interface Subject { box: PixelRect; confidence: HeroConfidence; reasons: string[] }

/**
 * The block measurements of one region, in thumbnail pixels — what the first
 * pass and the fit rescue both read, so the two can never measure differently.
 */
export interface RegionAnalysis {
  ux: number; uy: number; uw: number; uh: number;
  bs: number; cols: number; rows: number;
  /** Edge-dense blocks (anything textured). */
  active: Uint8Array;
  /** Structure pixels per block, where the block clears `STRUCTURE_SHARE`. */
  structMass: Float32Array;
  rowS: number[];
  rowBlue: number[];
  structureBlocks: number;
  /** Per block: the share of blue-dominant pixels, and the mean colour (RGB). */
  blockBlue: Float32Array;
  blockMean: Float32Array;
}

export function analyseRegion(t: HeroThumbnail, usable: PixelRect): RegionAnalysis | null {
  const { x: ux, y: uy, w: uw, h: uh } = usable;
  if (uw < 8 || uh < 8) return null;
  const luma = new Float32Array(uw * uh);
  for (let y = 0; y < uh; y += 1) {
    for (let x = 0; x < uw; x += 1) {
      const [r, g, b] = pixelAt(t, ux + x, uy + y);
      luma[y * uw + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  const L = (x: number, y: number) => luma[y * uw + x];
  const edge = new Uint8Array(uw * uh);
  const vert = new Uint8Array(uw * uh);
  for (let y = 1; y < uh - 1; y += 1) {
    for (let x = 1; x < uw - 1; x += 1) {
      const gx = Math.abs(L(x + 1, y) - L(x - 1, y));
      const gy = Math.abs(L(x, y + 1) - L(x, y - 1));
      if (gx + gy >= EDGE_THRESHOLD) edge[y * uw + x] = 1;
      if (gx >= VERTICAL_EDGE && gx > 1.5 * gy) vert[y * uw + x] = 1;
    }
  }
  // A vertical edge counts as structure only as part of a vertical RUN.
  const runLength = Math.max(4, Math.round(uh / 40));
  const structure = new Uint8Array(uw * uh);
  for (let x = 0; x < uw; x += 1) {
    let start = -1;
    for (let y = 0; y <= uh; y += 1) {
      const on = y < uh && vert[y * uw + x] === 1;
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        if (y - start >= runLength) for (let k = start; k < y; k += 1) structure[k * uw + x] = 1;
        start = -1;
      }
    }
  }

  const bs = Math.max(4, Math.round(Math.max(uw, uh) / 48));
  const cols = Math.ceil(uw / bs), rows = Math.ceil(uh / bs);
  const active = new Uint8Array(cols * rows);
  const structMass = new Float32Array(cols * rows);
  const blockBlue = new Float32Array(cols * rows);
  const blockMean = new Float32Array(cols * rows * 3);
  let totalStructure = 0;
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      let edges = 0, structs = 0, area = 0, blue = 0, mr = 0, mg = 0, mb = 0;
      for (let y = by * bs; y < Math.min(uh, (by + 1) * bs); y += 1) {
        for (let x = bx * bs; x < Math.min(uw, (bx + 1) * bs); x += 1) {
          area += 1; edges += edge[y * uw + x]; structs += structure[y * uw + x];
          const [r, g, b] = pixelAt(t, ux + x, uy + y);
          if (b > r + 10 && b > g) blue += 1;
          mr += r; mg += g; mb += b;
        }
      }
      const i = by * cols + bx;
      if (edges / area >= ACTIVE_DENSITY) active[i] = 1;
      if (structs / area >= STRUCTURE_SHARE) { structMass[i] = structs; totalStructure += structs; }
      blockBlue[i] = blue / area;
      blockMean[i * 3] = mr / area; blockMean[i * 3 + 1] = mg / area; blockMean[i * 3 + 2] = mb / area;
    }
  }

  const rowS = new Array<number>(rows).fill(0);
  let structureBlocks = 0;
  for (let i = 0; i < structMass.length; i += 1) {
    if (structMass[i] > 0) { rowS[Math.floor(i / cols)] += 1; structureBlocks += 1; }
  }
  // Per block-row: is it SKY? Blue-dominant pixels and no structure at all.
  const rowBlue = new Array<number>(rows).fill(0);
  for (let by = 0; by < rows; by += 1) {
    let blue = 0, n = 0;
    for (let y = by * bs; y < Math.min(uh, (by + 1) * bs); y += 2) {
      for (let x = 0; x < uw; x += 2) {
        const [r, g, b] = pixelAt(t, ux + x, uy + y);
        if (b > r + 10 && b > g) blue += 1;
        n += 1;
      }
    }
    rowBlue[by] = n ? blue / n : 0;
  }
  return { ux, uy, uw, uh, bs, cols, rows, active, structMass, rowS, rowBlue, structureBlocks, blockBlue, blockMean };
}

interface Band { top: number; bottom: number; mass: number }

/**
 * v2 — THE BAND, NOT THE EXTENT. Measured on the 41 live cards
 * (1 October 2026): a real photograph is textured almost everywhere —
 * foliage, render, paving, cloud — so edge-dense blocks form ONE region the
 * size of the frame, and stray vertical edges (posts, trunks, a lamp) sit
 * everywhere. What does not move is the PEAK: the rows a facade's walls,
 * windows and doors occupy carry several times the structure of anything
 * else. So the walls are the band around that peak, and the roof is what
 * stands directly on it.
 */
function findBand(a: RegionAnalysis): Band {
  const { rowS, rows } = a;
  // The peak, on a [1,2,1]-smoothed profile so one dense row cannot win alone.
  const smooth = rowS.map((v, i) => (rowS[i - 1] ?? 0) + 2 * v + (rowS[i + 1] ?? 0));
  let peak = 0;
  for (let i = 1; i < rows; i += 1) if (smooth[i] > smooth[peak]) peak = i;
  const threshold = Math.max(1, Math.max(...rowS) * 0.2);
  const dense = (r: number) => rowS[r] >= threshold;
  // Grow the band from the peak, crossing gaps of at most two quiet rows.
  const grow = (from: number, step: number) => {
    let edge = from;
    for (let r = from + step; r >= 0 && r < rows; r += step) {
      if (dense(r)) { edge = r; continue; }
      const ahead1 = r + step, ahead2 = r + 2 * step;
      const bridged = (ahead1 >= 0 && ahead1 < rows && dense(ahead1))
        || (ahead2 >= 0 && ahead2 < rows && dense(ahead2) && !dense(r));
      if (!bridged) break;
    }
    return edge;
  };
  let top = dense(peak) ? peak : grow(peak, -1);
  let bottom = dense(peak) ? peak : grow(peak, 1);
  top = grow(top, -1);
  bottom = grow(bottom, 1);
  let mass = 0;
  for (let r = top; r <= bottom; r += 1) mass += rowS[r];
  return { top, bottom, mass };
}

/** Per column: structure blocks inside the band's rows. */
function bandColumns(a: RegionAnalysis, band: Band): number[] {
  const colS = new Array<number>(a.cols).fill(0);
  for (let r = band.top; r <= band.bottom; r += 1) {
    for (let c = 0; c < a.cols; c += 1) if (a.structMass[r * a.cols + c] > 0) colS[c] += 1;
  }
  return colS;
}

/**
 * What sky looks like in this photograph: the mean colour of the untextured
 * blocks in its top rows, where nothing stands — or null where something
 * does (a tight crop, a tree, a structure at the top), because a reference
 * read off a roof would call the roof sky.
 */
function skyReference(a: RegionAnalysis, bandTop: number): Rgb | null {
  const refRows = Math.min(2, Math.max(1, bandTop));
  let n = 0, r = 0, g = 0, b = 0, structured = 0, textured = 0;
  for (let row = 0; row < refRows; row += 1) {
    for (let c = 0; c < a.cols; c += 1) {
      const i = row * a.cols + c;
      if (a.structMass[i] > 0) structured += 1;
      if (a.active[i]) { textured += 1; continue; }
      r += a.blockMean[i * 3]; g += a.blockMean[i * 3 + 1]; b += a.blockMean[i * 3 + 2]; n += 1;
    }
  }
  return bandTop > 0 && structured === 0 && textured <= refRows * a.cols * 0.3 && n ? [r / n, g / n, b / n] : null;
}

/**
 * The roof: textured, non-sky rows standing on the band, at most the band's
 * own height. A sky row, or a row flat across the building (an overcast
 * page), ends it — a roof is neither.
 *
 * v3 (the fit rescue's facade only — the first pass is v2, untouched) keeps
 * that cap and changes two things: sky is judged over the row's OWN span,
 * because across the whole building a roof narrower than three-fifths of it
 * reads as sky; and the ridge's own row, mostly the sky over it, is the
 * roof's last row rather than none of it.
 */
function roofTop(a: RegionAnalysis, band: Band, x0: number, x1: number, extend = false): number {
  const bandHeight = band.bottom - band.top + 1;
  if (!extend) {
    let top = band.top;
    for (let r = band.top - 1; r >= 0 && band.top - r <= bandHeight; r -= 1) {
      if (a.rowBlue[r] >= 0.4 && a.rowS[r] === 0) break;
      let textured = 0;
      for (let c = x0; c <= x1; c += 1) if (a.active[r * a.cols + c]) textured += 1;
      if (textured === 0) break;
      top = r;
    }
    return top;
  }
  // A block belongs to a row's span where it is textured OR plainly not this
  // photograph's sky: a smooth roof is roof-coloured, and texture alone never
  // sees its interior.
  const sky = skyReference(a, band.top);
  const solid = (i: number) => a.active[i] === 1 || (!!sky && a.blockBlue[i] < 0.35
    && distance([a.blockMean[i * 3], a.blockMean[i * 3 + 1], a.blockMean[i * 3 + 2]], sky) > 30);
  const spanOf = (r: number): [number, number] | null => {
    let lo = -1, hi = -1;
    for (let c = x0; c <= x1; c += 1) if (solid(r * a.cols + c)) { if (lo < 0) lo = c; hi = c; }
    return lo < 0 ? null : [lo, hi];
  };
  const skyOver = (r: number, span: [number, number]) => {
    let sum = 0;
    for (let c = span[0]; c <= span[1]; c += 1) sum += a.blockBlue[r * a.cols + c];
    return sum / (span[1] - span[0] + 1) >= 0.4 && a.rowS[r] === 0;
  };
  // Within the band's height only, as v2: past it, real photographs are
  // textured almost everywhere (canopy, cloud, a neighbour's gable) and a
  // walk that keeps climbing reaches the frame's edge. Measured on the live
  // cards, 1 October 2026: every climb past the cap ended at row 0.
  let top = band.top;
  for (let r = band.top - 1; r >= 0 && band.top - r <= bandHeight; r -= 1) {
    const span = spanOf(r);
    if (!span) break;
    if (skyOver(r, span)) {
      // The ridge's own row is mostly the sky over it: the roof's last row.
      top = r;
      break;
    }
    top = r;
  }
  return top;
}

/**
 * The building's bounds inside the usable region, in thumbnail pixels.
 *
 * Built on blocks, because a house is a REGION, not a cloud of pixels:
 *
 *   edge-dense blocks  anything textured — walls, roof tiles, trees, paving
 *   structure blocks   those carrying long VERTICAL edges — wall corners,
 *                      window frames, jambs, posts — which lawn noise, sky,
 *                      cloud and perspective paving do not produce
 *
 * Its TOP is the roof standing on the wall band; its BOTTOM is one block under
 * the lowest wall row, because what lies below the walls is driveway and lawn
 * — kept where it fits, never a reason to refuse a frame. Every uncertainty
 * widens the box: a box too large costs a tighter frame, a box too small cuts
 * a house.
 */
export function findSubject(
  t: HeroThumbnail, usable: PixelRect,
  /** Optional sink for NUMERIC measurements (profiles, counts) — never pixels. */
  diag?: Record<string, unknown>,
): Subject | null {
  const a = analyseRegion(t, usable);
  if (!a) return null;
  const { ux, uy, uw, uh, bs, cols, rows, active, structMass, rowS, rowBlue, structureBlocks } = a;

  const reasons: string[] = [];
  if (diag) {
    const colS = new Array(cols).fill(0), rowActive = new Array(rows).fill(0);
    for (let i = 0; i < active.length; i += 1) {
      if (active[i]) rowActive[Math.floor(i / cols)] += 1;
      if (structMass[i] > 0) colS[i % cols] += 1;
    }
    Object.assign(diag, {
      block: bs, cols, rows, row_active: rowActive, row_structure: rowS, col_structure: colS,
      row_blue: rowBlue.map((v) => Math.round(v * 100)),
    });
  }
  if (structureBlocks < 3) return null;

  const band = findBand(a);
  const bandMass = band.mass;

  // Width: the band's structure columns, 2%–98% of their mass, plus eaves.
  const colS = bandColumns(a, band);
  const quantile = (q: number) => {
    let sum = 0;
    for (let c = 0; c < cols; c += 1) { sum += colS[c]; if (sum >= bandMass * q) return c; }
    return cols - 1;
  };
  const sx0 = quantile(0.02), sx1 = Math.max(sx0, quantile(0.98));
  const eaves = Math.max(1, Math.round((sx1 - sx0 + 1) * 0.1));
  const x0 = Math.max(0, sx0 - eaves), x1 = Math.min(cols - 1, sx1 + eaves);

  const top = roofTop(a, band, x0, x1);
  // The bottom: one row under the lowest wall row; what lies below is soft.
  const bottom = Math.min(rows - 1, band.bottom + 1);

  const box: PixelRect = {
    x: ux + x0 * bs,
    y: uy + top * bs,
    w: Math.min(uw, (x1 + 1) * bs) - x0 * bs,
    h: Math.min(uh, (bottom + 1) * bs) - top * bs,
  };
  const heightShare = (bottom - top + 1) / rows;
  const widthShare = (x1 - x0 + 1) / cols;
  const confidence: HeroConfidence = bandMass >= structureBlocks * 0.6 && heightShare <= 0.75 && widthShare <= 0.9
    ? 'high' : 'medium';
  if (confidence === 'medium') reasons.push('structure_scattered_or_large');
  if (diag) Object.assign(diag, { band: [band.top, band.bottom], roof_top: top, band_share: Math.round((bandMass / structureBlocks) * 100) / 100, x: [x0, x1] });
  return { box, confidence, reasons };
}

/* ------------------------------------------------------------------------ */
/* 2b  The fit rescue (v3) — a second, harder look where the first says fit  */
/* ------------------------------------------------------------------------ */

/*
 * WHY IT EXISTS. Measured on the 41 live cards (1 October 2026), 15 v2 plans
 * were `fit`, and not all of them had to be: a house set inside a wide
 * brochure page, a panorama whose trees, poles and fences stand well apart
 * from the facade, a photograph with a full-height frame line at its edge.
 * The first pass measures EVERYTHING with a vertical edge and finds the
 * picture too wide; the facade itself fits a 16:9 frame with room to spare.
 *
 * WHAT IT MAY DO, in the order it is checked:
 *
 *   A  PROVE MORE CANVAS. Neutral bands at the left, right or bottom that are
 *      uniform to 80% (text on a brochure page is the other 20%) and end at a
 *      STRAIGHT photographic edge; and straight frame lines — a full-height
 *      or full-width edge with a uniform region beyond it. Never the top,
 *      where a flat overcast sky looks exactly like a page.
 *   B  FIND THE CONNECTED FACADE. Structure columns grouped; the heaviest
 *      group is the building, and a neighbouring group joins it unless OPEN
 *      SKY separates them — sky at roof height AND down the upper half of the
 *      walls, which is what lies between a house and a pole, a tree or the
 *      next house, and is never what lies between a house and its own garage.
 *      Anything left out that carries half the building's structure makes the
 *      picture ambiguous, and an ambiguous picture is shown whole.
 *   C  RETRY THE FRAME around that facade, holding it whole.
 *
 * Every uncertainty refuses: a rescue that cannot prove its case leaves the
 * `fit` standing, with the reason it stands.
 */

const RELAXED_DOMINANT_SHARE = 0.8;
const RELAXED_TOLERANCE = 6;
const RELAXED_MAX_TRIM_SHARE = 0.3;
const RELAXED_EDGE_BREAK = 0.6;
const FRAME_LINE_SHARE = 0.9;
const FRAME_LINE_RUN = 0.85;
const FRAME_EDGE = 30;
const FRAME_LINE_REACH = 0.3;
const FRAME_BEYOND_DOMINANT = 0.6;
const OPEN_SKY_SHARE = 0.6;
const PAGE_NEUTRAL_SHARE = 0.9;
const PHOTO_MAX_NEUTRAL = 0.5;
const PAGE_MIN_LIGHT = 200;
const AMBIGUOUS_MASS_SHARE = 0.5;

/** The per-channel median of a run of pixels, and the share near it. */
function regionDominance(
  t: HeroThumbnail, x0: number, y0: number, x1: number, y1: number, tolerance = RELAXED_TOLERANCE,
): { median: Rgb; share: number; neutral: number } {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = pixelAt(t, x, y);
      hist[0][p[0]] += 1; hist[1][p[1]] += 1; hist[2][p[2]] += 1;
      n += 1;
    }
  }
  if (!n) return { median: [0, 0, 0], share: 0, neutral: 0 };
  const median = hist.map((h) => {
    let sum = 0;
    for (let v = 0; v < 256; v += 1) { sum += h[v]; if (sum * 2 >= n) return v; }
    return 255;
  }) as Rgb;
  let near = 0, neutral = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = pixelAt(t, x, y);
      if (distance(p, median) <= tolerance) near += 1;
      if (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 16) neutral += 1;
    }
  }
  return { median, share: near / n, neutral: neutral / n };
}

/**
 * A printed page: one neutral colour, with type on it. After the thumbnail's
 * downscale a brochure's body text is grey blur over half its margin, so the
 * page colour alone covers as little as half the region — but the page AND its
 * type are neutral almost everywhere, which no photograph's edge is.
 */
function isPage(region: { median: Rgb; share: number; neutral: number }): boolean {
  if (!isCanvasColour(region.median)) return false;
  if (region.share >= RELAXED_DOMINANT_SHARE) return true;
  // Told by neutrality only where it is PAPER — light, with darker type on
  // it. A dark band that is neutral is a shadow as often as a letterbox, and
  // a letterbox is flat enough for the rule above.
  return region.neutral >= PAGE_NEUTRAL_SHARE && Math.min(...region.median) >= PAGE_MIN_LIGHT;
}

/**
 * Neutral canvas at one edge (left, right or bottom), judged as a REGION —
 * a brochure's margin carries text, and a column through set type is only
 * two-thirds page. The band is the region from the edge to the first
 * STRAIGHT photographic edge: two consecutive lines each mostly unlike the
 * canvas. Before that edge the band must be 80% one neutral colour, at least
 * two lines deep and at most 30% of the region.
 */
function relaxedCanvasTrim(t: HeroThumbnail, r: PixelRect, side: 'left' | 'right' | 'bottom'): number {
  const vertical = side !== 'bottom';
  const extent = vertical ? r.w : r.h;
  const along = vertical ? r.h : r.w;
  const cap = Math.floor(extent * RELAXED_MAX_TRIM_SHARE);
  if (cap < 3) return 0;
  const edgeColour = side === 'left' ? regionDominance(t, r.x, r.y, r.x + 1, r.y + r.h, 16)
    : side === 'right' ? regionDominance(t, r.x + r.w - 1, r.y, r.x + r.w, r.y + r.h, 16)
      : regionDominance(t, r.x, r.y + r.h - 1, r.x + r.w, r.y + r.h, 16);
  if (!isCanvasColour(edgeColour.median) || !(edgeColour.share >= 0.6
    || (edgeColour.neutral >= PAGE_NEUTRAL_SHARE && Math.min(...edgeColour.median) >= PAGE_MIN_LIGHT))) return 0;
  const pixel = (step: number, j: number) => side === 'left' ? pixelAt(t, r.x + step, r.y + j)
    : side === 'right' ? pixelAt(t, r.x + r.w - 1 - step, r.y + j)
      : pixelAt(t, r.x + j, r.y + r.h - 1 - step);
  const unlike = (step: number) => {
    let differs = 0;
    for (let j = 0; j < along; j += 1) if (distance(pixel(step, j), edgeColour.median) > LINE_TOLERANCE * 2) differs += 1;
    return differs / along >= RELAXED_EDGE_BREAK;
  };
  let edge = -1;
  for (let step = 2; step + 1 < cap; step += 1) {
    if (unlike(step) && unlike(step + 1)) { edge = step; break; }
  }
  if (edge < 2) return 0;
  // STRAIGHT: the page runs right up to that edge on its last line too —
  // neutral almost throughout, where the next two lines are mostly not.
  let like = 0;
  for (let j = 0; j < along; j += 1) {
    const p = pixel(edge - 1, j);
    if (distance(p, edgeColour.median) <= LINE_TOLERANCE || Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 16) like += 1;
  }
  if (like / along < 0.85) return 0;
  const band = side === 'left' ? regionDominance(t, r.x, r.y, r.x + edge, r.y + r.h)
    : side === 'right' ? regionDominance(t, r.x + r.w - edge, r.y, r.x + r.w, r.y + r.h)
      : regionDominance(t, r.x, r.y + r.h - edge, r.x + r.w, r.y + r.h);
  if (!isPage(band)) return 0;
  if (band.share >= RELAXED_DOMINANT_SHARE) {
    // One flat colour: it must be the colour the edge started with.
    return distance(band.median, edgeColour.median) > BAND_DRIFT ? 0 : edge;
  }
  // A page told by its NEUTRALITY (type over paper) must meet a photograph
  // that is not neutral: a white render wall at the frame's edge, running to
  // a corner, is neutral on both sides of that corner and is never a page.
  const next = side === 'left' ? regionDominance(t, r.x + edge, r.y, r.x + Math.min(r.w, edge + 4), r.y + r.h)
    : side === 'right' ? regionDominance(t, r.x + Math.max(0, r.w - edge - 4), r.y, r.x + r.w - edge, r.y + r.h)
      : regionDominance(t, r.x, r.y + Math.max(0, r.h - edge - 4), r.x + r.w, r.y + r.h - edge);
  return next.neutral <= PHOTO_MAX_NEUTRAL ? edge : 0;
}

/**
 * A straight frame line near one edge: a column (or, at the bottom, a row)
 * where a strong edge runs UNBROKEN across 85% of the region (90% in all) — anything that
 * stands on a horizon breaks it — with nothing but one flat colour beyond it. That is a brochure's photo border, a separator
 * above a banner, a panel's edge — not a building, whose corner never runs
 * the full height of its own photograph unbroken by its roof. Returns how
 * many lines to remove from that edge (the line included), or 0.
 */
function frameLineTrim(t: HeroThumbnail, r: PixelRect, side: 'left' | 'right' | 'bottom'): number {
  const vertical = side !== 'bottom';
  const extent = vertical ? r.w : r.h;
  const along = vertical ? r.h : r.w;
  const reach = Math.floor(extent * FRAME_LINE_REACH);
  const strongAt = (step: number): boolean => {
    let on = 0, run = 0, longest = 0;
    for (let j = 1; j < along - 1; j += 1) {
      let g = 0, cross = 0;
      if (side === 'bottom') {
        const y = r.y + r.h - 1 - step, x = r.x + j;
        if (y - 1 < 0 || y + 1 >= t.height) return false;
        g = distance(pixelAt(t, x, y + 1), pixelAt(t, x, y - 1));
        cross = distance(pixelAt(t, x + 1, y), pixelAt(t, x - 1, y));
      } else {
        const x = side === 'left' ? r.x + step : r.x + r.w - 1 - step, y = r.y + j;
        if (x - 1 < 0 || x + 1 >= t.width) return false;
        g = distance(pixelAt(t, x + 1, y), pixelAt(t, x - 1, y));
        cross = distance(pixelAt(t, x, y + 1), pixelAt(t, x, y - 1));
      }
      // Colour, not brightness: a red banner under a green lawn is the same
      // brightness and an unmistakable edge.
      if (g >= FRAME_EDGE && g > 1.5 * cross) { on += 1; run += 1; longest = Math.max(longest, run); } else run = 0;
    }
    // UNBROKEN: one continuous run across most of the region (a page's own
    // margins at its ends are the only gap allowed), and the line nearly
    // everywhere — anything standing on a horizon breaks both.
    const n = Math.max(1, along - 2);
    return on / n >= FRAME_LINE_SHARE && longest / n >= FRAME_LINE_RUN;
  };
  for (let step = 0; step < reach; step += 1) {
    if (!strongAt(step)) continue;
    let last = step;
    while (last + 1 < reach && strongAt(last + 1)) last += 1;
    // What lies beyond the line must be one FLAT region — print is flat to a
    // few levels, a photograph's lawn or sky is not — and never a green
    // field: a straight horizon over a lawn is the photograph's own edge.
    if (step >= 3) {
      const beyond = side === 'left' ? regionDominance(t, r.x, r.y, r.x + step - 1, r.y + r.h)
        : side === 'right' ? regionDominance(t, r.x + r.w - step + 1, r.y, r.x + r.w, r.y + r.h)
          : regionDominance(t, r.x, r.y + r.h - step + 1, r.x + r.w, r.y + r.h);
      const [br, bg, bb] = beyond.median;
      if (bg > br + 12 && bg > bb + 12) return 0;
      // A neutral page may carry more — type, a logo, a badge — because the
      // straight, unbroken edge already proves where the photograph stops.
      if (isCanvasColour(beyond.median) ? !isPage(beyond) : beyond.share < FRAME_BEYOND_DOMINANT) return 0;
    }
    return last + 1;
  }
  return 0;
}

/**
 * Stage A — the photographic region, proven harder than the first pass
 * proves it. Starts from the first pass's region and only ever narrows it.
 */
export function findPhotoRegion(t: HeroThumbnail, u: PixelRect): { region: PixelRect; changed: boolean; uncertain: boolean } {
  let r = { ...u };
  for (let pass = 0; pass < 2; pass += 1) {
    const left = Math.max(relaxedCanvasTrim(t, r, 'left'), frameLineTrim(t, r, 'left'));
    r = { ...r, x: r.x + left, w: r.w - left };
    const right = Math.max(relaxedCanvasTrim(t, r, 'right'), frameLineTrim(t, r, 'right'));
    r = { ...r, w: r.w - right };
    const bottom = Math.max(relaxedCanvasTrim(t, r, 'bottom'), frameLineTrim(t, r, 'bottom'));
    r = { ...r, h: r.h - bottom };
    // The top is held to the FIRST pass's strict rule, never a relaxed one —
    // asked again across the refined columns, because the text in a margin
    // is what stopped it the first time.
    const top = trimEdge(t, 'top', { from: r.x, to: r.x + r.w }, t.height);
    if (top > r.y && top < r.y + r.h) r = { ...r, y: top, h: r.y + r.h - top };
    if (r.w < 8 || r.h < 8) break;
  }
  const changed = r.x !== u.x || r.y !== u.y || r.w !== u.w || r.h !== u.h;
  // A "photograph" that is a sliver of the region is a misreading.
  const uncertain = r.w < u.w * 0.5 || r.h < u.h * 0.5 || r.w * r.h < u.w * u.h * 0.4;
  return { region: uncertain ? { ...u } : r, changed: changed && !uncertain, uncertain };
}

interface Facade {
  /** Thumbnail pixels: the building, held whole. */
  hard: PixelRect;
  /** … and with the generous eaves and soft ground the first pass allows. */
  soft: PixelRect;
  confidence: HeroConfidence;
  excluded: number;
  trimmedEnds: number;
}

/**
 * Stage B — the connected facade. See the module note above `relaxedCanvasTrim`
 * for what may and may not be left out.
 */
export function findFacade(a: RegionAnalysis, diag?: Record<string, unknown>): Facade | { refused: HeroFitReason } {
  const { ux, uy, uw, uh, bs, cols, rows, active, blockBlue, blockMean } = a;
  if (a.structureBlocks < 3) return { refused: 'subject_confidence_low' };
  const band = findBand(a);
  const bandHeight = band.bottom - band.top + 1;
  const colS = bandColumns(a, band);

  // Groups of structure columns; a single quiet column does not separate.
  const groups: Array<{ x0: number; x1: number; mass: number }> = [];
  for (let c = 0; c < cols; c += 1) {
    if (colS[c] === 0) continue;
    const last = groups[groups.length - 1];
    if (last && c - last.x1 <= 2) { last.x1 = c; last.mass += colS[c]; }
    else groups.push({ x0: c, x1: c, mass: colS[c] });
  }
  if (!groups.length) return { refused: 'subject_confidence_low' };
  // What sky looks like here: the top rows, where nothing stands.
  const sky = skyReference(a, band.top);
  const skyish = (row: number, c: number) => {
    const i = row * cols + c;
    if (blockBlue[i] >= 0.35) return true;
    return !!sky && !active[i] && distance([blockMean[i * 3], blockMean[i * 3 + 1], blockMean[i * 3 + 2]], sky) <= 24;
  };
  // The zone that decides "open": roof height down to the middle of the
  // walls, measured from the heaviest group's roof.
  let heaviest = groups[0];
  for (const g of groups) if (g.mass > heaviest.mass) heaviest = g;
  const zoneTop = roofTop(a, band, heaviest.x0, heaviest.x1, true);
  const zoneBottom = band.top + Math.floor((bandHeight - 1) / 2);
  // … and the rows the walls stand in: the band's own densest rows, in its
  // upper two-thirds — a fence's rows are the band's foot, and beside a
  // fence is lawn, which is not sky and must not join it to the house.
  const wallLimit = band.top + Math.max(0, Math.ceil(bandHeight * 0.65) - 1);
  let densest = 1;
  for (let row = band.top; row <= wallLimit; row += 1) densest = Math.max(densest, a.rowS[row]);
  const wallRows: number[] = [];
  for (let row = band.top; row <= wallLimit; row += 1) if (a.rowS[row] >= densest * 0.5) wallRows.push(row);
  const skyShare = (rowList: number[], c0: number, c1: number) => {
    let open = 0, n = 0;
    for (const row of rowList) {
      for (let c = c0; c <= c1; c += 1) { n += 1; if (skyish(row, c)) open += 1; }
    }
    return n ? open / n : 0;
  };
  const zoneRows: number[] = [];
  for (let row = zoneTop; row <= zoneBottom; row += 1) zoneRows.push(row);
  // Open means sky at roof height AND beside the walls themselves: a garage
  // door, a blank wall or a tree is not sky, whatever stands above it.
  const openAcross = (c0: number, c1: number) => c1 >= c0
    && skyShare(zoneRows, c0, c1) >= OPEN_SKY_SHARE && skyShare(wallRows, c0, c1) >= OPEN_SKY_SHARE * 0.85;

  // Clusters: groups joined across anything but open sky. A house broken by
  // a plain garage door or a blank wall is ONE cluster; a house and the pole,
  // tree or house beside it, with sky between, are two.
  const clusters: Array<{ x0: number; x1: number; mass: number; parts: number; cut: boolean }> = [];
  for (const g of groups) {
    const last = clusters[clusters.length - 1];
    if (last && !openAcross(last.x1 + 1, g.x0 - 1)) { last.x1 = g.x1; last.mass += g.mass; last.parts += 1; }
    else clusters.push({ x0: g.x0, x1: g.x1, mass: g.mass, parts: 1, cut: false });
  }
  // Cut by the photograph's edge: no open-sky column between it and the edge.
  const skyColumnIn = (c0: number, c1: number) => {
    for (let c = c0; c <= c1; c += 1) if (openAcross(c, c)) return true;
    return false;
  };
  for (const k of clusters) {
    k.cut = k.x0 <= 1 || k.x1 >= cols - 2 || !skyColumnIn(0, k.x0 - 1) || !skyColumnIn(k.x1 + 1, cols - 1);
  }
  const centre = (cols - 1) / 2;
  // Structure confined to the foot of the wall band is a fence, a hedge or a
  // garden edge — never a building, so never a rival.
  const lowOnly = (k: { x0: number; x1: number }) => {
    for (let row = band.top; row <= band.bottom; row += 1) {
      for (let c = k.x0; c <= k.x1; c += 1) {
        if (a.structMass[row * cols + c] > 0) return row >= band.top + bandHeight * 0.55;
      }
    }
    return true;
  };
  // Foliage: most of what it carries in the wall band is green.
  const vegetation = (k: { x0: number; x1: number }) => {
    let green = 0, n = 0;
    for (let row = band.top; row <= band.bottom; row += 1) {
      for (let c = k.x0; c <= k.x1; c += 1) {
        const i = row * cols + c;
        if (!active[i]) continue;
        n += 1;
        const r = blockMean[i * 3], g = blockMean[i * 3 + 1], b = blockMean[i * 3 + 2];
        if (g > r + 8 && g > b + 8) green += 1;
      }
    }
    return n > 0 && green / n >= 0.5;
  };
  const notBuilding = (k: { x0: number; x1: number }) => k.x1 - k.x0 <= 1 || lowOnly(k) || vegetation(k);
  const standing = clusters.filter((k) => !notBuilding(k));
  const candidates = standing.length ? standing : clusters;
  const heaviestOf = (list: typeof clusters) => {
    let best = list[0];
    for (const k of list) {
      const closer = Math.abs((k.x0 + k.x1) / 2 - centre) < Math.abs((best.x0 + best.x1) / 2 - centre);
      if (k.mass > best.mass || (k.mass === best.mass && closer)) best = k;
    }
    return best;
  };
  let main = heaviestOf(candidates);
  // The photographer frames the property and lets the frame's edge run
  // through the house next door: where the heaviest building is the one the
  // edge cuts, a building standing WHOLE in the picture with half its
  // structure is the property.
  const whole = candidates.filter((k) => !k.cut);
  if (main.cut && whole.length) {
    const alternative = heaviestOf(whole);
    if (alternative.mass >= main.mass * AMBIGUOUS_MASS_SHARE) main = alternative;
  }
  if (diag) Object.assign(diag, { facade_clusters: clusters.map((k) => [k.x0, k.x1, k.mass, k.cut ? 1 : 0]) });
  // What is left out is judged against the building. One standing whole in
  // the picture with half its structure is a rival; one the frame's edge
  // runs through is the next house along — unless the building is itself
  // the one the edge cuts, when anything substantial standing whole may be
  // the property, and the picture is ambiguous.
  for (const k of clusters) {
    // A pole, a trunk, a rule, a fence or a tree is never a rival.
    if (k === main || notBuilding(k)) continue;
    const share = k.mass / main.mass;
    if (k.cut && !main.cut) continue;
    if (share >= (k.cut ? 1 : AMBIGUOUS_MASS_SHARE)) return { refused: 'subject_confidence_low' };
    if (main.cut && !k.cut && share >= 0.35) return { refused: 'subject_confidence_low' };
  }
  let x0 = main.x0, x1 = main.x1;
  const mainAt = clusters.indexOf(main);
  const excluded = clusters.length - 1;
  const stopLeft = mainAt > 0 ? clusters[mainAt - 1].x1 : -1;
  const stopRight = mainAt < clusters.length - 1 ? clusters[mainAt + 1].x0 : cols;

  // Low structure at the facade's ends with open sky above it: a fence.
  let trimmedEnds = 0;
  const lowAndOpen = (c: number) => {
    if (colS[c] === 0) return true;
    let firstRow = band.bottom;
    for (let row = band.top; row <= band.bottom; row += 1) if (a.structMass[row * cols + c] > 0) { firstRow = row; break; }
    // Above a fence is whatever stands behind it; above a wall is its roof.
    return firstRow >= band.top + bandHeight * 0.65 && skyShare(zoneRows, c, c) >= OPEN_SKY_SHARE;
  };
  while (x1 - x0 > 2 && lowAndOpen(x0)) { if (colS[x0] > 0) trimmedEnds += 1; x0 += 1; }
  while (x1 - x0 > 2 && lowAndOpen(x1)) { if (colS[x1] > 0) trimmedEnds += 1; x1 -= 1; }
  while (x0 < x1 && colS[x0] === 0) x0 += 1;
  while (x1 > x0 && colS[x1] === 0) x1 -= 1;

  // Eaves: one block at least (5% of the facade) held whole, 10% as room —
  // never reaching into what was left out.
  const width = x1 - x0 + 1;
  const hardEave = Math.max(1, Math.round(width * 0.05));
  const softEave = Math.max(hardEave, Math.round(width * 0.1));
  const limitLo = stopLeft < 0 ? 0 : stopLeft + 2, limitHi = stopRight >= cols ? cols - 1 : stopRight - 2;
  const hx0 = Math.max(0, limitLo, x0 - hardEave), hx1 = Math.min(cols - 1, limitHi, x1 + hardEave);
  const sx0 = Math.max(0, limitLo, x0 - softEave), sx1 = Math.min(cols - 1, limitHi, x1 + softEave);
  if (hx0 > x0 || hx1 < x1) return { refused: 'subject_confidence_low' };

  const top = roofTop(a, band, hx0, hx1, true);
  const foot = band.bottom;
  if (diag) {
    const rowActive = new Array(rows).fill(0);
    for (let i = 0; i < active.length; i += 1) if (active[i]) rowActive[Math.floor(i / cols)] += 1;
    Object.assign(diag, {
      facade_block: bs, facade_band: [band.top, band.bottom], facade_cols: colS, facade_row_active: rowActive,
      facade_row_structure: a.rowS,
      facade_x: [x0, x1], facade_hard_x: [hx0, hx1], facade_top: top, facade_zone: [zoneTop, zoneBottom], facade_sky: sky,
    });
  }
  // The building ends half a block under its lowest wall row; the first pass's
  // whole soft row below it is room, not building.
  const hardBottomPx = Math.min(uh, (foot + 1) * bs + (foot < rows - 1 ? Math.ceil(bs / 2) : 0));
  const softBottomPx = Math.min(uh, (Math.min(rows - 1, foot + 1) + 1) * bs);
  const rect = (c0: number, c1: number, bottomPx: number): PixelRect => ({
    x: ux + c0 * bs, y: uy + top * bs,
    w: Math.min(uw, (c1 + 1) * bs) - c0 * bs, h: bottomPx - top * bs,
  });
  let mass = 0;
  for (let c = x0; c <= x1; c += 1) mass += colS[c];
  const heightShare = (foot - top + 1) / rows;
  const confidence: HeroConfidence = mass >= a.structureBlocks * 0.6 && heightShare <= 0.75 && (hx1 - hx0 + 1) / cols <= 0.9
    ? 'high' : 'medium';
  return {
    hard: rect(hx0, hx1, hardBottomPx), soft: rect(sx0, sx1, softBottomPx),
    confidence, excluded, trimmedEnds,
  };
}

interface RescueOutcome {
  plan: HeroPlan | null;
  fitReason: HeroFitReason;
  record: HeroRescueRecord;
  usable: PixelRect | null;
  focal: PixelRect | null;
}

const FIRST_PASS_FIT_REASON: Record<string, HeroFitReason> = {
  subject_wider_than_frame: 'building_too_wide',
  subject_taller_than_frame: 'building_too_tall',
  no_subject_shown_whole: 'subject_confidence_low',
};

/** Stages A–C. Pure; refuses whenever it cannot prove its case. */
function rescueFit(
  t: HeroThumbnail, first: HeroPlan, sx: number, sy: number, diag?: Record<string, unknown>,
): RescueOutcome {
  const SW = first.source.width, SH = first.source.height;
  const firstReason = first.reasons[first.reasons.length - 1] ?? '';
  const record: HeroRescueRecord = {
    outcome: 'refused', photoRegionChanged: false, canvasDetected: false, boxChanged: false,
    excludedGroups: 0, trimmedEnds: 0,
    firstPass: { mode: first.mode, reason: firstReason, usable: first.usable, focal: first.focal, crop: first.crop },
  };
  const refuse = (fitReason: HeroFitReason, usable: PixelRect | null = null, focal: PixelRect | null = null): RescueOutcome =>
    ({ plan: null, fitReason, record, usable, focal });

  // Back to thumbnail pixels: the first pass's region, exactly.
  // An uncertain refinement is dropped, never acted on: the first pass's
  // region stands (`findPhotoRegion` returns it unchanged).
  const u = findUsableRegion(t);
  const found = findPhotoRegion(t, u);
  record.photoRegionChanged = found.changed;
  record.canvasDetected = found.changed || first.measures.trimmed;
  const usable = toSource(found.region, sx, sy, SW, SH);

  const a = analyseRegion(t, found.region);
  if (!a) return refuse('photo_region_uncertain');
  const facade = findFacade(a, diag);
  if (diag) Object.assign(diag, { rescue_region: found.region, rescue_refused: 'refused' in facade ? facade.refused : null });
  if ('refused' in facade) return refuse(facade.refused, found.changed ? usable : null);
  record.excludedGroups = facade.excluded;
  record.trimmedEnds = facade.trimmedEnds;
  const focal = intersect(toSource(facade.hard, sx, sy, SW, SH, true), usable);
  const room = intersect(toSource(facade.soft, sx, sy, SW, SH, true), usable);
  record.boxChanged = !first.focal || focal.x !== first.focal.x || focal.y !== first.focal.y
    || focal.w !== first.focal.w || focal.h !== first.focal.h;
  if (diag) Object.assign(diag, { rescue_region: found.region, rescue_hard: facade.hard, rescue_excluded: facade.excluded, rescue_trimmed: facade.trimmedEnds });

  const keepRegion = found.changed ? usable : null;
  const framed = frameAround(usable, focal, facade.confidence, room);
  if (framed.ok === false) {
    const reason = FIRST_PASS_FIT_REASON[framed.why] ?? 'safe_frame_unavailable';
    return refuse(reason, keepRegion, focal);
  }
  if (framed.crop.w < HERO_RESCUE_MIN_CROP_SOURCE_PX) {
    return refuse('minimum_resolution', keepRegion, focal);
  }
  const reasons = first.mode === 'fit'
    ? [...first.reasons.slice(0, -1), 'fit_rescued']
    : [...first.reasons.filter((r) => r !== 'already_framed' && r !== 'subject_enlarged'), 'reframed_inside_photo'];
  if (found.changed) reasons.push('photo_region_refined');
  if (facade.excluded) reasons.push('disconnected_structure_excluded');
  if (facade.trimmedEnds) reasons.push('low_structure_trimmed');
  if (framed.enlarged) reasons.push('subject_enlarged');
  record.outcome = 'promoted';
  const plan = finish({
    version: first.version, mode: 'crop', confidence: facade.confidence, source: first.source,
    usable, focal, crop: framed.crop, reasons, rescue: record,
  }, framed.zoom);
  if (!validateHeroPlan(plan)) {
    record.outcome = 'refused';
    return refuse('safe_frame_unavailable', keepRegion, focal);
  }
  return { plan, fitReason: 'safe_frame_unavailable', record, usable, focal };
}

/* ------------------------------------------------------------------------ */
/* 3  The frame                                                              */
/* ------------------------------------------------------------------------ */

const shapeOff = (w: number, h: number) => Math.abs(w / h - HERO_ASPECT) / HERO_ASPECT;

type FrameAnswer =
  | { ok: true; crop: PixelRect; zoom: number; enlarged: boolean }
  | { ok: false; why: 'subject_wider_than_frame' | 'subject_taller_than_frame' | 'subject_does_not_fit_frame' };

/**
 * The 16:9 frame around a building, in source pixels. `focal` must be held
 * whole; `room` (the building plus its soft surroundings) is given breathing
 * space where the frame can afford it, never at the building's expense.
 */
function frameAround(usable: PixelRect, focal: PixelRect, confidence: HeroConfidence, room: PixelRect = focal): FrameAnswer {
  // The largest 16:9 frame the photograph holds, in source pixels.
  const wide = usable.w / usable.h >= HERO_ASPECT;
  const maxW = wide ? Math.floor((usable.h * HERO_ASPECT_W) / HERO_ASPECT_H) : usable.w;
  // Can the building stand in a 16:9 frame at all?
  const maxH = Math.floor((maxW * HERO_ASPECT_H) / HERO_ASPECT_W);
  if (focal.w > maxW) return { ok: false, why: 'subject_wider_than_frame' };
  if (focal.h > maxH) return { ok: false, why: 'subject_taller_than_frame' };

  // Breathing room: soft, clipped to the photograph.
  const margin = {
    x0: Math.max(usable.x, room.x - Math.round(maxW * 0.03)),
    x1: Math.min(usable.x + usable.w, room.x + room.w + Math.round(maxW * 0.03)),
    y0: Math.max(usable.y, room.y - Math.round(maxH * 0.03)),
    y1: Math.min(usable.y + usable.h, room.y + room.h + Math.round(maxH * 0.05)),
  };
  const roomW = Math.max(margin.x1 - margin.x0, ((margin.y1 - margin.y0) * HERO_ASPECT_W) / HERO_ASPECT_H);

  let width = maxW;
  let enlarged = false;
  if (confidence === 'high' && focal.w / maxW < HERO_TARGET_MIN_SHARE) {
    const floor = Math.max(maxW / HERO_MAX_ZOOM, Math.min(maxW, HERO_MIN_CROP_SOURCE_PX), roomW,
      focal.w / HERO_TARGET_MAX_SHARE);
    width = Math.min(maxW, Math.max(floor, focal.w / HERO_TARGET_MIN_SHARE));
    if (width < maxW) enlarged = true;
  }
  // 16:9 in whole pixels (to one pixel of rounding), never smaller than the
  // building and never larger than the photograph.
  let cw = Math.min(usable.w, Math.max(Math.round(width), focal.w));
  let ch = Math.round((cw * HERO_ASPECT_H) / HERO_ASPECT_W);
  if (ch > usable.h) { ch = usable.h; cw = Math.round((ch * HERO_ASPECT_W) / HERO_ASPECT_H); }
  if (ch < focal.h) { ch = focal.h; cw = Math.round((ch * HERO_ASPECT_W) / HERO_ASPECT_H); }
  if (cw > usable.w || ch > usable.h || cw < focal.w || ch < focal.h) {
    return { ok: false, why: 'subject_does_not_fit_frame' };
  }

  // Horizontally centred on the building; vertically, 38% of the spare
  // height above it and the rest below — sky trimmed, driveway kept.
  let x = Math.round(focal.x + focal.w / 2 - cw / 2);
  let y = Math.round(focal.y - (ch - focal.h) * 0.38);
  x = clamp(x, usable.x, usable.x + usable.w - cw);
  y = clamp(y, usable.y, usable.y + usable.h - ch);
  // Margins where the frame can give them, the building always.
  if (margin.x0 < x && margin.x1 - margin.x0 <= cw) x = margin.x0;
  if (margin.x1 > x + cw && margin.x1 - margin.x0 <= cw) x = margin.x1 - cw;
  if (margin.y0 < y && margin.y1 - margin.y0 <= ch) y = margin.y0;
  x = clamp(Math.min(x, focal.x), usable.x, usable.x + usable.w - cw);
  y = clamp(Math.min(y, focal.y), usable.y, usable.y + usable.h - ch);
  if (focal.x + focal.w > x + cw) x = focal.x + focal.w - cw;
  if (focal.y + focal.h > y + ch) y = focal.y + focal.h - ch;
  return { ok: true, crop: { x, y, w: cw, h: ch }, zoom: maxW / cw, enlarged };
}

/**
 * Plan how a card frames this picture. Never throws for a well-formed
 * thumbnail; returns null only for one with no pixels to read, which the
 * caller records as a failure and leaves the card as it was.
 *
 * Two passes. The FIRST is the v2 planner, unchanged. Where it answers `fit`
 * — or `original` over canvas it could not prove — the SECOND (v3, the fit
 * rescue, `rescueFit`) looks again, harder: the true photographic region, and
 * the connected facade rather than everything with an edge. It may turn a
 * `fit` into a `crop`; it can never turn a crop into anything, and every `fit`
 * it leaves standing carries the one machine-readable reason it stands.
 */
export function planHero(
  t: HeroThumbnail, diag?: Record<string, unknown>, options: { rescue?: boolean } = {},
): HeroPlan | null {
  const rescue = options.rescue ?? HERO_RESCUE_DEFAULT;
  const first = planFirstPass(t, diag, rescue ? HERO_RESCUE_VERSION : HERO_FIRST_PASS_VERSION);
  if (!first || !rescue) return first;
  const SW = first.source.width, SH = first.source.height;
  const sx = SW / t.width, sy = SH / t.height;
  if (first.mode !== 'fit') {
    // A crop or an untouched original is looked at again ONLY where canvas
    // is proven inside what it draws — a banner across its foot, a margin —
    // and kept unless the rescue frames the building inside the photograph.
    const found = findPhotoRegion(t, findUsableRegion(t));
    if (!found.changed || inside(first.crop, toSource(found.region, sx, sy, SW, SH))) return first;
    const outcome = rescueFit(t, first, sx, sy, diag);
    return outcome.plan && outcome.record.photoRegionChanged ? outcome.plan : first;
  }
  const outcome = rescueFit(t, first, sx, sy, diag);
  if (outcome.plan) return outcome.plan;
  const usable = outcome.usable ?? first.usable;
  return finish({
    ...first,
    usable,
    focal: outcome.focal ?? first.focal,
    crop: usable,
    fitReason: outcome.fitReason,
    rescue: outcome.record,
    reasons: [...first.reasons, `fit_${outcome.fitReason}`],
  }, 1);
}

function planFirstPass(t: HeroThumbnail, diag: Record<string, unknown> | undefined, version: number): HeroPlan | null {
  if (!(t.width > 2) || !(t.height > 2) || !(t.sourceWidth > 0) || !(t.sourceHeight > 0)) return null;
  if (!t.pixels || t.pixels.length < t.width * t.height * 3) return null;

  const SW = Math.round(t.sourceWidth), SH = Math.round(t.sourceHeight);
  const sx = SW / t.width, sy = SH / t.height;
  const reasons: string[] = [];

  const u = findUsableRegion(t);
  const trimmed = u.w < t.width || u.h < t.height;
  if (trimmed) reasons.push('canvas_trimmed');
  const usable = toSource(u, sx, sy, SW, SH);

  // The first pass IS v2, unchanged; only the version it is stamped with moves.
  const subject = findSubject(t, u, diag);
  const focal = subject ? intersect(toSource(subject.box, sx, sy, SW, SH, true), usable) : null;
  const confidence: HeroConfidence = subject?.confidence ?? 'low';
  if (subject) reasons.push(...subject.reasons);
  else reasons.push('no_subject_found');

  const base = { version, source: { width: SW, height: SH }, usable, focal: focal };
  const fit = (why: string): HeroPlan => finish({
    ...base, mode: 'fit', confidence, crop: usable, reasons: [...reasons, why],
  }, 1);

  // The largest 16:9 frame the photograph holds, in source pixels.
  const wide = usable.w / usable.h >= HERO_ASPECT;
  const maxW = wide ? Math.floor((usable.h * HERO_ASPECT_W) / HERO_ASPECT_H) : usable.w;

  // Already right: untrimmed and the shape of the frame.
  if (!trimmed && shapeOff(SW, SH) <= HERO_ALREADY_FRAMED_TOLERANCE
    && !(confidence === 'high' && focal && focal.w / SW < HERO_TARGET_MIN_SHARE)) {
    return finish({ ...base, mode: 'original', confidence, crop: { x: 0, y: 0, w: SW, h: SH },
      reasons: [...reasons, 'already_framed'] }, 1);
  }

  if (!focal || confidence === 'low') {
    // No subject: never cropped past the old allowance.
    if (shapeOff(usable.w, usable.h) <= HERO_SHAPE_TOLERANCE) {
      const crop = centredFrame(usable, maxW);
      return finish({ ...base, mode: 'crop', confidence, crop,
        reasons: [...reasons, 'no_subject_near_frame_shape'] }, 1);
    }
    return fit('no_subject_shown_whole');
  }

  const framed = frameAround(usable, focal, confidence);
  if (framed.ok === false) return fit(framed.why);
  if (framed.enlarged) reasons.push('subject_enlarged');
  const plan = finish({ ...base, mode: 'crop', confidence, crop: framed.crop, reasons }, framed.zoom);
  return validateHeroPlan(plan) ? plan : fit('frame_failed_validation');
}

function centredFrame(usable: PixelRect, maxW: number): PixelRect {
  const w = Math.min(usable.w, maxW);
  const h = Math.min(usable.h, Math.round((w * HERO_ASPECT_H) / HERO_ASPECT_W));
  return {
    x: usable.x + Math.floor((usable.w - w) / 2),
    y: usable.y + Math.floor((usable.h - h) / 2),
    w, h,
  };
}

function finish(plan: Omit<HeroPlan, 'measures'>, zoom: number): HeroPlan {
  const { crop, focal, source } = plan;
  return {
    ...plan,
    measures: {
      trimmed: plan.usable.w < source.width || plan.usable.h < source.height,
      focalWidthShare: focal && plan.mode !== 'fit' ? round3(focal.w / crop.w) : null,
      cropAreaShare: round3((crop.w * crop.h) / (source.width * source.height)),
      zoom: round3(zoom),
    },
  };
}

function intersect(a: PixelRect, b: PixelRect): PixelRect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x, y,
    w: Math.max(1, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(1, Math.min(a.y + a.h, b.y + b.h) - y),
  };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** Thumbnail rectangle → source pixels; `outward` rounds to contain. */
function toSource(r: PixelRect, sx: number, sy: number, SW: number, SH: number, outward = false): PixelRect {
  const x0 = outward ? Math.floor(r.x * sx) : Math.round(r.x * sx);
  const y0 = outward ? Math.floor(r.y * sy) : Math.round(r.y * sy);
  const x1 = Math.min(SW, outward ? Math.ceil((r.x + r.w) * sx) : Math.round((r.x + r.w) * sx));
  const y1 = Math.min(SH, outward ? Math.ceil((r.y + r.h) * sy) : Math.round((r.y + r.h) * sy));
  return { x: Math.max(0, x0), y: Math.max(0, y0), w: x1 - Math.max(0, x0), h: y1 - Math.max(0, y0) };
}

/* ------------------------------------------------------------------------ */
/* 4  Reading a stored plan                                                  */
/* ------------------------------------------------------------------------ */

const isRect = (value: unknown): value is PixelRect => {
  const r = value as Record<string, unknown> | null;
  return !!r && typeof r === 'object'
    && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isInteger(n))
    && (r.w as number) > 0 && (r.h as number) > 0 && (r.x as number) >= 0 && (r.y as number) >= 0;
};
const inside = (inner: PixelRect, outer: PixelRect) =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/**
 * Is this a plan a card may draw? The rules the planner obeys, checked again
 * on what was STORED, because a plan is a claim about pixels and a claim that
 * does not hold is worse than none: the card falls back to the old drawing.
 */
export function validateHeroPlan(value: unknown): value is HeroPlan {
  const plan = value as HeroPlan | null;
  if (!plan || typeof plan !== 'object' || !Number.isInteger(plan.version)) return false;
  if (plan.version < HERO_PLAN_MIN_VERSION || plan.version > HERO_PLAN_MAX_VERSION) return false;
  if (!['original', 'crop', 'fit'].includes(plan.mode)) return false;
  // From v3 a fit names its reason, and only a fit does.
  if (plan.version >= HERO_RESCUE_VERSION) {
    const reason = (plan as { fitReason?: unknown }).fitReason;
    if (plan.mode === 'fit' ? !HERO_FIT_REASONS.includes(reason as HeroFitReason) : reason !== undefined && reason !== null) {
      return false;
    }
  }
  const W = plan.source?.width, H = plan.source?.height;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0) return false;
  const whole = { x: 0, y: 0, w: W, h: H };
  if (!isRect(plan.usable) || !isRect(plan.crop) || !inside(plan.usable, whole)) return false;
  if (!inside(plan.crop, plan.usable) && plan.mode !== 'original') return false;
  if (plan.mode === 'original') {
    return plan.crop.x === 0 && plan.crop.y === 0 && plan.crop.w === W && plan.crop.h === H;
  }
  if (plan.mode === 'fit') {
    return plan.crop.x === plan.usable.x && plan.crop.y === plan.usable.y
      && plan.crop.w === plan.usable.w && plan.crop.h === plan.usable.h;
  }
  // A crop is exactly 16:9 and never cuts the building.
  if (!isHeroAspect(plan.crop.w, plan.crop.h)) return false;
  // A missing focal is the same as a null one: the network's payload composer
  // strips nulls (jsonb_strip_nulls), so a plan arrives at the Command Centre
  // without the key. Reading `undefined` as "a focal that fails" would make
  // one portal refuse a plan the other draws.
  if (plan.focal !== null && plan.focal !== undefined) {
    if (!isRect(plan.focal) || !inside(plan.focal, plan.crop)) return false;
  }
  return true;
}

/** Where a plan is kept on the image row, and where its last failure is. */
export const HERO_PLAN_KEY = 'marketplace_hero';
export const HERO_ATTEMPT_KEY = 'marketplace_hero_attempt';

/** Which object a door signs for an image: the builder's file, or its repair. */
export type HeroServedObject = 'original' | 'derivative';

/** A stored plan: the plan, and the exact bytes it describes. */
export interface StoredHeroPlan {
  plan: HeroPlan;
  /** The object a door signed for this image when the plan was made. */
  object: HeroServedObject;
  /**
   * SHA-256 of that object's bytes — the fingerprint. Not a storage path:
   * the Command Centre's mirror holds no network path (its image row points
   * at the network's door), while the SHA-256 travels in `source_detail` to
   * both ends, so both read the same plan by the same rule.
   */
  sha256: string;
  planned_at: string;
}

/**
 * The fingerprint of an image's ORIGINAL bytes, as the row records it: the
 * stored SHA-256, the source's, or — for rows written before either existed —
 * the SHA-256 the marketplace eligibility measured, which names the same
 * stored bytes. All three travel to the Command Centre in `source_detail`.
 * The planner never trusts it blindly: it hashes the bytes it downloads and
 * plans nothing where they disagree.
 */
export function heroOriginalFingerprint(
  sourceDetail: Record<string, unknown> | null | undefined,
): string | null {
  const detail = sourceDetail ?? {};
  for (const key of ['stored_sha256', 'source_sha256', 'marketplace_measured_sha256']) {
    const value = detail[key];
    if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  }
  return null;
}

/**
 * The plan a card may draw for the object being SERVED, or null.
 *
 * The fingerprint is the whole guard: a plan names the object and the bytes
 * it measured, and the door names the object and the bytes it signs. A
 * builder who replaces the file, a repair that writes a derivative, a
 * re-judgement that switches the door back to the original — each changes
 * one of the two, and each voids the plan here without anybody deleting it.
 * Null means "draw the card as before", never "no picture".
 */
export function heroPlanForServed(
  sourceDetail: Record<string, unknown> | null | undefined,
  served: { object: HeroServedObject; sha256: string | null | undefined },
): HeroPlan | null {
  const stored = (sourceDetail ?? {})[HERO_PLAN_KEY] as StoredHeroPlan | undefined;
  if (!stored || typeof stored !== 'object') return null;
  if (!served.sha256 || typeof stored.sha256 !== 'string') return null;
  if (stored.object !== served.object || stored.sha256 !== served.sha256) return null;
  return validateHeroPlan(stored.plan) ? stored.plan : null;
}

/**
 * How well a plan presents its property, for ONE purpose: breaking a tie
 * between candidates the display rule already ranks equal on evidence. Lower
 * is better. A missing plan ranks with `fit`, so planning can never demote a
 * picture below where it stood before it was planned.
 */
export function heroSuitabilityRank(plan: HeroPlan | null): number {
  if (!plan) return 2;
  if (plan.mode === 'fit' || plan.confidence === 'low') return 2;
  return plan.confidence === 'high' ? 0 : 1;
}
