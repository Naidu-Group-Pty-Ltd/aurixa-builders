/**
 * A SMALL PICTURE OF A TABLE, MADE READABLE TO RECOGNITION — AND NOTHING ELSE.
 *
 * `figureRaster.pure.ts` does three things to a picture before recognition
 * reads it: grey, enlarged to about 300 dpi at the size the page prints it,
 * and the table's rules painted out. Each is pinned here, including the ones
 * that must NOT happen: nothing is shrunk, nothing is enlarged without bound,
 * and a letter is never taken for a rule.
 */
import { describe, expect, it } from 'vitest';

import {
  enlarge, inkThreshold, prepareForRecognition, recognitionScale, toGrey, withoutRules,
  type GreyRaster,
} from '../../../supabase/functions/_shared/builderStock/figureRaster.pure';

describe('how far a picture is enlarged', () => {
  it('to about 300 dpi at the size the page prints it', () => {
    // Production: 231 pixels across 151.2 points is 110 dpi.
    expect(recognitionScale({ width: 231, height: 166 }, 151.2)).toBeCloseTo(2.727, 2);
  });

  it('never shrinks a picture that is already dense', () => {
    expect(recognitionScale({ width: 1200, height: 800 }, 144)).toBe(1);
  });

  it('never past four times, however coarse', () => {
    expect(recognitionScale({ width: 100, height: 60 }, 300)).toBe(4);
  });

  it('never past four megapixels', () => {
    const scale = recognitionScale({ width: 900, height: 900 }, 600);
    expect(900 * 900 * scale * scale).toBeLessThanOrEqual(4_000_001);
    expect(scale).toBeGreaterThanOrEqual(1);
  });

  it('by the picture\'s own height where the page does not say how large it prints it', () => {
    expect(recognitionScale({ width: 231, height: 166 }, null)).toBe(3);
    expect(recognitionScale({ width: 600, height: 400 }, undefined)).toBe(2);
    expect(recognitionScale({ width: 900, height: 700 }, 0)).toBe(1);
  });
});

/** A white raster with a ruled table's frame and one small letter-like mark. */
function ruledRaster(): GreyRaster {
  const width = 120;
  const height = 60;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let x = 0; x < width; x++) { pixels[10 * width + x] = 20; pixels[50 * width + x] = 20; }
  for (let y = 10; y <= 50; y++) { pixels[y * width + 5] = 20; pixels[y * width + 60] = 20; }
  // A mark the size of a figure's stroke, well away from every rule.
  for (let y = 25; y < 35; y++) for (let x = 20; x < 23; x++) pixels[y * width + x] = 30;
  // A decimal point.
  pixels[34 * width + 26] = 40;
  return { width, height, pixels };
}

describe('the rules are painted out, and nothing else is', () => {
  it('whitens every full-width and full-height rule, and keeps the marks between them', () => {
    const raster = ruledRaster();
    const cleaned = withoutRules(raster, inkThreshold(raster.pixels));
    const at = (x: number, y: number) => cleaned.pixels[y * cleaned.width + x];
    expect(at(40, 10)).toBe(255);
    expect(at(40, 50)).toBe(255);
    expect(at(5, 30)).toBe(255);
    expect(at(60, 30)).toBe(255);
    expect(at(21, 30)).toBe(30);
    expect(at(26, 34)).toBe(40);
  });

  it('leaves a picture with no rules exactly as it was', () => {
    const plain: GreyRaster = { width: 40, height: 20, pixels: new Uint8Array(800).fill(255) };
    for (let x = 10; x < 14; x++) plain.pixels[10 * 40 + x] = 0;
    expect(withoutRules(plain, 128).pixels).toEqual(plain.pixels);
  });
});

describe('the rest of the preparation', () => {
  it('greys by luminance', () => {
    const grey = toGrey(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), 4, 1);
    expect([...grey.pixels]).toEqual([76, 150, 29, 255]);
  });

  it('enlarges without inventing tone, and a scale of one is the picture itself', () => {
    const flat: GreyRaster = { width: 3, height: 2, pixels: new Uint8Array(6).fill(90) };
    const big = enlarge(flat, 2.5);
    expect([big.width, big.height]).toEqual([8, 5]);
    expect(new Set(big.pixels)).toEqual(new Set([90]));
    expect(enlarge(flat, 1)).toBe(flat);
  });

  it('separates ink from paper', () => {
    const pixels = new Uint8Array(100).fill(250);
    pixels.fill(20, 0, 30);
    const threshold = inkThreshold(pixels);
    expect(threshold).toBeGreaterThanOrEqual(20);
    expect(threshold).toBeLessThan(250);
  });

  it('prepares a production-sized picture as recognition is handed it', () => {
    const rgb = { width: 231, height: 166, pixels: new Uint8Array(231 * 166 * 3).fill(255) };
    const ready = prepareForRecognition(rgb, 151.2);
    expect(ready.width).toBe(Math.round(231 * ready.scale));
    expect(ready.height).toBe(Math.round(166 * ready.scale));
    expect(ready.pixels.length).toBe(ready.width * ready.height);
  });
});
