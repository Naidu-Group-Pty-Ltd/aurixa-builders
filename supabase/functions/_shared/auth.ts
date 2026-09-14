/**
 * Shared authentication utilities for Edge Functions
 * Validates session tokens from the custom auth system
 * Supports HttpOnly cookies for XSS protection
 * Also supports Supabase JWT when verify_jwt is enabled (defense in depth)
 *
 * SECURITY: Bearer JWTs are ALWAYS cryptographically verified before any
 * claim (sub/role) is trusted. Most functions run with verify_jwt=false at
 * the gateway, so in-function signature verification is the trust boundary.
 */

import { verifySupabaseJWT } from './jwt.ts';
import { hashSessionToken, isSessionHashConfigured, computeIdleExpiry, isSessionUsable } from './sessionHash.ts';

/** Constant-time string comparison (avoids leaking a secret via timing). */
function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SessionValidationResult {
  error: string | null;
  userId: string | null;
  username: string | null;
  authMethod?: 'jwt' | 'session' | 'service_role'; // Track which auth method was used
}

/**
 * Verify a session token is valid and not expired
 * @param supabase - Supabase client with service_role
 * @param sessionToken - The session token from the request
 * @returns Session validation result with user info or error
 */
export async function verifySession(
  supabase: any,
  sessionToken: string | null | undefined
): Promise<SessionValidationResult> {
  if (!sessionToken) {
    console.log('[verifySession] No session token provided');
    return { error: 'Authentication required', userId: null, username: null };
  }

  // WP-11A: never log a preview of the token; hash-derived id is what we key on.
  console.log('[verifySession] Verifying session token (length:', sessionToken.length, ')');

  try {
    // WP-11A: dual-read. Prefer HMAC hash lookup so a DB dump cannot be
    // replayed as a live cookie; fall back to the legacy plaintext column
    // for sessions issued before the migration window closed.
    const hash = isSessionHashConfigured() ? await hashSessionToken(sessionToken) : null;

    type Row = {
      id: string;
      user_id: string;
      expires_at: string;
      token_hash: string | null;
      revoked_at: string | null;
      idle_expires_at: string | null;
    };

    let session: Row | null = null;

    if (hash) {
      const { data } = await supabase
        .from('user_sessions')
        .select('id, user_id, expires_at, token_hash, revoked_at, idle_expires_at')
        .eq('token_hash', hash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      session = (data as Row | null) ?? null;
    }

    let matchedByPlaintext = false;
    if (!session) {
      const { data, error: sessionError } = await supabase
        .from('user_sessions')
        .select('id, user_id, expires_at, token_hash, revoked_at, idle_expires_at')
        .eq('session_token', sessionToken)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (sessionError) {
        console.log('[verifySession] Session query error:', sessionError.code, sessionError.message);
      }
      if (data) {
        session = data as Row;
        matchedByPlaintext = true;
      }
    }

    if (!session) {
      return { error: 'Invalid or expired session', userId: null, username: null };
    }

    // WP-11A: idle-expiry and revocation checks.
    const usable = isSessionUsable(session);
    if (!usable.ok) {
      console.log('[verifySession] Session unusable:', usable.reason);
      return { error: 'Session revoked or expired', userId: null, username: null };
    }

    // WP-11A: lazily backfill token_hash + last_used_at, and SLIDE the
    // idle-expiry forward on every successful verify. Previously idle_expires_at
    // was only set when null, which effectively pinned the idle deadline to
    // 30 minutes after login and killed active sessions.
    try {
      const patch: Record<string, unknown> = {
        last_used_at: new Date().toISOString(),
        idle_expires_at: computeIdleExpiry().toISOString(),
      };
      if (hash && (matchedByPlaintext || !session.token_hash)) patch.token_hash = hash;
      await supabase.from('user_sessions').update(patch).eq('id', session.id);
    } catch (bfErr) {
      console.log('[verifySession] Backfill non-fatal error:', (bfErr as Error).message);
    }


    // A session is valid only while its owning custom user remains active and
    // has not been soft-deleted. This prevents disabling a user from leaving
    // existing sessions usable until their expiry.
    const { data: user } = await supabase
      .from('custom_users')
      .select('username, is_active, deleted_at')
      .eq('id', session.user_id)
      .maybeSingle();

    if (!user || user.is_active !== true || user.deleted_at !== null) {
      console.log('[verifySession] Session user missing, inactive, or deleted');
      return { error: 'Invalid or expired session', userId: null, username: null };
    }

    console.log('[verifySession] Session authentication successful (userId 8-prefix:',
      session.user_id?.substring(0, 8) + '...',
      'username:', user?.username || 'not found', ')');

    return {
      error: null,
      userId: session.user_id,
      username: user?.username || null,
      authMethod: 'session',
    };
  } catch (err) {
    console.error('[verifySession] Session verification error:', err);
    return { error: 'Session verification failed', userId: null, username: null };
  }
}

/**
 * Verify authentication using either Supabase JWT (when verify_jwt is enabled) or custom session token
 * This provides defense in depth - JWT is checked first, then falls back to session token
 * @param supabase - Supabase client with service_role
 * @param headers - Request headers (for JWT from Authorization header)
 * @param body - Request body (for session_token)
 * @returns Session validation result with user info or error
 */
export async function verifyAuth(
  supabase: any,
  headers: Headers,
  body?: { session_token?: string; command_centre_session_token?: string }
): Promise<SessionValidationResult> {
  // DIAGNOSTIC: presence-only. WP-11A/P1-LOG: never log previews of credential
  // material (Authorization prefix, Cookie preview, token prefix) — those leak
  // exploitable bytes of a session cookie/JWT into logs.
  const authHeader = headers.get('authorization');
  const cookieHeader = headers.get('cookie');
  const commandCentreSessionHeader = headers.get('x-command-centre-session-token');
  const sessionHeader = headers.get('x-session-token');
  console.log('[verifyAuth] Headers check:', {
    hasAuthHeader: !!authHeader,
    hasCookieHeader: !!cookieHeader,
    hasCommandCentreSessionHeader: !!commandCentreSessionHeader,
    hasSessionHeader: !!sessionHeader,
    hasBody: !!body,
    bodyHasCommandCentreSessionToken: !!(body?.command_centre_session_token),
    bodyHasSessionToken: !!(body?.session_token)
  });

  // Internal-service auth (AUTH-002): a dedicated INTERNAL_EDGE_SECRET presented
  // in x-internal-edge-secret authorizes an internal edge-to-edge call as
  // service_role, WITHOUT spreading the crown-jewel service-role key on the
  // wire. Constant-time compared; headers-only. This lets every receiver that
  // already accepts service_role via verifyAuth transparently accept the safer
  // internal credential.
  const internalSecret = (Deno.env.get('INTERNAL_EDGE_SECRET') || '').trim();
  const presentedInternal = (headers.get('x-internal-edge-secret') || '').trim();
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (internalSecret.length >= 16 && (
        (presentedInternal.length > 0 && constantTimeEqualStr(internalSecret, presentedInternal)) ||
        (bearerToken.length > 0 && constantTimeEqualStr(internalSecret, bearerToken))
      )) {
    console.log('[verifyAuth] Valid INTERNAL_EDGE_SECRET - allowing internal service call');
    return { error: null, userId: 'service_role', username: 'system', authMethod: 'service_role' };
  }

  // First, try the Authorization header. SECURITY: claims from a Bearer JWT
  // are only trusted after cryptographic verification. Most functions run
  // with verify_jwt=false at the gateway, so a decoded-but-unverified payload
  // is attacker-controlled input (forged sub/role, alg=none, etc.).
  if (authHeader?.startsWith('Bearer ')) {
    const jwtToken = authHeader.substring(7).trim();

    // AUTH-004 / SEC5-P0.2: the raw service-role key is NO LONGER accepted as a
    // Bearer credential (the previous `sb_secret_*` direct-comparison put the
    // crown-jewel key on the wire as an inter-function Authorization value).
    // Internal callers present the dedicated INTERNAL_EDGE_SECRET via the
    // `x-internal-edge-secret` header (handled above); pg_cron sends that header
    // too. A cryptographically-verified service_role JWT is still honoured below
    // (a signed token, not the raw key).

    // The anon key is public and identifies nobody; fall through to session auth.
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const isAnonKey = !!anonKey && jwtToken === anonKey.trim();

    if (jwtToken.includes('.') && !isAnonKey) {
      try {
        // 1) Verify the HS256 signature against the project JWT secret. This
        //    covers both custom-auth JWTs (issued by _shared/jwt.ts) and
        //    legacy Supabase keys/JWTs signed with the same secret.
        const payload = await verifySupabaseJWT(jwtToken);

        if (payload) {
          if ((payload as any).role === 'service_role') {
            console.log('[verifyAuth] Verified service_role JWT - allowing internal service call');
            return {
              error: null,
              userId: 'service_role',
              username: 'system',
              authMethod: 'service_role',
            };
          }

          if (payload.sub && payload.role === 'authenticated') {
            // Signature is valid; confirm the user is active and not soft-deleted.
            const { data: user, error: userError } = await supabase
              .from('custom_users')
              .select('username, id, is_active, deleted_at')
              .eq('id', payload.sub)
              .maybeSingle();

            if (!userError && user && user.is_active === true && user.deleted_at === null) {
              console.log('[verifyAuth] JWT authentication successful:', { userId: payload.sub.substring(0, 8) + '...', username: user.username });
              return {
                error: null,
                userId: payload.sub,
                username: user.username || null,
                authMethod: 'jwt',
              };
            }
            console.log('[verifyAuth] Verified JWT but user missing/inactive in custom_users, falling back to session token');
          } else {
            console.log('[verifyAuth] Verified JWT is not an authenticated user token (role:', payload.role, '), falling back to session token');
          }
        } else {
          // 2) HS256 verification failed. The token may be a native Supabase
          //    Auth JWT signed with a newer (possibly asymmetric) key — verify
          //    it with the Auth server instead of trusting decoded claims.
          const supabaseUrl = Deno.env.get('SUPABASE_URL');
          if (supabaseUrl && anonKey) {
            const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
              headers: { Authorization: `Bearer ${jwtToken}`, apikey: anonKey },
            });
            if (resp.ok) {
              const authUser = await resp.json();
              if (authUser?.id) {
                const { data: user, error: userError } = await supabase
                  .from('custom_users')
                  .select('username, id, is_active, deleted_at')
                  .eq('id', authUser.id)
                  .maybeSingle();
                if (!userError && user && user.is_active === true && user.deleted_at === null) {
                  console.log('[verifyAuth] Auth-server-verified JWT successful:', { userId: String(authUser.id).substring(0, 8) + '...' });
                  return {
                    error: null,
                    userId: String(authUser.id),
                    username: user.username || null,
                    authMethod: 'jwt',
                  };
                }
              }
            }
          }
          console.log('[verifyAuth] Bearer JWT failed cryptographic verification, falling back to session token');
        }
      } catch (err) {
        console.log('[verifyAuth] JWT verification errored, falling back to session token:', err);
        // Fall through to session token check
      }
    }
  }

  // Fall back to custom session token authentication
  // This is the primary authentication method for the custom auth system
  console.log('[verifyAuth] Attempting session token extraction...');
  const sessionToken = extractSessionToken(headers, body);
  console.log('[verifyAuth] Session token extracted:', sessionToken ? 'present' : 'null');

  if (!sessionToken) {
    console.log('[verifyAuth] No session token found - returning authentication required');
    return { error: 'Authentication required', userId: null, username: null };
  }

  console.log('[verifyAuth] Verifying session token...');
  return await verifySession(supabase, sessionToken);
}

