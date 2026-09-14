/**
 * Builder stock — taking the marketing sticker off the builder's own photograph.
 *
 * THE PICTURE IS THE BUILDER'S AND STAYS THE BUILDER'S. This removes a graphic
 * that was laid ON TOP of a photograph and rebuilds only what that graphic was
 * covering. It is not a generator: nothing here invents a house, and there is
 * no model, no network call and no randomness anywhere in it. The same bytes in
 * produce the same bytes out, on any runtime, for ever.
 *
 * HOW THE HOLE IS FILLED. The overlay's own pixels are discarded and replaced
 * by solving Laplace's equation across the hole with the surrounding
 * photograph as the boundary condition — the smoothest surface that meets the
 * real pixels at every edge of the patch. On sky, render gradients, grass and
 * roof sheeting, which is where builders put these badges, that reconstruction
 * is what was behind them to within a shade. It is seeded by pushing the
 * nearest real pixel inward first so the relaxation starts from something
 * plausible rather than from grey, which is what stops a large patch settling
 * into a visible flat blob.
 *
 * AND IT REFUSES WHEN IT WOULD BE GUESSING. Diffusion reconstructs a smooth
 * field, so it is right exactly when the covered area was smooth and wrong when
 * the badge sat across a window, a roofline or a tree. `boundaryDetail`
 * measures how busy the real pixels immediately around the hole are, and a
 * patch whose surroundings are structured is REFUSED rather than smeared:
 * a plausible-looking wrong facade is worse than no photograph, because nobody
 * can tell it happened. That refusal is reported, never silently swallowed.
 *
 * WHAT IT WILL NOT DO. It does not crop, it does not scale, it does not
 * recolour, it does not touch a pixel outside the mask, and it does not run at
 * all on a picture the detector called clean. Everything outside the removed
 * graphic is the builder's original pixel, unchanged, and a test asserts that
 * byte for byte.
 */

import { MAX_REPAIRED_SHARE } from './repairRegion.pure.ts';

/**
 * How far the mask is grown before filling, IN THUMBNAIL PIXELS.
 *
 * A badge is composited with soft edges, so the pixels just outside the
 * detector's region are a blend of graphic and photograph. Leaving them behind
 * draws a ghost outline exactly where the badge was — the one artefact that
 * makes a repair obvious.
 *
 * THREE IS NOT THE EFFECTIVE RADIUS AT PRODUCTION SIZE. The mask was measured
 * on a 400px reduction and `growOverlayMask` grows it by `EDGE_GROW` TIMES THE
 * SCALE — one thumbnail pixel of badge edge lands several full-resolution
 * pixels wide, so the anti-aliasing does too. On a 1200px cover the dilation
 * radius is 9 full-resolution pixels; at 2048px it is 15; at 4000px it is 30.
 * Reading "three pixels" as the geometry of a production repair understates it
 * by an order of magnitude, and a test pins the scaled behaviour.
 */
const EDGE_GROW = 3;

/**
 * How busy the surroundings may be before the fill is refused.
 *
 * Mean absolute neighbour difference of the real pixels within `EDGE_GROW * 2`
 * of the hole, on 0-255. Sky and render gradients sit in the low single
 * figures; a roofline, a window frame or foliage runs far above this. Fitted
 * against the production covers rather than picked: the badges this exists to
 * remove sit on flat ground, and the ones that do not are the ones where a
 * diffusion fill would invent architecture.
 */
const MAX_BOUNDARY_DETAIL = 6;

/**
 * And how far the surroundings may be from ONE colour.
 *
 * Mean absolute deviation of the ring's pixels from the ring's own mean, on
 * 0-255. This is the measure that matters and it took a bad render to find.
 *
 * WHAT THE DETAIL TEST MISSES. Laplace's equation interpolates between the
 * boundary values, so a hole whose ring is all one colour fills invisibly and a
 * hole with two very different colours on opposite sides fills with a RAMP
 * between them — a visible streak, exactly the shape of the hole. Both rings
 * can be locally smooth, so the neighbour-difference test says nothing about
 * it: measured on the real bytes, Lot 13 Hummock Rise scores 2.46 and the
 * Brownsplains badge scores 3.18, and Lot 13 is the one that came out as two
 * grey smears while Brownsplains is indistinguishable from an unbadged render.
 *
 * On THIS measure they are 41.8 and 22.0. Lot 13's badges lie across sky on one
 * side and dark timber cladding on the other; the Brownsplains badge lies on
 * open sky. Thirty sits in the middle of a gap that is nearly twice as wide as
 * either value's distance from it.
 *
 * A picture refused here still reaches the generative route, which does not
 * interpolate and does not care that the two sides differ.
 */
