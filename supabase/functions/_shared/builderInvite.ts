/**
 * The one way a Builder Portal invite is minted.
 *
 * `builder-portal-invite` grew this first: a token of two UUIDs, stored only
 * as a peppered hash, expiring in a fixed window, delivered as a link to
 * `/builder/accept-invite`. `builder-network-admin` needs the same thing to
 * bootstrap a brand-new organisation's first owner, and a second copy of a
 * credential's shape is how the two come to disagree about the window, the
 * path, or — worst — whether the plaintext is ever stored.
 *
 * Two rules travel with it.
 *
 *  * **An unhashable token is never stored.** `hashSessionToken` returns null
 *    when the session pepper is unconfigured, and writing the token
 *    unpeppered would leave a credential at rest in a form that verifies
 *    itself. `mintBuilderInvite` returns null instead and the caller refuses.
 *
 *  * **The plaintext is returned exactly once and never persisted.** Only the
 *    hash reaches the database, so a link that is lost is re-minted rather
 *    than re-read — the same rule the network's connection invite codes and
 *    the Passport's grant links already answer to.
 */
import { hashSessionToken } from './sessionHash.ts';
import { PENDING_MEMBERSHIP_STATUS } from './builderInviteScope.pure.ts';

/** How long an invite link stays good. One window, both callers. */
export const INVITE_EXPIRY_HOURS = 72;

/** Where a builder accepts one. */
export function builderAppBaseUrl(): string {
  return (Deno.env.get('APP_BASE_URL') || 'https://builders.aurixasystems.com.au').replace(/\/+$/, '');
}

export function inviteUrlFor(token: string): string {
  return `${builderAppBaseUrl()}/builder/accept-invite?token=${encodeURIComponent(token)}`;
}

export interface MintedInvite {
  /** Shown once to whoever is sending it. Never stored. */
  readonly token: string;
  /** What the database holds. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly url: string;
}

/**
 * Mint one. Null means the pepper is unconfigured — refuse, do not downgrade.
 */
export async function mintBuilderInvite(now: Date = new Date()): Promise<MintedInvite | null> {
  const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const tokenHash = await hashSessionToken(token);
  if (!tokenHash) return null;
  return {
    token,
    tokenHash,
    expiresAt: new Date(now.getTime() + INVITE_EXPIRY_HOURS * 3_600_000),
    url: inviteUrlFor(token),
  };
}

/**
 * Bring a WAITING membership up, and only a waiting one.
 *
 * `invited` is a membership granted to an account that has not accepted this
 * organisation's own invitation yet (20260928090000). Two things promote it:
 * accepting that organisation's invitation, and the organisation granting
 * access again to an account that by then already signs in — which mints
 * nothing, so without this the row would never come up, the "you now have
 * access" notice would promise access the portal refuses, and the seat would
 * be stuck for good. On the operator's own doors the same stranding leaves an
 * organisation with no reachable owner.
 *
 * Four call sites needed it, which is why it is here rather than at any of
 * them: three copies of one rule is how the three come to disagree about which
 * statuses may be promoted.
 *
 * Two rules travel with it.
 *
 *  * **Only ever from `invited`.** A `suspended` membership is an
 *    administrator's decision and neither an invitation nor a re-grant may
 *    undo it; a `revoked` one is gone. The filter is the status, never the
 *    absence of `active`.
 *  * **Scoped to one organisation.** An update naming only the user is the
 *    cross-organisation activation this whole change exists to prevent.
 *
 * Returns the error rather than throwing, so each caller can decide whether a
 * failed promotion should fail its act — on acceptance it must not, because
 * the single-use token has already been spent.
 *
 * AND IT REPORTS WHETHER IT PROMOTED ANYTHING. The first version returned only
 * the error, and a zero-row update carries none: a membership that is
 * `suspended` rather than waiting matched nothing, answered `error: null`, and
 * the caller went on to email the colleague "You now have access — your
 * existing sign-in still works" over a membership the portal still refuses.
 * That is verbatim the failure the promotion exists to prevent, so silence may
 * not read as success. Refusing to promote a suspended membership is right;
 * reporting the refusal as a grant is not.
 *
 * A SEAT'S OWN INVITATION IS USED UP BY THE STATEMENT THAT ACCEPTS IT (doc 68).
 * Given `inviteTokenHash`, the seat is promoted only while it still carries
 * that token, and the trigger `trg_builder_membership_invitation_ends` clears
 * the token as the seat stops waiting — so one token brings one seat up, once,
 * and two concurrent acceptances cannot both succeed.
 */
export async function promoteWaitingMembership(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: {
    readonly builderUserId: string;
    readonly organisationId: string;
    /** Set where the caller is granting a role now, omitted on acceptance. */
    readonly membershipRole?: string;
    readonly grantedBy?: string;
    /** The seat's own invitation, when that is what is being accepted. */
    readonly inviteTokenHash?: string;
  },
): Promise<{ readonly error: { message: string } | null; readonly promoted: number }> {
  const patch: Record<string, unknown> = { status: 'active' };
  if (args.membershipRole) patch.membership_role = args.membershipRole;
  if (args.grantedBy) patch.granted_by = args.grantedBy;
  // `.select('id')` is what makes the row count readable at all: without it
  // PostgREST returns no representation and "changed nothing" is
  // indistinguishable from "changed one".
  let promotion = supabase
    .from('builder_organisation_memberships')
    .update(patch)
    .eq('builder_user_id', args.builderUserId)
    .eq('organisation_id', args.organisationId)
    .eq('status', PENDING_MEMBERSHIP_STATUS)
    .is('revoked_at', null);
  if (args.inviteTokenHash) promotion = promotion.eq('invite_token_hash', args.inviteTokenHash);
  const { data, error } = await promotion.select('id');
  return { error: error ?? null, promoted: Array.isArray(data) ? data.length : 0 };
}