/**
 * Verify the caller as EITHER a custom-auth user (session token / custom HS256
 * JWT → `custom_users`) OR a native Supabase Auth user (JWT verified against
 * the Auth server). The template-builder endpoints authenticate real humans
 * from both systems; accepting only one of them locked out the other and
 * surfaced as blanket "Authentication required" errors on every import.
 */
export async function verifyAuthOrNativeUser(
  supabase: any,
  req: Request,
  body?: { session_token?: string; command_centre_session_token?: string }
): Promise<SessionValidationResult> {
  const custom = await verifyAuth(supabase, req.headers, body);
  if (!custom.error) return custom;

  // Fallback: a native Supabase Auth user (verify the JWT with the Auth server).
  try {
    const authHeader = req.headers.get('authorization');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (authHeader?.startsWith('Bearer ') && anonKey && supabaseUrl) {
      const jwt = authHeader.substring(7).trim();
      // The anon key itself is not a user.
      if (jwt && jwt !== anonKey.trim()) {
        const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey },
        });
        if (resp.ok) {
          const user = await resp.json();
          if (user?.id) {
            console.log('[verifyAuthOrNativeUser] Native Supabase Auth user verified:', String(user.id).substring(0, 8) + '...');
            return {
              error: null,
              userId: String(user.id),
              username: user.email ?? null,
              authMethod: 'jwt',
            };
          }
        }
      }
    }
  } catch (err) {
    console.log('[verifyAuthOrNativeUser] Native auth fallback failed:', err);
  }
  return custom; // original custom-auth error (message + null user)
}

