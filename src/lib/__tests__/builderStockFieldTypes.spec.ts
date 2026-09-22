/**
 * ===========================================================================
 * MONEY IS NOT AN AREA, AND AN AREA IS NOT A ROOM COUNT.
 * ===========================================================================
 *
 * `fieldTypes.pure.ts` is the one gate every claim passes through. A reader
 * decides a value BELONGS to a field — that is discovery, and it is the
 * reader's business. Whether what was found is the KIND of thing the field
 * holds is not, and it used to be answered in four places in the reader and in
 * three readers besides.
 *
 * The case this exists for is on the live document
 * `Lot 37 - Miami 190 - Property Package.pdf`:
 *
 *     T O T A L  P A C K A G E  ·  L A N D  +  B U I L D  ·  I N C .  G S T
 *     Build $547,407                                          $1,327,407
 *
 * Normalisation makes `LAND` and `BUILD` legible, correctly — they ARE those
 * words, and a vocabulary lookup then offers them as labels for the two area
 * fields. Nothing in the reader knows the figures beside them are money.
 */
import { describe, expect, it } from 'vitest';

import {
  acceptFieldValue,
  FIELD_KIND,
  readsAsACount,
} from '../../../supabase/functions/_shared/builderStock/fieldTypes.pure';

const reason = (field: string, value: string, proof?: 'label' | 'column') => {
  const verdict = acceptFieldValue(field, value, proof);
  return verdict.accepted ? null : verdict.reason;
};
const accepts = (field: string, value: string, proof?: 'label' | 'column') =>
  acceptFieldValue(field, value, proof).accepted;

// ---------------------------------------------------------------------------
// The four absolutes
// ---------------------------------------------------------------------------

describe('money never becomes an area', () => {
  it('refuses the package price under a LAND + BUILD heading', () => {
    expect(reason('land_size_sqm', '$1,327,407')).toBe('money_is_not_an_area');
    expect(reason('building_size_sqm', '$547,407')).toBe('money_is_not_an_area');
  });

  it('refuses it under a column heading too', () => {
    // A currency marker is a statement about what the number IS. No amount of
    // structure makes it false.
    expect(reason('land_size_sqm', '$334,000', 'column'))
      .toBe('money_is_not_an_area');
  });

  it('refuses a figure too large to be an area of anything', () => {
    // 334,000 with no marker at all: caught by the bound rather than by the
    // currency rule, which is the second of two independent guards.
    expect(reason('land_size_sqm', '334,000')).toBe('area_out_of_range');
  });

  it('leaves a real measurement alone, comma and all', () => {
    expect(accepts('land_size_sqm', '1,204 m2')).toBe(true);
    expect(accepts('land_size_sqm', '563 m²')).toBe(true);
    expect(accepts('building_size_sqm', '190.38 m²')).toBe(true);
  });
});

describe('an area never becomes an identifier', () => {
  it('refuses a floor-area schedule read as a unit number', () => {
    // `UNIT: 115.30m² 12.41sq` on the Lot 48 flyer. One wrong read made the
    // card's title `Unit 115.30m 12.41sq, 35 Cockrell Rd` and stopped any page
    // from stating the property's identity.
    expect(accepts('unit_number', '115.30m² 12.41sq')).toBe(false);
    expect(reason('lot_number', '350 m²')).toBe('an_area_is_not_a_designation');
  });

  it('refuses a price read as a lot', () => {
    expect(reason('lot_number', '$662,900')).toBe('money_is_not_a_designation');
  });

  it('takes the designations a builder actually writes', () => {
    for (const lot of ['37', '1037', '12A', '2/14', '266-268']) {
      expect(accepts('lot_number', lot)).toBe(true);
    }
  });
});

