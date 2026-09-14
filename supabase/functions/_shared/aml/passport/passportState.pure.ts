/**
 * Passport state — the ONE derivation of the Compliance Passport's lifecycle
 * position, shared by every portal.
 *
 * There is deliberately NO stored passport status. The state is a pure
 * function of records that already exist and are already authoritative:
 * the attestation register (`aml.compliance_attestations`), the service gate
 * (`aml.cases.service_gate_status`), the case lifecycle (`aml.cases.status`)
 * and any open refresh obligations. A stored copy would be the exact drift
 * bug this programme exists to prevent — "Journey says Verified, Passport
 * says Pending" cannot happen when the Passport has nothing of its own to
 * disagree with.
 *
 * The browser must not recompute its own variant of this mapping: edge
 * functions embed the result in every projection, and the UI renders it.
 * (A read-only mirror re-export exists at `src/lib/aml/passport/` for types
 * and presentation helpers only.)
 *
 * Vocabulary (human lifecycle, distinct from `aml.case_status`):
 *   NOT_ISSUED → READY_FOR_ISSUANCE → ISSUED_CURRENT
 *     → SUPERSEDED (between versions) / REFRESH_REQUIRED (caution)
 *     → SUSPENDED / REVOKED (restriction, from the service gate)
 *     → COMPLETED_RETAINED (case closed; record retained, never deleted)
 */

export type PassportStateCode =
  | "not_issued"
  | "ready_for_issuance"
  | "issued_current"
  | "superseded"
  | "refresh_required"
  | "suspended"
  | "revoked"
  | "completed_retained";

/** Tones align with the existing AML badge families (never colour-only). */
export type PassportStateTone =
  | "success"
  | "progress"
  | "attention"
  | "muted"
  | "destructive";

export type PassportAttestationFact = {
  version: number;
  issued_at: string | null;
  superseded_at: string | null;
  payload_sha256: string;
  schema_version: number | null;
};

export type PassportStateInput = {
  /** Every attestation version for the case, any order. Empty = never issued. */
  attestations: PassportAttestationFact[];
  /** `aml.cases.service_gate_status` — the canonical "may the service proceed". */
  service_gate_status: string | null;
  /** `aml.cases.status` (legacy enum) — used only to detect closure. */
  case_status: string | null;
  /**
   * Whether the current attestation's material inputs still match the case.
   * `true`/`false` only when assessable (schema v2 material-input hash);
   * `null` = not assessable (v1 attestation) and never forces a caution state.
   */
  material_inputs_current: boolean | null;
  /** Open rows in `aml.partner_refresh_obligations` for the case. */
  open_refresh_obligations: number;
};

export type PassportStateResult = {
  code: PassportStateCode;
  /** Rendered verbatim by every surface. */
  label: string;
  tone: PassportStateTone;
  /** Machine-readable reasons for the derivation — shown in Command only. */
  reasons: string[];
  /** The unsuperseded attestation version, if one exists. */
  current_version: number | null;
  /** Highest version ever issued (register length), 0 = never issued. */
  latest_version: number;
};

const GATE_APPROVED = new Set(["approved", "approved_with_controls"]);

const LABELS: Record<PassportStateCode, { label: string; tone: PassportStateTone }> = {
  not_issued: { label: "Not issued", tone: "muted" },
  ready_for_issuance: { label: "Ready for issuance", tone: "progress" },
  issued_current: { label: "Issued · Current", tone: "success" },
  superseded: { label: "Superseded — new version pending", tone: "attention" },
  refresh_required: { label: "Refresh required", tone: "attention" },
  suspended: { label: "Suspended", tone: "destructive" },
  revoked: { label: "Revoked", tone: "destructive" },
  completed_retained: { label: "Completed — retained record", tone: "muted" },
};

function result(
  code: PassportStateCode,
  reasons: string[],
  currentVersion: number | null,
  latestVersion: number,
): PassportStateResult {
  return { code, ...LABELS[code], reasons, current_version: currentVersion, latest_version: latestVersion };
}

export function derivePassportState(input: PassportStateInput): PassportStateResult {
  const attestations = [...(input.attestations ?? [])].sort((a, b) => a.version - b.version);
  const latest = attestations.length ? attestations[attestations.length - 1].version : 0;
  const current = attestations.filter((a) => !a.superseded_at).pop() ?? null;
  const currentVersion = current?.version ?? null;
  const gate = input.service_gate_status ?? null;

  // Restriction states win over everything: they are explicit, reasoned MLRO
  // gate decisions, and a restricted Passport must never read as Current.
  if (gate === "terminated") {
    return result("revoked", ["service_gate_terminated"], currentVersion, latest);
  }
  if (gate === "locked") {
    return result("suspended", ["service_gate_locked"], currentVersion, latest);
  }

  // Never issued: the journey is still building the record.
  if (attestations.length === 0) {
    if (gate && GATE_APPROVED.has(gate)) {
      return result("ready_for_issuance", ["gate_approved_no_attestation"], null, 0);
    }
    return result("not_issued", ["no_attestation"], null, 0);
  }

  // Closed case with an issued record: retained under the compliance
  // retention period rather than removed (never "deleted").
  if (input.case_status === "closed") {
    return result("completed_retained", ["case_closed"], currentVersion, latest);
  }

  // Every version superseded and no successor yet — the window between a
  // material change and reissue. A caution state, not a failure.
  if (!current) {
    return result("superseded", ["all_versions_superseded"], null, latest);
  }

  const reasons: string[] = [];
  if (input.material_inputs_current === false) reasons.push("material_inputs_changed");
  if ((input.open_refresh_obligations ?? 0) > 0) reasons.push("open_refresh_obligation");
  // A gate that has regressed below approved (e.g. cleared → under_review)
  // must not leave the Passport claiming Current: reliance-readiness derives
  // only from an explicitly approved gate, the same rule the attestation
  // payload itself applies to `service_readiness`.
  if (gate && !GATE_APPROVED.has(gate)) reasons.push("service_gate_regressed");

  if (reasons.length > 0) {
    return result("refresh_required", reasons, currentVersion, latest);
  }

  return result("issued_current", ["current_attestation_gate_approved"], currentVersion, latest);
}