const MAX_BOUNDARY_SPREAD = 30;

/**
 * And how big any ONE hole may be.
 *
 * A second gate because the first is not sufficient: a badge can sit on quiet
 * enough surroundings to pass the detail test and still be too big to fill,
 * because what makes a diffusion read as a smear is the distance from the
 * middle of the hole to the nearest real pixel.
 *
 * PER REGION, NOT PER PICTURE, AND THE FIRST VERSION HAD THIS WRONG. It capped
 * the TOTAL, on the evidence that Lot 13 Hummock Rise "covers 23% of the frame
 * between its badges" — but that 23% was measured against a mask which has
 * since been shown to be wrong, one that included the house's black garage door
 * and a patch of sky. Its two actual badges are 6.2% each. Two small holes at
 * opposite ends of a photograph are two small reconstructions; summing them
 * describes nothing about either.
 *
 * Fitted against the real covers: the Brownsplains badge (7.6% of the frame,
 * detail 2.9, sitting on open sky) is removed so completely that the result is
 * indistinguishable from an unbadged render, while the Cloverton "Registered"
 * pill (2.8% but detail 11.2, sitting over a tree) is refused for the detail
 * test rather than this one.
 */
const MAX_REGION_SHARE = 0.10;

/** Relaxation sweeps. Enough for the patch sizes a badge produces. */
const SWEEPS = 96;

export interface SanitizeInput {
  /** The picture at the size the builder supplied it. */
  width: number;
  height: number;
  /** RGB triples, row-major. Not mutated. */
  pixels: Uint8Array;
  /**
   * WHERE THE STICKER IS, one byte per pixel, at the size it was measured.
   *
   * From `overlayPlate.pure.ts`, which derives it from the lines of type the
   * classifier found rather than from flat colour. That distinction is the most
   * important one in the repair: a flat-colour mask on Lot 13 Hummock Rise
   * covered the black garage door and a patch of sky and missed one of the two
   * badges, and repairing it took the garage door off the house.
   *
   * MEASURED ON THE THUMBNAIL AND SCALED UP, NOT MEASURED AGAIN HERE, and that
   * is not a shortcut — it is the only correct order. Every threshold in the
   * detector is fitted against the 400px reduction; measured at 1200px the
   * Lot 13 badges were not found at all while the sky around them was.
   */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  /** How many separate stickers that mask represents, for the record. */
  regions: number;
}

export type SanitizeResult =
  | {
    ok: true;
    width: number;
    height: number;
    /** A new buffer: the original is left exactly as it came in. */
    pixels: Uint8Array;
    /** How much of the picture was rebuilt, as a share. */
    repairedShare: number;
    regionsRemoved: number;
    boundaryDetail: number;
  }
  | {
    ok: false;
    reason: 'nothing_to_remove' | 'background_too_detailed' | 'too_much_to_rebuild'
      | 'unusable_input';
  };

/** Grow the mask so the graphic's soft edge goes with it. */
function grow(mask: Uint8Array, width: number, height: number, by: number): Uint8Array {
  let current = mask;
  for (let pass = 0; pass < by; pass++) {
    const next = new Uint8Array(current);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (current[at]) continue;
        if ((x > 0 && current[at - 1])
          || (x + 1 < width && current[at + 1])
          || (y > 0 && current[at - width])
          || (y + 1 < height && current[at + width])) next[at] = 1;
      }
    }
    current = next;
  }
  return current;
}

/**
 * How structured the real photograph is immediately around the hole.
 *
 * Measured on the pixels that will BE the boundary condition, because those are
 * the ones the reconstruction has to agree with. A high number means the fill
 * would be interpolating across detail it cannot know.
 *
 * THE RING IS SIX FULL-RESOLUTION PIXELS AND DOES NOT SCALE, while the
 * dilation it surrounds does (`EDGE_GROW * spread` in `growOverlayMask`). That
 * is an inconsistency, and it is deliberately left standing: the thresholds
 * below (`MAX_BOUNDARY_DETAIL`, `MAX_BOUNDARY_SPREAD`) were fitted against
 * real 1200px covers, where the ring was already 6px around a 9px dilation.
 * Scaling the ring would change what both measures read on every production
 * image and would un-fit both constants; do not "fix" this without refitting
 * them against the same covers.
 */
