/**
 * One address, composed from the parts the intake actually extracted.
 *
 * The marketplace was pinning properties at suburb centroids while holding
 * their street names, and this is the module that stops it.
 *
 * ## What went wrong
 *
 * `Property Intake Master` carries the address decomposed — `Unit Number`,
 * `Street Number`, `Street Name`, `Street Type`, `Suburb`, `State`,
 * `Postcode` — because the extraction prompt asks the model for exactly that,
 * and it is populated: 97 of 139 live listings can build a street line from
 * their parts. Nothing read them. The projection did
 *
 *     address = fields['Address'] ?? fields['Full Address']
 *
 * and every surface downstream — the card, the popup, the geocoder — took that
 * one string. The street parts travelled all the way into the browser on
 * `PropertyListing` and had **zero** call sites.
 *
 * That would merely have been wasteful if the two fields agreed. They do not.
 * On the intake's geocoded branch `Address` is never written at all, and
 * `Full Address` is a re-parse of Google's `formatted_address` — so a record
 * whose email said `Mortlock Street, Cobblebank` ends up with
 *
 *     Address       : null
 *     Full Address  : "Cobblebank VIC 3338, Australia"   ← the geocoder's answer
 *     Street Name   : "Mortlock"                          ← what the email said
 *     Street Type   : "Street"
 *
 * The geocoder was asked for `Cobblebank`, could only answer with the suburb,
 * and its answer was then written back over the record as the address. Fourteen
 * Cobblebank properties resolve to one point that way; across the corpus 202
 * cached geocodes collapse onto 95 distinct coordinates, all `APPROXIMATE`.
 *
 * ## The rule
 *
 * **The parts outrank any formatted string.** A geocoder's `formatted_address`
 * describes what it MATCHED, which — when the match was coarse — is a strictly
 * smaller fact than what the source told us. Composing `Mortlock Street,
 * Cobblebank VIC 3338` sends the geocoder a question it can answer at street
 * level instead of one it can only answer at suburb level.
 *
 * Three things follow.
 *
 * **Precision is measured, never assumed.** `precision` says how far the parts
 * actually reach, so a surface can plot a pin and still say "this is the
 * street, not the letterbox" rather than implying a rooftop it does not have.
 * Some listings genuinely arrive with a suburb and nothing else, and an estate
 * lot genuinely has no street number until the plan is registered — no amount
 * of parsing invents one, and pretending otherwise is the failure this whole
 * area keeps having.
 *
 * **A formatted string is used only where it adds something.** Falling back to
 * it is right when the parts are empty; preferring it is what caused the bug.
 *
 * **Nothing here geocodes, fetches or decides.** Pure: no Deno, no DOM, no
 * network, so the edge function, the browser and the tests all run the same
 * composition.
 */

/** Values the intake writes to mean "we could not tell". Never address text. */
const SENTINELS = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'tbc', 'tba', '-', '']);

