/**
 * `49 Cockrell Rd,` OVER `Mernda VIC 3754` — THE ADDRESS A FLYER PRINTS WITH
 * NO LABEL AT ALL.
 *
 * WHAT THIS FIXTURE IS. The coordinates are the ones `LOT 27 - ZIMI - FLYER`
 * and `LOT 36 - ZIMI - FLYER` actually reported from production on 21
 * September 2026, read back out of each import's own `placement` record.
 * Both draw the same block at the same place:
 *
 *     p1 r5 x276   49 Cockrell Rd,        68 Burnside Way,
 *     p1 r6 x276   Mernda VIC 3754        Mernda VIC 3754
 *
 * MEASURED ACROSS ALL FOUR LIVE DOCUMENTS, 1,057 lines the reader had
 * attributed to nothing: one locality line and one street line in exactly
 * the two documents that carry an address, and not one false positive in the
 * other 1,050 — which include prices, dimensions, inclusions prose and a
 * floor plan's room names.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const yOf = (band: number) => 780 - band * 14;
const at = (band: number, x: number, text: string): PdfTextItem =>
  ({ text, x, y: yOf(band), width: text.length * 5 });

/** The ZIMI flyer's first page, at its measured bands. */
const flyer = (extra: PdfTextItem[] = []): PdfTextItem[] => [
  at(0, 36, 'HAVENWOOD'),
  at(3, 36, 'Zimi'),
  at(4, 88, '3'), at(4, 167, '2.5'), at(4, 260, '1'),
  at(5, 276, '49 Cockrell Rd,'),
  at(6, 276, 'Mernda VIC 3754'),
  at(7, 47, 'Front and rear landscaping, driveway + fencing'),
  at(8, 47, 'Timber look laminate flooring, carpet'),
  at(12, 47, '20mm stone benchtops'),
  at(13, 47, 'LED downlights throughout'),
  at(15, 47, '2590mm ceilings throughout'),
  at(21, 47, '600mm European appliances inc dishwasher'),
  at(24, 47, 'Exposed aggregate concrete driveway and path'),
  at(30, 36, 'Lot 27'),
  at(31, 36, 'Land Size: 143 m2'),
  at(32, 36, 'Build Size: 180 m2'),
  at(33, 36, 'Price: $699,000'),
  ...extra,
];

const readFlyer = (items: PdfTextItem[]) => readPdfBrochure(
  [items.map((item) => item.text).join('\n')],
  { positionedPages: [{ page: 1, items }] },
);

const reading = readFlyer(flyer());
const record = reading.rows.length ? normaliseStockRow(reading.rows[0]) : null;

describe('an unlabelled address block is read', () => {
  it('reads the street the flyer prints', () => {
    expect(record?.address_line).toBe('49 Cockrell Rd');
  });

  it('reads the locality, the state and the postcode', () => {
    expect(record?.suburb).toBe('Mernda');
    expect(record?.state).toBe('VIC');
    expect(record?.postcode).toBe('3754');
  });

  it('names how it read them, so a record can be audited', () => {
    expect(reading.diagnostics.readBy ?? [])
      .toEqual(expect.arrayContaining(['address_line:address_block']));
  });
});

describe('what keeps it from reading a specification as a street', () => {
  it('claims nothing from a street line with no locality under it', () => {
    // A street-shaped line alone is a line that happens to look like one.
    const alone = readFlyer(flyer().filter((i) => i.text !== 'Mernda VIC 3754'));
    const row = alone.rows.length ? normaliseStockRow(alone.rows[0]) : null;
    expect(row?.address_line ?? null).toBeNull();
    expect(row?.suburb ?? null).toBeNull();
  });

  it('claims nothing where the document draws TWO blocks', () => {
    /*
     * A builder's own office address is the same shape as a property's, and
     * this module does not choose between two readings. Two blocks claim
     * nothing and the document reads exactly as it did.
     */
    const two = readFlyer(flyer([
      at(40, 47, '12 Sample Street'),
      at(41, 47, 'Thomastown VIC 3074'),
    ]));
    const row = two.rows.length ? normaliseStockRow(two.rows[0]) : null;
    expect(row?.address_line ?? null).toBeNull();
    expect(row?.suburb ?? null).toBeNull();
  });

  it('never reads a measurement as a street number', () => {
    // `20mm stone benchtops`, `2590mm ceilings throughout` and `600mm
    // European appliances` are all on this page, above and below each other.
    expect(record?.address_line).not.toMatch(/mm/);
  });

  /*
   * RENEGOTIATED 23 SEPTEMBER 2026, and this is the record the corpus
   * contract asks for.
   *
   * WAS: a bare suburb under a street line claims nothing — `Diggers Rest` "is
   * a suburb and nothing else, and a bare suburb is not the document labelling
   * itself".
   *
   * WHY THAT WAS WRONG FOR THIS SHAPE: the street line above it ends in a
   * COMMA. The document is saying, in its own punctuation, that the address
   * goes on — the same address the one-line reader has read since
   * `Lot 37, Sandpiper Estate, Tweed Heads NSW` was measured. Refusing it cost
   * production real cards: `LOT 4327` (`Lot 4327 Jubilee Estate,` over
   * `Wyndham Vale`) and `LOT 3312` (`Lot 3312 Smiths Lane,` over
   * `Clyde North`) imported with no locality at all, read back out of their
   * own `placement` records.
   *
   * NOW: with the comma, the suburb is read and NOTHING is invented — no state
   * and no postcode the page does not print. Without it, the original refusal
   * stands exactly as it was, which is the half of this test that still
   * protects what it was written to protect.
   */
  it('reads a bare suburb only where the street line above it continues with a comma', () => {
    const bare = readFlyer(flyer().map((item) =>
      item.text === 'Mernda VIC 3754' ? at(6, 276, 'Diggers Rest') : item));
    const row = bare.rows.length ? normaliseStockRow(bare.rows[0]) : null;
    expect(row?.address_line).toBe('49 Cockrell Rd');
    expect(row?.suburb).toBe('Diggers Rest');
    expect(row?.state ?? null).toBeNull();
    expect(row?.postcode ?? null).toBeNull();
  });

  it('refuses a locality line with no state and postcode under a street line that does not continue', () => {
    const bare = readFlyer(flyer().map((item) => {
      if (item.text === 'Mernda VIC 3754') return at(6, 276, 'Diggers Rest');
      if (item.text === '49 Cockrell Rd,') return at(5, 276, '49 Cockrell Rd');
      return item;
    }));
    const row = bare.rows.length ? normaliseStockRow(bare.rows[0]) : null;
    expect(row?.suburb ?? null).toBeNull();
  });

  it('defers to an address the document LABELLED', () => {
    // A `Site Address:` box is the document saying so in words, and a block
    // read from shape alone must never overrule one.
    const labelled = readFlyer(flyer([
      at(36, 36, 'Site Address: Lot 27 Havenwood Boulevard'),
    ]));
    const row = labelled.rows.length ? normaliseStockRow(labelled.rows[0]) : null;
    expect(row?.address_line).toBe('Lot 27 Havenwood Boulevard');
  });
});
