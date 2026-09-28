import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_MEMBERSHIP_STATUS,
  acceptanceActivation,
  inviteLinkDisclosure,
  membershipStatusForGrant,
} from '../../../supabase/functions/_shared/builderInviteScope.pure';

/**
 * AN INVITATION BELONGS TO ONE ORGANISATION.
 *
 * The invite token is stored on `builder_portal_users`, so it is an ACCOUNT
 * credential; the memberships it can light up belong to organisations. Until
 * this module existed those two facts were never reconciled, and the gap was a
 * cross-organisation takeover:
 *
 *  1. Organisation A's owner invites an address that is still a pending
 *     invitee of organisation B. `invite` re-mints the account's one token.
 *  2. ANY failure of the invitation email hands the plaintext link back to A's
 *     own administrator. (The audit read 110 of 110 refusals as proof the sends
 *     were broken; doc 65 §4 records why that reading was wrong. The defect
 *     does not rest on it — a bounce, an outage or a rate limit reach the same
 *     branch.)
 *  3. Accepting that link activated the ACCOUNT, and every membership it held
 *     came alive with it — including B's, up to `owner`. It also stamped the
 *     mailbox verified without anybody proving they hold it.
 *
 * Two rules close it, and each is sufficient on its own. They are both here
 * because the first is the structural one and the second is the one that stops
 * the attacker ever holding the credential:
 *
 *  * A GRANT TO A NOT-YET-ACTIVE ACCOUNT IS PENDING, and acceptance activates
 *    only the organisation the accepted token was minted for. Every other
 *    organisation's membership stays pending until its own invitation is
 *    accepted. `builder_accessible_organisations` already requires
 *    `status = 'active'`, so a pending membership is invisible to sessions,
 *    organisation selection and every authorisation check — the enforcement
 *    point is one that already existed.
 *  * A LINK IS NEVER HANDED TO A CALLER who would thereby hold a credential
 *    for somebody else's organisation.
 */

const org = {
  a: 'aaaaaaaa-1111-4111-8111-111111111111',
  b: 'bbbbbbbb-2222-4222-8222-222222222222',
} as const;

const live = (organisationId: string, role = 'member') => ({
  organisation_id: organisationId,
  membership_role: role,
  status: 'active',
});
const pending = (organisationId: string, role = 'member') => ({
  organisation_id: organisationId,
  membership_role: role,
  status: PENDING_MEMBERSHIP_STATUS,
});

describe('what status a granted membership starts in', () => {
  it('is pending for an account that has not accepted anything yet', () => {
    expect(membershipStatusForGrant({ accountIsActive: false })).toBe(PENDING_MEMBERSHIP_STATUS);
  });

  it('is active for an account that is already on the network', () => {
    // An organisation adding a colleague who already signs in is not an
    // invitation: nothing is minted and there is nothing to accept, so the
    // membership is live at once. That behaviour is unchanged.
    expect(membershipStatusForGrant({ accountIsActive: true })).toBe('active');
  });

  it('never invents a status the column would refuse', () => {
    for (const accountIsActive of [true, false]) {
      expect(['active', 'invited']).toContain(membershipStatusForGrant({ accountIsActive }));
    }
  });
});

describe('whether the inviter may be shown the link', () => {
  it('may, for a brand-new invitee who belongs nowhere else', () => {
    const verdict = inviteLinkDisclosure({ liveMemberships: [pending(org.a)], invitingOrganisationId: org.a });
    expect(verdict.mayReturnLink).toBe(true);
  });

  it('may, when every membership the account holds is the inviter own organisation', () => {
    const verdict = inviteLinkDisclosure({
      liveMemberships: [pending(org.a), live(org.a)],
      invitingOrganisationId: org.a,
    });
    expect(verdict.mayReturnLink).toBe(true);
  });

  it('MAY NOT, when the account is a pending invitee of another organisation', () => {
    const verdict = inviteLinkDisclosure({
      liveMemberships: [pending(org.a), pending(org.b, 'owner')],
      invitingOrganisationId: org.a,
    });
    expect(verdict.mayReturnLink).toBe(false);
    expect(verdict.reason).toBe('belongs_to_another_organisation');
  });

  it('MAY NOT, when the account holds a live membership of another organisation', () => {
    const verdict = inviteLinkDisclosure({
      liveMemberships: [pending(org.a), live(org.b, 'owner')],
      invitingOrganisationId: org.a,
    });
    expect(verdict.mayReturnLink).toBe(false);
  });

  it('refuses rather than guesses when it is not told which organisation is inviting', () => {
    const verdict = inviteLinkDisclosure({ liveMemberships: [pending(org.a)], invitingOrganisationId: null });
    expect(verdict.mayReturnLink).toBe(false);
  });

  it('names no organisation in its reason — the caller learns only that it may not have the link', () => {
    const verdict = inviteLinkDisclosure({
      liveMemberships: [pending(org.a), pending(org.b)],
      invitingOrganisationId: org.a,
    });
    expect(JSON.stringify(verdict)).not.toContain(org.b);
  });
});

