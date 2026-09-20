/**
 * Builder stock lists — reading properties out of a PDF WITHOUT a model.
 *
 * THE GAP THIS CLOSES. Every other format has two readings: a table, read
 * deterministically, and prose, read by the assisted reader. The PDF branch of
 * `extract.ts` has only ever produced the second — it sets `pageTexts`, `text`
 * and `media` and it has never once touched `result.rows` — so `runImport`'s
 * `if (!rows.length && extraction.text)` was satisfied by EVERY PDF ever
 * uploaded, and the model was reached by construction rather than by judgement.
 * A brochure stating its lot, its design, its price and its bed/bath/car count
 * in so many words was sent to a paid provider to be told what it already said.
 *
 * This module is that missing middle. It reads only what a document EXPLICITLY
 * STATES, and where it cannot prove it has done so safely it says nothing and
 * the existing assisted reader runs exactly as it does today.
 *
 * ── WHAT THE READER CAN AND CANNOT SEE ────────────────────────────────────
 *
 * Measured 20 September 2026 against the pinned reader (`unpdf@0.12.1`, the
 * same version and the same call `pdfText.ts` makes) on PDFs built with text
 * at known coordinates:
 *
 *   drawn:  ESTATE(x=40) LOT(x=130) DESIGN(x=210) … PRICE(x=510)
 *   read:   "ESTATE LOT DESIGN BED BATH CAR LAND PRICE"
 *
 * Every horizontal gap — 21 to 62 units of white space — comes back as ONE
 * space, byte-identical to the space inside "Palomino Estate". So on the
 * flattened text a schedule's row reads
 *
 *   "Palomino Estate 315 Enzo 8.5 4 2 2 350 $863,850"
 *
 * — ten tokens under eight headings, with no recoverable boundary between
 * them. **A column cannot be recovered from `readPdfPageTexts` output**, and
 * anything that split that string on whitespace would be inventing the table
 * it claims to have found. That is why the two modes below are different
 * shapes of work rather than one parser: `readPdfBrochure` reads LINES, which
 * survive flattening intact, and `assemblePdfSchedule` reads POSITIONS, which
 * only the layout reader can supply.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────
 *
 * ONLY `complete` MAY POPULATE `extraction.rows`. `incomplete`, `ambiguous`
 * and `unsupported` are one outcome as far as the pipeline is concerned — the
 * deterministic reader stood down — and each is a statement about THIS READER,
 * never a finding about the document and never an upload failure.
 *
 * FAIL-CLOSED EVERYWHERE. Every refusal costs exactly what today costs: the
 * assisted reader runs. Every wrong acceptance writes a property into a
 * builder's marketplace. The two are not symmetrical, so every judgement here
 * is made on the refusing side.
 *
 * NO SECOND VOCABULARY. Headings resolve through `fieldForHeader`, rows key
 * through `keyRowsByHeader`, and every value is coerced by `normaliseStockRow`
 * — the same three functions a CSV goes through. This module decides WHICH
 * text is a label and WHICH is its value; it decides nothing about what a
 * label means or what a value becomes.
 *
 * NO INFERENCE. There is no fuzzy matching here, no similarity, no scoring and
 * no reading of prose. A value is claimed only where the document writes the
 * label beside it.
 */
import {
  coerceNumber,
  coercePrice,
  fieldForHeader,
  normaliseStockRow,
} from './normalise.pure.ts';
import { headerScore, keyRowsByHeader } from './table.pure.ts';

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * `complete` is the only one that imports.
 *
 * The other three are deliberately DISTINCT rather than one "no", because they
 * send a reader of the audit row to different places: `unsupported` says this
 * document is not a shape we claim to read, `incomplete` says it is that shape
 * and we could not finish it, and `ambiguous` says we finished it twice and
 * got two answers. Only the second and third are ever worth a developer's
 * attention.
 */
