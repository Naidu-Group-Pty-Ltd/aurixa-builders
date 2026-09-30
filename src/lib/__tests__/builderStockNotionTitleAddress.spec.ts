import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseBuilderAddressLine, postcodeStatedBesidePlace,
} from '../../../supabase/functions/_shared/builderStockAddress.pure';
import { stockItemTitle, stockItemLocality, stockItemSuburb } from '../builderStock';

/**
 * MEASURED 30 SEPTEMBER 2026. Every row on the live Notion stock list (upload
 * 6c025d69, 41 rows) is titled `<address> · <design> [· <tag>]`, and the
 * parser did not know the dot: the network stored the whole tail as the
 * suburb — `Tweed Heads · Bravo 217 · Best Price` — on 41 of 41 rows, and a
 * card printed it as the locality. Every title below is copied verbatim from
 * `builder_stock_items.source_row->>'address_line'` on that upload.
 */
describe('a Notion title that separates its fields with a dot', () => {
  it('reads the address from the first field and the design from the next', () => {
    expect(parseBuilderAddressLine('Lot 52 Tweed Heads · Bravo 217 · Best Price')).toMatchObject({
      lotNumber: '52', suburb: 'Tweed Heads', state: null, postcode: null,
      streetName: null, designName: 'Bravo 217',
    });
    expect(parseBuilderAddressLine('Lot 60941 Kalkallo VIC · 3 Bed')).toMatchObject({
      lotNumber: '60941', suburb: 'Kalkallo', state: 'VIC', designName: '3 Bed',
    });
    expect(parseBuilderAddressLine('Unit 19 Thornton NSW · Industrial')).toMatchObject({
      unitNumber: '19', suburb: 'Thornton', state: 'NSW', designName: 'Industrial',
    });
    expect(parseBuilderAddressLine('Lot 104 Redbank Plains QLD · Chester 242 Dual-Key')).toMatchObject({
      lotNumber: '104', suburb: 'Redbank Plains', state: 'QLD', designName: 'Chester 242 Dual-Key',
    });
    expect(parseBuilderAddressLine('Lot 147 Clyde North VIC · Suri 28 Display Home')).toMatchObject({
      lotNumber: '147', suburb: 'Clyde North', state: 'VIC', designName: 'Suri 28 Display Home',
    });
  });

  it('reads a title with no lot as a place and its design', () => {
    expect(parseBuilderAddressLine('Deanside VIC · Mira 22 Display Home')).toMatchObject({
      lotNumber: null, suburb: 'Deanside', state: 'VIC', designName: 'Mira 22 Display Home',
    });
  });

  it('never leaves a dot-separated field inside the suburb', () => {
    const titles = [
      'Lot 52 Tweed Heads · Bravo 217 · Best Price',
      'Lot 43 Tweed Heads · Echo 255 · Best Yield',
      'Lot 1342 Lara VIC · Remi 20',
      'Lot 113 Millfield NSW · 180',
      'Lot 219 Beaudesert QLD · Dual-Key',
      'Lot 208 Donnybrook VIC · Navi 22 Display Home',
      'Lot 60416 Beveridge VIC · Ilya 15',
    ];
    for (const title of titles) {
      const parsed = parseBuilderAddressLine(title);
      expect(parsed.suburb, title).not.toMatch(/[·•]/);
      expect(parsed.suburb, title).not.toBeNull();
    }
  });

  it('keeps a dot INSIDE a bracket as part of the annotation', () => {
    // The same list's older titles, still carried by fixtures elsewhere.
    expect(parseBuilderAddressLine(
      'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [3 Bed · 140 m²]',
    )).toMatchObject({
      lotNumber: '60941', estate: 'Cloverton Estate', suburb: 'Kalkallo',
      state: 'VIC', postcode: '3064', designName: '3 Bed · 140 m²',
    });
  });

  it('takes the field that says it is an address, wherever it sits', () => {
    expect(parseBuilderAddressLine('Bravo 217 · Lot 52 Tweed Heads')).toMatchObject({
      lotNumber: '52', suburb: 'Tweed Heads', designName: 'Bravo 217',
    });
  });

  it('never takes a design or a tag for the address on a weaker signal', () => {
    // A four-digit design number is not a postcode, and `Act Now` is not the ACT.
    expect(parseBuilderAddressLine('Tweed Heads · Aura 1780')).toMatchObject({
      suburb: 'Tweed Heads', designName: 'Aura 1780',
    });
    expect(parseBuilderAddressLine('Tweed Heads · Bravo 217 · Act Now')).toMatchObject({
      suburb: 'Tweed Heads', designName: 'Bravo 217',
    });
    expect(parseBuilderAddressLine('Aura 1780 · Lot 5 Clyde VIC')).toMatchObject({
      lotNumber: '5', suburb: 'Clyde', state: 'VIC', designName: 'Aura 1780',
    });
  });

  it('reads a bullet the same way, and a dot with no space around it as text', () => {
    expect(parseBuilderAddressLine('Lot 7 Clyde VIC • Aura 19')).toMatchObject({
      lotNumber: '7', suburb: 'Clyde', state: 'VIC', designName: 'Aura 19',
    });
    expect(parseBuilderAddressLine('Lot 7 Clyde·North VIC').suburb).toBe('Clyde·North');
  });

  it('prefers a bracketed design on the address over the next field', () => {
    expect(parseBuilderAddressLine('Lot 5 - Smith Street, Clyde VIC 3978 [Aura 19] · Best Price'))
      .toMatchObject({ lotNumber: '5', streetName: 'Smith', suburb: 'Clyde', designName: 'Aura 19' });
  });

  it('leaves a line without the separator exactly as it was read before', () => {
    expect(parseBuilderAddressLine('Lot 209 - 44 Satinwood Crescent Donnybrook VIC')).toMatchObject({
      lotNumber: '209', streetNumber: '44', streetName: 'Satinwood', streetType: 'Crescent',
      suburb: 'Donnybrook', state: 'VIC', designName: null,
    });
  });
});