describe('what one accepted invitation activates', () => {
  it('activates the organisation the token was minted for', () => {
    const outcome = acceptanceActivation({
      tokenOrganisationId: org.a,
      liveMemberships: [pending(org.a)],
    });
    expect(outcome).toEqual({ ok: true, activate: org.a });
  });

  it('activates ONLY that organisation, never another the account is pending in', () => {
    const outcome = acceptanceActivation({
      tokenOrganisationId: org.a,
      liveMemberships: [pending(org.a), pending(org.b, 'owner')],
    });
    expect(outcome).toEqual({ ok: true, activate: org.a });
  });

  it('leaves another organisation alone even when that membership is already live', () => {
    // The operator-created first owner of B is `active` while B's account is
    // still pending. Accepting A's invitation must not be a way into B — and
    // here it cannot be, because acceptance touches only A's row.
    const outcome = acceptanceActivation({
      tokenOrganisationId: org.a,
      liveMemberships: [pending(org.a), live(org.b, 'owner')],
    });
    expect(outcome).toEqual({ ok: true, activate: org.a });
  });

  it('refuses a token whose organisation the account does not belong to', () => {
    const outcome = acceptanceActivation({
      tokenOrganisationId: org.b,
      liveMemberships: [pending(org.a)],
    });
    expect(outcome).toEqual({ ok: false, reason: 'token_organisation_not_a_membership' });
  });

  it('accepts a token minted before this rule existed when there is nothing to over-activate', () => {
    // A token stored with no organisation is one minted by the old code. It is
    // honoured only where the account holds exactly one membership, so no
    // other organisation can come alive with it.
    const outcome = acceptanceActivation({
      tokenOrganisationId: null,
      liveMemberships: [pending(org.a)],
    });
    expect(outcome).toEqual({ ok: true, activate: org.a });
  });

  it('refuses a token minted before this rule existed when the account belongs to several', () => {
    const outcome = acceptanceActivation({
      tokenOrganisationId: null,
      liveMemberships: [pending(org.a), pending(org.b)],
    });
    expect(outcome).toEqual({ ok: false, reason: 'unscoped_token_spans_organisations' });
  });

  it('refuses an account with no membership at all', () => {
    const outcome = acceptanceActivation({ tokenOrganisationId: org.a, liveMemberships: [] });
    expect(outcome.ok).toBe(false);
  });

  it('returns exactly one organisation to activate, whatever it is given', () => {
    const outcome = acceptanceActivation({
      tokenOrganisationId: org.a,
      liveMemberships: [pending(org.a), pending(org.a), pending(org.b)],
    });
    expect(outcome).toEqual({ ok: true, activate: org.a });
  });
});

describe('the handlers that must obey these rules', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', ...parts), 'utf8');
  const invite = read('builder-portal-invite', 'index.ts');
  const accept = read('builder-portal-accept-invite', 'index.ts');
  const admin = read('builder-network-admin', 'index.ts');

  it('the invite function records which organisation a token was minted for', () => {
    expect(invite).toMatch(/invite_token_organisation_id/);
  });

  it('the invite function asks this module whether it may return the link', () => {
    expect(invite).toMatch(/inviteLinkDisclosure/);
  });

  it('the invite function grants a membership at this module status, never a literal', () => {
    expect(invite).toMatch(/membershipStatusForGrant/);
  });

  it('the acceptance function reads the token organisation and scopes on it', () => {
    expect(accept).toMatch(/invite_token_organisation_id/);
    expect(accept).toMatch(/acceptanceActivation/);
  });

  it('the acceptance function activates one membership — the one the rule chose', () => {
    /*
     * This used to assert `.eq('organisation_id'` in this file, which was a
     * statement about where the promotion happened to be WRITTEN rather than
     * about what it does: moving the statement into the shared helper broke it
     * while the behaviour was unchanged and, worse, a copy left behind here
     * would have kept it green. So the two halves are asserted where each
     * lives — the helper scopes by organisation (below), and what acceptance
     * owes is that the organisation it passes is the one the RULE chose, never
     * the account's whole membership set.
     */
    const promotion = accept.slice(accept.indexOf('promoteWaitingMembership(supabase, {'));
    expect(promotion.slice(0, 300)).toMatch(/organisationId: scope\.activate/);
  });

  it('the operator door grants a first owner at this module status too', () => {
    // Otherwise an operator-created pending owner stays `active` and an
    // invitation accepted elsewhere would still reach that organisation.
    expect(admin).toMatch(/membershipStatusForGrant/);
    expect(admin).toMatch(/invite_token_organisation_id/);
  });

  it('no handler grants a membership with a hard-coded active status any more', () => {
    for (const source of [invite, admin]) {
      const grants = source.match(/\.insert\(\{[^}]*builder_user_id[^}]*\}\)/gs) ?? [];
      const membershipGrants = grants.filter((g) => g.includes('organisation_id') && g.includes('membership_role'));
      expect(membershipGrants.length).toBeGreaterThan(0);
      for (const grant of membershipGrants) expect(grant).not.toMatch(/status:\s*'active'/);
    }
  });
});

