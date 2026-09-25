/**
 * Builder stock lists — the normalisation layer.
 *
 * Every builder sends a different spreadsheet. This module maps whatever a
 * file happened to call a column onto the fixed set of fields
 * `builder_stock_items` holds, and refuses to do anything else.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a value that is not in the file does
 * not appear in the output. There is no inference, no default price, no
 * assumed state, no "probably a house". A missing optional field is `null`,
 * and a row that carries nothing identifying is dropped rather than imported
 * as an empty property.
 *
 * Pure: no IO, no clock, and its one import is another pure module. It is
 * loaded by the edge function under Deno and by `src/lib/__tests__` under
 * vitest, which is why it has an explicit `.pure.ts` name and no `@/` alias
 * anywhere.
 */
import { SOURCE_ANCHOR_HEADER } from './sourceAssets.pure.ts';
import { parseBuilderAddressLine } from '../builderStockAddress.pure.ts';
import { composeAddressLine } from './canonicalIdentity.pure.ts';

export type StockPropertyType =
  | 'house' | 'townhouse' | 'apartment' | 'duplex' | 'land' | 'terrace'
  | 'house_and_land' | 'other';

export type StockAvailability =
  | 'available' | 'on_hold' | 'reserved' | 'contracted' | 'sold' | 'settled'
  | 'withdrawn' | 'unknown';

/** The canonical shape. Mirrors the columns of `builder_stock_items`. */
export interface NormalisedStockRecord {
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lot_number: string | null;
  unit_number: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  property_type: StockPropertyType | null;
  /**
   * The house design this lot is being sold with — "Elara 18", "Miami 190".
   *
   * A BUILDER SELLS FEWER DESIGNS THAN LOTS, and the document library is
   * organised the way the business is: one brochure per design, linked from
   * every row that sells it. The package matcher has always understood designs
   * — `pageStatesIdentity` requires the page to state the label's design before
   * it will call the page a property's cover — but it read them out of
   * BRACKETED text in the display label, which a spreadsheet row never carries.
   * So a design column arrived, went to `unmapped`, and the one document that
   * names the house was refused for not naming the lot.
   *
   * Canonical and structured, alongside `building_size_sqm`, because the
   * matcher takes discriminators as fields rather than re-parsing a label.
   */
  house_design: string | null;
  land_size_sqm: number | null;
  building_size_sqm: number | null;
  price: number | null;
  /** Verbatim, when the file said something a number cannot hold ("POA"). */
  price_display: string | null;
  availability_status: StockAvailability;
  expected_completion: string | null;
  description: string | null;
  /** Image URLs the file itself carried. Provenance stage 1. */
  image_urls: string[];
  /**
   * The HEADER each of those URLs sat under, verbatim.
   *
   * The column name is LEVEL 1 evidence about what the image is FOR — a row's
   * "Facade" column names the property's listing image and its "Floorplan"
   * column names something that must never reach a card — so throwing it away
   * at normalisation threw away the only thing that could tell them apart.
   * Keyed by URL rather than positional so the dedupe above cannot misalign it.
   */
  image_url_fields: Record<string, string>;
  /**
   * WHICH ROW OF THE SOURCE THIS IS — a Notion block id, a sheet and row, a
   * table row. Set only when the source stated it, and it is what ties the
   * builder's own render to this property rather than to the one beside it.
   */
  source_anchor: string | null;
  /** Every column we could not place, kept for the audit record. */
  unmapped: Record<string, string>;
}

/** Canonical field names a header can map onto. */
import { quantifiedFieldForLabel } from './labelSemantics.pure.ts';
import { areaInSquareMetres, type AreaField } from './areaUnits.pure.ts';

type FieldKey =
  | 'external_reference' | 'development_name' | 'project_name' | 'address_line'
  | 'suburb' | 'state' | 'postcode' | 'lot_number' | 'unit_number'
  | 'bedrooms' | 'bathrooms' | 'car_spaces' | 'property_type'
  | 'land_size_sqm' | 'building_size_sqm' | 'price' | 'availability_status'
  | 'expected_completion' | 'description' | 'image_url' | 'builder_name'
  | 'house_design'
  // One column stating all three counts — "BED // BATH // CAR": "3 / 2 / 2".
  // Not a record field: the switch parses it into the three that are.
  | 'bed_bath_car';

/**
 * Header text is compared with punctuation, spacing and case removed, so
 * "Land Size (m2)", "land_size_m2" and "LANDSIZEM2" are one key.
 *
 * A UNIT MARKER IS PART OF THE HEADING, and deleting it made two different
 * columns one key. `LAND M2` and `LAND $` sit side by side in a stock list —
 * one is an area and one is money — and stripping the `$` left `land` for
 * both. `land` is an alias for `land_size_sqm`, so every property imported
 * from such a sheet had its LAND PRICE written into its land size: 26 live
 * properties published a 428,000 m2 block, which is 105 acres, because the
 * land cost $428,000. The same collapse hid `HOUSE $` behind `HOUSE`, and
 * `PACKAGE $` — the number a buyer actually sees — behind `PACKAGE`, so not
 * one of those 26 carried a price at all.
 *
 * So the two markers that distinguish a MEASURE from MONEY survive as words.
 * `$` and `%` are the only characters this treats specially, and neither
 * appeared in any alias before this — so a heading that carries one could only
 * ever have been judged as though it did not, and every key that changes here
 * is a key that was wrong. A `X $` column this table does not name now lands
 * in `unmapped`, which is visible in the audit record, instead of silently
 * becoming `X`.
 */
export function normaliseHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\$/g, ' dollars ')
    .replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The alias table. Deliberately explicit rather than fuzzy: a header this
 * table does not know lands in `unmapped`, which is visible in the audit
 * record, and adding it here is a one-line change. Guessing would eventually
 * map "Deposit" onto `price`.
 */
const HEADER_ALIASES: Record<string, FieldKey> = {};

function alias(field: FieldKey, ...headers: string[]): void {
  for (const header of headers) HEADER_ALIASES[normaliseHeader(header)] = field;
}

alias('external_reference',
  'reference', 'ref', 'stock ref', 'stock reference', 'stock id', 'stock code',
  'property id', 'property ref', 'listing id', 'listing reference', 'id',
  'item code', 'sku', 'package id', 'package code', 'external id', 'external reference');

alias('development_name',
  'development', 'development name', 'estate', 'estate name', 'community',
  'community name', 'subdivision',
  // Notion's own label for the estate column on a database view.
  'estate tag');

alias('project_name',
  'project', 'project name', 'stage', 'stage name', 'release', 'release name',
  'building', 'building name');

alias('address_line',
  'address', 'street address', 'property address', 'full address', 'address line',
  'address line 1', 'street', 'site address',
  // A Notion database's TITLE column is what names the row, and on a stock
  // list that is the lot and its address ("Lot 60434 - Cloverton Estate,
  // Kalkallo VIC 3064"). Without this every row from a Notion collection
  // carries nothing identifying and `identifiesAProperty` drops all of them.
  'deal', 'listing', 'property');

alias('suburb',
  'suburb', 'city', 'town', 'locality', 'suburb town',
  // `location` is one of the commonest headings a builder gives the suburb
  // column, and its absence here is why 86 of 89 properties on one import
  // carried no locality at all — which starves the whole fallback ladder.
  'location', 'suburb location', 'area');
alias('state', 'state', 'st', 'state territory', 'region');
alias('postcode', 'postcode', 'post code', 'postal code', 'zip', 'zip code');

alias('lot_number', 'lot', 'lot no', 'lot number', 'lot #', 'lotno');
alias('unit_number',
  'unit', 'unit no', 'unit number', 'apartment', 'apartment number', 'apt',
  'townhouse number', 'house number', 'dwelling', 'dwelling number');

