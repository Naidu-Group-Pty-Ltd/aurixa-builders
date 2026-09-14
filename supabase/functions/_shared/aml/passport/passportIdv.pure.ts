/**
 * Compliance Passport — the IDV binding.
 *
 * ## Why this module exists before the integration does
 *
 * The Passport's Verification page is the surface the identity-verification
 * workflow will eventually drive. That workflow is completed today through the
 * main AML/CTF Compliance page and is NOT yet wired to the Passport, so this
 * module is the seam that makes the later wiring an addition rather than a
 * rewrite of the page.
 *
 * The rule it enforces: **the page never names a check type.** It asks this
 * module what components exist and what each one means. When the live IDV
 * workflow starts emitting richer component records, it declares them HERE —
 * beside the existing ones, in the same vocabulary — and the page renders them
 * without being touched. A page that switched on `check_type` inline would
 * have to be edited for every new IDV signal, and every such edit is a chance
 * to show a client's biometric detail on a surface that must not carry it.
 *
 * ## The disclosure rule that comes with it
 *
 * Each component declares `disclosable`. A component marked `false` may
 * contribute its PRESENCE and its PASS/FAIL to the Passport and nothing else —
 * never a score, never a measurement, never the underlying media. Biometric
 * measurements and provider payloads are restricted material under the
 * programme's §32 default-deny rule, and the Passport is a disclosure surface:
 * a partner and, on the client projection, the client themselves can see it.
 * `summariseIdv` is what the page calls, and it cannot return a score because
 * this module never carries one.
 */

/** The canonical component vocabulary. Extend here, never at a call site. */
export type IdvComponentCode =
  | "document_authenticity"
  | "face_match"
  | "liveness"
  | "electronic_idv"
  | "document_sighting";

export type IdvComponent = {
  code: IdvComponentCode;
  /** Operator-facing label, as the design writes it. */
  label: string;
  /** One line stating what the check establishes — shown under the label. */
  meaning: string;
  /**
   * May the component's detail cross a disclosure boundary? Presence and
   * outcome always may; anything finer only when this is true.
   */
  disclosable: boolean;
};

/**
 * The four components the design's Verification page names, plus the manual
 * sighting the AML engine already records. `document_sighting` is the fallback
 * a case carries when verification was done in person rather than by provider.
 */
export const IDV_COMPONENTS: Record<IdvComponentCode, IdvComponent> = {
  document_authenticity: {
    code: "document_authenticity",
    label: "Document authenticity",
    meaning: "The identity document was examined for tampering and structural validity.",
    disclosable: true,
  },
  face_match: {
    code: "face_match",
    label: "Facial match",
    meaning: "The presented face was compared against the document portrait.",
    // A match SCORE is a biometric measurement. The fact of a match is not.
    disclosable: false,
  },
  liveness: {
    code: "liveness",
    label: "Liveness",
    meaning: "The capture was confirmed as a live person rather than a replay.",
    disclosable: false,
  },
  electronic_idv: {
    code: "electronic_idv",
    label: "Electronic verification",
    meaning: "Name, date of birth and address were matched against independent sources.",
    disclosable: true,
  },
  document_sighting: {
    code: "document_sighting",
    label: "Document sighting",
    meaning: "The original document was sighted and certified by a responsible officer.",
    disclosable: true,
  },
};

/**
 * Raw `check_type` values seen in `aml.verification_checks`, mapped onto the
 * canonical vocabulary. Unknown types are deliberately NOT guessed — see
 * `classifyIdvCheck`.
 */
const CHECK_TYPE_MAP: Record<string, IdvComponentCode> = {
  electronic_idv: "electronic_idv",
  ocr_anti_tamper: "document_authenticity",
  document_authenticity: "document_authenticity",
  document_only: "document_sighting",
  document_sighting: "document_sighting",
  face_match: "face_match",
  facial_match: "face_match",
  liveness: "liveness",
  liveness_video: "liveness",
};

/**
 * Returns null for a check type this module does not know.
 *
 * Null is the correct answer rather than a default bucket: a check shown under
 * the wrong component tells an operator that a control was performed which was
 * not. The page counts unmapped checks separately and says so.
 */
export function classifyIdvCheck(checkType: string | null | undefined): IdvComponent | null {
  if (!checkType) return null;
  const code = CHECK_TYPE_MAP[String(checkType).trim().toLowerCase()];
  return code ? IDV_COMPONENTS[code] : null;
}

export type IdvCheckFact = {
  check_type: string;
  status: string;
  completed_at: string | null;
};

export type IdvComponentResult = {
  component: IdvComponent;
  /** "passed" only when a record says so; absence is never a pass. */
  outcome: "passed" | "failed" | "pending" | "not_performed";
  completed_at: string | null;
};

export type IdvSummary = {
  components: IdvComponentResult[];
  /** Checks whose type this module does not recognise — surfaced, not hidden. */
  unmapped: number;
  performed: number;
  passed: number;
  /** True only when every component the case attempted has passed. */
  complete: boolean;
};

const PASSED = new Set(["passed", "verified", "accepted", "match", "clear"]);
const FAILED = new Set(["failed", "rejected", "declined", "no_match"]);

/**
 * Fold a case's raw verification checks into the design's component view.
 *
 * Components with no record are reported as `not_performed` rather than being
 * omitted: the design's Verification page shows the full control set so the
 * reader can see what was NOT done, which is the question an auditor asks
 * first. An omitted row answers it wrongly by saying nothing at all.
 */
export function summariseIdv(checks: IdvCheckFact[]): IdvSummary {
  const byCode = new Map<IdvComponentCode, IdvCheckFact[]>();
  let unmapped = 0;

  for (const check of checks) {
    const component = classifyIdvCheck(check.check_type);
    if (!component) {
      unmapped += 1;
      continue;
    }
    const list = byCode.get(component.code) ?? [];
    list.push(check);
    byCode.set(component.code, list);
  }

  const components: IdvComponentResult[] = (Object.keys(IDV_COMPONENTS) as IdvComponentCode[])
    .map((code) => {
      const found = byCode.get(code) ?? [];
      if (found.length === 0) {
        return { component: IDV_COMPONENTS[code], outcome: "not_performed" as const, completed_at: null };
      }
      // A component is only as good as its worst record: one failed check
      // fails the component, even when a later attempt passed. Re-running
      // until something passes is exactly what an audit trail must expose.
      const statuses = found.map((f) => String(f.status ?? "").toLowerCase());
      const outcome = statuses.some((s) => FAILED.has(s))
        ? ("failed" as const)
        : statuses.every((s) => PASSED.has(s))
          ? ("passed" as const)
          : ("pending" as const);
      const completed = found
        .map((f) => f.completed_at)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .sort()
        .pop() ?? null;
      return { component: IDV_COMPONENTS[code], outcome, completed_at: completed };
    });

  const performed = components.filter((c) => c.outcome !== "not_performed").length;
  const passed = components.filter((c) => c.outcome === "passed").length;

  return {
    components,
    unmapped,
    performed,
    passed,
    complete: performed > 0 && passed === performed,
  };
}
