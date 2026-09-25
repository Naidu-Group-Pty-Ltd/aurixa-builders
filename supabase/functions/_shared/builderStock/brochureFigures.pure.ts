/**
 * BUILDER STOCK — WHAT A PROPERTY'S OWN BROCHURE MAY SAY ABOUT ITS FIGURES.
 *
 * WHY THIS EXISTS. Measured 25 September 2026 (`stock-field-coverage`): the one
 * live stock list, a Google Sheet of seventy properties, has NO floor-area
 * column, so 69 of them drew "—" for home size, and it leaves the car count
 * blank on its twenty dual-key rows. Every one of those rows links its own
 * brochure — the image ladder already opens it and takes its photograph from
 * it — and that brochure prints the figures the sheet does not. Run through the
 * product's own deterministic reader (`stock-brochure-figures`), 43 of the 69
 * give a building size from their text, and the area-schedule OCR that already
 * serves an uploaded PDF gives eight more. Nothing carried a single one of them
 * onto the row.
 *
 * THE RULES, and each is a refusal rather than a guess.
 *
 *   A FIGURE COMES ONLY FROM A DOCUMENT THE PRODUCT ALREADY JUDGED THIS
 *   PROPERTY'S. The caller reads only a link whose stored answer is a
 *   photograph delivered (`image_recovered`) — the photograph election has
 *   already held that document to the property's identity. Nothing here
 *   widens which documents count.
 *
 *   A LOT'S FIGURES FROM THIS LOT, A DESIGN'S FROM THIS DESIGN. A brochure is
 *   often typeset for one specimen lot and linked from every lot selling the
 *   design — measured: Lot 1728 · Nex 20 shows Lot 1629's brochure. Bedrooms,
 *   bathrooms, car spaces and the house's floor area belong to the DESIGN, so
 *   they may come from any brochure that presents this design. The land size
 *   belongs to the LOT and comes only from a brochure that states this lot.
 *   One that states neither this lot nor this design gives nothing.
 *
 *   ONE PROPERTY, OR NOTHING. The reading must be `complete` with exactly one
 *   row — two rows is a schedule, and pairing a schedule's rows to a property
 *   by position is how a figure lands on the wrong lot.
 *
 *   A FIGURE ONLY EVER FILLS AN ABSENCE. The stock list is the builder's own
 *   word and outranks its brochure; a figure the builder typed into "Complete
 *   the schedule" outranks both. The fill itself is done in SQL, conditioned on
 *   the column still being empty, so a stock list that states the figure
 *   between the read and the write still wins.
 *
 * Pure: no IO, no clock, no network.
 */
import { normaliseStockRow } from './normalise.pure.ts';
import { readPdfFigures, type FigureVerdict, type PdfFigure } from './pdfFigures.pure.ts';
import { readPdfOutlineFigures, type PdfOutlineFigure } from './pdfOutlineFigures.pure.ts';

/**
 * Bumped when what a reading may fill changes, so every property is read
 * again under the new rule. The SQL claim reads the same number through
 * `builder_stock_document_figures_version()`, and a spec holds them equal.
 */
export const DOCUMENT_FIGURES_VERSION = 1;

/** What a design states: the same for every lot that sells it. */
export const DESIGN_FIGURE_FIELDS = [
  'bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm',
] as const;
/** What only the lot's own document may state. */
export const LOT_FIGURE_FIELDS = ['land_size_sqm'] as const;
export const DOCUMENT_FIGURE_FIELDS = [...DESIGN_FIGURE_FIELDS, ...LOT_FIGURE_FIELDS] as const;
export type DocumentFigureField = typeof DOCUMENT_FIGURE_FIELDS[number];

/**
 * How a document relates to the property it is linked from.
 *
 *   `this_lot`     it states this property's lot (or a lot the builder
 *                  confirmed it may state) and no other design
 *   `same_design`  it presents this property's design, and states another lot
 *                  or none
 *   `none`         neither — or it states this lot under another design
 */
export type DocumentStanding = 'this_lot' | 'same_design' | 'none';

/** What the worker reads out of the document, as it travels back. */
export interface BrochureFigureEvidence {
  reading: {
    status: string;
    /** Raw, keyed by canonical field: exactly what the import normalises. */
    rows: Array<Record<string, unknown>>;
    reason: string | null;
  };
  /** The document presents the property's design as its own package page. */
  presentsDesign: boolean;
  /** Pictures that may print the house's area schedule, never decoded there. */
  figures: PdfFigure[];
  /** Blocks of type painted as shapes, for the same question. */
  outlines: PdfOutlineFigure[];
}

