/**
 * The same-origin function proxy: `POST /fn/<name>` → the network's Supabase
 * Edge Function of that name, with the anon key attached HERE and never in
 * the browser (extraction plan §5 — "the READ travels, not the key").
 *
 * What this buys, in order of importance:
 *
 * - The browser holds zero Supabase credentials and never learns the
 *   project's URL: `VITE_SUPABASE_*` does not exist in the network bundle.
 * - The session cookie is first-party. The edge function's `Set-Cookie`
 *   passes back through this response, so `__Host-builder_session_token`
 *   belongs to builders.aurixasystems.com.au — which is what lets it be
 *   SameSite=Lax instead of None-plus-compensations.
 * - The reachable surface is a named allowlist (`fnProxyPolicy.pure.ts`),
 *   not whatever the Supabase gateway happens to expose.
 *
 * Refusal shapes: an unknown or malformed name answers 404 without saying
 * whether such a function exists behind the proxy; missing configuration
 * answers 503 naming the VARIABLE, never a value.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
// The `.js` extension is load-bearing: Vercel runs this file as native Node
// ESM, whose loader resolves relative specifiers verbatim — extensionless,
// it threw ERR_MODULE_NOT_FOUND before the handler ran and every /fn call
// answered FUNCTION_INVOCATION_FAILED. TypeScript maps the `.js` specifier
// back onto the `.ts` source at typecheck, so both sides resolve.
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  resolveProxiedFunction,
  trustedClientIpFromPlatform,
} from '../_shared/fnProxyPolicy.pure.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Same-origin traffic sends no preflight, so OPTIONS here is a stray.
  if (req.method !== 'POST') {
    res.status(405).setHeader('Allow', 'POST').json({ error: 'method_not_allowed' });
    return;
  }

  const resolution = resolveProxiedFunction(req.query.name);
  if (!resolution.ok) {
    // One refusal for every miss: confirming which names exist behind the
    // proxy is exactly the enumeration the allowlist is here to stop.
    res.status(404).json({ error: 'unknown_function' });
    return;
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  if (!supabaseUrl || !anonKey) {
    const missing = [
      !supabaseUrl ? 'SUPABASE_URL' : null,
      !anonKey ? 'SUPABASE_ANON_KEY' : null,
    ].filter(Boolean).join(', ');
    console.error(`[fn-proxy] unconfigured: ${missing} not set`);
    res.status(503).json({ error: 'proxy_unconfigured', missing });
    return;
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.length) headers.set(name, value);
  }
  // The credential is attached HERE, server-side. The browser cannot supply
  // either header — neither is on the forwarded list.
  headers.set('apikey', anonKey);
  headers.set('authorization', `Bearer ${anonKey}`);

  // The end user's address, attached the same way and for the same reason: it
  // must be the platform's view, not the caller's claim. Before this, no
  // client-IP header crossed the proxy at all, so every per-IP rate limit
  // behind it shared ONE bucket for the entire product — 30 sign-in attempts
  // per 15 minutes network-wide, and five password resets per hour. One
  // person exhausting either locked out everyone else.
  const clientIp = trustedClientIpFromPlatform(req.headers);
  if (clientIp) headers.set('x-real-ip', clientIp);

  // Vercel parses a JSON body before we see it; re-serialising is faithful
  // because every portal call is application/json by construction.
  const body =
    typeof req.body === 'string'
      ? req.body
      : req.body === undefined || req.body === null
        ? undefined
        : JSON.stringify(req.body);

  let upstream: Response;
  try {
    upstream = await fetch(`${supabaseUrl}/functions/v1/${resolution.name}`, {
      method: 'POST',
      headers,
      body,
    });
  } catch (error) {
    console.error(`[fn-proxy] ${resolution.name} unreachable:`, error);
    res.status(502).json({ error: 'function_unreachable' });
    return;
  }

  res.status(upstream.status);
  res.setHeader('Cache-Control', 'no-store');
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    if (name === 'set-cookie') {
      // Set-Cookie must not be joined: undici folds repeated headers with a
      // comma, and a comma-joined cookie pair is one broken cookie.
      const cookies = upstream.headers.getSetCookie?.() ?? [];
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      continue;
    }
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.send(Buffer.from(await upstream.arrayBuffer()));
}
