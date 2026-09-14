/**
 * Reliance eligibility — the single server-side guard for every NEW
 * partner-reliance access path (AML/CTF Act 2006 (Cth) Pt 2 Div 7).
 *
 * Pure module by design: no Deno APIs, no network, no database client. The
 * edge function loads the rows; this module decides. That keeps the legal
 * gating behaviourally testable from vitest (same pattern as
 * `_shared/amlFinanceEngine.ts`) and guarantees the decision cannot vary by
 * call site.
 *
 * Phase 1 evaluates the canonical-partner and case-link layer.
 * Phase 2 adds the arrangement layer (agreement + assessment currency +
 * scope) on top — same entry point, richer input.
 *
 * Two invariants this module owns:
 *  - a denial NEVER carries restricted reasoning. Reason codes are
 *    partner-safe constants; messages are operator-facing.
 *  - independence is never blocked here: when reliance is unavailable the
 *    caller falls back to independent_cdd / information sharing. This guard
 *    gates RELIANCE access only, and never touches the originating case,
 *    risk assessment or service gate.
 */

export const LEGAL_ROUTES = [
  "reliance",
  "outsourced_cdd",
  "independent_cdd",
  "information_share_only",
] as const;
export type LegalRoute = (typeof LEGAL_ROUTES)[number];

export const PARTNER_LINK_STATES = ["active", "suspended", "ended"] as const;
export type PartnerLinkState = (typeof PARTNER_LINK_STATES)[number];

export type RelianceDenialCode =
  | "partner_org_unresolved"
  | "partner_org_not_active"
  | "partner_link_missing"
  | "partner_link_not_active"
  | "partner_link_wrong_route"
  | "partner_link_wrong_case"
  | "partner_link_wrong_tenant"
  // Phase 2 — arrangement layer
  | "agreement_missing"
  | "agreement_inactive"
  | "agreement_not_yet_effective"
  | "agreement_expired"
  | "review_overdue"
  | "eligibility_not_recorded"
  | "eligibility_not_eligible"
  | "scope_not_recorded"
  | "scope_procedure_not_covered"
  | "scope_customer_type_not_covered"
  | "assessment_missing"
  | "assessment_overdue"
  | "assessment_unsuitable";

export interface PartnerOrganisationInput {
  id: string;
  status: string; // active | suspended | ended
}

export interface PartnerCaseLinkInput {
  id: string;
  case_id: string;
  tenant_id: string;
  partner_org_id: string;
  legal_route: string;
  state: string;
}

export interface RelianceLinkContext {
  caseId: string;
  caseTenantId: string;
  /** Canonical org resolved from the agreement — null when unresolved. */
  partnerOrg: PartnerOrganisationInput | null;
  /** The candidate link rows for this case × organisation (any state). */
  links: PartnerCaseLinkInput[];
}

export type RelianceDecision =
  | { ok: true; link: PartnerCaseLinkInput }
  | { ok: false; code: RelianceDenialCode; message: string };

/**
 * Phase 1 layer: is there a canonical partner organisation in good standing
 * with an ACTIVE partner-case link, for THIS case, in THIS tenant, whose
 * legal route is reliance?
 *
 * Deny-by-default: any absent, mismatched, suspended or ended input denies.
 * A caller-supplied organisation id is never part of this contract — the
 * organisation arrives resolved from the stored agreement row, and links
 * arrive pre-filtered by the server from the database, never from the
 * request body.
 */
export function evaluatePartnerLinkForReliance(
  ctx: RelianceLinkContext,
): RelianceDecision {
  if (!ctx.partnerOrg || !ctx.partnerOrg.id) {
    return {
      ok: false,
      code: "partner_org_unresolved",
      message:
        "This agreement is not mapped to a canonical partner organisation. Resolve the partner mapping before granting new reliance access.",
    };
  }
  if (ctx.partnerOrg.status !== "active") {
    return {
      ok: false,
      code: "partner_org_not_active",
      message: `The partner organisation is ${ctx.partnerOrg.status}. Reinstate it before granting new reliance access.`,
    };
  }

  const candidates = (ctx.links ?? []).filter(
    (l) => l.partner_org_id === ctx.partnerOrg!.id,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "partner_link_missing",
      message:
        "No partner-case link exists for this organisation on this case. Link the partner (with a documented purpose and legal route) before granting access.",
    };
  }

  // Wrong-case / wrong-tenant links can only reach this function through a
  // query bug — deny loudly rather than silently filtering them out.
  const wrongCase = candidates.find((l) => l.case_id !== ctx.caseId);
  if (wrongCase) {
    return {
      ok: false,
      code: "partner_link_wrong_case",
      message: "A supplied link belongs to a different case. Refusing.",
    };
  }
  const wrongTenant = candidates.find((l) => l.tenant_id !== ctx.caseTenantId);
  if (wrongTenant) {
    return {
      ok: false,
      code: "partner_link_wrong_tenant",
      message: "A supplied link belongs to a different tenant. Refusing.",
    };
  }

  const relianceLinks = candidates.filter((l) => l.legal_route === "reliance");
  if (relianceLinks.length === 0) {
    return {
      ok: false,
      code: "partner_link_wrong_route",
      message:
        "The partner is linked to this case, but not under the reliance route. Reliance is never inferred from another route — use the partner's actual route, or record a reliance link where legally available.",
    };
  }

  const active = relianceLinks.find((l) => l.state === "active");
  if (!active) {
    return {
      ok: false,
      code: "partner_link_not_active",
      message:
        "The reliance link for this partner is suspended or ended. Only an active link can carry new reliance access.",
    };
  }

  return { ok: true, link: active };
}

