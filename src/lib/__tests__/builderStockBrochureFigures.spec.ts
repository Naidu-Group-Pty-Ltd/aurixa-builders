/**
 * WHAT A PROPERTY'S OWN BROCHURE MAY SAY ABOUT ITS FIGURES — the rules
 * `brochureFigures.pure.ts` decides and the SQL enforces, pinned.
 *
 * MEASURED 25 SEPTEMBER 2026: the live stock list has no floor-area column
 * (69 of 70 properties drew "—" for home size) while every row links its own
 * brochure, which states it. The held-out fixture `heldout-a-sheet-with-no-
 * floor-area-whose-brochures-state-it` proves the path end to end; these pin
 * the decisions it turns on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DESIGN_FIGURE_FIELDS, DOCUMENT_FIGURES_VERSION, decideDocumentFigures, documentFigureFallback,
  documentStanding, parseBrochureFigureEvidence, retryDelaySeconds, wantsPicture,
  type BrochureFigureEvidence,
} from '../../../supabase/functions/_shared/builderStock/brochureFigures.pure';
import {
  FIGURES_PROTOCOL, OLDEST_PDF_ELECTION_PROTOCOL, decodeElectionContext, encodeElectionContext,
  encodeFigureContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** A reading as the product's own reader returns it for a measured brochure. */
const evidence = (row: Record<string, unknown> | null, extra: Partial<BrochureFigureEvidence> = {}):
BrochureFigureEvidence => ({
  reading: { status: row ? 'complete' : 'ambiguous', rows: row ? [row] : [], reason: null },
  presentsDesign: false,
  figures: [],
  outlines: [],
  ...extra,
});

const ENZO_927 = {
  lot_number: '927', bedrooms: '3', bathrooms: '2', car_spaces: '2',
  building_size_sqm: '129.5m2', land_size_sqm: '294m2', price: '$780,050',
};

describe('how a document stands to the property it is linked from', () => {
  it('stating this lot, it may give every figure', () => {
    const decision = decideDocumentFigures({
      evidence: evidence(ENZO_927),
      property: { lot_number: '927', house_design: 'Enzo 10.5' },
    });
    expect(decision.standing).toBe('this_lot');
    expect(decision.values).toEqual({
      bedrooms: 3, bathrooms: 2, car_spaces: 2, building_size_sqm: 129.5, land_size_sqm: 294,
    });
  });

  it('another lot of the same design gives the design\'s figures, never the land', () => {
    // Measured: Lot 1728 · Nex 20 links Lot 1629's brochure.
    const decision = decideDocumentFigures({
      evidence: evidence({ ...ENZO_927, lot_number: '1002' }, { presentsDesign: true }),
      property: { lot_number: '1004', house_design: 'Enzo 10.5' },
    });
    expect(decision.standing).toBe('same_design');
    expect(Object.keys(decision.values).sort()).toEqual([...DESIGN_FIGURE_FIELDS].sort());
    expect(decision.values.land_size_sqm).toBeUndefined();
  });

  it('another lot that does not present this design gives nothing', () => {
    const decision = decideDocumentFigures({
      evidence: evidence({ ...ENZO_927, lot_number: '1002' }),
      property: { lot_number: '1004', house_design: 'Enzo 10.5' },
    });
    expect(decision.standing).toBe('none');
    expect(decision.values).toEqual({});
  });

  it('this lot under another design gives nothing: one of the two is wrong', () => {
    expect(documentStanding(evidence({ ...ENZO_927, house_design: 'Elara 18' }),
      { lot_number: '927', house_design: 'Enzo 10.5' }).standing).toBe('none');
  });

  it('a lot the builder confirmed counts as this lot only where the document presents this design', () => {
    // Their own brochure with its lot mistyped: the design is theirs.
    expect(documentStanding(evidence({ ...ENZO_927, lot_number: '1307' }, { presentsDesign: true }),
      { lot_number: '1037', house_design: 'Vanta 20', confirmedLots: ['1307'] }).standing)
      .toBe('this_lot');
    // A sibling of another design whose photograph they chose to show:
    // measured, Lot 1447 · Nex 20 shows Lot 1744 · Cura 20B's.
    expect(documentStanding(evidence({ ...ENZO_927, lot_number: '1744' }),
      { lot_number: '1447', house_design: 'Nex 20', confirmedLots: ['1744'] }).standing)
      .toBe('none');
  });

  it('a schedule of several properties, or a reading that stood down, gives nothing', () => {
    const two: BrochureFigureEvidence = {
      ...evidence(ENZO_927), reading: { status: 'complete', rows: [ENZO_927, ENZO_927], reason: null },
    };
    expect(decideDocumentFigures({ evidence: two, property: { lot_number: '927', house_design: null } })
      .values).toEqual({});
    expect(decideDocumentFigures({ evidence: evidence(null, { presentsDesign: true }),
      property: { lot_number: '927', house_design: 'Enzo 10.5' } }).values).toEqual({});
  });
});

