/**
 * THE WAYS A BROCHURE SETS A SPECIFICATION LINE, READ AS THE PAGE MEANS THEM.
 *
 * Found 24 September 2026 by probing the reader with the forms brochures use,
 * after the four production layouts of reader 19 were read. Each of these lost
 * a printed fact with the reading still reporting `complete`, and one refused
 * a whole brochure:
 *
 *   `Beds: 4 Baths: 2 Cars: 2`            one pair, "4 Baths: 2 Cars: 2", declined
 *   `Land: 448m² | Frontage: 14m`         the same, the land size lost
 *   `Land Size 512m²  Frontage 16m`       refused whole: `Frontage` is not stored
 *   `Home 24.6 sq`                        the heading was the design, the line unread
 *   `House: 220m²`                        the DESIGN "220m²", and beside a
 *                                         labelled design, a conflict that
 *                                         refused the brochure
 */
import { describe, expect, it } from 'vitest';

import { acceptFieldValue } from '../../../supabase/functions/_shared/builderStock/fieldTypes.pure';
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { readPdfBrochure } from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

const IDENTITY = ['LOT 44 Currawong Crescent', 'Leppington NSW 2179'];
const read = (lines: string[]) => {
  const reading = readPdfBrochure([[...IDENTITY, ...lines].join('\n')]);
  return { reading, row: reading.rows[0] ? normaliseStockRow(reading.rows[0]) : null };
};

describe('several `Label: value` pairs on one line', () => {
  it('reads every pair', () => {
    const { reading, row } = read(['Beds: 4 Baths: 2 Cars: 2']);
    expect(reading.status).toBe('complete');
    expect([row?.bedrooms, row?.bathrooms, row?.car_spaces]).toEqual([4, 2, 2]);
  });

  it('reads pairs set apart by a separator, and a frontage between them claims nothing', () => {
    const { row } = read(['Land: 448m² | House: 212m²']);
    expect(row?.land_size_sqm).toBe(448);
    expect(row?.building_size_sqm).toBe(212);
    const land = read(['Land: 448m² | Frontage: 14m']).row;
    expect(land?.land_size_sqm).toBe(448);
  });

  it('reads nothing where a colon does not end a label: a time, an address, a ratio', () => {
    for (const line of ['Open Saturday 10:30 - 4:00', 'Visit: https://example.test/lots', 'Ratio 1:2:3']) {
      const { reading } = read([line]);
      expect(reading.rows[0]?.bedrooms ?? null).toBeNull();
      expect(reading.rows[0]?.land_size_sqm ?? null).toBeNull();
    }
  });

  it('leaves a single pair to the reader it always was', () => {
    expect(read(['Bedrooms: 4']).row?.bedrooms).toBe(4);
    expect(read(['Price: $845,000']).row?.price).toBe(845000);
  });
});

describe('a frontage beside the land', () => {
  it('does not cost the land size', () => {
    expect(read(['Land Size 512m²  Frontage 16m  Depth 32m']).row?.land_size_sqm).toBe(512);
    expect(read(['Land Size 450m2 Frontage 15 m']).row?.land_size_sqm).toBe(450);
    expect(read(['Land 600m² Street Frontage 18m']).row?.land_size_sqm).toBe(600);
  });

  it('is never read as a size', () => {
    const { row } = read(['Frontage 16m', 'Depth 32m']);
    expect(row?.land_size_sqm ?? null).toBeNull();
    expect(row?.building_size_sqm ?? null).toBeNull();
  });
});

describe('a heading over a measurement is the measurement, never a name', () => {
  it('`House: 220m²` is the house, and a labelled design stands beside it', () => {
    const { reading, row } = read(['Design: Aurora 25', 'House: 220m²']);
    expect(reading.status).toBe('complete');
    expect(row?.house_design).toBe('Aurora 25');
    expect(row?.building_size_sqm).toBe(220);
  });

  it('composes the heading with an area written in squares, inline or after a colon', () => {
    expect(read(['Home 24.6 sq']).row?.building_size_sqm).toBe(228.54);
    expect(read(['House: 24.6 squares']).row?.building_size_sqm).toBe(228.54);
  });

  it('refuses a figure and its unit as a name, by name, on every path', () => {
    const { reading, row } = read(['Home Design: 24.6 sq']);
    expect(row?.house_design ?? null).toBeNull();
    expect(reading.diagnostics.declinedBecause ?? []).toContain('house_design:a_measurement_is_not_a_name');
    expect(acceptFieldValue('house_design', '220m²'))
      .toEqual({ accepted: false, reason: 'a_measurement_is_not_a_name' });
    expect(acceptFieldValue('suburb', '0.5 acres'))
      .toEqual({ accepted: false, reason: 'a_measurement_is_not_a_name' });
  });

  it('leaves every real name alone', () => {
    for (const name of ['Aurora 25', 'Nex 20', 'Enzo 10.5', 'Cura 20B', 'Square One', '12 Acres Road']) {
      expect(acceptFieldValue('house_design', name).accepted).toBe(true);
    }
  });

  it('never makes a heading over a LENGTH an area heading', () => {
    // `m` is square metres to the normaliser only once a field has said so.
    const { row } = read(['House: 12m wide frontage']);
    expect(row?.building_size_sqm ?? null).toBeNull();
  });
});
