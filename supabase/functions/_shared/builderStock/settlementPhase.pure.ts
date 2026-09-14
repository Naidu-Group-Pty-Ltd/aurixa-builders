/**
 * Builder stock — which of the three settlement phases a tick does.
 *
 * WHY A TICK DOES ONE. The phases are independent questions with independent
 * markers, and running all three in one invocation is what kills the settler: a
 * tick that re-reads a builder's Drive package — a folder listing, a
 * multi-megabyte PDF download, a text extraction and a raster extraction — and
 * THEN sweeps display eligibility and THEN spends the overlay-repair budget on
 * full-resolution decodes exceeds the edge worker's CPU allowance and returns
 * 546 with NOTHING WRITTEN. Every tick then does the same work and dies the
 * same way, so a queue that looks busy makes no progress at all. That is not
 * hypothetical: a provenance-version bump reopened 26 packages and produced
 * exactly that, for hours.
 *
 * AND WHY IT ROTATES RATHER THAN PRIORITISES. Strict priority was the first
 * shape of this and it starves everything behind the first phase with work.
 * Provenance on the live deployment is one upload of seventy rows settled four
 * at a time, so it holds every tick for hours — and while it did, it discovered
 * twenty-six builder primaries that could not be DRAWN, because the eligibility
 * sweep that judges a newly stored picture never got a tick to run in. "Images
 * found, none displayed" is the same blank card by another route.
 *
 * So the tick takes the phases that have work and rotates through them. The
 * index comes from the clock rather than from stored state: the settler keeps
 * none, and a counter in the database would be one more thing to get wrong. The
 * only property required is that consecutive ticks land on consecutive indices.
 *
 * NOTHING IS SKIPPED AND NO CAP IS RELAXED. A phase this tick defers is the
 * phase the next tick takes, every phase has its own marker, and the sweep is
 * resumable — so rotation costs ticks and never coverage.
 *
 * Pure: no imports, no IO, no clock of its own — the caller passes the time.
 */

/** The three questions, in the order they are rotated through. */
export const SETTLEMENT_PHASES = ['provenance', 'eligibility', 'sanitization'] as const;

export type SettlementPhase = typeof SETTLEMENT_PHASES[number];

/** What each candidate upload still has outstanding. */
export interface PhaseWork {
  needsProvenance?: boolean;
  needsEligibility?: boolean;
  needsSanitization?: boolean;
}

/**
 * The phase this tick should do.
 *
 * `now` is the wall clock and `period` the rotation step — the cron interval,
 * so one tick is one phase. A phase with nothing outstanding is left out of the
 * rotation entirely, so a queue with only repairs left spends every tick on
 * repairs rather than two thirds of them on nothing.
 *
 * With no work at all the answer is `provenance`, which is the phase that costs
 * least to run against an empty queue and the one a new upload needs first.
 */
export function choosePhase(
  candidates: PhaseWork[],
  now: number,
  period: number,
): SettlementPhase {
  const outstanding = SETTLEMENT_PHASES.filter((phase) => (candidates ?? []).some(
    (candidate) => (phase === 'provenance' && candidate.needsProvenance)
      || (phase === 'eligibility' && candidate.needsEligibility)
      || (phase === 'sanitization' && candidate.needsSanitization),
  ));
  if (!outstanding.length) return 'provenance';
  if (!Number.isFinite(now) || !Number.isFinite(period) || period <= 0) return outstanding[0];
  const index = Math.floor(now / period) % outstanding.length;
  return outstanding[(index + outstanding.length) % outstanding.length];
}