describe('what counts as a figure', () => {
  it('a figure outside what a house can be is a misreading, and is dropped', () => {
    const decision = decideDocumentFigures({
      evidence: evidence({ ...ENZO_927, building_size_sqm: '12950m2', car_spaces: '40' }),
      property: { lot_number: '927', house_design: null },
    });
    expect(decision.values.building_size_sqm).toBeUndefined();
    expect(decision.values.car_spaces).toBeUndefined();
    expect(decision.values.bedrooms).toBe(3);
  });

  it('the area schedule\'s picture fills the floor area only, and only where the text gave none', () => {
    const noArea = evidence({ ...ENZO_927, building_size_sqm: undefined }, {
      figures: [{ page: 1, objectNumber: 9, width: 600, height: 300, start: 1, end: 2,
        flate: false, drawn: null, sha256: 'a'.repeat(64) }],
    });
    const property = { lot_number: '927', house_design: null };
    const first = decideDocumentFigures({ evidence: noArea, property });
    expect(wantsPicture(noArea, first)).toBe(true);
    const withPicture = decideDocumentFigures({
      evidence: noArea, property,
      picture: { state: 'read', buildingSizeSqm: '178.23', provedBy: ['parts'], page: 1 },
    });
    expect(withPicture.values.building_size_sqm).toBe(178.23);
    expect(withPicture.readBy.building_size_sqm).toBe('picture');
    // The text's own figure is never displaced by a picture.
    const stated = decideDocumentFigures({
      evidence: evidence(ENZO_927), property,
      picture: { state: 'read', buildingSizeSqm: '999.00', provedBy: ['parts'], page: 1 },
    });
    expect(stated.values.building_size_sqm).toBe(129.5);
  });
});

describe('what a re-read of a silent stock list keeps', () => {
  const record = {
    v: 1, document: 'https://drive.google.com/file/d/x/view', state: 'read',
    values: { building_size_sqm: 191.7, car_spaces: 2 }, read_at: '2026-09-25T00:00:00Z',
  };

  it('puts the brochure\'s figure back rather than blanking it', () => {
    expect(documentFigureFallback(record, 'building_size_sqm')).toBe(191.7);
    expect(documentFigureFallback(record, 'car_spaces')).toBe(2);
  });

  it('keeps nothing the brochure did not state, and nothing from a read that learned nothing', () => {
    expect(documentFigureFallback(record, 'land_size_sqm')).toBeNull();
    expect(documentFigureFallback(record, 'price')).toBeNull();
    expect(documentFigureFallback({ ...record, state: 'retry' }, 'building_size_sqm')).toBeNull();
    expect(documentFigureFallback(null, 'building_size_sqm')).toBeNull();
  });

  it('the importer consults it exactly where a re-read unsays a column', () => {
    const importer = read('supabase/functions/_shared/builderStock/importStock.ts');
    expect(importer).toMatch(/patch\[column\] = documentFigureFallback\(options\.documentFigures, column\);/);
    expect(importer).toContain("house_design:source_row->>house_design, document_figures'");
  });
});