/** The evidence as it arrived over the wire, or null if it is not exactly that. */
export function parseBrochureFigureEvidence(stored: unknown): BrochureFigureEvidence | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const e = stored as Record<string, unknown>;
  const reading = e.reading as Record<string, unknown> | undefined;
  if (!reading || typeof reading !== 'object' || typeof reading.status !== 'string') return null;
  if (!Array.isArray(reading.rows)) return null;
  const rows = reading.rows.filter((row): row is Record<string, unknown> =>
    !!row && typeof row === 'object' && !Array.isArray(row));
  return {
    reading: {
      status: reading.status,
      rows,
      reason: typeof reading.reason === 'string' ? reading.reason : null,
    },
    presentsDesign: e.presentsDesign === true,
    figures: readPdfFigures(e.figures),
    outlines: readPdfOutlineFigures(e.outlines),
  };
}

function lotOf(value: unknown): string {
  const digits = String(value ?? '').trim().replace(/^lot\s*/i, '');
  return /^\d{1,5}[a-z]?$/i.test(digits) ? digits.toLowerCase() : '';
}

function designKey(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
}

/** The one row a reading may speak for, or null. */
export function theOneRow(evidence: BrochureFigureEvidence): Record<string, unknown> | null {
  if (evidence.reading.status !== 'complete') return null;
  return evidence.reading.rows.length === 1 ? evidence.reading.rows[0] : null;
}

/** How this document stands to this property. See `DocumentStanding`. */
export function documentStanding(
  evidence: BrochureFigureEvidence,
  property: { lot_number: unknown; house_design: unknown; confirmedLots?: readonly string[] },
): { standing: DocumentStanding; reason: string } {
  const row = theOneRow(evidence);
  const docLot = lotOf(row?.lot_number);
  const ownLot = lotOf(property.lot_number);
  const docDesign = designKey(row?.house_design);
  const ownDesign = designKey(property.house_design);
  const designDiffers = !!docDesign && !!ownDesign && docDesign !== ownDesign;
  const confirmed = (property.confirmedLots ?? []).map(lotOf).filter(Boolean);

  if (docLot && ownLot && (docLot === ownLot || confirmed.includes(docLot))) {
    return designDiffers
      ? { standing: 'none', reason: 'states_this_lot_under_another_design' }
      : { standing: 'this_lot', reason: 'states_this_lot' };
  }
  if (designDiffers) return { standing: 'none', reason: 'another_design' };
  if (evidence.presentsDesign || (docDesign && docDesign === ownDesign)) {
    return { standing: 'same_design', reason: docLot ? 'another_lot_same_design' : 'design_only' };
  }
  return { standing: 'none', reason: docLot ? 'another_lot' : 'names_nothing' };
}

/** The fields a document of this standing may fill. */
export function fieldsFor(standing: DocumentStanding): readonly DocumentFigureField[] {
  if (standing === 'this_lot') return DOCUMENT_FIGURE_FIELDS;
  if (standing === 'same_design') return DESIGN_FIGURE_FIELDS;
  return [];
}

/** Plausible, or not a figure. A reading that fails these is a misreading. */
const BOUNDS: Record<DocumentFigureField, [number, number]> = {
  bedrooms: [0, 20],
  bathrooms: [0, 20],
  car_spaces: [0, 20],
  building_size_sqm: [20, 5000],
  land_size_sqm: [20, 200000],
};

export interface DocumentFigureDecision {
  standing: DocumentStanding;
  reason: string;
  /** Each value the document states and this standing allows. */
  values: Partial<Record<DocumentFigureField, number>>;
  /** Where each value was read: the text layer, or a picture of the schedule. */
  readBy: Partial<Record<DocumentFigureField, 'text' | 'picture'>>;
}

/**
 * What a document may give a property.
 *
 * `picture` is the area-schedule verdict, asked for only where the text gave
 * no floor area; it may fill the floor area and nothing else.
 */
