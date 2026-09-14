/**
 * "We started reading that package and never came back."
 *
 * WHY THIS EXISTS. `recoverPackageImage` downloads a multi-megabyte PDF,
 * extracts its rasters and classifies them, and once begun nothing stops it.
 * When the edge worker kills the invocation partway through — `CPU Time
 * exceeded`, `Memory limit exceeded` — there is no throw to catch, no `finally`
 * that runs and no response to inspect. The process simply ends.
 *
 * Every guard the repair already has is blind to that. `MAX_ITEMS_RESTORED_PER_RUN`
 * and `MAX_PACKAGE_RECOVERIES_PER_RUN` are counters that reset with the run.
 * `PACKAGE_RECOVERY_RESERVE_MS` reserves WALL CLOCK, and the binding limit here
 * is CPU and memory. The `try/catch` around the recovery cannot catch a kill.
 * So the next tick reads the same queue, reaches the same property, starts the
 * same download and dies at the same place — for ever.
 *
 * PRODUCTION, 28 AUGUST 2026. Upload `eccc9840` settled twelve properties and
 * then stopped dead on the thirteenth, Lot 104 Finch Road. Every tick from
 * 02:00 onward booted, ran six to nine seconds and was killed, alternating
 * `CPU Time exceeded` and `Memory limit exceeded`, emitting no tick log at all.
 * `source_images_settled_version` stayed NULL, so the upload never settled, so
 * the fallback ladder was never entered, so three properties stayed blank on
 * the live Marketplace. One heavy package held twenty-three properties still.
 *
 * THE ANSWER IS TO WRITE SOMETHING DOWN BEFORE THE DANGEROUS STEP, which is
 * the same shape as the repair claim the sanitizer already uses: a
 * compare-and-set before the spend, so that being killed is survivable
 * evidence rather than silence. An attempt is recorded, the step runs, and a
 * verdict overwrites the attempt. A kill leaves the attempt standing, and the
 * next tick can SEE it.
 *
 * IT SHARES `source_provenance_result` WITH THE VERDICT, AND THAT IS SAFE BY
 * CONSTRUCTION. `negativeProvenanceStillStands` returns false for any record
 * whose `result` is not `no_deterministic_image`, so an attempt record reads as
 * "no answer yet — ask again". That is the fail-open direction that module
 * chose deliberately, and this leans on it rather than modifying it: no new
 * column, no new table, no change to what a verdict means.
 */
import {
  recordNoDeterministicImage,
  type ProvenanceQuestion,
} from './negativeProvenance.pure.ts';

/** The marker. Deliberately not a verdict, and never mistaken for one. */
import { RUNTIME_VERSION } from './runtimeVersion.pure.ts';

export const PACKAGE_RECOVERY_ATTEMPT = 'package_recovery_attempt' as const;

/**
 * How many times one package may kill the worker before the sweep moves on.
 *
 * FOUR. It was two, priced when an attempt cost a five-minute upload-wide
 * tick and a stuck package pinned every property behind it — under that
 * regime a third try was mostly a third kill. Neither premise survives the
 * per-item settler: an attempt now costs one claim whose OWN backoff walks
 * toward an hour, and a killed package pins nobody but itself.
 *
 * WHAT TWO ACTUALLY RETIRED, MEASURED 2 SEPTEMBER 2026. A provenance bump
 * requeued twenty properties at once and the reprocessing burst drew seven
 * `CPU Time exceeded` kills in three minutes — contention, not weight: in the
 * same runtime, on the same tick cadence, Lot 824's 7.2 MB brochure read and
 * stored, and Lot 516's 10.6 MB one stored its render with the kill landing
 * AFTER the row was written. Lots 709 and 818 — 5 MB documents that read in
 * three seconds on a clean isolate — were killed twice each in that burst and
 * retired at the budget, unread. A budget that cannot tell a toxic document
 * from a busy minute is priced wrong for the failure it meters.
 *
 * Four spreads the attempts across the claim backoff's growing gaps, so a
 * burst has ended by the time the later tries arrive, while a document that
 * genuinely destroys the worker every time it is opened still retires — and
 * still retires as `operational`, never as evidence exhaustion.
 */
