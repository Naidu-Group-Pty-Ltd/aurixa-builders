/**
 * What an image *is*, decided by looking at its pixels.
 *
 * This is the one implementation of that judgement. It used to live in
 * `src/lib/imageKind.ts` and run only in a browser, only after the card had
 * already drawn, only for a session — which meant the single most important
 * decision the marketplace makes, *which photograph leads a listing*, was taken
 * with no visual information at all. A contact sheet of sixteen listings' hero
 * images, sampled at random from production on 2026-08-19, came back as:
 *
 * - **six floor plans** (37.5%),
 * - one "coming soon" text card,
 * - one stock interior render that is the hero on seventeen different listings,
 * - and eight actual photographs of the property.
 *
 * The URLs give nothing away — five of the six plans are
 * `lh3.googleusercontent.com/d/<opaque id>`, because the agency emails its
 * photographs as Google Drive links. Pixels are the only evidence there is.
 *
 * ## The thresholds are measured, not guessed
 *
 * Every number below comes from running these features over images whose
 * identity was established by eye. `white` is the fraction of near-white pixels
 * and it separates the two populations by a factor of six:
 *
 * | Kind | `white` | `colour` | `palette` |
 * | --- | --- | --- | --- |
 * | Floor plans (7 measured) | 0.731 – 0.955 | 0.003 – 0.051 | 20 – 105 |
 * | "Coming soon" text card | 0.512 | 0.160 | 213 |
 * | Agency banner strip | 0.000 (aspect 10.9) | 0.104 | 18 |
 * | Photographs (11 measured) | 0.000 – 0.118 | 0.000 – 0.634 | 46 – 556 |
 *
 * The gap between the worst plan (0.731) and the whitest photograph (0.118) is
 * enormous, which is why this is a threshold and not a model.
 *
 * ## The bias is deliberate and asymmetric
 *
 * Calling a plan a photograph leaves it where the agent put it — yesterday's
 * behaviour. Calling a photograph a plan buries it behind everything else. The
 * second mistake is much worse, so every rule here demands strong evidence
 * before it will say anything other than `photo`, and the overlap zone resolves
 * to `photo`.
 *
 * ## What it cannot see
 *
 * A stock interior render is a photograph by every measure here — it is one, it
 * is just not a photograph of *this* property. Nothing in a single image can
 * establish that. It takes the corpus: an image that is the hero on seventeen
 * listings is not a picture of any of them, and that is
 * `listingImageSelection.pure.ts`'s `sharedListings`, not this module's job.
 *
 * Pure: no Deno, no DOM, no imports. Takes RGBA bytes and returns numbers.
 */

/** What one image turns out to be. */
export type VisualKind = 'photo' | 'floorplan' | 'graphic';

export interface VisualFeatures {
  /** Fraction of near-white pixels — paper ground. */
  white: number;
  /** Fraction with real chroma — sky, brick, lawn, water. */
  colour: number;
  /** Fraction that is nearly black. */
  dark: number;
  /** Distinct quantised colours. Line art has a handful; a photograph hundreds. */
  palette: number;
  /** Mean absolute luminance step between horizontal neighbours. */
  edge: number;
}

/** The square the analysis is sampled at. Small on purpose: see `signature`. */
export const ANALYSIS_SIZE = 64;

/**
 * Feature extraction over an RGBA buffer that is `size` × `size`.
 *
 * The caller is responsible for the downscale — the browser does it with a
 * canvas, the edge function with a decoder — because that is the one step whose
 * implementation genuinely differs between the two runtimes.
 */
export function visualFeatures(pixels: ArrayLike<number>, size: number = ANALYSIS_SIZE): VisualFeatures {
  const total = size * size;
  const luma = new Float64Array(total);
  const palette = new Set<number>();
  let white = 0;
  let colour = 0;
  let dark = 0;

  for (let i = 0; i < total; i += 1) {
    const at = i * 4;
    const r = pixels[at];
    const g = pixels[at + 1];
    const b = pixels[at + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (r >= 232 && g >= 232 && b >= 232) white += 1;
    // Saturation on bright-enough pixels; dark line-work counts as neither.
    else if (max > 60 && max - min > 0.28 * max) colour += 1;
    if (max < 40) dark += 1;

    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    palette.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }

  let edge = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      edge += Math.abs(luma[y * size + x] - luma[y * size + x + 1]);
    }
  }

  return {
    white: white / total,
    colour: colour / total,
    dark: dark / total,
    palette: palette.size,
    edge: edge / (size * (size - 1)),
  };
}

