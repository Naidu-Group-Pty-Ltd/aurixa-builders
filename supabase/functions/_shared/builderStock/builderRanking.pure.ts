/**
 * WHICH BUILDER'S STOCK AN ADVISER SEES FIRST.
 *
 * The Builders Network is a multi-vendor marketplace: one builder's forty-unit
 * development exists once, and every Aurixa workspace — the prime and every
 * clone — draws the same stock from the same network. Until this module the
 * marketplace answered that question with `ORDER BY created_at DESC`. Newest
 * first is not an answer; it is the absence of one, and in a marketplace the
 * absence of an answer is itself a policy — it rewards whoever uploaded most
 * recently and tells a builder nothing they can act on.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a SORT. It never removes a property from the marketplace, never blanks
 * a card, and never decides that stock may not be sold. The single exception is
 * an operator's explicit `suppress`, which is a recorded human act with a
 * reason and an expiry — not something an algorithm may arrive at on its own.
 * That is the same rule the image ordering already answers to: demotion is a
 * sort, never a filter.
 *
 * It is also not a claim about builders that this platform has not earned. Most
 * of what you would want to rank a builder on — did they finish on time, how
 * many defects, did the sale complete — lives in tables that held ZERO rows
 * when this was written (0 construction cases, 0 practical completions, 0
 * defects, 0 warranty claims, 0 transactions; 2 selections and 1 activation
 * announcement across the whole network). A ranking that scored those as zero
 * would not be measuring builders, it would be measuring which tables happen to
 * be populated, and it would rank a builder with no delivery history BELOW one
 * with a bad delivery history.
 *
 * ## The five rules that carry it
 *
 * **ABSENT IS NEVER ZERO.** The rule this platform already learned twice — once
 * when a failed Places lookup stored `count: 0` and depressed a published walk
 * score, once when an unresolved rent printed `0.00%` yield beside real
 * projections. A signal with no data is `not_measured`, and a `not_measured`
 * signal leaves BOTH sides of the average: it is not in the numerator and not
 * in the denominator. It cannot drag a score down, and it cannot be mistaken
 * for a measurement of nothing.
 *
 * **A THINLY-EVIDENCED SCORE IS PULLED TOWARD THE MIDDLE.** Excluding absent
 * signals creates its own trap: a builder measured on one signal, at 100, would
 * out-rank a builder measured on nine signals at 85. So the weighted mean of
 * what WAS measured is blended with a neutral prior carrying `PRIOR_WEIGHT`,
 * and a builder measured on nothing at all lands exactly on neutral rather than
 * at the floor. This is the property that makes the ranking defensible while
 * the network is young: confidence travels with the number instead of being
 * lost inside it, and being unmeasured is never the same as being bad.
 *
 * **MERIT AND MONEY ARE TWO NUMBERS AND NEVER ONE.** A commercial placement
 * adds no points to `merit`. It selects a placement BAND that sits above the
 * organic order, is capped by the surface that draws it, and is labelled on the
 * card where the adviser reads it. Blending them would destroy both: a builder could
 * no longer be told their merit score without being told something untrue, and
 * a paid position would wear the appearance of merit — which, for an adviser
 * who then recommends that property to a client, is the kind of claim that has
 * to be disclosed rather than hidden.
 *
 * **AN OVERRIDE IS AN ACT, NOT A VALUE.** Mission Control's pin, suppression
 * and freeze never rewrite a computed score. They sit beside it, each carrying
 * an actor, a reason and an expiry, so the score stays a true statement about
 * the builder and the intervention stays visible as an intervention. An expired
 * override LAPSES — the ranking returns to merit on its own rather than
 * becoming permanent through nobody's decision, which is how a temporary
 * commercial arrangement silently becomes the shape of the marketplace.
 *
 * **THE PAGE'S SHAPE IS NOT PART OF ANY SCORE.** The diversity cap that keeps
 * one vendor from owning page one is applied to the ORDERED LIST at read time,
 * never folded into a score. A builder's position must not depend on which
 * other builders happen to be on the page with them — otherwise no rank can be
 * reported to a builder, reproduced, or audited.
 *
 * ## Where it runs
 *
 * Network-side, once. The answer travels on `stock.item.upserted` into every
 * clone's mirror, and a clone sorts by what it was told rather than deciding
 * for itself. Two implementations of one judgement is how two deployments come
 * to disagree about who is first — and a clone's mirror is a partial view, so
 * its answer would be wrong as well as different.
 *
 * Pure: no IO, no clock, no database. `asOf` is a parameter for the same reason
 * every other dated rule here takes one — a scorer that reads the wall clock
 * cannot be tested and cannot be reproduced.
 */

// ===========================================================================
// Version
// ===========================================================================

/**
 * Bumped when a stored score would change for inputs already scored.
 *
 * It travels on every snapshot row and on the wire to the clones, so a mirror
 * can say which rules produced the order it is drawing. A clone never compares
 * versions to decide anything — it draws what it was sent — but an operator
 * looking at two deployments that disagree needs to be able to see that one is
 * simply carrying an older answer.
 */
export const BUILDER_RANKING_VERSION = 1;

/** The midpoint an unmeasured builder sits on. Not a score — an absence of one. */
export const NEUTRAL_SCORE = 50;

