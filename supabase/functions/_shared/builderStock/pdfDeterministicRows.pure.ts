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
  normaliseUnits,
  trackedOutHeadings,
  type NormalisedUnit,
  type RawUnit,
} from './documentNormalisation.pure.ts';
import { acceptFieldValue, readsAsACount } from './fieldTypes.pure.ts';
import {
  coerceNumber,
  coercePrice,
  fieldForHeader,
  normaliseStockRow,
} from './normalise.pure.ts';
import { headerScore, keyRowsByHeader } from './table.pure.ts';
import {
  bedroomsFromPlan, bindCountRow, countRoomsNamed,
} from './floorPlanCounts.pure.ts';
import {
  pdfRegionAnchor, segmentPropertyRegions,
  type PageSegmentation, type RegionBox,
} from './propertyRegions.pure.ts';
import { SOURCE_ANCHOR_HEADER } from './sourceAssets.pure.ts';

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
  | 'pdf_deterministic_brochure'
  /**
   * One page, several properties, read region by region.
   *
   * Its own word rather than `brochure`'s, because the import log has to be
   * able to say which reading produced a row: a document read whole and a
   * document read in regions are two different claims about the page, and a
   * defect in one is not a defect in the other.
   */
  | 'pdf_deterministic_regions';

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
  /**
   * WHAT THE READER HAD ALREADY READ WHEN IT STOOD DOWN.
   *
   * DELIBERATELY NOT `rows`, and the note above that field says why: "a
   * refusal that carried rows would be one edit away from importing them."
   * That rule stands. This is a different field, with a different name,
   * populated ONLY on a refusal, and the one caller permitted to act on it is
   * the one that has just established there is no better reader available.
   *
   * WHY IT EXISTS AT ALL. The brochure gate's own reasoning is that
   * completing around an unaccounted line "SUPPRESSED the assisted reader,
   * which can read both" — and it is right. But it is conditional on that
   * reader existing. Measured 21 SEPTEMBER 2026 on
   * `LOT 817 - ELARA 18 TEMPIO LIGHT - BROCHURE V002 (1).pdf`: this reader
   * read `development_name`, `expected_completion`, `house_design` and
   * `price`, stood down on one unaccounted line, and the assisted reader it
   * stood down FOR was refused HTTP 402 by its provider — an account with no
   * credit. Four fields read off the document were discarded to defer to a
   * reader that cannot run, and the builder was told their stock list could
   * not be imported.
   *
   * Standing down suppresses nothing when there is nothing to suppress. So
   * the reading survives its own refusal, and whether it may be USED is a
   * decision taken elsewhere, by a caller that knows what happened next.
   *
   * Empty unless the refusal is one where a property could still be
   * identified: see `provisionalFrom`.
   */
  provisional: Array<Record<string, unknown>>;
  /**
   * The lines this reader could not account for, verbatim.
   *
   * WHY THE TEXT AND NOT JUST THE COUNT, when `diagnostics.unaccountedLines`
   * is deliberately a number. Because the count cannot be acted on. Measured
   * across 21 SEPTEMBER 2026: nine of twelve brochures imported with no model
   * call at all, and every one that did not was a template whose vocabulary
   * this reader had not yet learned — `LOT 717 - ENZO 10.5 MODERN` failed
   * twice at 03:09 and 03:24 and imported at 04:07 from the SAME 8,425,036
   * bytes, once the vocabulary widened. Closing the next gap means knowing
   * which line it is, and a count says only that there was one.
   *
   * DELIBERATELY NOT IN `diagnostics`. That object's contract is that it is
   * safe to log — "no value a document stated ever appears here, because this
   * is written to the import log and a builder's price is not ours to put in
   * a log line" — and this is document text. It travels to the upload row's
   * `error_detail`, which is internal: `get_upload` and
   * `projectUploadListRow` both project it away, and it is read by whoever
   * is fixing the reader.
   *
   * BOUNDED, because an unbounded copy of a document into a column is its own
   * defect.
   */
  unaccounted: string[];
  /**
   * The lines this reader SAW and attributed to nothing, verbatim.
   *
   * WHY, AND IT IS THE LAST TIME THIS QUESTION COSTS A DEPLOY CYCLE. A field
   * that does not populate is answerable in exactly one way: what did the
   * document say, and what did the reader make of it. `diagnostics` carries
   * counts by contract — it is written to the import log — so "359 ignored
   * lines" is all production has ever recorded, and every gap has had to be
   * guessed at or reproduced from a file nobody here can reach.
   *
   * MEASURED 21 SEPTEMBER 2026: `LOT 266 Crowlea Estate - CURA 20B TEMPIO B`
   * imported with no address, no suburb, no state, no estate and no design,
   * beside 359 ignored lines. Nothing anywhere says whether that brochure
   * states a street address at all — so whether this is a vocabulary gap or
   * a document that simply does not carry one cannot be settled.
   *
   * These travel to the upload row's `error_detail`, which is internal:
   * `get_upload` and the upload select both project it away, so no builder is
   * shown their own document quoted back. Bounded, and NOT in `diagnostics`,
   * because the log contract stands.
   */
  ignored: string[];
  /**
   * WHERE EACH OF THOSE LINES WAS DRAWN — `p1 r7 x40`, aligned by index.
   *
   * WHY GEOMETRY AND NOT MORE TEXT. The first reading of `LOT 266 Crowlea
   * Estate` handed back its page-1 block and the block did not settle the
   * question it was captured for: `Estate Warragul` is either one run naming
   * something, or a label in one column and its value in another, and a
   * flattened line cannot be told apart from a flattened pair. The same
   * ambiguity decides `Lot Size` over `520m2` — the property's real land
   * size, which this reader did not take. Numbers only, so nothing here is
   * document text and the alignment is what carries the meaning.
   *
   * FIRST OCCURRENCE OF A GIVEN LINE. A brochure prints `•` forty times and
   * they are all the same bullet; recording each one's own coordinate would
   * buy nothing and cost the entries that matter.
   */
  placement: string[];
  /** Set on `complete` and null otherwise. Recorded as `parse_strategy`. */
  strategy: PdfDeterministicStrategy | null;
  /**
   * WHERE ON THE PAGE EACH PROPERTY WAS DRAWN, when the document segmented.
   *
   * Empty on every other reading, which is every document this reader has
   * ever handled: a caller that finds it empty must behave exactly as it did.
   *
   * It exists for ONE caller and one question — which property owns which
   * picture. A page carrying three cards draws three renders, and the page
   * number cannot tell them apart; the column each was drawn in can. See
   * `regionForImage`, which answers null far more often than it answers a
   * region, because a wrong image is worse than no image.
   *
   * DELIBERATELY NOT IN `diagnostics`: `text` is document text and that
   * object's contract is that it is safe to write to the import log. Nothing
   * here is logged — it is read in-process by `extract.ts` and discarded.
   */
  regions?: PdfReadingRegion[];
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
     * THE READING THAT DID NOT WIN, where two readers both refused.
     *
     * A stable mode word and a stable reason word, so a document that really
     * did hold a broken table still says so in the import log even when the
     * brochure's account is the one returned. Safe to log by the same
     * contract as everything else here. See `moreEvidencedRefusal`.
     */
    alsoTried?: { mode: 'table' | 'brochure' | 'none'; reason: string };
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
     * Lines the document carries that could not change which property this
     * is or what is being sold — a floor plan's room names, inclusions
     * bullets, specification and marketing copy. Counted and reported, and
     * deliberately not blocking: see the gate in `readPdfBrochure`.
     */
    ignoredLines?: number;
    /**
     * Fields the document stated two different ways. Dropped rather than
     * chosen between — see the conflict gate in `readPdfBrochure`.
     */
    disputedFields?: string[];
    /**
     * Set where a bed/bath/car row of bare numbers was read because the
     * document's own floor plan named the same number of bedrooms.
     */
    countsCorroborated?: boolean;
    /**
     * How the configuration row's positions were settled — `fraction_is_
     * bathrooms`, `plan_named_bedrooms` and so on. Safe by construction:
     * evidence NAMES, never a value the document stated.
     */
    countEvidence?: string[];
    /**
     * Optional attributes the document states only in PICTURES. The
     * production brochure prints `3 2 1` beside bed, bath and car icons,
     * and the icons are images — so the counts are named here as unread
     * rather than assigned by the usual order, which would be inference.
     */
    visualOnlyFields?: string[];
    /**
     * Canonical fields the document stated and this reader declines BY
     * POLICY — the four `BROCHURE_CLAIMABLE_FIELDS` names for stated
     * reasons. Named rather than counted, because "we did not take the
     * status" is a different sentence from "we could not read a line", and
     * an import log should be able to tell them apart.
     */
    declinedFields?: string[];
    /**
     * `field:reason` for every declined field the gate named a reason for, in
     * `fieldTypes.pure.ts`'s own fixed vocabulary.
     *
     * A field name alone says a statement was refused and not what was wrong
     * with it — `land_size_sqm` declined reads as a brochure with a missing
     * measurement until the log can say `money_is_not_an_area`. The vocabulary
     * is this product's, never a document's words, so it is safe to log.
     */
    declinedBecause?: string[];
    /**
     * `field:reader` for every field claimed, in this module's own reader
     * vocabulary. A log that says WHAT was read and not HOW cannot tell a
     * figure the document spelled out from one inferred off a position, and
     * that distinction is the whole difference between the readings here.
     */
    readBy?: string[];
    /**
     * How many independent property regions the document's pages carried.
     *
     * A COUNT, so it is safe to log by the same contract as everything else
     * here — and it is reported whichever way the reading went, because the
     * question an operator asks about a multi-property sheet is "did it see
     * the cards at all", and a reading that fell back looks identical to one
     * that never segmented.
     */
    regionsFound?: number;
    /**
     * Why a segmented reading was abandoned, in this module's own vocabulary.
     *
     * Set only where regions WERE found and the document was still read
     * whole. Every one of these is a statement about THIS reader, never a
     * finding about the document.
     */
    regionsAbandoned?: string;
  };
}

/**
 * One property region, as the reading hands it on.
 *
 * `box` is in the layout reader's own units, which is the same space a
 * picture's `placement.drawn` rectangle is measured in — that is what makes
 * the two comparable at all.
 */
export interface PdfReadingRegion {
  /** 1-based, the page a person sees. */
  page: number;
  /** Reading order within the page: left to right, then top to bottom. */
  index: number;
  box: RegionBox;
  /** `pdf:page{N}#r{i}` — the anchor the region's property carries. */
  anchor: string;
  /**
   * The region's own text, flattened.
   *
   * WHY IT TRAVELS. Every question the imagery path asks about a property is
   * asked of "its page" — does the page state its identity, does the page
   * state package facts, how many pictures does the page draw. On a page
   * carrying three cards each of those answers is about all three, and
   * `pageStatesIdentity`'s rule 2 refuses a page naming any other lot, which
   * is correct for a page read whole and wrong for a card. Once the page has
   * been segmented the property's page IS its region, so the region's text is
   * what those questions are asked of.
   */
  text: string;
}

/**
 * The record a stood-down brochure reading would have produced, or none.
 *
 * HELD TO THE SAME BAR AS A COMPLETE READING, and that is the whole safety
 * argument: every gate below the unaccounted-lines one still applies, in the
 * same order, over the same inputs. A provisional record therefore names a
 * property, is not a summary row, carries at least `MIN_BROCHURE_FIELDS`, maps
 * every field to a canonical header, and survives `normaliseStockRow`. What it
 * does NOT have is an account of every line on the page — which is exactly and
 * only what the refusal was about.
 *
 * SO IT IS THINNER, NEVER WRONGER. Each value in it was read off the document
 * by a named reader and is the same value a complete reading would have
 * carried; the fields it lacks are fields nothing claimed. There is no
 * inference here and no widening: a field this function invents is a field the
 * complete path would have invented too.
 *
 * NULL RATHER THAN A PARTIAL RECORD wherever any of those gates refuses,
 * because a row with no identity cannot be matched, re-matched or
 * de-duplicated — importing one creates a property nothing can ever find
 * again, which is worse than the import that failed.
 */
function provisionalFrom(
  claimed: Map<string, string>,
): Array<Record<string, unknown>> {
  const identity = IDENTITY_FIELDS.filter((field) => claimed.has(field));
  if (!identity.length) return [];
  if (identity.every((field) =>
    SUMMARY_IDENTITY_LABELS.has(flattenIdentity(claimed.get(field) ?? '')))) return [];
  if (claimed.size < MIN_BROCHURE_FIELDS) return [];

  const raw: Record<string, unknown> = {};
  for (const [field, value] of claimed) {
    const header = CANONICAL_HEADER[field];
    if (!header) return [];
    raw[header] = value;
  }
  return normaliseStockRow(raw) ? [raw] : [];
}

function refuse(
  status: Exclude<PdfDeterministicStatus, 'complete'>,
  reason: string,
  diagnostics: PdfDeterministicReading['diagnostics'],
  provisional: Array<Record<string, unknown>> = [],
  unaccounted: string[] = [],
  ignored: string[] = [],
  placedAt: ReadonlyMap<string, string> = new Map(),
): PdfDeterministicReading {
  const kept = boundLines(ignored);
  return {
    status, rows: [], provisional, strategy: null, reason, diagnostics,
    ignored: kept,
    placement: kept.map((line) => placedAt.get(line) ?? ''),
    // Bounded on both axes: enough to name the gap, never a copy of the page.
    unaccounted: unaccounted.slice(0, MAX_UNACCOUNTED_REPORTED)
      .map((line) => line.slice(0, MAX_UNACCOUNTED_LINE_CHARS)),
  };
}

/** Enough to name a vocabulary gap; never enough to reconstruct a document. */
const MAX_UNACCOUNTED_REPORTED = 12;
const MAX_UNACCOUNTED_LINE_CHARS = 120;
/**
 * And a wider bound for the lines a reader ATTRIBUTED TO NOTHING, because a
 * missing address is somewhere among them and twelve lines of a brochure's
 * several hundred would be a lottery.
 *
 * IT WAS 80 AND THAT WAS A SAMPLE, NOT A CEILING. `LOT 266 Crowlea Estate`
 * left 359 lines unnamed and the eighty that came back stopped in the middle
 * of the inclusions list — so the one question the capture exists to answer,
 * what this document says about where the property IS, was answered for page
 * one and cut off for the rest. A brochure of this kind runs to about 360
 * lines, so this is a ceiling above the whole document rather than a window
 * onto part of it, which is what a diagnosis needs to be.
 *
 * Still a bound, and still 120 characters a line: an unbounded copy of a
 * document into a column is its own defect, and the column is internal —
 * `get_upload` and `projectUploadListRow` both project it away.
 */
const MAX_IGNORED_REPORTED = 400;

function boundLines(lines: readonly string[]): string[] {
  return lines.slice(0, MAX_IGNORED_REPORTED)
    .map((line) => line.slice(0, MAX_UNACCOUNTED_LINE_CHARS));
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
 * THE FOOTER THAT IS A SENTENCE, NOT A WORD — JUDGED ON WHAT THE DOCUMENT
 * WROTE, WHICH IS THE WHOLE OF WHY THE FIRST ATTEMPT DID NOT WORK.
 *
 * `SUMMARY_IDENTITY_LABELS` catches `TOTAL`, because a footer under a `LOT`
 * column is usually one word. A stock list's other footer is a sentence, and
 * it lands in the same cell:
 *
 *     All prices correct at time of publication. E&OE. | | | | | | |
 *
 * MEASURED 21 SEPTEMBER 2026 on the acceptance corpus's three-property
 * schedule, which imported FOUR properties — the fourth a property whose lot
 * number was that sentence. A phantom row on a builder's card is a fabricated
 * record, which is the one outcome this reader may never produce.
 *
 * IT IS ASKED OF THE SOURCE ROW AND NEVER OF THE NORMALISED RECORD.
 * `normaliseStockRow` caps a lot number at 39 characters, so by the time the
 * record exists the cell reads `All prices correct at time of publicatio` —
 * the `E&OE.` that identifies it has been cut off, and every recogniser in
 * this module then answers no. A coerced field is not evidence about the
 * document; the cell is.
 *
 * Recognised, never guessed: `isIncidentalContent` is the same closed-list
 * recogniser brochure mode already applies to this exact sentence — `E&OE`
 * is a term of art in `SELF_DESCRIPTION` — so the two modes now agree about
 * one line instead of disagreeing about it.
 */
function rowIsPublicationFurniture(row: Record<string, unknown>): boolean {
  const cells = Object.values(row)
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '');
  if (!cells.length) return false;
  return cells.every((cell) => isIncidentalContent(cell) || readsAsProse(cell));
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
  /**
   * WHICH READING PRODUCED THIS, for the import log and nothing else.
   *
   * A stock item imported with `bathrooms: 9` took a day to explain, because
   * the log could say which fields were read and not how — and the readers
   * differ enormously in how much they prove. It is a fixed vocabulary of
   * this module's own reader names, so it carries nothing a document said.
   */
  via?: ClaimSource;
}

type ClaimSource =
  | 'labelled'
  | 'labelled_numbers'
  | 'inline_counts'
  | 'lot_heading'
  | 'named_place'
  | 'inline_field_name'
  | 'leading_field_name'
  | 'address_block'
  | 'beside'
  | 'below'
  | 'caption'
  | 'filename'
  | 'icon_row';

