/**
 * WHICH SMALL PICTURES ON A PROPERTY'S OWN PAGE ARE READ FOR A FIGURE, AND
 * WHEN — and the one thing a verdict may ever change.
 *
 * The shapes below are the production `Lot 101 - PICO - BROCHURE v002.pdf`
 * page's own pictures, as the reading trace printed them: a 1359x1080 facade
 * across 11% of the page, a 268x613 floor plan across 17%, and the 231x166
 * area schedule across 3.3%. Only the last is an inset, and only the last is
 * asked.
 */
import { describe, expect, it } from 'vitest';

import {
  figureCandidatesFrom, figuresToRead, readFigureVerdict, readPdfFigures,
  withFigureApplied, MAX_FIGURES_READ, type PdfFigure,
} from '../../../supabase/functions/_shared/builderStock/pdfFigures.pure';
import type { DrawnImage } from '../../../supabase/functions/_shared/builderStock/pdfPageImages.pure';

const A4 = { width: 595.3, height: 841.9 };

const drawnImage = (
  name: string, width: number, height: number, filters: string[],
  drawn: { x: number; y: number; width: number; height: number },
  objectNumber = 1,
): DrawnImage => ({
  image: {
    name, objectNumber, width, height, start: 1000, end: 1000 + width * height,
    filters, components: 3, bitsPerComponent: 8,
  },
  placement: { name, drawn, clip: null, index: 0, ctm: [1, 0, 0, 1, 0, 0] as never },
});

const FACADE = drawnImage('Im1', 1359, 1080, ['DCTDecode'], { x: 329.4, y: 630.7, width: 265.3, height: 210.9 }, 11);
const PLAN = drawnImage('Im2', 268, 613, ['DCTDecode'], { x: 346.1, y: 82.3, width: 193.9, height: 443.6 }, 12);
const SCHEDULE = drawnImage('Im3', 231, 166, ['FlateDecode'], { x: 45.3, y: 79.9, width: 151.2, height: 108.6 }, 13);

describe('an inset is a candidate by its shape alone', () => {
  it('takes the schedule and leaves the facade and the floor plan', () => {
    const found = figureCandidatesFrom([FACADE, PLAN, SCHEDULE], A4.width, A4.height);
    expect(found.map((entry) => entry.drawn.image.name)).toEqual(['Im3']);
    expect(found[0].pageAreaShare).toBeCloseTo(0.0328, 3);
    expect(found[0].placements).toBe(1);
  });

  it('counts a picture a page draws twice, so the caller can refuse it', () => {
    const twice = [SCHEDULE, { ...SCHEDULE, placement: { ...SCHEDULE.placement, index: 1 } }];
    expect(figureCandidatesFrom(twice, A4.width, A4.height)[0].placements).toBe(2);
  });

  it('refuses an icon, a banner, an encoding with no file in it, and a photograph', () => {
    const icon = drawnImage('Ic', 48, 48, ['DCTDecode'], { x: 70, y: 740, width: 12, height: 12 });
    const banner = drawnImage('Bn', 1200, 150, ['DCTDecode'], { x: 0, y: 800, width: 150, height: 19 });
    const jpx = drawnImage('Jx', 231, 166, ['JPXDecode'], SCHEDULE.placement.drawn);
    const lzw = drawnImage('Lz', 231, 166, ['LZWDecode'], SCHEDULE.placement.drawn);
    const photo = drawnImage('Ph', 600, 400, ['DCTDecode'], { x: 0, y: 0, width: 300, height: 200 });
    expect(figureCandidatesFrom([icon, banner, jpx, lzw, photo], A4.width, A4.height)).toEqual([]);
  });

  it('reads a JPEG compressed again, which is still a JPEG once inflated', () => {
    const doubled = drawnImage('Dj', 231, 166, ['FlateDecode', 'DCTDecode'], SCHEDULE.placement.drawn);
    expect(figureCandidatesFrom([doubled], A4.width, A4.height)).toHaveLength(1);
  });
});

const figure = (page: number, y = 79.9, x = 45.3): PdfFigure => ({
  page, objectNumber: 13, width: 231, height: 166, start: 1000, end: 2000, flate: true,
  drawn: { x, y, width: 151.2, height: 108.6 }, sha256: 'a'.repeat(64),
});
const ROW = { lot_number: '101', price: '$604,500', building_size_sqm: null };