/**
 * Parse cookies from Cookie header
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name] = rest.join('=');
    }
  });
  
  return cookies;
}

/**
 * Extract session token from request headers, cookies, or body
 * Priority: Cookie > x-command-centre-session-token header > x-session-token header > body > Authorization header (only if not a JWT)
 * Supports HttpOnly cookies for XSS protection
 * 
 * NOTE: We check Authorization header LAST and only if it doesn't look like a JWT
 * to avoid treating the Supabase anon key as a session token
 */
export function extractSessionToken(
  headers: Headers,
  // Body is accepted for signature compatibility but ignored — WP-11B/C Phase 4
  // sunsets every non-cookie carrier.
  _body?: { session_token?: string | null; command_centre_session_token?: string | null }
): string | null {
  const isValidToken = (t: any): t is string =>
    typeof t === 'string' && t.length > 0 && t !== 'null' && t !== 'undefined';

  // WP-11B/C Phase 4: the `__Host-session_token` HttpOnly cookie is the SOLE
  // carrier for staff sessions. The legacy `session_token` cookie name and
  // every header/body/authorization fallback that was tagged as
  // `[wp11c.legacy_fallback]` during the Phase 3 soak has been removed.
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  return isValidToken(cookies['__Host-session_token']) ? cookies['__Host-session_token'] : null;
}