/**
 * The verdict.
 *
 * `aspect` is width ÷ height, when the caller knows it. It only ever adds a
 * `graphic` verdict for shapes no camera produces — an agency banner strip
 * measured 1093 × 100 and was on twenty listings — and never overrides `photo`
 * for an ordinary frame.
 */
export function classifyVisual(features: VisualFeatures, aspect?: number | null): VisualKind {
  const { white, colour, palette } = features;

  // A banner, a logo lockup, a letterhead strip: a shape no camera makes, in
  // colours no scene has. Measured: 1093 × 100, palette of 18, on 20 listings.
  if (typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0) {
    if ((aspect >= 3.2 || aspect <= 0.32) && palette <= 96) return 'graphic';
  }

  // A page of line-work on paper. The whitest photograph measured was 0.118, so
  // 0.62 sits in a gap six times wider than the population it excludes. The
  // palette bound is what separates a plan from a text card printed on white:
  // plans measured 20–105 distinct colours, the "coming soon" card 213.
  if (white >= 0.62) return palette <= 160 ? 'floorplan' : 'graphic';

  /*
   * A plan whose rooms are FILLED with colour.
   *
   * The bound here was 0.30, fitted to plans whose colour is lawn and pool on
   * an otherwise white sheet. A builder's modern floor plan fills every room
   * with a brand colour instead, and the Palomino Vanta 23 plan measured
   * `colour` 0.301 — outside by a thousandth, elected as the hero of two live
   * cards, badged "Builder supplied", twice through a re-derivation.
   *
   * WHAT ACTUALLY SEPARATES THE POPULATIONS HERE IS `white`, and it is not
   * close: no photograph in the corpus exceeds 0.118 and this plan is 0.518.
   * `colour` was never the discriminator in this band — it was a guard against
   * a washed-out photograph, which a low-palette bound already refuses — so
   * widening it admits coloured plans without reaching any measured
   * photograph. The "coming soon" card stays a graphic on its palette of 213.
   */
  if (white >= 0.45 && colour <= 0.45 && palette <= 140) return 'floorplan';

  // Flat artwork on a light ground: a marketing card, a rendered tile. Needs a
  // restrained palette *and* little colour, because a genuine photograph of a
  // white room under an overcast sky is low-colour but never low-palette — the
  // lowest measured was 46, for a black-and-white aerial, and it carries no
  // white at all.
  if (white >= 0.35 && colour <= 0.30 && palette <= 260) return 'graphic';

  return 'photo';
}

/**
 * A 64-bit difference hash, as 16 hex characters.
 *
 * Row-wise brightness comparisons on an 8 × 9 grid: bit *i* is "this cell is
 * brighter than the one to its right". Indifferent to scale, to JPEG quality
 * and to a mild exposure shift — exactly the differences between two copies of
 * one photograph — while two different rooms disagree on roughly half the bits.
 *
 * Sampled from the same downscale the features use, so it costs a few hundred
 * array reads and no extra decode.
 */
export function visualSignature(pixels: ArrayLike<number>, size: number = ANALYSIS_SIZE): string {
  const cell = size / 8;
  const luma = (col: number, row: number): number => {
    const x = Math.min(size - 1, Math.floor(((col + 0.5) * (cell * 8)) / 9));
    const y = Math.min(size - 1, Math.floor((row + 0.5) * cell));
    const at = (y * size + x) * 4;
    return 0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2];
  };

  let hex = '';
  for (let row = 0; row < 8; row += 1) {
    let nibble = 0;
    for (let col = 0; col < 8; col += 1) {
      nibble = (nibble << 1) | (luma(col, row) > luma(col + 1, row) ? 1 : 0);
      if (col % 4 === 3) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

/** Everything one decode establishes about an image. */
export interface VisualAnalysis {
  kind: VisualKind;
  signature: string;
  features: VisualFeatures;
  width: number;
  height: number;
}

/** Runs the whole judgement over a downscaled RGBA square plus the true size. */
export function analyseRgba(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  size: number = ANALYSIS_SIZE,
): VisualAnalysis {
  const features = visualFeatures(pixels, size);
  return {
    features,
    kind: classifyVisual(features, height > 0 ? width / height : null),
    signature: visualSignature(pixels, size),
    width,
    height,
  };
}
