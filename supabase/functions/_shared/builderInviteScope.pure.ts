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

/**
 * MAY THE PLATFORM OPERATOR BE HANDED THIS LINK?
 *
 * A different caller, so a different rule, and the difference is the whole
 * reason there are two.
 *
 * The operator door mints a brand-new organisation's first owner and takes
 * `send_email` as a choice: an operator who declines the email IS the intended
 * delivery channel, so "only where there is no mail provider" would break the
 * door's purpose. What must never happen is the operator receiving a working
 * credential for somebody else's person — and that was reachable, because
 * `established` is `password_hash || invite_accepted_at` and a real tenant's
 * PENDING INVITEE has neither. An operator could create an empty organisation,
 * name that address its owner, take the link, accept it, choose a password and
 * stamp the mailbox verified; the account is then theirs and every live
 * membership it holds comes with it.
 *
 * So the operator's rule is the membership one: the link is handed over only
 * where the account belongs nowhere but the organisation being created.
 *
 * This is deliberately NOT the tenant's rule. For a tenant administrator, a
 * response that varies by address is an oracle over other tenants' staff — the
 * thing `builder-portal-invite`'s own header forbids — so there the decision
 * reads the provider state and nothing about the invitee. A platform operator
 * can already see the whole network, so nothing is disclosed to them that they
 * could not read directly; what is withheld is the CREDENTIAL, not the fact.
 */
export function operatorMayHandLink(
  args: {
    readonly liveMemberships: readonly ScopeMembership[];
    readonly newOrganisationId: string | null;
  },
): boolean {
  if (!args.newOrganisationId) return false;
  return !args.liveMemberships.some(
    (membership) => membership.organisation_id !== args.newOrganisationId,
  );
}

/** What the mail provider did with this invitation, as the senders report it. */
export type InviteSendState = "sent" | "not_configured" | "failed";

/**
 * MAY THIS RESPONSE CARRY THE ONE-TIME LINK AT ALL?
 *
 * This is the question `inviteLinkDisclosure` should have been, and the
 * independent review of the first fix is what showed it. Two things were wrong
 * with returning the link whenever a send merely FAILED.
 *
 *  * **A failed send is attacker-triggerable.** The provider limits sends per
 *    second and `builder-portal-invite` has no rate limit of its own, so a
 *    caller can force `failed` at will. Holding the link for an address nobody
 *    has claimed yet lets the CALLER accept it: acceptance sets a password of
 *    their choosing and stamps the mailbox verified, so they own an account
 *    bearing somebody else's address. Scoping acceptance stops that account
 *    reaching another organisation TODAY — but an account that already signs in
 *    is granted a LIVE membership whenever any organisation adds it later, by
 *    design and correctly, so the claim pays off the first time the real person
 *    is invited somewhere. Closing the link is what closes that.
 *  * **The link's PRESENCE was an oracle.** Withholding it from a caller whose
 *    invitee belongs elsewhere makes its absence a per-address answer to "does
 *    this address hold a membership in an organisation that is not mine?" —
 *    exactly what `builder-portal-invite`'s own header forbids. A caller who may
 *    not know WHICH organisation may not be told THAT one exists either.
 *
 * So the affordance is kept only for the case it was written for — a deployment
 * with **no mail provider at all**, where the inviter is the only delivery
 * channel there is and no invitation could otherwise be sent — and never
 * because one send went wrong. There the residual is accepted and unavoidable:
 * whoever can invite is the postman.
 *
 * `sent` returns nothing because the email carries it. `failed` returns nothing
 * and says so in the log, with the provider's own message.
 */
export function mayHandLinkToInviter(args: { readonly send: InviteSendState }): boolean {
  return args.send === "not_configured";
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
    /*
     * A legacy token names no organisation, so the only safe reading is an
     * account that holds exactly one — and the one it holds has to be a
     * membership actually WAITING on an invitation. The candidate list is every
     * non-revoked membership, `suspended` included; promotion no-ops on those,
     * so nothing is over-activated either way, but naming one as the
     * organisation being joined tells whoever holds the link about a membership
     * nobody is inviting them into.
     */
    const waiting = [...new Set(
      args.liveMemberships
        .filter((m) => !m.status || m.status === PENDING_MEMBERSHIP_STATUS)
        .map((m) => m.organisation_id),
    )];
    if (!waiting.length) return { ok: false, reason: "no_membership" };
    return waiting.length === 1
      ? { ok: true, activate: waiting[0] }
      : { ok: false, reason: "unscoped_token_spans_organisations" };
  }

  return organisations.includes(args.tokenOrganisationId)
    ? { ok: true, activate: args.tokenOrganisationId }
    : { ok: false, reason: "token_organisation_not_a_membership" };
}
