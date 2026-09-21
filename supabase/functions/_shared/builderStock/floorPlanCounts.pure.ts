/**
 * BUILDER STOCK — THE PLAN NAMES THE ROOMS, SO THE ROW CAN BE READ.
 *
 * THE PROBLEM, STATED EXACTLY. A brochure prints its configuration as three
 * bare numbers beside bed, bath and car ICONS — `3 2.5 1`. The icons are
 * images, so the document's TEXT states which numbers the property has and
 * never which is which. Assuming the conventional order wrote `bathrooms: 9`
 * onto a real property on 21 September 2026, and this module exists so that
 * nothing here ever assumes it again.
 *
 * WHAT WAS BEING OVERLOOKED. A spreadsheet import reads every figure without
 * difficulty, because each value sits under an explicit HEADING. A floor plan
 * is the same shape: it labels `BED 1`, `BED 2`, `MASTER`, `BATH`, `ENS`,
 * `GARAGE`. Those are headings too. `bedroomsNamedOn` already found them —
 * and used them only to CHECK the icon row, never as the evidence that reads
 * it.
 *
 * SO THE ROW SUPPLIES THE VALUES AND THE PLAN PROVES THE POSITIONS. Three
 * numbers onto three fields is six possible assignments; the plan's own
 * counts and one hard fact eliminate them until exactly one survives, and
 * where more than one survives nothing is claimed. There is no convention in
 * it and no model.
 *
 * THE HARD FACT: only a bathroom count is ever written as a fraction. A
 * property has 2.5 bathrooms; it never has 2.5 bedrooms or 2.5 car spaces.
 * `COUNT_VALUE` has admitted `.5` since it was written, and this is what that
 * admission is FOR. On `3 2.5 1` that single constraint binds the middle
 * position outright.
 *
 * WHY A WRONG HEURISTIC HERE CANNOT PRODUCE A WRONG FIGURE. The plan's counts
 * are never written to the record — they are only ever compared against the
 * row the document printed. A miscounted bathroom simply fails to match, the
 * assignment stays ambiguous, and the fields are left unread exactly as they
 * are today. The failure mode is silence, which is this module's whole safety
 * argument: it can add certainty and it cannot add error.
 *
 * AND THE LABELS CARRY DIMENSIONS. `BEDROOM_LABEL` was anchored at both ends
 * — `/^(?:bed|bedroom)\s*\d{1,2}$/` — so it matched a bare `BED 2` and missed
 * `BED 2  3.0 x 3.1`, which is how nearly every plan is actually drawn. The
 * patterns here match the label where it STARTS a unit, so a room named with
 * its dimensions beside it is still a room named.
 *
 * Pure: no IO, no clock, no network.
 */

/** A unit of page text, as the brochure reader produces them. */
export interface PlanUnit { text: string }

/**
 * The three fields a configuration row states, in the order this module
 * reports them. The ORDER HERE IS NOT A CLAIM ABOUT ANY DOCUMENT — it is the
 * order of the answer, and which position of the row fills which is decided
 * per document below.
 */
export const COUNT_FIELD_NAMES = ['bedrooms', 'bathrooms', 'car_spaces'] as const;
export type CountField = typeof COUNT_FIELD_NAMES[number];

/**
 * ROOM LABELS, MATCHED WHERE THEY START A UNIT.
 *
 * Each requires a word boundary after the label so `BEDDING` is not a bedroom
 * and `BATHROOM SELECTIONS` — a marketing heading — is not a bathroom.
 */
const BEDROOM_NUMBERED = /^(?:bed|bedroom)\s*(\d{1,2})\b/i;
const BEDROOM_MASTER = /^master(?:\s+(?:bed|bedroom|suite))?\b/i;
const BATHROOM_LABEL = /^(?:bath|bathroom|ens|ensuite|en-suite)\b/i;
const POWDER_LABEL = /^(?:powder|wc|w\.c\.)\b/i;
const CAR_NUMBERED = /^(?:car|carspace|car\s+space|bay)\s*(\d{1,2})\b/i;

/**
 * A label that is a heading ABOUT rooms rather than a room.
 *
 * A brochure's inclusions page prints `BATHROOM` over a list of taps and
 * tiles, and counting that as a bathroom is how a plan's count stops matching
 * the row it is meant to interpret.
 */
const ROOM_LABEL_SUFFIX_EXCLUSIONS =
  /\b(?:selections?|inclusions?|schedule|specifications?|finishes|options?)\b/i;

