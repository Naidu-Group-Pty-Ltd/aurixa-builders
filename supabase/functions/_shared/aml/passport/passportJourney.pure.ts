/**
 * The AML/CTF Journey — the design's page 00, and the Passport's own thesis:
 * "the Passport is generated from this journey — it is not a separate record".
 *
 * This module adds NO new source of truth and requires NO extra query. The
 * journey is the SAME facts the stamps derive from, grouped into the phases
 * a compliance operator thinks in. A milestone is `recorded` only when its
 * underlying record exists — there is no stored progress, no completion flag
 * and nothing a portal user can tick.
 *
 * Because journey and stamps share one input, a milestone can never claim
 * something the stamp register contradicts.
 */

import type { PassportStampInput } from "./passportStamps.pure.ts";

export type JourneyPhase =
  | "client_verification"
  | "compliance_assessment"
  | "passport_issuance"
  | "partner_reliance"
  | "transaction_completion";

export type JourneyMilestoneCode =
  | "consent"
  | "evidence_supplied"
  | "identity_verified"
  | "screening"
  | "ownership"
  | "funding"
  | "review"
  | "issued"
  | "finance_reliance"
  | "solicitor_reliance"
  | "builder_reliance"
  | "settlement";

export type JourneyMilestone = {
  code: JourneyMilestoneCode;
  phase: JourneyPhase;
  /** Display order within the whole journey (01, 02 …). */
  ordinal: string;
  title: string;
  detail: string;
  /** Which Passport page this milestone populates — the design's "↳ Populates". */
  feeds: string;
  /** Portal the underlying record came from. */
  portal: string;
  recorded: boolean;
  at: string | null;
  actor: string | null;
};

export type JourneyPhaseGroup = {
  phase: JourneyPhase;
  label: string;
  milestones: JourneyMilestone[];
  recorded: number;
  total: number;
};

export type PassportJourney = {
  phases: JourneyPhaseGroup[];
  recorded: number;
  total: number;
  /** 0-100, whole numbers. Derived; never stored. */
  percent: number;
};

const PHASE_LABELS: Record<JourneyPhase, string> = {
  client_verification: "Client verification",
  compliance_assessment: "Compliance assessment",
  passport_issuance: "Passport issuance",
  partner_reliance: "Partner reliance",
  transaction_completion: "Transaction completion",
};

const PHASE_ORDER: JourneyPhase[] = [
  "client_verification",
  "compliance_assessment",
  "passport_issuance",
  "partner_reliance",
  "transaction_completion",
];

function maxDate(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (!best || v > best)) best = v;
  return best;
}

function orgTypeKey(t: string | null | undefined): "finance" | "solicitor" | "builder" | null {
  if (t === "finance") return "finance";
  if (t === "solicitor_conveyancer") return "solicitor";
  if (t === "builder" || t === "developer") return "builder";
  return null;
}

/**
 * Derive the journey from the same facts the stamp register uses.
 *
 * `audience` narrows what a client may be told: partner reliance milestones
 * are shown to a client as the fact that a partner accepted, never with the
 * partner's internal assessment vocabulary.
 *
 * A relying entity reads the Command Centre's own wording. The client
 * rewordings exist because a client is not a compliance reader; a partner is,
 * and softening "Screening completed" for them would be a different account
 * of the same due diligence — which is the one thing the two documents may
 * not have. What a partner does not see is decided by the view assembler and
 * its allow-list, never by paraphrase here.
 */