/**
 * Create CORS headers with credentials support for cookies
 * Uses dynamic origin for security
 *
 * SECURITY (SEC5-CORS): this response carries `Access-Control-Allow-Credentials:
 * true`, so the reflected origin must be an EXACT, fully-qualified match — never
 * a shared hosting suffix. Suffix trust for `*.lovable.app` /
 * `*.lovableproject.com` was removed: a hostile page on any such subdomain could
 * otherwise read a credentialed response (staff-session exfiltration chain).
 *
 * Allowed origins come from `ALLOWED_ORIGINS` (comma-separated, fully-qualified
 * URLs) plus localhost for development. Preview deployments must be listed by
 * full URL in `ALLOWED_ORIGINS`. As a deliberate, auditable escape hatch,
 * setting `CORS_ALLOW_LOVABLE_PREVIEW=true` re-enables the Lovable suffix match
 * for non-production preview environments — it is OFF by default so production
 * is exact-origin without any configuration.
 *
 * SAFETY FALLBACK: If `ALLOWED_ORIGINS` is unset, we fall back to the legacy
 * production origin so existing deployments never break. Set `ALLOWED_ORIGINS`.
 */

const LEGACY_FALLBACK_ORIGINS = [
  'https://command-centre.npcservices.com.au',
  'https://npc-property-dashbord.lovable.app',
];

// Exact, project-owned preview origins. These are safe to include regardless
// of ALLOWED_ORIGINS and avoid credentialed auth requests failing CORS when the
// preview host differs from the published host. Deliberately no suffix match.
const PROJECT_PREVIEW_ORIGINS = [
  'https://id-preview--7976d60b-c277-4851-889b-c170285f4be2.lovable.app',
  'https://7976d60b-c277-4851-889b-c170285f4be2.lovableproject.com',
];

/**
 * CORS-REQ-HEADERS: canonical allowlist of REQUEST headers the browser may send.
 *
 * A preflight succeeds only when EVERY header the client puts in
 * `Access-Control-Request-Headers` appears here. A header the app sends but
 * that is missing from this list fails the preflight, so the real request is
 * never dispatched and `fetch()` rejects with an opaque `TypeError: Failed to
 * fetch` — indistinguishable from the function being down.
 *
 * `src/lib/secureInvoke.ts` attaches `x-correlation-id` to EVERY edge-function
 * call and `x-step-up-token` to step-up-gated calls, so both must stay listed.
 * Anything new added to a client request header must be added here in the same
 * change; `scripts/security/check-cors-contract.mjs` enforces that.
 */
