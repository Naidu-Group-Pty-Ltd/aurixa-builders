/**
 * ===========================================================================
 * A QUANTIFIER TURNS A THING INTO A MEASURE OF IT — AND NOTHING ELSE DOES.
 * ===========================================================================
 *
 * `TOTAL HOME` over `190 m²` is the building's floor area, and no alias table
 * has that heading. The repair that was refused was to add `total home` as a
 * synonym: the next brochure writes `OVERALL HOME`, the one after
 * `TOTAL BUILD AREA`, and each costs another line in a list about one
 * document. What they share is their GRAMMAR, so the grammar is what is
 * implemented — and the negatives below are what make it safe to.
 */
import { describe, expect, it } from 'vitest';

import {
  quantifiedFieldForLabel,
} from '../../../supabase/functions/_shared/builderStock/labelSemantics.pure';
import {
  fieldForHeader,
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  readPdfBrochure,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

// ---------------------------------------------------------------------------
// 1 · The class
// ---------------------------------------------------------------------------

describe('the quantified-measure class', () => {
  it('reads every spelling of the dwelling it was shown', () => {
    for (const label of [
      'TOTAL HOME', 'TOTAL HOME AREA', 'OVERALL HOME', 'TOTAL BUILDING AREA',
      'TOTAL BUILD AREA', 'OVERALL BUILDING AREA',
    ]) {
      expect(quantifiedFieldForLabel(label)).toBe('building_size_sqm');
    }
  });

  it('reads the ones nobody listed either', () => {
    // The point of a grammatical rule: these were never written down anywhere
    // and are the same sentence.
    for (const label of [
      'Total Dwelling', 'Combined Floor Area', 'Aggregate Internal Area',
      'Whole House m2', 'Entire Residence Size', 'Total Home M²',
      'gross building area',
    ]) {
      expect(quantifiedFieldForLabel(label)).toBe('building_size_sqm');
    }
    for (const label of ['Total Land Area', 'Overall Site Area', 'Total Block m2']) {
      expect(quantifiedFieldForLabel(label)).toBe('land_size_sqm');
    }
  });

  it('reaches every reader through the one label resolver', () => {
    // No second vocabulary: `fieldForHeader` is what the brochure reader, the
    // table reader and the CSV path all ask.
    expect(fieldForHeader('TOTAL HOME')).toBe('building_size_sqm');
    expect(fieldForHeader('Overall Building Area')).toBe('building_size_sqm');
  });

  it('never overrules an alias the table states explicitly', () => {
    // Asked LAST. `land size` is an alias and stays one, whatever shape it has.
    expect(fieldForHeader('Land Size')).toBe('land_size_sqm');
    expect(fieldForHeader('House')).toBe('house_design');
    expect(fieldForHeader('Building')).toBe('project_name');
  });
});

// ---------------------------------------------------------------------------
// 2 · The negatives, which are what make it safe
// ---------------------------------------------------------------------------

describe('what a quantifier does NOT do', () => {
  it('is not "strip the quantifier and look the noun up again"', () => {
    /*
     * THE VERSION THAT WAS REFUSED. Against this repository's own alias table
     * a naive strip reads
     *
     *     TOTAL HOUSE     → `house`    → house_design   ← the DESIGN
     *     TOTAL BUILDING  → `building` → project_name   ← the PROJECT
     *
     * Two wrong fields. A bare noun and a quantified one do not mean the same
     * thing, so the measurement is returned rather than the noun's meaning.
     */
    expect(quantifiedFieldForLabel('TOTAL HOUSE')).toBe('building_size_sqm');
    expect(quantifiedFieldForLabel('TOTAL BUILDING')).toBe('building_size_sqm');
    expect(fieldForHeader('TOTAL HOUSE')).not.toBe('house_design');
    expect(fieldForHeader('TOTAL BUILDING')).not.toBe('project_name');
  });

  it('names no field for a thing that has no extent', () => {
    expect(quantifiedFieldForLabel('TOTAL PACKAGE')).toBeNull();
    expect(quantifiedFieldForLabel('Total Price')).toBeNull();
    expect(quantifiedFieldForLabel('Overall Rating')).toBeNull();
  });

  it('refuses "the total area OF WHAT"', () => {
    expect(quantifiedFieldForLabel('TOTAL')).toBeNull();
    expect(quantifiedFieldForLabel('Total Area')).toBeNull();
    expect(quantifiedFieldForLabel('Total m2')).toBeNull();
  });

  it('refuses a heading over a SUM of two things', () => {
    // `LAND + BUILD` is a heading over an addition, and this product has no
    // field for it.
    expect(quantifiedFieldForLabel('TOTAL LAND AND BUILD')).toBeNull();
    expect(quantifiedFieldForLabel('Total Land + Build')).toBeNull();
  });

  it('refuses a money marker, because money is what that marker means', () => {
    expect(quantifiedFieldForLabel('TOTAL HOME $')).toBeNull();
    expect(quantifiedFieldForLabel('Total Build $')).toBeNull();
  });

  it('leaves the words another module measured and declined', () => {
    // `normalise.pure.ts` records that bare `living` means a living area on
    // some live sheets and a ROOM COUNT on others, and declined to guess.
    // This does not overturn another module's measured decision.
    expect(quantifiedFieldForLabel('Total Living')).toBeNull();
    // `lot` is this product's identifier; an unclear area is a wrong figure.
    expect(quantifiedFieldForLabel('Total Lot')).toBeNull();
  });

  it('is not a quantifier just because it is an adjective', () => {
    expect(quantifiedFieldForLabel('Ground Floor')).toBeNull();
    expect(quantifiedFieldForLabel('Upper Building')).toBeNull();
    expect(quantifiedFieldForLabel('Net Building Area')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3 · Through the real reader, on the two shapes that matter
// ---------------------------------------------------------------------------

describe('a quantified heading over a value, read end to end', () => {
  const brochure = (lines: string[]) => readPdfBrochure([lines.join('\n')]);
  const IDENTITY = [
    'Lot 37 Fairweather Drive',
    'Sandpiper Estate, Tweed Heads NSW 2485',
  ];

  it('establishes the building size from the area under it', () => {
    const reading = brochure([...IDENTITY, 'TOTAL HOME', '190 m²']);
    expect(reading.status).toBe('complete');
    const row = normaliseStockRow(reading.rows[0])!;
    expect(row.building_size_sqm).toBe(190);
  });

  it('establishes it inline too', () => {
    const row = normaliseStockRow(
      brochure([...IDENTITY, 'TOTAL BUILD AREA 190.38 m2']).rows[0])!;
    expect(row.building_size_sqm).toBe(190.38);
  });

  it('NEVER establishes an area from the package price', () => {
    /*
     * THE CASE THE WHOLE RULE IS BOUNDED BY, as the page sets it:
     *
     *     T O T A L  P A C K A G E  ·  L A N D  +  B U I L D  ·  I N C .  G S T
     *                                                             $547,407
     *
     * Two halves refuse it and both are needed. `package` is not a thing with
     * extent, so the quantified rule names nothing; `LAND` resolves through
     * the ordinary alias table exactly as it always has, and what refuses the
     * money is the typed gate. MONEY IS NEVER AN AREA.
     */
    const reading = brochure([
      ...IDENTITY,
      'TOTAL PACKAGE · LAND + BUILD · INC. GST',
      '$547,407',
    ]);
    const row = normaliseStockRow(reading.rows[0] ?? {});
    expect(row?.building_size_sqm ?? null).toBeNull();
    expect(row?.land_size_sqm ?? null).toBeNull();
    /*
     * And what it IS, since reader version 19: the page says in words that it
     * carries the package's price and prints exactly one sum of money nothing
     * else accounted for, so that sum is the price (`PACKAGE_PRICE_CAPTION`).
     * The only field it may ever reach is the price.
     */
    expect(row?.price).toBe(547407);
    const { price: _price, ...rest } = row ?? {};
    expect(JSON.stringify(rest)).not.toContain('547407');
  });

  it('declines the money by name rather than dropping it silently', () => {
    const reading = brochure([
      ...IDENTITY, 'TOTAL HOME', '$547,407',
    ]);
    expect(reading.diagnostics.declinedBecause ?? [])
      .toContain('building_size_sqm:money_is_not_an_area');
  });

  it('leaves a room dimension out of a quantified area', () => {
    const reading = brochure([...IDENTITY, 'TOTAL HOME', '3.6 x 3.2']);
    const row = normaliseStockRow(reading.rows[0] ?? {});
    expect(row?.building_size_sqm ?? null).toBeNull();
  });
});
