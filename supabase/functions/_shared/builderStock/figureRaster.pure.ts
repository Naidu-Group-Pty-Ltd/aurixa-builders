/**
 * ===========================================================================
 * BUILDER STOCK — A SMALL PICTURE OF A TABLE, MADE READABLE TO RECOGNITION.
 * ===========================================================================
 *
 * The area schedule a package brochure prints as a picture is small — the
 * production `Lot 101 - PICO` raster is 231 x 166 pixels drawn across 151 x
 * 109 points, about 110 dpi — and it is a TABLE: every row and column is ruled.
 * Recognition was measured on it (23 September 2026, the product's own
 * Tesseract and language model) and the rules are what defeat it. Read at its
 * own pixels it recognises the heading and little else; enlarged, the rules
 * are read as letters (`cour [wom`, `owELLNG tozss`) and the rows dissolve.
 * With the rules taken out first, the same pictures read every row, in every
 * enlargement and threshold tried.
 *
 * So, and only so:
 *
 *   1. GREY. Colour carries nothing a figure needs.
 *   2. ENLARGED TO ABOUT 300 DPI AT THE SIZE THE PAGE PRINTS IT, which is the
 *      density recognition is built for. The factor comes from the picture's
 *      own drawn width where the page states it, never from a guess about the
 *      text, and it is bounded both ways — nothing is shrunk, nothing is
 *      enlarged past four times or past four megapixels.
 *   3. THE RULES REMOVED. A rule is a run of dark pixels longer than any
 *      letter could make: a horizontal run across 40% of the picture's width,
 *      or a vertical one down 40% of its height. Those pixels, and the
 *      one-pixel antialiased edge either side of them, are painted white.
 *      Letters are left exactly as they were: nothing is sharpened, thinned or
 *      thickened, because recognition's own thresholding is better at letters
 *      than anything written here.
 *
 * What comes out is still only pixels. What they SAY is decided by
 * recognition, and whether that is believed is decided by the picture's own
 * arithmetic (`areaSchedulePicture.pure.ts`).
 *
 * Pure: no IO, no clock.
 */

/** Recognition's native density. */
const TARGET_DPI = 300;
/** Enlargement is bounded: past this a picture is already dense enough. */
const MAX_SCALE = 4;
/** And bounded by what it costs to recognise. */
const MAX_OUTPUT_PIXELS = 4_000_000;
/** A run this share of the picture's span is a rule, not a letter. */
const RULE_SPAN = 0.4;

export interface GreyRaster {
  width: number;
  height: number;
  /** One byte per pixel, 0 black to 255 white, row-major. */
  pixels: Uint8Array;
}

/** RGB (three bytes per pixel, row-major) to grey. */
export function toGrey(rgb: Uint8Array, width: number, height: number): GreyRaster {
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    pixels[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
  }
  return { width, height, pixels };
}

/**
 * How much to enlarge a picture so it reaches recognition at about 300 dpi.
 *
 * `drawnWidthPt` is the width the page prints it at, in points. Where the page
 * does not state it the picture is taken to be printed at the density its
 * pixels suggest for a small inset — enlarged three times below 250 pixels
 * tall, twice below 500, and not at all above.
 */
export function recognitionScale(
  pixels: { width: number; height: number },
  drawnWidthPt: number | null | undefined,
): number {
  let scale: number;
  if (drawnWidthPt && drawnWidthPt > 0 && pixels.width > 0) {
    const dpi = pixels.width / (drawnWidthPt / 72);
    scale = TARGET_DPI / dpi;
  } else {
    scale = pixels.height < 250 ? 3 : pixels.height < 500 ? 2 : 1;
  }
  scale = Math.max(1, Math.min(MAX_SCALE, scale));
  const area = pixels.width * pixels.height;
  if (area > 0 && area * scale * scale > MAX_OUTPUT_PIXELS) {
    scale = Math.max(1, Math.sqrt(MAX_OUTPUT_PIXELS / area));
  }
  return scale;
}

/** Bilinear enlargement. A scale of 1 returns the raster untouched. */
export function enlarge(raster: GreyRaster, scale: number): GreyRaster {
  if (!(scale > 1)) return raster;
  const { width: w, height: h, pixels: src } = raster;
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(W * H);
  const sx = w / W;
  const sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const dx = fx - x0;
      const top = src[y0 * w + x0] * (1 - dx) + src[y0 * w + x1] * dx;
      const bottom = src[y1 * w + x0] * (1 - dx) + src[y1 * w + x1] * dx;
      out[y * W + x] = Math.round(top * (1 - dy) + bottom * dy);
    }
  }
  return { width: W, height: H, pixels: out };
}

/** Otsu's threshold: the grey level that best separates ink from paper. */
export function inkThreshold(pixels: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of pixels) histogram[value] += 1;
  const total = pixels.length;
  let sum = 0;
  for (let level = 0; level < 256; level++) sum += level * histogram[level];
  let sumBelow = 0;
  let weightBelow = 0;
  let best = -1;
  let threshold = 127;
  for (let level = 0; level < 256; level++) {
    weightBelow += histogram[level];
    if (!weightBelow) continue;
    const weightAbove = total - weightBelow;
    if (!weightAbove) break;
    sumBelow += level * histogram[level];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sum - sumBelow) / weightAbove;
    const between = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (between > best) {
      best = between;
      threshold = level;
    }
  }
  return threshold;
}

/**
 * The raster with its ruled lines painted out. See the header: a run of ink
 * longer than `RULE_SPAN` of the picture's width (or height) is a rule.
 */
export function withoutRules(raster: GreyRaster, threshold: number): GreyRaster {
  const { width: w, height: h, pixels } = raster;
  const ink = (index: number) => pixels[index] <= threshold;
  const rule = new Uint8Array(w * h);
  const minAcross = Math.max(2, Math.round(w * RULE_SPAN));
  const minDown = Math.max(2, Math.round(h * RULE_SPAN));

  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!ink(y * w + x)) { x += 1; continue; }
      let end = x;
      while (end < w && ink(y * w + end)) end += 1;
      if (end - x >= minAcross) for (let i = x; i < end; i++) rule[y * w + i] = 1;
      x = end;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!ink(y * w + x)) { y += 1; continue; }
      let end = y;
      while (end < h && ink(end * w + x)) end += 1;
      if (end - y >= minDown) for (let i = y; i < end; i++) rule[i * w + x] = 1;
      y = end;
    }
  }

  const out = pixels.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!rule[y * w + x]) continue;
      // The rule and its antialiased edge, one pixel either side.
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          out[yy * w + xx] = 255;
        }
      }
    }
  }
  return { width: w, height: h, pixels: out };
}

/**
 * Everything above, in order: the picture as recognition should be handed it.
 */
export function prepareForRecognition(
  rgb: { width: number; height: number; pixels: Uint8Array },
  drawnWidthPt: number | null | undefined,
): GreyRaster & { scale: number } {
  const grey = toGrey(rgb.pixels, rgb.width, rgb.height);
  const scale = recognitionScale(rgb, drawnWidthPt);
  const enlarged = enlarge(grey, scale);
  const cleaned = withoutRules(enlarged, inkThreshold(enlarged.pixels));
  return { ...cleaned, scale };
}
