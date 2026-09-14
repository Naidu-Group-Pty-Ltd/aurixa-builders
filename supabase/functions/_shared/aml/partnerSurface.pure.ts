/**
 * What a partner's compliance page shows, and why.
 *
 * ── The problem this exists for ────────────────────────────────────────
 * A partner who already holds a portal account should be able to open the
 * Compliance Passport inside their own portal, on their own AML/CTF
 * Compliance page, rather than only from an emailed one-time link. The
 * emailed link is a delivery; a portal is a place you go back to.
 *
 * The shared workspace that would host it already carries eight panels —
 * records requests, an independent determination form, evidence deliveries,
 * an audit receipt, a clarification channel — and those panels are chosen by
 * a static per-portal adapter, not by a flag. So enabling the workspace in
 * order to show a Passport would light every one of them at once, on a
 * deployment where their write flags are separately off and several would
 * render and then refuse.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 * Turning the Passport on NARROWS the surface. That is deliberate and it is
 * the whole safety property: an operator who enables
 * `aml_partner_passport_view` gets exactly the document and the statutory
 * notice around it, and nothing they have not reviewed. The full workspace
 * is a second, later switch.
 *
 *   passport | full  | mode           | what changed
 *   ---------|-------|----------------|--------------------------------
 *   off      | off   | full           | today, byte for byte
 *   ON       | off   | passport_only  | the Passport, and only that
 *   ON       | ON    | full           | everything, Passport included
 *   off      | ON    | full           | today
 *
 * The `off/off → full` row is the one that matters for safety: this module
 * must be inert on a deployment that has already enabled the workspace, so
 * `passport_only` is never reachable by omission.
 *
 * Three rules carry it.
 *
 * **A mode narrows; it never widens.** `passport_only` can only ever hide
 * panels the adapter already permits. Nothing here can show a partner a
 * panel their portal's adapter withheld — the adapter stays the ceiling.
 *
 * **The Passport is a disclosure, not a decoration.** Whether the document
 * may be shown is decided by the grant and the attestation, never by the
 * mode: an expired grant, a revoked one, a superseded attestation or one
 * flagged for refresh all withhold it, exactly as the token path does. The
 * mode decides what the PAGE is; entitlement decides whether the document is
 * on it.
 *
 * **A page with nothing on it must say so.** `passport_only` with no
 * disclosable Passport is a real state — the partner is enrolled, the matter
 * is linked, and the record is not currently disclosable — and it is
 * reported rather than rendered as an empty page.
 */

export type PartnerSurfaceMode = "passport_only" | "full";

export interface PartnerSurfaceFlags {
  /** `aml_partner_passport_view` — the Passport document in the portal. */
  passportViewEnabled: boolean;
  /** `aml_partner_workspace_full` — the eight-panel Phase 4 workspace. */
  fullWorkspaceEnabled: boolean;
}

export function partnerSurfaceMode(flags: PartnerSurfaceFlags): PartnerSurfaceMode {
  return flags.passportViewEnabled && !flags.fullWorkspaceEnabled
    ? "passport_only"
    : "full";
}

/* ── whether the DOCUMENT may be disclosed ───────────────────────────────
   The same question `redeem_attestation` answers before it serves a
   Passport, asked in one place so the portal and the link cannot diverge.
   Every input is a fact the server already holds; nothing here is a policy
   of its own. */

export interface PassportDisclosureFacts {
  grant: { revoked_at: string | null; expires_at: string } | null;
  attestation: {
    superseded_at?: string | null;
    refresh_required_at?: string | null;
  } | null;
  now?: Date;
}

export type PassportDisclosureCode =
  | "disclosable"
  /** No grant has ever been issued to this organisation on this matter. */
  | "not_shared"
  | "revoked"
  | "expired"
  | "superseded"
  | "refresh_required"
  /** A grant exists and no attestation does — nothing to draw. */
  | "no_attestation";

export interface PassportDisclosure {
  disclosable: boolean;
  code: PassportDisclosureCode;
  /** Partner-safe, and never a reason internal to the issuer. */
  message: string;
}

export function passportDisclosure(facts: PassportDisclosureFacts): PassportDisclosure {
  const now = (facts.now ?? new Date()).getTime();
  if (!facts.grant) {
    return {
      disclosable: false, code: "not_shared",
      message: "The issuing organisation has not shared a Compliance Passport for this matter.",
    };
  }
  if (facts.grant.revoked_at) {
    return {
      disclosable: false, code: "revoked",
      message: "Access to this Compliance Passport has been withdrawn by the issuing organisation.",
    };
  }
  if (new Date(facts.grant.expires_at).getTime() <= now) {
    return {
      disclosable: false, code: "expired",
      message: "Access to this Compliance Passport has expired. Ask the issuing organisation to issue it again.",
    };
  }
  if (!facts.attestation) {
    return {
      disclosable: false, code: "no_attestation",
      message: "No attestation is available for this matter yet.",
    };
  }
  if (facts.attestation.superseded_at) {
    return {
      disclosable: false, code: "superseded",
      message: "This Compliance Passport has been superseded by a newer version. The issuing organisation must share the current one.",
    };
  }
  if (facts.attestation.refresh_required_at) {
    return {
      disclosable: false, code: "refresh_required",
      message: "A material change was recorded and this Compliance Passport is being refreshed. It is unavailable until the issuing organisation reissues it.",
    };
  }
  return { disclosable: true, code: "disclosable", message: "" };
}

/* ── which panels the page draws ─────────────────────────────────────────
   The adapter is the CEILING and this is a mask over it, so a portal that
   never permitted a panel cannot acquire one by changing mode. */

export interface PartnerAdapterPanels {
  procedures?: boolean;
  determination?: boolean;
  recordsRequests?: boolean;
  deliveries?: boolean;
  auditReceipt?: boolean;
  clarification?: boolean;
}

export interface PartnerPanelVisibility {
  passport: boolean;
  /** The credential header — version, hash, legal route. Always shown. */
  passportStrip: boolean;
  summary: boolean;
  tasks: boolean;
  procedures: boolean;
  determination: boolean;
  recordsRequests: boolean;
  deliveries: boolean;
  auditReceipt: boolean;
  clarification: boolean;
  /** A way to ask a question is never withheld. */
  support: boolean;
}

export function partnerWorkspacePanels(
  mode: PartnerSurfaceMode,
  adapter: PartnerAdapterPanels,
): PartnerPanelVisibility {
  const full = mode === "full";
  return {
    passport: true,
    passportStrip: true,
    summary: full,
    tasks: full,
    /* Every one of these is `full && adapter`, never `full || adapter`:
       the mode can only ever subtract from what the portal already allowed. */
    procedures: full && Boolean(adapter.procedures),
    determination: full && Boolean(adapter.determination),
    recordsRequests: full && Boolean(adapter.recordsRequests),
    deliveries: full && Boolean(adapter.deliveries),
    auditReceipt: full && Boolean(adapter.auditReceipt),
    clarification: full && Boolean(adapter.clarification),
    support: true,
  };
}
