/**
 * TYPE A PAGE PAINTS AS SHAPES — found, carried and drawn.
 *
 * `LOT 326 - NEX 20` and `LOT 324 - NEX 20` state the house's size only in an
 * area schedule whose rows the exporter converted to curves. What each step
 * below may and may not do is `pdfOutlineFigures.pure.ts`; the recognition
 * and the proof are the picture path's own, asserted in the acceptance gate
 * against a document that paints its rows exactly this way.
 */
import { describe, expect, it } from 'vitest';

import {
  isGlyphLike, MAX_FIGURE_RECOGNITIONS, MAX_OUTLINES_READ, outlineFigureFrom,
  outlineRegionsFrom, outlinesToRead, outlinesWithinRecognitionBudget, rasteriseOutlines,
  readPdfOutlineFigures, scanFilledPaths, type FilledPath, type PdfOutlineFigure,
} from '../../../supabase/functions/_shared/builderStock/pdfOutlineFigures.pure';

/** A glyph-ish filled shape: a lozenge `w` wide and `h` tall at (x, y). */
const glyph = (x: number, y: number, w = 4, h = 7) =>
  `${x} ${y} m ${x + w} ${y} l ${x + w} ${y + h * 0.6} l ${x + w / 2} ${y + h} l ${x} ${y + h * 0.6} l h`;
/** A word: `n` glyphs, one path, filled even-odd, as the production page paints them. */
const word = (x: number, y: number, n: number, size = 7) =>
  `${Array.from({ length: n }, (_, i) => glyph(x + i * size * 0.7, y, size * 0.55, size)).join(' ')} f*`;
/** A schedule: four rows of three words, 14 points apart. */
const schedule = (x: number, top: number) => [0, 1, 2, 3]
  .map((row) => [word(x, top - row * 14, 6), word(x + 44, top - row * 14, 7), word(x + 94, top - row * 14, 6)]
    .join('\n'))
  .join('\n');

