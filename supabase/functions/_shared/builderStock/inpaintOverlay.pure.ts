/**
 * Builder stock — the geometry of a masked repair, and the gate that proves it.
 *
 * The deterministic reconstruction in `sanitizeOverlay.pure.ts` refuses when a
 * badge sits over something structured or covers too much of the frame, because
 * solving Laplace's equation across a fifth of a photograph produces a smear
 * and a smear is worse than a blank card. This is what happens next: the same
 * mask, the same original bytes, and a model asked to reconstruct only what was
 * behind it.
 *
 * THE MODEL IS NEVER GIVEN THE PHOTOGRAPH AND NEVER GIVEN THE FRAME. It is
 * given a SQUARE PATCH cut around one overlay region, with enough surrounding
 * photograph to know what it is continuing, and a mask marking the part to
 * rebuild. Three reasons, and all three matter:
 *
 *   The endpoint returns a 1024-square image whatever it is sent. Handing it a
 *   whole 1200x800 photograph means receiving back a re-encoded, re-framed,
 *   re-scaled picture of the entire property — every pixel changed, the
 *   original's dimensions gone, and no way to tell a repaired badge from a
 *   redesigned roof.
 *
 *   A patch keeps the model's influence LOCAL. Whatever it does, it does inside
 *   a square that contains one graphic, and the rest of the builder's
 *   photograph was never in the request at all.
 *
 *   And it makes the guarantee arithmetic rather than a hope. What comes back
 *   is composited onto the original at the mask and nowhere else, so
 *   "everything outside the mask is pixel-identical" is not a property the
 *   model has to respect — it is a property of the compositing, checked
 *   afterwards over the whole frame by `outsidePermittedRegionUnchanged`.
 *
 * THE FEATHER IS THE ONE EXCEPTION AND IT IS TWO PIXELS. A hard mask edge shows
 * as a seam, because the returned patch has been through a different encoder
 * than the builder's file. A narrow linear blend just outside the mask removes
 * it. Those pixels are part of the PERMITTED region and the gate knows it;
 * everything beyond them must match the original byte for byte, and the gate
 * fails the whole repair if a single one does not.
 *
 * Pure: no imports, no IO, no clock, no network.
 */

/** How far outside the mask the boundary may be blended. */
export const FEATHER = 2;

/**
 * How much photograph goes around the graphic, as a share of the SHORT edge.
 *
 * The model is reconstructing a continuation, so it needs to see what it is
 * continuing: sky above and beside the badge, the roofline it interrupts, the
 * render it sits on. Too little and the patch is mostly graphic and the result
 * is invention; too much and the mask becomes a speck in a 1024-square and the
 * detail comes back soft.
 *
 * ADDITIVE, NOT MULTIPLICATIVE, AND PRODUCTION IS WHY. A margin of "twice the
 * graphic" is fine for a badge and absurd for a banner: Lot 13 Hummock Rise
 * carries two 460px pills on a 1200px frame, and at 2x each one demanded a
 * 920px square. The two squares then overlapped, merged, and became a single
 * patch covering the ENTIRE photograph — so the model was handed the whole
 * picture, took one pill off, left the other, and drew timber cladding across
 * a patch of sky. Which is every failure mode the patch design exists to
 * prevent, arrived at by arithmetic.
 */
const CONTEXT_SHARE = 0.2;

/**
 * How much bigger a merge may make a patch before it is not worth making.
 *
 * Merging exists so two overlapping requests do not each rebuild part of the
 * other's work. It is NOT worth turning two local repairs into one global one:
 * past this the squares stay separate and overlap, which the cumulative
 * composite handles correctly — the second request simply sees the first
 * repair as context.
 */
const MERGE_GROWTH = 1.2;

/** Patches smaller than this are enlarged: a tiny crop upscales to mush. */
const MIN_PATCH = 96;

/**
 * A square may run off the edge of the picture, and the overhang is PADDING.
 *
 * THE DEFECT THIS FIXES, FOUND IN PRODUCTION ON LOT 13 HUMMOCK RISE. A patch
 * has to be square, because the endpoint returns a square; the first version
 * also required it to fit INSIDE the frame, so its side was capped at the
 * frame's short edge. A builder's status plates run across the width of a
 * landscape photograph — wider than it is tall — so no square inside the frame
 * could hold them, the coverage check refused the plan, and the card stayed
 * blank. Which is the outcome this whole change exists to end.
 *
 * A square that overhangs costs nothing and gives up nothing. The overhanging
 * pixels are filled by replicating the nearest real edge pixel and are marked
 * NOT editable in the mask, so the model is told to leave them alone; they are
 * never composited back, because `compositePatch` writes only inside the frame
 * and only where the mask allows. The picture the model sees is still made of
 * the builder's own pixels and nothing else.
 *
 * The side is still bounded — by the picture's LONG edge — so a patch can never
 * be larger than the photograph it came from.
 */
