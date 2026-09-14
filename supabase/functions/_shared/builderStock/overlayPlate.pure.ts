/**
 * Builder stock — finding the STICKER, as opposed to finding a flat colour.
 *
 * WHY THIS EXISTS, AND IT IS THE MOST IMPORTANT THING IN THE REPAIR. The
 * classifier's flat-colour pass answers "is there promotional treatment on this
 * picture", and for that purpose a false positive is cheap: the card shows
 * nothing. The repair asks a different question — "which pixels may I rebuild"
 * — and there a false positive is catastrophic, because rebuilding them
 * REMOVES WHATEVER WAS THERE.
 *
 * Lot 13 Hummock Rise is the proof. Its flat-colour regions, measured on the
 * real production bytes, are: the black garage door (7.5% of the frame), a
 * patch of pale sky (6.7%), and one of the two green status pills (4.5%). The
 * other pill is not a region at all. Repairing that mask took the garage door
 * off a house and left the marketing on it. I have the render; it is a house
 * with timber where its garage used to be.
 *
 * SO THE MASK IS DERIVED FROM THE TYPE, NOT FROM THE COLOUR. A promotional
 * badge is a plate WITH WORDS ON IT. The strict text pass already finds the
 * words, to thresholds fitted so no real photograph trips them; this takes each
 * of those runs, samples the colour immediately around it, and floods that
 * colour outward to find the plate the words sit on. A black garage door has no
 * words on it and is never reached. Neither is sky, a roof or a wall.
 *
 * AND THERE IS A SECOND KIND OF PLATE, WHICH COST FOUR CARDS TO FIND. A badge
 * does not always carry words this detector can read. Cloverton Registered
 * carries "Registered" in 60px type on a green pill, and the strict pass finds
 * ZERO runs on it at every resolution from 400px to full size — so a mask
 * derived from type alone is empty, the repair reports "nothing to remove", and
 * four production cards sat blank while the classifier went on refusing the
 * picture. The pill itself, meanwhile, is exactly the flat region the
 * classifier DID find.
 *
 * What separates that pill from Lot 13's black garage door is not words: it is
 * COLOUR. Measured on the production set, every promotional plate is a
 * chromatic fill — the green pills at 0.54-0.90 saturation, the red at 0.69,
 * Brownsplains' blue at 0.70, Coridale's at 0.70, none below 112 chroma — and
 * the architectural regions are neutral: Lot 537 Kirramingly's white garage
 * door measures 0.045 saturation and 10 chroma, and a black door measures less.
 * That is not a narrow margin to fit a threshold into, it is an order of
 * magnitude, and it has a physical reason: a photoreal render is made of
 * material colours, and a brand badge is a colour chosen so that it cannot be
 * mistaken for one.
 *
 * So a flat region whose fill is chromatic is a plate in its own right. A
 * neutral one never is, whatever its size or position — which is what keeps
 * every garage door, roof, wall, driveway and patch of sky out of the mask.
 *
 * AND IT REFUSES RATHER THAN GUESSES. A run whose surroundings are not one
 * colour has no plate — it is type set straight onto the photograph, and there
 * is no honest extent to remove — so it contributes nothing and the picture
 * keeps its blank card. A flood that runs away into the photograph is refused
 * on the same principle: a plate is small, and something that isn't is not a
 * plate.
 *
 * Pure: no imports, no IO, no clock.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RasterLike {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * How far a pixel's colour may sit from the plate's before it is not the plate.
 *
 * Per channel, on 0-255, summed across the three. A printed plate is one flat
 * colour with anti-aliasing at its edge and JPEG ringing over it; the badges in
 * production sit inside 40 and the photograph around them is hundreds away.
 */
const PLATE_TOLERANCE = 60;

/** How far outside the type the plate colour is sampled from. */
const RING = 3;

/**
 * How much of that ring must be the plate's own colour.
 *
 * Half. Type on a plate has a ring that is nearly all plate, spoiled only by
 * the letters' own anti-aliasing where a descender or a diacritic reaches
 * outside the run's box; type on a photograph has a ring that is the
 * photograph. There is no middle case in the production set, and the gap is
 * wide enough that this number is not delicate.
 */
const RING_AGREEMENT = 0.5;

/**
 * How much bigger than its type a plate may be before it is not a plate.
 *
 * A pill is roughly its text plus a margin. Something ten times its type is a
 * wall the flood escaped into, and the run is refused rather than the wall
 * being rebuilt.
 */
