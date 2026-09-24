/**
 * ===========================================================================
 * THE UNIT PRINTED BESIDE A MEASUREMENT IS PART OF IT.
 * ===========================================================================
 *
 * MEASURED 24 SEPTEMBER 2026, through the real reader: `House Size` over
 * `21.5 squares` reached the row as `building_size_sqm: 21.5`, a 21.5 m²
 * house. `Land Size` over `1.2 acres` became a 1.2 m² block, and `2,000 sq
 * ft` became 2,000 m². `coerceNumber` takes the first number in a cell and
 * nothing else, so the one word that said what the number measures was
 * dropped one step before the field that holds square metres. The ceilings in
 * `normalise.pure.ts` catch a misplaced decimal and nothing smaller than one.
 *
 * Nothing stored carries a unit in a size yet (every production size is a
 * bare number), so this changes no reading that exists. It decides what the
 * next document that prints one gets, from any source: a brochure, a sheet,
 * a Notion page or a web page all reach the card through `normalise.pure.ts`,
 * and a brochure's claims pass `fieldTypes.pure.ts` on the way. Both ask
 * here, so the two cannot come to disagree about what `0.5 acres` is.
 *
 * EVERY CONVERSION IS A DEFINITION, NOT AN ESTIMATE. A square is 100 square
 * feet, a square foot is 0.09290304 m², a hectare 10,000 m² and an acre
 * 4,046.8564224 m². Where the unit and the field cannot both be true — a
 * house in hectares or acres, a block in squares, a "squares" figure too
 * large to be a dwelling — the size is ABSENT, never guessed.
 *
 * `sq` alone is squares on a house (`21.5 sq`, the Australian building
 * convention). On land it stays square metres, as it has always been read:
 * land is not sold in squares, and a trailing `sq` there is `sqm` cut short.
 * A number with no unit, or with one this does not name, reads exactly as it
 * did before this existed.
 *
 * Pure: no IO.
 */

export type AreaField = 'land_size_sqm' | 'building_size_sqm';

export const SQUARE_METRES_PER_SQUARE = 9.290304;
export const SQUARE_METRES_PER_SQUARE_FOOT = 0.09290304;
export const SQUARE_METRES_PER_HECTARE = 10_000;
export const SQUARE_METRES_PER_ACRE = 4_046.8564224;
/** A hundred squares is 929 m². Past that, a figure in squares is not a dwelling. */
export const MAX_DWELLING_SQUARES = 100;

export type AreaUnit =
  | 'square_metres' | 'squares' | 'sq' | 'square_feet' | 'hectares' | 'acres';

/**
 * The unit written immediately after a measurement's number, if it names one.
 * `null` is "no unit this names", which reads as the bare number always has.
 */
export function areaUnitAfter(after: string): AreaUnit | null {
  const unit = after.replace(/^\s+/, '').toLowerCase();
  // Square feet and square metres first: both begin with `sq`.
  if (/^(?:sq\.?\s*(?:ft|feet|foot)\b|square\s+(?:feet|foot)\b|sqft\b|ft\s?(?:2|²))/.test(unit)) {
    return 'square_feet';
  }
  if (/^(?:m\s?(?:2|²)|m\b|sqm\b|sq\.?\s*(?:m|mt|mtr|mtrs|metres?|meters?)\b|square\s+met(?:re|er)s?\b)/.test(unit)) {
    return 'square_metres';
  }
  if (/^squares?\b/.test(unit)) return 'squares';
  if (/^sqs?\b/.test(unit)) return 'sq';
  if (/^(?:ha|hectares?)\b/.test(unit)) return 'hectares';
  if (/^(?:ac|acres?)\b/.test(unit)) return 'acres';
  return null;
}

/** The first number in `raw`, as `coerceNumber` takes it, and the unit after it. */
function firstNumber(raw: string): { amount: number; unit: AreaUnit | null } | null {
  const cleaned = String(raw ?? '').replace(/,/g, '');
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  if (!Number.isFinite(amount)) return null;
  return { amount, unit: areaUnitAfter(cleaned.slice((match.index ?? 0) + match[0].length)) };
}

/**
 * Does `raw` state an area in a unit that is NOT square metres — squares,
 * square feet, hectares or acres? What a heading over it may mean turns on
 * this, before any field is known: `HOUSE` over `24.6 sq` is the house's
 * size, never its design. Square metres are left out on purpose. Every
 * reader already spells those, and a bare `m` is also a length (`Frontage
 * 15m`), which must never make a heading an area heading.
 */
export function statesAreaInAnotherUnit(raw: string): boolean {
  const unit = firstNumber(raw)?.unit ?? null;
  return unit !== null && unit !== 'square_metres';
}

/**
 * Does the unit written in `raw` change what its number means for `field`?
 *
 * False for square metres, for no unit, and for `sq` on land: the three
 * readings in which the number already IS square metres, and which every
 * reader has always taken as it stands.
 */
export function unitConvertsArea(raw: string, field: AreaField): boolean {
  const unit = firstNumber(raw)?.unit ?? null;
  if (unit === null || unit === 'square_metres') return false;
  return !(unit === 'sq' && field === 'land_size_sqm');
}

/**
 * What a size written as `raw` measures in square metres, for `field`.
 *
 * The number is the FIRST in the text, exactly as `coerceNumber` has always
 * taken it (a comma is a thousands separator), and the unit is the words
 * written straight after it. `null` where there is no number, or where the
 * unit and the field cannot both be true. The result is unrounded; the
 * caller's own bounds and rounding apply after it.
 */
export function areaInSquareMetres(raw: string, field: AreaField): number | null {
  const read = firstNumber(raw);
  if (!read) return null;
  const { amount, unit } = read;
  const land = field === 'land_size_sqm';
  switch (unit) {
    case 'square_feet':
      return amount * SQUARE_METRES_PER_SQUARE_FOOT;
    case 'squares':
      if (land) return null;
      return amount < MAX_DWELLING_SQUARES ? amount * SQUARE_METRES_PER_SQUARE : null;
    case 'sq':
      if (land) return amount;
      return amount < MAX_DWELLING_SQUARES ? amount * SQUARE_METRES_PER_SQUARE : null;
    case 'hectares':
      return land ? amount * SQUARE_METRES_PER_HECTARE : null;
    case 'acres':
      return land ? amount * SQUARE_METRES_PER_ACRE : null;
    default:
      return amount;
  }
}
