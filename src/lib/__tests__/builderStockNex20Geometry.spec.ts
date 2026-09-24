/**
 * THE PAGES AS PRODUCTION DREW THEM — `LOT 326 - NEX 20 - BROCHURE.pdf` and
 * `LOT 324 - NEX 20 - V002.pdf`, page 1, and the one line `LOT 4544` changed.
 *
 * WHAT THESE FIXTURES ARE. Every run in `LOT_326` and `LOT_324` is one
 * `readPdfTextLayout` returned from the stored bytes of that upload on
 * 24 September 2026, printed by `scripts/ops/stock-reading-trace.ts`
 * (production-rollout phase `stock-reading-trace`). Nothing is reconstructed
 * except that the inclusions list is cut to its first two rows, which carry
 * nothing this reading depends on.
 *
 * WHAT THEY READ, AND WHAT THEY READ NOW. Both cards showed the lot and the
 * estate and nothing else a buyer looks for first: no price, no street and no
 * suburb, on a page that prints all three in 22- and 40-point type.
 *
 *   • the package price is set ABOVE its caption (`$861,700` over
 *     `PACKAGE PRICE`), and every pairing rule read a label over its value;
 *   • the address is three lines of one frame — the lot and its street, the
 *     estate closed by a comma, the suburb — and no rule read a street line
 *     with no locality directly under it;
 *   • and on `LOT 324` the price table beside that frame sets two rows between
 *     the estate and the suburb, which put the suburb out of `unitBelow`'s
 *     two-band reach even once the frame was read.
 *
 * `LOT 4544 Riverwalk Estate - ENZO 10.5 MODERN` could not be traced — its
 * bytes were deleted with the upload — but the import's own record of what it
 * set aside names `Wyndham Vale` on page 1, row 6, x 31, and nothing else from
 * the address. Its sibling `LOT 4327` from the same template read that suburb
 * because its lot line ends in a comma; `LOT_4544` below is that production
 * page with the comma taken off, which is the one difference the record
 * implies, and it is labelled as the inference it is.
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

const INCLUSIONS: PdfTextItem[] = [
  run(218.9, 297.5, 154.9, 12.0, 'FULL TURNKEY INCLUSIONS'),
  run(198.9, 297.5, 5.8, 10.6, '√'),
  run(198.9, 310.3, 107.3, 10.6, 'Front & rear landscaping,'),
  run(198.9, 430.8, 5.8, 10.6, '√'),
  run(198.9, 443.5, 71.8, 10.6, 'Colour Concrete'),
  run(186.9, 310.3, 91.3, 10.6, 'driveway, and fencing'),
  run(186.9, 443.5, 38.0, 10.6, 'driveway'),
];

const LOT_326: PdfTextItem[] = [
  run(782.0, 299.9, 128.4, 40.0, 'NEX 20'),
  run(762.5, 469.3, 10.5, 26.0, '*'),
  run(743.0, 299.9, 21.3, 40.0, '$'),
  run(743.0, 321.2, 23.4, 40.0, '8'),
  run(743.0, 344.8, 20.5, 41.0, '6'),
  run(743.0, 365.5, 20.5, 41.0, '1'),
  run(743.0, 386.2, 9.2, 40.0, ','),
  run(743.0, 395.7, 21.1, 40.0, '7'),
  run(743.0, 417.0, 49.5, 40.0, '00'),
  run(731.2, 27.7, 10.5, 22.0, 'L'),
  run(731.2, 38.2, 45.9, 22.0, 'ot 32'),
  run(731.2, 84.1, 12.6, 22.0, '6'),
  run(731.2, 101.0, 134.6, 22.0, 'Dapple Avenue'),
  run(722.0, 299.9, 85.5, 10.6, 'PACKAGE PRICE'),
  run(700.5, 27.7, 144.7, 22.0, 'Palomino Estate,'),
  run(684.5, 311.2, 21.3, 10.6, 'Build'),
  run(684.5, 396.8, 21.3, 10.6, 'Land'),
  run(684.5, 482.5, 33.3, 10.6, 'Lot Size'),
  run(669.8, 27.7, 149.7, 22.0, 'Armstrong Creek'),
  run(665.0, 396.9, 6.0, 10.6, '$'),
  run(665.0, 402.9, 39.7, 10.6, '389,000'),
  run(664.9, 313.2, 6.0, 10.6, '$'),
  run(664.9, 319.2, 5.9, 10.6, '4'),
  run(664.9, 325.1, 5.9, 10.6, '7'),
  run(664.9, 330.9, 14.7, 10.6, '2,7'),
  run(664.9, 345.6, 13.1, 10.6, '00'),
  run(664.9, 482.5, 18.4, 10.6, '350'),
  run(664.9, 501.0, 4.0, 10.6, '²'),
  run(639.0, 27.7, 241.3, 22.0, 'Titles: Dec 2026 - Jan 2027'),
  ...INCLUSIONS,
];

const LOT_324: PdfTextItem[] = [
  run(782.0, 299.9, 128.4, 40.0, 'NEX 20'),
  run(762.0, 476.1, 10.5, 26.0, '*'),
  run(743.0, 299.9, 21.3, 40.0, '$'),
  run(743.0, 321.2, 23.4, 40.0, '8'),
  run(743.0, 344.8, 128.5, 40.0, '63,850'),
  run(723.2, 299.9, 85.5, 10.6, 'PACKAGE PRICE'),
  run(722.5, 27.7, 10.5, 22.0, 'L'),
  run(722.5, 38.2, 197.0, 22.0, 'ot 324 Dapple Avenue'),
  run(691.7, 27.7, 144.7, 22.0, 'Palomino Estate,'),
  run(684.5, 311.2, 21.3, 10.6, 'Build'),
  run(684.5, 396.8, 21.3, 10.6, 'Land'),
  run(684.5, 482.5, 33.3, 10.6, 'Lot Size'),
  run(665.0, 396.9, 6.0, 10.6, '$'),
  run(665.0, 402.9, 39.7, 10.6, '389,000'),
  run(664.9, 313.2, 6.0, 10.6, '$'),
  run(664.9, 319.2, 5.9, 10.6, '4'),
  run(664.9, 325.1, 31.5, 10.6, '74,850'),
  run(664.9, 482.5, 18.4, 10.6, '350'),
  run(664.9, 501.0, 4.0, 10.6, '²'),
  run(661.0, 27.7, 149.7, 22.0, 'Armstrong Creek'),
  run(630.2, 27.7, 241.3, 22.0, 'Titles: Dec 2026 - Jan 2027'),
  ...INCLUSIONS,
];

/** `LOT 4327`'s production page 1, top block, with its lot line's comma taken off. */
const enzoTop = (lotRuns: PdfTextItem[], suburb: PdfTextItem | null): PdfTextItem[] => [
  run(777.3, 27.5, 117.6, 30.0, 'Enzo 10.5'),
  run(743.6, 81.5, 6.7, 12.0, '3'),
  run(743.6, 165.0, 6.1, 12.0, '2'),
  run(743.6, 257.0, 6.1, 12.0, '2'),
  run(689.8, 28.8, 57.4, 22.0, 'Land -'),
  run(689.8, 94.4, 12.5, 22.0, '$'),
  run(689.8, 106.9, 82.4, 22.0, '351,000'),
  run(664.5, 27.5, 52.9, 22.0, 'Build -'),
  run(664.5, 97.5, 12.5, 22.0, '$'),
  run(664.5, 110.0, 79.3, 22.0, '347,050'),
  run(639.2, 28.8, 151.7, 22.0, 'Package Price - $'),
  run(639.2, 180.5, 80.6, 22.0, '698,050'),
  ...lotRuns,
  ...(suburb ? [suburb] : []),
  run(550.0, 27.5, 58.2, 23.0, 'Titles -'),
  run(550.0, 88.9, 105.0, 23.0, 'Titled Land'),
  run(181.2, 27.3, 41.1, 14.0, 'Lot Size'),
  run(160.5, 50.7, 3.0, 5.8, '2'),
  run(157.2, 27.3, 16.3, 10.0, '263'),
  run(157.2, 43.4, 7.4, 10.0, 'm'),
];

