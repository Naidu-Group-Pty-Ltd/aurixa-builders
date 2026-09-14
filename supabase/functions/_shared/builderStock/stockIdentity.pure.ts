/**
 * Builder stock — is the row arriving the SAME PROPERTY as the one we hold?
 *
 * WHY THIS EXISTS. `source_anchor` is the source's own id for a row — a Notion
 * block id, a sheet and row — and it is the only identity the live stock list
 * actually carries: not one of its rows has a builder reference, a lot column
 * or a unit column, so both of the importer's match keys are null for every
 * one of them. That made every re-import an INSERT of a brand-new set, which
 * is what emptied the marketplace: eight uploads, twenty-three rows each,
 * `updated` zero every single time, and the imagery left behind on the rows
 * the operator then archived.
 *
 * So the anchor becomes a match key. But an anchor is a POINTER TO A ROW, not
 * a statement about a property: a person can edit that row, or re-use it for
 * the next lot in the estate. Carrying a property's photographs forward purely
 * because a row id matched would be this platform's worst image defect — a
 * builder's photograph of one house shown, badged "Builder supplied", on a
 * different house.
 *
 * Hence: THE ANCHOR SAYS WHICH ROW. THIS MODULE SAYS WHETHER IT IS STILL THE
 * SAME PROPERTY. Imagery is carried forward only when both agree.
 *
 * NOTHING HERE IS A NEW HEURISTIC. Every part is a rule this repository
 * already relies on to attribute a builder's own package to a property —
 * `lotAndDesignFrom` and `streetAddressFrom` are the identity rules the Drive
 * package reader has used since the source-discovery work, and reading the lot
 * out of the row's own label is the same rule for the same reason: the columns
 * are empty and the label is where the source states it.
 *
 * Pure: no IO, no clock.
 */
import {
  lotAndDesignFrom, normaliseDriveName, streetAddressFrom,
} from './drivePackage.pure.ts';
import { stockRecordLabel, type StockLabelFields } from './normalise.pure.ts';

/**
 * The fields an identity is read from — satisfied by a normalised record and
 * by a stored row alike, because the stored row's columns carry the same
 * names. Deliberately NOT the whole record: see the exclusions below.
 */
export interface PropertyIdentityFields extends StockLabelFields {
  project_name?: string | null;
  /** `numeric` arrives from PostgREST as a string. */
  building_size_sqm?: number | string | null;
  /**
   * The house design as its own column, where the file gives it one.
   *
   * A stored row carries this inside `source_row` rather than as a column of
   * its own, so the importer projects it out of the JSON the same way it
   * projects the anchor. Optional, because most sources state the design only
   * inside the label and `lotAndDesignFrom` reads it there.
   */
  house_design?: string | null;
}

/**
 * WHAT MAKES TWO ROWS THE SAME PROPERTY.
 *
 * Five parts, and the reason each is here is that changing it changes which
 * house the builder's own package is about:
 *
 *   `development`  the estate. Two lots numbered 43 in different estates are
 *                  different properties.
 *   `lot`          the lot or unit. From the columns when the file fills them
 *                  and from the row's own label when it does not, which is
 *                  every row on the live list ("Lot 60941 - Cloverton
 *                  Estate…").
 *   `street`       the street number and name, by `streetAddressFrom` — which
 *                  already knows that a house-and-land row states its street
 *                  number AS its lot number.
 *   `design`       the bracketed house design. This is the part that
 *                  distinguishes seven rows sharing one lot, and it is exactly
 *                  what `selectPackageDocument` matches a PDF on, so a changed
 *                  design means the package we attributed is the wrong
 *                  document.
 *   `buildingSize` the floor area, which is how this repository already
 *                  disambiguates two candidates for one lot
 *                  (`selectByBuildingSize`). Production needs it: the two
 *                  Cloverton rows are both "Lot 60941 - Cloverton Estate,
 *                  Kalkallo VIC 3064", same estate, same lot, same land, and
 *                  differ only as "[3 Bed · 140 m²]" and "[4 Bed · 154 m²]" —
 *                  a bracket the design regex correctly declines to read as a
 *                  design name. Without the area they are one property, and
 *                  one of them would inherit the other's photograph.
 *
 * WHAT IS DELIBERATELY ABSENT, and this is the more important half. Price,
 * land size, availability, expected completion, bedrooms, bathrooms, car
 * spaces and description are NOT identity. They change on almost every
 * re-import — a repriced lot is the same house — and putting any of them here
 * would throw away a correct photograph every time a builder edited a number,
 * which is the failure this whole change exists to end. The test is "would a
 * builder's package for the old row be the wrong document for the new one",
 * and a price cannot make it so.
 */
