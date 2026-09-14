/**
 * WP-11A — Session token hashing.
 *
 * Sessions are stored at rest as HMAC-SHA256(pepper, session_token) so that
 * a database leak cannot be replayed as a live cookie. The random token
 * itself is only ever held in the browser cookie / auth header.
 *
 * A dual-read compatibility window is preserved: `verifySession` looks up by
 * `token_hash` first, falls back to plaintext `session_token`, and lazily
 * backfills the hash on the winning row. Plaintext columns are dropped in a
 * later work package once every issuer has been migrated.
 *
 * SESSION_TOKEN_PEPPER must be set. It is a 32+ byte random value stored as
 * an Edge Function secret; if it is missing the module fails closed rather
 * than silently degrade to an unpeppered hash.
 */
const PEPPER_RAW = (globalThis as any).Deno?.env?.get?.('SESSION_TOKEN_PEPPER') ?? '';
const encoder = new TextEncoder();

let cachedKey: Promise<CryptoKey> | null = null;

function getKey(): Promise<CryptoKey> {
  if (!PEPPER_RAW || PEPPER_RAW.length < 16) {
    return Promise.reject(new Error(
      '[sessionHash] SESSION_TOKEN_PEPPER is missing or too short (>=16 chars required)',
    ));
  }
  if (!cachedKey) {
    cachedKey = crypto.subtle.importKey(
      'raw',
      encoder.encode(PEPPER_RAW),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return cachedKey;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Deterministically hash a session token. Result is a 64-char hex string.
 * Empty/null input returns null so callers can early-out cleanly.
 */
export async function hashSessionToken(token: string | null | undefined): Promise<string | null> {
  if (!token || typeof token !== 'string' || token.length === 0) return null;
  const key = await getKey();
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  return toHex(sig);
}

/** True when SESSION_TOKEN_PEPPER is configured with acceptable entropy. */
export function isSessionHashConfigured(): boolean {
  return typeof PEPPER_RAW === 'string' && PEPPER_RAW.length >= 16;
}

/**
 * Resolve a `user_sessions` row from a raw token using the hash column first and
 * the legacy plaintext `session_token` column only as a transitional fallback.
 * This is the single lookup path every reader should use so that hash-only
 * sessions (no plaintext at rest) are found everywhere. Returns the row or null.
 *
 * @param select  columns to select (must include what the caller needs; keep
 *                `id` so callers can act by primary key).
 * @param applyFilters  optional callback to add extra `.eq()/.gt()` filters to
 *                each candidate query (e.g. expiry / portal_scope).
 */
export async function resolveUserSessionRow(
  supabase: any,
  token: string | null | undefined,
  select = 'id, user_id, expires_at, token_hash, revoked_at, idle_expires_at',
  applyFilters?: (q: any) => any,
): Promise<any | null> {
  if (!token) return null;
  const withFilters = (q: any) => (applyFilters ? applyFilters(q) : q);
  const hash = isSessionHashConfigured() ? await hashSessionToken(token) : null;
  if (hash) {
    const { data } = await withFilters(
      supabase.from('user_sessions').select(select).eq('token_hash', hash),
    ).maybeSingle();
    if (data) return data;
  }
  const { data } = await withFilters(
    supabase.from('user_sessions').select(select).eq('session_token', token),
  ).maybeSingle();
  return data ?? null;
}

/**
 * Compute idle-expiry for a session. Defaults to 30 minutes but callers may
 * override for long-running finance/admin sessions.
 */
export function computeIdleExpiry(now: Date = new Date(), idleMinutes = 30): Date {
  return new Date(now.getTime() + Math.max(1, idleMinutes) * 60_000);
}

/**
 * Return true when the session should be treated as revoked or idle-expired.
 * Absolute `expires_at` is checked by the caller in the same query.
 */
export function isSessionUsable(row: {
  revoked_at?: string | null;
  idle_expires_at?: string | null;
}): { ok: boolean; reason?: 'revoked' | 'idle_expired' } {
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.idle_expires_at && new Date(row.idle_expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'idle_expired' };
  }
  return { ok: true };
}