/**
 * How much neutral prior the blend carries, in the same units as signal weight
 * (signal weights sum to 100).
 *
 * 35 was chosen so that a builder evidenced on a single small signal cannot
 * reach the top band on it: `verification_standing` alone, scored perfectly,
 * yields (100x6 + 50x35) / 41 = 57.3 — above neutral, nowhere near a top-band
 * 75. A builder evidenced on 60 points of weight at 85 yields 72.1. Evidence
 * outranks perfection, which is the intended shape.
 */
export const BUILDER_PRIOR_WEIGHT = 35;

/** The same blend for a property. Its signals are more reliably present, so the prior is lighter. */
export const ITEM_PRIOR_WEIGHT = 20;

// ===========================================================================
// Readings — the shape that keeps absent from becoming zero
// ===========================================================================

/** Why a signal could not be measured. Never a score; always a statement about evidence. */
export type NotMeasuredReason =
  /** The builder has no live stock, so nothing about their catalogue can be read. */
  | 'no_live_stock'
  /** No adviser has ever activated this builder's stock, so responsiveness is unobserved. */
  | 'no_activations'
  /** No sale has reached a terminal state, so conversion is unobserved. */
  | 'no_outcomes'
  /** No completed build, defect or warranty record exists for this builder. */
  | 'no_delivery_record'
  /**
   * Too few comparable properties, from too few OTHER builders, to say whether
   * a price is competitive. Comparing a builder's price to a cohort made only
   * of their own stock compares them to themselves.
   */
  | 'cohort_too_small'
  /** The builder has not stated when they began trading, and nothing else knows. */
  | 'not_declared'
  /** No operator has recorded a standing for this builder, or the one on file has aged out. */
  | 'not_recorded'
  /** Evidence exists but is stale enough that reporting it would assert more than is known. */
  | 'stale';

/** One signal's answer: a number, or an explicit absence. Never both, never neither. */
export type SignalReading =
  | {
    readonly state: 'measured';
    /** 0..100. */
    readonly value: number;
    /** What the number was read from, so a score can be explained without recomputing it. */
    readonly evidence: Readonly<Record<string, number | string | boolean | null>>;
  }
  | {
    readonly state: 'not_measured';
    readonly reason: NotMeasuredReason;
  };

export const measured = (
  value: number,
  evidence: Readonly<Record<string, number | string | boolean | null>> = {},
): SignalReading => ({ state: 'measured', value: clamp(value, 0, 100), evidence });

export const notMeasured = (reason: NotMeasuredReason): SignalReading =>
  ({ state: 'not_measured', reason });

// ===========================================================================
// The builder signals, and what each is worth
// ===========================================================================

export type BuilderSignalKey =
  | 'listing_quality'
  | 'catalogue_completeness'
  | 'availability_hygiene'
  | 'freshness'
  | 'portfolio_depth'
  | 'portfolio_breadth'
  | 'tenure'
  | 'verification_standing'
  | 'responsiveness'
  | 'conversion'
  | 'delivery_record'
  | 'price_position'
  | 'reputation';

/**
 * The weights, summing to 100, declared in one place and nowhere else.
 *
 * They are a POLICY, not a measurement, and they are stated here rather than
 * configured because a marketplace whose ordering can be changed without a code
 * review is a marketplace whose ordering nobody can account for later. Changing
 * one is a deliberate edit that bumps `BUILDER_RANKING_VERSION`.
 *
 * What the shape says: how a builder keeps their listings (`listing_quality`,
 * `catalogue_completeness`, `availability_hygiene`, `freshness` — 40 together)
 * and how they behave once a client is sent to them (`responsiveness`,
 * `conversion`, `delivery_record` — 29) dominate. Size (`portfolio_depth`,
 * `portfolio_breadth` — 7) is deliberately small and deliberately capped: a
 * marketplace that rewards inventory volume linearly becomes a marketplace only
 * large builders can enter.
 */
export const BUILDER_SIGNAL_WEIGHTS: Readonly<Record<BuilderSignalKey, number>> = Object.freeze({
  listing_quality: 14,
  catalogue_completeness: 9,
  availability_hygiene: 7,
  freshness: 10,
  portfolio_depth: 4,
  portfolio_breadth: 3,
  tenure: 7,
  verification_standing: 6,
  responsiveness: 10,
  conversion: 7,
  delivery_record: 12,
  price_position: 5,
  reputation: 6,
});

/** What each signal is called where a person reads it. Database vocabulary never reaches an operator. */
export const BUILDER_SIGNAL_LABEL: Readonly<Record<BuilderSignalKey, string>> = Object.freeze({
  listing_quality: 'Listing quality',
  catalogue_completeness: 'Catalogue completeness',
  availability_hygiene: 'Availability kept current',
  freshness: 'Stock list freshness',
  portfolio_depth: 'Portfolio size',
  portfolio_breadth: 'Geographic spread',
  tenure: 'Years operating',
  verification_standing: 'Verification and standing',
  responsiveness: 'Responsiveness to activations',
  conversion: 'Activations reaching a sale',
  delivery_record: 'Delivery record',
  price_position: 'Price against comparable stock',
  reputation: 'Recorded standing',
});

