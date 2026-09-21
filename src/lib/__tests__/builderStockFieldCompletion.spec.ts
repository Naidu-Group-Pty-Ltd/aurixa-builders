/**
 * THE GAPS GO TO THE MODEL, NOT THE DOCUMENT.
 *
 * MEASURED 21 SEPTEMBER 2026 over every property this deployment holds:
 *
 *   brochure          addr  price  beds  baths  cars  home  land
 *   LOT 805 NEX 20     Y     -      -     -      -     Y     -
 *   LOT 309 NEX 20     Y     -      -     -      -     Y     -
 *   LOT 717 ENZO       Y     Y      -     -      -     Y     -
 *   LOT 315 ENZO       Y     Y      -     -      -     Y     Y
 *   LOT 36  ZIMI       -     Y      Y     Y      Y     Y     Y
 *   LOT 40  ZIMI       -     Y      -     -      -     Y     Y
 *
 * Bedrooms, bathrooms and car spaces absent on SEVEN OF EIGHT, and the gaps
 * disagreeing between families — the NEX 20 with an address and no price, the
 * ZIMI with a price and no address. Card beside card on the marketplace, that
 * is the inconsistency a reader sees first.
 *
 * It is not a vocabulary gap: the brochure prints `3 2.5 1` beside bed, bath
 * and car ICONS, and an icon is an image, so the text says which numbers the
 * property has and never which is which. Assuming the order wrote
 * `bathrooms: 9` onto a real property that same morning.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPLETABLE_FIELDS,
  completionMayMerge,
  completionWorthAsking,
  mergeCompletion,
  missingVitalFields,
  NEVER_COMPLETED_FIELDS,
  VITAL_FIELDS,
} from '../../../supabase/functions/_shared/builderStock/stockFieldCompletion.pure.ts';

/** The production reading of LOT 805, verbatim from `source_row`. */
const LOT_805: Record<string, unknown> = {
  price: null, state: 'VIC', suburb: 'TARNEIT', bedrooms: null, postcode: '3029',
  bathrooms: null, car_spaces: null, lot_number: '805', address_line: 'Lot 805 DAYLILLY ROAD',
  house_design: 'NEX 20', land_size_sqm: null, development_name: 'Harlow Estate',
  building_size_sqm: 182.78, expected_completion: 'Q3, 2026',
};

/** And of LOT 36, whose gaps are the other way round. */
const LOT_36: Record<string, unknown> = {
  price: 730000, bedrooms: 3, bathrooms: 2.5, car_spaces: 1, lot_number: '36',
  address_line: null, building_size_sqm: 153, land_size_sqm: 174,
};

describe('what counts as incomplete', () => {
  it('names exactly what LOT 805 could not fill', () => {
    expect(missingVitalFields(LOT_805).sort())
      .toEqual(['bathrooms', 'bedrooms', 'car_spaces', 'land_size_sqm', 'price']);
  });

  it('names exactly what LOT 36 could not fill', () => {
    // The other family's gap, and the reason one rule has to serve both.
    expect(missingVitalFields(LOT_36)).toEqual(['address_line']);
  });

  it('asks for nothing on a record that draws a full card', () => {
    const full = { ...LOT_805, price: 730000, bedrooms: 4, bathrooms: 2,
      car_spaces: 2, land_size_sqm: 350 };
    expect(missingVitalFields(full)).toEqual([]);
    expect(completionWorthAsking(full)).toBe(false);
  });

  it('treats an empty string as absent, not as a value', () => {
    expect(missingVitalFields({ ...LOT_36, address_line: '   ' }))
      .toContain('address_line');
  });

  it('treats a real zero as held', () => {
    // A property with no car space states none, and `absent is never zero`
    // cuts both ways: a stated zero is a fact and must not be re-asked.
    expect(missingVitalFields({ ...LOT_36, address_line: 'x', car_spaces: 0 }))
      .toEqual([]);
  });
});

