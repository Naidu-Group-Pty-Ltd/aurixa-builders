/**
 * Partner Compliance Workspace — the pure domain layer (Phase 4).
 *
 * Everything a partner organisation is allowed to see or do in its
 * first-party workspace is decided here: the controlled record-class
 * catalogue, the per-code scope evaluation, the attestation lifecycle
 * state, the determination rules, and the CLOSED partner-safe DTO
 * constructor. The edge function loads rows and enforces session identity;
 * this module decides shape and policy, so both are behaviourally
 * testable from vitest and identical across all four portals.
 *
 * Boundary rules owned here:
 *  - the DTO is built by explicit constructor — nothing is spread from a
 *    database row, and the finished DTO is deep-scanned against the
 *    restricted-key tripwire before it is returned;
 *  - a partner can request CONTROLLED RECORD CODES only. Table names,
 *    storage paths and field names are not part of the vocabulary, and an
 *    unknown code is prohibited, not "pending review";
 *  - a determination never carries origin data and never writes any —
 *    the outcome set is closed and the compliance role is mandatory for
 *    a final decision.
 */

import { findRestrictedKeys } from "./attestationV2.ts";

/* ── controlled record classes ─────────────────────────────────────────── */

/**
 * The requestable catalogue. Codes are the records framework's partner-
 * requestable CDD evidence families (P3 — restricted CDD evidence,
 * deliverable only after origin review under an arrangement). Families
 * that are never partner-deliverable (P4/P5/P6 — investigation, reporting,
 * reviewer reasoning, raw biometrics) are NOT in this catalogue, so they
 * cannot even be asked for.
 */
export const REQUESTABLE_RECORD_CLASSES: Record<string, { label: string }> = {
  identity_verification_record: { label: "Identity verification record (method, date, outcome)" },
  identity_document_details: { label: "Identity document details relied upon" },
  document_sighting_record: { label: "Document sighting / certification record" },
  ownership_control_evidence: { label: "Ownership and control evidence" },
  authority_evidence: { label: "Authority to act evidence" },
  source_of_funds_declaration: { label: "Source of funds declaration" },
  consent_evidence: { label: "Consent and notice acceptance evidence" },
  screening_procedure_record: { label: "Screening procedure record (sources and freshness)" },
};

export type RecordScope = "within_scope" | "requires_origin_review" | "prohibited";

export interface RecordScopeEvaluation {
  code: string;
  label: string | null;
  scope: RecordScope;
}

/**
 * Evaluate each requested code against the catalogue and the arrangement's
 * recorded record-class scope. Unknown codes are PROHIBITED (a partner
 * cannot invent vocabulary); known codes inside the arrangement scope are
 * within_scope; known codes outside it require origin review. Nothing is
 * ever auto-approved by this function — approval is always an origin
 * decision.
 */
export function evaluateRecordsRequestScope(
  codes: string[],
  arrangementRecordClasses: string[] | null,
): RecordScopeEvaluation[] {
  const scopeSet = new Set(arrangementRecordClasses ?? []);
  return (codes ?? []).map((code) => {
    const entry = REQUESTABLE_RECORD_CLASSES[code];
    if (!entry) return { code, label: null, scope: "prohibited" as const };
    return {
      code,
      label: entry.label,
      scope: scopeSet.has(code) ? ("within_scope" as const) : ("requires_origin_review" as const),
    };
  });
}

/* ── attestation lifecycle state ───────────────────────────────────────── */

export type PartnerAttestationState =
  | "current" | "superseded" | "refresh_required" | "revoked" | "expired" | "unavailable";

export function deriveAttestationState(input: {
  attestation: { superseded_at: string | null; refresh_required_at?: string | null } | null;
  grant: { revoked_at: string | null; expires_at: string } | null;
  determinationHash: string | null;
  attestationHash: string | null;
  now: Date;
}): PartnerAttestationState {
  if (!input.attestation || !input.grant) return "unavailable";
  if (input.grant.revoked_at) return "revoked";
  if (new Date(input.grant.expires_at).getTime() < input.now.getTime()) return "expired";
  if (input.attestation.superseded_at) return "superseded";
  // Phase 6: a material change flags the attestation for refresh without
  // superseding it. Non-current content is never served (see the DTO below),
  // so a flagged attestation immediately stops disclosing.
  if (input.attestation.refresh_required_at) return "refresh_required";
  // The partner's recorded determination pinned an older content hash than
  // the current attestation → their decision needs refreshing even though
  // the attestation itself is current.
  if (
    input.determinationHash && input.attestationHash &&
    input.determinationHash !== input.attestationHash
  ) {
    return "refresh_required";
  }
  return "current";
}

/* ── partner determination ─────────────────────────────────────────────── */

export const DETERMINATION_OUTCOMES = [
  "satisfied", "records_requested", "independent_cdd_required", "not_satisfied",
] as const;
export type DeterminationOutcome = (typeof DETERMINATION_OUTCOMES)[number];