export type PdfDeterministicStatus =
  | 'complete'
  | 'incomplete'
  | 'ambiguous'
  | 'unsupported';

export type PdfDeterministicStrategy =
  | 'pdf_deterministic_table'
  | 'pdf_deterministic_brochure';

export interface PdfDeterministicReading {
  status: PdfDeterministicStatus;
  /**
   * Raw rows keyed by CANONICAL field name — the identical shape
   * `modelExtract` hands back, so both paths meet at `normaliseStockRow` and
   * neither can acquire coercion rules the other lacks.
   *
   * Empty on every status but `complete`. A refusal that carried rows would be
   * one edit away from importing them.
   */
  rows: Array<Record<string, unknown>>;
  /** Set on `complete` and null otherwise. Recorded as `parse_strategy`. */
  strategy: PdfDeterministicStrategy | null;
  /** Machine-readable, stable, and safe to log. Never a fragment of the document. */
  reason: string;
  /**
   * SAFE BY CONSTRUCTION: counts, field NAMES and status words. No value a
   * document stated ever appears here, because this is written to the import
   * log and a builder's price is not ours to put in a log line.
   */
  diagnostics: {
    mode: 'table' | 'brochure' | 'none';
    pages: number;
    /** Canonical fields the reader claimed to have read, by name. */
    fieldsRead: string[];
    /** Property candidates the document offered, however they resolved. */
    candidates: number;
    /** Set when a field was stated twice with two different values. */
    conflictField?: string;
  };
}

function refuse(
  status: Exclude<PdfDeterministicStatus, 'complete'>,
  reason: string,
  diagnostics: PdfDeterministicReading['diagnostics'],
): PdfDeterministicReading {
  return { status, rows: [], strategy: null, reason, diagnostics };
}

// ---------------------------------------------------------------------------
// The canonical header for each field this module may claim
// ---------------------------------------------------------------------------

/**
 * The heading string a claimed field is written back under.
 *
 * It exists because a canonical field NAME is not always a heading the alias
 * table knows: `house_design` and `bed_bath_car` are absent from the
 * self-registration loop at the foot of `normalise.pure.ts`, so writing
 * `{ bed_bath_car: '3 Bed 2 Bath' }` would land the counts in `unmapped` and
 * lose them silently — exactly the class of defect that table's own header
 * records.
 *
 * `pdfDeterministicRows.spec.ts` asserts `fieldForHeader(header) === field`
 * for every entry, so this map cannot drift away from the vocabulary it is
 * a view onto.
 */
export const CANONICAL_HEADER: Record<string, string> = {
  external_reference: 'external_reference',
  development_name: 'development_name',
  project_name: 'project_name',
  address_line: 'address_line',
  suburb: 'suburb',
  state: 'state',
  postcode: 'postcode',
  lot_number: 'lot_number',
  unit_number: 'unit_number',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  car_spaces: 'car_spaces',
  property_type: 'property_type',
  land_size_sqm: 'land_size_sqm',
  building_size_sqm: 'building_size_sqm',
  price: 'price',
  expected_completion: 'expected_completion',
  // Neither of these is its own alias — see above.
  house_design: 'house design',
  bed_bath_car: 'configuration',
};

/**
 * What a BROCHURE may state about itself.
 *
 * Two canonical fields are deliberately absent, and their absence is the rule
 * rather than an oversight.
 *
 * `description` — a brochure IS marketing prose, and turning its prose into a
 * description is the one thing a deterministic reader must never do. A
 * schedule's `Notes` column is a different object and Mode 1 takes it.
 *
 * `availability_status` — "selling now", "final release", "don't miss out" are
 * what a brochure says about every property it has ever described. A schedule
 * has a Status column that means something; a brochure has a slogan.
 *
 * `image_url` and `builder_name` are likewise not a brochure's to state: the
 * pictures come out of the PDF itself with their own provenance, and who
 * supplied the stock is the authenticated organisation.
 */