export type ItemSignalKey =
  | 'image'
  | 'completeness'
  | 'availability'
  | 'freshness'
  | 'price_position';

/**
 * A property's own weights.
 *
 * `image` takes 40 because this product already decided that a card with no
 * builder photograph shows nothing at all — an empty card is the worst thing
 * the marketplace can put in front of an adviser, and it is entirely within the
 * builder's power to fix.
 */
export const ITEM_SIGNAL_WEIGHTS: Readonly<Record<ItemSignalKey, number>> = Object.freeze({
  image: 40,
  completeness: 25,
  availability: 15,
  freshness: 10,
  price_position: 10,
});

export const ITEM_SIGNAL_LABEL: Readonly<Record<ItemSignalKey, string>> = Object.freeze({
  image: 'Photograph',
  completeness: 'Detail completeness',
  availability: 'Availability',
  freshness: 'Last confirmed',
  price_position: 'Price against comparable stock',
});

// ===========================================================================
// The blend
// ===========================================================================

export interface ScoreBreakdown<K extends string> {
  /** 0..100, after the neutral blend. This is the number anything sorts on. */
  readonly score: number;
  /**
   * 0..1 — the share of total weight that was actually measured.
   *
   * Reported beside the score everywhere it is shown, because a 70 evidenced on
   * a tenth of the weights and a 70 evidenced on all of them are different
   * claims and must not read as the same one.
   */
  readonly confidence: number;
  /** The weighted mean of the measured signals alone, before the blend. Null when nothing was measured. */
  readonly measuredScore: number | null;
  readonly signals: Readonly<Record<K, SignalReading>>;
  /** Each measured signal's contribution to `measuredScore`, for explaining a position. */
  readonly contributions: ReadonlyArray<{
    readonly key: K;
    readonly value: number;
    readonly weight: number;
    readonly share: number;
  }>;
}

/**
 * Weighted mean over the MEASURED signals, blended toward neutral by how much
 * of the weight was measured.
 *
 * The two rules live here together on purpose: excluding absent signals and
 * then shrinking by confidence are halves of one idea, and separating them is
 * how the first rule turns into "one perfect signal wins".
 */
export function blend<K extends string>(
  signals: Readonly<Record<K, SignalReading>>,
  weights: Readonly<Record<K, number>>,
  priorWeight: number,
): ScoreBreakdown<K> {
  const keys = Object.keys(weights) as K[];
  const totalWeight = keys.reduce((sum, key) => sum + weights[key], 0);

  let measuredWeight = 0;
  let weightedSum = 0;
  const contributions: Array<{ key: K; value: number; weight: number; share: number }> = [];

  for (const key of keys) {
    const reading = signals[key];
    if (!reading || reading.state !== 'measured') continue;
    const weight = weights[key];
    measuredWeight += weight;
    weightedSum += reading.value * weight;
    contributions.push({ key, value: reading.value, weight, share: 0 });
  }

  const measuredScore = measuredWeight > 0 ? weightedSum / measuredWeight : null;
  for (const contribution of contributions) {
    contribution.share = measuredWeight > 0 ? contribution.weight / measuredWeight : 0;
  }

  // Nothing measured resolves to exactly NEUTRAL_SCORE, which is the whole
  // point: an unknown builder is unknown, not bad.
  const score = (weightedSum + NEUTRAL_SCORE * priorWeight) / (measuredWeight + priorWeight);

  return {
    score: round2(clamp(score, 0, 100)),
    confidence: totalWeight > 0 ? round4(measuredWeight / totalWeight) : 0,
    measuredScore: measuredScore === null ? null : round2(measuredScore),
    signals,
    contributions: contributions.sort((a, b) => b.weight * b.value - a.weight * a.value),
  };
}

// ===========================================================================
// Builder signal derivation
// ===========================================================================

/** A builder's catalogue, reduced to the counts a score is read from. */
export interface BuilderCatalogueFacts {
  readonly liveItems: number;
  /** Live items carrying an image the display rules would actually draw. */
  readonly itemsWithDisplayableImage: number;
  /** Live items whose price is stated at all (a figure or an explicit "on application"). */
  readonly itemsWithPrice: number;
  /** Mean per-item field completeness across live stock, 0..1. */
  readonly meanFieldCompleteness: number;
  /** Live items whose availability is `available`, `on_hold`, `reserved` or `contracted` — anything but `unknown`. */
  readonly itemsWithKnownAvailability: number;
  /** Live items still marked sellable (`available`). */
  readonly itemsAvailable: number;
  readonly distinctStates: number;
  readonly distinctSuburbs: number;
  /** Days since the builder last uploaded a stock list. Null when they never have. */
  readonly daysSinceLastUpload: number | null;
  /** Days since any live item was last seen in a source read. Null when never. */
  readonly daysSinceLastSeen: number | null;
}

export interface BuilderActivityFacts {
  readonly activations: number;
  readonly activationsAcknowledged: number;
  /** Median hours from an adviser activating to the builder acknowledging. Null when none acknowledged. */
  readonly medianAcknowledgementHours: number | null;
  readonly outcomes: number;
  readonly outcomesCompleted: number;
}

export interface BuilderDeliveryFacts {
  readonly completions: number;
  readonly completionsOnTime: number;
  readonly defects: number;
  readonly warrantyClaims: number;
}

