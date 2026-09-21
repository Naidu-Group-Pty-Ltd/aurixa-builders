/**
 * A ROW BAND WITH NOTHING IN THIS COLUMN IS NOT BETWEEN A LABEL AND ITS VALUE.
 *
 * WHAT THIS FIXTURE IS. Not an invented shape: the coordinates below are the
 * ones `LOT 266 Crowlea Estate - CURA 20B TEMPIO B` actually reported from
 * production on 21 September 2026, read back out of the import's own
 * `placement` record — the page, the row band and the left edge of every line
 * the reader placed and could not name.
 *
 *     r38  x29   Lot Size
 *     r39  x486  WIR          r39  x534  Ensuite
 *     r40  x29   520m2
 *     r42  x29   House Specifications
 *     r43  x29   Ground Floor:
 *     r45  x29   Garage:      r45  x101  36.0m2
 *
 * `Lot Size` and `520m2` are the same column to the unit, one band apart,
 * and what sits between them is two room names from the floor plan drawn
 * three hundred units away on the other side of the sheet. The property's
 * land size was printed directly under its own label and read by nothing,
 * which is why that card showed no land size at all.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

/** A band's `y`, so the reader lays the rows out in the order the page did. */
const yOf = (band: number) => 780 - band * 14;

const at = (band: number, x: number, text: string): PdfTextItem =>
  ({ text, x, y: yOf(band), width: text.length * 5 });

/**
 * The summary block and the specifications box, at their measured bands.
 * Enough of the page for the reader to accept it as a brochure, and nothing
 * invented beyond the lines the production capture named.
 */
const LOT_266_ITEMS: PdfTextItem[] = [
  at(0, 28, 'Cura 20B'),
  at(1, 81, '4'), at(1, 165, '2'), at(1, 249, '2'),
  at(2, 29, 'Land - $334,000'),
  at(3, 30, 'Build - $415,100'),
  at(4, 29, 'Price - $749,100'),
  at(6, 29, 'Estate Warragul'),
  at(7, 29, 'Titles - Q2 2027'),
  at(12, 514, 'Bed 3'),
  at(18, 523, 'Powder'),
  at(22, 528, 'Bath'),
  // The label, a band of the drawing beside it, then the value.
  at(38, 29, 'Lot Size'),
  at(39, 486, 'WIR'), at(39, 534, 'Ensuite'),
  at(40, 29, '520m2'),
  at(41, 507, 'Master Bed'),
  at(42, 29, 'House Specifications'),
  at(43, 29, 'Ground Floor:'), at(44, 101, '140.0m'),
  at(45, 29, 'Garage:'), at(45, 101, '36.0m2'),
  at(46, 29, 'Porch:'), at(47, 101, '1.5m'),
  at(49, 29, 'Total:'), at(50, 101, '177.0m'),
  at(52, 29, 'Lot 266'),
];

const reading = readPdfBrochure(
  [LOT_266_ITEMS.map((item) => item.text).join('\n')],
  { positionedPages: [{ page: 1, items: LOT_266_ITEMS }] },
);
const record = reading.rows.length ? normaliseStockRow(reading.rows[0]) : null;

describe('a label reaches the value printed under it', () => {
  it('reads the land size the page states', () => {
    // 520 m², under `Lot Size`, one band clear of it.
    expect(record?.land_size_sqm).toBe(520);
  });

  it('never reads it as the land PRICE beside it', () => {
    // `Land - $334,000` is the same field's label with a currency value, and
    // it is declined — so the figure that reaches the column can only be the
    // measured one.
    expect(reading.diagnostics.declinedFields ?? []).toContain('land_size_sqm');
    expect(record?.land_size_sqm).not.toBe(334000);
  });

  it('pairs no heading with the heading under it', () => {
    // `Ground Floor:` is two bands above `Garage:` in the same column now
    // that the band between them is skipped. A heading under a heading is a
    // layout, not a statement, and `readVerticalPair` refuses it.
    expect(record?.building_size_sqm ?? null).toBeNull();
  });

  it('never spends a garage AREA as a car space', () => {
    // `Garage:` resolves to `car_spaces` and `36.0m2` is beside it.
    expect(record?.car_spaces).not.toBe(36);
  });
});

describe('a spaced hyphen is a separator and a hyphen is not', () => {
  it('reads a completion date written with one', () => {
    expect(record?.expected_completion).toBe('Q2 2027');
  });

  it('leaves a design name that carries a hyphen whole', () => {
    // `ENZO 10.5 - MODERN` splits to `ENZO 10.5`, which resolves to no
    // field, so the line falls through to every reader that had it before.
    const design = readPdfBrochure(['Lot: 315\n'
      + 'Estate: Palomino Estate\n'
      + 'Design: ENZO 10.5 - MODERN\n'
      + 'Bedrooms: 4\nBathrooms: 2\nCar Spaces: 2\nPrice: $863,850']);
    expect(normaliseStockRow(design.rows[0])!.house_design).toBe('ENZO 10.5 - MODERN');
  });

  it('splits an unspaced hyphen at nothing', () => {
    // `Land-Size: 350 m2` is one label with a colon, not `Land` and a value
    // of `Size: 350 m2`.
    const tight = readPdfBrochure(['Lot: 315\n'
      + 'Estate: Palomino Estate\n'
      + 'Land-Size: 350 m2\n'
      + 'Bedrooms: 4\nBathrooms: 2\nCar Spaces: 2\nPrice: $863,850']);
    const row = normaliseStockRow(tight.rows[0]);
    expect(row?.land_size_sqm === 350 || row?.land_size_sqm === null).toBe(true);
  });
});
