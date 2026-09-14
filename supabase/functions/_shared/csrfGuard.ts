/**
 * WP-11A — CSRF protection for cookie-authenticated mutating requests.
 *
 * Cookie-carried sessions are auto-attached by the browser on any cross-site
 * request; without an Origin/Referer allowlist a malicious page could
 * mint a state-changing request against our Edge Functions from the user's
 * browser. This helper enforces a strict allowlist of accepted origins for
 * unsafe HTTP methods.
 *
 * Safe methods (GET, HEAD, OPTIONS) are allowed through — CORS handles them
 * and they are not supposed to mutate state.
 *
 * The allowlist is sourced from `ALLOWED_ORIGINS` (comma-separated, exact
 * fully-qualified URLs), extending the network's own origin. Enforcement is
 * exact-origin with no suffix trust — the prime removed suffix trust after
 * SEC5-CORS and this edition removes the preview escape hatch too.
 * If no cookie is present on the request (auth is header-only), the CSRF check
 * is bypassed because the classic CSRF attack vector (ambient cookie authority)
 * does not apply.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * NETWORK EDITION — the network's one first-party origin.
 *
 * The prime's list was its own hosts plus six Lovable preview spellings for
 * ITS project id; every one of those is somebody else's origin here, and a
 * carried carve-out is exactly how one product's page comes to drive
 * another's cookie-authenticated mutations. `ALLOWED_ORIGINS` extends this
 * per environment; nothing suffix-matches.
 */
const FIRST_PARTY_ORIGINS = [
  'https://builders.aurixasystems.com.au',
];

function parseAllowedOrigins(): string[] {
  const raw = (globalThis as any).Deno?.env?.get?.('ALLOWED_ORIGINS') || '';
  const fromEnv = raw
    .split(',')
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
  // Environment configuration extends the known first-party origins rather
  // than replacing them. Replacing the list caused preview releases to become
  // CSRF-denied whenever production configured only the custom domain.
  return [...new Set([...FIRST_PARTY_ORIGINS, ...fromEnv])];
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const list = [
    ...parseAllowedOrigins(),
    'http://localhost:5173',
    'http://localhost:8080',
  ];
  // NETWORK EDITION: exact-origin only, with no suffix trust of any kind.
  // The prime kept a flag-gated Lovable-preview suffix; this product has no
  // preview host family, so the escape hatch is deleted rather than dormant.
  return list.includes(origin);
}

export interface CsrfCheckResult {
  ok: boolean;
  reason?: 'origin_not_allowed' | 'origin_missing';
  origin?: string | null;
}

/**
 * Enforce Origin/Referer allowlist on cookie-authenticated mutations.
 * - GET/HEAD/OPTIONS: always allowed.
 * - No `Cookie` header on the request: CSRF risk absent, allowed.
 * - Otherwise Origin (or Referer host) must be in the allowlist.
 */
export function enforceCsrf(req: Request): CsrfCheckResult {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return { ok: true };
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return { ok: true };

  const origin = req.headers.get('origin');
  if (origin) {
    return originAllowed(origin)
      ? { ok: true, origin }
      : { ok: false, reason: 'origin_not_allowed', origin };
  }
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return originAllowed(refOrigin)
        ? { ok: true, origin: refOrigin }
        : { ok: false, reason: 'origin_not_allowed', origin: refOrigin };
    } catch {
      return { ok: false, reason: 'origin_not_allowed', origin: null };
    }
  }
  return { ok: false, reason: 'origin_missing', origin: null };
}

/** Convenience 403 factory used by handlers that want a canned response. */
export function csrfDenied(cors: Record<string, string>, detail: CsrfCheckResult): Response {
  return new Response(
    JSON.stringify({ error: 'CSRF check failed', code: 'csrf_denied', reason: detail.reason, origin: detail.origin ?? null, guard: 'v2' }),
    { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}
