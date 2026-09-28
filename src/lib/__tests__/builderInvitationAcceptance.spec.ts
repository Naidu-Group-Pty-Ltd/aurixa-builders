import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_MEMBERSHIP_STATUS,
  invitationRequiresPassword,
  inviterMayHoldInvitationLink,
} from '../../../supabase/functions/_shared/builderInviteScope.pure';
import { invitationEmail } from '../../../supabase/functions/_shared/builderInvitationCopy.pure';
import { shapeMembers } from '../../../supabase/functions/_shared/builderMemberManagement.pure';

/**
 * AN INVITATION WAITS FOR ITS INVITEE — WHOEVER THEY ALREADY ARE (doc 68).
 *
 * An address that already signed in somewhere joined an inviting organisation
 * at once: the membership was granted `active`, nothing was minted, and a
 * notice said "you now have access". Two things followed from that one rule.
 *
 *  * Nobody agreed to it. Any owner or administrator could put an existing
 *    account into their organisation, and it appeared in that person's
 *    switcher with a role somebody else chose.
 *  * It was the last oracle. The members list filed that address as a live
 *    member under its registered name the moment it was invited, while a new
 *    address waited as an invitation under the name the inviter typed — so one
 *    invitation told an administrator whether an arbitrary address already had
 *    an account (doc 67 §3).
 *
 * The owner's rule (28 Sep 2026): every organisation invitation waits for the
 * invitee to accept it, established accounts included. Existing memberships are
 * not touched. The acceptance is the emailed link, and for an account that
 * already signs in it is ONE deliberate click: no password is set or changed,
 * and no session is issued by the link, because a link that signed somebody in
 * without their password would be a weaker door than the one they already use.
 */

const functions = (...parts: string[]) =>
  readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'functions', ...parts), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('which invitation an account is offered', () => {
  it('a brand-new or never-accepted account sets a password', () => {
    expect(invitationRequiresPassword({ password_hash: null, invite_accepted_at: null })).toBe(true);
    expect(invitationRequiresPassword({})).toBe(true);
  });

  it('an account that already signs in only accepts — nothing about its password changes', () => {
    expect(invitationRequiresPassword({ password_hash: '$2b$10$x', invite_accepted_at: null })).toBe(false);
    expect(invitationRequiresPassword({ password_hash: null, invite_accepted_at: '2026-09-01T00:00:00Z' })).toBe(false);
  });
});

describe('who may hold the link', () => {
  it('never the inviter, where there is a postman', () => {
    for (const requiresPassword of [true, false]) {
      expect(inviterMayHoldInvitationLink({ send: 'sent', requiresPassword })).toBe(false);
      expect(inviterMayHoldInvitationLink({ send: 'failed', requiresPassword })).toBe(false);
    }
  });

  it('never the inviter for an account that already signs in — even with no mail provider', () => {
    // That link joins the account to the inviting organisation with one click.
    // Handed to the inviter, the inviter could accept on the person's behalf:
    // the auto-activation this rule removes, by another route.
    expect(inviterMayHoldInvitationLink({ send: 'not_configured', requiresPassword: false })).toBe(false);
  });

  it('only a password-setting link, and only where the deployment has no mail provider', () => {
    expect(inviterMayHoldInvitationLink({ send: 'not_configured', requiresPassword: true })).toBe(true);
  });
});

describe('what the invitee is sent', () => {
  const base = {
    organisationName: 'Acme Builders',
    companyName: 'Aurixa',
    inviterName: 'Pat Owner',
    inviteeName: 'Sam',
    url: 'https://builders.example/builder/accept-invite?token=t',
    expiryHours: 72,
  };

  it('a first invitation asks for a password, as it always has', () => {
    const mail = invitationEmail({ ...base, requiresPassword: true });
    expect(mail.content.action?.label).toBe('Set your password');
    expect(mail.content.action?.url).toBe(base.url);
  });

  it('an account that already signs in is asked to ACCEPT, and told nothing changes until it does', () => {
    const mail = invitationEmail({ ...base, requiresPassword: false });
    expect(mail.content.action?.label).toBe('Accept invitation');
    expect(mail.content.action?.url).toBe(base.url);
    const words = [mail.subject, mail.content.heading, ...mail.content.paragraphs, mail.content.footnote ?? ''].join(' ');
    expect(words).not.toMatch(/you now have access|has added you|password/i);
    expect(words).toMatch(/until you accept/i);
  });

  it('greets the invitee by the name THIS organisation typed, never a name from the account', () => {
    // The account row carries whatever the first inviter typed, or the
    // person's registered name; neither is this organisation's to repeat.
    const mail = invitationEmail({ ...base, requiresPassword: false, inviteeName: 'Sam' });
    expect(mail.content.paragraphs[0]).toBe('Hi Sam,');
  });
});

