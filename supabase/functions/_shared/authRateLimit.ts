/**
 * Shared rate limiting for authentication and password-recovery endpoints.
 *
 * Why this module exists
 * ----------------------
 * Every login in this deployment already had a per-ACCOUNT lockout (5 failures
 * → 15 minutes). That stops someone grinding one account. It does nothing about
 * the opposite shape, which is the one that actually gets used: one attempt
 * against each of ten thousand accounts, from one host. Password spraying never
 * trips a per-account counter because no single account ever reaches attempt
 * two. Before this module, `custom-auth-login-v2` (staff), and the client,
 * finance, builder and solicitor portal logins had no source-keyed ceiling at
 * all.
 *
 * The second reason is subtler and cost more. The handlers that DID limit
 * (`*-forgot-password`, two of the logins) keyed the bucket on:
 *
 *     req.headers.get('x-forwarded-for')?.split(',')[0]
 *
 * `X-Forwarded-For` is a request header. A client sets it, and an intermediary
 * APPENDS to it rather than replacing it, so element [0] is whatever the caller
 * typed. A limiter keyed on it buckets an attacker under a value the attacker
 * chooses — one header per request and the ceiling is gone. Those limiters read
 * as protection in review and enforced nothing. `getTrustedClientIp` (WP-01)
 * exists precisely because of this and deliberately refuses to parse XFF; it
 * reads only `cf-connecting-ip` / `x-real-ip`, which the edge sets and a client
 * cannot forge. Everything here goes through it.
 *
 * Availability
 * ------------
 * Fail-closed limiters have already taken this product down once: the migration
 * defining `security_consume_rate_limit` never reached production, every RPC
 * call errored, `publicAbuseControls` read that error as "over quota", and
 * Street View answered 429 to every request for six weeks (see
 * 20260803020000_repair_shared_rate_limit_and_circuit_primitives.sql). An
 * unavailable limiter is not the same fact as a caller being over their limit,
 * and conflating them here would lock every user out of every portal.
 *
 * So the backends are tried in order and the last one cannot fail:
 *   1. `security_consume_rate_limit`  — shared, atomic, returns retry-after.
 *   2. `check_and_bump_rate_limit`    — shared, atomic, boolean (older peer).
 *   3. per-isolate in-memory bucket   — weaker under horizontal scale (one
 *      window per isolate) but a real ceiling, and it can never 500.
 *
 * A degraded decision still denies when it is over the limit. It just never
 * denies *because the database was unreachable*.
 *
 * Ordering invariant (ABUSE-003)
 * ------------------------------
 * The source-IP bucket must be consumed and checked BEFORE any identifier-keyed
 * bucket is written, or a caller who is already IP-limited can keep minting
 * persistent limiter rows keyed on e-mail addresses they invent. `beginAuthRateLimit`
 * enforces that structurally: it consumes the IP dimension itself and only hands
 * back a `consumeIdentifier` closure, so an identifier bucket cannot be written
 * before the IP gate has answered. `scripts/security/check-auth-rate-limit-coverage.mjs`
 * gates it.
 */

import { getTrustedClientIp } from './requestSecurity.ts';

/**
 * The Supabase client, structurally. `rpc()` returns a PostgrestFilterBuilder —
 * a thenable, not a Promise — so this is deliberately `any`, matching
 * `requestSecurity.ts` and `publicAbuseControls.ts` rather than inventing a
 * stricter shape the real client does not satisfy.
 */
// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** Outcome of consuming one unit from one dimension. */
export interface AuthRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** True when the shared primitive was unavailable and the per-isolate fallback answered. */
  degraded: boolean;
}

export interface AuthRateLimitBudget {
  max: number;
  windowSeconds: number;
}

/**
 * Bucket keys must satisfy the RPC's own `^[a-z0-9:_./-]{1,200}$` check — it
 * raises rather than returning a row otherwise, which would look like an
 * outage. Anything outside the class is folded to a stable SHA-free token so a
 * unicode e-mail local part cannot turn into an exception.
 */
function normalizeKeyPart(value: string, maxLength = 96): string {
  const lowered = value.trim().toLowerCase();
  const safe = lowered.replace(/[^a-z0-9:_./-]/g, '_');
  return safe.length > maxLength ? safe.slice(0, maxLength) : safe || 'unknown';
}

// ── Per-isolate fallback ────────────────────────────────────────────────────
const localBuckets = new Map<string, { count: number; resetAt: number }>();

function consumeLocal(key: string, budget: AuthRateLimitBudget): AuthRateLimitDecision {
  const now = Date.now();
  const windowMs = budget.windowSeconds * 1000;
  const bucket = localBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    localBuckets.set(key, { count: 1, resetAt: now + windowMs });
    if (localBuckets.size > 5_000) {
      for (const [k, v] of localBuckets) if (v.resetAt <= now) localBuckets.delete(k);
    }
    return { allowed: true, retryAfterSeconds: 0, degraded: true };
  }
  bucket.count += 1;
  const allowed = bucket.count <= budget.max;
  return {
    allowed,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    degraded: true,
  };
}

/**
 * Consume one unit against the strongest limiter backend that answers.
 * Never throws — an auth endpoint that 500s because the limiter is sick is a
 * worse outcome than one that falls back to a per-isolate ceiling.
 */