export const MAX_PACKAGE_ATTEMPTS = 4;

/**
 * How many times a branch may answer `unreachable` before it is retired.
 *
 * WHY THIS HAS TO EXIST AT ALL. `unreachable` records nothing, deliberately:
 * a sign-in wall may open tomorrow and banking "no image" for it would suppress
 * a document that reads perfectly well. But `openBranches` then returns the
 * branch again on the next tick, for ever — and a property whose every
 * remaining branch is unreachable never leaves the source stage, so it never
 * reaches the fallback ladder that would have given it a picture.
 *
 * PRODUCTION, 31 AUGUST 2026, upload `43ffa452`. Thirteen properties were
 * claimed every sixty seconds, indefinitely, on branches that can never
 * answer: two Drive files returning 404 (deleted, or their permission
 * revoked), one answering `Google Drive: Sign-in`, and single-page siting
 * plans with no text layer for the reader to read. Rotation gave each of them
 * its turn and each turn answered the same nothing.
 *
 * SIX, not two. An unreachable answer costs one cheap fetch rather than a
 * killed worker, and the failures it covers include genuinely transient ones —
 * a slow origin, a rate limit, a cold cache — so it is worth several more
 * goes. What it must not be is unbounded, because "we keep trying" is not the
 * alternative to retiring: the alternative is a property pinned on the source
 * stage with no picture at all.
 *
 * And retiring is not for ever. The question is keyed on the provenance
 * version, the package and the anchor, so a bumped extractor or a re-imported
 * row asks again from zero — which is exactly the asymmetry
 * `recordPackageUnprocessable` already embodies for the kill case.
 */
export const MAX_UNREACHABLE_ATTEMPTS = 6;

export interface PackageAttemptRecord {
  result: typeof PACKAGE_RECOVERY_ATTEMPT;
  provenance_version: number;
  package_reference: string;
  source_anchor: string | null;
  /** How many times this exact question has been started and not finished. */
  attempts: number;
  /**
   * How many times this exact question RETURNED `unreachable`.
   *
   * Kept apart from `attempts` because the two are different failures with
   * different budgets: `attempts` counts a worker this package DESTROYED, and
   * two is plenty because a third would destroy another one. This counts a
   * link that answered cleanly and told us nothing, which costs one cheap
   * fetch, so it is given several more goes before it is retired.
   */
  unreachable?: number;
  /**
   * The runtime that was holding this question when it failed to finish.
   *
   * An attempt record only ever counts OUR failures — the step started and
   * never returned — so it is stamped unconditionally, and `attemptsSoFar`
   * compares it. A superseded runtime therefore starts the kill count again
   * from zero, which is what reopens a property we crashed on without
   * touching one that was answered. `unreachableSoFar` deliberately does NOT
   * compare it: see `unreachableMatch`.
   */
  runtime_version?: number;
  started_at: string;
}

/** Is this stored record an attempt at the question being asked now? */
function attemptFor(
  stored: unknown,
  question: ProvenanceQuestion,
): PackageAttemptRecord | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Partial<PackageAttemptRecord>;
  if (record.result !== PACKAGE_RECOVERY_ATTEMPT) return null;

  // The same three keys the verdict compares, for the same reasons: a version
  // bump, a swapped package or a different source row is a NEW question, and
  // its attempt count must start again rather than inherit somebody else's.
  if (Number(record.provenance_version) !== question.provenanceVersion) return null;
  if (record.package_reference !== question.packageReference) return null;
  if ((record.source_anchor ?? null) !== question.sourceAnchor) return null;

  /*
   * AND THE RUNTIME, for the kill count alone. An attempt record IS a record
   * of our own failure — a step that began and never came back — so a runtime
   * that has been superseded is no longer the worker that failed, and its
   * count must not be inherited by the one that replaced it. This is what
   * reopens a property whose brochure only ever died of contention, without
   * a version bump reaching a single property that was answered properly.
   *
   * A record written before this field existed compares equal to runtime 0,
   * so the first bump reopens exactly those, once.
   */
  if (Number(record.runtime_version ?? 0)
    !== Number(question.runtimeVersion ?? RUNTIME_VERSION)) return null;

  return record as PackageAttemptRecord;
}

