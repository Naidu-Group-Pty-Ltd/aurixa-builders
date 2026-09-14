/**
 * Builder stock — what a picture in a builder's document actually IS.
 *
 * PRODUCTION, 4 SEPTEMBER 2026. Lots 109 and 115 Palomino drew a green floor
 * plan on the marketplace, badged "Builder supplied". Lot 116, the same estate
 * and the same builder, drew the house. All three are correct attributions of
 * the right document to the right property; what differs is which picture
 * inside the document was called the hero.
 *
 * WHY THE DOCUMENT'S OWN EMPHASIS WAS NOT ENOUGH. `selectCoverHero` picks by
 * what the page DID — a raster the cover draws once, and draws at least twice
 * the size of any other, is the picture the page named. Its own comment says
 * the test is "the DOCUMENT'S, not the picture's", and that was right for the
 * question it was answering (which picture does this page present as the
 * property's). It is the wrong test for the question a card asks (is this a
 * photograph of a house), because a brochure whose first page leads with the
 * floor plan states the plan exactly as emphatically.
 *
 * This is the same defect the listings side already fixed and measured:
 * "the single most important decision the marketplace makes, which photograph
 * leads a listing, was taken with no visual information at all" — six of
 * sixteen sampled heroes were floor plans. Builder stock never got that
 * judgement.
 *
 * SO IT BORROWS IT RATHER THAN REPEATING IT. Everything decided here is
 * decided by `listingImageVision.pure.ts`, whose thresholds were measured
 * against labelled production images and whose bias is deliberately asymmetric
 * — it demands strong evidence before it will say anything other than `photo`.
 * This module is an ADAPTER and contains no judgement of its own: builder
 * stock's decoder produces RGB triples at up to 400px on the long side, and
 * that classifier reads a square of RGBA. Converting between them is the whole
 * of this file.
 *
 * Pure: no IO, no clock.
 */
import {
  ANALYSIS_SIZE, analyseRgba, type VisualAnalysis, type VisualKind,
} from '../listingImageVision.pure.ts';

/** Builder stock's decoded thumbnail, as `sourceImageRaster.ts` produces it. */
export interface RgbThumbnail {
  width: number;
  height: number;
  /** RGB triples, `width * height * 3` bytes. */
  pixels: ArrayLike<number>;
  /** The full-resolution size, which is what the aspect test must use. */
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * Resample an RGB thumbnail into the square RGBA buffer the classifier reads.
 *
 * Nearest-neighbour on purpose. Every feature the classifier measures is a
 * POPULATION statistic — the fraction of near-white pixels, the number of
 * distinct quantised colours, the mean horizontal luma step — and the input is
 * already a box-filtered thumbnail, so averaging a second time would blur the
 * hard black line-work that separates a plan from a photograph and pull both
 * populations towards each other. Sampling preserves it.
 */
export function toAnalysisRgba(
  thumbnail: RgbThumbnail,
  size: number = ANALYSIS_SIZE,
): Uint8Array | null {
  const { width, height } = thumbnail;
  if (!(width > 0) || !(height > 0)) return null;
  const source = thumbnail.pixels;
  if (!source || source.length < width * height * 3) return null;

  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / size));
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / size));
      const from = (sy * width + sx) * 3;
      const to = (y * size + x) * 4;
      out[to] = source[from] as number;
      out[to + 1] = source[from + 1] as number;
      out[to + 2] = source[from + 2] as number;
      out[to + 3] = 255;
    }
  }
  return out;
}

/**
 * What this picture is, or null where it could not be established.
 *
 * NULL IS A REAL ANSWER AND IT MEANS "NOTHING IS KNOWN". Every caller treats
 * it as the state before this module existed, because an undecodable image
 * must behave exactly as it did rather than being demoted on a failure of
 * ours — the rule this programme keeps returning to: our failure is never
 * recorded as evidence about the builder's picture.
 */
export function classifyThumbnail(thumbnail: RgbThumbnail | null | undefined): VisualAnalysis | null {
  if (!thumbnail) return null;
  const rgba = toAnalysisRgba(thumbnail);
  if (!rgba) return null;
  /*
   * The TRUE dimensions, not the thumbnail's. The classifier's one
   * aspect-based rule catches shapes no camera produces (an agency banner
   * measured 1093 × 100), and a thumbnail that has been fitted into a box no
   * longer has the aspect the document drew.
   */
  const width = thumbnail.sourceWidth ?? thumbnail.width;
  const height = thumbnail.sourceHeight ?? thumbnail.height;
  try {
    return analyseRgba(rgba, width, height);
  } catch {
    return null;
  }
}

/**
 * May a picture of this kind LEAD a property's card?
 *
 * Only a photograph. A floor plan and a graphic are both legitimate things for
 * a builder's brochure to contain and neither is a picture of the house, which
 * is what a card is for. An unknown kind may lead, because it is the answer
 * this module gives when it could not look.
 */
export function mayLeadCard(kind: VisualKind | null | undefined): boolean {
  return kind !== 'floorplan' && kind !== 'graphic';
}

export type { VisualKind };