alias('bedrooms', 'bed', 'beds', 'bedroom', 'bedrooms', 'br', 'no of bedrooms');
alias('bathrooms', 'bath', 'baths', 'bathroom', 'bathrooms', 'ba', 'no of bathrooms');
alias('car_spaces',
  'car', 'cars', 'car space', 'car spaces', 'garage', 'garages', 'parking',
  'parking spaces', 'carports');
/*
 * ALL THREE COUNTS IN ONE CELL. The live master stocklist writes
 * `BED // BATH // CAR` with values like `3 / 2 / 2` — 81 of 81 rows on the
 * 6 September 2026 upload carried it, and every one landed in `unmapped`, so
 * not one card showed a bedroom. The slashes vanish in `normaliseHeader`, so
 * all these spellings are already one key.
 */
alias('bed_bath_car',
  'bed bath car', 'beds baths cars', 'bed bath cars', 'bed bath car spaces',
  // A Notion stock list heads the same column "Configuration", writing
  // "4 Bed 2 Bath 2 Car" — measured 6 September 2026, 17 of 18 rows.
  'configuration');

alias('property_type',
  'type', 'property type', 'dwelling type', 'product', 'product type',
  'house type', 'stock type');

/*
 * THE DESIGN, AND DELIBERATELY NOT THE FOUR HEADINGS ABOVE.
 *
 * `product`, `product type`, `house type` and `type` are already claimed by
 * `property_type` — they answer "house or townhouse", not "which design" — so
 * taking them here would silently change what an existing column means for
 * every builder who already uses one. `floor plan` is likewise not this: on a
 * stock list that column holds a LINK to a drawing, and `floor area` is
 * `building_size_sqm`.
 *
 * What is left is the headings that can only mean the design itself.
 */
alias('house_design',
  'design', 'house design', 'home design', 'design name', 'house design name',
  'home design name', 'facade design', 'design type',
  /*
   * A stock list names the design in a column called plainly `HOUSE`, beside
   * `HOUSE m2` and `HOUSE $`. That was unmappable while the normaliser deleted
   * the marker — `HOUSE $` produced the same key, and whichever column came
   * last would have written "$447,950" into the design. It is safe now because
   * the three are three keys. The design is what `findDesignCoverPages` reads
   * to attribute a render, so a null here is a whole rung of the evidence
   * ladder that can never run.
   */
  /*
   * `house` ALONE, and deliberately nothing near it. `Product`, `Type`,
   * `Product Type` and `House Type` belong to `property_type` and a test
   * asserts this table does not take them — a heading that answers "what kind
   * of dwelling is this" is not the heading that answers "which of our designs
   * is it".
   */
  'house');

// The unit is written six ways — "(m2)", "m²", "sqm", "sq m" — and the header
// normaliser strips the punctuation but not the letters, so each spelling is a
// distinct key and has to be listed.
alias('land_size_sqm',
  'land', 'land size', 'land area', 'land size sqm', 'land size m2',
  'land size m²', 'land m2', 'land m²', 'land sqm', 'land sq m',
  'land area sqm', 'land area m2', 'land area m²',
  // `block size` and `lot size` had the bare form and `m2` only — the same
  // half-a-list this file's build side was found with. The cross-product in
  // `builderStockSizeHeaders.test.ts` is what turned that up.
  'block size', 'block size m2', 'block size m²', 'block size sqm',
  'block m2', 'block m²', 'block sqm',
  'lot size', 'lot size m2', 'lot size m²', 'lot size sqm',
  /*
   * `Site Area` — THE SAME HALF-A-LIST, ONE LIST LOWER.
   *
   * `build area` was listed and `site area` was not, which is the exact
   * asymmetry the comment above describes and the comment below it repeats.
   * MEASURED 21 SEPTEMBER 2026 on the acceptance corpus's mixed
   * scan-and-text package: its siting page states `Site Area: 375 m2` beside
   * `Build Area: 201 m2`, and the property imported with the build size and
   * NO land size — the land line attributed to nothing.
   *
   * It is the standard heading on an Australian siting plan and it means the
   * allotment, never the dwelling: a document stating both states them
   * together, which is what makes the pair unambiguous.
   */
  'site area', 'site area m2', 'site area m²', 'site area sqm',
  'site size', 'site size m2', 'site size m²', 'site size sqm',
  /*
   * `Allotment 512m²`, `Lot Area 450m2` — THE SAME HALF-A-LIST, TWO MORE WORDS.
   * Each set the land aside with the reading still complete (24 September
   * 2026, by probing). `allotment` ALONE is deliberately absent: in South
   * Australia an allotment is the LOT (`Allotment 12`), so the bare word is a
   * designation there and a size nowhere. With its unit or `size`/`area` it
   * can only be the land.
   */
  'allotment size', 'allotment size m2', 'allotment size m²', 'allotment size sqm',
  'allotment area', 'allotment area m2', 'allotment area m²', 'allotment area sqm',
  'allotment m2', 'allotment m²', 'allotment sqm',
  'lot area', 'lot area m2', 'lot area m²', 'lot area sqm');

/*
 * THE HOUSE'S AREA IS WRITTEN AS MANY WAYS AS THE LAND'S, AND THIS LIST HAD
 * HALF OF THEM.
 *
 * MEASURED 11 SEPTEMBER 2026 over twenty header spellings a real builder's
 * spreadsheet uses: every one of eleven LAND spellings mapped, and TEN OF
 * TWENTY build spellings did not. The plainest one is the one that bit —
 * `Build (sqm)` normalises to `buildsqm`, and while `land sqm` was listed,
 * `build sqm` never was. So a sheet with `Land (sqm)` beside `Build (sqm)`
 * imported the land and silently dropped the house, into `unmapped` where
 * nothing reads it.
 *
 * In production that is 244 of 1,007 properties carrying a land size and no
 * building size — 24% — and `building_size_sqm` is the field the card prints
 * as "180 m² home", so those cards simply lost a line.
 *
 * THE UNIT IS THE TRAP. `normaliseHeader` strips punctuation but keeps
 * letters, so `m²` collapses to `m` while `m2` stays `m2` and `sq m` becomes
 * `sqm` — three distinct keys for one unit. Every base word therefore needs
 * every unit spelled out, which is why this list is long rather than clever.
 * `builderStockSizeHeaders.test.ts` generates the land × build cross-product
 * and fails on any asymmetry, so the two can never drift apart again.
 *
 * `living` on its own is deliberately NOT here. It appears on 39 live rows and
 * means the living-area size on some sheets and a room count on others; the
 * `HOUSE $` collapse in the header above is what this table costs when it
 * guesses.
 */
alias('building_size_sqm',
  // build …
  'build size', 'build size m2', 'build size m²', 'build size sqm',
  'build area', 'build area m2', 'build area m²', 'build area sqm',
  'build m2', 'build m²', 'build sqm', 'build sq m',
  // building …
  'building size', 'building size sqm', 'building size m2', 'building size m²',
  'building area', 'building area sqm', 'building area m2', 'building area m²',
  'building m2', 'building m²', 'building sqm',
  // house …
  'house size', 'house size m2', 'house size m²', 'house size sqm',
  'house area', 'house area m2', 'house area m²', 'house area sqm',
  // A stock list writes the house's own area as bare "HOUSE m2", beside
  // "LAND M2". Distinct keys from `house` and `house $` only since the
  // normaliser stopped deleting the marker — see `normaliseHeader`.
  'house m2', 'house m²', 'house sqm',
  // home …
  'home size', 'home size m2', 'home size m²', 'home size sqm',
  'home area', 'home area m2', 'home area m²', 'home area sqm',
  'home m2', 'home m²', 'home sqm',
  // floor / internal / living area …
  'floor area', 'floor area m2', 'floor area m²', 'floor area sqm',
  'internal area', 'internal area m2', 'internal area m²', 'internal area sqm',
  'living area', 'living area m2', 'living area m²', 'living area sqm',
  // `Dwelling Size 231m²`. `dwelling` alone is `unit_number`'s, and stays so.
  'dwelling size', 'dwelling size m2', 'dwelling size m²', 'dwelling size sqm',
  'dwelling area', 'dwelling area m2', 'dwelling area m²', 'dwelling area sqm',
  'dwelling m2', 'dwelling m²', 'dwelling sqm');

