/**
 * WP-10 — Shared abuse-control helpers for public / paid-provider edge functions.
 *
 * Provides:
 *   - `verifyTurnstile(token, ip)`  Cloudflare Turnstile verification, fail-closed
 *                                   when REQUIRE_TURNSTILE=true.
 *   - `enforceIpQuota` / `enforceActorQuota` / `enforceKeyQuota`   database
 *                                   atomic counters shared across instances.
 *   - `enforceGlobalCircuitBreaker` last-N-failure trip for paid providers.
 *   - `reserveUsage/commit/release` optimistic atomic global counters.
 *   - `killSwitchActive(name)`      env-flag gate.
 *   - `getClientIp(req)`            normalized IP extractor.
 *   - `sanitizeShortText(s, max)`   control-char stripper w/ length cap.
 *   - `fetchWithTimeout(url, opts, ms)` bounded upstream fetch.
 *   - `hashToken(token)`            SHA-256 hex for tracking-token equality.
 *   - `redactError(e)`              user-safe error message.
 *
 * Quotas use security_consume_rate_limit so horizontal scaling cannot evade
 * the ceiling. Circuit-breaker migration remains a separate provider task.
 */

import { getTrustedClientIp } from './requestSecurity.ts';

/**
 * Per-isolate fallback counter, used only when the shared DB primitive cannot
 * answer. Weaker than the shared limiter — a horizontally scaled deployment
 * gets one window per isolate — but a real ceiling nonetheless, and vastly
 * better than the two alternatives when the primitive is missing: no limit at
 * all, or (as this did) refusing every request.
 */
const localBuckets = new Map<string, { count: number; resetAt: number }>();

function consumeLocalQuota(key: string, opts: { limit: number; windowMs: number }): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = localBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    localBuckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    // Opportunistic sweep so a long-lived isolate does not accumulate keys.
    if (localBuckets.size > 5_000) {
      for (const [k, v] of localBuckets) if (v.resetAt <= now) localBuckets.delete(k);
    }
    return { ok: true, retryAfterMs: 0 };
  }
  bucket.count += 1;
  return bucket.count <= opts.limit
    ? { ok: true, retryAfterMs: 0 }
    : { ok: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
}

/**
 * Consume one unit against the shared rate-limit primitive.
 *
 * `security_consume_rate_limit` being UNAVAILABLE is a different fact from a
 * caller being over their limit, and conflating the two took down features
 * that were working correctly. The migration that defines it (20260723140000)
 * had never been applied to production, so every call returned an RPC error,
 * every helper reported `ok: false`, and Street View answered 429 to every
 * request while telling the user Google had no imagery for their address.
 *
 * So: an over-limit answer still denies, but an unavailable primitive falls
 * back to a per-isolate counter and logs. These callers are authenticated and
 * module-gated; the quota is defence-in-depth against a staff member looping,
 * not a public abuse boundary, and disabling the feature outright is the more
 * expensive failure.
 */
async function consumeQuota(supabase: any, key: string, opts: { limit: number; windowMs: number }): Promise<{ ok: boolean; retryAfterMs: number; degraded?: boolean }> {
  const { data, error } = await supabase.rpc('security_consume_rate_limit', { p_key: key, p_max: opts.limit, p_window_seconds: Math.max(1, Math.ceil(opts.windowMs / 1000)) });
  if (error || !data?.[0]) {
    console.warn('[abuse-controls] shared rate limiter unavailable, using per-isolate fallback:', error?.message ?? 'empty response');
    return { ...consumeLocalQuota(key, opts), degraded: true };
  }
  return { ok: data[0].allowed === true, retryAfterMs: Number(data[0].retry_after_seconds || 0) * 1000 };
}
export async function enforceIpQuota(supabase: any, ip: string | null, scope: string, opts: { limit: number; windowMs: number }) { return consumeQuota(supabase, `public:ip:${ip || 'unknown'}:${scope}`, opts); }
export async function enforceActorQuota(supabase: any, actorId: string, scope: string, opts: { limit: number; windowMs: number }) { return consumeQuota(supabase, `public:actor:${actorId}:${scope}`, opts); }
export async function enforceKeyQuota(supabase: any, key: string, scope: string, opts: { limit: number; windowMs: number }) { return consumeQuota(supabase, `public:key:${key}:${scope}`, opts); }