export const CORS_ALLOWED_REQUEST_HEADERS = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  // Observability + step-up (sent by src/lib/secureInvoke.ts).
  'x-correlation-id',
  'x-step-up-token',
  // Session carriers for the staff / client / finance / solicitor portals.
  'x-session-token',
  'x-command-centre-session-token',
  'x-portal-session-token',
  'x-finance-session-token',
  'x-solicitor-session-token',
  'x-portal-request',
  'x-session-id',
  'x-generation-run-id',
  // PostgREST headers sent by supabase-js when a query is routed through the
  // `authenticated-data` gateway. Omitting them failed the CORS preflight, so
  // every gateway read/write surfaced as a bare "Failed to fetch".
  'prefer',
  'accept-profile',
  'content-profile',
  'range',
  'range-unit',
  'x-supabase-api-version',
].join(', ');

/**
 * CORS-RES-HEADERS: response headers the browser is allowed to reveal to JS.
 *
 * Cross-origin, `response.headers.get()` can only see the seven CORS-safelisted
 * response headers unless the header is named here. Without this list the
 * metering/correlation headers below silently read back as `null`, so token
 * accounting records 0 and correlation ids never reach the client logs.
 */
export const CORS_EXPOSED_RESPONSE_HEADERS = [
  'x-correlation-id',
  'x-tokens-used',
  'x-tokens-reserved',
  'x-tokens-estimated',
  'x-duration-ms',
  // PostgREST count/pagination metadata; `count: 'exact'` reads this back.
  'content-range',
  'content-profile',
].join(', ');


function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') || '';
  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (fromEnv.length > 0) {
    return fromEnv;
  }

  // WP-19: unset falls through to LEGACY_FALLBACK_ORIGINS. Two things are wrong
  // with that and only one of them can be fixed from here.
  //
  // The problem is config hygiene, not exposure. The fallback is two exact,
  // legitimate production hostnames — an allowlist, not a wildcard — so nothing
  // is over-trusted today. What is wrong is that a missing variable is invisible
  // (the app works, so nobody sets it) and that trust stays pinned to hostnames
  // in source after the app moves off them.
  //
  // This deliberately does NOT fail closed. Whether `ALLOWED_ORIGINS` is set on
  // the deployed project cannot be determined from this repository, and it
  // cannot be determined from outside either: probing a deployed function with a
  // disallowed origin returns `allowedOrigins[0]`, which is
  // `command-centre.npcservices.com.au` whether the variable is set to it or the
  // fallback supplied it. The two states are indistinguishable, and guessing
  // wrong takes every browser client offline at once — an outage traded for a
  // hygiene improvement is a bad trade.
  //
  // So it stays available and gets loud instead. `CORS_STRICT_ALLOWED_ORIGINS=true`
  // opts into failing closed once the operator has confirmed the variable is
  // set; NT-41 in the live negative-test matrix is what confirms it, because
  // that harness runs against the deployed system, which is the only place the
  // answer exists.
  if ((Deno.env.get('CORS_STRICT_ALLOWED_ORIGINS') || '').trim().toLowerCase() === 'true') {
    console.error('[auth.cors] ALLOWED_ORIGINS is unset and CORS_STRICT_ALLOWED_ORIGINS=true — no production origin is trusted for credentialed responses. Set ALLOWED_ORIGINS.');
    return [];
  }
  console.error(
    '[auth.cors] ALLOWED_ORIGINS is UNSET. Falling back to hardcoded legacy origins '
    + `(${LEGACY_FALLBACK_ORIGINS.join(', ')}). This is configuration debt: those hostnames stay `
    + 'trusted for credentialed responses even after this app moves off them. Set ALLOWED_ORIGINS, '
    + 'then set CORS_STRICT_ALLOWED_ORIGINS=true to make this state fail closed.',
  );
  return LEGACY_FALLBACK_ORIGINS;
}

/**
 * Opt-in, non-production escape hatch for Lovable preview iframes. OFF unless
 * `CORS_ALLOW_LOVABLE_PREVIEW=true` is explicitly set. Production leaves this
 * unset, so suffix origins are NOT trusted for credentialed responses.
 */
