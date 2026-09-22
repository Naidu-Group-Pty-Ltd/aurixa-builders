/**
 * `Lot 37, Sandpiper Estate, Tweed Heads NSW` — THE ADDRESS THAT STOOD A
 * DOCUMENT DOWN FOR WANT OF FOUR DIGITS.
 *
 * The fixture below is the line set `Lot 37 - Miami 190 - Property
 * Package.pdf` recorded in its own row, verbatim, in the order the reader saw
 * them — including the letter-spaced headings the document is typeset in
 * (`L O T`, `B E D`, `B A T H`) and the standalone middle dots between them.
 *
 * Before this rule the document answered `unaccounted_specification_lines`
 * over that one address line, and the estate it imported was `PROPLAUNCH` —
 * a marketing platform's brand mark read off a caption — while the line
 * itself named `Sandpiper Estate`.
 */
import { describe, expect, it } from 'vitest';

import {
  readComposedAddressLine, readPdfBrochure,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

const LOT_37 = [
  'PROPLAUNCH', 'L O T', '3 7', '·', 'E S T A T E',
  'Lot 37, Sandpiper Estate, Tweed Heads NSW',
  'Four bedroom home, 190 m².', 'Fixed price. Fully turnkey.',
  'Miami 190, Spectral façade', '563 m² lot,', 'registering Q1 2027',
  'T O T A L', 'P A C K A G E', '·', 'L A N D', '+', 'B U I L D',
  'Build $547,407', 'Rental appraisal $1,250–$1,300 /wk', '$1,327,407',
  'T O T A L', 'H O M E', 'B E D', '/', 'B A T H', 'G A R A G E',
  '190 m²', '4 / 2', '2', 'Tweed Heads', 'Q1 2027', 'Miami 190', 'Spectral', 'NSW',
].join('\n');

const reading = () => readPdfBrochure([LOT_37], {
  filename: 'Lot 37 - Miami 190 - Property Package.pdf',
  organisationName: 'Luxton Homes',
});

describe('a composed address line whose locality carries no postcode', () => {
  it('is read, rather than standing the document down', () => {
    const r = reading();
    expect(r.status).toBe('complete');
    expect(r.unaccounted).toEqual([]);
  });

  it('names the estate the LINE named, not the one a caption did', () => {
    const row = (reading().rows ?? [])[0] ?? {};
    expect(row.development_name).toBe('Sandpiper Estate');
    expect(JSON.stringify(row)).not.toContain('PROPLAUNCH');
  });

  it('reads the lot, the suburb, the state and the design', () => {
    const row: Record<string, unknown> = (reading().rows ?? [])[0] ?? {};
    expect(row.lot_number).toBe('37');
    expect(row.suburb).toBe('Tweed Heads');
    expect(row.state).toBe('NSW');
    expect(row['house design']).toBe('Miami 190');
  });

  /*
   * THE NEGATIVES. The postcode is dispensable only INSIDE a composed line —
   * comma-separated, opening with a lot or a street — because that context is
   * what makes the final segment a locality. A bare line is untouched, and so
   * is a segment whose last token is not one of the eight states.
   */
  it('still requires a state from the closed set', () => {
    expect(readComposedAddressLine('Lot 37, Sandpiper Estate, Tweed Heads')).toBeNull();
    expect(readComposedAddressLine('Lot 37, Sandpiper Estate, Tweed Heads XYZ')).toBeNull();
  });

  it('leaves a postcode where the document states one', () => {
    const read = readComposedAddressLine('Lot 9 Perrin Street, Armstrong Creek VIC 3217');
    expect(read).toMatchObject({
      lot: '9', street: 'Perrin Street', suburb: 'Armstrong Creek',
      state: 'VIC', postcode: '3217',
    });
  });

  it('takes a middle segment as the estate only where it says it is one', () => {
    expect(readComposedAddressLine('Lot 12, Kestrel Way, Rockbank VIC 3335'))
      .toMatchObject({ street: 'Kestrel Way', development: null });
  });
});
