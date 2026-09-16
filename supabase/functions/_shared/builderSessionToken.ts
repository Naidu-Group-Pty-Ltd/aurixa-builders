/**
 * Builder / Developer Portal — session credential extraction and request validation.
 *
 * Mirrors `_shared/solicitorSessionToken.ts` with one deliberate divergence:
 * the Solicitor module still accepts an `x-solicitor-session-token` header and a
 * `solicitor_session_token` body field as legacy carriers. Builder has no legacy
 * clients, so it is COOKIE-ONLY. There is nothing to migrate away from later
 * (Phase 0 NOCOPY-02).
 */

import { localDevOrigins } from './localDevOrigins.ts';

export const BUILDER_SESSION_COOKIE = '__Host-builder_session_token';
export const BUILDER_PORTAL_HEADER = 'builder-portal';

/**
 * Read the Builder session token from the cookie header. Returns null when the
 * cookie is absent — a header or body value is never consulted, so a caller
 * cannot present a token any other way.
 */
export function extractBuilderSessionToken(headers: Headers): string | null {
  const cookieHeader = headers.get('cookie') || '';
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(';').flatMap((cookie) => {
      const [name, ...value] = cookie.trim().split('=');
      return name && value.length ? [[name, value.join('=')]] : [];
    }),
  );

  const raw = cookies[BUILDER_SESSION_COOKIE];
  if (!raw) return null;
  const token = decodeURIComponent(raw);
  return token.length ? token : null;
}

/**
 * NETWORK EDITION — the origins this product answers to.
 *
 * The prime's fallbacks were its own hosts (the Command Centre and its
 * Lovable preview); carrying them here would let a page on the PRIME's
 * origin drive the NETWORK's sessions. The network answers to exactly one
 * production origin — the browser talks to the same-origin `/fn/*` proxy,
 * which forwards the Origin header verbatim. `ALLOWED_ORIGINS` extends the
 * list per environment (e.g. a preview host) without a deploy.
 *
 * The local dev servers used to live in this list unconditionally, so every
 * deployed function trusted a laptop's `localhost` as much as the production
 * site. They are now opt-in via `ALLOW_LOCAL_DEV_ORIGINS=true` — see
 * `localDevOrigins.ts` for why that default is the safe way round.
 */
const FALLBACK_ORIGINS = [
  'https://builders.aurixasystems.com.au',
];

function allowedOrigins(): string[] {
  const configured = ((globalThis as any).Deno?.env?.get?.('ALLOWED_ORIGINS') || '')
    .split(',').map((value: string) => value.trim()).filter(Boolean);
  // The local dev servers are opt-in per environment
  // (`ALLOW_LOCAL_DEV_ORIGINS=true`), not a standing production carve-out.
  return [...configured, ...FALLBACK_ORIGINS, ...localDevOrigins()];
}

/**
 * Every Builder Portal request must carry the portal discriminator AND an
 * allow-listed Origin. A missing Origin is rejected rather than tolerated,
 * matching `validateSolicitorPortalHeaders`.
 */
export function validateBuilderPortalHeaders(headers: Headers): boolean {
  if (headers.get('x-portal-request') !== BUILDER_PORTAL_HEADER) return false;
  const origin = headers.get('origin');
  return !!origin && allowedOrigins().includes(origin);
}

export function validateBuilderPortalRequest(req: Request): boolean {
  return validateBuilderPortalHeaders(req.headers);
}

/**
 * A Builder request must not carry another portal's session cookie in a way
 * that could be mistaken for authority. Builder resolution only ever reads
 * BUILDER_SESSION_COOKIE, so this is a defence-in-depth assertion used by the
 * cross-portal isolation tests.
 *
 * NETWORK EDITION — the axis that matters changed (extraction plan §5). The
 * network is a SIBLING SUBDOMAIN of every host on aurixasystems.com.au, and
 * a sibling can plant `builder_session_token=X; Domain=aurixasystems.com.au`
 * — a fixation cookie that arrives here wearing the right name in the wrong
 * spelling. What makes the real cookie immune is the `__Host-` prefix: a
 * browser refuses to store it with a Domain attribute at all, so possession
 * of the exact `__Host-` name IS proof it was set first-party on this host.
 * The resolver above therefore reads only the `__Host-` spelling, and this
 * assertion flags the BARE spelling as foreign alongside the other portals'
 * names — its presence means a sibling host is trying something.
 */
export function carriesForeignPortalSession(headers: Headers): boolean {
  const cookieHeader = headers.get('cookie') || '';
  const names = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim().split('=')[0])
    .filter(Boolean);
  return names.includes('__Host-solicitor_session_token')
    || names.includes('__Host-finance_session_token')
    // The un-prefixed spelling of our own name: a Domain-scoped plant from a
    // sibling host, never a cookie this product set.
    || names.includes('builder_session_token');
}
