/**
 * Passport distribution readiness — the one server-side answer to "may this
 * Passport go to this partner, by this legal route, right now?"
 *
 * ## What this module is NOT
 *
 * It is not a second reliance engine. `relianceEligibility.ts` already owns
 * the canonical-partner/case-link layer and the written-arrangement layer, and
 * `grant_access` already owns creating a grant and its manifest. This module
 * **composes** those decisions and adds the layers distribution needs that
 * neither of them covers — Passport currency, portal membership, evidence
 * classification and the idempotency state of an existing grant — into one
 * structured result per partner.
 *
 * Re-deriving what those modules decide would be the drift this programme
 * keeps paying for, so their outcomes arrive here as inputs and are never
 * recomputed.
 *
 * ## Two rules the whole module rests on
 *
 * **UNKNOWN IS DENY.** Every blocker is affirmative evidence that a condition
 * is met; absence of evidence is never treated as satisfaction. A route with
 * no recorded classification, an arrangement nobody assessed, an attestation
 * nobody issued — each denies. There is no "probably fine" branch.
 *
 * **A LEGAL ROUTE IS READ, NEVER INFERRED.** Finance is not reliance.
 * Solicitor is not reliance. Builder is not reliance. The route is whatever
 * the partner-case link records, and this module evaluates the prerequisites
 * *of that route* — it never promotes a partner into s 37A because the portal
 * type looked financial, and never quietly demotes one to information sharing
 * because reliance was unavailable. An unavailable reliance route reports
 * blockers; it does not silently become something else.
 *
 * Pure by construction: no Deno APIs, no network, no database client. The edge
 * function loads rows; this decides. `now` is a parameter so every decision is
 * deterministic and testable.
 */

import {
  evaluateArrangementForReliance,
  evaluatePartnerLinkForReliance,
  type ArrangementAssessmentInput,
  type ArrangementInput,
  type LegalRoute,
  type PartnerCaseLinkInput,
  type PartnerOrganisationInput,
  type RelianceDenialCode,
} from "../relianceEligibility.ts";

/* ── blocking conditions ─────────────────────────────────────────────────
   Partner-safe constants. A code never carries reasoning, a reviewer's note,
   a risk figure or anything else the partner may not see — the operator-facing
   sentence lives beside it and is written for the Command Centre. */

export const DISTRIBUTION_BLOCKERS = [
  "PASSPORT_NOT_ISSUED",
  "PASSPORT_REFRESH_REQUIRED",
  "PASSPORT_SUSPENDED",
  "PASSPORT_SUPERSEDED",
  "PARTNER_LINK_REQUIRED",
  "PARTNER_CLASSIFICATION_REQUIRED",
  "PORTAL_MEMBERSHIP_REQUIRED",
  "CLIENT_SHARING_CONSENT_REQUIRED",
  "CDD_ARRANGEMENT_REQUIRED",
  "ARRANGEMENT_ASSESSMENT_REQUIRED",
  "ARRANGEMENT_REVIEW_OVERDUE",
  "DISCLOSURE_CONFIGURATION_REQUIRED",
  "EVIDENCE_AVAILABILITY_INCOMPLETE",
  "LEGAL_ROUTE_NOT_RECORDED",
  "DISTRIBUTION_NOT_ENABLED",
] as const;
export type DistributionBlocker = (typeof DISTRIBUTION_BLOCKERS)[number];

/** Where a repeated distribution stands. Bulk callers switch on this. */
export const DISTRIBUTION_STATES = [
  "READY",
  "ALREADY_CURRENT",
  "NEW_VERSION_AVAILABLE",
  "GRANT_EXPIRED",
  "GRANT_REVOKED",
  "REFRESH_REQUIRED",
  "ACTION_REQUIRED",
] as const;
export type DistributionState = (typeof DISTRIBUTION_STATES)[number];