export function derivePassportJourney(
  input: PassportStampInput,
  audience: "command" | "client" | "partner" = "command",
): PassportJourney {
  const atts = [...(input.attestations ?? [])].sort((a, b) => a.version - b.version);
  const firstIssue = atts.find((a) => a.issued_at)?.issued_at ?? null;

  const consent = [...(input.consents ?? [])]
    .filter((c) => c.accepted_at)
    .sort((a, b) => String(a.accepted_at).localeCompare(String(b.accepted_at)))[0] ?? null;

  const liveDocs = (input.documents ?? []).filter((d) => !["superseded", "deleted"].includes(d.status));
  const anyDoc = liveDocs.length > 0;
  const docsAccepted = anyDoc && liveDocs.every((d) => d.status === "accepted");

  const passedIdv = (input.verification_checks ?? [])
    .filter((c) => c.status === "passed" && ["electronic_idv", "document_sighting", "dvs"].includes(c.check_type))
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))[0] ?? null;

  const subjects = input.screening_subjects ?? [];
  const terminal = new Set(["completed", "false_positive", "confirmed_match", "not_required"]);
  const screeningDone = subjects.length > 0 && subjects.every((s) => terminal.has(s.state));

  const owners = input.owners ?? [];
  const ownershipDone = owners.length > 0 &&
    owners.every((o) => ["verified", "waived"].includes(String(o.verification_state)));

  const sofAt = maxDate((input.source_of_funds ?? []).filter((r) => r.verified).map((r) => r.verified_at));
  const sowAt = maxDate((input.source_of_wealth ?? []).filter((r) => r.verified).map((r) => r.verified_at));
  const eddDone = (input.edd_cases ?? []).filter((e) => e.status === "completed");
  const fundingAt = maxDate([sofAt, sowAt]);

  // "Compliance review completed" is evidenced by issuance itself: an
  // attestation may only be issued from an explicitly approved gate, so the
  // review is proven by the same record rather than asserted separately.
  const reviewAt = firstIssue;

  const relianceFor = (key: "finance" | "solicitor" | "builder") => {
    const a = (input.assessments ?? [])
      .filter((x) => x.status === "satisfied" && x.decided_at && orgTypeKey(x.partner_org_type) === key)
      .sort((x, y) => String(y.decided_at).localeCompare(String(x.decided_at)))[0];
    return a ?? null;
  };
  const fin = relianceFor("finance");
  const sol = relianceFor("solicitor");
  const bld = relianceFor("builder");

  const settled = (input.transactions ?? []).filter((t) => t.status === "settled" && t.settlement_date);
  const settledAt = maxDate(settled.map((t) => t.settlement_date));

  const partnerActor = (a: { assessor_name: string | null; partner_org_name: string | null } | null) =>
    // The individual assessor at ANOTHER organisation is that organisation's
    // record, so only the Command Centre reads a name here.
    audience === "command" ? (a?.assessor_name ?? a?.partner_org_name ?? null) : (a?.partner_org_name ?? null);

  /**
   * Client-safe overrides. A client may know a milestone happened; they must
   * not receive the internal vocabulary the operational copy uses ("sanctions",
   * "PEP", "risk assessment"). Same fact, their words.
   */
  const CLIENT_WORDING: Partial<Record<JourneyMilestoneCode, Partial<Pick<JourneyMilestone, "title" | "detail" | "feeds">>>> = {
    screening: {
      title: "Background checks completed",
      detail: "The required background checks were completed for everyone identified on your case.",
      feeds: "Compliance summary",
    },
    review: {
      title: "Compliance review completed",
      detail: "Your adviser's compliance team completed their review of the information you provided.",
      feeds: "Compliance summary",
    },
    funding: {
      title: "Funding information reviewed",
      detail: "The information you provided about how the purchase is funded was reviewed.",
      feeds: "Compliance summary",
    },
    finance_reliance: {
      title: "Finance partner accepted your Passport",
      detail: "Your finance partner reviewed your Compliance Passport and accepted it.",
      feeds: "Partner access",
    },
    solicitor_reliance: {
      title: "Solicitor accepted your Passport",
      detail: "Your solicitor or conveyancer reviewed your Compliance Passport and accepted it.",
      feeds: "Partner access",
    },
    builder_reliance: {
      title: "Builder accepted your Passport",
      detail: "Your builder or developer reviewed your Compliance Passport and accepted it.",
      feeds: "Partner access",
    },
  };

  const defs: Array<Omit<JourneyMilestone, "ordinal">> = [
    {
      code: "consent", phase: "client_verification",
      title: "Client verification initiated",
      detail: "Privacy and compliance consent captured with device and IP record.",
      feeds: "Identity · Journey record", portal: "Client Portal",
      recorded: Boolean(consent), at: consent?.accepted_at ?? null,
      actor: consent?.actor_label ?? null,
    },
    {
      code: "evidence_supplied", phase: "client_verification",
      title: "Identity and entity evidence supplied",
      detail: "Identity and supporting documents provided for the customer and related parties.",
      feeds: "Evidence wallet · Identity", portal: "Client Portal",
      recorded: anyDoc,
      at: maxDate(liveDocs.map((d) => d.created_at ?? d.reviewed_at)),
      actor: null,
    },
    {
      code: "identity_verified", phase: "compliance_assessment",
      title: "Identity verification completed",
      detail: "Document authenticity, facial match, liveness and electronic verification assessed.",
      feeds: "Verification · Compliance summary", portal: "Command Centre",
      recorded: Boolean(passedIdv), at: passedIdv?.completed_at ?? null, actor: null,
    },
    {
      code: "screening", phase: "compliance_assessment",
      title: "Screening completed",
      detail: "Sanctions, PEP and other relevant screening performed for every identified party.",
      feeds: "Screening · Compliance summary", portal: "System",
      recorded: screeningDone,
      at: maxDate(subjects.map((s) => s.completed_at)), actor: null,
    },
    {
      code: "ownership", phase: "compliance_assessment",
      title: "Ownership and control verified",
      detail: "Beneficial owners and controllers traced and verified to document standard.",
      feeds: "Ownership & control", portal: "Command Centre",
      recorded: ownershipDone, at: maxDate(owners.map((o) => o.verified_at)), actor: null,
    },
    {
      code: "funding", phase: "compliance_assessment",
      title: "Source of funds and wealth reviewed",
      detail: "Composition of the consideration evidenced and assessed.",
      feeds: "Funding & EDD", portal: "Command Centre",
      recorded: Boolean(fundingAt) || eddDone.length > 0,
      at: fundingAt ?? maxDate(eddDone.map((e) => e.completed_at)), actor: null,
    },
    {
      code: "review", phase: "compliance_assessment",
      title: "Compliance review completed",
      detail: "Risk assessment recorded and the service gate approved by the responsible officer.",
      feeds: "Compliance summary", portal: "Command Centre",
      recorded: Boolean(reviewAt), at: reviewAt, actor: null,
    },
    {
      code: "issued", phase: "passport_issuance",
      title: "Passport issued",
      detail: "Evidence manifest sealed and fingerprinted; the Passport becomes available for controlled sharing.",
      feeds: "Client identity · Stamps", portal: "Command Centre",
      recorded: Boolean(firstIssue), at: firstIssue, actor: null,
    },
    {
      code: "finance_reliance", phase: "partner_reliance",
      title: "Finance reliance accepted",
      detail: "The finance partner reviewed the authorised Passport and recorded its own reliance decision.",
      feeds: "Partner access · Stamps", portal: "Finance Portal",
      recorded: Boolean(fin), at: fin?.decided_at ?? null, actor: partnerActor(fin),
    },
    {
      code: "solicitor_reliance", phase: "partner_reliance",
      title: "Solicitor reliance accepted",
      detail: "The solicitor or conveyancer recorded its own reliance decision.",
      feeds: "Partner access · Stamps", portal: "Solicitor Portal",
      recorded: Boolean(sol), at: sol?.decided_at ?? null, actor: partnerActor(sol),
    },
    {
      code: "builder_reliance", phase: "partner_reliance",
      title: "Builder / developer reliance accepted",
      detail: "The builder or developer recorded its own reliance decision.",
      feeds: "Partner access · Stamps", portal: "Builder Portal",
      recorded: Boolean(bld), at: bld?.decided_at ?? null, actor: partnerActor(bld),
    },
    {
      code: "settlement", phase: "transaction_completion",
      title: "Settlement confirmed",
      detail: "On confirmed settlement the Passport receives its final transaction seal and is retained.",
      feeds: "Transaction · Stamps", portal: "System",
      recorded: settled.length > 0, at: settledAt, actor: null,
    },
  ];

  const withOrdinals: JourneyMilestone[] = defs.map((d, i) => ({
    ...d,
    ...(audience === "client" ? (CLIENT_WORDING[d.code] ?? {}) : {}),
    ordinal: String(i + 1).padStart(2, "0"),
  }));

  const phases: JourneyPhaseGroup[] = PHASE_ORDER.map((phase) => {
    const milestones = withOrdinals.filter((m) => m.phase === phase);
    return {
      phase,
      label: PHASE_LABELS[phase],
      milestones,
      recorded: milestones.filter((m) => m.recorded).length,
      total: milestones.length,
    };
  }).filter((g) => g.total > 0);

  const recorded = withOrdinals.filter((m) => m.recorded).length;
  const total = withOrdinals.length;

  return {
    phases,
    recorded,
    total,
    percent: total === 0 ? 0 : Math.round((recorded / total) * 100),
  };
}
