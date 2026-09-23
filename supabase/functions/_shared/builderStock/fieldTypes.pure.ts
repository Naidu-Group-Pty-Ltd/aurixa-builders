/**
 * ===========================================================================
 * WHAT A VALUE MAY BECOME — ONE ANSWER, ASKED BY EVERY READER.
 * ===========================================================================
 *
 * A reader's job is to find evidence: this label, that value, drawn there.
 * Whether the evidence may be written into a field is a different question,
 * and it was being answered in as many places as there are readers — a count
 * guard here, an area guard there, a price coercion in `normalise.pure.ts`,
 * and a `statesACount` check that only one of three call sites made. Scattered
 * standards are how `Garage: 22.59m²` became twenty-two car spaces and how a
 * room dimension became nine bathrooms.
 *
 * THE DANGEROUS CASE THIS EXISTS FOR, measured on the live document:
 *
 *     T O T A L  P A C K A G E  ·  L A N D  +  B U I L D  ·  I N C .  G S T
 *     Build $547,407                                          $1,327,407
 *
 * Normalisation makes `LAND` and `BUILD` legible as phrases, which is correct
 * — they ARE those words. A vocabulary lookup then offers them as labels for
 * `land_size_sqm` and `building_size_sqm`, and the nearest values are money.
 * Nothing in the reader knows that is absurd. This does:
 *
 *     MONEY IS NEVER AN AREA.
 *     AN AREA IS NEVER AN IDENTIFIER.
 *     A MEASUREMENT IS NEVER A ROOM COUNT.
 *     A COUNT IS A SMALL WHOLE NUMBER OF ROOMS AND NOTHING ELSE.
 *
 * EVERY ANSWER IS TYPED AND EVERY REFUSAL IS NAMED. `accept` returns the
 * reason it declined, from a fixed vocabulary, so a document's own record can
 * say "that was money, and money is not an area" instead of leaving a field
 * empty with no account of why.
 */

/** The kinds of thing this product stores. One entry per stored field. */
export type FieldKind =
  | 'identifier'      // external_reference
  | 'designation'     // lot_number, unit_number
  | 'address'         // address_line
  | 'locality'        // suburb
  | 'state'
  | 'postcode'
  | 'place_name'      // development_name, project_name
  | 'design_name'     // house_design
  | 'count'           // bedrooms, bathrooms, car_spaces
  | 'area'            // land_size_sqm, building_size_sqm
  | 'currency'        // price
  | 'date_text';      // expected_completion

/** Which kind each stored field is. The one mapping; nothing restates it. */
export const FIELD_KIND: Readonly<Record<string, FieldKind>> = Object.freeze({
  external_reference: 'identifier',
  lot_number: 'designation',
  unit_number: 'designation',
  address_line: 'address',
  suburb: 'locality',
  state: 'state',
  postcode: 'postcode',
  development_name: 'place_name',
  project_name: 'place_name',
  house_design: 'design_name',
  bedrooms: 'count',
  bathrooms: 'count',
  car_spaces: 'count',
  land_size_sqm: 'area',
  building_size_sqm: 'area',
  price: 'currency',
  expected_completion: 'date_text',
});

export type DeclineReason =
  | 'empty'
  | 'money_is_not_an_area'
  | 'money_is_not_a_count'
  | 'money_is_not_a_designation'
  | 'an_area_is_not_a_count'
  | 'an_area_is_not_a_designation'
  | 'a_measurement_is_not_a_count'
  | 'not_a_count'
  | 'count_out_of_range'
  | 'not_a_number'
  | 'area_out_of_range'
  | 'no_currency_marker'
  | 'not_a_state'
  | 'not_a_postcode'
  | 'no_alphanumeric_content'
  | 'not_a_designation'
  | 'a_section_heading_is_not_a_name';

/**
 * WHAT THE DOCUMENT'S STRUCTURE PROVES ABOUT WHERE THIS VALUE CAME FROM.
 *
 * `label` — a label drawn near a value. Weak: `Total` sits over a floor area
 * on one brochure and over a package price on the next, and the reader cannot
 * tell which from the pairing alone.
 *
 * `column` — a cell under a reconstructed table heading, where the grid itself
 * was proved: every data cell falls inside exactly one of the header's columns
 * and no two share one. A `PRICE` column says its cells are prices.
 *
 * It changes exactly one answer — whether a price must carry a currency marker
 * — and nothing else. The rules that say money is not an area and a room
 * dimension is not a bedroom count are facts about the VALUE, so no amount of
 * structure makes them false.
 */
export type StructuralProof = 'label' | 'column';

export type FieldVerdict =
  | { accepted: true; value: string }
  | { accepted: false; reason: DeclineReason };

