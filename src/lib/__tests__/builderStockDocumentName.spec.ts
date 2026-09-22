/**
 * ===========================================================================
 * A HOSTNAME IS NOT A DOCUMENT NAME.
 * ===========================================================================
 *
 * The deterministic reader treats the name it is handed as EVIDENCE:
 * `corroborateDesignFromFilename` settles which field an unplaced page line
 * belongs to when every word of that line also appears in the name. Two
 * independent statements agreeing.
 *
 * It was being handed `upload.original_filename`, which the two transports
 * mean different things by. Measured 22 September 2026 by calling the
 * corroborator with one unplaced page line and three names for one document:
 *
 *   `LOT 37 - HAVENWOOD 21 - PACKAGE.pdf`      → house_design "Havenwood 21"
 *   `alphahomes.com.au/…/LOT 37 - HAVENWOOD…`  → house_design "Havenwood 21"
 *   `alphahomes.com.au/download`               → nothing
 *
 * The same bytes were a different document depending on how they arrived,
 * which is the one thing the import pipeline's own header promises is not
 * true. The GAIN was worse than the loss:
 *
 *   `havenwood-homes.com.au/download`, page line `Havenwood`
 *                                              → house_design "Havenwood"
 *
 * No document said that. A hostname did — `nameTokens` splits on every
 * non-alphanumeric, so `havenwood-homes.com.au` contributes `havenwood` to
 * the set the corroborator matches against. A brand mark became a property
 * field.
 *
 * This file pins the separation, in both directions: what the rule must
 * ANSWER, and what the reader must then DO with each answer.
 */
import { describe, expect, it } from 'vitest';

import {
  filenameFromContentDisposition,
  sourceDocumentName,
} from '../../../supabase/functions/_shared/builderStock/documentName.pure';
import {
  corroborateDesignFromFilename,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  stockSourceDisplayName,
} from '../../../supabase/functions/_shared/builderStock/urlSource.pure';

describe('what a URL names', () => {
  it('takes the last path segment when it names a file', () => {
    expect(sourceDocumentName({
      finalUrl: 'https://alphahomes.com.au/brochures/LOT%2037%20-%20HAVENWOOD%2021.pdf',
    })).toBe('LOT 37 - HAVENWOOD 21.pdf');
  });

  it('NAMES NOTHING where the path names an endpoint', () => {
    // The case the defect was measured on. A query string is not a name.
    expect(sourceDocumentName({ finalUrl: 'https://alphahomes.com.au/download?id=9f2a' })).toBeNull();
  });

  it('never falls back to the hostname', () => {
    // `snapshotFileName` does, correctly, because an object needs a name.
    // Evidence does not, and that difference is the whole module.
    expect(sourceDocumentName({ finalUrl: 'https://havenwood-homes.com.au/' })).toBeNull();
    expect(sourceDocumentName({ finalUrl: 'https://havenwood-homes.com.au' })).toBeNull();
    expect(sourceDocumentName({ finalUrl: 'https://havenwood-homes.com.au/stock/' })).toBeNull();
  });

  it('never invents a stem', () => {
    // A directory-shaped tail carries no extension, so it is not a document.
    expect(sourceDocumentName({ finalUrl: 'https://alphahomes.com.au/stock/spring-release' })).toBeNull();
  });

  it('is not derived from the display label', () => {
    const url = 'https://alphahomes.com.au/brochures/LOT%2037.pdf';
    expect(stockSourceDisplayName(url, null)).toContain('…');
    expect(sourceDocumentName({ finalUrl: url })).toBe('LOT 37.pdf');
  });

  it('refuses an address it cannot parse rather than guessing', () => {
    expect(sourceDocumentName({ finalUrl: 'not an address' })).toBeNull();
  });
});

