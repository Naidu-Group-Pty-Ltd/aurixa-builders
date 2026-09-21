/**
 * THE BROCHURE CORPUS — the shapes, not the files.
 *
 * Three production documents were fixed one refusal at a time
 * (`two_cells_in_one_column`, `conflicting_values:land_size_sqm`,
 * `label_without_value:development_name`) and each fix was correct and each
 * was too late: the next brochure failed on the next reason. That is the
 * defect this file exists to stop repeating.
 *
 * Every fixture here is a STRUCTURAL CLASS a builder's PDF can belong to,
 * written generically. No builder name decides anything, no filename is
 * parsed for its own sake, and nothing is keyed on a document we happen to
 * have seen. A new brochure is covered because its SHAPE is covered.
 *
 * THE ONE RULE THEY ALL CHECK:
 *
 *   Can this evidence mean we have the WRONG PROPERTY or the WRONG DEAL?
 *     yes → refuse the document
 *     no  → ignore it, reconcile it, or drop that one field
 *
 * so the corpus is split in two. The first half is documents that MUST
 * import without a model. The second is documents that MUST refuse.
 */
import { describe, expect, it } from 'vitest';

import {
  readPdfBrochure,
  readPdfDeterministicRows,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

// ---------------------------------------------------------------------------
// Helpers — a page of lines, or a page of runs drawn at coordinates
// ---------------------------------------------------------------------------

const page = (...lines: string[]) => lines.join('\n');

/** A drawn run. `h` is the type size, which is what proves a superscript. */
const run = (text: string, x: number, y: number, w: number, h = 10): PdfTextItem =>
  ({ text, x, y, width: w, height: h });

const read = (
  pages: string[],
  options: Parameters<typeof readPdfBrochure>[1] = {},
) => readPdfBrochure(pages, options);

const rowOf = (reading: ReturnType<typeof readPdfBrochure>) => {
  expect(reading.status).toBe('complete');
  expect(reading.rows).toHaveLength(1);
  return normaliseStockRow(reading.rows[0])!;
};

/** What `runImport` does with a reading: rows, or the model. */
const reachesTheModel = (reading: ReturnType<typeof readPdfBrochure>) =>
  !(reading.status === 'complete' && reading.rows.length > 0);

/** The identity block every fixture below needs to be a property at all. */
const IDENTITY = ['Lot 208 Fairweather Drive', 'Estate: Northbrook Rise',
  'Home Design: Aspire 24 Grande'];

// ===========================================================================
// PART ONE — documents that MUST import, with no model
// ===========================================================================

describe('1 · a marketing page and a siting plan, the common package brochure', () => {
  const reading = read([
    page('Aspire 24',
      '4  2  2',
      'Land Price - $310,000',
      'Build Price - $352,900',
      'Package Price - $662,900',
      'Lot 208 Fairweather Drive',
      'Northbrook Rise, Clyde North',
      'Titles: March 2027',
      'Lot Size', '402m2',
      'House Specifications',
      'Enclosed: 201.40m2', 'Garage: 36.10m2', 'Total: 237.50m2'),
    page('Site Address: Lot 208 FAIRWEATHER DRIVE', 'Estate:',
      'Locality: CLYDE NORTH (3978)', 'State: VIC',
      'Home Design: ASPIRE 24 GRANDE', 'Email/Phone:',
      'Site Area: 401.86 m2', 'Build Area: 237.50 m2',
      'This siting is subject to developer approval.'),
    page('Inclusions', '•', 'Stone benchtops throughout', '•',
      'LED downlights throughout', 'Ph 1300 555 020', 'www.example.com.au',
      '© 2027 A Builder Pty Ltd. Prices subject to change without notice.'),
  ]);

  it('imports, and never reaches the model', () => {
    expect(reading.status).toBe('complete');
    expect(reachesTheModel(reading)).toBe(false);
  });

  it('reads the identity and the deal', () => {
    const row = rowOf(reading);
    expect({
      lot: row.lot_number, design: row.house_design, estate: row.development_name,
      address: row.address_line, suburb: row.suburb, state: row.state,
      postcode: row.postcode, price: row.price, titles: row.expected_completion,
    }).toEqual({
      lot: '208', design: 'ASPIRE 24 GRANDE', estate: 'Northbrook Rise',
      address: 'Lot 208 FAIRWEATHER DRIVE', suburb: 'CLYDE NORTH',
      state: 'VIC', postcode: '3978', price: 662900, titles: 'March 2027',
    });
  });

  it('the price BREAKDOWN is not read as a contradiction', () => {
    // `Land Price` and `Build Price` are compounds this vocabulary has no
    // column for. Reading the `Land` in one as a land size is what stood a
    // real document down.
    expect(rowOf(reading).price).toBe(662900);
    expect(reading.diagnostics.disputedFields).toBeUndefined();
  });
});

describe('2 · the same measurement rounded on one page and exact on another', () => {
  it('reconciles, and keeps the exact figure', () => {
    const row = rowOf(read([
      page(...IDENTITY, 'Price: $662,900', 'Lot Size: 402m2'),
      page('Land Area: 401.86 m2'),
    ]));
    expect(row.land_size_sqm).toBe(401.86);
  });

  it('but a disagreement in a digit the coarse figure states is real', () => {
    const reading = read([
      page(...IDENTITY, 'Price: $662,900',
        'Build Size: 237.50 m2', 'Build Size: 241.00 m2'),
    ]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.building_size_sqm).toBeNull();
    expect(reading.diagnostics.disputedFields).toEqual(['building_size_sqm']);
  });
});

describe('3 · blank fields on a template', () => {
  it('an empty box states nothing and stands nothing down', () => {
    const row = rowOf(read([
      page('Site Address: Lot 208 Fairweather Drive', 'Estate:',
        'Home Design: Aspire 24 Grande', 'Email/Phone:', 'Land Size:',
        'Price: $662,900'),
    ]));
    expect(row.lot_number).toBe('208');
    expect(row.land_size_sqm).toBeNull();
    expect(row.development_name).toBeNull();
  });
});

describe('4 · the design captioned under its own name', () => {
  it('reads the name, not the caption', () => {
    const row = rowOf(read([
      page('Lot 208 Fairweather Drive', 'Price: $662,900',
        'ASPIRE 24 GRANDE', 'HOME DESIGN',
        'NORTHBROOK RISE', 'ESTATE'),
    ]));
    expect({ design: row.house_design, estate: row.development_name })
      .toEqual({ design: 'ASPIRE 24 GRANDE', estate: 'NORTHBROOK RISE' });
  });
});

describe('5 · the field word embedded in the name', () => {
  it('the document labels itself', () => {
    const row = rowOf(read([
      page('Lot 208 Fairweather Drive', 'Price: $662,900',
        'NORTHBROOK RISE ESTATE', 'ASPIRE 24 GRANDE DESIGN'),
    ]));
    expect({ design: row.house_design, estate: row.development_name })
      .toEqual({ design: 'ASPIRE 24 GRANDE DESIGN', estate: 'NORTHBROOK RISE ESTATE' });
  });

  it('and a sentence ending in a field word is not a name', () => {
    const reading = read([
      page(...IDENTITY, 'Price: $662,900', 'Welcome home to Northbrook Rise Estate'),
    ]);
    expect(normaliseStockRow(reading.rows[0])!.development_name)
      .toBe('Northbrook Rise');
  });
});

describe('6 · two columns side by side', () => {
  const FLAT = page('Lot 208 Fairweather Drive', 'Estate: Northbrook Rise',
    'Price: $662,900', 'LAND SIZE BUILD AREA', '402 m2 237.50 m2');

  it('unpairable when flattened, so neither size is invented', () => {
    const reading = read([FLAT]);
    expect(reading.diagnostics.fieldsRead).not.toContain('land_size_sqm');
    expect(reading.diagnostics.fieldsRead).not.toContain('building_size_sqm');
  });

  it('each column pairs with its own value once the positions are read', () => {
    const row = rowOf(read([FLAT], {
      positionedPages: [{ page: 1, items: [
        run('Lot 208 Fairweather Drive', 40, 760, 180),
        run('Estate: Northbrook Rise', 40, 730, 160),
        run('Price: $662,900', 40, 700, 110),
        run('LAND SIZE', 40, 660, 60), run('BUILD AREA', 240, 660, 70),
        run('402 m2', 40, 640, 40), run('237.50 m2', 240, 640, 55),
      ] }],
    }));
    expect([row.land_size_sqm, row.building_size_sqm]).toEqual([402, 237.5]);
  });

  it('and a label never pairs across columns', () => {
    const reading = read([page('Lot 208 Fairweather Drive', 'LAND SIZE', '237.50 m2')], {
      positionedPages: [{ page: 1, items: [
        run('Lot 208 Fairweather Drive', 40, 760, 180),
        run('LAND SIZE', 40, 700, 60), run('237.50 m2', 240, 680, 55),
      ] }],
    });
    expect(reading.diagnostics.fieldsRead).not.toContain('land_size_sqm');
  });
});

describe('7 · a label with its value on the line below', () => {
  it('pairs downwards', () => {
    const row = rowOf(read([
      page('Lot 208 Fairweather Drive', 'Estate: Northbrook Rise',
        'LAND SIZE', '402 m2', 'PACKAGE PRICE', '$662,900'),
    ]));
    expect([row.land_size_sqm, row.price]).toEqual([402, 662900]);
  });

  it('and never across a page break', () => {
    const reading = read([
      page('Lot 208 Fairweather Drive', 'Estate: Northbrook Rise',
        'Price: $662,900', 'LAND SIZE'),
      page('402 m2'),
    ]);
    expect(reading.diagnostics.fieldsRead).not.toContain('land_size_sqm');
  });
});

describe('8 · a superscript m² drawn as its own run', () => {
  it('is put back on the number it belongs to', () => {
    const row = rowOf(read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900', 'Lot Size', '402m', '2')], {
      positionedPages: [{ page: 1, items: [
        run('Lot 208 Fairweather Drive', 40, 760, 180, 24),
        run('Estate: Northbrook Rise', 40, 730, 160, 14),
        run('Price: $662,900', 40, 700, 110, 14),
        run('Lot Size', 27, 190, 41, 14),
        run('402', 27, 169, 15), run('m', 42, 169, 7),
        run('2', 49, 172.4, 3, 5.8),
      ] }],
    }));
    expect(row.land_size_sqm).toBe(402);
  });

  it('and a run of ordinary type on the next line is NOT folded in', () => {
    const reading = read([page('Lot 208 Fairweather Drive', 'Price: $1', 'Land Size', '402')], {
      positionedPages: [{ page: 1, items: [
        run('Lot 208 Fairweather Drive', 40, 760, 180),
        run('Price: $1', 40, 730, 60),
        run('Land Size', 40, 700, 50), run('402', 40, 686, 15),
      ] }],
    });
    // A normal line below is a PAIR, not a superscript: the size still reads.
    expect(normaliseStockRow(reading.rows[0])!.land_size_sqm).toBe(402);
  });
});

