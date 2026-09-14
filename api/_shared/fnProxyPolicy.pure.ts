/**
 * The `/fn/*` proxy's policy — what may be called, and what travels.
 *
 * The network frontend holds NO Supabase credential: the browser calls
 * same-origin `/fn/<name>`, and this policy decides which function names that
 * path can reach and which headers cross in each direction. The handler in
 * `api/fn/[name].ts` injects the anon key server-side (extraction plan §5).
 *
 * Three rules, each learned somewhere:
 *
 * - **Allowlist by NAME, never a pattern.** A prefix rule ("builder-*") would
 *   quietly expose every function that ever wears the prefix — the workers,
 *   the Make callback, and `builder-portal-invite`, which is gated
 *   `verify_jwt = true` precisely because the network has no staff plane yet.
 *   A new function is proxied by being added here, deliberately.
 *
 * - **Forwarded request headers are an explicit list.** Forwarding everything
 *   forwards `Authorization` from the browser (which must never carry
 *   authority here), proxy-chain headers, and whatever an extension injects.
 *   `origin` IS forwarded — Node's fetch sends none of its own, and the edge
 *   functions' CSRF guard requires an allow-listed Origin on every
 *   cookie-authenticated mutation.
 *
 * - **Response headers back are an explicit list too**, and `set-cookie` is
 *   the point: the `__Host-builder_session_token` cookie is minted by the
 *   edge function and must reach the browser AS the network origin's own
 *   first-party cookie — which is exactly what makes SameSite=Lax fit.
 */

/** Every function the browser may reach through `/fn/*`. */
export const PROXIED_FUNCTIONS = [
  'builder-portal-login',
  'builder-portal-logout',
  'builder-portal-register',
  'builder-portal-verify-email',
  'builder-portal-verify',
  'builder-portal-accept-invite',
  'builder-portal-forgot-password',
  'builder-portal-reset-password',
  'builder-portal-change-password',
  'builder-portal-projects',
  'builder-portal-inventory',
  'builder-portal-transactions',
  'builder-portal-construction',
  'builder-portal-delivery',
  'builder-portal-collaboration',
  'builder-portal-workspace',
  'builder-portal-stock',
  'builder-network-connections',
] as const;

export type ProxiedFunction = (typeof PROXIED_FUNCTIONS)[number];

/** Request headers copied from the browser to the edge function. */
export const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'x-portal-request',
  'origin',
  'cookie',
] as const;

/** Response headers copied from the edge function back to the browser. */
export const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'set-cookie',
] as const;

export type ProxyResolution =
  | { ok: true; name: ProxiedFunction }
  | { ok: false; reason: 'missing' | 'malformed' | 'not_proxied' };

/**
 * Resolve a path segment to a proxied function.
 *
 * The shape check runs BEFORE the set membership so the refusal for
 * `builder-portal-login%2F..` is `malformed`, never a lookup over a string
 * containing separators — nothing downstream may ever see a name this
 * function did not pass.
 */
export function resolveProxiedFunction(raw: string | string[] | undefined): ProxyResolution {
  const name = Array.isArray(raw) ? raw[0] : raw;
  if (!name) return { ok: false, reason: 'missing' };
  if (!/^[a-z][a-z0-9-]{0,80}$/.test(name)) return { ok: false, reason: 'malformed' };
  return (PROXIED_FUNCTIONS as readonly string[]).includes(name)
    ? { ok: true, name: name as ProxiedFunction }
    : { ok: false, reason: 'not_proxied' };
}