const ALLOW_OVERHANG = true;

/**
 * How many separate repairs one photograph may need.
 *
 * Each is a request. A picture carrying more than this many distinct graphics
 * is a marketing tile rather than a photograph with a badge on it, and the
 * honest answer for it is the blank card the display rule already gives.
 */
export const MAX_PATCHES = 4;

export interface Patch {
  x: number;
  y: number;
  /** Square: the endpoint's own output is square, so anything else re-frames. */
  size: number;
}

/** Connected components of a mask, as bounding boxes. */
function components(
  mask: Uint8Array, width: number, height: number,
): Array<{ left: number; top: number; right: number; bottom: number }> {
  const seen = new Uint8Array(mask.length);
  const boxes: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let left = width, right = -1, top = height, bottom = -1;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop() as number;
      const x = at % width;
      const y = (at - x) / width;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x > 0 && mask[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1); }
      if (x + 1 < width && mask[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; stack.push(at + 1); }
      if (y > 0 && mask[at - width] && !seen[at - width]) {
        seen[at - width] = 1; stack.push(at - width);
      }
      if (y + 1 < height && mask[at + width] && !seen[at + width]) {
        seen[at + width] = 1; stack.push(at + width);
      }
    }
    boxes.push({ left, top, right, bottom });
  }
  return boxes;
}

/**
 * Sit a square of the given side over the picture.
 *
 * Slid back inside the frame where it can be, and left overhanging where it
 * cannot — a square wider than the picture is short has nowhere to go, and
 * shrinking it is what dropped coverage. The origin never goes negative, so a
 * patch always starts on a real pixel and the overhang is at the far edge.
 */
function place(
  x: number, y: number, size: number, width: number, height: number,
): Patch {
  return {
    x: Math.max(0, size >= width ? 0 : Math.min(width - size, x)),
    y: Math.max(0, size >= height ? 0 : Math.min(height - size, y)),
    size,
  };
}

/**
 * Where to cut, given the mask the detector produced.
 *
 * One square per graphic, merged where two squares overlap AND the merge still
 * fits — two requests whose patches overlap would each rebuild part of the
 * other's work, and the second composite would land on top of the first with no
 * way to tell which pixel came from where.
 *
 * THE MERGE IS CONDITIONAL BECAUSE A SQUARE HAS A CEILING. A patch cannot be
 * wider than the frame's short edge without leaving the picture, so merging two
 * badges at opposite ends of a wide photograph produces a square that is
 * CLAMPED — and a clamped square covers neither of them. That is not a smaller
 * repair, it is a repair that removes one graphic, silently leaves the other,
 * and hands back something that looks finished. The fixture that found it is
 * the Lot 13 shape: three plates across a 400x200 frame, merged into one
 * 200-square at the origin, two badges untouched. So a merge that would not
 * contain both squares is not performed, and the two stay separate requests.
 *
 * AND THE PLAN IS CHECKED AGAINST THE MASK BEFORE IT IS RETURNED. `uncovered`
 * is true when any masked pixel falls outside every patch, which the caller
 * turns into a refusal. A picture repaired in three of its five places is a
 * picture with marketing on it, served as though it were clean — the same
 * reason `tooMany` refuses rather than truncating.
 */
