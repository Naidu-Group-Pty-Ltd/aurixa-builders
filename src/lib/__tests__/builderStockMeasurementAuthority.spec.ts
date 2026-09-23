/**
 * THE PAGE THAT PRICES THE PROPERTY IS THE PAGE THAT MEASURES IT.
 *
 * The rule `measurementAuthority.pure.ts` states, asserted twice: once on the
 * settlement itself, where every tier boundary can be named, and once through
 * `readPdfBrochure`, where the same boundaries are reached the way a builder's
 * document reaches them. The production brochure that forced the rule is
 * asserted run for run in `builderStockLot927Geometry.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  settleMeasurement,
  type MeasurementComparison,
  type MeasurementStatement,
} from '../../../supabase/functions/_shared/builderStock/measurementAuthority.pure';
import {
  readPdfBrochure,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

// ---------------------------------------------------------------------------
// The settlement
// ---------------------------------------------------------------------------

/**
 * The reader's own comparison, restated for figures alone: two writings are
 * one measurement where they agree at the coarser one's precision.
 */
const decimals = (value: string) => value.match(/\.(\d+)/)?.[1].length ?? 0;
const compare: MeasurementComparison = {
  same: (_field, a, b) => {
    const places = Math.min(decimals(a), decimals(b));
    return Math.round(Number.parseFloat(a) * 10 ** places)
      === Math.round(Number.parseFloat(b) * 10 ** places);
  },
  finer: (a, b) => decimals(a) > decimals(b),
};

const LAND = 'land_size_sqm';
const BUILD = 'building_size_sqm';
const at = (page: number, value: string, field = LAND, via = 'labelled'): MeasurementStatement =>
  ({ field, value, via, page });

const settle = (
  statements: MeasurementStatement[],
  pricePages: number[],
  field = LAND,
  propertySchedule?: () => { value: string; via: string } | null,
) => settleMeasurement({
  field, statements, pricePages: new Set(pricePages), compare, propertySchedule,
});

describe('settling one measurement', () => {
  it('keeps the property page\'s figure over a different one elsewhere, and says so', () => {
    expect(settle([at(0, '294'), at(1, '309.45')], [0]))
      .toEqual({ kind: 'read', value: '294', via: 'labelled', outranked: true });
  });

  it('takes another page\'s finer writing of the same measurement', () => {
    expect(settle([at(0, '402'), at(1, '401.86')], [0]))
      .toEqual({ kind: 'read', value: '401.86', via: 'labelled', outranked: false });
  });

  it('refines to the finest of several agreeing writings, whatever their order', () => {
    const forward = settle([at(0, '402'), at(1, '401.9'), at(2, '401.86')], [0]);
    const backward = settle([at(0, '402'), at(2, '401.86'), at(1, '401.9')], [0]);
    expect(forward).toEqual({ kind: 'read', value: '401.86', via: 'labelled', outranked: false });
    expect(backward).toEqual(forward);
  });

  it('does not choose between two refinements that disagree with each other', () => {
    // Both round to 402; they disagree in a digit 402 does not state.
    expect(settle([at(0, '402'), at(1, '401.86'), at(2, '402.40')], [0]))
      .toEqual({ kind: 'read', value: '402', via: 'labelled', outranked: false });
  });

  it('lets another page fill a figure the property page never states', () => {
    expect(settle([at(1, '401.20')], [0]))
      .toEqual({ kind: 'read', value: '401.20', via: 'labelled', outranked: false });
  });

  it('reads the other pages by the ordinary rule when they are all there is', () => {
    expect(settle([at(1, '401.20'), at(2, '398')], [0])).toEqual({ kind: 'disputed' });
  });

  it('leaves a property page that disagrees with itself disputed — no other page settles it', () => {
    expect(settle([at(0, '117.50'), at(0, '119.16'), at(1, '117.50')], [0]))
      .toEqual({ kind: 'disputed' });
  });

  it('never revives a disputed field with a third statement', () => {
    expect(settle([at(0, '294'), at(0, '309.45'), at(0, '294')], [0]))
      .toEqual({ kind: 'disputed' });
    expect(settle([at(0, '294'), at(1, '309.45'), at(2, '294')], []))
      .toEqual({ kind: 'disputed' });
  });

  it('reads a document that prices nothing exactly as before: one tier, in order', () => {
    expect(settle([at(0, '294'), at(1, '309.45')], [])).toEqual({ kind: 'disputed' });
    expect(settle([at(0, '321'), at(1, '320.72')], []))
      .toEqual({ kind: 'read', value: '320.72', via: 'labelled', outranked: false });
    expect(settle([], [])).toEqual({ kind: 'none' });
  });

  it('settles nothing a field never stated', () => {
    expect(settle([at(0, '129.5', BUILD)], [0], LAND)).toEqual({ kind: 'none' });
  });
});