export function decideDocumentFigures(input: {
  evidence: BrochureFigureEvidence;
  picture?: FigureVerdict | null;
  property: { lot_number: unknown; house_design: unknown; confirmedLots?: readonly string[] };
}): DocumentFigureDecision {
  const { standing, reason } = documentStanding(input.evidence, input.property);
  const allowed = fieldsFor(standing);
  const values: DocumentFigureDecision['values'] = {};
  const readBy: DocumentFigureDecision['readBy'] = {};
  if (!allowed.length) return { standing, reason, values, readBy };

  const row = theOneRow(input.evidence);
  // The import's own coercion over the WHOLE row, so `129.5m2` means here what
  // it means there and a combined `configuration` ("4 Bedrooms 2 Bathrooms
  // 2 Car Spaces") is split exactly as the import splits it. Only the allowed
  // fields are taken from what it gives back.
  const normalised = row ? normaliseStockRow(row) : null;
  for (const field of allowed) {
    const value = normalised ? (normalised as unknown as Record<string, unknown>)[field] : null;
    if (typeof value === 'number' && Number.isFinite(value)
      && value >= BOUNDS[field][0] && value <= BOUNDS[field][1]) {
      values[field] = value;
      readBy[field] = 'text';
    }
  }
  if (values.building_size_sqm === undefined && allowed.includes('building_size_sqm')
    && input.picture?.state === 'read') {
    const size = Number(input.picture.buildingSizeSqm);
    const [low, high] = BOUNDS.building_size_sqm;
    if (Number.isFinite(size) && size >= low && size <= high) {
      values.building_size_sqm = size;
      readBy.building_size_sqm = 'picture';
    }
  }
  return { standing, reason, values, readBy };
}

/** Whether the pictures are worth reading: a floor area is allowed and not yet read. */
export function wantsPicture(
  evidence: BrochureFigureEvidence,
  decision: DocumentFigureDecision,
): boolean {
  return fieldsFor(decision.standing).includes('building_size_sqm')
    && decision.values.building_size_sqm === undefined
    && (evidence.figures.length + evidence.outlines.length) > 0;
}

/**
 * THE RECORD A PROPERTY KEEPS (`builder_stock_items.document_figures`).
 *
 * `values` is what the document stated and its standing allowed — not what was
 * written onto a column, which the SQL decides against the column as it stands.
 * It is kept whole so a re-read of a silent stock list can put back what the
 * document said rather than blank it (`documentFigureFallback`).
 */
export interface DocumentFiguresRecord {
  v: number;
  /** The link read, exactly as the row's provenance keys it. */
  document: string;
  /** `read` — an answer; `retry` — nothing was learned, ask again later. */
  state: 'read' | 'retry';
  standing?: DocumentStanding;
  reason?: string;
  values?: Partial<Record<DocumentFigureField, number>>;
  read_by?: Partial<Record<DocumentFigureField, 'text' | 'picture'>>;
  read_at: string;
  attempts?: number;
  next_attempt_at?: string;
}

/** A stored record, if it is one this build can trust. */
export function readDocumentFiguresRecord(stored: unknown): DocumentFiguresRecord | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const r = stored as Record<string, unknown>;
  if (typeof r.v !== 'number' || typeof r.document !== 'string') return null;
  if (r.state !== 'read' && r.state !== 'retry') return null;
  const values: Partial<Record<DocumentFigureField, number>> = {};
  const rawValues = (r.values && typeof r.values === 'object' && !Array.isArray(r.values))
    ? r.values as Record<string, unknown> : {};
  for (const field of DOCUMENT_FIGURE_FIELDS) {
    const value = rawValues[field];
    if (typeof value === 'number' && Number.isFinite(value)) values[field] = value;
  }
  return {
    v: r.v,
    document: r.document,
    state: r.state,
    ...(typeof r.standing === 'string' ? { standing: r.standing as DocumentStanding } : {}),
    values,
    read_at: typeof r.read_at === 'string' ? r.read_at : '',
  };
}

/**
 * What a column falls back to when the stock list is silent about it on a
 * re-read of the same file: the document's figure, or null.
 */
export function documentFigureFallback(stored: unknown, column: string): number | null {
  const record = readDocumentFiguresRecord(stored);
  if (!record || record.state !== 'read') return null;
  const value = record.values?.[column as DocumentFigureField];
  return typeof value === 'number' ? value : null;
}

/** Backoff for a read that learned nothing: 5 minutes, doubling, capped at a day. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(24 * 3600, 300 * 2 ** Math.max(0, attempts - 1));
}

/** After this many reads that learned nothing, a document is left alone. */
export const MAX_DOCUMENT_FIGURE_ATTEMPTS = 6;
