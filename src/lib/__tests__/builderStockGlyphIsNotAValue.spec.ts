/**
 * A BULLET IS NOT AN ESTATE — THE LOT 37 REFUSAL, REPRODUCED.
 *
 * `Lot 37 - Miami 190 - Property Package.pdf` is the one live upload in this
 * deployment and the document this incident is about. It spent a day reported
 * as an unreadable brochure, then as a model account with no credit
 * (`openrouter/openai/gpt-5.6-luna: refused 402` over 3,962 characters of
 * cleanly extracted text), and once the model left the path and refusals
 * started carrying their own evidence, its row finally said what the reader
 * actually saw:
 *
 *     conflicting_values:development_name
 *     development_name = ·
 *     development_name = PROPLAUNCH
 *
 * The document does not name two estates. One of the two is a BULLET GLYPH.
 *
 * The fixtures below are that pair and nothing else: a page that states its
 * lot, its design and its land size — everything the row recorded as
 * `fields_read` — beside a bullet where a layout puts one.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

const page = (...lines: string[]) => lines.join('\n');

/**
 * The shape the production row recorded: TWO development_name claims, one of
 * them a glyph. The first version of this fixture set `PROPLAUNCH` as a bare
 * heading, which is not a claim at all — so only the dot was claimed, there
 * was no conflict, and four of these five tests passed with the fix removed.
 * A fixture that does not reproduce the defect pins nothing.
 */
const LOT_37 = [
  page(
    'Estate: PROPLAUNCH',
    'Lot 37',
    'Home Design: Miami 190',
    'Land Size: 350m2',
  ),
  page(
    'Estate: ·',
    'Lot 37',
  ),
];

describe('a value made entirely of punctuation', () => {
  it('does not stand a brochure down as a second estate', () => {
    const reading = readPdfBrochure(LOT_37, {});
    expect(reading.reason).not.toBe('conflicting_values:development_name');
    expect(reading.status).not.toBe('ambiguous');
  });

  it('is never published as the estate', () => {
    const reading = readPdfBrochure(LOT_37, {});
    // Asserted FIRST, because a document that refuses publishes nothing and
    // "no row carries a glyph" is vacuously true of no rows.
    expect((reading.rows ?? []).length).toBeGreaterThan(0);
    for (const row of reading.rows ?? []) {
      for (const value of Object.values(row)) {
        expect(String(value ?? '')).toMatch(/[\p{L}\p{N}]/u);
      }
    }
  });

  it('still reads everything the document does state', () => {
    const reading = readPdfBrochure(LOT_37, {});
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.fieldsRead).toEqual(
      expect.arrayContaining(['lot_number', 'house_design', 'land_size_sqm']));
  });

  /*
   * THE NEGATIVE, AND IT IS THE ONE THAT MATTERS. The rule is alphanumeric
   * rather than alphabetic on purpose: a lot number is legitimately `12` and a
   * postcode is legitimately `3338`, and a rule written as "must contain a
   * letter" would silently delete both.
   */
  it('leaves a value that is only digits exactly as it is', () => {
    const reading = readPdfBrochure([
      page('Lot 12', 'Home Design: Vista 22', 'Suburb: Tarneit',
           'State: VIC', 'Postcode: 3029', 'Land Size: 350m2'),
    ], {});
    const row = (reading.rows ?? [])[0] ?? {};
    expect(JSON.stringify(row)).toContain('3029');
    expect(JSON.stringify(row)).toContain('12');
  });

  it('leaves a real estate name alone', () => {
    const reading = readPdfBrochure([
      page('Lot 12', 'Estate: Northbrook Rise', 'Home Design: Vista 22',
           'Suburb: Tarneit', 'State: VIC', 'Land Size: 350m2'),
    ], {});
    expect(JSON.stringify(reading.rows ?? [])).toContain('Northbrook Rise');
  });
});
