/**
 * The network sync surface's load-bearing rules (extraction plan §2/§6),
 * pinned against the pure modules directly and the functions at the source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStamp,
  stampKey,
  stampsDiffer,
} from '../../../supabase/functions/_shared/builderNetworkStamp.pure';
import {
  BuilderNetworkPrivacyViolation,
  assertPayloadCrossesClean,
  forbiddenPathsIn,
} from '../../../supabase/functions/_shared/builderNetworkPrivacy.pure';
import {
  MAX_SKEW_SECONDS,
  signDelivery,
  verifyDelivery,
} from '../../../supabase/functions/_shared/builderNetworkHmac';
import { carriesForeignPortalSession } from '../../../supabase/functions/_shared/builderSessionToken';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('the polling stamp', () => {
  const a = buildStamp({ count: 3, latest: '2026-09-14T00:00:00Z', pendingRequests: 1, attention: 0 });

  it('a null previous stamp is NOT a change', () => {
    expect(stampsDiffer(null, a)).toBe(false);
    expect(stampsDiffer(undefined, a)).toBe(false);
  });

  it('every scalar is compared exactly', () => {
    expect(stampsDiffer(a, { ...a })).toBe(false);
    expect(stampsDiffer(a, { ...a, count: 4 })).toBe(true);
    expect(stampsDiffer(a, { ...a, latest: null })).toBe(true);
    expect(stampsDiffer(a, { ...a, pendingRequests: 2 })).toBe(true);
    expect(stampsDiffer(a, { ...a, attention: 1 })).toBe(true);
  });

  it('the key carries its scope, and the scope is the connection', () => {
    expect(stampKey('inbound', 'abc')).toBe('builder_network:inbound:abc');
    expect(stampKey('outbound', 'abc')).not.toBe(stampKey('inbound', 'abc'));
  });

  it('absent readings normalise to zero and null, never NaN', () => {
    expect(buildStamp({})).toEqual({ count: 0, latest: null, pendingRequests: 0, attention: 0 });
  });
});

describe('the privacy contract', () => {
  it('returns a clean payload untouched — the same reference', () => {
    const payload = { stock_item_id: 'x', address: { suburb: 'Truganina' }, price_display: '$500,000' };
    expect(assertPayloadCrossesClean(payload)).toBe(payload);
  });

  it('throws with the full dotted path, at any depth', () => {
    const dirty = { item: { pricing: { margin: 0.2 } }, rows: [{ client_id: 'c1' }] };
    let caught: unknown;
    try { assertPayloadCrossesClean(dirty); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BuilderNetworkPrivacyViolation);
    expect((caught as BuilderNetworkPrivacyViolation).paths)
      .toEqual(['item.pricing.margin', 'rows[0].client_id']);
  });

  it('THROWS rather than filters — nothing survives a dirty payload', () => {
    // The API offers no "cleaned copy": the only exports are detection and
    // an assertion, so a caller cannot adopt a filtered payload.
    expect(() => assertPayloadCrossesClean({ ok: true, internal_notes: 'x' })).toThrow();
  });

  it('catches the camelCase cousin of a forbidden column', () => {
    expect(forbiddenPathsIn({ clientEmail: 'a@b.c' })).toEqual(['clientEmail']);
    expect(forbiddenPathsIn({ internalNote: 'x' })).toEqual(['internalNote']);
    expect(forbiddenPathsIn({ selectedByUserId: 'u' })).toEqual(['selectedByUserId']);
  });

  it('covers every family the plan names', () => {
    for (const key of ['client_id', 'internal_notes', 'selected_by_user_id', 'staff_id', 'margin', 'cost_price', 'aml_case_id', 'smr_reference', 'other_connection_id']) {
      expect(forbiddenPathsIn({ [key]: 1 }), key).toHaveLength(1);
    }
  });
});

describe('the HMAC transport', () => {
  const secret = 'a'.repeat(64);
  const body = '{"event_type":"stock.published","dedupe_key":"k1"}';

  const headersFor = async (ts: string, sig?: string) => new Headers({
    'x-aurixa-timestamp': ts,
    'x-aurixa-signature': sig ?? await signDelivery(secret, ts, body),
  });

  it('a signed delivery verifies', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await verifyDelivery(secret, await headersFor(ts), body)).toEqual({ ok: true });
  });

  it('a different secret, body or timestamp fails as bad_signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = await headersFor(ts);
    expect(await verifyDelivery('b'.repeat(64), headers, body))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyDelivery(secret, headers, body + ' '))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a captured request dies of old age', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 60);
    expect(await verifyDelivery(secret, await headersFor(stale), body))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('missing headers are their own refusal', async () => {
    expect(await verifyDelivery(secret, new Headers(), body))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('the session cookie, on the sibling-subdomain axis', () => {
  it('the builder cookie is __Host-, Lax, Path=/ and carries no Domain', () => {
    const auth = read('supabase/functions/_shared/auth.ts');
    const line = auth.split('\n').find((l) => l.includes('__Host-builder_session_token=${'));
    expect(line).toBeTruthy();
    expect(line).toContain('HttpOnly');
    expect(line).toContain('Secure');
    expect(line).toContain('SameSite=Lax');
    expect(line).toContain('Path=/');
    expect(line).not.toContain('Domain');
  });

  it('flags the other portals’ cookies and the bare spelling of our own', () => {
    const h = (cookie: string) => new Headers({ cookie });
    expect(carriesForeignPortalSession(h('__Host-solicitor_session_token=x'))).toBe(true);
    expect(carriesForeignPortalSession(h('a=1; __Host-finance_session_token=x'))).toBe(true);
    // A Domain-scoped plant from a sibling host wears the bare name —
    // a browser cannot store the __Host- spelling with a Domain attribute.
    expect(carriesForeignPortalSession(h('builder_session_token=planted'))).toBe(true);
  });

  it('does not flag the real cookie, and name matching is exact', () => {
    const h = (cookie: string) => new Headers({ cookie });
    expect(carriesForeignPortalSession(h('__Host-builder_session_token=real'))).toBe(false);
    expect(carriesForeignPortalSession(h('not_builder_session_token_x=1'))).toBe(false);
    expect(carriesForeignPortalSession(h(''))).toBe(false);
  });
});

describe('the functions hold the graph’s rules', () => {
  it('revoked is terminal: accept refuses it and nothing un-revokes', () => {
    const source = readCode('supabase/functions/builder-network-connections/index.ts');
    expect(source).toContain("connection.state === 'revoked'");
    expect(source).not.toMatch(/state:\s*'invited'\s*}/); // no transition writes invited
    expect(source).not.toContain('unrevoke');
  });

  it('the event ledger is append-only from this surface', () => {
    const source = readCode('supabase/functions/builder-network-connections/index.ts');
    const eventsUse = source.split("from('workspace_connection_events')");
    // Every use is an insert.
    for (const after of eventsUse.slice(1)) {
      expect(after.trimStart().startsWith('.insert(')).toBe(true);
    }
  });

  it('both directions pass the privacy gate, and the worker gates before the wire', () => {
    expect(readCode('supabase/functions/builder-network-inbound/index.ts'))
      .toContain('assertPayloadCrossesClean');
    const worker = readCode('supabase/functions/builder-network-outbox-worker/index.ts');
    const gateAt = worker.indexOf('assertPayloadCrossesClean');
    const wireAt = worker.indexOf('await fetch(connection.inbound_url');
    expect(gateAt).toBeGreaterThan(-1);
    expect(wireAt).toBeGreaterThan(gateAt);
  });

  it('the inbound door refuses with one generic answer', () => {
    const source = readCode('supabase/functions/builder-network-inbound/index.ts');
    // One refusal constructor, used for every rung of the ladder.
    expect(source.match(/delivery_refused/g)).toHaveLength(1);
    expect(source.match(/return refuse\(\)/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
