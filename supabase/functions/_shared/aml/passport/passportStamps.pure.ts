/**
 * Passport stamps — earned from real records, never authored by hand.
 *
 * A stamp is a presentation of something the system already proved: a consent
 * row, a passed verification check, an issued attestation, a partner's
 * recorded assessment, a settled transaction. This module derives stamps from
 * those records directly — it never parses event-log prose, and there is no
 * stamps table to drift. Portal users cannot create, edit or reorder stamps;
 * the only way to earn one is for the underlying record to exist.
 *
 * The vocabulary is CLOSED. A new stamp kind is a reviewed change to
 * `STAMP_VOCABULARY` in this file, nowhere else. Each derived stamp carries a
 * `source` reference (table + id/timestamp) so Command can open the record
 * behind it, and a `client_safe` flag decides whether the client's own view
 * may show it (titles are already safe — the flag exists so partner-sharing
 * visibility remains a deliberate choice, not an accident of vocabulary).
 */

export type PassportStampCode =
  | "client_consent_recorded"
  | "identity_verified"
  | "documents_verified"
  | "ownership_verified"
  | "screening_completed"
  | "source_of_funds_reviewed"
  | "source_of_wealth_reviewed"
  | "edd_completed"
  | "passport_issued"
  | "passport_updated"
  | "passport_superseded"
  | "passport_shared_finance"
  | "passport_shared_solicitor"
  | "passport_shared_builder"
  | "reliance_accepted_finance"
  | "reliance_accepted_solicitor"
  | "reliance_accepted_builder"
  | "independent_cdd_recorded"
  | "passport_refresh_requested"
  | "passport_refresh_completed"
  | "access_revoked"
  | "transaction_completed";

export type PassportStampShape = "circle" | "rect" | "seal";
export type PassportStampTone = "gold" | "green" | "navy" | "blue" | "red";

export type PassportStamp = {
  code: PassportStampCode;
  title: string;
  /** Organisation the stamp speaks for (issuer or the partner itself). */
  org: string;
  /** Portal surface the underlying record came from. */
  portal: string;
  /** Actor label where the record carries one; null for system events. */
  actor: string | null;
  /** ISO timestamp of the underlying record. */
  at: string;
  /** Attestation version current when the record was made (null = pre-issue). */
  version: number | null;
  shape: PassportStampShape;
  tone: PassportStampTone;
  /** Where the stamp came from — Command opens this record. */
  source: { kind: string; id: string | null };
  /** May the client's own Passport view show this stamp? */
  client_safe: boolean;
};

type VocabEntry = {
  title: string;
  shape: PassportStampShape;
  tone: PassportStampTone;
  client_safe: boolean;
};

