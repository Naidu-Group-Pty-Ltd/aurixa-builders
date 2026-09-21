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
  isIncidentalContent,
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
 * Every line of it resolves, which is what `complete` means: nothing here was
 * ignored on a judgement about its shape.
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
   * IT READS WHAT THE DOCUMENT LABELS AND INVENTS NOTHING FROM WHAT IT DOES
   * NOT — and that, not refusal, is the property that matters.
   *
   * THIS BLOCK ASSERTED A REFUSAL, and the change is deliberate. `PALOMINO
   * ESTATE` carries its own field word, so the document labels it and the
   * estate is read. `ENZO 8.5 LUCA` carries nothing, and no rule here will
   * decide what it is — so `house_design` stays EMPTY. What changed is
   * whether that unread line stands the whole property down, and the real
   * seven-page brochure settled it: a document that must account for every
   * line can never finish one, because a brochure is a floor plan and an
   * inclusions list as well as a property. An unread line blocks when it
   * could make this the wrong property or contradict the deal; a name this
   * reader cannot place does neither.
   */
  it('reads the estate the document named, and never guesses the design', () => {
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.fieldsRead).toContain('development_name');
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
    expect(normaliseStockRow(reading.rows[0])!.house_design).toBeNull();
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    // The inclusions sentence is declined by name rather than counted.
    expect(reading.diagnostics.declinedFields).toEqual(['description']);
  });

  it('the line it could not place is reported rather than acted on', () => {
    expect(reading.diagnostics.ignoredLines ?? 0).toBeGreaterThan(0);
    const record = normaliseStockRow(reading.rows[0])!;
    // Nothing on the page leaked into a field it does not belong to.
    expect(record.development_name).toBe('PALOMINO ESTATE');
    expect(record.project_name).toBeNull();
    expect(record.description).toBeNull();
  });

  it('the bare lines are not prose, and are not furniture either', () => {
    expect(readsAsProse('PALOMINO ESTATE')).toBe(false);
    expect(readsAsProse('ENZO 8.5 LUCA')).toBe(false);
    expect(isIncidentalContent('PALOMINO ESTATE')).toBe(false);
    expect(isIncidentalContent('ENZO 8.5 LUCA')).toBe(false);
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
    // It is never excused as prose, and it never becomes the design.
    expect(readsAsProse('House Design Enzo 8.5 Luca Modern.')).toBe(false);
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
    if (reading.rows.length) {
      expect(normaliseStockRow(reading.rows[0])!.house_design).toBeNull();
    }
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

  it('a blank field on a form states nothing, and stands nothing down', () => {
    /*
     * THIS ASSERTED A REFUSAL, and the builder's own siting plan is why it
     * no longer does. Page 2 of the production brochures draws
     * `Site Address:` and `Estate:` side by side and leaves `Estate:`
     * EMPTY, because nobody typed in it. Lot 315 survived only because its
     * page 1 states `Palomino Estate` elsewhere; Lot 717's estate carries
     * no field word, nothing claimed it, and an empty box on a form threw
     * the whole property away.
     *
     * A label with nothing after it cannot contradict a fact, cannot make
     * this a different property and cannot fill a field.
     */
    const reading = readPdfBrochure([
      'LOT 315\nEstate: Palomino\nPrice: $863,850\nLand Size:',
    ]);
    expect(reading.status).toBe('complete');
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.land_size_sqm).toBeNull();
    expect(record.development_name).toBe('Palomino');
    expect(record.price).toBe(863850);
  });

  it('and the blank is counted rather than silently discarded', () => {
    const reading = readPdfBrochure([
      'LOT 315\nEstate: Palomino\nPrice: $863,850\nLand Size:',
    ]);
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.diagnostics.ignoredLines ?? 0).toBeGreaterThan(0);
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
    const pageTexts = ['LOT 315\n4 BED\nEstate: Palomino\nPrice: $716,675\nPrice $375,000 deposit'];
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
 * measurements is a label with the figure set UNDER it. Every one of those is
 * an explicit statement; none of them was readable before.
 *
 * `ENZO 8.5 LUCA` and `PALOMINO` are bare, and this reader may not decide
 * which is the design and which the estate. So this document does not
 * complete — it goes to the reader that can tell them apart.
 */
const BUILDER_BROCHURE = [
  'LOT 315', '', 'ENZO 8.5 LUCA', '', 'PALOMINO', '',
  '4 BED', '2 BATH', '2 CAR', '',
  'LAND', '350 m²', '',
  'HOUSE', '210 m²', '',
  'PACKAGE PRICE', '$863,850',
].join('\n');

/**
 * THE SAME BROCHURE WITH ITS TWO BARE LINES LABELLED, and with the furniture
 * a real one carries — a phone number, a copyright line, a web address, a
 * page number and a marketing sentence.
 *
 * This is what `complete` is for: every line of the document is read into a
 * field or recognised as something the document says about itself.
 */
const LABELLED_PACKAGE_BROCHURE = [
  'LOT 315', '',
  'DESIGN', 'ENZO 8.5 LUCA', '',
  'ESTATE', 'PALOMINO', '',
  '4 BED', '2 BATH', '2 CAR', '',
  'LAND', '350 m²', '',
  'HOUSE', '210 m²', '',
  'PACKAGE PRICE', '$863,850', '',
  'Discover a better way to live.',
  'Ph 1300 123 456',
  'www.acmehomes.com.au',
  '© 2026 Acme Homes. Prices subject to change without notice.',
  'Page 1 of 2',
].join('\n');

describe('a brochure that leaves two lines unread does not suppress the model', () => {
  const reading = readPdfBrochure([BUILDER_BROCHURE]);

  it('reads every labelled fact and leaves the two names it cannot place', () => {
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.fieldsRead).toContain('price');
    expect(reading.diagnostics.fieldsRead).toContain('building_size_sqm');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    // `ENZO 8.5 LUCA` and `PALOMINO` are reported, never assigned.
    expect(reading.diagnostics.ignoredLines ?? 0).toBeGreaterThanOrEqual(2);
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.house_design).toBeNull();
    expect(record.development_name).toBeNull();
  });
});

