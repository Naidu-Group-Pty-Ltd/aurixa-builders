/**
 * Shared request-security primitives (WP-01).
 *
 * These helpers are deliberately fail-closed. They are additive: existing
 * callers retain legacy paths until their dedicated migration package moves
 * them to these APIs.
 */
import { verifyHuman, verifyInternal, verifyWebhookSecret, type AuthContext } from './auth_v2.ts';

export { verifyHuman };

const MIN_SECRET_LENGTH = 16;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export type PortalAuthContext = {
  ok: boolean;
  authType: 'client_portal' | 'finance_portal' | null;
  actorId: string | null;
  clientId: string | null;
  correlationId: string;
  errorCode: 'missing_credentials' | 'invalid_session' | 'inactive_actor' | null;
};

const portalCtx = (partial: Partial<PortalAuthContext>): PortalAuthContext => ({
  ok: false, authType: null, actorId: null, clientId: null,
  correlationId: crypto.randomUUID(), errorCode: null, ...partial,
});

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() || '';
  return trimmed.length > 0 && trimmed !== 'null' && trimmed !== 'undefined' ? trimmed : null;
}

/** Only accepts the platform's single-client address headers; never parses X-Forwarded-For. */
export function getTrustedClientIp(headers: Headers): string | null {
  const candidate = nonEmpty(headers.get('cf-connecting-ip')) ?? nonEmpty(headers.get('x-real-ip'));
  if (!candidate || candidate.includes(',') || candidate.length > 45) return null;
  return IPV4.test(candidate) || (candidate.includes(':') && IPV6.test(candidate)) ? candidate.toLowerCase() : null;
}

/** Reads a body incrementally and stops before buffering more than maxBytes. */
export async function enforceRawBodyLimit(req: Request, maxBytes: number): Promise<{ ok: true; raw: string } | { ok: false; error: Response }> {
  const contentLength = Number(req.headers.get('content-length'));
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || (Number.isFinite(contentLength) && contentLength > maxBytes)) {
    return { ok: false, error: securityJsonError(413, 'request_too_large') };
  }
  if (!req.body) return { ok: true, raw: '' };

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel('request_too_large');
      return { ok: false, error: securityJsonError(413, 'request_too_large') };
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return { ok: true, raw };
}

/** Reads a bounded JSON body before parsing, preventing unbounded allocation. */
export async function enforceJsonBodyLimit<T = unknown>(req: Request, maxBytes: number): Promise<{ ok: true; value: T; raw: string } | { ok: false; error: Response }> {
  const bounded = await enforceRawBodyLimit(req, maxBytes);
  if (bounded.ok === false) return { ok: false, error: bounded.error };
  const { raw } = bounded;
  try { return { ok: true, value: JSON.parse(raw) as T, raw }; }
  catch { return { ok: false, error: securityJsonError(400, 'invalid_request') }; }
}

/** Validates a base64 payload length before decoding or forwarding it. */
export function enforceBase64Limit(value: unknown, maxEncodedChars: number, maxDecodedBytes: number): { ok: true; normalized: string; decodedBytes: number } | { ok: false; error: Response } {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxEncodedChars || !Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes <= 0) {
    return { ok: false, error: securityJsonError(413, 'payload_too_large') };
  }
  const normalized = value.replace(/^data:[^;,]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return { ok: false, error: securityJsonError(400, 'invalid_request') };
  const decodedBytes = Math.floor((normalized.length * 3) / 4) - (normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0);
  return decodedBytes <= maxDecodedBytes ? { ok: true, normalized, decodedBytes } : { ok: false, error: securityJsonError(413, 'payload_too_large') };
}