export const STAMP_VOCABULARY: Record<PassportStampCode, VocabEntry> = {
  client_consent_recorded: { title: "CLIENT CONSENT RECORDED", shape: "rect", tone: "navy", client_safe: true },
  identity_verified: { title: "IDENTITY VERIFIED", shape: "circle", tone: "gold", client_safe: true },
  documents_verified: { title: "DOCUMENTS VERIFIED", shape: "rect", tone: "gold", client_safe: true },
  ownership_verified: { title: "OWNERSHIP VERIFIED", shape: "seal", tone: "gold", client_safe: true },
  screening_completed: { title: "SCREENING COMPLETED", shape: "rect", tone: "navy", client_safe: true },
  source_of_funds_reviewed: { title: "SOURCE OF FUNDS REVIEWED", shape: "rect", tone: "green", client_safe: true },
  source_of_wealth_reviewed: { title: "SOURCE OF WEALTH REVIEWED", shape: "rect", tone: "green", client_safe: true },
  edd_completed: { title: "ENHANCED DUE DILIGENCE COMPLETED", shape: "rect", tone: "navy", client_safe: false },
  passport_issued: { title: "PASSPORT ISSUED", shape: "circle", tone: "green", client_safe: true },
  passport_updated: { title: "PASSPORT UPDATED", shape: "circle", tone: "gold", client_safe: true },
  passport_superseded: { title: "PASSPORT VERSION SUPERSEDED", shape: "rect", tone: "navy", client_safe: true },
  passport_shared_finance: { title: "FINANCE PASSPORT SHARED", shape: "rect", tone: "blue", client_safe: true },
  passport_shared_solicitor: { title: "SOLICITOR PASSPORT SHARED", shape: "rect", tone: "blue", client_safe: true },
  passport_shared_builder: { title: "BUILDER / DEVELOPER PASSPORT SHARED", shape: "rect", tone: "blue", client_safe: true },
  reliance_accepted_finance: { title: "FINANCE RELIANCE ACCEPTED", shape: "seal", tone: "blue", client_safe: true },
  reliance_accepted_solicitor: { title: "SOLICITOR RELIANCE ACCEPTED", shape: "seal", tone: "blue", client_safe: true },
  reliance_accepted_builder: { title: "BUILDER / DEVELOPER RELIANCE ACCEPTED", shape: "seal", tone: "blue", client_safe: true },
  independent_cdd_recorded: { title: "INDEPENDENT CDD RECORDED", shape: "rect", tone: "blue", client_safe: true },
  passport_refresh_requested: { title: "PASSPORT REFRESH REQUESTED", shape: "rect", tone: "navy", client_safe: true },
  // The refresh being ASKED FOR and the refresh being DONE are two different
  // facts, and only the first had a stamp — so a completed obligation still
  // read as an outstanding request for ever. `completed_at` is the record.
  passport_refresh_completed: { title: "PASSPORT REFRESHED", shape: "circle", tone: "gold", client_safe: true },
  access_revoked: { title: "ACCESS REVOKED", shape: "rect", tone: "red", client_safe: true },
  transaction_completed: { title: "TRANSACTION COMPLETED", shape: "circle", tone: "green", client_safe: true },
};

/* ── how a stamp face is inked (the approved design's own rule) ─────────── */

/**
 * The design inks a stamp by **what it speaks for**, not by a per-code palette.
 *
 * `AML Compliance Passport.dc.html` derives it in one line:
 *
 *   org !== 'AURIXA SYSTEMS' ? 'partner'
 *     : /TRANSACTION COMPLETED|PASSPORT ISSUED/.test(title) ? 'final'
 *     : 'gold'
 *
 * Three inks, and the reasoning is legible on the page: gold is the issuing
 * entity's own certification, blue is somebody else's decision recorded in our
 * register, green is a terminal certification — the Passport issued, and the
 * matter completed. Reproduced here against the CODE rather than the title so
 * a wording change cannot silently repaint a stamp, and against the issuer
 * passed in rather than a literal so it holds for any tenant.
 */
export type StampFaceTone = "gold" | "partner" | "final";

export function stampFaceTone(
  stamp: { code: PassportStampCode; org: string },
  issuerOrg: string,
): StampFaceTone {
  if (stamp.org && issuerOrg && stamp.org !== issuerOrg) return "partner";
  if (stamp.code === "passport_issued" || stamp.code === "transaction_completed") return "final";
  return "gold";
}

/* ── the ink a die is charged with ─────────────────────────────────────── */

/**
 * Seven inks, and every one of them means something.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 * `STAMP_VOCABULARY` has carried a per-code `tone` since it was written —
 * navy, gold, green, blue, red — and the die threw all of it away.
 * `stampFaceTone` collapsed twenty-two certifications into three inks, and
 * because the issuer strikes nearly all of them, a real register rendered as
 * five gold rectangles and one green circle. The colour was in the data; the
 * page simply never asked for it.
 *
 * ── The two axes, and why they stay separate ─────────────────────────
 * AUTHORITY comes first and is unchanged: a stamp that speaks for somebody
 * else is inked `partner`, whatever it certifies. That is a security property
 * — a reader must be able to see at a glance which impressions are ours — so
 * it is still decided by `stampFaceTone` and this function defers to it
 * rather than re-deriving it.
 *
 * SUBJECT decides the rest. What a certification is ABOUT is the most useful
 * thing a colour can say on a page of them, and it is stable: a code's
 * subject cannot change without the code changing.
 *
 *   gold      the issuer's own identity and document work
 *   azure     screening against an external register
 *   violet    consent and authority given by the customer
 *   emerald   funding — source of funds, wealth, enhanced due diligence
 *   final     terminal certifications: the Passport issued, the matter done
 *   partner   somebody else's decision recorded in our register
 *   alert     something withdrawn, superseded or outstanding
 *
 * ── Why not just use the vocabulary's own tone ───────────────────────
 * Because it is coarser than the meaning. It inks `source_of_funds_reviewed`
 * green, the same green as `passport_issued`, and a funding review that looks
 * identical to the terminal certification is exactly the confusion a colour
 * system is supposed to remove. The vocabulary's tone drives the wax seals,
 * which are decorative; the die needs the finer reading.
 */