describe('a brochure whose every line is accounted for is read without a model', () => {
  const reading = readPdfBrochure([LABELLED_PACKAGE_BROCHURE]);

  it('completes, where before it refused', () => {
    expect(reading.status).toBe('complete');
    expect(reading.strategy).toBe('pdf_deterministic_brochure');
    expect(reading.rows).toHaveLength(1);
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('recovers every fact the document states, through the real normaliser', () => {
    const record = normaliseStockRow(reading.rows[0])!;
    expect({
      lot_number: record.lot_number,
      house_design: record.house_design,
      development_name: record.development_name,
      bedrooms: record.bedrooms,
      bathrooms: record.bathrooms,
      car_spaces: record.car_spaces,
      land_size_sqm: record.land_size_sqm,
      building_size_sqm: record.building_size_sqm,
      price: record.price,
    }).toEqual({
      lot_number: '315',
      house_design: 'ENZO 8.5 LUCA',
      development_name: 'PALOMINO',
      bedrooms: 4,
      bathrooms: 2,
      car_spaces: 2,
      land_size_sqm: 350,
      building_size_sqm: 210,
      price: 863850,
    });
  });

  it('the furniture cost it nothing, and is counted rather than ignored quietly', () => {
    // The sentence, the phone number, the web address, the copyright line
    // and the page number: five lines, none of them about this property.
    expect(reading.diagnostics.incidentalLines).toBe(5);
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
    // And the design came from the line the document labelled `DESIGN`.
    expect(record.house_design).toBe('ENZO 8.5 LUCA');
  });

  it('a figure under a descriptive label is refused, never written into it', () => {
    // No unit can rescue `DESIGN`, so the pair is refused — and the design
    // stays empty. The label states nothing, so it stands nothing down.
    const reading2 = readPdfBrochure([
      ['LOT 315', 'Bedrooms', '4', 'Price', '$800,000', 'DESIGN', '210 m²'].join('\n'),
    ]);
    expect(reading2.diagnostics.fieldsRead).not.toContain('house_design');
    if (reading2.rows.length) {
      expect(normaliseStockRow(reading2.rows[0])!.house_design).toBeNull();
    }
  });

  it('a heading directly under a heading is a layout, not a statement', () => {
    const reading2 = readPdfBrochure([['LOT 315', 'LAND', 'HOUSE', 'Price: $1'].join('\n')]);
    expect(reading2.status).not.toBe('complete');
    expect(reading2.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A LABEL AND ITS VALUE NEVER MEET ACROSS A PAGE BREAK
// ---------------------------------------------------------------------------

describe('vertical pairing is page-local', () => {
  /*
   * The page break is the document's own evidence that two lines were not
   * set together. A flattened array would let the last line of one page take
   * the first line of the next as its value — a measurement read off a
   * different page, which is worse than no measurement at all.
   */
  it('a label at the foot of a page does not take the top of the next', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'HOUSE'].join('\n'),
      ['210 m²', 'Price: $800,000'].join('\n'),
    ]);
    // The pair is never made across the break, so no building size is read.
    expect(reading.diagnostics.fieldsRead).not.toContain('building_size_sqm');
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
  });

  it('the same two lines on ONE page are a pair', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'HOUSE', '210 m²', 'Price: $800,000'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.building_size_sqm).toBe(210);
  });
});

// ---------------------------------------------------------------------------
// WHAT A DOCUMENT SAYS ABOUT ITSELF
// ---------------------------------------------------------------------------

describe('incidental content does not stand a document down', () => {
  const FURNITURE = [
    'Ph 1300 123 456',
    'Phone: 03 9123 4567',
    'Mobile 0412 345 678',
    '+61 3 9123 4567',
    'sales@acmehomes.com.au',
    'E sales@acmehomes.com.au',
    'www.acmehomes.com.au',
    'https://acmehomes.com.au/stock',
    'acmehomes.com.au',
    'Page 3 of 7',
    '© 2026 Acme Homes Pty Ltd',
    'ABN 12 345 678 901',
    'All rights reserved.',
    'Builder licence no. 123456',
    'Images are for illustrative purposes only.',
    "Artist's impression. Not to scale.",
    'Prices subject to change without notice.',
  ];

  it.each(FURNITURE)('%s is the document talking about itself', (line) => {
    expect(isIncidentalContent(line)).toBe(true);
  });

  const FACTS = [
    'PALOMINO',
    'ENZO 8.5 LUCA',
    'LOT 315',
    '350 m²',
    '$863,850',
    '4 2 2 350 863850',
    'Land Size 350 m2 approx',
    'Ph',
    'Website',
  ];

  it.each(FACTS)('%s is not furniture, so it is the caller\'s problem', (line) => {
    expect(isIncidentalContent(line)).toBe(false);
  });

  it('a specification run of digits is never read as a telephone number', () => {
    // The reason an unlabelled number must OPEN the way a published number
    // opens: this line is a bed/bath/car/land/price row, not a phone.
    expect(isIncidentalContent('4 2 2 350 863850')).toBe(false);
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

  it('the same count stated twice with two figures loses the count, not the property', () => {
    /*
     * THIS BLOCK ASSERTED A REFUSAL, and the sibling brochure for Lot 717 is
     * why it no longer does. A disagreement about a DESCRIPTION of the
     * property says nothing about WHICH property it is, and throwing the lot,
     * the street, the design, the estate and the price away over it sent a
     * legible document to a model. The count is dropped rather than chosen
     * between — whichever came first is an accident of page order.
     */
    const reading = readPdfBrochure([
      ['LOT 315', 'Estate: Palomino', '4 BED', 'Price: $1', '3 BED'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.bedrooms).toBeNull();
    expect(reading.diagnostics.disputedFields).toEqual(['bedrooms']);
  });

  it('but two prices, two lots or two designs still refuse', () => {
    const cases: Array<[string, string]> = [
      ['Price: $863,850\nPrice: $910,000', 'conflicting_values:price'],
      ['LOT 316', 'conflicting_values:lot_number'],
      ['Design: Enzo 8.5\nDesign: Nex 20', 'conflicting_values:house_design'],
    ];
    for (const [tail, reason] of cases) {
      const reading = readPdfBrochure([
        ['LOT 315', 'Estate: Palomino', 'Price: $863,850', tail].join('\n'),
      ]);
      expect({ tail, status: reading.status, reason: reading.reason })
        .toEqual({ tail, status: 'ambiguous', reason });
      expect(reading.rows).toEqual([]);
    }
  });

  /*
   * THE ESTATE LEFT THAT LIST. It named a PLACE, not the property and not
   * the deal, so two of them cannot mean the wrong one of either — and the
   * lot, which can, still refuses immediately above. The estate is dropped
   * and the rest of the document stands.
   */
  it('and two estates drop the estate instead', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Estate: Palomino', 'Price: $863,850',
        'Land Size: 350m2', 'Estate: Society 1056'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(reading.rows).toHaveLength(1);
    expect(reading.rows[0].development_name ?? null).toBeNull();
    expect(normaliseStockRow(reading.rows[0])!.price).toBe(863850);
  });

  it('one measurement written twice at two precisions is one measurement', () => {
    /*
     * THE DEFECT THE SIBLING BROCHURE FOUND. A builder's marketing page
     * rounds and the siting plan is exact — Lot 315 states `Lot Size 321m²`
     * and `Site Area: 320.72 m²` about the same lot. The finer reading is
     * kept; a disagreement in a digit the coarser figure actually states is
     * still a disagreement.
     */
    const agree = readPdfBrochure([
      ['LOT 315', 'Estate: Palomino', 'Price: $1',
        'Land Size: 321 m2', 'Land Size: 320.72 m2'].join('\n'),
    ]);
    expect(agree.status).toBe('complete');
    expect(normaliseStockRow(agree.rows[0])!.land_size_sqm).toBe(320.72);
    expect(agree.diagnostics.disputedFields).toBeUndefined();

    const differ = readPdfBrochure([
      ['LOT 315', 'Estate: Palomino', 'Price: $1',
        'Build Size: 117.50 m2', 'Build Size: 119.16 m2'].join('\n'),
    ]);
    expect(normaliseStockRow(differ.rows[0])!.building_size_sqm).toBeNull();
    expect(differ.diagnostics.disputedFields).toEqual(['building_size_sqm']);
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
  it('a MATERIAL label beside a value we could not take still blocks', () => {
    // A second price stated in terms this reader cannot take may be the deal
    // contradicting itself, and it cannot tell without reading it.
    const reading = readPdfBrochure([
      ['LOT 315', '4 BED', 'Estate: Palomino', 'Price: $716,675',
        'Price $375,000 deposit'].join('\n'),
    ]);
    expect(reading.status).toBe('incomplete');
    expect(reading.reason).toBe('unaccounted_specification_lines');
    expect(reading.rows).toEqual([]);
  });

  it('but an optional measurement it could not take does not', () => {
    // A land size says nothing about WHICH property this is.
    const reading = readPdfBrochure([
      ['LOT 315', '4 BED', 'Estate: Palomino', 'Price: $716,675',
        'Land Size 350 m2 approx'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.lot_number).toBe('315');
  });

  it('a label set on its own with nothing pairable under it claims nothing', () => {
    const reading = readPdfBrochure([['LOT 315', 'Bedrooms', '4', 'Land Size'].join('\n')]);
    expect(reading.diagnostics.fieldsRead).not.toContain('land_size_sqm');
    if (reading.rows.length) {
      expect(normaliseStockRow(reading.rows[0])!.land_size_sqm).toBeNull();
    }
  });
});

describe('a specification line is not a heading row', () => {
  /*
   * A VALUE IS ANYTHING THAT OPENS WITH A FIGURE.
   *
   * The first version of this screen admitted a bare number only, which is
   * the one spelling a builder's brochure does not use: `350m²`, `210m2`,
   * `$863,850` and `4-bed` all state a value, all reached three recognised
   * words, and all were read as a heading row — which sent the document for
   * a positional read, where the schedule parser refused it with a table's
   * refusal and masked the brochure reading underneath.
   */
  it.each([
    ['counts beside their figures', '4 BED 2 BATH 2 CAR'],
    ['labels beside their figures', 'LAND 350 HOUSE 210 PRICE'],
    ['a configuration sentence', '3 Bed 2 Bath 2 Car Double Garage'],
    ['an area with its unit attached', 'LAND 350m² HOUSE 210m2 PRICE'],
    ['an area written sqm', 'Land 350sqm House 210sqm Package Price'],
    ['a price with its currency', 'Lot 315 Design Enzo Price $863,850'],
    ['hyphenated counts', 'Lot 315 Design Enzo 4-bed 2-bath 2-car'],
  ])('%s does not send a brochure for a positional read', (_label, line) => {
    expect(mayHoldSchedule([line])).toBe(false);
  });

  it('a real heading row still does, because a heading never opens with a figure', () => {
    expect(mayHoldSchedule(['ESTATE LOT DESIGN BED BATH CAR LAND PRICE'])).toBe(true);
    expect(mayHoldSchedule(['Estate Lot Design Beds Baths Cars Land m2 Price'])).toBe(true);
    expect(mayHoldSchedule(['Lot Design Land m² House m² Package Price'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE BROCHURE'S OWN STRUCTURE IS WHAT IDENTIFIES IT
// ---------------------------------------------------------------------------

/**
 * A brochure is not a spreadsheet, and the three ways it says what a line IS.
 *
 * None of these is a guess about which bare line is the design: in every one
 * of them the DOCUMENT says so — by putting the field's own word inside the
 * name, by captioning the name, by drawing the label beside or above it, or
 * by stating it again somewhere else with one of those. A document that does
 * none of them still refuses, and that case is asserted last.
 */
const CELL = (text: string, x: number, y: number): PdfTextItem =>
  ({ text, x, y, width: text.length * 5 });

const SPEC = ['4 BED', '2 BATH', '2 CAR', 'LAND', '350 m²', 'HOUSE', '210 m²',
  'PACKAGE PRICE', '$863,850'];

const readRecord = (reading: ReturnType<typeof readPdfBrochure>) =>
  normaliseStockRow(reading.rows[0])!;

describe('1 — a design the document names inside its own line', () => {
  const reading = readPdfBrochure([
    ['LOT 315', 'ENZO 8.5 LUCA DESIGN', 'PALOMINO ESTATE', ...SPEC].join('\n'),
  ]);

  it('completes, and the design is the line the document labelled', () => {
    expect(reading.status).toBe('complete');
    expect(readRecord(reading).house_design).toBe('ENZO 8.5 LUCA DESIGN');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('nothing is stripped from a builder’s own name', () => {
    // `Estate` is part of `Palomino Estate`; `Design` after a design name is
    // a caption. No rule can tell those apart, so the line stands as printed.
    expect(readRecord(reading).development_name).toBe('PALOMINO ESTATE');
  });

  it('a heading in the MIDDLE of a line names nothing', () => {
    // `Land Size 350 m2` is a specification, not a name ending in a field —
    // so it never becomes a development or a design.
    const reading2 = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Price: $1', 'Land Size 350 m2 approx'].join('\n'),
    ]);
    expect(reading2.diagnostics.fieldsRead).not.toContain('development_name');
    expect(reading2.diagnostics.fieldsRead).not.toContain('house_design');
  });

  it('a sentence that happens to end in a field word is not a name', () => {
    // `Welcome to Palomino Estate` has a lowercase function word in it, which
    // a proper name does not — the typography of the page, not a word list.
    // It claims nothing; what it must never do is become the estate.
    const reading2 = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Price: $1', 'Welcome to Palomino Estate'].join('\n'),
    ]);
    expect(reading2.diagnostics.fieldsRead).not.toContain('development_name');
    if (reading2.rows.length) {
      expect(normaliseStockRow(reading2.rows[0])!.development_name).toBeNull();
    }
  });

  it('a label row of nothing but headings claims nothing', () => {
    const reading2 = readPdfBrochure([['LOT 315', 'PACKAGE PRICE', 'LAND SIZE'].join('\n')]);
    expect(reading2.status).not.toBe('complete');
    expect(reading2.diagnostics.fieldsRead).not.toContain('development_name');
    expect(reading2.diagnostics.fieldsRead).not.toContain('house_design');
  });
});

describe('2 — an estate the document captions under its name', () => {
  const reading = readPdfBrochure([
    ['LOT 315', 'ENZO 8.5 LUCA', 'HOME DESIGN', 'PALOMINO', 'ESTATE', ...SPEC].join('\n'),
  ]);

  it('reads both identities from the captions the page set', () => {
    expect(reading.status).toBe('complete');
    const record = readRecord(reading);
    expect({ design: record.house_design, estate: record.development_name })
      .toEqual({ design: 'ENZO 8.5 LUCA', estate: 'PALOMINO' });
  });

  it('and still reads everything else, through the real normaliser', () => {
    const record = readRecord(reading);
    expect({
      lot: record.lot_number, beds: record.bedrooms, baths: record.bathrooms,
      cars: record.car_spaces, land: record.land_size_sqm,
      build: record.building_size_sqm, price: record.price,
    }).toEqual({
      lot: '315', beds: 4, baths: 2, cars: 2, land: 350, build: 210, price: 863850,
    });
  });

  it('a caption never reads a figure or a price as a name', () => {
    // `$863,850` above `LOT` must not become a lot number, and `350 m²`
    // above `DESIGN` must not become a design.
    const reading2 = readPdfBrochure([['$863,850', 'LOT', '350 m²', 'DESIGN'].join('\n')]);
    expect(reading2.status).not.toBe('complete');
    expect(reading2.diagnostics.fieldsRead).not.toContain('lot_number');
    expect(reading2.diagnostics.fieldsRead).not.toContain('house_design');
  });

  it('a column of labels over values is never read upwards', () => {
    // LAND/350 and HOUSE/210 pair downwards; the caption rule is tried last
    // and can never take `350 m²` as a caption for `HOUSE`.
    const reading2 = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'LAND', '350 m²', 'HOUSE', '210 m²'].join('\n'),
    ]);
    expect(reading2.status).toBe('complete');
    const record = readRecord(reading2);
    expect([record.land_size_sqm, record.building_size_sqm]).toEqual([350, 210]);
  });
});

describe('3 — a bare line the document states again, with evidence', () => {
  /*
   * THE SHAPE A SEVEN-PAGE BROCHURE ACTUALLY HAS. The cover carries the
   * names bare; a later page carries them with their field words. Only the
   * later page says what they are, and the cover's copies are the same fact
   * printed twice.
   */
  const reading = readPdfBrochure([
    ['LOT 315', 'ENZO 8.5 LUCA', 'PALOMINO', '4 BED', '2 BATH', '2 CAR'].join('\n'),
    ['LAND', '350 m²', 'HOUSE', '210 m²', 'PACKAGE PRICE', '$863,850'].join('\n'),
    ['PALOMINO ESTATE', 'ENZO 8.5 LUCA DESIGN', 'Ph 1300 123 456'].join('\n'),
  ]);

  it('completes, with both identities read from the page that evidenced them', () => {
    expect(reading.status).toBe('complete');
    const record = readRecord(reading);
    expect({ design: record.house_design, estate: record.development_name })
      .toEqual({ design: 'ENZO 8.5 LUCA DESIGN', estate: 'PALOMINO ESTATE' });
  });

  it('the cover’s bare copies are counted as repeats, never as new facts', () => {
    expect(reading.diagnostics.corroboratedLines).toBe(2);
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('a bare line NOTHING evidences fills no field', () => {
    // `LUCA MODERN` is a facade nothing in the document names. It is
    // reported and ignored — and it never becomes the design.
    const reading2 = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'Bedrooms: 4', 'Price: $1', 'LUCA MODERN'].join('\n'),
    ]);
    expect(reading2.diagnostics.fieldsRead).not.toContain('house_design');
    expect(reading2.diagnostics.ignoredLines ?? 0).toBeGreaterThan(0);
  });

  it('a digit shared with a measurement corroborates nothing', () => {
    const reading2 = readPdfBrochure([
      ['LOT 315', 'Land Size: 350', 'Price: $1', 'Bedrooms: 4', '350 SOMETHING'].join('\n'),
    ]);
    // Whatever it does with the line, it may not read it as a second size.
    expect(normaliseStockRow(reading2.rows[0] ?? {})?.land_size_sqm ?? 350).toBe(350);
  });
});

describe('4 and 5 — two designs, or two estates, refuse', () => {
  it('two designs is the document declining to say which', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'ENZO 8.5 LUCA DESIGN', 'NEX 20 DESIGN',
        'Price: $1'].join('\n'),
    ]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('conflicting_values:house_design');
    expect(reading.rows).toEqual([]);
  });

  /*
   * TWO ESTATES IS NOT THE SAME KIND OF DISAGREEMENT, and this assertion was
   * renegotiated rather than adjusted.
   *
   * A design names the HOUSE and a price names the DEAL, so two of either can
   * mean the wrong one. An estate is a PLACE CONTAINING many properties; the
   * lot identifies one, and a document describing two properties would
   * conflict on the lot. So the estate is dropped, nothing is chosen between,
   * and the estate reads as not stated.
   *
   * THE DOCUMENT STILL DOES NOT IMPORT, which is the part worth asserting:
   * with the estate gone this fixture states a lot and a price and no longer
   * clears `MIN_BROCHURE_FIELDS`, so it refuses for what it actually lacks
   * rather than for a contradiction it never had. A thin document is still
   * refused; it is refused honestly.
   */
  it('two estates drop the estate rather than refusing the document', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'SOCIETY RISE ESTATE', 'Price: $1'].join('\n'),
    ]);
    expect(reading.reason).not.toBe('conflicting_values:development_name');
    expect(reading.status).toBe('unsupported');
    expect(reading.reason).toBe('too_few_fields_for_a_specification');
    expect(reading.rows).toEqual([]);
  });

  it('and where the rest of the document is enough, it imports without one', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'SOCIETY RISE ESTATE',
        'Home Design: Enzo 8.5', 'Land Size: 350m2', 'Price: $662,900'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(reading.rows).toHaveLength(1);
    expect(reading.rows[0].development_name ?? null).toBeNull();
  });

  it('the same name stated twice corroborates rather than conflicting', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'Bedrooms: 4', 'Price: $863,850'].join('\n'),
      ['PALOMINO ESTATE', 'LOT 315'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(readRecord(reading).development_name).toBe('PALOMINO ESTATE');
  });

  it('two lots in one document still refuse', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'Price: $1'].join('\n'),
      ['LOT 324', 'PALOMINO ESTATE', 'Price: $2'].join('\n'),
    ]);
    expect(reading.status).toBe('ambiguous');
    expect(reading.rows).toEqual([]);
  });
});