export interface PlanRoomCounts {
  /** Distinct bedrooms the plan names, or null where it names none. */
  bedrooms: number | null;
  /** Distinct bathing rooms the plan names, or null where it names none. */
  bathrooms: number | null;
  /**
   * Car spaces the plan names INDIVIDUALLY, or null.
   *
   * Almost always null, and deliberately: a plan draws one `GARAGE` whether it
   * holds one car or three, so the label cannot count them. `CAR 1` / `CAR 2`
   * can, and where a plan writes those they are counted. Everything else
   * leaves this null and the position is settled by elimination.
   */
  carSpaces: number | null;
  /** Whether the plan named a powder room, which is half a bathroom here. */
  powderRooms: number;
}

/**
 * Count the rooms a document's floor plan names.
 *
 * DISTINCT BY NAME, ACROSS THE WHOLE DOCUMENT. A brochure prints its plan
 * once and its dimensions table again, so `BED 2` appearing twice is one
 * bedroom. `MASTER` and `BED 1` are different names and both count.
 */
export function countRoomsNamed(units: ReadonlyArray<PlanUnit>): PlanRoomCounts {
  const bedrooms = new Set<string>();
  const bathrooms = new Set<string>();
  const cars = new Set<string>();
  let powder = 0;
  const powderSeen = new Set<string>();

  for (const unit of units) {
    const text = String(unit?.text ?? '').trim();
    if (!text) continue;
    if (ROOM_LABEL_SUFFIX_EXCLUSIONS.test(text)) continue;

    const bed = BEDROOM_NUMBERED.exec(text);
    if (bed) { bedrooms.add(`bed${bed[1]}`); continue; }
    if (BEDROOM_MASTER.test(text)) { bedrooms.add('master'); continue; }

    const car = CAR_NUMBERED.exec(text);
    if (car) { cars.add(`car${car[1]}`); continue; }

    if (POWDER_LABEL.test(text)) {
      const key = text.toLowerCase().replace(/\s+/g, '').slice(0, 12);
      if (!powderSeen.has(key)) { powderSeen.add(key); powder += 1; }
      continue;
    }
    if (BATHROOM_LABEL.test(text)) {
      /*
       * KEYED ON THE LABEL AND NOT THE WHOLE UNIT, because the dimensions
       * beside it differ between the plan and the dimensions table and would
       * make one room count as two.
       */
      const label = text.toLowerCase().replace(/\s+/g, '');
      const key = /^ens/.test(label) ? `ens${label.slice(3, 5)}` : `bath${label.slice(4, 6)}`;
      bathrooms.add(key);
      continue;
    }
  }

  return {
    bedrooms: bedrooms.size ? bedrooms.size : null,
    bathrooms: bathrooms.size ? bathrooms.size : null,
    carSpaces: cars.size ? cars.size : null,
    powderRooms: powder,
  };
}

/** Is this value one only a bathroom count can take? */
function isFractional(value: number): boolean {
  return !Number.isInteger(value);
}

/**
 * What the plan says a field should be, as the numbers that would match.
 *
 * A bathroom count is offered BOTH with and without the powder room, because
 * whether a builder prints `2` or `2.5` for two bathrooms and a powder room
 * is that builder's house style and not something to be decided here. Both
 * are candidate readings of the same plan, and a row matching either one
 * binds the position; a row matching neither binds nothing.
 */
function expectedFor(field: CountField, plan: PlanRoomCounts): number[] | null {
  if (field === 'bedrooms') return plan.bedrooms === null ? null : [plan.bedrooms];
  if (field === 'car_spaces') return plan.carSpaces === null ? null : [plan.carSpaces];
  /*
   * A PLAN'S BATHROOM COUNT IS NOT EVIDENCE, AND THIS IS THE CORRECTION THAT
   * MATTERS MOST HERE.
   *
   * Bedrooms are numbered — `BED 1`, `BED 2`, `MASTER` — so counting the
   * distinct names counts the rooms. Bathing rooms are not: a plan writes
   * `BATH`, `ENS`, `ENSUITE`, `POWDER`, `WC`, sometimes `BATH 1` and `BATH 2`,
   * sometimes nothing at all where the room is drawn without a caption. A
   * three-bedroom home printing `3 2 1` beside a plan this module reads as ONE
   * bathroom would then be bound as one bathroom and two car spaces — a
   * confident figure, wrong, and produced by exactly the kind of assumption
   * this module exists to refuse. Found by the brochure corpus on the first
   * run, which is what that corpus is for.
   *
   * So the count is still taken — it is reported, and it is worth seeing —
   * and it constrains NOTHING. What constrains the row is the bedroom count,
   * which is countable, and the fraction, which is a fact about notation.
   */
  return null;
}