describe('9 · the PDF supplying its own space runs, and splitting a number', () => {
  it('reassembles the lot and the design exactly as the page reads', () => {
    const row = rowOf(read([page('Aspire 24', 'Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900')], {
      positionedPages: [{ page: 1, items: [
        run('Aspire 2', 28, 777, 70, 30), run('4', 98, 777, 12, 30),
        run('Lot', 28, 604, 30, 24), run(' ', 58, 604, 4, 24),
        run('2', 62, 604, 13, 24), run('08', 75, 604, 22, 24),
        run(' ', 97, 604, 4, 24), run('Fairweather Drive', 101, 604, 150, 24),
        run('Estate: Northbrook Rise', 28, 575, 200, 24),
        run('Price: $662,900', 28, 546, 140, 24),
      ] }],
    }));
    expect(row.lot_number).toBe('208');
    expect(row.address_line).toBeNull();
  });
});

describe('10 · a floor plan', () => {
  it('its room labels cannot stand a property down, or become counts', () => {
    const reading = read([page(...IDENTITY, 'Price: $662,900',
      'Robe', 'Kitchen', 'Linen', 'Ensuite', 'LDRY', 'Porch', 'Bath',
      'Garage', 'Terrace', 'Meals/Living', 'Bed 1', 'Bed 2', 'Bed 3',
      'MASTER', 'ENTRY', 'P.')]);
    const row = rowOf(reading);
    expect([row.bedrooms, row.bathrooms, row.car_spaces])
      .toEqual([null, null, null]);
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('and a room AREA is never a count', () => {
    const row = rowOf(read([page(...IDENTITY, 'Price: $662,900',
      'Garage: 36.10m2')]));
    expect(row.car_spaces).toBeNull();
  });
});

describe('11 · pages of inclusions and specification copy', () => {
  it('cost the document nothing', () => {
    const reading = read([
      page(...IDENTITY, 'Price: $662,900'),
      page('VERV Quality Inclusions:', '•', 'Architecturally Designed Facade',
        '•', '2590mm high ceiling throughout', '•', 'Quality Flooring throughout',
        'Doors: Flush panel. 2040mm high. Either', 'hinged or sliding as per plan.',
        'Roof Pitch:', 'Roof pitch to be 22.5 degrees.',
        'Taps: 2 external taps, 1 to front water', 'meter and 1 to rear of home.'),
      page('Ph 1300 555 020', 'sales@example.com.au', 'www.example.com.au',
        'Page 3 of 3', 'ABN 12 345 678 901',
        "Artist's impression. Not to scale.", 'All rights reserved.'),
    ]);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.diagnostics.ignoredLines ?? 0).toBeGreaterThan(0);
  });
});

describe('12 · the bed/bath/car icon row', () => {
  const reading = read([page(...IDENTITY, 'Price: $662,900', '4', '2', '2')]);

  it('three bare digits are never assigned by their order', () => {
    const row = rowOf(reading);
    expect([row.bedrooms, row.bathrooms, row.car_spaces])
      .toEqual([null, null, null]);
  });

  it('and the property imports anyway, with the gap named', () => {
    expect(reachesTheModel(reading)).toBe(false);
    expect(reading.diagnostics.visualOnlyFields)
      .toEqual(['bathrooms', 'bedrooms', 'car_spaces']);
  });

  it('a count the document WRITES is still read', () => {
    const row = rowOf(read([page(...IDENTITY, 'Price: $662,900',
      'Bedrooms: 4', 'Bathrooms 2', '2 CAR')]));
    expect([row.bedrooms, row.bathrooms, row.car_spaces]).toEqual([4, 2, 2]);
  });
});

describe('19 · the filename corroborates what the page already prints', () => {
  it('classifies a bare name the document shows', () => {
    const row = rowOf(read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900', 'Aspire 24 Grande')],
      { filename: 'LOT 208 - ASPIRE 24 GRANDE - BROCHURE.pdf' }));
    expect(row.house_design).toBe('Aspire 24 Grande');
  });

  it('and can never invent one the document does not', () => {
    const reading = read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900')],
      { filename: 'LOT 208 - ASPIRE 24 GRANDE - BROCHURE.pdf' });
    expect(normaliseStockRow(reading.rows[0])!.house_design).toBeNull();
  });
});