describe('the card a Notion row draws', () => {
  const row = {
    unit_number: null, lot_number: null, development_name: 'Sandpiper Estate Tweed Heads South NSW',
    project_name: null, external_reference: null, building_size_sqm: 217, house_design: null,
    address_line: 'Lot 52 Tweed Heads · Bravo 217 · Best Price',
  };

  it('leads with the lot and names the design, without the tag or the suburb again', () => {
    expect(stockItemTitle(row)).toBe('Lot 52 · Bravo 217');
    expect(stockItemTitle({ ...row, address_line: 'Unit 19 Thornton NSW · Industrial' }))
      .toBe('Unit 19 · Industrial');
    expect(stockItemTitle({ ...row, address_line: 'Deanside VIC · Mira 22 Display Home' }))
      .toBe('Mira 22 Display Home');
    // Two packages on one lot stay two different titles.
    expect(stockItemTitle({ ...row, address_line: 'Lot 43 Tweed Heads · Echo 236 · Best Price' }))
      .not.toBe(stockItemTitle({ ...row, address_line: 'Lot 43 Tweed Heads · Echo 255 · Best Yield' }));
    // A configuration is restated as the home size, as for a bracketed one.
    expect(stockItemTitle({ ...row, address_line: 'Lot 60941 Kalkallo VIC · 3 Bed', building_size_sqm: 140 }))
      .toBe('Lot 60941 · 140 m\u00b2 home');
  });

  it('keeps a street the address field names', () => {
    expect(stockItemTitle({ ...row, address_line: 'Lot 5 - 12 Smith Street, Clyde VIC · Aura 19' }))
      .toBe('Lot 5, 12 Smith Street · Aura 19');
  });

  it('titles a line without the separator exactly as before', () => {
    expect(stockItemTitle({
      ...row, address_line: 'Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]',
    })).toBe('Lot 36, Tringa Street · Stradbroke 180');
  });

  it('prints a locality that is a place', () => {
    const parsed = parseBuilderAddressLine(row.address_line);
    expect(stockItemLocality({ suburb: parsed.suburb, state: 'NSW', postcode: null })).toBe('Tweed Heads NSW');
  });

  it('prints a place from a row the old parse stored, before any re-read corrects it', () => {
    // Verbatim from the 19 live rows on 30 Sep 2026.
    expect(stockItemLocality({ suburb: 'Tweed Heads · Bravo 217 · Best Price', state: 'NSW', postcode: null }))
      .toBe('Tweed Heads NSW');
    expect(stockItemLocality({ suburb: 'Kalkallo · 3 Bed', state: 'VIC', postcode: null })).toBe('Kalkallo VIC');
    expect(stockItemSuburb('Clyde North · Suri 28 Display Home')).toBe('Clyde North');
    expect(stockItemSuburb('Redbank Plains • Chester 242 Dual-Key')).toBe('Redbank Plains');
  });

  it('leaves every real suburb exactly as stored', () => {
    for (const suburb of ['Tweed Heads South', 'ARMSTRONG CREEK', 'Wyndhamvale', 'Clyde·North']) {
      expect(stockItemSuburb(suburb)).toBe(suburb);
    }
    expect(stockItemSuburb(null)).toBeNull();
    expect(stockItemSuburb('   ')).toBeNull();
  });
});