/** The six ways three fields can sit on three positions. */
const ASSIGNMENTS: CountField[][] = [
  ['bedrooms', 'bathrooms', 'car_spaces'],
  ['bedrooms', 'car_spaces', 'bathrooms'],
  ['bathrooms', 'bedrooms', 'car_spaces'],
  ['bathrooms', 'car_spaces', 'bedrooms'],
  ['car_spaces', 'bedrooms', 'bathrooms'],
  ['car_spaces', 'bathrooms', 'bedrooms'],
];

export interface BoundCounts {
  bedrooms: number;
  bathrooms: number;
  car_spaces: number;
  /** How the single surviving assignment was reached, for the import log. */
  evidence: string[];
}

/**
 * Read a configuration row using the plan as the key.
 *
 * Every one of the six assignments is tested against the evidence and the
 * answer is returned ONLY where exactly one survives. Two survivors is the
 * document declining to say which number is which, and this returns null —
 * which is today's behaviour and the state the icon row was already left in.
 *
 * THE EVIDENCE, AND NOTHING ELSE IS USED:
 *
 *   • A FRACTIONAL VALUE IS A BATHROOM COUNT. Nothing else here can be
 *     written with a half.
 *   • A FIELD THE PLAN COUNTED MUST SIT ON A POSITION HOLDING THAT COUNT.
 *     Where the plan counted nothing for a field, that field is unconstrained
 *     and is settled only by what the other two force.
 *
 * There is no tie-break, no preference and no default ordering: a row this
 * cannot determine is not determined.
 */
export function bindCountRow(
  row: ReadonlyArray<number>,
  plan: PlanRoomCounts,
): BoundCounts | null {
  if (row.length !== COUNT_FIELD_NAMES.length) return null;
  if (!row.every((value) => Number.isFinite(value))) return null;

  const evidence: string[] = [];
  const survivors = ASSIGNMENTS.filter((assignment) => assignment.every((field, at) => {
    const value = row[at];
    // Only a bathroom may be a fraction, and a fraction may only be a bathroom.
    if (isFractional(value) && field !== 'bathrooms') return false;
    const expected = expectedFor(field, plan);
    if (expected === null) return true;
    return expected.includes(value);
  }));

  if (!survivors.length) return null;

  /*
   * WHAT MUST BE DETERMINED IS THE FIGURES, NOT THE LABELLING.
   *
   * Requiring exactly one surviving assignment was too strict, and the case
   * that shows it is ordinary: `4 2 2` against a plan naming four bedrooms
   * and two bathrooms leaves two assignments standing, because a `2` sits in
   * both of the remaining positions. They disagree about which printed `2` is
   * the bathroom count and they agree exactly about the ANSWER — two
   * bathrooms and two car spaces — so the row is read, not refused.
   *
   * The test is therefore agreement on the values every survivor produces. A
   * genuine ambiguity — two survivors that would write different figures —
   * still claims nothing.
   */
  const readings = survivors.map((assignment) => ({
    bedrooms: row[assignment.indexOf('bedrooms')],
    bathrooms: row[assignment.indexOf('bathrooms')],
    car_spaces: row[assignment.indexOf('car_spaces')],
  }));
  const first = readings[0];
  const agree = readings.every((reading) =>
    reading.bedrooms === first.bedrooms
    && reading.bathrooms === first.bathrooms
    && reading.car_spaces === first.car_spaces);
  if (!agree) return null;
  const order = survivors[0];

  if (row.some(isFractional)) evidence.push('fraction_is_bathrooms');
  for (const field of COUNT_FIELD_NAMES) {
    if (expectedFor(field, plan) !== null) evidence.push(`plan_named_${field}`);
  }
  /*
   * A SOLUTION WITH NO EVIDENCE AT ALL IS NOT A SOLUTION. Six assignments
   * cannot reduce to one on nothing, so this cannot fire — and it is asserted
   * rather than reasoned about, because a future constraint that stops
   * constraining would otherwise let the natural order through silently.
   */
  if (!evidence.length) return null;

  const at = (field: CountField) => row[order.indexOf(field)];
  return {
    bedrooms: at('bedrooms'),
    bathrooms: at('bathrooms'),
    car_spaces: at('car_spaces'),
    evidence,
  };
}

/**
 * And the bedrooms a plan names, where the document prints no row at all.
 *
 * THE ONE FIGURE A PLAN STATES OUTRIGHT. Distinct numbered bedrooms plus a
 * master is a direct count of named rooms, the same kind of reading as a
 * spreadsheet column — no position and no convention. Bathrooms and car
 * spaces are deliberately NOT offered here: whether a powder room is half a
 * bathroom is a house style, and a garage names no number of cars at all, so
 * without a row to check against there is nothing to make either safe.
 */
export function bedroomsFromPlan(plan: PlanRoomCounts): number | null {
  return plan.bedrooms;
}
