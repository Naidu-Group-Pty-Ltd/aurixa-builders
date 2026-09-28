/**
 * `Site Address: Lot 511 10 FORMATCHECK STREET` — A LOT, THEN THE STREET'S
 * OWN NUMBER.
 *
 * REPRODUCED IN PRODUCTION 28 SEPTEMBER 2026, in the Tier-0 formats proof, case
 * `pdf-brochure` (`scripts/ops/fixtures/tier0/pdf-brochure.pdf`). The brochure
 * states its property twice:
 *
 *     p1   Lot 511 10 Formatcheck Street
 *          Kestrel Grove, Truganina VIC 3029
 *     p2   Site Address: Lot 511 10 FORMATCHECK STREET
 *          Locality: TRUGANINA (3029)
 *
 * and it imported with `lot_number: null` and `address_line: "Lot 511 10
 * FORMATCHECK STREET"`. The lot this builder searches by was on both pages and
 * was stored nowhere, and the lot sat inside the address instead.
 *
 * `readLotHeading` read `Lot 511 Formatcheck Street` and `Lot 7 (No. 15)
 * Banksia Way`, and refused any other tail carrying a digit, so it refused the
 * street's own number when the builder did not bracket it. It is asked twice
 * about these words: once about page 1's LINE and once, through `splitAddress`,
 * about page 2's labelled VALUE. The address block read page 1 correctly (lot
 * 511, `10 Formatcheck Street`), but a block defers to anything the document
 * labelled, so the label discarded it.
 *
 * The inputs below are the fixture's own text layer: the page texts
 * `readPdfPageTexts` returns for its bytes and the runs `readPdfTextLayout`
 * returns for them, positions rounded to two places. They are driven through
 * `readPdfDeterministicRows`, the entry point `extract.ts` calls.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfDeterministicRows,
  type PdfTextItem,
  type PdfTextLayoutPage,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

// ---------------------------------------------------------------------------
// The fixture, and the same two pages with the address written other ways
// ---------------------------------------------------------------------------

/** Page 1 of the fixture, with its address line swapped for `address`. */
const cover = (address: string) => [
  'VIOLET 30',
  address,
  'Kestrel Grove, Truganina VIC 3029',
  'Package Price - $600,000',
  'Lot Size 350m2',
  'Total: 180.5m2',
  'PROOF ONLY - not for sale. Artist impression.',
].join('\n');

/** Page 2 of the fixture — the siting plan — with its `Site Address:` value swapped. */
const siting = (address: string) => [
  'SITING PLAN',
  `Site Address: ${address}`,
  'Locality: TRUGANINA (3029)',
  'State: VIC',
  'Home Design: VIOLET 30',
  'Estate: KESTREL GROVE',
  'Site Area: 350 m2',
  'Build Area: 180.5 m2',
  'This siting is subject to developer approval.',
].join('\n');

const run = (text: string, x: number, y: number, width: number, height: number): PdfTextItem =>
  ({ text, x, y, width, height });

/** The runs `readPdfTextLayout` returns for the fixture's two pages. */
const DRAWN: PdfTextLayoutPage[] = [
  {
    page: 1,
    items: [
      run('VIOLET 30', 56.69, 762.52, 100.04, 20),
      run('', 56.69, 739.84, 0, 11),
      run('Lot 511 10 Formatcheck Street', 56.69, 739.84, 151.02, 11),
      run('Kestrel Grove, Truganina VIC 3029', 56.69, 720, 171.8, 11),
      run('', 56.69, 297.64, 0, 11),
      run('Package Price - $600,000', 56.69, 297.64, 130.25, 11),
      run('', 56.69, 277.8, 0, 11),
      run('Lot Size', 56.69, 277.8, 39.74, 11),
      run(' ', 96.44, 277.8, 12.23, 11),
      run('350m2', 108.67, 277.8, 33.63, 11),
      run('Total: 180.5m2', 56.69, 257.95, 73.37, 11),
      run('', 56.69, 218.27, 0, 8),
      run('PROOF ONLY - not for sale. Artist impression.', 56.69, 218.27, 164.94, 8),
    ],
  },
  {
    page: 2,
    items: [
      run('SITING PLAN', 56.69, 762.52, 88.68, 14),
      run('', 56.69, 728.5, 0, 11),
      run('Site Address: Lot 511 10 FORMATCHECK STREET', 56.69, 728.5, 254.91, 11),
      run('Locality: TRUGANINA (3029)', 56.69, 708.66, 143.03, 11),
      run('State: VIC', 56.69, 688.82, 50.14, 11),
      run('Home Design: VIOLET 30', 56.69, 668.98, 127.16, 11),
      run('Estate: KESTREL GROVE', 56.69, 649.13, 130.22, 11),
      run('Site Area: 350 m2', 56.69, 629.29, 88.04, 11),
      run('Build Area: 180.5 m2', 56.69, 609.45, 102.72, 11),
      run('', 56.69, 246.61, 0, 8),
      run('This siting is subject to developer approval.', 56.69, 246.61, 152.95, 8),
    ],
  },
];

