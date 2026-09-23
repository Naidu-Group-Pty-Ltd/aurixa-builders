/**
 * AN AREA SCHEDULE READ OFF A PICTURE IS BELIEVED ONLY WHERE THE PICTURE'S
 * OWN ARITHMETIC PROVES IT.
 *
 * The texts below are what recognition actually produced. The first is
 * Tesseract's reading of the production `Lot 101 - PICO - BROCHURE v002.pdf`
 * page, rendered at 300 dpi, from the read-only reading trace — `m²` comes
 * back as `m?` and `m*`, and `7.11` as `7il`. The rest are the product's own
 * engine on schedule pictures of the same geometry. Each rule is shown beside
 * the twin it must refuse: a recognition error must never become a building
 * size on a client's card.
 */
import { describe, expect, it } from 'vitest';

import {
  areaProvedBySquares, readPictureSchedule, scheduleRowOf, squaresRestate, SQUARE_METRES_PER_SQUARE,
} from '../../../supabase/functions/_shared/builderStock/areaSchedulePicture.pure';

const PRODUCTION_PAGE_RENDER = [
  'AREA SCHEDULE Re Na =',
  'DWELLING: | 90.11m* 9.70sq z C',
  'GARAGE: 22.59m? | 2.43sq BaisHaaow ~ 5',
  'COURT: 4.69m? | 0.50sq =f C ‘fe',
  'PORCH: 7ilm? | 0.77sq E Si 2',
  'TOTAL: 124.50m? | 13.40sq ig',
].join('\n');

/**
 * The same production picture, read by the PRODUCT's engine after the
 * product's own preparation (`figureRaster.pure.ts`), from the read-only trace
 * of the stored document: every decimal point in the area column is lost or
 * read as a space, and every squares figure keeps its point.
 */
const PRODUCTION_PICTURE_POINT_LOST = [
  'AREA SCHEDULE',
  'DWELLING: 90.1lm*  9.70sq',
  'GARAGE:  2250m* 243s',
  'COURT: 460m*  050sq',
  'PORCH: Time 0.77sq',
  'TOTAL: 12450m*  13.40sq',
].join('\n');
const PRODUCTION_PICTURE_POINT_AS_SPACE = [
  'AREA SCHEDULE',
  'DWELLING: 90.11m* 9.70sq',
  'GARAGE: 22.59m? 2.43sq',
  'COURT: 4.69m* 0.50sq',
  'PORCH: 7.11m? 0.77sq',
  'TOTAL: 124 50m*  13.40sq',
].join('\n');

const CLEAN = [
  'AREA SCHEDULE',
  'DWELLING: 95.20m? 10.25sq',
  'GARAGE: 22.59m? 2.43sq',
  'COURT: 4.69m* 0.50sq',
  'PORCH: 7.1m? 0.77sq',
  'TOTAL: 129.59m? 13.95sq',
].join('\n');

describe('a total the picture proves', () => {
  it('reads the production schedule, proved by its squares, though a part is misread', () => {
    const { reading, refusal } = readPictureSchedule(PRODUCTION_PAGE_RENDER);
    expect(refusal).toBeNull();
    expect(reading?.value).toBe('124.50');
    expect(reading?.area).toBe(124.5);
    // `7ilm?` is not a figure, so the parts cannot prove it; the squares do.
    expect(reading?.provedBy).toEqual(['squares']);
  });

  it('reads the production picture whose total lost its decimal point, placed by its squares', () => {
    const { reading, refusal } = readPictureSchedule(PRODUCTION_PICTURE_POINT_LOST);
    expect(refusal).toBeNull();
    expect(reading).toMatchObject({ value: '124.50', area: 124.5, provedBy: ['squares'] });
  });

  it('reads it where the point came back as a space, proved both ways', () => {
    const { reading } = readPictureSchedule(PRODUCTION_PICTURE_POINT_AS_SPACE);
    expect(reading).toMatchObject({ value: '124.50', area: 124.5, provedBy: ['squares', 'parts'] });
  });

  it('reads a schedule every row of which is legible, proved both ways', () => {
    const { reading } = readPictureSchedule(CLEAN);
    expect(reading?.value).toBe('129.59');
    expect(reading?.provedBy).toEqual(['squares', 'parts']);
    expect(reading?.parts).toBe(4);
  });

  it('reads a schedule with no squares where every part is legible and they add up', () => {
    const text = ['Living: 180.20m2', 'Garage: 36.50m2', 'Alfresco: 14.30m2', 'Total: 231.00m2'].join('\n');
    expect(readPictureSchedule(text).reading).toMatchObject({ value: '231.00', provedBy: ['parts'] });
  });
});