export type StampInk =
  | "gold" | "azure" | "violet" | "emerald" | "final" | "partner" | "alert";

const STAMP_INK: Record<PassportStampCode, StampInk> = {
  client_consent_recorded: "violet",

  identity_verified: "gold",
  documents_verified: "gold",
  ownership_verified: "gold",
  passport_updated: "gold",
  passport_refresh_completed: "gold",

  screening_completed: "azure",

  source_of_funds_reviewed: "emerald",
  source_of_wealth_reviewed: "emerald",
  edd_completed: "emerald",

  passport_issued: "final",
  transaction_completed: "final",

  passport_shared_finance: "partner",
  passport_shared_solicitor: "partner",
  passport_shared_builder: "partner",
  reliance_accepted_finance: "partner",
  reliance_accepted_solicitor: "partner",
  reliance_accepted_builder: "partner",
  independent_cdd_recorded: "partner",

  access_revoked: "alert",
  passport_superseded: "alert",
  passport_refresh_requested: "alert",
};

/**
 * The ink for one impression.
 *
 * Authority is asked first and answered by `stampFaceTone`, so there is one
 * rule about whose certification a stamp is and this cannot drift from it.
 * Everything else is the subject.
 */
export function stampInk(
  stamp: { code: PassportStampCode; org: string },
  issuerOrg: string,
): StampInk {
  if (stampFaceTone(stamp, issuerOrg) === "partner") return "partner";
  return STAMP_INK[stamp.code] ?? "gold";
}

/**
 * The design rotates each impression by a fixed amount taken from its position
 * — `[-6, 3, -2.5, 4.5, -4][i % 5]`. Struck impressions are never square to
 * the page, and a random angle would move on every render.
 */
const STAMP_ROTATIONS = [-6, 3, -2.5, 4.5, -4];

export function stampRotation(index: number): number {
  return STAMP_ROTATIONS[((index % STAMP_ROTATIONS.length) + STAMP_ROTATIONS.length) % STAMP_ROTATIONS.length];
}

/* ── source facts (rows the edge function already fetched) ──────────────── */

export type StampConsentFact = { id: string | null; kind: string; accepted_at: string | null; actor_label?: string | null };
export type StampCheckFact = {
  id: string | null; party_label: string | null; check_type: string; status: string; completed_at: string | null;
  /**
   * The stored objects for this attempt, for the ONE image the Passport may
   * show — the face the provider extracted from the identity document.
   *
   * Optional and read only through `identityPortrait.pure.ts`, which is an
   * allow-list of one key: the document page and the selfie are named there
   * as withheld rather than merely omitted. Absent on every check recorded
   * before portraits were stored, and on every hosted-provider check, where
   * NPC deliberately holds no copy of anything.
   */
  capture_objects?: unknown;
  /** NPC's own vocabulary for the document, e.g. `passport`. */
  document_choice?: string | null;
  /** ISO 3166-1 alpha-3, as the provider read it off the document. */
  issuing_state?: string | null;
  /**
   * The stamp left by a completed portrait backfill attempt, where one ran.
   *
   * It is what separates "the photograph is on its way" from "the document
   * was read and carried none" on the Client Identity page — an absence that
   * will resolve itself from one that will not.
   */
  portrait_backfill?: unknown;
};
export type StampDocumentFact = { status: string; reviewed_at?: string | null; created_at?: string | null };
export type StampScreeningFact = { state: string; completed_at?: string | null };
export type StampOwnershipFact = { verification_state: string | null; verified_at?: string | null };
export type StampSofFact = { verified: boolean | null; verified_at: string | null };
export type StampEddFact = { status: string; completed_at?: string | null };
export type StampGrantFact = {
  id: string | null;
  created_at: string | null;
  revoked_at: string | null;
  partner_org_name: string | null;
  partner_org_type: string | null; // finance | builder | developer | solicitor_conveyancer | other
  attestation_version: number | null;
};
export type StampAssessmentFact = {
  id: string | null;
  status: string; // satisfied | not_satisfied | records_requested
  decided_at: string | null;
  assessor_name: string | null;
  partner_org_name: string | null;
  partner_org_type: string | null;
};
export type StampRefreshFact = {
  id: string | null;
  created_at: string | null;
  status: string;
  completed_at?: string | null;
  cancelled_at?: string | null;
  due_at?: string | null;
};
export type StampTransactionFact = { id: string | null; status: string; settlement_date: string | null; property_address?: string | null };

