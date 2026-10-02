import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_MEMBERSHIP_STATUS,
  acceptanceActivation,
  mayHandLinkToInviter,
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

describe('whether the response may carry the one-time link', () => {
  /*
   * The first fix withheld the link where the address belonged to another
   * organisation. That closed the cross-organisation case and left two things
   * the independent review found, each of which this narrower rule closes:
   *
   *  * a FAILED send is attacker-triggerable, and holding the link for an
   *    unclaimed address lets the caller accept it themselves — owning an
   *    account bearing somebody else's address, which pays off the first time
   *    any organisation adds that established account live;
   *  * the link's PRESENCE answered "does this address belong somewhere that is
   *    not mine?", which is the oracle the invite function's header forbids.
   *    Protecting WHICH organisation while disclosing THAT one exists is not
   *    protection.
   */
  it('does not, when the email was sent — the email carries it', () => {
    expect(mayHandLinkToInviter({ send: 'sent' })).toBe(false);
  });

  it('does NOT, when a send merely failed', () => {
    // The case the takeover was delivered through, and the one an attacker can
    // force by running the provider over its per-second limit.
    expect(mayHandLinkToInviter({ send: 'failed' })).toBe(false);
  });

  it('does, and only, where the deployment has no mail provider at all', () => {
    // The case the affordance was written for: the inviter is the only delivery
    // channel there is, so withholding it means nobody can ever be invited.
    // The residual is accepted there and unavoidable — whoever may invite is
    // the postman.
    expect(mayHandLinkToInviter({ send: 'not_configured' })).toBe(true);
  });

  it('answers the same for every address, so its answer discloses nothing', () => {
    // The whole point: the decision reads the provider state and NOTHING about
    // the invitee, so the response shape cannot vary per address.
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'supabase', 'functions', '_shared', 'builderInviteScope.pure.ts'),
      'utf8',
    );
    const fn = source.slice(source.indexOf('export function mayHandLinkToInviter'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/membership|organisation|email|invitee/i);
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
  // Both operator doors seat a first owner through this one grant.
  const ownerSeat = read('_shared', 'builderOwnerSeat.ts');

  it('the invite function mints each invitation onto this organisation\'s own seat', () => {
    // Doc 68: the token used to live in the account's ONE slot and record its
    // organisation beside it; a second organisation's invitation overwrote the
    // first. It now lives on the seat it opens, so the organisation is the
    // seat's own and nothing can replace another organisation's.
    const grant = invite.match(/\.from\('builder_organisation_memberships'\)\s*\.insert\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(grant).toMatch(/organisation_id: activeOrganisationId/);
    expect(grant).toMatch(/invite_token_hash: minted\.tokenHash/);
  });

  it('both doors that can return a link ask this module — each its own rule', () => {
    /*
     * Exactly two functions return a one-time link, and the first fix guarded
     * one of them: `builder-network-admin` had no membership read of the target
     * at all, so an operator could mint a working credential for any address
     * not yet established, a real tenant's pending invitee included.
     *
     * They ask DIFFERENT questions, deliberately. A tenant administrator gets a
     * decision that reads nothing about the invitee, because any per-address
     * variation is an oracle over other tenants' staff. A platform operator,
     * who can already see the whole network, gets the membership rule: what is
     * withheld from them is the credential, not the fact.
     */
    expect(invite).toMatch(/inviterMayHoldInvitationLink/);
    expect(invite).not.toMatch(/operatorMayHandLink/);
    expect(admin).toMatch(/operatorMayHandLink/);
    expect(admin).not.toMatch(/mayHandLinkToInviter/);
  });

  it('the invite function grants every membership at this module\'s waiting status, never a literal', () => {
    // Doc 68: an organisation's invitation waits for its invitee whoever they
    // already are, so the tenant door no longer asks `membershipStatusForGrant`
    // (which made an established account's grant live). The operator door
    // still does — below.
    expect(invite).toMatch(/status: PENDING_MEMBERSHIP_STATUS/);
    expect(invite).not.toMatch(/membershipStatusForGrant/);
  });

  it('the acceptance function reads the token organisation and scopes on it', () => {
    expect(accept).toMatch(/invite_token_organisation_id/);
    expect(accept).toMatch(/acceptanceActivation/);
  });

  it('the acceptance function activates one membership — the one the rule chose, or the one the token is on', () => {
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
    const calls = [...accept.matchAll(/promoteWaitingMembership\(supabase, \{/g)].map((m) => accept.slice(m.index, m.index + 300));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // An account-slot token activates the organisation the scoping rule
      // chose; a seat token activates the seat it is on, and uses it up.
      const scoped = /organisationId: scope\.activate/.test(call);
      const seat = /organisationId: seat\.organisation_id/.test(call) && /inviteTokenHash: tokenHash/.test(call);
      expect(scoped || seat, call).toBe(true);
    }
  });

  it('the operator door grants a first owner at this module status too', () => {
    // Otherwise an operator-created pending owner stays `active` and an
    // invitation accepted elsewhere would still reach that organisation.
    // The status is decided once, in the grant both operator doors share, and
    // each door hands it the SAME reading of the account it minted against.
    expect(ownerSeat).toMatch(/membershipStatusForGrant\(\{ accountIsActive: args\.accountIsActive \}\)/);
    const calls = admin.match(/grantOwnerSeat\(supabase, \{[\s\S]{0,240}?\}\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toMatch(/accountIsActive: established/);
    expect(admin).toMatch(/invite_token_organisation_id/);
  });

  it('no handler grants a membership with a hard-coded active status any more', () => {
    for (const source of [invite, ownerSeat]) {
      const grants = source.match(/\.insert\(\{[^}]*builder_user_id[^}]*\}\)/gs) ?? [];
      const membershipGrants = grants.filter((g) => g.includes('organisation_id') && g.includes('membership_role'));
      expect(membershipGrants.length).toBeGreaterThan(0);
      for (const grant of membershipGrants) expect(grant).not.toMatch(/status:\s*'active'/);
    }
    // The operator plane keeps no grant of its own beside the shared one: a
    // second copy is how the two doors came to fail the same way.
    expect(admin).not.toMatch(/from\('builder_organisation_memberships'\)\s*\.insert\(/);
  });
});

describe('a seat that was left waiting', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', ...parts), 'utf8');
  const helper = read('_shared', 'builderInvite.ts');
  const invite = read('builder-portal-invite', 'index.ts');
  const accept = read('builder-portal-accept-invite', 'index.ts');
  const admin = read('builder-network-admin', 'index.ts');
  const ownerSeat = read('_shared', 'builderOwnerSeat.ts');

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
    for (const [name, source] of [['invite', invite], ['accept', accept], ['admin', admin], ['owner seat', ownerSeat]] as const) {
      const updates = source.match(
        /\.from\('builder_organisation_memberships'\)\s*\.update\(\{[^}]*\}/gs,
      ) ?? [];
      for (const update of updates) {
        expect(update, `${name} promotes a membership by hand`).not.toMatch(/status:\s*'active'/);
      }
    }
    // Acceptance and the operator's owner-seat grant bring a seat up; an
    // organisation's invitation never does (doc 68) — only its invitee does.
    expect(accept).toMatch(/promoteWaitingMembership/);
    expect(ownerSeat).toMatch(/promoteWaitingMembership/);
    expect(admin).not.toMatch(/promoteWaitingMembership\(/);
    expect(invite).not.toMatch(/promoteWaitingMembership/);
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

  it('is never reached on the portal door — an invitation brings nothing up, whoever it is for', () => {
    // It used to promote a waiting seat the moment an organisation re-added an
    // account that signs in. Doc 68: only the invitee's acceptance may.
    expect(invite).not.toMatch(/23505' && accountIsActive/);
    expect(invite).not.toMatch(/promoteWaitingMembership/);
  });

  it('is reached on BOTH operator doors, where stranding costs an organisation its owner', () => {
    // Both doors call the one grant, each with its own reading of whether the
    // account signs in; the grant promotes only for an account that does, and
    // only after its insert found the seat already there.
    const calls = admin.match(/grantOwnerSeat\(supabase, \{[\s\S]{0,240}?\}\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toMatch(/accountIsActive: established/);
    const exists = ownerSeat.indexOf("!== 'seat_exists'");
    const gate = ownerSeat.indexOf('if (args.accountIsActive) {');
    const promotion = ownerSeat.indexOf('promoteWaitingMembership(supabase, {');
    expect(exists).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(exists);
    expect(promotion).toBeGreaterThan(gate);
    expect((ownerSeat.match(/promoteWaitingMembership\(supabase, \{/g) ?? []).length).toBe(1);
  });

  it('never fails an acceptance by throwing, because the act it follows may already be spent', () => {
    // On activation the promotion is after the update that decides the race, so
    // a failure there leaves the account active with nothing accessible —
    // refused by the session, explained, and recoverable by re-sending. On a
    // join it IS the act, and a refusal is answered, never thrown.
    const calls = [...accept.matchAll(/promoteWaitingMembership\(supabase, \{/g)].map((m) => accept.slice(m.index, m.index + 600));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/\bthrow\b/);
    expect(accept).toMatch(/console\.error\('\[builder-portal-accept-invite\] membership promotion failed'/);
  });

  it('returns its error rather than throwing, so each door decides', () => {
    const fn = helper.slice(helper.indexOf('export async function promoteWaitingMembership'));
    expect(fn).toMatch(/return \{ error: error \?\? null, promoted:/);
    expect(fn).not.toMatch(/\bthrow\b/);
  });
});

describe('what the independent review found in the first fix', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', ...parts), 'utf8');
  const invite = read('builder-portal-invite', 'index.ts');
  const admin = read('builder-network-admin', 'index.ts');
  const accept = read('builder-portal-accept-invite', 'index.ts');
  const helper = read('_shared', 'builderInvite.ts');
  const ownerSeat = read('_shared', 'builderOwnerSeat.ts');
  const members = read('_shared', 'builderMemberManagement.pure.ts');
  const mail = read('_shared', 'builderInviteEmail.ts');
  const reset = read('builder-portal-forgot-password', 'index.ts');

  it('the operator door decides its link by WHOSE the account is, and reads the memberships to do it', () => {
    // `established` is `password_hash || invite_accepted_at`, and a real
    // tenant's PENDING INVITEE has neither — so this door handed out a working
    // credential for somebody else's person. It had no membership read at all.
    expect(admin).toMatch(/operatorMayHandLink/);
    const decision = admin.slice(admin.indexOf('WHOSE person is this'.toUpperCase()));
    expect(decision.slice(0, 900)).toMatch(/\.from\('builder_organisation_memberships'\)/);
    expect(admin).toMatch(/invite_url: established \|\| !linkIsTheirs \? null/);
  });

  it('the tenant door decides its link from the deployment first, and never hands over a join link', () => {
    // Any per-address variation is an oracle over other tenants' staff, so
    // where there is a mail provider the decision is no link for anybody. Where
    // there is none, only a password-setting link may be handed over: a join
    // link would let the inviter accept on an established account's behalf
    // (doc 68). That residual difference exists only without a provider.
    expect(invite).toMatch(/inviterMayHoldInvitationLink\(\{\s*send: providerConfigured \? 'sent' : 'not_configured',\s*requiresPassword/);
    expect(invite).not.toMatch(/inviteLinkDisclosure/);
  });

  it('a link is never handed over merely because one send failed', () => {
    // The decision is taken from the deployment's configuration BEFORE any
    // send (doc 68 moved every send after the answer), so no send's outcome
    // can reach it at all.
    expect(mayHandLinkToInviter({ send: 'failed' })).toBe(false);
    expect(invite).toMatch(/const providerConfigured = builderEmailConfigured\(\)/);
  });

  it('reads the send outcome by narrowing the union, never through a derived string', () => {
    /*
     * `reason` exists only on the unsent arm of `InviteEmailOutcome`, and a
     * derived `sendState` string cannot carry that discrimination back —
     * `deno check` rejected exactly that (TS2339) after the whole local suite
     * had passed, because Deno is not installed in the development sandbox and
     * CI is the only place this class is caught. This assertion is the local
     * half: every read of `outcome.reason` sits inside an `if (!outcome.sent)`.
     */
    const reads = [...invite.matchAll(/outcome\.reason/g)].map((m) => m.index ?? 0);
    expect(reads.length).toBeGreaterThan(0);
    const guard = invite.indexOf('if (!outcome.sent) {');
    expect(guard).toBeGreaterThan(-1);
    const guardEnd = invite.indexOf('\n      }', guard);
    for (const at of reads) {
      expect(at, 'a reason read outside the unsent branch').toBeGreaterThan(guard);
      expect(at, 'a reason read after the unsent branch closes').toBeLessThan(guardEnd);
    }
  });

  it('the promoter reports whether it promoted anything, and every caller reads it', () => {
    // A zero-row update carries no error, so silence used to read as success:
    // a `suspended` membership matched nothing and the caller emailed "you now
    // have access" over a membership the portal still refuses.
    expect(helper).toMatch(/\.select\('id'\)/);
    expect(helper).toMatch(/promoted: Array\.isArray\(data\) \? data\.length : 0/);
    expect(accept).toMatch(/\.promoted === 0/);
    // The operator doors' grant reads the count too: a promotion that changed
    // no row falls through to reading the seat back, never to "promoted".
    expect(ownerSeat).toMatch(/promotion\.promoted > 0\) return \{ ok: true, seat: 'promoted'/);
  });

  it('revoking an invitation destroys only this organisation own token', () => {
    // The token slot is one per account, so nulling it by user id alone let any
    // organisation cancel an invitation somebody else had issued.
    const revoke = invite.slice(invite.indexOf("action === 'revoke_invite'"));
    expect(revoke.slice(0, 2200)).toMatch(/\.eq\('invite_token_organisation_id', activeOrganisationId\)/);
  });

  it('the members list files a waiting membership with the invitations', () => {
    // It partitioned on the ACCOUNT's status, so a membership waiting in THIS
    // organisation drew as a full member with a Suspend the database refuses.
    expect(members).toMatch(/view\.status === PENDING_MEMBERSHIP_STATUS/);
  });

  it('the acceptance lookup tells a failed read from an absent token', () => {
    // The select names the new column, so functions deployed ahead of the
    // migration would answer PGRST204 and every invitation would read as
    // "invalid" with nothing logged.
    expect(accept).toMatch(/error: portalUserError/);
    expect(accept).toMatch(/503/);
  });

  it("the provider's own message is redacted before it is logged, on both send sites", () => {
    // The promise "the recipient never reaches a log" is not the provider's to
    // keep: its refusals quote the offending address.
    expect(mail).toMatch(/export function redactAddresses/);
    for (const [name, source] of [['invite email', mail], ['reset', reset]] as const) {
      expect(source, `${name} logs an unredacted body`).toMatch(/redactAddresses\(detail\)/);
      expect(source, `${name} logs a raw body`).not.toMatch(/provider_message: detail\./);
    }
  });

  it('a join approval grants the waiting status too, and promotes a waiting row', () => {
    // The rule reached three edge functions and not the one that grants in SQL.
    const sql = readFileSync(
      join(__dirname, '..', '..', '..', 'supabase', 'migrations',
        '20260928120000_a_join_request_is_a_grant_so_it_waits.sql'), 'utf8');
    expect(sql).toMatch(/v_grant_status := CASE/);
    expect(sql).not.toMatch(/v_primary, 'active', _decided_by/);
    expect(sql).toMatch(/SET status = 'active', granted_by = _decided_by/);
    expect(sql).toMatch(/AND m\.status = 'invited'/);
  });
});