function lovablePreviewSuffixAllowed(origin: string): boolean {
  if ((Deno.env.get('CORS_ALLOW_LOVABLE_PREVIEW') || '').trim().toLowerCase() !== 'true') return false;
  try {
    const host = new URL(origin).hostname;
    return host.endsWith('.lovable.app') || host.endsWith('.lovableproject.com');
  } catch {
    return false;
  }
}

/**
 * The exact origins trusted for CREDENTIALED responses — i.e. the ones allowed
 * to read a response carrying the staff session cookie.
 */
function credentialedOriginAllowlist(): string[] {
  // WP-19: the two exact preview origins used to sit here unconditionally,
  // which contradicted the posture stated two functions up — "Production leaves
  // this unset, so suffix origins are NOT trusted for credentialed responses."
  // The suffix rule was gated and the exact list was not, so two Lovable
  // preview URLs could read a response carrying the staff session cookie in
  // production. Both now answer to the same flag.
  const preview = (Deno.env.get('CORS_ALLOW_LOVABLE_PREVIEW') || '').trim().toLowerCase() === 'true'
    ? PROJECT_PREVIEW_ORIGINS
    : [];
  return [
    ...parseAllowedOrigins(),
    ...preview,
    'http://localhost:5173',
    'http://localhost:8080',
    // Belt and braces: guarantees the list is never empty, so the
    // `allowedOrigins[0]` used as the deliberate mismatch below is always a
    // defined string and never `Access-Control-Allow-Origin: undefined`.
    // `.invalid` is reserved by RFC 2606 and resolves nowhere.
    'https://origin.invalid',
  ];
}

/**
 * Is this origin trusted to receive a credentialed CORS response?
 *
 * Exported because `createTokenAuthCorsHeaders` needs the same answer without
 * inheriting `createCorsHeaders`'s "mismatched ACAO" behaviour for origins that
 * are NOT on the list (see that function for why the difference matters).
 */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return credentialedOriginAllowlist().includes(origin) || lovablePreviewSuffixAllowed(origin);
}

export function createCorsHeaders(origin: string | null = null): Record<string, string> {
  const allowedOrigins = credentialedOriginAllowlist();

  // Exact-origin allowlist only. Suffix matching is gated behind an explicit,
  // default-off preview flag (see lovablePreviewSuffixAllowed). A disallowed
  // origin gets a mismatched ACAO (allowedOrigins[0]) that the browser refuses
  // to expose to the caller.
  const allowedOrigin = isAllowedOrigin(origin) ? origin! : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    // Required for browser preflight (POST + application/json)
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOWED_REQUEST_HEADERS,
    // Without this the client reads back `null` for every custom header.
    'Access-Control-Expose-Headers': CORS_EXPOSED_RESPONSE_HEADERS,
    // Required for HttpOnly cookie auth
    'Access-Control-Allow-Credentials': 'true',
    // Cache the preflight so each call isn't a two-round-trip.
    'Access-Control-Max-Age': '86400',
    // Ensure caches/proxies don't mix CORS responses across origins
    'Vary': 'Origin',
  };
}

/**
 * CORS headers for endpoints that historically answered every origin with a
 * wildcard because they authenticated on a Bearer token alone.
 *
 * ## Why this now takes the request origin
 *
 * The wildcard was chosen to avoid a hard failure: the plain origin-allowlist
 * variant answers a NON-allowlisted origin with a deliberately mismatched
 * `Access-Control-Allow-Origin`, which the browser surfaces as an opaque
 * "Failed to fetch" on EVERY call — indistinguishable from an outage.
 *
 * But a wildcard origin is only valid for an UNcredentialed request, so the
 * app had to call these endpoints with `credentials: 'omit'`. That stripped the
 * HttpOnly `__Host-session_token` cookie, and WP-11B/C Phase 4 had already made
 * that cookie the SOLE session carrier (`extractSessionToken` reads nothing
 * else). The only credential left was the HS256 access-token JWT — and the
 * ES256 remediation (see `supabase/functions/authenticated-data/index.ts`)
 * records that both projects now sign with ES256, so the browser holds no
 * usable one. The result was every PDF template import failing 401
 * "Authentication required", surfaced to the user as "Your sign-in session has
 * expired", on a session that was perfectly valid.
 *
 * So: answer an ALLOWLISTED origin exactly, with credentials, and the cookie
 * authenticates exactly as it does for the ~300 other functions. Answer anyone
 * else with the old wildcard, so token-only and non-browser callers keep
 * working and no origin ever gets the mismatched-ACAO hard failure. This is
 * strictly narrower than the previous blanket wildcard for credentialed
 * requests and identical to it for everything else.
 *
 * A function that accepts the cookie here MUST also run `enforceCsrf` (see
 * `_shared/csrfGuard.ts`) — ambient cookie authority is what CSRF exploits.
 */