export type DeterminationValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * A final compliance determination requires the partner's own compliance
 * role, an explicit responsibility acknowledgement and a recorded basis.
 * Attestation-responsive outcomes must pin the exact content hash; only
 * independent_cdd_required may exist without one (reliance was never
 * available). None of this touches the originating case.
 */
export function validatePartnerDetermination(input: {
  outcome: string;
  decisionBasis: string;
  responsibilityAcknowledged: boolean;
  complianceRole: string | null;
  attestationSha256: string | null;
}): DeterminationValidation {
  if (!(DETERMINATION_OUTCOMES as readonly string[]).includes(input.outcome)) {
    return {
      ok: false, code: "invalid_outcome",
      message: `Outcome must be one of: ${DETERMINATION_OUTCOMES.join(", ")}`,
    };
  }
  if (input.complianceRole !== "compliance_officer") {
    return {
      ok: false, code: "compliance_role_required",
      message: "Only your organisation's compliance role can record a compliance determination. Operational users may prepare information but not decide.",
    };
  }
  if (!input.responsibilityAcknowledged) {
    return {
      ok: false, code: "responsibility_acknowledgement_required",
      message: "You must acknowledge that your organisation remains responsible for its own AML/CTF compliance before recording a determination.",
    };
  }
  if ((input.decisionBasis ?? "").trim().length < 10) {
    return {
      ok: false, code: "decision_basis_required",
      message: "Record the basis of your determination (at least 10 characters).",
    };
  }
  if (input.outcome !== "independent_cdd_required" && !input.attestationSha256) {
    return {
      ok: false, code: "attestation_hash_required",
      message: "This outcome responds to an attestation and must pin its exact content hash. If no attestation is available, the outcome is independent_cdd_required.",
    };
  }
  return { ok: true };
}

/* ── the responsibility notice (fixed wording, present in every DTO) ───── */

export const RESPONSIBILITY_NOTICE =
  "Your organisation remains responsible for its own AML/CTF compliance: its customer due diligence, " +
  "risk assessment, reliance or independent CDD decision, ongoing monitoring, record keeping and " +
  "regulatory obligations. Information shared here describes procedures performed by the issuing " +
  "organisation. It is not a determination that your organisation is compliant, and relying on it is " +
  "your organisation's own decision under its written CDD arrangement (AML/CTF Act 2006 (Cth) Pt 2 Div 7).";

/* ── the closed partner-safe DTO ───────────────────────────────────────── */

export interface PartnerWorkspaceLinkDto {
  id: string;
  relationship_role: string;
  legal_route: string;
  state: string;
  portal_type: string;
  linked_at: string;
  purchase_file_id: string | null;
  legal_matter_id: string | null;
}

export interface PartnerWorkspaceDto {
  workspace_version: 1;
  responsibility_notice: string;
  partner: { organisation_legal_name: string; classification_status: string };
  origin: { organisation_label: string };
  link: PartnerWorkspaceLinkDto;
  attestation: {
    schema_version: number;
    version: number;
    sha256: string;
    issued_at: string;
    state: PartnerAttestationState;
  } | null;
  attestation_state: PartnerAttestationState;
  procedures: Record<string, unknown> | null;
  limitations: string[];
  record_availability: string[];
  determination: {
    status: string;
    decided_at: string | null;
    based_on_attestation_sha256: string | null;
    refresh_required: boolean;
  } | null;
  determination_history_count: number;
  open_requests: Array<{
    id: string;
    requested_record_codes: string[];
    status: string;
    requested_at: string;
    due_at: string | null;
    origin_response_message: string | null;
  }>;
  deliveries: Array<{
    id: string;
    record_code: string;
    safe_label: string;
    delivered_version: number;
    delivered_sha256: string | null;
    delivered_at: string;
    expires_at: string;
    revoked_at: string | null;
    available: boolean;
  }>;
  tasks: Array<{ kind: string; label: string; due_at: string | null }>;
  next_action: { code: string; label: string };
}

/**
 * Build the workspace DTO. Every field is written out explicitly from the
 * typed inputs — no row spreads — and the finished object is deep-scanned
 * with the restricted-key tripwire: if origin vocabulary ever reaches the
 * inputs, construction throws rather than disclosing.
 */
