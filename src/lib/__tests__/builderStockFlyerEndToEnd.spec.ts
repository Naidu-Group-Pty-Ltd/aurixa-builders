/**
 * ONE WRONG READ, A BROKEN TITLE AND A BLANK CARD.
 *
 * `LOT 48 - EMBER - FLYER` imported on 21 September 2026 with the title
 * `Unit 115.30m 12.41sq, 35 Cockrell Rd` and no photograph, under
 * `image_work_last_result: supplied evidence no_evidence` — two symptoms that
 * looked unrelated and were the same defect.
 *
 * The flyer's floor plan carries an AREA SCHEDULE — `GARAGE:`, `PORCH:`,
 * `COURT:`, `TOTAL:` and `UNIT:` — and `Unit` is a heading this vocabulary
 * reads as an identifier, so the reader claimed
 * `unit_number: "115.30m 12.41sq"`. `stockRecordLabel` puts the designation
 * FIRST, which is the title; and the SAME label is what `pageStatesIdentity`
 * matches a page against, so no page could state the property's identity and
 * the election refused the builder's own render.
 *
 * WHAT THIS FIXTURE IS. The lines and coordinates below are the ones that
 * import actually reported from production, read back out of its own
 * `placement` record — every line the reader could not name, at the band and
 * column it was drawn in. The right-hand column's own bands are
 * RECONSTRUCTED from the flyer, because a line the reader CLAIMED never
 * reaches that record; they are placed clear of the icon row so the fixture
 * exercises one reading at a time rather than reproducing a collision it was
 * not written to measure.
 *
 * It drives the real reader, the real label composer and the real cover
 * election, end to end, the way the card is built.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow, stockRecordLabel, stockIdentityHints,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  findPropertyCoverPages,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

const yOf = (band: number) => 780 - band * 14;
const at = (band: number, x: number, text: string): PdfTextItem =>
  ({ text, x, y: yOf(band), width: text.length * 5 });

/** `LOT 48 - EMBER - FLYER`, page 1, at its measured bands. */
const LOT_48: PdfTextItem[] = [
  at(0, 36, 'HAVENWOOD'),
  at(3, 36, 'Ember'),
  at(4, 88, '4'), at(4, 172, '2'), at(4, 260, '1'),
  at(5, 276, '35 Cockrell Rd,'),
  at(6, 276, 'Mernda VIC 3754'),
  at(2, 276, 'Lot 48'),
  at(2, 400, 'Sale Price - $810,000'),
  at(3, 400, 'Land Size - 299sqm'),
  at(9, 400, 'Build Size - 148sqm'),
  at(7, 47, 'Front and rear landscaping, driveway + fencing'),
  at(12, 118, '52, 53, 54'),
  at(15, 47, '20mm stone benchtopsAREA SCHEDULE'),
  // The area schedule, which is what broke it.
  at(17, 119, 'UNIT:'), at(17, 141, '115.30m² 12.41sq'),
  at(18, 119, 'GARAGE:'), at(18, 141, '22.59m² 2.43sq'),
  at(19, 119, 'PORCH:'), at(19, 142, '6.89m²'),
  at(21, 119, 'COURT:'), at(21, 142, '3.48m²'),
  at(23, 119, 'TOTAL:'), at(23, 141, '148.26m 15.96sq'),
  at(26, 119, 'SPOS'), at(26, 141, '107.44m'),
  at(29, 47, '600mm European appliances inc dishwasher'),
  at(35, 47, 'Window furnishings and flyscreens'),
  // The floor plan's own room names, which is what corroborates the icon row.
  at(16, 291, 'BED 4'),
  at(29, 238, 'GARAGE'),
  at(41, 235, 'BED 3'),
  at(52, 233, 'BED 2'),
  at(56, 239, 'ENS'),
  at(60, 238, 'MASTER'),
];

const FILENAME = 'LOT 48 - EMBER - FLYER.pdf';

/** The page text the election reads, as the flyer prints it. */
const PAGE_TEXT = [
  'HAVENWOOD', 'Lot 48', 'Ember', 'Sale Price - $810,000',
  'Land Size - 299sqm', 'Build Size - 148sqm', '4 2 1',
  '35 Cockrell Rd,', 'Mernda VIC 3754',
  'LOT 46, 47, 48, 49,', '52, 53, 54',
].join('\n');

const reading = readPdfBrochure(
  [LOT_48.map((item) => item.text).join('\n')],
  { positionedPages: [{ page: 1, items: LOT_48 }], filename: FILENAME },
);
const record = reading.rows.length
  ? normaliseStockRow(reading.rows[0])
  : (reading.provisional.length ? normaliseStockRow(reading.provisional[0]) : null);

describe('a floor plan\'s area schedule is not an identifier', () => {
  it('claims no unit number from `UNIT: 115.30m² 12.41sq`', () => {
    expect(record?.unit_number ?? null).toBeNull();
  });

  it('declines it by name rather than dropping it silently', () => {
    expect(reading.diagnostics.declinedFields ?? []).toContain('unit_number');
  });

  it('still reads the lot the flyer states', () => {
    expect(record?.lot_number).toBe('48');
  });

  it('still reads every figure around it', () => {
    expect(record?.price).toBe(810000);
    expect(record?.land_size_sqm).toBe(299);
    expect(record?.building_size_sqm).toBe(148);
    expect(record?.bedrooms).toBe(4);
    expect(record?.bathrooms).toBe(2);
    expect(record?.car_spaces).toBe(1);
  });
});

describe('the title a client reads', () => {
  it('names the lot and the street, not a floor area', () => {
    const label = stockRecordLabel(record!);
    expect(label).toContain('Lot 48');
    expect(label).not.toContain('115.30');
    expect(label).not.toMatch(/\bsq\b/);
  });

  it('carries the address the flyer prints', () => {
    expect(record?.address_line).toBe('35 Cockrell Rd');
    expect(record?.suburb).toBe('Mernda');
    expect(record?.state).toBe('VIC');
    expect(record?.postcode).toBe('3754');
  });

  it('reads the design the builder named in the file and on the page', () => {
    // `Ember` is printed bare at the top and is in the filename. Two
    // independent sources agreeing is not a guess.
    expect(record?.house_design).toBe('Ember');
  });
});

describe('the builder\'s own render reaches the card', () => {
  it('finds a cover page for this property', () => {
    /*
     * `pageStatesIdentity` matches the page against the row's LABEL, so the
     * garbage designation was what refused the render. With the label clean,
     * the flyer's own page states the lot, the street and the design.
     */
    const covers = findPropertyCoverPages(
      [PAGE_TEXT], stockRecordLabel(record!), stockIdentityHints(record!), true);
    expect(covers).toHaveLength(1);
    expect(covers[0].page).toBe(1);
  });

  it('was refused while the label carried the floor area', () => {
    // The defect, reproduced: the exact label production stored.
    const covers = findPropertyCoverPages(
      [PAGE_TEXT], 'Unit 115.30m 12.41sq, 35 Cockrell Rd', [], true);
    expect(covers).toHaveLength(0);
  });
});
