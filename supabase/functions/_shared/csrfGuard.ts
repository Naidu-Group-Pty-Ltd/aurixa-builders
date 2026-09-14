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
 * fully-qualified URLs). SEC5-CORS: suffix trust for `*.lovable.app` /
 * `*.lovableproject.com` was removed — the SameSite=None staff cookie makes
 * exact-origin enforcement essential. The Lovable suffix is only honoured when
 * `CORS_ALLOW_LOVABLE_PREVIEW=true` is explicitly set (non-production preview).
 * If no cookie is present on the request (auth is header-only), the CSRF check
 * is bypassed because the classic CSRF attack vector (ambient cookie authority)
 * does not apply.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LEGACY_FALLBACK = [
  'https://command-centre.npcservices.com.au',
  'https://npc-property-dashbord.lovable.app',
  'https://id-preview--7976d60b-c277-4851-889b-c170285f4be2.lovable.app',
  // Exact first-party preview/sandbox origins for THIS project (belt-and-braces
  // alongside lovableFirstPartyHost, which can be missed if a deployed bundle
  // ships a stale copy of this module).
  'https://7976d60b-c277-4851-889b-c170285f4be2.lovableproject.com',
  'https://id-preview--7976d60b-c277-4851-889b-c170285f4be2.lovableproject.com',
  'https://7976d60b-c277-4851-889b-c170285f4be2.lovable.app',
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
  return [...new Set([...LEGACY_FALLBACK, ...fromEnv])];
}

// First-party Lovable preview/sandbox hosts for THIS project only. The project
// id is part of every preview hostname Lovable mints for us, so matching on it
// keeps enforcement exact-origin in spirit (no other tenant can satisfy it)
// while surviving preview-host renames that previously produced csrf_denied.
const LOVABLE_PROJECT_ID = '7976d60b-c277-4851-889b-c170285f4be2';
const LOVABLE_HOST_SUFFIXES = ['.lovable.app', '.lovableproject.com', '.lovable.dev'];

function lovableFirstPartyHost(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (!LOVABLE_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false;
    return host.includes(LOVABLE_PROJECT_ID);
  } catch {
    return false;
  }
}

function lovablePreviewSuffixAllowed(origin: string): boolean {
  if (lovableFirstPartyHost(origin)) return true;
  if (((globalThis as any).Deno?.env?.get?.('CORS_ALLOW_LOVABLE_PREVIEW') || '').trim().toLowerCase() !== 'true') return false;
  try {
    const host = new URL(origin).hostname;
    return host.endsWith('.lovable.app') || host.endsWith('.lovableproject.com');
  } catch {
    return false;
  }
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const list = [
    ...parseAllowedOrigins(),
    'http://localhost:5173',
    'http://localhost:8080',
  ];
  if (list.includes(origin)) return true;
  // SEC5-CORS: exact-origin only; suffix match is gated behind the default-off
  // preview flag so production cookie mutations require an exact allowlisted origin.
  return lovablePreviewSuffixAllowed(origin);
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