export const BROCHURE_CLAIMABLE_FIELDS: ReadonlySet<string> = new Set([
  'external_reference', 'development_name', 'project_name', 'address_line',
  'suburb', 'state', 'postcode', 'lot_number', 'unit_number',
  'bedrooms', 'bathrooms', 'car_spaces', 'property_type', 'house_design',
  'land_size_sqm', 'building_size_sqm', 'price', 'expected_completion',
  'bed_bath_car',
]);

/**
 * Fields whose value is a NUMBER, and therefore the only fields a label may
 * claim without a colon between it and its value.
 *
 * This is the guard that stops prose being read as a specification. "Design
 * your dream home today" opens with a heading this vocabulary knows, and
 * `house_design` is not in this set, so the line is left alone; "Land Size
 * 350 m2" is claimed because 350 is a number and the sentence cannot be
 * anything else.
 */
const NUMERIC_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'bedrooms', 'bathrooms', 'car_spaces',
  'land_size_sqm', 'building_size_sqm', 'price', 'postcode',
]);

/**
 * Identity, and NOT `identifiesAProperty`.
 *
 * That function is an ADMISSION test for a row inside a table whose other rows
 * vouch for it, and its own header says the bar is deliberately low. A lot
 * number alone passes it, so using it here would let a 6.8 MB brochure import
 * as "Lot 315" and nothing else while suppressing the reader that could have
 * read the rest.
 *
 * `suburb` is excluded for the same reason: a brochure naming the suburb it is
 * built in has not identified a property.
 */
const IDENTITY_FIELDS: readonly string[] = [
  'external_reference', 'address_line', 'lot_number', 'unit_number',
];

/**
 * How many distinct fields a document must state before it is a SPECIFICATION
 * rather than prose that happens to contain a label.
 *
 * Identity plus two. Below this the honest reading is that this document's
 * facts are not written in labelled form — which is a statement about the
 * shape, so it answers `unsupported` and the assisted reader takes the whole
 * document, exactly as it does today. Raising the number costs nothing but
 * model calls; lowering it buys thin properties.
 */
export const MIN_BROCHURE_FIELDS = 3;

/** Bounds. A hostile or enormous document must not spend the isolate here. */
const MAX_LINES_SCANNED = 4000;
const MAX_LABEL_WORDS = 4;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

interface Claim {
  field: string;
  /** Verbatim, as the document wrote it. Coercion is `normaliseStockRow`'s. */
  value: string;
}

/**
 * The longest run of leading words that names a field we know.
 *
 * Longest-first, because "Land Size" and "Land" are both aliases and the
 * shorter one would swallow "Size" into the value.
 */
function labelAt(tokens: string[], start: number): { field: string; length: number } | null {
  const available = Math.min(MAX_LABEL_WORDS, tokens.length - start);
  for (let length = available; length >= 1; length--) {
    const field = fieldForHeader(tokens.slice(start, start + length).join(' '));
    if (field) return { field, length };
  }
  return null;
}

/** `m2`, `m²`, `sqm`, `sq`, `m` — a unit belongs to the number before it. */
const UNIT_TOKEN = /^(?:m2|m²|sqm|sq|m|sqm\.|m\.)$/i;
const HAS_DIGIT = /\d/;

/**
 * A line written as one or more `label value` pairs, where every value is a
 * number — "Bedrooms 4", "Land Size 350 m2", "PACKAGE PRICE $863,850".
 *
 * THE WHOLE LINE OR NOTHING. A line is claimed only when every token in it is
 * accounted for as a label or as one of its values. That is what separates a
 * specification line from a sentence that opens with one: "Land Size 350 m2"
 * is consumed entirely, "Land sizes from 350 m2 are available now" is not, and
 * the second yields nothing rather than yielding a land size.
 */
