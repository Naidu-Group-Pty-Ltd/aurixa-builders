/**
 * WHAT ONE INVITATION IS ALLOWED TO OPEN.
 *
 * The invite token lives on `builder_portal_users`, so it is a credential for
 * an ACCOUNT. The things it lights up are MEMBERSHIPS, and those belong to
 * organisations. Until this module existed nothing reconciled the two, and the
 * gap was a cross-organisation takeover, measured against production on
 * 27 Sep 2026:
 *
 *  1. Organisation A's owner or administrator invites an address that is still
 *     a pending invitee of organisation B. `invite` re-mints the account's one
 *     token, replacing B's.
 *  2. ANY failure of the send hands the plaintext link back to A's
 *     administrator. (110 invitations had been refused since 16 Sep, which the
 *     audit read as proof the sends were broken; doc 65 §4 records why that was
 *     wrong. A bounce, an outage or a rate limit reach the same branch, so the
 *     defect never rested on it.)
 *  3. Accepting activated the ACCOUNT, and every membership it held came alive
 *     with it: B's too, up to `owner`. The mailbox was stamped verified with
 *     nobody having proved they hold it.
 *
 * Two rules close it. Each is sufficient alone; both are here because one is
 * structural and the other stops the attacker ever holding the credential.
 *
 * **A grant to a not-yet-active account is PENDING.** Acceptance activates
 * only the organisation whose token was accepted. Every other organisation
 * stays pending until its own invitation is accepted.
 * `builder_accessible_organisations` already requires `status = 'active'`, so a
 * pending membership is invisible to session issue, organisation selection and
 * every authorisation check — the enforcement point is one that already
 * existed and is asserted elsewhere, rather than a new gate to be trusted.
 *
 * **A link is never handed to a caller** who would thereby hold a credential
 * for an organisation that is not theirs.
 *
 * Pure on purpose: the rules are tested without a database or a network, and
 * both the portal door and the operator door import them rather than restating
 * them. A restated rule is how two doors come to disagree.
 */

/**
 * The status a membership waits in until its own invitation is accepted.
 *
 * `builder_organisation_memberships_status_check` admits it as of migration
 * `20260928090000`. It is deliberately the same word the USER row already uses
 * while pending, so one vocabulary describes one state.
 */
export const PENDING_MEMBERSHIP_STATUS = "invited" as const;

/** A live (not revoked) membership, as the scope rules need to see it. */
export interface ScopeMembership {
  readonly organisation_id: string;
  readonly membership_role?: string | null;
  readonly status?: string | null;
}

/**
 * What status a membership granted right now should start in.
 *
 * An organisation adding a colleague who already signs in is not an
 * invitation: nothing is minted and there is nothing to accept, so that
 * membership is live at once and its behaviour is unchanged. A grant to an
 * account that cannot yet sign in is a promise the invitation has to keep.
 */
export function membershipStatusForGrant(
  args: { readonly accountIsActive: boolean },
): "active" | typeof PENDING_MEMBERSHIP_STATUS {
  return args.accountIsActive ? "active" : PENDING_MEMBERSHIP_STATUS;
}

export type InviteLinkRefusal = "belongs_to_another_organisation" | "no_inviting_organisation";

export interface InviteLinkDisclosure {
  readonly mayReturnLink: boolean;
  readonly reason?: InviteLinkRefusal;
}

/**
 * May the calling administrator be shown the one-time link?
 *
 * Only where every membership the account holds is the caller's own
 * organisation. Anything else means the link would let its holder into
 * somebody else's organisation, which is the takeover above.
 *
 * The reason NAMES NO ORGANISATION: a caller who may not hold the link may not
 * learn which other organisation the address belongs to either.
 */
export function inviteLinkDisclosure(
  args: {
    readonly liveMemberships: readonly ScopeMembership[];
    readonly invitingOrganisationId: string | null;
  },
): InviteLinkDisclosure {
  if (!args.invitingOrganisationId) {
    return { mayReturnLink: false, reason: "no_inviting_organisation" };
  }
  const elsewhere = args.liveMemberships.some(
    (membership) => membership.organisation_id !== args.invitingOrganisationId,
  );
  return elsewhere
    ? { mayReturnLink: false, reason: "belongs_to_another_organisation" }
    : { mayReturnLink: true };
}

export type AcceptanceRefusal =
  | "token_organisation_not_a_membership"
  | "unscoped_token_spans_organisations"
  | "no_membership";

export type AcceptanceActivation =
  | { readonly ok: true; readonly activate: string }
  | { readonly ok: false; readonly reason: AcceptanceRefusal };

/**
 * Which single organisation this acceptance may activate.
 *
 * A token minted with no organisation predates this rule. It is honoured only
 * where the account holds exactly one organisation, so no second organisation
 * can come alive with it; where it spans several it is refused rather than
 * guessed, because guessing is the defect. Production held no such token when
 * this shipped (0 pending accounts, 0 live tokens), so the branch exists to
 * fail safely rather than to be relied on.
 */
export function acceptanceActivation(
  args: {
    readonly tokenOrganisationId: string | null;
    readonly liveMemberships: readonly ScopeMembership[];
  },
): AcceptanceActivation {
  const organisations = [...new Set(args.liveMemberships.map((m) => m.organisation_id))];
  if (!organisations.length) return { ok: false, reason: "no_membership" };

  if (!args.tokenOrganisationId) {
    return organisations.length === 1
      ? { ok: true, activate: organisations[0] }
      : { ok: false, reason: "unscoped_token_spans_organisations" };
  }

  return organisations.includes(args.tokenOrganisationId)
    ? { ok: true, activate: args.tokenOrganisationId }
    : { ok: false, reason: "token_organisation_not_a_membership" };
}
