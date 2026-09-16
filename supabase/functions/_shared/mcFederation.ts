/**
 * Verifying Mission Control's federation assertions (extraction plan §1/§5).
 *
 * Mission Control signs RS256 JWTs with the one platform signing key and
 * publishes the key set at its own `/api/public/builders/jwks`; the network
 * verifies OFFLINE against that JWKS — no shared secret, no callback, and
 * revoking the `builders:*` scopes on MC's side is a complete rollback.
 *
 * The rules, each the narrow side of a real failure class:
 *
 *  * **The audience is exactly ours.** One signing key serves two audiences
 *    (Anthropic's token URL and this origin), and exact-match `aud` is what
 *    makes an assertion minted for one unreplayable at the other.
 *  * **The JWKS is fetched from configuration, cached briefly, and refetched
 *    once on an unknown `kid`** — that is rotation support, not retry logic.
 *    An unconfigured MISSION_CONTROL_URL refuses by NAME rather than
 *    guessing a host: a verifier that guesses its trust root has none.
 *  * **Scopes are read from the verified claims only.** The caller's word
 *    for its own authority is the thing signatures exist to replace.
 *  * **The issuer is pinned when configured.** `MC_FEDERATION_ISSUER` (the
 *    value MC's own `cloneIssuerUrl()` mints) narrows further; unset, the
 *    signature + audience + scope chain already binds the caller to the
 *    holder of MC's signing key.
 */

export const BUILDERS_AUDIENCE = 'https://builders.aurixasystems.com.au';
export const BUILDERS_JWKS_PATH = '/api/public/builders/jwks';
const JWKS_TTL_MS = 300_000;
/**
 * THE GRACE PERIOD HAS A CEILING.
 *
 * Outside the TTL, a JWKS endpoint that answers non-200 or answers rubbish used
 * to fall back on the cached keys with no upper bound at all — so a key Mission
 * Control had ROTATED OUT went on verifying assertions for as long as the
 * endpoint stayed broken, which is the state an attacker who has taken a
 * retired key would want to arrange. Twelve TTLs is one hour: long enough that
 * trust does not flap through the outages the fallback was written for, short
 * enough that a rotation is enforced within the hour whatever MC is doing. Past
 * it the cache is not keys any more, and verification fails closed.
 */
const JWKS_MAX_STALE_MS = JWKS_TTL_MS * 12;
const CLOCK_SKEW_SECONDS = 60;

interface Jwk { kty: string; n: string; e: string; kid?: string; alg?: string }

/** Guarded like builderSessionToken's: this module is also typechecked
 *  under the browser config because its spec imports it. */
function envGet(key: string): string | undefined {
  return (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } })
    .Deno?.env?.get?.(key);
}

let jwksCache: { fetchedAt: number; keys: Jwk[] } | null = null;

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const raw = atob(padded);
  // Backed by a plain ArrayBuffer explicitly: WebCrypto's BufferSource
  // refuses the SharedArrayBuffer-admitting default under strict TS.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function jwksUrl(): string | null {
  const base = (envGet('MISSION_CONTROL_URL') || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${BUILDERS_JWKS_PATH}`;
}

/** The cached keys while they are still inside the hard bound — otherwise none. */
function usableStaleKeys(): Jwk[] | null {
  if (!jwksCache) return null;
  if (Date.now() - jwksCache.fetchedAt >= JWKS_MAX_STALE_MS) return null;
  return jwksCache.keys;
}

async function fetchJwks(force = false): Promise<Jwk[] | null> {
  const url = jwksUrl();
  if (!url) return null;
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return usableStaleKeys();
    const body = await response.json().catch(() => null) as { keys?: Jwk[] } | null;
    if (!body || !Array.isArray(body.keys)) return usableStaleKeys();
    jwksCache = { fetchedAt: Date.now(), keys: body.keys };
    return jwksCache.keys;
  } catch {
    // A transient fetch failure keeps the previous keys inside their TTL —
    // trust does not flap with the network. Past JWKS_MAX_STALE_MS it does not:
    // no keys come back, and the caller refuses rather than verifying against a
    // set nobody has been able to confirm for an hour.
    return usableStaleKeys();
  }
}

export interface McAssertionClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti?: string;
  clone_id?: string;
  slug?: string;
  display_name?: string;
  scopes?: string[];
}

export type McVerification =
  | { ok: true; claims: McAssertionClaims }
  | {
      ok: false;
      reason:
        | 'unconfigured'
        | 'malformed'
        | 'unknown_key'
        | 'bad_signature'
        | 'wrong_audience'
        | 'wrong_issuer'
        | 'expired'
        | 'not_yet_valid'
        | 'missing_scope';
    };

/** Verify a compact RS256 assertion and require one `builders:` scope on it. */
export async function verifyMcAssertion(
  token: string,
  requiredScope: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<McVerification> {
  if (!jwksUrl()) return { ok: false, reason: 'unconfigured' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  let header: { alg?: string; kid?: string };
  let claims: McAssertionClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'malformed' };

  let keys = await fetchJwks();
  if (!keys) return { ok: false, reason: 'unconfigured' };
  let jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) {
    // One forced refetch: an unknown kid is what rotation looks like.
    keys = await fetchJwks(true);
    jwk = keys?.find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'unknown_key' };
  }

  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };

  if (claims.aud !== BUILDERS_AUDIENCE) return { ok: false, reason: 'wrong_audience' };
  const pinnedIssuer = (envGet('MC_FEDERATION_ISSUER') || '').trim();
  if (pinnedIssuer && claims.iss !== pinnedIssuer) return { ok: false, reason: 'wrong_issuer' };
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.iat === 'number' && claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  if (!scopes.includes(requiredScope)) return { ok: false, reason: 'missing_scope' };

  return { ok: true, claims };
}