export async function enforceGlobalDailyQuota(supabase: any, scope: string, limit: number) { return consumeQuota(supabase, `public:global:${scope}:daily`, { limit, windowMs: 24 * 60 * 60 * 1000 }); }

// ---------------------------------------------------------------- Circuit breaker / reservations
// SEC-MED: the former in-memory circuit-breaker (`_breaker`) and usage-reservation
// (`_reservations`) helpers were process-local — under horizontal scaling each
// isolate kept its own counters, so neither the breaker nor the daily reservation
// held globally. They have been REMOVED (they had no remaining consumers). Every
// paid-provider path now uses shared atomic storage:
//   - Circuit breaker: provider_circuit_is_open / provider_circuit_record_failure
//     / provider_circuit_record_success RPCs (see google-places-autocomplete).
//   - Global daily / per-scope quotas: enforceGlobalDailyQuota / enforce*Quota
//     above (security_consume_rate_limit RPC).
// Do NOT reintroduce instance-local counters for cross-instance limits.

// ---------------------------------------------------------------- Env / flags
export function killSwitchActive(name: string): boolean {
  const v = Deno.env.get(name);
  return v === '1' || v === 'true' || v === 'TRUE';
}

// ---------------------------------------------------------------- Request helpers
export function getClientIp(req: Request): string | null {
  return getTrustedClientIp(req.headers);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
export function sanitizeShortText(s: unknown, max = 200): string {
  const v = typeof s === 'string' ? s : '';
  return v.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function redactError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  // Never expose provider/db internals to public callers.
  if (!msg) return 'internal_error';
  if (/service_role|supabase|postgres|jwt|bearer|secret|api[_-]?key|token/i.test(msg)) return 'internal_error';
  return msg.slice(0, 200);
}

// ---------------------------------------------------------------- Turnstile
export interface TurnstileResult { ok: boolean; failClosed: boolean; reason?: string }

export async function verifyTurnstile(token: string | null | undefined, ip: string | null): Promise<TurnstileResult> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  const required = Deno.env.get('REQUIRE_TURNSTILE') === 'true';

  if (!secret) {
    if (required) return { ok: false, failClosed: true, reason: 'turnstile_unavailable' };
    return { ok: true, failClosed: false };
  }
  // A configured secret makes verification available; it does not make the
  // challenge mandatory. Public clients that do not render Turnstile must
  // continue to work unless the explicit requirement flag is enabled.
  if (!token) {
    if (required) return { ok: false, failClosed: true, reason: 'turnstile_missing' };
    return { ok: true, failClosed: false };
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetchWithTimeout(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      5000,
    );
    const data = await res.json().catch(() => ({}));
    if (data?.success) return { ok: true, failClosed: false };
    return { ok: false, failClosed: required, reason: 'turnstile_failed' };
  } catch (_e) {
    return { ok: false, failClosed: required, reason: 'turnstile_error' };
  }
}

// ---------------------------------------------------------------- Honeypot + timing
export function honeypotTripped(body: Record<string, unknown>, fields: string[] = ['website', 'company_url', 'hp']): boolean {
  return fields.some((f) => {
    const v = body[f];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/** Minimum form-fill time — client sends `form_started_at` (unix ms). */
export function tooFastSubmission(body: Record<string, unknown>, minMs = 1200): boolean {
  const started = Number(body.form_started_at);
  if (!Number.isFinite(started) || started <= 0) return false;
  const elapsed = Date.now() - started;
  return elapsed >= 0 && elapsed < minMs;
}

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain) return e;
  // strip +tag and (for gmail) dots — reduces trivial duplicate captures
  let normLocal = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') normLocal = normLocal.replace(/\./g, '');
  return `${normLocal}@${domain}`;
}