function boundaryDetail(
  pixels: Uint8Array, mask: Uint8Array, width: number, height: number,
): { detail: number; spread: number } {
  const near = grow(mask, width, height, EDGE_GROW * 2);
  let total = 0;
  let n = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let ring = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      // The ring: close to the hole, but real photograph rather than graphic.
      if (!near[at] || mask[at]) continue;
      const p = at * 3;
      sumR += pixels[p];
      sumG += pixels[p + 1];
      sumB += pixels[p + 2];
      ring += 1;
      for (const step of [3, width * 3]) {
        total += Math.abs(pixels[p] - pixels[p + step])
          + Math.abs(pixels[p + 1] - pixels[p + step + 1])
          + Math.abs(pixels[p + 2] - pixels[p + step + 2]);
        n += 3;
      }
    }
  }
  if (!ring) return { detail: 0, spread: 0 };
  const meanR = sumR / ring;
  const meanG = sumG / ring;
  const meanB = sumB / ring;
  let deviation = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      if (!near[at] || mask[at]) continue;
      const p = at * 3;
      deviation += Math.abs(pixels[p] - meanR) + Math.abs(pixels[p + 1] - meanG)
        + Math.abs(pixels[p + 2] - meanB);
    }
  }
  return { detail: n ? total / n : 0, spread: deviation / ring / 3 };
}

/**
 * Rebuild the masked pixels from the photograph around them.
 *
 * Two stages, and both matter. The push-in seeds every hole pixel with the
 * nearest real colour so the relaxation starts near the answer; the sweeps then
 * average each hole pixel against its four neighbours, which is Laplace's
 * equation solved by Gauss-Seidel and reads, on a picture, as the surrounding
 * gradient continued through the gap.
 */
function diffuse(
  source: Uint8Array, mask: Uint8Array, width: number, height: number,
): Uint8Array {
  const out = new Uint8Array(source);

  // Stage one: march the nearest real colour inward, four directions, so no
  // hole pixel begins from nothing however wide the patch is.
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) filled[i] = mask[i] ? 0 : 1;
  const sweep = (xs: number[], ys: number[]) => {
    for (const y of ys) {
      for (const x of xs) {
        const at = y * width + x;
        if (filled[at]) continue;
        const neighbours = [
          x > 0 ? at - 1 : -1,
          x + 1 < width ? at + 1 : -1,
          y > 0 ? at - width : -1,
          y + 1 < height ? at + width : -1,
        ];
        for (const n of neighbours) {
          if (n < 0 || !filled[n]) continue;
          out[at * 3] = out[n * 3];
          out[at * 3 + 1] = out[n * 3 + 1];
          out[at * 3 + 2] = out[n * 3 + 2];
          filled[at] = 1;
          break;
        }
      }
    }
  };
  const forwardX = Array.from({ length: width }, (_, i) => i);
  const forwardY = Array.from({ length: height }, (_, i) => i);
  const backX = [...forwardX].reverse();
  const backY = [...forwardY].reverse();
  sweep(forwardX, forwardY);
  sweep(backX, backY);
  sweep(forwardX, backY);
  sweep(backX, forwardY);

  // Stage two: relax. Only masked pixels move; the photograph holds the edges.
  for (let pass = 0; pass < SWEEPS; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (!mask[at]) continue;
        const p = at * 3;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          if (x > 0) { sum += out[p - 3 + c]; n++; }
          if (x + 1 < width) { sum += out[p + 3 + c]; n++; }
          if (y > 0) { sum += out[p - width * 3 + c]; n++; }
          if (y + 1 < height) { sum += out[p + width * 3 + c]; n++; }
          if (n) out[p + c] = Math.round(sum / n);
        }
      }
    }
  }
  return out;
}

/** The area of the biggest connected hole, which is what a fill has to cross. */
function largestRegion(mask: Uint8Array, width: number, height: number): number {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let largest = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop() as number;
      area += 1;
      const x = at % width;
      const y = (at - x) / width;
      if (x > 0 && mask[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1); }
      if (x + 1 < width && mask[at + 1] && !seen[at + 1]) {
        seen[at + 1] = 1; stack.push(at + 1);
      }
      if (y > 0 && mask[at - width] && !seen[at - width]) {
        seen[at - width] = 1; stack.push(at - width);
      }
      if (y + 1 < height && mask[at + width] && !seen[at + width]) {
        seen[at + width] = 1; stack.push(at + width);
      }
    }
    if (area > largest) largest = area;
  }
  return largest;
}