describe('a measurement never becomes a room count', () => {
  it('refuses the garage AREA under a car-spaces label', () => {
    // `Garage: 22.59m²`. Taken at face value that is a property with
    // twenty-two car spaces, written by a document that never said so.
    expect(reason('car_spaces', '22.59m²')).toBe('an_area_is_not_a_count');
    expect(reason('car_spaces', '22.59')).toBe('not_a_count');
  });

  it('refuses a room dimension', () => {
    expect(reason('bedrooms', '3.6 x 3.2')).toBe('a_measurement_is_not_a_count');
    expect(reason('bathrooms', '9 × 4')).toBe('a_measurement_is_not_a_count');
  });

  it('refuses a figure no dwelling has', () => {
    expect(reason('bedrooms', '99')).toBe('count_out_of_range');
  });

  it('takes a count, including the half a powder room is', () => {
    expect(accepts('bedrooms', '4')).toBe(true);
    expect(accepts('bathrooms', '2.5')).toBe(true);
    expect(accepts('car_spaces', '0')).toBe(true);
  });

  it('answers discovery with the same rule', () => {
    // The icon-row reader looks along a row for the units that could be
    // counts. That is finding evidence, and it must ask the same question.
    expect(readsAsACount('3')).toBe(true);
    expect(readsAsACount('22.59m²')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Price: absent is better than wrong
// ---------------------------------------------------------------------------

describe('a price says it is money, or the structure does', () => {
  it('takes what the document marked as money', () => {
    expect(accepts('price', '$1,327,407')).toBe(true);
    expect(accepts('price', 'AUD 863,850')).toBe(true);
  });

  it('refuses a bare figure beside a label', () => {
    // A label drawn near a value is weak evidence: `Total` sits over a floor
    // area on one brochure and over a package price on the next. A figure that
    // might be an area, a reference or a year must never become a price
    // because it was large. ABSENT IS BETTER THAN WRONG.
    expect(reason('price', '659,900')).toBe('no_currency_marker');
  });

  it('takes a bare figure under a proved column heading', () => {
    // A reconstructed schedule proves its grid: every data cell falls inside
    // exactly one of the header's columns and no two share one. A PRICE column
    // says its cells are prices.
    expect(accepts('price', '659,900', 'column')).toBe(true);
  });

  it('never takes a measurement as a price, however it was proved', () => {
    expect(reason('price', '350 m2', 'column')).toBe('money_is_not_an_area');
  });
});

// ---------------------------------------------------------------------------
// What it declines to have an opinion about
// ---------------------------------------------------------------------------

describe('the gate judges kinds, not content', () => {
  it('takes the names a builder writes', () => {
    for (const design of ['Miami 190', 'Nex 20', 'Enzo 8.5', 'Ember']) {
      expect(accepts('house_design', design)).toBe(true);
    }
    expect(accepts('development_name', 'Sandpiper Estate')).toBe(true);
    expect(accepts('address_line', 'Lot 37 Fairweather Drive')).toBe(true);
  });

  it('refuses a glyph in a value slot', () => {
    expect(reason('development_name', '·')).toBe('no_alphanumeric_content');
    expect(reason('house_design', '+')).toBe('no_alphanumeric_content');
  });

  it('holds a closed set for the two fields that have one', () => {
    expect(acceptFieldValue('state', 'nsw')).toEqual({ accepted: true, value: 'NSW' });
    expect(reason('state', 'XYZ')).toBe('not_a_state');
    expect(accepts('postcode', '3338')).toBe(true);
    expect(reason('postcode', '333')).toBe('not_a_postcode');
  });

  it('has no opinion about a field it does not name', () => {
    // Readers hold values this gate has nothing to say about — a description,
    // a status word. Inventing an opinion here would decline them all.
    expect(FIELD_KIND.description).toBeUndefined();
    expect(accepts('description', 'Fixed price. Fully turnkey.')).toBe(true);
  });

  it('names every stored field it does judge', () => {
    // A field missing from this map passes unjudged, which is the safe default
    // and a silent one. Pinned so adding a stored field is a decision.
    expect(Object.keys(FIELD_KIND).sort()).toEqual([
      'address_line', 'bathrooms', 'bedrooms', 'building_size_sqm', 'car_spaces',
      'development_name', 'expected_completion', 'external_reference',
      'house_design', 'land_size_sqm', 'lot_number', 'postcode', 'price',
      'project_name', 'state', 'suburb', 'unit_number',
    ]);
  });
});
