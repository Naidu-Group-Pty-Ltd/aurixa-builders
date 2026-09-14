/**
 * Passport credential — the ONE display identifier for the Compliance Passport.
 *
 * Derived, never stored. The canonical inputs are the AML case reference
 * (`aml.cases.case_reference`, e.g. "AML-2026-1184") and the attestation
 * version (`aml.compliance_attestations.version`). Deriving keeps the
 * credential incapable of drifting from the records it names: there is no
 * second identifier to migrate, back-fill or mismatch across portals.
 *
 * Format: `AUX-<CASE REFERENCE>[-V<n>]`, uppercased. Examples:
 *   passportCredential("AML-2026-1184")        → "AUX-AML-2026-1184"
 *   passportCredential("AML-2026-1184", 3)     → "AUX-AML-2026-1184-V3"
 *
 * Every surface (Command Centre, Client Portal, partner workspace, booklet)
 * must render the credential through this helper. Slightly different formats
 * per portal would read as different documents to a partner comparing them.
 */

/** Case-reference characters we will reproduce; anything else is dropped. */
const SAFE_REFERENCE = /[^A-Z0-9-]/g;

export function passportCredential(
  caseReference: string | null | undefined,
  version?: number | null,
): string | null {
  const raw = String(caseReference ?? "").trim().toUpperCase();
  if (!raw) return null;
  const cleaned = raw.replace(SAFE_REFERENCE, "").replace(/^-+|-+$/g, "");
  if (!cleaned) return null;
  const base = cleaned.startsWith("AUX-") ? cleaned : `AUX-${cleaned}`;
  if (version == null || !Number.isFinite(version) || version < 1) return base;
  return `${base}-V${Math.trunc(version)}`;
}

/** The version label on its own ("v3") — booklet chrome and version register. */
export function passportVersionLabel(version: number | null | undefined): string | null {
  if (version == null || !Number.isFinite(version) || version < 1) return null;
  return `v${Math.trunc(version)}`;
}

/**
 * Short form of the evidence fingerprint for display: groups of four hex
 * characters, dot-separated, uppercased — "8F3C·B41D·9AE0·72CF". The full
 * SHA-256 stays available wherever the short form is shown.
 */
export function shortFingerprint(sha256: string | null | undefined, groups = 4): string | null {
  const raw = String(sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(raw)) return null;
  const take = Math.min(Math.max(groups, 1), Math.floor(raw.length / 4));
  const parts: string[] = [];
  for (let i = 0; i < take; i++) parts.push(raw.slice(i * 4, i * 4 + 4).toUpperCase());
  return parts.join("·");
}
