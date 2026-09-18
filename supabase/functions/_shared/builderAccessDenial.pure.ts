/**
 * Why a builder who typed the right password still cannot come in.
 *
 * `builder-portal-login` answers every post-credential refusal with
 * `GENERIC_AUTH_ERROR` — "Invalid email or password" — including the case
 * where the caller's organisation has been SUSPENDED. A builder whose
 * organisation an operator suspended is told their password is wrong, goes
 * and resets it, and is told their password is wrong again.
 *
 * The generic answer is right up to the moment the password is verified and
 * wrong after it. The login function already draws that line and states the
 * reason in its own header: "account state is only evaluated once the caller
 * has proven who they are." An attacker without the password never reaches
 * this module, so nothing here is observable to one — and to the person who
 * DID prove who they are, the state of their own organisation is not a
 * secret. `resolveBuilderSession` already takes that view, answering
 * `no_membership` with a sentence rather than a generic string.
 *
 * Three rules shape it.
 *
 *  * **Nothing here decides access.** `builder_accessible_organisations` is
 *    the only authority on that, and it has already said no by the time this
 *    is called. This explains an existing refusal; it can never create one,
 *    and it is never consulted on the allow path.
 *
 *  * **The most actionable true reason wins.** A builder may hold several
 *    memberships. One suspended organisation and one revoked membership is a
 *    different sentence from two revoked memberships, and the one the reader
 *    can act on — talk to the operator about the suspension — is the one to
 *    say. Order is by what the reader would do next, not by severity.
 *
 *  * **An unrecognised shape falls back to the generic answer.** A state this
 *    module cannot name must not become a confident wrong sentence, so the
 *    caller keeps the existing refusal. Saying nothing new is always safe;
 *    saying something untrue is not.
 */

/** One membership, joined to the organisation it belongs to. */
export interface MembershipRow {
  readonly status: string | null;
  readonly revoked_at: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly organisation_status: string | null;
  readonly organisation_legal_name: string | null;
}

export interface AccessDenialReading {
  /** A stable code for logs and tests. Never rendered to the builder. */
  readonly code:
    | "account_suspended"
    | "account_revoked"
    | "organisation_suspended"
    | "organisation_pending_activation"
    | "organisation_closed"
    | "membership_ended"
    | "no_membership"
    | "account_locked"
    | "unknown";
  /** What the builder reads. Empty only for `unknown`. */
  readonly message: string;
}

/** The refusal the login function already gives, kept for `unknown`. */
export const GENERIC_DENIAL: AccessDenialReading = {
  code: "unknown",
  message: "",
};

/** A membership is live when nothing about the membership ITSELF bars it. */
export function membershipIsLive(row: MembershipRow, now: Date): boolean {
  if (row.status !== "active") return false;
  if (row.revoked_at) return false;
  if (row.valid_from && new Date(row.valid_from) > now) return false;
  if (row.valid_until && new Date(row.valid_until) <= now) return false;
  return true;
}

function naming(name: string | null | undefined, fallback: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed : fallback;
}

/**
 * Explain the account's own state.
 *
 * Checked before the organisation, because a suspended account cannot reach
 * any organisation and naming the further door first would be a distraction.
 * `revoked` is deliberately final in tone and offers no self-service route:
 * it is an operator decision, and pointing the reader at a password reset —
 * which is what the generic answer did — wastes their time.
 */
export function readAccountState(account: {
  readonly status: string | null;
  readonly is_active: boolean | null;
  readonly revoked_at: string | null;
}): AccessDenialReading | null {
  if (account.revoked_at || account.status === "revoked") {
    return {
      code: "account_revoked",
      message:
        "Your sign-in is correct, but this account has been withdrawn. Contact an administrator " +
        "at your organisation if you believe that is a mistake.",
    };
  }
  if (account.status === "suspended") {
    return {
      code: "account_suspended",
      message:
        "Your sign-in is correct, but this account is suspended. Nothing is wrong with your " +
        "password. Contact an administrator at your organisation to have it lifted.",
    };
  }
  // Inactive with no reason recorded is a shape we cannot name; the caller
  // keeps its generic refusal.
  if (account.status !== "active" || !account.is_active) return GENERIC_DENIAL;
  return null;
}

/**
 * Explain a lockout.
 *
 * Separate from the organisation reasons because it is a fact about the
 * ACCOUNT and outranks them: an unlocked door behind a locked one is not the
 * thing to talk about first.
 */
export function readLockout(
  lockedUntil: string | null | undefined,
  now: Date,
): AccessDenialReading | null {
  if (!lockedUntil) return null;
  const until = new Date(lockedUntil);
  if (!Number.isFinite(until.getTime()) || until <= now) return null;
  const minutes = Math.max(
    1,
    Math.ceil((until.getTime() - now.getTime()) / 60_000),
  );
  return {
    code: "account_locked",
    message:
      `Too many failed sign-in attempts, so this account is locked for another ${minutes} ` +
      `minute${minutes === 1 ? "" : "s"}. Your password was correct — wait and try again, ` +
      `or reset it if you would rather not wait.`,
  };
}

/**
 * Explain why no organisation was accessible.
 *
 * Called ONLY after the password verified and only when the accessible list
 * came back empty.
 */
export function readAccessDenial(
  rows: readonly MembershipRow[],
  now: Date,
): AccessDenialReading {
  if (!rows.length) {
    return {
      code: "no_membership",
      message:
        "Your sign-in is correct, but this account does not belong to an organisation on the " +
        "network yet. Ask whoever invited you to add you to theirs.",
    };
  }

  const live = rows.filter((row) => membershipIsLive(row, now));

  // A live membership of a suspended organisation is the reported case, and
  // the only one where the remedy sits with the network operator.
  const suspended = live.find((row) => row.organisation_status === "suspended");
  if (suspended) {
    return {
      code: "organisation_suspended",
      message:
        `${naming(suspended.organisation_legal_name, "Your organisation")} has been suspended on the ` +
        `Builders Network, so its workspace cannot be opened. Your sign-in details are correct — ` +
        `nothing is wrong with your password. Contact the network operator to have the suspension reviewed.`,
    };
  }

  const pending = live.find(
    (row) => row.organisation_status === "pending_activation",
  );
  if (pending) {
    return {
      code: "organisation_pending_activation",
      message:
        `${naming(pending.organisation_legal_name, "Your organisation")} has not been approved on the ` +
        `Builders Network yet. Your sign-in details are correct; the workspace opens once the ` +
        `registration is approved.`,
    };
  }

  const closed = live.find((row) => row.organisation_status === "closed");
  if (closed) {
    return {
      code: "organisation_closed",
      message:
        `${naming(closed.organisation_legal_name, "Your organisation")} has been closed on the ` +
        `Builders Network. Your sign-in details are correct, but a closed organisation cannot be reopened.`,
    };
  }

  // Memberships exist and none is live: the membership ended rather than the
  // organisation failing. Deliberately does not say which organisation — a
  // membership somebody removed is their record to explain, not ours.
  if (!live.length) {
    return {
      code: "membership_ended",
      message:
        "Your sign-in is correct, but your access to this organisation has been withdrawn or has " +
        "expired. Ask an administrator there to restore it.",
    };
  }

  // A live membership of an organisation we cannot classify. Say nothing new.
  return GENERIC_DENIAL;
}