/* ── evidence classification ─────────────────────────────────────────────
   What the ORIGIN can authorise, derived from records that exist. A class is
   never reported available because it is usually available; it is reported
   available because a canonical row supports it. Nothing here names a
   document, a path or a byte — this is a classification, and retrieval stays
   with the existing controlled-access mechanism. */

export const EVIDENCE_CLASSES = [
  "IDENTITY_KYC_AVAILABLE",
  "VERIFICATION_DATA_AVAILABLE",
  "ADDRESS_EVIDENCE_AVAILABLE",
  "ENTITY_EVIDENCE_AVAILABLE",
  "OWNERSHIP_EVIDENCE_AVAILABLE",
  "AUTHORITY_EVIDENCE_AVAILABLE",
  "TRANSACTION_EVIDENCE_AVAILABLE",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * Classes that may NEVER be authorised for distribution, whatever a caller
 * asks for and whatever a record contains.
 *
 * This is the §11 exclusion list expressed as data so it can be asserted. It
 * is deliberately a deny-list ON TOP of an allow-list: `EVIDENCE_CLASSES` is
 * the only vocabulary that can be produced, so a restricted class cannot be
 * emitted in the first place — this exists so that a future edit which widens
 * the allow-list still fails a test rather than shipping.
 */
export const NEVER_DISCLOSABLE = [
  "smr", "suspicious_matter", "suspicion", "mlro_investigation",
  "analyst_reasoning", "reviewer_note", "risk_score", "risk_methodology",
  "sanctions_candidate", "dismissed_match", "law_enforcement", "austrac",
  "provider_secret", "provider_payload", "biometric", "liveness_score",
  "face_match_score",
] as const;

export type EvidenceReadiness = {
  available: EvidenceClass[];
  /** Classes the arrangement's scope permits but no record supports yet. */
  unavailable: EvidenceClass[];
  /**
   * Whether the partner can reach the available classes now, or must ask.
   * `request_required` is not a failure — it is the existing records-request
   * path, and saying so is better than inventing a request from the origin.
   */
  delivery: "available_now" | "request_required" | "none";
};

/* ── inputs ──────────────────────────────────────────────────────────────
   Every field is a ROW the edge function read. Nothing is caller-asserted:
   there is deliberately no `partner_is_eligible`, `section_37a`,
   `agreement_current` or `passport_current` input, because a body that could
   state those would be the authority instead of the database. */

export type PassportCurrency = {
  /** The current, non-superseded attestation — null when none exists. */
  attestation: {
    id: string;
    version: number;
    payload_sha256: string;
    issued_at: string | null;
    superseded_at: string | null;
    schema_version: number | null;
  } | null;
  /** Derived Passport state code from `passportState.pure.ts`. */
  stateCode: string;
  /** Open refresh obligations against this case. */
  openRefreshObligations: number;
  /** Canonical service gate on the case. */
  serviceGateStatus: string | null;
};

export type MembershipInput = {
  id: string;
  partner_org_id: string;
  portal_type: string;
  portal_user_source: string | null;
  portal_user_id: string | null;
  status: string;
};

export type ExistingGrantInput = {
  id: string;
  attestation_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  refresh_required_at: string | null;
  partner_org_id: string | null;
};

export type EvidenceFacts = {
  /** Accepted identity/KYC documents exist. */
  identityDocumentsAccepted: number;
  /** A passed verification check exists. */
  verificationPassed: number;
  addressEvidenceAccepted: number;
  entityEvidenceAccepted: number;
  ownershipRecords: number;
  authorityRecords: number;
  transactionRecords: number;
  /** Deliveries already made to this partner for this case. */
  deliveriesToPartner: number;
};

export type DistributionCandidate = {
  partnerOrgId: string | null;
  partnerOrgName: string | null;
  portalType: string | null;
  /** The route RECORDED on the link. Never inferred from portalType. */
  legalRoute: string | null;
  relationshipRole: string | null;
  purpose: string | null;
  partnerOrg: PartnerOrganisationInput | null;
  /** Classification recorded on the organisation. */
  classificationStatus: string | null;
  links: PartnerCaseLinkInput[];
  membership: MembershipInput | null;
  arrangement: ArrangementInput | null;
  assessment: ArrangementAssessmentInput | null;
  existingGrant: ExistingGrantInput | null;
  /** A manifest already exists for the current attestation + grant. */
  manifestPresent: boolean;
  evidence: EvidenceFacts;
};

export type DistributionContext = {
  caseId: string;
  caseTenantId: string;
  caseSubjectType: string | null;
  /** Compliance-sharing consent row id, or null when the client has not given it. */
  sharingConsentId: string | null;
  passport: PassportCurrency;
  /** Server-read feature flag. Off = nothing is distributable. */
  distributionEnabled: boolean;
  now: Date;
};

export type DistributionReadiness = {
  partner: {
    org_id: string | null;
    org_name: string | null;
    portal_type: string | null;
    relationship_role: string | null;
    purpose: string | null;
    classification_status: string | null;
  };
  legal_route: LegalRoute | null;
  passport: {
    attestation_id: string | null;
    version: number | null;
    payload_sha256: string | null;
    issued_at: string | null;
    state_code: string;
  };
  state: DistributionState;
  ready: boolean;
  blockers: DistributionBlocker[];
  /** Operator-facing sentences, index-aligned with `blockers`. */
  messages: string[];
  /** The reliance-layer code when the reliance route was evaluated. */
  reliance_code: RelianceDenialCode | null;
  evidence: EvidenceReadiness;
  next_actions: string[];
};

const MESSAGES: Record<DistributionBlocker, string> = {
  PASSPORT_NOT_ISSUED:
    "No current Compliance Passport has been issued for this case. Issue the attestation before distributing.",
  PASSPORT_REFRESH_REQUIRED:
    "This Passport is marked refresh-required. Complete the refresh before distributing it further.",
  PASSPORT_SUSPENDED:
    "The Passport is suspended or the service gate is closed. Distribution is blocked while that stands.",
  PASSPORT_SUPERSEDED:
    "The attestation supplied has been superseded. Distribute the current version.",
  PARTNER_LINK_REQUIRED:
    "No active partner-case link exists for this organisation on this case. Link the partner, with a recorded purpose and legal route, first.",
  PARTNER_CLASSIFICATION_REQUIRED:
    "The partner organisation has no completed classification. Classify it before it can carry reliance.",
  PORTAL_MEMBERSHIP_REQUIRED:
    "No active portal membership resolves this organisation to a portal user. Invite or reinstate the partner's portal access.",
  CLIENT_SHARING_CONSENT_REQUIRED:
    "The client has not consented to sharing their completed verification. Ask them to accept the sharing consent in their portal.",
  CDD_ARRANGEMENT_REQUIRED:
    "No written CDD arrangement is in force for this partner. s 37A reliance is unavailable without one.",
  ARRANGEMENT_ASSESSMENT_REQUIRED:
    "No operative arrangement assessment exists, or it is unsuitable. Record an assessment before new reliance.",
  ARRANGEMENT_REVIEW_OVERDUE:
    "The arrangement's review or assessment is overdue. Review it before new reliance access.",
  DISCLOSURE_CONFIGURATION_REQUIRED:
    "No disclosure configuration exists for this attestation and partner. It will be generated through the canonical flow on distribution.",
  EVIDENCE_AVAILABILITY_INCOMPLETE:
    "No authorised evidence class is available for this partner yet, so distribution would carry the Passport alone.",
  LEGAL_ROUTE_NOT_RECORDED:
    "The partner-case link records no legal route. A route is read, never inferred — record it before distributing.",
  DISTRIBUTION_NOT_ENABLED:
    "Passport partner distribution is not enabled in this environment.",
};

/** Routes that require the full s 37A arrangement stack. */
const RELIANCE_ROUTES = new Set<string>(["reliance", "outsourced_cdd"]);

function isLegalRoute(v: string | null): v is LegalRoute {
  return v === "reliance" || v === "outsourced_cdd" ||
    v === "independent_cdd" || v === "information_share_only";
}

/**
 * Classify what the origin can authorise for this partner.
 *
 * Only classes a canonical record supports are reported. A procedure is never
 * represented as performed because it usually is — `ownershipRecords === 0`
 * means no ownership evidence, not "probably an individual so it's fine".
 */
export function classifyEvidence(facts: EvidenceFacts): EvidenceReadiness {
  const available: EvidenceClass[] = [];
  const unavailable: EvidenceClass[] = [];
  const push = (cls: EvidenceClass, supported: boolean) =>
    (supported ? available : unavailable).push(cls);

  push("IDENTITY_KYC_AVAILABLE", facts.identityDocumentsAccepted > 0);
  push("VERIFICATION_DATA_AVAILABLE", facts.verificationPassed > 0);
  push("ADDRESS_EVIDENCE_AVAILABLE", facts.addressEvidenceAccepted > 0);
  push("ENTITY_EVIDENCE_AVAILABLE", facts.entityEvidenceAccepted > 0);
  push("OWNERSHIP_EVIDENCE_AVAILABLE", facts.ownershipRecords > 0);
  push("AUTHORITY_EVIDENCE_AVAILABLE", facts.authorityRecords > 0);
  push("TRANSACTION_EVIDENCE_AVAILABLE", facts.transactionRecords > 0);

  return {
    available,
    unavailable,
    delivery: available.length === 0
      ? "none"
      : facts.deliveriesToPartner > 0
        ? "available_now"
        : "request_required",
  };
}

/**
 * Where a repeated distribution stands against the current attestation.
 *
 * Distribution is idempotent, so this is what makes a second call a no-op
 * rather than a duplicate grant. It compares the grant's PINNED attestation
 * against the current one — a grant is `ALREADY_CURRENT` only when it points
 * at exactly the attestation being distributed.
 */
export function distributionStateFor(
  grant: ExistingGrantInput | null,
  currentAttestationId: string | null,
  now: Date,
): DistributionState {
  if (!grant) return "READY";
  if (grant.revoked_at) return "GRANT_REVOKED";
  if (grant.refresh_required_at) return "REFRESH_REQUIRED";
  if (grant.expires_at && new Date(grant.expires_at).getTime() < now.getTime()) {
    return "GRANT_EXPIRED";
  }
  if (currentAttestationId && grant.attestation_id !== currentAttestationId) {
    return "NEW_VERSION_AVAILABLE";
  }
  return "ALREADY_CURRENT";
}

/**
 * Evaluate one proposed distribution.
 *
 * Fails closed on every axis. The reliance stack is evaluated ONLY for a
 * reliance route: an `independent_cdd` partner is not blocked because it has
 * no CDD arrangement — it never needed one — and an `information_share_only`
 * partner is never reported as carrying statutory reliance.
 */
export function evaluateDistribution(
  ctx: DistributionContext,
  candidate: DistributionCandidate,
): DistributionReadiness {
  const blockers: DistributionBlocker[] = [];
  const add = (b: DistributionBlocker) => {
    if (!blockers.includes(b)) blockers.push(b);
  };

  const att = ctx.passport.attestation;
  const route = isLegalRoute(candidate.legalRoute) ? candidate.legalRoute : null;
  let relianceCode: RelianceDenialCode | null = null;

  if (!ctx.distributionEnabled) add("DISTRIBUTION_NOT_ENABLED");

  /* A — the Passport itself. Applies to EVERY route: no route distributes a
     Passport that does not currently exist. */
  if (!att || !att.issued_at) {
    add("PASSPORT_NOT_ISSUED");
  } else if (att.superseded_at) {
    add("PASSPORT_SUPERSEDED");
  }
  if (ctx.passport.openRefreshObligations > 0) add("PASSPORT_REFRESH_REQUIRED");
  if (
    ctx.passport.stateCode === "suspended" ||
    ctx.passport.stateCode === "revoked" ||
    ctx.passport.serviceGateStatus === "terminated" ||
    ctx.passport.serviceGateStatus === "locked"
  ) {
    add("PASSPORT_SUSPENDED");
  }

  /* B — the route must be recorded before anything is evaluated against it. */
  if (!route) add("LEGAL_ROUTE_NOT_RECORDED");

  /* C — client authority. Required for any disclosure, on any route. */
  if (!ctx.sharingConsentId) add("CLIENT_SHARING_CONSENT_REQUIRED");

  /* D — portal membership. A link says the partner is on the matter; a
     membership is what lets an authenticated portal session resolve to them.
     Neither alone discloses anything. */
  const m = candidate.membership;
  if (
    !m || m.status !== "active" || !m.portal_user_id ||
    (candidate.partnerOrgId != null && m.partner_org_id !== candidate.partnerOrgId)
  ) {
    add("PORTAL_MEMBERSHIP_REQUIRED");
  }

  /* E — the canonical partner + case link, decided by the existing engine. */
  const linkDecision = evaluatePartnerLinkForReliance({
    caseId: ctx.caseId,
    caseTenantId: ctx.caseTenantId,
    partnerOrg: candidate.partnerOrg,
    links: candidate.links,
  });

  if (route && RELIANCE_ROUTES.has(route)) {
    if (!linkDecision.ok) {
      relianceCode = (linkDecision as { code?: RelianceDenialCode | null }).code ?? relianceCode;
      add("PARTNER_LINK_REQUIRED");
    }
    // Classification is a s 37A prerequisite and is never inferred.
    if (candidate.classificationStatus !== "completed") {
      add("PARTNER_CLASSIFICATION_REQUIRED");
    }
    /* The arrangement must belong to THIS partner. The edge function selects
       it by `partner_org_id`, so in production the binding always holds — but
       an engine that cannot see a mismatch is one refactor away from granting
       reliance on somebody else's written arrangement, which is the single
       worst outcome this module can produce.

       A mismatch is unambiguous and denies. A null is NOT treated as a
       mismatch: legacy agreement rows predate the column, and failing them
       here would revoke reliance that is lawfully in force today for a fact
       the caller's own query already guarantees. */
    if (
      candidate.arrangement?.partner_org_id &&
      candidate.arrangement.partner_org_id !== candidate.partnerOrgId
    ) {
      relianceCode = relianceCode ?? "agreement_missing";
      add("CDD_ARRANGEMENT_REQUIRED");
    }

    const arrangementDecision = evaluateArrangementForReliance({
      arrangement: candidate.arrangement,
      assessment: candidate.assessment,
      requiredProcedure: "customer_identification",
      caseCustomerType: ctx.caseSubjectType,
      now: ctx.now,
    });
    if (!arrangementDecision.ok) {
      // The DECLARED union, not `typeof relianceCode`. By this line control flow
      // has narrowed the variable to `"agreement_missing" | null` (the assignment
      // above), so `typeof` collapsed the cast to that one literal and every other
      // case below became "not comparable" — six type errors, and a switch the
      // compiler could no longer check for exhaustiveness on the reliance-denial
      // codes. Type-only: the runtime value is whatever the decision returned.
      const arrangementCode = (arrangementDecision as { code?: RelianceDenialCode | null }).code;
      // `?? null` because the cast's `code?:` is optional, so the expression is
      // `… | undefined` while the variable is `… | null`. Behaviour-identical —
      // `??` already treats undefined as absent.
      relianceCode = relianceCode ?? arrangementCode ?? null;
      switch (arrangementCode) {
        case "review_overdue":
        case "assessment_overdue":
          add("ARRANGEMENT_REVIEW_OVERDUE");
          break;
        case "assessment_missing":
        case "assessment_unsuitable":
          add("ARRANGEMENT_ASSESSMENT_REQUIRED");
          break;
        default:
          add("CDD_ARRANGEMENT_REQUIRED");
      }
    }
  } else if (route) {
    // Non-reliance routes still need an active link for THIS case — the link
    // is what scopes the disclosure — but never an arrangement or a
    // classification, because they do not carry statutory reliance.
    const active = candidate.links.find(
      (l) => l.case_id === ctx.caseId && l.state === "active" &&
        l.partner_org_id === candidate.partnerOrgId,
    );
    if (!active) add("PARTNER_LINK_REQUIRED");
  }

  /* F — evidence. Absence is reported, never fabricated. */
  const evidence = classifyEvidence(candidate.evidence);
  if (evidence.available.length === 0) add("EVIDENCE_AVAILABILITY_INCOMPLETE");

  /* G — disclosure configuration. Absent is a next action rather than a hard
     stop: the canonical flow generates it as part of distribution. It is
     reported so an operator can see what will be created. */
  if (!candidate.manifestPresent) add("DISCLOSURE_CONFIGURATION_REQUIRED");

  const hardBlockers = blockers.filter(
    (b) => b !== "DISCLOSURE_CONFIGURATION_REQUIRED" &&
      b !== "EVIDENCE_AVAILABILITY_INCOMPLETE",
  );
  const ready = hardBlockers.length === 0;

  const state: DistributionState = ready
    ? distributionStateFor(candidate.existingGrant, att?.id ?? null, ctx.now)
    : "ACTION_REQUIRED";

  const next_actions: string[] = [];
  if (ready && state === "READY") next_actions.push("share_passport_to_partner");
  if (ready && state === "NEW_VERSION_AVAILABLE") next_actions.push("share_passport_to_partner");
  if (ready && (state === "GRANT_EXPIRED" || state === "GRANT_REVOKED")) {
    next_actions.push("share_passport_to_partner");
  }
  if (evidence.delivery === "request_required" && evidence.available.length > 0) {
    next_actions.push("await_partner_records_request");
  }

  return {
    partner: {
      org_id: candidate.partnerOrgId,
      org_name: candidate.partnerOrgName,
      portal_type: candidate.portalType,
      relationship_role: candidate.relationshipRole,
      purpose: candidate.purpose,
      classification_status: candidate.classificationStatus,
    },
    legal_route: route,
    passport: {
      attestation_id: att?.id ?? null,
      version: att?.version ?? null,
      payload_sha256: att?.payload_sha256 ?? null,
      issued_at: att?.issued_at ?? null,
      state_code: ctx.passport.stateCode,
    },
    state,
    ready,
    blockers,
    messages: blockers.map((b) => MESSAGES[b]),
    reliance_code: relianceCode,
    evidence,
    next_actions,
  };
}

/**
 * Evaluate a set of partners independently.
 *
 * Each candidate is evaluated on its own facts, so one partner's missing
 * arrangement can never mark another as blocked — and, on the write side, one
 * failure never lets the caller report the whole batch as shared.
 */
export function evaluateDistributionBatch(
  ctx: DistributionContext,
  candidates: DistributionCandidate[],
): DistributionReadiness[] {
  return candidates.map((c) => evaluateDistribution(ctx, c));
}

/** Batch outcome summary — accurate partial failure is the point. */
export function summariseBatch(results: Array<{ ready: boolean; state: DistributionState }>) {
  return {
    total: results.length,
    ready: results.filter((r) => r.ready && r.state !== "ALREADY_CURRENT").length,
    already_current: results.filter((r) => r.state === "ALREADY_CURRENT").length,
    blocked: results.filter((r) => !r.ready).length,
  };
}