describe('6 and 7 — a heading and a company are not a property', () => {
  it('a marketing heading does not become the design', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'YOUR NEW HOME AWAITS', 'Bedrooms: 4',
        'Price: $1'].join('\n'),
    ]);
    // Nothing named it, so nothing claims it — the design stays empty.
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
    if (reading.rows.length) {
      expect(normaliseStockRow(reading.rows[0])!.house_design).toBeNull();
    }
  });

  it('a builder’s own name is the publisher, not the estate', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'ENZO 8.5 LUCA DESIGN', 'Bedrooms: 4',
        'Price: $863,850', 'ACME HOMES'].join('\n'),
    ], { organisationName: 'Acme Homes Pty Ltd' });
    expect(reading.status).toBe('complete');
    expect(readRecord(reading).development_name).toBe('PALOMINO ESTATE');
    expect(reading.diagnostics.incidentalLines).toBe(1);
  });

  it('and without knowing the organisation it is still never a field', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'PALOMINO ESTATE', 'ENZO 8.5 LUCA DESIGN', 'Bedrooms: 4',
        'Price: $863,850', 'ACME HOMES'].join('\n'),
    ]);
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.development_name).toBe('PALOMINO ESTATE');
    expect(record.house_design).toBe('ENZO 8.5 LUCA DESIGN');
  });
});