export type PassportStampInput = {
  issuer_org: string;
  attestations: Array<{ version: number; issued_at: string | null; superseded_at: string | null }>;
  consents: StampConsentFact[];
  verification_checks: StampCheckFact[];
  documents: StampDocumentFact[];
  screening_subjects: StampScreeningFact[];
  owners: StampOwnershipFact[];
  source_of_funds: StampSofFact[];
  source_of_wealth: StampSofFact[];
  edd_cases: StampEddFact[];
  grants: StampGrantFact[];
  assessments: StampAssessmentFact[];
  refresh_obligations: StampRefreshFact[];
  transactions: StampTransactionFact[];
};

/* ── derivation ─────────────────────────────────────────────────────────── */

const PORTAL_BY_ORG_TYPE: Record<string, string> = {
  finance: "Finance Portal",
  solicitor_conveyancer: "Solicitor Portal",
  builder: "Builder / Developer Portal",
  developer: "Builder / Developer Portal",
};

function orgTypeKey(t: string | null): "finance" | "solicitor" | "builder" | null {
  if (t === "finance") return "finance";
  if (t === "solicitor_conveyancer") return "solicitor";
  if (t === "builder" || t === "developer") return "builder";
  return null;
}

/** Latest version whose issue predates `at` — pre-issue records bind to null. */
function versionAt(
  attestations: PassportStampInput["attestations"],
  at: string | null,
): number | null {
  if (!at) return null;
  let best: number | null = null;
  for (const a of attestations) {
    if (a.issued_at && a.issued_at <= at && (best === null || a.version > best)) best = a.version;
  }
  return best;
}

function maxDate(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (!best || v > best)) best = v;
  return best;
}