function readLabelledNumbers(line: string): Claim[] | null {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const claims: Claim[] = [];
  let index = 0;

  while (index < tokens.length) {
    const label = labelAt(tokens, index);
    if (!label || !NUMERIC_VALUE_FIELDS.has(label.field)) return null;
    index += label.length;

    // The value: one token carrying a digit, plus any bare unit after it.
    if (index >= tokens.length || !HAS_DIGIT.test(tokens[index])) return null;
    const parts = [tokens[index]];
    index += 1;
    while (index < tokens.length && UNIT_TOKEN.test(tokens[index])) {
      parts.push(tokens[index]);
      index += 1;
    }
    claims.push({ field: label.field, value: parts.join(' ') });
  }

  return claims.length ? claims : null;
}

/**
 * `Label: value`, with an explicit separator.
 *
 * The separator is what admits the TEXT fields — a design, an estate, an
 * address — because a colon is the document stating "this is that". Without
 * one only numbers are claimable, for the reason `NUMERIC_VALUE_FIELDS`
 * records.
 *
 * A recognised label with an EMPTY value answers `{ field, value: '' }` rather
 * than null: the document has named a fact it does not go on to state, and the
 * caller turns that into `incomplete` rather than importing a record missing a
 * field the document itself said it had.
 */
function readLabelledValue(line: string): Claim | null {
  const match = line.match(/^([^:–—]{1,60}?)\s*[:–—]\s*(.*)$/);
  if (!match) return null;
  const field = fieldForHeader(match[1]);
  if (!field) return null;
  return { field, value: match[2].trim() };
}

/**
 * The counts written inline — "3 BED 2 BATH 2 CAR", "4 Bed 2 Bath 2 Car".
 *
 * Handed on VERBATIM under the `configuration` heading, so the shapes are read
 * by `parseBedBathCar` inside `normalise.pure.ts` — the parser that already
 * knows the dual-occupancy form, the doubled slash and the eleven other
 * spellings a live stock list writes. Re-reading them here would be a second
 * opinion about a cell this product already has one implementation for.
 *
 * The whole line must be counts. "3 bedroom homes from $600,000" is a
 * sentence, and it is refused because `$600,000` is not a count.
 */
const INLINE_COUNTS =
  /^(?:\d{1,2}(?:\.\d)?\s*(?:bed(?:room)?s?|bath(?:room)?s?|cars?|carports?)\b[\s,/|·+-]*)+$/i;

function readInlineCounts(line: string): Claim | null {
  if (!INLINE_COUNTS.test(line.trim())) return null;
  return { field: 'bed_bath_car', value: line.trim() };
}

/**
 * `LOT 315`, `Lot 12A` — a line that is a lot designation and nothing else.
 *
 * Its own rule because a lot number is not a number: `12A` and `315/2` are
 * both real, so it cannot go through `readLabelledNumbers`, and a brochure
 * writes it as a heading rather than as `Lot: 315`. Two tokens exactly, and
 * the second may hold only the characters a lot designation is made of — which
 * is what stops "Lot released" and "Lot 5 of the finest homes" claiming
 * anything.
 */
function readLotHeading(line: string): Claim | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length !== 2) return null;
  if (fieldForHeader(tokens[0]) !== 'lot_number') return null;
  if (!/^[0-9]{1,6}[A-Za-z]?(?:[/-][0-9A-Za-z]{1,6})?$/.test(tokens[1])) return null;
  return { field: 'lot_number', value: tokens[1] };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Are two statements of the same field the same statement?
 *
 * Numbers are compared as numbers, so `$863,850` and `863850` are one price
 * and a document is not called ambiguous for writing its price twice in two
 * notations. Everything else is compared as text with case and spacing
 * removed, which is the comparison `normaliseHeader` already makes for
 * headings.
 */
function sameValue(field: string, a: string, b: string): boolean {
  if (field === 'price') {
    const left = coercePrice(a);
    const right = coercePrice(b);
    if (left.price !== null && right.price !== null) return left.price === right.price;
  }
  if (NUMERIC_VALUE_FIELDS.has(field)) {
    const left = coerceNumber(a);
    const right = coerceNumber(b);
    if (left !== null && right !== null) return left === right;
  }
  const flatten = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return flatten(a) === flatten(b);
}

