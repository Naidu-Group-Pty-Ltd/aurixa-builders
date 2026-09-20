/**
 * The deterministic PDF reader — the stage that stands between a PDF and the
 * assisted reader.
 *
 * WHAT THESE FIXTURES ARE. The three production brochures live in a private
 * bucket this session cannot read, and making it readable to obtain a fixture
 * is not a thing a test is worth. So the page strings below are not invented
 * shapes: they are what the PINNED reader (`unpdf@0.12.1`, the version and the
 * call `pdfText.ts` makes) actually returned for PDFs drawn at known
 * coordinates, measured 20 September 2026. The one fact that matters and that
 * could only be measured is in `PROBE_A`: eight columns drawn 21 to 62 units
 * apart come back separated by ONE space, identical to the space inside
 * "Palomino Estate". Every rule in the module under test follows from that.
 *
 * The positional fixtures are the same documents' item lists, with the
 * coordinates the generator placed the text at.
 */
import { describe, expect, it } from 'vitest';

import {
  BROCHURE_CLAIMABLE_FIELDS,
  CANONICAL_HEADER,
  MIN_BROCHURE_FIELDS,
  assemblePdfSchedule,
  hasSpecificationCue,
  layoutLines,
  mayHoldSchedule,
  readPdfBrochure,
  readPdfDeterministicRows,
  readsAsProse,
  type PdfTextItem,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';
import {
  fieldForHeader, normaliseStockRow,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';

// ---------------------------------------------------------------------------
// Measured reader output
// ---------------------------------------------------------------------------

/** A schedule drawn in eight columns. Measured: every gap is one space. */
const PROBE_A = 'ACME HOMES - STOCK LIST MARCH\n'
  + 'ESTATE LOT DESIGN BED BATH CAR LAND PRICE\n'
  + 'Palomino Estate 315 Enzo 8.5 4 2 2 350 $863,850\n'
  + 'Palomino Estate 324 Nex 20 4 2 2 420 $910,000\n'
  + 'Society 1056 717 Enzo 10.5 3 2 2 271 $741,655';

/**
 * A brochure whose estate and design are drawn as BARE LINES.
 *
 * This is the document the whole first gate exists for. The reader is right
 * to refuse to guess which of `PALOMINO ESTATE` and `ENZO 8.5 LUCA` is the
 * estate and which the design — and it must therefore also refuse to declare
 * the document read, because the assisted reader can tell them apart and
 * completing here would suppress it and publish a property missing both.
 */
const PROBE_B = 'LOT 315\n'
  + 'PALOMINO ESTATE\n'
  + 'ENZO 8.5 LUCA\n'
  + 'Land Size 350 m2\n'
  + 'Build Size 180 m2\n'
  + 'Bedrooms 4\n'
  + 'Bathrooms 2\n'
  + 'Car Spaces 2\n'
  + 'PACKAGE PRICE $863,850\n'
  + 'Full turnkey inclusions: landscaping, driveway and fencing.';

/**
 * The same property, written as labelled statements throughout.
 *
 * It carries no marketing line, and that is not an omission: `Full turnkey
 * inclusions: …` contains `inclusions`, which the alias table knows as a
 * description heading, so under the cue rule it is a fact this reader did not
 * take and the document correctly stands down. Prose with NO cue is still
 * ignored — proved separately below.
 */
const LABELLED_BROCHURE = 'Lot: 315\n'
  + 'Estate: Palomino Estate\n'
  + 'Design: Enzo 8.5 Luca\n'
  + 'Land Size: 350 m2\n'
  + 'Build Size: 180 m2\n'
  + 'Bedrooms: 4\n'
  + 'Bathrooms: 2\n'
  + 'Car Spaces: 2\n'
  + 'Price: $863,850';

/** The same eight columns, as the reader's item list places them. */
const SCHEDULE_ITEMS: PdfTextItem[] = (() => {
  const columns = [40, 130, 210, 300, 345, 390, 440, 510];
  const rows = [
    ['ESTATE', 'LOT', 'DESIGN', 'BED', 'BATH', 'CAR', 'LAND', 'PRICE'],
    ['Palomino Estate', '315', 'Enzo 8.5', '4', '2', '2', '350', '$863,850'],
    ['Palomino Estate', '324', 'Nex 20', '4', '2', '2', '420', '$910,000'],
    ['Society 1056', '717', 'Enzo 10.5', '3', '2', '2', '271', '$741,655'],
  ];
  const items: PdfTextItem[] = [
    { text: 'ACME HOMES - STOCK LIST MARCH', x: 40, y: 740, width: 245 },
  ];
  rows.forEach((cells, rowIndex) => {
    const y = 700 - rowIndex * 18;
    cells.forEach((text, column) => {
      items.push({ text, x: columns[column], y, width: text.length * 5 });
    });
  });
  return items;
})();

const schedulePages = (items: PdfTextItem[]) => [{ page: 1, items }];

// ---------------------------------------------------------------------------
// A — the vocabulary is the existing one
// ---------------------------------------------------------------------------

describe('no second field vocabulary', () => {
  it('every canonical header this module writes back resolves to its own field', () => {
    for (const [field, header] of Object.entries(CANONICAL_HEADER)) {
      expect({ field, resolved: fieldForHeader(header) })
        .toEqual({ field, resolved: field });
    }
  });

  it('every brochure-claimable field has a canonical header', () => {
    for (const field of BROCHURE_CLAIMABLE_FIELDS) {
      expect(CANONICAL_HEADER[field]).toBeTruthy();
    }
  });

  it('a brochure may not state its own description or availability', () => {
    // A brochure IS marketing prose; turning it into a description or a
    // status is the one thing a deterministic reader must never do.
    expect(BROCHURE_CLAIMABLE_FIELDS.has('description')).toBe(false);
    expect(BROCHURE_CLAIMABLE_FIELDS.has('availability_status')).toBe(false);
    expect(BROCHURE_CLAIMABLE_FIELDS.has('image_url')).toBe(false);
    expect(BROCHURE_CLAIMABLE_FIELDS.has('builder_name')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B — the measured fact the whole design rests on
// ---------------------------------------------------------------------------

describe('a column cannot be recovered from flattened page text', () => {
  it('the schedule reaches the brochure reader as prose and claims nothing', () => {
    const reading = readPdfBrochure([PROBE_A]);
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
  });

  it('the flattened data row genuinely carries no boundary', () => {
    const row = PROBE_A.split('\n')[2];
    expect(row).toBe('Palomino Estate 315 Enzo 8.5 4 2 2 350 $863,850');
    // Ten whitespace tokens under eight headings: nothing here says where a
    // cell ends, which is why the table mode reads positions instead.
    expect(row.split(/\s+/)).toHaveLength(10);
    expect(PROBE_A.split('\n')[1].split(/\s+/)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// C — the deterministic single-property brochure
// ---------------------------------------------------------------------------

describe('a brochure whose design and estate are bare lines', () => {
  const reading = readPdfBrochure([PROBE_B]);

  /*
   * THIS BLOCK USED TO ASSERT THE OPPOSITE, and the change is deliberate.
   *
   * The gate was "any line that could be a fact must be accounted for", which
   * on a real seven-page brochure is unreachable — it blocks on the builder's
   * own phone number. It is now the narrower and more precise question: does
   * the line NAME a field this vocabulary knows and state a value we did not
   * take? `PALOMINO ESTATE` and `ENZO 8.5 LUCA` name no field we recognise,
   * so they are reported and the document completes on what it does state.
   *
   * What that costs is recorded rather than hidden: the record carries no
   * design and no development, and `unclassifiedLines` says two lines went
   * unread. What it buys is that an ordinary brochure imports at all.
   */
  it('completes on the facts it can name', () => {
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_brochure');
    expect(reading.rows).toHaveLength(1);
  });

  it('reports the lines it could not place, and invents nothing from them', () => {
    // `PALOMINO ESTATE`, `ENZO 8.5 LUCA`, and the inclusions sentence — whose
    // `inclusions` the alias table knows but which this reader may not claim.
    expect(reading.diagnostics.unclassifiedLines).toBe(3);
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.house_design).toBeNull();
    expect(record.development_name).toBeNull();
  });

  it('every value it did take is one the document stated', () => {
    const record = normaliseStockRow(reading.rows[0])!;
    expect({
      lot: record.lot_number, land: record.land_size_sqm, build: record.building_size_sqm,
      beds: record.bedrooms, baths: record.bathrooms, cars: record.car_spaces,
      price: record.price,
    }).toEqual({
      lot: '315', land: 350, build: 180, beds: 4, baths: 2, cars: 2, price: 863850,
    });
  });

  it('the bare lines are not prose', () => {
    expect(readsAsProse('PALOMINO ESTATE')).toBe(false);
    expect(readsAsProse('ENZO 8.5 LUCA')).toBe(false);
    // A specification line with a full stop on the end is still a fact.
    expect(readsAsProse('Land Size 350 m2.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2 — shape alone may never excuse a line
// ---------------------------------------------------------------------------

describe('a line that could be a fact is never prose, however it is written', () => {
  const FACTS = [
    ['a sentence-shaped design', 'House Design Enzo 8.5 Luca Modern.'],
    ['a heading with no number', 'Palomino Estate release two'],
    ['money', 'Priced from $800,000'],
    ['an area unit', 'Generous blocks from 350 sqm'],
    ['a bare number', 'Block 512'],
    ['a postcode', 'Tarneit 3029'],
    ['a known heading mid-sentence', 'Ask about the availability of this release'],
  ] as const;

  it.each(FACTS)('%s is a fact, not prose', (_label, line) => {
    expect(hasSpecificationCue(line)).toBe(true);
    expect(readsAsProse(line)).toBe(false);
  });

  it('the reported defect: a design written as a sentence stands the document down', () => {
    /*
     * Six words and a full stop — prose by every measure of SHAPE, and it is
     * the house design. No colon, so nothing claims it; excused as a sentence,
     * the document completed and the design was lost for good.
     */
    const reading = readPdfBrochure([
      'Lot: 315\nEstate: Palomino Estate\nPrice: $863,850\nBedrooms: 4\n'
      + 'House Design Enzo 8.5 Luca Modern.',
    ]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('unaccounted_specification_lines');
    expect(reading.diagnostics.unaccountedLines).toBe(1);
    expect(reading.rows).toEqual([]);
  });

  const MARKETING = [
    'Discover a better way to live.',
    'Welcome to your new home.',
    'Thoughtfully crafted for the way you want to live every day.',
  ];

  it.each(MARKETING)('marketing with no cue is still ignored: %s', (line) => {
    expect(hasSpecificationCue(line)).toBe(false);
    expect(readsAsProse(line)).toBe(true);
  });

  it('a labelled brochure carrying cue-free marketing still completes', () => {
    const reading = readPdfBrochure([`${LABELLED_BROCHURE}\nDiscover a better way to live.`]);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.rows).toHaveLength(1);
  });

  it('the cue vocabulary is the existing one, never a second list', () => {
    // Every cue word here is a heading `fieldForHeader` already resolves.
    for (const heading of ['Estate', 'Design', 'Price', 'Land', 'Availability']) {
      expect(fieldForHeader(heading)).toBeTruthy();
      expect(hasSpecificationCue(`Something about the ${heading.toLowerCase()} here`)).toBe(true);
    }
  });
});

describe('an explicit brochure is read without a model', () => {
  const reading = readPdfBrochure([LABELLED_BROCHURE]);

  it('is complete and names its own strategy', () => {
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_brochure');
    expect(reading.rows).toHaveLength(1);
  });

  it('leaves nothing unaccounted — which is what admits it', () => {
    // The same property as PROBE_B, and the ONLY difference is that its
    // estate and design carry their labels. That difference is the gate.
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('recovers every field the document states, through the real normaliser', () => {
    const record = normaliseStockRow(reading.rows[0]);
    expect(record).not.toBeNull();
    expect({
      lot_number: record!.lot_number,
      development_name: record!.development_name,
      house_design: record!.house_design,
      land_size_sqm: record!.land_size_sqm,
      building_size_sqm: record!.building_size_sqm,
      bedrooms: record!.bedrooms,
      bathrooms: record!.bathrooms,
      car_spaces: record!.car_spaces,
      price: record!.price,
    }).toEqual({
      lot_number: '315',
      development_name: 'Palomino Estate',
      house_design: 'Enzo 8.5 Luca',
      land_size_sqm: 350,
      building_size_sqm: 180,
      bedrooms: 4,
      bathrooms: 2,
      car_spaces: 2,
      price: 863850,
    });
  });

  it('invents nothing the document did not label', () => {
    const record = normaliseStockRow(reading.rows[0])!;
    // The inclusions sentence is marketing, and it stays out of the record —
    // a brochure may not state its own description or availability.
    expect(record.description).toBeNull();
    expect(record.availability_status).toBe('unknown');
    expect(record.suburb).toBeNull();
    expect(record.address_line).toBeNull();
  });

  it('reads the colon form for the fields a number cannot carry', () => {
    const reading2 = readPdfBrochure([
      'Lot: 315\nEstate: Palomino Estate\nDesign: Enzo 8.5 Luca\nPrice: $863,850',
    ]);
    expect(reading2.status).toBe('complete');
    const record = normaliseStockRow(reading2.rows[0])!;
    expect({
      lot: record.lot_number, estate: record.development_name,
      design: record.house_design, price: record.price,
    }).toEqual({
      lot: '315', estate: 'Palomino Estate', design: 'Enzo 8.5 Luca', price: 863850,
    });
  });

  it('reads the inline counts through the parser that already knows them', () => {
    const reading2 = readPdfBrochure([
      'LOT 717\nEstate: Society 1056\n3 Bed 2 Bath 2 Car\nPrice: $741,655',
    ]);
    expect(reading2.status).toBe('complete');
    const record = normaliseStockRow(reading2.rows[0])!;
    expect([record.bedrooms, record.bathrooms, record.car_spaces]).toEqual([3, 2, 2]);
  });
});

// ---------------------------------------------------------------------------
// D — an omitted optional field is not invented
// ---------------------------------------------------------------------------

describe('a builder may leave an optional field out', () => {
  it('a brochure with no build size still reads, and carries none', () => {
    const reading = readPdfBrochure([
      'LOT 315\nEstate: Palomino Estate\nLand Size 350 m2\nBedrooms 4\nPrice: $863,850',
    ]);
    expect(reading.status).toBe('complete');
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.land_size_sqm).toBe(350);
    expect(record.building_size_sqm).toBeNull();
    expect(record.bathrooms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E — ambiguity refuses, and nothing is imported
// ---------------------------------------------------------------------------

describe('two answers is not an answer', () => {
  const cases: Array<[string, string, string]> = [
    ['two prices', 'LOT 315\nEstate: X\nPrice: $863,850\nPrice: $910,000',
      'conflicting_values:price'],
    ['two lots', 'LOT 315\nEstate: X\nPrice: $863,850\nLOT 316',
      'conflicting_values:lot_number'],
    ['two bedroom counts', 'LOT 315\nEstate: X\nBedrooms 4\nBedrooms 3',
      'conflicting_values:bedrooms'],
    ['counts stated two ways', 'LOT 315\nEstate: X\n3 Bed 2 Bath 2 Car\nBedrooms 4',
      'counts_stated_two_ways'],
  ];

  it.each(cases)('%s refuses and imports nothing', (_label, text, reason) => {
    const reading = readPdfBrochure([text]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe(reason);
    expect(reading.rows).toEqual([]);
    expect(reading.strategy).toBeNull();
  });

  it('the same price written twice in two notations is one price', () => {
    const reading = readPdfBrochure([
      'LOT 315\nEstate: Palomino\nPrice: $863,850\nPACKAGE PRICE 863850',
    ]);
    expect(reading.status).toBe('complete');
  });

  it('a label with no value is incomplete, not a thin import', () => {
    // The template shape: the page draws its labels and carries its values in
    // form fields we could not associate.
    const reading = readPdfBrochure([
      'LOT 315\nEstate: Palomino\nPrice: $863,850\nLand Size:',
    ]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('label_without_value:land_size_sqm');
    expect(reading.rows).toEqual([]);
  });
});

describe('prose is not a specification', () => {
  it('a sentence opening with a heading claims nothing', () => {
    // `design`, `land` and `price` are all headings this vocabulary knows.
    const reading = readPdfBrochure([
      'Design your dream home today\n'
      + 'Land sizes from 350 m2 are available now\n'
      + 'Price on application for a limited time\n'
      + 'Lot releases every month',
    ]);
    expect(reading.status).toBe('unsupported');
    expect(reading.rows).toEqual([]);
  });

  it('a document with an identity and nothing else is not a specification', () => {
    const reading = readPdfBrochure(['LOT 315\nWelcome to your new home.']);
    expect(reading.status).toBe('unsupported');
    expect(reading.reason).toBe('too_few_fields_for_a_specification');
    expect(reading.rows).toEqual([]);
  });

  it('facts with no identity are incomplete rather than a nameless property', () => {
    const reading = readPdfBrochure(['Bedrooms 4\nBathrooms 2\nPrice: $863,850']);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('no_identity_field');
  });

  it('the identity bar is stricter than the row admission test', () => {
    // `identifiesAProperty` admits a row on `suburb` alone; this must not.
    const reading = readPdfBrochure([
      'Suburb: Tarneit\nBedrooms 4\nBathrooms 2\nPrice: $863,850',
    ]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('no_identity_field');
    expect(MIN_BROCHURE_FIELDS).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// F — the schedule, from positions
// ---------------------------------------------------------------------------

describe('a PDF schedule is reconstructed from where the text was drawn', () => {
  it('splits a line into the cells the page drew', () => {
    const lines = layoutLines(SCHEDULE_ITEMS);
    const header = lines.find((line) => line.cells[0]?.text === 'ESTATE');
    expect(header?.cells.map((cell) => cell.text)).toEqual(
      ['ESTATE', 'LOT', 'DESIGN', 'BED', 'BATH', 'CAR', 'LAND', 'PRICE'],
    );
    const first = lines.find((line) => line.cells[1]?.text === '315');
    // "Palomino Estate" is ONE cell: its two runs are a word apart, not a
    // column apart.
    expect(first?.cells.map((cell) => cell.text)).toEqual(
      ['Palomino Estate', '315', 'Enzo 8.5', '4', '2', '2', '350', '$863,850'],
    );
  });

  it('keys every row through the existing header vocabulary', () => {
    const reading = assemblePdfSchedule(schedulePages(SCHEDULE_ITEMS));
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_table');
    expect(reading.rows).toHaveLength(3);

    const records = reading.rows.map((row) => normaliseStockRow(row));
    expect(records.every((record) => record !== null)).toBe(true);
    expect(records.map((record) => [
      record!.development_name, record!.lot_number, record!.house_design,
      record!.bedrooms, record!.land_size_sqm, record!.price,
    ])).toEqual([
      ['Palomino Estate', '315', 'Enzo 8.5', 4, 350, 863850],
      ['Palomino Estate', '324', 'Nex 20', 4, 420, 910000],
      ['Society 1056', '717', 'Enzo 10.5', 3, 271, 741655],
    ]);
  });

  it('a partly readable schedule imports NONE of it', () => {
    /*
     * ONE ROW THAT CAME APART. Its estate and lot cells are missing — the
     * shape a reconstruction produces when a row's left-hand runs were drawn
     * as a graphic, or fell outside the scanned item cap — so it names no
     * property. Three rows read perfectly and the document is still refused
     * whole, because importing those three and sending the document to the
     * assisted reader as well would import them twice.
     */
    expect(assemblePdfSchedule(schedulePages(SCHEDULE_ITEMS)).rows).toHaveLength(3);
    const items = [...SCHEDULE_ITEMS,
      { text: '4', x: 300, y: 628, width: 5 },
      { text: '2', x: 345, y: 628, width: 5 },
      { text: '2', x: 390, y: 628, width: 5 },
      { text: '350', x: 440, y: 628, width: 15 },
    ];
    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('a_row_could_not_be_normalised');
    expect(reading.rows).toEqual([]);
  });

  it('a TOTAL footer stands the whole schedule down', () => {
    /*
     * `normaliseStockRow` ACCEPTS this row — `identifiesAProperty` takes a
     * development name beside a figure, and its own header says the bar is
     * deliberately low. That is right for a CSV, where it is the only gate a
     * row has, and it is deliberately NOT changed: it is shared with every
     * other format. This PDF-only stage asks the stricter question instead.
     *
     * And it refuses the DOCUMENT rather than dropping the row: dropping it
     * would be this stage deciding which line of a builder's schedule is not
     * stock, and importing the other three while sending the document to the
     * assisted reader would import those three twice.
     */
    const items = [...SCHEDULE_ITEMS,
      { text: 'TOTAL', x: 40, y: 628, width: 28 },
      { text: '$2,515,505', x: 510, y: 628, width: 48 },
    ];
    const totalsRow = normaliseStockRow({ Estate: 'TOTAL', 'Package Price': '$2,515,505' });
    expect(totalsRow).not.toBeNull();          // the shared admission test takes it
    expect(totalsRow!.lot_number).toBeNull();  // and it names no property

    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('a_row_identifies_no_property');
    expect(reading.rows).toEqual([]);
    expect(reading.strategy).toBeNull();
  });

  /**
   * `LOT | DESIGN | PRICE` — the arrangement that puts a footer's word in the
   * IDENTITY column rather than beside it.
   */
  const lotColumnSchedule = (footer: string | null) => {
    const columns = [40, 160, 300];
    const rows: string[][] = [
      ['LOT', 'DESIGN', 'PRICE'],
      ['315', 'ENZO', '$800,000'],
      ['316', 'NEX', '$850,000'],
    ];
    const items: PdfTextItem[] = [];
    rows.forEach((cells, rowIndex) => {
      const y = 700 - rowIndex * 18;
      cells.forEach((text, column) => {
        items.push({ text, x: columns[column], y, width: text.length * 5 });
      });
    });
    if (footer !== null) {
      items.push({ text: footer, x: 40, y: 646, width: footer.length * 5 });
      items.push({ text: '$1,650,000', x: 300, y: 646, width: 50 });
    }
    return schedulePages(items);
  };

  it('the same schedule with no footer reads its two properties', () => {
    const reading = assemblePdfSchedule(lotColumnSchedule(null));
    expect(reading.status).toBe('complete');
    expect(reading.rows).toHaveLength(2);
    expect(reading.rows.map((row) => normaliseStockRow(row)!.lot_number)).toEqual(['315', '316']);
  });

  it.each(['TOTAL', 'TOTALS', 'SUBTOTAL', 'SUB-TOTAL', 'GRAND TOTAL', 'Summary'])(
    'a %s sitting in the LOT column stands the whole schedule down', (footer) => {
      /*
       * `normaliseStockRow` answers `lot_number: "TOTAL"`, which is present
       * and truthy — so a gate that asks only whether an identifier EXISTS is
       * satisfied by the sum of the rows above it. The word is the test.
       */
      const asProperty = normaliseStockRow({ LOT: footer, PRICE: '$1,650,000' });
      expect(asProperty).not.toBeNull();
      expect(asProperty!.lot_number).toBe(footer);

      const reading = assemblePdfSchedule(lotColumnSchedule(footer));
      expect(reading.status).toBe('incomplete');
      expect(reading.reason).toBe('a_summary_row_is_not_a_property');
      expect(reading.rows).toEqual([]);
      expect(reading.strategy).toBeNull();
    },
  );

  it('an alphanumeric lot is never mistaken for a summary marker', () => {
    // The rule is about the WORD, not the shape — builders sell `12A`,
    // `315/2` and `MC-0041`, and a numeric-only lot rule would refuse them.
    for (const lot of ['12A', '315/2', 'MC-0041', 'A1']) {
      const reading = assemblePdfSchedule(lotColumnSchedule(lot));
      expect({ lot, status: reading.status }).toEqual({ lot, status: 'complete' });
      expect(reading.rows).toHaveLength(3);
    }
  });

  it('a row with no identifier of any kind stands the schedule down', () => {
    // A "prices from" legend under the table: a price and nothing to look up.
    const items = [...SCHEDULE_ITEMS,
      { text: 'Palomino Estate', x: 40, y: 628, width: 60 },
      { text: '$741,655', x: 510, y: 628, width: 40 },
    ];
    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('a_row_identifies_no_property');
    expect(reading.rows).toEqual([]);
  });

  it('a row carrying more cells than the heading declares refuses the document', () => {
    /*
     * THE TEST THAT MAKES THE GRID SAFE. The header found eight columns; this
     * row draws a ninth run a column-width past the last of them, so the grid
     * and the data disagree about how many columns this table has. Rather
     * than folding the extra into PRICE — which is how a land price ends up
     * printed as a land size — the whole document is refused.
     */
    const items = [...SCHEDULE_ITEMS, { text: 'Titled', x: 570, y: 682, width: 26 }];
    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('two_cells_in_one_column');
    expect(reading.rows).toEqual([]);
  });

  it('a cell drawn to the left of the first column refuses the document', () => {
    const items = [...SCHEDULE_ITEMS, { text: '*', x: 20, y: 664, width: 4 }];
    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('cell_outside_every_column');
    expect(reading.rows).toEqual([]);
  });

  it('text moved INTO another column is not something geometry can catch', () => {
    /*
     * RECORDED RATHER THAN ASSERTED AWAY. A run drawn at x=305 is inside the
     * BED column as far as the page is concerned, and no reconstruction can
     * say otherwise — so the grid test above is a check that the data FITS the
     * heading, never a claim that every cell is under the right one. What
     * bounds the damage is that the result still goes through
     * `normaliseStockRow`, and that the shape this produces is vanishingly
     * unlike a real schedule.
     */
    const items = SCHEDULE_ITEMS.map((item) =>
      item.text === 'Enzo 8.5' ? { ...item, x: 305 } : item);
    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('complete');
    // The design column is empty on that row, which is what a reader sees.
    expect(normaliseStockRow(reading.rows[0])!.house_design).toBeNull();
  });

  it('table rows on a page with no heading are never dropped in silence', () => {
    const continuation = [
      { text: 'Society 1056', x: 40, y: 700, width: 60 },
      { text: '718', x: 130, y: 700, width: 15 },
      { text: 'Enzo 10.5', x: 210, y: 700, width: 45 },
      { text: '$751,655', x: 510, y: 700, width: 40 },
    ];
    const reading = assemblePdfSchedule([
      { page: 1, items: SCHEDULE_ITEMS },
      { page: 2, items: continuation },
    ]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('table_rows_on_a_page_with_no_heading');
    expect(reading.rows).toEqual([]);
  });

  it('unrecognised headings are not a table', () => {
    const items = [
      { text: 'Colour', x: 40, y: 700, width: 30 },
      { text: 'Finish', x: 200, y: 700, width: 30 },
      { text: 'Stone', x: 40, y: 682, width: 26 },
      { text: 'Honed', x: 200, y: 682, width: 30 },
    ];
    const reading = assemblePdfSchedule(schedulePages(items));
    expect(reading.status).toBe('unsupported');
    expect(reading.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G — the screen, and the orchestrator
// ---------------------------------------------------------------------------

describe('positions are read only where a schedule might be', () => {
  it('a schedule heading row is recognised on the flattened text', () => {
    expect(mayHoldSchedule([PROBE_A])).toBe(true);
  });

  it('a brochure does not pay for a second read of the document', () => {
    expect(mayHoldSchedule([PROBE_B])).toBe(false);
  });
});

describe('the orchestrator', () => {
  it('prefers the brochure when the brochure is complete, and asks for no positions', () => {
    const reading = readPdfDeterministicRows({ pageTexts: [LABELLED_BROCHURE] });
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_brochure');
  });

  it('a brochure naming a fact it did not read reaches the assisted reader', () => {
    const pageTexts = ['LOT 315\n4 BED\nPrice: $1\nLand Size 350 m2 approx'];
    for (const positionedPages of [undefined, schedulePages([])]) {
      const reading = readPdfDeterministicRows({ pageTexts, positionedPages });
      expect(reading.status).not.toBe('complete');
      expect(reading.rows).toEqual([]);
      expect(reading.strategy).toBeNull();
    }
  });

  it('falls to the schedule when the text is a table', () => {
    const reading = readPdfDeterministicRows({
      pageTexts: [PROBE_A], positionedPages: schedulePages(SCHEDULE_ITEMS),
    });
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_table');
    expect(reading.rows).toHaveLength(3);
  });

  it('a prose brochure with no positions refuses, and carries no rows', () => {
    const reading = readPdfDeterministicRows({
      pageTexts: ['Welcome to Palomino Estate. Homes designed for families.'],
    });
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
    expect(reading.strategy).toBeNull();
  });

  it('every refusal carries no rows and no strategy', () => {
    const refusals = [
      readPdfDeterministicRows({ pageTexts: [] }),
      readPdfDeterministicRows({ pageTexts: [''] }),
      readPdfDeterministicRows({ pageTexts: ['LOT 315\nPrice: $1\nPrice: $2'] }),
      readPdfDeterministicRows({ pageTexts: ['Nothing to read here at all.'] }),
    ];
    for (const reading of refusals) {
      expect(reading.status).not.toBe('complete');
      expect(reading.rows).toEqual([]);
      expect(reading.strategy).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// H — the diagnostics are safe to log
// ---------------------------------------------------------------------------

describe('diagnostics never carry what the document said', () => {
  it('a refusal reports field names and counts, and no values', () => {
    const reading = readPdfBrochure([
      'LOT 315\nEstate: Palomino Estate\nPrice: $863,850\nPrice: $910,000',
    ]);
    const serialised = JSON.stringify({
      reason: reading.reason, diagnostics: reading.diagnostics,
    });
    expect(serialised).not.toContain('863,850');
    expect(serialised).not.toContain('863850');
    expect(serialised).not.toContain('Palomino');
    expect(serialised).not.toContain('315');
    expect(reading.diagnostics.conflictField).toBe('price');
  });
});

// ---------------------------------------------------------------------------
// The brochure a builder actually uploads
// ---------------------------------------------------------------------------

/**
 * A NORMAL BUILDER BROCHURE, in the shape a PDF sets one.
 *
 * Not a table and not a run of `Label: value` lines. Its identity is a
 * heading, its counts sit one per line beside their icons, and each of its
 * measurements is a label with the figure set UNDER it. Every one of those
 * is an explicit statement; none of them was readable before.
 *
 * `ENZO 8.5 LUCA` and `PALOMINO` are deliberately left bare. A reader that
 * decided which of the two is the design and which the estate would be
 * guessing, so both stay unread — and the document still completes on what it
 * states in terms this vocabulary knows.
 */
const BUILDER_BROCHURE = [
  'LOT 315', '', 'ENZO 8.5 LUCA', '', 'PALOMINO', '',
  '4 BED', '2 BATH', '2 CAR', '',
  'LAND', '350 m²', '',
  'HOUSE', '210 m²', '',
  'PACKAGE PRICE', '$863,850',
].join('\n');

describe('a normal builder brochure is read without a model', () => {
  const reading = readPdfBrochure([BUILDER_BROCHURE]);

  it('completes, where before it refused', () => {
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_brochure');
    expect(reading.rows).toHaveLength(1);
  });

  it('recovers every fact the document states, through the real normaliser', () => {
    const record = normaliseStockRow(reading.rows[0])!;
    expect({
      lot_number: record.lot_number,
      bedrooms: record.bedrooms,
      bathrooms: record.bathrooms,
      car_spaces: record.car_spaces,
      land_size_sqm: record.land_size_sqm,
      building_size_sqm: record.building_size_sqm,
      price: record.price,
    }).toEqual({
      lot_number: '315',
      bedrooms: 4,
      bathrooms: 2,
      car_spaces: 2,
      land_size_sqm: 350,
      building_size_sqm: 210,
      price: 863850,
    });
  });

  it('invents neither the design nor the estate, and says how many it could not place', () => {
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.house_design).toBeNull();
    expect(record.development_name).toBeNull();
    expect(record.availability_status).toBe('unknown');
    // `ENZO 8.5 LUCA` and `PALOMINO` — reported, never guessed at.
    expect(reading.diagnostics.unclassifiedLines).toBe(2);
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('the unit under a label resolves the label, through the existing table', () => {
    /*
     * `HOUSE` alone is the DESIGN in this vocabulary, deliberately. Set above
     * `210 m²` it is the house's area, and `house m2` is a spelling the alias
     * table already knows — so the two lines resolve through it rather than
     * through a mapping invented here.
     */
    expect(fieldForHeader('house')).toBe('house_design');
    expect(fieldForHeader('house m2')).toBe('building_size_sqm');
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.building_size_sqm).toBe(210);
    expect(record.house_design).toBeNull();
  });

  it('a figure under a descriptive label is refused, never written into it', () => {
    // No unit can rescue `DESIGN`, so the pair is refused and the document
    // stands down rather than recording "210 m²" as the home's design.
    const reading2 = readPdfBrochure([
      ['LOT 315', 'Bedrooms', '4', 'Price', '$800,000', 'DESIGN', '210 m²'].join('\n'),
    ]);
    expect(reading2.status).toBe('incomplete');
    expect(reading2.reason).toBe('label_without_value:house_design');
    expect(reading2.rows).toEqual([]);
  });

  it('a heading directly under a heading is a layout, not a statement', () => {
    const reading2 = readPdfBrochure([['LOT 315', 'LAND', 'HOUSE', 'Price: $1'].join('\n')]);
    expect(reading2.status).not.toBe('complete');
    expect(reading2.rows).toEqual([]);
  });
});

describe('counts set one per line', () => {
  it('three separate count lines are three fields, not three answers to one', () => {
    /*
     * THE FIRST THING THE READER REFUSED on a real brochure. Each line was
     * claimed as the combined `bed_bath_car` cell, so `2 BATH` contradicted
     * `4 BED` and a plain document answered `conflicting_values`.
     */
    const reading = readPdfBrochure([['LOT 315', '4 BED', '2 BATH', '2 CAR'].join('\n')]);
    expect(reading.status).toBe('complete');
    const record = normaliseStockRow(reading.rows[0])!;
    expect([record.bedrooms, record.bathrooms, record.car_spaces]).toEqual([4, 2, 2]);
  });

  it('the same count repeated across pages corroborates', () => {
    const reading = readPdfBrochure([
      ['LOT 315', '4 BED', '2 BATH', 'Price: $863,850'].join('\n'),
      ['LOT 315', '4 BED'].join('\n'),
      ['LOT 315', '4 BED', '2 BATH'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    const record = normaliseStockRow(reading.rows[0])!;
    expect([record.bedrooms, record.bathrooms]).toEqual([4, 2]);
  });

  it('the same count stated twice with two figures still conflicts', () => {
    const reading = readPdfBrochure([['LOT 315', '4 BED', 'Price: $1', '3 BED'].join('\n')]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('conflicting_values:bedrooms');
    expect(reading.rows).toEqual([]);
  });

  it('a line naming more than one count still goes to the shared parser', () => {
    const reading = readPdfBrochure([['LOT 717', 'Estate: Society 1056', '3 Bed 2 Bath 2 Car'].join('\n')]);
    expect(reading.status).toBe('complete');
    const record = normaliseStockRow(reading.rows[0])!;
    expect([record.bedrooms, record.bathrooms, record.car_spaces]).toEqual([3, 2, 2]);
  });
});

describe('identity is never invented for a direct upload', () => {
  it('a design-only brochure with no lot refuses', () => {
    /*
     * A LINKED row already knows its lot and uses the brochure only to
     * corroborate. A direct upload has no such external fact, so a document
     * that names only its design must not become a property.
     */
    const reading = readPdfBrochure([
      ['Design: Enzo 8.5 Luca', '4 BED', '2 BATH', 'LAND', '350 m²'].join('\n'),
    ]);
    expect(reading.status).not.toBe('complete');
    expect(reading.reason).toBe('no_identity_field');
    expect(reading.rows).toEqual([]);
  });

  it('two lots with nothing separating them refuses rather than taking the first', () => {
    const reading = readPdfBrochure([
      ['LOT 315', '4 BED', 'LAND', '350 m²'].join('\n'),
      ['LOT 410', '3 BED', 'LAND', '280 m²'].join('\n'),
    ]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('conflicting_values:lot_number');
    expect(reading.rows).toEqual([]);
  });

  it('facts from two properties can never reach one row', () => {
    // Every conflicting field refuses the whole document, so there is no
    // arrangement in which Lot A's number meets Lot B's price.
    const reading = readPdfBrochure([
      ['LOT 315', 'Price: $863,850'].join('\n'),
      ['LOT 410', 'Price: $910,000'].join('\n'),
    ]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.rows).toEqual([]);
  });
});

describe('a fact we can see and did not read still refuses', () => {
  it('a recognised label beside a value we could not take', () => {
    const reading = readPdfBrochure([
      ['LOT 315', '4 BED', 'Price: $1', 'Land Size 350 m2 approx'].join('\n'),
    ]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('unaccounted_specification_lines');
    expect(reading.rows).toEqual([]);
  });

  it('a label set on its own with nothing pairable under it', () => {
    const reading = readPdfBrochure([['LOT 315', 'Bedrooms', '4', 'Land Size'].join('\n')]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('label_without_value:land_size_sqm');
    expect(reading.rows).toEqual([]);
  });
});

describe('a specification line is not a heading row', () => {
  it.each([
    ['counts beside their figures', '4 BED 2 BATH 2 CAR'],
    ['labels beside their figures', 'LAND 350 HOUSE 210 PRICE'],
    ['a configuration sentence', '3 Bed 2 Bath 2 Car Double Garage'],
  ])('%s does not send a brochure for a positional read', (_label, line) => {
    expect(mayHoldSchedule([line])).toBe(false);
  });

  it('a real heading row still does', () => {
    expect(mayHoldSchedule(['ESTATE LOT DESIGN BED BATH CAR LAND PRICE'])).toBe(true);
    expect(mayHoldSchedule(['Estate Lot Design Beds Baths Cars Land m2 Price'])).toBe(true);
  });
});
