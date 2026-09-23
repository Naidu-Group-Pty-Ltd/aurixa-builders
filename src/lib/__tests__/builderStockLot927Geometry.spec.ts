/**
 * THE PAGES AS PRODUCTION DREW THEM — `LOT 927 - ENZO 10.5 - BROCHURE
 * V002.pdf`, pages 1 and 2.
 *
 * WHAT THIS FIXTURE IS. Every run below is one `readPdfTextLayout` returned
 * from the stored bytes of that upload on 23 September 2026 — its text, the x
 * and y it was drawn at, its advance and its drawn height — printed by
 * `scripts/ops/stock-reading-trace.ts` (production-rollout phase
 * `stock-reading-trace`). Nothing is reconstructed and nothing is cut: pages
 * 3 to 7 are the builder's specification copy, and these two pages read
 * exactly the row the whole document reads (measured).
 *
 * THE ONE LIBERTY, and it changes nothing the reader reads (measured: the
 * reading with and without it is byte-identical). The siting consultant's
 * name, email address and mobile number, the builder's office street and
 * phone, and the siting software's plan id are replaced by placeholders of
 * the same shape. A person's contact details are not ours to put in a
 * repository, and the shape is what the reader answers to.
 *
 * WHAT IT READ, AND WHAT IT READS NOW. The builder's card read
 *
 *     Lot 927, DAYBREAK Street · ENZO 10.5, OFFICER VIC 3809
 *     $780,050 · 3 2 2 · HOME 132 m² · LAND —
 *
 * over a page that prints `Lot Size 294m²` and a house schedule totalling
 * `129.5m²`. Page 2 is a siting consultant's drawing whose `Site Area:
 * 309.45 m2` and `Build Area: 131.6 m2` are the operands of the `42.5%` site
 * coverage it prints: the land was disputed between 294 and 309.45 and
 * dropped, the siting's labelled build area outranked the house's own
 * schedule, and the estate — `(Banyan Place Estate)` on page 1, `Estate:
 * Banyan Place` on page 2 — was disputed and dropped too. See
 * `measurementAuthority.pure.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const run = (y: number, x: number, width: number, height: number, text: string): PdfTextItem =>
  ({ text, x, y, width, height });

const FILENAME = 'LOT 927 - ENZO 10.5 - BROCHURE V002.pdf';
const ORGANISATION = 'Bob The Builder Pty Ltd';

/** The property's own page: its price, its address, its lot size, its house. */
const PAGE_1: PdfTextItem[] = [
  run(777.3, 28.4, 117.6, 30.0, 'Enzo 10.5'),
  run(743.6, 81.5, 6.7, 12.0, '3'),
  run(743.6, 165.0, 6.1, 12.0, '2'),
  run(743.6, 257.0, 6.1, 12.0, '2'),
  run(689.8, 95.5, 12.5, 22.0, '$'),
  run(689.8, 108.0, 35.9, 22.0, '423'),
  run(689.8, 143.9, 4.3, 22.0, ','),
  run(689.8, 148.2, 11.9, 22.0, '5'),
  run(689.8, 160.2, 27.3, 22.0, '00'),
  run(689.8, 29.8, 57.4, 22.0, 'Land -'),
  run(664.5, 28.5, 52.9, 22.0, 'Build -'),
  run(664.5, 98.6, 12.5, 22.0, '$'),
  run(664.5, 111.1, 12.4, 22.0, '3'),
  run(664.5, 123.4, 66.5, 22.0, '56,550'),
  run(639.2, 29.8, 151.7, 22.0, 'Package Price - $'),
  run(639.2, 181.5, 11.0, 22.0, '7'),
  run(639.2, 192.5, 26.0, 22.0, '80'),
  run(639.2, 218.5, 4.3, 22.0, ','),
  run(639.2, 222.8, 39.3, 22.0, '050'),
  run(601.9, 26.2, 229.3, 23.0, 'Lot 927 Daybreak Street,'),
  run(601.9, 258.3, 62.2, 23.0, 'Officer'),
  run(574.3, 26.2, 199.4, 23.0, '(Banyan Place Estate)'),
  run(546.7, 26.2, 170.1, 23.0, '***TITLED LAND***'),
  run(507.5, 27.5, 228.3, 18.0, 'VERV Inclusions & Turnkey Pack'),
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
  run(434.9, 77.7, 39.4, 10.0, 'mm high'),
  run(434.9, 121.1, 5.0, 10.0, 'c'),
  run(434.9, 127.1, 25.3, 10.0, 'eiling'),
  run(434.9, 157.3, 53.4, 10.0, 'throughout'),
  run(422.4, 37.8, 4.6, 10.0, '•'),
  run(422.4, 51.2, 33.7, 10.0, 'Quality'),
  run(422.4, 88.8, 96.5, 10.0, 'Flooring throughout'),
  run(409.9, 37.8, 4.6, 10.0, '•'),
  run(409.9, 51.2, 132.3, 10.0, 'LED downlights throughout'),
  run(397.4, 37.8, 4.6, 10.0, '•'),
  run(397.4, 51.2, 140.4, 10.0, 'Stone benchtops throughout'),
  run(384.9, 37.8, 4.6, 10.0, '•'),
  run(384.9, 51.2, 233.4, 10.0, 'Stainless steel appliances including Dishwasher'),
  run(352.0, 27.9, 124.7, 10.0, 'VERV Turnkey Inclusions:'),
  run(339.5, 37.9, 4.6, 10.0, '•'),
  run(339.5, 51.3, 174.5, 10.0, 'Landscaping to front and rear yards'),
  run(339.5, 226.7, 1.9, 10.0, '.'),
  run(327.0, 37.9, 4.6, 10.0, '•'),
  run(327.0, 51.3, 126.4, 10.0, 'Clothesline and Letterbox'),
  run(327.0, 178.7, 1.9, 10.0, '.'),
  run(314.5, 37.9, 4.6, 10.0, '•'),
  run(314.5, 51.3, 161.2, 10.0, 'Boundary Fencing including Gate'),
  run(314.5, 213.5, 1.9, 10.0, '.'),
  run(302.0, 37.9, 4.6, 10.0, '•'),
  run(302.0, 51.3, 225.0, 10.0, 'Exposed aggregate paving to Driveway, Porch'),
  run(289.5, 51.3, 208.3, 10.0, 'and Alfresco (design specific - refer plans)'),
  run(289.5, 260.5, 1.9, 10.0, '.'),
  run(277.0, 37.9, 4.6, 10.0, '•'),
  run(277.0, 51.3, 164.7, 10.0, 'Window Furnishings & Flyscreens'),
  run(277.0, 216.9, 1.9, 10.0, '.'),
  run(264.5, 37.9, 4.6, 10.0, '•'),
  run(264.5, 51.3, 128.6, 10.0, 'Split system to living room'),
  run(264.5, 180.9, 1.9, 10.0, '.'),
  run(252.0, 37.9, 4.6, 10.0, '•'),
  run(252.0, 51.3, 171.9, 10.0, 'Alarm System including (3) sensors'),
  run(252.0, 224.1, 1.9, 10.0, '.'),
  run(239.5, 37.9, 4.6, 10.0, '•'),
  run(239.5, 51.3, 221.0, 10.0, 'Fiber Connection to the home - as per design'),
  run(227.0, 51.3, 52.0, 10.0, 'guidelines.'),
  run(182.1, 28.6, 41.1, 14.0, 'Lot Size'),
  run(161.5, 51.9, 3.0, 5.8, '2'),
  run(158.1, 28.6, 23.5, 10.0, '294m'),
  run(129.7, 28.8, 116.7, 14.0, 'House Specifications'),
  run(113.9, 131.4, 3.0, 5.8, '2'),
  run(110.6, 30.8, 38.8, 10.0, 'Enclosed:'),
  run(110.6, 102.8, 28.7, 10.0, '91.91m'),
  run(100.9, 133.6, 3.0, 5.8, '2'),
  run(97.6, 30.8, 30.6, 10.0, 'Garage:'),
  run(97.6, 102.8, 30.8, 10.0, '38.10m'),
  run(87.9, 115.8, 3.0, 5.8, '2'),
  run(84.6, 30.8, 25.1, 10.0, 'Porch:'),
  run(84.6, 102.8, 13.0, 10.0, '3m'),
  run(72.1, 134.4, 3.2, 5.8, '2'),
  run(71.6, 30.8, 22.4, 10.0, 'Total:'),
  run(68.8, 102.8, 23.8, 10.0, '129.5'),
  run(68.8, 126.6, 7.8, 10.0, 'm'),
  run(47.0, 28.3, 249.8, 6.0,
    '*Price based on standard inclusions and facade. Image depicts upgrade items not '
    + 'included in the price.'),
  run(35.2, 28.3, 503.7, 6.0,
    'This plan is intended to give an indication of the proposed layout only and may vary '
    + 'without notice. It is not the actual lot for sale. Individual features such as '
    + 'furniture and/or vehicles are not included. Images are'),
  run(27.7, 28.3, 489.7, 6.0,
    'artists’ impression for illustrative purposes only. Please ask our sales advisor or '
    + 'refer to contract drawings and site plans for exact dimensions and setback. Facade '
    + 'finishes, materials and colours may vary.'),
];

