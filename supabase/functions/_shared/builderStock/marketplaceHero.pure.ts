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

/** Raise when the planner's output for the same pixels would change. */
export const HERO_PLAN_VERSION = 2;

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
 * The building's bounds inside the usable region, in thumbnail pixels.
 *
 * Built on blocks, because a house is a REGION, not a cloud of pixels:
 *
 *   edge-dense blocks  anything textured — walls, roof tiles, trees, paving
 *   structure blocks   those carrying long VERTICAL edges — wall corners,
 *                      window frames, jambs, posts — which lawn noise, sky,
 *                      cloud and perspective paving do not produce
 *
 * The subject is the connected edge-dense region carrying the most structure,
 * joined by any other region of comparable structure at the same height (a
 * garage separated from the house by a plain door). Its TOP is the region's
 * top, which is the roof; its BOTTOM is the lowest STRUCTURE, because what
 * lies below the walls is driveway and lawn — kept where it fits, never a
 * reason to refuse a frame. Every uncertainty widens the box: a box too large
 * costs a tighter frame, a box too small cuts a house.
 */
export function findSubject(
  t: HeroThumbnail, usable: PixelRect,
  /** Optional sink for NUMERIC measurements (profiles, counts) — never pixels. */
  diag?: Record<string, unknown>,
): Subject | null {
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
  let totalStructure = 0;
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      let edges = 0, structs = 0, area = 0;
      for (let y = by * bs; y < Math.min(uh, (by + 1) * bs); y += 1) {
        for (let x = bx * bs; x < Math.min(uw, (bx + 1) * bs); x += 1) {
          area += 1; edges += edge[y * uw + x]; structs += structure[y * uw + x];
        }
      }
      const i = by * cols + bx;
      if (edges / area >= ACTIVE_DENSITY) active[i] = 1;
      if (structs / area >= STRUCTURE_SHARE) { structMass[i] = structs; totalStructure += structs; }
    }
  }

  /*
   * v2 — THE BAND, NOT THE EXTENT. Measured on the 41 live cards
   * (1 October 2026): a real photograph is textured almost everywhere —
   * foliage, render, paving, cloud — so edge-dense blocks form ONE region the
   * size of the frame, and stray vertical edges (posts, trunks, a lamp) sit
   * everywhere. What does not move is the PEAK: the rows a facade's walls,
   * windows and doors occupy carry several times the structure of anything
   * else. So the walls are the band around that peak, and the roof is what
   * stands directly on it.
   */
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
  let bandTop = dense(peak) ? peak : grow(peak, -1);
  let bandBottom = dense(peak) ? peak : grow(peak, 1);
  bandTop = grow(bandTop, -1);
  bandBottom = grow(bandBottom, 1);
  const bandHeight = bandBottom - bandTop + 1;
  let bandMass = 0;
  for (let r = bandTop; r <= bandBottom; r += 1) bandMass += rowS[r];

  // Width: the band's structure columns, 2%–98% of their mass, plus eaves.
  const colS = new Array<number>(cols).fill(0);
  for (let r = bandTop; r <= bandBottom; r += 1) {
    for (let c = 0; c < cols; c += 1) if (structMass[r * cols + c] > 0) colS[c] += 1;
  }
  const quantile = (q: number) => {
    let sum = 0;
    for (let c = 0; c < cols; c += 1) { sum += colS[c]; if (sum >= bandMass * q) return c; }
    return cols - 1;
  };
  const sx0 = quantile(0.02), sx1 = Math.max(sx0, quantile(0.98));
  const eaves = Math.max(1, Math.round((sx1 - sx0 + 1) * 0.1));
  const x0 = Math.max(0, sx0 - eaves), x1 = Math.min(cols - 1, sx1 + eaves);

  // The roof: textured, non-sky rows standing on the band, at most the band's
  // own height. A sky row, or a row flat across the building (an overcast
  // page), ends it — a roof is neither.
  let top = bandTop;
  for (let r = bandTop - 1; r >= 0 && bandTop - r <= bandHeight; r -= 1) {
    if (rowBlue[r] >= 0.4 && rowS[r] === 0) break;
    let textured = 0;
    for (let c = x0; c <= x1; c += 1) if (active[r * cols + c]) textured += 1;
    if (textured === 0) break;
    top = r;
  }
  // The bottom: one row under the lowest wall row; what lies below is soft.
  const bottom = Math.min(rows - 1, bandBottom + 1);

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
  if (diag) Object.assign(diag, { band: [bandTop, bandBottom], roof_top: top, band_share: Math.round((bandMass / structureBlocks) * 100) / 100, x: [x0, x1] });
  return { box, confidence, reasons };
}