/**
 * THE PRICE IS WHAT THE PROPERTY COSTS, which for a house-and-land package is
 * the PACKAGE.
 *
 * A stock list states three figures — `LAND $`, `HOUSE $`, `PACKAGE $` — and
 * only the third is the number a buyer is quoted. The other two are its
 * breakdown, they have no field here, and they stay in `unmapped` rather than
 * being mapped to something adjacent: a card showing the house component as
 * the price understates a $871,450 package by $428,000.
 */
alias('price',
  'price', 'total price', 'list price', 'package price', 'asking price',
  'sale price', 'price from', 'full price', 'purchase price', 'amount',
  'price $', 'total $', 'package $', 'total package $', 'package price $',
  'house and land $', 'house land $', 'total price $', 'list price $',
  // `House & Land Package $899,500`: the package is the price when the value
  // carries the marker, or when the heading says `price` itself.
  'house and land package $', 'house land package $',
  'house and land package price', 'house land package price',
  'house and land price', 'house land price',
  /*
   * THE HEADINGS A PRICE IS QUALIFIED UNDER. `Total Package Price`, `Fixed
   * Price` and `Turnkey Package` each head the one figure a buyer is quoted,
   * and each set its line aside with the reading still complete. Found 24
   * September 2026 by probing. A heading that could as easily head a YES/NO or
   * a name in a spreadsheet column (`Turnkey Package`, `Fixed Price House &
   * Land`) is listed only with the `$` its value carries, so it is a price
   * where the figure says it is money and nothing otherwise.
   */
  'total package price', 'total package price $', 'package total', 'package total $',
  'fixed price', 'fixed price $', 'fixed price package', 'fixed price package $',
  'fixed package price', 'fixed price house and land $', 'fixed price house land $',
  'fixed price house and land package $', 'fixed price house land package $',
  'turnkey price', 'turnkey price $', 'turnkey package price', 'turnkey package $',
  'turnkey $', 'turnkey house and land $', 'turnkey house land $',
  'house and land package price $', 'house land package price $',
  'house and land total $', 'house land total $', 'total package cost',
  'package cost', 'total cost $', 'price guide', 'selling price',
  'h and l price', 'hl price', 'h and l package $', 'hl package $', 'h and l $', 'hl $');

alias('availability_status',
  'status', 'availability', 'available', 'sales status', 'stock status',
  'availability status', 'package status', 'lot status', 'property status');

alias('expected_completion',
  'completion', 'expected completion', 'completion date', 'est completion',
  'estimated completion', 'titles', 'titled', 'handover', 'handover date',
  'settlement', 'ready date');

alias('description',
  'description', 'notes', 'comments', 'details', 'features', 'inclusions',
  'remarks');

/**
 * Columns that carry an image FOR THE PROPERTY.
 *
 * Every one of these names the row's own picture, which is what makes a hit
 * LEVEL 1 primary evidence in `sourceImageRole.pure.ts`. A column naming
 * something else — "Floorplan", "Site Plan", "Masterplan" — is deliberately
 * absent: it would be mapped here, read as the property's image, and printed on
 * a client's card.
 */
alias('image_url',
  'image', 'images', 'image url', 'image urls', 'photo', 'photos', 'photo url',
  'render', 'renders', 'facade image', 'picture', 'facade', 'facade url',
  'hero image', 'primary image', 'property image', 'listing image',
  'render url', 'photo urls', 'image link');

alias('builder_name',
  'builder', 'builder name', 'developer', 'developer name', 'vendor', 'supplier');

/**
 * Every canonical field also answers to its own name. A model extracting from
 * prose returns these keys directly, and it would be absurd for the alias
 * table to recognise "Land Size (m2)" but not `land_size_sqm`.
 */
for (const field of [
  'external_reference', 'development_name', 'project_name', 'address_line',
  'suburb', 'state', 'postcode', 'lot_number', 'unit_number', 'bedrooms',
  'bathrooms', 'car_spaces', 'property_type', 'land_size_sqm',
  'building_size_sqm', 'price', 'availability_status', 'expected_completion',
  'description', 'image_url', 'builder_name',
] as FieldKey[]) {
  alias(field, field);
}

/** The field a header maps onto, or null when we do not recognise it. */
export function fieldForHeader(raw: unknown): string | null {
  const key = normaliseHeader(raw);
  const exact = HEADER_ALIASES[key];
  if (exact) return exact;
  /*
   * A STOCKLIST VERSIONS ITS OWN COLUMNS, AND THE VERSION IS NOT MEANING.
   *
   * The live master stocklist heads its price column `Package Price - V002` —
   * the suffix is the sheet's own revision, bumped when the builder reissues
   * it — and the exact lookup above therefore missed a heading whose alias
   * (`package price`) this table has known all along. 81 of 81 rows priced in
   * the sheet showed "Price not stated" on their cards, while three showed a
   * STALE price a V001 sheet had written before the suffix appeared.
   *
   * So a trailing version token is stripped and the lookup retried — and only
   * into a KNOWN alias, never into a guess: `Build Price - V002` strips to
   * `build price`, which this table deliberately does not know (a component
   * is not the package price), and stays unmapped exactly as before. A `V002`
   * in the middle of a heading (`... - V002 Contract Type`) is untouched.
   */
  const versioned = key.match(/^(.*?)v\d{1,4}$/);
  if (versioned) {
    const stripped = HEADER_ALIASES[versioned[1]];
    if (stripped) return stripped;
  }
  /*
   * AND LAST, THE SHAPE. `TOTAL HOME`, `OVERALL BUILDING AREA`,
   * `TOTAL BUILD AREA` — a quantifier turns a thing into a measure of it, and
   * no list of synonyms ever finishes. It is asked LAST, so nothing this table
   * explicitly knows can be overruled by a rule about grammar, and it answers
   * only for the two fields a quantifier can be asking about. See
   * `labelSemantics.pure.ts`, in particular why it is not "strip the
   * quantifier and look the noun up again" — that reads `TOTAL HOUSE` as the
   * DESIGN and `TOTAL BUILDING` as the PROJECT.
   */
  return quantifiedFieldForLabel(raw);
}

// ---------------------------------------------------------------------------
// Coercion. Each returns null rather than a guess.
// ---------------------------------------------------------------------------

function text(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  // Spreadsheets are full of these. They mean "not stated", not a value.
  if (/^(n\/?a|nil|none|tbc|tba|-{1,3}|\.|unknown|null)$/i.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

/** Whether `text` ended this cell before the cell did. */
function cellWasCut(value: unknown, read: string): boolean {
  return String(value).replace(/\s+/g, ' ').trim().length > read.length;
}

/**
 * A number, from whatever a spreadsheet cell contains. "$749,000" is 749000;
 * "3.5" is 3.5; "3+1" is 3 (the leading figure, which is what a "3+1 garage"
 * column means); "POA" is null.
 */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value, 60);
  if (raw === null) return null;
  const match = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A land or building size in square metres, from whatever the source printed.
 *
 * THE UNIT PRINTED BESIDE IT IS PART OF IT: `21.5 squares` is a 199.74 m²
 * house and `1.2 acres` a 4,856 m² block, never 21.5 m² and 1.2 m². The rule
 * and its measurements are `areaUnits.pure.ts`, which the brochure reader's
 * typed gate asks too. A size with no unit reads exactly as `coerceNumber`.
 */
export function coerceArea(value: unknown, field: AreaField): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value, 60);
  if (raw === null) return null;
  return areaInSquareMetres(raw, field);
}

/**
 * Price, plus what the file literally said.
 *
 * The display string is kept whenever the cell was not a bare number, because
 * "From $749,000" and "$749,000" are different claims and the second must not
 * be printed for the first.
 */
