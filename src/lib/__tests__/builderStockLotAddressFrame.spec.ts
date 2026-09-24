/**
 * A LOT, ITS STREET AND ITS LOCALITY, HOWEVER THEY ARE SET OUT.
 *
 * Reader 21 made a locality's commas punctuation, and under a lot set as a
 * heading of its own that read `Egret Street, Marsden Park NSW 2765` as ONE
 * suburb — a second address the whole-document guard refused together with
 * the real one. The most ordinary flyer there is lost the street, the suburb,
 * the state and the postcode reader 20 had read. Swept against the values the
 * page means, 528 lot-heading layouts read 45 wrong and lost 63 at reader 21.
 *
 * The sweep that found it also found five older shapes, wrong or lost at
 * every reader: an estate run into its suburb, an estate and a bare suburb
 * after a comma, a pipe left on the street, a street number after the lot
 * (which imported NOTHING), and a dashed lot line whose street the positioned
 * layout put beside the lot rather than under it.
 *
 * Every case is the page's own statement, and the second half matters as much
 * as the first: a suburb ending in a development word is not an estate, a
 * state is never a suburb, and a real suburb whose middle word could end a
 * street is read whole.
 */
import { describe, expect, it } from 'vitest';

import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  readPdfBrochure,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

type Row = Record<string, unknown>;

/** Read a flattened page and return the record the import would keep. */
function read(lines: string[]) {
  const reading = readPdfBrochure([lines.join('\n')]);
  const raw = reading.rows[0] ?? reading.provisional[0];
  return { reading, row: (raw ? normaliseStockRow(raw) : null) as Row | null };
}

function expectFields(row: Row | null, want: Row) {
  expect(row).not.toBeNull();
  for (const [field, value] of Object.entries(want)) {
    expect([field, row?.[field] ?? null]).toEqual([field, value]);
  }
}

const TAIL = ['Land Size 412m²', 'Price $689,000'];
const ADDRESS = ['lot_number', 'address_line', 'suburb', 'state', 'postcode', 'development_name'];

describe('a lot set as a heading over the rest of its address', () => {
  const cases: Array<[string, string[], Row]> = [
    ['its street and locality, after a comma',
      ['LOT 572', 'Egret Street, Marsden Park NSW 2765'],
      { lot_number: '572', address_line: 'Egret Street', suburb: 'Marsden Park', state: 'NSW', postcode: '2765', development_name: null }],
    ['its street and locality, with no comma',
      ['LOT 745', 'Wren Street Riverstone NSW 2765'],
      { lot_number: '745', address_line: 'Wren Street', suburb: 'Riverstone', state: 'NSW', postcode: '2765' }],
    ['its estate and locality, after a comma',
      ['Lot 318', 'Sandpiper Estate, Oran Park NSW 2570'],
      { lot_number: '318', development_name: 'Sandpiper Estate', suburb: 'Oran Park', state: 'NSW', postcode: '2570', address_line: null }],
    ['its estate and locality, with no comma',
      ['LOT 692', 'Osprey Estate Point Cook VIC 3030'],
      { lot_number: '692', development_name: 'Osprey Estate', suburb: 'Point Cook', state: 'VIC', postcode: '3030' }],
    ['a heading closed by a dash',
      ['LOT 572 -', 'Egret Street, Marsden Park NSW 2765'],
      { lot_number: '572', address_line: 'Egret Street', suburb: 'Marsden Park', state: 'NSW', postcode: '2765' }],
    ['its street, then its estate run into its suburb',
      ['LOT 692', 'Tern Street', 'Osprey Estate Point Cook VIC 3030'],
      { lot_number: '692', address_line: 'Tern Street', development_name: 'Osprey Estate', suburb: 'Point Cook', state: 'VIC', postcode: '3030' }],
    ['its street, then its estate and suburb after a comma',
      ['LOT 463', 'Plover Avenue', 'Lorikeet Estate, Tarneit VIC 3029'],
      { lot_number: '463', address_line: 'Plover Avenue', development_name: 'Lorikeet Estate', suburb: 'Tarneit', state: 'VIC', postcode: '3029' }],
    ['its locality set apart by commas',
      ['LOT 214', 'Clyde North, VIC, 3978'],
      { lot_number: '214', suburb: 'Clyde North', state: 'VIC', postcode: '3978' }],
  ];
  for (const [name, lines, want] of cases) {
    it(`reads ${name}, completely`, () => {
      const { reading, row } = read([...lines, ...TAIL]);
      expect(reading.status).toBe('complete');
      expectFields(row, want);
    });
  }

  it('reads its street, estate and suburb with nothing but a price beside them', () => {
    // Reader 20 stood this document down: with the locality unread, a lot
    // and a price were too few to call a property.
    const { reading, row } = read(['LOT 692', 'Tern Street', 'Osprey Estate Point Cook VIC 3030', 'Price $731,000']);
    expect(reading.status).toBe('complete');
    expectFields(row, { lot_number: '692', address_line: 'Tern Street', suburb: 'Point Cook', development_name: 'Osprey Estate', price: 731000 });
  });
});