// ---------------------------------------------------------------------------
// Mode 2 — the explicit single-property brochure
// ---------------------------------------------------------------------------

/**
 * Read a brochure that STATES its property.
 *
 * Runs on `pageTexts` — the strings `readPdfPageTexts` already produced for
 * this upload — so it costs one pass over text the pipeline is holding anyway
 * and reads nothing the assisted reader would not have been sent.
 */
export function readPdfBrochure(pageTexts: readonly string[]): PdfDeterministicReading {
  const diagnostics: PdfDeterministicReading['diagnostics'] = {
    mode: 'brochure', pages: pageTexts.length, fieldsRead: [], candidates: 0,
  };

  const claimed = new Map<string, string>();
  let sawAnyLabel = false;

  const lines = pageTexts
    .flatMap((page) => String(page ?? '').split(/\r?\n/))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_LINES_SCANNED);

  for (const line of lines) {
    const found: Claim[] = [];

    const labelled = readLabelledValue(line);
    if (labelled) {
      if (!BROCHURE_CLAIMABLE_FIELDS.has(labelled.field)) continue;
      sawAnyLabel = true;
      if (!labelled.value) {
        /*
         * THE DOCUMENT NAMED A FACT AND DID NOT STATE IT. A template whose
         * values live in form fields reads exactly like this, and importing
         * the fields it DID fill would publish a property whose own brochure
         * says it has a land size we do not carry.
         */
        diagnostics.fieldsRead = [...claimed.keys()].sort();
        return refuse('incomplete', `label_without_value:${labelled.field}`, diagnostics);
      }
      found.push(labelled);
    } else {
      const numbers = readLabelledNumbers(line);
      if (numbers) found.push(...numbers);
      else {
        const counts = readInlineCounts(line);
        if (counts) found.push(counts);
        else {
          const lot = readLotHeading(line);
          if (lot) found.push(lot);
        }
      }
    }

    for (const claim of found) {
      if (!BROCHURE_CLAIMABLE_FIELDS.has(claim.field)) continue;
      sawAnyLabel = true;
      const existing = claimed.get(claim.field);
      if (existing === undefined) {
        claimed.set(claim.field, claim.value);
        continue;
      }
      if (!sameValue(claim.field, existing, claim.value)) {
        /*
         * TWO ANSWERS IS NOT AN ANSWER. Two prices, two lots, two bedroom
         * counts — whether that is a dual-key home, a page per release or a
         * catalogue of six designs, this reader cannot tell them apart, and
         * separating them is precisely the judgement it does not make.
         */
        diagnostics.conflictField = claim.field;
        diagnostics.fieldsRead = [...claimed.keys()].sort();
        return refuse('ambiguous', `conflicting_values:${claim.field}`, diagnostics);
      }
    }
  }

  diagnostics.fieldsRead = [...claimed.keys()].sort();

  if (!claimed.size) {
    return refuse('unsupported', sawAnyLabel ? 'no_values_read' : 'no_labelled_fields', diagnostics);
  }

  /*
   * THE COUNTS MAY BE STATED ONCE, NOT TWICE. A document carrying both
   * "3 Bed 2 Bath 2 Car" and "Bedrooms: 4" is stating its configuration two
   * ways, and which one wins inside `normaliseStockRow` would be decided by
   * key order — a detail of this function, not of the document.
   */
  if (claimed.has('bed_bath_car')
    && (claimed.has('bedrooms') || claimed.has('bathrooms') || claimed.has('car_spaces'))) {
    diagnostics.conflictField = 'bed_bath_car';
    return refuse('ambiguous', 'counts_stated_two_ways', diagnostics);
  }

  const identity = IDENTITY_FIELDS.filter((field) => claimed.has(field));
  if (!identity.length) {
    return refuse('incomplete', 'no_identity_field', diagnostics);
  }
  if (claimed.size < MIN_BROCHURE_FIELDS) {
    return refuse('unsupported', 'too_few_fields_for_a_specification', diagnostics);
  }

  const raw: Record<string, unknown> = {};
  for (const [field, value] of claimed) {
    const header = CANONICAL_HEADER[field];
    // A field with no canonical heading cannot be written back without
    // guessing one, so it is dropped rather than mis-filed — and it is a
    // refusal, because dropping it silently is the defect this module's own
    // vocabulary notes describe.
    if (!header) return refuse('incomplete', `no_canonical_header:${field}`, diagnostics);
    raw[header] = value;
  }

  const record = normaliseStockRow(raw);
  if (!record) {
    return refuse('incomplete', 'normalisation_refused_the_row', diagnostics);
  }

  diagnostics.candidates = 1;
  return {
    status: 'complete',
    rows: [raw],
    strategy: 'pdf_deterministic_brochure',
    reason: 'explicit_fields_read',
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Mode 1 — the PDF stock schedule
// ---------------------------------------------------------------------------

/**
 * One run of text the reader found, and where the page put it.
 *
 * `width` is the run's own advance, so `x + width` is where it ends — which is
 * what makes a gap measurable. The layout reader supplies these; nothing here
 * fetches or decodes anything.
 */
export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
}