const AU_STATE = /^(?:VIC|NSW|QLD|SA|WA|TAS|NT|ACT)$/i;
/** A currency marker anywhere in the value. `$`, or a stated currency code. */
const CURRENCY = /[$£€¥]|\b(?:AUD|USD|NZD)\b/i;
/** An area unit at the end of the value, which is where a document puts it. */
const AREA_UNIT = /(?:m²|m2|sqm|sq\s?m|square\s+met(?:re|er)s?)\s*$/i;
/** A room dimension: two measurements multiplied. Never a count, never an area. */
const ROOM_DIMENSION = /^\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*$/i;
const HAS_DIGIT = /\d/;

/**
 * A COUNT IS A SMALL WHOLE NUMBER OF ROOMS.
 *
 * Optionally a half — a powder room is counted as half a bathroom by every
 * Australian builder — and nothing else attached. `22.59` is not a count and
 * neither is `115.30m²`.
 */
const COUNT_VALUE = /^\d{1,2}(?:\.5)?$/;
const MAX_PLAUSIBLE_COUNT = 20;

/**
 * The bounds an area must fall inside to be an area at all.
 *
 * Not a judgement about property, a judgement about UNITS: below one square
 * metre the figure is not an area of anything, and above a hundred thousand it
 * is a number that arrived from somewhere else — a price with its separators
 * stripped is the usual somewhere.
 */
const MIN_AREA = 1;
const MAX_AREA = 100_000;

