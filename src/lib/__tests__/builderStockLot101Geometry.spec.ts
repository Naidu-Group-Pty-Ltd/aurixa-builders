/**
 * THE PAGE AS PRODUCTION DREW IT — `Lot 101 - PICO - BROCHURE v002.pdf`,
 * page 1.
 *
 * WHAT THIS FIXTURE IS. Every run below is one `readPdfTextLayout` returned
 * from the stored bytes of that upload on 23 September 2026 — its text, the x
 * and y it was drawn at, its advance and its drawn height — printed by
 * `scripts/ops/stock-reading-trace.ts` (production-rollout phase
 * `stock-reading-trace`), top of the page first, which is the order the trace
 * prints. Nothing is reconstructed and nothing is cut, and no liberty was
 * needed: the page carries no person's name and no contact detail. Pages 2 to
 * 6 are the floor plan and the builder's specification copy, and this page
 * alone reads exactly the row the whole document reads (measured, with the
 * stored page text and with these runs joined).
 *
 * WHAT IT READ, AND WHAT IT READS NOW. The builder's card read
 *
 *     Lot 101 · 3 2 1
 *
 * and nothing else, over a page that prints its package total, the estate
 * the lot is in, the design and the month its titles are due. Four ways of
 * writing a fact, each one a spelling this reader already knew in another
 * arrangement:
 *
 *     TOTAL - $604,500               `total $` is a price heading; the marker
 *                                    rode on the value, and only the
 *                                    no-separator reader retried with it
 *     Lot 101 Watsons Reach Estate   the lot line's tail was read only to be
 *                                    refused, never as the estate it names
 *     PICO 8                         the filename says `PICO`; the design is
 *                                    a family and a size
 *     Titles December 2026           a completion after its label, with no
 *                                    separator between them
 *
 * WHAT IT DOES NOT READ, AND WHY THAT IS RIGHT. The page names no street and
 * no suburb — `Lot 101, Watsons Reach Estate` is the whole of where this
 * brochure says the property is — and its text states no lot size and no
 * build size anywhere. The build size is printed only INSIDE A PICTURE of the
 * house's area schedule, which is a different reader's problem; the land
 * size is printed nowhere in the document at all. Nothing here invents them,
 * and the land and build PRICES are never read as either.
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

const FILENAME = 'Lot 101 - PICO - BROCHURE v002.pdf';
const ORGANISATION = 'Bob The Builder Pty Ltd';

/** The property's own page: its design, its prices, where it is, its titles. */
const PAGE_1: PdfTextItem[] = [
  run(776.9, 29.7, 86.4, 30.0, 'PICO 8'),
  run(740.4, 71.6, 6.7, 12.0, '3'),
  run(740.4, 165.0, 6.1, 12.0, '2'),
  run(740.4, 257.0, 4.8, 12.0, '1'),
  run(695.3, 24.1, 40.0, 20.0, 'Land'),
  run(695.3, 81.7, 5.3, 20.0, '-'),
  run(695.3, 104.7, 83.3, 20.0, '$238,500'),
  run(671.4, 24.1, 39.8, 20.0, 'Build'),
  run(671.4, 80.2, 5.3, 20.0, '-'),
  run(671.4, 101.9, 10.4, 20.0, '$'),
  run(671.4, 112.2, 75.7, 20.0, '366,000'),
  run(647.4, 24.1, 85.7, 20.0, 'TOTAL - $'),
  run(647.4, 109.8, 75.1, 20.0, '604,500'),
  run(587.4, 29.8, 31.0, 24.0, 'Lot'),
  run(587.4, 64.9, 34.0, 24.0, '101'),
  run(587.4, 103.0, 212.8, 24.0, 'Watsons Reach Estate'),
  run(558.6, 29.8, 50.7, 24.0, 'Titles'),
  run(558.6, 84.6, 157.2, 24.0, 'December 2026'),
  run(483.4, 15.8, 229.2, 18.0, 'VERV Inclusions & Turnkey Pack'),
  run(460.7, 16.1, 120.5, 10.0, 'VERV Quality Inclusions:'),
  run(448.2, 26.1, 4.6, 10.0, '•'),
  run(448.2, 39.5, 54.9, 10.0, 'Architectur'),
  run(448.2, 95.4, 4.7, 10.0, 'a'),
  run(448.2, 101.1, 97.7, 10.0, 'lly Designed Facade'),
  run(435.7, 26.1, 4.6, 10.0, '•'),
  run(435.7, 39.5, 149.5, 10.0, 'Low Profile Concrete Rooftiles'),
  run(423.2, 26.1, 4.6, 10.0, '•'),
  run(423.2, 39.5, 126.1, 10.0, 'Brickwork above windows'),
  run(410.7, 26.1, 4.6, 10.0, '•'),
  run(410.7, 39.5, 25.5, 10.0, '2590'),
  run(410.7, 66.0, 39.4, 10.0, 'mm high'),
  run(410.7, 109.4, 5.0, 10.0, 'c'),
  run(410.7, 115.4, 25.3, 10.0, 'eiling'),
  run(410.7, 145.7, 53.4, 10.0, 'throughout'),
  run(398.2, 26.1, 4.6, 10.0, '•'),
  run(398.2, 39.5, 33.7, 10.0, 'Quality'),
  run(398.2, 77.2, 96.5, 10.0, 'Flooring throughout'),
  run(385.7, 26.1, 4.6, 10.0, '•'),
  run(385.7, 39.5, 132.3, 10.0, 'LED downlights throughout'),
  run(373.2, 26.1, 4.6, 10.0, '•'),
  run(373.2, 39.5, 140.4, 10.0, 'Stone benchtops throughout'),
  run(360.7, 26.1, 4.6, 10.0, '•'),
  run(360.7, 39.5, 233.4, 10.0, 'Stainless steel appliances including Dishwasher'),
  run(332.5, 16.3, 124.7, 10.0, 'VERV Turnkey Inclusions:'),
  run(320.0, 26.3, 4.6, 10.0, '•'),
  run(320.0, 39.6, 174.5, 10.0, 'Landscaping to front and rear yards'),
  run(320.0, 215.1, 1.9, 10.0, '.'),
  run(307.5, 26.3, 4.6, 10.0, '•'),
  run(307.5, 39.6, 126.4, 10.0, 'Clothesline and Letterbox'),
  run(307.5, 167.0, 1.9, 10.0, '.'),
  run(295.0, 26.3, 4.6, 10.0, '•'),
  run(295.0, 39.6, 161.2, 10.0, 'Boundary Fencing including Gate'),
  run(295.0, 201.8, 1.9, 10.0, '.'),
  run(282.5, 26.3, 4.6, 10.0, '•'),
  run(282.5, 39.6, 225.0, 10.0, 'Exposed aggregate paving to Driveway, Porch'),
  run(270.0, 39.6, 208.3, 10.0, 'and Alfresco (design specific - refer plans)'),
  run(270.0, 248.8, 1.9, 10.0, '.'),
  run(257.5, 26.3, 4.6, 10.0, '•'),
  run(257.5, 39.6, 164.7, 10.0, 'Window Furnishings & Flyscreens'),
  run(257.5, 205.3, 1.9, 10.0, '.'),
  run(245.0, 26.3, 4.6, 10.0, '•'),
  run(245.0, 39.6, 128.6, 10.0, 'Split system to living room'),
  run(245.0, 169.2, 1.9, 10.0, '.'),
  run(232.5, 26.3, 4.6, 10.0, '•'),
  run(232.5, 39.6, 171.9, 10.0, 'Alarm System including (3) sensors'),
  run(232.5, 212.4, 1.9, 10.0, '.'),
  run(220.0, 26.3, 4.6, 10.0, '•'),
  run(220.0, 39.6, 221.1, 10.0, 'Fiber Connection to the home - as per design'),
  run(207.5, 39.6, 52.0, 10.0, 'guidelines.'),
  run(47.0, 28.3, 242.8, 6.0,
    '*Price based on standard inclusions and facade. Image depicts upgrade '
    + 'items not included in the price.'),
  run(47.0, 273.4, 249.8, 6.0,
    'This plan is intended to give an indication of the proposed layout only '
    + 'and may vary without notice. It is not'),
  run(39.8, 28.3, 499.6, 6.0,
    'the actual lot for sale. Individual features such as furniture and/or '
    + 'vehicles are not included. Images are artists’ impression for '
    + 'illustrative purposes only. Please ask our sales advisor or refer to '
    + 'contract drawings and'),
  run(32.6, 28.3, 218.8, 6.0,
    'site plans for exact dimensions and setback. Facade finishes, materials '
    + 'and colours may vary.'),
];