export interface PdfTextLayoutPage {
  page: number;
  items: PdfTextItem[];
}

/**
 * Two runs on the same line if their baselines are within this. Sub-pixel
 * drift is normal inside one line; a line step is never this small.
 */
const SAME_LINE_TOLERANCE = 1.8;

/**
 * The white space that separates a COLUMN from a WORD.
 *
 * Measured on the probe document: the gaps between the eight columns were 21.0
 * to 62.5 units, and a Helvetica word space at the same size is about 2.5. Six
 * is two-and-a-half word spaces — comfortably above kerning and an order below
 * a column — and getting it wrong is not a correctness risk in either
 * direction: too small and cells split, so `keyRowsByHeader` finds no header
 * or the alignment test refuses; too large and cells merge, so the same two
 * tests refuse. Both roads end at the assisted reader.
 */
const MIN_COLUMN_GAP = 6;

/** A cell may begin a hair to the left of its column and still be in it. */
const COLUMN_SLACK = 2;

/** How far down a page a header may sit, matching `keyRowsByHeader`'s own scan. */
const MAX_HEADER_SCAN = 15;

interface LayoutCell { x: number; text: string }
interface LayoutLine { y: number; cells: LayoutCell[] }

/**
 * Items into lines, and lines into cells.
 *
 * Exported for its tests: the whole safety of Mode 1 rests on this producing
 * cells that are the document's own, and a fixture of coordinates proves that
 * without a PDF.
 */
export function layoutLines(items: readonly PdfTextItem[]): LayoutLine[] {
  const drawn = items
    .filter((item) => String(item.text ?? '').trim() !== '')
    .slice()
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const groups: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of drawn) {
    const group = groups.find((candidate) =>
      Math.abs(candidate.y - item.y) <= SAME_LINE_TOLERANCE);
    if (group) group.items.push(item);
    else groups.push({ y: item.y, items: [item] });
  }

  /*
   * One pass left to right. A run that begins within `MIN_COLUMN_GAP` of where
   * the previous one ended is more of the same cell; anything further is the
   * next column. `end` tracks the rightmost edge reached so far rather than
   * the last run's, so a cell assembled from three runs still ends where its
   * widest run does.
   */
  return groups.map((group) => {
    const cells: LayoutCell[] = [];
    let end = Number.NEGATIVE_INFINITY;
    for (const item of group.items.slice().sort((a, b) => a.x - b.x)) {
      const text = item.text.trim();
      if (!text) continue;
      const previous = cells[cells.length - 1];
      if (previous && item.x - end < MIN_COLUMN_GAP) {
        previous.text = `${previous.text} ${text}`.replace(/\s+/g, ' ').trim();
      } else {
        cells.push({ x: item.x, text });
      }
      end = Math.max(end, item.x + (Number.isFinite(item.width) ? item.width : 0));
    }
    return { y: group.y, cells };
  });
}

