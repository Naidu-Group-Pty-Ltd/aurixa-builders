/**
 * Where a new organisation's first owner sits, when the account already sits
 * somewhere.
 *
 * Both operator doors on `builder-network-admin` seed an organisation's first
 * owner — `submit_access_request` into the organisation it has just created,
 * `invite_organisation_owner` into an empty one an operator created — and both
 * inserted the seat with `is_primary: true` unconditionally. Two partial
 * unique indexes stand behind that table:
 *
 *   builder_memberships_live_key         (builder_user_id, organisation_id)
 *                                        WHERE revoked_at IS NULL
 *   builder_memberships_one_primary_key  (builder_user_id)
 *                                        WHERE is_primary AND revoked_at IS NULL
 *
 * and `close_organisation` writes only the organisation row, so an account
 * whose organisation was closed still holds a live, PRIMARY seat in it. Its
 * next organisation's owner seat therefore collided with the one-primary key
 * every time. Measured 1 Oct 2026: one public application (14:36:45 UTC) and
 * six operator "Invite owner" attempts on the organisation it left behind
 * (14:47–14:50) all failed on `builder_memberships_one_primary_key` — so the
 * address of a closed organisation's owner could never own another one, by
 * either door, and the refusal named nothing but `invite_failed`.
 *
 * The doors then read every 23505 as the OTHER key — "a waiting seat I can
 * promote" — which found nothing to promote and refused, and for an account
 * that had not yet set a password they did not read it at all: the error was
 * dropped, the request settled `provisioned` and the welcome email promised an
 * organisation the person had no seat in.
 *
 * Two rules, and why each is the rule rather than a workaround:
 *
 *  1. THE NEW SEAT IS PRIMARY ONLY WHERE NO OTHER SEAT ALREADY IS. `is_primary`
 *     is a preference — the organisation a sign-in opens by default — and the
 *     person chose it, or their first organisation chose it for them. This
 *     never rewrites it: the seat in the closed organisation is somebody's
 *     record of where they were, the operator plane does not edit memberships
 *     in other organisations, and nothing about access depends on it. Sign-in
 *     already opens the accessible primary OR the only accessible organisation
 *     (`builderPortalAuth.ts`), and a closed organisation is never accessible,
 *     so a person whose only other seat is in a closed organisation still
 *     lands in their new one.
 *
 *  2. A COLLISION IS READ BY ITS INDEX, NEVER BY ITS CODE. `23505` alone cannot
 *     tell "you already have a seat here" from "you already have a primary
 *     somewhere", and the two have opposite remedies. The index name is in the
 *     error message, the same way `builderOrganisationConflict.pure.ts` reads
 *     the organisation table's three keys. An index this module does not name
 *     is `unrecognised` and fails the way it always did — a guess here would
 *     send the door down the wrong branch.
 */

import { PENDING_MEMBERSHIP_STATUS } from './builderInviteScope.pure.ts';

/** What Postgres raises when a unique index refuses a row. */
export const UNIQUE_VIOLATION = '23505';

export const MEMBERSHIP_LIVE_KEY = 'builder_memberships_live_key';
export const MEMBERSHIP_ONE_PRIMARY_KEY = 'builder_memberships_one_primary_key';

export interface PostgresErrorLike {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly details?: string | null;
}

/**
 * `seat_exists` — the account already holds a live seat in THIS organisation.
 * `primary_taken` — the account already holds a live primary seat elsewhere.
 * `unrecognised` — a unique violation on an index this module does not name.
 */
export type MembershipCollision = 'seat_exists' | 'primary_taken' | 'unrecognised';

/** Read a membership insert's error as a named collision, or as nothing. */
export function readMembershipCollision(
  error: PostgresErrorLike | null | undefined,
): MembershipCollision | null {
  if (!error || String(error.code ?? '') !== UNIQUE_VIOLATION) return null;
  const haystack = `${error.message ?? ''} ${error.details ?? ''}`;
  // The primary key is checked first: its name does not contain the live
  // key's, and neither contains the other, but the order is stated so a
  // future index named for both cannot be read as the wrong one silently.
  if (haystack.includes(MEMBERSHIP_ONE_PRIMARY_KEY)) return 'primary_taken';
  if (haystack.includes(MEMBERSHIP_LIVE_KEY)) return 'seat_exists';
  return 'unrecognised';
}

export interface HeldSeat {
  readonly organisation_id: string;
  readonly is_primary: boolean | null;
}

/**
 * Whether the owner seat about to be granted in `newOrganisationId` should be
 * the account's primary.
 *
 * Only a seat in ANOTHER organisation counts: a live seat in this one is the
 * `seat_exists` case, which the grant answers separately and never by
 * inserting a second row.
 */
export function ownerSeatIsPrimary(
  held: readonly HeldSeat[],
  newOrganisationId: string,
): boolean {
  return !held.some(
    (seat) => seat.organisation_id !== newOrganisationId && seat.is_primary === true,
  );
}

/**
 * A seat an organisation already holds, as the bootstrap's guard reads it.
 * Revoked rows are included on purpose: a seat that was withdrawn is history
 * this organisation has, and it is not "nobody here yet".
 */
export interface OrganisationSeat {
  readonly builder_user_id: string;
  readonly membership_role: string | null;
  readonly status: string | null;
  readonly revoked_at: string | null;
}

/**
 * MAY THE FIRST OWNER'S INVITATION BE ISSUED AGAIN?
 *
 * `invite_organisation_owner` refuses an organisation that has any member,
 * because adding a person to an organisation with members is administering
 * somebody else's organisation. But the seat its OWN first invitation granted
 * counts as a member, so the dialog's own advice — "if it is lost, mint
 * another" — was refused by the door that gave it, and so was every remedy for
 * an invitation whose email bounced or was never sent. The only owner the
 * organisation had was a promise nobody could deliver.
 *
 * Issuing that same invitation again is not adding anybody. So the guard
 * yields in exactly one shape: every seat the organisation has ever had is a
 * live OWNER seat, still WAITING (`invited`), belonging to the very account
 * being invited. Anything else — another person, a revoked seat, a seat that
 * has been accepted, a different role — is an organisation with history, and
 * is refused exactly as before.
 *
 * Re-issuing re-mints the account's one token, so the earlier link stops
 * working: that is what "mint another" means, and it is why a lost link is
 * safe to replace.
 */
export function ownerInvitationMayBeReissued(args: {
  readonly seats: readonly OrganisationSeat[];
  readonly accountId: string | null;
}): boolean {
  if (!args.accountId || args.seats.length === 0) return false;
  return args.seats.every(
    (seat) =>
      seat.revoked_at === null &&
      seat.builder_user_id === args.accountId &&
      seat.membership_role === 'owner' &&
      seat.status === PENDING_MEMBERSHIP_STATUS,
  );
}
