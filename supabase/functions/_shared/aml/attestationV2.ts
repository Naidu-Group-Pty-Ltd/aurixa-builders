/**
 * Attestation v2 — deterministic hashing, the closed disclosure schema and
 * manifest intersection for the compliance passport (Phase 3).
 *
 * Pure module: no Deno APIs beyond Web Crypto (available in both Deno and
 * Node ≥ 20), no database access. The edge function supplies data; this
 * module owns the disclosure mechanics, so they are behaviourally testable
 * from vitest and cannot vary by call site.
 *
 * Three mechanisms live here:
 *
 *  1. canonicalJson — key-sorted, deterministic serialisation. v1 hashed
 *     JSON.stringify with incidental key order; v2 hashes canonical form,
 *     so a refactor of object-literal ordering can never silently change
 *     every future hash.
 *
 *  2. The material-input hash — the inputs that genuinely affect what a
 *     partner relies on. A material change (party verified/changed,
 *     consent version, screening state, gate decision, limitations,
 *     subject identity) produces a new hash; presentation-only fields
 *     (issuer label, section counters) are deliberately excluded so they
 *     cannot create meaningless supersession.
 *
 *  3. The manifest intersection — every v2 partner response is BUILT from
 *     the payload by attribute-code allowlist, with denied classes
 *     overriding allowed codes, plus a deep restricted-key tripwire that
 *     refuses to serialise a payload carrying internal vocabulary at all.
 */

/* ── canonical JSON ────────────────────────────────────────────────────── */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

export async function sha256HexCanonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ── material inputs ───────────────────────────────────────────────────── */

export interface MaterialInputs {
  subject: string | null;
  subject_type: string | null;
  /** Verified-party procedure facts only (the v1 party entries). */
  parties: unknown[];
  consents_held: unknown[];
  screening: {
    performed: boolean;
    last_performed_at: string | null;
    scope: unknown;
    list_freshness: Record<string, string>;
  };
  service_gate_decision_id: string | null;
  limitations: string[];
  questionnaire_version: string | null;
}

/** Deterministic hash of the material inputs. Order-insensitive by
 * construction (canonical JSON); parties are sorted by their party label so
 * query ordering cannot masquerade as a material change. */
export async function materialInputHash(inputs: MaterialInputs): Promise<string> {
  const parties = [...(inputs.parties ?? [])].sort((a, b) =>
    String((a as any)?.party ?? "").localeCompare(String((b as any)?.party ?? "")));
  const consents = [...(inputs.consents_held ?? [])].sort((a, b) =>
    `${(a as any)?.code}:${(a as any)?.version}`.localeCompare(`${(b as any)?.code}:${(b as any)?.version}`));
  return sha256HexCanonical({ ...inputs, parties, consents_held: consents });
}

/* ── the closed v2 schema and attribute codes ──────────────────────────── */

export const ATTESTATION_V2_SCHEMA = "aml.compliance_attestation.v2";

/**
 * Attribute code → payload section. The map is the ONLY route by which a
 * section reaches a partner: a code absent from the map, or absent from the
 * manifest's allowlist, discloses nothing. Envelope fields (schema, issuer,
 * case_reference, reliance_basis) always travel — they identify the
 * document, they disclose nothing about the customer.
 */
export const ATTRIBUTE_CODE_SECTIONS: Record<string, string[]> = {
  "subject.identity": ["subject", "subject_type"],
  "identity.customer_identification": ["customer_identification"],
  "screening.procedure": ["screening"],
  "service.readiness": ["service_readiness"],
  "procedure.limitations": ["limitations"],
};

export const ENVELOPE_KEYS = ["schema", "issuer", "case_reference", "reliance_basis"] as const;

/** The default grant manifest mirrors the full sanitised v1 disclosure. */
export const DEFAULT_ALLOWED_ATTRIBUTE_CODES = Object.keys(ATTRIBUTE_CODE_SECTIONS);

/**
 * Denied classes recorded on every manifest. Most are families that never
 * appear in the sanitised payload at all — recording them makes the
 * exclusion machine-checkable and survives later schema widening: a later
 * code that mapped one of these families would still be stripped, because
 * denied ALWAYS overrides allowed.
 */