/* ------------------------------------------------------------------------ */
/* 3  The frame                                                              */
/* ------------------------------------------------------------------------ */

const shapeOff = (w: number, h: number) => Math.abs(w / h - HERO_ASPECT) / HERO_ASPECT;

/**
 * Plan how a card frames this picture. Never throws for a well-formed
 * thumbnail; returns null only for one with no pixels to read, which the
 * caller records as a failure and leaves the card as it was.
 */
export function planHero(t: HeroThumbnail, diag?: Record<string, unknown>): HeroPlan | null {
  if (!(t.width > 2) || !(t.height > 2) || !(t.sourceWidth > 0) || !(t.sourceHeight > 0)) return null;
  if (!t.pixels || t.pixels.length < t.width * t.height * 3) return null;

  const SW = Math.round(t.sourceWidth), SH = Math.round(t.sourceHeight);
  const sx = SW / t.width, sy = SH / t.height;
  const reasons: string[] = [];

  const u = findUsableRegion(t);
  const trimmed = u.w < t.width || u.h < t.height;
  if (trimmed) reasons.push('canvas_trimmed');
  const usable = toSource(u, sx, sy, SW, SH);

  const subject = findSubject(t, u, diag);
  const focal = subject ? intersect(toSource(subject.box, sx, sy, SW, SH, true), usable) : null;
  const confidence: HeroConfidence = subject?.confidence ?? 'low';
  if (subject) reasons.push(...subject.reasons);
  else reasons.push('no_subject_found');

  const base = { version: HERO_PLAN_VERSION, source: { width: SW, height: SH }, usable, focal: focal };
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

  // Can the building stand in a 16:9 frame at all?
  const maxH = Math.floor((maxW * HERO_ASPECT_H) / HERO_ASPECT_W);
  if (focal.w > maxW) return fit('subject_wider_than_frame');
  if (focal.h > maxH) return fit('subject_taller_than_frame');

  // Breathing room: soft, clipped to the photograph.
  const margin = {
    x0: Math.max(usable.x, focal.x - Math.round(maxW * 0.03)),
    x1: Math.min(usable.x + usable.w, focal.x + focal.w + Math.round(maxW * 0.03)),
    y0: Math.max(usable.y, focal.y - Math.round(maxH * 0.03)),
    y1: Math.min(usable.y + usable.h, focal.y + focal.h + Math.round(maxH * 0.05)),
  };
  const roomW = Math.max(margin.x1 - margin.x0, ((margin.y1 - margin.y0) * HERO_ASPECT_W) / HERO_ASPECT_H);

  let width = maxW;
  if (confidence === 'high' && focal.w / maxW < HERO_TARGET_MIN_SHARE) {
    const floor = Math.max(maxW / HERO_MAX_ZOOM, Math.min(maxW, HERO_MIN_CROP_SOURCE_PX), roomW,
      focal.w / HERO_TARGET_MAX_SHARE);
    width = Math.min(maxW, Math.max(floor, focal.w / HERO_TARGET_MIN_SHARE));
    if (width < maxW) reasons.push('subject_enlarged');
  }
  // 16:9 in whole pixels (to one pixel of rounding), never smaller than the
  // building and never larger than the photograph.
  let cw = Math.min(usable.w, Math.max(Math.round(width), focal.w));
  let ch = Math.round((cw * HERO_ASPECT_H) / HERO_ASPECT_W);
  if (ch > usable.h) { ch = usable.h; cw = Math.round((ch * HERO_ASPECT_W) / HERO_ASPECT_H); }
  if (ch < focal.h) { ch = focal.h; cw = Math.round((ch * HERO_ASPECT_W) / HERO_ASPECT_H); }
  if (cw > usable.w || ch > usable.h || cw < focal.w || ch < focal.h) {
    return fit('subject_does_not_fit_frame');
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

  const crop = { x, y, w: cw, h: ch };
  const plan = finish({ ...base, mode: 'crop', confidence, crop, reasons }, maxW / cw);
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
  if (!plan || typeof plan !== 'object' || plan.version !== HERO_PLAN_VERSION) return false;
  if (!['original', 'crop', 'fit'].includes(plan.mode)) return false;
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
  if (plan.focal !== null) {
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
