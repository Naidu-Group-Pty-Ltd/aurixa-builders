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
  it('is exactly the nineteen browser-invocable portal functions', () => {
    expect([...PROXIED_FUNCTIONS].sort()).toEqual([
      'builder-network-connections',
      'builder-portal-accept-invite',
      'builder-portal-change-password',
      'builder-portal-collaboration',
      'builder-portal-construction',
      'builder-portal-delivery',
      'builder-portal-forgot-password',
      'builder-portal-inventory',
      'builder-portal-invite',
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

  it('never includes the workers or the callback', () => {
    // The workers are invoked by schedule or internal signature; the
    // callback is Make's and is authorised by one-time capability tokens,
    // not by a browser session. (invite JOINED the allowlist with the
    // admin-plane lift — it is an org-owner portal act now.)
    for (const name of [
      'builder-document-processor',
      'builder-stock-image-settler',
      'builder-stock-link-callback',
      // Machine doors: HMAC, the internal signature and MC's federation
      // assertion — never a browser.
      'builder-network-inbound',
      'builder-network-outbox-worker',
      'builder-network-admin',
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
    expect(resolveProxiedFunction('builder-network-inbound')).toEqual({ ok: false, reason: 'not_proxied' });
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

/*
 * WHERE THE PROXY RUNS DECIDES WHERE EVERY PORTAL REQUEST RUNS.
 *
 * The edge runtime executes a function in the region closest to its CALLER,
 * and the caller of every portal function is this proxy, not the browser. With
 * no region declared, Vercel ran the proxy in `iad1` (Washington), so every
 * portal request executed in `us-east-1` while the database is in Sydney: each
 * of a request's ten or so database round trips crossed the Pacific. Measured
 * on 27 Sep 2026 from the gateway's own logs (`x_sb_edge_region: us-east-1`,
 * called from Ashburn): `builder-portal-stock` averaged 4.6 s, sending a
 * message took 3-5.5 s and each poll of an open conversation about 4 s. The
 * database work in those requests was 14-25 ms.
 */
describe('where the proxy runs', () => {
  /** A Supabase database region, and the Vercel function region beside it. */
  const VERCEL_REGION_BESIDE: Record<string, string> = { 'ap-southeast-2': 'syd1' };

  it('runs in the Vercel region beside the network database', () => {
    const vercel = JSON.parse(read('vercel.json')) as { regions?: string[] };
    const databaseRegion = /\| Supabase project \| `[a-z]{20}` \(([a-z]+-[a-z]+-\d)\) \|/.exec(read('README.md'))?.[1];
    expect(databaseRegion, 'the README records the network database region').toBe('ap-southeast-2');
    expect(vercel.regions).toEqual([VERCEL_REGION_BESIDE[databaseRegion!]]);
  });
});