const LOT_4544 = enzoTop(
  [run(605.2, 27.5, 30.8, 23.0, 'Lot'), run(605.2, 62.2, 181.3, 23.0, '4544 Riverwalk Estate')],
  run(577.6, 27.5, 141.5, 23.0, 'Wyndham Vale'),
);

function read(items: PdfTextItem[], filename: string) {
  const reading = readPdfBrochure(
    [items.map((item) => item.text).join('\n')],
    { positionedPages: [{ page: 1, items }], filename },
  );
  return { reading, record: reading.rows.length ? normaliseStockRow(reading.rows[0]) : null };
}

describe('LOT 326 — the price over its caption and the three-line address', () => {
  const { reading, record } = read(LOT_326, 'LOT 326 - NEX 20 - BROCHURE.pdf');

  it('reads the package price from the figure set over its caption', () => {
    expect(record?.price).toBe(861700);
    expect(reading.diagnostics.readBy ?? []).toContain('price:figure_caption');
  });

  it('reads the street, the estate and the suburb from the one frame', () => {
    expect(record?.lot_number).toBe('326');
    expect(record?.address_line).toBe('Dapple Avenue');
    expect(record?.development_name).toBe('Palomino Estate');
    expect(record?.suburb).toBe('Armstrong Creek');
    expect(reading.diagnostics.readBy ?? []).toContain('suburb:address_block');
  });

  it('invents no state and no postcode the page does not print', () => {
    expect(record?.state ?? null).toBeNull();
    expect(record?.postcode ?? null).toBeNull();
  });

  it('keeps the land price out of the land size, as it always has', () => {
    expect(record?.land_size_sqm).toBe(350);
    expect(reading.diagnostics.declinedBecause ?? [])
      .toContain('land_size_sqm:money_is_not_an_area');
  });
});