/** Generic client-safe error response; detailed reason codes stay in server logs/audit events. */
export function securityJsonError(status: 400 | 401 | 403 | 413 | 429 | 503, code: string, correlationId = crypto.randomUUID()): Response {
  const message = status === 401 ? 'Authentication required' : status === 403 ? 'Access denied' : status === 429 ? 'Too many requests' : status === 503 ? 'Service unavailable' : 'Invalid request';
  return new Response(JSON.stringify({ error: message, code, correlation_id: correlationId }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function verifyRequiredWebhookSecret(configured: string | null | undefined, presented: string | null | undefined): boolean {
  return verifyWebhookSecret(configured, presented, MIN_SECRET_LENGTH);
}

export function verifyRequiredCronSecret(configured: string | null | undefined, presented: string | null | undefined): boolean {
  return verifyWebhookSecret(configured, presented, MIN_SECRET_LENGTH);
}

/** Strictly verifies a signed internal request and restricts its declared caller. */
export async function verifySignedInternal(supabase: any, req: Request, rawBody: string, allowedCallers: readonly string[]): Promise<AuthContext> {
  if ((Deno.env.get('INTERNAL_EDGE_SECRET') || '').trim().length < MIN_SECRET_LENGTH) {
    return { ok: false, authType: null, actorId: null, username: null, roles: [], method: null, correlationId: crypto.randomUUID(), errorCode: 'missing_credentials' };
  }
  const signed = await verifyInternal(supabase, req, rawBody, { allowLegacyStaticSecret: false, allowLegacyServiceRoleKey: false });
  if (!signed.ok || signed.method !== 'internal_hmac' || !signed.actorId || !allowedCallers.includes(signed.actorId)) {
    return { ...signed, ok: false, authType: null, actorId: null, username: null, roles: [], method: null, errorCode: signed.ok ? 'invalid_internal_signature' : signed.errorCode };
  }
  return signed;
}

export async function requireHumanOrSignedInternal(supabase: any, req: Request, rawBody: string, allowedCallers: readonly string[], body?: { session_token?: string; command_centre_session_token?: string }): Promise<AuthContext> {
  const internal = await verifySignedInternal(supabase, req, rawBody, allowedCallers);
  return internal.ok ? internal : verifyHuman(supabase, req, body);
}

export async function verifyPortalSession(supabase: any, token: string | null | undefined): Promise<PortalAuthContext> {
  const sessionToken = nonEmpty(token);
  if (!sessionToken) return portalCtx({ errorCode: 'missing_credentials' });
  // WP-11A: dual-read — hashed lookup preferred, plaintext fallback until WP-11B closes the window.
  let hash: string | null = null;
  try {
    const mod = await import('./sessionHash.ts');
    if (mod.isSessionHashConfigured()) hash = await mod.hashSessionToken(sessionToken);
  } catch { /* pepper missing → fallback path */ }

  let row: any = null;
  if (hash) {
    const { data } = await supabase.from('client_portal_sessions')
      .select('id, user_id, revoked_at, idle_expires_at, token_hash, client_portal_users:user_id ( id, client_id, status )')
      .eq('token_hash', hash).gt('expires_at', new Date().toISOString()).maybeSingle();
    row = data ?? null;
  }
  if (!row) {
    const { data } = await supabase.from('client_portal_sessions')
      .select('id, user_id, revoked_at, idle_expires_at, token_hash, client_portal_users:user_id ( id, client_id, status )')
      .eq('session_token', sessionToken).gt('expires_at', new Date().toISOString()).maybeSingle();
    row = data ?? null;
  }
  const user = row?.client_portal_users;
  if (!row || !user) return portalCtx({ errorCode: 'invalid_session' });
  if (row.revoked_at) return portalCtx({ errorCode: 'invalid_session' });
  if (row.idle_expires_at && new Date(row.idle_expires_at).getTime() < Date.now()) return portalCtx({ errorCode: 'invalid_session' });
  if (user.status !== 'active') return portalCtx({ errorCode: 'inactive_actor' });
  // Best-effort backfill.
  try {
    const patch: Record<string, unknown> = { last_used_at: new Date().toISOString() };
    if (hash && !row.token_hash) patch.token_hash = hash;
    await supabase.from('client_portal_sessions').update(patch).eq('id', row.id);
  } catch { /* non-fatal */ }
  return portalCtx({ ok: true, authType: 'client_portal', actorId: user.id, clientId: user.client_id, errorCode: null });
}

export async function verifyFinancePortalSession(supabase: any, token: string | null | undefined): Promise<PortalAuthContext> {
  const sessionToken = nonEmpty(token);
  if (!sessionToken) return portalCtx({ errorCode: 'missing_credentials' });
  let hash: string | null = null;
  try {
    const mod = await import('./sessionHash.ts');
    if (mod.isSessionHashConfigured()) hash = await mod.hashSessionToken(sessionToken);
  } catch { /* fallback */ }

  let data: any = null;
  if (hash) {
    const res = await supabase.from('finance_portal_users')
      .select('id, finance_contact_id, is_active, revoked_at, session_expires_at, session_idle_expires_at, session_token_hash')
      .eq('session_token_hash', hash).maybeSingle();
    data = res.data ?? null;
  }
  if (!data) {
    const res = await supabase.from('finance_portal_users')
      .select('id, finance_contact_id, is_active, revoked_at, session_expires_at, session_idle_expires_at, session_token_hash')
      .eq('session_token', sessionToken).maybeSingle();
    data = res.data ?? null;
  }
  if (!data) return portalCtx({ errorCode: 'invalid_session' });
  if (!data.is_active || data.revoked_at || !data.session_expires_at || new Date(data.session_expires_at) <= new Date()) {
    return portalCtx({ errorCode: 'inactive_actor' });
  }
  if (data.session_idle_expires_at && new Date(data.session_idle_expires_at).getTime() < Date.now()) {
    return portalCtx({ errorCode: 'invalid_session' });
  }
  try {
    const patch: Record<string, unknown> = { session_last_used_at: new Date().toISOString() };
    if (hash && !data.session_token_hash) patch.session_token_hash = hash;
    await supabase.from('finance_portal_users').update(patch).eq('id', data.id);
  } catch { /* non-fatal */ }
  return portalCtx({ ok: true, authType: 'finance_portal', actorId: data.id, clientId: data.finance_contact_id ?? null, errorCode: null });
}

export type RateLimitResult = { allowed: boolean; count: number; remaining: number; retryAfterSeconds: number };
export async function consumeRateLimit(supabase: any, key: string, max: number, windowSeconds: number): Promise<RateLimitResult> {
  const normalized = key.trim().toLowerCase();
  if (!/^[a-z0-9:_./-]{1,200}$/.test(normalized) || !Number.isInteger(max) || max < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error('Invalid rate limit parameters');
  const { data, error } = await supabase.rpc('security_consume_rate_limit', { p_key: normalized, p_max: max, p_window_seconds: windowSeconds });
  if (error || !data?.[0]) throw new Error('Rate limit unavailable');
  const row = data[0];
  return { allowed: row.allowed === true, count: Number(row.count), remaining: Number(row.remaining), retryAfterSeconds: Number(row.retry_after_seconds) };
}