export type TenureSource = 'abr_verified' | 'declared' | 'none';

export interface BuilderStandingFacts {
  readonly tenureYears: number | null;
  readonly tenureSource: TenureSource;
  readonly hasWellFormedAbn: boolean;
  readonly hasContactEmail: boolean;
  readonly hasContactPhone: boolean;
  readonly termsAccepted: boolean;
  readonly onboardingStepsTotal: number;
  readonly onboardingStepsComplete: number;
  /** An operator's recorded standing, 0..100. Null when none is on file. */
  readonly reputationScore: number | null;
  readonly reputationAgeDays: number | null;
}

/** Where a builder's stock sits against comparable stock from OTHER builders. */
export interface PricePositionFacts {
  /** Live items that fell in a cohort large enough to judge. */
  readonly itemsInCohort: number;
  /**
   * Mean of each item's cohort ratio (item price / cohort median). Null when no
   * item reached a usable cohort.
   */
  readonly meanCohortRatio: number | null;
}

/**
 * The floor a price cohort must clear before it may say anything.
 *
 * `MIN_COHORT_ORGANISATIONS` is the load-bearing one and it is 3, not 2: a
 * cohort of two builders makes each one's "position against the market" a
 * position against one competitor, which moves violently on a single listing.
 * Below the floor the signal is `cohort_too_small` — not "average", which would
 * quietly assert that a price had been compared when it had not.
 */
export const MIN_COHORT_ORGANISATIONS = 3;
export const MIN_COHORT_ITEMS = 8;

/** The band a cohort ratio is read across. Saturating at both ends, on purpose. */
export const PRICE_BAND_BEST = 0.85;
export const PRICE_BAND_WORST = 1.20;

/**
 * Below this, a discount stops reading as value and starts reading as a
 * different product. The score saturates rather than climbing, and the evidence
 * says so, because a marketplace that rewards "cheapest" without limit rewards
 * mispriced and misdescribed stock.
 */
export const PRICE_IMPLAUSIBLE_DISCOUNT = 0.60;

/** Past this, a stock list has stopped being maintained rather than merely being quiet. */
export const FRESHNESS_STALE_DAYS = 120;
/** Inside this, a stock list is current and scores full. */
export const FRESHNESS_CURRENT_DAYS = 14;

/** A recorded standing older than this says more about when somebody looked than about the builder. */
export const REPUTATION_MAX_AGE_DAYS = 365;

/** A declared trading date nobody verified cannot out-score a verified one. */
export const DECLARED_TENURE_CEILING = 70;
/** Years of trading at which tenure stops adding. Twenty years and forty are not different risks. */
export const TENURE_SATURATION_YEARS = 20;

/** The activations a builder must have seen before responsiveness is a fact rather than an anecdote. */
export const MIN_ACTIVATIONS_FOR_RESPONSIVENESS = 3;
/** The outcomes a builder must have before a conversion rate means anything. */
export const MIN_OUTCOMES_FOR_CONVERSION = 3;
/** The completions a builder must have before a delivery record is reportable. */
export const MIN_COMPLETIONS_FOR_DELIVERY = 3;

/** Acknowledging within this many hours is full marks. */
export const RESPONSE_EXCELLENT_HOURS = 4;
/** Past this, an acknowledgement is too late to have been useful to the adviser waiting on it. */
export const RESPONSE_POOR_HOURS = 120;

export interface BuilderFacts {
  readonly organisationId: string;
  readonly catalogue: BuilderCatalogueFacts;
  readonly activity: BuilderActivityFacts;
  readonly delivery: BuilderDeliveryFacts;
  readonly standing: BuilderStandingFacts;
  readonly pricePosition: PricePositionFacts;
}

