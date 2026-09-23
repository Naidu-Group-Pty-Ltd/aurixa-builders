/**
 * THE HOUSE'S AREA SCHEDULE, AND WHEN ITS TOTAL IS THE BUILDING SIZE.
 *
 * `readAreaScheduleTotal` answers one question — what does the one dwelling
 * area schedule on this document add up to — and the reader asks it only
 * where the document labels no build size and does not state two. Both halves
 * are asserted: the schedule is read where it is all the document offers, and
 * it never speaks over a figure the document LABELLED, because that is the
 * reason the first version of this rule was deleted (Lot 315: `Total: 117.50m²`
 * on the cover, `Build Area: 119.16 m2` on the siting page).
 */
import { describe, expect, it } from 'vitest';

import {
  readAreaScheduleTotal,
  type ScheduleUnit,
} from '../../../supabase/functions/_shared/builderStock/areaSchedule.pure';
import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

/** Rows of a schedule drawn as a label cell beside a value cell. */
const schedule = (rows: Array<[string, string]>, first = 30): ScheduleUnit[] =>
  rows.flatMap(([label, value], index) => [
    { text: label, row: first + index, x: 29 },
    { text: value, row: first + index, x: 101 },
  ]);

describe('the one schedule a document draws', () => {
  it('answers its total, as the document wrote it', () => {
    const total = readAreaScheduleTotal([schedule([
      ['Enclosed:', '91.91m2'], ['Garage:', '38.10m2'], ['Porch:', '3m2'], ['Total:', '129.5m2'],
    ])]);
    expect(total).toEqual({ value: '129.5m2', parts: 3 });
  });

  it('reads a schedule set as one cell a row', () => {
    const units: ScheduleUnit[] = ['Ground Floor: 139.5m2', 'Garage: 36.0m2', 'Porch: 1.5m2',
      'Total: 177.0m2'].map((text, index) => ({ text, row: index, x: 0 }));
    expect(readAreaScheduleTotal([units])?.value).toBe('177.0m2');
  });

  it("walks past a plan's labels drawn between its rows", () => {
    const units = [
      ...schedule([['Enclosed:', '118.40m2'], ['Garage:', '38.10m2']], 10),
      { text: 'Bed 3', row: 12, x: 498 },
      ...schedule([['Porch:', '4m2'], ['Total:', '160.5m2']], 13),
    ];
    expect(readAreaScheduleTotal([units])?.value).toBe('160.5m2');
  });

  it('answers once for a schedule the document prints twice', () => {
    const rows: Array<[string, string]> = [['Enclosed:', '91.91m2'], ['Garage:', '38.10m2'],
      ['Total:', '130.01m2']];
    expect(readAreaScheduleTotal([schedule(rows), schedule(rows, 70)])?.value).toBe('130.01m2');
  });
});

describe('what it refuses', () => {
  it('a total with only one part', () => {
    expect(readAreaScheduleTotal([schedule([['Garage:', '38.10m2'], ['Total:', '38.10m2']])]))
      .toBeNull();
  });

  it('money, which is never an area', () => {
    expect(readAreaScheduleTotal([schedule([
      ['House:', '$347,050'], ['Garage:', '$20,000'], ['Total:', '$367,050'],
    ])])).toBeNull();
  });

  it('a list of lots, which names no part of a dwelling', () => {
    expect(readAreaScheduleTotal([schedule([
      ['Lot 1:', '300m2'], ['Lot 2:', '320m2'], ['Total:', '620m2'],
    ])])).toBeNull();
  });

  it('a total smaller than one of its parts', () => {
    expect(readAreaScheduleTotal([schedule([
      ['Enclosed:', '140m2'], ['Garage:', '36m2'], ['Total:', '120m2'],
    ])])).toBeNull();
  });

  it('a total its parts do not account for', () => {
    expect(readAreaScheduleTotal([schedule([
      ['Enclosed:', '140m2'], ['Garage:', '36m2'], ['Total:', '420m2'],
    ])])).toBeNull();
  });

  it('two schedules that disagree', () => {
    expect(readAreaScheduleTotal([
      schedule([['Enclosed:', '91.91m2'], ['Garage:', '38.10m2'], ['Total:', '130m2']]),
      schedule([['Enclosed:', '101m2'], ['Garage:', '38.10m2'], ['Total:', '139.1m2']], 70),
    ])).toBeNull();
  });

  it('a schedule that never closes with a total', () => {
    expect(readAreaScheduleTotal([schedule([['Enclosed:', '91.91m2'], ['Garage:', '38.10m2']])]))
      .toBeNull();
  });
});

describe('the reader asks it only where nothing else states the build', () => {
  const yOf = (band: number) => 780 - band * 14;
  const at = (band: number, x: number, text: string): PdfTextItem =>
    ({ text, x, y: yOf(band), width: text.length * 5 });
  const page = (extra: PdfTextItem[]): PdfTextItem[] => [
    at(0, 28, 'Lot 214'),
    at(1, 28, 'Home Design: Aspire 24'),
    at(2, 28, 'Price: $662,900'),
    at(10, 29, 'Enclosed:'), at(10, 101, '201.40m2'),
    at(11, 29, 'Garage:'), at(11, 101, '36.10m2'),
    at(12, 29, 'Total:'), at(12, 101, '237.50m2'),
    ...extra,
  ];
  const read = (items: PdfTextItem[]) => {
    const reading = readPdfBrochure(
      [items.map((item) => item.text).join('\n')],
      { positionedPages: [{ page: 1, items }] },
    );
    return { reading, row: reading.rows.length ? normaliseStockRow(reading.rows[0]) : null };
  };

  it('reads the total where the document states nothing else', () => {
    const { row, reading } = read(page([]));
    expect(row?.building_size_sqm).toBe(237.5);
    expect(reading.diagnostics.readBy ?? []).toContain('building_size_sqm:area_schedule');
  });

  it('never speaks over a build size the document labelled', () => {
    const { row, reading } = read(page([at(20, 28, 'Build Area: 241.16 m2')]));
    expect(row?.building_size_sqm).toBe(241.16);
    expect(reading.diagnostics.readBy ?? []).not.toContain('building_size_sqm:area_schedule');
  });

  it('never breaks a tie the document left open', () => {
    const { row } = read(page([
      at(20, 28, 'Build Area: 241.16 m2'),
      at(22, 28, 'Build Size: 250 m2'),
    ]));
    expect(row?.building_size_sqm ?? null).toBeNull();
  });
});
