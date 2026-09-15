/**
 * Join-request decisions — the deciding half of registration's
 * never-auto-join rule — pinned at the source.
 *
 * The behavioural proofs (approve grants exactly one member-role
 * membership, duplicates refuse, cross-org ids read as not-found, decline
 * grants nothing) run against the real schema in
 * scripts/db/baseline-check.mjs §4. What lives here is the wiring that a
 * refactor would most plausibly loosen: WHO may call, WHICH organisation id
 * is used, and WHERE the decision executes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const invite = readCode('supabase/functions/builder-portal-invite/index.ts');
const migration = read('supabase/migrations/20260915110000_join_request_decisions_and_onboarding.sql');

describe('authorisation order in builder-portal-invite', () => {
  it('the owner/administrator gate stands before every join-request action', () => {
    const roleGate = invite.indexOf("membershipRole !== 'owner' && membershipRole !== 'administrator'");
    const listAction = invite.indexOf("'list_join_requests'");
    const decideAction = invite.indexOf("'approve_join_request'");
    expect(roleGate).toBeGreaterThan(-1);
    expect(listAction).toBeGreaterThan(roleGate);
    expect(decideAction).toBeGreaterThan(roleGate);
  });

  it('the organisation id is the server-resolved active organisation, never the body', () => {
    const listBlock = invite.slice(
      invite.indexOf("'list_join_requests'"), invite.indexOf("'approve_join_request'"));
    expect(listBlock).toContain(".eq('organisation_id', activeOrganisationId)");
    const decideBlock = invite.slice(invite.indexOf("'approve_join_request'"));
    expect(decideBlock).toContain('_organisation_id: activeOrganisationId');
    // The one body-sourced value is the request id, and it must parse as a uuid.
    expect(decideBlock).toMatch(/request_id[\s\S]{0,200}\[0-9a-f\]\{8\}/);
  });

  it('the decision executes as one database command', () => {
    expect(invite).toContain("rpc('builder_decide_org_join_request'");
    // No direct membership or request-status writes from the edge function:
    // the transaction is the database's.
    const joinSection = invite.slice(invite.indexOf('Join requests'));
    expect(joinSection).not.toMatch(/from\('builder_organisation_memberships'\)\s*\.\s*(insert|update)/);
    expect(joinSection).not.toMatch(/from\('builder_org_join_requests'\)\s*\.\s*update/);
  });
});

describe('the decision command', () => {
  it('re-verifies the decider and settles concurrency on the pending row', () => {
    expect(migration).toContain("membership_role IN ('owner', 'administrator')");
    expect(migration).toContain('BUILDER_NOT_ORG_ADMIN');
    expect(migration).toMatch(/AND r\.status = 'pending'/);
    expect(migration).toContain('BUILDER_JOIN_REQUEST_ALREADY_DECIDED');
    expect(migration).toContain('BUILDER_JOIN_REQUEST_NOT_FOUND');
  });

  it('stamps decided_by and decided_at with the status', () => {
    expect(migration).toMatch(/decided_by = _decided_by/);
    expect(migration).toMatch(/decided_at = now\(\)/);
  });

  it('grants the member role, never ownership, and audits the act', () => {
    expect(migration).toMatch(/'member',\s*\n?\s*v_primary/);
    expect(migration).not.toMatch(/VALUES \(v_request\.builder_user_id, _organisation_id, 'owner'/);
    expect(migration).toContain("'builder_org_join_request_approved'");
    expect(migration).toContain("'builder_org_join_request_declined'");
  });
});

describe('the surface', () => {
  it('the settings page offers the queue beside the invite card', () => {
    const settings = read('src/pages/builder/BuilderSettings.tsx');
    expect(settings).toContain('<BuilderTeamInviteCard />');
    expect(settings).toContain('<BuilderJoinRequestsCard />');
  });

  it('the card defers to the server and renders only for owners/administrators', () => {
    const card = readCode('src/components/builder-portal/BuilderJoinRequestsCard.tsx');
    expect(card).toMatch(/membershipRole === 'owner' \|\| membershipRole === 'administrator'/);
    expect(card).toContain('builderDecideJoinRequest');
  });

  it('Mission Control keeps visibility and no decision authority', () => {
    const admin = readCode('supabase/functions/builder-network-admin/index.ts');
    expect(admin).toContain("'list_join_requests'");
    expect(admin).not.toContain('builder_decide_org_join_request');
    expect(admin).not.toMatch(/approve_join_request|decline_join_request/);
  });
});
