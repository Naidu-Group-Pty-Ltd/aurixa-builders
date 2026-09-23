/**
 * THE PAGE AS PRODUCTION DREW IT — `LOT 4327 Jubilee Estate - ENZO 10.5
 * MODERN - BROCHURE V002 - Copy.pdf`, page 1.
 *
 * WHAT THIS FIXTURE IS. Every run below is one `readPdfTextLayout` returned
 * from the stored bytes of that upload on 23 September 2026 — its text, the x
 * and y it was drawn at, its advance and its drawn height — printed by
 * `scripts/ops/stock-reading-trace.ts` (production-rollout phase
 * `stock-reading-trace`). Nothing is reconstructed. The one liberty is that
 * the inclusions list is cut to its first four bullets, which carry nothing
 * this reading depends on.
 *
 * WHAT IT READ, AND WHAT IT READS NOW. The import recorded
 *
 *     fields_read   expected_completion, house_design, land_size_sqm,
 *                   lot_number, price
 *     house_design  "Specifications"        ← `House` over `Specifications`
 *     visual_only   bathrooms, bedrooms, car_spaces
 *
 * and the builder's card read `Lot 4327, · Specifications`, no locality, three
 * dashes and `HOME —` — on a page that prints the estate, the suburb, the
 * design, its three counts and its total area. Each of those had its own
 * cause, and each is asserted here against the page that exposed it.
 */
import { describe, expect, it } from 'vitest';