/** Read these pages as the product reads a document. */
function readPages(pages: PdfTextItem[][], filename = FILENAME) {
  const reading = readPdfBrochure(
    pages.map((items) => items.map((item) => item.text).join('\n')),
    {
      positionedPages: pages.map((items, index) => ({ page: index + 1, items })),
      filename,
      organisationName: ORGANISATION,
    },
  );
  return {
    reading,
    record: reading.rows.length ? normaliseStockRow(reading.rows[0]) : null,
  };
}

describe('the property page as the builder uploaded it', () => {
  const { reading, record } = readPages([PAGE_1]);

  it('reads the package total as the price', () => {
    expect(record?.price).toBe(604500);
    expect(reading.diagnostics.readBy ?? []).toContain('price:beside');
  });

  it('reads the estate the lot line names, and invents no street or suburb', () => {
    expect(record?.lot_number).toBe('101');
    expect(record?.development_name).toBe('Watsons Reach Estate');
    expect({
      address: record?.address_line ?? null, suburb: record?.suburb ?? null,
      state: record?.state ?? null, postcode: record?.postcode ?? null,
    }).toEqual({ address: null, suburb: null, state: null, postcode: null });
  });

  it('reads the design the page prints, in the family the filename names', () => {
    expect(record?.house_design).toBe('PICO 8');
    expect(reading.diagnostics.readBy ?? []).toContain('house_design:filename');
  });

  it('reads when the titles are due', () => {
    expect(record?.expected_completion).toBe('December 2026');
  });

  it('keeps the counts it already read', () => {
    expect([record?.bedrooms, record?.bathrooms, record?.car_spaces]).toEqual([3, 2, 1]);
  });

  it('states no land or build size, because the text of the page states neither', () => {
    expect(record?.land_size_sqm ?? null).toBeNull();
    expect(record?.building_size_sqm ?? null).toBeNull();
  });

  it('reads it whole', () => {
    expect(reading.status).toBe('complete');
    expect(reading.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Each rule the page needed, beside the twin it must refuse.
// ---------------------------------------------------------------------------

const yOf = (band: number) => 780 - band * 28;
const at = (band: number, x: number, text: string, height = 20): PdfTextItem =>
  ({ text, x, y: yOf(band), width: text.length * 9, height });

/** A package page in this template, with any of its lines replaced. */
function packagePage(overrides: Partial<Record<
  'design' | 'land' | 'build' | 'total' | 'lot' | 'titles', string | null
>> = {}): PdfTextItem[] {
  const lines = {
    design: 'PICO 8',
    land: 'Land - $238,500',
    build: 'Build - $366,000',
    total: 'TOTAL - $604,500',
    lot: 'Lot 101 Watsons Reach Estate',
    titles: 'Titles December 2026',
    ...overrides,
  };
  const order = ['design', 'land', 'build', 'total', 'lot', 'titles'] as const;
  const items: PdfTextItem[] = [];
  order.forEach((key, band) => {
    const text = lines[key];
    if (text) items.push(at(band, 28, text, key === 'design' ? 30 : 20));
  });
  return items;
}

describe('a bare TOTAL is the price only where its value is money', () => {
  it('reads `TOTAL - $604,500` as the price', () => {
    expect(readPages([packagePage()]).record?.price).toBe(604500);
  });

  it('never reads the land or the build component as the price', () => {
    const { record } = readPages([packagePage({ total: null })]);
    expect(record?.price ?? null).toBeNull();
    expect(record?.land_size_sqm ?? null).toBeNull();
    expect(record?.building_size_sqm ?? null).toBeNull();
  });

  it('never reads a TOTAL of square metres as a build size or a price', () => {
    const { record } = readPages([packagePage({ total: 'TOTAL - 124.50m²' })]);
    expect(record?.price ?? null).toBeNull();
    expect(record?.building_size_sqm ?? null).toBeNull();
  });
});

describe('the estate a lot line names', () => {
  it('is read', () => {
    expect(readPages([packagePage()]).record?.development_name).toBe('Watsons Reach Estate');
  });

  it('is never a street: `Lot 315 Central Boulevard` claims only its lot', () => {
    const { record } = readPages(
      [packagePage({ lot: 'Lot 315 Central Boulevard' })],
      'Lot 315 - PICO - BROCHURE v002.pdf',
    );
    expect(record?.lot_number).toBe('315');
    expect(record?.development_name ?? null).toBeNull();
    expect(record?.address_line ?? null).toBeNull();
  });
});

describe('a completion written after its label with no separator', () => {
  it('is read in the shape of a month and a year, or a quarter', () => {
    expect(readPages([packagePage()]).record?.expected_completion).toBe('December 2026');
    expect(readPages([packagePage({ titles: 'Titles Q3 2027' })]).record?.expected_completion)
      .toBe('Q3 2027');
  });

  it('is never a sentence that opens with the word', () => {
    const { record } = readPages([packagePage({ titles: 'Titles are expected soon' })]);
    expect(record?.expected_completion ?? null).toBeNull();
    expect(record?.price).toBe(604500);
  });
});

describe('a design whose family the filename names and whose size the page prints', () => {
  it('is read', () => {
    expect(readPages([packagePage()]).record?.house_design).toBe('PICO 8');
  });

  it('is not read where the page prints two sizes of the family', () => {
    const page = [...packagePage(), at(7, 28, 'PICO 10', 30)];
    const { record } = readPages([page]);
    expect(record?.house_design ?? null).toBeNull();
    expect(record?.price).toBe(604500);
  });

  it('is not read where the family is only PART of a filename segment', () => {
    const { record } = readPages([packagePage()], 'Lot 101 - PICO SERIES - BROCHURE v002.pdf');
    expect(record?.house_design ?? null).toBeNull();
    expect(record?.price).toBe(604500);
  });

  it('is not read where the last word is a year, not a size', () => {
    const { record } = readPages([packagePage({ design: 'PICO 2026' })]);
    expect(record?.house_design ?? null).toBeNull();
    expect(record?.price).toBe(604500);
  });

  it('is not read where the page never says which property it is', () => {
    const { record } = readPages([packagePage({ lot: 'Lot 101' })]);
    expect(record?.house_design ?? null).toBeNull();
    expect(record?.price).toBe(604500);
  });
});
