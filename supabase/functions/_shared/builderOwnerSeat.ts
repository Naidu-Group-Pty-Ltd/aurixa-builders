/**
 * The one way an operator door seats a new organisation's first owner.
 *
 * `submit_access_request` and `invite_organisation_owner` grant the same seat
 * under the same rules and had two copies of the grant, which is how they
 * came to fail the same way on 1 Oct 2026 (see `builderOwnerSeat.pure.ts`).
 * This is the grant; the rules it answers to are in the pure module.
 *
 * It reads, inserts and — only for an account that can already sign in —
 * promotes a seat THIS organisation left waiting, through the one promotion
 * implementation (`promoteWaitingMembership`). It never updates or deletes a
 * membership in any other organisation: the seat a closed organisation's
 * owner still holds is their record of where they were, and stays exactly as
 * it is.
 *
 * Every failure is RETURNED, never thrown, and never read as success. A door
 * that is told "granted" emails "this organisation is now yours to run", so a
 * grant that changed nothing must not say it did.
 */
import { promoteWaitingMembership } from './builderInvite.ts';
import {
  membershipStatusForGrant,
  PENDING_MEMBERSHIP_STATUS,
} from './builderInviteScope.pure.ts';
import {
  ownerSeatIsPrimary,
  readMembershipCollision,
  type HeldSeat,
} from './builderOwnerSeat.pure.ts';

export type OwnerSeatResult =
  | {
    readonly ok: true;
    /**
     * `granted` — a new seat. `promoted` — this organisation's waiting seat
     * brought up for an account that already signs in. `already_held` — the
     * seat was already there, as an owner, in the state this grant would
     * have written (a retried request, or two operators racing).
     */
    readonly seat: 'granted' | 'promoted' | 'already_held';
    /** Whether the seat opens by default at sign-in. */
    readonly isPrimary: boolean;
  }
  | {
    readonly ok: false;
    /** Machine-readable, for logs and for the outcome the door records. */
    readonly reason: 'seats_unreadable' | 'seat_not_granted' | 'seat_held_otherwise';
    readonly message: string;
  };

export async function grantOwnerSeat(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: {
    readonly builderUserId: string;
    readonly organisationId: string;
    /** `password_hash || invite_accepted_at` — the door's own reading. */
    readonly accountIsActive: boolean;
  },
): Promise<OwnerSeatResult> {
  // An owner seat granted to an account that cannot sign in yet WAITS for
  // that account to accept THIS organisation's invitation. Left live, an
  // invitation accepted in some other organisation would bring it up too.
  const status = membershipStatusForGrant({ accountIsActive: args.accountIsActive });

  // Where the account already sits. A read that FAILED is not an account
  // with no seats: guessing "primary" from nothing collides on exactly the
  // index this module exists to read.
  const { data: seats, error: seatsError } = await supabase
    .from('builder_organisation_memberships')
    .select('organisation_id, is_primary')
    .eq('builder_user_id', args.builderUserId)
    .is('revoked_at', null);
  if (seatsError) {
    return { ok: false, reason: 'seats_unreadable', message: String(seatsError.message ?? seatsError) };
  }

  let isPrimary = ownerSeatIsPrimary((seats ?? []) as HeldSeat[], args.organisationId);
  const insertSeat = (primary: boolean) => supabase
    .from('builder_organisation_memberships')
    .insert({
      builder_user_id: args.builderUserId,
      organisation_id: args.organisationId,
      membership_role: 'owner',
      is_primary: primary,
      status,
    });

  let { error } = await insertSeat(isPrimary);
  // A primary that appeared between the read and the insert (another door
  // granting this account a seat at the same moment) costs the new seat its
  // default, never the seat itself.
  if (error && isPrimary && readMembershipCollision(error) === 'primary_taken') {
    isPrimary = false;
    ({ error } = await insertSeat(false));
  }
  if (!error) return { ok: true, seat: 'granted', isPrimary };

  if (readMembershipCollision(error) !== 'seat_exists') {
    return { ok: false, reason: 'seat_not_granted', message: String(error.message ?? error) };
  }

  /*
   * THE ACCOUNT ALREADY HAS A SEAT HERE. For an account that signs in, a seat
   * an earlier grant left WAITING would otherwise never come up: nothing is
   * minted for an established account, so no acceptance will promote it, and
   * on the operator's doors that strands an organisation with no reachable
   * owner. A promotion that changed no row is not an attachment — the seat
   * that exists is read below and decides.
   */
  if (args.accountIsActive) {
    const promotion = await promoteWaitingMembership(supabase, {
      builderUserId: args.builderUserId,
      organisationId: args.organisationId,
      membershipRole: 'owner',
    });
    if (promotion.error) {
      return { ok: false, reason: 'seat_not_granted', message: String(promotion.error.message) };
    }
    if (promotion.promoted > 0) return { ok: true, seat: 'promoted', isPrimary: false };
  }

  const { data: seat, error: seatError } = await supabase
    .from('builder_organisation_memberships')
    .select('status, membership_role, is_primary')
    .eq('builder_user_id', args.builderUserId)
    .eq('organisation_id', args.organisationId)
    .is('revoked_at', null)
    .maybeSingle();
  if (seatError || !seat) {
    return { ok: false, reason: 'seats_unreadable', message: String(seatError?.message ?? 'the seat could not be read back') };
  }
  // Already what this grant would have written: an owner, live for an
  // account that signs in, waiting for one that does not. Anything else — a
  // suspended seat, a different role — is somebody's decision this door does
  // not overrule.
  const expected = args.accountIsActive ? 'active' : PENDING_MEMBERSHIP_STATUS;
  if (seat.membership_role === 'owner' && seat.status === expected) {
    return { ok: true, seat: 'already_held', isPrimary: seat.is_primary === true };
  }
  return {
    ok: false,
    reason: 'seat_held_otherwise',
    message: `a ${seat.status} ${seat.membership_role} seat already exists`,
  };
}