/**
 * Turn positioned pages into keyed rows, or say why not.
 *
 * THE COLUMN GRID IS THE HEADER'S. Every data cell must fall inside exactly
 * one of the header's columns, and a cell that starts before the first column
 * or that shares a column with another cell on its line refuses the whole
 * document. That is a test that the DATA FITS THE HEADING — a row drawing nine
 * cells under eight headings means the grid and the table disagree about how
 * many columns there are, and folding the ninth into the eighth is how a land
 * price comes to be printed as a land size.
 *
 * WHAT IT IS NOT is a claim that every cell sits under the right heading. A
 * run drawn at the BED column's own x IS in the BED column as far as the page
 * is concerned, and no reconstruction can say otherwise; `pdfDeterministic`'s
 * spec records that case rather than pretending it is caught.
 */
export function assemblePdfSchedule(
  pages: readonly PdfTextLayoutPage[],
): PdfDeterministicReading {
  const diagnostics: PdfDeterministicReading['diagnostics'] = {
    mode: 'table', pages: pages.length, fieldsRead: [], candidates: 0,
  };

  const matrix: string[][] = [];
  let headers: string[] | null = null;
  let sawOrphanRows = false;

  for (const page of pages) {
    const lines = layoutLines(page.items);
    const headerIndex = lines.slice(0, MAX_HEADER_SCAN)
      .findIndex((line) => headerScore(line.cells.map((cell) => cell.text)) >= 2);

    if (headerIndex < 0) {
      // A page with table-shaped content and no heading is a continuation we
      // cannot key, or a page we have misread. Either way it must not be
      // dropped in silence — see rule 8 of the completeness contract.
      if (lines.some((line) => line.cells.length >= 3)) sawOrphanRows = true;
      continue;
    }

    const headerLine = lines[headerIndex];
    const columns = headerLine.cells.map((cell) => cell.x);
    const labels = headerLine.cells.map((cell) => cell.text);
    if (!headers) {
      headers = labels;
      matrix.push(headers.slice());
    } else if (headers.length !== labels.length
      || headers.some((label, index) => label !== labels[index])) {
      /*
       * A SECOND TABLE IS NOT A CONTINUATION. `keyRowsByHeader` keys every row
       * by one header list and quietly truncates a row that is wider, so two
       * page headings that disagree would lose the extra columns of one of
       * them with nothing recording it.
       */
      return refuse('incomplete', 'heading_changed_between_pages', diagnostics);
    }

    for (const line of lines.slice(headerIndex + 1)) {
      if (!line.cells.length) continue;
      const row = new Array<string>(columns.length).fill('');
      for (const cell of line.cells) {
        const column = columnFor(columns, cell.x);
        if (column === null) {
          diagnostics.candidates = matrix.length - 1;
          return refuse('ambiguous', 'cell_outside_every_column', diagnostics);
        }
        if (row[column] !== '') {
          diagnostics.candidates = matrix.length - 1;
          return refuse('ambiguous', 'two_cells_in_one_column', diagnostics);
        }
        row[column] = cell.text;
      }
      if (row.some((value) => value !== '')) matrix.push(row);
    }
  }

  if (!headers || matrix.length <= 1) {
    return refuse('unsupported', 'no_schedule_found', diagnostics);
  }
  if (sawOrphanRows) {
    return refuse('incomplete', 'table_rows_on_a_page_with_no_heading', diagnostics);
  }

  const keyed = keyRowsByHeader(matrix);
  if (!keyed) return refuse('unsupported', 'headings_not_recognised', diagnostics);
  /*
   * THE HEADING WE FOUND MUST BE THE HEADING IT KEYS BY. `keyRowsByHeader`
   * re-scans for the best candidate in the first fifteen rows, so a data row
   * that scores higher than the heading would become the heading and shift
   * every row under it by one. The two readings have to agree or neither is
   * trustworthy.
   */
  if (keyed.headerRowIndex !== 0) {
    return refuse('ambiguous', 'heading_row_disputed', diagnostics);
  }

  diagnostics.candidates = keyed.rows.length;
  diagnostics.fieldsRead = Array.from(new Set(
    keyed.headers.map((header) => fieldForHeader(header)).filter((f): f is string => !!f),
  )).sort();

  if (!keyed.rows.length) return refuse('unsupported', 'no_data_rows', diagnostics);

  /*
   * EVERY ROW OR NO ROWS. A schedule whose last line is a total, or one row of
   * which came apart in reconstruction, is refused whole. Importing the rows
   * that parsed and sending the document to the assisted reader as well would
   * import the readable ones twice; importing them and stopping there would
   * lose the rest with nothing saying so.
   */
  for (const row of keyed.rows) {
    if (!normaliseStockRow(row)) {
      return refuse('incomplete', 'a_row_could_not_be_normalised', diagnostics);
    }
  }

  return {
    status: 'complete',
    rows: keyed.rows,
    strategy: 'pdf_deterministic_table',
    reason: 'schedule_reconstructed',
    diagnostics,
  };
}