export function derivePassportStamps(input: PassportStampInput): PassportStamp[] {
  const issuer = input.issuer_org || "Aurixa Systems";
  const stamps: PassportStamp[] = [];
  const V = (at: string | null) => versionAt(input.attestations ?? [], at);

  const make = (
    code: PassportStampCode,
    at: string | null,
    over: Partial<Pick<PassportStamp, "org" | "portal" | "actor" | "source" | "version">>,
  ) => {
    if (!at) return; // no record time = no stamp; a stamp without provenance is decoration
    const vocab = STAMP_VOCABULARY[code];
    stamps.push({
      code,
      title: vocab.title,
      org: over.org ?? issuer,
      portal: over.portal ?? "Command Centre",
      actor: over.actor ?? null,
      at,
      version: over.version !== undefined ? over.version : V(at),
      shape: vocab.shape,
      tone: vocab.tone,
      source: over.source ?? { kind: "derived", id: null },
      client_safe: vocab.client_safe,
    });
  };

  // Consent — the first recorded client consent of any kind.
  const firstConsent = [...input.consents]
    .filter((c) => c.accepted_at)
    .sort((a, b) => String(a.accepted_at).localeCompare(String(b.accepted_at)))[0];
  if (firstConsent) {
    make("client_consent_recorded", firstConsent.accepted_at, {
      portal: "Client Portal",
      actor: firstConsent.actor_label ?? null,
      source: { kind: "aml.consents", id: firstConsent.id },
    });
  }

  // Identity verified — a passed identity check of any accepted kind exists.
  const passedIdv = input.verification_checks
    .filter((c) => c.status === "passed" && ["electronic_idv", "document_sighting", "dvs"].includes(c.check_type))
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))[0];
  if (passedIdv) {
    make("identity_verified", passedIdv.completed_at, {
      source: { kind: "aml.verification_checks", id: passedIdv.id },
    });
  }

  // Documents verified — every non-superseded document accepted, at least one.
  const liveDocs = input.documents.filter((d) => !["superseded", "deleted"].includes(d.status));
  if (liveDocs.length > 0 && liveDocs.every((d) => d.status === "accepted")) {
    make("documents_verified", maxDate(liveDocs.map((d) => d.reviewed_at ?? d.created_at)), {
      source: { kind: "aml.documents", id: null },
    });
  }

  // Ownership verified — at least one owner and none unresolved.
  const owners = input.owners ?? [];
  if (
    owners.length > 0 &&
    owners.every((o) => ["verified", "waived"].includes(String(o.verification_state)))
  ) {
    make("ownership_verified", maxDate(owners.map((o) => o.verified_at)), {
      source: { kind: "aml.beneficial_owners", id: null },
    });
  }

  // Screening completed — every subject reached a terminal, non-error state.
  const subjects = input.screening_subjects ?? [];
  const screeningDone = subjects.length > 0 &&
    subjects.every((s) => ["completed", "false_positive", "confirmed_match", "not_required"].includes(s.state));
  if (screeningDone) {
    make("screening_completed", maxDate(subjects.map((s) => s.completed_at)), {
      portal: "System",
      source: { kind: "aml.party_screening_subjects", id: null },
    });
  }

  // Source of funds / wealth — at least one verified row each.
  const sofAt = maxDate(input.source_of_funds.filter((r) => r.verified).map((r) => r.verified_at));
  if (sofAt) make("source_of_funds_reviewed", sofAt, { source: { kind: "aml.source_of_funds", id: null } });
  const sowAt = maxDate(input.source_of_wealth.filter((r) => r.verified).map((r) => r.verified_at));
  if (sowAt) make("source_of_wealth_reviewed", sowAt, { source: { kind: "aml.source_of_wealth", id: null } });

  // EDD completed — only when an EDD case existed and completed.
  const eddDone = input.edd_cases.filter((e) => e.status === "completed");
  if (eddDone.length > 0) {
    make("edd_completed", maxDate(eddDone.map((e) => e.completed_at)), {
      source: { kind: "aml.edd_cases", id: null },
    });
  }

  // Issuance lineage: v1 = issued; later versions = updated; every
  // superseded version also records its supersession.
  const sorted = [...(input.attestations ?? [])].sort((a, b) => a.version - b.version);
  for (const a of sorted) {
    if (a.issued_at) {
      make(a.version === (sorted[0]?.version ?? 1) ? "passport_issued" : "passport_updated", a.issued_at, {
        version: a.version,
        source: { kind: "aml.compliance_attestations", id: null },
      });
    }
    if (a.superseded_at) {
      make("passport_superseded", a.superseded_at, {
        version: a.version,
        portal: "System",
        source: { kind: "aml.compliance_attestations", id: null },
      });
    }
  }

  // Partner sharing and revocation — from grants.
  for (const g of input.grants ?? []) {
    const key = orgTypeKey(g.partner_org_type);
    if (key && g.created_at) {
      make(`passport_shared_${key}` as PassportStampCode, g.created_at, {
        portal: PORTAL_BY_ORG_TYPE[g.partner_org_type ?? ""] ?? "Command Centre",
        version: g.attestation_version ?? V(g.created_at),
        source: { kind: "aml.reliance_grants", id: g.id },
      });
    }
    if (g.revoked_at) {
      make("access_revoked", g.revoked_at, {
        portal: "Command Centre",
        actor: g.partner_org_name,
        source: { kind: "aml.reliance_grants", id: g.id },
      });
    }
  }

  // Partner decisions — the partner's own stamp, attributed to the partner.
  for (const a of input.assessments ?? []) {
    if (!a.decided_at) continue;
    const key = orgTypeKey(a.partner_org_type);
    if (a.status === "satisfied" && key) {
      make(`reliance_accepted_${key}` as PassportStampCode, a.decided_at, {
        org: a.partner_org_name ?? "Partner organisation",
        portal: PORTAL_BY_ORG_TYPE[a.partner_org_type ?? ""] ?? "Partner portal",
        actor: a.assessor_name,
        source: { kind: "aml.independent_assessments", id: a.id },
      });
    } else if (a.status !== "satisfied") {
      // not_satisfied / records_requested both record independent CDD activity;
      // neither is presented as an acceptance.
      make("independent_cdd_recorded", a.decided_at, {
        org: a.partner_org_name ?? "Partner organisation",
        portal: PORTAL_BY_ORG_TYPE[a.partner_org_type ?? ""] ?? "Partner portal",
        actor: a.assessor_name,
        source: { kind: "aml.independent_assessments", id: a.id },
      });
    }
  }

  // Refresh — the ask and the answer are separate records, and a completed
  // obligation earns both: the request happened, and so did the refresh.
  for (const r of input.refresh_obligations ?? []) {
    if (r.created_at) {
      make("passport_refresh_requested", r.created_at, {
        portal: "System",
        source: { kind: "aml.partner_refresh_obligations", id: r.id },
      });
    }
    if (r.completed_at) {
      make("passport_refresh_completed", r.completed_at, {
        source: { kind: "aml.partner_refresh_obligations", id: r.id },
      });
    }
  }

  // Transaction completed — settled transactions only, from canonical status.
  for (const t of input.transactions ?? []) {
    if (t.status === "settled") {
      make("transaction_completed", t.settlement_date, {
        portal: "System",
        source: { kind: "aml.transactions", id: t.id },
      });
    }
  }

  return stamps.sort((a, b) => a.at.localeCompare(b.at));
}