/**
 * The detector's mask, on the builder's own pixels.
 *
 * Scaled up from the thumbnail it was measured at — see `SanitizeInput.overlay`
 * for why it is never re-measured here — and then grown BY THE SCALE: one
 * thumbnail pixel is several here, so the edge of the badge lands that much
 * less precisely and the ghost outline would be that much wider.
 *
 * Shared with the generative route in `inpaintOverlay.ts`, which is the point
 * of it being a function. THE TWO ROUTES MUST REPAIR EXACTLY THE SAME PIXELS:
 * one of them refuses and hands over to the other, and a mask that differed
 * between them would mean the fallback rebuilding a different area from the one
 * that was judged too hard to rebuild.
 */
export function growOverlayMask(
  source: Uint8Array,
  maskWidth: number, maskHeight: number, width: number, height: number,
): Uint8Array | null {
  const count = width * height;
  if (count <= 0 || maskWidth <= 0 || maskHeight <= 0) return null;
  if (source.length !== maskWidth * maskHeight) return null;

  const scaleX = maskWidth / width;
  const scaleY = maskHeight / height;
  const scaled = new Uint8Array(count);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(maskHeight - 1, Math.floor(y * scaleY));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(maskWidth - 1, Math.floor(x * scaleX));
      scaled[y * width + x] = source[sy * maskWidth + sx];
    }
  }
  const spread = Math.max(1, Math.round(Math.max(width / maskWidth, height / maskHeight)));
  return grow(scaled, width, height, EDGE_GROW * spread);
}

/**
 * Take the graphic off, or say why not.
 *
 * The mask comes from the detector that refused the picture, so this can only
 * ever remove something that pass called a laid-over graphic.
 */
export function sanitizeOverlay(input: SanitizeInput): SanitizeResult {
  const { width, height, pixels, maskWidth, maskHeight } = input;
  const count = width * height;
  if (count <= 0 || pixels.length < count * 3) return { ok: false, reason: 'unusable_input' };
  let source = 0;
  for (let i = 0; i < input.mask.length; i++) source += input.mask[i];
  if (!source) return { ok: false, reason: 'nothing_to_remove' };

  const mask = growOverlayMask(input.mask, maskWidth, maskHeight, width, height);
  if (!mask) return { ok: false, reason: 'unusable_input' };
  let masked = 0;
  for (let i = 0; i < count; i++) masked += mask[i];
  if (!masked) return { ok: false, reason: 'nothing_to_remove' };

  const repairedShare = masked / count;
  if (largestRegion(mask, width, height) / count > MAX_REGION_SHARE) {
    // One hole too wide to fill, however quiet its edges are.
    return { ok: false, reason: 'too_much_to_rebuild' };
  }
  /*
   * AND A CEILING ON THE TOTAL, THE SAME ONE EVERY OTHER ROUTE ANSWERS TO.
   *
   * The per-region cap above is about what a diffusion can FILL; it says
   * nothing about how much of the picture is being replaced in aggregate, and
   * `overlayPlateMask` has no cap on plate count — N separate modest holes are
   * N × their share with no gate here at all. The generative route refuses
   * this at Barrier B before its first model call, and the serving gate
   * refuses any derivative whose recorded share exceeds the ceiling — so
   * without this check the smear is computed, written to storage, and only
   * then discovered to be unservable, which is the paid-for blank card this
   * area exists to avoid. Refused up front instead, with the same terminal
   * reason the generative route records.
   */
  if (repairedShare > MAX_REPAIRED_SHARE) {
    return { ok: false, reason: 'too_much_to_rebuild' };
  }

  const boundary = boundaryDetail(pixels, mask, width, height);
  if (boundary.detail > MAX_BOUNDARY_DETAIL || boundary.spread > MAX_BOUNDARY_SPREAD) {
    /*
     * The badge is sitting on the building, in a tree, or across the join
     * between two very different things. Reconstructing here would be inventing
     * what it covered — and it looks like it, too: a busy ring smears and a
     * two-coloured ring ramps.
     */
    return { ok: false, reason: 'background_too_detailed' };
  }

  return {
    ok: true,
    width,
    height,
    pixels: diffuse(pixels, mask, width, height),
    repairedShare,
    regionsRemoved: input.regions,
    boundaryDetail: boundary.detail,
  };
}