export function buildPartnerWorkspaceDto(input: {
  partnerOrg: { legal_name: string; classification_status: string };
  originLabel: string;
  link: {
    id: string; relationship_role: string; legal_route: string; state: string;
    portal_type: string; linked_at: string;
    purchase_file_id: string | null; legal_matter_id: string | null;
  };
  attestation: {
    schema_version: number | null; version: number; payload_sha256: string;
    issued_at: string; superseded_at: string | null;
    refresh_required_at?: string | null;
  } | null;
  grant: { revoked_at: string | null; expires_at: string } | null;
  /** Manifest-intersected procedure facts (already sanitised) or null. */
  procedures: Record<string, unknown> | null;
  limitations: string[];
  recordAvailability: string[];
  determinations: Array<{
    status: string; decided_at: string | null;
    based_on_attestation_sha256: string | null; created_at: string;
  }>;
  requests: Array<{
    id: string; requested_record_codes: string[]; status: string;
    requested_at: string; due_at: string | null; origin_response_message: string | null;
  }>;
  deliveries: Array<{
    id: string; record_code: string; safe_label: string; delivered_version: number;
    delivered_sha256: string | null; delivered_at: string; expires_at: string;
    revoked_at: string | null;
  }>;
  now: Date;
}): PartnerWorkspaceDto {
  const latestDetermination = input.determinations[0] ?? null;
  const state = deriveAttestationState({
    attestation: input.attestation,
    grant: input.grant,
    determinationHash: latestDetermination?.based_on_attestation_sha256 ?? null,
    attestationHash: input.attestation?.payload_sha256 ?? null,
    now: input.now,
  });

  const openRequests = input.requests.filter((r) =>
    ["submitted", "under_review", "approved", "partly_approved"].includes(r.status));

  const deliveries = input.deliveries.map((d) => ({
    id: d.id,
    record_code: d.record_code,
    safe_label: d.safe_label,
    delivered_version: d.delivered_version,
    delivered_sha256: d.delivered_sha256,
    delivered_at: d.delivered_at,
    expires_at: d.expires_at,
    revoked_at: d.revoked_at,
    available: !d.revoked_at && new Date(d.expires_at).getTime() > input.now.getTime(),
  }));

  const tasks: PartnerWorkspaceDto["tasks"] = [];
  for (const r of openRequests) {
    tasks.push({
      kind: "records_request",
      label: `Records request ${r.status.replace(/_/g, " ")}`,
      due_at: r.due_at,
    });
  }
  for (const d of deliveries) {
    if (d.available) {
      tasks.push({ kind: "evidence_expiry", label: `Evidence "${d.safe_label}" expires`, due_at: d.expires_at });
    }
  }
  if (state === "superseded" || state === "refresh_required") {
    tasks.push({ kind: "refresh", label: "Review the refreshed attestation and re-record your determination", due_at: null });
  }

  const nextAction = ((): PartnerWorkspaceDto["next_action"] => {
    if (input.link.state !== "active") {
      return { code: "link_inactive", label: "This link is no longer active. Contact the issuing organisation if you believe this is an error." };
    }
    if (state === "revoked") return { code: "access_revoked", label: "Access has been revoked. Contact the issuing organisation." };
    if (state === "expired") return { code: "access_expired", label: "Access has expired. Ask the issuing organisation to re-issue access if still required." };
    if (state === "superseded" || state === "refresh_required") {
      return { code: "refresh_review", label: "The attestation has been refreshed. Review it and re-record your organisation's determination." };
    }
    if (input.link.legal_route !== "reliance") {
      return { code: "independent_cdd", label: "Reliance is not in place for this matter. Complete your organisation's own customer due diligence." };
    }
    if (state === "unavailable") {
      return { code: "await_attestation", label: "No attestation is available yet. You may complete independent CDD, or wait for the issuing organisation." };
    }
    if (!latestDetermination || latestDetermination.status === "open") {
      return { code: "record_determination", label: "Review the procedures and record your organisation's own determination." };
    }
    return { code: "up_to_date", label: "No action required." };
  })();

  const dto: PartnerWorkspaceDto = {
    workspace_version: 1,
    responsibility_notice: RESPONSIBILITY_NOTICE,
    partner: {
      organisation_legal_name: input.partnerOrg.legal_name,
      classification_status: input.partnerOrg.classification_status,
    },
    origin: { organisation_label: input.originLabel },
    link: {
      id: input.link.id,
      relationship_role: input.link.relationship_role,
      legal_route: input.link.legal_route,
      state: input.link.state,
      portal_type: input.link.portal_type,
      linked_at: input.link.linked_at,
      purchase_file_id: input.link.purchase_file_id,
      legal_matter_id: input.link.legal_matter_id,
    },
    attestation: input.attestation ? {
      schema_version: input.attestation.schema_version ?? 1,
      version: input.attestation.version,
      sha256: input.attestation.payload_sha256,
      issued_at: input.attestation.issued_at,
      state,
    } : null,
    attestation_state: state,
    // Superseded/revoked/expired content is NEVER included — only a state.
    procedures: state === "current" ? input.procedures : null,
    limitations: [...(input.limitations ?? [])],
    record_availability: [...(input.recordAvailability ?? [])],
    determination: latestDetermination ? {
      status: latestDetermination.status,
      decided_at: latestDetermination.decided_at,
      based_on_attestation_sha256: latestDetermination.based_on_attestation_sha256,
      refresh_required: state === "refresh_required" || state === "superseded",
    } : null,
    determination_history_count: input.determinations.length,
    open_requests: openRequests.map((r) => ({
      id: r.id,
      requested_record_codes: [...r.requested_record_codes],
      status: r.status,
      requested_at: r.requested_at,
      due_at: r.due_at,
      origin_response_message: r.origin_response_message,
    })),
    deliveries,
    tasks,
    next_action: nextAction,
  };

  const violations = findRestrictedKeys(dto);
  if (violations.length > 0) {
    throw new Error(`restricted keys in partner workspace DTO: ${violations.join(", ")}`);
  }
  return dto;
}
