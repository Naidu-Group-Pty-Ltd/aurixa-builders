/**
 * THE UNIT PRINTED BESIDE A MEASUREMENT IS PART OF IT.
 *
 * `House Size` over `21.5 squares` reached the row as a 21.5 m² house,
 * `1.2 acres` as a 1.2 m² block, and `HOUSE` over `24.6 sq` wrote the figure
 * into the design and refused the whole brochure. What each unit measures is
 * `areaUnits.pure.ts`, and every conversion there is a definition. See that
 * file's header for the rule and what it leaves alone.
 */
import { describe, expect, it } from 'vitest';

import {
  areaInSquareMetres, SQUARE_METRES_PER_ACRE, SQUARE_METRES_PER_SQUARE,
  statesAreaInAnotherUnit, unitConvertsArea,
} from '../../../supabase/functions/_shared/builderStock/areaUnits.pure';
import { acceptFieldValue } from '../../../supabase/functions/_shared/builderStock/fieldTypes.pure';
import {
  coerceArea, normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { readPdfBrochure } from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

const house = (raw: string) => areaInSquareMetres(raw, 'building_size_sqm');
const land = (raw: string) => areaInSquareMetres(raw, 'land_size_sqm');
const cents = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

describe('every conversion is a definition', () => {
  it('a square is a hundred square feet, and an acre is exact', () => {
    expect(SQUARE_METRES_PER_SQUARE).toBe(100 * 0.3048 * 0.3048);
    expect(SQUARE_METRES_PER_ACRE).toBeCloseTo(43_560 * 0.3048 * 0.3048, 7);
  });

  it('reads a house in squares, however the squares are written', () => {
    for (const raw of ['21.5 squares', '21.5 square', '21.5 sq', '21.5sq', '21.5 SQ', '21.5 sq.', '21.5 sqs']) {
      expect(cents(house(raw))).toBe(199.74);
    }
  });

  it('reads square feet on either field, and hectares and acres on land', () => {
    expect(cents(house('2,150 sq ft'))).toBe(199.74);
    expect(cents(land('2,000 sqft'))).toBe(185.81);
    expect(cents(land('2000 ft²'))).toBe(185.81);
    expect(land('0.5 ha')).toBe(5_000);
    expect(land('2 hectares')).toBe(20_000);
    expect(cents(land('0.5 acres'))).toBe(2_023.43);
    expect(cents(land('1.2 ac'))).toBe(4_856.23);
  });

  it('leaves square metres, and a bare number, exactly as they were', () => {
    for (const raw of ['350m2', '350 m²', '350 sqm', '350 sq m', '350 sq. m', '350 square metres', '350m', '350']) {
      expect(land(raw)).toBe(350);
    }
  });

  it('keeps `sq` on land as square metres cut short, because land is not sold in squares', () => {
    expect(land('350 sq')).toBe(350);
    expect(unitConvertsArea('350 sq', 'land_size_sqm')).toBe(false);
    expect(unitConvertsArea('21.5 sq', 'building_size_sqm')).toBe(true);
  });
});

describe('where the unit and the field cannot both be true, the size is absent', () => {
  it('a house is never measured in hectares or acres', () => {
    expect(house('1 ha')).toBeNull();
    expect(house('0.1 acres')).toBeNull();
  });

  it('a block is never measured in squares', () => {
    expect(land('21.5 squares')).toBeNull();
  });

  it('a hundred squares is 929 m², and past that "squares" is not a dwelling', () => {
    expect(cents(house('99.5 squares'))).toBe(924.39);
    expect(house('150 sq')).toBeNull();
    expect(house('215 squares')).toBeNull();
  });

  it('a length is never an area', () => {
    // `2000 feet` names no unit here, so it is not converted: the reader never
    // takes it (see below), and this module reads it as it always read a
    // number with a word after it.
    expect(unitConvertsArea('2000 feet', 'land_size_sqm')).toBe(false);
  });

  it('names an area in another unit before any field is known, and a length never', () => {
    expect(statesAreaInAnotherUnit('24.6 sq')).toBe(true);
    expect(statesAreaInAnotherUnit('0.5 acres')).toBe(true);
    expect(statesAreaInAnotherUnit('2,000 sq ft')).toBe(true);
    // Square metres are every reader's own spelling already, and `15m` is a length.
    expect(statesAreaInAnotherUnit('450m²')).toBe(false);
    expect(statesAreaInAnotherUnit('15m')).toBe(false);
    expect(statesAreaInAnotherUnit('Aurora 25')).toBe(false);
    expect(statesAreaInAnotherUnit('$899,000')).toBe(false);
  });
});

describe('the normaliser, which every source reaches the card through', () => {
  it('stores square metres, converted', () => {
    const row = normaliseStockRow({
      lot_number: '12', building_size_sqm: '28.6 squares', land_size_sqm: '0.5 acres',
    })!;
    expect(row.building_size_sqm).toBe(265.7);
    expect(row.land_size_sqm).toBe(2023.43);
  });

  it('still refuses what the domain cannot hold, after converting', () => {
    // Thirteen acres is 52,611 m², past the fifty-thousand ceiling.
    expect(normaliseStockRow({ lot_number: '1', land_size_sqm: '13 acres' })!.land_size_sqm).toBeNull();
    expect(normaliseStockRow({ lot_number: '1', land_size_sqm: '12 acres' })!.land_size_sqm).toBe(48562.28);
  });

  it('reads a number as it always did', () => {
    expect(coerceArea(178.23, 'building_size_sqm')).toBe(178.23);
    expect(coerceArea('178.23', 'building_size_sqm')).toBe(178.23);
    expect(coerceArea('n/a', 'building_size_sqm')).toBeNull();
    expect(normaliseStockRow({ lot_number: '1', land_size_sqm: '1,191' })!.land_size_sqm).toBe(1191);
  });
});

describe('the typed gate judges a converting unit by what it measures', () => {
  it('half an acre is a block, not half a square metre', () => {
    expect(acceptFieldValue('land_size_sqm', '0.5 acres').accepted).toBe(true);
    expect(acceptFieldValue('land_size_sqm', '0.5 ha').accepted).toBe(true);
    expect(acceptFieldValue('building_size_sqm', '28.6 SQ.').accepted).toBe(true);
  });

  it('refuses a unit the field is not measured in, by name', () => {
    expect(acceptFieldValue('building_size_sqm', '1 ha'))
      .toEqual({ accepted: false, reason: 'area_unit_does_not_measure_this' });
    expect(acceptFieldValue('land_size_sqm', '21.5 squares'))
      .toEqual({ accepted: false, reason: 'area_unit_does_not_measure_this' });
  });

  it('judges every other value exactly as before', () => {
    expect(acceptFieldValue('land_size_sqm', '334,000')).toEqual({ accepted: false, reason: 'area_out_of_range' });
    expect(acceptFieldValue('land_size_sqm', '$334,000')).toEqual({ accepted: false, reason: 'money_is_not_an_area' });
    expect(acceptFieldValue('land_size_sqm', '350 sq').accepted).toBe(true);
    expect(acceptFieldValue('building_size_sqm', '0.4')).toEqual({ accepted: false, reason: 'area_out_of_range' });
  });
});

describe('a brochure, read end to end', () => {
  const IDENTITY = ['LOT 12 Wattle Grove Road', 'Stoneleigh Rise Estate, Bungendore NSW 2621'];
  const read = (lines: string[]) => {
    const reading = readPdfBrochure([[...IDENTITY, ...lines].join('\n')]);
    return { reading, row: reading.rows[0] ? normaliseStockRow(reading.rows[0]) : null };
  };

  it('reads the units a builder writes inline, where the whole line used to be set aside', () => {
    const { row } = read(['House Size 28.6 squares', 'Land Size 0.5 acres', 'PACKAGE PRICE $1,245,000']);
    expect(row?.building_size_sqm).toBe(265.7);
    expect(row?.land_size_sqm).toBe(2023.43);
    expect(row?.price).toBe(1245000);
    expect(cents(coerceArea('2,000 sq ft', 'land_size_sqm'))).toBe(185.81);
    expect(read(['Land Size 2,000 sq ft']).row?.land_size_sqm).toBe(185.81);
  });

  it('never writes a figure in squares into the design', () => {
    const { reading, row } = read(['Home Design: Aurora 25', 'HOUSE', '24.6 sq']);
    expect(reading.status).toBe('complete');
    expect(row?.house_design).toBe('Aurora 25');
    expect(row?.building_size_sqm).toBe(228.54);
  });

  it('takes a unit word after `sq` or `square` only, so a length stays unread', () => {
    const { row } = read(['Land Size 2000 feet']);
    expect(row?.land_size_sqm ?? null).toBeNull();
    expect(read(['Land Size 350 square metres']).row?.land_size_sqm).toBe(350);
  });

  it('names a size in a unit its field is not measured in, rather than dropping it', () => {
    const { reading, row } = read(['Land Size 21.5 squares']);
    expect(row?.land_size_sqm ?? null).toBeNull();
    expect(reading.diagnostics.declinedBecause ?? [])
      .toContain('land_size_sqm:area_unit_does_not_measure_this');
  });
});
