/**
 * A PAGE WHOSE TEXT IS NOT UPRIGHT IS READ AS ITS FLATTENED LINES.
 *
 * Measured 24 September 2026: a landscape brochure stored as a portrait page
 * with `/Rotate 90` draws its text turned a quarter. Taken as drawn, every line
 * shared one x and stepped along it, so the positioned layout put the whole
 * page on one row and the reader merged it into one cell with no spaces — and
 * read nothing from a page whose flattened text is perfect. The held-out
 * fixture `heldout-landscape-page-stored-rotated` proves the whole path; this
 * pins the one decision.
 */
import { describe, expect, it } from 'vitest';

import { mostlyUpright } from '../../../supabase/functions/_shared/builderStock/pdfTextLayout';

/** A pdf.js text item: the run and its transform `[a, b, c, d, x, y]`. */
const run = (str: string, a: number, b: number, c: number, d: number) =>
  ({ str, transform: [a, b, c, d, 40, 700] });

describe('whether a page’s text runs along it', () => {
  it('is upright for ordinary text, italic included', () => {
    expect(mostlyUpright([run('LOT 64 Currawong Street', 18, 0, 0, 18)])).toBe(true);
    // Italic is skew in the third term, and is not asked.
    expect(mostlyUpright([run('Home Design', 12, 0, 2.5, 12)])).toBe(true);
  });

  it('is not upright for text turned a quarter either way, or upside down', () => {
    expect(mostlyUpright([run('LOT 64 Currawong Street', 0, 18, -18, 0)])).toBe(false);
    expect(mostlyUpright([run('LOT 64 Currawong Street', 0, -18, 18, 0)])).toBe(false);
    expect(mostlyUpright([run('LOT 64 Currawong Street', -18, 0, 0, -18)])).toBe(false);
  });

  it('counts characters, so one sideways caption does not withhold an upright page', () => {
    expect(mostlyUpright([
      run('LOT 64 Currawong Street', 18, 0, 0, 18),
      run('Box Hill NSW 2765', 12, 0, 0, 12),
      run('Artist impression', 0, 8, -8, 0),
    ])).toBe(true);
    // And a turned page with one upright page number is still a turned page.
    expect(mostlyUpright([
      run('LOT 64 Currawong Street', 0, 18, -18, 0),
      run('Box Hill NSW 2765', 0, 12, -12, 0),
      run('1', 10, 0, 0, 10),
    ])).toBe(false);
  });

  it('keeps the layout of a page with no text, which the reader already handles', () => {
    expect(mostlyUpright([])).toBe(true);
    expect(mostlyUpright([run('   ', 0, 18, -18, 0)])).toBe(true);
  });
});