describe('LOT 324 — the frame continues past two rows of another column', () => {
  const { reading, record } = read(LOT_324, 'LOT 324 - NEX 20 - V002.pdf');

  it('reads the package price, whose caption shares a baseline with the lot line', () => {
    expect(record?.price).toBe(863850);
  });

  it('reads the suburb 30.7 points under the estate, past the price table', () => {
    expect(record?.address_line).toBe('Dapple Avenue');
    expect(record?.development_name).toBe('Palomino Estate');
    expect(record?.suburb).toBe('Armstrong Creek');
    expect(record?.state ?? null).toBeNull();
  });
});

describe('LOT 4544 — the lot line names its estate and ends without a comma', () => {
  it('reads the suburb on the next line of the frame', () => {
    const { record } = read(LOT_4544,
      'LOT 4544 Riverwalk Estate - ENZO 10.5 MODERN - BROCHURE V002 - Copy - Copy.pdf');
    expect(record?.lot_number).toBe('4544');
    expect(record?.development_name).toBe('Riverwalk Estate');
    expect(record?.suburb).toBe('Wyndham Vale');
    expect(record?.address_line ?? null).toBeNull();
    expect(record?.price).toBe(698050);
  });

  it('reads nothing as a suburb when the next line is not a place', () => {
    // `Lot 101 Watsons Reach Estate` over its titles line: the PICO page.
    const items = enzoTop(
      [run(605.2, 27.5, 30.8, 23.0, 'Lot'), run(605.2, 62.2, 181.3, 23.0, '101 Watsons Reach Estate')],
      null,
    ).map((item) => item.text === 'Titles -'
      ? run(577.6, 27.5, 58.2, 23.0, 'Titles December 2026') : item)
      .filter((item) => item.text !== 'Titled Land');
    const { record } = read(items, 'Lot 101 - PICO - BROCHURE v002.pdf');
    expect(record?.lot_number).toBe('101');
    expect(record?.suburb ?? null).toBeNull();
  });

  it('never reads the estate again as its own suburb', () => {
    const { record } = read(enzoTop(
      [run(605.2, 27.5, 30.8, 23.0, 'Lot'), run(605.2, 62.2, 181.3, 23.0, '12 Aurora Estate')],
      run(577.6, 27.5, 141.5, 23.0, 'Aurora'),
    ), 'LOT 12 - ENZO 10.5 - BROCHURE.pdf');
    expect(record?.development_name).toBe('Aurora Estate');
    expect(record?.suburb ?? null).toBeNull();
  });

  it('reaches no further down the frame than its own leading', () => {
    // The same place name two blank lines lower is the top of something else.
    const { record } = read(enzoTop(
      [run(605.2, 27.5, 30.8, 23.0, 'Lot'), run(605.2, 62.2, 181.3, 23.0, '4544 Riverwalk Estate')],
      run(540.0, 27.5, 141.5, 23.0, 'Wyndham Vale'),
    ).filter((item) => item.y !== 550.0), 'LOT 4544 - ENZO 10.5 - BROCHURE.pdf');
    expect(record?.suburb ?? null).toBeNull();
  });
});

