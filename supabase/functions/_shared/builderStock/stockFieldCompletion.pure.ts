/**
 * BUILDER STOCK — THE GAPS GO TO THE MODEL, NOT THE DOCUMENT.
 *
 * WHY THIS EXISTS, AND WHY THE PREVIOUS ANSWER WAS A TREADMILL.
 *
 * The deterministic reader reads a brochure by recognising the WORDS it uses
 * to label its facts. That is what makes it trustworthy and it is also its
 * ceiling: a template that states something in words it has not learned
 * yields nothing for that field, and the remedy was to teach it those words —
 * once per template family, for ever, as builders add designs.
 *
 * MEASURED, 21 SEPTEMBER 2026, across every property this deployment holds:
 *
 *   brochure          addr  price  beds  baths  cars  home  land
 *   LOT 805 NEX 20     Y     -      -     -      -     Y     -
 *   LOT 309 NEX 20     Y     -      -     -      -     Y     -
 *   LOT 717 ENZO       Y     Y      -     -      -     Y     -
 *   LOT 315 ENZO       Y     Y      -     -      -     Y     Y
 *   LOT 36  ZIMI       -     Y      Y     Y      Y     Y     Y
 *   LOT 40  ZIMI       -     Y      -     -      -     Y     Y
 *
 * Bedrooms, bathrooms and car spaces are absent on SEVEN OF EIGHT, and the
 * gaps do not agree between families: the NEX 20 has an address and no price,
 * the ZIMI has a price and no address. A marketplace card drawn from that is
 * inconsistent property to property, which is what a reader notices first.
 *
 * AND THE COUNTS ARE NOT A VOCABULARY GAP AT ALL. The brochure prints
 * `3 2.5 1` beside bed, bath and car ICONS, and an icon is an image — so the
 * TEXT says which numbers the property has and never which is which.
 * Assuming the conventional order is what wrote `bathrooms: 9` onto a real
 * property earlier the same day. `readIconCountRow` therefore accepts the row
 * only where the floor plan NAMES its bedrooms as text, which is true of the
 * ZIMI flyer and of nothing else here. No amount of vocabulary fixes that.
 *
 * SO THE SHAPE OF THE FIX CHANGES. The deterministic reader stops being the
 * only reader of the document and starts being the AUTHORITY over it: it
 * reads what it can prove, and what is still missing is asked of the model as
 * a SHORT LIST OF NAMED FIELDS rather than by handing over the document and
 * starting again. That is general by construction — it needs nothing to be
 * known in advance about any template — and it keeps the ordering this
 * product now insists on: deterministic first, the model last, and only for
 * the residue.
 *
 * FOUR RULES CARRY IT.
 *
 *   • A COMPLETION MAY ONLY FILL AN ABSENCE. `mergeCompletion` never writes
 *     over a value the deterministic reader claimed — not to correct it, not
 *     to reformat it. The reader saw the label; the model did not.
 *   • IDENTITY IS NEVER COMPLETED. `COMPLETABLE_FIELDS` excludes the lot, the
 *     unit, the builder's reference, the estate and the design. Those decide
 *     WHICH property a row is and what it is matched against on re-import, so
 *     a model supplying one could merge two properties or split one in half.
 *     What may be completed is what a card DISPLAYS.
 *   • ONE PROPERTY, BOTH SIDES. A completion is merged only where the
 *     deterministic reading found exactly one property and the model returned
 *     exactly one. Two rows on either side is a schedule, the table reader
 *     owns those, and pairing rows across two readings by position is how a
 *     price lands on the wrong lot.
 *   • AND IT IS RECORDED AS COMPLETED. Every field this fills is named in the
 *     import's own telemetry line, so a thin record and a completed one are
 *     never the same thing to anybody reading back.
 *
 * Pure: no IO, no clock, no network.
 */

/**
 * What a marketplace card draws, and therefore what an incomplete record is
 * incomplete IN.
 *
 * Taken from the card rather than from the table: a column nothing renders is
 * not a gap a reader can see, and spending a model call on one is spend with
 * no visible return.
 */
export const VITAL_FIELDS: readonly string[] = [
  'price',
  'bedrooms',
  'bathrooms',
  'car_spaces',
  'building_size_sqm',
  'land_size_sqm',
  'address_line',
];

/**
 * The fields a completion may write, which is NOT the same list.
 *
 * `address_line` is vital and completable — it is what a card shows and a
 * model filling it cannot change which property the row is, because matching
 * is by lot and development. Everything that DOES decide identity is absent
 * from here by name, so a future field added to `VITAL_FIELDS` cannot become
 * completable by accident.
 */
export const COMPLETABLE_FIELDS: readonly string[] = [
  'price',
  'bedrooms',
  'bathrooms',
  'car_spaces',
  'building_size_sqm',
  'land_size_sqm',
  'address_line',
];

/**
 * Identity and classification the deterministic reader owns outright.
 *
 * Named rather than merely omitted, so the rule is legible and a test can
 * assert the two lists do not overlap.
 */
export const NEVER_COMPLETED_FIELDS: readonly string[] = [
  'lot_number',
  'unit_number',
  'external_reference',
  'development_name',
  'house_design',
  'suburb',
  'state',
  'postcode',
];

/** Is this value one the reader actually has? */
function isHeld(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

/**
 * Which of the card's fields this row cannot fill.
 *
 * Keyed on the RAW row the readers produce, before `normaliseStockRow`, so a
 * caller asks the same question of a deterministic reading and of a model's.
 */
export function missingVitalFields(row: Record<string, unknown>): string[] {
  return VITAL_FIELDS.filter((field) => !isHeld(row?.[field]));
}

/** Is there anything here worth asking a model for? */
export function completionWorthAsking(row: Record<string, unknown>): boolean {
  return missingVitalFields(row).some((field) => COMPLETABLE_FIELDS.includes(field));
}

export interface CompletionOutcome {
  /** The row to import: the reading, plus the absences a completion filled. */
  row: Record<string, unknown>;
  /** Canonical names of the fields the completion supplied. */
  completed: string[];
}

/**
 * Fill this reading's absences from a model's reading of the same document.
 *
 * ADDITIVE ONLY, BY CONSTRUCTION. The base row is copied and a field is
 * written only where the base does not hold one AND the field is completable
 * AND the completion actually holds a value. There is no branch that replaces
 * anything, which is what makes "the deterministic reader is the authority" a
 * property of this function rather than a promise about its callers.
 */
export function mergeCompletion(
  base: Record<string, unknown>,
  completion: Record<string, unknown> | null | undefined,
): CompletionOutcome {
  const row: Record<string, unknown> = { ...base };
  const completed: string[] = [];
  if (!completion) return { row, completed };

  for (const field of COMPLETABLE_FIELDS) {
    if (isHeld(row[field])) continue;
    const supplied = completion[field];
    if (!isHeld(supplied)) continue;
    row[field] = supplied;
    completed.push(field);
  }
  return { row, completed: completed.sort() };
}

/**
 * May these two readings be merged at all?
 *
 * ONE PROPERTY ON BOTH SIDES. A brochure states one property and both readers
 * should say so; anything else is a schedule, which the table reader owns and
 * which has no ambiguity to resolve. Pairing rows across two readings by
 * position is how a price lands on the wrong lot, and there is no key to pair
 * them by — the model is not given the lot and must not be.
 */
export function completionMayMerge(
  deterministicRows: ReadonlyArray<unknown>,
  completionRows: ReadonlyArray<unknown>,
): boolean {
  return deterministicRows.length === 1 && completionRows.length === 1;
}