const numeric = (value: string): number | null => {
  const cleaned = value.replace(/[^\d.]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/**
 * May this value be written into this field?
 *
 * The one gate. A reader has already decided the value BELONGS to the field —
 * that is discovery, and it is the reader's business. This decides whether
 * what was found is the KIND of thing the field holds, which is not.
 */
export function acceptFieldValue(
  field: string,
  raw: unknown,
  proof: StructuralProof = 'label',
): FieldVerdict {
  const value = String(raw ?? '').trim();
  if (!value) return { accepted: false, reason: 'empty' };

  const kind = FIELD_KIND[field];
  // A field this map does not name is not this gate's to judge. Readers may
  // hold values it has no opinion about (a description, a status word), and
  // inventing an opinion here would decline them all.
  if (!kind) return { accepted: true, value };

  if (!/[\p{L}\p{N}]/u.test(value)) {
    return { accepted: false, reason: 'no_alphanumeric_content' };
  }

  const money = CURRENCY.test(value);
  const area = AREA_UNIT.test(value);
  const dimension = ROOM_DIMENSION.test(value);

  switch (kind) {
    case 'count': {
      if (money) return { accepted: false, reason: 'money_is_not_a_count' };
      if (area) return { accepted: false, reason: 'an_area_is_not_a_count' };
      if (dimension) return { accepted: false, reason: 'a_measurement_is_not_a_count' };
      if (!COUNT_VALUE.test(value)) return { accepted: false, reason: 'not_a_count' };
      const n = Number(value);
      if (!(n >= 0 && n <= MAX_PLAUSIBLE_COUNT)) {
        return { accepted: false, reason: 'count_out_of_range' };
      }
      return { accepted: true, value };
    }
    case 'area': {
      /*
       * THE ONE THAT MATTERS. `LAND + BUILD` is a phrase this vocabulary reads
       * as two area labels, and on a package brochure the figure beside it is
       * the package price. A currency marker is a statement about what the
       * number IS, and it outranks whatever label happens to sit near it.
       */
      if (money) return { accepted: false, reason: 'money_is_not_an_area' };
      if (dimension) return { accepted: false, reason: 'a_measurement_is_not_a_count' };
      const n = numeric(value);
      if (n === null) return { accepted: false, reason: 'not_a_number' };
      if (!(n >= MIN_AREA && n <= MAX_AREA)) {
        return { accepted: false, reason: 'area_out_of_range' };
      }
      return { accepted: true, value };
    }
    case 'currency': {
      /*
       * A PRICE SAYS IT IS MONEY, OR IT IS NOT TAKEN. `Total 659,900` with no
       * symbol is left absent, which is the conservative side and the one this
       * product takes everywhere: a figure that might be an area, a reference
       * or a year must not become a price because it was large.
       */
      if (area) return { accepted: false, reason: 'money_is_not_an_area' };
      if (!money && proof !== 'column') {
        return { accepted: false, reason: 'no_currency_marker' };
      }
      if (numeric(value) === null) return { accepted: false, reason: 'not_a_number' };
      return { accepted: true, value };
    }
    case 'designation': {
      if (money) return { accepted: false, reason: 'money_is_not_a_designation' };
      if (area) return { accepted: false, reason: 'an_area_is_not_a_designation' };
      if (dimension) return { accepted: false, reason: 'a_measurement_is_not_a_count' };
      /*
       * A lot or unit is a short token: digits, optionally a letter, and the
       * occasional hyphenated or slashed pair. It is never a sentence and
       * never a size. The shape is `LOT_DESIGNATION`'s, which
       * `readVerticalPair` has demanded since `LOT` over `350 m²` wrote a land
       * size into the field that says WHICH property this is — moved here
       * rather than restated, because it was being asked in one reader and
       * then in one more, and a rule asked twice is a rule the third reader
       * forgets.
       */
      if (!/^[0-9]{1,6}[A-Za-z]?(?:[/-][0-9A-Za-z]{1,6})?$/.test(value)) {
        return { accepted: false, reason: 'not_a_designation' };
      }
      return { accepted: true, value };
    }
    case 'state':
      return AU_STATE.test(value)
        ? { accepted: true, value: value.toUpperCase() }
        : { accepted: false, reason: 'not_a_state' };
    case 'postcode':
      return /^\d{4}$/.test(value)
        ? { accepted: true, value }
        : { accepted: false, reason: 'not_a_postcode' };
    case 'locality':
    case 'place_name':
    case 'design_name':
    case 'address':
    case 'identifier':
    case 'date_text':
    default:
      /*
       * A NAME IS WORDS, and the only thing this gate asserts about one is
       * that it carries some. Narrowing further would decline `Nex 20`,
       * `Miami 190` and `Lot 37 Fairweather Drive`, all of which are real.
       */
      if (kind !== 'identifier' && kind !== 'date_text' && !/\p{L}/u.test(value)) {
        return { accepted: false, reason: 'no_alphanumeric_content' };
      }
      /*
       * AND A DESIGN OR AN ESTATE IS NEVER THE NAME OF A SECTION OF THE
       * DOCUMENT. MEASURED 23 SEPTEMBER 2026 on the production brochure for
       * `LOT 4327`: its area schedule is headed `House` over `Specifications`,
       * two lines, and `House` is this vocabulary's word for the design — so
       * the pair reader read `house_design: "Specifications"`, the card was
       * titled `Lot 4327, · Specifications`, and the design the page prints
       * in its largest type could no longer be corroborated because the field
       * was already held.
       *
       * The words are the document's own furniture — what a brochure calls
       * its specification, inclusion and feature pages — and a name made of
       * nothing else names no design and no place. A name CONTAINING one is
       * untouched: `Specifications Estate` is not a thing anybody builds, but
       * `The Grove` and `Enzo 10.5` must never be refused for the company
       * they keep, so every word of the value has to be furniture.
       */
      if ((kind === 'design_name' || kind === 'place_name') && namesOnlyASection(value)) {
        return { accepted: false, reason: 'a_section_heading_is_not_a_name' };
      }
      if (kind === 'area' as FieldKind && !HAS_DIGIT.test(value)) {
        return { accepted: false, reason: 'not_a_number' };
      }
      return { accepted: true, value };
  }
}

/**
 * The words a brochure calls its own SECTIONS by, and the words that qualify
 * them. A value made of these and nothing else is a heading. See the
 * `design_name` / `place_name` branch of `acceptFieldValue`.
 */
const SECTION_NOUNS = new Set([
  'specification', 'specifications', 'inclusion', 'inclusions', 'feature', 'features',
  'detail', 'details', 'overview', 'summary', 'schedule', 'selection', 'selections',
  'finish', 'finishes', 'option', 'options', 'particulars', 'information',
  'floorplan', 'floorplans', 'plan', 'plans', 'elevation', 'elevations', 'gallery',
]);
const SECTION_QUALIFIERS = new Set([
  'single', 'double', 'storey', 'story', 'standard', 'quality', 'turnkey',
  'house', 'home', 'property', 'package', 'key', 'general', 'additional',
  'floor', 'the', 'our', 'your', 'and',
]);

function namesOnlyASection(value: string): boolean {
  // A figure is what a design is numbered by (`Plan 21`, `Nex 20`); a heading
  // carries none, so a value with a digit in it is never refused here.
  if (HAS_DIGIT.test(value)) return false;
  const words = value.toLowerCase().replace(/&/g, ' and ').split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return false;
  if (!words.some((word) => SECTION_NOUNS.has(word))) return false;
  return words.every((word) => SECTION_NOUNS.has(word) || SECTION_QUALIFIERS.has(word));
}

/**
 * IS THIS THE SHAPE OF A ROOM COUNT?
 *
 * Exported because DISCOVERY asks it too, and must ask the same question the
 * gate does. The icon-row reader looks along a row for the units that could be
 * counts — that is finding evidence, not setting a standard — and it had its
 * own copy of the rule. Two copies of "what a count looks like" is how one of
 * them comes to admit `22.59`.
 */
export function readsAsACount(value: unknown): boolean {
  return acceptFieldValue('bedrooms', value).accepted;
}

/** Convenience for the common shape: the value, or null with the reason lost. */
export function acceptedOrNull(
  field: string,
  raw: unknown,
  proof: StructuralProof = 'label',
): string | null {
  const verdict = acceptFieldValue(field, raw, proof);
  return verdict.accepted ? verdict.value : null;
}
