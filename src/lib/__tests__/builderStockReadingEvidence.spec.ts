/**
 * THREE DEFECTS FROM ONE PRODUCTION IMPORT, 21 SEPTEMBER 2026.
 *
 * `LOT 266 Crowlea Estate - CURA 20B TEMPIO B` and `LOT 324 - NEX 20` are the
 * two documents behind everything in this file. Between them a client's
 * marketplace card drew a land size of `334,000 m²`, an estate called
 * `(Watsons Reach Estate)` with the brackets in it, and a property whose
 * address, suburb, state, estate and design were all empty beside a
 * diagnostic that said only `359 ignored lines`.
 *
 * The third is the one that matters most, and it is not a reading rule. A
 * field that does not populate is answerable in exactly one way — what did
 * the document say, and what did the reader make of it — and this deployment
 * could answer neither, because the only thing it kept about the rest of the
 * page was how many lines there were. Every gap so far has had to be guessed
 * at, or reproduced from a file nobody here can reach.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const SPEC = 'Lot: 266\n'
  + 'Estate: Crowlea Estate\n'
  + 'Design: Cura 20B Tempio B\n'
  + 'Land Size: 350 m2\n'
  + 'Build Size: 180 m2\n'
  + 'Bedrooms: 4\n'
  + 'Bathrooms: 2\n'
  + 'Car Spaces: 2\n'
  + 'Price: $863,850';

// ---------------------------------------------------------------------------
// 1. A measurement three orders of magnitude out is not a measurement
// ---------------------------------------------------------------------------

describe('a stock item measures what a stock item can measure', () => {
  const rowWith = (header: string, value: string) =>
    normaliseStockRow({ lot_number: '266', [header]: value });

  it('refuses the production figure that printed 334,000 m² on a card', () => {
    // The observed defect, verbatim. `coerceNumber` strips the comma as a
    // thousands separator, so whatever the brochure meant by it, what
    // reached the column was thirty-three hectares.
    expect(rowWith('land_size_sqm', '334,000')!.land_size_sqm).toBeNull();
  });

  it('refuses it for the reason, not the digits — 100,000 m² goes too', () => {
    // The point of the bound is the misplaced decimal, so it cannot be a
    // bound that happens to sit just under one observation.
    expect(rowWith('land_size_sqm', '100000')!.land_size_sqm).toBeNull();
  });

  it('keeps every land size a house and land package actually has', () => {
    // Measured across this deployment's own stock: 143, 180, 182.78. The
    // acreage end of a builder's estate is a couple of thousand.
    for (const stated of ['143', '182.78', '350', '4000']) {
      expect(rowWith('land_size_sqm', stated)!.land_size_sqm).toBe(Number(stated));
    }
  });

  it('bounds a DWELLING separately and far tighter than a lot', () => {
    // A 4,000 m² block is an acreage lot; a 4,000 m² dwelling is a unit
    // error. One ceiling for both fields could only have been the looser one.
    expect(rowWith('building_size_sqm', '4000')!.building_size_sqm).toBeNull();
    expect(rowWith('building_size_sqm', '380')!.building_size_sqm).toBe(380);
  });

  it('answers ABSENT rather than clamped, because absent is correctable', () => {
    // A clamped figure is published as fact and nothing reports it. A null
    // renders as not stated, which the card already draws and which the
    // builder can correct from their schedule.
    const row = rowWith('land_size_sqm', '334,000')!;
    expect(row.land_size_sqm).toBeNull();
    expect(row.land_size_sqm).not.toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// 2. A name the document put in brackets is still the name
// ---------------------------------------------------------------------------

describe('a bracketed name is read without its brackets', () => {
  it('strips a balanced pair the document used as punctuation', () => {
    const reading = readPdfBrochure([SPEC.replace(
      'Estate: Crowlea Estate', 'Estate: (Watsons Reach Estate)')]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.development_name)
      .toBe('Watsons Reach Estate');
  });

  it('leaves a HALF pair exactly as read, because half a pair is a cut name', () => {
    const reading = readPdfBrochure([SPEC.replace(
      'Estate: Crowlea Estate', 'Estate: (Watsons Reach Estate')]);
    expect(reading.status).toBe('complete');
    // Removing the survivor would hide that this reader lost the other half
    // somewhere, which is a worse failure than a stray bracket on a card.
    expect(normaliseStockRow(reading.rows[0])!.development_name)
      .toBe('(Watsons Reach Estate');
  });

  it('leaves a name whose brackets are its own content alone', () => {
    const reading = readPdfBrochure([SPEC.replace(
      'Design: Cura 20B Tempio B', 'Design: (Cura 20B (B) Tempio)')]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.house_design)
      .toBe('(Cura 20B (B) Tempio)');
  });
});

// ---------------------------------------------------------------------------
// 3. What the document said that became no field
// ---------------------------------------------------------------------------

describe('a reading keeps what it attributed to nothing', () => {
  /*
   * AND THIS IS THE PRODUCTION CASE, NOT AN INVENTED ONE. A brochure that
   * prints its street address with no label in front of it is a line this
   * reader places and cannot name — so it lands here, and until now the only
   * thing recorded about it was that the count went up by one. That is
   * precisely how `LOT 266 Crowlea Estate` came to import with no address
   * beside a diagnostic reading `359 ignored lines`.
   */
  const UNLABELLED_ADDRESS = '12 Crowlea Drive';
  const reading = readPdfBrochure([`${SPEC}\n${UNLABELLED_ADDRESS}`]);

  it('still completes — retaining evidence changes no verdict', () => {
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.rows).toHaveLength(1);
  });

  it('carries the line it could not name, verbatim', () => {
    // This is the whole point. A count says a line existed; the line says
    // whether a missing address is a vocabulary gap or a document with none.
    expect(reading.ignored).toContain(UNLABELLED_ADDRESS);
  });

  it('agrees with its own count', () => {
    expect(reading.ignored.length).toBe(reading.diagnostics.ignoredLines);
  });

  it('keeps document text OUT of `diagnostics`, which is logged', () => {
    // The contract on that object is that it is safe to write to the import
    // log. Serialising the whole of it must never contain a line the
    // document printed — a builder's price is not ours to put in a log line.
    expect(JSON.stringify(reading.diagnostics)).not.toContain(UNLABELLED_ADDRESS);
    expect(JSON.stringify(reading.diagnostics)).not.toContain('863,850');
  });

  it('bounds itself — a diagnosis, never a copy of the document', () => {
    const noise = Array.from({ length: 400 }, (_, i) =>
      `${i} Crowlea Drive`).join('\n');
    const large = readPdfBrochure([`${SPEC}\n${noise}`]);
    expect(large.diagnostics.ignoredLines).toBeGreaterThan(80);
    expect(large.ignored.length).toBe(80);
    for (const line of large.ignored) expect(line.length).toBeLessThanOrEqual(120);
  });

  it('carries the evidence out of a REFUSAL too', () => {
    // A refused document already reported its unaccounted lines; what it
    // placed and could not name is the other half of the same question, and
    // the assisted reader that picks the document up next is not the one who
    // has to fix this reader's vocabulary.
    const refused = readPdfBrochure([
      `${SPEC}\nStage 12 Release 4\n${UNLABELLED_ADDRESS}`]);
    expect(refused.status).toBe('incomplete');
    expect(refused.unaccounted).toContain('Stage 12 Release 4');
    expect(refused.ignored).toContain(UNLABELLED_ADDRESS);
  });
});