describe('the members list, where the last oracle was', () => {
  const caller = { callerId: 'owner', callerRole: 'owner' };
  const seats = [
    { id: 's-new', builder_user_id: 'u-new', membership_role: 'member', status: PENDING_MEMBERSHIP_STATUS, invited_name: 'Nina New' },
    { id: 's-est', builder_user_id: 'u-est', membership_role: 'member', status: PENDING_MEMBERSHIP_STATUS, invited_name: 'Eddie' },
    { id: 's-else', builder_user_id: 'u-else', membership_role: 'member', status: PENDING_MEMBERSHIP_STATUS, invited_name: 'Ellie' },
  ];
  const users = [
    { id: 'u-new', name: 'Nina New', email: 'nina@x.test', status: 'invited' },
    // Signs in already, under the name they registered with.
    { id: 'u-est', name: 'Edward Registered-Name', email: 'eddie@x.test', status: 'active' },
    // Pending in ANOTHER organisation, which typed its own name for them.
    { id: 'u-else', name: 'Name Another Organisation Typed', email: 'ellie@x.test', status: 'invited' },
  ];

  it('files every waiting seat as an invitation, whatever the account behind it has done', () => {
    const shaped = shapeMembers(seats, users, caller);
    expect(shaped.members).toEqual([]);
    expect(shaped.invitations.map((v) => v.builder_user_id).sort()).toEqual(['u-else', 'u-est', 'u-new']);
  });

  it('shows the name this organisation typed for a waiting seat — never the account\'s', () => {
    const byUser = new Map(shapeMembers(seats, users, caller).invitations.map((v) => [v.builder_user_id, v]));
    expect(byUser.get('u-est')?.name).toBe('Eddie');
    expect(byUser.get('u-else')?.name).toBe('Ellie');
    expect(byUser.get('u-new')?.name).toBe('Nina New');
  });

  it('shows a member the account\'s own name once they have accepted — they agreed to join', () => {
    const accepted = shapeMembers(
      [{ ...seats[1], status: 'active' }], users, caller);
    expect(accepted.members[0]?.name).toBe('Edward Registered-Name');
  });

  it('keeps a seat recorded before the typed name existed readable', () => {
    const legacy = shapeMembers(
      [{ id: 's-old', builder_user_id: 'u-new', membership_role: 'member', status: PENDING_MEMBERSHIP_STATUS }],
      users, caller);
    expect(legacy.invitations[0]?.name).toBe('Nina New');
  });
});