const MAX_PLATE_TO_TEXT = 10;

/** And an absolute ceiling, as a share of the picture. */
const MAX_PLATE_SHARE = 0.2;

/**
 * How chromatic a flat region's fill must be before it is a badge and not a
 * building.
 *
 * TWO NUMBERS AND BOTH MUST HOLD, because either alone has a failure mode: a
 * near-black pixel can post a high saturation off a chroma of three, and a pale
 * wash can post a chroma of sixty off almost no saturation. Requiring both is
 * what makes this a statement about a COLOUR rather than about an arithmetic
 * artefact of one.
 *
 * Fitted against the production set, and deliberately not fitted tightly. The
 * promotional plates measure 0.54-0.90 saturation and 112-174 chroma; the
 * architectural regions measure 0.045 and 10. These sit between the two, far
 * enough from the badges that a duller brand colour still reads as one, and far
 * enough from the architecture that a warm white or a beige render never does.
 *
 * SATURATION IS HSV's — (max - min) / max — and chroma is (max - min) on 0-255,
 * both taken on the region's MEAN fill. The mean is right here and the mode is
 * right in `plateAround`: there, a stray sky pixel in a ring would poison an
 * average; here, the region is already known to be one flat colour, and its
 * average is that colour.
 */
const MIN_PLATE_SATURATION = 0.35;
const MIN_PLATE_CHROMA = 60;

/** A region's mean fill, and the two numbers that say whether it is a colour. */
export interface RegionFill {
  r: number;
  g: number;
  b: number;
  saturation: number;
  chroma: number;
}

/** The mean colour inside a box, with its saturation and chroma. */
export function regionFill(view: RasterLike, box: Box): RegionFill | null {
  const { width, height, pixels } = view;
  const left = Math.max(0, Math.min(width - 1, box.left));
  const right = Math.max(0, Math.min(width - 1, box.right));
  const top = Math.max(0, Math.min(height - 1, box.top));
  const bottom = Math.max(0, Math.min(height - 1, box.bottom));
  if (right < left || bottom < top) return null;
  if (pixels.length < width * height * 3) return null;

  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const at = (y * width + x) * 3;
      sr += pixels[at];
      sg += pixels[at + 1];
      sb += pixels[at + 2];
      n += 1;
    }
  }
  if (!n) return null;
  const r = sr / n, g = sg / n, b = sb / n;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  return { r, g, b, chroma, saturation: max <= 0 ? 0 : chroma / max };
}

/**
 * Is this fill a brand colour rather than a building material?
 *
 * The whole of the colour rule, in one place, so the mask and the clearance
 * cannot come to different conclusions about the same region — one deciding
 * there is a badge to remove while the other decides the picture is clean would
 * be the worst outcome available here.
 */
export function isPromotionalFill(fill: RegionFill | null): boolean {
  if (!fill) return false;
  return fill.saturation >= MIN_PLATE_SATURATION && fill.chroma >= MIN_PLATE_CHROMA;
}

/**
 * The flat regions whose fill is a brand colour, small enough to be a badge.
 *
 * The size ceiling is the same one a flooded plate is held to: something a
 * fifth of the picture is not a sticker, and rebuilding it would be rebuilding
 * the picture.
 */
export function promotionalRegions(view: RasterLike, regions: Box[]): Box[] {
  const count = view.width * view.height;
  if (count <= 0) return [];
  return (regions ?? []).filter((box) => {
    const area = (box.right - box.left + 1) * (box.bottom - box.top + 1);
    if (area <= 0 || area > MAX_PLATE_SHARE * count) return false;
    return isPromotionalFill(regionFill(view, box));
  });
}

/**
 * The plates the given lines of type are set on.
 *
 * `textBoxes` comes from the strict pass in `marketingOverlay.pure.ts` — the
 * same runs the verdict counted, so this can only ever remove something that
 * pass called prominent overlay typography.
 */
