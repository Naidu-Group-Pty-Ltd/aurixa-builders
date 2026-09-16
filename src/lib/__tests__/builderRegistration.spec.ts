/**
 * The registration trio's load-bearing rules, pinned at the source
 * (extraction plan §5).
 *
 * These are the rules a later refactor would most plausibly loosen without
 * noticing: the order of the governance chain, the never-auto-join rule, the
 * separation of the verification token from the invite machinery, and the
 * backfill that keeps every pre-existing user out of a gate nobody owed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

/** Source with comments removed, so prose cannot satisfy — or break — a rule. */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('the governance chain', () => {
  it('reads email verification SECOND — after auth, before rotation', () => {
    const gate = readCode('supabase/functions/_shared/builderPortalAuth.ts');
    const body = gate.slice(gate.indexOf('builderGovernanceError'));
    const order = [
      "'auth_required'",
      "'email_verification_required'",
      "'password_rotation_required'",
      "'organisation_selection_required'",
      "'terms_acceptance_required'",
      "'onboarding_required'",
    ].map((needle) => body.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the browser guard mirrors the order (a journey aid, not the control)', () => {
    const guard = readCode('src/components/builder-portal/BuilderPortalProtectedRoute.tsx');
    const verifyAt = guard.indexOf('email_verified_at');
    const rotateAt = guard.indexOf('must_change_password');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(rotateAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(rotateAt);
  });

  it('nobody who already proved a mailbox is gated: the migration backfills', () => {
    const migration = read('supabase/migrations/20260914200000_registration_and_verification.sql');
    expect(migration).toMatch(/SET email_verified_at = invite_accepted_at/);
    expect(migration).toMatch(/invite_accepted_at IS NOT NULL/);
  });

  it('both emailed-token flows stamp the proof', () => {
    expect(readCode('supabase/functions/builder-portal-accept-invite/index.ts'))
      .toContain('email_verified_at: new Date().toISOString()');
    const reset = readCode('supabase/functions/builder-portal-reset-password/index.ts');
    expect(reset).toContain('email_verified_at: new Date().toISOString()');
    // Conditionally: a re-proof never rewrites the date of the first.
    expect(reset).toContain(".is('email_verified_at', null)");
  });
});

describe('builder-portal-register is a CLOSED door — invitation only', () => {
  const source = readCode('supabase/functions/builder-portal-register/index.ts');

  it('refuses every request with the invitation-only policy', () => {
    expect(source).toContain("code: 'registration_closed'");
    // 403, a policy — not a 404 that invites guessing, not a 200 that pretends.
    expect(source).toContain('REGISTRATION_CLOSED, 403');
  });

  it('writes nothing: no user, organisation, membership, join request or token', () => {
    // The whole exposure was that this endpoint wrote rows unauthenticated.
    // A closed door touches none of the identity tables at all.
    expect(source).not.toContain("from('builder_portal_users')");
    expect(source).not.toContain("from('builder_organisations')");
    expect(source).not.toContain("from('builder_organisation_memberships')");
    expect(source).not.toContain("from('builder_org_join_requests')");
    expect(source).not.toContain("from('builder_email_verification_tokens')");
    // It never mints an onboarding checklist, because it creates no one.
    expect(source).not.toContain("rpc('builder_ensure_onboarding_steps'");
  });

  it('still turns away a cross-origin probe before answering', () => {
    // The refusal is a portal answer, so the same origin/shape guard the rest
    // of the portal uses runs first.
    expect(source).toContain('validateBuilderPortalRequest(req)');
  });
});

describe('builder-portal-verify-email', () => {
  const source = readCode('supabase/functions/builder-portal-verify-email/index.ts');

  it('uses its own token table and never the invite machinery', () => {
    expect(source).toContain("from('builder_email_verification_tokens')");
    expect(source).not.toContain('invite_token');
    expect(source).not.toContain('invite_accepted');
  });

  it('consumes atomically and stamps conditionally', () => {
    expect(source).toContain(".is('consumed_at', null)");
    expect(source).toContain(".is('email_verified_at', null)");
  });

  it('CSRF-guards the one cookie-authenticated branch', () => {
    expect(source).toContain('enforceCsrf(req)');
  });
});

describe('the doors are wired', () => {
  it('the register route is kept and public — an old link meets an honest notice, not a 404', () => {
    const app = read('src/App.tsx');
    const registerAt = app.indexOf('<Route path="register" element={<BuilderRegister />} />');
    const verifyAt = app.indexOf('<Route path="verify-email" element={<BuilderVerifyEmail />} />');
    const guardAt = app.indexOf('<Route element={<BuilderPortalProtectedRoute />}>');
    expect(registerAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(registerAt).toBeLessThan(guardAt);
    expect(verifyAt).toBeLessThan(guardAt);
  });

  it('the register page is a closed-door notice that submits nothing', () => {
    const page = read('src/pages/builder/BuilderRegister.tsx');
    expect(page).toContain('Invitation only');
    // No form, no submit, no call to the registration client helper.
    expect(page).not.toContain('builderRegister');
    expect(page).not.toContain('<form');
  });

  it('the login page offers NO public sign-up link', () => {
    const login = read('src/pages/builder/BuilderLogin.tsx');
    expect(login).not.toContain('to="/builder/register"');
    expect(login).toContain('by invitation');
  });
});

describe('every account-creating door mints the onboarding checklist', () => {
  it('the invite paths seed through the shared rpc', () => {
    expect(readCode('supabase/functions/builder-portal-invite/index.ts'))
      .toContain("rpc('builder_ensure_onboarding_steps'");
    expect(readCode('supabase/functions/builder-portal-accept-invite/index.ts'))
      .toContain("rpc('builder_ensure_onboarding_steps'");
  });

  it('users created before the fix are backfilled, and the migration proves zero-row users gone', () => {
    const migration = read('supabase/migrations/20260915110000_join_request_decisions_and_onboarding.sql');
    expect(migration).toContain('builder_ensure_onboarding_steps(v_user)');
    expect(migration).toMatch(/a builder user still has zero onboarding rows/);
  });

  it('approval of a join request also ensures the checklist', () => {
    const migration = read('supabase/migrations/20260915110000_join_request_decisions_and_onboarding.sql');
    expect(migration).toContain('builder_ensure_onboarding_steps(v_request.builder_user_id)');
  });
});
