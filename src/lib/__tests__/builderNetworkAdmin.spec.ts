/**
 * The operator door's rules: the federation verifier end to end (a real
 * RSA keypair, a stubbed JWKS), and the admin function's refusals at the
 * source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// The module reads Deno.env at CALL time, so a Node-side stub suffices.
const env = new Map<string, string>();
beforeEach(() => {
  env.clear();
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => env.get(key) },
  };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).Deno;
  vi.restoreAllMocks();
});

import {
  BUILDERS_AUDIENCE,
  verifyMcAssertion,
} from '../../../supabase/functions/_shared/mcFederation';

const b64url = (bytes: Uint8Array | string): string => {
  const raw = typeof bytes === 'string'
    ? Buffer.from(bytes)
    : Buffer.from(bytes);
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function makeSigner(kid = crypto.randomUUID()) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (claims: Record<string, unknown>, signAsKid = kid) => {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: signAsKid }));
    const payload = b64url(JSON.stringify(claims));
    const signature = new Uint8Array(await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(`${header}.${payload}`),
    ));
    return `${header}.${payload}.${b64url(signature)}`;
  };
  return { jwk: { ...jwk, kid }, sign, kid, privateKey: pair.privateKey };
}

function stubJwks(jwk: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ keys: [jwk] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({
  iss: 'https://mission-control.example/api/public/clones/oidc',
  sub: 'mission-control:operator',
  aud: BUILDERS_AUDIENCE,
  iat: now(),
  exp: now() + 300,
  jti: 'j1',
  scopes: ['builders:operate'],
});

describe('verifyMcAssertion', () => {
  it('refuses by NAME when the trust root is unconfigured', async () => {
    const verdict = await verifyMcAssertion('a.b.c', 'builders:operate');
    expect(verdict).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('accepts a well-formed assertion signed by the published key', async () => {
    env.set('MISSION_CONTROL_URL', 'https://mission-control.example');
    const signer = await makeSigner();
    stubJwks(signer.jwk);
    const verdict = await verifyMcAssertion(await signer.sign(goodClaims()), 'builders:operate');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.sub).toBe('mission-control:operator');
  });

  it('refuses the wrong audience — one key, two audiences, zero cross-acceptance', async () => {
    env.set('MISSION_CONTROL_URL', 'https://mission-control.example');
    const signer = await makeSigner();
    stubJwks(signer.jwk);
    const token = await signer.sign({ ...goodClaims(), aud: 'https://api.anthropic.com/oauth/token' });
    expect(await verifyMcAssertion(token, 'builders:operate'))
      .toEqual({ ok: false, reason: 'wrong_audience' });
  });

  it('refuses a missing scope, an expired token, and a foreign signature', async () => {
    env.set('MISSION_CONTROL_URL', 'https://mission-control.example');
    const signer = await makeSigner();
    stubJwks(signer.jwk);

    expect(await verifyMcAssertion(
      await signer.sign({ ...goodClaims(), scopes: ['builders:federate'] }),
      'builders:operate',
    )).toEqual({ ok: false, reason: 'missing_scope' });

    expect(await verifyMcAssertion(
      await signer.sign({ ...goodClaims(), exp: now() - 3600 }),
      'builders:operate',
    )).toEqual({ ok: false, reason: 'expired' });

    // The stranger SPOOFS the published kid with foreign key material —
    // the cache finds the kid, the signature does not verify.
    const stranger = await makeSigner(signer.kid);
    expect(await verifyMcAssertion(
      await stranger.sign(goodClaims()),
      'builders:operate',
    )).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('pins the issuer when the environment names one', async () => {
    env.set('MISSION_CONTROL_URL', 'https://mission-control.example');
    env.set('MC_FEDERATION_ISSUER', 'https://mission-control.example/api/public/clones/oidc');
    const signer = await makeSigner();
    stubJwks(signer.jwk);
    expect((await verifyMcAssertion(await signer.sign(goodClaims()), 'builders:operate')).ok).toBe(true);
    expect(await verifyMcAssertion(
      await signer.sign({ ...goodClaims(), iss: 'https://elsewhere.example/oidc' }),
      'builders:operate',
    )).toEqual({ ok: false, reason: 'wrong_issuer' });
  });
});

describe('builder-network-admin, at the source', () => {
  const source = readCode('supabase/functions/builder-network-admin/index.ts');

  /**
   * One operation's body, so an assertion about it cannot be satisfied by
   * another operation twenty lines away. Comment-stripped, because `source`
   * is: a rule about what the handler DOES must not be met by prose saying
   * it does.
   */
  const operationBody = (operation: string): string => {
    const start = source.indexOf(`operation === '${operation}'`);
    expect(start, operation).toBeGreaterThan(-1);
    const next = source.indexOf("if (operation === '", start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  };

  it('sees the join-request queue and cannot decide it', () => {
    // Owners decide membership. The admin surface reads the table and never
    // writes it — no update, no insert, no decided_at.
    const after = source.split("from('builder_org_join_requests')");
    expect(after.length).toBeGreaterThan(1);
    for (const chunk of after.slice(1)) {
      const head = chunk.slice(0, 40);
      expect(head.includes('.select(')).toBe(true);
    }
  });

  it('touches memberships only to seed an organisation that has none', () => {
    // This assertion used to be `not.toContain('builder_organisation_memberships')`
    // — an absolute ban standing in for the real rule, which is that nothing
    // here may decide membership in somebody ELSE'S organisation.
    //
    // It then became a COUNT of the uses, which is the same proxy one step
    // removed: adding the access-request pipeline made it read 3 where it
    // expected 2, and the honest answer was never a different number. Both
    // callers do the same lawful thing — seed the first owner of an
    // organisation that has nobody in it — and that is what is checked.
    //
    //   `invite_organisation_owner` counts members and REFUSES when any
    //   exist, then seeds.
    //   `submit_access_request` seeds into the organisation IT JUST CREATED
    //   a few lines above, which by construction has none.
    //
    // Anything else touching this table is an operator deciding somebody
    // else's membership, so every use has to sit inside one of those two.
    const bootstrap = operationBody("invite_organisation_owner");
    const application = operationBody("submit_access_request");

    const uses = source.split("from('builder_organisation_memberships')").length - 1;
    const accounted =
      (bootstrap.split("from('builder_organisation_memberships')").length - 1) +
      (application.split("from('builder_organisation_memberships')").length - 1);
    expect(accounted).toBe(uses);

    // Both seed through the ONE owner-seat grant (builderOwnerSeat.ts), so
    // the seed itself is asserted there and its call sites here. Before it
    // existed each door carried its own insert, and both failed identically
    // on 1 Oct 2026 against a closed organisation's primary seat.
    const seed = /grantOwnerSeat\(supabase, \{/;
    expect(source.match(new RegExp(seed.source, 'g'))?.length).toBe(2);

    // The bootstrap refuses before it seeds.
    const guard = bootstrap.indexOf('organisation_already_has_members');
    expect(guard).toBeGreaterThan(-1);
    expect(bootstrap.search(seed)).toBeGreaterThan(guard);
    expect(bootstrap.slice(bootstrap.search(seed), bootstrap.search(seed) + 200))
      .toMatch(/organisationId: organisationId/);
    // And what guards it is a real read of the seats, revoked ones included
    // (no `revoked_at` filter), whose failure refuses rather than reading as
    // an empty organisation. It yields only to this door's own waiting
    // invitation to the same person (`ownerInvitationMayBeReissued`).
    expect(bootstrap).toMatch(
      /builder_organisation_memberships'\)\s*\.select\('builder_user_id, membership_role, status, revoked_at'\)\s*\.eq\('organisation_id', organisationId\);/,
    );
    expect(bootstrap).toMatch(/if \(seatedError\) \{[\s\S]{0,200}return json\(/);
    expect(bootstrap).toMatch(
      /if \(seats\.length > 0 && !reissue\) \{\s*return json\(\{ error: 'organisation_already_has_members' \}, 409\);/,
    );

    // The application seeds only into the organisation it created itself.
    const created = application.indexOf("from('builder_organisations')");
    expect(created).toBeGreaterThan(-1);
    expect(application.search(seed)).toBeGreaterThan(created);
    expect(application.slice(application.search(seed), application.search(seed) + 200))
      .toMatch(/organisationId: organisation\.id/);

    // Nothing anywhere updates or deletes a membership — here, or in the
    // grant both doors call. Promotion of a seat THIS organisation left
    // waiting goes through the one promoter, asserted in builderInviteScope.
    const grant = readCode('supabase/functions/_shared/builderOwnerSeat.ts');
    for (const code of [source, grant]) {
      expect(code).not.toMatch(/builder_organisation_memberships'\)[\s\S]{0,120}\.(update|delete)\(/);
    }
  });

  it('a closed organisation is acted on only by reopening it', () => {
    // Every other act refuses a closed row (the code keeps its old name so a
    // deployed console reading it still understands it); the one way back is
    // `reopen_organisation`, which only ever moves a row OUT of closed.
    expect(source).toContain('a_closed_organisation_is_terminal');
    const reopen = operationBody('reopen_organisation');
    expect(reopen).toMatch(/\.eq\('status', 'closed'\)/);
  });

  it('the invite code is hashed at rest and returned once', () => {
    expect(source).toContain('hashSessionToken(inviteCode)');
    expect(source).toContain('invite_code_hash: inviteCodeHash');
    // Nothing stores the plaintext.
    expect(source).not.toMatch(/invite_code:\s*inviteCode,[\s\S]{0,200}\.insert\(/);
  });

  it('one live connection per pair; revoked rows never block a new one', () => {
    expect(source).toContain("in('state', ['invited', 'active'])");
    expect(source).toContain('a_live_connection_already_exists');
  });

  it('is gated on builders:operate before any operation dispatch', () => {
    const gateAt = source.indexOf("verifyMcAssertion(token, 'builders:operate')");
    const dispatchAt = source.indexOf("operation === 'overview'");
    expect(gateAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(gateAt);
  });
});
