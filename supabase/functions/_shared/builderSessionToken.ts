/**
 * Builder / Developer Portal — session credential extraction and request validation.
 *
 * Mirrors `_shared/solicitorSessionToken.ts` with one deliberate divergence:
 * the Solicitor module still accepts an `x-solicitor-session-token` header and a
 * `solicitor_session_token` body field as legacy carriers. Builder has no legacy
 * clients, so it is COOKIE-ONLY. There is nothing to migrate away from later
 * (Phase 0 NOCOPY-02).
 */

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

const FALLBACK_ORIGINS = [
  'https://command-centre.npcservices.com.au',
  'https://npc-property-dashbord.lovable.app',
  'http://localhost:5173',
  'http://localhost:8080',
];

function allowedOrigins(): string[] {
  const configured = ((globalThis as any).Deno?.env?.get?.('ALLOWED_ORIGINS') || '')
    .split(',').map((value: string) => value.trim()).filter(Boolean);
  return [...configured, ...FALLBACK_ORIGINS];
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
 */
export function carriesForeignPortalSession(headers: Headers): boolean {
  const cookieHeader = headers.get('cookie') || '';
  return cookieHeader.includes('__Host-solicitor_session_token')
    || cookieHeader.includes('__Host-finance_session_token');
}