/* ── What would actually clear a caution state ─────────────────────────
 *
 * `refresh_required` is ONE code covering two different owed acts, and the
 * product used to render both of them as "issue a new version".
 *
 * On a real case (`AML-2026-00005`) the attestation was v1, issued, not
 * superseded, `refresh_required_at` NULL, with zero open refresh
 * obligations. The Passport still read **"Refresh required · v1"** — for one
 * reason and one only: `service_gate_regressed`, because the gate was
 * `under_review`. Nothing about the document was wrong.
 *
 * Stage 9 then told the operator "a newer version is needed — reissue from
 * the reliance panel below", and the reliance panel offered "Reissue as v2"
 * as the open act. Following that advice supersedes a perfectly good v1 for
 * nothing, and **v2 reads `refresh_required` too**, because the gate is
 * still not approved. A remedy that cannot discharge the reason is worse
 * than no remedy: it is a loop with an audit trail.
 *
 * So the reasons are classified. This is the ONE place that knows which act
 * clears which reason, and `passportStateRemedy.spec` asserts that every
 * reason string this module can emit is classified by it — a new reason
 * fails the build rather than silently defaulting into "reissue".
 */

/** Reasons a NEW VERSION discharges. The document itself is out of date. */
const REISSUE_CLEARS = new Set([
  "material_inputs_changed",
  "open_refresh_obligation",
  "all_versions_superseded",
]);

/** Reasons only an APPROVED SERVICE GATE discharges. Issuing cannot help. */
const GATE_APPROVAL_CLEARS = new Set([
  "service_gate_regressed",
]);

/**
 * Reasons that are not cautions at all — they explain a HEALTHY or a
 * TERMINAL reading, and nothing is owed on them.
 *
 * They matter here because a caller may hand this function any state's
 * reasons, and `issued_current` publishes one
 * (`current_attestation_gate_approved`). Treating an unrecognised reason as
 * "reissue" is the right default for a caution, and exactly the wrong answer
 * for a Passport that is already in force — so these are named rather than
 * left to the default. A restriction (`suspended`/`revoked`) is likewise not
 * something a version or a gate approval discharges: the MLRO's own gate
 * decision is what stands.
 */
const NOT_A_CAUTION = new Set([
  "current_attestation_gate_approved",
  "gate_approved_no_attestation",
  "no_attestation",
  "case_closed",
  "service_gate_terminated",
  "service_gate_locked",
]);

export type PassportRefreshRemedy =
  /** A new version is owed. */
  | "reissue"
  /** The gate is owed; the issued version is fine and stays in force. */
  | "approve_gate"
  /** Both, and the gate first — reissuing before it cannot clear the state. */
  | "both"
  /** Nothing is owed on this reading. */
  | "none";

/**
 * What would clear this state, from the reasons the server published.
 *
 * An unrecognised reason counts towards `reissue`. That is the conservative
 * side: offering a reissue that turns out to be unnecessary costs a version,
 * whereas withholding one that IS needed strands the case — and the spec test
 * means an unrecognised reason cannot reach production in the first place.
 */
export function refreshRemedy(reasons: readonly string[] | null | undefined): PassportRefreshRemedy {
  const list = (reasons ?? []).filter((r) => !NOT_A_CAUTION.has(r));
  const gate = list.some((r) => GATE_APPROVAL_CLEARS.has(r));
  const reissue = list.some((r) => !GATE_APPROVAL_CLEARS.has(r));
  if (gate && reissue) return "both";
  if (gate) return "approve_gate";
  if (reissue) return "reissue";
  return "none";
}

/** Every reason code this module classifies — the spec test reads this. */
export const PASSPORT_STATE_REASONS = [
  ...REISSUE_CLEARS, ...GATE_APPROVAL_CLEARS, ...NOT_A_CAUTION,
] as const;

/** Per-version register state — the version panel's vocabulary. */
export type PassportVersionState = "current" | "superseded" | "initial_issue";

export function versionRegisterState(
  fact: PassportAttestationFact,
  all: PassportAttestationFact[],
): PassportVersionState {
  if (!fact.superseded_at) return "current";
  const minVersion = Math.min(...all.map((a) => a.version));
  return fact.version === minVersion ? "initial_issue" : "superseded";
}