/**
 * The same record WITHOUT the runtime comparison, for the dead-link budget.
 *
 * A link that answers a sign-in wall, a 404 or a scan with no text layer is
 * not a failure a better worker fixes, so its count has to survive a runtime
 * bump — otherwise every improvement to the worker would re-chase every dead
 * link in the library from zero, for ever. Kept as its own matcher rather
 * than a flag on the one above, so the two budgets cannot be confused at a
 * call site.
 */
function unreachableMatch(
  stored: unknown,
  question: ProvenanceQuestion,
): PackageAttemptRecord | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Partial<PackageAttemptRecord>;
  if (record.result !== PACKAGE_RECOVERY_ATTEMPT) return null;
  if (Number(record.provenance_version) !== question.provenanceVersion) return null;
  if (record.package_reference !== question.packageReference) return null;
  if ((record.source_anchor ?? null) !== question.sourceAnchor) return null;
  return record as PackageAttemptRecord;
}

/** How many times this exact question has been started and not finished. */
export function attemptsSoFar(stored: unknown, question: ProvenanceQuestion): number {
  const record = attemptFor(stored, question);
  if (!record) return 0;
  const attempts = Number(record.attempts);
  return Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
}

/** How many times this exact question has answered `unreachable`. */
export function unreachableSoFar(stored: unknown, question: ProvenanceQuestion): number {
  const record = unreachableMatch(stored, question);
  if (!record) return 0;
  const n = Number(record.unreachable);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * What the column holds after a branch answered `unreachable`.
 *
 * The spend RETURNED, so the kill claim is spent and must not stand — that is
 * what `provenanceAfterAttempt` is for, and its reasoning is unchanged. What
 * is kept is the count of how many times this link has told us nothing, so the
 * budget above can be reached at all. `attempts` is reset to zero because no
 * worker was destroyed: an unreachable answer must never push a package
 * towards the resource-limit retirement, which is a different finding.
 */
export function recordUnreachableAttempt(
  stored: unknown,
  question: ProvenanceQuestion,
  now: () => Date = () => new Date(),
): PackageAttemptRecord {
  return {
    result: PACKAGE_RECOVERY_ATTEMPT,
    provenance_version: question.provenanceVersion,
    package_reference: question.packageReference,
    source_anchor: question.sourceAnchor,
    attempts: 0,
    unreachable: unreachableSoFar(stored, question) + 1,
    runtime_version: question.runtimeVersion ?? RUNTIME_VERSION,
    started_at: now().toISOString(),
  };
}

/** Has this link told us nothing often enough to be retired? */
export function unreachableAttemptsExhausted(
  stored: unknown,
  question: ProvenanceQuestion,
): boolean {
  return unreachableSoFar(stored, question) >= MAX_UNREACHABLE_ATTEMPTS;
}

/**
 * The terminal answer for a link that can be fetched but never read.
 *
 * AN HONEST ONE, and deliberately not the same sentence as the resource-limit
 * retirement: an operator reading the column is told the link could not be
 * reached, not that the builder's document was empty and not that it broke the
 * worker. A 404, a sign-in page and a scan with no text layer all land here,
 * and all three are facts about our access rather than about the property.
 */
export function recordPackageUnreachable(
  question: ProvenanceQuestion,
  now: () => Date = () => new Date(),
) {
  return recordNoDeterministicImage(
    question,
    `That link could not be read after ${MAX_UNREACHABLE_ATTEMPTS} attempts — `
    + `it answered with no readable document — so no builder image was taken `
    + `from it.`,
    // OURS, NOT THE DOCUMENT'S. A 404, a sign-in wall and a scan with no text
    // layer are all facts about our access, so this retirement retires the
    // branch and never admits the online fallback. See `suppliedEvidence`.
    'operational',
    now,
  );
}

/**
 * The record to write BEFORE the recovery runs.
 *
 * Written first and overwritten by the verdict, so the only way this survives
 * is for the step never to have finished.
 */
export function recordPackageAttempt(
  stored: unknown,
  question: ProvenanceQuestion,
  now: () => Date = () => new Date(),
): PackageAttemptRecord {
  return {
    result: PACKAGE_RECOVERY_ATTEMPT,
    provenance_version: question.provenanceVersion,
    package_reference: question.packageReference,
    source_anchor: question.sourceAnchor,
    attempts: attemptsSoFar(stored, question) + 1,
    /*
     * Carried across a runtime bump: the kill count above resets, this does
     * not. A dead link stays dead however good the worker gets.
     */
    unreachable: unreachableSoFar(stored, question) || undefined,
    runtime_version: question.runtimeVersion ?? RUNTIME_VERSION,
    started_at: now().toISOString(),
  };
}

/**
 * What the column must hold once the guarded step RETURNED.
 *
 * The claim is spent, so it is cleared — but "cleared" means back to the answer
 * the property held before ANY claim, not back to whatever the column happened
 * to contain when this run read it. After a kill the column contains a
 * SURVIVING ATTEMPT, and restoring that resurrects a spent claim.
 *
 * PRODUCTION, 28 AUGUST 2026, upload `55d12d53`. Lot 1342 Austin Estate
 * (`a9f231f3`, folder `1jlUkB8O…`) sat at `attempts: 1` with
 * `started_at 05:35:02` while its row was still being written at 05:55:10 —
 * twenty minutes and four ticks later. Each tick read the surviving attempt,
 * wrote attempt 2, and then rolled the counter back to 1 on the return path,
 * so `packageAttemptsExhausted` could never fire. The sweep re-entered the same
 * package for ever and the three properties after it in `created_at` order were
 * never touched at all. The counter has to be monotonic across kills or the
 * exhaustion guard is unreachable.
 */
export function provenanceAfterAttempt(
  stored: unknown,
  question: ProvenanceQuestion,
): unknown {
  return attemptFor(stored, question) ? null : (stored ?? null);
}

/** Has this package had its chances? */
export function packageAttemptsExhausted(
  stored: unknown,
  question: ProvenanceQuestion,
): boolean {
  return attemptsSoFar(stored, question) >= MAX_PACKAGE_ATTEMPTS;
}

/**
 * The terminal answer for a package that cannot be processed here.
 *
 * A VERDICT, AND AN HONEST ONE. It is the existing `no_deterministic_image` —
 * this repository has exactly one negative result and this does not invent a
 * second — with a detail that says what actually happened, so an operator
 * reading the column is not told the builder's package was empty when the truth
 * is that we could not open it within an edge worker's limits.
 *
 * Writing it is what lets the upload settle, and settling is what admits the
 * property to stage B and stage C. The alternative is not "we keep trying": the
 * alternative is the whole upload pinned and every property behind it blank.
 */
export function recordPackageUnprocessable(
  question: ProvenanceQuestion,
  now: () => Date = () => new Date(),
) {
  return {
    ...recordNoDeterministicImage(
      question,
      `This package could not be processed within the worker's resource limits `
      + `after ${MAX_PACKAGE_ATTEMPTS} attempts, so no builder image was taken `
      + `from it.`,
      // A DESTROYED WORKER IS NOT AN EMPTY DOCUMENT. This is what "settling"
      // used to buy the fallback ladder with, and it may not any more.
      'operational',
      now,
    ),
    /*
     * THE ONE WRITER THAT STAMPS THE RUNTIME, because this is the one
     * retirement that is purely OUR failure. The document was never read and
     * never answered; a worker died holding it. When the runtime that died
     * is superseded, this record stops standing and the branch is asked
     * again — see `runtimeVersion.pure.ts`.
     *
     * `recordPackageUnreachable` deliberately does NOT stamp, though it is
     * `operational` too: a 404 or a sign-in wall is not something a better
     * worker can open, and re-chasing dead links on every runtime change is a
     * treadmill rather than a recovery.
     */
    runtime_version: question.runtimeVersion ?? RUNTIME_VERSION,
  };
}