/** The client's own view: vocabulary-flagged subset, same order. */
export function clientSafeStamps(stamps: PassportStamp[]): PassportStamp[] {
  return stamps.filter((s) => s.client_safe);
}

/* ── the certification programme (what is still outstanding) ────────────── */

/**
 * A stamp this case is on track to earn but has not.
 *
 * It deliberately carries **no `at`, no `version`, no `actor` and no
 * `source`** — there is no record behind it, and a pending stamp that looked
 * like an earned one would be the single worst defect this page could have.
 * The types do not overlap, so nothing that counts earned stamps can count one
 * of these by mistake.
 */
export type PendingStamp = {
  code: PassportStampCode;
  title: string;
  shape: PassportStampShape;
  tone: PassportStampTone;
  client_safe: boolean;
  /** What the system is waiting for, in plain words. Never a promise. */
  awaiting: string;
  /** A date a record already carries (settlement, obligation due). */
  expected_at: string | null;
  /** Organisation the outstanding step belongs to, where one is named. */
  org: string | null;
};

/**
 * Facts about the case that decide which stamps are even *applicable*.
 * Separate from `PassportStampInput` because these describe the shape of the
 * engagement rather than the records it has produced.
 */
export type StampProgrammeFacts = {
  /** `individual` | `entity` | … — decides whether ownership applies. */
  subject_type?: string | null;
  /** Case status; a closed case is no longer working toward anything. */
  case_status?: string | null;
  /**
   * Case stage and service gate. These are here because applicability is NOT
   * only a question of which child rows exist. Both live cases in enhanced CDD
   * carry `status = edd_required` / `case_stage = enhanced_cdd` and **zero**
   * `aml.edd_cases` rows — the obligation is declared on the case before any
   * EDD record is opened. Deriving applicability from child rows alone made
   * the register silent about the one certification those cases most obviously
   * owe.
   */
  case_stage?: string | null;
  service_gate_status?: string | null;
};

/**
 * Which codes are milestones of the compliance programme, as opposed to
 * things that merely happen.
 *
 * The distinction is the whole reason this is a list rather than the
 * vocabulary: `ACCESS REVOKED` shown as an empty impression reads as a
 * revocation the system is *waiting for*, and `PASSPORT VERSION SUPERSEDED`
 * as an outcome somebody owes. Neither is anything a case works toward, and
 * neither may ever be drawn as outstanding.
 *
 * Sharing is absent for the same reason in the other direction: a Passport is
 * complete whether or not it is ever shared with a partner, so a pending
 * `FINANCE PASSPORT SHARED` would invent an obligation on the officer.
 */
