/**
 * Member management in the portal — the pure half.
 *
 * The AUTHORITY lives in the database (`builder_org_manage_membership`,
 * 20260927100000): an active owner or administrator of the organisation, an
 * owner only by an owner, never oneself, never the last active owner, never
 * `owner` as an assignable role. This module only shapes what the endpoint
 * returns: the member list, and a sentence for each refusal. `can_manage` is a
 * journey aid for the page; the server re-decides every act.
 */
import { PENDING_MEMBERSHIP_STATUS } from './builderInviteScope.pure.ts';


/** The roles an owner or administrator may assign — the same set invitations offer. */
export const MANAGEABLE_ROLES = ['administrator', 'manager', 'member', 'read_only'] as const;
export const MEMBER_ACTIONS = ['set_role', 'suspend', 'reactivate', 'remove'] as const;
export type MemberAction = typeof MEMBER_ACTIONS[number];

const REFUSALS: Record<string, { status: number; error: string }> = {
  BUILDER_NOT_ORG_ADMIN: { status: 403, error: 'Only an organisation owner or administrator may manage members' },
  BUILDER_OWNER_ONLY: { status: 403, error: 'Only an owner may change, suspend or remove an owner' },
  BUILDER_MEMBERSHIP_NOT_FOUND: { status: 404, error: 'That member is not in your organisation' },
  BUILDER_MEMBER_SELF_MANAGEMENT: { status: 409, error: 'You cannot change, suspend or remove your own membership' },
  BUILDER_LAST_OWNER: { status: 409, error: 'An organisation must keep at least one active owner' },
  BUILDER_MEMBER_ROLE_INVALID: { status: 400, error: 'That role cannot be assigned' },
  BUILDER_MEMBER_ACTION_UNKNOWN: { status: 400, error: 'That action is not recognised' },
  BUILDER_MEMBER_NOT_ACTIVE: { status: 409, error: 'That member is not active' },
  BUILDER_MEMBER_NOT_SUSPENDED: { status: 409, error: 'That member is not suspended' },
};

/** The refusal a database error names, or null when it names none (a fault, not a decision). */
export function memberRefusal(message: string): { status: number; error: string; code: string } | null {
  const code = Object.keys(REFUSALS).find((key) => message.includes(key));
  return code ? { ...REFUSALS[code], code } : null;
}

export interface MembershipRow {
  id: string;
  builder_user_id: string;
  membership_role: string;
  status: string;
  /** The name the inviting organisation typed (doc 68); null on a seat recorded before it existed. */
  invited_name?: string | null;
}
export interface MemberUserRow { id: string; name: string | null; email: string; status: string }
export interface MemberView {
  membership_id: string;
  builder_user_id: string;
  name: string | null;
  email: string;
  role: string;
  status: string;
  is_self: boolean;
  can_manage: boolean;
}

/**
 * Members and pending invitations, each carrying whether this caller could
 * manage them.
 *
 * THE SPLIT IS PER MEMBERSHIP, NOT PER ACCOUNT. It used to read the ACCOUNT's
 * status alone, which was the same question until a membership could wait on
 * its own (migration `20260928090000`): after the intended flow — A invites
 * Bob, B invites Bob, Bob accepts B's link — Bob's account is `active` while
 * A's membership is still `invited`, so A's list filed him under **members**
 * and drew him as a full one. There is no badge for a waiting membership, and
 * both Suspend and Remove rendered; Suspend is refused by the database
 * (`BUILDER_MEMBER_NOT_ACTIVE`) on a row the page had just presented as
 * active, Reactivate is refused too, and "Cancel invitation" was unreachable
 * because he was not in the invitations list. An invitation this organisation
 * is still waiting on belongs with the invitations, whatever the account has
 * done elsewhere.
 *
 * AND A WAITING SEAT IS NAMED BY WHAT THIS ORGANISATION TYPED (doc 68). The
 * account row carries another organisation's typed name, or the person's
 * registered one, so drawing it under an invitation told an administrator
 * where the address already belonged — the last oracle doc 67 left. Once the
 * invitee accepts, they are a member and are shown as they call themselves.
 */
export function shapeMembers(
  memberships: MembershipRow[],
  users: MemberUserRow[],
  caller: { callerId: string; callerRole: string },
): { members: MemberView[]; invitations: MemberView[] } {
  const userById = new Map(users.map((u) => [u.id, u]));
  const views: MemberView[] = [];
  for (const m of memberships) {
    const user = userById.get(m.builder_user_id);
    if (!user) continue;
    const isSelf = m.builder_user_id === caller.callerId;
    const mayTouchRole = m.membership_role !== 'owner' || caller.callerRole === 'owner';
    const waiting = m.status === PENDING_MEMBERSHIP_STATUS;
    views.push({
      membership_id: m.id,
      builder_user_id: m.builder_user_id,
      name: waiting ? (m.invited_name ?? user.name) : user.name,
      email: user.email,
      role: m.membership_role,
      status: m.status,
      is_self: isSelf,
      can_manage: !isSelf && mayTouchRole && (caller.callerRole === 'owner' || caller.callerRole === 'administrator'),
    });
  }
  // Either the account has never accepted anything, or THIS organisation's own
  // membership is still waiting — both are invitations from here.
  const invitedAccounts = new Set(users.filter((u) => u.status === 'invited').map((u) => u.id));
  const isInvitation = (view: MemberView) =>
    invitedAccounts.has(view.builder_user_id) || view.status === PENDING_MEMBERSHIP_STATUS;
  // Owners first, then by role, then by name.
  const rank = (role: string) => ['owner', ...MANAGEABLE_ROLES].indexOf(role as never);
  const byName = (a: MemberView, b: MemberView) =>
    rank(a.role) - rank(b.role) || (a.name ?? a.email).localeCompare(b.name ?? b.email);
  return {
    members: views.filter((v) => !isInvitation(v)).sort(byName),
    invitations: views.filter(isInvitation).sort(byName),
  };
}