/** The column a cell at `x` belongs to, or null when it belongs to none. */
function columnFor(columns: readonly number[], x: number): number | null {
  for (let index = columns.length - 1; index >= 0; index--) {
    if (x >= columns[index] - COLUMN_SLACK) return index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The screen, and the entry point
// ---------------------------------------------------------------------------

/**
 * Might this document hold a schedule?
 *
 * A COST QUESTION AND NEVER A CORRECTNESS ONE. Reading positions means opening
 * the document a second time, and a brochure — which is what every PDF in this
 * corpus has been — must not pay for a table it does not have. Three
 * recognised headings on one flattened line is what a heading row looks like
 * after the reader has collapsed its gaps; a brochure line reaches two at the
 * most, and if this screen is ever wrong in either direction the answer is
 * still decided by the parsers rather than by it.
 */
export function mayHoldSchedule(pageTexts: readonly string[]): boolean {
  for (const page of pageTexts) {
    for (const line of String(page ?? '').split(/\r?\n/)) {
      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length < 3) continue;
      if (headerScore(tokens) >= 3) return true;
    }
  }
  return false;
}

/**
 * The deterministic reading of a PDF, from what the pipeline already holds.
 *
 * `positionedPages` is supplied only when `mayHoldSchedule` said it was worth
 * reading them; its absence is not a failure and simply means the schedule
 * mode was not attempted.
 *
 * ORDER. The brochure is tried first because it is free — the strings are
 * already in hand — and because a schedule cannot pass it: a schedule's data
 * lines open with an estate name rather than a label, so they claim nothing,
 * and a schedule that somehow did claim something would state its fields more
 * than once and answer `ambiguous`.
 */
export function readPdfDeterministicRows(input: {
  pageTexts: readonly string[];
  positionedPages?: readonly PdfTextLayoutPage[] | null;
}): PdfDeterministicReading {
  const pageTexts = input.pageTexts ?? [];

  const brochure = readPdfBrochure(pageTexts);
  if (brochure.status === 'complete') return brochure;

  if (input.positionedPages && input.positionedPages.length) {
    const schedule = assemblePdfSchedule(input.positionedPages);
    if (schedule.status === 'complete') return schedule;
    // The schedule reading is the more informative refusal wherever the
    // document actually had a table in it.
    if (schedule.reason !== 'no_schedule_found') return schedule;
  }

  return brochure;
}