import {
  layoutLines,
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const run = (y: number, x: number, width: number, height: number, text: string): PdfTextItem =>
  ({ text, x, y, width, height });

const FILENAME = 'LOT 4327 Jubilee Estate - ENZO 10.5 MODERN - BROCHURE V002 - Copy.pdf';

const PAGE_1: PdfTextItem[] = [
  run(777.3, 27.5, 117.6, 30.0, 'Enzo 10.5'),
  run(743.6, 81.5, 6.7, 12.0, '3'),
  run(743.6, 165.0, 6.1, 12.0, '2'),
  run(743.6, 257.0, 6.1, 12.0, '2'),
  run(689.8, 28.8, 57.4, 22.0, 'Land -'),
  run(689.8, 94.4, 12.5, 22.0, '$'),
  run(689.8, 106.9, 82.4, 22.0, '338,000'),
  run(664.5, 27.5, 52.9, 22.0, 'Build -'),
  run(664.5, 97.5, 12.5, 22.0, '$'),
  run(664.5, 110.0, 79.3, 22.0, '347,050'),
  run(639.2, 28.8, 151.7, 22.0, 'Package Price - $'),
  run(639.2, 180.5, 80.6, 22.0, '685,050'),
  run(605.2, 27.5, 30.8, 23.0, 'Lot'),
  run(605.2, 62.2, 181.3, 23.0, '4327 Jubilee Estate'),
  run(605.2, 242.4, 5.0, 23.0, ','),
  run(577.6, 27.5, 141.5, 23.0, 'Wyndham Vale'),
  run(550.0, 27.5, 58.2, 23.0, 'Titles -'),
  run(550.0, 88.9, 105.0, 23.0, 'Titled Land'),
  run(507.5, 27.5, 229.2, 18.0, 'VERV Inclusions & Turnkey Pack'),
  run(484.9, 27.8, 120.5, 10.0, 'VERV Quality Inclusions:'),
  run(472.4, 37.8, 4.6, 10.0, '•'),
  run(472.4, 51.2, 54.9, 10.0, 'Architectur'),
  run(472.4, 107.1, 4.7, 10.0, 'a'),
  run(472.4, 112.7, 97.7, 10.0, 'lly Designed Facade'),
  run(459.9, 37.8, 4.6, 10.0, '•'),
  run(459.9, 51.2, 149.5, 10.0, 'Low Profile Concrete Rooftiles'),
  run(447.4, 37.8, 4.6, 10.0, '•'),
  run(447.4, 51.2, 126.1, 10.0, 'Brickwork above windows'),
  run(434.9, 37.8, 4.6, 10.0, '•'),
  run(434.9, 51.2, 25.5, 10.0, '2590'),
  run(434.9, 77.7, 39.5, 10.0, 'mm high'),
  run(434.9, 121.1, 5.0, 10.0, 'c'),
  run(434.9, 127.1, 25.3, 10.0, 'eiling'),
  run(434.9, 157.3, 53.4, 10.0, 'throughout'),
  run(181.2, 27.3, 41.1, 14.0, 'Lot Size'),
  run(160.5, 50.7, 3.0, 5.8, '2'),
  run(157.2, 27.3, 16.3, 10.0, '263'),
  run(157.2, 43.4, 7.4, 10.0, 'm'),
  run(128.7, 27.5, 36.4, 14.0, 'House'),
  run(113.0, 130.1, 3.0, 5.8, '2'),
  run(111.9, 27.3, 78.3, 14.0, 'Specifications'),
  run(109.7, 29.5, 38.8, 10.0, 'Enclosed:'),
  run(109.7, 101.5, 28.7, 10.0, '91.91m'),
  run(100.0, 132.2, 3.0, 5.8, '2'),
  run(96.7, 29.5, 30.6, 10.0, 'Garage:'),
  run(96.7, 101.5, 30.8, 10.0, '38.10m'),
  run(87.0, 114.5, 3.0, 5.8, '2'),
  run(83.7, 29.5, 25.1, 10.0, 'Porch:'),
  run(83.7, 101.5, 13.0, 10.0, '3m'),
  run(71.2, 133.1, 3.2, 5.8, '2'),
  run(70.7, 29.5, 22.4, 10.0, 'Total:'),
  run(67.8, 101.5, 23.8, 10.0, '129.5'),
  run(67.8, 125.3, 7.8, 10.0, 'm'),
  run(47.0, 28.3, 249.8, 6.0,
    '*Price based on standard inclusions and facade. Image depicts upgrade items not included in the price.'),
  run(35.2, 28.3, 503.7, 6.0,
    'This plan is intended to give an indication of the proposed layout only and may vary without notice. '
    + 'It is not the actual lot for sale. Individual features such as furniture and/or vehicles are not included. Images are'),
  run(27.7, 28.3, 489.7, 6.0,
    'artists’ impression for illustrative purposes only. Please ask our sales advisor or refer to contract '
    + 'drawings and site plans for exact dimensions and setback. Facade finishes, materials and colours may vary.'),
];

const lines = layoutLines(PAGE_1);
const cellsOf = (text: string) =>
  lines.find((line) => line.cells.some((cell) => cell.text === text))?.cells.map((cell) => cell.text);

const reading = readPdfBrochure(
  [PAGE_1.map((item) => item.text).join('\n')],
  { positionedPages: [{ page: 1, items: PAGE_1 }], filename: FILENAME },
);
const record = reading.rows.length ? normaliseStockRow(reading.rows[0]) : null;

describe('the lines the page is made of', () => {
  it('keeps the raised 2 with the figure it abuts, not the heading beside its baseline', () => {
    expect(cellsOf('Specifications')).toEqual(['Specifications']);
    expect(cellsOf('Enclosed:')).toEqual(['Enclosed:', '91.91m2']);
  });

  it('puts Total: on the line of the value drawn 2.9 points under it', () => {
    expect(cellsOf('Total:')).toEqual(['Total:', '129.5m2']);
  });

  it('leaves every other line exactly as it was drawn', () => {
    expect(cellsOf('Garage:')).toEqual(['Garage:', '38.10m2']);
    expect(cellsOf('Porch:')).toEqual(['Porch:', '3m2']);
    expect(cellsOf('263m2')).toEqual(['263m2']);
    expect(cellsOf('3')).toEqual(['3', '2', '2']);
  });
});

describe('what the page states, read', () => {
  it('reads the lot, the estate and the suburb from the two-line address', () => {
    expect(record?.lot_number).toBe('4327');
    expect(record?.development_name).toBe('Jubilee Estate');
    expect(record?.suburb).toBe('Wyndham Vale');
  });

  it('invents neither a state, a postcode nor a street the page does not print', () => {
    expect(record?.state ?? null).toBeNull();
    expect(record?.postcode ?? null).toBeNull();
    expect(record?.address_line ?? null).toBeNull();
  });

  it('reads the design the page prints in its largest type, never the section heading', () => {
    expect(record?.house_design).toBe('Enzo 10.5');
    expect(reading.diagnostics.declinedBecause ?? [])
      .toContain('house_design:a_section_heading_is_not_a_name');
  });

  it('reads the icon row in its printed order and says that is how', () => {
    expect([record?.bedrooms, record?.bathrooms, record?.car_spaces]).toEqual([3, 2, 2]);
    expect(reading.diagnostics.countEvidence).toEqual(['icon_row_in_conventional_order']);
    expect(reading.diagnostics.visualOnlyFields ?? []).toEqual([]);
  });

  it('reads the house total as the building size, from the schedule', () => {
    expect(record?.building_size_sqm).toBe(129.5);
    expect(reading.diagnostics.readBy ?? []).toContain('building_size_sqm:area_schedule');
  });

  it('keeps everything it already read', () => {
    expect(record?.price).toBe(685050);
    expect(record?.land_size_sqm).toBe(263);
    expect(record?.expected_completion).toBe('Titled Land');
    // The land PRICE is still never a land size.
    expect(reading.diagnostics.declinedBecause ?? [])
      .toContain('land_size_sqm:money_is_not_an_area');
  });
});