const PROGRAMME: PassportStampCode[] = [
  "client_consent_recorded",
  "identity_verified",
  "documents_verified",
  "ownership_verified",
  "screening_completed",
  "source_of_funds_reviewed",
  "source_of_wealth_reviewed",
  "edd_completed",
  "passport_issued",
  "reliance_accepted_finance",
  "reliance_accepted_solicitor",
  "reliance_accepted_builder",
  "passport_refresh_completed",
  "transaction_completed",
];

const AWAITING: Record<string, string> = {
  client_consent_recorded: "The client accepts the compliance consents in their portal.",
  identity_verified: "An identity check passes — electronic verification, DVS or a sighted document.",
  documents_verified: "Every requested document is accepted on review.",
  ownership_verified: "Every beneficial owner and controller is verified or waived.",
  screening_completed: "Every party reaches a completed screening outcome.",
  source_of_funds_reviewed: "A source-of-funds record is verified.",
  source_of_wealth_reviewed: "A source-of-wealth record is verified.",
  edd_completed: "The enhanced due diligence case is completed.",
  passport_issued: "The responsible compliance officer issues the Passport.",
  passport_refresh_completed: "The outstanding refresh obligation is completed.",
  transaction_completed: "Settlement of the linked transaction is confirmed.",
};

const ENTITY_SUBJECTS = new Set(["entity", "company", "trust", "partnership", "association"]);

/**
 * Derive what this case has NOT yet earned.
 *
 * The Passport page previously drew earned stamps and stopped, which cannot
 * distinguish "this case has one certification" from "this case is one of
 * fourteen certifications through". Both render as a single seal on an
 * otherwise empty page. Production makes that concrete: of five live cases,
 * the best-covered earns two stamps and one earns none at all.
 *
 * Nothing here invents a record. A pending entry is a statement about the
 * *absence* of one, and every entry is conditional on the case genuinely
 * having that dimension — an individual is never shown a pending ownership
 * seal, and a case with no EDD is never shown a pending EDD seal.
 */
export function derivePendingStamps(
  input: PassportStampInput,
  earned: PassportStamp[],
  facts: StampProgrammeFacts = {},
): PendingStamp[] {
  const has = new Set(earned.map((s) => s.code));

  // A finished engagement is finished, whatever it did or did not collect.
  // Listing what it will never now earn reads as an open action list on a file
  // nobody is working — a closed case, or one whose service gate has been
  // terminated, owes nothing.
  if (facts.case_status === "closed" || facts.service_gate_status === "terminated") return [];

  const isEntity = ENTITY_SUBJECTS.has(String(facts.subject_type ?? "").toLowerCase()) ||
    (input.owners ?? []).length > 0;

  // The case ITSELF can declare enhanced due diligence, and in production that
  // is the only place it is declared: two live cases sit at `edd_required` /
  // `enhanced_cdd` with no `aml.edd_cases` row at all.
  const eddDeclared = facts.case_status === "edd_required" || facts.case_stage === "enhanced_cdd";
  const eddRecorded = (input.edd_cases ?? []).length > 0;
  const hasSow = (input.source_of_wealth ?? []).length > 0;

  // A partner we shared with, who has not yet recorded a decision.
  const decided = new Set(
    (input.assessments ?? [])
      .filter((a) => a.decided_at)
      .map((a) => orgTypeKey(a.partner_org_type))
      .filter(Boolean) as string[],
  );
  const awaitingPartner = new Map<string, string | null>();
  for (const g of input.grants ?? []) {
    const key = orgTypeKey(g.partner_org_type);
    if (!key || !g.created_at || g.revoked_at) continue;
    if (decided.has(key)) continue;
    if (!awaitingPartner.has(key)) awaitingPartner.set(key, g.partner_org_name);
  }

  const openRefresh = (input.refresh_obligations ?? []).find(
    (r) => !r.completed_at && !r.cancelled_at && r.status !== "cancelled",
  );
  const unsettled = (input.transactions ?? []).find(
    (t) => t.status !== "settled" && t.status !== "cancelled" && t.status !== "withdrawn",
  );

  const applies = (code: PassportStampCode): boolean => {
    switch (code) {
      case "ownership_verified": return isEntity;
      // Deliberately RECORD-driven, and not from `eddDeclared`. Source of
      // wealth is client-visible; enhanced due diligence is not. Letting the
      // declared EDD state raise a client-visible item would turn the client's
      // own Passport into an inference channel for a Command-only fact — the
      // declaration drives `edd_completed` alone, which `client_safe: false`
      // strips before the client ever sees it.
      case "source_of_wealth_reviewed": return hasSow || eddRecorded;
      case "edd_completed": return eddRecorded || eddDeclared;
      case "reliance_accepted_finance": return awaitingPartner.has("finance");
      case "reliance_accepted_solicitor": return awaitingPartner.has("solicitor");
      case "reliance_accepted_builder": return awaitingPartner.has("builder");
      case "passport_refresh_completed": return Boolean(openRefresh);
      case "transaction_completed": return Boolean(unsettled);
      default: return true;
    }
  };

  const expected = (code: PassportStampCode): string | null => {
    if (code === "transaction_completed") return unsettled?.settlement_date ?? null;
    if (code === "passport_refresh_completed") return openRefresh?.due_at ?? null;
    return null;
  };

  const org = (code: PassportStampCode): string | null => {
    if (code === "reliance_accepted_finance") return awaitingPartner.get("finance") ?? null;
    if (code === "reliance_accepted_solicitor") return awaitingPartner.get("solicitor") ?? null;
    if (code === "reliance_accepted_builder") return awaitingPartner.get("builder") ?? null;
    return null;
  };

  const out: PendingStamp[] = [];
  for (const code of PROGRAMME) {
    // `passport_refresh_completed` is the one code that can be both earned
    // (a past refresh) and pending (a new obligation), so it is tested
    // against the open obligation rather than against history.
    if (code !== "passport_refresh_completed" && has.has(code)) continue;
    if (!applies(code)) continue;
    const vocab = STAMP_VOCABULARY[code];
    out.push({
      code,
      title: vocab.title,
      shape: vocab.shape,
      tone: vocab.tone,
      client_safe: vocab.client_safe,
      awaiting: AWAITING[code] ?? "This certification has not yet been earned.",
      expected_at: expected(code),
      org: org(code),
    });
  }
  return out;
}