export function createTokenAuthCorsHeaders(origin: string | null = null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOWED_REQUEST_HEADERS,
    'Access-Control-Expose-Headers': CORS_EXPOSED_RESPONSE_HEADERS,
    'Access-Control-Max-Age': '86400',
    // The answer now depends on the request origin, so caches must not serve
    // one origin's CORS response to another.
    'Vary': 'Origin',
  };

  if (isAllowedOrigin(origin)) {
    return {
      ...base,
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Credentials': 'true',
    };
  }

  return { ...base, 'Access-Control-Allow-Origin': '*' };
}

/**
 * Create session cookie header for login response
 */
export function createSessionCookie(
  sessionToken: string,
  expiresAt: Date,
  options?: { clear?: boolean }
): string {
  const maxAge = options?.clear ? 0 : Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  const expires = options?.clear ? new Date(0).toUTCString() : expiresAt.toUTCString();
  
  // HttpOnly: prevents JavaScript access (XSS protection)
  // Secure: only sent over HTTPS
  // SameSite=None: required because the app runs on a different site than *.supabase.co
  // (cross-site fetch). We rely on:
  //  - strict Origin allow-listing in createCorsHeaders
  //  - required apikey header (not possible in CSRF form posts)
  // to preserve CSRF protection.
  // Path=/: cookie available for all paths.
  // WP-11B: cookie name is `__Host-session_token` (host-prefixed per RFC 6265bis).
  //         The prefix forces Secure, Path=/, and forbids Domain — browsers
  //         reject the Set-Cookie if any of those invariants is violated,
  //         which prevents cookie-jar contamination from sibling subdomains.
  return `__Host-session_token=${options?.clear ? '' : sessionToken}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}; Expires=${expires}; Path=/`;
}

/**
 * Create a clear session cookie header for logout.
 * WP-11B/C Phase 4: the legacy `session_token` cookie name has been sunset;
 * only the `__Host-session_token` cookie is emitted/cleared.
 */
export function createClearSessionCookie(): string {
  return createSessionCookie('', new Date(0), { clear: true });
}

export function createClearSessionCookies(): string[] {
  const past = new Date(0).toUTCString();
  return [
    `__Host-session_token=; HttpOnly; Secure; SameSite=None; Max-Age=0; Expires=${past}; Path=/`,
  ];
}

/**
 * Client-portal-scoped session cookie.
 *
 * The Finance, Solicitor and Builder portals were each given a dedicated
 * cookie name for the reason recorded under `createFinanceSessionCookie`. The
 * Client Portal was the one that never got it: `client-portal-login`,
 * `client-portal-logout` and `client-portal-accept-invite` all called
 * `createSessionCookie`, so a client portal session was written into the
 * Command Centre's own `__Host-session_token`.
 *
 * Two consequences, both of which show up as soon as one address is registered
 * in more than one portal and a tester uses both in one browser — which is
 * exactly how this deployment is being exercised:
 *
 *  - A client portal sign-in overwrote the staff cookie with a token that is
 *    not in `user_sessions`, so the Command Centre's next call failed
 *    `verifySession` and the person was bounced to the login screen with
 *    "Authentication required" on a staff session that had not expired.
 *  - `client-portal-logout` cleared `__Host-session_token`, so signing out of
 *    the Client Portal silently signed the same browser out of the Command
 *    Centre.
 *
 * A distinct `__Host-` name makes a client portal session unpresentable as a
 * staff session and vice versa, which is what the other three portals already
 * rely on. Nothing reads this cookie as a *client portal* credential today —
 * that portal carries its token explicitly in the body and the
 * `x-portal-session-token` header — so the rename removes a collision without
 * changing how the Client Portal authenticates.
 */