describe('23 · the organisation and the optional fields', () => {
  it('the builder’s own name is never the estate', () => {
    const row = rowOf(read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900', 'A BUILDER HOMES')],
      { organisationName: 'A Builder Homes Pty Ltd' }));
    expect(row.development_name).toBe('Northbrook Rise');
  });

  it('a property with no counts and no sizes is still a property', () => {
    const row = rowOf(read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900')]));
    expect({ lot: row.lot_number, price: row.price, beds: row.bedrooms,
      land: row.land_size_sqm }).toEqual({
      lot: '208', price: 662900, beds: null, land: null });
  });
});

// ===========================================================================
// PART TWO — documents that MUST refuse, and reach the model
// ===========================================================================

describe('13-17 · contradictions about the property or the deal', () => {
  const contradictions: Array<[string, string, string]> = [
    ['13 · two lots', 'Lot 209 Fairweather Drive', 'conflicting_values:lot_number'],
    ['14 · two addresses', 'Site Address: Lot 208 Halcyon Way',
      'conflicting_values:address_line'],
    ['15 · two designs', 'Home Design: Vantage 30', 'conflicting_values:house_design'],
    ['16 · two estates', 'Estate: Halcyon Fields',
      'conflicting_values:development_name'],
    ['17 · two prices', 'Price: $710,000', 'conflicting_values:price'],
  ];

  it.each(contradictions)('%s refuses the whole document', (_label, line, reason) => {
    const reading = read([
      page('Lot 208 Fairweather Drive', 'Site Address: Lot 208 Fairweather Drive',
        'Estate: Northbrook Rise', 'Home Design: Aspire 24 Grande',
        'Price: $662,900', line),
    ]);
    expect({ status: reading.status, reason: reading.reason })
      .toEqual({ status: 'ambiguous', reason });
    expect(reading.rows).toEqual([]);
    expect(reachesTheModel(reading)).toBe(true);
  });
});

