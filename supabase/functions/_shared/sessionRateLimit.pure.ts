/**
 * RATE LIMITS FOR AN ACT A SIGNED-IN PERSON TAKES FOR AN ORGANISATION.
 *
 * `authRateLimit.ts` exists for the doors a stranger can knock on — login,
 * registration, password recovery — where the source address is the only
 * identity there is, so its helpers consume the address first. An act behind a
 * portal session has two better identities, and both come from the
 * server-validated session rather than from anything in the request: the
 * person, and the organisation they are acting for.
 *
 * Keying such an act on the source address would be worse than redundant.
 * Every request the portal's own proxy forwards without its proof secret
 * arrives from the proxy, and a request with no trusted address header shares
 * the one `untrusted` bucket, so one organisation's burst would refuse every
 * other organisation's staff.
 *
 * Pure: the keys, the budgets and the order are decided here and tested
 * without a database. `authRateLimit.ts` binds them to the shared limiter, so
 * the fallback posture (never 500, degrade to a per-isolate ceiling) is the
 * one every other door already has.
 */

export interface SessionRateLimitBudget {
  readonly max: number;
  readonly windowSeconds: number;
}

export interface SessionRateLimitBudgets {
  readonly user: SessionRateLimitBudget;
  readonly organisation: SessionRateLimitBudget;
}

export type SessionRateLimitDimensionName = 'user' | 'organisation';

export interface SessionRateLimitDimension {
  readonly dimension: SessionRateLimitDimensionName;
  readonly key: string;
  readonly budget: SessionRateLimitBudget;
}

/** One unit consumed from one bucket, as the shared limiter reports it. */
export interface SessionRateLimitOutcome {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  /** The shared limiter was unavailable and a per-isolate bucket answered. */
  readonly degraded: boolean;
}

export interface SessionRateLimitDecision extends SessionRateLimitOutcome {
  /** Which ceiling refused, for the log; never sent to the caller. */
  readonly refusedBy: SessionRateLimitDimensionName | null;
}

/** `builder-portal-invite`'s `invite` and `resend`: each mints a token and sends an email. */
export const INVITE_SEND_SCOPE = 'binv';

/**
 * WHY THESE NUMBERS.
 *
 * Production held no genuine invitation history to fit them to on
 * 28 Sep 2026: every inviter in the activity log was a proof account (the
 * busiest sent 11 in one hour, one organisation 12) and the largest real
 * organisation had 2 members. So they are reasoned from the workflow instead.
 *
 *  * A person: 40 an hour — an owner onboarding an office of about thirty in
 *    one sitting, with room for resends and corrected typos.
 *  * An organisation: 100 an hour — several administrators doing that at once.
 *    It is also the bound on what one tenant can spend of the mail provider
 *    that every tenant shares, however many administrators it appoints.
 *
 * The hour is the window every other email-sending door here uses
 * (forgot-password, register, accept-invite, verify-email).
 */
export const INVITE_SEND_BUDGETS: SessionRateLimitBudgets = {
  user: { max: 40, windowSeconds: 3600 },
  organisation: { max: 100, windowSeconds: 3600 },
};

/**
 * The buckets one act is counted against, in the order they are consumed: the
 * person first, so an administrator over their own ceiling spends none of the
 * organisation's.
 *
 * Refuses a missing id rather than building a key from it: a key built from an
 * empty or undefined id is ONE bucket every such caller shares — the failure
 * keying on identity exists to avoid.
 */
export function sessionRateLimitDimensions(args: {
  readonly scope: string;
  readonly userId: string;
  readonly organisationId: string;
  readonly budgets: SessionRateLimitBudgets;
}): SessionRateLimitDimension[] {
  const userId = String(args.userId ?? '').trim();
  const organisationId = String(args.organisationId ?? '').trim();
  if (!userId) throw new Error('A session rate limit needs the authenticated user id.');
  if (!organisationId) throw new Error('A session rate limit needs the active organisation id.');
  return [
    { dimension: 'user', key: `${args.scope}_user:${userId}`, budget: args.budgets.user },
    { dimension: 'organisation', key: `${args.scope}_org:${organisationId}`, budget: args.budgets.organisation },
  ];
}

/**
 * Consume each dimension in order, stopping at the first that refuses.
 * `consume` is the shared limiter; it never throws, so neither does this.
 */
export async function enforceSessionLimits(
  dimensions: readonly SessionRateLimitDimension[],
  consume: (key: string, budget: SessionRateLimitBudget) => Promise<SessionRateLimitOutcome>,
): Promise<SessionRateLimitDecision> {
  let degraded = false;
  for (const { dimension, key, budget } of dimensions) {
    const outcome = await consume(key, budget);
    degraded = degraded || outcome.degraded;
    if (!outcome.allowed) {
      return { allowed: false, retryAfterSeconds: outcome.retryAfterSeconds, degraded, refusedBy: dimension };
    }
  }
  return { allowed: true, retryAfterSeconds: 0, degraded, refusedBy: null };
}
