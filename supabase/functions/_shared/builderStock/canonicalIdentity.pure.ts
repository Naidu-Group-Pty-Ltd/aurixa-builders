/**
 * BUILDER STOCK — A PROPERTY THE FALLBACK LADDER CANNOT NAME IS A PROPERTY IT
 * CANNOT PHOTOGRAPH.
 *
 * PRODUCTION, 30 AUGUST 2026. A 119-property stock list imported cleanly, the
 * cutover published it, the scheduler ran, every property was claimed and
 * every property advanced — source, eligibility, sanitization, fallback — and
 * not one image was produced. The state machine turned perfectly and delivered
 * nothing.
 *
 *     lot_number        89 of 89
 *     development_name  89 of 89
 *     land_size_sqm     89 of 89
 *     address_line       3 of 89   <-
 *     suburb             3 of 89   <-
 *
 * `geocodableAddress` returns null without an `address_line`, so stage 3 had
 * nothing to geocode and stage 2 nothing to identify. The properties reached
 * the bottom of the ladder and found it had no rungs.
 *
 *
 * THE DEFECT IS NOT THE SOURCE. IT IS THAT AN ADDRESS WAS ONLY EVER TAKEN,
 * NEVER COMPOSED.
 *
 * `address_line` is mapped from a column that looks like an address, and a
 * great many stock lists do not have one: they carry the lot in one column,
 * the estate in another and the suburb in a third, which is the ordinary shape
 * of a builder's spreadsheet. A Notion database happened to carry its title as
 * a full address line, so the gap never showed. Any CSV, XLSX or Sheet in the
 * split shape — today's or a future builder's — starves the same ladder.
 *
 * So the record composes what it can name itself from the identity it DOES
 * hold. Nothing is invented: every part comes from a column the builder
 * supplied, and the raw row is stored beside it, so what was composed is
 * always visible.
 *
 *
 * IT IS CONSERVATIVE ON PURPOSE. A bare lot number names nothing — "Lot 605"
 * geocodes to whichever estate the provider feels like, and a picture of the
 * wrong estate is worse than no picture. So a composition needs a NAMED PLACE:
 * an estate or a project. Where the row has only a number, or only a locality,
 * it composes nothing and the property stays honestly unidentifiable.
 *
 * Pure: no IO, no clock, no network.
 */

export interface ComposableIdentity {
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lot_number: string | null;
  unit_number: string | null;
  development_name: string | null;
  project_name: string | null;
}

export interface ComposedAddress {
  line: string;
  /** Which fields it was built from, in order. Diagnostics, never a rule. */
  parts: string[];
}

/**
 * The name of a PLACE this row carries, if it carries one.
 *
 * An estate or a project is a place a geocoder can find. A lot number, a
 * design name and a configuration are not — they qualify a place rather than
 * being one.
 */
function placeOf(record: ComposableIdentity): { value: string; field: string } | null {
  const development = clean(record.development_name);
  if (development) return { value: development, field: 'development_name' };
  const project = clean(record.project_name);
  if (project) return { value: project, field: 'project_name' };
  /*
   * AND DELIBERATELY NOT THE SUBURB. It is already the next part of the line
   * the caller joins, so using it here would be circular — and a lookup handed
   * nothing but a suburb returns a picture of somewhere else in it, which is
   * the guard `geocodableAddress` has always had and which this must not
   * weaken. A row with a locality and no named estate composes nothing.
   */
  return null;
}

/**
 * An address line for a record that was not given one.
 *
 * Returns null when the source DID supply one — what a builder wrote is always
 * better than anything assembled here, and overwriting it would be the product
 * second-guessing its own source.
 */
export function composeAddressLine(record: ComposableIdentity): ComposedAddress | null {
  if (clean(record.address_line)) return null;

  const place = placeOf(record);
  if (!place) return null;

  const parts: string[] = [];
  const line: string[] = [];

  // A lot or unit number qualifies the place and never stands in for it.
  const unit = clean(record.unit_number);
  const lot = clean(record.lot_number);
  if (unit) { line.push(prefixed(unit, 'Unit')); parts.push('unit_number'); }
  else if (lot) { line.push(prefixed(lot, 'Lot')); parts.push('lot_number'); }

  line.push(place.value);
  parts.push(place.field);

  return { line: line.join(' ') , parts };
}

/*
 * THERE IS DELIBERATELY NO `withComposedIdentity` HERE.
 *
 * The obvious next function — one that writes the composed line back onto
 * `address_line` — was written, and it broke a real test within the hour. A
 * builder package document is searched for the property's own label, and
 * `stockRecordLabel` reads `address_line`; a composed string leaked into it
 * and a package that had matched stopped matching. Identity, duplicate
 * detection and document search all read that column, so it stays EXACTLY
 * what the builder wrote, empty included.
 *
 * The composition therefore has one consumer, `geocodableAddress`, where it is
 * a question put to a geocoder rather than a fact stored about a property.
 */

/** "605" -> "Lot 605"; "Lot 605" is left alone. */
function prefixed(value: string, word: string): string {
  return new RegExp(`^${word}\\b`, 'i').test(value) ? value : `${word} ${value}`;
}

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}