describe('8 — the positions the page drew its text at', () => {
  /*
   * WHAT ONLY THE LAYOUT CAN SAY. Flattened, a two-column block is two
   * labels over two values and the pairing is unrecoverable; a label beside
   * its value is one string. Both are ordinary brochure furniture.
   */
  const TWO_COLUMN: PdfTextItem[] = [
    CELL('LOT 315', 40, 760),
    CELL('ENZO 8.5 LUCA', 40, 720), CELL('DESIGN', 40, 700),
    CELL('PALOMINO', 40, 660), CELL('ESTATE', 40, 640),
    CELL('4 BED', 40, 600), CELL('2 BATH', 140, 600), CELL('2 CAR', 240, 600),
    CELL('LAND', 40, 560), CELL('HOUSE', 240, 560),
    CELL('350 m²', 40, 540), CELL('210 m²', 240, 540),
    CELL('PACKAGE PRICE', 40, 500), CELL('$863,850', 240, 500),
  ];
  const FLATTENED = ['LOT 315', 'ENZO 8.5 LUCA', 'DESIGN', 'PALOMINO', 'ESTATE',
    '4 BED 2 BATH 2 CAR', 'LAND HOUSE', '350 m² 210 m²',
    'PACKAGE PRICE $863,850'].join('\n');

  it('the flattened reading cannot pair a two-column block, and takes neither', () => {
    const reading = readPdfBrochure([FLATTENED]);
    // `LAND HOUSE` over `350 m² 210 m²` is unpairable, so no size is read —
    // which is the point: a wrong measurement is worse than none.
    expect(reading.diagnostics.fieldsRead).not.toContain('land_size_sqm');
    expect(reading.diagnostics.fieldsRead).not.toContain('building_size_sqm');
  });

  it('the positioned reading pairs each column with its own value', () => {
    const reading = readPdfBrochure([FLATTENED],
      { positionedPages: [{ page: 1, items: TWO_COLUMN }] });
    expect(reading.status).toBe('complete');
    const record = readRecord(reading);
    expect({
      lot: record.lot_number, design: record.house_design,
      estate: record.development_name, beds: record.bedrooms,
      baths: record.bathrooms, cars: record.car_spaces,
      land: record.land_size_sqm, build: record.building_size_sqm,
      price: record.price,
    }).toEqual({
      lot: '315', design: 'ENZO 8.5 LUCA', estate: 'PALOMINO',
      beds: 4, baths: 2, cars: 2, land: 350, build: 210, price: 863850,
    });
  });

  it('a label drawn BESIDE its value is read as the pair it is', () => {
    const beside: PdfTextItem[] = [
      CELL('LOT 315', 40, 760),
      CELL('DESIGN', 40, 720), CELL('ENZO 8.5 LUCA', 200, 720),
      CELL('ESTATE', 40, 690), CELL('PALOMINO', 200, 690),
      CELL('LAND', 40, 660), CELL('350 m²', 200, 660),
      CELL('PRICE', 40, 630), CELL('$863,850', 200, 630),
    ];
    const reading = readPdfBrochure(
      [['LOT 315', 'DESIGN ENZO 8.5 LUCA', 'ESTATE PALOMINO', 'LAND 350 m²',
        'PRICE $863,850'].join('\n')],
      { positionedPages: [{ page: 1, items: beside }] },
    );
    expect(reading.status).toBe('complete');
    const record = readRecord(reading);
    expect({ design: record.house_design, estate: record.development_name,
      land: record.land_size_sqm, price: record.price })
      .toEqual({ design: 'ENZO 8.5 LUCA', estate: 'PALOMINO',
        land: 350, price: 863850 });
  });

  it('a column never pairs with a value in a DIFFERENT column', () => {
    // `LAND` at x=40 and `210 m²` at x=240 are not a pair, whatever order
    // the flattened stream puts them in — so no land size is read.
    const split: PdfTextItem[] = [
      CELL('LOT 315', 40, 760),
      CELL('Bedrooms: 4', 40, 730),
      CELL('LAND', 40, 700), CELL('210 m²', 240, 680),
    ];
    const reading = readPdfBrochure([['LOT 315', 'Bedrooms: 4', 'LAND', '210 m²'].join('\n')],
      { positionedPages: [{ page: 1, items: split }] });
    expect(reading.diagnostics.fieldsRead).not.toContain('land_size_sqm');
  });

  it('a page the layout reader could not decode falls back to its text', () => {
    const reading = readPdfBrochure(
      [['LOT 315', 'PALOMINO ESTATE', 'Bedrooms: 4', 'Price: $1'].join('\n')],
      { positionedPages: [{ page: 1, items: [] }] },
    );
    expect(reading.status).toBe('complete');
  });

  it('positions never cross a page boundary either', () => {
    const first: PdfTextItem[] = [CELL('LOT 315', 40, 760), CELL('HOUSE', 40, 40)];
    const second: PdfTextItem[] = [CELL('210 m²', 40, 760), CELL('Price: $1', 40, 700)];
    const reading = readPdfBrochure(
      [['LOT 315', 'HOUSE'].join('\n'), ['210 m²', 'Price: $1'].join('\n')],
      { positionedPages: [{ page: 1, items: first }, { page: 2, items: second }] },
    );
    expect(reading.diagnostics.fieldsRead).not.toContain('building_size_sqm');
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
  });
});

