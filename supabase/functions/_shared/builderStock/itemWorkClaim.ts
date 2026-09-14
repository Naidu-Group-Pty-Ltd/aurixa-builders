/**
 * Builder Stock — taking ONE property's imagery work, and giving it back.
 *
 * The seam between the settler and the per-item claim added by
 * `20261019000000_builder_stock_item_work_claim.sql`. Three calls, and one rule
 * that matters more than all of them:
 *
 *   A MISSING CLAIM FUNCTION IS DEPLOYMENT SKEW, NEVER AN OUTAGE.
 *
 * Edge functions ship automatically when `main` moves; migrations in this
 * project are dispatched by hand, one file at a time. So this module WILL run
 * against a database that does not have the function yet — that is not a
 * hypothetical, it is what happened on 29 August, when a settler requiring
 * `claim_builder_stock_settlement_lease` went live against an unapplied
 * migration and answered 503 on every tick until somebody noticed the whole
 * marketplace had gone blank.
 *
 * So `unavailable` is a first-class answer here, distinct from "nothing to do"
 * and distinct from "the read failed". The caller logs it and uses the old
 * path. Slow is not an outage.
 */

/** The columns a claimed property hands back. A row of `builder_stock_items`. */
export interface ClaimedItem {
  id: string;
  organisation_id: string;
  upload_id: string | null;
  /**
   * The upload whose replacement values this row is holding, if any.
   *
   * A MATCHED ROW'S `upload_id` IS STILL THE OLD ONE. Re-pointing it is step 1
   * of the cutover itself, so until publication the id of the upload actually
   * waiting on this property lives here and nowhere else. Asking to publish
   * `upload_id` on such a row asks about the dataset already on screen.
   */
  pending_upload_id: string | null;
  image_work_stage: string;
  image_work_attempts: number;
  lifecycle_status: string | null;
}

/** Where a claimed property goes next. Mirrors the column's CHECK constraint. */
export type ItemWorkStage =
  | 'source' | 'eligibility' | 'sanitization' | 'fallback' | 'settled';

export const ITEM_WORK_STAGES: readonly ItemWorkStage[] = [
  'source', 'eligibility', 'sanitization', 'fallback', 'settled',
];

export type ClaimResult =
  /** The function is not deployed. Deployment skew — use the old path. */
  | { available: false }
  /** Deployed, and nothing is due right now. */
  | { available: true; item: null }
  /** Deployed, and this property is ours for the length of the lease. */
  | { available: true; item: ClaimedItem };

/**
 * Is this PostgREST error "the function/column is not there"?
 *
 * Three spellings, because three layers can answer first: Postgres itself
 * (`42883` undefined_function, `42703` undefined_column), and PostgREST's own
 * schema cache, which reports a name it has never seen in prose rather than
 * with a code.
 *
 * DELIBERATELY NARROW. Anything else — a timeout, a permission error, a
 * connection reset — is a live fault and must NOT be mistaken for an
 * undeployed migration, because that would silently downgrade a broken
 * database to the slow path and hide it.
 */
export function isMissingCapability(error: unknown): boolean {
  if (!error) return false;
  const record = error as { code?: string; message?: string };
  if (record.code === '42883' || record.code === 'PGRST202') return true;
  const message = String(record.message ?? '').toLowerCase();
  return message.includes('could not find the function')
    || message.includes('does not exist')
    || message.includes('schema cache');
}

/**
 * Claim EXACTLY ONE property.
 *
 * ONE, AND THE SINGULAR IS THE POINT. Claiming a batch and then working
 * through it inside a single invocation rebuilds the very thing this replaces:
 * claim A, B, C, D — A kills the worker — and B, C and D are now leased by a
 * process that no longer exists, having never been looked at. They would wait
 * out a lease for a failure that was not theirs, which is head-of-line
 * blocking wearing a different hat.
 *
 * So one invocation takes one property, and a kill costs exactly that property
 * one lease term. Throughput comes from invoking more often, or later from
 * safe parallel invocation — never from widening this number.
 */
export async function claimOneImageWorkItem(
  db: any,
  input: { leaseSeconds: number; organisationId?: string | null } = { leaseSeconds: 120 },
): Promise<ClaimResult> {
  const { data, error } = await db.rpc('claim_builder_stock_image_work', {
    p_limit: 1,
    p_lease_seconds: Math.max(1, Math.trunc(input.leaseSeconds) || 120),
    p_organisation_id: input.organisationId ?? null,
  });

  if (error) {
    if (isMissingCapability(error)) return { available: false };
    // A live fault. Not skew, and not an empty queue: let it surface.
    throw new Error(`builder stock item claim failed: ${
      (error as { message?: string }).message ?? 'unknown'}`);
  }

  const rows = (data ?? []) as ClaimedItem[];
  return { available: true, item: rows[0] ?? null };
}