export function planInpaintPatches(
  mask: Uint8Array, width: number, height: number,
): { patches: Patch[]; tooMany: boolean; uncovered: boolean } {
  if (mask.length !== width * height || width <= 0 || height <= 0) {
    return { patches: [], tooMany: false, uncovered: false };
  }
  const boxes = components(mask, width, height);
  if (!boxes.length) return { patches: [], tooMany: false, uncovered: false };
  // The LONG edge, not the short one. See `ALLOW_OVERHANG`.
  const ceiling = ALLOW_OVERHANG ? Math.max(width, height) : Math.min(width, height);

  let squares = boxes.map((box) => {
    const boxWidth = box.right - box.left + 1;
    const boxHeight = box.bottom - box.top + 1;
    const longest = Math.max(boxWidth, boxHeight);
    const margin = Math.min(longest, Math.round(CONTEXT_SHARE * Math.min(width, height)));
    const size = Math.min(ceiling, Math.max(MIN_PATCH, longest + 2 * margin));
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    return place(Math.round(cx - size / 2), Math.round(cy - size / 2), size, width, height);
  });

  // Merge overlaps until nothing overlaps. Bounded: each pass strictly reduces
  // the count, so this terminates in at most `squares.length` passes.
  for (;;) {
    let merged = false;
    outer: for (let a = 0; a < squares.length; a++) {
      for (let b = a + 1; b < squares.length; b++) {
        const one = squares[a];
        const two = squares[b];
        const overlaps = one.x < two.x + two.size && two.x < one.x + one.size
          && one.y < two.y + two.size && two.y < one.y + one.size;
        if (!overlaps) continue;
        const left = Math.min(one.x, two.x);
        const top = Math.min(one.y, two.y);
        const right = Math.max(one.x + one.size, two.x + two.size);
        const bottom = Math.max(one.y + one.size, two.y + two.size);
        const size = Math.max(right - left, bottom - top);
        // The clamp that would silently drop coverage. See the header.
        if (size > ceiling) continue;
        // And the merge that would turn two local repairs into one global one.
        if (size > Math.max(one.size, two.size) * MERGE_GROWTH) continue;
        squares = squares.filter((_, i) => i !== a && i !== b);
        squares.push(place(left, top, size, width, height));
        merged = true;
        break outer;
      }
    }
    if (!merged) break;
  }

  if (squares.length > MAX_PATCHES) return { patches: [], tooMany: true, uncovered: false };
  // Stable order, so the same picture always produces the same requests.
  squares.sort((a, b) => a.y - b.y || a.x - b.x);

  // Every masked pixel must be inside a patch, or this plan repairs part of a
  // graphic and reports success. Kept even now that a square may overhang: the
  // check is what makes the overhang SAFE to allow rather than a thing to hope
  // about, and it is the only assertion standing between a wide banner and a
  // half-cleaned photograph.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const covered = squares.some((patch) =>
        x >= patch.x && x < patch.x + patch.size
        && y >= patch.y && y < patch.y + patch.size);
      if (!covered) return { patches: [], tooMany: false, uncovered: true };
    }
  }

  return { patches: squares, tooMany: false, uncovered: false };
}

/**
 * Cut RGB pixels out of a frame, replicating the edge where the square
 * overhangs.
 *
 * Edge replication rather than black or grey: a hard border inside the picture
 * handed to the model is a feature it will try to continue, and a black bar
 * beside a roofline is exactly the kind of thing that comes back drawn into the
 * repair. Replication carries the photograph's own colour outward and reads as
 * nothing at all. None of it is ever composited back — see `compositePatch`.
 */
export function cropRgb(
  pixels: Uint8Array, width: number, patch: Patch, height?: number,
): Uint8Array {
  const rows = height ?? Math.floor(pixels.length / 3 / width);
  const out = new Uint8Array(patch.size * patch.size * 3);
  for (let y = 0; y < patch.size; y++) {
    const sy = Math.max(0, Math.min(rows - 1, patch.y + y));
    for (let x = 0; x < patch.size; x++) {
      const sx = Math.max(0, Math.min(width - 1, patch.x + x));
      const from = (sy * width + sx) * 3;
      const to = (y * patch.size + x) * 3;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
    }
  }
  return out;
}

/**
 * Cut a mask out of a frame. The overhang is NOT editable.
 *
 * Zero outside the picture, so the model is told to leave the padding alone —
 * and so that even a model that ignored the instruction changes nothing, since
 * those pixels correspond to no pixel of the photograph.
 */
export function cropMask(
  mask: Uint8Array, width: number, patch: Patch, height?: number,
): Uint8Array {
  const rows = height ?? Math.floor(mask.length / width);
  const out = new Uint8Array(patch.size * patch.size);
  for (let y = 0; y < patch.size; y++) {
    const sy = patch.y + y;
    if (sy < 0 || sy >= rows) continue;
    for (let x = 0; x < patch.size; x++) {
      const sx = patch.x + x;
      if (sx < 0 || sx >= width) continue;
      out[y * patch.size + x] = mask[sy * width + sx];
    }
  }
  return out;
}

/**
 * Bilinear resample of RGB samples.
 *
 * Used in both directions — the patch goes up to the size the endpoint works
 * at, and the answer comes back down to the size the patch actually is. The
 * builder's own pixels never go through this: only the patch handed to the
 * model and the patch it returns, and only inside the mask does either reach
 * the stored picture.
 */
export function resampleRgb(
  pixels: Uint8Array, width: number, height: number, toWidth: number, toHeight: number,
): Uint8Array {
  const out = new Uint8Array(toWidth * toHeight * 3);
  const sx = width / toWidth;
  const sy = height / toHeight;
  for (let y = 0; y < toHeight; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < toWidth; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      const at = (y * toWidth + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = pixels[(y0 * width + x0) * 3 + c];
        const b = pixels[(y0 * width + x1) * 3 + c];
        const d = pixels[(y1 * width + x0) * 3 + c];
        const e = pixels[(y1 * width + x1) * 3 + c];
        out[at + c] = Math.round(
          (a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy);
      }
    }
  }
  return out;
}