function clean(value: unknown): string | null {
  if (typeof value !== 'string') {
    // Airtable returns a number for a numeric column, and a street number is
    // one — `15` must not be discarded for not being a string.
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export interface AddressParts {
  unitNumber?: unknown;
  streetNumber?: unknown;
  streetName?: unknown;
  streetType?: unknown;
  suburb?: unknown;
  state?: unknown;
  postcode?: unknown;
  /** What the source called the address, when it said anything at all. */
  address?: unknown;
  /**
   * A geocoder's formatted address. Deliberately last: it describes what the
   * provider MATCHED, which may be coarser than what the source told us.
   */
  formatted?: unknown;
}

/**
 * How far down the address the record actually reaches.
 *
 * `address` — a street number, so a rooftop is findable.
 * `street`  — a named street with no number: the right street, not the door.
 * `locality`— a suburb and nothing finer.
 * `none`    — nothing to place at all.
 */
export type AddressPrecision = 'address' | 'street' | 'locality' | 'none';

export interface ComposedAddress {
  /** The street line alone: `23/15 Smith Street`, `Smith Street`, or null. */
  street: string | null;
  /** Street plus locality, for display and for the geocoder. */
  full: string | null;
  /** Suburb, state and postcode, joined. Null when there is no locality. */
  locality: string | null;
  precision: AddressPrecision;
  /**
   * True when the street line came from the decomposed parts rather than from
   * a pre-formatted string. Recorded so a caller can tell a composed address
   * from an inherited one without re-deriving it.
   */
  fromParts: boolean;
}

/** `15 Smith Street`, `23/15 Smith Street`, `Smith Street`, or null. */
function streetFromParts(parts: AddressParts): string | null {
  const name = clean(parts.streetName);
  if (!name) return null;

  const type = clean(parts.streetType);
  const number = clean(parts.streetNumber);
  const unit = clean(parts.unitNumber);

  // `23/15 Smith Street` is the Australian form, and it needs both halves: a
  // unit with no street number cannot be written that way, so it is dropped
  // rather than rendered as a bare `23 Smith Street`, which would be a
  // different property.
  const numberPart = unit && number ? `${unit}/${number}` : number;

  return [numberPart, name, type].filter(Boolean).join(' ');
}

const AU_STATES = /\b(nsw|vic|qld|wa|sa|tas|act|nt)\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this string say anything beyond the locality?
 *
 * A `Full Address` of `Cobblebank VIC 3338, Australia` is the suburb written
 * out, and treating it as a street line is how a pin lands in the middle of a
 * suburb while the record knows the street.
 *
 * Comparing the leading segment to the suburb is not enough — the segment is
 * `Cowra NSW 2794`, not `Cowra`, so an equality test passes it through. What
 * settles it is subtraction: strike out the suburb, the state, the postcode
 * and the country, and see whether any words are left. Anything that survives
 * is street.
 */
function carriesAStreet(
  value: string,
  suburb: string | null,
  state: string | null,
  postcode: string | null,
): boolean {
  const head = value.split(',')[0].trim();
  if (!head) return false;

  let residue = head;
  for (const token of [suburb, state, postcode]) {
    if (!token) continue;
    residue = residue.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'gi'), ' ');
  }
  residue = residue
    .replace(/\baustralia\b/gi, ' ')
    .replace(AU_STATES, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  return residue.length > 0;
}

/**
 * Does this line open with a street number?
 *
 * `30 Callistemon Approach` and `23/15 Smith Street` do. `Lot 209 - 44
 * Satinwood Crescent` does not — a lot number is not a street number, and the
 * street number after it belongs to a lot that may not be registered yet.
 */
function leadsWithAStreetNumber(line: string): boolean {
  return /^\d+[a-z]?(\s*[-/]\s*\d+[a-z]?)?\s+\S/i.test(line.trim());
}

/**
 * Compose one address from whatever the record holds.
 *
 * The parts win. A pre-formatted string is used only where the parts cannot
 * supply a street, and never as evidence of precision it does not carry.
 */
export function composeListingAddress(parts: AddressParts): ComposedAddress {
  const suburb = clean(parts.suburb);
  const state = clean(parts.state);
  const postcode = clean(parts.postcode);
  const locality = [suburb, state, postcode].filter(Boolean).join(' ') || null;

  const fromParts = streetFromParts(parts);
  let street = fromParts;
  let usedParts = Boolean(fromParts);
  /** Whether the line we settled on is the source's own, not a geocoder's. */
  let sourceOwned = usedParts;

  if (!street) {
    // Nothing decomposed. Take the source's own line, then the geocoder's,
    // but only where either actually names a street.
    const sourceLine = clean(parts.address);
    for (const candidate of [sourceLine, clean(parts.formatted)]) {
      if (candidate && carriesAStreet(candidate, suburb, state, postcode)) {
        street = candidate;
        usedParts = false;
        sourceOwned = candidate === sourceLine;
        break;
      }
    }
  }

  /**
   * Precision follows the EVIDENCE, and the two inherited strings are not
   * equal evidence.
   *
   * `Address` is what the extraction model read out of the email, so
   * `30 Callistemon Approach` really does name a street number for this
   * property. A geocoder's `formatted_address` describes what the provider
   * MATCHED — a suburb-level answer can still carry digits (a postcode, a
   * range) — so it can never establish a street number, and treating it as if
   * it could is the class of mistake this whole module exists to stop.
   */
  let precision: AddressPrecision;
  if (fromParts && clean(parts.streetNumber)) precision = 'address';
  else if (street && sourceOwned && leadsWithAStreetNumber(street)) precision = 'address';
  else if (street) precision = 'street';
  else if (suburb) precision = 'locality';
  else precision = 'none';

  const full = [street, locality].filter(Boolean).join(', ') || null;

  return { street, full, locality, precision, fromParts: usedParts };
}

/**
 * The line a person reads. Never the bare suburb where a street is known, and
 * never an empty string — callers render it as a heading.
 */
export function displayAddressLine(parts: AddressParts): string | null {
  const composed = composeListingAddress(parts);
  return composed.full ?? clean(parts.formatted) ?? clean(parts.address);
}