describe('a completion may only ever fill an absence', () => {
  /*
   * THE LOAD-BEARING GUARANTEE. The deterministic reader saw the label; the
   * model did not. There is no branch that replaces a held value, which makes
   * "the reader is the authority" a property of the function rather than a
   * promise about its callers.
   */
  it('fills what the reader could not prove', () => {
    const { row, completed } = mergeCompletion(LOT_805, {
      price: 815000, bedrooms: 4, bathrooms: 2, car_spaces: 2, land_size_sqm: 350,
    });
    expect(completed).toEqual(['bathrooms', 'bedrooms', 'car_spaces', 'land_size_sqm', 'price']);
    expect(row.bedrooms).toBe(4);
    expect(row.price).toBe(815000);
  });

  it('never writes over a figure the reader read', () => {
    const { row, completed } = mergeCompletion(LOT_805, {
      building_size_sqm: 999, address_line: 'SOMEWHERE ELSE',
    });
    expect(row.building_size_sqm).toBe(182.78);
    expect(row.address_line).toBe('Lot 805 DAYLILLY ROAD');
    expect(completed).toEqual([]);
  });

  it('never supplies identity, however the model answers', () => {
    // A model supplying a lot, a unit, a reference, an estate or a design
    // could merge two properties or split one in half on re-import: those
    // are what a row is MATCHED by. So the base is stripped of every one of
    // them and the model offers all of them.
    const stripped: Record<string, unknown> = { ...LOT_805 };
    for (const field of NEVER_COMPLETED_FIELDS) stripped[field] = null;

    const offered: Record<string, unknown> = {
      lot_number: '999', unit_number: '7', external_reference: 'REF-1',
      development_name: 'Invented Estate', house_design: 'FAKE 1',
      suburb: 'NOWHERE', state: 'NSW', postcode: '2000',
    };
    const { row, completed } = mergeCompletion(stripped, offered);

    for (const field of NEVER_COMPLETED_FIELDS) {
      expect(row[field], `${field} was supplied by a model`).toBeNull();
      expect(completed, `${field} was reported as completed`).not.toContain(field);
    }
    expect(completed).toEqual([]);
  });

  it('the two lists cannot overlap', () => {
    for (const field of COMPLETABLE_FIELDS) {
      expect(NEVER_COMPLETED_FIELDS).not.toContain(field);
    }
  });

  it('every completable field is one a card draws', () => {
    // Spending a model call on a column nothing renders is spend with no
    // visible return.
    for (const field of COMPLETABLE_FIELDS) expect(VITAL_FIELDS).toContain(field);
  });

  it('ignores a completion that holds nothing', () => {
    expect(mergeCompletion(LOT_805, null).completed).toEqual([]);
    expect(mergeCompletion(LOT_805, {}).completed).toEqual([]);
    expect(mergeCompletion(LOT_805, { bedrooms: null, price: '' }).completed).toEqual([]);
  });

  it('leaves the base untouched as an object', () => {
    const before = JSON.stringify(LOT_805);
    mergeCompletion(LOT_805, { bedrooms: 4 });
    expect(JSON.stringify(LOT_805)).toBe(before);
  });
});

describe('one property on both sides, or no merge', () => {
  /*
   * There is no key to pair rows by — the model is not given the lot and must
   * not be — so pairing by position is how a price lands on the wrong lot.
   */
  it('merges one against one', () => {
    expect(completionMayMerge([{}], [{}])).toBe(true);
  });

  it('refuses a schedule on either side', () => {
    expect(completionMayMerge([{}, {}], [{}])).toBe(false);
    expect(completionMayMerge([{}], [{}, {}])).toBe(false);
    expect(completionMayMerge([], [{}])).toBe(false);
    expect(completionMayMerge([{}], [])).toBe(false);
  });
});

describe('the import wires it as the last resort, and it cannot fail an import', () => {
  const run = readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock/runImport.ts'), 'utf8');
  const block = run.slice(
    run.indexOf('WHAT THE READER COULD NOT PROVE IS ASKED FOR BY NAME'),
    run.indexOf("status: 'imported',"));

  it('runs only after a deterministic reading exists', () => {
    // Not a second attempt at the document: a reading with no rows takes the
    // existing assisted path above this, unchanged.
    expect(block).toMatch(/rows\.length === 1 && completionWorthAsking\(rows\[0\]\)/);
  });

  it('is wrapped, so no failure of it reaches the builder', () => {
    expect(block).toContain('} catch (error) {');
    expect(block).not.toMatch(/return \{\s*\n\s*ok: false/);
  });

  it('spends the same metered budget as every other model call', () => {
    // A vendor call outside the ceiling is a ceiling nobody set.
    expect(block).toContain('budget');
  });

  it('records which fields were completed', () => {
    expect(block).toContain('completedFields = merged.completed');
    expect(run).toContain('completedFields');
  });

  it('marks the strategy, so a completed record is never a read one', () => {
    expect(block).toContain("+completed");
  });
});
