/**
 * A KERB THE CROP CUT IS NOT A LINE OF TYPE.
 *
 * MEASURED 24 SEPTEMBER 2026, on the same linked stock list whose flyers the
 * cover rule refused. Lot 54's photograph was elected, attached and then
 * hidden as a marketing tile. Its picture is a clean builder render — a
 * facade, a garden, a kerb and a road, with nothing laid over it — and the
 * strict type pass found ONE line of lettering in it: the kerb and lawn edge
 * across its lower fifth, from the picture's left edge to 86.7% of the way
 * across (354×400, y 77.8%–84%). The clearance then refused with
 * `type_present`, because a promotional block with type on it is never
 * cleared, and the property's own photograph was hidden for ever with nothing
 * to remove.
 *
 * THE CORPUS, because this is a safety gate. `stock-overlay-audit` read every
 * distinct stored picture with a display verdict — 112 — and found 21 strict
 * runs across the 13 convicted on type. Twenty are real captions and every
 * one of them is INSET; the widest runs 34% of the frame. Exactly one reached
 * a side of the frame: the kerb.
 *
 * THE PICTURE BELOW IS INVENTED, and deliberately so. It is a grey field with
 * one band whose columns alternate stroke and counter the way a line of
 * type's ink does at this scale, so it passes every geometric test the strict
 * pass has — height, aspect, fill, stripes, core profile. That is the point:
 * placed where the kerb was it must not be type, and placed where a caption
 * sits it must be, so the only thing that can separate the two is the rule
 * this fixture exists for. The first block fails before the change; the
 * guards hold on both sides of it.
 */
import { describe, expect, it } from 'vitest';

import {
  measureFaintOverlayText,
  overlayTextBoxes,
  readMarketingOverlay,
  type RasterView,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';

/** Lot 54's measured picture size. */
const W = 354;
const H = 400;

/** One period of a line of type's ink at this scale: stroke, edge, counter, edge. */
const LETTERING = [30, 30, 110, 190, 190, 110];
/** The same, at the contrast of pale type over a pale sky. */
const FAINT_LETTERING = [104, 104, 110, 116, 116, 110];

interface Box { x0: number; x1: number; y0: number; y1: number }

/** Lot 54's kerb run, as the audit measured it. */
const KERB: Box = { x0: 0, x1: 0.867, y0: 0.778, y1: 0.84 };

function paint(pixels: Uint8Array, box: Box, pixel: (x: number) => number[]): void {
  const left = Math.round(box.x0 * W);
  const right = Math.round(box.x1 * W);
  const top = Math.round(box.y0 * H);
  const bottom = Math.round(box.y1 * H);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const [r, g, b] = pixel(x - left);
      const at = (y * W + x) * 3;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
    }
  }
}

function picture(bands: Box[], options: {
  period?: number[];
  plate?: { box: Box; rgb: number[] };
} = {}): RasterView {
  const pixels = new Uint8Array(W * H * 3).fill(110);
  const period = options.period ?? LETTERING;
  for (const band of bands) {
    paint(pixels, band, (x) => {
      const v = period[x % period.length];
      return [v, v, v];
    });
  }
  if (options.plate) paint(pixels, options.plate.box, () => options.plate!.rgb);
  return { width: W, height: H, pixels };
}

describe('structure the crop cut, reaching a side and running across the frame', () => {
  it('is not a line of type where Lot 54\'s kerb was', () => {
    const view = picture([KERB]);
    const verdict = readMarketingOverlay(view);
    expect(verdict.textLineCount).toBe(0);
    expect(verdict.annotated).toBe(false);
    expect(overlayTextBoxes(view)).toEqual([]);
  });

  it('is clean, not merely unconvicted: the faint pass has nothing to doubt', () => {
    const verdict = readMarketingOverlay(picture([KERB]));
    expect(verdict.uncertain).toBe(false);
    expect(verdict.faintTextLineCount).toBe(0);
  });

  it('is the same from the right-hand side of the frame', () => {
    const view = picture([{ ...KERB, x0: 1 - KERB.x1, x1: 1 }]);
    expect(readMarketingOverlay(view).textLineCount).toBe(0);
    expect(overlayTextBoxes(view)).toEqual([]);
  });

  it('starts at half the frame', () => {
    expect(readMarketingOverlay(picture([{ ...KERB, x1: 0.51 }])).textLineCount).toBe(0);
  });
});

describe('what stays type, which is what keeps this from admitting a tile', () => {
  it('still convicts the captions the audit measured, which are inset', () => {
    for (const caption of [
      { x0: 0.638, x1: 0.933, y0: 0.07, y1: 0.135 },
      { x0: 0.083, x1: 0.42, y0: 0.135, y1: 0.26 },
      { x0: 0.6, x1: 0.775, y0: 0.217, y1: 0.267 },
    ]) {
      const verdict = readMarketingOverlay(picture([caption]));
      expect(verdict.textLineCount, JSON.stringify(caption)).toBe(1);
      expect(verdict.annotated).toBe(true);
    }
  });

  it('still convicts a banner\'s line of type set across the frame with a margin', () => {
    for (const margin of [0.05, 0.1]) {
      const banner = { ...KERB, x0: margin, x1: 1 - margin };
      expect(readMarketingOverlay(picture([banner])).textLineCount, `${margin}`).toBe(1);
      expect(overlayTextBoxes(picture([banner]))).toHaveLength(1);
    }
  });

  it('still convicts a caption the crop clipped, which is short', () => {
    for (const x1 of [0.3, 0.49]) {
      expect(readMarketingOverlay(picture([{ ...KERB, x1 }])).textLineCount, `${x1}`).toBe(1);
    }
  });

  it('never clears a plate: the flat-colour pass convicts it exactly as before', () => {
    const verdict = readMarketingOverlay(picture([KERB], {
      plate: { box: { x0: 0.6, x1: 0.9, y0: 0.1, y1: 0.25 }, rgb: [200, 30, 40] },
    }));
    expect(verdict.annotated).toBe(true);
    expect(verdict.regionCount).toBe(1);
  });

  it('leaves the faint pass as it was: it still doubts a faint band at the edge', () => {
    const view = picture([KERB], { period: FAINT_LETTERING });
    expect(measureFaintOverlayText(view).lineCount).toBe(1);
    const verdict = readMarketingOverlay(view);
    expect(verdict.annotated).toBe(false);
    expect(verdict.uncertain).toBe(true);
  });
});