/** Stamp a reader's name on what it produced, without rewriting the reader. */
function via(source: ClaimSource, claims: readonly Claim[]): Claim[] {
  return claims.map((claim) => ({ ...claim, via: claim.via ?? source }));
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

/**
 * THE MARKER A VALUE CARRIES IS PART OF ITS LABEL — `Build 214m2` IS
 * `build m2`, AND `Package $749,000` IS `package $`.
 *
 * MEASURED 21 SEPTEMBER 2026 across two acceptance documents, on lines whose
 * every other figure read perfectly:
 *
 *     4  2  2     Land 448m2     Package $845,000
 *     Land 392m2   Build 214m2   Package $749,000
 *
 * `Land` resolved and the property imported with its land size, its lot, its
 * street and its design — and with NO PRICE and NO BUILD SIZE, which on a
 * marketplace card is the figure a buyer came for. `Build` and `Package` are
 * not labels on their own; `build m2`, `build sqm`, `package $` and
 * `package price $` all ARE, and have been since the header vocabulary was
 * written. The spellings were never missing. What was missing is that a
 * brochure attaches the marker to the VALUE — `214m2`, `$749,000` — while a
 * spreadsheet puts it in the column heading, which is the shape the
 * vocabulary was built from.
 *
 * So a bare label that does not resolve is retried ONCE with the marker its
 * value carries. Nothing new is admitted: a spelling that is not already in
 * the vocabulary still resolves to nothing, which is why this cannot invent
 * a field. `Package 3` stays unread, because `package` alone is not a
 * heading and `3` carries no marker — the bare word never becomes a price.
 *
 * ONLY `$` AND THE AREA UNITS, and deliberately not a general suffix rule:
 * those are the two markers the heading vocabulary actually spells, and a
 * marker it does not spell would be a guess about what the builder meant.
 */
function markerOf(value: string): string | null {
  const text = String(value ?? '');
  if (text.includes('$')) return '$';
  const unit = text.match(/(m2|m²|sqm)\s*$/i);
  return unit ? unit[1].toLowerCase() : null;
}

/** `labelAt`, retried with the marker the value beside it carries. */
function labelAtWithValueMarker(
  tokens: string[], start: number, value: string,
): { field: string; length: number } | null {
  const marker = markerOf(value);
  if (!marker) return null;
  const available = Math.min(MAX_LABEL_WORDS, tokens.length - start);
  for (let length = available; length >= 1; length--) {
    const phrase = `${tokens.slice(start, start + length).join(' ')} ${marker}`;
    const field = fieldForHeader(phrase);
    if (field) return { field, length };
  }
  return null;
}

/**
 * The fields whose label is also the name of a ROOM.
 *
 * Named here because `readLabelledNumbers` must refuse them and nothing else
 * may: every other numeric field's label (`Land Size`, `Price`, `Build Size`)
 * names a measurement of the property and never a part of it.
 */
const COUNT_FIELDS: ReadonlySet<string> = new Set([
  'bedrooms', 'bathrooms', 'car_spaces',
]);

/*
 * WHAT A COUNT, AN AMOUNT AND A DESIGNATION LOOK LIKE MOVED OUT OF THIS FILE.
 *
 * `COUNT_VALUE`, `MAX_PLAUSIBLE_COUNT`, `statesACount`, `statesAnAmount`,
 * `MEASURED_FIELDS`, `LOT_DESIGNATION`'s shape and the letter-spaced-value
 * guard were six rules about WHAT A VALUE IS, written here because this is
 * where the claims are. They are `fieldTypes.pure.ts`'s now, asked once at the
 * one gate every claim passes through — and `readsAsACount` is imported back
 * for the icon-row reader, which asks the same question while DISCOVERING
 * rather than while deciding.
 */

/** The two fields that say WHICH property this is. Suppression reads it. */
const DESIGNATION_FIELDS = new Set(['lot_number', 'unit_number']);

/** Is this label written as more than one of the thing it names? */
function isPlural(labelTokens: readonly string[]): boolean {
  const last = labelTokens[labelTokens.length - 1] ?? '';
  return /s$/i.test(last);
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
    /*
     * The value this label would take, looked at BEFORE the label is
     * resolved, because the marker it carries is part of the label. See
     * `labelAtWithValueMarker`.
     */
    const bare = labelAt(tokens, index);
    const label = bare && NUMERIC_VALUE_FIELDS.has(bare.field)
      ? bare
      : (labelAtWithValueMarker(tokens, index, tokens[index + 1] ?? '')
        ?? labelAtWithValueMarker(tokens, index, tokens[index + 2] ?? '')
        ?? bare);
    if (!label || !NUMERIC_VALUE_FIELDS.has(label.field)) return null;
    /*
     * `BED 3` IS THE THIRD BEDROOM. `BEDROOMS 3` IS THREE BEDROOMS.
     *
     * Measured on the production brochure for Lot 315: its floor plan
     * annotates the rooms `Bed 1`, `Bed 2` and `Bed 3` at 6.7pt, and this
     * reader claimed `bedrooms: 3` off one and `bedrooms: 2` off another.
     * The conflict rule caught THAT document — but a plan drawing a single
     * `Bed 3` would have been claimed silently, and a bedroom count read off
     * a room's NAME is a fabricated figure.
     *
     * The counts are the only fields with this collision, because they are
     * the only ones whose label also names a ROOM; no floor plan annotates a
     * room `Land Size` or `Price`. And the two readings are told apart by
     * NUMBER, which is a property of English rather than of any builder: a
     * room label names ONE room and is written singular, a count names
     * several and is written plural. `Bed 3` claims nothing; `Bedrooms 3`,
     * `Beds 3` and `Baths 2` are unchanged, and so are `3 BED` (the figure
     * first, read by `readInlineCounts`), `Bedrooms: 3` (the document's own
     * colon) and a label paired with the cell beside or beneath it.
     */
    if (COUNT_FIELDS.has(label.field)
      && !isPlural(tokens.slice(index, index + label.length))) {
      return null;
    }
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
  const match = line.match(LABELLED_VALUE);
  if (!match) return null;
  const field = fieldForHeader(match[1]);
  if (!field) return null;
  return { field, value: match[2].trim() };
}

/**
 * `Titles - Q2 2027` — A SPACED HYPHEN IS A SEPARATOR; A HYPHEN IS NOT.
 *
 * The separator class was `:`, an en dash and an em dash, and a plain hyphen
 * was deliberately outside it because a hyphen lives INSIDE the names this
 * reader must not cut in half: `ENZO 10.5 - MODERN` is a design, and a rule
 * that splits on any hyphen renames it `ENZO 10.5`.
 *
 * MEASURED ON `LOT 266 Crowlea Estate`, whose whole summary block is written
 * with one: `Land - $334,000`, `Build - $415,100`, `Titles - Q2 2027`. The
 * completion date was on the page under a label this vocabulary already
 * knows and was read by nothing.
 *
 * TWO THINGS MAKE IT SAFE, AND THE SECOND WAS ALREADY THERE. The hyphen must
 * be SPACED on both sides, so `Land-Size: 350` still splits at its colon and
 * not at its hyphen. And what stands to the left must resolve to a field
 * this vocabulary names — the guard `readLabelledValue` has always applied —
 * so `ENZO 10.5 - MODERN` splits to `ENZO 10.5`, resolves to nothing and
 * falls through to every reader that handled it before, unchanged. So does
 * `Build - $415,100`, because `Build` is not a heading here, and so does
 * `Total - $749,100`.
 *
 * The left side is lazy and stops at the first separator, so a label may not
 * itself contain one — which is what it already meant for a colon.
 */
const LABELLED_VALUE = /^([^:–—]{1,60}?)\s*(?::|–|—|\s-\s)\s*(.*)$/;

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
  // Nor is a line that is itself asking for a value.
  if (/[:–—]$/.test(value.trim())) return null;
  /*
   * AND A LINE THAT IS ITSELF A `Label: value` STATEMENT BELONGS TO ITS OWN
   * LABEL, NOT TO THIS ONE.
   *
   * A siting plan leaves boxes empty — `Estate:` with nothing after it —
   * and the next line is the next field. Pairing downwards swallowed it
   * whole: `development_name: "Home Design: Aspire 24 Grande"`, a design
   * written into the estate and the design itself then lost. Two labels
   * cannot share one value.
   */
  if (statesItsOwnLabel(value)) return null;

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
  } else if (resolved === 'external_reference' && !HAS_DIGIT.test(value)) {
    /*
     * A REFERENCE CARRIES A NUMBER, AND A FLOOR PLAN IS FULL OF THINGS THAT
     * DO NOT.
     *
     * Production, 21 Sep 2026: a flyer imported with
     * `external_reference: "D.W"` — the dishwasher, annotated on the plan,
     * paired with a cell this vocabulary reads as a reference (`REF`, `ID`
     * and `SKU` all resolve to it). It passed every guard above because it
     * is neither a measurement nor a name.
     *
     * That is the worst field to be wrong in: `external_reference` is what a
     * later upload MATCHES a property by, so a plan abbreviation two
     * different builders both draw would merge two different houses into one
     * row. `MC-0041`, `SKU-99` and `H&L-12` all carry a digit; `D.W`, `W.C`
     * and `P'TRY` carry none.
     *
     * Only the PAIRING path is narrowed. A document that labels its own
     * reference — `Ref: ABC` — is read by `readLabelledValue` and is
     * untouched, because there the document said which field it meant.
     */
    return null;
  } else if (COUNT_FIELDS.has(resolved)) {
    /*
     * ==================================================================
     * A COUNT IS NEVER READ OUT OF A POSITION.
     * ==================================================================
     *
     * Production, 21 Sep 2026: a one-page flyer imported with
     * `bathrooms: 9` on a card whose own icon row reads `3 2.5 1`. Nine
     * bathrooms was then printed to the builder, and it did a second harm
     * — a count already claimed suppresses the icon row, so the figure the
     * document really states was never reached.
     *
     * The counts are the only fields whose label also names a ROOM, and
     * this module has now paid for that twice: `Bed 3` is the third
     * bedroom rather than three bedrooms, and `Garage: 22.59m²` is an area
     * rather than a car space. A plan that draws `BATH` in one cell and a
     * figure in the next is stating a dimension, a grid reference or a
     * schedule line — the adjacency is the plan's layout, not a sentence.
     *
     * So positional evidence no longer reaches a count at all. What still
     * does is every form where the document itself joins the word to the
     * number: `Bedrooms: 3`, `Bedrooms 3`, `3 BED 2 BATH 1 CAR` — and the
     * icon row, which is corroborated against the plan's own bedrooms
     * before it may claim anything.
     *
     * The direction of the loss is the one this product already chose
     * everywhere else: a count nobody can prove is null, and the builder
     * is told it was not stated.
     */
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
/**
 * `ESTATE WARRAGUL` — THE DOCUMENT NAMED THE FIELD IN FRONT OF THE VALUE.
 *
 * The mirror of `readInlineFieldName`, and it exists because a summary block
 * writes its rows the other way round. Measured on `LOT 266 Crowlea Estate`:
 * the page states `Land - $334,000`, `Build - $415,100`, `Titles - Q2 2027`
 * and then, in the same column with no separator at all, `Estate Warragul`.
 * The estate was on the page, under a word this vocabulary already resolves,
 * and read by nothing — and with no estate claimed the filename may not
 * corroborate a design either, so `Cura 20B` went with it.
 *
 * THE VALUE IS WHAT FOLLOWS, WHICH IS THE ONE ASYMMETRY WITH THE MIRROR.
 * There the heading is the last run and is part of the name — `Estate` is
 * part of `Palomino Estate`. Here it leads, and a name does not begin with
 * the word for what it is, so the label is a label and the value is the rest.
 *
 * THE SAME GUARDS, AND THEY ARE WHAT KEEPS A SPECIFICATION SHEET OUT. The
 * line must read as a name, so 300 lines of inclusions prose cannot reach
 * it; it must not carry a currency or an area, which belongs to the numeric
 * readers; it must not end in its own colon, which is a label asking for a
 * value in the next cell; it must not resolve WHOLLY through the alias table,
 * because `Lot Size` is a heading and not a field beside a name; the field
 * must be one this reader may claim AND descriptive, so `Bed 3` and
 * `Garage Double` claim nothing; and what follows must not itself be a
 * heading, because a heading beside a heading is a layout.
 *
 * AND THE LABEL IS AN ALLOW-LIST, BECAUSE THE GUARDS ABOVE WERE NOT ENOUGH.
 * Driven over all 359 lines that document left unnamed, every guard in place,
 * this claimed exactly two: `Estate Warragul`, and `House Specifications` as
 * a house design called "Specifications". The second is a SECTION HEADING —
 * and so are `Home Design`, `Design Guidelines` and `Kitchen Appliances`. In
 * a trailing position the word for a thing belongs to the name in front of
 * it; in a LEADING position it is as likely to be introducing a page as
 * labelling a value, and no structural test separates the two.
 *
 * So only the fields where a leading label is a statement are read, and the
 * design is not among them — it does not need to be. `Cura 20B` reaches the
 * record the way it always could: `corroborateDesignFromFilename` confirms a
 * name the page prints against the name the builder gave the file, and its
 * one precondition is an estate or project, which is exactly what this
 * closes. The list may grow, on the same terms it was made: evidence from a
 * document, not a guess about word order.
 */
const LEADING_LABEL_FIELDS: ReadonlySet<string> = new Set([
  'development_name', 'project_name',
]);
function readLeadingFieldName(line: string): Claim | null {
  const trimmed = String(line ?? '').trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  if (!readsAsAName(trimmed)) return null;
  if (CURRENCY_OR_AREA.test(trimmed)) return null;
  if (/[:–—]$/.test(trimmed)) return null;
  if (fieldForHeader(trimmed)) return null;
  const reach = Math.min(MAX_LABEL_WORDS, tokens.length - 1);
  for (let length = reach; length >= 1; length--) {
    const field = fieldForHeader(tokens.slice(0, length).join(' '));
    if (!field) continue;
    if (!BROCHURE_CLAIMABLE_FIELDS.has(field)) return null;
    if (!DESCRIPTIVE_FIELDS.has(field)) return null;
    if (!LEADING_LABEL_FIELDS.has(field)) return null;
    const value = tokens.slice(length).join(' ');
    if (!value.length || fieldForHeader(value)) return null;
    /*
     * A LABEL FOLLOWED BY A FIGURE IS AN ENUMERATED DESIGNATION, AND THE
     * FIGURE BELONGS TO THE LABEL.
     *
     * `Stage` and `Release` both resolve to `project_name`, so without this
     * `Stage 12 Release 4` claims a project called `12 Release 4` — the
     * label torn off the front of the very designation it names. `Estate
     * Warragul` is the other shape: a class noun labelling a name that
     * stands on its own. The number is what tells them apart, and it is the
     * same shape `readLotHeading` already reads.
     */
    if (HAS_DIGIT.test(value.trim()[0] ?? '')) return null;
    return { field, value };
  }
  return null;
}

function readInlineFieldName(line: string): Claim | null {
  const trimmed = String(line ?? '').trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  if (!readsAsAName(trimmed)) return null;
  if (CURRENCY_OR_AREA.test(trimmed)) return null;
  /*
   * A LINE ENDING IN A COLON IS A LABEL, NOT A NAME. Page 2 of the
   * production brochure draws its data block as label cells beside value
   * cells — `Home Design:`, `Site Area:`, `Locality:` — and reading the
   * label's own words as the name it is asking for wrote `house_design:
   * "Home Design:"`. The pairing readers take these correctly; this one
   * must decline them.
   */
  if (/[:–—]$/.test(trimmed)) return null;
  /*
   * AND A LINE THAT RESOLVES WHOLLY THROUGH THE ALIAS TABLE IS A LABEL.
   *
   * `BUILD AREA` is a heading. Read as a NAME ending in a field word it
   * becomes `area`, which this vocabulary knows as a locality — so a
   * two-column measurement block claimed `suburb: "BUILD AREA"` and the
   * build area itself was never read. The prefix test alone cannot see it,
   * because `BUILD` resolves to nothing on its own.
   */
  if (fieldForHeader(trimmed)) return null;
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

/*
 * A SECTION'S `Total:` IS NOT READ, AND THE DOCUMENT IS WHY.
 *
 * The production brochure's first page states its areas as a section —
 * `House Specifications` over `Enclosed: 91.91m²`, `Garage: 22.59m²`,
 * `Porch: 3m²`, `Total: 117.50m²` — and a rule was written here to take
 * that total as the building size, resolving `House` with the value's unit
 * the way `readVerticalPair` does.
 *
 * It was removed because page 2 of the same document states
 * `Build Area: 119.16 m2` in so many words, and the two disagree. A derived
 * figure that contradicts a stated one is not a second opinion, it is a
 * fabrication with an argument attached — and the reader that waits for the
 * document to say it plainly gets the right number without one. The same
 * lesson as the locality: this brochure says everything it means somewhere.
 */

/**
 * `ARMSTRONG CREEK (3217)` — the locality and its postcode.
 *
 * The production brochure's siting block states `Locality: ARMSTRONG CREEK
 * (3217)`, which is one label over two facts the row keeps in two columns.
 * Read whole, the suburb carries a bracketed number that is not part of any
 * suburb's name and the postcode column stays empty beside it.
 *
 * Narrow on purpose: a suburb claim alone, a trailing bracket alone, and
 * exactly four digits in it, which is what an Australian postcode is. Any
 * other bracket is left where the document put it.
 */
const TRAILING_POSTCODE = /^(.*\S)\s*\((\d{4})\)$/;

/**
 * `Site Address: Lot 208 Fairweather Drive` — the address AND the lot.
 *
 * A siting plan states the property once, as an address that OPENS with the
 * lot designation. The address is what a person reads; the lot number is
 * what a stock row matches on, and leaving it null because it was written
 * inside another field loses the one identifier a builder searches by.
 *
 * It is the reading `readLotHeading` already makes of a line, applied to a
 * value: the word, a designation, and an address-shaped tail. Nothing is
 * chosen — if the document states a DIFFERENT lot elsewhere the two meet at
 * the conflict rule and refuse, exactly as two lots should.
 */
function splitAddress(claim: Claim): Claim[] {
  if (claim.field !== 'address_line') return [claim];
  const lot = readLotHeading(claim.value);
  // A part split out of a value was read the way the whole was.
  return lot ? [claim, { ...lot, via: claim.via }] : [claim];
}

/**
 * A VALUE NEVER ENDS IN A SEPARATOR.
 *
 * `PALOMINO ESTATE, ARMSTRONG CREEK` read for its estate gives back
 * `Palomino Estate,` — the comma belonged to the line, not to the name,
 * and it reaches the stock row as part of the estate. The same is true of
 * a value a document sets in a list (`Enzo 8.5 Luca;`) and of a label's
 * own colon surviving a split.
 *
 * DELIBERATELY NARROW. Only separators are trimmed, and only from the
 * ends: a full stop is left exactly where the document put it, because
 * `Fairweather Ave.` and `St. Leonards` carry theirs as part of the name
 * and a reader that strips it renames the street. A comma INSIDE a value
 * is untouched, which is what keeps `$863,850` and `1,204 m2` whole.
 *
 * It is applied to every claim, from every reader, at the one point they
 * all pass through — a trim performed in six readers is a trim that will
 * be forgotten in the seventh.
 */
const EDGE_SEPARATORS = /^[\s,;:·•\u2013\u2014-]+|[\s,;:·•\u2013\u2014-]+$/g;

/**
 * A NAME THE DOCUMENT PUT IN BRACKETS IS STILL THE NAME.
 *
 * MEASURED 21 SEPTEMBER 2026: `LOT 324 - NEX 20` imported its estate as
 * `(Watsons Reach Estate)`, brackets and all, and the marketplace drew them.
 * A brochure brackets an estate where it sits beside something else — the
 * design, the builder — and the brackets are the document's punctuation, not
 * part of what the place is called.
 *
 * BALANCED ONLY, and stripped as a PAIR. A name opening with a bracket and
 * not closing one is a name this reader has cut in half somewhere, and
 * quietly removing the survivor would hide that; it is left exactly as read.
 */
const WRAPPING_BRACKETS = /^\((.+)\)$|^\[(.+)\]$/;

function unwrapBrackets(value: string): string {
  const match = value.trim().match(WRAPPING_BRACKETS);
  if (!match) return value;
  const inner = (match[1] ?? match[2] ?? '').trim();
  // An inner bracket of its own means the pair is not this name's wrapper.
  if (!inner.length || /[()\[\]]/.test(inner)) return value;
  return inner;
}

function trimSeparators(claim: Claim): Claim {
  const value = unwrapBrackets(claim.value.replace(EDGE_SEPARATORS, ''))
    .replace(EDGE_SEPARATORS, '');
  if (!value.length || value === claim.value) return claim;
  return { ...claim, value };
}

/**
 * `49 Cockrell Rd,` OVER `Mernda VIC 3754` — THE ADDRESS A FLYER PRINTS WITH
 * NO LABEL AT ALL.
 *
 * Every rule in this module waits for the document to label what it states,
 * and that is right for a value: a number under no heading could be anything.
 * An Australian locality line is the exception, and it is the document
 * labelling ITSELF — `Mernda VIC 3754` is a suburb, a state from a closed set
 * of eight, and four digits, in that order. Nothing else on a builder's page
 * takes that shape.
 *
 * MEASURED ACROSS ALL FOUR LIVE DOCUMENTS, 1,057 lines this reader had
 * attributed to nothing:
 *
 *     LOT 27  - ZIMI - FLYER          1 locality line, 1 street line
 *     LOT 36  - ZIMI - FLYER          1 locality line, 1 street line
 *     LOT 266 Crowlea Estate          0              , 0
 *     LOT 324 - NEX 20                0              , 0
 *
 * One of each in exactly the two documents that carry an address, and not a
 * single false positive in the other 1,050 lines — which include prices,
 * dimensions, inclusions prose and a floor plan's room names.
 *
 * THREE GUARDS, AND THE THIRD IS THE ONE THAT MATTERS. The locality line
 * must state a state AND a postcode, so a bare suburb claims nothing. The
 * street line must sit DIRECTLY ABOVE it in the same column, which is what
 * makes the pair an address block rather than two lines that happen to look
 * like one. And there must be EXACTLY ONE such block in the whole document:
 * a builder's own office address is the same shape as a property's, and this
 * module does not choose between two readings — two blocks claim nothing and
 * the document reads exactly as it does today.
 */
const AU_STATE = /^(?:VIC|NSW|QLD|SA|WA|TAS|NT|ACT)$/i;

/** Closed, and deliberately so: a word this list does not carry is not a street. */
const STREET_TYPE = new Set([
  'rd', 'road', 'st', 'street', 'ave', 'avenue', 'dr', 'drive', 'ct', 'court',
  'cres', 'crescent', 'way', 'pl', 'place', 'bvd', 'blvd', 'boulevard',
  'pde', 'parade', 'cct', 'circuit', 'cl', 'close', 'tce', 'terrace', 'rise',
  'lane', 'ln', 'walk', 'esp', 'esplanade', 'hwy', 'highway', 'loop', 'mews',
  'link', 'view', 'vista', 'chase', 'bend', 'square', 'sq', 'grove', 'gr',
  'green', 'track', 'trail', 'circus', 'crossing', 'gardens', 'glade',
]);

interface LocalityLine {
  suburb: string;
  state: string;
  postcode: string;
}

/** `Mernda VIC 3754` — a locality, its state and its postcode, in that order. */
function readLocalityLine(line: string): LocalityLine | null {
  const tokens = String(line ?? '').trim().replace(/[.,]+$/, '').split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;
  const postcode = tokens[tokens.length - 1];
  const state = tokens[tokens.length - 2];
  if (!/^\d{4}$/.test(postcode)) return null;
  if (!AU_STATE.test(state)) return null;
  const suburb = tokens.slice(0, tokens.length - 2).join(' ');
  // A suburb is words. Anything carrying a digit is a measurement or a price.
  if (!suburb.length || !/^[A-Za-z]/.test(suburb) || HAS_DIGIT.test(suburb)) return null;
  return { suburb, state: state.toUpperCase(), postcode };
}

/**
 * `49 Cockrell Rd,` — a street number, a name, and a type from the closed set.
 *
 * OR `Lot 37 Fairweather Drive`, which is how builder stock is written before
 * a street number exists. `readComposedAddressLine` has accepted that form on
 * a ONE-LINE address since it was written (`Lot 9 Perrin Street, Armstrong
 * Creek VIC 3217`); this reader, which takes the same address set on two
 * lines, did not — so the identical address read completely in one shape and
 * not at all in the other. The lot is dropped from the street, exactly as the
 * composed reader drops it, because the field says WHERE and a lot says WHICH.
 *
 * THE WORD IS REQUIRED. A bare leading number is a street number here and a
 * LOT on builder stock, and nothing in a line can tell them apart — measured
 * in `builderStockAddress`, of 44 rows opening with a number that also carry a
 * lot number it equals the lot in 44 and differs in none. So this reads `Lot`
 * only where the document wrote it.
 */
function readStreetLine(line: string): string | null {
  const trimmed = String(line ?? '').trim().replace(/[.,]+$/, '');
  let tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4 && /^lots?$/i.test(tokens[0])
    && LOT_DESIGNATION.test(tokens[1])) {
    tokens = tokens.slice(2);
  } else {
    // A number, optionally with a unit letter — never `20mm`, which is a size.
    if (tokens.length < 3) return null;
    if (!/^\d{1,6}[A-Za-z]?$/.test(tokens[0])) return null;
    tokens = tokens.slice(1);
    tokens.unshift('');
  }
  if (tokens.length < 2) return null;
  if (!STREET_TYPE.has(tokens[tokens.length - 1].toLowerCase())) return null;
  const name = tokens.filter(Boolean);
  if (name.length < 2) return null;
  // The name is words; a digit in it is a specification, not a street.
  if (name.some((token) => HAS_DIGIT.test(token))) return null;
  return tokens[0] === '' ? trimmed : name.join(' ');
}

/**
 * `Lot 9 Perrin Street, Armstrong Creek VIC 3217` — THE SAME ADDRESS ON ONE
 * LINE, WHICH IS HOW MOST BUILDERS PRINT IT.
 *
 * `readStreetLine` above needs the street and the locality on two lines,
 * DIRECTLY above one another, because that is the shape the two flyers it was
 * measured on happened to use. That guard is sound and it is also the whole
 * of the rule: a brochure that sets the same address as one comma-separated
 * line matched nothing, so the line was unaccounted, and one unaccounted line
 * stands the document down.
 *
 * MEASURED 21 SEPTEMBER 2026 over an acceptance corpus of sixteen generated
 * documents put through the portal's own import: SEVEN of the nine documents
 * that produced no property at all failed for exactly this and nothing else —
 *
 *     Lot 77, Kestrel Way, Rockbank VIC 3335
 *     Lot 41 Galloway Road, Bacchus Marsh VIC 3340
 *     Lot 512, Olivewood Boulevard, Donnybrook VIC 3064
 *     Lot 100, Sandalford Drive, Werribee VIC 3030
 *     Lot 233, Ridgeback Street, Kalkallo VIC 3064
 *     Lot 18, Hollybank Crescent, Melton South VIC 3338
 *     Lot 9 Perrin Street, Armstrong Creek VIC 3217
 *
 * — each the one line the reader could not attribute, on a document stating
 * its price, its land size and its design in terms the reader read perfectly.
 *
 * WHY THIS IS A READER AND NOT AN EXEMPTION. The refusal these documents hit
 * was correct under the asymmetry it was written for: "a false incidental
 * loses a field for good, and a false unaccounted costs one model call."
 * That trade no longer exists — nothing on this path calls a model — so an
 * unaccounted line now costs the whole document. The answer to that is not to
 * stop refusing; it is to be able to READ the line. Widening
 * `isIncidentalContent` to swallow it would have been the other thing, and it
 * would have thrown away the address as well as the refusal.
 *
 * FOUR GUARDS, and they are the two-line rule's own, applied to segments.
 * The line must END in a locality — a suburb, a state from the closed set of
 * eight, and four digits — which is the document labelling itself and the
 * reason nothing else on a builder's page can match. The street segment must
 * end in a street type from the same closed `STREET_TYPE` set the two-line
 * reader uses, so one vocabulary answers both shapes rather than two. A
 * street name carrying a digit is a specification, not a street. And the
 * whole-document guard is unchanged: these blocks join the same
 * `addressBlocks` list, so TWO addresses in a document still claim nothing.
 *
 * THE LOT IS TAKEN OFF THE FRONT RATHER THAN LEFT IN THE STREET, because
 * `Lot 9 Perrin Street` is a lot and a street and not an address called
 * "Lot 9 Perrin Street" — and it is claimed only where the document has not
 * already said which lot it is, so this can never become a second opinion
 * about identity.
 */

/**
 * The publisher's own address, which is the same SHAPE as a property's and
 * must never be read as one.
 *
 * A positive recognition of a closed list, exactly as `SELF_DESCRIPTION` is:
 * these are labels a builder puts in front of their own premises. It is not a
 * shape heuristic and there is no fall-through — an address line this does not
 * recognise is a candidate, and the one-block-per-document guard is what then
 * protects it. Anchored at the start, because a label is a prefix: a street
 * genuinely called `Office Street` is not disqualified by its name.
 */
const PUBLISHER_PREMISES = new RegExp(
  '^\\s*(?:'
  + 'head\\s+office|registered\\s+office|principal\\s+office|postal\\s+address'
  + '|display\\s+(?:home|homes|centre|center|village|suite)'
  + '|sales\\s+(?:office|centre|center|suite)'
  + '|showroom|office'
  + ')\\b[\\s.:|\u2013\u2014-]*',
  'i',
);

/** A street with no number in front of it: `Perrin Street`, `Kestrel Way`. */
function readStreetName(segment: string): string | null {
  const trimmed = String(segment ?? '').trim().replace(/^[,\s]+|[.,\s]+$/g, '');
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  if (!STREET_TYPE.has(tokens[tokens.length - 1].toLowerCase())) return null;
  if (tokens.some((token) => HAS_DIGIT.test(token))) return null;
  return trimmed;
}

/** `Lot 9` / `Lot 214` at the head of a segment, returned with what is left. */
const LEADING_LOT = /^lot\s*[:.]?\s*(\d{1,5}[A-Za-z]?)\b[\s,.-]*/i;

interface ComposedAddress extends LocalityLine {
  street: string;
  lot: string | null;
  /** The segment between the lot and the locality that named a place, if any. */
  development: string | null;
}

/**
 * `Tweed Heads NSW` — A LOCALITY INSIDE A COMPOSED LINE, WHERE THE POSTCODE
 * IS OPTIONAL AND ONLY THERE.
 *
 * `readLocalityLine` requires a postcode and is right to: it judges a line
 * standing on its own, where `Mernda VIC` could be a heading, a column or a
 * caption, and four digits are what make it unmistakable.
 *
 * MEASURED 22 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property Package.pdf`.
 * Its address is one line and carries no postcode:
 *
 *     Lot 37, Sandpiper Estate, Tweed Heads NSW
 *
 * so the whole document stood down on that single unaccounted line — while
 * naming its lot, its estate, its suburb and its state in it.
 *
 * The postcode is dispensable HERE because the line has already proved
 * itself: it is comma-separated, it opens with a lot designation or a street,
 * and this segment is its last. A state from the closed set of eight ending
 * the final segment of such a line is the document saying where the property
 * is. A bare `Tweed Heads NSW` on its own line still claims nothing, because
 * this function is never asked about one.
 */
function readComposedLocality(segment: string): LocalityLine | null {
  const exact = readLocalityLine(segment);
  if (exact) return exact;
  const tokens = String(segment ?? '').trim().replace(/[.,]+$/, '').split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const state = tokens[tokens.length - 1];
  if (!AU_STATE.test(state)) return null;
  const suburb = tokens.slice(0, tokens.length - 1).join(' ');
  if (!suburb.length || !/^[A-Za-z]/.test(suburb) || HAS_DIGIT.test(suburb)) return null;
  return { suburb, state: state.toUpperCase(), postcode: '' };
}

/**
 * Read one line as a whole Australian address, or nothing.
 *
 * Nothing is inferred and nothing is reconstructed: every part returned was
 * written on the line, and a line that does not satisfy all four guards
 * returns null rather than a best effort.
 */
export function readComposedAddressLine(line: string): ComposedAddress | null {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  // The publisher's own premises are never a property's address.
  if (PUBLISHER_PREMISES.test(raw)) return null;

  const segments = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;

  const locality = readComposedLocality(segments[segments.length - 1]);
  if (!locality) return null;

  let head = segments.slice(0, -1).join(', ').trim();
  let lot: string | null = null;
  const lotMatch = head.match(LEADING_LOT);
  if (lotMatch) {
    lot = lotMatch[1];
    head = head.slice(lotMatch[0].length).trim();
  }
  if (!head) return null;

  /*
   * `Sandpiper Estate` — THE SEGMENT BETWEEN THE LOT AND THE LOCALITY.
   *
   * On `Lot 37, Sandpiper Estate, Tweed Heads NSW` the middle segment is not
   * a street and never will be: it ends in the word ESTATE, which is the one
   * thing in this vocabulary that says outright what it is. Taken only where
   * it says so — a segment that merely looks like a name stays unread, and
   * the alternative on that document was `PROPLAUNCH`, read off a caption.
   */
  const named = head.match(/^(.*\S)\s+(estate|rise|park|grove|gardens|village|waters|heights)$/i);
  const development = named ? `${named[1]} ${named[2]}` : null;
  if (development) return { street: '', lot, development, ...locality };

  // Either shape of street is acceptable, and both are the existing rules:
  // numbered streets answer to `readStreetLine`, unnumbered ones to
  // `readStreetName`. Neither invents a number the line does not carry.
  const street = readStreetLine(head) ?? readStreetName(head);
  if (!street) return null;

  return { street, lot, development: null, ...locality };
}

function splitLocality(claim: Claim): Claim[] {
  if (claim.field !== 'suburb') return [claim];
  const match = claim.value.trim().match(TRAILING_POSTCODE);
  if (!match) return [claim];
  return [
    { field: 'suburb', value: match[1], via: claim.via },
    { field: 'postcode', value: match[2], via: claim.via },
  ];
}

/**
 * `PALOMINO ESTATE, ARMSTRONG CREEK` — the estate, and nothing else.
 *
 * The name the document gives its estate is often set with the locality
 * after a comma, and `readInlineFieldName` requires the field word to END
 * the line, so the whole thing resolved to nothing. Reading the FIRST
 * segment on its own is all this does: that segment carries its own field
 * word, so it is the document labelling itself and not an inference.
 *
 * IT DELIBERATELY DOES NOT READ THE TAIL AS THE SUBURB, and the production
 * brochure is why. A first version took `Armstrong Creek` from the comma on
 * the argument that an address composition runs from the specific to the
 * general — which is true, and which was still a guess. Page 2 of that same
 * document states `Locality: ARMSTRONG CREEK (3217)` in so many words, and
 * the two readings disagreed. The document says it plainly somewhere; a
 * reader that waits for it says nothing wrong.
 */
function readNamedPlace(line: string): Claim[] | null {
  const segments = line.split(',').map((part) => part.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const named = readInlineFieldName(segments[0]);
  if (!named) return null;
  if (named.field !== 'development_name' && named.field !== 'project_name') return null;
  return [named];
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
/**
 * Is this line already a statement of its own?
 *
 * `Home Design: Aspire 24 Grande` answers to `Home Design`, never to
 * whatever label happens to sit above it.
 */
function statesItsOwnLabel(value: string): boolean {
  const own = readLabelledValue(value);
  return Boolean(own && own.value);
}

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
  // Nor is a line that already answers to a label of its own.
  if (statesItsOwnLabel(trimmed)) return null;
  /*
   * AND A LINE ENDING IN A COLON IS ASKING FOR A VALUE, NOT BEING ONE. The
   * production brochure's last page draws `Date:` above a field word, and
   * the caption reading took the question as the answer.
   */
  if (/[:–—]$/.test(trimmed)) return null;
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
 * A MARKETING SLOGAN, WHICH IS NEVER A DESIGN AND NEVER AN ESTATE.
 *
 * MEASURED 21 SEPTEMBER 2026. A brochure drawing `SALE NOW ON` across its
 * render, uploaded as `LOT 512 - SALE NOW ON.pdf`, imported with
 * `house_design: "SALE NOW ON"` — and every step that produced it was
 * working as designed. `corroborateDesignFromFilename` exists precisely
 * because two independent sources agreeing is good evidence, and here the
 * filename and the page genuinely did agree. They agreed about an offer.
 *
 * The defect is that the corroborator had no notion of a line that cannot be
 * a property attribute WHATEVER corroborates it. A design is the name of a
 * house; a slogan is the publisher selling one, and no amount of agreement
 * turns the second into the first. So this is asked of the CANDIDATE rather
 * than of the evidence, and it is the same doctrine `isIncidentalContent`
 * answers to — a closed list, positively recognised, no shape heuristic and
 * no fall-through. A slogan this list does not carry reads exactly as it does
 * today.
 *
 * It deliberately does NOT make the line incidental. A slogan is still a line
 * the reader could not attribute, and hiding it would be widening the
 * incidental rule to cover the reader's own gap — the thing this module's
 * header forbids. It is barred from being a NAME, and nothing else.
 */
const PROMOTIONAL_SLOGAN = new RegExp([
  '\\bsale\\s+now\\s+on\\b', '\\bon\\s+sale\\s+now\\b', '\\bnow\\s+selling\\b',
  '\\bsave\\s*\\$', '\\bsavings?\\s+of\\s*\\$', '\\bdiscount\\b', '\\bbonus\\b',
  '\\bthis\\s+weekend\\s+only\\b', '\\blimited\\s+time\\b', '\\bwhile\\s+stocks?\\s+last\\b',
  '\\bhurry\\b', '\\bact\\s+(?:now|fast)\\b', "\\bdon'?t\\s+miss\\b",
  '\\bfree\\s+upgrade\\b', '\\bmove\\s+in\\s+ready\\b', '\\bspecial\\s+offer\\b',
  '\\bprice\\s+drop\\b', '\\breduced\\b', '\\benquire\\s+(?:now|today)\\b',
  '\\bregister\\s+(?:now|your\\s+interest)\\b', '\\bbook\\s+(?:now|a\\s+tour)\\b',
  '\\boffer\\s+ends\\b', '\\bfrom\\s+only\\b', '\\bno\\s+deposit\\b',
].join('|'), 'i');

/**
 * May this text stand as the name of a design, an estate or a project?
 *
 * Exported because two readers ask it — the filename corroborator and the
 * place corroborator — and one rule asked twice is the only way they cannot
 * come to disagree about the same line.
 */
export function readsAsPromotion(value: string): boolean {
  return PROMOTIONAL_SLOGAN.test(String(value ?? ''));
}

/**
 * A DOCUMENT SAYING, IN WORDS, THAT SOME OF THE LOTS ON THIS PAGE ARE NOT
 * WHAT IT IS SELLING.
 *
 * MEASURED 21 SEPTEMBER 2026 on the acceptance corpus's site-plan package.
 * Its plan page draws
 *
 *     Lot 303      Lot 304      Lot 306      Lot 307
 *     Adjoining allotments are not offered for sale in this package.
 *
 * and the reader took `303`, then `304`, saw two answers for a material
 * field, and refused the whole document — over a brochure whose subject lot,
 * street, suburb, state, design, land size and price were each stated
 * exactly once and never in doubt. A site plan that draws its neighbours is
 * the ordinary shape of a package brochure, so this class refuses a common
 * document rather than a broken one.
 *
 * THE RULE IS THE DOCUMENT'S OWN SENTENCE, NOT A GUESS ABOUT LAYOUT. The
 * first attempt tried to recognise the SHAPE — a line naming several lots —
 * and could not: a two-property release draws `Lot 402` and `Lot 407` in
 * exactly the same shape, on the same band, and that document really does
 * describe two properties. Nothing geometric separates them. What separates
 * them is that one of the two says so.
 *
 * So designations are suppressed on a page ONLY where that page carries an
 * explicit exclusion statement AND names more than one of them. A page with
 * one lot is untouched whatever it says; a page with several and no
 * statement still refuses, which is why the two-property release is
 * unaffected and still stands the document down.
 *
 * It suppresses rather than selects: the page claims no lot at all, and the
 * subject property's identity has to come from somewhere the document states
 * it once — its address block, or another page. A document whose only lot
 * information is an excluded list therefore still refuses, rather than
 * importing a property nobody named.
 *
 * Closed list, positively recognised, no fall-through — the same doctrine
 * `isIncidentalContent` answers to.
 */
const EXCLUSION_STATEMENT = new RegExp([
  '\\bnot (?:offered |available )?for sale\\b',
  '\\bnot included in (?:this|the) (?:package|sale|offer)\\b',
  '\\bshown for (?:context|reference|illustration|information)\\b',
  '\\bfor (?:context|reference|illustrative purposes) only\\b',
  '\\badjoining (?:lots?|allotments?|properties)\\b',
  '\\bneighbouring (?:lots?|allotments?|properties)\\b',
  '\\bsurrounding (?:lots?|allotments?)\\b',
  '\\bother lots? (?:are |is )?(?:not|shown)\\b',
].join('|'), 'i');

/** Does this page tell the reader that some of the lots on it are not the subject? */
export function pageExcludesOtherLots(lines: readonly string[]): boolean {
  return lines.some((line) => EXCLUSION_STATEMENT.test(String(line ?? '')));
}

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
  if (tokens.length < 2) return null;
  if (fieldForHeader(tokens[0]) !== 'lot_number') return null;
  if (!LOT_DESIGNATION.test(tokens[1])) return null;
  /*
   * `LOT 315 CENTRAL BOULEVARD` — the lot AND the street it is on.
   *
   * The production brochure heads its address block that way, and the
   * two-token rule refused it: a lot designation this reader could see and
   * would not take, on the one field that says which property this is.
   *
   * What follows the designation is read only to be REFUSED — nothing here
   * claims a street, because the tail may be anything and this module does
   * not decide what. It must simply be an address-shaped tail, which is
   * what stops "Lot 5 of the finest homes in Victoria" claiming lot 5: a
   * short run of words set as a name, carrying no figure of its own and no
   * heading this vocabulary would have read differently.
   */
  const tail = tokens.slice(2);
  if (tail.length) {
    if (tail.length > MAX_NAME_TOKENS) return null;
    const rest = tail.join(' ');
    if (HAS_DIGIT.test(rest)) return null;
    if (!readsAsAName(rest)) return null;
    if (fieldForHeader(rest)) return null;
  }
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
/** How many digits a value is written to. `321` is 0, `320.72` is 2. */
function decimalsIn(value: string): number {
  const match = value.match(/\d[\d,\s]*\.(\d+)/);
  return match ? match[1].length : 0;
}

/**
 * ARE THESE TWO FIGURES THE SAME MEASUREMENT, WRITTEN TWICE?
 *
 * A brochure states its land size on the marketing page and again on the
 * siting plan, and the two are almost never the same STRING: the front page
 * rounds and the plan is exact. Measured on the production brochure for Lot
 * 315, one document says
 *
 *   page 1   Lot Size   321m²
 *   page 2   Site Area: 320.72 m²
 *
 * — the same lot, to the nearest square metre and to the centimetre. Reading
 * that as two answers is how a perfectly consistent document came to be
 * called `ambiguous`, and it is why the sibling brochure for Lot 717 failed
 * on `conflicting_values:land_size_sqm` while its land size (271 m²) was
 * never in doubt. Lot 315 escaped only because `Site Area` happens not to
 * resolve through the alias table; one word different in the builder's
 * template and it would have failed too.
 *
 * THE TEST IS THE COARSER FIGURE'S OWN PRECISION. Round the finer one to the
 * number of decimals the coarser one is written to; if they agree, the
 * document said one thing twice and the FINER reading is kept. `321` and
 * `320.72` agree. `321` and `450` do not, and neither do `117.50` and
 * `119.16` — a disagreement in a digit the coarser figure actually states is
 * a real disagreement and still refuses.
 */
function sameMeasurement(left: number, right: number, a: string, b: string): boolean {
  if (left === right) return true;
  const places = Math.min(decimalsIn(a), decimalsIn(b));
  const factor = 10 ** places;
  return Math.round(left * factor) === Math.round(right * factor);
}

function sameValue(field: string, a: string, b: string): boolean {
  if (field === 'price') {
    const left = coercePrice(a);
    const right = coercePrice(b);
    if (left.price !== null && right.price !== null) return left.price === right.price;
  }
  if (NUMERIC_VALUE_FIELDS.has(field)) {
    const left = coerceNumber(a);
    const right = coerceNumber(b);
    if (left !== null && right !== null) return sameMeasurement(left, right, a, b);
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
/*
 * A unit is `NormalisedUnit` and nothing else. Everything downstream reads
 * `text` exactly as it always did; what it gains is `raw` — the page's own
 * string — and `normalisation`, which says which rule produced the reading and
 * from what. See `documentNormalisation.pure.ts`.
 */
type BrochureUnit = NormalisedUnit;

/** How far apart two cells may start and still be one column. */
const SAME_COLUMN_TOLERANCE = 12;

/**
 * ===========================================================================
 * THE ONE SEAM. RAW EVIDENCE IN, CANONICAL UNITS OUT.
 * ===========================================================================
 *
 * A PDF reaches this reader two ways — page text and positioned runs — and
 * both become units here. Everything after this point reads units, so this is
 * where a document's TYPOGRAPHY stops being any reader's problem: the dot that
 * separates two fields, the heading a designer tracked out, the word gap
 * inside it. All three are resolved once, for both transports, in
 * `documentNormalisation.pure.ts`, and none of them is a rule about a field.
 *
 * WHAT WAS HERE BEFORE was a copy of the separator rule and a per-field guard
 * against letter-spaced type, which is how one idea comes to be written five
 * times. The rules moved; the call sites did not have to.
 */
function unitsFromPageText(page: string): BrochureUnit[] {
  /*
   * WITHOUT POSITIONS NOTHING CHANGES, and that is asserted rather than hoped.
   * A flattened page produces one unit per line, every one at `x = 0` on a row
   * of its own — so BESIDE is always absent and BELOW is always the next line,
   * byte for byte the reading this module has always made. Normalisation is
   * therefore run PER LINE and the rows are numbered afterwards: a line that
   * splits into three statements contributes three rows, not one row of three.
   */
  const units: BrochureUnit[] = [];
  for (const line of String(page ?? '').split(/\r?\n/)) {
    for (const unit of normaliseUnits([{ text: line, x: 0, row: 0 }])) {
      units.push({ ...unit, x: 0, row: units.length });
    }
  }
  return units;
}

function unitsFromLayout(items: readonly PdfTextItem[]): BrochureUnit[] {
  /*
   * The cells carry their own set widths, so the phrase rule is measured here
   * rather than guessed: `T O T A L` joins `H O M E` because the gap between
   * them is of the order of the run's own width, and does not join a
   * tracked-out word in the next column.
   */
  const raw: RawUnit[] = [];
  layoutLines(items).forEach((line, row) => {
    for (const cell of line.cells) {
      raw.push({ text: cell.text, x: cell.x, row, width: cell.width });
    }
  });
  return normaliseUnits(raw);
}

/** The unit drawn beside this one, on the same visual line. */
function unitBeside(units: readonly BrochureUnit[], index: number): number | null {
  const next = index + 1;
  if (next >= units.length) return null;
  return units[next].row === units[index].row ? next : null;
}

/**
 * A ROW BAND WITH NOTHING IN THIS COLUMN IS NOT BETWEEN THEM.
 *
 * How many bands may be crossed to reach the next cell in a column. Two is
 * enough for a value the page drew one band clear of its label, and short
 * enough that the bottom of one box cannot pair with the top of the next.
 */
const COLUMN_BAND_REACH = 2;

/**
 * The unit drawn below this one, IN THE SAME COLUMN.
 *
 * Only a unit whose left edge lines up with this one's, and only a few row
 * bands down — a label whose value is half a page away is a label with
 * nothing under it, not a pair.
 *
 * IT USED TO MEAN THE VERY NEXT BAND, AND ON A LAID-OUT PAGE THAT IS NOT
 * ADJACENCY. A row band spans the WHOLE WIDTH of the page, so anything drawn
 * anywhere on it occupies it — and a floor plan's room labels, three hundred
 * units away on the other side of the sheet, were enough to put a band
 * between a label and the value printed directly beneath it.
 *
 * MEASURED ON `LOT 266 Crowlea Estate`, from that document's own geometry:
 *
 *     r38  x29   Lot Size
 *     r39  x486  WIR          r39  x534  Ensuite
 *     r40  x29   520m2
 *
 * `Lot Size` and `520m2` are the same column to the unit, one band apart,
 * and the band between them holds two room names from the drawing beside.
 * The property's land size was on the page, exactly under its label, and
 * unreadable — which is how a card came to show no land size at all.
 *
 * THE FLATTENED READING IS UNCHANGED, BYTE FOR BYTE. There every unit sits
 * at x = 0 on a band of its own, so the first band below always holds a unit
 * in the column and this returns it without ever skipping, exactly as the
 * rule that was always there.
 *
 * AND NOTHING HERE DECIDES WHAT A PAIR MEANS. `readVerticalPair` still
 * refuses a heading under a heading, a line ending in its own colon, a line
 * that states its own label, an identifier with the wrong shape and a bare
 * measurement in an identity field — which is what keeps `Ground Floor:`
 * from pairing with `Garage:` two bands below it.
 */
function unitBelow(units: readonly BrochureUnit[], index: number): number | null {
  const from = units[index];
  let bandsSeen = 0;
  let band: number | null = null;
  let best: number | null = null;
  for (let j = index + 1; j < units.length; j++) {
    const unit = units[j];
    if (unit.row === from.row) continue;
    if (band === null || unit.row !== band) {
      // A new band. Whatever the last one offered in this column is the
      // answer; an empty one costs a step of the reach and nothing else.
      if (best !== null) return best;
      if (band !== null && ++bandsSeen >= COLUMN_BAND_REACH) return null;
      band = unit.row;
    }
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
 * THE FILENAME MAY CLASSIFY WHAT THE DOCUMENT SAYS. IT MAY NOT SAY IT.
 *
 * `LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf` names the lot and one other
 * thing. The document itself prints `Enzo 8.5` as its largest line and
 * prints `Palomino Estate` with its own field word, so the estate is settled
 * from the page and the only identity the page has not labelled is the
 * design. The filename does not supply that name — the page already did —
 * it settles which field a name the page already carries belongs to.
 *
 * FOUR CONDITIONS, AND EVERY ONE OF THEM REFUSES RATHER THAN GUESSES.
 *
 *   • THE LOT MUST AGREE. A filename naming a different lot from the
 *     document is a file somebody renamed or attached to the wrong record,
 *     and it answers `ambiguous` rather than being ignored — the one thing
 *     worse than not reading a filename is trusting a mismatched one.
 *   • THE NAME MUST BE THE DOCUMENT'S. Only a line the page actually printed
 *     and this reader could not place is a candidate, and every one of its
 *     tokens must appear in the filename. A name that is in the filename and
 *     not on the page can never be claimed.
 *   • THE ESTATE MUST ALREADY BE SETTLED. Until it is, an unplaced name
 *     could be either, and choosing is exactly the judgement this module
 *     does not make.
 *   • THERE MUST BE EXACTLY ONE CANDIDATE. Two unplaced names both echoed by
 *     the filename is the document declining to say which is which.
 */
/** An identity a document states about ITSELF, beyond the lot every one has. */
const FILENAME_CORROBORATION_ANCHORS = [
  'development_name', 'project_name', 'address_line', 'external_reference',
] as const;

export function corroborateDesignFromFilename(input: {
  filename: string | null | undefined;
  unresolved: readonly string[];
  claimed: ReadonlyMap<string, string>;
}): { claim: Claim; line: string } | 'lot_mismatch' | null {
  const raw = String(input.filename ?? '').trim();
  if (!raw) return null;
  const stem = raw.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const fileTokens = nameTokens(stem);
  if (!fileTokens.length) return null;

  // The lot the filename names, if it names one.
  for (let index = 0; index < fileTokens.length - 1; index++) {
    if (fieldForHeader(fileTokens[index]) !== 'lot_number') continue;
    const stated = fileTokens[index + 1];
    if (!LOT_DESIGNATION.test(stated)) continue;
    const held = input.claimed.get('lot_number');
    if (held && flattenIdentity(held) !== flattenIdentity(stated)) return 'lot_mismatch';
    break;
  }

  if (input.claimed.has('house_design')) return null;
  /*
   * THE DOCUMENT MUST HAVE ESTABLISHED WHICH PROPERTY IT IS, BEYOND ITS LOT.
   *
   * The gate was `development_name || project_name`, which is one way a
   * document does that and not the only one. MEASURED ON THE HAVENWOOD
   * FLYERS: they name no estate anywhere — `HAVENWOOD` is set alone at the
   * top of the page with nothing labelling it — but they state a street, a
   * suburb, a state and a postcode, and they print the design as a bare name
   * (`Ember`, `Zimi`) that the builder ALSO put in the filename. Two
   * independent sources agreeing is exactly what this function exists to act
   * on, and it was refusing because the third source was absent.
   *
   * THE LOT IS NOT ON THE LIST, deliberately: every document states one, so
   * admitting it would remove the gate rather than widen it.
   */
  if (!FILENAME_CORROBORATION_ANCHORS.some((field) => input.claimed.has(field))) {
    return null;
  }

  const fileSet = new Set(fileTokens);
  const candidates = input.unresolved.filter((line) => {
    if (!readsAsAName(line)) return false;
    const tokens = nameTokens(line);
    if (tokens.length < 1) return false;
    return tokens.every((token) => fileSet.has(token));
  });
  const distinct = [...new Set(candidates.map((line) => line.trim()))];
  if (distinct.length !== 1) return null;
  return { claim: { field: 'house_design', value: distinct[0] }, line: distinct[0] };
}

/**
 * `NORTHBROOK RISE, CLYDE NORTH` — WHERE THE DOCUMENT PROVES THE TAIL.
 *
 * A great many estates are named without the word: `Northbrook Rise`,
 * `Society 1056`, `The Grove`. `readInlineFieldName` cannot touch those, so
 * the estate is simply absent — which is honest, and which loses a field
 * the page prints in full.
 *
 * What resolves it is the document's own corroboration rather than a guess
 * about word order. Where a line is exactly `<name>, <place>` and the
 * document states that same place AS ITS LOCALITY somewhere else — a siting
 * plan's `Locality:` box, a suburb read from any labelled field — then the
 * tail is confirmed to be the suburb, and the head is the thing the suburb
 * qualifies. Nothing here decides what a comma means; the suburb had to be
 * read from a label first.
 *
 * FOUR GUARDS. Exactly two segments; a suburb already claimed from a
 * LABELLED statement; the tail matching it; and the development not already
 * claimed, so a document that names its estate properly always wins.
 */
function corroborateDevelopmentFromPlace(
  unresolved: readonly string[],
  claimed: ReadonlyMap<string, string>,
): Claim | null {
  if (claimed.has('development_name') || claimed.has('project_name')) return null;
  const suburb = claimed.get('suburb');
  if (!suburb) return null;
  const locality = flattenIdentity(suburb);
  if (!locality) return null;

  const found = new Set<string>();
  for (const line of unresolved) {
    const segments = line.split(',').map((part) => part.trim()).filter(Boolean);
    if (segments.length !== 2) continue;
    if (flattenIdentity(segments[1]) !== locality) continue;
    const name = segments[0];
    if (!readsAsAName(name)) continue;
    if (fieldForHeader(name)) continue;
    if (HAS_DIGIT.test(name) && LOT_DESIGNATION.test(name)) continue;
    found.add(name);
  }
  // Two different names before the same suburb is the document declining.
  return found.size === 1
    ? { field: 'development_name', value: [...found][0] }
    : null;
}

/**
 * ===========================================================================
 * THE BED / BATH / CAR ROW, WHERE THE DOCUMENT PROVES WHICH IS WHICH.
 * ===========================================================================
 *
 * Almost every builder's brochure states its configuration as three bare
 * numbers under three ICONS — a bed, a bath, a car. The icons are images, so
 * the text layer carries `3 2 1` and nothing that says what they count, and
 * reading them by the usual order would be inference: the counts were left
 * null and every card showed three dashes.
 *
 * THE DOCUMENT SETTLES IT ITSELF. A brochure that draws that row also draws
 * a FLOOR PLAN, and a floor plan labels its rooms: `Bed 1`, `Bed 2`,
 * `Bed 3`, `MASTER`. Counting the distinct bedrooms it names is a fact about
 * the page, and where that count equals the FIRST number of the row, the row
 * has told us what its first position means. The remaining two then follow
 * it, in the order the row is written.
 *
 * Measured on the production brochure for Lot 315: the plan labels `Bed 1`,
 * `Bed 2` and `Bed 3`, the row reads `3 2 1`, and the reading is 3 bedrooms,
 * 2 bathrooms, 1 car — which is what the assisted reader independently made
 * of the same document on 12 September, and what the builder's own stock
 * list states under a column headed `BED // BATH // CAR`.
 *
 * FIVE GUARDS, AND IT CLAIMS NOTHING WHERE ANY OF THEM FAILS.
 *
 *   • EXACTLY ONE candidate row in the whole document. Two rows of three
 *     bare numbers is a comparison table or a second property, and this
 *     cannot tell which is the subject.
 *   • EXACTLY THREE numbers, each a plausible count.
 *   • The floor plan must name at least one bedroom — no plan, no reading.
 *   • Its bedroom count must EQUAL the first number. A plan that disagrees
 *     with the row is a document this reader does not understand.
 *   • Nothing may already be claimed for any of the three, so a document
 *     that writes `Bedrooms: 4` in words always wins.
 */
const COUNT_ROW_SIZE = 3;

/**
 * A row of three bare counts, however the page drew it.
 *
 * Positioned, the icons separate the digits into three cells of one row.
 * Flattened, the same row arrives as one line of three tokens. Both are the
 * same statement and both are read; anything else is not a candidate.
 */
function countRowsOn(units: readonly BrochureUnit[]): number[][] {
  const found: number[][] = [];

  for (const unit of units) {
    const tokens = unit.text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length !== COUNT_ROW_SIZE) continue;
    if (!tokens.every(readsAsACount)) continue;
    found.push(tokens.map(Number));
  }

  const byRow = new Map<number, BrochureUnit[]>();
  for (const unit of units) {
    const row = byRow.get(unit.row);
    if (row) row.push(unit);
    else byRow.set(unit.row, [unit]);
  }
  for (const row of byRow.values()) {
    /*
     * THE ICON ROW IS THE THREE COUNTS ON A BAND, NOT A BAND CARRYING
     * NOTHING ELSE.
     *
     * This asked `row.length !== COUNT_ROW_SIZE` — every unit on the band had
     * to be one of the three counts — so a single other run sharing that band
     * defeated the whole corroboration. MEASURED 21 SEPTEMBER 2026 on the
     * acceptance corpus's flyer: its icons sit at x 91, 147 and 204 reading
     * `4`, `2`, `1`, its floor plan names MASTER, BED 2, BED 3, BED 4, ENS
     * and BATH, and `countRoomsNamed` answered `{bedrooms: 4, bathrooms: 2}`
     * — everything the corroboration needs. `soleCountRow` returned null,
     * because `Build Size - 148sqm` is drawn on the same band as the icons.
     * The property imported with no bedrooms, no bathrooms and no car spaces,
     * which on a card is most of what a buyer reads.
     *
     * A brochure sets its icon row beside a price or a size constantly; the
     * production fixture this rule was written against simply happened not
     * to. So the band is filtered to the units that STATE A COUNT and the row
     * is those, where there are exactly three of them.
     *
     * NOTHING IS LOOSENED DOWNSTREAM, which is what makes this safe rather
     * than merely permissive. A candidate row still has to be the ONLY
     * distinct one in the document (`soleCountRow`), and it still claims
     * nothing until the floor plan's own room names bind it — either every
     * position (`bindCountRow`) or the bedroom count agreeing with the first
     * number. Three unrelated small integers on a band therefore buy a
     * candidate that no plan will confirm, and confirm nothing.
     */
    const counts = row.filter((unit) => readsAsACount(unit.text));
    if (counts.length !== COUNT_ROW_SIZE) continue;
    found.push(counts.map((unit) => Number(unit.text.trim())));
  }
  return found;
}

/** The one row of three counts the document draws, if it draws exactly one. */
function soleCountRow(
  pages: ReadonlyArray<readonly BrochureUnit[]>,
): number[] | null {
  const rows = pages.flatMap((units) => countRowsOn(units));
  const distinct = [...new Set(rows.map((row) => row.join('/')))];
  if (distinct.length !== 1) return null;
  return distinct[0].split('/').map(Number);
}

/**
 * A COUNT THE DOCUMENT'S OWN ROW DOES NOT CARRY IS CONTRADICTED BY IT.
 *
 * The icon row is the page's statement of its counts. It does not say which
 * number is which — that is the whole reason for the corroboration above —
 * but it does say WHICH NUMBERS THE PROPERTY HAS, and that much needs no
 * order at all. A claimed `9` against a row reading `3 2.5 1` is the
 * document disagreeing with itself, and this module's standing answer to
 * that is to drop the field rather than choose.
 *
 * Deliberately weak on purpose, so it can only ever remove a figure:
 *
 *   • It runs only where the document draws EXACTLY ONE candidate row, so
 *     a comparison spread or a second property judges nothing.
 *   • It asks only whether the value APPEARS in the row, never where. An
 *     explicit `Bedrooms: 3` beside `3 2.5 1` is untouched, and so is a
 *     `Bathrooms: 2.5` — the order is still never read.
 *   • It writes nothing. A field it removes is reported as disputed and
 *     reads as not stated, which is what an unprovable count is.
 *
 * The one real figure it can cost is a total the row states per dwelling —
 * a dual-key `Bedrooms: 6` against a row of `3 2 1`. Losing that to null is
 * the direction this product takes everywhere: the builder is told it was
 * not stated, and can state it.
 */
function countsContradictedByRow(
  pages: ReadonlyArray<readonly BrochureUnit[]>,
  claimed: ReadonlyMap<string, string>,
): string[] {
  const row = soleCountRow(pages);
  if (!row) return [];
  const stated = new Set(row.map((value) => String(value)));
  const contradicted: string[] = [];
  for (const field of COUNT_FIELDS) {
    const held = claimed.get(field);
    if (held === undefined) continue;
    const number = Number(held.trim());
    if (!Number.isFinite(number)) continue;
    if (!stated.has(String(number))) contradicted.push(field);
  }
  return contradicted;
}

function readIconCountRow(
  pages: ReadonlyArray<readonly BrochureUnit[]>,
  claimed: ReadonlyMap<string, string>,
): { claims: Claim[]; evidence: string[] } | null {
  for (const field of COUNT_FIELDS) if (claimed.has(field)) return null;
  if (claimed.has('bed_bath_car')) return null;

  /*
   * THE PLAN IS THE KEY TO THE ROW, AND IT IS READ ACROSS THE WHOLE DOCUMENT.
   *
   * A brochure draws its icon row on the cover and its floor plan three pages
   * later, so the evidence that reads the row is not on the page the row is
   * on. `countRoomsNamed` counts distinct NAMES, so a room appearing on both
   * the plan and its dimensions table is one room.
   *
   * THIS REPLACES A RULE THAT COULD ONLY EVER AGREE WITH ONE ORDER. The old
   * test was `bedroomsNamedOn === row[0]` — it proved the FIRST position and
   * then took the remaining two in the order they happened to be printed,
   * which is the assumption this module exists to refuse. `bindCountRow`
   * settles every position or none.
   */
  const rooms = countRoomsNamed(pages.flat());
  const row = soleCountRow(pages);

  if (row) {
    const bound = bindCountRow(row, rooms);
    if (bound) {
      return {
        claims: [
          { field: 'bedrooms', value: String(bound.bedrooms) },
          { field: 'bathrooms', value: String(bound.bathrooms) },
          { field: 'car_spaces', value: String(bound.car_spaces) },
        ],
        evidence: bound.evidence,
      };
    }
    /*
     * AND WHERE IT COULD NOT, THE RULE THIS REPLACES STILL STANDS.
     *
     * `bindCountRow` determines every position or none, and on a whole-number
     * row it usually needs the fraction it does not have. Refusing there
     * would take away readings this product already makes correctly — a
     * regression bought with purity — so the original test is kept exactly
     * as it was: the plan's bedroom count agreeing with the row's FIRST
     * number, and the remaining two read in the order the row printed them.
     *
     * It is the weaker reading and is recorded as one. What it cannot do is
     * notice a document that prints its counts in another order, which is
     * precisely what the binding above is for.
     */
    const named = bedroomsFromPlan(rooms);
    if (named !== null && named === row[0]) {
      return {
        claims: [
          { field: 'bedrooms', value: String(row[0]) },
          { field: 'bathrooms', value: String(row[1]) },
          { field: 'car_spaces', value: String(row[2]) },
        ],
        evidence: ['plan_named_bedrooms_at_first_position'],
      };
    }
    return null;
  }

  /*
   * A DOCUMENT WITH NO ROW CLAIMS NOTHING, which is unchanged.
   *
   * A plan's room labels describe the home and the corpus has asserted since
   * it was written that they may not become the property's counts on their
   * own. Nothing here overturns that: the plan is the KEY to a row the
   * document printed, never a substitute for one.
   */
  return null;
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
     * Pages whose text was RECOGNISED rather than drawn, 1-based.
     *
     * Such a page is read as flattened text: its positioned runs describe only
     * whatever native fragment happened to share it, which on a scanned sheet
     * is a fraction of what it says. See the seam in `readPdfBrochure`.
     */
    recognisedPages?: readonly number[] | null;

    /**
     * The organisation that uploaded the document. Its own name is on every
     * page of its own brochure and is never the estate or the design — so it
     * is recognised as the publisher talking about itself rather than left
     * to stand the document down. Absent, nothing changes.
     */
    organisationName?: string | null;
    /**
     * The name the builder gave the file. Read only to CLASSIFY a name the
     * document itself printed — see `corroborateDesignFromFilename`.
     */
    filename?: string | null;
  } = {},
): PdfDeterministicReading {
  const diagnostics: PdfDeterministicReading['diagnostics'] = {
    mode: 'brochure', pages: pageTexts.length, fieldsRead: [], candidates: 0,
  };

  const claimed = new Map<string, string>();
  /**
   * Fields the document stated two ways. Dropped rather than chosen between,
   * and reported, so a builder can see which figure their brochure disagrees
   * with itself about.
   */
  const disputed = new Set<string>();
  /** Which reading produced each claimed field. For the import log only. */
  const readBy = new Map<string, ClaimSource>();
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
  /**
   * AND WHY. A field name alone says a statement was refused and not what was
   * wrong with it — `land_size_sqm` declined is a builder's brochure with a
   * missing measurement until the log can say `money_is_not_an_area`.
   * Vocabulary from `fieldTypes.pure.ts`; never a document's own words, so
   * this is safe to log.
   */
  const declinedBecause = new Map<string, string>();
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
  /*
   * ======================================================================
   * A RECOGNISED PAGE HAS NO TRUSTWORTHY LAYOUT.
   * ======================================================================
   *
   * Positions describe what the PDF ITSELF DREW. Where a page's text was read
   * off its pixels, the positioned runs describe only the native fragment that
   * happened to be there too — and on a mixed page that fragment is a fraction
   * of what the page says.
   *
   * MEASURED 22 SEPTEMBER 2026 on `LOT 140 - HARLOW 21 - MIXED.pdf`: page 2 is
   * a scanned specification sheet carrying ONE native line, its price. The
   * layout reader returned that one line, `unitsFromLayout` produced one unit,
   * and the rule below — prefer positions wherever there are any — threw away
   * the recognised text that states the design, both sizes and all three room
   * counts. Five fields absent from a page that states them plainly, and the
   * fully scanned document beside it read perfectly, because it had no native
   * text at all to prefer.
   *
   * So a page named here is read as the FLATTENED text it now is. Nothing else
   * changes: a page the PDF drew itself keeps its positions, which is what the
   * beside/below pairing and the glyph-run folding depend on.
   */
  const recognised = new Set(
    (options.recognisedPages ?? []).map((page) => Number(page)).filter(Number.isFinite));
  const pages = pageTexts.map((page, index) => {
    const items = recognised.has(index + 1) ? null : positioned.get(index + 1);
    const laid = items && items.length ? unitsFromLayout(items) : null;
    /*
     * A layout reading that produced nothing falls back to the flattened
     * one. An empty page is a page the reader could not decode, and reading
     * it as no content at all would let a document complete around it.
     */
    return laid && laid.length ? laid : unitsFromPageText(page);
  });
  if (positioned.size) diagnostics.mode = 'brochure';

  /*
   * THE WORDS THIS DOCUMENT SET AS DISPLAY TYPE. Computed once, over every
   * page, because a heading tracked out on page 1 is still a heading where
   * page 4 repeats it. See `trackedOutHeadings`.
   */
  const headings = new Set<string>();
  for (const page of pages) {
    for (const heading of trackedOutHeadings(page)) headings.add(heading);
  }

  let scanned = 0;
  /*
   * WHERE A LINE THIS READER COULD NOT NAME WAS DRAWN. Numbers only, and the
   * first occurrence of a given line wins — see `placement` on the reading.
   * Recorded as lines are seen, because every list downstream of here is a
   * filtered copy of the last and an index cannot survive that.
   */
  const placedAt = new Map<string, string>();
  /** Every street-over-locality pair the document draws. See `readLocalityLine`. */
  const addressBlocks: Array<LocalityLine
    & { street: string; lines: string[]; lot?: string | null;
        development?: string | null }> = [];
  /*
   * INDEXED, NOT `forEach`. This loop `return`s a refusal from inside itself
   * on a conflict and on the line ceiling; inside a callback those returns
   * would leave the callback and the reader would carry on as though nothing
   * had been refused.
   */
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const units = pages[pageIndex];
    /*
     * Decided once for the page, before any line is read, because the
     * sentence that excludes the neighbours is usually drawn BELOW them. See
     * `pageExcludesOtherLots`.
     */
    const pageLines = units.map((unit) => unit.text);
    const excludesOtherLots = pageExcludesOtherLots(pageLines);
    const designationsOnPage = new Set<string>();
    if (excludesOtherLots) {
      for (const line of pageLines) {
        const heading = readLotHeading(line);
        if (heading) designationsOnPage.add(flattenIdentity(heading.value));
      }
    }
    const suppressDesignations = excludesOtherLots && designationsOnPage.size > 1;
    /** Units already spent as another unit's value. */
    const consumed = new Set<number>();
    for (let index = 0; index < units.length; index++) {
      if (++scanned > MAX_LINES_SCANNED) break;
      if (consumed.has(index)) continue;
      const line = units[index].text;
      const found: Claim[] = [];

      /*
       * A SECTION'S TOTAL BELONGS TO THE SECTION.
       *
       * The production brochure states the house's area as
       *
       *   House Specifications
       *   Enclosed: 91.91m²   Garage: 22.59m²   Porch: 3m²   Total: 117.50m²
       *
       * `Total` names no field — correctly, since a total on its own is a
       * word and not a measurement of anything in particular. What says what
       * it measures is the heading it sits under, and the unit says which
       * reading of that heading applies: `House` is the DESIGN in this
       * vocabulary and `house m2` is the building's area, which is the same
       * re-reading `readVerticalPair` already makes for a label over its
       * value. So the heading and its total are one statement and are
       * consumed together.
       */
      const labelled = readLabelledValue(line);
      /*
       * A LABEL WHOSE VALUE IS IN THE NEXT CELL IS NOT A LABEL WITH NO
       * VALUE. The production brochure draws `Garage:` and `22.59m²` as two
       * cells of one row, and refusing on the empty half stood the document
       * down over a label whose value was six units to the right. An empty
       * value falls through to the pairing readers, and the bare-label rule
       * below is what still catches a label nothing anywhere fills in.
       */
      /*
       * ==================================================================
       * A LABEL WITH NO VALUE AFTER IT IS NOT A LABEL WITH NO VALUE.
       * ==================================================================
       *
       * `Garage:` and `22.59m²` are two cells of one row, so an empty half
       * falls through to the pairing readers rather than being judged here.
       * And where nothing pairs with it either — the builder's siting plan
       * draws `Estate:` and `Email/Phone:` as EMPTY BOXES nobody typed in —
       * the line simply states nothing. It cannot contradict a fact, cannot
       * make this a different property and cannot fill a field, so it is
       * counted as unresolved and answers to the same rule as every other
       * line: it stands the document down only if it leads with a canonical
       * label AND states a figure, which a blank by definition does not.
       *
       * That was not always so, and it cost a whole document. Lot 717's
       * estate is `Society 1056`, which carries no field word, so nothing
       * claimed `development_name` — and page 2's empty `Estate:` box threw
       * the lot, the street, the design and the price away with it.
       */
      if (labelled && labelled.value) {
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
        found.push(...via('labelled', [labelled]));
      } else {
        const numbers = readLabelledNumbers(line);
        if (numbers) found.push(...via('labelled_numbers', numbers));
        else {
          const counts = readInlineCounts(line);
          if (counts) found.push(...via('inline_counts', counts));
          else {
            const lot = readLotHeading(line);
            if (lot) found.push(...via('lot_heading', [lot]));
            else {
              const place = readNamedPlace(line);
              const named = place ? null : readInlineFieldName(line);
              /*
               * The established readers first, always. This one is the
               * mirror of `readInlineFieldName` and never its competitor: a
               * line it could read has a heading at the END, and a line this
               * one reads has it at the START.
               */
              const leading = place || named ? null : readLeadingFieldName(line);
              if (place) found.push(...via('named_place', place));
              else if (named) found.push(...via('inline_field_name', [named]));
              else if (leading) found.push(...via('leading_field_name', [leading]));
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
                const besideText = beside !== null && !consumed.has(beside)
                  ? units[beside].text : null;
                const alongside = besideText !== null
                  ? readVerticalPair(line, besideText) : null;
                if (alongside && beside !== null) {
                  found.push(...via('beside', [alongside.claim]));
                  consumed.add(beside);
                } else {
                  const below = unitBelow(units, index);
                  const under = below !== null && !consumed.has(below)
                    ? readVerticalPair(line, units[below].text) : null;
                  if (under && below !== null) {
                    found.push(...via('below', [under.claim]));
                    consumed.add(below);
                  } else {
                    const caption = below !== null && !consumed.has(below)
                      ? readCaptionedValue(line, units[below].text) : null;
                    if (caption && below !== null) {
                      found.push(...via('caption', [caption.claim]));
                      consumed.add(below);
                    }
                  }
                }
              }
            }
          }
        }
      }

      /*
       * ======================================================================
       * AN ADDRESS BLOCK IS A PROPERTY OF THE PAGE'S LINES.
       * ======================================================================
       *
       * A street line with a locality line under it, and the same address set
       * as one comma-separated line. Collected for EVERY line, never claimed
       * here: whether a block may be read depends on how many the whole
       * document holds, and that is judged once at the end.
       *
       * IT USED TO BE COLLECTED ONLY FOR A LINE NOTHING ELSE COULD READ, and
       * that is the defect the letter-spaced fixture found. A builder writes
       *
       *     Lot 37 Fairweather Drive
       *     Sandpiper Estate, Tweed Heads NSW 2485
       *
       * and the first line is a LOT HEADING — read, claimed, and therefore
       * never offered to the address reader, so the street, the suburb, the
       * state and the postcode were all absent on a document that prints them
       * in full. Whether a line names a lot and whether it names a street are
       * two different questions about the same words, and only one of them was
       * being asked. The whole-document guard is unchanged: two blocks still
       * claim nothing.
       */
      {
        const street = readStreetLine(line);
        if (street) {
          const beneath = unitBelow(units, index);
          const under = beneath !== null && !consumed.has(beneath)
            ? units[beneath].text : null;
          /*
           * THE LOCALITY LINE, READ BY WHICHEVER READER READS IT BETTER.
           *
           * `readLocalityLine` takes everything before the state as the
           * suburb, so `Sandpiper Estate, Tweed Heads NSW 2485` gives the
           * suburb `Sandpiper Estate, Tweed Heads` — a suburb no register
           * has. The composed reader already knows that a comma before the
           * locality separates an ESTATE from it, and says which is which, so
           * it is asked first and the simpler reader is the fallback.
           */
          const composedUnder = under ? readComposedAddressLine(under) : null;
          const locality = composedUnder && composedUnder.suburb
            ? {
                suburb: composedUnder.suburb,
                state: composedUnder.state,
                postcode: composedUnder.postcode,
              }
            : (under ? readLocalityLine(under) : null);
          if (locality && under !== null) {
            addressBlocks.push({
              street, ...locality,
              development: composedUnder?.development ?? null,
              lines: [line, under],
            });
          }
        }
        /*
         * AND THE SAME ADDRESS SET AS ONE LINE. It joins the SAME list, so
         * the whole-document guard counts both shapes together and a document
         * carrying one of each still claims nothing.
         *
         * A COMPOSED READING THAT NAMES NEITHER A STREET NOR A LOT IS NOT AN
         * ADDRESS BLOCK. It is a locality line — and on a two-line address it
         * is the SECOND line of a block already collected above, so pushing it
         * made one address look like two, the whole-document guard refused
         * them both, and a brochure printing its street, suburb, state and
         * postcode in full imported none of them. The guard was right; it was
         * being handed the same address twice.
         *
         * THE LOT COUNTS, and that is not a detail. `Lot 37, Sandpiper Estate,
         * Tweed Heads NSW` is the production document's own address line and
         * carries no street at all: the lot IS how it says which property it
         * is. Requiring a street would have thrown that whole line away, which
         * is the defect this reader was written to close.
         */
        const composed = street ? null : readComposedAddressLine(line);
        if (composed && (composed.street || composed.lot)) {
          addressBlocks.push({
            street: composed.street,
            suburb: composed.suburb,
            state: composed.state,
            postcode: composed.postcode,
            lot: composed.lot,
            development: composed.development,
            lines: [line],
          });
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
        /*
         * ================================================================
         * A LABEL WITH NOTHING THIS READER COULD PAIR TO IT STATES NOTHING.
         * ================================================================
         *
         * This refused the document, and the whole class is gone for the
         * same reason the blank form field is. A floor plan is a page of
         * bare labels — `Bath`, `Garage`, `Ensuite`, `Porch`, `Linen` — and
         * a siting plan is a form with empty boxes. A heading with no value
         * beside it, under it or anywhere the page put it cannot
         * contradict a fact, cannot make this a different property and
         * cannot fill a field. The document simply did not say.
         *
         * What it must never do is CLAIM anything, and it does not: the
         * pairing readers refused it precisely because no value they would
         * accept was there. `DESIGN` over `210 m²` still records no design.
         *
         * The line is counted as one the reader could not resolve, and
         * answers to the same rule as every other: it stands the document
         * down only if it leads with a canonical label AND states a figure
         * — which a bare label, by definition, does not.
         */
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
        if (!placedAt.has(line)) {
          const unit = units[index];
          placedAt.set(line, `p${pageIndex + 1} r${unit.row} x${Math.round(unit.x)}`);
        }
        continue;
      }

      /*
       * ==================================================================
       * A LINE THAT NAMES FOUR LOTS IS NAMING NONE OF THEM.
       * ==================================================================
       *
       * MEASURED 21 SEPTEMBER 2026 on the acceptance corpus's site-plan
       * package. Its plan page draws
       *
       *     Lot 303      Lot 304      Lot 306      Lot 307
       *
       * directly above `Adjoining allotments are not offered for sale in
       * this package.` The reader took `303`, then took `304`, saw two
       * answers for a material field and refused the whole document — over
       * a brochure whose subject lot, street, suburb, state, design, land
       * size and price were each stated exactly once and never in doubt.
       *
       * A designation identifies ONE property. A line carrying several of
       * them is therefore not any property's designation — it is a list: a
       * site plan's adjoining allotments, a legend, a release index. So the
       * line claims NOTHING and the document's real identity, stated
       * elsewhere and stated once, stands.
       *
       * THIS IS NOT "PICK THE FIRST ONE", which is the judgement this module
       * does not make, and it is not a relaxation of the conflict rule: two
       * lots on two different LINES still refuse the document, because that
       * really may be two properties. The difference is that a line is a
       * unit of statement, and a statement of four lots is a statement about
       * a neighbourhood.
       *
       * It is not incidental either — the line stays unresolved and answers
       * to the ordinary unread-line rule, so a document whose ONLY lot
       * information is such a list still stands down rather than importing
       * a property nobody named.
       */
      for (const claim of found.flatMap(splitAddress).flatMap(splitLocality).map(trimSeparators)) {
        if (suppressDesignations && DESIGNATION_FIELDS.has(claim.field)) continue;
        if (!BROCHURE_CLAIMABLE_FIELDS.has(claim.field)) continue;
        /*
         * ================================================================
         * A VALUE MADE ENTIRELY OF PUNCTUATION IS NOT A VALUE.
         * ================================================================
         *
         * MEASURED 21 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property
         * Package.pdf`, the one live upload in this deployment and the
         * document this whole incident is about. Its refusal, read back out
         * of its own row once refusals started carrying their evidence:
         *
         *     conflicting_values:development_name
         *     development_name = ·
         *     development_name = PROPLAUNCH
         *
         * The document does not name two estates. It names none: one of the
         * two "estates" is a BULLET GLYPH. A middle dot was claimed as a
         * development name, the platform's own branding was claimed as
         * another, the two disagreed, and a material conflict stood down a
         * brochure that states its lot, its design and its land size
         * perfectly — which the same row records as `fields_read`.
         *
         * Nothing downstream could have caught it. `development_name` is a
         * free-text field, so no coercion refuses a dot; the conflict rule
         * fired on a pair of values only one of which was ever real; and
         * with the conflict gone a single `·` would simply have been
         * published as the estate on a builder's card.
         *
         * THE TEST IS ALPHANUMERIC, NOT ALPHABETIC, because `lot_number` is
         * legitimately `12` and `postcode` is legitimately `3338`. A value
         * carrying no letter AND no digit anywhere states nothing in any
         * field this vocabulary has — it is a separator, a bullet or a rule
         * that a layout put where a value goes.
         *
         * It is dropped rather than standing the document down: a glyph is
         * not the document disagreeing with itself, it is this reader having
         * picked up something that was never a statement.
         */
        /*
         * ==================================================================
         * ONE GATE. READERS DISCOVER EVIDENCE; THEY DO NOT SET THE STANDARD.
         * ==================================================================
         *
         * Whether a value BELONGS to a field is discovery, and it is each
         * reader's business. Whether what was found is the KIND of thing the
         * field holds is not, and it used to be answered here in four
         * separate tests and in three readers besides — a count guard one
         * reader made, an area guard another made, a designation shape a
         * third made. Scattered standards are how `Garage: 22.59m²` became
         * twenty-two car spaces and how `LAND $334,000` became a land size of
         * three hundred and thirty-four thousand square metres.
         *
         * `acceptFieldValue` is now the only answer, it is typed, and every
         * refusal names its reason. See `fieldTypes.pure.ts` — in particular
         * the case it exists for, which this document states:
         *
         *     T O T A L  P A C K A G E · L A N D + B U I L D · I N C .  G S T
         *                                                          $1,327,407
         *
         * Normalisation makes `LAND` and `BUILD` legible, correctly, because
         * they ARE those words. Money is still not an area.
         *
         * WHAT PROOF THE STRUCTURE OFFERS travels with the question. A label
         * drawn near a value is weak evidence, so a price must SAY it is
         * money; a column under a heading is strong, and that path asks with
         * `column`. A figure that might be an area, a reference or a year
         * must never become a price because it was large.
         */
        const verdict = acceptFieldValue(claim.field, claim.value, 'label');
        if (!verdict.accepted) {
          /*
           * A GLYPH IS DROPPED; A STATEMENT IS DECLINED. The difference is
           * whether the document said anything: `·` in a value slot is this
           * reader picking up punctuation, and `LAND $334,000` is the
           * document stating a fact this reader refuses to read as an area.
           * The second is worth naming in the import log; the first would
           * fill it with noise.
           */
          if (verdict.reason !== 'no_alphanumeric_content'
            && verdict.reason !== 'empty') {
            declined.add(claim.field);
            declinedBecause.set(claim.field, verdict.reason);
          }
          continue;
        }
        /*
         * `M A S T E R P L A N` IS A HEADING THIS DOCUMENT TRACKED OUT.
         *
         * MEASURED 21 SEPTEMBER 2026 on the same document:
         *
         *     development_name = PROPLAUNCH
         *     development_name = M A S T E R P L A N
         *
         * A designer tracked out a page heading — a normal treatment for one
         * — and had it been the only candidate it would have gone onto a
         * builder's card as the estate. The guard that caught it refused any
         * letter-spaced VALUE, which worked only because nothing had made it
         * legible; now that normalisation has, the FACT travels instead.
         * Letter-spacing is applied to the words that label things and never
         * to the thing itself, so a word this page set as display type is its
         * heading and no field may hold one. Numbers are excluded by
         * construction: `3 7` is the lot the heading above it introduces.
         */
        if (headings.has(claim.value.replace(/\s+/g, ' ').trim().toUpperCase())) {
          continue;
        }
        const existing = claimed.get(claim.field);
        if (existing === undefined) {
          claimed.set(claim.field, claim.value);
          if (claim.via) readBy.set(claim.field, claim.via);
          continue;
        }
        if (disputed.has(claim.field)) continue;
        if (!sameValue(claim.field, existing, claim.value)) {
          /*
           * ================================================================
           * TWO ANSWERS IS NOT AN ANSWER — ABOUT THAT FIELD.
           * ================================================================
           *
           * Two lots, two designs, two estates or two prices are a document
           * this reader cannot resolve into ONE property, and separating
           * them is the judgement it does not make. Those still refuse the
           * whole document.
           *
           * EVERYTHING ELSE LOSES ONLY ITSELF, and that is the correction
           * the sibling brochure forced. Lot 717 failed outright on
           * `conflicting_values:land_size_sqm` — its lot, its street, its
           * design, its estate and its price were never in doubt, and a
           * disagreement about one measurement threw all of them away and
           * sent a perfectly legible document to a model that was not
           * available. Refusing the FIELD keeps every guarantee that matters:
           * nothing is invented, nothing is chosen between, and an absent
           * measurement is the one state this product already treats as
           * honest everywhere else. Importing Lot 717 with no land size is
           * strictly better than importing nothing and telling the builder
           * their brochure could not be read.
           *
           * The disputed field is DROPPED rather than left at its first
           * reading — whichever came first is an accident of page order, and
           * keeping it would be choosing.
           */
          if (MATERIAL_FIELDS.has(claim.field)) {
            diagnostics.conflictField = claim.field;
            diagnostics.fieldsRead = [...claimed.keys()].sort();
            /*
             * THE TWO ANSWERS THEMSELVES, AND NOT JUST THE NAME OF THE
             * QUESTION.
             *
             * MEASURED 21 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property
             * Package.pdf`. Its row recorded `conflicting_values:
             * development_name` and `unaccounted_lines: 0`, which names the
             * field and states that nothing was left over — so the record
             * said a document disagreed with itself about its estate and
             * held NOTHING about what the two estates were. There is no way
             * to tell from that whether the document names two genuinely
             * different places or spells one place two ways, and no way to
             * find out except to ask the builder to send the file again.
             * That is the diagnostic dead end this whole incident kept
             * running into.
             *
             * It travels as `unaccounted`, which is document text and reaches
             * `error_detail` — bounded by the same two limits every other
             * line here answers to — and never as a diagnostic, which is the
             * safe-to-log projection.
             */
            return refuse('ambiguous', `conflicting_values:${claim.field}`, diagnostics,
              [], [`${claim.field} = ${existing}`, `${claim.field} = ${claim.value}`]);
          }
          disputed.add(claim.field);
          claimed.delete(claim.field);
          continue;
        }
        /*
         * THE SAME MEASUREMENT, WRITTEN MORE PRECISELY. Where two readings
         * reconcile, the finer one is the document being exact rather than
         * the document repeating itself: `Site Area: 320.72 m²` is what
         * `Lot Size 321m²` rounds. Keeping the first would make the answer
         * depend on page order.
         */
        if (NUMERIC_VALUE_FIELDS.has(claim.field)
          && decimalsIn(claim.value) > decimalsIn(existing)) {
          claimed.set(claim.field, claim.value);
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
  /*
   * ======================================================================
   * A HEADING IS A LABEL CANDIDATE. IT IS NOT A CANDIDATE FOR ANYTHING.
   * ======================================================================
   *
   * `unresolved` is what the readers below draw their candidates from —
   * `corroborateDesignFromFilename` takes a line whose words all appear in the
   * filename, `readPlaceNamedWithoutTheWord` takes `<name>, <place>`. Both ask
   * `readsAsAName`, and a word set in capitals reads as one.
   *
   * MEASURED on `Lot 37 - Miami 190 - Property Package.pdf`, the first run
   * after normalisation reached this file. The filename corroborator had one
   * candidate — `Miami 190`, the design, drawn bare on the page — and now had
   * three, because `L O T` and `P A C K A G E` had become `LOT` and `PACKAGE`,
   * both of which are words in that filename. Three candidates is ambiguity,
   * so it took none, and a design the document and the filename BOTH named was
   * lost. Normalisation made two headings legible and a reader downstream read
   * their legibility as evidence.
   *
   * THIS IS THE RULE THE WHOLE LAYER TURNS ON. A phrase a designer tracked out
   * may become a LABEL — that is what made `B E D` and `T O T A L  H O M E`
   * worth resolving at all — and it may never become a VALUE, a name, or a
   * candidate for one. The claim gate says the same thing about `claimed`; this
   * says it about every reader that goes looking.
   */
  const notAHeading = (line: string) =>
    !headings.has(String(line ?? '').replace(/\s+/g, ' ').trim().toUpperCase());
  const repeats = unresolved
    .filter((line) => !corroboratedBy(line, names))
    .filter(notAHeading);

  /*
   * THE ADDRESS BLOCK, TAKEN ONLY WHERE THE DOCUMENT DRAWS EXACTLY ONE.
   *
   * Judged here rather than in the loop because the guard is a property of
   * the WHOLE document: a builder's own office address is the same shape as
   * a property's, and this module does not choose between two readings. Two
   * blocks claim nothing and the document reads exactly as it does today.
   *
   * It defers to anything the document LABELLED. A `Site Address:` box, a
   * `Locality:` line or a suburb read from any labelled field is the
   * document saying so in words, and a block read from shape alone must
   * never overrule one.
   *
   * AND IT IS TAKEN BEFORE THE FILENAME IS CONSULTED, which is where it
   * belongs and is not where it was first written. The filename may
   * corroborate a design only on a document that has established WHICH
   * property it is, and on a flyer that names no estate the address IS that
   * establishment — so claiming it afterwards left the corroboration with
   * nothing to anchor to and the design unread. What the DOCUMENT says is
   * settled first; the filename is a second opinion and speaks second.
   */
  const addressBlock = addressBlocks.length === 1 ? addressBlocks[0] : null;
  const addressBlockRead = Boolean(addressBlock)
    && !claimed.has('address_line') && !claimed.has('suburb');
  if (addressBlock && addressBlockRead) {
    if (addressBlock.street) claimed.set('address_line', addressBlock.street);
    claimed.set('suburb', addressBlock.suburb);
    claimed.set('state', addressBlock.state);
    claimed.set('postcode', addressBlock.postcode);
    if (!addressBlock.postcode) claimed.delete('postcode');
    for (const field of ['address_line', 'suburb', 'state', 'postcode']) {
      if (claimed.has(field)) readBy.set(field, 'address_block');
    }
    /*
     * The estate the line itself named, and only where the line SAID so.
     * It outranks nothing: a document that labelled its estate has already
     * claimed the field and this leaves it alone.
     */
    if (addressBlock.development && !claimed.has('development_name')) {
      claimed.set('development_name', addressBlock.development);
      readBy.set('development_name', 'address_block');
    }
    /*
     * The lot the address line itself carried — taken ONLY where the document
     * has not already said which lot it is, so a line can never become a
     * second opinion about identity. Where both speak and disagree, the
     * existing conflict rule is the one that decides.
     */
    if (addressBlock.lot && !claimed.has('lot_number')) {
      claimed.set('lot_number', addressBlock.lot);
      readBy.set('lot_number', 'address_block');
    }
  }
  const afterAddress = addressBlock && addressBlockRead
    ? repeats.filter((line) => !addressBlock.lines.includes(line))
    : repeats;

  /*
   * THE FILENAME'S ONE JOB, taken after every page has been read so the
   * estate is as settled as the document is going to make it.
   */
  const corroborated = corroborateDesignFromFilename({
    filename: options.filename, unresolved: afterAddress, claimed,
  });
  if (corroborated === 'lot_mismatch') {
    diagnostics.conflictField = 'lot_number';
    diagnostics.fieldsRead = [...claimed.keys()].sort();
    return refuse('ambiguous', 'filename_lot_disagrees_with_document', diagnostics);
  }
  if (corroborated && !readsAsPromotion(corroborated.claim.value)) {
    claimed.set('house_design', trimSeparators(corroborated.claim).value);
    readBy.set('house_design', 'filename');
  }
  const afterFilename = corroborated
    ? afterAddress.filter((line) => line.trim() !== corroborated.line)
    : afterAddress;

  /*
   * THE ESTATE THE DOCUMENT NAMES WITHOUT THE WORD, confirmed by the
   * locality it states under a label of its own.
   */
  const place = corroborateDevelopmentFromPlace(afterFilename, claimed);
  if (place && !readsAsPromotion(place.value)) {
    claimed.set('development_name', trimSeparators(place).value);
    readBy.set('development_name', 'named_place');
  }
  const placedByName = place
    ? afterFilename.filter((line) =>
      flattenIdentity(line.split(',')[0] ?? '') !== flattenIdentity(place.value))
    : afterFilename;

  const placed = placedByName;

  /*
   * =====================================================================
   * WHAT AN UNREAD LINE HAS TO BE BEFORE IT STANDS A DOCUMENT DOWN.
   * =====================================================================
   *
   * `complete` never meant that every line of a seven-page marketing
   * brochure became a column, and the rule that said so was unreachable on
   * a real document: the production brochure for Lot 315 carries a floor
   * plan (`Robe`, `Terrace`, `Kitchen`, `Linen`, `Ensuite`, `LDRY`,
   * `Porch`), twelve inclusions bullets, five pages of specification copy
   * and a comparison spread. Forty lines, not one of which could make this
   * a different property or change what is being sold for how much.
   *
   * So the test is what the line WOULD have told us: a line that plainly
   * names one of `BLOCKING_FIELDS` and that this reader could not place is
   * a canonical fact left unread, and it still stands the document down.
   * Everything else is the document's own prose, and it is counted and
   * reported rather than acted on.
   *
   * The conservative half is untouched. Two statements of one field still
   * answer `ambiguous`, a summary word still cannot be an identity, a
   * filename that disagrees about the lot still refuses, and no field is
   * ever filled from a line this reader did not read.
   */
  const stillUnresolved = placed.filter((line) =>
    blockingFieldNamed(line) !== null && statesAValue(line));
  diagnostics.ignoredLines = placed.length - stillUnresolved.length;
  /*
   * The same lines, kept rather than only counted. `placed` is what survived
   * every attribution rule, so this is precisely "what the document said that
   * became no field" — the one thing needed to answer why a field is empty.
   */
  const ignoredText = placed.filter((line) => !stillUnresolved.includes(line));

  diagnostics.fieldsRead = [...claimed.keys()].sort();
  diagnostics.unaccountedLines = stillUnresolved.length;
  diagnostics.incidentalLines = incidental;
  diagnostics.corroboratedLines = unresolved.length - repeats.length;
  if (declined.size) {
    diagnostics.declinedFields = [...declined].sort();
    /*
     * THE NAMES ARE THE CONTRACT; THE REASONS ARE BESIDE THEM. Widening
     * `declinedFields` into `field:reason` would have been a quieter change
     * to make and a worse one: `importTelemetry` projects that list into the
     * import log and three specs read it as names, so every one of them would
     * have kept passing while meaning something else.
     */
    const reasons = [...declined].sort()
      .filter((field) => declinedBecause.has(field))
      .map((field) => `${field}:${declinedBecause.get(field)}`);
    if (reasons.length) diagnostics.declinedBecause = reasons;
  }
  /*
   * THE ICON ROW, read only where the floor plan corroborates it. Placed
   * with the other corroborations because it needs the whole document: the
   * row is on the cover and the plan that proves it is pages later.
   */
  /*
   * A count the document's own row does not carry goes first, because a
   * figure nothing supports must not survive into the reading — and while
   * it stands it also suppresses the row that could have replaced it.
   */
  for (const field of countsContradictedByRow(pages, claimed)) {
    disputed.add(field);
    claimed.delete(field);
    readBy.delete(field);
  }
  const counts = readIconCountRow(pages, claimed);
  if (counts) {
    for (const claim of counts.claims) {
      claimed.set(claim.field, claim.value);
      /*
       * `icon_row` NAMES WHERE THE VALUE CAME FROM, which is the row the
       * document printed — the plan is the KEY that reads it, not the source
       * of the figure. How it was keyed is `countEvidence` beside this.
       */
      readBy.set(claim.field, 'icon_row');
    }
    diagnostics.countsCorroborated = true;
    /*
     * WHAT SETTLED THE ROW, not merely that something did. The two readings
     * are different evidence — a fraction that can only be a bathroom, and a
     * plan that named the rooms — and a log that says only "corroborated"
     * cannot tell a figure proved by the document's own plan from one that
     * was proved by arithmetic.
     */
    diagnostics.countEvidence = counts.evidence;
  }
  // What was read is what the row carries, and the counts settle last.
  diagnostics.fieldsRead = [...claimed.keys()].sort();
  const provenance = [...claimed.keys()].sort()
    .map((field) => `${field}:${readBy.get(field) ?? 'unknown'}`);
  if (provenance.length) diagnostics.readBy = provenance;

  const visualOnly = [...COUNT_FIELDS].filter((field) => !claimed.has(field)).sort();
  if (visualOnly.length) diagnostics.visualOnlyFields = visualOnly;
  if (disputed.size) diagnostics.disputedFields = [...disputed].sort();

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
  /*
   * AND THE READING SURVIVES THE REFUSAL, without changing it.
   *
   * The paragraph above is unchanged and still decides: an unaccounted line
   * stands this document down and the assisted reader gets it. What is new is
   * that the four fields already read are carried out with the refusal
   * instead of being dropped on the floor, so a caller that discovers there
   * is no assisted reader has something better than nothing to fall back on.
   * `provisionalFrom` applies every remaining gate, so this cannot admit a
   * record the complete path would have refused.
   */
  if (stillUnresolved.length > 0) {
    return refuse('incomplete', 'unaccounted_specification_lines', diagnostics,
      provisionalFrom(claimed), stillUnresolved, ignoredText, placedAt);
  }

  /*
   * THE COUNTS MAY BE STATED ONCE, NOT TWICE — AND THAT COSTS THE COUNTS.
   *
   * A document carrying both `3 Bed 2 Bath 2 Car` and `Bedrooms: 4` states
   * its configuration two ways, and which one wins inside
   * `normaliseStockRow` would be decided by key order — a detail of this
   * function, not of the document. So neither is kept.
   *
   * It used to refuse the whole document, which is the same mistake the
   * measurement conflict made: a configuration says nothing about WHICH
   * property this is. The room counts are dropped, reported, and the lot,
   * the design, the estate and the price stand.
   */
  if (claimed.has('bed_bath_car')
    && (claimed.has('bedrooms') || claimed.has('bathrooms') || claimed.has('car_spaces'))) {
    for (const field of ['bed_bath_car', 'bedrooms', 'bathrooms', 'car_spaces']) {
      if (claimed.delete(field)) disputed.add(field);
    }
    diagnostics.fieldsRead = [...claimed.keys()].sort();
    diagnostics.disputedFields = [...disputed].sort();
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
  const keptIgnored = boundLines(ignoredText);
  return {
    status: 'complete',
    // Nothing provisional on a complete reading: the rows ARE the reading,
    // and a complete reading accounted for every line by definition.
    provisional: [],
    unaccounted: [],
    // What the reader PLACED but could not name. A complete reading still
    // leaves these behind — a brochure prints far more than a stock row
    // holds — and they are the only evidence of what the document said in
    // the space a missing field would have come from.
    ignored: keptIgnored,
    placement: keptIgnored.map((line) => placedAt.get(line) ?? ''),
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
  /**
   * The run's drawn height, where the reader supplied one.
   *
   * Optional, and absent means 0: every rule that reads it declines when it
   * is missing, so a fixture written before this existed reads exactly as it
   * did.
   */
  height?: number;
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

/**
 * A WORD SPACE GROWS WITH THE TYPE; A CONSTANT DOES NOT.
 *
 * Six units is right for body copy and wrong for a headline, and that is not
 * a tuning question — it is the difference between reading a brochure and
 * reading a bag of words. A page's display lines are its identity: the lot,
 * the street, the estate, the titles date. Split them at the spaces and the
 * document states none of them.
 *
 * MEASURED, on the production brochure for Lot 315, over every run gap on all
 * seven pages. The word spaces are
 *
 *   h=24.0  gap 4.12   "Titles:" | "December" | "2026"   ratio 0.17
 *   h= 9.6  gap 3.09   "1:200" | "@ A4"                  ratio 0.32
 *   h=10.0  gap 3.95   "Quality" | "Flooring throughout"  ratio 0.40
 *   h= 7.0  gap 4.58   "Glasswool" | "batts"              ratio 0.65
 *
 * and the narrowest gap that genuinely separates two columns is
 *
 *   h= 8.9  gap 8.02   "Home Design:" | "ENZO 8.5 - MODERN"   ratio 0.90
 *   h= 8.9  gap 11.76  "Site Address:" | "Lot 315 CENTRAL …"  ratio 1.32
 *
 * — so at 0.6 of the type's own height the two populations do not touch, and
 * the six-unit floor still carries everything set at ten units or under.
 *
 * THE FLOOR IS WHAT MAKES IT A NO-OP ON WHAT ALREADY WORKS. Every line on
 * that document at h > 10 has its runs either abutting or 29 units apart or
 * more, so nothing it reads today changes; only display type set loosely
 * enough to break at its spaces is affected, which is the case this exists
 * for. And the asymmetry runs the safe way: merging two cells leaves a line
 * the label readers still resolve, while splitting one destroys the
 * statement outright.
 *
 * A run with no height reported falls back to the floor, so a fixture
 * written before `height` existed reads exactly as it did.
 */
const COLUMN_GAP_PER_UNIT_OF_TYPE = 0.6;

function columnGapFor(left: PdfTextItem, right: PdfTextItem): number {
  const type = Math.max(
    Number.isFinite(left.height) ? Number(left.height) : 0,
    Number.isFinite(right.height) ? Number(right.height) : 0,
  );
  if (!(type > 0)) return MIN_COLUMN_GAP;
  return Math.max(MIN_COLUMN_GAP, type * COLUMN_GAP_PER_UNIT_OF_TYPE);
}

/**
 * A SUPERSCRIPT IS PART OF ITS NUMBER, NOT A LINE OF ITS OWN.
 *
 * Measured on the production brochure for Lot 315: the page writes its areas
 * as `321m` with a raised `2`, and the two are separate runs —
 *
 *   "321"  y=168.9  h=10.0      "m"  y=168.9  h=10.0
 *   "2"    y=172.3  h= 5.8      x=48.9, where "m" ends at 49.0
 *
 * — 3.4 units up at 58% of the type size, abutting. Grouped by baseline
 * alone that `2` becomes a LINE of its own, which breaks `Lot Size` away
 * from its value and leaves the document unable to state its own land size.
 * Every area on that page is written this way, so it is the difference
 * between reading four measurements and reading none.
 *
 * IT IS DONE OVER ROWS RATHER THAN RUNS, because a raised run sorts ABOVE
 * the run it belongs to: in reading order the `2` arrives before the `321`
 * it modifies, so no pass that compares a run with the one before it can see
 * the pair. A row that is nothing but small raised runs is folded into the
 * row beneath it, and the ordinary left-to-right cell assembly then puts
 * each one back where it was drawn.
 *
 * EVERY TEST IS ABOUT THE TYPE, NOT THE TEXT. Nothing here reads `m` or `2`,
 * so an exponent, a footnote marker and an ordinal all fold the same way and
 * the reading that follows decides what the fused text means. A run whose
 * height the reader did not supply declines, so a fixture written before
 * that field existed is untouched.
 */
function foldSuperscriptRows(
  groups: Array<{ y: number; items: PdfTextItem[] }>,
): void {
  for (let index = groups.length - 1; index >= 1; index--) {
    const raised = groups[index];
    const base = groups.find((candidate) => candidate !== raised
      && candidate.y < raised.y
      && raised.y - candidate.y < SUPERSCRIPT_MAX_RISE);
    if (!base) continue;
    const baseHeight = Math.max(...base.items.map((item) => item.height ?? 0));
    if (!(baseHeight > 0)) continue;
    if (raised.y - base.y >= baseHeight) continue;
    const every = raised.items.every((item) => {
      const height = item.height ?? 0;
      if (!(height > 0) || height >= baseHeight) return false;
      return base.items.some((anchor) => {
        const gap = item.x - (anchor.x + (anchor.width || 0));
        return gap > -1 && gap < MIN_COLUMN_GAP;
      });
    });
    if (!every) continue;
    base.items.push(...raised.items);
    groups.splice(index, 1);
  }
}

/**
 * The most a run may sit above another and still be its superscript.
 *
 * A line of body copy is set well beyond this; the measured rise on the
 * production document is 3.4 units. It is only a first filter — the base
 * row's own type size is what actually decides, and it is stricter.
 */
const SUPERSCRIPT_MAX_RISE = 8;

/**
 * The narrowest gap that is a SPACE rather than the join inside a word.
 *
 * Measured: runs that continue a word abut at |gap| ≤ 0.28, and a page that
 * wants a space emits one as a run of its own. See `layoutLines`.
 */
const MIN_SPACE_GAP = 1;

/** A cell may begin a hair to the left of its column and still be in it. */
const COLUMN_SLACK = 2;

/** How far down a page a header may sit, matching `keyRowsByHeader`'s own scan. */
const MAX_HEADER_SCAN = 15;

/**
 * `width` is where the cell ENDS minus where it starts — the sum of its runs'
 * advances plus the gaps it absorbed. Supplied because the phrase rule in
 * `documentNormalisation` measures a gap against the run before it, and a cell
 * with no width falls back to bare adjacency.
 */
interface LayoutCell { x: number; text: string; width?: number }
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

  foldSuperscriptRows(groups);

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
    let last: PdfTextItem | null = null;
    for (const item of group.items.slice().sort((a, b) => a.x - b.x)) {
      const text = item.text.trim();
      if (!text) continue;
      const previous = cells[cells.length - 1];
      if (previous && last && item.x - end < columnGapFor(last, item)) {
        /*
         * RUNS THAT ABUT ARE ONE WORD, AND THE PAGE SUPPLIES ITS OWN SPACES.
         *
         * This used to join every run in a cell with a space, which is right
         * for a table — where a cell's runs are whole words — and wrong for
         * everything else. A PDF's text layer breaks a run wherever the
         * exporter placed its glyphs, including inside a number, and the
         * spaces BETWEEN words are runs of their own. Measured on the
         * production brochure for Lot 315:
         *
         *   "Lot"  gap 0.00  " "  gap 0.00  "3"  gap -0.28  "15" …
         *   "Enzo 8"  gap 0.00  ".5"
         *
         * — so the page says `Lot 315 Central Boulevard` and `Enzo 8.5`,
         * and inserting a space produced `Lot 3 15 Central Boulevard` and
         * `Enzo 8 .5`. A lot number the reader could not read and a design
         * nothing could match. `extractText` gets this right on the same
         * bytes, which is the evidence that the runs, not the reader, carry
         * the spacing.
         *
         * So a space is inserted only where the page LEFT one: runs that
         * abut are concatenated. `MIN_SPACE_GAP` is a hair above the
         * measured abutment (|gap| ≤ 0.28 across every run on that page) and
         * far below the narrowest real word gap.
         */
        const gap = item.x - end;
        const joiner = gap >= MIN_SPACE_GAP && !/\s$/.test(previous.text)
          && !/^\s/.test(item.text) ? ' ' : '';
        previous.text = `${previous.text}${joiner}${item.text}`
          .replace(/\s+/g, ' ').trimStart();
      } else {
        cells.push({ x: item.x, text });
      }
      end = Math.max(end, item.x + (Number.isFinite(item.width) ? item.width : 0));
      last = item;
      const current = cells[cells.length - 1];
      if (current) current.width = Math.max(0, end - current.x);
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
  /*
   * A row the recogniser names as the publication talking about itself is
   * DROPPED rather than standing the document down, and the difference from
   * the paragraph above is that this one is not a judgement. "Every row or no
   * rows" is right where the alternative is deciding in silence that a line
   * of a builder's schedule is not stock; an `E&OE` footer is not a silent
   * decision, it is the same positive recognition brochure mode makes about
   * the same sentence. Refusing here would lose three real properties to a
   * disclaimer every stock list carries.
   */
  const kept: typeof keyed.rows = [];
  for (const row of keyed.rows) {
    if (rowIsPublicationFurniture(row as Record<string, unknown>)) continue;
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
    kept.push(row);
  }
  if (!kept.length) {
    return refuse('incomplete', 'a_row_identifies_no_property', diagnostics);
  }
  diagnostics.candidates = kept.length;

  return {
    status: 'complete',
    // Nothing provisional on a complete reading: the rows ARE the reading,
    // and a complete reading accounted for every line by definition.
    provisional: [],
    unaccounted: [],
    ignored: [],
    placement: [],
    rows: kept,
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
      /*
       * A HEADING ROW IS MOSTLY HEADINGS.
       *
       * `headerScore` counts how many of a line's words name a column, and
       * three was enough — which a SENTENCE reaches without being a table.
       * Measured on the production brochure for Lot 315, this line put the
       * whole document through the schedule parser and it came back
       * `two_cells_in_one_column`, a table's refusal on a document holding
       * no table:
       *
       *   "*Price based on standard inclusions and facade. Image depicts
       *    upgrade items not included in the price."
       *
       * Three recognised words — `price`, `inclusions`, `facade` — out of
       * sixteen. The two other disclaimers on its first two pages do the
       * same. Measured against the heading rows this screen exists to admit,
       * the two populations do not overlap and there is nothing in between:
       *
       *   heading rows   8/8, 8/9, 4/8, 6/6   → 0.50 to 1.00
       *   disclaimers    3/16, 3/38, 3/15     → 0.08 to 0.20
       *
       * A column heading names its column and says nothing else, so the
       * density is the test and the floor sits in the empty gap.
       */
      if (headerScore(tokens) / tokens.length < MIN_HEADING_DENSITY) continue;
      return true;
    }
  }
  return false;
}

/**
 * ===========================================================================
 * THE MATERIAL FIELDS — the one test the whole reader answers to.
 * ===========================================================================
 *
 * Every refusal in this module was walked and asked one question: CAN THIS
 * EVIDENCE MEAN WE HAVE THE WRONG PROPERTY OR THE WRONG DEAL? Where the
 * answer is no, it does not stand the document down, because a brochure is
 * a floor plan, an inclusions list, a disclaimer and five pages of
 * specification copy as well as a property, and a reader that must account
 * for all of it can never finish one.
 *
 * These are the fields where the answer is YES. They say WHICH property
 * this is and WHAT IS BEING SOLD FOR HOW MUCH. Two of any of them, or one
 * of them stated in terms this reader could not take, is a document that
 * may be describing a different property or a different deal, and no rule
 * here can pick between them.
 *
 * EVERYTHING ELSE DESCRIBES THE PROPERTY RATHER THAN IDENTIFYING IT. A land
 * size, a build size, a room count, a completion date: a document that
 * disagrees with itself about one of those, or states one this reader could
 * not read, still says perfectly clearly which property it is and what it
 * costs. That field is dropped or left absent and the rest stands.
 *
 * ONE SET, USED TWICE — by the conflict rule and by the unread-line rule —
 * because two lists is how the two come to disagree about what matters.
 * `land_size_sqm` and `building_size_sqm` were in the second list and not
 * the first, which is exactly the inconsistency this replaces.
 */
/*
 * ===========================================================================
 * AND WHY `development_name` IS NOT ON THIS LIST.
 * ===========================================================================
 *
 * It was, and the test above is what takes it off: CAN THIS EVIDENCE MEAN WE
 * HAVE THE WRONG PROPERTY OR THE WRONG DEAL? Two estate names cannot. An
 * estate is a PLACE CONTAINING many properties; the lot is what identifies
 * one, and `lot_number` stays material — so a document that really described
 * two properties would conflict on the lot and refuse exactly as it does
 * today. Nothing about the identity guard is weakened by this.
 *
 * MEASURED 21 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property Package.pdf`,
 * the one live upload in this deployment and the document this whole
 * incident is about. Its two "estates" are
 *
 *     development_name = PROPLAUNCH
 *     development_name = M A S T E R P L A N
 *
 * — a marketing platform's brand mark, and a page heading set in
 * letter-spaced type. THE DOCUMENT NAMES NO ESTATE. Refusing it outright
 * because two wrong guesses disagreed is the worst outcome available: its
 * lot, its land size and its design were never in doubt, and a builder was
 * told their brochure could not be read.
 *
 * This is the correction `land_size_sqm` already forced, applied to the
 * field whose turn it was. The disputed value is DROPPED rather than chosen
 * between, the estate reads as not stated, and not stated is exactly what
 * the document says.
 *
 * `project_name` stays material, deliberately and without evidence either
 * way: it is the closest thing this vocabulary has to a development's own
 * identifier, and there is no measurement in front of me that says two of
 * them can be a single property. One field moves, for the reason the
 * measurement gives.
 */
const MATERIAL_FIELDS: ReadonlySet<string> = new Set([
  'external_reference', 'address_line', 'lot_number', 'unit_number',
  'project_name', 'house_design', 'price',
]);

/**
 * Does this line state a value at all?
 *
 * A heading states none — `House Specifications` names a field this reader
 * carries and cannot contradict anything, because it says nothing about it.
 * What blocks is a line that names a canonical field AND puts a figure
 * beside it, which is a fact the document states and this reader did not
 * take.
 */
function statesAValue(line: string): boolean {
  return HAS_DIGIT.test(line) || CURRENCY_OR_AREA.test(line);
}

/**
 * The field this line states, where it states one plainly.
 *
 * TWO ADJACENT HEADINGS ARE A COMPOUND THIS VOCABULARY DOES NOT KNOW. The
 * production brochure prints `Land Price - $375,000` and `Build Price -
 * $341,675` beside its package price. Reading `Land` there as a land size —
 * which the alias table will do, because `Land` is one — turns a component
 * of the deal into a contradiction of a measurement, and stands down a
 * document that is stating its price breakdown perfectly clearly. When the
 * word after a heading is itself a heading, the document is naming something
 * this vocabulary has no column for, and the honest answer is that it names
 * nothing rather than the first half of it.
 */
function blockingFieldNamed(line: string): string | null {
  /*
   * AND THE LABEL HAS TO LEAD THE LINE.
   *
   * A statement writes its label first — `Land Size 350 m2`, `Price:
   * $500,000`. A heading word in the MIDDLE of a sentence is a word, and
   * reading it as a label is how four lines of the production brochure's
   * own siting notes came to stand the document down:
   *
   *   "500m2 with a maximum setback of 5m to the house."   → house_design
   *   "500mm fall over building envelope. Allotment up to" → project_name
   *   "(Geo Plan ID: 813489)"                              → external_reference
   *   "Build Price - $341,675"                             → price
   *
   * Not one of them states a canonical fact, and every one of them carries
   * a figure, so the value test alone could not tell them apart. A leading
   * bullet or asterisk is stepped over, because that is punctuation the
   * page adds rather than part of what the line says.
   */
  const tokens = line.trim().replace(/^[•*·\-\u2013\u2014]\s*/, '')
    .split(/\s+/).filter(Boolean);
  const reach = Math.min(MAX_LABEL_WORDS, tokens.length);
  for (let length = reach; length >= 1; length--) {
    const field = fieldForHeader(tokens.slice(0, length).join(' '));
    if (!field) continue;
    /*
     * TWO ADJACENT HEADINGS ARE A COMPOUND THIS VOCABULARY DOES NOT KNOW.
     * `Land Price - $375,000` is a component of the deal, not a land size
     * that contradicts a measurement.
     */
    const after = tokens[length];
    if (after !== undefined && fieldForHeader(after)) return null;
    /*
     * A STATEMENT PUTS ITS VALUE NEXT TO ITS LABEL.
     *
     * `Land Size 350 m2` states a size. `Prices from $700,000` does not
     * state the price of anything — it is marketing copy that happens to
     * open with a word this vocabulary knows, and every brochure carries
     * lines like it. The difference is whether the very next token is the
     * VALUE, and that is a property of how a statement is written rather
     * than of any builder's wording.
     */
    if (after === undefined) return null;
    if (!VALUE_TOKEN.test(after)) return null;
    return MATERIAL_FIELDS.has(field) ? field : null;
  }
  return null;
}

/**
 * How much of a line must name a column before it is read as a heading row.
 *
 * Derived, not chosen: see the measurement in `mayHoldSchedule`. The real
 * heading rows this screen admits run 0.50 to 1.00 and the prose it must
 * reject runs 0.08 to 0.20, so the floor sits in the gap between them.
 */
const MIN_HEADING_DENSITY = 0.4;

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
  /** Pages whose text was recognised rather than drawn, 1-based. */
  recognisedPages?: readonly number[] | null;
  organisationName?: string | null;
  filename?: string | null;
}): PdfDeterministicReading {
  const pageTexts = input.pageTexts ?? [];

  const readBrochure = () => readPdfBrochure(pageTexts, {
    positionedPages: input.positionedPages,
    recognisedPages: input.recognisedPages,
    organisationName: input.organisationName,
    filename: input.filename,
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

  /*
   * ======================================================================
   * A SCHEDULE IS STILL READ AS A SCHEDULE, AND IT IS ASKED FIRST.
   * ======================================================================
   *
   * A document whose flattened text shows a heading row is a table, and the
   * table parser has guarantees about the grid that nothing else here has:
   * every cell in a column, a cell outside every column refuses, two cells in
   * one column refuses. Segmentation would be asking a weaker reader a
   * question this one already answers well, so the order is unchanged for
   * every document that has ever reached it — and a schedule reading that
   * COMPLETES returns before anything below runs.
   */
  const schedule = positioned && positioned.length && mayHoldSchedule(pageTexts)
    ? assemblePdfSchedule(positioned)
    : null;
  if (schedule?.status === 'complete') return schedule;

  /*
   * ======================================================================
   * SEVERAL PROPERTIES ON ONE PAGE ARE SEVERAL DOCUMENTS.
   * ======================================================================
   *
   * A page carrying three property cards was read as ONE document by every
   * reader below this line, because every one of them reads a document as a
   * stream of lines and a stream of lines has no columns in it. The brochure
   * reader would either refuse it (three lots stated, one `lot_number`, a
   * `conflicting_values` ambiguity) or — where the cards state different
   * fields — complete it as one property wearing three properties' facts.
   * The second outcome is the one that matters: it is not a missing import,
   * it is a WRONG one, and it is the only shape in this subsystem that can
   * put one builder's price on another builder's house.
   *
   * IT RUNS BEFORE THE BROCHURE READER because that reader answers for the
   * page as a whole, and by the time it has spoken the regions are gone.
   *
   * AND IT ALMOST NEVER ENGAGES. `segmentPropertyRegions` answers null for
   * every page that does not carry PROPERTY-LEVEL evidence in more than one
   * band — which is every single-property brochure, however many visual
   * columns it sets, because a column of prose beside a column of render
   * states one lot between them. Where it answers null for every page this
   * returns null and the readers below see exactly what they have always
   * seen.
   */
  let regionsFound = 0;
  let regionsAbandoned = '';
  if (positioned && positioned.length) {
    const segmented = readSegmentedDocument(pageTexts, positioned, {
      recognisedPages: input.recognisedPages,
      organisationName: input.organisationName,
    });
    if (segmented.reading) return segmented.reading;
    regionsFound = segmented.found;
    regionsAbandoned = segmented.abandoned;
  }

  const brochure = readBrochure();
  /*
   * REGIONS WERE FOUND AND THE READING WAS ABANDONED, so the document is read
   * exactly as it was before — and the log says so. A fallback that is silent
   * is indistinguishable from a page that never segmented, which is the one
   * thing an operator looking at a multi-property sheet needs to be able to
   * tell apart.
   */
  if (regionsFound) {
    brochure.diagnostics.regionsFound = regionsFound;
    brochure.diagnostics.regionsAbandoned = regionsAbandoned;
  }
  if (brochure.status === 'complete') return brochure;
  /*
   * WHEN BOTH READERS REFUSE, THE ONE THAT READ SOMETHING IS THE ANSWER.
   * See `moreEvidencedRefusal`, and the defect below it that cost a whole
   * seven-page brochure its import.
   */
  if (schedule) {
    const answer = moreEvidencedRefusal(schedule, brochure);
    if (regionsFound) {
      answer.diagnostics.regionsFound = regionsFound;
      answer.diagnostics.regionsAbandoned = regionsAbandoned;
    }
    return answer;
  }
  return brochure;
}

/**
 * ===========================================================================
 * ONE PAGE, SEVERAL PROPERTIES — READ AS SEVERAL DOCUMENTS.
 * ===========================================================================
 *
 * `segmentPropertyRegions` decides WHERE the properties are; this decides
 * what may be done about it. The separation matters: the segmenter is
 * geometry and evidence and has no opinion about readers, and this has no
 * opinion about columns.
 *
 * THE CONTRACT, AND IT IS THE STRICTEST ONE IN THIS MODULE.
 *
 * EVERY PAGE MUST BE ACCOUNTED FOR. A page that segmented contributes one
 * candidate per region; a page that did not contributes one candidate, which
 * is the whole page. EVERY candidate must then complete under the ordinary
 * brochure gate — the same gate, the same order, the same inputs — and if any
 * one of them refuses, the WHOLE segmented reading is abandoned and the
 * document is read exactly as it is read today.
 *
 * That is deliberately harsher than it needs to be, and it is harsh in the
 * only direction that is safe. The alternative — keep the regions that read
 * and drop the page that did not — is `complete`-ing around content nobody
 * read, which is the rule this module's own header opens with: "NEVER
 * COMPLETE AROUND A FACT WE DID NOT READ." A page of terms and conditions
 * beside two property cards therefore costs the segmented reading, and the
 * document falls back. That limit is real, it is named in the log
 * (`regionsAbandoned`), and it is the conservative side of it.
 *
 * SHARED EVIDENCE IS INHERITED, NEVER SPLIT. A region's synthetic document is
 * the page's shared runs followed by the region's own — so the estate name,
 * the builder's name, the stage and the footer disclaimer are read into every
 * candidate, and every candidate has to account for them. Nothing that was
 * drawn in one region's band can reach another's: `segmentPropertyRegions`
 * puts a band in exactly one place, and a band that qualified as nobody's
 * property is SHARED rather than given to a neighbour.
 *
 * THE FILENAME IS NOT PASSED. `corroborateDesignFromFilename` and the
 * lot-agreement check both read the document's own name, and a document
 * naming several properties has a name that describes the DOCUMENT. Letting
 * it corroborate one region would make it contradict all the others — and
 * `filename_lot_disagrees_with_document` would refuse the lot the file is
 * actually named for.
 */
function readSegmentedDocument(
  pageTexts: readonly string[],
  positionedPages: readonly PdfTextLayoutPage[],
  options: {
    recognisedPages?: readonly number[] | null;
    organisationName?: string | null;
  },
): { reading: PdfDeterministicReading | null; found: number; abandoned: string } {
  const none = { reading: null, found: 0, abandoned: '' };

  const byPage = new Map<number, PdfTextItem[]>();
  for (const page of positionedPages) {
    if (page && Number.isFinite(page.page) && Array.isArray(page.items)) {
      byPage.set(Number(page.page), page.items);
    }
  }
  /*
   * A RECOGNISED PAGE HAS NO TRUSTWORTHY LAYOUT — the same seam
   * `readPdfBrochure` answers to. Its positioned runs describe only whatever
   * native fragment happened to share the sheet, so the gutters they suggest
   * are gutters in a fragment. Such a page is never segmented; it is read
   * whole, from the text that was recognised off its pixels.
   */
  const recognised = new Set(
    (options.recognisedPages ?? []).map((page) => Number(page)).filter(Number.isFinite));

  const segmentation = new Map<number, PageSegmentation>();
  for (let index = 0; index < pageTexts.length; index++) {
    const page = index + 1;
    if (recognised.has(page)) continue;
    const items = byPage.get(page);
    if (!items || !items.length) continue;
    const found = segmentPropertyRegions(items);
    if (found) segmentation.set(page, found);
  }
  if (!segmentation.size) return none;

  const found = [...segmentation.values()]
    .reduce((total, entry) => total + entry.regions.length, 0);
  const give = (abandoned: string) => ({ reading: null, found, abandoned });

  const rows: Array<Record<string, unknown>> = [];
  const regions: PdfReadingRegion[] = [];
  const fieldsRead = new Set<string>();
  const readBy = new Set<string>();

  const readPart = (
    items: readonly PdfTextItem[] | null,
    flattened: string,
  ): PdfDeterministicReading => readPdfBrochure([flattened], {
    positionedPages: items && items.length ? [{ page: 1, items: items.slice() }] : null,
    organisationName: options.organisationName ?? null,
    filename: null,
  });

  for (let index = 0; index < pageTexts.length; index++) {
    const page = index + 1;
    const segmented = segmentation.get(page);

    if (!segmented) {
      /*
       * A PAGE THAT DID NOT SEGMENT IS ONE CANDIDATE, and it is held to the
       * same bar as every region. Read from its own positions where it has
       * trustworthy ones and from its flattened text where it does not,
       * which is exactly the seam the whole-document reader applies.
       */
      const items = recognised.has(page) ? null : (byPage.get(page) ?? null);
      const reading = readPart(items, items ? flattenLayout(items) : (pageTexts[index] ?? ''));
      if (reading.status !== 'complete' || reading.rows.length !== 1) {
        return give(`page_${page}_not_a_property:${reading.reason}`);
      }
      rows.push(reading.rows[0]);
      for (const field of reading.diagnostics.fieldsRead) fieldsRead.add(field);
      for (const entry of reading.diagnostics.readBy ?? []) readBy.add(entry);
      continue;
    }

    for (const region of segmented.regions) {
      const items = segmented.shared.concat(region.items);
      const flattened = flattenLayout(items);
      const reading = readPart(items, flattened);
      if (reading.status !== 'complete' || reading.rows.length !== 1) {
        return give(`region_${page}_${region.index}:${reading.reason}`);
      }
      const anchor = pdfRegionAnchor(page, region.index);
      /*
       * THE REGION'S OWN ANCHOR, SET HERE AND NOWHERE ELSE.
       *
       * `importStock` applies a page anchor only where the record arrived
       * without one (`if (!record.source_anchor && anchors[index])`), so a
       * region anchor written here survives — and it has to, because the
       * page anchor it would otherwise be given names a page three
       * properties share.
       */
      rows.push({ ...reading.rows[0], [SOURCE_ANCHOR_HEADER]: anchor });
      regions.push({ page, index: region.index, box: region.box, anchor, text: flattened });
      for (const field of reading.diagnostics.fieldsRead) fieldsRead.add(field);
      for (const entry of reading.diagnostics.readBy ?? []) readBy.add(entry);
    }
  }

  if (rows.length < 2) return give('fewer_than_two_properties');

  /*
   * AND THEY MUST BE DIFFERENT PROPERTIES. `segmentPropertyRegions` already
   * refuses two bands that name the same one, on the evidence it can see
   * before anything is read; this asks the same question of the rows that
   * were actually produced, which is the answer that counts. Two identical
   * records are one property drawn twice, and importing them forks it.
   */
  const identities = rows.map((row) => JSON.stringify(
    Object.entries(row)
      .filter(([header]) => header !== SOURCE_ANCHOR_HEADER)
      .map(([header, value]) => [header, String(value ?? '')])
      .sort((a, b) => a[0].localeCompare(b[0]))));
  if (new Set(identities).size !== identities.length) {
    return give('two_regions_read_the_same_property');
  }

  return {
    reading: {
      status: 'complete',
      rows,
      provisional: [],
      unaccounted: [],
      ignored: [],
      placement: [],
      strategy: 'pdf_deterministic_regions',
      reason: 'regions_read',
      regions,
      diagnostics: {
        mode: 'brochure',
        pages: pageTexts.length,
        fieldsRead: [...fieldsRead].sort(),
        candidates: rows.length,
        regionsFound: found,
        readBy: [...readBy].sort(),
      },
    },
    found,
    abandoned: '',
  };
}

/**
 * A region's runs as the lines they were drawn as.
 *
 * The same `layoutLines` every reading here goes through, so a region's text
 * and a page's text are produced by one implementation — two would drift, and
 * this one is what the imagery path asks its questions of.
 */
function flattenLayout(items: readonly PdfTextItem[]): string {
  return layoutLines(items)
    .map((line) => line.cells.map((cell) => cell.text).join(' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * ===========================================================================
 * WHEN BOTH READERS REFUSE, THE ONE THAT READ SOMETHING IS THE ANSWER.
 * ===========================================================================
 *
 * THE DEFECT THIS CLOSES, MEASURED 21 SEPTEMBER 2026 ON
 * `Lot 37 - Miami 190 - Property Package.pdf` (1,951,962 bytes, 7 pages,
 * 3,962 characters of text extracted cleanly):
 *
 *     deterministic_status     "ambiguous"
 *     deterministic_reason     "two_cells_in_one_column"
 *     deterministic_fields     []
 *     deterministic_candidates 0
 *     → assisted reader → refused, HTTP 402: an account with no credit
 *     → import FAILED, zero properties
 *
 * The line above this one used to read `if (schedule.reason !==
 * 'no_schedule_found') return schedule;` — so the brochure reading was
 * computed and then THROWN AWAY, with everything in it: its `provisional`
 * rows, the fields it read, the lines it could not place and where they were
 * drawn. What survived was a TABLE's refusal about a document that holds no
 * table, and `runImport`'s deterministic fallback — the one that exists so a
 * model outage cannot fail a readable import — was handed an empty
 * `provisional` and had nothing to stand on.
 *
 * `mayHoldSchedule` has been hardened against this twice (see its own header:
 * the Lot 315 disclaimer, then the heading-density floor). Both were right
 * and neither is sufficient, because they narrow WHICH documents reach the
 * table parser rather than fixing what happens when it refuses one. A screen
 * can always be wrong about the next template; a reader that discards
 * evidence is wrong by construction.
 *
 * THE RULE. A refusal is a statement about what could not be established.
 * Between two of them, the one that established MORE is the more truthful
 * account of the document, and it is the only one that can carry a
 * provisional record. So the readings are ranked by what they actually
 * gathered — provisional records first, then named fields, then candidates —
 * and the winner is returned WHOLE.
 *
 * WHOLE, NEVER MERGED. Two readers' rows are two readings of one page, and
 * splicing them would invent a record neither reader would stand behind —
 * the rule `readPdfBrochure` already answers to. Nothing here combines
 * values; it chooses an account.
 *
 * AND THE OTHER ACCOUNT IS NOT LOST. The reading that did not win leaves its
 * mode and its reason in `diagnostics.alsoTried`, so a document that really
 * did hold a broken table still says so in the import log. Safe to log by the
 * same contract as everything else there: a stable machine word and a count,
 * never a fragment of the document.
 *
 * WHERE THEY ARE EQUAL — both empty — the schedule's refusal stands exactly
 * as it did, because a document the screen says holds a table and which the
 * table parser then refused is best described by the table parser.
 */
export function moreEvidencedRefusal(
  schedule: PdfDeterministicReading,
  brochure: PdfDeterministicReading,
): PdfDeterministicReading {
  const evidence = (reading: PdfDeterministicReading): [number, number, number] => [
    reading.provisional.length,
    reading.diagnostics.fieldsRead.length,
    reading.diagnostics.candidates,
  ];
  const [sP, sF, sC] = evidence(schedule);
  const [bP, bF, bC] = evidence(brochure);

  const brochureRead = bP > sP
    || (bP === sP && bF > sF)
    || (bP === sP && bF === sF && bC > sC);

  const chosen = brochureRead ? brochure : schedule;
  const other = brochureRead ? schedule : brochure;
  return {
    ...chosen,
    diagnostics: {
      ...chosen.diagnostics,
      alsoTried: { mode: other.diagnostics.mode, reason: other.reason },
    },
  };
}