describe('the house\'s own schedule', () => {
  const schedule = () => ({ value: '129.5m2', via: 'area_schedule' });

  it('outranks a build size another page labels', () => {
    expect(settle([at(1, '131.6', BUILD)], [0], BUILD, schedule))
      .toEqual({ kind: 'read', value: '129.5m2', via: 'area_schedule', outranked: true });
  });

  it('is not asked where the property page labels the build', () => {
    const asked = vi.fn(schedule);
    expect(settle([at(0, '130', BUILD), at(1, '131.6', BUILD)], [0], BUILD, asked))
      .toEqual({ kind: 'read', value: '130', via: 'labelled', outranked: true });
    expect(asked).not.toHaveBeenCalled();
  });

  it('is not asked where the property page disputes the build', () => {
    const asked = vi.fn(schedule);
    expect(settle([at(0, '130', BUILD), at(0, '135', BUILD)], [0], BUILD, asked))
      .toEqual({ kind: 'disputed' });
    expect(asked).not.toHaveBeenCalled();
  });

  it('leaves the other pages to speak where the property page draws none', () => {
    expect(settle([at(1, '131.6', BUILD)], [0], BUILD, () => null))
      .toEqual({ kind: 'read', value: '131.6', via: 'labelled', outranked: false });
  });
});

// ---------------------------------------------------------------------------
// Through the reader
// ---------------------------------------------------------------------------

const page = (...lines: string[]) => lines.join('\n');
const IDENTITY = ['Lot 208 Fairweather Drive', 'Home Design: Aspire 24 Grande'];
const SITING = (land: string, build: string) => page(
  'Site Address: Lot 208 FAIRWEATHER DRIVE', 'Site Coverage: 42.5%',
  `Site Area: ${land}`, `Build Area: ${build}`,
  'This siting is subject to developer approval.');

const readRow = (pages: string[]) => {
  const reading = readPdfBrochure(pages);
  expect(reading.status).toBe('complete');
  expect(reading.rows).toHaveLength(1);
  return { reading, row: normaliseStockRow(reading.rows[0])! };
};

describe('a package brochure and its siting plan', () => {
  it('reads the property page\'s land and build, not the siting\'s', () => {
    const { reading, row } = readRow([
      page(...IDENTITY, 'Package Price: $780,050', 'Land Size: 294 m2', 'Build Size: 129.5 m2'),
      SITING('309.45 m2', '131.6 m2'),
    ]);
    expect([row.land_size_sqm, row.building_size_sqm]).toEqual([294, 129.5]);
    expect(reading.diagnostics.outrankedFields).toEqual(['building_size_sqm', 'land_size_sqm']);
    expect(reading.diagnostics.disputedFields).toBeUndefined();
  });

  it('reads the same with the siting plan first', () => {
    const { row } = readRow([
      SITING('309.45 m2', '131.6 m2'),
      page(...IDENTITY, 'Package Price: $780,050', 'Land Size: 294 m2', 'Build Size: 129.5 m2'),
    ]);
    expect([row.land_size_sqm, row.building_size_sqm]).toEqual([294, 129.5]);
  });

  it('still takes the siting\'s exact writing of the same lot', () => {
    const { reading, row } = readRow([
      page(...IDENTITY, 'Package Price: $662,900', 'Lot Size: 402m2'),
      SITING('401.86 m2', '237.50 m2'),
    ]);
    expect(row.land_size_sqm).toBe(401.86);
    expect(row.building_size_sqm).toBe(237.5);
    expect(reading.diagnostics.outrankedFields).toBeUndefined();
  });

  it('still reads the siting where the property page states no sizes', () => {
    const { row } = readRow([
      page(...IDENTITY, 'Package Price: $712,000'),
      SITING('375 m2', '201 m2'),
    ]);
    expect([row.land_size_sqm, row.building_size_sqm]).toEqual([375, 201]);
  });

  it('still disputes a figure the property page states two ways', () => {
    const { reading, row } = readRow([
      page(...IDENTITY, 'Package Price: $863,850',
        'Build Size: 117.50 m2', 'Build Size: 119.16 m2'),
      SITING('320.72 m2', '117.50 m2'),
    ]);
    expect(row.building_size_sqm).toBeNull();
    expect(reading.diagnostics.disputedFields).toEqual(['building_size_sqm']);
  });

  it('reads a document that prices nothing exactly as it always did', () => {
    const { reading, row } = readRow([
      page(...IDENTITY, 'Land Size: 294 m2'),
      SITING('309.45 m2', '131.6 m2'),
    ]);
    expect(row.land_size_sqm).toBeNull();
    expect(row.building_size_sqm).toBe(131.6);
    expect(reading.diagnostics.disputedFields).toEqual(['land_size_sqm']);
    expect(reading.diagnostics.outrankedFields).toBeUndefined();
  });
});

describe('one estate, spelled with and without the word', () => {
  const estateOf = (pages: string[]) => readRow(pages).row.development_name;

  it('is one estate, in the spelling that names it one, whichever page comes first', () => {
    const cover = page(...IDENTITY, 'Price: $780,050', 'Estate: Aurora Park Estate');
    const siting = page('Site Address: Lot 208 FAIRWEATHER DRIVE', 'Estate: Aurora Park');
    expect(estateOf([cover, siting])).toBe('Aurora Park Estate');
    expect(estateOf([siting, cover])).toBe('Aurora Park Estate');
  });

  it('is still two estates where the names differ', () => {
    const { reading, row } = readRow([
      page(...IDENTITY, 'Price: $780,050', 'Estate: Aurora Park Estate'),
      page('Site Address: Lot 208 FAIRWEATHER DRIVE', 'Estate: Aurora Rise'),
    ]);
    expect(row.development_name).toBeNull();
    expect(reading.diagnostics.disputedFields).toContain('development_name');
  });
});