describe('postcodeStatedBesidePlace', () => {
  it('takes the postcode the estate states beside the same suburb', () => {
    expect(postcodeStatedBesidePlace('Cloverton Estate Kalkallo VIC 3064 - Stocklands',
      { suburb: 'Kalkallo', state: 'VIC' })).toBe('3064');
    expect(postcodeStatedBesidePlace('Coridale Estate, Lara 3212 VIC',
      { suburb: 'Lara', state: 'VIC' })).toBe('3212');
  });

  it('refuses a postcode that belongs to a longer suburb', () => {
    expect(postcodeStatedBesidePlace('Sandpiper Estate Tweed Heads South NSW 2486',
      { suburb: 'Tweed Heads', state: 'NSW' })).toBeNull();
  });

  it('refuses a postcode the text does not set beside the suburb', () => {
    expect(postcodeStatedBesidePlace('Thornton Industrial - 5 Kestrel Ave NSW 2322',
      { suburb: 'Thornton', state: 'NSW' })).toBeNull();
  });

  it('refuses another state, a second number, and a missing place', () => {
    expect(postcodeStatedBesidePlace('Kalkallo NSW 3064', { suburb: 'Kalkallo', state: 'VIC' })).toBeNull();
    expect(postcodeStatedBesidePlace('Stage 2026, Kalkallo VIC 3064',
      { suburb: 'Kalkallo', state: 'VIC' })).toBeNull();
    expect(postcodeStatedBesidePlace('Cloverton Estate Kalkallo VIC 3064', { suburb: null, state: 'VIC' })).toBeNull();
    expect(postcodeStatedBesidePlace('Cloverton Estate Kalkallo VIC 3064', { suburb: 'Kalkallo', state: null })).toBeNull();
    expect(postcodeStatedBesidePlace(null, { suburb: 'Kalkallo', state: 'VIC' })).toBeNull();
  });

  it('is the fallback the importer writes, after anything the row stated itself', () => {
    const importer = readFileSync(path.resolve(__dirname,
      '../../../supabase/functions/_shared/builderStock/importStock.ts'), 'utf8');
    const patch = importer.slice(importer.indexOf('function writablePatch('),
      importer.indexOf('async function buildInventoryIndex('));
    expect(patch).toMatch(/record\.postcode \?\? coercePostcode\(place\.postcode\)\s*\?\? postcodeStatedBesidePlace\(record\.development_name/);
  });
});