/* ── Phase 2: arrangement governance layer ─────────────────────────────── */

export interface ArrangementInput {
  id: string;
  status: string; // active | suspended | terminated
  next_review_due: string; // YYYY-MM-DD
  /** Recorded configuration value, never a system inference. */
  eligibility_classification: string;
  scope_procedures: string[] | null;
  scope_customer_types: string[] | null;
  effective_from: string | null;
  expires_on: string | null;
  partner_org_id: string | null;
}

export interface ArrangementAssessmentInput {
  decision: string; // suitable | suitable_with_conditions | unsuitable
  next_due_at: string; // YYYY-MM-DD
  status: string; // operative | superseded
}

export type ArrangementDecision =
  | { ok: true }
  | { ok: false; code: RelianceDenialCode; message: string };

/**
 * Phase 2 layer: is the WRITTEN arrangement itself capable of carrying new
 * reliance right now?
 *
 * Deny-by-default across every dimension: an unassessed eligibility, a
 * missing or overdue or unsuitable assessment, an out-of-force agreement,
 * or an uncovered procedure all deny. Customer-type scope is checked only
 * when it was recorded (an empty/unrecorded customer-type scope means the
 * arrangement does not restrict by type); procedure scope must be recorded
 * explicitly — procedures are WHAT the arrangement covers, so their absence
 * is an incomplete arrangement, not an unrestricted one.
 *
 * None of this ever gates independent_cdd, outsourced_cdd or information
 * sharing, and none of it reads or writes the originating case, risk
 * assessment or service gate. `now` is a parameter so the decision is
 * deterministic and testable.
 */
export function evaluateArrangementForReliance(ctx: {
  arrangement: ArrangementInput | null;
  assessment: ArrangementAssessmentInput | null;
  requiredProcedure: string;
  caseCustomerType?: string | null;
  now: Date;
}): ArrangementDecision {
  const a = ctx.arrangement;
  const nowMs = ctx.now.getTime();
  if (!a) {
    return {
      ok: false, code: "agreement_missing",
      message: "No written CDD arrangement exists for this partner. s 37A reliance is unavailable without one.",
    };
  }
  if (a.status !== "active") {
    return {
      ok: false, code: "agreement_inactive",
      message: `The arrangement is ${a.status}. Only an active arrangement can carry new reliance access.`,
    };
  }
  if (a.effective_from && new Date(a.effective_from).getTime() > nowMs) {
    return {
      ok: false, code: "agreement_not_yet_effective",
      message: "The arrangement is not yet in effect.",
    };
  }
  if (a.expires_on && new Date(a.expires_on).getTime() < nowMs) {
    return {
      ok: false, code: "agreement_expired",
      message: "The arrangement has expired. Re-execute or extend it before new reliance access.",
    };
  }
  if (new Date(a.next_review_due).getTime() < nowMs) {
    return {
      ok: false, code: "review_overdue",
      message: "This CDD arrangement's review is overdue. Review the agreement before issuing new grants.",
    };
  }
  if (a.eligibility_classification === "not_eligible") {
    return {
      ok: false, code: "eligibility_not_eligible",
      message: "The recorded eligibility determination for this arrangement is 'not eligible'. Use the independent CDD route.",
    };
  }
  if (a.eligibility_classification !== "eligible_reporting_entity"
    && a.eligibility_classification !== "eligible_foreign_equivalent") {
    return {
      ok: false, code: "eligibility_not_recorded",
      message: "No eligibility classification has been recorded for this arrangement. Record the legal determination before new reliance access — until then the independent CDD route remains available.",
    };
  }
  if (!a.scope_procedures || a.scope_procedures.length === 0) {
    return {
      ok: false, code: "scope_not_recorded",
      message: "The arrangement's procedure scope has not been recorded. Record which procedures it covers before new reliance access.",
    };
  }
  if (!a.scope_procedures.includes(ctx.requiredProcedure)) {
    return {
      ok: false, code: "scope_procedure_not_covered",
      message: `The arrangement does not cover the "${ctx.requiredProcedure}" procedure. Amend the arrangement or use the independent CDD route.`,
    };
  }
  if (
    ctx.caseCustomerType &&
    a.scope_customer_types && a.scope_customer_types.length > 0 &&
    !a.scope_customer_types.includes(ctx.caseCustomerType)
  ) {
    return {
      ok: false, code: "scope_customer_type_not_covered",
      message: "The arrangement does not cover this customer type. Amend the arrangement or use the independent CDD route.",
    };
  }
  const s = ctx.assessment;
  if (!s || s.status !== "operative") {
    return {
      ok: false, code: "assessment_missing",
      message: "No operative arrangement assessment exists. s 37A requires the arrangement to be regularly reviewed — record an assessment before new reliance access.",
    };
  }
  if (s.decision === "unsuitable") {
    return {
      ok: false, code: "assessment_unsuitable",
      message: "The operative assessment found the arrangement unsuitable. New reliance access is blocked; the independent CDD route remains available.",
    };
  }
  if (new Date(s.next_due_at).getTime() < nowMs) {
    return {
      ok: false, code: "assessment_overdue",
      message: "The arrangement assessment is overdue. Re-assess the arrangement before new reliance access.",
    };
  }
  return { ok: true };
}