describe('the wire', () => {
  it('a figures question is protocol 4 and carries nothing that names a property', () => {
    const wire = decodeElectionContext(encodeFigureContext({
      design: 'Enzo 10.5', documentName: 'the linked document', url: 'https://example.invalid/b.pdf',
    }));
    expect(wire?.protocol).toBe(FIGURES_PROTOCOL);
    expect(wire?.purpose).toBe('figures');
    expect(wire?.label).toBe('figures');
    expect(wire?.identityHints).toEqual([]);
  });

  it('an election is never asked as figures, and figures never under an election protocol', () => {
    const election = decodeElectionContext(encodeElectionContext({
      label: 'Lot 927', identifiedBy: 'direct_link', documentName: 'd', url: 'u',
    }));
    expect(election?.protocol).toBe(OLDEST_PDF_ELECTION_PROTOCOL);
    expect(election?.purpose).toBeUndefined();
    const tamper = (patch: Record<string, unknown>) => {
      const raw = JSON.parse(atob(encodeFigureContext({ documentName: 'd', url: 'u' })));
      return decodeElectionContext(btoa(JSON.stringify({ ...raw, ...patch })));
    };
    expect(tamper({ protocol: OLDEST_PDF_ELECTION_PROTOCOL })).toBeNull();
    expect(tamper({ purpose: undefined })).toBeNull();
  });

  it('evidence is re-checked field by field, never trusted', () => {
    expect(parseBrochureFigureEvidence(null)).toBeNull();
    expect(parseBrochureFigureEvidence({ reading: { status: 'complete' } })).toBeNull();
    const parsed = parseBrochureFigureEvidence({
      reading: { status: 'complete', rows: [ENZO_927, 'junk'], reason: 5 },
      presentsDesign: 'yes', figures: [{ page: 'x' }], outlines: 'nope',
    });
    expect(parsed?.reading.rows).toHaveLength(1);
    expect(parsed?.reading.reason).toBeNull();
    expect(parsed?.presentsDesign).toBe(false);
    expect(parsed?.figures).toEqual([]);
    expect(parsed?.outlines).toEqual([]);
  });
});

describe('the SQL answers to the same rules', () => {
  const sql = read('supabase/migrations/20260925120000_a_brochure_fills_what_its_stock_list_left_out.sql');

  it('the version the claim asks under is the one this build writes', () => {
    expect(sql).toMatch(new RegExp(
      `builder_stock_document_figures_version\\(\\)\\s*RETURNS integer LANGUAGE sql IMMUTABLE AS \\$\\$ SELECT ${DOCUMENT_FIGURES_VERSION} \\$\\$`));
  });

  it('a figure fills only a column that is still empty, or one this document filled before', () => {
    for (const column of ['bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm']) {
      expect(sql).toContain(`AND (${column} IS NULL OR ${column} = (v_prev ->> '${column}')::numeric)`);
    }
  });

  it('the record\'s shape states key presence before key type', () => {
    const at = (needle: string) => sql.indexOf(needle);
    expect(at("document_figures ? 'v'")).toBeGreaterThan(0);
    expect(at("document_figures ? 'v'")).toBeLessThan(at("jsonb_typeof(document_figures -> 'v')"));
    expect(at("document_figures ? 'document'")).toBeLessThan(at("jsonb_typeof(document_figures -> 'document')"));
  });

  it('the figure reader is a signed internal worker, declared and reviewed', () => {
    const fn = read('supabase/functions/builder-stock-figure-reader/index.ts');
    expect(fn).toContain('verifyInternal(supabase, req, bounded.raw)');
    expect(read('supabase/config.toml')).toMatch(/\[functions\.builder-stock-figure-reader\]\nverify_jwt = false/);
  });
});