export interface StockPropertyIdentity {
  development: string;
  lot: string;
  street: string;
  design: string;
  buildingSize: string;
}

/** The identity parts, in the order a person would want them reported. */
export const IDENTITY_PARTS: ReadonlyArray<keyof StockPropertyIdentity> = [
  'development', 'lot', 'street', 'design', 'buildingSize',
];

/**
 * A building area as a comparable token.
 *
 * Rounded to the square metre, because `140` and `140.00` are the same house
 * and PostgREST hands back the second. An unreadable or absent area is the
 * empty string — see `samePropertyIdentity` for what that then means.
 */
function areaToken(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return String(Math.round(numeric));
}

/** Read the exact-property identity out of a record or a stored row. */
export function stockPropertyIdentity(
  fields: PropertyIdentityFields,
): StockPropertyIdentity {
  const label = stockRecordLabel(fields);
  const { lot: labelLot, design } = lotAndDesignFrom(label);
  const street = streetAddressFrom(label);

  // The columns first, the label second. A file that fills its lot column is
  // stating it more plainly than a title can, and the label rule exists for
  // the files that do not.
  const column = (fields.unit_number ?? fields.lot_number ?? '').trim();

  /*
   * THE SAME RULE FOR THE DESIGN, and it is why 30 packages were invisible.
   *
   * The design was read only out of the label's brackets, so a list that
   * states it in a column of its own — which the live master stocklist does,
   * for every row — produced an empty design on both sides of the comparison.
   * Three rows offering three houses on Harlow 801 were then one property,
   * and the anchor guard could not see the difference either: it compares
   * this identity, so a row re-used for a different HOUSE on the same land
   * looked unchanged and would have handed over the other design's brochure.
   */
  const designColumn = (fields.house_design ?? '').trim();

  return {
    development: normaliseDriveName(fields.development_name ?? fields.project_name ?? ''),
    lot: column ? normaliseDriveName(column) : (labelLot ?? ''),
    street: street ? `${street.number} ${street.street}` : '',
    design: designColumn ? normaliseDriveName(designColumn) : (design ?? ''),
    buildingSize: areaToken(fields.building_size_sqm),
  };
}

/**
 * Do these two identities describe the same property?
 *
 * ABSENCE IS NOT A DIFFERENCE, AND THAT IS THE ONE SUBTLE RULE HERE. A part
 * neither side states is not evidence of anything: most rows have no design
 * and many have no street, so requiring both sides to state all five would
 * make almost every re-import look like a new property and would re-derive
 * every photograph in the marketplace on every upload — the same outcome as
 * having no match key at all, reached the long way round.
 *
 * A part ONE side states and the other does not is likewise not a difference.
 * A thinner file is the case the importer's own patch rule is built around —
 * "an update never erases" — and a source that stopped printing the design in
 * its title has not moved the house.
 *
 * What IS a difference is both sides stating the part and disagreeing. That is
 * the source telling us, in its own words, that this row is now about
 * something else.
 */
export function samePropertyIdentity(
  before: StockPropertyIdentity,
  after: StockPropertyIdentity,
): boolean {
  return identityDifferences(before, after).length === 0;
}

/**
 * Which parts the two sides state and disagree on — empty when they are the
 * same property.
 *
 * Returned rather than a bare boolean so the import can SAY what changed. A
 * property whose imagery was dropped and re-derived is a thing an operator
 * will ask about, and "the lot changed from 43 to 44" is an answer.
 */
export function identityDifferences(
  before: StockPropertyIdentity,
  after: StockPropertyIdentity,
): Array<keyof StockPropertyIdentity> {
  return IDENTITY_PARTS.filter((part) => {
    const a = before[part];
    const b = after[part];
    return !!a && !!b && a !== b;
  });
}

/** The same question, straight from the two sets of fields. */
export function sameProperty(
  before: PropertyIdentityFields,
  after: PropertyIdentityFields,
): boolean {
  return samePropertyIdentity(stockPropertyIdentity(before), stockPropertyIdentity(after));
}

/** Human wording for the import summary and the activity log. */
export function describeIdentityChange(
  differences: ReadonlyArray<keyof StockPropertyIdentity>,
): string {
  const words: Record<keyof StockPropertyIdentity, string> = {
    development: 'development', lot: 'lot or unit', street: 'street address',
    design: 'house design', buildingSize: 'building size',
  };
  const named = differences.map((part) => words[part]);
  if (!named.length) return 'the same property';
  if (named.length === 1) return `a different ${named[0]}`;
  return `a different ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}