export function coercePrice(value: unknown): { price: number | null; display: string | null } {
  const raw = text(value, 120);
  if (raw === null) return { price: null, display: null };
  const numeric = typeof value === 'number' ? coerceNumber(value) : coerceMoney(raw);
  const bare = /^\$?\s*\d[\d,]*(\.\d+)?$/.test(raw);
  if (numeric === null) return { price: null, display: raw };
  /*
   * A FIGURE NO PROPERTY IS SOLD FOR IS NOT ITS PRICE, AND IT IS NOT PRINTED
   * EITHER — absent beats wrong, here as for the sizes. See `MIN_PLAUSIBLE_PRICE`.
   */
  if (numeric < MIN_PLAUSIBLE_PRICE || numeric > MAX_PLAUSIBLE_PRICE) {
    return { price: null, display: null };
  }
  return { price: numeric, display: bare ? null : raw };
}

/**
 * ===========================================================================
 * A SUM OF MONEY AS A PRICE LIST WRITES IT, INCLUDING ITS MULTIPLIER.
 * ===========================================================================
 *
 * `$829k` was stored as a price of EIGHT HUNDRED AND TWENTY-NINE DOLLARS, and
 * `$1.15M` as one dollar fifteen, on every source that reaches a card: the
 * digits were read and the letter after them dropped. Found 24 September 2026
 * by probing, not by a customer — no stored price carries either (the lowest
 * is $596,500) — so no card reads differently for this; it decides what the
 * next sheet or brochure that writes one gets.
 *
 * The multiplier is a definition, not a guess: `k` and `thousand` are a
 * thousand, `m`, `mil` and `million` a million, and only where the letter is
 * written straight after the FIRST figure in the value, so `4 bed from $799k`
 * is not four thousand of anything. And a space set as the thousands separator
 * (`$799 000`, which some templates set in place of a comma) groups the figure
 * rather than ending it.
 */
export function coerceMoney(raw: string): number | null {
  const source = String(raw ?? '');
  const scaled = source.replace(/,/g, '')
    .match(/^\D*?(\d+(?:\.\d+)?)\s*(k|thousand|m|mil|mill|million)(?![a-z])/i);
  if (scaled) {
    const factor = /^(?:k|thousand)$/i.test(scaled[2]) ? 1_000 : 1_000_000;
    const amount = Number(scaled[1]) * factor;
    return Number.isFinite(amount) ? Math.round(amount) : null;
  }
  const grouped = source.match(/^\D*?(\d{1,3}(?:[    ]\d{3})+)(?:\.\d{1,2})?(?![\d,])/);
  if (grouped) {
    const amount = Number(grouped[1].replace(/\D/g, ''));
    return Number.isFinite(amount) ? amount : null;
  }
  return coerceNumber(source);
}

/**
 * THE PRICE A PROPERTY CAN PLAUSIBLY BE SOLD FOR.
 *
 * The same kind of bound as `MAX_LAND_SQM`: not a judgement about the market,
 * a judgement about units. Ten thousand dollars is below any lot of land a
 * builder lists and far above a price written in thousands (`799` for
 * $799,000), which is the failure the floor exists to catch — a card saying
 * `$799` is published as a fact, and an absent price is not. A hundred million
 * is above any house and land package and below a price with a misplaced
 * multiplier. No stored price is outside either bound.
 */
const MIN_PLAUSIBLE_PRICE = 10_000;
const MAX_PLAUSIBLE_PRICE = 100_000_000;

const STATES: Record<string, string> = {
  nsw: 'NSW', newsouthwales: 'NSW',
  vic: 'VIC', victoria: 'VIC',
  qld: 'QLD', queensland: 'QLD',
  sa: 'SA', southaustralia: 'SA',
  wa: 'WA', westernaustralia: 'WA',
  tas: 'TAS', tasmania: 'TAS',
  nt: 'NT', northernterritory: 'NT',
  act: 'ACT', australiancapitalterritory: 'ACT',
};