describe('what a server states about its own body', () => {
  it('reads a plain filename parameter', () => {
    expect(filenameFromContentDisposition('attachment; filename="LOT 37 - HAVENWOOD 21.pdf"'))
      .toBe('LOT 37 - HAVENWOOD 21.pdf');
  });

  it('reads an unquoted one', () => {
    expect(filenameFromContentDisposition('attachment; filename=stock.pdf')).toBe('stock.pdf');
  });

  it('prefers the extended form, which is the one that can carry non-ASCII', () => {
    expect(filenameFromContentDisposition(
      "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''LOT%2037%20%E2%80%93%20HAVENWOOD.pdf",
    )).toBe('LOT 37 – HAVENWOOD.pdf');
  });

  it('keeps only the last segment, so a header cannot smuggle a path', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(filenameFromContentDisposition('attachment; filename="C:\\\\stock\\\\lot37.pdf"')).toBe('lot37.pdf');
  });

  it('answers null for a header that states no name', () => {
    expect(filenameFromContentDisposition('inline')).toBeNull();
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('')).toBeNull();
  });

  it('outranks the path, because it is the server naming its own body', () => {
    expect(sourceDocumentName({
      finalUrl: 'https://alphahomes.com.au/download?id=9f2a',
      contentDisposition: 'attachment; filename="LOT 37 - HAVENWOOD 21.pdf"',
    })).toBe('LOT 37 - HAVENWOOD 21.pdf');
  });

  it('falls through to the path when the header is malformed', () => {
    expect(sourceDocumentName({
      finalUrl: 'https://alphahomes.com.au/brochures/lot-37.pdf',
      contentDisposition: 'attachment; filename*=UTF-8\'\'%E0%A4%A',
    })).toBe('lot-37.pdf');
  });
});

/**
 * The defect itself, driven through the function that committed it.
 *
 * `claimed` carries an address, which is one of the corroborator's anchors,
 * and no `house_design` — the state in which it is entitled to act.
 */
describe('the reading a name produces', () => {
  const claimed = new Map([
    ['lot_number', '37'],
    ['suburb', 'Clyde North'],
    ['address_line', '12 Fairweather Drive'],
  ]);
  const read = (filename: string | null, unresolved: string[]) =>
    corroborateDesignFromFilename({ filename, unresolved, claimed });

  it("settles the design from the builder's own file name", () => {
    expect(read('LOT 37 - HAVENWOOD 21 - PACKAGE.pdf', ['Havenwood 21']))
      .toMatchObject({ claim: { field: 'house_design', value: 'Havenwood 21' } });
  });

  it('reads the SAME document identically when a URL names it', () => {
    const url = 'https://alphahomes.com.au/brochures/LOT%2037%20-%20HAVENWOOD%2021%20-%20PACKAGE.pdf';
    expect(read(sourceDocumentName({ finalUrl: url }), ['Havenwood 21']))
      .toEqual(read('LOT 37 - HAVENWOOD 21 - PACKAGE.pdf', ['Havenwood 21']));
  });

  it('LETS A HOSTNAME NAME A HOUSE DESIGN when handed a display label', () => {
    // Not an assertion about what the product does — an assertion about what
    // the corroborator does with a bad name, which is why the name is fixed
    // upstream of it rather than the rule being weakened here.
    const label = stockSourceDisplayName('https://havenwood-homes.com.au/download', null);
    expect(read(label, ['Havenwood'])).toMatchObject({
      claim: { field: 'house_design', value: 'Havenwood' },
    });
  });

  it('claims nothing from that same address once it is named honestly', () => {
    expect(read(sourceDocumentName({ finalUrl: 'https://havenwood-homes.com.au/download' }), ['Havenwood']))
      .toBeNull();
  });

  it('claims nothing where no name was given, exactly as for `download.pdf`', () => {
    expect(read('', ['Havenwood 21'])).toBeNull();
    expect(read(null, ['Havenwood 21'])).toBeNull();
    expect(read('download.pdf', ['Havenwood'])).toBeNull();
  });
});