describe('a total the picture does not prove', () => {
  it('refuses a misread total, however clearly it was recognised', () => {
    // 128.59 m² is 13.84 squares, and the picture printed 13.95.
    const text = CLEAN.replace('TOTAL: 129.59m?', 'TOTAL: 128.59m?');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'unproved' });
  });

  it('places a lost point only where the squares allow exactly one place, and never mends a digit', () => {
    // `12460`: no placement is 13.40 squares — 124.60 is 13.41.
    expect(readPictureSchedule(PRODUCTION_PICTURE_POINT_LOST.replace('12450m*', '12460m*')))
      .toMatchObject({ reading: null, refusal: 'unproved' });
    // A figure with no point and no squares is a figure of no known size.
    expect(readPictureSchedule(PRODUCTION_PICTURE_POINT_LOST.replace('13.40sq', '')))
      .toMatchObject({ reading: null, refusal: 'unproved' });
  });

  it('never proves a total by parts whose points were lost: they can agree at the wrong size', () => {
    // 90.1 + 22.5 + 4.7 + 7.2 = 124.5, every point lost, no squares: 1245 m².
    const text = ['DWELLING: 901m2', 'GARAGE: 225m2', 'COURT: 47m2', 'PORCH: 72m2', 'TOTAL: 1245m2'].join('\n');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'unproved' });
  });

  it('refuses a misread squares figure beside a legible total, where the parts cannot vouch', () => {
    const text = PRODUCTION_PAGE_RENDER.replace('13.40sq', '13.46sq');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'unproved' });
  });

  it('is stricter than the text reader: a builder\'s slip that text would take, a picture may not', () => {
    // `areaSchedule.pure.ts` takes 129.5 from parts of 133.01, a quarter either
    // side; recognised digits are not the document's own, so nothing here does.
    const text = ['Enclosed: 91.91m2', 'Garage: 38.10m2', 'Porch: 3m2', 'Total: 129.5m2'].join('\n');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'unproved' });
  });

  it('refuses a picture that states two different totals', () => {
    const text = `${CLEAN}\nTOTAL: 124.50m? 13.40sq`;
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'two_totals' });
  });

  it('refuses a total no house has', () => {
    const text = ['GARAGE: 3.00m2 0.32sq', 'TOTAL: 5.00m2 0.54sq'].join('\n');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'implausible' });
  });

  it('refuses a schedule whose total row is illegible', () => {
    const text = CLEAN.replace('TOTAL: 129.59m? 13.95sq', 'TOTAL: [soar | aay');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'no_total' });
  });
});

describe('what is not a house\'s schedule at all', () => {
  it('a land schedule names no part of a dwelling', () => {
    const text = ['Lot 1: 300m2', 'Lot 2: 350m2', 'TOTAL: 650m2'].join('\n');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'no_schedule' });
  });

  it('a price breakdown is money, never an area', () => {
    const text = ['Land - $238,500', 'Build - $366,000', 'TOTAL - $604,500'].join('\n');
    expect(readPictureSchedule(text)).toMatchObject({ reading: null, refusal: 'no_schedule' });
  });

  it('a picture recognition could not read', () => {
    const text = ['PweLENG [erie [970', 'carace [ie [a', 'coum [amr [05m', 'ca', 'TOTAL [soar | aay'].join('\n');
    expect(readPictureSchedule(text).reading).toBeNull();
  });
});

describe('a row, as recognition spells it', () => {
  it('reads each spelling of m² recognition produces, and never the squares as the area', () => {
    for (const unit of ['m²', 'm2', 'm?', 'm*', 'm®', 'mz', 'sqm', ' sq m']) {
      expect(scheduleRowOf(`TOTAL: 124.50${unit} 13.40sq`)).toMatchObject({
        total: true, area: 124.5, written: '124.50', squares: 13.4,
      });
    }
    expect(scheduleRowOf('GARAGE: 2.43sq')).toMatchObject({ written: null, area: null, squares: 2.43 });
  });

  it('keeps a figure whose point was lost as written, with no size until its squares give it one', () => {
    const lost = scheduleRowOf('TOTAL: 12450m*  13.40sq');
    expect(lost).toMatchObject({ written: '12450', area: null, squares: 13.4 });
    expect(areaProvedBySquares(lost!)).toEqual({ value: '124.50', area: 124.5 });
    const spaced = scheduleRowOf('TOTAL: 124 50m* 13.40sq');
    expect(spaced).toMatchObject({ written: '124 50', area: null });
    expect(areaProvedBySquares(spaced!)).toEqual({ value: '124.50', area: 124.5 });
    // A kept point is held to: the squares must restate THAT reading.
    expect(areaProvedBySquares(scheduleRowOf('TOTAL: 1245.0m2 13.40sq')!)).toBeNull();
  });

  it('reads a label ended by recognition\'s stray full stop, and a cell border as nothing', () => {
    expect(scheduleRowOf('COURT. | 4.69m? 0.50sq')).toMatchObject({ label: 'court', area: 4.69 });
  });

  it('is nothing for a line that names no part of a dwelling', () => {
    expect(scheduleRowOf('AREA SCHEDULE')).toBeNull();
    expect(scheduleRowOf('Site Coverage: 42.5%')).toBeNull();
  });
});

describe('the squares identity', () => {
  it('is the builder\'s own unit: 100 square feet', () => {
    expect(SQUARE_METRES_PER_SQUARE).toBe(9.290304);
    expect(squaresRestate(124.5, 13.4)).toBe(true);
    expect(squaresRestate(129.59, 13.95)).toBe(true);
    expect(squaresRestate(90.11, 9.7)).toBe(true);
  });

  it('breaks on a misread digit in either column', () => {
    expect(squaresRestate(124.3, 13.4)).toBe(false);
    expect(squaresRestate(724.5, 13.4)).toBe(false);
    expect(squaresRestate(124.5, 13.46)).toBe(false);
  });

  it('is exact, because a band is somewhere a misread can land', () => {
    // Measured: one preparation read 129.59 as 129.50 — 13.94 squares against
    // the printed 13.95. A hundredth's leeway would have taken it.
    expect(squaresRestate(129.5, 13.95)).toBe(false);
    // A publisher who truncates rather than rounds is still read:
    // 90.11 m² is 9.6993 squares, printed 9.70 rounded or 9.69 cut off.
    expect(squaresRestate(90.11, 9.7)).toBe(true);
    expect(squaresRestate(90.11, 9.69)).toBe(true);
    expect(squaresRestate(90.11, 9.68)).toBe(false);
  });
});