describe('9 — a summary row is still not a property, in either mode', () => {
  it('a heading over a footer cell does not become a lot number', () => {
    const items: PdfTextItem[] = [
      CELL('LOT', 40, 700), CELL('LAND', 140, 700), CELL('PRICE', 240, 700),
      CELL('TOTAL', 40, 680), CELL('4200', 140, 680), CELL('$12,000,000', 240, 680),
    ];
    const reading = readPdfBrochure([['LOT LAND PRICE', 'TOTAL 4200 $12,000,000'].join('\n')],
      { positionedPages: [{ page: 1, items }] });
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE REAL LOT 315 BROCHURE PROVED
// ---------------------------------------------------------------------------

/**
 * Every fixture below is the SHAPE of the production document
 * `LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf`, measured by running the
 * real bytes through this reader. Nothing here is invented: the geometry,
 * the run splits and the wording are what the page actually carries.
 */
describe('the filename classifies what the document says, and nothing more', () => {
  const PAGE = (extra: string[] = []) => [
    'Lot 315 Central Boulevard',
    'Palomino Estate, Armstrong Creek',
    'Package Price - $716,675',
    'Titles: December 2026',
    ...extra,
  ].join('\n');

  it('1 — corroborates a design the PDF already prints', () => {
    const reading = readPdfBrochure([PAGE(['Enzo 8.5'])],
      { filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf' });
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.house_design).toBe('Enzo 8.5');
  });

  it('2 — cannot invent a design the PDF never prints', () => {
    const reading = readPdfBrochure([PAGE()],
      { filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf' });
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
    expect(normaliseStockRow(reading.rows[0])!.house_design).toBeNull();
  });

  it('3 — a filename lot that disagrees with the document refuses outright', () => {
    const reading = readPdfBrochure([PAGE(['Enzo 8.5'])],
      { filename: 'LOT 324 - ENZO 8.5 LUCA - BROCHURE V002.pdf' });
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('filename_lot_disagrees_with_document');
    expect(reading.rows).toEqual([]);
  });

  it('3a — and it will not classify while the estate is still in question', () => {
    const reading = readPdfBrochure([
      ['Lot 315 Central Boulevard', 'Package Price - $716,675',
        'Titles: December 2026', 'Enzo 8.5'].join('\n'),
    ], { filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf' });
    // Two unplaced names and no settled estate: either could be either.
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
  });

  it('3b — nor when the document offers two names the filename echoes', () => {
    const reading = readPdfBrochure([PAGE(['Enzo 8.5', 'Luca'])],
      { filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf' });
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
  });
});

describe('a brochure is a floor plan and an inclusions list too', () => {
  const FLOOR_PLAN = ['Robe', 'Kitchen', 'Linen', 'Ensuite', 'LDRY', 'Porch',
    'Bath', 'Garage', 'Terrace', 'Meals/Living', 'Bed 1', 'Bed 2', 'Bed 3'];
  const INCLUSIONS = ['•', 'Low Profile Concrete Rooftiles', '•',
    'Stone benchtops throughout', '•', 'Boundary Fencing including Gate.',
    '•', 'Window Furnishings & Flyscreens.'];

  const withNoise = (noise: string[]) => readPdfBrochure([
    ['Lot 315 Central Boulevard', 'Palomino Estate, Armstrong Creek',
      'Home Design: ENZO 8.5 - MODERN', 'Package Price - $716,675',
      'Site Area: 321m2', ...noise].join('\n'),
  ]);

  it('4 — a floor plan’s room names do not stand the property down', () => {
    const reading = withNoise(FLOOR_PLAN);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.diagnostics.ignoredLines ?? 0).toBeGreaterThan(0);
  });

  it('5 — nor do inclusions bullets and specification copy', () => {
    const reading = withNoise(INCLUSIONS);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('5a — and a room label never becomes a count', () => {
    const reading = withNoise(FLOOR_PLAN);
    const record = normaliseStockRow(reading.rows[0])!;
    // `Bed 1`, `Bed 2`, `Bed 3` are rooms. Three bedrooms is not stated.
    expect(record.bedrooms).toBeNull();
    expect(record.bathrooms).toBeNull();
    expect(record.car_spaces).toBeNull();
  });

  it('5b — a garage AREA is never read as a number of car spaces', () => {
    const reading = withNoise(['Garage: 22.59m2']);
    expect(normaliseStockRow(reading.rows[0])!.car_spaces).toBeNull();
  });

  it('6 — but a canonical fact it could not read still blocks', () => {
    const reading = withNoise(['Price $375,000']);
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
  });

  it('6a — and two statements of one field are still ambiguous', () => {
    const reading = withNoise(['Home Design: NEX 20']);
    expect(reading.status).toBe('ambiguous');
    expect(reading.reason).toBe('conflicting_values:house_design');
    expect(reading.rows).toEqual([]);
  });

  it('6b — a price breakdown beside the package price is not a contradiction', () => {
    // `Land Price` and `Build Price` are compounds this vocabulary has no
    // column for. Reading the `Land` in one as a land size is what stood the
    // real document down.
    const reading = withNoise(['Land Price - $375,000', 'Build Price - $341,675']);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.price).toBe(716675);
  });
});

describe('the counts are in the icons, and the icons are pictures', () => {
  const ICON_ROW = readPdfBrochure([
    ['Lot 315 Central Boulevard', 'Palomino Estate, Armstrong Creek',
      'Home Design: ENZO 8.5 - MODERN', 'Package Price - $716,675',
      '3', '2', '1'].join('\n'),
  ]);

  it('7 — three bare digits are never assigned by their order', () => {
    const record = normaliseStockRow(ICON_ROW.rows[0])!;
    expect([record.bedrooms, record.bathrooms, record.car_spaces])
      .toEqual([null, null, null]);
  });

  it('8 — and a visual-only attribute does not force a model', () => {
    expect(ICON_ROW.status).toBe('complete');
    expect(ICON_ROW.rows).toHaveLength(1);
    expect(ICON_ROW.diagnostics.visualOnlyFields)
      .toEqual(['bathrooms', 'bedrooms', 'car_spaces']);
  });

  it('8a — a count the document WRITES is still read', () => {
    const reading = readPdfBrochure([
      ['Lot 315 Central Boulevard', 'Palomino Estate, Armstrong Creek',
        'Bedrooms: 3', 'Bathrooms 2', '1 CAR', 'Package Price - $716,675'].join('\n'),
    ]);
    const record = normaliseStockRow(reading.rows[0])!;
    expect([record.bedrooms, record.bathrooms, record.car_spaces]).toEqual([3, 2, 1]);
    expect(reading.diagnostics.visualOnlyFields).toBeUndefined();
  });
});

describe('9 — the whole Lot 315 shape, as the page draws it', () => {
  /*
   * THE MEASURED GEOMETRY OF PAGE 1, run for run. Every x, width and height
   * below was read off the production document: the design split as
   * `Enzo 8` + `.5`, the lot split as `Lot` + a space run + `3` + `15`, and
   * the land size as `321` + `m` + a raised `2` three units up at 58% of
   * the type size. None of it is readable from the flattened page.
   */
  const item = (
    text: string, x: number, y: number, width: number, height: number,
  ): PdfTextItem => ({ text, x, y, width, height });

  const ITEMS: PdfTextItem[] = [
    item('Enzo 8', 28.4, 777.3, 81.7, 30), item('.5', 110.1, 777.3, 22.1, 30),
    item('Package Price - $', 29.4, 642.0, 151.9, 22),
    item('716,675', 185.0, 642.0, 70.0, 22),
    item('Lot', 28.8, 604.0, 30.6, 24), item(' ', 59.4, 604.0, 4.1, 24),
    item('3', 63.6, 604.0, 13.5, 24), item('15', 76.8, 604.0, 22.3, 24),
    item(' ', 99.1, 604.0, 4.1, 24),
    item('Central Boulevard', 103.2, 604.0, 167.0, 24),
    item('Palomino Estate, Armstrong Creek', 28.8, 575.2, 317.8, 24),
    item('Titles:', 28.8, 546.4, 54.1, 24),
    item('December 2026', 90.0, 546.4, 120.0, 24),
    item('Lot Size', 27.3, 190.2, 41.1, 14),
    item('321', 27.3, 168.9, 14.5, 10), item('m', 41.6, 168.9, 7.4, 10),
    item('2', 48.9, 172.3, 3.0, 5.8),
    item('Bed 3', 405.6, 417.3, 16.3, 6.7),
    item('Robe', 466.0, 306.6, 14.0, 6.7),
  ];
  const FLAT = ['Enzo 8.5', 'Package Price - $716,675', 'Lot 315 Central Boulevard',
    'Palomino Estate, Armstrong Creek', 'Titles: December 2026',
    'Lot Size', '321m', '2', 'Bed 3', 'Robe'].join('\n');

  const reading = readPdfBrochure([FLAT],
    { positionedPages: [{ page: 1, items: ITEMS }],
      filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf' });

  it('completes, and reads every fact the page states', () => {
    expect(reading.status).toBe('complete');
    const record = normaliseStockRow(reading.rows[0])!;
    expect({
      lot: record.lot_number, design: record.house_design,
      estate: record.development_name, land: record.land_size_sqm,
      price: record.price, titles: record.expected_completion,
    }).toEqual({
      lot: '315', design: 'Enzo 8.5', estate: 'Palomino Estate',
      land: 321, price: 716675, titles: 'December 2026',
    });
  });

  it('the runs of a split number and a raised unit are put back together', () => {
    // `Lot` `3` `15` is `Lot 315`, and `321` `m` `²` is `321m²`. Neither is
    // readable from the flattened page, and both are what the page drew.
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.lot_number).toBe('315');
    expect(record.land_size_sqm).toBe(321);
  });

  it('and the floor plan is ignored rather than acted on', () => {
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(normaliseStockRow(reading.rows[0])!.bedrooms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WHAT THE DOCUMENT IS ABOUT IS NEVER GUESSED AT
// ---------------------------------------------------------------------------

describe('a material line this reader cannot name stands the document down', () => {
  /*
   * A LINE THIS READER CANNOT PLACE NEVER BECOMES A FIELD, and that is the
   * property these assert. Whether it also stands the document down is a
   * different question, answered by whether it could make this the WRONG
   * property — and a name nothing identifies cannot.
   */
  const MATERIAL = [
    ['a bare name', 'PALOMINO'],
    ['a bare design', 'ENZO 8.5 LUCA'],
    ['a name with a number in it', 'Society 1056'],
    ['a short phrase with no cue', 'SALES OFFICE'],
  ];

  it.each(MATERIAL)('%s fills no identity field', (_label, line) => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Bathrooms: 2', 'Price: $800,000', line].join('\n'),
    ]);
    if (reading.rows.length) {
      const record = normaliseStockRow(reading.rows[0])!;
      expect(record.house_design).toBeNull();
      expect(record.development_name).toBeNull();
      expect(record.project_name).toBeNull();
    }
    expect(reading.diagnostics.fieldsRead).not.toContain('house_design');
    expect(reading.diagnostics.fieldsRead).not.toContain('development_name');
  });

  it('a MATERIAL fact the document states and this reader missed still blocks', () => {
    // A second lot leads the line and puts its number beside it. That may be
    // a different property, and this reader cannot tell without reading it.
    const reading = readPdfBrochure([
      ['LOT 315', 'Estate: Palomino', 'Bedrooms: 4', 'Price: $800,000',
        'Lot 316A also released this weekend'].join('\n'),
    ]);
    expect(reading.status).not.toBe('complete');
    expect(reading.rows).toEqual([]);
  });

  it('an optional measurement it missed does NOT block', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Estate: Palomino', 'Bedrooms: 4', 'Price: $800,000',
        'Land Size 350 m2 approximately per contract'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(normaliseStockRow(reading.rows[0])!.price).toBe(800000);
  });

  it('the same document without that line completes', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Bathrooms: 2', 'Price: $800,000'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
  });

  it('and furniture in its place still completes', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Bathrooms: 2', 'Price: $800,000',
        'Ph 1300 123 456', '© 2026 Acme Homes', 'Page 2 of 6',
        'Your new home starts here.'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.diagnostics.incidentalLines).toBe(4);
  });

  it('an inclusions paragraph is declined by name, not counted against it', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Price: $800,000',
        'Full turnkey inclusions: landscaping, driveway and fencing.',
        'Status: Selling now'].join('\n'),
    ]);
    expect(reading.status).toBe('complete');
    expect(reading.diagnostics.unaccountedLines).toBe(0);
    expect(reading.diagnostics.declinedFields)
      .toEqual(['availability_status', 'description']);
    // And neither reached the row.
    const record = normaliseStockRow(reading.rows[0])!;
    expect(record.description).toBeNull();
    expect(record.availability_status).toBe('unknown');
  });

  it('a figure beside an inclusions label is still never read as a field', () => {
    const reading = readPdfBrochure([
      ['LOT 315', 'Bedrooms: 4', 'Price: $800,000',
        'Inclusions include 2 living areas'].join('\n'),
    ]);
    expect(reading.diagnostics.fieldsRead).not.toContain('description');
    if (reading.rows.length) {
      expect(normaliseStockRow(reading.rows[0])!.description).toBeNull();
    }
  });
});
