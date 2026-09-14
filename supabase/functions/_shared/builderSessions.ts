/**
 * Builder / Developer Portal — session lifecycle.
 *
 * Mirrors `_shared/solicitorSessions.ts`, but as a THIN TYPESCRIPT ADAPTER over
 * the Phase 1 database functions rather than a second session implementation:
 *
 *   builder_issue_session(_user_id, _token_hash, ...)   -> issue
 *   builder_resolve_session(_token_hash, _idle_minutes) -> resolve + idle slide
 *   builder_revoke_session(_session_id, _reason)        -> revoke one
 *   builder_revoke_user_sessions(_user_id, _reason, _except) -> revoke many
 *
 * Phase 1 owns the invariants (hash-only storage, expiry ordering, the
 * concurrent-revoke re-check, membership requirement at issue time). This module
 * does not re-implement any of them.
 *
 * The raw token exists only here and in the Set-Cookie header. It is hashed with
 * the repository's peppered `hashSessionToken` (HMAC-SHA256 with
 * SESSION_TOKEN_PEPPER, fails closed when unset) — never a bare SHA-256.
 */
import { hashSessionToken, computeIdleExpiry, isSessionHashConfigured } from './sessionHash.ts';

export const BUILDER_SESSION_ABSOLUTE_HOURS = 12;
export const BUILDER_SESSION_IDLE_MINUTES = 30;

/** One generic string for every credential failure — no account enumeration. */
export const GENERIC_AUTH_ERROR = 'Invalid email or password';

export interface IssuedBuilderSession {
  id: string;
  token: string;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
}

export interface ResolvedBuilderSession {
  session_id: string;
  builder_user_id: string;
  absolute_expires_at: string;
}

const rawToken = () => `${crypto.randomUUID()}-${crypto.randomUUID()}-${crypto.randomUUID()}`;

export function requestIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

const fingerprint = async (kind: string, value: string | null) =>
  value ? await hashSessionToken(`${kind}:${value}`) : null;

/**
 * Issue a Builder session. The database receives only the hash; the caller
 * receives the raw token solely to put in the Set-Cookie header.
 *
 * Throws when the user is inactive or holds no active membership — that rule
 * lives in `builder_issue_session`, not here.
 */
export async function issueBuilderSession(
  supabase: any,
  userId: string,
  req: Request,
  options: { deviceLabel?: string } = {},
): Promise<IssuedBuilderSession> {
  if (!isSessionHashConfigured()) {
    throw new Error('[builderSessions] SESSION_TOKEN_PEPPER is not configured — refusing to issue an unpeppered session');
  }

  const token = rawToken();
  const tokenHash = await hashSessionToken(token);
  if (!tokenHash) throw new Error('Session hashing unavailable');

  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + BUILDER_SESSION_ABSOLUTE_HOURS * 3_600_000);
  const idleExpiresAt = computeIdleExpiry(now, BUILDER_SESSION_IDLE_MINUTES);

  const { data, error } = await supabase.rpc('builder_issue_session', {
    _user_id: userId,
    _token_hash: tokenHash,
    _absolute_expires_at: absoluteExpiresAt.toISOString(),
    _idle_expires_at: idleExpiresAt.toISOString(),
    _ip_hash: await fingerprint('ip', requestIp(req)),
    _user_agent_hash: await fingerprint('ua', req.headers.get('user-agent')),
    _device_label: options.deviceLabel?.slice(0, 120) || null,
  });

  if (error || !data) throw error || new Error('Session creation failed');
  return { id: data as string, token, absoluteExpiresAt, idleExpiresAt };
}

/**
 * Resolve a raw cookie token to a session. Returns null for absent, expired,
 * revoked, or no-longer-permitted sessions — the database re-checks the user
 * and membership on every resolution, so losing the last membership ends access
 * immediately rather than at session expiry.
 */
export async function resolveBuilderSessionToken(
  supabase: any,
  token: string | null,
): Promise<ResolvedBuilderSession | null> {
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  if (!tokenHash) return null;

  const { data, error } = await supabase.rpc('builder_resolve_session', {
    _token_hash: tokenHash,
    _idle_minutes: BUILDER_SESSION_IDLE_MINUTES,
  });
  if (error) {
    console.error('[builderSessions] resolve failed', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.session_id || !row?.builder_user_id) return null;
  return row as ResolvedBuilderSession;
}

export async function revokeBuilderSession(
  supabase: any, sessionId: string, reason: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('builder_revoke_session', {
    _session_id: sessionId, _reason: reason,
  });
  if (error) throw error;
  return data === true;
}

export async function revokeAllBuilderSessions(
  supabase: any, userId: string, reason: string, exceptSessionId: string | null = null,
): Promise<number> {
  const { data, error } = await supabase.rpc('builder_revoke_user_sessions', {
    _user_id: userId, _reason: reason, _except_session_id: exceptSessionId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Append a Builder identity event to the trusted activity log.
 *
 * Unlike `auditSolicitorIdentity`, which logs a console error and continues,
 * this RETURNS whether the write succeeded so a caller performing an
 * access-control change can fail closed (Phase 0 NOCOPY-04). Identity events
 * that are observational — a failed login attempt, a logout — may ignore it.
 */
export async function auditBuilderIdentity(
  supabase: any,
  req: Request,
  entry: {
    userId?: string | null;
    organisationId?: string | null;
    actorType?: 'builder_user' | 'command_user' | 'service_role' | 'system';
    action: string;
    sessionId?: string | null;
    previousState?: Record<string, unknown> | null;
    newState?: Record<string, unknown> | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const ip = requestIp(req);
  const { error } = await supabase.rpc('builder_log_activity', {
    _actor_user_id: null,
    _actor_type: entry.actorType ?? 'builder_user',
    _action: entry.action,
    _entity_type: 'session',
    _entity_id: entry.sessionId ?? null,
    _organisation_id: entry.organisationId ?? null,
    _builder_user_id: entry.userId ?? null,
    _previous_state: entry.previousState ?? null,
    _new_state: entry.newState ?? null,
    _reason: entry.reason ?? null,
    _metadata: entry.metadata ?? {},
    _ip_address: ip,
    _user_agent: req.headers.get('user-agent') || null,
  });

  if (error) {
    console.error('[builderSessions] activity log failed', { action: entry.action, message: error.message });
    return false;
  }
  return true;
}
