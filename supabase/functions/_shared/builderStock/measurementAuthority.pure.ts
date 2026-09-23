/**
 * ===========================================================================
 * BUILDER STOCK — WHICH PAGE'S LOT SIZE AND BUILD SIZE A BROCHURE MEANS.
 * ===========================================================================
 *
 * A builder's package brochure states the size of the land and of the house
 * on the property's own page, and very often states two more figures on a
 * page drawn for a different purpose. MEASURED 23 SEPTEMBER 2026 on the
 * production brochure `LOT 927 - ENZO 10.5 - BROCHURE V002.pdf`:
 *
 *   page 1   Package Price - $780,050
 *            Lot Size  294m²
 *            House Specifications … Total: 129.5m²
 *
 *   page 2   Proposed Siting of your ALTO Home
 *            Site Coverage: 42.5%
 *            Site Area:  309.45 m2
 *            Build Area: 131.6 m2
 *
 * Page 2 is a siting consultant's drawing. Its two areas are the operands of
 * the site coverage it prints (131.6 ÷ 309.45 is 42.53%), measured to the
 * surveyed boundary and to the outside of the walls. They are real figures,
 * and they are not the figures the builder is selling the property on: the
 * card read `LAND —` because 294 and 309.45 were treated as one statement
 * made twice that disagreed, and `HOME 132 m²` because the siting's labelled
 * `Build Area` outranked the house's own schedule. Both were wrong in the
 * builder's eyes, and both for the same reason — the reader gave a siting
 * sheet the same standing as the page that describes what is on offer.
 *
 * ===========================================================================
 * THE PAGE THAT PRICES THE PROPERTY IS THE PAGE THAT MEASURES IT.
 * ===========================================================================
 *
 * A package brochure has exactly one page that is about the property as a
 * product — the one that states what it costs — and that page's figures are
 * the builder's own statement of the land and the house. So a lot size or a
 * build size is settled in two tiers:
 *
 *   1. THE PROPERTY'S OWN PAGE — every page on which the document stated its
 *      price. If it states a figure, that figure stands. If it states two
 *      that disagree, the field is disputed and dropped exactly as before:
 *      the page disagreeing with itself is not something another page can
 *      settle, and choosing between them would be choosing.
 *
 *   2. EVERY OTHER PAGE — a siting plan, a specification sheet. Such a page
 *      may do two things and no others. It may REFINE the property's own
 *      figure where it states the same measurement to more decimals —
 *      `Lot Size 321m²` and `Site Area: 320.72 m²`, which is what the
 *      Lot 315 brochure prints and what `sameMeasurement` was written for —
 *      and it may FILL a figure the property's own page never states. It
 *      may never overrule one.
 *
 * For the house there is one more statement between the tiers: the
 * property's page may state the build size only as an area schedule (the
 * house's parts and their `Total`), which `areaSchedule.pure.ts` reads. That
 * schedule is the property's own statement, so it outranks a figure labelled
 * on any other page — and still ranks below a figure the property's page
 * LABELS as the build, which is the order `areaSchedule.pure.ts` has always
 * kept.
 *
 * A DOCUMENT THAT STATES NO PRICE HAS NO PROPERTY PAGE, and reads as it
 * always did: every statement in one tier, in document order — with one
 * correction. The reader's loop re-claimed a field on the statement after the
 * one that disputed it, so a third figure revived a size two others had
 * disputed, and page order chose. Here a dispute is final within its tier.
 *
 * WHAT WAS OUTRANKED IS SAID, NEVER SILENTLY DISCARDED. A field whose
 * property-page figure stood over a different figure elsewhere is named in
 * the reading's diagnostics (`outrankedFields`), by name only, so an import
 * log can say that the brochure's siting disagrees with its cover without
 * carrying either number.
 *
 * Pure: no IO, no clock, no network. The comparison of two written figures is
 * the reader's own (`sameValue`, `decimalsIn`), passed in rather than copied,
 * so this module can never come to disagree with the reader about when two
 * figures are one measurement.
 */

/** The two measurements this rule settles. Nothing else is tiered. */
export const MEASURED_FIELDS: ReadonlySet<string> = new Set([
  'land_size_sqm', 'building_size_sqm',
]);

/** One statement of a measurement, where the document made it. */
export interface MeasurementStatement<Via extends string = string> {
  field: string;
  /** Verbatim, as the document wrote it. */
  value: string;
  /** The reader that produced it, for the import log. */
  via?: Via;
  /** 0-based index of the page it was stated on. */
  page: number;
}

/** How two written figures compare. The reader's own rules, injected. */
export interface MeasurementComparison {
  /** Do `a` and `b` state one measurement (at the coarser one's precision)? */
  same(field: string, a: string, b: string): boolean;
  /** Is `a` written to more decimal places than `b`? */
  finer(a: string, b: string): boolean;
}