const FIXTURE_PAGES = [cover('Lot 511 10 Formatcheck Street'), siting('Lot 511 10 FORMATCHECK STREET')];

const read = (pageTexts: string[], positionedPages: PdfTextLayoutPage[] | null = null) =>
  readPdfDeterministicRows({ pageTexts, positionedPages, filename: 'pdf-brochure.pdf' });

/** What a stock row would store, or null where the reading produced none. */
const stored = (reading: ReturnType<typeof read>) =>
  reading.rows.length ? normaliseStockRow(reading.rows[0]) : null;

/** The property's identity and where it is, as stored. */
const identity = (reading: ReturnType<typeof read>) => {
  const row = stored(reading);
  return {
    status: reading.status,
    lot: row?.lot_number ?? null,
    address: row?.address_line ?? null,
    suburb: row?.suburb ?? null,
    state: row?.state ?? null,
    postcode: row?.postcode ?? null,
  };
};

// ===========================================================================
// THE DEFECT
// ===========================================================================

describe('the Tier-0 brochure: `Lot 511 10 Formatcheck Street`', () => {
  const EXPECTED = {
    status: 'complete', lot: '511', address: '10 FORMATCHECK STREET',
    suburb: 'TRUGANINA', state: 'VIC', postcode: '3029',
  };

  it('as drawn (page texts and positioned runs, as the import hands them over)', () => {
    const reading = read(FIXTURE_PAGES, DRAWN);
    expect(identity(reading)).toEqual(EXPECTED);
    expect(stored(reading)?.address_line).not.toMatch(/^lot\b/i);
  });

  it('as flattened text', () => {
    expect(identity(read(FIXTURE_PAGES))).toEqual(EXPECTED);
  });

  it('keeps everything else the document states, and leaves no line unread', () => {
    const reading = read(FIXTURE_PAGES, DRAWN);
    const row = stored(reading);
    expect({
      estate: row?.development_name, design: row?.house_design, price: row?.price,
      land: row?.land_size_sqm, build: row?.building_size_sqm,
    }).toEqual({
      estate: 'KESTREL GROVE', design: 'VIOLET 30', price: 600000, land: 350, build: 180.5,
    });
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.unaccounted).toEqual([]);
  });

  it('reads the labelled value on its own, with no cover beside it', () => {
    expect(identity(read([siting('Lot 511 10 FORMATCHECK STREET')]))).toEqual(EXPECTED);
  });

  it('keeps a full stop the street owns', () => {
    const row = stored(read([siting('Lot 511 10 Formatcheck Ave.')]));
    expect({ lot: row?.lot_number, address: row?.address_line })
      .toEqual({ lot: '511', address: '10 Formatcheck Ave.' });
  });
});

describe('a comma after the designation: `Lot 511, 10 Formatcheck Street`', () => {
  const EXPECTED = {
    status: 'complete', lot: '511', address: '10 FORMATCHECK STREET',
    suburb: 'TRUGANINA', state: 'VIC', postcode: '3029',
  };

  it('reads the lot and the street on both pages', () => {
    expect(identity(read([
      cover('Lot 511, 10 Formatcheck Street'), siting('Lot 511, 10 FORMATCHECK STREET'),
    ]))).toEqual(EXPECTED);
  });

  it('reads the labelled value on its own', () => {
    expect(identity(read([siting('Lot 511, 10 FORMATCHECK STREET')]))).toEqual(EXPECTED);
  });
});

