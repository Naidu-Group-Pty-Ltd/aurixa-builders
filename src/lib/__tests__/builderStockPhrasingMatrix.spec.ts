/**
 * THE WAYS A BROCHURE PHRASES A FACT, AND WHAT THE READER MUST TAKE FROM EACH.
 *
 * Found 24 September 2026 by putting 130 phrasings through the reader instead
 * of waiting for a customer's document to show them one at a time. Four
 * address layouts imported NOTHING — the one line naming the property was the
 * line nobody read — two prices were stored WRONG on every source (`$829k` as
 * $829, `$1.15M` as $1.15), and the rest lost a printed fact while the reading
 * reported itself complete.
 *
 * Every case here is the document's own statement. The negative half matters
 * as much as the positive: each of those lines must still read nothing, so a
 * reading that grows never grows into a guess.
 */
import { describe, expect, it } from 'vitest';

import { acceptFieldValue } from '../../../supabase/functions/_shared/builderStock/fieldTypes.pure';
import {
  coercePrice, normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  readComposedAddressLine, readPdfBrochure, readPdfDeterministicRows,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

type Row = Record<string, unknown>;

/** Read a page and return the record the import would keep, complete or not. */
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

const TAIL = ['Land Size 450m²', 'Price $799,000'];

describe('an address, however the page punctuates it', () => {
  const cases: Array<[string, string[], Row]> = [
    ['the locality set apart by commas',
      ['LOT 214 Kingfisher Road, Clyde North, VIC, 3978'],
      { lot_number: '214', address_line: 'Kingfisher Road', suburb: 'Clyde North', state: 'VIC', postcode: '3978' }],
    ['the suburb set apart from its state',
      ['Lot 12 Wattle Grove Road, Clyde North, VIC 3978'],
      { lot_number: '12', address_line: 'Wattle Grove Road', suburb: 'Clyde North', state: 'VIC', postcode: '3978' }],
    ['a comma after the lot',
      ['Lot 12, Wattle Grove Road', 'Bungendore NSW 2621'],
      { lot_number: '12', address_line: 'Wattle Grove Road', suburb: 'Bungendore', state: 'NSW', postcode: '2621' }],
    ['rules between the parts',
      ['Lot 58 | Wren Street | Box Hill NSW 2765'],
      { lot_number: '58', address_line: 'Wren Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['no comma at all',
      ['Lot 903 Fairwater Drive Tarneit VIC 3029'],
      { lot_number: '903', address_line: 'Fairwater Drive', suburb: 'Tarneit', state: 'VIC', postcode: '3029' }],
    ['no comma, and a street type in the street name',
      ['Lot 12 Wattle Grove Road Bungendore NSW 2621'],
      { lot_number: '12', address_line: 'Wattle Grove Road', suburb: 'Bungendore', state: 'NSW', postcode: '2621' }],
    ['no comma, and a suburb opening with a word a street may end in',
      ['Lot 12 Smith Street Glen Waverley VIC 3150'],
      { lot_number: '12', address_line: 'Smith Street', suburb: 'Glen Waverley', state: 'VIC', postcode: '3150' }],
    ['the lot, the street and the locality on three lines',
      ['LOT 47', 'Heron Court', 'Mount Barker SA 5251'],
      { lot_number: '47', address_line: 'Heron Court', suburb: 'Mount Barker', state: 'SA', postcode: '5251' }],
    ['the lot, the estate and the locality on three lines',
      ['Lot 12', 'Stoneleigh Rise Estate', 'Bungendore NSW 2621'],
      { lot_number: '12', development_name: 'Stoneleigh Rise Estate', suburb: 'Bungendore', state: 'NSW', postcode: '2621' }],
    ['the state spelled out, with a postcode that agrees',
      ['Lot 12 Wattle Grove Road', 'Bungendore New South Wales 2621'],
      { address_line: 'Wattle Grove Road', suburb: 'Bungendore', state: 'NSW', postcode: '2621' }],
    ['the state spelled out on one line',
      ['Lot 12 Wattle Grove Road, Clyde North Victoria 3978'],
      { lot_number: '12', suburb: 'Clyde North', state: 'VIC', postcode: '3978' }],
    ['the street number in brackets after the lot',
      ['Lot 7 (No. 15) Banksia Way', 'Baldivis WA 6171'],
      { lot_number: '7', address_line: '15 Banksia Way', suburb: 'Baldivis', state: 'WA', postcode: '6171' }],
    ['the whole address under its own label',
      ['Address: Lot 33 Ridgeline Crescent, Ripley QLD 4306'],
      { lot_number: '33', address_line: 'Ridgeline Crescent', suburb: 'Ripley', state: 'QLD', postcode: '4306' }],
    ['a labelled locality',
      ['Lot 12 Wattle Grove Road', 'Location: Bungendore NSW 2621'],
      { suburb: 'Bungendore', state: 'NSW', postcode: '2621' }],
    ['a street called `The …`',
      ['Lot 16 The Promenade, Shell Cove NSW 2529'],
      { lot_number: '16', address_line: 'The Promenade', suburb: 'Shell Cove', state: 'NSW', postcode: '2529' }],
    ['a place and its postcode with no state',
      ['Lot 12 Wattle Grove Road', 'Clyde North 3978'],
      { address_line: 'Wattle Grove Road', suburb: 'Clyde North', state: null, postcode: '3978' }],
    ['a comma between the suburb and its state on the locality line',
      ['Lot 12 Wattle Grove Road', 'Bungendore, NSW 2621'],
      { suburb: 'Bungendore', state: 'NSW', postcode: '2621' }],
    ['a unit over its street number',
      ['5/12 Kestrel Street, Box Hill NSW 2765'],
      { unit_number: '5', address_line: '5/12 Kestrel Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['the unit named before its street',
      ['Unit 5, 12 Kestrel Street, Box Hill NSW 2765'],
      { unit_number: '5', address_line: '12 Kestrel Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['the kind of dwelling before a unit over its number',
      ['Townhouse 5/12 Kestrel Street, Box Hill NSW 2765'],
      { unit_number: '5', address_line: '5/12 Kestrel Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['the same, over its locality',
      ['Townhouse 5/12 Kestrel Street', 'Box Hill NSW 2765'],
      { unit_number: '5', address_line: '5/12 Kestrel Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['the unit named before its street, over its locality',
      ['Unit 5, 12 Kestrel Street', 'Box Hill NSW 2765'],
      { unit_number: '5', address_line: '12 Kestrel Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['a range of street numbers',
      ['12-14 Kestrel Street, Box Hill NSW 2765'],
      { unit_number: null, address_line: '12-14 Kestrel Street', suburb: 'Box Hill', state: 'NSW', postcode: '2765' }],
    ['a street that ends in a direction',
      ['Lot 118 Main Road East, Riverstone NSW 2765'],
      { lot_number: '118', address_line: 'Main Road East', suburb: 'Riverstone', state: 'NSW', postcode: '2765' }],
    ['a street that ends in a direction, over its locality',
      ['Lot 118 Great Western Highway West', 'Blacktown NSW 2148'],
      { lot_number: '118', address_line: 'Great Western Highway West', suburb: 'Blacktown', state: 'NSW', postcode: '2148' }],
  ];
  for (const [name, lines, want] of cases) {
    it(`reads ${name}, completely`, () => {
      const { reading, row } = read([...lines, ...TAIL]);
      expect(reading.status).toBe('complete');
      expectFields(row, want);
    });
  }

  it('reads the lot, state and postcode and leaves the street unread where the page leaves two answers', () => {
    // `Smith St Albans`: `St` is a street type and the start of a suburb.
    const { reading, row } = read(['Lot 12 Smith St Albans VIC 3021', ...TAIL]);
    expect(reading.status).toBe('complete');
    expectFields(row, { lot_number: '12', address_line: null, suburb: null, state: 'VIC', postcode: '3021' });
    // `Street Lane` is two street types; `Lane Cove` is a suburb.
    const cove = readComposedAddressLine('Lot 12 Smith Street Lane Cove NSW 2066');
    expect([cove?.street, cove?.suburb, cove?.lot]).toEqual(['', '', '12']);
  });

  it('never reads a spelled-out state its postcode contradicts', () => {
    // Mount Victoria is in New South Wales; 2786 is not a Victorian postcode.
    const { row } = read(['Lot 12 Wattle Grove Road', 'Mount Victoria 2786', ...TAIL]);
    expectFields(row, { suburb: 'Mount Victoria', state: null, postcode: '2786' });
  });

  it('reads a stage or release designation as costing the document nothing', () => {
    const { reading, row } = read(['Seabreeze Estate - Stage 3', 'Lot 16 The Promenade, Shell Cove NSW 2529', ...TAIL]);
    expect(reading.status).toBe('complete');
    expectFields(row, { development_name: 'Seabreeze Estate', lot_number: '16' });
  });
});

describe('the unit a townhouse is headed by', () => {
  const STREET = '18 Swift Street, Marsden Park NSW 2765';
  const PRICE = 'Price $719,000';

  it('reads `TOWNHOUSE 3` over its street as the unit, and never as the design', () => {
    const { reading, row } = read(['TOWNHOUSE 3', STREET, '3 Bed | 2 Bath | 1 Car', PRICE]);
    expect(reading.status).toBe('complete');
    expectFields(row, { unit_number: '3', house_design: null, address_line: '18 Swift Street', bedrooms: 3 });
    // The filename names the same words, and still does not make them a design.
    const named = readPdfDeterministicRows({
      pageTexts: [['TOWNHOUSE 3', STREET, PRICE].join('\n')],
      positionedPages: null,
      filename: 'TOWNHOUSE 3 - SWIFT - FLYER.pdf',
    } as Parameters<typeof readPdfDeterministicRows>[0]);
    expect(named.status).toBe('complete');
    expectFields(normaliseStockRow(named.rows[0]) as Row | null, { unit_number: '3', house_design: null });
  });

  for (const [heading, unit] of [
    ['Unit 5', '5'], ['Apartment 305', '305'], ['Apt. 12', '12'], ['Townhome 7', '7'],
    ['Unit No. 4', '4'], ['TOWNHOUSE 12A', '12A'],
  ]) {
    it(`reads ${JSON.stringify(heading)} as unit ${unit}`, () => {
      const { reading, row } = read([heading, STREET, PRICE]);
      expect(reading.status).toBe('complete');
      expectFields(row, { unit_number: unit, address_line: '18 Swift Street' });
    });
  }

  it('reads one unit printed twice as one unit', () => {
    const { reading, row } = read(['TOWNHOUSE 3', STREET, 'Townhouse 3', PRICE]);
    expect(reading.status).toBe('complete');
    expectFields(row, { unit_number: '3' });
  });

  it('takes nothing where the document names more than one unit, exactly as before', () => {
    // A site plan labelling its units names several, and names none of them as this one.
    const units = read(['Unit 1', 'Unit 2', STREET, PRICE]);
    expect(units.reading.status).toBe('incomplete');
    expectFields(units.row, { unit_number: null, address_line: '18 Swift Street' });
    const townhouses = read(['Townhouse 1', 'Townhouse 2', STREET, PRICE]);
    expect(townhouses.reading.status).toBe('complete');
    expectFields(townhouses.row, { unit_number: null, house_design: null });
  });

  it('takes nothing where the page states no street for the unit to be at', () => {
    const { row } = read(['Townhouse 28', 'LOT 12', 'Stoneleigh Rise Estate, Bungendore NSW 2621', 'Price $799,000']);
    expectFields(row, { unit_number: null, lot_number: '12' });
  });

  it('never overrules a unit the document already holds, and never stops it importing', () => {
    const labelled = read(['TOWNHOUSE 3', 'Unit: 5', STREET, PRICE]);
    expect(labelled.reading.status).toBe('complete');
    expectFields(labelled.row, { unit_number: '5' });
    const addressed = read(['TOWNHOUSE 3', '5/12 Kestrel Street, Box Hill NSW 2765', PRICE]);
    expect(addressed.reading.status).toBe('complete');
    expectFields(addressed.row, { unit_number: '5', address_line: '5/12 Kestrel Street' });
  });

  it('reads a design word as no unit, and a sentence as no heading', () => {
    // `Villa` and `Residence` name designs; neither is read as a unit.
    expectFields(read(['Villa 18', STREET, PRICE]).row, { unit_number: null });
    expectFields(read(['Residence 4', STREET, PRICE]).row, { unit_number: null });
    const sentence = read(['Unit 5 of 12 released now', STREET, PRICE]);
    expectFields(sentence.row, { unit_number: null });
  });
});

describe('a price, however it is headed and written', () => {
  const ID = ['LOT 12 Wattle Grove Road', 'Stoneleigh Rise Estate, Bungendore NSW 2621', 'Land Size 450m²'];
  const cases: Array<[string, number]> = [
    ['Total Package Price $799,000', 799000],
    ['Fixed Price $799,000', 799000],
    ['Fixed Price House & Land $829k', 829000],
    ['Fixed Price Package $799,000', 799000],
    ['Turnkey Package $1.15M', 1150000],
    ['Turnkey Price $799,000', 799000],
    ['Total Price $799k', 799000],
    ['Price $1.2M', 1200000],
    ['Price $799 000', 799000],
    ['Price $ 799,000', 799000],
    ['House and Land Package Price $799,000', 799000],
    ['House & Land Package $899,500', 899500],
    ['H&L Package $799,000', 799000],
    ['Land Price $350,000 House Price $449,000 Total $799,000', 799000],
    ['Land $350,000 | House $449,000 | Total $799,000', 799000],
    ['Land $350,000 + House $449,000 = $799,000', 799000],
    ['Price: $799,000 (inc. GST)', 799000],
    ['Price $812,000 inc GST', 812000],
    ['Price $812,000 incl. GST', 812000],
    ['Price $812,000 fixed', 812000],
  ];
  for (const [line, price] of cases) {
    it(`reads ${JSON.stringify(line)} as ${price}`, () => {
      const { reading, row } = read([...ID, line]);
      expect(reading.status).toBe('complete');
      expectFields(row, { price });
    });
  }

  it('reads the total of component prices set one to a line, and the components as nothing', () => {
    const { reading, row } = read([...ID, 'Land $350,000', 'House $449,000', 'Total $799,000']);
    expect(reading.status).toBe('complete');
    expectFields(row, { price: 799000, land_size_sqm: 450 });
  });

  it('never takes a component, a deposit or a sum that does not add up as the price', () => {
    for (const line of ['Land Price $350,000', 'House $449,000', 'Build Price - $402,900', 'Deposit $10,000',
      'Stamp Duty $31,000', 'Save $20,000', 'Land $350,000 + House $449,000 = $800,000', 'From $699,000']) {
      const { row } = read([...ID, line]);
      expect([line, row?.price ?? null]).toEqual([line, null]);
    }
  });
});

describe('the normaliser, which every source reaches the card through', () => {
  it('reads a multiplier by definition, on every source', () => {
    expect(coercePrice('$829k').price).toBe(829000);
    expect(coercePrice('$829K').price).toBe(829000);
    expect(coercePrice('$1.15M').price).toBe(1150000);
    expect(coercePrice('$1.2 million').price).toBe(1200000);
    expect(coercePrice('799k').price).toBe(799000);
    expect(normaliseStockRow({ lot_number: '1', price: '$950k' })!.price).toBe(950000);
  });

  it('reads a space as the thousands separator', () => {
    expect(coercePrice('$799 000').price).toBe(799000);
    expect(coercePrice('$1 250 000').price).toBe(1250000);
  });

  it('refuses a figure no property is sold for, rather than printing it', () => {
    expect(coercePrice('$799')).toEqual({ price: null, display: null });
    expect(coercePrice('0')).toEqual({ price: null, display: null });
    expect(coercePrice(799)).toEqual({ price: null, display: null });
    expect(coercePrice('$450m')).toEqual({ price: null, display: null });
  });

  it('reads every other price exactly as before', () => {
    expect(coercePrice('$749,000')).toEqual({ price: 749000, display: null });
    expect(coercePrice(749000)).toEqual({ price: 749000, display: null });
    expect(coercePrice('From $749,000')).toEqual({ price: 749000, display: 'From $749,000' });
    expect(coercePrice('POA')).toEqual({ price: null, display: 'POA' });
    // The first figure carries the multiplier or nothing does.
    expect(coercePrice('4 bed from $799k').price).toBeNull();
  });

  it('reads a count cell as a listing writes it', () => {
    const counts = (cell: string) => {
      const row = normaliseStockRow({ lot_number: '1', configuration: cell })!;
      return [row.bedrooms, row.bathrooms, row.car_spaces];
    };
    expect(counts('4 BR 2 BA 2 CAR')).toEqual([4, 2, 2]);
    expect(counts('4 x Bedrooms, 2 x Bathrooms, Double Garage')).toEqual([4, 2, 2]);
    expect(counts('3 Bed 2 Bath Single Garage')).toEqual([3, 2, 1]);
    expect(counts('4 Bed + Study 2 Bath 2 Living 2 Car')).toEqual([4, 2, 2]);
    // A car figure beside the garage's size is the count, and is not added to.
    expect(counts('4 Bed 2 Bath 2 Car Double Garage')).toEqual([4, 2, 2]);
    // Every shape it read before, unchanged.
    expect(counts('4 Bed 2 Bath 2 Car')).toEqual([4, 2, 2]);
    expect(counts('3 Bed 2 Bath 1 Car + 2 Bed 1 Bath 1 Car')).toEqual([5, 3, 2]);
    expect(counts('3 / 2 / 2')).toEqual([3, 2, 2]);
  });
});

describe('a count line that states rooms this product does not store', () => {
  const ID = ['LOT 12 Wattle Grove Road', 'Stoneleigh Rise Estate, Bungendore NSW 2621', ...TAIL];
  const cases: Array<[string, [number | null, number | null, number | null]]> = [
    ['4 BR 2 BA 2 CAR', [4, 2, 2]],
    ['4 Bed + Study | 2 Bath | 2 Living | Double Garage', [4, 2, 2]],
    ['4 Bed + Study 2 Bath 2 Car', [4, 2, 2]],
    ['4 Bedrooms, 2 Bathrooms, Double Garage', [4, 2, 2]],
    ['4 Bed 2 Bath 2 Living 2 Car', [4, 2, 2]],
    ['4 Bedrooms 2 Bathrooms 2 Living Areas 2 Car Garage', [4, 2, 2]],
    ['4 Bed 2 Bath 2 Car 1 Study', [4, 2, 2]],
    ['4 Bed 2 Bath 2 Car 450m² 220m²', [4, 2, 2]],
    ['4 x Bedrooms', [4, null, null]],
    ['Bedrooms x 4', [4, null, null]],
    ['4 Bedrooms + Study', [4, null, null]],
    ['4 Bedroom Home', [4, null, null]],
    ['3 Bedrooms | 2 Bathrooms | 2 Garage', [3, 2, 2]],
    ['4 Bedrooms, 2 Bathrooms, 2 Car Garage', [4, 2, 2]],
    // Label first with a singular: the singular states nothing, the rest is read.
    ['Bedrooms 4 Bathrooms 2 Garage 2', [4, 2, null]],
  ];
  for (const [line, want] of cases) {
    it(`reads ${JSON.stringify(line)}`, () => {
      const { reading, row } = read([...ID, line]);
      expect(reading.status).toBe('complete');
      expect([row?.bedrooms ?? null, row?.bathrooms ?? null, row?.car_spaces ?? null]).toEqual(want);
    });
  }
});

describe('sizes under other headings', () => {
  const ID = ['LOT 12 Wattle Grove Road', 'Stoneleigh Rise Estate, Bungendore NSW 2621', 'Price $799,000'];
  const cases: Array<[string, Row]> = [
    ['Allotment 512m²', { land_size_sqm: 512 }],
    ['Allotment Size: 512m²', { land_size_sqm: 512 }],
    ['Lot Area 450m2', { land_size_sqm: 450 }],
    ['450m² Lot', { land_size_sqm: 450 }],
    ['Land Size: approx. 450m²', { land_size_sqm: 450 }],
    ['Land Size approx. 450m²', { land_size_sqm: 450 }],
    ['Land Size 450m² (approx)', { land_size_sqm: 450 }],
    ['Land 512 sq.m', { land_size_sqm: 512 }],
    ['Dwelling Size 231m²', { building_size_sqm: 231 }],
    ['231m² Home', { building_size_sqm: 231 }],
    ['Land Size 450 m2.', { land_size_sqm: 450 }],
    ['Land Size: 450m² (12.5m x 36m)', { land_size_sqm: 450 }],
  ];
  for (const [line, want] of cases) {
    it(`reads ${JSON.stringify(line)}`, () => {
      const { reading, row } = read([...ID, line]);
      expect(reading.status).toBe('complete');
      expectFields(row, want);
    });
  }

  it('reads a frontage by a depth as no area at all, on every source', () => {
    // Two lengths state the block's shape, not its size — 12.5 m² was stored.
    for (const line of ['Land Size: 12.5m x 36m', 'Lot Size: 12.5 x 36', 'Block: 15m × 30m']) {
      const { reading, row } = read([...ID, line]);
      expect(reading.status).toBe('complete');
      expectFields(row, { land_size_sqm: null });
    }
    expect(acceptFieldValue('land_size_sqm', '12.5m x 36m'))
      .toEqual({ accepted: false, reason: 'a_measurement_is_not_a_count' });
    expect(normaliseStockRow({ lot_number: '1', land_size_sqm: '12.5m x 36m' })!.land_size_sqm).toBeNull();
    expect(normaliseStockRow({ lot_number: '1', land_size_sqm: '450m² (15m x 30m)' })!.land_size_sqm).toBe(450);
  });

  it('judges an area by the figure the normaliser will store', () => {
    expect(acceptFieldValue('land_size_sqm', 'approx. 450m²').accepted).toBe(true);
    // `numeric` once read `50000m2` as 500,002 and refused a real block.
    expect(acceptFieldValue('land_size_sqm', '50000m2').accepted).toBe(true);
    expect(acceptFieldValue('land_size_sqm', '0.5m2')).toEqual({ accepted: false, reason: 'area_out_of_range' });
  });
});

describe('a locality is never a design or an estate', () => {
  it('is refused at the gate, by name', () => {
    expect(acceptFieldValue('house_design', 'Clyde North VIC 3978'))
      .toEqual({ accepted: false, reason: 'a_locality_is_not_a_name' });
    expect(acceptFieldValue('development_name', 'Tarneit, VIC 3029'))
      .toEqual({ accepted: false, reason: 'a_locality_is_not_a_name' });
  });

  it('leaves every real name alone', () => {
    for (const name of ['Aspire 24 Grande', 'Nex 20', 'Tweed Heads NSW', 'Harlow 22 SA', 'Victoria 25']) {
      expect(acceptFieldValue('house_design', name).accepted).toBe(true);
    }
  });
});

describe('what must still read nothing', () => {
  const ID = ['LOT 12 Wattle Grove Road', 'Stoneleigh Rise Estate, Bungendore NSW 2621', ...TAIL];
  const base = read(ID).row!;
  const FIELDS = ['lot_number', 'address_line', 'suburb', 'state', 'postcode', 'development_name',
    'house_design', 'price', 'land_size_sqm', 'building_size_sqm', 'bedrooms', 'bathrooms', 'car_spaces'];
  const lines = [
    'Head Office: 12 Smith Street, Richmond VIC 3121', 'Display Home: 5 Grand Avenue, Clyde North VIC 3978',
    '12 Months Warranty Tarneit VIC 3029', '2 Storey Homes Clyde North VIC 3978', 'Call 1300 123 456',
    'Deposit $10,000', 'Land Price $350,000', 'Stamp Duty $31,000', 'Save $20,000', 'Rent $550 per week',
    'From $699,000', 'Land $350,000 + House $449,000 = $800,000', '4 bed from $799k',
    'Bed 3', 'Bath 2', 'Bed 4 Bath 2 Car 2', '2 Living', 'Double Storey', 'Double Garage',
    '4 bedroom homes from $600,000', '450m² 220m²', 'Frontage 16m', '450m² of living', 'Lots from 450m²',
    'Allotment 12', 'Stage 3', 'Release 4', 'Spring 2026', 'Titles expected Spring 2026',
    'Completion March 2027', 'The Hampton', 'Open 7 Days 10am - 5pm', 'Price subject to change',
    '$1.2M in savings on selected lots', 'House $449,000', 'Build Price - $402,900', 'Land $350,000',
    '4 Bed 1 Bath 1 Ensuite 2 Car',
  ];
  for (const line of lines) {
    it(`reads nothing from ${JSON.stringify(line)}, and it costs the brochure nothing`, () => {
      const { reading, row } = read([...ID, line]);
      expect(reading.status).toBe('complete');
      for (const field of FIELDS) expect([field, row?.[field] ?? null]).toEqual([field, base[field] ?? null]);
    });
  }

  it('reads nothing from a design line under a bare lot, and nothing from a bare name there either', () => {
    const { row } = read(['LOT 47', 'HARLOW', 'Land Size 450m²', 'Price $799,000']);
    expectFields(row, { lot_number: '47', suburb: null, house_design: null });
  });
});