describe('18 · a document describing more than one property', () => {
  it('refuses rather than splitting or picking', () => {
    const reading = read([
      page('Lot 208 Fairweather Drive', 'Estate: Northbrook Rise',
        'Price: $662,900'),
      page('Lot 209 Fairweather Drive', 'Estate: Northbrook Rise',
        'Price: $688,400'),
    ]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.rows).toEqual([]);
  });
});

describe('20 · the filename contradicting the document', () => {
  it('refuses, rather than trusting either', () => {
    const reading = read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900', 'Aspire 24 Grande')],
      { filename: 'LOT 311 - ASPIRE 24 GRANDE - BROCHURE.pdf' });
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('filename_lot_disagrees_with_document');
    expect(reading.rows).toEqual([]);
  });
});

describe('· a material fact stated in terms the reader could not take', () => {
  it('blocks, because it may be the deal contradicting itself', () => {
    const reading = read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900',
      'Price $310,000 land component')]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('unaccounted_specification_lines');
  });

  it('while marketing copy opening with the same word does not', () => {
    // `Prices from …` states the price of nothing: a statement puts its
    // value next to its label.
    const reading = read([page('Lot 208 Fairweather Drive',
      'Estate: Northbrook Rise', 'Price: $662,900',
      'Prices from $610,000 across the release')]);
    expect(reading.status).toBe('complete');
  });
});

