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
 * it claims to have found.
 *
 * THAT IS NOT ONLY A TABLE'S PROBLEM, and treating it as one is what left a
 * legible brochure unread. A brochure sets a two-column block
 *
 *     LAND        HOUSE
 *     350 m²      210 m²
 *
 * which flattens to `LAND HOUSE` over `350 m² 210 m²` — two labels and two
 * values with the pairing destroyed — and sets a label beside its value,
 * which flattens to one string. So BOTH modes read positions where the
 * layout reader supplied them: `assemblePdfSchedule` reconstructs a grid,
 * and `readPdfBrochure` reads a page as the rows and cells it was drawn in,
 * falling back to the flattened lines for any page that has none. With no
 * positions at all the brochure reading is byte for byte the one this module
 * has always made.
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
 * A BROCHURE IS NOT A SPREADSHEET, AND IT IS NOT A BAG OF STRINGS EITHER.
 * `Label: value` is the shape a brochure almost never uses. It says what a
 * line is by putting the field's own word inside the name (`PALOMINO
 * ESTATE`), by captioning the name (`ENZO 8.5 LUCA` over `HOME DESIGN`), by
 * drawing the label beside or above the value, or by printing the name bare
 * on the cover and again, with one of those, further in. Each of those is
 * the DOCUMENT saying so, read through the alias table every other format
 * uses and through the positions the page drew. None of them is a rule about
 * which bare line tends to be a design: there is no such rule here, because
 * `Society 1056` is an estate and `Enzo 8.5` is a design and nothing about
 * either line says which.
 *
 * NEVER COMPLETE AROUND A FACT WE DID NOT READ. `complete` is a statement
 * about the WHOLE document, not about the fields that happened to resolve: a
 * brochure completes only where every line of it was read into a field,
 * repeated a name already read, declined under a named policy
 * (`BROCHURE_CLAIMABLE_FIELDS`), or was POSITIVELY recognised as the
 * document's own furniture — a phone number, a web or email address, a page
 * number, a copyright or licence line, a disclaimer, the uploading
 * organisation's own name, a cue-free marketing sentence. A line that is
 * none of those may be a property fact, so it stands the document down and
 * the assisted reader runs. That still includes a bare name nothing in seven
 * pages ever qualifies: ignoring one does not make the record thinner, it
 * makes it wrong, since completing also SUPPRESSES the reader that could
 * have read it.
 *
 * The furniture list is what keeps this reachable rather than theoretical —
 * an earlier rule blocked on any line carrying a digit, which a real
 * seven-page brochure breaks on its builder's own telephone number — and it
 * is a closed list of positive recognisers, never a fall-through.
 *
 * A schedule refuses when any reconstructed row names no property (a `TOTAL`
 * footer is a row `normaliseStockRow` accepts and this stage must not).
 *
 * Both gates are asked the CONSERVATIVE question, because both were first
 * written asking the convenient one. "Is this line prose?" excused
 * `House Design Enzo 8.5 Luca Modern.` on its shape, so it is now "could this
 * line be a fact?" — a digit, money, an area unit or any known heading, and
 * the line is never prose. "Does this row carry an identifier?" was satisfied
 * by `lot_number: "TOTAL"`, so it is now "is that identifier a real one?".
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
    /**
     * Lines this reader could not resolve and could not prove incidental.
     * ANY ONE OF THEM STANDS A BROCHURE DOWN, whether it named a field we
     * know or could not be classified at all: the document put it on the
     * page, so it may be a property fact, and completing around it would
     * suppress the one reader that could have read it.
     * A COUNT and never the text, because this reaches the import log.
     */
    unaccountedLines?: number;
    /**
     * Lines a document says about ITSELF rather than about the property —
     * a phone number, a website, a copyright or licence line, a page
     * number, a disclaimer, a cue-free marketing sentence. Reported so a
     * document that was mostly furniture is visible, and not blocking,
     * because each was recognised POSITIVELY rather than merely unmatched.
     */
    incidentalLines?: number;
    /**
     * Lines that repeat something the document has ALREADY had read — the
     * cover's bare `PALOMINO` where page five states `PALOMINO ESTATE`.
     * Reported, and not blocking, because a second printing of a fact is
     * not a second fact.
     */
    corroboratedLines?: number;
    /**
     * Canonical fields the document stated and this reader declines BY
     * POLICY — the four `BROCHURE_CLAIMABLE_FIELDS` names for stated
     * reasons. Named rather than counted, because "we did not take the
     * status" is a different sentence from "we could not read a line", and
     * an import log should be able to tell them apart.
     */
    declinedFields?: string[];
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
 * Words that name a SUM of the rows above, not a property.
 *
 * A schedule headed `LOT | DESIGN | PRICE` puts its footer's word in the LOT
 * column, so `normaliseStockRow` answers `lot_number: "TOTAL"` and a test that
 * asks only whether an identifier is PRESENT is satisfied by it. Requiring the
 * lot to be numeric would be the wrong repair — builders really do sell
 * `12A`, `315/2` and `MC-0041` — so the rule is about the WORD, not the shape:
 * an obvious summary label is not property identity.
 *
 * Deliberately a short, closed list of the unambiguous ones. A builder whose
 * estate is called "Summary" is not a case worth guessing at, and anything not
 * named here simply keeps today's behaviour.
 */
const SUMMARY_IDENTITY_LABELS: ReadonlySet<string> = new Set([
  'total', 'totals', 'subtotal', 'grandtotal', 'summary',
]);

/** Case, spacing and punctuation only — never the value's meaning. */
function flattenIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Does this row name a property a person could go and look up?
 *
 * `none` — no identifier at all (a `TOTAL` under an ESTATE column, a legend).
 * `summary` — every identifier it has is a summary word.
 * `ok` — at least one identifier that is not.
 *
 * `every` rather than `some`: a row carrying both `TOTAL` and a real street
 * address is identified by the address, and refusing it would be this stage
 * guessing again.
 */
function rowIdentity(
  record: Record<string, unknown>,
): 'ok' | 'none' | 'summary' {
  const stated = IDENTITY_FIELDS
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (!stated.length) return 'none';
  return stated.every((value) => SUMMARY_IDENTITY_LABELS.has(flattenIdentity(value)))
    ? 'summary'
    : 'ok';
}

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

/** Each count and the word that names it, in the order the line writes them. */
const COUNT_GROUP = /(\d{1,2}(?:\.\d)?)\s*(bed(?:room)?s?|bath(?:room)?s?|cars?|carports?)\b/gi;

/** The canonical field each count word names. The vocabulary is the existing one. */
const COUNT_FIELD: ReadonlyArray<[RegExp, string]> = [
  [/^bed/i, 'bedrooms'],
  [/^bath/i, 'bathrooms'],
  [/^car/i, 'car_spaces'],
];

/**
 * A line that is nothing but counts.
 *
 * TWO SHAPES, AND THE DIFFERENCE IS WHY THIS RETURNS A LIST.
 *
 * A brochure sets its counts as three separate lines beside three icons —
 *
 *     4 BED
 *     2 BATH
 *     2 CAR
 *
 * — and each of those lines is a complete statement about ONE field. Claiming
 * each as the combined `bed_bath_car` cell made them three different values of
 * one field, so the second line contradicted the first and a perfectly plain
 * brochure answered `conflicting_values:bed_bath_car`. Measured on the shape
 * this module exists to read, that was the FIRST thing it refused.
 *
 * So a line naming exactly ONE count word claims that one canonical field,
 * where a repeat of the same figure on a later page corroborates and a
 * genuine disagreement still conflicts — both for free, through the same
 * machinery every other field uses.
 *
 * A line naming MORE than one is handed on verbatim under `configuration`
 * exactly as before, because `parseBedBathCar` in `normalise.pure.ts` already
 * knows that cell's dual-occupancy form, its doubled slash and its eleven
 * other spellings, and a second opinion about it here is the last thing this
 * module should hold.
 */
function readInlineCounts(line: string): Claim[] | null {
  const trimmed = line.trim();
  if (!INLINE_COUNTS.test(trimmed)) return null;
  const groups = [...trimmed.matchAll(COUNT_GROUP)];
  if (!groups.length) return null;

  const fields = new Set(groups.map(([, , word]) =>
    COUNT_FIELD.find(([pattern]) => pattern.test(word))?.[1] ?? ''));
  if (fields.size !== 1 || fields.has('')) {
    return [{ field: 'bed_bath_car', value: trimmed }];
  }
  /*
   * ONE WORD, BUT IT MAY BE WRITTEN TWICE ("2 bed + 2 bed" on a dual key).
   * That is the combined cell's arithmetic, not this one's, so anything but a
   * single figure goes back to the shared parser rather than being summed here.
   */
  if (groups.length !== 1) return [{ field: 'bed_bath_car', value: trimmed }];
  return [{ field: [...fields][0], value: groups[0][1] }];
}

/**
 * A value that is a measurement or a sum and carries no words of its own —
 * `350 m²`, `$863,850`, `210`. Used to tell a descriptive field's value from a
 * figure that has been set under it.
 */
const BARE_MEASUREMENT = /^[$€£¥]?\s*\d[\d.,\s]*(?:m2|m²|sqm|sq\s?m|ha|hectares?|acres?)?$/i;

/**
 * The area unit a value carries, in the spelling the alias table knows.
 *
 * Anchored to the end of the value rather than fenced with `\b`, because a
 * word boundary cannot match after `²` — it is not a word character, so
 * `\bm²\b` never fires and `210 m²` read as carrying no unit at all.
 */
function areaUnitOf(value: string): string | null {
  const match = value.match(/(?:\d|\s)(m2|m²|sqm|sq\s?m)\.?\s*$/i);
  return match ? match[1].replace(/\s+/g, ' ') : null;
}

/**
 * Fields whose value is WORDS. A figure set under one of these is not its
 * value — it is a measurement whose label has been read too narrowly.
 */
const DESCRIPTIVE_FIELDS: ReadonlySet<string> = new Set([
  'house_design', 'development_name', 'project_name', 'suburb', 'property_type',
]);

/**
 * THE LABEL ON ONE LINE, THE VALUE ON THE NEXT.
 *
 * This is how a brochure is actually set, and not reading it is most of why a
 * plainly legible document produced nothing:
 *
 *     LAND              HOUSE             PACKAGE PRICE
 *     350 m²            210 m²            $863,850
 *
 * Every one of those is a complete, explicit statement, and the old reader saw
 * none of them because it only understood a label and a value sharing a line.
 * Nothing is inferred here: the label line must resolve WHOLLY through
 * `fieldForHeader`, the value must be the very next line, and the value must
 * be the shape that field takes.
 *
 * THE UNIT RESOLVES THE LABEL, and that is what keeps this honest. `HOUSE`
 * alone is `house_design` — the alias table says so deliberately, because a
 * builder's `HOUSE` column holds the design name. Set above `210 m²` it is the
 * house's AREA, and the table already knows that spelling too (`house m2` is
 * `building_size_sqm`). So where the value carries an area unit the label is
 * re-read WITH that unit through the same table. No mapping is invented: the
 * document supplied both halves and the existing vocabulary resolved them.
 *
 * Returns the claim and how many lines it consumed, or null.
 */
function readVerticalPair(
  label: string,
  value: string | undefined,
): { claim: Claim; consumed: number } | null {
  const bare = fieldForHeader(label);
  if (!bare || !BROCHURE_CLAIMABLE_FIELDS.has(bare)) return null;
  if (value === undefined) return null;

  // A heading directly under a heading is a layout, not a statement.
  if (fieldForHeader(value)) return null;

  const unit = areaUnitOf(value);
  const resolved = (unit ? fieldForHeader(`${label} ${unit}`) : null) ?? bare;
  if (!BROCHURE_CLAIMABLE_FIELDS.has(resolved)) return null;

  if (resolved === 'lot_number' || resolved === 'unit_number') {
    /*
     * AN IDENTIFIER HAS A SHAPE, and without this it had none. `LOT` over
     * `350 m²` resolved a claimable field with a value that passed every
     * other guard — neither numeric nor descriptive — and wrote a land size
     * into the one field that says WHICH PROPERTY this is. The reading of a
     * page's columns is what made the pairing reachable; the hole was always
     * there. It is the same shape `readLotHeading` demands.
     */
    if (!LOT_DESIGNATION.test(value)) return null;
  } else if (IDENTITY_FIELDS.includes(resolved) && BARE_MEASUREMENT.test(value)) {
    // An address or a reference is free-form, but it is never a bare figure.
    return null;
  } else if (NUMERIC_VALUE_FIELDS.has(resolved)) {
    if (!HAS_DIGIT.test(value)) return null;
  } else if (DESCRIPTIVE_FIELDS.has(resolved) && BARE_MEASUREMENT.test(value)) {
    /*
     * A figure under a descriptive label that no unit rescued. Reading it
     * would write a measurement into a design name, so the pair is refused
     * and the caller records the label as stated-but-unread.
     */
    return null;
  }
  return { claim: { field: resolved, value }, consumed: 2 };
}

/**
 * Is this line a SENTENCE, rather than a fact we failed to read?
 *
 * The question only ever arises for a line this reader could not assign, and
 * the two answers are not symmetrical: calling a sentence a fact costs a model
 * call, and calling a fact a sentence loses it out of a client's record for
 * good. So the test is deliberately hard to pass, and everything it is unsure
 * about is a fact.
 *
 * A sentence ends in a full stop, a question mark or an exclamation, AND runs
 * longer than the longest thing a specification line plausibly is. The word
 * count carries that second half on its own for an unpunctuated line.
 *
 * SHAPE ALONE WAS NOT ENOUGH, and this is the defect that proved it:
 *
 *   "House Design Enzo 8.5 Luca Modern."
 *
 * Six words with a full stop on the end — prose by every measure of shape,
 * and it is the house design. No colon, so no text field claims it; long
 * enough to read as a sentence, so it was excused; and with enough labelled
 * fields elsewhere the document completed and the design was gone for good.
 *
 * So shape is now the SECOND question. The first is whether the line carries
 * any cue that it might be a fact at all, and a line that does is never prose
 * however it is written. The cues are deliberately coarse — a digit, money, an
 * area unit, or any heading the EXISTING alias table recognises anywhere in
 * the line — because the two errors are not the same size: a false fallback
 * costs one model call, and a false "prose" costs a client's record a field
 * for ever. Nothing here reads the fact it detects; it only declines to
 * pretend the line is decoration.
 *
 *   "House Design Enzo 8.5 Luca Modern."   digit + `house design` → FACT
 *   "PALOMINO ESTATE"                      `estate`               → FACT
 *   "ENZO 8.5 LUCA"                        digit                  → FACT
 *   "Land Size 350 m2."                    digit + unit + `land`  → FACT
 *   "Priced from $800,000"                 digit + money + `price`→ FACT
 *   "Discover a better way to live."       no cue, 6 w, stop      → prose
 *   "Welcome to your new home."            no cue, 5 w, stop      → prose
 */
const PROSE_MIN_WORDS_WITH_STOP = 4;
const PROSE_MIN_WORDS_WITHOUT_STOP = 8;

/** Money and the ways an area is written. Digits are tested separately. */
const CURRENCY_OR_AREA = /[$€£¥]|\b(?:m2|m²|sqm|sq\s?m|hectares?|ha|acres?)\b/i;

/**
 * Could this line be stating a property fact?
 *
 * Asked only of a line this reader could NOT claim, and answered on the
 * conservative side every time. It detects; it never extracts.
 *
 * The heading scan walks every window of up to `MAX_LABEL_WORDS` words through
 * `fieldForHeader` — the SAME vocabulary the claimers use, never a second list
 * — so a heading anywhere in the line counts, not only at its start. That is
 * the half that catches a design or an estate written with no number in it.
 */
export function hasSpecificationCue(line: string): boolean {
  const trimmed = line.trim();
  if (/\d/.test(trimmed)) return true;
  if (CURRENCY_OR_AREA.test(trimmed)) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let start = 0; start < tokens.length; start++) {
    const reach = Math.min(MAX_LABEL_WORDS, tokens.length - start);
    for (let length = 1; length <= reach; length++) {
      if (fieldForHeader(tokens.slice(start, start + length).join(' '))) return true;
    }
  }
  return false;
}

/**
 * Does this line state ONLY fields this reader declines by policy?
 *
 * `Full turnkey inclusions: landscaping, driveway and fencing.` is the shape
 * that needs it. Its label is three words the alias table does not resolve as
 * a whole, so no claimer touches it; but `inclusions` IS a heading, which
 * makes it a cue, which without this rule makes an ordinary brochure's
 * inclusions paragraph stand the whole document down.
 *
 * It is the same decision the labelled branch makes for `Inclusions: …`, and
 * it is safe for the same reason: `BROCHURE_CLAIMABLE_FIELDS` names four
 * fields a stock row may not carry from a brochure, so a model would not
 * recover them either and standing down over one buys nothing.
 *
 * TWO GUARDS KEEP IT NARROW. Every heading in the line must be one of the
 * declined four — one recognised claimable heading and this answers nothing,
 * so `Land Size 350 m2` is untouched — and the line must state no FIGURE at
 * all, because `Inclusions: 2 living areas` states something a row could have
 * carried and this module is not the judge of what.
 *
 * Returns the declined field names, or null where the rule does not apply.
 */
function declinedHeadings(line: string): string[] | null {
  const trimmed = line.trim();
  if (/\d/.test(trimmed) || CURRENCY_OR_AREA.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const found = new Set<string>();
  for (let start = 0; start < tokens.length; start++) {
    const reach = Math.min(MAX_LABEL_WORDS, tokens.length - start);
    for (let length = 1; length <= reach; length++) {
      const field = fieldForHeader(tokens.slice(start, start + length).join(' '));
      if (!field) continue;
      if (BROCHURE_CLAIMABLE_FIELDS.has(field)) return null;
      found.add(field);
    }
  }
  return found.size ? [...found] : null;
}

/**
 * THE MOST WORDS A PROPER NAME IS SET IN.
 *
 * `Aspire 24 Grande Facade`, `The Reserve at Warralily` — past this a line is
 * a sentence about the property rather than the property's name, and this
 * module does not read sentences.
 */
const MAX_NAME_TOKENS = 6;

/**
 * The characters a lot or unit designation is made of.
 *
 * `12A`, `315/2` and `315` are all real and a builder may spell one however
 * they like — but a lot number is not a measurement and not a price, which is
 * what this is here to say. Named once because two readers ask it.
 */
const LOT_DESIGNATION = /^[0-9]{1,6}[A-Za-z]?(?:[/-][0-9A-Za-z]{1,6})?$/;

/**
 * Is this line set the way a PROPER NAME is set?
 *
 * The one typographic fact that separates `PALOMINO ESTATE` from
 * `Welcome to Palomino Estate`: a name capitalises every word it has, and a
 * sentence does not capitalise its function words. Digits and punctuation are
 * not letters and carry no case, so `ENZO 8.5 LUCA` is a name and `8.5` on
 * its own is not disqualified by having no letter at all.
 *
 * It is a property of how the PAGE was typeset, not a list of words, which is
 * what makes it safe to apply to any builder's vocabulary.
 */
function readsAsAName(value: string): boolean {
  const tokens = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > MAX_NAME_TOKENS) return false;
  return tokens.every((token) => {
    const letter = token.match(/[A-Za-z]/);
    return !letter || letter[0] === letter[0].toUpperCase();
  });
}

/**
 * THE DOCUMENT NAMED THE FIELD INSIDE THE NAME — `PALOMINO ESTATE`.
 *
 * A brochure rarely writes `Estate: Palomino`. It writes the estate's name,
 * and the name ENDS in the word for what it is: an estate, a development, a
 * community, a project, a design. That trailing word is a heading the
 * existing alias table already resolves, so the document has labelled the
 * line itself and nothing here has to decide which of two bare lines is
 * which.
 *
 * FOUR GUARDS. The heading must be the line's LAST run (a heading in the
 * middle is a specification — `Land Size 350 m2`); the field it resolves to
 * must be one this reader may claim AND descriptive, so `PACKAGE PRICE` and
 * `LAND SIZE` claim nothing here; something must remain in front of it to BE
 * the name; and the line must be set as a name, which is what keeps
 * `Welcome to Palomino Estate` out.
 *
 * THE VALUE IS THE LINE AS PRINTED. `Estate` is part of `Palomino Estate`
 * the way it is not part of a caption, and no rule can tell those apart — so
 * nothing is stripped, because editing a builder's own name is a judgement
 * this module does not get to make.
 */
function readInlineFieldName(line: string): Claim | null {
  const trimmed = String(line ?? '').trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  if (!readsAsAName(trimmed)) return null;
  if (CURRENCY_OR_AREA.test(trimmed)) return null;
  const reach = Math.min(MAX_LABEL_WORDS, tokens.length - 1);
  for (let length = reach; length >= 1; length--) {
    const field = fieldForHeader(tokens.slice(tokens.length - length).join(' '));
    if (!field) continue;
    if (!BROCHURE_CLAIMABLE_FIELDS.has(field)) return null;
    if (!DESCRIPTIVE_FIELDS.has(field)) return null;
    const name = tokens.slice(0, tokens.length - length).join(' ');
    // All headings and no name is a caption row, not a statement.
    if (!name || fieldForHeader(name)) return null;
    return { field, value: trimmed };
  }
  return null;
}

/**
 * THE NAME FIRST AND ITS CAPTION UNDER IT.
 *
 *     ENZO 8.5 LUCA
 *     HOME DESIGN
 *
 * The mirror of `readVerticalPair`, and a brochure sets identity this way at
 * least as often as the other. It is tried only after the label-over-value
 * reading has failed, so a column of `LAND / 350 m² / HOUSE / 210 m²` still
 * pairs downwards and nothing here can reach it.
 *
 * DESCRIPTIVE FIELDS ONLY, and this is the guard that matters. A caption
 * reading over a numeric or identity field would take `$863,850` above `LOT`
 * as a lot number; a name is the only thing a brochure captions this way, so
 * the value must be a name, must not be a measurement and must not carry
 * money or an area unit.
 */
function readCaptionedValue(
  value: string,
  label: string | undefined,
): { claim: Claim } | null {
  if (label === undefined) return null;
  const field = fieldForHeader(label);
  if (!field || !BROCHURE_CLAIMABLE_FIELDS.has(field)) return null;
  if (!DESCRIPTIVE_FIELDS.has(field)) return null;
  const trimmed = String(value ?? '').trim();
  // A heading is a layout, never a value — the same rule the pair reader has.
  if (fieldForHeader(trimmed)) return null;
  if (BARE_MEASUREMENT.test(trimmed)) return null;
  if (CURRENCY_OR_AREA.test(trimmed)) return null;
  if (!readsAsAName(trimmed)) return null;
  return { claim: { field, value: trimmed } };
}

export function readsAsProse(line: string): boolean {
  // A line that might be a fact is never prose, whatever shape it is in.
  if (hasSpecificationCue(line)) return false;
  const trimmed = line.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (/[.!?]$/.test(trimmed)) return words > PROSE_MIN_WORDS_WITH_STOP;
  return words > PROSE_MIN_WORDS_WITHOUT_STOP;
}

/*
 * ===========================================================================
 * WHAT A DOCUMENT SAYS ABOUT ITSELF.
 * ===========================================================================
 *
 * `readsAsProse` answers "is this a sentence?", and it answers it only for a
 * line carrying no cue at all — which is right, and which leaves out most of
 * the furniture a real brochure is made of. A builder's phone number is seven
 * digits and a cue by every test above; so is `© 2026 Acme Homes`, so is
 * `Page 3 of 7`, and so is `www.acmehomes.com.au` the moment a dot meets a
 * digit. A reader that must account for every one of them can never finish a
 * genuine document.
 *
 * THIS IS NOT THE OPPOSITE OF THE BLOCKING RULE, IT IS NARROWER THAN IT. A
 * line is incidental only where it was RECOGNISED as one of a closed list of
 * things a publisher writes about the publication — a telephone number, an
 * email address, a web address, a page number, a legal or licence line, a
 * disclaimer. Everything else that could not be read is unaccounted and
 * stands the document down, including every short line this module cannot
 * name: `PALOMINO` and `ENZO 8.5 LUCA` are not furniture, they are an estate
 * and a design, and the assisted reader can read them.
 *
 * The asymmetry that decides every doubtful case is the one this module is
 * built on: a false "incidental" loses a field out of a client's record for
 * good, and a false "unaccounted" costs one model call. So a recogniser here
 * must match the WHOLE line (or carry an unmistakable legal cue), and a
 * recogniser that is unsure matches nothing.
 */

/**
 * The label a brochure puts in front of a contact detail. Stripping it is
 * what lets the body be tested as a whole, and its presence is also evidence:
 * a number the document itself labelled `Ph` is a telephone number whatever
 * shape it is written in.
 */
const CONTACT_LABEL =
  /^(?:ph|phone|tel|telephone|mob|mobile|fax|call|contact|e|email|w|web|website)\b[\s.:|–—-]*/i;

/**
 * A telephone number with NO label in front of it, and deliberately not "a
 * run of digits": `4 2 2 350 863850` is a specification and would satisfy
 * that. So an unlabelled number must OPEN the way a published number opens —
 * an international prefix, an area code, or a 13/1300/1800 service number.
 */
const UNLABELLED_PHONE =
  /^(?:\+\d[\d\s().-]{7,18}|(?:\(0\d\)|0\d|1[38]00|13\s?\d\d)[\d\s().-]{4,16})$/;
/** With a label, the document has already said what the figure is. */
const LABELLED_NUMBER = /^[+(]?[\d\s().+-]+$/;
const EMAIL_BODY = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
/**
 * A web address. A scheme or a `www.` says so outright; a bare host must end
 * in a public suffix we recognise, because `ENZO.LUCA` is not a domain and
 * `8.5` must never look like one.
 */
const WEB_BODY = new RegExp(
  '^(?:https?://\\S+'
  + '|www\\.[a-z0-9][^\\s]*'
  + '|[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*'
  + '\\.(?:com|net|org|edu|gov|info|biz|io|co|au|nz)(?:\\.[a-z]{2,3})?(?:/\\S*)?)$',
  'i',
);
const PAGE_FURNITURE = /^page\s*\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?$/i;
/**
 * A legal, corporate or presentational statement. These are the only
 * recognisers that may fire on part of a line, because that is how they are
 * written — a disclaimer is a sentence with a term of art in the middle of
 * it — and each term of art belongs to the publication rather than to any
 * property.
 */
const SELF_DESCRIPTION = new RegExp([
  '©', '\\bcopyright\\b', '\\ball rights reserved\\b',
  '\\bA\\.?B\\.?N\\.?\\b', '\\bA\\.?C\\.?N\\.?\\b', '\\bE\\.?\\s?&\\s?O\\.?E\\b',
  '\\bsubject to change\\b', '\\bwithout notice\\b', '\\bwhile every (?:care|effort)\\b',
  "\\bartist'?s impression\\b", '\\bfor illustrat\\w+', '\\billustrative purposes\\b',
  '\\bindicative only\\b', '\\bnot to scale\\b', '\\bterms (?:and|&) conditions\\b',
  '\\bdisclaimer\\b', '\\bprivacy policy\\b', '\\bQBCC\\b',
  '\\blicen[cs]e (?:no\\b|number\\b|#)', '\\bbuilder\'?s? licen[cs]e\\b',
].join('|'), 'i');

/**
 * Is this line the document talking about itself?
 *
 * Every answer of `true` is a POSITIVE recognition. There is no fall-through
 * to `true` and no shape heuristic: a line this function does not recognise
 * is not incidental, which means the caller counts it against the document.
 */
export function isIncidentalContent(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (PAGE_FURNITURE.test(trimmed)) return true;
  if (SELF_DESCRIPTION.test(trimmed)) return true;

  const labelled = CONTACT_LABEL.test(trimmed);
  const body = trimmed.replace(CONTACT_LABEL, '').trim();
  // A label with nothing after it is a label, and labels are the caller's.
  if (!body) return false;
  if (EMAIL_BODY.test(body)) return true;
  if (WEB_BODY.test(body)) return true;
  if (labelled ? LABELLED_NUMBER.test(body) : UNLABELLED_PHONE.test(body)) {
    const digits = body.replace(/\D/g, '').length;
    return digits >= 8 && digits <= 15;
  }
  return false;
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
  if (!LOT_DESIGNATION.test(tokens[1])) return null;
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
 * ONE THING THE PAGE DREW, AND WHERE IT DREW IT.
 *
 * A brochure is not a bag of strings, and reading it as one is what made a
 * legible document unreadable. `readPdfPageTexts` flattens a page to lines,
 * so a two-column block
 *
 *     LAND        HOUSE
 *     350 m²      210 m²
 *
 * arrives as `LAND HOUSE` over `350 m² 210 m²` — two labels and two values
 * with no way to say which belongs to which, and the pair reader correctly
 * refuses it. The positions were never lost, only discarded on that path, and
 * `layoutLines` already reassembles them into rows of cells for the schedule
 * mode. This is the same reading, offered to the brochure.
 *
 * `row` is the visual line the unit sits on and `x` its left edge, which is
 * all the pairing rules need: BESIDE is the next unit on the same row, BELOW
 * is the nearest unit on the next row in the same column.
 *
 * WITHOUT POSITIONS NOTHING CHANGES. A flattened page produces one unit per
 * line, every one at `x = 0` on a row of its own, so BESIDE is always absent
 * and BELOW is always the next line — byte for byte the reading this module
 * has always made.
 */
interface BrochureUnit {
  text: string;
  x: number;
  row: number;
}

/** How far apart two cells may start and still be one column. */
const SAME_COLUMN_TOLERANCE = 12;

function unitsFromPageText(page: string): BrochureUnit[] {
  return String(page ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, row) => ({ text, x: 0, row }));
}

function unitsFromLayout(items: readonly PdfTextItem[]): BrochureUnit[] {
  const units: BrochureUnit[] = [];
  layoutLines(items).forEach((line, row) => {
    for (const cell of line.cells) {
      const text = String(cell.text ?? '').replace(/\s+/g, ' ').trim();
      if (text) units.push({ text, x: cell.x, row });
    }
  });
  return units;
}

/** The unit drawn beside this one, on the same visual line. */
function unitBeside(units: readonly BrochureUnit[], index: number): number | null {
  const next = index + 1;
  if (next >= units.length) return null;
  return units[next].row === units[index].row ? next : null;
}

/**
 * The unit drawn directly BELOW this one, in the same column.
 *
 * Only the very next row is considered — a label whose value is three rows
 * down is a label with nothing under it, not a pair — and only a unit whose
 * left edge lines up with this one's. On the flattened reading every unit is
 * at x = 0 on its own row, so this resolves to the next line and the rule is
 * the one that was always there.
 */
function unitBelow(units: readonly BrochureUnit[], index: number): number | null {
  const from = units[index];
  let targetRow: number | null = null;
  let best: number | null = null;
  for (let j = index + 1; j < units.length; j++) {
    const unit = units[j];
    if (unit.row === from.row) continue;
    if (targetRow === null) targetRow = unit.row;
    if (unit.row !== targetRow) break;
    if (Math.abs(unit.x - from.x) > SAME_COLUMN_TOLERANCE) continue;
    if (best === null || Math.abs(unit.x - from.x) < Math.abs(units[best].x - from.x)) {
      best = j;
    }
  }
  return best;
}

/** Tokens of a value, case and punctuation removed. */
function nameTokens(value: string): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Has the document already had this line read, somewhere else?
 *
 * A brochure prints its estate on the cover, in the running foot and beside
 * the sales office, and it prints the design on the cover and over the floor
 * plan. Exactly one of those printings usually carries the evidence that says
 * what it is — `PALOMINO ESTATE` on page five for the cover's bare
 * `PALOMINO`. The others are the same fact again.
 *
 * So a line whose every token appears in a NAME this reader has already
 * claimed is accounted for. It claims nothing itself and it can move no
 * field: the value came from the printing that carried the evidence, and
 * this only stops the bare repeat from standing the document down.
 *
 * It is matched against names alone — the identity and descriptive fields —
 * because a bare `350` sharing a digit with a land size is a coincidence and
 * a bare `PALOMINO` sharing every token with `PALOMINO ESTATE` is not.
 */
function corroboratedBy(line: string, names: ReadonlyArray<readonly string[]>): boolean {
  const tokens = nameTokens(line);
  if (!tokens.length) return false;
  return names.some((name) => tokens.every((token) => name.includes(token)));
}

/**
 * Read a brochure that STATES its property.
 *
 * Runs on `pageTexts` — the strings `readPdfPageTexts` already produced for
 * this upload — and, where the layout reader supplied them, on the positions
 * the page actually drew its text at. Neither costs a network call: the
 * strings are already in hand and the positions come from the same pinned
 * reader, opened once per upload.
 */
export function readPdfBrochure(
  pageTexts: readonly string[],
  options: {
    positionedPages?: readonly PdfTextLayoutPage[] | null;
    /**
     * The organisation that uploaded the document. Its own name is on every
     * page of its own brochure and is never the estate or the design — so it
     * is recognised as the publisher talking about itself rather than left
     * to stand the document down. Absent, nothing changes.
     */
    organisationName?: string | null;
  } = {},
): PdfDeterministicReading {
  const diagnostics: PdfDeterministicReading['diagnostics'] = {
    mode: 'brochure', pages: pageTexts.length, fieldsRead: [], candidates: 0,
  };

  const claimed = new Map<string, string>();
  /*
   * Lines that may be property information and that this reader did not
   * resolve. ANY ONE OF THEM REFUSES THE DOCUMENT. A COUNT, never the text:
   * the diagnostics go to the import log.
   */
  const unresolved: string[] = [];
  /** Lines POSITIVELY recognised as furniture. Reported, not blocking. */
  let incidental = 0;
  /** Canonical fields the document stated and this reader declines by policy. */
  const declined = new Set<string>();
  const organisation = nameTokens(options.organisationName ?? '');

  /*
   * PAGE BY PAGE, AND THE PAGES NEVER JOIN.
   *
   * The pairing rules reach for the unit UNDER this one, so a document read
   * as one stream would let the last line of a page pair with the first line
   * of the next — `HOUSE` at the foot of page 1 taking `210 m²` off the top
   * of page 2, two facts that were never set together. The page break is the
   * document's own evidence that they are not a pair, so every page is its
   * own unit stream and no rule can leave the page it started on.
   *
   * POSITIONS WHERE THERE ARE POSITIONS. A page the layout reader supplied
   * is read as the rows and cells it was drawn in; a page it did not is read
   * as the lines it flattens to, which is exactly what this module has
   * always read. The two are matched by page NUMBER, so a document whose
   * layout came back short still reads every page it has.
   */
  const positioned = new Map<number, PdfTextItem[]>();
  for (const page of options.positionedPages ?? []) {
    if (page && Number.isFinite(page.page) && Array.isArray(page.items)) {
      positioned.set(page.page, page.items);
    }
  }
  const pages = pageTexts.map((page, index) => {
    const items = positioned.get(index + 1);
    const laid = items && items.length ? unitsFromLayout(items) : null;
    /*
     * A layout reading that produced nothing falls back to the flattened
     * one. An empty page is a page the reader could not decode, and reading
     * it as no content at all would let a document complete around it.
     */
    return laid && laid.length ? laid : unitsFromPageText(page);
  });
  if (positioned.size) diagnostics.mode = 'brochure';

  let scanned = 0;
  for (const units of pages) {
    /** Units already spent as another unit's value. */
    const consumed = new Set<number>();
    for (let index = 0; index < units.length; index++) {
      if (++scanned > MAX_LINES_SCANNED) break;
      if (consumed.has(index)) continue;
      const line = units[index].text;
      const found: Claim[] = [];

      const labelled = readLabelledValue(line);
      if (labelled) {
        if (!BROCHURE_CLAIMABLE_FIELDS.has(labelled.field)) {
          /*
           * A LABEL WE KNOW AND DELIBERATELY DO NOT TAKE — `Status: Selling`,
           * `Inclusions: stone benchtops`.
           *
           * This is the one thing that is NOT a fact we failed to read.
           * `BROCHURE_CLAIMABLE_FIELDS` names four fields a brochure may not
           * settle and gives a reason for each, and the assisted reader is held
           * to the same four: sending the document to a model would not recover
           * them either, so standing down over one buys nothing and costs every
           * real brochure, all of which carry inclusions copy.
           *
           * It is declared rather than dropped. The FIELD NAME goes into the
           * diagnostics, so an import log says which statement was declined and
           * under which rule — a different sentence from "a line we could not
           * read", which is the one below and which blocks.
           */
          declined.add(labelled.field);
          incidental += 1;
          continue;
        }
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
          if (counts) found.push(...counts);
          else {
            const lot = readLotHeading(line);
            if (lot) found.push(lot);
            else {
              const named = readInlineFieldName(line);
              if (named) found.push(named);
              else {
                /*
                 * THE THREE WAYS A PAGE SETS A LABEL BESIDE ITS VALUE, in
                 * the order a document means them.
                 *
                 * BESIDE first, because a cell drawn to the right of a label
                 * on the same line is that label's value and nothing else
                 * can claim it — this is the reading only the positions
                 * make possible. Then BELOW, the label over its value, which
                 * is what the flattened reading already did. Then the
                 * caption, the value over its label, which is tried last so
                 * a column of labels and values can never be read upwards.
                 */
                const beside = unitBeside(units, index);
                const alongside = beside !== null && !consumed.has(beside)
                  ? readVerticalPair(line, units[beside].text) : null;
                if (alongside && beside !== null) {
                  found.push(alongside.claim);
                  consumed.add(beside);
                } else {
                  const below = unitBelow(units, index);
                  const under = below !== null && !consumed.has(below)
                    ? readVerticalPair(line, units[below].text) : null;
                  if (under && below !== null) {
                    found.push(under.claim);
                    consumed.add(below);
                  } else {
                    const caption = below !== null && !consumed.has(below)
                      ? readCaptionedValue(line, units[below].text) : null;
                    if (caption && below !== null) {
                      found.push(caption.claim);
                      consumed.add(below);
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (!found.length) {
        /*
         * ===============================================================
         * A LINE THIS READER DID NOT RESOLVE STANDS THE DOCUMENT DOWN,
         * UNLESS IT WAS RECOGNISED AS THE DOCUMENT'S OWN FURNITURE.
         * ===============================================================
         *
         * THREE THINGS MAY PASS IT, each of them RECOGNISED rather than
         * merely unmatched, and there is no fall-through. Everything else is
         * a fact we can see on the page and did not read, and completing
         * around one of those does not produce a thinner record — it
         * produces a WRONG one, because it also suppresses the assisted
         * reader, which could have read it. The record is then thin for
         * ever, and nothing anywhere says so.
         *
         * The case this rule exists for is the reader's own first fixture:
         *
         *   LOT 315
         *   PALOMINO ESTATE          ← the estate
         *   ENZO 8.5 LUCA            ← the design
         *   Land Size 350 m2
         *
         * Neither bare line resolves through this vocabulary, and refusing to
         * GUESS which is which was right. Calling the document complete anyway
         * was not. It stands down, the model reads all four lines, and the
         * builder gets the property their brochure describes.
         *
         * What may pass: a line the document says about ITSELF, recognised
         * as one (`isIncidentalContent` — a phone number, a web or email
         * address, a page number, a licence or copyright line, a
         * disclaimer); a line whose only heading is a field declined by the
         * policy above and which states no figure (`declinedHeadings` — an
         * inclusions paragraph); and a sentence carrying no cue that it
         * states anything at all (`readsAsProse`). A brochure's phone
         * number, copyright line, website, inclusions copy and marketing
         * prose therefore cost it nothing, which is what keeps this
         * reachable on a real seven-page document.
         */
        const bareLabel = fieldForHeader(line);
        if (bareLabel && BROCHURE_CLAIMABLE_FIELDS.has(bareLabel)) {
          /*
           * A LABEL SET ON ITS OWN WITH NOTHING THIS READER COULD PAIR TO IT.
           * The shape a template whose values live in form fields produces, and
           * the shape a figure under a descriptive heading produces once the
           * pairing has refused it. The document named the fact; importing the
           * rest would publish a record its own brochure contradicts. It is
           * named in the refusal because it is the one unresolved line this
           * reader can identify, and that makes the log actionable.
           */
          diagnostics.fieldsRead = [...claimed.keys()].sort();
          diagnostics.unaccountedLines = unresolved.length + 1;
          diagnostics.incidentalLines = incidental;
          if (declined.size) diagnostics.declinedFields = [...declined].sort();
          return refuse('incomplete', `label_without_value:${bareLabel}`, diagnostics);
        }
        const declinedHere = declinedHeadings(line);
        if (declinedHere) {
          for (const field of declinedHere) declined.add(field);
          incidental += 1;
          continue;
        }
        if (isIncidentalContent(line) || readsAsProse(line)) {
          incidental += 1;
          continue;
        }
        /*
         * THE PUBLISHER'S OWN NAME. A builder's brochure carries the
         * builder's name on every page, and it is never the estate and never
         * the design — the uploading organisation is what a stock row's
         * `builder_name` already comes from, which is why this vocabulary
         * declines to read one off a page at all.
         */
        if (organisation.length && corroboratedBy(line, [organisation])) {
          incidental += 1;
          continue;
        }
        /*
         * UNRESOLVED, AND JUDGED AT THE END. It may yet be the second
         * printing of a name another page stated with its field word
         * attached, and that page may come after this one.
         */
        unresolved.push(line);
        continue;
      }

      for (const claim of found) {
        if (!BROCHURE_CLAIMABLE_FIELDS.has(claim.field)) continue;
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
    /*
     * THE CEILING IS A REFUSAL, NOT A STOPPING POINT. Everything past
     * it is unread by definition, and a reader that completes on the
     * first four thousand lines of a document is completing around
     * whatever the rest of it said.
     */
    if (scanned > MAX_LINES_SCANNED) {
      diagnostics.fieldsRead = [...claimed.keys()].sort();
      diagnostics.unaccountedLines = unresolved.length;
      diagnostics.incidentalLines = incidental;
      return refuse('incomplete', 'line_ceiling_reached', diagnostics);
    }
  }

  /*
   * THE SECOND PRINTING IS NOT A SECOND FACT.
   *
   * Judged here rather than in the loop because the evidence can come later
   * in the document than the bare line it accounts for: a cover states
   * `PALOMINO`, page five states `PALOMINO ESTATE`, and only the second one
   * says what the first one is. The names are the fields that hold one — the
   * identity and descriptive fields — so a digit shared with a land size can
   * never account for anything.
   */
  const names = [...claimed.entries()]
    .filter(([field]) => IDENTITY_FIELDS.includes(field) || DESCRIPTIVE_FIELDS.has(field))
    .map(([, value]) => nameTokens(value))
    .filter((tokens) => tokens.length > 0);
  const stillUnresolved = unresolved.filter((line) => !corroboratedBy(line, names));

  diagnostics.fieldsRead = [...claimed.keys()].sort();
  diagnostics.unaccountedLines = stillUnresolved.length;
  diagnostics.incidentalLines = incidental;
  diagnostics.corroboratedLines = unresolved.length - stillUnresolved.length;
  if (declined.size) diagnostics.declinedFields = [...declined].sort();

  if (!claimed.size) {
    return refuse('unsupported', 'no_labelled_fields', diagnostics);
  }

  /*
   * ===================================================================
   * COMPLETE MEANS THE WHOLE DOCUMENT WAS ACCOUNTED FOR.
   * ===================================================================
   *
   * Every line of it: read into a field, declined under a named policy, or
   * recognised as the document's own furniture. One line that was none of
   * those stands the whole document down.
   *
   * The defect this closes, on the reader's own first fixture:
   *
   *   LOT 315
   *   PALOMINO ESTATE          ← the estate, correctly not guessed at
   *   ENZO 8.5 LUCA            ← the design, correctly not guessed at
   *   Land Size 350 m2
   *   …
   *
   * Refusing to guess which of those two bare lines is the estate and which
   * the design was right. Returning `complete` anyway was not: it imported a
   * property with no development and no design, and — far worse — it
   * SUPPRESSED the assisted reader, which can read both. The deterministic
   * stage turned a document we could read most of into a property missing
   * the two fields we could not, with nothing anywhere saying so.
   *
   * So the supported shape is narrow BY CONSTRUCTION: a brochure completes
   * only where it states its property in labels this vocabulary knows, and
   * everything else on its pages is furniture we could name. The cost of
   * standing down is exactly today's behaviour — one model call, on a route
   * that has made one for every PDF ever uploaded. The cost of completing
   * wrongly is a permanently thinner record that nothing reports.
   */
  if (stillUnresolved.length > 0) {
    return refuse('incomplete', 'unaccounted_specification_lines', diagnostics);
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
  /*
   * A SUMMARY WORD IS NOT A PROPERTY, and the brochure reader needs this
   * rule now for the same reason the schedule reader always has. Reading a
   * page's COLUMNS means a heading can sit over a footer cell — `LOT` above
   * `TOTAL` — and `normaliseStockRow` accepts `lot_number: "TOTAL"` as a
   * perfectly good row. It is the same test, over the same words, that
   * `rowIdentity` applies to a reconstructed table row.
   */
  if (identity.every((field) =>
    SUMMARY_IDENTITY_LABELS.has(flattenIdentity(claimed.get(field) ?? '')))) {
    return refuse('incomplete', 'summary_row_identity', diagnostics);
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
    const record = normaliseStockRow(row);
    if (!record) {
      return refuse('incomplete', 'a_row_could_not_be_normalised', diagnostics);
    }
    /*
     * ===============================================================
     * EVERY ROW MUST NAME A PROPERTY, AND A TOTAL DOES NOT.
     * ===============================================================
     *
     * `normaliseStockRow` admits far more than a property: its own header
     * says the bar is deliberately low, and `identifiesAProperty` accepts a
     * development name beside a figure — which is exactly the shape of
     *
     *     TOTAL | | | | | | | $2,515,505
     *
     * so a schedule's own footer imported as a fourth "property" called
     * TOTAL priced at the sum of the other three.
     *
     * That test is right for a CSV, where it is the only gate a row has and
     * dropping a thin row is worse than importing one, and it is NOT changed
     * here — `normalise.pure.ts` is shared with every other format and this
     * is a PDF-only stage in front of it. What this adds is the stricter
     * question a RECONSTRUCTED row has to answer: does it carry an
     * identifier a person could go and look up? A total, a subtotal, a
     * "prices from" line and a legend carry none.
     *
     * And it stands the WHOLE document down rather than dropping the row,
     * because dropping it would silently decide that one line of a builder's
     * schedule is not stock — the judgement this stage exists not to make.
     */
    const identity = rowIdentity(record as unknown as Record<string, unknown>);
    if (identity === 'none') {
      return refuse('incomplete', 'a_row_identifies_no_property', diagnostics);
    }
    if (identity === 'summary') {
      /*
       * THE FOOTER MOVED INTO THE LOT COLUMN. Under `LOT | DESIGN | PRICE`
       * the word `TOTAL` lands in `lot_number`, which is present and truthy —
       * so "does this row carry an identifier" answered yes for a row that is
       * the sum of the two above it. Asking WHICH word it is, rather than
       * whether one is there, is the difference.
       */
      return refuse('incomplete', 'a_summary_row_is_not_a_property', diagnostics);
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
      if (headerScore(tokens) < 3) continue;
      /*
       * A HEADING ROW IS MADE OF HEADINGS. It names its columns and states
       * none of their values, so a bare figure anywhere in the line means
       * this is a specification, not a heading — `4 BED 2 BATH 2 CAR` and
       * `LAND 350 HOUSE 210 PRICE` both reach three recognised words and
       * neither is a table.
       *
       * Production paid for that: a seven-page brochure tripped this screen,
       * the positional reader ran, the schedule parser found a heading-shaped
       * line and refused the document `two_cells_in_one_column` — a table's
       * refusal, on a document that never held a table, masking the brochure
       * reading underneath it.
       */
      if (tokens.some((token) => VALUE_TOKEN.test(token))) continue;
      return true;
    }
  }
  return false;
}

/**
 * A token that states a value rather than naming a column.
 *
 * ANY TOKEN THAT OPENS WITH A FIGURE, whatever it carries after it. The first
 * version admitted only a bare number, which is the one spelling a builder's
 * screen shot does not use: `350m²`, `350sqm`, `210m2`, `$863,850`, `4-bed`
 * and `2-bath` all state a value and every one of them slipped through, so a
 * specification line reached three recognised words and was read as a heading
 * row. A column HEADING never opens with a figure — `Estate`, `Lot`,
 * `Design`, `Beds`, `Land m2`, `Package Price` — so the widened test costs a
 * genuine heading row nothing and there is no unit list to keep current.
 */
const VALUE_TOKEN = /^[$€£¥]?\d/;

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
  organisationName?: string | null;
}): PdfDeterministicReading {
  const pageTexts = input.pageTexts ?? [];

  const readBrochure = () => readPdfBrochure(pageTexts, {
    positionedPages: input.positionedPages,
    organisationName: input.organisationName,
  });

  /*
   * THE SCHEDULE SCREEN MOVED HERE, and it now decides ORDER as well.
   *
   * It used to gate whether the positions were READ at all, which was right
   * while only the schedule mode used them. The brochure reads them now, so
   * the positions are fetched for every PDF and the screen keeps doing the
   * one job it was written for: a document whose flattened text shows no
   * heading row is never offered to the table parser, so a brochure can
   * never be refused with a table's refusal — the defect that masked a
   * readable document behind `two_cells_in_one_column`.
   *
   * WHY THE TABLE NOW GOES FIRST WHERE THERE IS ONE. The brochure was tried
   * first because a schedule could not pass it: its data lines open with an
   * estate name rather than a label, so they claimed nothing. Reading the
   * page's COLUMNS changes that — a one-row table is a heading over a value
   * in every column, which is exactly the shape the brochure reader is built
   * to read. It would produce the same row, but through a reader that has
   * none of the table parser's guarantees about the grid. So a document the
   * screen says holds a table is read as a table, and the brochure is what
   * happens to everything else and to a table reading that refused.
   */
  const positioned = input.positionedPages ?? null;
  if (positioned && positioned.length && mayHoldSchedule(pageTexts)) {
    const schedule = assemblePdfSchedule(positioned);
    if (schedule.status === 'complete') return schedule;
    const fallback = readBrochure();
    if (fallback.status === 'complete') return fallback;
    // The schedule reading is the more informative refusal wherever the
    // document actually had a table in it.
    if (schedule.reason !== 'no_schedule_found') return schedule;
    return fallback;
  }

  return readBrochure();
}