export function overlayPlateMask(
  view: RasterLike, textBoxes: Box[], flatRegions: Box[] = [],
): { mask: Uint8Array; plates: Box[] } {
  const { width, height, pixels } = view;
  const count = width * height;
  const mask = new Uint8Array(Math.max(0, count));
  const plates: Box[] = [];
  if (count <= 0 || pixels.length < count * 3) return { mask, plates };

  const paint = (plate: Box) => {
    plates.push(plate);
    for (let y = plate.top; y <= plate.bottom; y++) {
      for (let x = plate.left; x <= plate.right; x++) mask[y * width + x] = 1;
    }
  };

  for (const text of textBoxes) {
    /*
     * TWO WAYS TO FIND THE STICKER, AND BOTH REQUIRE THE TYPE.
     *
     * The flood is the better one — it finds the plate's real extent, including
     * the parts of it the classifier's flat-colour pass split or missed. But a
     * plate that is translucent, or gradient-filled, or printed over a busy
     * enough photograph, has no single colour to flood, and refusing those
     * outright cost four production repairs that the flat pass had found
     * perfectly well.
     *
     * So where the flood cannot settle it, a flat region that FULLY CONTAINS
     * the run of type is accepted instead. The containment is what keeps this
     * honest: the region has words printed on it, which a black garage door
     * does not — on Lot 13 Hummock Rise this admits the green pill and
     * excludes both the garage door and the patch of sky, because neither has a
     * line of type inside it.
     */
    const plate = plateAround(pixels, width, height, text)
      ?? flatRegionAround(text, flatRegions, count);
    if (!plate) continue;
    paint(plate);
  }

  /*
   * AND THE BADGES THAT CARRY NO READABLE WORDS.
   *
   * Added last and only where the type found nothing, so a plate the flood
   * settled is never widened by a coarser region containing it — the flood's
   * extent is the better one and it wins wherever it exists.
   *
   * A region already inside the mask is skipped rather than added twice: the
   * same pill can be both a flooded plate and a flat region, and a duplicate
   * would inflate `plates.length`, which is what the deterministic route counts
   * to decide how much of the picture it is being asked to rebuild.
   */
  for (const region of promotionalRegions(view, flatRegions)) {
    const cy = Math.min(height - 1, Math.max(0, (region.top + region.bottom) >> 1));
    const cx = Math.min(width - 1, Math.max(0, (region.left + region.right) >> 1));
    if (mask[cy * width + cx]) continue;
    paint(region);
  }

  return { mask, plates };
}

/**
 * The smallest flat block that has this line of type printed inside it.
 *
 * HELD TO THE SAME PLATE-TO-TEXT RATIO AS THE FLOOD. This path used to check
 * containment and the share ceiling only, which left the one self-consistent
 * wrong repair constructible: a small caption printed on a large flat area of
 * the render — a wall, a driveway, a banded sky — where the flood cannot
 * settle a plate colour, so the fallback accepted the WHOLE flat area as the
 * plate. Every later gate then agreed with itself: the grown mask is the
 * permitted set, Barrier B passes at a fifth of the frame, the integrity gate
 * inspects only the pixels the compositor declined to write, and a fifth of
 * the house is rebuilt with every check reporting success. A pill is roughly
 * its text plus a margin, whichever instrument found it; something ten times
 * its type is the picture, and the run is refused rather than the wall being
 * rebuilt — the same rule, the same constant, as `plateAround`'s own ceiling.
 */
function flatRegionAround(text: Box, regions: Box[], count: number): Box | null {
  const textArea = (text.right - text.left + 1) * (text.bottom - text.top + 1);
  if (textArea <= 0) return null;
  let best: Box | null = null;
  for (const region of regions) {
    if (region.left > text.left || region.top > text.top) continue;
    if (region.right < text.right || region.bottom < text.bottom) continue;
    const area = (region.right - region.left + 1) * (region.bottom - region.top + 1);
    if (area > MAX_PLATE_SHARE * count) continue;
    if (area > MAX_PLATE_TO_TEXT * textArea) continue;
    if (!best) { best = region; continue; }
    const bestArea = (best.right - best.left + 1) * (best.bottom - best.top + 1);
    if (area < bestArea) best = region;
  }
  return best;
}

