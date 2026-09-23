/**
 * THE ICON ROW, READ IN ITS PRINTED ORDER — AND EVERY REASON IT IS NOT.
 *
 * Where a floor plan names the rooms, it keys the row and nothing here runs.
 * Where it cannot — the plan is a picture, its labels were split by the
 * exporter, there is no siting page — `readOrderedIconRow` reads the row in
 * the order it was printed, bed · bath · car, under guards that each refuse
 * rather than guess. Every guard has a case below in which it is the ONLY
 * thing standing between a row and a reading, so removing any one of them
 * fails a test by name.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const yOf = (band: number) => 780 - band * 20;
const at = (band: number, x: number, text: string, width = text.length * 6.5): PdfTextItem =>
  ({ text, x, y: yOf(band), width, height: 12 });

/** A figure's own advance, as the production page draws it. */
const figure = (band: number, x: number, text: string) => at(band, x, text, 6.5 * text.length);

/** The headline: design, the icon row where it is drawn, the lot, a price. */
const headline = (row: PdfTextItem[], extra: PdfTextItem[] = []): PdfTextItem[] => [
  at(0, 28, 'Orion 11.5'),
  ...row,
  at(3, 29, 'Package Price - $801,500'),
  at(4, 28, 'Lot 1809 Maple Estate,'),
  at(5, 28, 'Tarneit'),
  at(6, 28, 'Land Size 312m2'),
  ...extra,
];

const ICONS = (a: string, b: string, c: string) =>
  [figure(1, 81.5, a), figure(1, 165, b), figure(1, 257, c)];

const read = (pages: PdfTextItem[][]) => {
  const reading = readPdfBrochure(
    pages.map((items) => items.map((item) => item.text).join('\n')),
    { positionedPages: pages.map((items, index) => ({ page: index + 1, items })) },
  );
  const row = reading.rows.length ? normaliseStockRow(reading.rows[0]) : null;
  return { reading, counts: [row?.bedrooms ?? null, row?.bathrooms ?? null, row?.car_spaces ?? null] };
};

describe('an icon row with nothing to key it', () => {
  it('is read bed, bath, car, and says so', () => {
    const { counts, reading } = read([headline(ICONS('4', '2', '2'))]);
    expect(counts).toEqual([4, 2, 2]);
    expect(reading.diagnostics.countEvidence).toEqual(['icon_row_in_conventional_order']);
    expect(reading.diagnostics.readBy ?? []).toEqual(expect.arrayContaining([
      'bedrooms:icon_row', 'bathrooms:icon_row', 'car_spaces:icon_row',
    ]));
  });

  it('reads a half bathroom in the bathroom\'s place', () => {
    expect(read([headline(ICONS('3', '2.5', '2'))]).counts).toEqual([3, 2.5, 2]);
  });

  it('records a plan that named fewer bedrooms as a floor, not a disagreement', () => {
    const { counts, reading } = read([headline(ICONS('4', '2', '2'), [at(12, 480, 'Master')])]);
    expect(counts).toEqual([4, 2, 2]);
    expect(reading.diagnostics.countEvidence)
      .toEqual(['icon_row_in_conventional_order', 'plan_bedrooms_within_count']);
  });
});

describe('a plan that keys the row still keys it', () => {
  it('and the order is never the evidence where the plan is', () => {
    const plan = ['Master', 'Bed 2', 'Bed 3', 'Bed 4'].map((room, index) => at(10 + index, 480, room));
    const { counts, reading } = read([headline(ICONS('4', '2', '2'), plan)]);
    expect(counts).toEqual([4, 2, 2]);
    expect(reading.diagnostics.countEvidence).not.toContain('icon_row_in_conventional_order');
  });
});

describe('each guard, alone, refuses', () => {
  const none = [null, null, null];

  it('a plan naming MORE bedrooms than the row prints', () => {
    const plan = ['Master', 'Bed 2', 'Bed 3', 'Bed 4'].map((room, index) => at(10 + index, 480, room));
    const { counts, reading } = read([headline(ICONS('3', '2', '2'), plan)]);
    expect(counts).toEqual(none);
    expect(reading.diagnostics.visualOnlyFields).toEqual(['bathrooms', 'bedrooms', 'car_spaces']);
  });

  it('figures set a column apart but with no room for a pictogram', () => {
    // Twelve points between figures: three cells, as a table's columns are,
    // and less than three of the figures' own advances.
    const tight = [figure(1, 81.5, '4'), figure(1, 100, '2'), figure(1, 118.5, '2')];
    expect(read([headline(tight)]).counts).toEqual(none);
  });

  it('text drawn in the gap where the pictogram would be', () => {
    expect(read([headline([...ICONS('4', '2', '2'), at(1, 120, 'from')])]).counts).toEqual(none);
  });

  it('zero-padded figures, which number something', () => {
    // `03 02 01` is plausible in every other respect, so this is the one
    // guard that refuses it.
    expect(read([headline(ICONS('03', '02', '01'))]).counts).toEqual(none);
  });

  it('more bathrooms than bedrooms and a powder room', () => {
    expect(read([headline(ICONS('1', '2', '1'))]).counts).toEqual(none);
  });

  it('more car spaces than bedrooms and one', () => {
    expect(read([headline(ICONS('1', '1', '3'))]).counts).toEqual(none);
  });

  it('a half anywhere but the bathroom\'s place', () => {
    expect(read([headline(ICONS('2.5', '2', '1'))]).counts).toEqual(none);
  });

  it('a row on a page that does not name the lot', () => {
    const cover = [at(0, 28, 'Orion 11.5'), ...ICONS('4', '2', '2')];
    const details = [
      at(0, 29, 'Package Price - $801,500'),
      at(1, 28, 'Lot 1809 Maple Estate,'),
      at(2, 28, 'Tarneit'),
      at(3, 28, 'Land Size 312m2'),
    ];
    expect(read([cover, details]).counts).toEqual(none);
  });

  it('a second, different row anywhere in the document', () => {
    const second = [figure(20, 81.5, '3'), figure(20, 165, '2'), figure(20, 257, '1')];
    expect(read([headline(ICONS('4', '2', '2'), second)]).counts).toEqual(none);
  });

  it('a row with no measured widths, which is a flattened line', () => {
    const flat = ICONS('4', '2', '2').map((item) => ({ ...item, width: 0 }));
    expect(read([headline(flat)]).counts).toEqual(none);
  });
});