describe('a lot and its street, then an estate beside its suburb', () => {
  const cases: Array<[string, string[], Row]> = [
    ['an estate run into its suburb',
      ['Lot 229 Currawong Drive', 'Kingfisher Estate Clyde North VIC 3978'],
      { lot_number: '229', address_line: 'Currawong Drive', development_name: 'Kingfisher Estate', suburb: 'Clyde North', state: 'VIC', postcode: '3978' }],
    ['an estate run into its suburb, and a comma before the state',
      ['Lot 229 Currawong Drive', 'Kingfisher Estate Clyde North, VIC 3978'],
      { development_name: 'Kingfisher Estate', suburb: 'Clyde North', state: 'VIC', postcode: '3978' }],
    ['an estate and its suburb after a comma, with its state',
      ['Lot 326 Dapple Avenue', 'Palomino Estate, Armstrong Creek VIC 3217'],
      { lot_number: '326', address_line: 'Dapple Avenue', development_name: 'Palomino Estate', suburb: 'Armstrong Creek', state: 'VIC', postcode: '3217' }],
    ['an estate and its suburb after a comma, with no state',
      ['Lot 814 Brolga Street', 'Jacana Estate, Wyndham Vale'],
      { lot_number: '814', address_line: 'Brolga Street', development_name: 'Jacana Estate', suburb: 'Wyndham Vale', state: null, postcode: null }],
    ['an estate named after the suburb it is in',
      ['Lot 326 Dapple Avenue', 'Mambourin Estate, Mambourin VIC 3024'],
      { development_name: 'Mambourin Estate', suburb: 'Mambourin', state: 'VIC', postcode: '3024' }],
    ['an estate run into its suburb under a numbered street',
      ['18 Egret Street', 'Sandpiper Estate Marsden Park NSW 2765'],
      { address_line: '18 Egret Street', development_name: 'Sandpiper Estate', suburb: 'Marsden Park', state: 'NSW', postcode: '2765' }],
    ['an estate in capitals run into its suburb',
      ['LOT 5 EGRET STREET', 'SANDPIPER ESTATE MARSDEN PARK NSW 2765'],
      { address_line: 'EGRET STREET', development_name: 'SANDPIPER ESTATE', suburb: 'MARSDEN PARK', state: 'NSW', postcode: '2765' }],
  ];
  for (const [name, lines, want] of cases) {
    it(`reads ${name}`, () => {
      const { reading, row } = read([...lines, ...TAIL]);
      expect(reading.status).toBe('complete');
      expectFields(row, want);
    });
  }
});

describe('what sits between a lot and its street', () => {
  const cases: Array<[string, string[], Row]> = [
    ['a pipe', ['LOT 537 | Magpie Crescent', 'Werribee VIC 3030'],
      { lot_number: '537', address_line: 'Magpie Crescent', suburb: 'Werribee', state: 'VIC', postcode: '3030' }],
    ['a colon', ['Lot 537: Magpie Crescent', 'Werribee VIC 3030'],
      { lot_number: '537', address_line: 'Magpie Crescent', suburb: 'Werribee' }],
    ['a dash', ['Lot 537 - Magpie Crescent', 'Werribee VIC 3030'],
      { lot_number: '537', address_line: 'Magpie Crescent', suburb: 'Werribee' }],
    ['the street\'s own number, after a comma', ['Lot 906, 14 Heath Street', 'Riverstone NSW 2765'],
      { lot_number: '906', address_line: '14 Heath Street', suburb: 'Riverstone', state: 'NSW', postcode: '2765' }],
    ['the street\'s own number, with no comma', ['Lot 906 14 Heath Street', 'Riverstone NSW 2765'],
      { lot_number: '906', address_line: '14 Heath Street', suburb: 'Riverstone' }],
    ['the street\'s own number, and an estate run into the suburb', ['Lot 906 14 Heath Street', 'Kestrel Estate Riverstone NSW 2765'],
      { lot_number: '906', address_line: '14 Heath Street', development_name: 'Kestrel Estate', suburb: 'Riverstone' }],
  ];
  for (const [name, lines, want] of cases) {
    it(`reads ${name} as neither the lot nor the street`, () => {
      const { reading, row } = read([...lines, ...TAIL]);
      expect(reading.status).toBe('complete');
      expectFields(row, want);
    });
  }

  it('reads no street from a line that names no street after the lot', () => {
    const { row } = read(['Lot 906 2 Storey Home', 'Riverstone NSW 2765', ...TAIL]);
    expect(row?.address_line ?? null).toBeNull();
  });
});