/**
 * How strongly a repaired pixel replaces the original one, 0-255.
 *
 * 255 inside the mask, falling linearly to 0 over `FEATHER` pixels outside it,
 * 0 everywhere else. This IS the permitted region: anything the map scores 0
 * is a pixel the repair may not touch, and the gate below checks exactly that.
 */
export function blendWeights(
  mask: Uint8Array, width: number, height: number,
): Uint8Array {
  const weights = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) weights[i] = mask[i] ? 255 : 0;
  let ring = mask;
  for (let step = 1; step <= FEATHER; step++) {
    const next = new Uint8Array(ring);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (ring[at]) continue;
        const touching = (x > 0 && ring[at - 1]) || (x + 1 < width && ring[at + 1])
          || (y > 0 && ring[at - width]) || (y + 1 < height && ring[at + width]);
        if (!touching) continue;
        next[at] = 1;
        weights[at] = Math.round(255 * (1 - step / (FEATHER + 1)));
      }
    }
    ring = next;
  }
  return weights;
}

/**
 * Lay a repaired patch onto the original frame, at the mask and nowhere else.
 *
 * Returns a NEW buffer. The original is not mutated, so the bytes the gate
 * compares against are the bytes that came out of storage.
 */
export function compositePatch(
  base: Uint8Array, width: number, height: number,
  patch: Patch, repaired: Uint8Array, weights: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(base);
  for (let y = 0; y < patch.size; y++) {
    const frameY = patch.y + y;
    if (frameY < 0 || frameY >= height) continue;
    for (let x = 0; x < patch.size; x++) {
      const frameX = patch.x + x;
      if (frameX < 0 || frameX >= width) continue;
      const w = weights[(frameY * width + frameX)];
      if (!w) continue;
      const to = (frameY * width + frameX) * 3;
      const from = (y * patch.size + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[to + c] = Math.round((repaired[from + c] * w + base[to + c] * (255 - w)) / 255);
      }
    }
  }
  return out;
}

/**
 * THE GATE. Is every pixel outside the permitted region still the builder's?
 *
 * Checked over the WHOLE frame rather than over the patches, and against the
 * bytes read from storage rather than against an intermediate — so it catches a
 * bad patch, a bad composite, an off-by-one in the crop, a mis-sized response
 * and a swapped buffer with the same test. It returns the count rather than a
 * boolean because a caller recording a refusal should be able to say how far
 * out it was.
 *
 * Zero is the only passing answer. There is no tolerance parameter and there
 * must never be one: "almost all of the photograph is the builder's" is the
 * claim this exists to make impossible.
 */
export function outsidePermittedRegionUnchanged(
  original: Uint8Array, result: Uint8Array, weights: Uint8Array,
): { ok: boolean; changed: number } {
  if (original.length !== result.length) return { ok: false, changed: original.length };
  let changed = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i]) continue;
    const at = i * 3;
    if (original[at] !== result[at] || original[at + 1] !== result[at + 1]
      || original[at + 2] !== result[at + 2]) changed += 1;
  }
  return { ok: changed === 0, changed };
}

/**
 * How much of the frame the model would be permitted to touch.
 *
 * BARRIER B MEASURES THE FINAL SET, NOT THE REQUEST. The number that matters
 * is not the rectangle somebody asked for, nor the mask the detector drew: it
 * is `weights`, the exact pixels `compositePatch` may write and the exact
 * pixels `outsidePermittedRegionUnchanged` then declines to check. Between the
 * source rectangle and that set sit `growOverlayMask`'s dilation and this
 * module's own FEATHER ring, both of which only ever add area. (The merge of
 * overlapping patches does NOT: it widens what the model is SHOWN, never what
 * may be written, because `compositePatch` gates every pixel on `weights` and
 * `weights` is derived from the mask alone.) A ceiling applied to the request
 * would be a ceiling with a gap in it exactly the width of everything that
 * grows.
 *
 * Counting the permitted set also makes the multi-region case fall out for
 * free: four separate rectangles, individually modest, are one number here.
 *
 * AND THE CEILING BOUNDS HOW MUCH, NEVER WHICH. Inside it the system is free
 * to rebuild the wrong pixels — a wall-sized mask consumes budget exactly as a
 * correct one does — so this number is a blast-radius cap, not evidence that
 * the permitted set is the right set. Region correctness is the mask
 * derivation's burden (`overlayPlate.pure.ts`, which holds every plate to its
 * own text), and the integrity gate below proves containment in the mask, not
 * correctness of it.
 */
export function permittedShare(
  weights: Uint8Array, width: number, height: number,
): number {
  const count = width * height;
  if (count <= 0 || weights.length !== count) return 0;
  let permitted = 0;
  for (let i = 0; i < count; i++) if (weights[i]) permitted += 1;
  return permitted / count;
}
