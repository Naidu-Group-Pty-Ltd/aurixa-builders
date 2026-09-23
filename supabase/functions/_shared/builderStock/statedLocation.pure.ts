/**
 * WHERE A PROPERTY IS, AS ITS BUILDER STATES IT.
 *
 * A package brochure can name its lot and its estate and nothing else.
 * `Lot 101 - PICO - BROCHURE v002.pdf` is the one that sent this here: its
 * whole location is the line `Lot 101 Watsons Reach Estate`, its only land
 * figure is a price, and its own small print says "it is not the actual lot
 * for sale … refer to contract drawings and site plans". Every page was read
 * and every picture recognised; there is no street, suburb, state or postcode
 * anywhere in it. No reader can recover a fact a document does not carry, so
 * the card said `Lot 101, Watsons Reach Estate` and no marketplace could place
 * it — the clone's address composer keeps an estate name and never geocodes
 * it, correctly, because an estate is a marketing name rather than a place.
 *
 * The builder knows where their lot is. This is how they say so.
 *
 * ## It is `manualStats.pure.ts`'s rule, applied to a place
 *
 * **THE STATEMENT LIVES WHERE A RE-READ CANNOT REACH IT.** `address_line`,
 * `suburb`, `state` and `postcode` are in `importStock.ts`'s
 * `UNSAYABLE_ON_REREAD`: a same-source re-read that states nothing sets them
 * to NULL, and the reader sweep re-reads every upload whenever the reader's
 * version moves. An address typed into those columns would therefore be erased
 * by the next reader release, with nothing reporting it. So the statement is
 * stored in `manual_stats.values` beside the builder's figures, a column the
 * patch does not name, and laid over the document on READ.
 *
 * **IT IS A CORRECTION, NOT A REPLACEMENT RECORD.** Each part stands alone and
 * is absent when unstated, so a builder may state only the suburb and state
 * and keep the document's street. Clearing a part gives the document its
 * reading back. The document's own reading is never overwritten: it stays in
 * its column, and `stated_*` carries it beside the effective value so the
 * dialog can show the builder what they are replacing.
 *
 * **ONE AUTHORITY FOR WHAT IS ACCEPTED.** The dialog, the edge function and
 * the column's CHECK all apply the rules here: the state is one of the eight
 * the column already admits, the postcode is four digits as the column already
 * requires, and a value that fails is REFUSED rather than cleaned into
 * something nobody typed.
 *
 * This module is the network's alone. A clone never reads a stated location:
 * the payload composer (`builder_network_compose_stock_item_payload`) sends
 * the EFFECTIVE address in the ordinary columns, so every clone surface — the
 * card, the locality line, the geocoder that places a pin, the state filter
 * and the search — sees the builder's statement with no change of its own.
 * `manualStats.pure.ts` stays byte-identical to the clone's copy, and reads
 * only the five figures from the same `values` object.
 *
 * Pure: no Deno, no DOM, no network.
 */

/** A part of a property's location a builder may state. */
export type StatedLocationField = 'address_line' | 'suburb' | 'state' | 'postcode';

export interface StatedLocationSpec {
  readonly field: StatedLocationField;
  /** What the builder is asked for. */
  readonly label: string;
  /** The same part inside a sentence. */
  readonly prose: string;
  /** The longest value accepted, after spaces are collapsed. */
  readonly maxLength: number;
}

/**
 * The four parts, in the order an Australian address is written.
 *
 * The lot is deliberately absent. It is half of the key a re-import finds a
 * property by (`stockMatchKeys`, the development/lot/design key), so a builder
 * restating it here could orphan the property from its own stock list; it is
 * also already read from every document this pipeline has seen.
 */
export const STATED_LOCATION_SPECS: readonly StatedLocationSpec[] = [
  { field: 'address_line', label: 'Street address', prose: 'street address', maxLength: 120 },
  { field: 'suburb', label: 'Suburb', prose: 'suburb', maxLength: 60 },
  { field: 'state', label: 'State', prose: 'state', maxLength: 3 },
  { field: 'postcode', label: 'Postcode', prose: 'postcode', maxLength: 4 },
] as const;

export const STATED_LOCATION_FIELDS: readonly StatedLocationField[] =
  STATED_LOCATION_SPECS.map((spec) => spec.field);

/**
 * The eight the `builder_stock_items_state_check` constraint admits, and the
 * only spellings stored. A builder may type `Victoria` or `vic`; what is kept
 * is `VIC`, because that is what every reader of the column compares against.
 */
export const STATED_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const;

const STATE_BY_NAME: Record<string, string> = {
  act: 'ACT', australiancapitalterritory: 'ACT',
  nsw: 'NSW', newsouthwales: 'NSW',
  nt: 'NT', northernterritory: 'NT',
  qld: 'QLD', queensland: 'QLD',
  sa: 'SA', southaustralia: 'SA',
  tas: 'TAS', tasmania: 'TAS',
  vic: 'VIC', victoria: 'VIC',
  wa: 'WA', westernaustralia: 'WA',
};

/** Only the parts a builder actually stated. A missing key means the document stands. */
export type StatedLocation = Partial<Record<StatedLocationField, string>>;

export interface StatedLocationParse {
  location: StatedLocation;
  /** One per refused part, in address order, addressed to the builder. */
  errors: Array<{ field: StatedLocationField; message: string }>;
}