/** The preliminary siting: a consultant's drawing of the same lot. */
const PAGE_2: PdfTextItem[] = [
  run(785.3, 38.7, 211.9, 13.4, 'Proposed Siting of your VERV Home'),
  run(763.1, 38.7, 371.9, 7.4,
    'VERV Group Pty Ltd | 12 Sample Road, ASCOT VALE VIC 3032 | Phone: 03 9000 0000 | '
    + 'example.com.au'),
  run(751.9, 38.7, 46.3, 8.9, 'Customer:'),
  run(751.9, 291.0, 24.3, 8.9, 'Date:'),
  run(751.9, 356.2, 45.7, 8.9, '19/12/2025'),
  run(738.6, 109.2, 108.8, 8.9, 'Lot 927 DAYBREAK STREET'),
  run(738.6, 291.0, 31.3, 8.9, 'Estate:'),
  run(738.6, 356.2, 52.1, 8.9, 'Banyan Place'),
  run(738.6, 38.7, 58.7, 8.9, 'Site Address:'),
  run(725.2, 38.7, 38.0, 8.9, 'Locality:'),
  run(725.2, 109.2, 63.8, 8.9, 'OFFICER (3809)'),
  run(725.2, 291.0, 26.9, 8.9, 'State:'),
  run(725.2, 356.2, 14.0, 8.9, 'VIC'),
  run(711.9, 38.7, 62.5, 8.9, 'Home Design:'),
  run(711.9, 109.2, 86.7, 8.9, 'ENZO 10.5 - MODERN'),
  run(711.9, 291.0, 61.1, 8.9, 'Email/Phone:'),
  run(688.1, 42.4, 80.2, 9.6, 'Incomplete Sub:'),
  run(688.1, 124.0, 14.9, 9.6, 'Yes'),
  run(673.3, 42.4, 80.9, 9.6, 'Current Fencing:'),
  run(658.5, 42.4, 71.7, 9.6, 'Ceiling Height:'),
  run(658.5, 124.0, 21.5, 9.6, '2.4m'),
  run(643.6, 42.4, 70.5, 9.6, 'Site Coverage:'),
  run(643.6, 124.0, 28.1, 9.6, '42.5%'),
  run(628.8, 42.4, 47.3, 9.6, 'Site Area:'),
  run(628.8, 124.0, 45.6, 9.6, '309.45 m2'),
  run(613.9, 42.4, 53.3, 9.6, 'Build Area:'),
  run(613.9, 124.0, 40.3, 9.6, '131.6 m2'),
  run(565.7, 261.5, 17.0, 0.0, '2.9 m'),
  run(565.7, 312.8, 20.6, 0.0, '2.08 m'),
  run(565.7, 367.7, 17.0, 0.0, '2.4 m'),
  run(556.1, 276.4, 32.3, 7.7, '14.285 m'),
  run(530.2, 383.3, 11.3, 6.7, '3 m'),
  run(518.1, 228.1, 20.6, 6.6, '3.31 m'),
  run(513.8, 338.8, 13.0, 0.0, 'BED 3'),
  run(505.4, 289.3, 32.3, 0.0, 'FAMILY/MEALS'),
  run(488.9, 410.2, 20.6, 0.0, '9.17 m'),
  run(487.3, 221.6, 32.3, 1.2, '11.038 m'),
  run(473.2, 339.9, 12.8, 5.5, 'ROBE'),
  run(469.0, 266.7, 2.3, 0.0, 'P.'),
  run(460.7, 358.9, 13.0, 0.0, 'BED 2'),
  run(453.9, 330.9, 12.8, 0.0, 'ROBE'),
  run(439.3, 277.9, 19.8, 5.5, 'KITCHEN'),
  run(434.2, 400.3, 11.3, 6.7, '0 m'),
  run(431.1, 306.4, 7.0, 0.0, 'LIN'),
  run(417.0, 292.6, 11.7, 0.0, 'BATH'),
  run(405.5, 367.1, 19.3, 0.0, 'GARAGE'),
  run(404.7, 402.1, 17.3, 0.0, '25 m'),
  run(390.8, 277.1, 9.3, 0.0, 'ENS'),
  run(390.5, 306.7, 13.5, 0.0, 'L-DRY'),
  run(379.1, 319.8, 15.2, 0.0, 'ENTRY'),
  run(362.4, 288.9, 12.8, 5.5, 'ROBE'),
  run(353.7, 287.1, 18.8, 0.0, 'MASTER'),
  run(344.6, 400.3, 11.3, 6.7, '0 m'),
  run(342.1, 323.1, 16.3, 0.0, 'PORCH'),
  run(318.6, 273.0, 5.7, 1.5, '1.245 m'),
  run(310.3, 248.4, 32.3, 1.1, '14.215 m'),
  run(305.0, 364.1, 17.0, 6.7, '5.3 m'),
  run(295.1, 226.2, 20.6, 6.6, '0.96 m'),
  run(276.4, 38.0, 26.0, 7.4, 'Zoning'),
  run(271.9, 72.8, 22.6, 8.9, 'UGZ2'),
  run(268.7, 410.0, 17.0, 0.0, '9.5 m'),
  run(257.8, 38.0, 32.7, 7.4, 'Overlays'),
  run(253.4, 72.8, 28.0, 8.9, 'DCPO3'),
  run(247.2, 334.8, 20.6, 0.0, '6.69 m'),
  run(245.1, 261.3, 20.6, 0.0, '6.35 m'),
  run(239.3, 38.0, 19.0, 7.4, 'Road'),
  run(234.8, 72.8, 20.7, 8.9, 'Local'),
  run(214.8, 38.0, 48.7, 7.4, 'Requirement'),
  run(214.8, 112.1, 23.8, 7.4, 'Actual'),
  run(212.3, 335.8, 32.3, 7.7, '10.505 m'),
  run(202.2, 38.0, 14.8, 7.4, 'Site'),
  run(197.7, 112.2, 25.4, 8.9, '42.5%'),
  run(183.6, 38.0, 15.4, 7.4, 'POS'),
  run(166.6, 38.0, 47.3, 7.4, 'Landscaping'),
  run(140.6, 38.0, 20.0, 7.4, 'Trees'),
  run(80.5, 38.7, 20.5, 7.4, 'Note:'),
  run(80.5, 61.5, 299.9, 7.4,
    'This is a preliminary siting and is subject to a clear copy of title and approval of '
    + 'the builder.'),
  run(70.1, 481.6, 26.8, 8.9, 'Scale:'),
  run(70.1, 508.5, 22.6, 8.9, '1:200'),
  run(70.1, 534.1, 22.8, 9.6, '@ A4'),
  run(69.4, 38.7, 376.6, 7.4,
    'This siting is subject to developer approval, state building regulations and council '
    + 'requirements (where applicable).'),
  run(55.3, 38.7, 47.5, 8.2, 'Consultant:'),
  run(55.3, 88.7, 57.8, 8.2, 'Sam Citizen'),
  run(55.3, 187.0, 147.3, 8.2, 'Email: siting@example.com.au'),
  run(55.3, 349.1, 87.7, 8.2, 'Phone: 0400 000 000'),
  run(54.5, 469.1, 96.2, 9.6, '(Geo Plan ID: 100000)'),
  run(43.4, 477.2, 88.1, 9.6, 'GeoSite IT Pty Ltd'),
  run(35.3, 34.3, 429.3, 10.4,
    '_________________________ ____________ _________________________ ____________'),
  run(24.9, 34.3, 69.0, 6.7, 'Customer Signature (1)'),
  run(24.9, 178.9, 24.6, 6.7, 'Date (1)'),
  run(24.9, 249.4, 69.0, 6.7, 'Customer Signature (2)'),
  run(24.9, 394.1, 24.6, 6.7, 'Date (2)'),
];