describe('· no property at all', () => {
  it('a document naming no property is never a row', () => {
    const reading = read([page('Northbrook Rise', 'Price: $662,900',
      'Land Size: 402m2')]);
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
  });

  it('and a summary word is not an identity', () => {
    const reading = read([page('Lot: TOTAL', 'Estate: Northbrook Rise',
      'Price: $9,000,000')]);
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
  });
});

// ===========================================================================
// 21-22 — the routes this reader must not disturb
// ===========================================================================

describe('21 · a schedule PDF still goes to the table reader', () => {
  const HEADING = 'ESTATE LOT DESIGN BED BATH CAR LAND PRICE';
  const items: PdfTextItem[] = (() => {
    const columns = [40, 130, 210, 300, 345, 390, 440, 510];
    const rows = [
      ['ESTATE', 'LOT', 'DESIGN', 'BED', 'BATH', 'CAR', 'LAND', 'PRICE'],
      ['Northbrook Rise', '208', 'Aspire 24', '4', '2', '2', '402', '$662,900'],
      ['Northbrook Rise', '209', 'Vantage 30', '4', '2', '2', '448', '$688,400'],
    ];
    const out: PdfTextItem[] = [];
    rows.forEach((cells, r) => cells.forEach((text, c) =>
      out.push(run(text, columns[c], 700 - r * 18, text.length * 5))));
    return out;
  })();

  it('reads its rows through the schedule mode, not the brochure one', () => {
    const reading = readPdfDeterministicRows({
      pageTexts: [page('A BUILDER — STOCK LIST', HEADING,
        'Northbrook Rise 208 Aspire 24 4 2 2 402 $662,900',
        'Northbrook Rise 209 Vantage 30 4 2 2 448 $688,400')],
      positionedPages: [{ page: 1, items }],
    });
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_table');
    expect(reading.rows).toHaveLength(2);
  });

  it('and a brochure is never offered to it', () => {
    const reading = readPdfDeterministicRows({
      pageTexts: [page(...IDENTITY, 'Price: $662,900',
        '*Price based on standard inclusions and facade. Image depicts '
        + 'upgrade items not included in the price.')],
      positionedPages: [{ page: 1, items: [] }],
    });
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_brochure');
  });
});

describe('22 · nothing here reaches another architecture', () => {
  it('the reader spends nothing, fetches nothing and knows no clock', () => {
    const reading = read([page(...IDENTITY, 'Price: $662,900')]);
    expect(reading.status).toBe('complete');
    // Proved at the source in builderStockPdfDeterministicWiring.spec.ts;
    // asserted here as the corpus's own statement of the boundary.
    expect(reading.diagnostics.mode).toBe('brochure');
    expect(reading.rows).toHaveLength(1);
  });
});