/** Same audience rule as earned stamps — the vocabulary flag decides. */
export function clientSafePending(pending: PendingStamp[]): PendingStamp[] {
  return pending.filter((p) => p.client_safe);
}

/* ── client stamp facts ─────────────────────────────────────────────────── */

export type ClientStampFacts = {
  issuer_org: string;
  attestations: PassportStampInput["attestations"];
  consents: StampConsentFact[];
  verification_checks: StampCheckFact[];
  documents: StampDocumentFact[];
  grants: StampGrantFact[];
  assessments: StampAssessmentFact[];
  refresh_obligations: StampRefreshFact[];
  transactions: StampTransactionFact[];
  /** The CURRENT attestation's sanitised payload (v1 or v2 shape), if issued. */
  attestation_payload: Record<string, unknown> | null;
};

/**
 * Assemble the stamp input for the CLIENT audience.
 *
 * The client portal function is contract-bound never to read the restricted
 * case families — not even their table names may appear in its source. So
 * the client's post-issuance milestone facts come from the ISSUED, SANITISED
 * attestation payload instead: what the MLRO attested outward is exactly
 * what the client may see. Before issuance the client earns only the stamps
 * their own actions produce (consent, identity, documents). Families the
 * payload does not carry stay empty — an empty family means "no stamp",
 * never "invent one".
 */
export function buildClientStampInput(facts: ClientStampFacts): PassportStampInput {
  const payload = facts.attestation_payload;
  const performedBlock = payload && typeof payload === "object"
    ? (payload as Record<string, any>).screening ?? null
    : null;
  const attestedComplete: StampScreeningFact[] = performedBlock && performedBlock.performed
    ? [{ state: "completed", completed_at: performedBlock.last_performed_at ?? null }]
    : [];

  return {
    issuer_org: facts.issuer_org,
    attestations: facts.attestations,
    consents: facts.consents,
    verification_checks: facts.verification_checks,
    documents: facts.documents,
    screening_subjects: attestedComplete,
    owners: [],
    source_of_funds: [],
    source_of_wealth: [],
    edd_cases: [],
    grants: facts.grants,
    assessments: facts.assessments,
    refresh_obligations: facts.refresh_obligations,
    transactions: facts.transactions,
  };
}
