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
// 1a. A price is not a measurement
// ---------------------------------------------------------------------------

describe('a labelled figure carrying money is not an area', () => {
  /*
   * THE DOCUMENT'S OWN ARITHMETIC IS THE EVIDENCE. `LOT 266 Crowlea Estate`
   * imported `price: 749,100` and `land_size_sqm: 334000` in the same
   * reading, through `labelled_numbers` — and $334,000 plus a $415,100 build
   * is exactly $749,100. A house and land package states its two halves, and
   * `LAND` is a label this vocabulary reads as an area.
   */
  const priced = readPdfBrochure([SPEC
    .replace('Land Size: 350 m2', 'LAND $334,000')
    .replace('Build Size: 180 m2', 'Build Size: $415,100')]);

  it('claims no area from a priced label', () => {
    const record = normaliseStockRow(priced.rows[0] ?? {});
    expect(record?.land_size_sqm ?? null).toBeNull();
    expect(record?.building_size_sqm ?? null).toBeNull();
  });

  it('DECLINES it by name rather than dropping it silently', () => {
    // An import log has to be able to say which statement was refused and
    // under which rule; a figure that simply vanishes is a second defect.
    expect(priced.diagnostics.declinedFields ?? [])
      .toEqual(expect.arrayContaining(['land_size_sqm', 'building_size_sqm']));
  });

  it('does not stand the document down over it', () => {
    // The rest of that brochure read perfectly, and a priced label is not a
    // vocabulary gap a model would close either.
    expect(priced.status).toBe('complete');
    expect(normaliseStockRow(priced.rows[0])!.price).toBe(863850);
  });

  it('leaves a real measurement alone, comma and all', () => {
    const measured = readPdfBrochure([SPEC.replace(
      'Land Size: 350 m2', 'Land Size: 1,204 m2')]);
    expect(normaliseStockRow(measured.rows[0])!.land_size_sqm).toBe(1204);
  });

  it('asks about the value the document printed, never the size of it', () => {
    /*
     * 334,000 with no currency marker is refused for being an implausible
     * AREA rather than for being money — two independent guards, because a
     * PDF can put the dollar sign in a text run of its own.
     *
     * RENEGOTIATED 22 SEPTEMBER 2026, and the previous assertion is worth
     * recording. It read `.not.toContain('land_size_sqm')`, because the
     * plausibility bound used to live in `normaliseStockRow` — so the reader
     * claimed the figure, the coercion nulled it downstream, and the import
     * log said nothing at all. Both guards now sit in `acceptFieldValue`, so
     * the statement is declined where it is made and the log can say which
     * of the two refused it. The measurement is still absent, which is the
     * property that matters and is asserted below unchanged.
     */
    const bare = readPdfBrochure([SPEC.replace('Land Size: 350 m2', 'LAND 334,000')]);
    expect(bare.diagnostics.declinedFields ?? []).toContain('land_size_sqm');
    expect(bare.diagnostics.declinedBecause ?? [])
      .toContain('land_size_sqm:area_out_of_range');
    // And NOT as money: the document printed no currency marker, so the
    // reason has to be about the magnitude and not about a dollar sign
    // nothing drew.
    expect(bare.diagnostics.declinedBecause ?? [])
      .not.toContain('land_size_sqm:money_is_not_an_area');
    expect(normaliseStockRow(bare.rows[0])!.land_size_sqm).toBeNull();
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
    /*
     * THE BOUND IS A CEILING ABOVE A WHOLE BROCHURE, NOT A WINDOW ONTO PART
     * OF ONE. At 80 it was a sample: `LOT 266 Crowlea Estate` left 359 lines
     * unnamed and the eighty that came back stopped mid-way through the
     * inclusions list, so the question the capture exists to answer was
     * answered for page one and cut off for the rest.
     */
    const noise = Array.from({ length: 900 }, (_, i) =>
      `${i} Crowlea Drive`).join('\n');
    const large = readPdfBrochure([`${SPEC}\n${noise}`]);
    expect(large.diagnostics.ignoredLines).toBeGreaterThan(400);
    expect(large.ignored.length).toBe(400);
    for (const line of large.ignored) expect(line.length).toBeLessThanOrEqual(120);
  });

  it('says where each line was drawn, aligned by index', () => {
    /*
     * A FLATTENED LINE CANNOT BE TOLD APART FROM A FLATTENED PAIR, and that
     * is the whole ambiguity: `Estate Warragul` is either one run naming
     * something or a label in one column beside its value in another, and
     * only the geometry says which.
     */
    expect(reading.placement).toHaveLength(reading.ignored.length);
    const at = reading.placement[reading.ignored.indexOf(UNLABELLED_ADDRESS)];
    expect(at).toMatch(/^p\d+ r\d+ x\d+$/);
  });

  it('keeps the placement free of document text', () => {
    // Numbers only. It rides the same internal channel as the lines, but
    // nothing about it needs to be a fragment of the page.
    for (const at of reading.placement) expect(at).toMatch(/^(p\d+ r\d+ x\d+)?$/);
  });

  it('carries the evidence out of a REFUSAL too', () => {
    // A refused document already reported its unaccounted lines; what it
    // placed and could not name is the other half of the same question, and
    // the assisted reader that picks the document up next is not the one who
    // has to fix this reader's vocabulary.
    //
    // The unread line was `Stage 12 Release 4` until reader 21, which
    // recognises a release designation as naming which release of an estate
    // this is and lets it cost a document nothing. A price stated two ways is
    // a statement no reader may settle, so it stands the document down instead.
    const refused = readPdfBrochure([
      `${SPEC}\nPrice $799,000 or $820,000\n${UNLABELLED_ADDRESS}`]);
    expect(refused.status).toBe('incomplete');
    expect(refused.unaccounted).toContain('Price $799,000 or $820,000');
    expect(refused.ignored).toContain(UNLABELLED_ADDRESS);
  });
});