/** Read these pages, in this order, as the product reads a document. */
function readPages(pages: PdfTextItem[][]) {
  const reading = readPdfBrochure(
    pages.map((items) => items.map((item) => item.text).join('\n')),
    {
      positionedPages: pages.map((items, index) => ({ page: index + 1, items })),
      filename: FILENAME,
      organisationName: ORGANISATION,
    },
  );
  return {
    reading,
    record: reading.rows.length ? normaliseStockRow(reading.rows[0]) : null,
  };
}

describe('the brochure as the builder uploaded it', () => {
  const { reading, record } = readPages([PAGE_1, PAGE_2]);

  it('reads the lot size the property page prints, not the siting plan\'s site area', () => {
    expect(record?.land_size_sqm).toBe(294);
    expect(reading.diagnostics.readBy ?? []).toContain('land_size_sqm:below');
  });

  it('reads the house\'s own total as the build size, not the siting plan\'s build area', () => {
    expect(record?.building_size_sqm).toBe(129.5);
    expect(reading.diagnostics.readBy ?? []).toContain('building_size_sqm:area_schedule');
  });

  it('says the siting disagreed and was outranked, and disputes nothing', () => {
    expect(reading.diagnostics.outrankedFields).toEqual(['building_size_sqm', 'land_size_sqm']);
    expect(reading.diagnostics.disputedFields).toBeUndefined();
  });

  it('reads the estate once, in the spelling that names it an estate', () => {
    expect(record?.development_name).toBe('Banyan Place Estate');
  });

  it('keeps everything it already read', () => {
    expect(reading.status).toBe('complete');
    expect({
      lot: record?.lot_number, address: record?.address_line, suburb: record?.suburb,
      state: record?.state, postcode: record?.postcode, design: record?.house_design,
      price: record?.price, counts: [record?.bedrooms, record?.bathrooms, record?.car_spaces],
    }).toEqual({
      lot: '927', address: 'Lot 927 DAYBREAK STREET', suburb: 'OFFICER', state: 'VIC',
      postcode: '3809', design: 'ENZO 10.5', price: 780050, counts: [3, 2, 2],
    });
    // The land PRICE is still never a land size.
    expect(reading.diagnostics.declinedBecause ?? [])
      .toContain('land_size_sqm:money_is_not_an_area');
  });
});

describe('the rule, not the page order', () => {
  it('reads the same row with the siting plan first', () => {
    const inOrder = readPages([PAGE_1, PAGE_2]).record;
    const sitingFirst = readPages([PAGE_2, PAGE_1]).record;
    expect(sitingFirst).toEqual(inOrder);
  });

  it('reads the siting plan\'s own figures where nothing prices the property', () => {
    const { reading, record } = readPages([PAGE_2]);
    expect(record?.land_size_sqm).toBe(309.45);
    expect(record?.building_size_sqm).toBe(131.6);
    expect(record?.development_name).toBe('Banyan Place');
    expect(reading.diagnostics.outrankedFields).toBeUndefined();
  });
});