describe('a dashed lot line whose street the page set beside the lot', () => {
  const yOf = (band: number) => 800 - band * 24;
  const at = (band: number, text: string, height = 12): PdfTextItem =>
    ({ text, x: 43, y: yOf(band), width: text.length * 7, height });

  const readPositioned = (items: PdfTextItem[]) => {
    const reading = readPdfBrochure(
      [items.map((item) => item.text).join('\n')],
      { positionedPages: [{ page: 1, items }] },
    );
    return { reading, row: (reading.rows.length ? normaliseStockRow(reading.rows[0]) : null) as Row | null };
  };

  it('reads the street split onto the lot\'s own row, and the estate and suburb under them', () => {
    const { reading, row } = readPositioned([
      at(0, 'LOT 463 - Plover Avenue', 22),
      at(1, 'Lorikeet Estate, Tarneit VIC 3029'),
      at(3, 'Land Size 392m²'),
      at(4, 'Price $702,500'),
    ]);
    expect(reading.status).toBe('complete');
    expectFields(row, {
      lot_number: '463', address_line: 'Plover Avenue', development_name: 'Lorikeet Estate',
      suburb: 'Tarneit', state: 'VIC', postcode: '3029',
    });
  });

  it('reads a design split onto the lot\'s row as no street', () => {
    const { row } = readPositioned([
      at(0, 'LOT 88 - HARLOW 21', 22),
      at(1, 'Wollert VIC 3750'),
      at(3, 'Land Size 392m²'),
      at(4, 'Price $702,500'),
    ]);
    expect(row?.address_line ?? null).toBeNull();
  });
});

describe('what a lot or a street must never be read as', () => {
  it('reads a suburb ending in a development word as the suburb, and never as an estate', () => {
    const { row } = read(['LOT 572', 'Marsden Park, NSW 2765', ...TAIL]);
    expectFields(row, { suburb: 'Marsden Park', state: 'NSW', postcode: '2765', development_name: null });
  });

  it('reads a state and its postcode under a street as exactly that, and never as a suburb', () => {
    expectFields(read(['18 Egret Street', 'NSW 2765', ...TAIL]).row,
      { address_line: '18 Egret Street', suburb: null, state: 'NSW', postcode: '2765' });
    expectFields(read(['Lot 5 Egret Street', 'Victoria 3029', ...TAIL]).row,
      { address_line: 'Egret Street', suburb: null, state: 'VIC', postcode: '3029' });
    // 2029 is a New South Wales postcode: the state is not Victoria, and no suburb is.
    expectFields(read(['Lot 5 Egret Street', 'Victoria 2029', ...TAIL]).row, { suburb: null, state: null });
  });

  it('never reads a street or an estate run into a locality as one suburb', () => {
    for (const [heading, locality] of [
      ['LOT 572', 'Egret Street, Marsden Park NSW 2765'],
      ['LOT 745', 'Wren Street Riverstone NSW 2765'],
      ['Lot 326 Dapple Avenue', 'Palomino Rise Armstrong Creek VIC 3217'],
      ['Lot 326 - Dapple Avenue', 'Palomino Estate, Armstrong Creek VIC 3217'],
    ]) {
      const { row } = read([heading, locality, ...TAIL]);
      const suburb = String(row?.suburb ?? '');
      expect([locality, /\b(?:street|estate|rise)\b/i.test(suburb)]).toEqual([locality, false]);
    }
  });

  it('reads a suburb whose middle word could end a street whole', () => {
    for (const [locality, suburb] of [
      ['Holland Park West QLD 4121', 'Holland Park West'],
      ['Box Hill North VIC 3129', 'Box Hill North'],
      ['Lane Cove West NSW 2066', 'Lane Cove West'],
      ['Mount Victoria NSW 2786', 'Mount Victoria'],
      ['Victoria Point QLD 4165', 'Victoria Point'],
    ]) {
      for (const heading of [['LOT 572'], ['Lot 572 Egret Street'], ['18 Egret Street']]) {
        const { row } = read([...heading, locality, ...TAIL]);
        expect([heading[0], locality, row?.suburb ?? null]).toEqual([heading[0], locality, suburb]);
      }
    }
  });

  it('takes an estate named with a word that also names streets for no estate under a bare lot', () => {
    const { row } = read(['LOT 572', 'Egret Grove, Marsden Park NSW 2765', ...TAIL]);
    expectFields(row, { suburb: 'Marsden Park', development_name: null });
  });

  it('reads nothing of a place from a line that names none', () => {
    for (const under of ['Harlow 21', '4 Bed | 2 Bath | 2 Car', 'Titles: Dec 2026', 'Spring 2026']) {
      const { row } = read(['Lot 326 Dapple Avenue', under, ...TAIL]);
      for (const field of ADDRESS.filter((f) => f !== 'lot_number' && f !== 'development_name')) {
        expect([under, field, row?.[field] ?? null]).toEqual([under, field, null]);
      }
    }
  });
});