export function coerceState(value: unknown): string | null {
  const raw = text(value, 60);
  if (raw === null) return null;
  return STATES[raw.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

export function coercePostcode(value: unknown): string | null {
  const raw = text(value, 20);
  if (raw === null) return null;
  const match = raw.match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

const PROPERTY_TYPES: Array<[RegExp, StockPropertyType]> = [
  [/house\s*(&|and|\+)\s*land|h\s*&\s*l|hl\s*package|package/i, 'house_and_land'],
  [/townhouse|town\s*home|villa/i, 'townhouse'],
  [/apartment|unit\b|flat|residence/i, 'apartment'],
  [/duplex|dual\s*occ/i, 'duplex'],
  [/terrace/i, 'terrace'],
  [/land\s*only|vacant\s*land|^land$|allotment/i, 'land'],
  [/house|home|detached/i, 'house'],
];

export function coercePropertyType(value: unknown): StockPropertyType | null {
  const raw = text(value, 80);
  if (raw === null) return null;
  for (const [pattern, mapped] of PROPERTY_TYPES) {
    if (pattern.test(raw)) return mapped;
  }
  return 'other';
}

const AVAILABILITY: Array<[RegExp, StockAvailability]> = [
  [/under\s*offer|on\s*hold|holding|held/i, 'on_hold'],
  [/reserved|deposit\s*(taken|paid)|eoi/i, 'reserved'],
  [/exchanged|contracted|under\s*contract|conditional/i, 'contracted'],
  [/settled|completed/i, 'settled'],
  [/sold|unavailable|not\s*available/i, 'sold'],
  [/withdrawn|removed|off\s*market|cancelled/i, 'withdrawn'],
  [/available|active|for\s*sale|released|open|current|in\s*stock|yes/i, 'available'],
];

/**
 * Availability. Defaults to `unknown` and NOT to `available` — a row whose
 * status column we could not read must not behave like live inventory.
 */
export function coerceAvailability(value: unknown): StockAvailability {
  const raw = text(value, 80);
  if (raw === null) return 'unknown';
  for (const [pattern, mapped] of AVAILABILITY) {
    if (pattern.test(raw)) return mapped;
  }
  return 'unknown';
}

/**
 * The longest link this product follows, from any column: an image column's
 * links have always been held to it, and a brochure's are now too.
 */
export const MAX_LINK_CHARS = 2000;

/** How much of an unrecognised column's prose the audit record keeps. */
export const UNMAPPED_PROSE_CHARS = 300;

function coerceUrls(value: unknown): string[] {
  const raw = text(value, 4000);
  if (raw === null) return [];
  const out: string[] = [];
  for (const candidate of raw.split(/[\s,;|]+/)) {
    if (/^https?:\/\/\S+$/i.test(candidate) && candidate.length <= MAX_LINK_CHARS) {
      out.push(candidate);
    }
  }
  return out.slice(0, 12);
}

const LINK_TOKEN = /^https?:\/\//i;

/**
 * AN UNRECOGNISED CELL KEEPS ITS PROSE CLIPPED AND ITS LINKS WHOLE.
 *
 * `unmapped` is two things at once. It is the audit record of what a file
 * carried that no field took, which is why its prose is clipped. And it is the
 * only place a row's brochure, flyer or package link is kept: a column of
 * links is not one this table maps, and `rowSourceBranches` reads the links
 * back out of it. Clipping served the first and silently broke the second,
 * because a link is an address and the first 300 characters of an address are
 * a different address.
 *
 * PRODUCTION, 24 SEPTEMBER 2026, production-rollout run 36013693485. A
 * `Brochure URL` column held signed links of about 500 characters. The settler
 * asked for the 300 it had kept, was refused `InvalidJWT: Invalid Compact JWS`
 * on every attempt, and the properties went source → fallback → source for as
 * long as anyone watched, each lap reported as "a fault on our side". A signed
 * storage link, a pre-signed object-store link and a shared-document link
 * carrying its parameters all run past 300 as a matter of course.
 *
 * So a link is kept whole or not at all, the rule an image column's links
 * have always had (`MAX_LINK_CHARS`). A cell with no link, or no longer than
 * the clip, is kept exactly as it always was. Where a cell carries a link and
 * runs past the clip, its prose is clipped as before and every link in it is
 * kept whole, in order. A link longer than the bound is left out, and so is
 * one the cell's own read ended (`cutByRead`): the start of a link is never
 * kept as if it were one.
 */
export function keptUnmappedCell(raw: string, cutByRead = false): string {
  if (!/https?:\/\//i.test(raw)) return raw.slice(0, UNMAPPED_PROSE_CHARS);
  const tokens = raw.split(' ');
  const kept: string[] = [];
  let prose = 0;
  tokens.forEach((token, i) => {
    if (LINK_TOKEN.test(token)) {
      const endedByRead = cutByRead && i === tokens.length - 1;
      if (!endedByRead && token.length <= MAX_LINK_CHARS) kept.push(token);
      return;
    }
    const room = UNMAPPED_PROSE_CHARS - prose;
    if (room <= 0) return;
    const word = token.slice(0, room);
    prose += word.length + 1;
    kept.push(word);
  });
  return kept.join(' ');
}

// ---------------------------------------------------------------------------
// Row → record
// ---------------------------------------------------------------------------

/** Empty record, so every caller starts from "nothing is known". */
export function emptyStockRecord(): NormalisedStockRecord {
  return {
    external_reference: null, development_name: null, project_name: null,
    address_line: null, suburb: null, state: null, postcode: null,
    lot_number: null, unit_number: null, bedrooms: null, bathrooms: null,
    car_spaces: null, property_type: null, house_design: null, land_size_sqm: null,
    building_size_sqm: null, price: null, price_display: null,
    availability_status: 'unknown', expected_completion: null, description: null,
    image_urls: [], image_url_fields: {}, source_anchor: null, unmapped: {},
  };
}

/**
 * Normalise one raw row, keyed by whatever headers the file used.
 *
 * Returns null when the row identifies no property. That test is deliberately
 * low — a reference, an address, a suburb, or a lot/unit is enough — because
 * dropping a real row is worse than importing a thin one; but a row of totals
 * or a blank separator line carries none of them and must not become a
 * property.
 */
export function normaliseStockRow(
  row: Record<string, unknown>,
): NormalisedStockRecord | null {
  const record = emptyStockRecord();
  let sawAnything = false;

  for (const [header, value] of Object.entries(row)) {
    const field = fieldForHeader(header);
    const raw = text(value, 4000);
    if (raw === null) continue;

    /**
     * The reserved anchor column, lifted off the row rather than filed.
     *
     * It is NOT evidence that the row describes a property — a row carrying
     * nothing but its own identity is still an empty row — so it deliberately
     * does not set `sawAnything`, and it never lands in `unmapped`, where it
     * would be shown to a builder as a column we failed to understand.
     */
    if (normaliseHeader(header) === normaliseHeader(SOURCE_ANCHOR_HEADER)) {
      record.source_anchor = raw.slice(0, 200);
      continue;
    }

    sawAnything = true;

    if (field === null) {
      // Kept, not dropped: the audit record shows what the file carried that
      // we did not place, which is how the alias table grows. Its links are
      // kept whole: see `keptUnmappedCell`.
      const key = String(header).slice(0, 80);
      if (Object.keys(record.unmapped).length < 40) {
        record.unmapped[key] = keptUnmappedCell(raw, cellWasCut(value, raw));
      }
      continue;
    }

    switch (field) {
      case 'external_reference': record.external_reference = text(value, 120); break;
      case 'development_name': record.development_name = text(value, 200); break;
      case 'project_name': record.project_name = text(value, 200); break;
      case 'address_line': record.address_line = text(value, 300); break;
      case 'suburb': record.suburb = text(value, 120); break;
      case 'state': record.state = coerceState(value); break;
      case 'postcode': record.postcode = coercePostcode(value); break;
      case 'lot_number': record.lot_number = text(value, 40); break;
      case 'unit_number': record.unit_number = text(value, 40); break;
      case 'bedrooms': record.bedrooms = clampCount(coerceNumber(value)); break;
      case 'bathrooms': record.bathrooms = clampCount(coerceNumber(value)); break;
      case 'car_spaces': record.car_spaces = clampCount(coerceNumber(value)); break;
      case 'bed_bath_car': {
        /*
         * `??=`, so a dedicated Bed/Bath/Car column wins whichever side of
         * the combined one it sits on — its own case overwrites when it
         * comes later, and holds when it came first. The shapes themselves
         * are `parseBedBathCar`'s.
         */
        const combined = parseBedBathCar(raw);
        if (!combined) {
          /*
           * BACK TO THE AUDIT RECORD. A recognised heading whose value could
           * not be read must stay visible as exactly that: the first version
           * of this case consumed the cell and wrote nothing anywhere, so 32
           * live rows' counts vanished without a trace and the shapes below
           * had to be recovered from the sheet itself rather than from the
           * record that is kept for precisely this.
           */
          const key = String(header).slice(0, 80);
          if (Object.keys(record.unmapped).length < 40) {
            record.unmapped[key] = keptUnmappedCell(raw, cellWasCut(value, raw));
          }
          break;
        }
        if (combined.bedrooms !== null) record.bedrooms ??= combined.bedrooms;
        if (combined.bathrooms !== null) record.bathrooms ??= combined.bathrooms;
        if (combined.car_spaces !== null) record.car_spaces ??= combined.car_spaces;
        break;
      }
      case 'property_type': record.property_type = coercePropertyType(value); break;
      case 'house_design': record.house_design = text(value, 120); break;
      case 'land_size_sqm':
        record.land_size_sqm = clampMeasurement(coerceArea(value, 'land_size_sqm'), MAX_LAND_SQM);
        break;
      case 'building_size_sqm':
        record.building_size_sqm = clampMeasurement(coerceArea(value, 'building_size_sqm'), MAX_BUILDING_SQM);
        break;
      case 'price': {
        const priced = coercePrice(value);
        record.price = priced.price;
        record.price_display = priced.display;
        break;
      }
      case 'availability_status': record.availability_status = coerceAvailability(value); break;
      case 'expected_completion': record.expected_completion = text(value, 120); break;
      case 'description': record.description = text(value, 4000); break;
      case 'image_url': {
        const urls = coerceUrls(value);
        record.image_urls.push(...urls);
        // The source's own heading, so the role can be read off it later.
        for (const url of urls) record.image_url_fields[url] ??= String(header ?? '').trim().slice(0, 120);
        break;
      }
      case 'builder_name':
        // Recorded for the audit trail only. Who supplied the stock is the
        // authenticated organisation, never a name in a spreadsheet cell.
        record.unmapped['builder_name_as_stated'] = text(value, 200) ?? '';
        break;
    }
  }

  if (!sawAnything) return null;
  if (!identifiesAProperty(record)) return null;
  record.image_urls = Array.from(new Set(record.image_urls)).slice(0, 12);
  for (const url of Object.keys(record.image_url_fields)) {
    if (!record.image_urls.includes(url)) delete record.image_url_fields[url];
  }

  return record;
}

function clampCount(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 20) return null;
  return Math.round(value * 10) / 10;
}

/**
 * The combined BED // BATH // CAR cell, in the shapes the live sheet writes.
 *
 * MEASURED, 6 September 2026, on the master stocklist's 98 data rows —
 * every distinct value, counted:
 *
 *   25×  "4 / 2 / 2"                         the plain form
 *   15×  "3 / 2/ / 2"                        a doubled slash — a typo
 *   13×  "3 / 2 / 2"
 *   11×  "Nest 1 = 3 + 2 + 1␤Nest 2 = 1 + 1" dual occupancy, two dwellings
 *    7×  "3 / 2 / 1"
 *    5×  "Nest 1 = 3 + 2 + 2␤Nest 2 = 1 + 1"
 *    2×  "3  /  2  /  2"
 *    1×  each of "3 / 2 / 1 ", "5 / 2 / 2", "Nest 1 = 2 + 2 + 1…", ""
 *
 * THE PLAIN FORM is three counts in the heading's own order. A doubled slash
 * contributes an EMPTY part, not a value, so empties are dropped before the
 * count — which reads the 15 typo rows correctly and still refuses "3 / 2"
 * (two values have not said which of the three is missing) and "3 / / 2"
 * (dropping the empty leaves two).
 *
 * THE DUAL-OCCUPANCY FORM is one line per dwelling, each `label = counts`
 * with the counts in the same bed/bath/car order. The card describes the
 * PACKAGE, so positions are summed across dwellings — and a position some
 * dwelling does not state is NOT a zero, it is unstated, so that position
 * answers null and the card simply omits it: "Nest 2 = 1 + 1" states one
 * bed and one bath, and asserting the package's car count from a line that
 * names no cars would be a guess wearing a sum's clothing.
 *
 * Anything else answers null and the caller keeps the cell visible in
 * `unmapped`, which is how the next shape gets found.
 */
function parseBedBathCar(raw: string): {
  bedrooms: number | null; bathrooms: number | null; car_spaces: number | null;
} | null {
  /*
   * THE LABELLED FORM, first because it is self-describing: every count
   * names what it counts, so counts are summed BY LABEL and a dual
   * occupancy can state all three totals — "3 Bed 2 Bath 1 Car + 2 Bed
   * 1 Bath 1 Car" (a Notion stock list, measured 6 September 2026, 3 of
   * 18 rows; the other 14 are the single-dwelling "4 Bed 2 Bath 2 Car")
   * is five beds, three baths, two cars. A label the cell never uses stays
   * null, and the label words are an explicit list so "2 Carrara" can
   * never read as two car spaces.
   */
  /*
   * AND THE ABBREVIATIONS AND MULTIPLIERS A LISTING PRINTS — `4 BR 2 BA`,
   * `4 x Bedrooms`, `4 Bdrm` — which the brochure's count-line reader admits
   * and hands on here verbatim (24 September 2026). A word this list does not
   * name (`2 Living`, `1 Study`) is still not a count of anything.
   */
  const labelled = [...raw.matchAll(
    /(\d+(?:\.\d+)?)\s*(?:[x×]\s*)?(bed(?:room)?s?|br|bdrm?s?|bath(?:room)?s?|ba|bths?|car\s?spaces?|cars?|carports?|garages?)\b/gi)];
  if (labelled.length) {
    const sums: Record<'bed' | 'bath' | 'car', number | null> = {
      bed: null, bath: null, car: null,
    };
    for (const match of labelled) {
      const word = match[2].toLowerCase();
      const label = /^b(?:ed|r|d)/.test(word) ? 'bed'
        : /^b(?:a|th)/.test(word) ? 'bath'
          : 'car';
      sums[label] = (sums[label] ?? 0) + Number(match[1]);
    }
    /*
     * `Double Garage` IS TWO CAR SPACES, BY DEFINITION, where the cell states
     * no car figure of its own — `Single` is one and `Triple` three. A figure
     * beside it (`2 Car Double Garage`) is the car count and is not added to.
     */
    if (sums.car === null) {
      const garages = [...raw.matchAll(
        /\b(single|one|double|twin|two|triple|three)[- ]?(?:car\s+)?(?:lock[- ]?up\s+)?(?:garage|carport)\b/gi)];
      if (garages.length) {
        sums.car = garages.reduce((total, match) => total
          + (/^(?:single|one)$/i.test(match[1]) ? 1 : /^(?:triple|three)$/i.test(match[1]) ? 3 : 2), 0);
      }
    }
    return {
      bedrooms: clampCount(sums.bed),
      bathrooms: clampCount(sums.bath),
      car_spaces: clampCount(sums.car),
    };
  }

  /*
   * One segment per dwelling. The cell is written as one LINE per dwelling,
   * but `text()` collapses a row's whitespace — newlines included — before
   * any value reaches a parser, so the boundary cannot be the newline: a new
   * segment begins wherever a label runs up to an `=`, which reads the cell
   * identically in both shapes.
   */
  const segments = raw.split(/\r?\n/)
    .flatMap((line) => line.split(/(?=\b[A-Za-z][^=+]{0,40}=)/))
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length && segments.every((segment) => segment.includes('='))) {
    const perSegment: Array<number[] | null> = segments.map((segment) => {
      const counts = segment.slice(segment.indexOf('=') + 1)
        .split('+')
        .map((part) => clampCount(coerceNumber(part)));
      return counts.length >= 2 && counts.length <= 3
        && counts.every((count) => count !== null)
        ? counts as number[]
        : null;
    });
    if (perSegment.some((counts) => counts === null)) return null;
    const summed = (position: number): number | null => {
      let total = 0;
      for (const counts of perSegment as number[][]) {
        if (counts.length <= position) return null;
        total += counts[position];
      }
      return clampCount(total);
    };
    return {
      bedrooms: summed(0), bathrooms: summed(1), car_spaces: summed(2),
    };
  }

  const parts = raw.split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => clampCount(coerceNumber(part)));
  if (parts.length === 3 && parts.every((part) => part !== null)) {
    return { bedrooms: parts[0], bathrooms: parts[1], car_spaces: parts[2] };
  }
  return null;
}

/**
 * WHAT A BUILDER'S STOCK ITEM CAN PLAUSIBLY MEASURE.
 *
 * THE CEILING WAS 1,000,000 m² AND THAT IS NOT A PLAUSIBILITY CHECK — it is
 * ONE HUNDRED HECTARES, a cattle station rather than a house and land
 * package. The comment above it had the rule exactly right ("a land size of
 * 400,000 m² in a residential stock list is a unit error, not a property")
 * and then set a bound that admits it.
 *
 * MEASURED, 21 SEPTEMBER 2026. `LOT 266 Crowlea Estate - CURA 20B TEMPIO B`
 * imported `land_size_sqm: 334000` and a client's card read
 * `LAND 334,000 m²` — thirty-three hectares. Every other stock item this
 * deployment holds measures 143 m², 180 m² or 182.78 m². `coerceNumber`
 * strips a comma as a thousands separator, so whatever the document printed,
 * a figure three orders of magnitude out passed a check written to stop
 * exactly that.
 *
 * THE BOUNDS ARE THE DOMAIN'S, AND THEY ARE SEPARATE PER FIELD. A house and
 * land package is a house on a residential block: an acreage lot in a
 * builder's estate reaches a couple of hectares and a dwelling does not reach
 * a thousand square metres. Both ceilings sit far above anything real and far
 * below a misplaced decimal, which is the only failure they exist to catch.
 *
 * AND ABSENT BEATS WRONG. A refused figure reads as not stated — which the
 * card already renders, and which a builder can correct with the schedule —
 * where a wrong one is published as fact.
 */
const MAX_LAND_SQM = 50_000;
const MAX_BUILDING_SQM = 2_000;

function clampMeasurement(value: number | null, ceiling: number): number | null {
  if (value === null || value < 0) return null;
  if (value > ceiling) return null;
  return Math.round(value * 100) / 100;
}

/** True when the row names something a person could go and look at. */
export function identifiesAProperty(record: NormalisedStockRecord): boolean {
  return !!(record.external_reference
    || record.address_line
    || record.suburb
    || record.lot_number
    || record.unit_number
    || (record.development_name && (record.price !== null || record.property_type)));
}

// ---------------------------------------------------------------------------
// Duplicate matching
// ---------------------------------------------------------------------------

export interface StockMatchKeys {
  /** organisation + the builder's own reference. */
  reference: string | null;
  /**
   * organisation + development + lot/unit + house design. Development and
   * lot/unit are both required; the design is whatever the row states.
   *
   * THE DESIGN IS PART OF THIS KEY BECAUSE THE PACKAGE IS THE PRODUCT. A
   * house-and-land list offers one piece of land with several houses on it,
   * and those rows are different things to sell: different price, different
   * bedrooms, different brochure. The live master stocklist does it
   * constantly — Harlow 801 is offered as a Cura 20B, a Nex 20 and an Elara
   * 18, Oaklands 117 likewise — and without the design all three rows key to
   * `harlow|801`, so the second overwrites the first and the third overwrites
   * the second. 125 rows became 95 properties that way, the survivor decided
   * by nothing better than its position in the file, and the two packages a
   * buyer could not see were not archived or reported; they were never
   * written.
   *
   * A row with no design keys exactly as it did before, so a list that names
   * no design behaves as it always has.
   */
  developmentUnit: { development: string; unit: string; design: string } | null;
  /**
   * organisation + the SOURCE'S OWN ID FOR THIS ROW.
   *
   * The strongest of the three, and the only one the live list carries. It is
   * matched FIRST and it is the only key guarded by an identity check — see
   * `stockIdentity.pure.ts` — because an anchor names a row rather than a
   * property, and a row can be edited or re-used for the next lot.
   */
  anchor: string | null;
}

/**
 * The three keys an import may match an existing row on, and no others.
 *
 * Address is deliberately absent. Two townhouses share one street address, and
 * merging them loses a property — the conservative failure is a duplicate row
 * a person can archive, not a silent merge nobody sees.
 *
 * THE ANCHOR IS THE STRONGEST AND IT IS WHY THIS LIST GREW. The two older keys
 * need a builder reference, or a development AND a lot/unit column; the live
 * Notion list carries none of them on any row — the lot lives inside the title
 * — so both were null for all twenty-three properties and every re-import
 * inserted a fresh set instead of updating. Eight uploads, `updated` zero every
 * time, and the marketplace's imagery left on rows the operator then archived.
 *
 * It is also the only key that names a ROW rather than a property, which is
 * exactly why it may never be trusted on its own: the importer pairs it with
 * `sameProperty` from `stockIdentity.pure.ts` before carrying anything forward.
 */
export function stockMatchKeys(record: NormalisedStockRecord): StockMatchKeys {
  const reference = record.external_reference
    ? record.external_reference.trim().toLowerCase()
    : null;

  const development = (record.development_name ?? record.project_name ?? '').trim().toLowerCase();
  const unit = (record.unit_number ?? record.lot_number ?? '').trim().toLowerCase();
  const design = designToken(record.house_design);

  const anchor = record.source_anchor ? record.source_anchor.trim() : null;

  return {
    reference: reference || null,
    developmentUnit: development && unit ? { development, unit, design } : null,
    anchor: anchor || null,
  };
}

/**
 * A house design as a comparable token.
 *
 * Whitespace collapsed as well as trimmed, because "Vanta  23" and "Vanta 23"
 * are the same house and a stock list maintained by hand contains both. The
 * empty string means the row named no design, which is a state this key
 * carries rather than rejects.
 */
export function designToken(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The development-unit key as one string, built in ONE place.
 *
 * Three copies of this template used to exist — the stored-row index, the
 * lookup and the post-insert update — and a key format written out at each
 * end is how two ends drift. Adding the design to two of the three would have
 * merged a package into its sibling on whichever copy was missed.
 */
export function developmentUnitMatchKey(
  parts: { development: string; unit: string; design: string },
): string {
  return `${parts.development}|${parts.unit}|${parts.design}`;
}

/** A stored row, as much of it as this key needs. */
export interface StoredRowKeyFields {
  development_name?: string | null;
  project_name?: string | null;
  unit_number?: string | null;
  lot_number?: string | null;
  /** `source_row->>house_design`, where the reader projected it. */
  house_design?: string | null;
  /** The whole record, where the reader has it. */
  source_row?: Record<string, unknown> | null;
}

/**
 * The same key, for a row we already hold — and there is ONE of these.
 *
 * The importer and the image-attachment path each had their own copy of this
 * function, which is exactly how they came to disagree: adding the design to
 * the importer's alone would have left every Harlow 801 brochure going to
 * whichever of the three packages was read last, badged "Builder supplied",
 * on the wrong house.
 *
 * The design is taken from the projected alias or from the stored record,
 * because the two readers differ in which they have: the importer projects
 * the scalar and never reads the blob, while the repair path reads the record
 * whole. Looking in both is what lets one function serve both.
 */
export function storedRowDevelopmentUnitKey(row: StoredRowKeyFields): string | null {
  const development = (row.development_name ?? row.project_name ?? '').trim().toLowerCase();
  const unit = (row.unit_number ?? row.lot_number ?? '').trim().toLowerCase();
  if (!development || !unit) return null;
  const fromRecord = typeof row.source_row?.house_design === 'string'
    ? row.source_row.house_design
    : null;
  return developmentUnitMatchKey({
    development, unit, design: designToken(row.house_design ?? fromRecord),
  });
}

/**
 * A fingerprint of everything a row SAID, for re-finding the property it
 * already became.
 *
 * This is NOT a third matching key for the importer, and it must never become
 * one: two genuinely different lots can agree on every value a thin file
 * carries, and merging them would be a defect nobody can see. It exists for
 * re-reading a source whose properties are already imported — attaching an
 * image to the property this exact row produced — where the alternative is
 * matching nothing at all.
 *
 * The live Notion list is exactly that case: not one of its seventy rows
 * carries a reference, a lot column or a unit column (the lot is inside the
 * title, "Lot 60434 - Cloverton Estate…"), so both of the importer's keys are
 * null for every row and a repair that used them would find nobody.
 */
export function stockRowFingerprint(record: Partial<NormalisedStockRecord>): string {
  const part = (value: unknown) =>
    String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return [
    part(record.external_reference),
    part(record.address_line),
    part(record.development_name),
    part(record.project_name),
    part(record.suburb),
    part(record.postcode),
    part(record.lot_number),
    part(record.unit_number),
    part(record.price),
    part(record.land_size_sqm),
    part(record.building_size_sqm),
    part(record.property_type),
  ].join('|');
}

/**
 * The fields a label is built from.
 *
 * Named as its own type so a STORED ROW can be labelled too: the columns carry
 * these names, and the identity rules in `stockIdentity.pure.ts` need the same
 * label from both sides of a re-import. Widening the parameter only — every
 * existing caller passes a whole record and is unaffected.
 */
export type StockLabelFields = Pick<NormalisedStockRecord,
  'unit_number' | 'lot_number' | 'address_line' | 'suburb'
  | 'development_name' | 'external_reference'>;

/** A short human label for a record, for logs and the import summary. */
/**
 * THE ADDRESS WITHOUT THE DESIGNATION THE LABEL IS ABOUT TO PUT IN FRONT OF IT.
 *
 * A builder's own document often writes the address WITH the lot in it — "Lot
 * 1731 Hornsea Street" — and the importer also captures the lot as its own
 * field, correctly. Both are right, and putting them together reads
 * "Lot 1731, Lot 1731 Hornsea Street", which is what a card showed on a
 * single-property brochure uploaded on 3 September 2026.
 *
 * The designation is dropped from the FRONT of the address only, and only
 * when it is the SAME one: a row whose lot is 1731 beside an address reading
 * "Lot 5 Smith Street" keeps both, because there the disagreement is the
 * information. Nothing is stripped from the middle of an address, so
 * "3/12 Smith Street" and "Factory 2, 15 Kent Road" are untouched.
 */
export function addressWithoutLeadingDesignation(
  addressLine: string | null | undefined,
  designation: 'Lot' | 'Unit',
  number: string | null | undefined,
): string {
  const address = String(addressLine ?? '').trim();
  const value = String(number ?? '').trim();
  if (!address || !value) return address;
  const pattern = new RegExp(
    `^${designation}\\s*\\.?\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,\\-]*`,
    'i',
  );
  const stripped = address.replace(pattern, '').trim();
  // Never answer an empty address: an address that was ONLY the designation
  // still says where the property is once the label restores it.
  return stripped || address;
}

/** The designation a record leads with, and the number it carries. */
function labelDesignation(
  record: StockLabelFields,
): { word: 'Lot' | 'Unit'; value: string } | null {
  if (record.unit_number) return { word: 'Unit', value: String(record.unit_number) };
  if (record.lot_number) return { word: 'Lot', value: String(record.lot_number) };
  return null;
}

export function stockRecordLabel(record: StockLabelFields): string {
  const parts: string[] = [];
  const designation = labelDesignation(record);
  if (designation) parts.push(`${designation.word} ${designation.value}`);
  const address = designation
    ? addressWithoutLeadingDesignation(
      record.address_line, designation.word, designation.value)
    : String(record.address_line ?? '');
  if (address) parts.push(address);
  if (record.suburb) parts.push(record.suburb);
  if (!parts.length && record.development_name) parts.push(record.development_name);
  if (!parts.length && record.external_reference) parts.push(record.external_reference);
  return parts.join(', ').slice(0, 200) || 'Unnamed property';
}

/**
 * The identity-bearing names the display label leaves out.
 *
 * `stockRecordLabel` shows the estate only when a row has neither a lot nor an
 * address — it is a short label for logs, and for logs that is right. But a
 * builder's own package cover identifies a lot the way the estate's marketing
 * does. Measured live, 2 September 2026: the Watsons Reach list's brochure for
 * lot 102 states "Lot 102 Watsons Reach Estate" beside its package price,
 * while the row's label reads "Lot 102, Diggers Rest" — the suburb, which the
 * document never mentions. The cover-identity corroboration was fed only the
 * label, refused the builder's own supplied brochure, and the card went blank.
 *
 * So the row's remaining identity names travel BESIDE the label, as hints for
 * `pageStatesIdentity`'s corroboration test alone — they can never substitute
 * for the lot, excuse a page naming another lot, or loosen the
 * full-conjunction path a lot-less label gets.
 */
export function stockIdentityHints(
  record: Pick<NormalisedStockRecord, 'development_name' | 'project_name'>,
): string[] {
  return [record.development_name, record.project_name]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
}

/**
 * A single-line address for the image-enrichment stages. Returns null when
 * there is not enough to geocode — an enrichment run against "Suburb" alone
 * would return a picture of somewhere else.
 */
/**
 * IS THERE A BUILDING AT THIS ADDRESS TO PHOTOGRAPH?
 *
 * A Street View still is a picture of whatever stands at a point on the
 * ground. For a completed dwelling that is the house. For a lot in a new
 * estate it is dirt, a road, or the paddock the estate has not been built on
 * yet — and that is not "no picture available", it is a picture of the wrong
 * thing, presented to a client as their property.
 *
 * PRODUCTION, 30 AUGUST 2026: a house-and-land package whose brochure shows a
 * finished render was served a Street View of an empty rural road outside the
 * estate. 58 cards were in that state.
 *
 * The signal is already here and needs no new field: a property the source
 * gave a REAL STREET ADDRESS is an addressed, built or building dwelling; one
 * whose line had to be COMPOSED from a lot number and an estate name is, by
 * construction, a lot in an estate. `composeAddressLine` returns non-null
 * only in the second case, which is exactly the test.
 *
 * It does not touch stage 2. A web search identifies a property by name, and
 * the builder's own render of the design on this lot is a legitimate and
 * useful reference picture — it is what the brochure itself shows. This
 * governs stage 3 alone, where the camera photographs the ground.
 */
export function hasPhotographableStreetAddress(record: {
  address_line: string | null;
}): boolean {
  return !!record.address_line?.trim();
}

export function geocodableAddress(record: {
  address_line: string | null; suburb: string | null;
  state: string | null; postcode: string | null;
  lot_number?: string | null; unit_number?: string | null;
  development_name?: string | null; project_name?: string | null;
}): string | null {
  /*
   * A LINE THE SOURCE DID NOT GIVE US, BUILT FROM WHAT IT DID.
   *
   * This used to refuse outright without an `address_line`, and a great many
   * stock lists do not have one: they carry the lot in one column, the estate
   * in another and the suburb in a third, which is the ordinary shape of a
   * builder's spreadsheet. Measured on one import — 89 properties, 89 lot
   * numbers, 89 estates, THREE addresses — every property was claimed, every
   * stage advanced, and stages 2 and 3 had nothing to identify or geocode. The
   * ladder ran to the bottom and found it had no rungs.
   *
   * COMPOSED HERE AND NOWHERE ELSE, WHICH IS THE POINT. `address_line` stays
   * exactly what the builder wrote — so property identity, duplicate matching
   * and the label a package document is searched for are all untouched. This
   * function is the one place that asks "can the fallback ladder name this
   * property", so it is the one place that may answer from the parts.
   *
   * NOTHING IS INVENTED, and it stays conservative: a bare lot number names
   * nothing a geocoder can find, so a composition needs a NAMED PLACE — an
   * estate or a project — and a row with only a number still returns null.
   */
  /*
   * AND IT IS TAKEN APART BEFORE IT IS ASKED OF ANYONE.
   *
   * `address_line` used to be handed over whole. It carries the lot prefix
   * that opens nearly every builder line and whatever the list writes after
   * the address — a design name, a floor area — so the question put to the
   * provider was `Lot 60913 Basalt St, Beveridge, VIC 3753 (178 m2), VIC,
   * Australia`, which is not a question it can answer at street level. Of the
   * nineteen properties on the 10 September 2026 list the one that answered
   * "that address could not be located" is the one whose whole line reached
   * the geocoder in that state, and it is the only one with no photograph.
   *
   * `parseBuilderAddressLine` is where that line is already pulled apart for
   * the map, so the street it found is the street asked for here.
   *
   * ONLY WHERE THE PARSE DID NOT HAVE TO GUESS, which is the whole of the
   * care needed here. A line opening with a bare number is ambiguous, and the
   * parser resolves it as a LOT on measured evidence — 44 of 44 — because for
   * a PIN calling a lot a street number is the dangerous direction. Composing
   * from its parts would therefore turn the supplied address `12 Wattle St`
   * into `Wattle Street` and throw away a rooftop this function already had.
   * So the parts are used where the line NAMED its lot (`Lot 60913 Basalt
   * St`, where what follows is a street by construction) or where a street
   * number was positively identified; anything else is asked exactly as it
   * was supplied, as it always has been.
   *
   * `address_line` itself is untouched either way, so property identity,
   * duplicate matching and the label a package document is searched for all
   * stand.
   */
  const parsed = parseBuilderAddressLine(record.address_line);
  const lotWasNamed = /^\s*lot\b/i.test(record.address_line ?? '');
  const street = (lotWasNamed || parsed.streetNumber)
    ? ([parsed.streetNumber, parsed.streetName, parsed.streetType]
      .filter((part) => !!part && !!String(part).trim())
      .join(' ')
      .trim() || null)
    : null;

  const line = street
    || record.address_line?.trim()
    || composeAddressLine(record as never)?.line
    || null;
  if (!line) return null;

  /*
   * The structured columns win where the source stated them, and the parsed
   * line fills the rest — the same precedence `builderStockAddress` applies
   * on the read path, because a builder who typed a suburb into the field
   * meant it and a Notion list types nothing into any field at all.
   */
  const parts = [
    line,
    record.suburb ?? parsed.suburb,
    record.state ?? parsed.state,
    record.postcode ?? parsed.postcode,
  ]
    .filter((part): part is string => !!part && !!part.trim());
  // Still two parts: a place on its own is a suburb, and a picture of "the
  // suburb" is a picture of somewhere else.
  if (parts.length < 2) return null;
  return `${parts.join(', ')}, Australia`;
}