/** Every builder signal, derived. Each one answers or says why it cannot. */
export function deriveBuilderSignals(
  facts: BuilderFacts,
): Readonly<Record<BuilderSignalKey, SignalReading>> {
  const { catalogue: c, activity: a, delivery: d, standing: s, pricePosition: p } = facts;
  const hasStock = c.liveItems > 0;

  return Object.freeze({
    listing_quality: hasStock
      ? measured(
        100 * (c.itemsWithDisplayableImage / c.liveItems),
        { live_items: c.liveItems, with_image: c.itemsWithDisplayableImage },
      )
      : notMeasured('no_live_stock'),

    catalogue_completeness: hasStock
      ? measured(
        100 * c.meanFieldCompleteness,
        { live_items: c.liveItems, mean_completeness: round4(c.meanFieldCompleteness) },
      )
      : notMeasured('no_live_stock'),

    /**
     * Two halves: is availability STATED at all, and is the list still mostly
     * sellable. A catalogue of `unknown` is unmaintained; a catalogue that is
     * entirely `sold` is honest but has nothing to offer an adviser today.
     */
    availability_hygiene: hasStock
      ? measured(
        100 * (0.6 * (c.itemsWithKnownAvailability / c.liveItems)
          + 0.4 * (c.itemsAvailable / c.liveItems)),
        {
          live_items: c.liveItems,
          known_availability: c.itemsWithKnownAvailability,
          available: c.itemsAvailable,
        },
      )
      : notMeasured('no_live_stock'),

    freshness: freshnessReading(c.daysSinceLastUpload, c.daysSinceLastSeen),

    portfolio_depth: hasStock
      ? measured(depthScore(c.liveItems), { live_items: c.liveItems })
      : notMeasured('no_live_stock'),

    portfolio_breadth: hasStock
      ? measured(
        breadthScore(c.distinctStates, c.distinctSuburbs),
        { states: c.distinctStates, suburbs: c.distinctSuburbs },
      )
      : notMeasured('no_live_stock'),

    tenure: tenureReading(s.tenureYears, s.tenureSource),

    verification_standing: measured(standingScore(s), {
      abn: s.hasWellFormedAbn,
      email: s.hasContactEmail,
      phone: s.hasContactPhone,
      terms: s.termsAccepted,
      onboarding: s.onboardingStepsTotal > 0
        ? `${s.onboardingStepsComplete}/${s.onboardingStepsTotal}`
        : 'none recorded',
    }),

    responsiveness: a.activations >= MIN_ACTIVATIONS_FOR_RESPONSIVENESS
      ? measured(responsivenessScore(a), {
        activations: a.activations,
        acknowledged: a.activationsAcknowledged,
        median_hours: a.medianAcknowledgementHours,
      })
      : notMeasured('no_activations'),

    conversion: a.outcomes >= MIN_OUTCOMES_FOR_CONVERSION
      ? measured(100 * (a.outcomesCompleted / a.outcomes), {
        outcomes: a.outcomes,
        completed: a.outcomesCompleted,
      })
      : notMeasured('no_outcomes'),

    delivery_record: d.completions >= MIN_COMPLETIONS_FOR_DELIVERY
      ? measured(deliveryScore(d), {
        completions: d.completions,
        on_time: d.completionsOnTime,
        defects: d.defects,
        warranty_claims: d.warrantyClaims,
      })
      : notMeasured('no_delivery_record'),

    price_position: pricePositionReading(p),

    reputation: reputationReading(s.reputationScore, s.reputationAgeDays),
  });
}

function freshnessReading(
  daysSinceUpload: number | null,
  daysSinceSeen: number | null,
): SignalReading {
  // Either witness will do, and the more recent one wins: a builder who
  // re-uploads and a builder whose feed is re-read are both maintaining a list.
  const candidates = [daysSinceUpload, daysSinceSeen].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (!candidates.length) return notMeasured('no_live_stock');
  const days = Math.min(...candidates);
  return measured(decayScore(days, FRESHNESS_CURRENT_DAYS, FRESHNESS_STALE_DAYS), {
    days_since_maintained: round2(days),
    days_since_upload: daysSinceUpload,
    days_since_seen: daysSinceSeen,
  });
}

/**
 * Size, compressed hard.
 *
 * Doubling a catalogue from 5 to 10 says something; doubling it from 200 to 400
 * says almost nothing about whether this builder is worth showing an adviser.
 * A log curve saturating at `DEPTH_SATURATION` keeps a serious small builder
 * competitive with a large one, which is what stops the marketplace closing to
 * new vendors.
 */
export const DEPTH_SATURATION_ITEMS = 60;
function depthScore(liveItems: number): number {
  if (liveItems <= 0) return 0;
  const ratio = Math.log1p(liveItems) / Math.log1p(DEPTH_SATURATION_ITEMS);
  return clamp(100 * ratio, 0, 100);
}

function breadthScore(states: number, suburbs: number): number {
  // Three states, or ten suburbs, is as broad as this signal needs to read.
  const stateShare = clamp(states / 3, 0, 1);
  const suburbShare = clamp(suburbs / 10, 0, 1);
  return 100 * (0.6 * stateShare + 0.4 * suburbShare);
}

/**
 * Tenure, discounted by how it is known.
 *
 * `builder_organisations.created_at` is when a builder joined this network, not
 * when they began trading — both live organisations joined in the two months
 * before this was written, and neither started trading then. Reading a join
 * date as tenure would invent a fact, so `none` is `not_declared` rather than
 * "new". A date the builder typed is a claim and is capped below a verified
 * one; a date read from the ABR against their ABN is a fact and scores in full.
 * The same rule the join-request path already states: an ABN match is a claim,
 * not a grant.
 */
function tenureReading(years: number | null, source: TenureSource): SignalReading {
  if (source === 'none' || years === null || !Number.isFinite(years) || years < 0) {
    return notMeasured('not_declared');
  }
  const raw = 100 * clamp(years / TENURE_SATURATION_YEARS, 0, 1);
  const value = source === 'declared' ? Math.min(raw, DECLARED_TENURE_CEILING) : raw;
  return measured(value, {
    years: round2(years),
    source,
    capped: source === 'declared' && raw > DECLARED_TENURE_CEILING,
  });
}

/**
 * Standing is the one signal every builder can always be measured on, because
 * every part of it is inside their own control and owed at onboarding anyway.
 * It is deliberately small (6 of 100) — finishing your paperwork is a floor,
 * not a distinction.
 */
function standingScore(s: BuilderStandingFacts): number {
  const onboarding = s.onboardingStepsTotal > 0
    ? s.onboardingStepsComplete / s.onboardingStepsTotal
    : 0;
  return 100 * (
    0.30 * (s.hasWellFormedAbn ? 1 : 0)
    + 0.15 * (s.hasContactEmail ? 1 : 0)
    + 0.10 * (s.hasContactPhone ? 1 : 0)
    + 0.20 * (s.termsAccepted ? 1 : 0)
    + 0.25 * clamp(onboarding, 0, 1)
  );
}