/** What one field settled to. */
export type MeasurementSettlement<Via extends string = string> =
  | { kind: 'none' }
  | { kind: 'disputed' }
  | {
    kind: 'read';
    value: string;
    via?: Via;
    /** Another page stated a DIFFERENT figure, and this one stood over it. */
    outranked: boolean;
  };

interface Reading<Via extends string> {
  value: string;
  via?: Via;
}

/**
 * One tier's statements, reduced in document order by the reader's
 * long-standing rule: the first figure is taken, a figure that agrees and is
 * written more precisely replaces it, and a figure that disagrees disputes
 * the field FOR GOOD — a third statement never revives a field two others
 * disputed, because keeping whichever came last is choosing by page order.
 */
function reduceTier<Via extends string>(
  field: string,
  statements: readonly MeasurementStatement<Via>[],
  compare: MeasurementComparison,
): Reading<Via> | 'disputed' | null {
  let reading: Reading<Via> | null = null;
  for (const statement of statements) {
    if (!reading) {
      reading = { value: statement.value, via: statement.via };
      continue;
    }
    if (!compare.same(field, reading.value, statement.value)) return 'disputed';
    if (compare.finer(statement.value, reading.value)) {
      // The finer writing of the same measurement; the reader that found the
      // measurement first keeps its name, as the reader always has.
      reading = { value: statement.value, via: reading.via };
    }
  }
  return reading;
}

/**
 * The property's own figure, refined by what other pages say about THE SAME
 * measurement and never overruled by what they say about a different one.
 *
 * Each other statement is compared with the property's figure — never with
 * one another in turn, which would let page order decide. A refinement is
 * taken only where every refining statement agrees with every other; two
 * siting figures that agree with `402` and disagree with each other in a
 * digit `402` does not state are not the property page's to choose between,
 * and the property's own figure stands as written.
 */
function refineFromOtherPages<Via extends string>(
  field: string,
  own: Reading<Via>,
  others: readonly MeasurementStatement<Via>[],
  compare: MeasurementComparison,
): { reading: Reading<Via>; outranked: boolean } {
  const refining: MeasurementStatement<Via>[] = [];
  let outranked = false;
  for (const statement of others) {
    if (!compare.same(field, own.value, statement.value)) {
      outranked = true;
      continue;
    }
    if (compare.finer(statement.value, own.value)) refining.push(statement);
  }
  if (!refining.length) return { reading: own, outranked };
  const consistent = refining.every((a) =>
    refining.every((b) => compare.same(field, a.value, b.value)));
  if (!consistent) return { reading: own, outranked };
  const finest = refining.reduce((best, next) =>
    compare.finer(next.value, best.value) ? next : best);
  return { reading: { value: finest.value, via: own.via }, outranked };
}

/**
 * Settle one measured field.
 *
 * `statements` in document order. `pricePages` are the pages on which the
 * document stated its price. `propertySchedule` is the house's area schedule
 * total as the property's own page states it — asked for the building size
 * only, lazily, and only where the property's page labelled no build size.
 */
export function settleMeasurement<Via extends string>(input: {
  field: string;
  statements: readonly MeasurementStatement<Via>[];
  pricePages: ReadonlySet<number>;
  compare: MeasurementComparison;
  propertySchedule?: () => { value: string; via: Via } | null;
}): MeasurementSettlement<Via> {
  const { field, compare } = input;
  const statements = input.statements.filter((statement) => statement.field === field);

  /*
   * NO PROPERTY PAGE, NO TIERS: the document reads as it always has.
   */
  if (!input.pricePages.size) {
    const reading = reduceTier(field, statements, compare);
    if (reading === 'disputed') return { kind: 'disputed' };
    if (!reading) return { kind: 'none' };
    return { kind: 'read', value: reading.value, via: reading.via, outranked: false };
  }

  const own = statements.filter((statement) => input.pricePages.has(statement.page));
  const others = statements.filter((statement) => !input.pricePages.has(statement.page));

  const stated = reduceTier(field, own, compare);
  if (stated === 'disputed') return { kind: 'disputed' };

  let authority: Reading<Via> | null = stated;
  if (!authority && input.propertySchedule) {
    const schedule = input.propertySchedule();
    if (schedule) authority = { value: schedule.value, via: schedule.via };
  }
  if (authority) {
    const { reading, outranked } = refineFromOtherPages(field, authority, others, compare);
    return { kind: 'read', value: reading.value, via: reading.via, outranked };
  }

  /*
   * THE PROPERTY'S PAGE SAID NOTHING, so the rest of the document is the
   * only statement there is, and it is read by the ordinary rule.
   */
  const filled = reduceTier(field, others, compare);
  if (filled === 'disputed') return { kind: 'disputed' };
  if (!filled) return { kind: 'none' };
  return { kind: 'read', value: filled.value, via: filled.via, outranked: false };
}