export const DEFAULT_DENIED_CLASSES = [
  "risk.assessment",
  "screening.match_content",
  "adverse_media.detail",
  "analyst.reasoning",
  "reviewer.notes",
  "mlro.commentary",
  "edd.detail",
  "reporting.suspicious_matter",
  "finance.discrepancy_internals",
  "biometric.raw",
  "storage.object_paths",
  "documents.unrestricted_copies",
];

/** Restage the sanitised v1-shape payload as schema v2. Pure transform —
 * every key it emits is written out explicitly; nothing is spread. */
export function toV2Payload(v1Payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: ATTESTATION_V2_SCHEMA,
    issuer: v1Payload.issuer ?? null,
    case_reference: v1Payload.case_reference ?? null,
    subject: v1Payload.subject ?? null,
    subject_type: v1Payload.subject_type ?? null,
    customer_identification: v1Payload.customer_identification ?? null,
    screening: v1Payload.screening ?? null,
    service_readiness: v1Payload.service_readiness ?? false,
    limitations: v1Payload.limitations ?? [],
    reliance_basis: v1Payload.reliance_basis ?? null,
  };
}

/* ── restricted-key tripwire ───────────────────────────────────────────── */

/**
 * Vocabulary that must never appear as a key ANYWHERE in a partner-facing
 * payload, at any nesting depth. This is a tripwire, not the boundary —
 * the boundary is the closed constructor above — but it means a future
 * change that smuggles internal fields through `outcome_detail` or a new
 * section fails loudly at issue AND at read.
 */
export const RESTRICTED_KEY_PATTERN =
  /(risk_rating|risk_score|risk_tier|match|adverse|reviewer|mlro|analyst|edd|suspicious|smr\b|report_status|discrepan|biometric|storage_path|bucket|signed_url|internal_note|decision_notes)/i;

export function findRestrictedKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...findRestrictedKeys(v, `${path}[${i}]`)));
    return found;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = path ? `${path}.${k}` : k;
    if (RESTRICTED_KEY_PATTERN.test(k)) found.push(keyPath);
    found.push(...findRestrictedKeys(v, keyPath));
  }
  return found;
}

/* ── manifest intersection ─────────────────────────────────────────────── */

export interface DisclosureManifestInput {
  allowed_attribute_codes: string[];
  allowed_record_classes: string[];
  denied_classes: string[];
  expires_at: string;
  revoked_at: string | null;
}

export type ManifestReadDecision =
  | { ok: true }
  | { ok: false; code: "manifest_missing" | "manifest_expired" | "manifest_revoked"; message: string };

export function evaluateManifestForRead(
  manifest: DisclosureManifestInput | null,
  now: Date,
): ManifestReadDecision {
  if (!manifest) {
    return {
      ok: false, code: "manifest_missing",
      message: "No disclosure manifest exists for this grant. v2 disclosure is manifest-controlled — contact the issuing organisation.",
    };
  }
  if (manifest.revoked_at) {
    return { ok: false, code: "manifest_revoked", message: "Access to this disclosure has been revoked." };
  }
  if (new Date(manifest.expires_at).getTime() < now.getTime()) {
    return { ok: false, code: "manifest_expired", message: "Access to this disclosure has expired." };
  }
  return { ok: true };
}

/**
 * Build the partner-facing v2 response body: envelope always; each mapped
 * section only when its code is allowed AND not denied; unknown codes
 * disclose nothing; record availability comes from the manifest, never the
 * stored payload. Throws if the source payload trips the restricted-key
 * tripwire — a tampered or widened payload must not be served at all.
 */
export function intersectPayloadWithManifest(
  payload: Record<string, unknown>,
  manifest: DisclosureManifestInput,
): Record<string, unknown> {
  const violations = findRestrictedKeys(payload);
  if (violations.length > 0) {
    throw new Error(`restricted keys present in attestation payload: ${violations.join(", ")}`);
  }
  const denied = new Set(manifest.denied_classes ?? []);
  const effectiveCodes = (manifest.allowed_attribute_codes ?? [])
    .filter((code) => !denied.has(code));

  const out: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) out[key] = payload[key] ?? null;
  for (const code of effectiveCodes) {
    const sections = ATTRIBUTE_CODE_SECTIONS[code];
    if (!sections) continue; // unknown code discloses nothing
    for (const section of sections) {
      if (payload[section] !== undefined) out[section] = payload[section];
    }
  }
  out.record_availability = {
    classes_available_on_controlled_request: [...(manifest.allowed_record_classes ?? [])],
  };
  return out;
}
