/**
 * The `/fn/*` proxy policy, pinned.
 *
 * The proxy is the network's whole credential boundary: the browser holds no
 * Supabase key and reaches only what this policy names. These tests pin the
 * three rules the policy module states — allowlist by name, explicit header
 * lists in both directions — and cross-check the allowlist against the
 * declared function estate so the two cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  PROXIED_FUNCTIONS,
  resolveProxiedFunction,
} from '../../../api/_shared/fnProxyPolicy.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

describe('the allowlist', () => {
  it('is exactly the seventeen browser-invocable portal functions', () => {
    expect([...PROXIED_FUNCTIONS].sort()).toEqual([
      'builder-portal-accept-invite',
      'builder-portal-change-password',
      'builder-portal-collaboration',
      'builder-portal-construction',
      'builder-portal-delivery',
      'builder-portal-forgot-password',
      'builder-portal-inventory',
      'builder-portal-login',
      'builder-portal-logout',
      'builder-portal-projects',
      'builder-portal-register',
      'builder-portal-reset-password',
      'builder-portal-stock',
      'builder-portal-transactions',
      'builder-portal-verify',
      'builder-portal-verify-email',
      'builder-portal-workspace',
    ]);
  });

  it('never includes the admin-plane, worker or callback functions', () => {
    // invite is verify_jwt=true until the admin-plane lift; the workers are
    // invoked by schedule or internal signature; the callback is Make's and
    // is authorised by one-time capability tokens, not by a browser session.
    for (const name of [
      'builder-portal-invite',
      'builder-document-processor',
      'builder-stock-image-settler',
      'builder-stock-link-callback',
    ]) {
      expect(PROXIED_FUNCTIONS as readonly string[]).not.toContain(name);
    }
  });

  it('every proxied name is a declared function with verify_jwt = false', () => {
    // A proxied function the gateway would refuse is a dead door; a proxied
    // name with no declaration at all is a typo this catches on the day it
    // is made rather than in production.
    const config = read('supabase/config.toml');
    for (const name of PROXIED_FUNCTIONS) {
      const block = new RegExp(
        `\\[functions\\.${name}\\]\\s*\\nverify_jwt = false`,
      );
      expect(config, `${name} must be declared verify_jwt = false`).toMatch(block);
    }
  });
});

describe('name resolution', () => {
  it('resolves each allowlisted name', () => {
    for (const name of PROXIED_FUNCTIONS) {
      expect(resolveProxiedFunction(name)).toEqual({ ok: true, name });
    }
  });

  it('refuses what is missing, malformed or merely similar', () => {
    expect(resolveProxiedFunction(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(resolveProxiedFunction('')).toEqual({ ok: false, reason: 'missing' });
    expect(resolveProxiedFunction('../builder-portal-login')).toEqual({ ok: false, reason: 'malformed' });
    expect(resolveProxiedFunction('builder-portal-login/../x')).toEqual({ ok: false, reason: 'malformed' });
    expect(resolveProxiedFunction('builder-portal-login%2f..')).toEqual({ ok: false, reason: 'malformed' });
    expect(resolveProxiedFunction('Builder-Portal-Login')).toEqual({ ok: false, reason: 'malformed' });
    expect(resolveProxiedFunction('builder-portal-invite')).toEqual({ ok: false, reason: 'not_proxied' });
    expect(resolveProxiedFunction('builder-document-processor')).toEqual({ ok: false, reason: 'not_proxied' });
  });

  it('takes only the first segment of an array (no smuggled second name)', () => {
    expect(resolveProxiedFunction(['builder-portal-login', 'builder-portal-invite']))
      .toEqual({ ok: true, name: 'builder-portal-login' });
  });
});

describe('the header lists', () => {
  it('forwards exactly what the functions need from the browser', () => {
    // `origin` is load-bearing: Node fetch sends none, and the CSRF guard
    // requires an allow-listed Origin on cookie-authenticated mutations.
    expect([...FORWARDED_REQUEST_HEADERS].sort()).toEqual(
      ['content-type', 'cookie', 'origin', 'x-portal-request'],
    );
  });

  it('never forwards a credential header from the browser', () => {
    for (const header of ['authorization', 'apikey', 'x-supabase-auth']) {
      expect(FORWARDED_REQUEST_HEADERS as readonly string[]).not.toContain(header);
    }
  });

  it('returns exactly the content and the cookie', () => {
    expect([...FORWARDED_RESPONSE_HEADERS].sort()).toEqual(['content-type', 'set-cookie']);
  });
});

describe('the route is actually wired', () => {
  it('vercel.json rewrites /fn/:name onto the handler', () => {
    const vercel = JSON.parse(read('vercel.json')) as {
      rewrites?: { source: string; destination: string }[];
    };
    expect(vercel.rewrites?.[0]).toEqual({ source: '/fn/:name', destination: '/api/fn/:name' });
  });

  it('the frontend invokes through /fn and never names supabase', () => {
    const transport = read('src/lib/builderPortal.ts');
    expect(transport).toContain("'/fn'");
    expect(transport.toLowerCase()).not.toContain('supabase_url');
    expect(transport.toLowerCase()).not.toContain('.supabase.co');
  });
});
