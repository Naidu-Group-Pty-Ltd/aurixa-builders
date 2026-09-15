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

describe('builder-portal-register', () => {
  const source = readCode('supabase/functions/builder-portal-register/index.ts');

  it('an ABN match creates a join REQUEST, and only the new-org path creates a membership', () => {
    expect(source).toContain("from('builder_org_join_requests')");
    // Exactly one membership insert in the whole function: the owner
    // membership of a freshly created organisation. The join-request branch
    // adds none — auto-join is the thing this function must never do.
    const membershipInserts = source.match(/from\('builder_organisation_memberships'\)/g) ?? [];
    expect(membershipInserts).toHaveLength(1);
  });

  it('never reasons about the email DOMAIN at all', () => {
    // Auto-join-on-domain needs the domain; the cheapest way to keep the
    // rule is that the function never extracts one.
    expect(source).not.toMatch(/split\(['"]@['"]\)/);
    expect(source).not.toMatch(/emailDomain|email_domain/);
  });

  it('a self-registered organisation arrives pending verification, inactive', () => {
    expect(source).toContain("status: 'pending_verification'");
    expect(source).toContain('is_active: false');
  });

  it('the registrant arrives unverified', () => {
    expect(source).toContain('email_verified_at: null');
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
  it('both routes are declared PUBLIC — the emailed link needs no session', () => {
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

  it('the login page offers the second door', () => {
    expect(read('src/pages/builder/BuilderLogin.tsx')).toContain('to="/builder/register"');
  });
});

describe('every door mints the onboarding checklist', () => {
  it('self-registration seeds steps with the SAME rpc the invite paths use', () => {
    const register = readCode('supabase/functions/builder-portal-register/index.ts');
    const userInsertAt = register.indexOf("from('builder_portal_users')\n      .insert(");
    const ensureAt = register.indexOf("rpc('builder_ensure_onboarding_steps'");
    expect(userInsertAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeGreaterThan(userInsertAt);
    // No duplicated step list in TypeScript: the catalogue stays in the
    // database function, one place, both doors.
    expect(register).not.toMatch(/profile_confirmed|organisation_confirmed|contact_confirmed|security_reviewed/);
  });

  it('the invite paths still seed through the same rpc', () => {
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