describe('the drawing instructions, read as filled shapes', () => {
  it('reads a filled path under the matrix in force, and forgets it after Q', () => {
    const scan = scanFilledPaths('q 2 0 0 2 100 50 cm 0 0 m 10 0 l 10 10 l h f Q 0 0 m 1 0 l 1 1 l h f');
    expect(scan.paths).toHaveLength(2);
    expect(scan.paths[0].box).toEqual({ x: 100, y: 50, width: 20, height: 20 });
    expect(scan.paths[1].box).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('takes the fill rule from the operator', () => {
    const scan = scanFilledPaths('0 0 m 5 0 l 5 5 l h f* 0 0 m 5 0 l 5 5 l h f 0 0 m 5 0 l 5 5 l h B*');
    expect(scan.paths.map((path) => path.evenOdd)).toEqual([true, false, true]);
  });

  it('never collects a stroke, a clip or a path that is ended unpainted', () => {
    const scan = scanFilledPaths('0 0 m 50 0 l S 0 0 10 10 re W n 0 0 m 5 5 l s 0 0 m 1 1 l n');
    expect(scan.paths).toHaveLength(0);
  });

  it('flattens curves into the ring', () => {
    const scan = scanFilledPaths('0 0 m 0 10 10 10 10 0 c h f');
    expect(scan.paths).toHaveLength(1);
    const ring = scan.paths[0].rings[0];
    expect(ring.length / 2).toBeGreaterThan(4);
    expect(scan.paths[0].box.height).toBeGreaterThan(7);
  });

  it('reads a rectangle as a rectangle', () => {
    const scan = scanFilledPaths('10 20 30 4 re f');
    expect(scan.paths[0].rectangular).toBe(true);
    expect(scan.paths[0].box).toEqual({ x: 10, y: 20, width: 30, height: 4 });
  });

  it('steps over strings, dictionaries and inline image data rather than reading them', () => {
    const content = [
      'BT (a string with m and l and \\) an escaped paren (nested f)) Tj ET',
      '/Span << /ActualText (0 0 m 9 9 l h f) >> BDC EMC',
      'BI /W 4 /H 4 /BPC 8 /CS /G ID 0 0 m 9 9 l h f\nEI',
      '0 0 m 4 0 l 4 7 l h f*',
    ].join('\n');
    const scan = scanFilledPaths(content);
    expect(scan.paths).toHaveLength(1);
    expect(scan.paths[0].box).toEqual({ x: 0, y: 0, width: 4, height: 7 });
  });

  it('names the forms it draws, with the matrix they are drawn under', () => {
    const scan = scanFilledPaths('q 1 0 0 1 5 6 cm /Fm0 Do Q /Fm1 Do');
    expect(scan.forms).toEqual([
      { name: 'Fm0', ctm: [1, 0, 0, 1, 5, 6] },
      { name: 'Fm1', ctm: [1, 0, 0, 1, 0, 0] },
    ]);
  });

  it('says so when a stream is too large to trust, rather than reading part of it', () => {
    const huge = Array.from({ length: 70_000 }, (_, i) => `${i} 0 m ${i} 1 l S`).join('\n');
    expect(scanFilledPaths(huge).truncated).toBe(true);
  });
});

describe('which shapes are type', () => {
  const shape = (width: number, height: number, rectangular = false): FilledPath => ({
    evenOdd: false, rings: [[0, 0, width, 0, width, height]],
    box: { x: 0, y: 0, width, height }, rectangular,
  });

  it('a letter, a full stop and a letter\'s bar are', () => {
    expect(isGlyphLike(shape(4, 7))).toBe(true);
    expect(isGlyphLike(shape(1, 1, true))).toBe(true);
    expect(isGlyphLike(shape(1.1, 5.4, true))).toBe(true);
  });

  it('a rule, a box and a picture-sized shape are not', () => {
    expect(isGlyphLike(shape(140, 0.5, true))).toBe(false);
    expect(isGlyphLike(shape(146, 93, true))).toBe(false);
    expect(isGlyphLike(shape(8, 8, true))).toBe(false);
    expect(isGlyphLike(shape(300, 200))).toBe(false);
  });
});

describe('a block of rows', () => {
  it('is found where four rows of words are painted as shapes', () => {
    const regions = outlineRegionsFrom(scanFilledPaths(schedule(64, 596)).paths);
    expect(regions).toHaveLength(1);
    expect(regions[0].rows).toBe(4);
    expect(regions[0].paths).toHaveLength(12);
  });

  it('is not found in one row of shapes, which is a logo or an icon row', () => {
    const row = [word(64, 596, 6), word(108, 596, 7)].join('\n');
    expect(outlineRegionsFrom(scanFilledPaths(row).paths)).toHaveLength(0);
  });

  it('is two blocks where two schedules are painted apart', () => {
    const two = `${schedule(64, 596)}\n${schedule(360, 300)}`;
    expect(outlineRegionsFrom(scanFilledPaths(two).paths)).toHaveLength(2);
  });

  it('leaves out the frame drawn around it', () => {
    const framed = `50 540 170 80 re f\n1 g\n${schedule(64, 596)}`;
    const [region] = outlineRegionsFrom(scanFilledPaths(framed).paths);
    expect(region.paths).toHaveLength(12);
  });
});

describe('what travels across the hand-off', () => {
  const [region] = outlineRegionsFrom(scanFilledPaths(schedule(64, 596)).paths);
  const figure = outlineFigureFrom(region, 1) as PdfOutlineFigure;

  it('is integer tenths of a point from the block\'s corner, and comes back exactly', () => {
    expect(figure.kind).toBe('outlines');
    expect(figure.paths.every((path) => path.rings.every((ring) =>
      ring.every((value) => Number.isInteger(value) && value >= 0)))).toBe(true);
    expect(readPdfOutlineFigures(JSON.parse(JSON.stringify([figure])))).toEqual([figure]);
  });

  it('is dropped whole when any part of it is not exactly that shape', () => {
    const broken = JSON.parse(JSON.stringify(figure));
    broken.paths[0].rings[0][0] = 1.5;
    expect(readPdfOutlineFigures([broken])).toEqual([]);
    expect(readPdfOutlineFigures([{ ...figure, kind: 'picture' }])).toEqual([]);
    expect(readPdfOutlineFigures([{ ...figure, page: 0 }])).toEqual([]);
    expect(readPdfOutlineFigures('not a list')).toEqual([]);
  });

  it('is refused past its bound rather than cut', () => {
    const many = outlineRegionsFrom(scanFilledPaths(schedule(64, 596)).paths)[0];
    const dense = { ...many, paths: many.paths.map((path) => ({
      ...path, rings: path.rings.map((ring) => [...ring, ...Array.from({ length: 2400 }, () => ring[0])]),
    })) };
    expect(outlineFigureFrom(dense, 1)).toBeNull();
  });
});

describe('when a block is read', () => {
  const [region] = outlineRegionsFrom(scanFilledPaths(schedule(64, 596)).paths);
  const figure = outlineFigureFrom(region, 1) as PdfOutlineFigure;
  const onPage2 = { ...figure, page: 2 };
  const base = { outlines: [figure, onPage2], rows: [{ lot_number: '326' }], pricePages: [1], disputedFields: [] };

  it('under exactly the conditions a picture is read under', () => {
    expect(outlinesToRead(base)).toEqual([figure]);
    expect(outlinesToRead({ ...base, rows: [{ building_size_sqm: '178.23' }] })).toEqual([]);
    expect(outlinesToRead({ ...base, rows: [{}, {}] })).toEqual([]);
    expect(outlinesToRead({ ...base, disputedFields: ['building_size_sqm'] })).toEqual([]);
    expect(outlinesToRead({ ...base, pricePages: [] })).toEqual([]);
  });

  it('never more than one crossing can recognise beside its pictures', () => {
    const lots = Array.from({ length: 5 }, () => figure);
    expect(outlinesToRead({ ...base, outlines: lots })).toHaveLength(MAX_OUTLINES_READ);
    expect(outlinesWithinRecognitionBudget(3, lots)).toHaveLength(MAX_FIGURE_RECOGNITIONS - 3);
    expect(outlinesWithinRecognitionBudget(MAX_FIGURE_RECOGNITIONS, lots)).toEqual([]);
  });
});

describe('drawing the block', () => {
  it('draws ink where the shapes are and paper everywhere else, with a margin', () => {
    const figure: PdfOutlineFigure = {
      kind: 'outlines', page: 1, drawn: { x: 0, y: 0, width: 20, height: 10 }, rowHeight: 10,
      paths: [{ evenOdd: false, rings: [[0, 0, 100, 0, 100, 100, 0, 100]] }],
    };
    const drawing = rasteriseOutlines(figure)!;
    const at = (x: number, y: number) => drawing.pixels[y * drawing.width + x];
    // 400 dpi: 20 x 10 points is 112 x 56 pixels, plus a 24-pixel margin.
    expect(drawing.width).toBe(112 + 48);
    expect(drawing.height).toBe(56 + 48);
    expect(at(0, 0)).toBe(255);
    // The square is the left half, and the top of the block is the top row.
    expect(at(24 + 20, 24 + 40)).toBe(0);
    expect(at(24 + 90, 24 + 40)).toBe(255);
  });

  it('leaves the counter of an O open under the even-odd rule, and fills it under non-zero', () => {
    const rings = [[0, 0, 100, 0, 100, 100, 0, 100], [30, 30, 70, 30, 70, 70, 30, 70]];
    const draw = (evenOdd: boolean) => rasteriseOutlines({
      kind: 'outlines', page: 1, drawn: { x: 0, y: 0, width: 10, height: 10 }, rowHeight: 10,
      paths: [{ evenOdd, rings }],
    })!;
    const centre = (drawing: ReturnType<typeof draw>) =>
      drawing.pixels[Math.floor(drawing.height / 2) * drawing.width + Math.floor(drawing.width / 2)];
    expect(centre(draw(true))).toBe(255);
    expect(centre(draw(false))).toBe(0);
  });
});