describe('a figure over a caption is read only where both stand alone', () => {
  it('never takes the build price for the package price from a column of statements', () => {
    // `Build - $347,050` over `Package Price - $698,050`: split at the dash,
    // the four units share their row's x, and `$347,050` sits over `Package
    // Price` in the same "column". It is the build price, and is never read
    // as the package price.
    const { record, reading } = read(LOT_4544, 'LOT 4544 - ENZO 10.5 - BROCHURE.pdf');
    expect(record?.price).toBe(698050);
    expect(reading.diagnostics.readBy ?? []).not.toContain('price:figure_caption');
  });

  it('reads nothing when the caption is the label of a figure beside it', () => {
    const items = LOT_326.map((item) => item.text === 'PACKAGE PRICE'
      ? run(722.0, 299.9, 85.5, 10.6, 'PACKAGE PRICE') : item);
    items.push(run(722.0, 400.0, 40.0, 10.6, '$799,000'));
    const { reading } = read(items, 'LOT 326 - NEX 20 - BROCHURE.pdf');
    expect(reading.diagnostics.readBy ?? []).not.toContain('price:figure_caption');
  });
});

/**
 * THE PAGE'S ONE PRICE — `Lot 37 - Miami 190 - Property Package.pdf`'s shape:
 * the package price set alone in display type, out of column and rows away
 * from the tracked caption line that names it. See `PACKAGE_PRICE_CAPTION`.
 */
describe("a price caption and the page's one unaccounted figure", () => {
  const packagePage = (extra: PdfTextItem[] = [], figure = '$1,204,880'): PdfTextItem[] => [
    run(806, 43, 60, 9, 'PROPLAUNCH'),
    run(624, 43, 90, 7, 'TOTAL PACKAGE'),
    run(624, 156, 20, 7, 'LAND'),
    run(624, 180, 5, 7, '+'),
    run(624, 192, 28, 7, 'BUILD'),
    run(610, 460, 70, 9, 'Build $512,880'),
    run(596, 361, 150, 9, 'Rental appraisal $1,150–$1,200 /wk'),
    run(578, 66, 160, 30, figure),
    run(578, 376, 140, 9, 'Fixed price site costs included'),
    run(520, 43, 200, 10, 'Lot 64, Wattlebird Estate, Kingscliff NSW'),
    ...extra,
  ];
  const priceOf = (items: PdfTextItem[]) => {
    const { reading, record } = read(items, 'Lot 64 - Coral 205 - Property Package.pdf');
    return { price: record?.price ?? null, readBy: reading.diagnostics.readBy ?? [] };
  };

  it('reads the one figure no label claimed as the price the caption names', () => {
    const { price, readBy } = priceOf(packagePage());
    expect(price).toBe(1204880);
    expect(readBy).toContain('price:caption_on_page');
  });

  it('never takes the build price or the rental appraisal for it', () => {
    expect(priceOf(packagePage()).price).not.toBe(512880);
  });

  it('reads nothing where the page prints a second unaccounted figure', () => {
    expect(priceOf(packagePage([run(560, 66, 120, 20, '$1,254,880')])).price).toBeNull();
  });

  it('reads nothing where no caption says the page carries the price', () => {
    const uncaptioned = packagePage().filter((item) => item.text !== 'TOTAL PACKAGE'
      && item.text !== 'LAND' && item.text !== 'BUILD' && item.text !== '+');
    expect(priceOf(uncaptioned).price).toBeNull();
  });

  it('reads nothing that is not the price of a house and land', () => {
    expect(priceOf(packagePage([], '$4,990')).price).toBeNull();
  });

  it('never overrules a price the page labelled', () => {
    const labelled = packagePage([run(700, 43, 200, 12, 'Package Price - $1,199,000')]);
    const { price, readBy } = priceOf(labelled);
    expect(price).toBe(1199000);
    expect(readBy).not.toContain('price:caption_on_page');
  });
});