describe('the invite door grants nothing an invitee has not accepted', () => {
  const code = stripComments(functions('builder-portal-invite', 'index.ts'));

  it('every membership it creates waits', () => {
    const grants = code.match(/\.from\('builder_organisation_memberships'\)\s*\.insert\(\{[\s\S]*?\}\)/g) ?? [];
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).toMatch(/status:\s*PENDING_MEMBERSHIP_STATUS/);
      expect(grant).not.toMatch(/status:\s*'active'/);
    }
    // The rule that made an established account's grant live is gone from this door.
    expect(code).not.toMatch(/membershipStatusForGrant/);
  });

  it('never brings a seat up itself — only the invitee\'s acceptance does', () => {
    expect(code).not.toMatch(/promoteWaitingMembership/);
    const updates = code.match(/\.from\('builder_organisation_memberships'\)\s*\.update\(\{[\s\S]*?\}\)/g) ?? [];
    for (const update of updates) expect(update).not.toMatch(/status:\s*'active'/);
  });

  it('sends no "you now have access" notice, because nobody has access until they accept', () => {
    expect(code).not.toMatch(/You now have access/);
    expect(code).not.toMatch(/builder_membership_granted/);
  });

  it('carries each invitation on its own seat, so an established account has something to accept', () => {
    const grant = (code.match(/\.from\('builder_organisation_memberships'\)\s*\.insert\(\{[\s\S]*?\}\)/g) ?? [])[0] ?? '';
    expect(grant).toMatch(/invite_token_hash:/);
    expect(grant).toMatch(/invite_token_expires_at:/);
    expect(grant).toMatch(/invited_name:/);
  });

  it('files every invitation\'s typed name for the list, and the list reads it', () => {
    const invite = functions('builder-portal-invite', 'index.ts');
    const list = invite.slice(invite.indexOf("if (action === 'list_members')"));
    expect(list.slice(0, 800)).toMatch(/invited_name/);
  });

  it('cancels a waiting seat whatever the account behind it has done', () => {
    // It used to cancel only for an account that had never signed in, so the
    // same button left an established invitee's seat standing — another
    // difference an administrator could read.
    const revoke = code.slice(code.indexOf("if (action === 'revoke_invite')"),
      code.indexOf("if (action === 'list_join_requests')"));
    expect(revoke.length).toBeGreaterThan(200);
    expect(revoke).not.toMatch(/invite_accepted_at|password_hash/);
    expect(revoke).toMatch(/PENDING_MEMBERSHIP_STATUS/);
  });
});

describe('the acceptance door: one click for an account that already signs in', () => {
  const source = functions('builder-portal-accept-invite', 'index.ts');
  const code = stripComments(source);

  it('looks the token up on the seat first, and tells a failed read from an absent token', () => {
    expect(code).toMatch(/\.from\('builder_organisation_memberships'\)[\s\S]{0,300}\.eq\('invite_token_hash', tokenHash\)/);
    expect(code).toMatch(/error: seatError/);
  });

  it('says on validation whether a password is asked for', () => {
    expect(code).toMatch(/requires_password:/);
  });

  it('joins an established account without writing its password, its status or a session', () => {
    const start = code.indexOf('const joinOnly = async');
    expect(start, 'the join-only acceptance exists').toBeGreaterThan(-1);
    const end = code.indexOf('\n    };', start);
    const joinOnly = code.slice(start, end);
    expect(joinOnly.length).toBeGreaterThan(200);
    expect(joinOnly).not.toMatch(/password_hash|hashPassword|must_change_password/);
    expect(joinOnly).not.toMatch(/issueBuilderSession|createBuilderSessionCookie|Set-Cookie/);
    expect(joinOnly).not.toMatch(/\.from\('builder_portal_users'\)\s*\.update\(\{[^}]*status:/);
    expect(joinOnly).toMatch(/promoteWaitingMembership\(/);
    expect(joinOnly).toMatch(/signed_in: false/);
  });

  it('promotes the seat the token is on, and uses the token up in the same statement', () => {
    expect(code).toMatch(/inviteTokenHash: tokenHash/);
    const helper = functions('_shared', 'builderInvite.ts');
    const fn = helper.slice(helper.indexOf('export async function promoteWaitingMembership'));
    expect(fn).toMatch(/\.eq\('invite_token_hash', args\.inviteTokenHash\)/);
  });

  it('no longer turns an account that signs in away from an invitation it was sent', () => {
    expect(code).not.toMatch(/already_active: true/);
  });

  it('activates a never-accepted account only while it is still unaccepted and not withdrawn', () => {
    const activations = code.match(/\.from\('builder_portal_users'\)\s*\.update\(\{[\s\S]*?password_hash: hashedPassword[\s\S]*?\.maybeSingle\(\)/g) ?? [];
    expect(activations.length).toBeGreaterThan(0);
    for (const activation of activations) {
      expect(activation).toMatch(/\.is\('invite_accepted_at', null\)/);
      expect(activation).toMatch(/\.is\('revoked_at', null\)/);
    }
  });
});