/**
 * Two things an adviser cares about: do they answer, and how fast.
 *
 * Answering at all carries more weight than answering quickly, because an
 * unacknowledged activation leaves a client waiting with nobody aware of them —
 * which is worse than a slow reply.
 */
function responsivenessScore(a: BuilderActivityFacts): number {
  const acknowledgedShare = a.activations > 0 ? a.activationsAcknowledged / a.activations : 0;
  const speed = a.medianAcknowledgementHours === null
    ? 0
    : decayScore(a.medianAcknowledgementHours, RESPONSE_EXCELLENT_HOURS, RESPONSE_POOR_HOURS);
  return clamp(100 * (0.6 * acknowledgedShare) + 0.4 * speed, 0, 100);
}

function deliveryScore(d: BuilderDeliveryFacts): number {
  const onTime = d.completions > 0 ? d.completionsOnTime / d.completions : 0;
  // Defects and warranty claims are rates per completion, and both saturate:
  // past roughly two defects a build the distinction stops being informative.
  const defectRate = d.completions > 0 ? d.defects / d.completions : 0;
  const warrantyRate = d.completions > 0 ? d.warrantyClaims / d.completions : 0;
  const defectHealth = 1 - clamp(defectRate / 2, 0, 1);
  const warrantyHealth = 1 - clamp(warrantyRate, 0, 1);
  return 100 * (0.5 * onTime + 0.3 * defectHealth + 0.2 * warrantyHealth);
}

function pricePositionReading(p: PricePositionFacts): SignalReading {
  if (p.itemsInCohort <= 0 || p.meanCohortRatio === null) {
    return notMeasured('cohort_too_small');
  }
  const ratio = p.meanCohortRatio;
  const implausible = ratio < PRICE_IMPLAUSIBLE_DISCOUNT;
  const value = priceRatioScore(ratio);
  return measured(value, {
    items_in_cohort: p.itemsInCohort,
    mean_cohort_ratio: round4(ratio),
    far_below_cohort: implausible,
  });
}

/**
 * A ratio of item price to cohort median, read across a declared band.
 *
 * It saturates at BOTH ends and that is the point. At the top, an ever-deeper
 * discount does not score ever higher — a listing 45% under comparable stock is
 * describing a different product, a different inclusion list or a data error,
 * and paying it more ranking than a listing 15% under would put exactly the
 * wrong stock in front of a client. At the bottom, an expensive listing floors
 * at zero on this signal alone and is never removed from the marketplace for
 * its price, because price is the builder's to set.
 */
export function priceRatioScore(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return NEUTRAL_SCORE;
  const clamped = clamp(ratio, PRICE_BAND_BEST, PRICE_BAND_WORST);
  const span = PRICE_BAND_WORST - PRICE_BAND_BEST;
  return clamp(100 * ((PRICE_BAND_WORST - clamped) / span), 0, 100);
}

function reputationReading(score: number | null, ageDays: number | null): SignalReading {
  if (score === null || !Number.isFinite(score)) return notMeasured('not_recorded');
  if (ageDays !== null && ageDays > REPUTATION_MAX_AGE_DAYS) return notMeasured('stale');
  return measured(score, { recorded_score: score, age_days: ageDays });
}

// ===========================================================================
// Item signal derivation
// ===========================================================================

export interface ItemFacts {
  readonly itemId: string;
  readonly organisationId: string;
  /** Does this property carry an image the display rules would actually draw? */
  readonly hasDisplayableImage: boolean;
  /**
   * The image exists but has not been judged yet (`pending` eligibility, an
   * unread encoding, a decode that failed). Distinguished from having none,
   * because "we could not tell" is not "there is nothing".
   */
  readonly imagePending: boolean;
  /** 0..1 across the fields a card draws. */
  readonly fieldCompleteness: number;
  readonly availabilityStatus: string;
  readonly daysSinceSeen: number | null;
  /** This item's price against its own cohort median. Null when no usable cohort. */
  readonly cohortRatio: number | null;
}

/**
 * How sellable an availability status is, to an adviser choosing stock today.
 *
 * `unknown` sits below `contracted` deliberately: a contracted property is a
 * known state an adviser can reason about, and an unknown one is a list that
 * has not been maintained. Nothing here is zero — every status still appears.
 */
export const AVAILABILITY_SCORE: Readonly<Record<string, number>> = Object.freeze({
  available: 100,
  on_hold: 55,
  reserved: 40,
  contracted: 25,
  unknown: 15,
  sold: 5,
  settled: 5,
  withdrawn: 0,
});