describe('a read that learned nothing', () => {
  it('backs off, doubling, and never past a day', () => {
    expect(retryDelaySeconds(1)).toBe(300);
    expect(retryDelaySeconds(2)).toBe(600);
    expect(retryDelaySeconds(20)).toBe(24 * 3600);
  });
});

describe('an area schedule whose labels and values the page sets apart', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const load = () => import('../../../supabase/functions/_shared/builderStock/areaSchedule.pure');

  it('pairs a run of labels with a run of values only where the values prove it', async () => {
    const { readAreaScheduleTotalFromLines } = await load();
    // Measured: the production VG18 cover.
    const vg18 = ['House Specifications', 'Ground Floor:', 'Garage:', 'Porch:', 'Total:',
      'Lot Size', '313m2', 'Exposed aggregate paving', '132.75m2', '36.05m2', '4.04m2', '172.84m2']
      .join('\n');
    expect(readAreaScheduleTotalFromLines([vg18])).toEqual({ value: '172.84m2', parts: 3 });
    // The same lists whose parts do not add to the total are not a schedule.
    expect(readAreaScheduleTotalFromLines([vg18.replace('4.04m2', '9.04m2')])).toBeNull();
    // Nor are lists of different lengths.
    expect(readAreaScheduleTotalFromLines([vg18.replace('4.04m2\n', '')])).toBeNull();
  });

  it('reads the inline form under the same proof, and a land or price list never', async () => {
    const { readAreaScheduleTotalFromLines } = await load();
    const inline = 'Ground Floor: 132.75m2\nGarage: 36.05m2\nPorch: 4.04m2\nTotal: 172.84m2';
    expect(readAreaScheduleTotalFromLines([inline])?.value).toBe('172.84m2');
    expect(readAreaScheduleTotalFromLines(['Lot 1: 300m2\nLot 2: 320m2\nTotal: 620m2'])).toBeNull();
    // Two different schedules in one document state no one total.
    const other = inline.replace('132.75', '140.75').replace('172.84', '180.84');
    expect(readAreaScheduleTotalFromLines([inline, other])).toBeNull();
  });
});

describe('the builder is told which figures the brochure supplied', () => {
  const record = {
    v: 1, document: 'https://drive.google.com/file/d/x/view', state: 'read',
    values: { building_size_sqm: 172.84, car_spaces: 2, land_size_sqm: 300 },
    read_at: '2026-09-25T00:00:00Z',
  };

  it('names a figure the stock list did not state and the property still carries', async () => {
    const { figuresSuppliedByDocument } = await import(
      '../../../supabase/functions/_shared/builderStock/brochureFigures.pure');
    expect(figuresSuppliedByDocument({
      documentFigures: record,
      row: { building_size_sqm: '172.84', car_spaces: 2, land_size_sqm: 313 },
      // The sheet stated its own car count; the land now differs.
      sourceRow: { car_spaces: 2, building_size_sqm: null },
    })).toEqual(['building_size_sqm']);
    // A figure the builder typed in is theirs.
    expect(figuresSuppliedByDocument({
      documentFigures: record, row: { building_size_sqm: 172.84 }, sourceRow: {},
      stated: ['building_size_sqm'],
    })).toEqual([]);
  });

  it('says so on the card, beside what the stock list did not specify', async () => {
    const { describeManualStats } = await import('@/lib/builderStock');
    const reading = describeManualStats({
      id: 'x', suburb: 'Tarneit', bedrooms: 4, bathrooms: 2, car_spaces: null,
      building_size_sqm: 172.84, land_size_sqm: 313,
      document_figure_fields: ['building_size_sqm'],
    } as never);
    expect(reading.note).toContain('Not specified in your stock list: car spaces.');
    expect(reading.note).toMatch(/Read from the brochure: home/);
  });
});