export async function consumeAuthRateLimit(
  supabase: SupabaseLike,
  key: string,
  budget: AuthRateLimitBudget,
): Promise<AuthRateLimitDecision> {
  const normalized = normalizeKeyPart(key, 200);
  const max = Math.max(1, Math.floor(budget.max));
  const windowSeconds = Math.max(1, Math.floor(budget.windowSeconds));

  // 1. Preferred: returns count/remaining/retry_after in one round trip.
  try {
    const { data, error } = await supabase.rpc('security_consume_rate_limit', {
      p_key: normalized, p_max: max, p_window_seconds: windowSeconds,
    });
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    if (!error && row) {
      return {
        allowed: row.allowed === true,
        retryAfterSeconds: Number(row.retry_after_seconds ?? 0) || 0,
        degraded: false,
      };
    }
  } catch { /* fall through */ }

  // 2. Older peer primitive — boolean only, so retry-after is the full window.
  try {
    const { data, error } = await supabase.rpc('check_and_bump_rate_limit', {
      p_key: normalized, p_max: max, p_window_seconds: windowSeconds,
    });
    if (!error && typeof data === 'boolean') {
      return { allowed: data, retryAfterSeconds: data ? 0 : windowSeconds, degraded: false };
    }
  } catch { /* fall through */ }

  console.warn('[auth-rate-limit] shared limiter unavailable, using per-isolate fallback', { key: normalized });
  return consumeLocal(normalized, { max, windowSeconds });
}

/**
 * The source identity a limiter buckets on.
 *
 * `trusted:false` means the platform gave us no address header we are willing
 * to believe. We do NOT then trust `X-Forwarded-For` — that is the hole this
 * module closes. Every such caller shares one bucket, so the ceiling is applied
 * with a multiplier (see `UNTRUSTED_IP_MULTIPLIER`) to avoid one shared bucket
 * locking out an entire deployment whose edge stops setting the header.
 */
export function authClientIp(req: Request): { ip: string; trusted: boolean } {
  const trusted = getTrustedClientIp(req.headers);
  return trusted ? { ip: trusted, trusted: true } : { ip: 'untrusted', trusted: false };
}

/** Applied to the IP ceiling when no trustworthy address header is present. */
export const UNTRUSTED_IP_MULTIPLIER = 20;

export interface AuthRateLimitGate {
  /** False when the source-IP ceiling is already exhausted. */
  allowed: boolean;
  retryAfterSeconds: number;
  degraded: boolean;
  ip: string;
  ipTrusted: boolean;
  /**
   * Consume the identifier (e-mail / username) dimension. Callable only after
   * the IP gate has answered, which is what keeps ABUSE-003 structural rather
   * than a comment. For enumeration-sensitive handlers, call this ONLY once the
   * account has been confirmed to exist and be eligible.
   */
  consumeIdentifier: (identifier: string, budget: AuthRateLimitBudget) => Promise<AuthRateLimitDecision>;
}

export interface BeginAuthRateLimitOptions {
  /** Short bucket namespace, e.g. `cpl` for client-portal-login. */
  scope: string;
  ip: AuthRateLimitBudget;
}

/**
 * Consume the source-IP dimension for an auth endpoint and return a gate that
 * can then consume the identifier dimension.
 */
export async function beginAuthRateLimit(
  supabase: SupabaseLike,
  req: Request,
  options: BeginAuthRateLimitOptions,
): Promise<AuthRateLimitGate> {
  const scope = normalizeKeyPart(options.scope, 32);
  const { ip, trusted } = authClientIp(req);
  const budget: AuthRateLimitBudget = trusted
    ? options.ip
    : { max: options.ip.max * UNTRUSTED_IP_MULTIPLIER, windowSeconds: options.ip.windowSeconds };

  const decision = await consumeAuthRateLimit(supabase, `${scope}_ip:${normalizeKeyPart(ip, 48)}`, budget);

  return {
    allowed: decision.allowed,
    retryAfterSeconds: decision.retryAfterSeconds,
    degraded: decision.degraded,
    ip,
    ipTrusted: trusted,
    consumeIdentifier: (identifier: string, identifierBudget: AuthRateLimitBudget) =>
      consumeAuthRateLimit(supabase, `${scope}_id:${normalizeKeyPart(identifier)}`, identifierBudget),
  };
}

/**
 * One-shot helper for handlers with no enumeration concern (logins, password
 * changes): consume IP then identifier, stopping at the first denial.
 */
export async function enforceAuthRateLimit(
  supabase: SupabaseLike,
  req: Request,
  options: BeginAuthRateLimitOptions & { identifier?: string | null; identifierBudget?: AuthRateLimitBudget },
): Promise<AuthRateLimitDecision & { ip: string; ipTrusted: boolean }> {
  const gate = await beginAuthRateLimit(supabase, req, options);
  if (!gate.allowed) {
    return { allowed: false, retryAfterSeconds: gate.retryAfterSeconds, degraded: gate.degraded, ip: gate.ip, ipTrusted: gate.ipTrusted };
  }
  const identifier = options.identifier?.trim();
  if (identifier && options.identifierBudget) {
    const decision = await gate.consumeIdentifier(identifier, options.identifierBudget);
    return { ...decision, ip: gate.ip, ipTrusted: gate.ipTrusted };
  }
  return { allowed: true, retryAfterSeconds: 0, degraded: gate.degraded, ip: gate.ip, ipTrusted: gate.ipTrusted };
}

/**
 * 429 with `Retry-After`. The body deliberately carries no detail about which
 * dimension tripped — that would tell an attacker whether the account exists.
 */
export function authRateLimitedResponse(
  corsHeaders: Record<string, string>,
  retryAfterSeconds: number,
  message = 'Too many attempts. Please try again later.',
): Response {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds || 60));
  return new Response(
    JSON.stringify({ error: message, retry_after_seconds: retryAfter }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'Cache-Control': 'no-store',
      },
    },
  );
}