export function deriveItemSignals(facts: ItemFacts): Readonly<Record<ItemSignalKey, SignalReading>> {
  return Object.freeze({
    image: facts.hasDisplayableImage
      ? measured(100, { displayable: true })
      : facts.imagePending
      // Not yet judged is not a failure to supply one. It scores at neutral so
      // an image still being assessed neither flatters nor punishes the card.
      ? measured(NEUTRAL_SCORE, { displayable: false, pending: true })
      : measured(0, { displayable: false, pending: false }),

    completeness: measured(100 * clamp(facts.fieldCompleteness, 0, 1), {
      field_completeness: round4(facts.fieldCompleteness),
    }),

    availability: measured(
      AVAILABILITY_SCORE[facts.availabilityStatus] ?? AVAILABILITY_SCORE.unknown,
      { availability_status: facts.availabilityStatus },
    ),

    freshness: facts.daysSinceSeen === null
      ? notMeasured('stale')
      : measured(decayScore(facts.daysSinceSeen, FRESHNESS_CURRENT_DAYS, FRESHNESS_STALE_DAYS), {
        days_since_seen: round2(facts.daysSinceSeen),
      }),

    price_position: facts.cohortRatio === null
      ? notMeasured('cohort_too_small')
      : measured(priceRatioScore(facts.cohortRatio), {
        cohort_ratio: round4(facts.cohortRatio),
        far_below_cohort: facts.cohortRatio < PRICE_IMPLAUSIBLE_DISCOUNT,
      }),
  });
}

export const scoreBuilder = (facts: BuilderFacts): ScoreBreakdown<BuilderSignalKey> =>
  blend(deriveBuilderSignals(facts), BUILDER_SIGNAL_WEIGHTS, BUILDER_PRIOR_WEIGHT);

export const scoreItem = (facts: ItemFacts): ScoreBreakdown<ItemSignalKey> =>
  blend(deriveItemSignals(facts), ITEM_SIGNAL_WEIGHTS, ITEM_PRIOR_WEIGHT);

// ===========================================================================
// Bands
// ===========================================================================

/**
 * A builder's band, which is what a property inherits.
 *
 * Bands rather than raw order, because the product asks for both a builder
 * ranking AND a property ranking: the band is the builder's answer, and the
 * property's own score decides the order inside it. A raw builder ordering
 * would mean every property of the better builder outranks every property of
 * the next one, and a mediocre listing would out-rank an excellent one on its
 * owner's reputation alone.
 *
 * Index 0 is best. Lower is better everywhere in this module, matching the
 * `position` idiom the rest of the stock code already uses.
 */
export const BUILDER_BAND_FLOORS: readonly number[] = Object.freeze([75, 62, 50, 38]);
export const BUILDER_BAND_LABEL: readonly string[] = Object.freeze([
  'Established',
  'Strong',
  'Standard',
  'Developing',
  'Unrated',
]);

export function builderBand(score: number): number {
  for (let index = 0; index < BUILDER_BAND_FLOORS.length; index += 1) {
    if (score >= BUILDER_BAND_FLOORS[index]) return index;
  }
  return BUILDER_BAND_FLOORS.length;
}

// ===========================================================================
// Placement — where merit stops and a decision begins
// ===========================================================================

export type PlacementKind = 'pinned' | 'promoted' | 'organic' | 'suppressed';

export interface RankingOverride {
  readonly organisationId: string;
  readonly kind: 'pin' | 'suppress';
  /** 1-based position for a pin. Ignored for a suppression. */
  readonly position: number | null;
  readonly reason: string;
  /** Null is a standing override; a date is one that lapses on its own. */
  readonly expiresAt: string | null;
}

export interface CommercialPlacement {
  readonly organisationId: string;
  readonly tier: string;
  /** Lower sorts first among promoted builders. */
  readonly priority: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

export interface Placement {
  readonly kind: PlacementKind;
  /** Set for `pinned` only. */
  readonly position: number | null;
  /** Set for `promoted` only. */
  readonly tier: string | null;
  readonly priority: number;
  /** Set for `pinned` and `suppressed` — the operator's recorded reason. */
  readonly reason: string | null;
  /**
   * Whether the card must carry a visible label.
   *
   * True for a paid placement and for an operator's pin alike: an adviser
   * reading this list recommends what is on it to a client, so anything whose
   * position was decided by something other than merit says so where they read
   * it. It is computed here rather than at the card so one rule serves every
   * surface, and it is never false for `promoted`.
   */
  readonly disclose: boolean;
}

/** An override or placement window that has not started, or has lapsed, is not in force. */
export function inForce(
  window: { readonly startsAt?: string | null; readonly endsAt?: string | null; readonly expiresAt?: string | null },
  asOf: string,
): boolean {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) return false;
  const starts = window.startsAt ? Date.parse(window.startsAt) : null;
  const ends = window.endsAt ? Date.parse(window.endsAt)
    : window.expiresAt ? Date.parse(window.expiresAt)
    : null;
  if (starts !== null && Number.isFinite(starts) && now < starts) return false;
  if (ends !== null && Number.isFinite(ends) && now >= ends) return false;
  return true;
}

/**
 * What decides this builder's position, in order of authority.
 *
 * Suppression outranks everything, including a paid placement: an operator who
 * has taken a builder out of the marketplace has usually done it for a reason
 * that a commercial arrangement must not override, and the reverse ordering
 * would mean paying to stay visible through a dispute.
 */
