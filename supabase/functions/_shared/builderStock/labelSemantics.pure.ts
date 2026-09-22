/**
 * ===========================================================================
 * A QUANTIFIER TURNS A THING INTO A MEASURE OF IT.
 * ===========================================================================
 *
 * `TOTAL HOME` over `190 m²` is the building's floor area, and no alias table
 * has that heading — nor the dozen others of the same shape a builder might
 * write. Adding `total home` as a synonym would be a rule about ONE document:
 * the next brochure writes `OVERALL HOME`, the one after `TOTAL BUILD AREA`,
 * and each costs another line in a list. What they share is not their words,
 * it is their GRAMMAR.
 *
 *     <quantifier> <thing that has extent> [<word restating extent>]
 *
 * So this resolves the class, once, and `fieldForHeader` asks it last — after
 * every explicit alias, so nothing this table knows can be overruled by a rule
 * about shapes.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT "STRIP THE QUANTIFIER AND LOOK AGAIN".
 * ---------------------------------------------------------------------------
 *
 * That was the first version and it is dangerous, measured against the alias
 * table this repository already has:
 *
 *     TOTAL HOUSE      → `house`    → house_design   ← the DESIGN, not an area
 *     TOTAL BUILDING   → `building` → project_name   ← the PROJECT, not an area
 *     TOTAL HOME       → `home`     → nothing at all
 *
 * Two wrong fields and one miss. A bare noun and a quantified one do not mean
 * the same thing: `House` answers *which of our designs is this*, and
 * `Total House` answers *how much of it is there*. The quantifier is what
 * turns the noun into a measurement, so the measurement is what this returns —
 * never the noun's own meaning.
 *
 * ---------------------------------------------------------------------------
 * AND IT DECIDES A LABEL, NEVER A VALUE.
 * ---------------------------------------------------------------------------
 *
 * `TOTAL PACKAGE · LAND + BUILD · INC. GST` over `$547,407` must establish no
 * area, and this module is only half of why. `package` is not a thing with
 * extent, so `TOTAL PACKAGE` resolves to nothing here — but `LAND` resolves to
 * `land_size_sqm` through the ordinary alias table, as it always has, and what
 * refuses the money is `acceptFieldValue`: MONEY IS NEVER AN AREA.
 *
 * That division is deliberate and is the architecture. This says what a phrase
 * NAMES. `fieldTypes.pure.ts` says what a value may BE. A label rule that also
 * judged values would be a second safety standard, and two standards is how
 * one of them comes to be wrong.
 */
/**
 * The fields a quantified phrase can name.
 *
 * Declared here rather than imported from `normalise.pure.ts`, which imports
 * THIS module — a type-only import would erase at runtime, but a cycle between
 * the alias table and the rule that extends it is worth not having at all. The
 * union is narrow because the class is: a quantifier asks how much of a thing
 * there is, and the two things this product measures are the dwelling and the
 * land.
 */
export type MeasuredField = 'building_size_sqm' | 'land_size_sqm';

/**
 * Words that QUANTIFY rather than name.
 *
 * Closed, and short on purpose. Each one asks "how much", which is the whole
 * basis for reading the noun after it as a measurement. `net` and `nett` are
 * deliberately absent: they quantify too, but a net area is a different
 * measurement from a gross one and this product has one building-size field —
 * so a brochure stating both would be two answers to one question, which the
 * conflict rule handles honestly and this must not pre-empt.
 */
const QUANTIFIER: ReadonlySet<string> = new Set([
  'total', 'overall', 'combined', 'aggregate', 'entire', 'whole', 'gross',
]);

/**
 * Things that HAVE an extent, and which extent a quantifier asks for.
 *
 * Every entry is a noun whose measurement this product stores. The omissions
 * are the considered part:
 *
 * `living` is left out because `normalise.pure.ts` states, from production,
 * that it "appears on 39 live rows and means the living-area size on some
 * sheets and a room count on others". That table declined to guess and this
 * one does not overturn another module's measured decision.
 *
 * `lot` is left out because it is this product's IDENTIFIER. `Lot Size` and
 * `Lot Area` are already aliases and resolve before this runs; what a bare
 * `TOTAL LOT` means is genuinely unclear, and an unclear area is a wrong
 * figure on a builder's card.
 *
 * `garage`, `porch`, `alfresco` and the rest of a floor plan's area schedule
 * are left out because a component's total is not the dwelling's — the reader
 * already has a rule saying a section's total belongs to its section.
 */
const MEASURED_CONCEPT: Readonly<Record<string, MeasuredField>> = Object.freeze({
  home: 'building_size_sqm',
  house: 'building_size_sqm',
  dwelling: 'building_size_sqm',
  residence: 'building_size_sqm',
  building: 'building_size_sqm',
  build: 'building_size_sqm',
  floor: 'building_size_sqm',
  internal: 'building_size_sqm',
  land: 'land_size_sqm',
  site: 'land_size_sqm',
  block: 'land_size_sqm',
  allotment: 'land_size_sqm',
});

/**
 * Words that only RESTATE that an extent is meant.
 *
 * `TOTAL HOME`, `TOTAL HOME AREA` and `TOTAL HOME M2` are one heading written
 * three ways. The unit spellings are here because `normaliseHeader` keeps a
 * unit's letters while dropping its punctuation, so `m²` reads as `m`.
 */
const EXTENT_WORD: ReadonlySet<string> = new Set([
  'area', 'size', 'm', 'm2', 'sqm', 'sq', 'squares', 'square', 'metres',
  'meters', 'metre', 'meter',
]);

/**
 * Tokens, from the RAW label rather than from a normalised key.
 *
 * `normaliseHeader` deletes every non-alphanumeric character INCLUDING the
 * spaces, so `Total Home` is the single key `totalhome` and has no word
 * boundaries left to read. A grammatical rule needs the words, so it tokenises
 * the raw text itself — and reproduces that function's one exception, the
 * money and percentage markers that survive as words, so `TOTAL HOME $` reads
 * as three tokens and fails this rule rather than passing it.
 */
function labelTokens(raw: unknown): string[] {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\$/g, ' dollars ')
    .replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The field a QUANTIFIED phrase names, or null.
 *
 * Exactly one concept word may remain once the quantifier and any trailing
 * extent words are removed. `TOTAL AREA` names no thing and answers null —
 * the total area OF WHAT is precisely the question — and `TOTAL LAND AND
 * BUILD` answers null too, because two concepts is a heading over a sum this
 * product has no field for.
 */
export function quantifiedFieldForLabel(raw: unknown): MeasuredField | null {
  const tokens = labelTokens(raw);
  if (tokens.length < 2) return null;
  if (!QUANTIFIER.has(tokens[0])) return null;

  const rest = tokens.slice(1);
  let end = rest.length;
  while (end > 0 && EXTENT_WORD.has(rest[end - 1])) end -= 1;
  const core = rest.slice(0, end);
  if (core.length !== 1) return null;

  return MEASURED_CONCEPT[core[0]] ?? null;
}