describe('a seat that was left waiting', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', ...parts), 'utf8');
  const helper = read('_shared', 'builderInvite.ts');
  const invite = read('builder-portal-invite', 'index.ts');
  const accept = read('builder-portal-accept-invite', 'index.ts');
  const admin = read('builder-network-admin', 'index.ts');

  /*
   * Adding a colleague who already signs in mints nothing, so nothing would
   * otherwise promote a membership an earlier invitation left `invited`: the
   * "you now have access" notice would promise access the portal refuses and
   * the seat would be stuck for good. On the operator's own doors the same
   * stranding leaves an organisation with NO reachable owner and no surface
   * that can repair it.
   */
  it('is promoted by exactly one implementation, not one per door', () => {
    expect(helper).toMatch(/export async function promoteWaitingMembership/);
    /*
     * Stated as the DEFECT rather than as "no door updates a membership":
     * revoking an invitation legitimately writes one directly, and a guard
     * that forbids every update would have to be relaxed for it and would then
     * stop seeing the thing it is for. What no door may do is bring a
     * membership UP by hand — that is the rule with four call sites, and three
     * copies is how three come to disagree about which statuses may be
     * promoted.
     */
    for (const [name, source] of [['invite', invite], ['accept', accept], ['admin', admin]] as const) {
      const updates = source.match(
        /\.from\('builder_organisation_memberships'\)\s*\.update\(\{[^}]*\}/gs,
      ) ?? [];
      for (const update of updates) {
        expect(update, `${name} promotes a membership by hand`).not.toMatch(/status:\s*'active'/);
      }
      expect(source).toMatch(/promoteWaitingMembership/);
    }
  });

  it('is promoted only from waiting — never from suspended or revoked', () => {
    // A suspended membership is an administrator's decision; neither an
    // invitation nor a re-grant may undo it. The filter is the status itself,
    // never the absence of `active`.
    const fn = helper.slice(helper.indexOf('export async function promoteWaitingMembership'));
    expect(fn).toMatch(/\.eq\('status', PENDING_MEMBERSHIP_STATUS\)/);
    expect(fn).toMatch(/\.is\('revoked_at', null\)/);
    expect(fn).not.toMatch(/'suspended'/);
    expect(fn).not.toMatch(/\.neq\('status'/);
  });

  it('is promoted inside one organisation, named as well as the user', () => {
    // An update naming only the user is the cross-organisation activation this
    // whole change exists to prevent.
    const fn = helper.slice(helper.indexOf('export async function promoteWaitingMembership'));
    expect(fn).toMatch(/\.eq\('builder_user_id', args\.builderUserId\)/);
    expect(fn).toMatch(/\.eq\('organisation_id', args\.organisationId\)/);
  });

  it('is reached on the portal door only where the account already signs in', () => {
    expect(invite).toMatch(/23505' && accountIsActive/);
  });

  it('is reached on BOTH operator doors, where stranding costs an organisation its owner', () => {
    const branches = admin.match(/23505' && established/g) ?? [];
    expect(branches.length).toBe(2);
    const promotions = admin.match(/promoteWaitingMembership\(supabase, \{/g) ?? [];
    expect(promotions.length).toBe(2);
  });

  it('never fails an acceptance, because the single-use token is already spent', () => {
    // The promotion is after the update that decides the race, so a failure
    // here leaves the account active with nothing accessible — refused by the
    // session, explained, and recoverable by re-sending. It must not throw.
    const promotion = accept.slice(accept.indexOf('promoteWaitingMembership(supabase, {'));
    expect(promotion.slice(0, 600)).not.toMatch(/throw/);
    expect(promotion).toMatch(/console\.error/);
  });

  it('returns its error rather than throwing, so each door decides', () => {
    const fn = helper.slice(helper.indexOf('export async function promoteWaitingMembership'));
    expect(fn).toMatch(/return \{ error: error \?\? null \}/);
    expect(fn).not.toMatch(/\bthrow\b/);
  });
});
