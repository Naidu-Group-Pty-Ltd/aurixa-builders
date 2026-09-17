/**
 * The ranking's rules, pinned.
 *
 * These are not tests of arithmetic — the arithmetic is allowed to change.
 * They are tests of the five statements the module makes about itself, each of
 * which a later well-meaning edit could quietly reverse:
 *
 *   absent is never zero
 *   a thinly-evidenced score is pulled toward the middle
 *   merit and money are two numbers and never one
 *   an override lapses
 *   the cap is a sort and never a filter
 *
 * The weights and thresholds are deliberately NOT asserted. Pinning 14 and 9
 * and 0.85 would make every tuning change a test edit, and a test that has to
 * be edited to let a change through stops being evidence of anything.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILDER_PRIOR_WEIGHT,
  BUILDER_SIGNAL_WEIGHTS,
  ITEM_SIGNAL_WEIGHTS,
  NEUTRAL_SCORE,
  PRICE_IMPLAUSIBLE_DISCOUNT,
  blend,
  builderBand,
  deriveBuilderSignals,
  explainBuilder,
  inForce,
  measured,
  notMeasured,
  priceRatioScore,
  resolvePlacement,
  scoreBuilder,
  type BuilderFacts,
  type BuilderSignalKey,
  type SignalReading,
} from '../../../supabase/functions/_shared/builderStock/builderRanking.pure';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const ASOF = '2026-09-17T00:00:00.000Z';

const facts = (patch: Partial<BuilderFacts> = {}): BuilderFacts => ({
  organisationId: 'org-1',
  catalogue: {
    liveItems: 0,
    itemsWithDisplayableImage: 0,
    itemsWithPrice: 0,
    meanFieldCompleteness: 0,
    itemsWithKnownAvailability: 0,
    itemsAvailable: 0,
    distinctStates: 0,
    distinctSuburbs: 0,
    daysSinceLastUpload: null,
    daysSinceLastSeen: null,
  },
  activity: {
    activations: 0,
    activationsAcknowledged: 0,
    medianAcknowledgementHours: null,
    outcomes: 0,
    outcomesCompleted: 0,
  },
  delivery: { completions: 0, completionsOnTime: 0, defects: 0, warrantyClaims: 0 },
  standing: {
    tenureYears: null,
    tenureSource: 'none',
    hasWellFormedAbn: false,
    hasContactEmail: false,
    hasContactPhone: false,
    termsAccepted: false,
    onboardingStepsTotal: 0,
    onboardingStepsComplete: 0,
    reputationScore: null,
    reputationAgeDays: null,
  },
  pricePosition: { itemsInCohort: 0, meanCohortRatio: null },
  ...patch,
});

// --------------------------------------------------------------------------

describe('absent is never zero', () => {
  it('a builder measured on nothing lands on neutral, not on the floor', () => {
    const scored = scoreBuilder(facts());
    // Everything about this builder is unknown. The one signal that always
    // answers — standing — scores 0 because they have supplied nothing at all,
    // so the result must still be near neutral rather than near zero.
    expect(scored.score).toBeGreaterThan(40);
    expect(scored.score).toBeLessThan(NEUTRAL_SCORE);
  });

  it('a not_measured signal leaves the denominator as well as the numerator', () => {
    const one: Record<'a' | 'b', SignalReading> = {
      a: measured(100),
      b: notMeasured('no_live_stock'),
    };
    const both: Record<'a' | 'b', SignalReading> = { a: measured(100), b: measured(100) };
    const weights = { a: 50, b: 50 };

    // With `b` absent, `a` alone IS the measured mean — 100, not 50.
    expect(blend(one, weights, 0).measuredScore).toBe(100);
    expect(blend(both, weights, 0).measuredScore).toBe(100);
    // And the confidence says which of the two it was.
    expect(blend(one, weights, 0).confidence).toBe(0.5);
    expect(blend(both, weights, 0).confidence).toBe(1);
  });

  it('a builder with no delivery history outranks one with a bad delivery history', () => {
    const unknown = scoreBuilder(facts({
      delivery: { completions: 0, completionsOnTime: 0, defects: 0, warrantyClaims: 0 },
    }));
    const bad = scoreBuilder(facts({
      delivery: { completions: 10, completionsOnTime: 0, defects: 40, warrantyClaims: 20 },
    }));
    expect(unknown.score).toBeGreaterThan(bad.score);
  });

  it('every not_measured reading names a reason a person could act on', () => {
    const signals = deriveBuilderSignals(facts());
    const reasons = (Object.keys(signals) as BuilderSignalKey[])
      .map((key) => signals[key])
      .filter((reading) => reading.state === 'not_measured')
      .map((reading) => (reading as { reason: string }).reason);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).toMatch(/^[a-z_]+$/);
  });
});

describe('a thinly-evidenced score is pulled toward the middle', () => {
  it('nine signals at 85 beat one signal at 100', () => {
    const thin = scoreBuilder(facts({
      standing: {
        ...facts().standing,
        hasWellFormedAbn: true, hasContactEmail: true, hasContactPhone: true,
        termsAccepted: true, onboardingStepsTotal: 4, onboardingStepsComplete: 4,
      },
    }));

    const evidenced = scoreBuilder(facts({
      catalogue: {
        liveItems: 40, itemsWithDisplayableImage: 34, itemsWithPrice: 40,
        meanFieldCompleteness: 0.85, itemsWithKnownAvailability: 40, itemsAvailable: 34,
        distinctStates: 3, distinctSuburbs: 12,
        daysSinceLastUpload: 5, daysSinceLastSeen: 2,
      },
      activity: {
        activations: 20, activationsAcknowledged: 18,
        medianAcknowledgementHours: 5, outcomes: 10, outcomesCompleted: 8,
      },
      delivery: { completions: 12, completionsOnTime: 10, defects: 4, warrantyClaims: 1 },
      standing: {
        tenureYears: 14, tenureSource: 'abr_verified',
        hasWellFormedAbn: true, hasContactEmail: true, hasContactPhone: true,
        termsAccepted: true, onboardingStepsTotal: 4, onboardingStepsComplete: 4,
        reputationScore: 84, reputationAgeDays: 30,
      },
    }));

    expect(thin.confidence).toBeLessThan(evidenced.confidence);
    expect(evidenced.score).toBeGreaterThan(thin.score);
  });

  it('the prior carries real weight — removing it would change the answer', () => {
    expect(BUILDER_PRIOR_WEIGHT).toBeGreaterThan(0);
    const signals = { a: measured(100), b: notMeasured('stale') } as Record<'a' | 'b', SignalReading>;
    const weights = { a: 10, b: 90 };
    const withPrior = blend(signals, weights, BUILDER_PRIOR_WEIGHT).score;
    const without = blend(signals, weights, 0).score;
    expect(without).toBe(100);
    expect(withPrior).toBeLessThan(80);
  });
});

describe('merit and money are two numbers and never one', () => {
  it('a commercial placement changes no merit score', () => {
    const base = facts({ catalogue: { ...facts().catalogue, liveItems: 5, itemsWithDisplayableImage: 3 } });
    const merit = scoreBuilder(base).score;
    const placed = resolvePlacement('org-1', builderBand(merit), [], [{
      organisationId: 'org-1', tier: 'premium', priority: 1, startsAt: null, endsAt: null,
    }], ASOF);
    // The placement is a separate answer. The score it was computed from is
    // untouched, and nothing in the placement carries points.
    expect(placed.kind).toBe('promoted');
    expect(scoreBuilder(base).score).toBe(merit);
    expect(Object.values(placed)).not.toContain(merit);
  });

  it('a bought or pinned position always discloses; an organic one never does', () => {
    const promoted = resolvePlacement('o', 2, [], [{
      organisationId: 'o', tier: 'partner', priority: 1, startsAt: null, endsAt: null,
    }], ASOF);
    const pinned = resolvePlacement('o', 2, [{
      organisationId: 'o', kind: 'pin', position: 1, reason: 'commercial pilot', expiresAt: null,
    }], [], ASOF);
    const organic = resolvePlacement('o', 2, [], [], ASOF);

    expect(promoted.disclose).toBe(true);
    expect(pinned.disclose).toBe(true);
    expect(organic.disclose).toBe(false);
  });

  it('suppression outranks a paid placement', () => {
    const resolved = resolvePlacement('o', 0, [{
      organisationId: 'o', kind: 'suppress', position: null,
      reason: 'under dispute, withdrawn pending review', expiresAt: null,
    }], [{ organisationId: 'o', tier: 'premium', priority: 1, startsAt: null, endsAt: null }], ASOF);
    expect(resolved.kind).toBe('suppressed');
  });
});

describe('an override lapses', () => {
  it('an expired pin stops applying without anyone revoking it', () => {
    const pin = {
      organisationId: 'o', kind: 'pin' as const, position: 1,
      reason: 'spring campaign placement', expiresAt: '2026-09-16T00:00:00.000Z',
    };
    expect(resolvePlacement('o', 3, [pin], [], ASOF).kind).toBe('organic');
    expect(resolvePlacement('o', 3, [pin], [], '2026-09-15T00:00:00.000Z').kind).toBe('pinned');
  });

  it('a placement window that has not opened is not in force', () => {
    expect(inForce({ startsAt: '2026-10-01T00:00:00.000Z' }, ASOF)).toBe(false);
    expect(inForce({ endsAt: '2026-10-01T00:00:00.000Z' }, ASOF)).toBe(true);
    expect(inForce({}, ASOF)).toBe(true);
  });
});

describe('price position refuses to invent a comparison', () => {
  it('an ever-deeper discount does not score ever higher', () => {
    const modest = priceRatioScore(0.85);
    const extreme = priceRatioScore(PRICE_IMPLAUSIBLE_DISCOUNT / 2);
    expect(extreme).toBe(modest);
  });

  it('a cohort that never formed is not measured, not average', () => {
    const signals = deriveBuilderSignals(facts({
      pricePosition: { itemsInCohort: 0, meanCohortRatio: null },
    }));
    expect(signals.price_position.state).toBe('not_measured');
  });
});

describe('tenure is never read from a join date', () => {
  it('no declared and no verified date reads as unmeasured, never as new', () => {
    const signals = deriveBuilderSignals(facts());
    expect(signals.tenure.state).toBe('not_measured');
  });

  it('a claim cannot out-score a verified fact of the same age', () => {
    const base = { ...facts().standing, tenureYears: 25 };
    const declared = deriveBuilderSignals(facts({
      standing: { ...base, tenureSource: 'declared' },
    })).tenure;
    const verified = deriveBuilderSignals(facts({
      standing: { ...base, tenureSource: 'abr_verified' },
    })).tenure;
    expect(declared.state).toBe('measured');
    expect(verified.state).toBe('measured');
    expect((declared as { value: number }).value)
      .toBeLessThan((verified as { value: number }).value);
  });
});

describe('a position can be explained', () => {
  it('the explanation names what was not measured, not only what was', () => {
    const explained = explainBuilder(scoreBuilder(facts()));
    expect(explained.unmeasured.length).toBeGreaterThan(0);
    expect(explained.bandLabel).toBeTruthy();
    for (const entry of explained.unmeasured) {
      expect(entry.label).not.toMatch(/_/); // operator-facing wording, never a column name
    }
  });
});

describe('the weights are a declared policy', () => {
  it('both weight tables sum to 100, so a weight reads as a percentage', () => {
    const sum = (weights: Record<string, number>) =>
      Object.values(weights).reduce((total, value) => total + value, 0);
    expect(sum(BUILDER_SIGNAL_WEIGHTS)).toBe(100);
    expect(sum(ITEM_SIGNAL_WEIGHTS)).toBe(100);
  });
});