/**
 * Give the claim back, saying what happened.
 *
 * `progressed` is the flag a worker sets when the step DID something but is not
 * finished — a source read that stored what it could and will store the rest
 * next time. It clears the attempt count, so a healthy resumable property does
 * not walk its own backoff up to the hour cap. A killed worker never reaches
 * this call at all, which is exactly why the counter it raised in the claim is
 * the honest measure of silence.
 */
export async function completeItemWork(
  db: any,
  itemId: string,
  outcome: {
    nextStage?: ItemWorkStage | null;
    result?: string | null;
    error?: string | null;
    retryAfterSeconds?: number;
    progressed?: boolean;
    /**
     * Clear the claim's backoff counter, independently of whether work
     * advanced.
     *
     * WHY THESE ARE TWO QUESTIONS. `image_work_attempts` is incremented by
     * the CLAIM, before anything is attempted, and the completion clears it
     * only when work progressed or the stage moved. That is right for a stage
     * that ran and failed. It is wrong for a claim HANDED BACK untouched: the
     * serial loop releases a property when too little of the invocation
     * remains to finish it, and nothing whatsoever was attempted — yet the
     * increment would stand, and `least(30 * 2^attempts, 3600)` turns a sixth
     * such deferral into a 32-minute backoff. A property would be penalised,
     * repeatedly, for our clock rather than for anything about itself.
     *
     * Defaults to `progressed === true`, so every existing caller keeps the
     * behaviour it had; only the handback passes it explicitly.
     */
    resetAttempts?: boolean;
  },
): Promise<{ available: boolean }> {
  const { error } = await db.rpc('complete_builder_stock_image_work', {
    p_item_id: itemId,
    p_next_stage: outcome.nextStage ?? null,
    p_result: outcome.result ?? null,
    p_error: outcome.error ?? null,
    p_retry_after_seconds: Math.max(0, Math.trunc(outcome.retryAfterSeconds ?? 0)),
    p_reset_attempts: outcome.resetAttempts ?? outcome.progressed === true,
  });
  if (error && isMissingCapability(error)) return { available: false };
  if (error) {
    throw new Error(`builder stock item completion failed: ${
      (error as { message?: string }).message ?? 'unknown'}`);
  }
  return { available: true };
}

export interface ItemWorkPending {
  available: boolean;
  claimable: number;
  outstanding: number;
}

/**
 * How much is claimable NOW, and how much is outstanding at all.
 *
 * The scheduler needs both, because they license different decisions. Nothing
 * claimable with work outstanding means every candidate is leased or backing
 * off — keep the job and do nothing this minute. Nothing outstanding means the
 * job may retire. Collapsing the two is how a sweep goes permanently quiet with
 * work still to do, which this repository has already shipped once.
 */
export async function readItemWorkPending(db: any): Promise<ItemWorkPending> {
  const { data, error } = await db.rpc('builder_stock_image_work_pending');
  if (error) {
    if (isMissingCapability(error)) return { available: false, claimable: 0, outstanding: 0 };
    throw new Error(`builder stock work queue unreadable: ${
      (error as { message?: string }).message ?? 'unknown'}`);
  }
  const row = ((data ?? []) as Array<{ claimable?: unknown; outstanding?: unknown }>)[0]
    ?? (data as { claimable?: unknown; outstanding?: unknown } | null)
    ?? {};
  return {
    available: true,
    claimable: Number(row.claimable ?? 0) || 0,
    outstanding: Number(row.outstanding ?? 0) || 0,
  };
}

export interface PublicationOutcome {
  available: boolean;
  published: boolean;
  reason?: string;
  promoted?: number;
  archived?: number;
  staged?: number;
  sourceOutstanding?: number;
}

/**
 * Publish this upload, IF it is ready.
 *
 * The readiness rule is evaluated inside the same statement that flips the
 * rows, so nothing can change between the check and the act — which is why
 * this is one RPC rather than a read here and a write after it. A caller may
 * ask on every completed item; asking is cheap and refusing is the normal
 * answer.
 *
 * `available: false` is deployment skew, exactly as for the claim: the
 * publication migration is not applied yet, the upload's rows are simply not
 * staged, and the caller carries on. It is never an outage.
 */
export async function publishUploadIfReady(
  db: any,
  uploadId: string,
): Promise<PublicationOutcome> {
  const { data, error } = await db.rpc('publish_builder_stock_upload', {
    p_upload_id: uploadId,
  });
  if (error) {
    if (isMissingCapability(error)) return { available: false, published: false };
    throw new Error(`builder stock publication failed: ${
      (error as { message?: string }).message ?? 'unknown'}`);
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    available: true,
    published: row.published === true,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    promoted: Number(row.promoted ?? 0) || 0,
    archived: Number(row.archived ?? 0) || 0,
    staged: Number(row.staged ?? 0) || 0,
    sourceOutstanding: Number(row.source_outstanding ?? 0) || 0,
  };
}