export function resolvePlacement(
  organisationId: string,
  band: number,
  overrides: readonly RankingOverride[],
  placements: readonly CommercialPlacement[],
  asOf: string,
): Placement {
  const mine = overrides.filter((o) => o.organisationId === organisationId && inForce(o, asOf));

  const suppression = mine.find((o) => o.kind === 'suppress');
  if (suppression) {
    return {
      kind: 'suppressed',
      position: null,
      tier: null,
      priority: 0,
      reason: suppression.reason,
      disclose: false,
    };
  }

  const pin = mine
    .filter((o) => o.kind === 'pin' && o.position !== null && o.position > 0)
    .sort((a, b) => (a.position as number) - (b.position as number))[0];
  if (pin) {
    return {
      kind: 'pinned',
      position: pin.position,
      tier: null,
      priority: pin.position as number,
      reason: pin.reason,
      disclose: true,
    };
  }

  const promoted = placements
    .filter((p) => p.organisationId === organisationId && inForce(p, asOf))
    .sort((a, b) => a.priority - b.priority)[0];
  if (promoted) {
    return {
      kind: 'promoted',
      position: null,
      tier: promoted.tier,
      priority: promoted.priority,
      reason: null,
      disclose: true,
    };
  }

  return { kind: 'organic', position: null, tier: null, priority: band, reason: null, disclose: false };
}

// ===========================================================================
// What travels, and what deliberately does not
// ===========================================================================

/**
 * The block a clone is sent for one property, and all it needs to draw an order.
 *
 * Composed in SQL by `builder_network_compose_stock_item_payload`; this type is
 * the contract that composition answers to, and the clone's mirror columns
 * mirror it key for key.
 *
 * WHAT IS NOT HERE IS THE POINT. There is no ordering function in this module
 * and there must not be one. A score is a statement about a builder and a
 * property; the SHAPE OF A PAGE — how many of one builder may run consecutively,
 * how many promoted slots a list offers, where a pin lands once an offset is
 * applied — is a property of the surface doing the paginating, and that surface
 * is the clone's marketplace. Computing it here would mean a builder's position
 * depended on who else happened to be on the page with them, which is exactly
 * what makes a rank unreportable and unauditable.
 *
 * So the split is: the network decides what each builder and property is WORTH,
 * and that travels. Each clone lays out a page from those worths, identically,
 * because the migration that does it is the same file in every deployment.
 */
export interface PublishedRank {
  readonly itemId: string;
  readonly organisationId: string;
  readonly builderScore: number;
  readonly builderConfidence: number;
  readonly builderBand: number;
  readonly itemScore: number;
  readonly itemConfidence: number;
  readonly placementKind: PlacementKind;
  readonly placementPosition: number | null;
  readonly placementTier: string | null;
  readonly disclose: boolean;
  readonly rankingVersion: number;
  readonly computedAt: string;
}

// ===========================================================================
// Explaining a position
// ===========================================================================

/**
 * Why this builder is where they are, in the words an operator or the builder
 * themselves would read.
 *
 * It names what was NOT measured as prominently as what was, because the most
 * common honest answer while the network is young is "we do not know enough
 * about you yet" — and a builder told only their score would read a mid-table
 * position as a judgement rather than as an absence of evidence.
 */
export function explainBuilder(breakdown: ScoreBreakdown<BuilderSignalKey>): {
  readonly score: number;
  readonly confidence: number;
  readonly band: number;
  readonly bandLabel: string;
  readonly strengths: ReadonlyArray<{ label: string; value: number }>;
  readonly weaknesses: ReadonlyArray<{ label: string; value: number }>;
  readonly unmeasured: ReadonlyArray<{ label: string; reason: NotMeasuredReason }>;
} {
  const keys = Object.keys(BUILDER_SIGNAL_WEIGHTS) as BuilderSignalKey[];
  const measuredKeys = keys.filter((key) => breakdown.signals[key]?.state === 'measured');

  const withValue = measuredKeys.map((key) => ({
    key,
    label: BUILDER_SIGNAL_LABEL[key],
    value: (breakdown.signals[key] as { value: number }).value,
    weight: BUILDER_SIGNAL_WEIGHTS[key],
  }));

  const band = builderBand(breakdown.score);
  return {
    score: breakdown.score,
    confidence: breakdown.confidence,
    band,
    bandLabel: BUILDER_BAND_LABEL[band] ?? BUILDER_BAND_LABEL[BUILDER_BAND_LABEL.length - 1],
    strengths: withValue
      .filter((s) => s.value >= 70)
      .sort((a, b) => b.value * b.weight - a.value * a.weight)
      .slice(0, 4)
      .map(({ label, value }) => ({ label, value })),
    weaknesses: withValue
      .filter((s) => s.value < 50)
      .sort((a, b) => (a.value * a.weight) - (b.value * b.weight))
      .slice(0, 4)
      .map(({ label, value }) => ({ label, value })),
    unmeasured: keys
      .filter((key) => breakdown.signals[key]?.state === 'not_measured')
      .map((key) => ({
        label: BUILDER_SIGNAL_LABEL[key],
        reason: (breakdown.signals[key] as { reason: NotMeasuredReason }).reason,
      })),
  };
}

// ===========================================================================
// Small shared arithmetic
// ===========================================================================

export function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/** 100 at or under `best`, 0 at or over `worst`, linear between. */
export function decayScore(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= best) return 100;
  if (value >= worst) return 0;
  return 100 * ((worst - value) / (worst - best));
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;