describe('an inset is read only where the text leaves the property unmeasured', () => {
  it('reads the inset on the page that states the price', () => {
    expect(figuresToRead({ figures: [figure(1)], rows: [ROW], pricePages: [1], disputedFields: [] }))
      .toHaveLength(1);
  });

  it('never where the text states a building size', () => {
    const stated = { ...ROW, building_size_sqm: '129.5m²' };
    expect(figuresToRead({ figures: [figure(1)], rows: [stated], pricePages: [1], disputedFields: [] }))
      .toEqual([]);
  });

  it('never where the text disputed one: a picture does not settle what two statements could not', () => {
    expect(figuresToRead({
      figures: [figure(1)], rows: [ROW], pricePages: [1], disputedFields: ['building_size_sqm'],
    })).toEqual([]);
  });

  it('never for a document read as several properties', () => {
    expect(figuresToRead({ figures: [figure(1)], rows: [ROW, ROW], pricePages: [1], disputedFields: [] }))
      .toEqual([]);
  });

  it('never where no page states the price, and never off the pages that do', () => {
    expect(figuresToRead({ figures: [figure(1)], rows: [ROW], pricePages: [], disputedFields: [] }))
      .toEqual([]);
    expect(figuresToRead({ figures: [figure(2)], rows: [ROW], pricePages: [1], disputedFields: [] }))
      .toEqual([]);
  });

  it('reads at most three, in the page\'s reading order', () => {
    const many = [figure(1, 100), figure(1, 600), figure(1, 300), figure(1, 50), figure(1, 450)];
    const chosen = figuresToRead({ figures: many, rows: [ROW], pricePages: [1], disputedFields: [] });
    expect(MAX_FIGURES_READ).toBe(3);
    expect(chosen.map((entry) => entry.drawn?.y)).toEqual([600, 450, 300]);
  });
});

describe('a figure that travels in a hand-off is trusted only in exactly its shape', () => {
  it('keeps a well-formed figure and drops anything else, rather than repairing it', () => {
    const good = figure(1);
    const stored = JSON.parse(JSON.stringify([
      good,
      { ...good, sha256: 'not a digest' },
      { ...good, start: -1 },
      { ...good, end: good.start },
      { ...good, flate: 'yes' },
      { ...good, page: 0 },
    ]));
    expect(readPdfFigures(stored)).toEqual([good]);
    expect(readPdfFigures(undefined)).toEqual([]);
    expect(readPdfFigures({ page: 1 })).toEqual([]);
  });
});

describe('what a verdict may change', () => {
  const READ = { state: 'read' as const, buildingSizeSqm: '124.50', provedBy: ['squares' as const], page: 1 };

  it('fills the one property\'s building size where the text left it empty', () => {
    expect(withFigureApplied([{ ...ROW }], READ)).toEqual([{ ...ROW, building_size_sqm: '124.50' }]);
    expect(withFigureApplied([{ lot_number: '101', building_size_sqm: '' }], READ)[0].building_size_sqm)
      .toBe('124.50');
  });

  it('never speaks over a building size, never across two properties, and never on a refusal', () => {
    const stated = [{ ...ROW, building_size_sqm: '129.5' }];
    expect(withFigureApplied(stated, READ)).toBe(stated);
    const two = [{ ...ROW }, { ...ROW }];
    expect(withFigureApplied(two, READ)).toBe(two);
    const rows = [{ ...ROW }];
    expect(withFigureApplied(rows, { state: 'refused', reasons: ['unproved'] })).toBe(rows);
    expect(withFigureApplied(rows, { state: 'unavailable', reason: 'recognition_unavailable' })).toBe(rows);
    expect(withFigureApplied(rows, null)).toBe(rows);
  });

  it('is read back from a checkpoint only in exactly the shape it was written', () => {
    expect(readFigureVerdict(JSON.parse(JSON.stringify(READ)))).toEqual(READ);
    expect(readFigureVerdict({ ...READ, buildingSizeSqm: '124.5m²' })).toBeNull();
    expect(readFigureVerdict({ ...READ, provedBy: [] })).toBeNull();
    expect(readFigureVerdict({ ...READ, provedBy: ['a guess'] })).toBeNull();
    expect(readFigureVerdict({ state: 'refused', reasons: ['unproved', 'no_total'] }))
      .toEqual({ state: 'refused', reasons: ['unproved', 'no_total'] });
    expect(readFigureVerdict({ state: 'maybe' })).toBeNull();
  });
});