describe('the lot line with nothing under it is read the way the unnumbered one is', () => {
  const page = (address: string) =>
    ['VIOLET 30', address, 'Package Price - $600,000', 'Lot Size 350m2'].join('\n');

  it('reads the lot, and leaves no unread line to stand the document down', () => {
    const numbered = read([page('Lot 511 10 Formatcheck Street')]);
    const unnumbered = read([page('Lot 511 Formatcheck Street')]);
    expect(identity(numbered)).toEqual(identity(unnumbered));
    expect(identity(numbered)).toMatchObject({ status: 'complete', lot: '511' });
    expect(numbered.unaccounted).toEqual([]);
  });
});

// ===========================================================================
// WHAT MUST NOT MOVE — each expectation is the reading before this change
// ===========================================================================

describe('what must not move', () => {
  const WHERE = { suburb: 'TRUGANINA', state: 'VIC', postcode: '3029' };

  it('`Lot 511 Formatcheck Street`: the lot is read, and the labelled address keeps it', () => {
    expect(identity(read([
      cover('Lot 511 Formatcheck Street'), siting('Lot 511 FORMATCHECK STREET'),
    ]))).toEqual({
      status: 'complete', lot: '511', address: 'Lot 511 FORMATCHECK STREET', ...WHERE,
    });
  });

  it('`Lot 511 (No. 10) Formatcheck Street`: the bracketed number, read as before', () => {
    expect(identity(read([
      cover('Lot 511 (No. 10) Formatcheck Street'), siting('Lot 511 (No. 10) FORMATCHECK STREET'),
    ]))).toEqual({
      status: 'complete', lot: '511', address: 'Lot 511 (No. 10) FORMATCHECK STREET', ...WHERE,
    });
  });

  it('an address that names no lot: no lot is invented', () => {
    expect(identity(read([cover('10 Formatcheck Street'), siting('10 FORMATCHECK STREET')])))
      .toEqual({ status: 'complete', lot: null, address: '10 FORMATCHECK STREET', ...WHERE });
  });

  it('`Lot TBC, 10 …`: a lot not yet allocated is no designation, and the address is not split', () => {
    expect(identity(read([
      cover('Lot TBC, 10 Formatcheck Street'), siting('Lot TBC, 10 FORMATCHECK STREET'),
    ]))).toEqual({
      status: 'complete', lot: null, address: 'Lot TBC, 10 FORMATCHECK STREET', ...WHERE,
    });
  });

  it('the cover alone: the address block reads the lot and the street it always read', () => {
    const reading = read([cover('Lot 511 10 Formatcheck Street')]);
    expect(identity(reading)).toEqual({
      status: 'complete', lot: '511', address: '10 Formatcheck Street',
      suburb: 'Truganina', state: 'VIC', postcode: '3029',
    });
    expect(stored(reading)?.development_name).toBe('Kestrel Grove');
  });
});

// ===========================================================================
// TWO LOTS ARE STILL TWO LOTS
// ===========================================================================

describe('a different lot elsewhere in the document', () => {
  const lotHeadedCover = (lot: string) =>
    [lot, 'Kestrel Grove, Truganina VIC 3029', 'Package Price - $600,000'].join('\n');

  it('refuses exactly as the unnumbered labelled address already refuses', () => {
    const unnumbered = read([lotHeadedCover('LOT 512'), siting('Lot 511 FORMATCHECK STREET')]);
    const numbered = read([lotHeadedCover('LOT 512'), siting('Lot 511 10 FORMATCHECK STREET')]);
    // The first is the reading before this change; the second now matches it.
    expect({ status: unnumbered.status, reason: unnumbered.reason })
      .toEqual({ status: 'ambiguous', reason: 'conflicting_values:lot_number' });
    expect({ status: numbered.status, reason: numbered.reason })
      .toEqual({ status: unnumbered.status, reason: unnumbered.reason });
    expect(numbered.rows).toEqual([]);
  });

  it('and the same lot stated twice is one lot', () => {
    expect(identity(read([lotHeadedCover('LOT 511'), siting('Lot 511 10 FORMATCHECK STREET')])))
      .toEqual({
        status: 'complete', lot: '511', address: '10 FORMATCHECK STREET',
        suburb: 'TRUGANINA', state: 'VIC', postcode: '3029',
      });
  });
});