/** Collapse runs of whitespace; the form sends whatever was typed. */
function tidy(raw: unknown): string {
  return String(raw).normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Letters and digits in any script, and the punctuation an address is written
// with: `13/15 Rose Street`, `Unit 2, 4-6 O'Connor Place`, `Lot 1 (Stage 3)`.
const ADDRESS_CHARACTERS = /^[\p{L}\p{M}\p{N} ,.'’\-/&#()]+$/u;
// A suburb is a name: `Diggers Rest`, `Tweed Heads South`, `O'Connor`,
// `St Kilda`. It carries no digit — a number there is a postcode or a lot
// typed into the wrong box, and refusing it says so.
const SUBURB_CHARACTERS = /^\p{L}[\p{L}\p{M} .'’\-]*$/u;
const HAS_LETTER = /\p{L}/u;

/**
 * Read one part. `null` is "not stated"; a string is the value to store; an
 * `{ error }` is a refusal naming the part.
 */
function readPart(
  spec: StatedLocationSpec,
  raw: unknown,
): { value: string } | { error: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `${spec.label} must be text.` };
  }
  const value = tidy(raw);
  if (value === '') return null;

  switch (spec.field) {
    case 'address_line': {
      if (value.length < 3 || value.length > spec.maxLength) {
        return { error: `${spec.label} must be between 3 and ${spec.maxLength} characters.` };
      }
      if (!HAS_LETTER.test(value) || !ADDRESS_CHARACTERS.test(value)) {
        return {
          error: `${spec.label} may contain letters, numbers, spaces and , . ' - / & # ( ) only.`,
        };
      }
      return { value };
    }
    case 'suburb': {
      if (value.length < 2 || value.length > spec.maxLength) {
        return { error: `${spec.label} must be between 2 and ${spec.maxLength} characters.` };
      }
      if (!SUBURB_CHARACTERS.test(value)) {
        return { error: `${spec.label} must be a place name, with no numbers.` };
      }
      return { value };
    }
    case 'state': {
      const canonical = STATE_BY_NAME[value.toLowerCase().replace(/[^a-z]/g, '')];
      if (!canonical) {
        return { error: `${spec.label} must be one of ${STATED_STATES.slice(0, -1).join(', ')} or ${STATED_STATES[STATED_STATES.length - 1]}.` };
      }
      return { value: canonical };
    }
    case 'postcode': {
      if (!/^\d{4}$/.test(value)) return { error: `${spec.label} must be four digits.` };
      return { value };
    }
  }
}

/**
 * Read whatever a client sent into a stated location.
 *
 * An empty string, null or an absent key all mean "this part is not stated",
 * which is how a builder takes a correction back. A value that breaks a rule
 * is refused with a message naming the part; nothing is clamped, truncated or
 * guessed, because a card showing a suburb nobody typed is worse than one
 * showing none.
 */
export function parseStatedLocation(input: unknown): StatedLocationParse {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const location: StatedLocation = {};
  const errors: StatedLocationParse['errors'] = [];
  for (const spec of STATED_LOCATION_SPECS) {
    const part = readPart(spec, source[spec.field]);
    if (part === null) continue;
    if ('error' in part) {
      errors.push({ field: spec.field, message: part.error });
      continue;
    }
    location[spec.field] = part.value;
  }
  return errors.length ? { location: {}, errors } : { location, errors };
}

/**
 * Read a stored statement back from `manual_stats`, ignoring anything that is
 * not a valid part.
 *
 * Defensive for the reason `readManualStats` is: this is JSONB, and a value
 * that would be refused on the way in is not trusted on the way out. The
 * column's CHECK holds the same rules, so in practice this drops nothing.
 */
export function readStatedLocation(storedManualStats: unknown): StatedLocation | null {
  if (!storedManualStats || typeof storedManualStats !== 'object') return null;
  const values = (storedManualStats as Record<string, unknown>).values;
  if (!values || typeof values !== 'object') return null;
  const location: StatedLocation = {};
  for (const spec of STATED_LOCATION_SPECS) {
    const raw = (values as Record<string, unknown>)[spec.field];
    if (typeof raw !== 'string') continue;
    const part = readPart(spec, raw);
    if (part && 'value' in part) location[spec.field] = part.value;
  }
  return Object.keys(location).length ? location : null;
}

/** A projected stock row, in the only shape this module needs to know about. */
type LocationRow = Record<string, unknown> & { manual_stats?: unknown };

/**
 * Lay a builder's stated location over what the document said.
 *
 * MUST RUN BEFORE `applyManualStats`, which rewrites `manual_stats` to the
 * five figures and nothing else. The effective parts replace the columns; the
 * document's own reading of each replaced part rides on `stated_*`, the
 * convention the figures already use; and `manual_location` carries the
 * builder's statement itself, which is what the dialog is seeded from.
 */
export function applyStatedLocation<T extends LocationRow>(row: T): T {
  const location = readStatedLocation(row.manual_stats);
  if (!location) return { ...row, manual_location: null } as T;
  const next: LocationRow = { ...row, manual_location: location };
  for (const field of STATED_LOCATION_FIELDS) {
    const value = location[field];
    if (value === undefined) continue;
    next[`stated_${field}`] = row[field] ?? null;
    next[field] = value;
  }
  return next as T;
}

/** Which parts a builder stated on this row. */
export function statedLocationFields(row: LocationRow): StatedLocationField[] {
  const location = readStatedLocation(row.manual_stats)
    ?? (row.manual_location && typeof row.manual_location === 'object'
      ? readStatedLocation({ values: row.manual_location })
      : null);
  if (!location) return [];
  return STATED_LOCATION_FIELDS.filter((field) => location[field] !== undefined);
}