export function createClientPortalSessionCookie(
  sessionToken: string,
  expiresAt: Date,
  options?: { clear?: boolean }
): string {
  const maxAge = options?.clear ? 0 : Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  const expires = options?.clear ? new Date(0).toUTCString() : expiresAt.toUTCString();
  return `__Host-client_session_token=${options?.clear ? '' : sessionToken}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}; Expires=${expires}; Path=/`;
}

export function createClearClientPortalSessionCookie(): string {
  return createClientPortalSessionCookie('', new Date(0), { clear: true });
}

/**
 * Finance-portal-scoped session cookie. Uses a dedicated cookie name so it does
 * NOT collide with the main dashboard's `__Host-session_token` when a user is
 * signed into both apps on the same browser (both cookies are scoped to
 * *.supabase.co because that's where edge functions live). Prior to this,
 * signing into the main dashboard overwrote the finance portal cookie and
 * every finance-portal-verify call returned 401.
 */
export function createFinanceSessionCookie(
  sessionToken: string,
  expiresAt: Date,
  options?: { clear?: boolean }
): string {
  const maxAge = options?.clear ? 0 : Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  const expires = options?.clear ? new Date(0).toUTCString() : expiresAt.toUTCString();
  return `__Host-finance_session_token=${options?.clear ? '' : sessionToken}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}; Expires=${expires}; Path=/`;
}

export function createClearFinanceSessionCookie(): string {
  return createFinanceSessionCookie('', new Date(0), { clear: true });
}

/**
 * Solicitor-portal-scoped session cookie. Same rationale as the finance
 * variant: a dedicated `__Host-`-prefixed name so signing into the Command
 * Centre, the Client Portal or the Finance Portal never clobbers the
 * solicitor's session (all edge functions share the *.supabase.co origin).
 */
export function createSolicitorSessionCookie(
  sessionToken: string,
  expiresAt: Date,
  options?: { clear?: boolean }
): string {
  const maxAge = options?.clear ? 0 : Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  const expires = options?.clear ? new Date(0).toUTCString() : expiresAt.toUTCString();
  return `__Host-solicitor_session_token=${options?.clear ? '' : sessionToken}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}; Expires=${expires}; Path=/`;
}

export function createClearSolicitorSessionCookie(): string {
  return createSolicitorSessionCookie('', new Date(0), { clear: true });
}

/**
 * Builder / Developer Portal session cookie.
 *
 * Attribute-for-attribute the Solicitor shape with a distinct name, so a
 * Builder session can never be presented as a Solicitor or Command Centre
 * session and vice versa. `__Host-` forbids a Domain attribute and requires
 * Path=/ and Secure, so the cookie cannot be scoped to a sibling host.
 *
 * SameSite=None is required because the Edge Functions are served from a
 * different origin than the SPA. The compensating controls are the central
 * CSRF guard on every mutation and the exact-origin allow-list — the same
 * arrangement the existing portals use.
 */
export function createBuilderSessionCookie(
  sessionToken: string,
  expiresAt: Date,
  options?: { clear?: boolean }
): string {
  const maxAge = options?.clear ? 0 : Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  const expires = options?.clear ? new Date(0).toUTCString() : expiresAt.toUTCString();
  return `__Host-builder_session_token=${options?.clear ? '' : sessionToken}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}; Expires=${expires}; Path=/`;
}

export function createClearBuilderSessionCookie(): string {
  return createBuilderSessionCookie('', new Date(0), { clear: true });
}


/**
 * Create an unauthorized response with proper CORS headers
 */
export function createUnauthorizedResponse(
  message: string = 'Authentication required',
  corsHeaders: Record<string, string> = createCorsHeaders()
): Response {
  return new Response(
    // `code` lets clients distinguish a real sign-in problem from other
    // failures and show actionable guidance instead of a raw 401.
    JSON.stringify({ error: message, code: 'auth_required', success: false }),
    {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Create a forbidden response with proper CORS headers
 */
export function createForbiddenResponse(
  message: string = 'Access denied',
  corsHeaders: Record<string, string> = createCorsHeaders()
): Response {
  return new Response(
    JSON.stringify({ error: message, success: false }),
    {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}
