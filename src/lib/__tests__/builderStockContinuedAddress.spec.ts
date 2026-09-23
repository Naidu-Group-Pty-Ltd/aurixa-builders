/**
 * ONE ADDRESS, BROKEN ACROSS TWO LINES AT A COMMA.
 *
 *     Lot 4327 Jubilee Estate,          Lot 3312 Smiths Lane,
 *     Wyndham Vale                      Clyde North
 *
 * Both are production brochures from one builder's template (23 September
 * 2026), and both imported the lot and nothing after it. The comma is the
 * document's own statement that the address continues, and
 * `readContinuedAddress` reads it — under conditions each of which is tested
 * here with a twin that fails it, because an address reader that says yes too
 * easily writes a sales office onto a property.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const yOf = (band: number) => 780 - band * 28;
const at = (band: number, x: number, text: string, height = 23): PdfTextItem =>
  ({ text, x, y: yOf(band), width: text.length * 9, height });

/** A package page: design, prices, the two-line address, titles. */
const page = (lotLine: string, placeLine: string, extra: PdfTextItem[] = []): PdfTextItem[] => [
  at(0, 28, 'Orion 11.5', 30),
  at(2, 29, 'Package Price - $801,500', 22),
  at(3, 28, 'Land Size 312m2', 14),
  at(4, 28, lotLine),
  at(5, 28, placeLine),
  at(6, 28, 'Titles - Titled Land'),
  ...extra,
];

const read = (items: PdfTextItem[], organisationName: string | null = null) => {
  const reading = readPdfBrochure(
    [items.map((item) => item.text).join('\n')],
    { positionedPages: [{ page: 1, items }], organisationName },
  );
  return {
    reading,
    row: reading.rows.length ? normaliseStockRow(reading.rows[0]) : null,
  };
};

describe('the address a comma carries onto the next line', () => {
  it('reads an estate and its suburb', () => {
    const { row, reading } = read(page('Lot 4327 Jubilee Estate,', 'Wyndham Vale'));
    expect(row?.lot_number).toBe('4327');
    expect(row?.development_name).toBe('Jubilee Estate');
    expect(row?.suburb).toBe('Wyndham Vale');
    expect(row?.address_line ?? null).toBeNull();
    expect(reading.diagnostics.readBy ?? []).toContain('suburb:address_block');
  });

  it('reads a street and its suburb', () => {
    const { row } = read(page('Lot 3312 Smiths Lane,', 'Clyde North'));
    expect(row?.address_line).toBe('Smiths Lane');
    expect(row?.suburb).toBe('Clyde North');
  });

  it('reads a numbered street and its suburb', () => {
    const { row } = read(page('49 Cockrell Rd,', 'Mernda'));
    expect(row?.address_line).toBe('49 Cockrell Rd');
    expect(row?.suburb).toBe('Mernda');
  });

  it('takes the state and postcode only where the page prints them', () => {
    const bare = read(page('Lot 4327 Jubilee Estate,', 'Wyndham Vale')).row;
    expect(bare?.state ?? null).toBeNull();
    expect(bare?.postcode ?? null).toBeNull();
    const full = read(page('Lot 4327 Jubilee Estate,', 'Wyndham Vale VIC 3024')).row;
    expect(full?.suburb).toBe('Wyndham Vale');
    expect(full?.state).toBe('VIC');
    expect(full?.postcode).toBe('3024');
  });
});

describe('what it will not read as a suburb', () => {
  it('a line that does not continue: no comma, no address', () => {
    const { row } = read(page('Lot 4327 Jubilee Estate', 'Wyndham Vale'));
    expect(row?.suburb ?? null).toBeNull();
    expect(row?.development_name ?? null).toBeNull();
  });

  it('the tail of a line that names no lot and no street number', () => {
    // `Maple Estate,` over a place is `readNamedPlace`'s shape, which reads the
    // estate and deliberately never its tail.
    const { row } = read(page('Maple Estate,', 'Tarneit'));
    expect(row?.suburb ?? null).toBeNull();
  });

  it('a line carrying a figure', () => {
    const { row } = read(page('Lot 4327 Jubilee Estate,', 'Stage 12'));
    expect(row?.suburb ?? null).toBeNull();
  });

  it('a line this vocabulary reads as a label', () => {
    const { row } = read(page('Lot 4327 Jubilee Estate,', 'Titled Land'));
    expect(row?.suburb ?? null).toBeNull();
  });

  it('a line set as a sentence', () => {
    const { row } = read(page('Lot 4327 Jubilee Estate,', 'a place to call home'));
    expect(row?.suburb ?? null).toBeNull();
  });

  it("the builder's own name", () => {
    const { row } = read(page('Lot 4327 Jubilee Estate,', 'Alto Homes'), 'Alto Homes Pty Ltd');
    expect(row?.suburb ?? null).toBeNull();
  });

  it('a street-type word after an estate, which is a street as easily as a suburb', () => {
    const { row } = read(page('Lot 12 Aurora Estate,', 'Harvest Rise'));
    expect(row?.suburb ?? null).toBeNull();
  });

  it('anything, where the document draws a second address', () => {
    const { row } = read(page('Lot 4327 Jubilee Estate,', 'Wyndham Vale', [
      at(9, 28, '12 Sample Street,', 10),
      at(10, 28, 'Thomastown VIC 3074', 10),
    ]));
    expect(row?.suburb ?? null).toBeNull();
  });

  it('over a locality the document labelled', () => {
    const { row } = read(page('Lot 4327 Jubilee Estate,', 'Wyndham Vale', [
      at(9, 28, 'Locality: MANOR LAKES', 10),
    ]));
    expect(row?.suburb).toBe('MANOR LAKES');
  });
});