/** The plate one run of type sits on, or null when it sits on the photograph. */
function plateAround(
  pixels: Uint8Array, width: number, height: number, text: Box,
): Box | null {
  const textWidth = text.right - text.left + 1;
  const textHeight = text.bottom - text.top + 1;
  if (textWidth <= 0 || textHeight <= 0) return null;

  /*
   * THE COLOUR IS SAMPLED FROM A RING JUST OUTSIDE THE TYPE.
   *
   * Outside, because inside is the letters; just outside, because that is the
   * only place guaranteed to be plate if a plate exists at all. The mode of a
   * coarsely quantised colour rather than the mean: a mean of green plate and
   * one stray sky pixel is neither.
   */
  const tally = new Map<number, { n: number; r: number; g: number; b: number }>();
  const ring: number[] = [];
  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (x >= text.left && x <= text.right && y >= text.top && y <= text.bottom) return;
    const at = (y * width + x) * 3;
    ring.push(at);
    const key = ((pixels[at] >> 4) << 8) | ((pixels[at + 1] >> 4) << 4) | (pixels[at + 2] >> 4);
    const entry = tally.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n += 1;
    entry.r += pixels[at];
    entry.g += pixels[at + 1];
    entry.b += pixels[at + 2];
    tally.set(key, entry);
  };
  for (let step = 1; step <= RING; step++) {
    for (let x = text.left - step; x <= text.right + step; x++) {
      sample(x, text.top - step);
      sample(x, text.bottom + step);
    }
    for (let y = text.top - step; y <= text.bottom + step; y++) {
      sample(text.left - step, y);
      sample(text.right + step, y);
    }
  }
  if (!tally.size) return null;

  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const entry of tally.values()) if (!best || entry.n > best.n) best = entry;
  if (!best || !ring.length) return null;
  const plate = [best.r / best.n, best.g / best.n, best.b / best.n];

  /*
   * THE RING HAS TO AGREE WITH ITSELF, AND AGREEMENT IS MEASURED BY COLOUR
   * DISTANCE RATHER THAN BY BUCKET.
   *
   * Type set straight onto a photograph is surrounded by whatever the
   * photograph is doing, which is many colours; a plate is one. The obvious
   * test — "is the commonest bucket most of the ring" — is wrong, and Lot 13
   * proved it: the ring around "Completed" is unmistakably the pill's green,
   * and the coarse buckets split it across shades by the letters' own
   * anti-aliasing and the JPEG ringing over them, leaving the commonest at 43%.
   * What is actually being asked is whether the ring is CLOSE TO one colour, so
   * that is what is counted.
   */
  let agreeing = 0;
  for (const at of ring) {
    if (Math.abs(pixels[at] - plate[0]) + Math.abs(pixels[at + 1] - plate[1])
      + Math.abs(pixels[at + 2] - plate[2]) <= PLATE_TOLERANCE) agreeing += 1;
  }
  if (agreeing / ring.length < RING_AGREEMENT) return null;

  /*
   * Flood that colour outward, unbounded except by the colour itself and by
   * the ceilings below. A plate stops at its own edge, which is what makes a
   * flood the right instrument; a colour that does not stop is not a plate and
   * the run is refused.
   */
  const count = width * height;
  const seen = new Uint8Array(count);
  const stack: number[] = [];
  const near = (index: number) => {
    const at = index * 3;
    return Math.abs(pixels[at] - plate[0]) + Math.abs(pixels[at + 1] - plate[1])
      + Math.abs(pixels[at + 2] - plate[2]) <= PLATE_TOLERANCE;
  };
  for (let step = 1; step <= RING; step++) {
    for (let x = text.left - step; x <= text.right + step; x++) {
      for (const y of [text.top - step, text.bottom + step]) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const index = y * width + x;
        if (seen[index] || !near(index)) continue;
        seen[index] = 1;
        stack.push(index);
      }
    }
  }
  if (!stack.length) return null;

  const ceiling = Math.min(
    Math.round(MAX_PLATE_SHARE * count),
    MAX_PLATE_TO_TEXT * textWidth * textHeight,
  );
  let area = 0;
  let left = text.left;
  let right = text.right;
  let top = text.top;
  let bottom = text.bottom;
  while (stack.length) {
    const index = stack.pop() as number;
    area += 1;
    if (area > ceiling) return null;
    const x = index % width;
    const y = (index - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
    const neighbours = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ];
    for (const n of neighbours) {
      if (n < 0 || seen[n] || !near(n)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }

  /*
   * The plate's BOUNDING BOX, including the type it carries.
   *
   * A rounded pill's corners are photograph, and they are rebuilt with the rest
   * — a few pixels of sky continued through a corner, rather than a green
   * fringe left behind where the sticker was. Leaving the fringe is the one
   * artefact that makes a repair obvious.
   */
  const plateBox = { left, top, right, bottom };
  const plateArea = (right - left + 1) * (bottom - top + 1);
  if (plateArea > MAX_PLATE_SHARE * count) return null;
  return plateBox;
}
