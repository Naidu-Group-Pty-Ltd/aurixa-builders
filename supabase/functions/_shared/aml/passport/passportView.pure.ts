/**
 * Passport view — the ONE projection that turns authoritative AML records
 * into audience-safe Passport view models.
 *
 * Three audiences, one assembler:
 *   command — richest AUTHORISED view (still not raw database access);
 *   client  — a dedicated server-side sanitised projection. Never the command
 *             payload with fields hidden by the browser;
 *   partner — a relying entity under a written CDD arrangement. It carries
 *             the CDD OUTCOMES, because that is the whole point of s 37A
 *             reliance: a partner who cannot see what was performed and what
 *             it concluded has to repeat the customer due diligence, which
 *             is the cost the arrangement exists to avoid. It is built from
 *             the same records as the command view and stripped by its own
 *             allow-list; `assertPartnerSafe` fails closed.
 *
 * The partner audience replaced a hand-composed booklet built from the
 * attestation payload. Two assemblies of one document eventually disagree
 * about it — these did: one had sixteen leaves and the other eight, with
 * different titles, and a partner holding both had no way to tell which was
 * the real one. There is one assembler now, and the audience is a parameter.
 *
 * Sanitisation is structural, not cosmetic:
 *   - the client view is BUILT from allow-lists (identity fields, stamp
 *     vocabulary, constructed history) — nothing is copied then redacted;
 *   - `assertClientSafe` deep-scans the finished view for restricted
 *     vocabulary and FAILS CLOSED (throws) if any is found, so a future
 *     accidental widening cannot ship silently. Contract tests pin this.
 *
 * Never in ANY projection produced here: screening match content, risk
 *   ratings/scores, analyst/reviewer/MLRO reasoning, SMR/suspicion material,
 *   provider payloads or secrets, biometric media/scores, storage paths.
 * Additionally never in the CLIENT view: screening/PEP detail of any kind,
 *   funding review detail, EDD reasoning, partner internal assessment notes,
 *   raw case-event summaries (client history is constructed from stamps and
 *   the client's own requests instead).
 */

import {
  derivePassportState,
  type PassportAttestationFact,
  type PassportStateResult,
  versionRegisterState,
  type PassportVersionState,
} from "./passportState.pure.ts";
import {
  clientSafePending,
  clientSafeStamps,
  derivePassportStamps,
  derivePendingStamps,
  type PassportStamp,
  type PassportStampInput,
  type PendingStamp,
} from "./passportStamps.pure.ts";
import { passportCredential, passportVersionLabel, shortFingerprint } from "./passportCredential.pure.ts";
import {
  describeIdentityPortrait, describeIdentityPortraitSlot,
  type IdentityPortraitDescriptor, type IdentityPortraitSlot,
} from "./identityPortrait.pure.ts";
import { derivePassportJourney, type PassportJourney } from "./passportJourney.pure.ts";

export type PassportAudience = "command" | "client" | "partner";

/* ── input row shapes (tight selects, fetched by the edge function) ─────── */

export type PassportCaseFact = {
  id: string;
  case_reference: string | null;
  subject_display_name: string | null;
  subject_type: string | null;
  status: string | null;
  case_stage: string | null;
  service_gate_status: string | null;
  opened_at: string | null;
  closed_at: string | null;
};

export type PassportDocumentFact = {
  id: string;
  requirement_label: string | null;
  requirement_code: string | null;
  required: boolean | null;
  status: string;
  created_at: string | null;
  version_number: number | null;
};

export type PassportTransactionFact = {
  id: string;
  kind: string | null;
  status: string | null;
  property_address: string | null;
  contract_date: string | null;
  settlement_date: string | null;
  purchase_price: number | null;
};

export type PassportOwnershipFact = {
  /** Party name. Command and client both see who; neither sees internals. */
  name: string;
  /** beneficial_owner | authorised_representative | entity */
  party_kind: string;
  relationship: string | null;
  ownership_percent: number | null;
  control_type: string | null;
  is_ubo: boolean | null;
  verification_state: string | null;
};

/** One evidence class a partner organisation may receive. */
export type PassportDisclosureFact = {
  code: string;
  /** granted | limited | withheld — built from the manifest, never guessed. */
  state: "granted" | "limited" | "withheld";
};

export type PassportPartnerFact = {
  org_name: string | null;
  org_type: string | null;
  portal_type: string | null;
  link_state: string | null;
  legal_route: string | null;
  grant_created_at: string | null;
  grant_expires_at: string | null;
  grant_revoked_at: string | null;
  attestation_version: number | null;
  last_viewed_at: string | null;
  assessment_status: string | null;
  assessment_decided_at: string | null;
  assessor_name: string | null;
  /** Authorised disclosure for this organisation (v2 manifests only). */
  disclosure?: PassportDisclosureFact[];
};

export type PassportEventFact = {
  id: string;
  category: string;
  summary: string;
  actor_label: string | null;
  created_at: string;
};

export type PassportClientRequestFact = {
  id: string;
  kind: string;
  subject: string | null;
  status: string;
  created_at: string;
};

export type PassportViewInput = {
  issuer_org: string;
  officer_label: string | null;
  case: PassportCaseFact;
  attestations: PassportAttestationFact[];
  material_inputs_current: boolean | null;
  open_refresh_obligations: number;
  /** questionnaire payloads, exactly as stored; allow-listed here. */
  personal_details: Record<string, unknown> | null;
  entity_details: Record<string, unknown> | null;
  documents: PassportDocumentFact[];
  transactions: PassportTransactionFact[];
  /** Parties in the control structure. Empty = nothing to show, never faked. */
  ownership?: PassportOwnershipFact[];
  /** Command-only families; omit entirely for the client audience. */
  screening?: {
    subjects: Array<{ state: string; completed_at?: string | null; party_label?: string | null }>;
    pep_result: string | null;
    pep_determined_at: string | null;
    list_freshness: Record<string, string>;
  } | null;
  funding?: {
    sof: Array<{ verified: boolean | null; verified_at: string | null }>;
    sow: Array<{ verified: boolean | null; verified_at: string | null }>;
    edd: Array<{ status: string; completed_at?: string | null }>;
  } | null;
  partners?: PassportPartnerFact[] | null;
  events?: PassportEventFact[] | null;
  client_requests: PassportClientRequestFact[];
  stamp_input: PassportStampInput;
};

/* ── view model ─────────────────────────────────────────────────────────── */

export type PassportVersionRow = {
  version: number;
  label: string | null;
  state: PassportVersionState;
  issued_at: string | null;
  superseded_at: string | null;
  fingerprint_short: string | null;
  schema_version: number | null;
};

export type PassportView = {
  audience: PassportAudience;
  header: {
    credential: string | null;
    case_reference: string | null;
    subject: string | null;
    subject_type: string | null;
    issuer_org: string;
    officer_label: string | null;
    state: PassportStateResult;
    current_version_label: string | null;
    evidence_fingerprint: string | null;
    evidence_fingerprint_short: string | null;
    first_issued_at: string | null;
    last_issued_at: string | null;
    opened_at: string | null;
  };
  versions: PassportVersionRow[];
  identity: {
    fields: Array<{ key: string; label: string; value: string }>;
    /**
     * The holder's photograph, on the page that bears their identity.
     *
     * A SLOT rather than a descriptor, and always present: a bio page whose
     * portrait block simply disappears when there is no image reads as a
     * broken page, and gives the reader no way to tell "we hold no
     * photograph" from "this document does not carry one". The slot names
     * which absence it is, including the transient one while the sweep is
     * fetching it. `url` is minted for one reader at the moment of service —
     * see `identityPortrait.pure.ts`.
     */
    portrait: IdentityPortraitSlot;
  };
  verification: {
    parties: Array<{
      party: string;
      verified: boolean;
      method: string | null;
      completed_at: string | null;
      components: Array<{ check_type: string; status: string; completed_at: string | null }>;
      /**
       * The face printed on the identity document, where one is stored.
       *
       * A DESCRIPTOR, never bytes and never a URL: `url` is filled in by the
       * edge function serving this view, for that reader, with a short
       * lifetime. A signed storage URL is a bearer credential, and a
       * credential inside a projection can be persisted, cached or embedded
       * in an attestation payload. See `identityPortrait.pure.ts`.
       *
       * Null is the ordinary case and every surface renders unchanged on it.
       */
      portrait: IdentityPortraitDescriptor | null;
    }>;
  };
  documents: Array<{
    id: string;
    label: string;
    required: boolean;
    status: string;
    uploaded_at: string | null;
    version_number: number | null;
  }>;
  transactions: Array<{
    id: string;
    kind: string | null;
    status: string | null;
    property_address: string | null;
    contract_date: string | null;
    settlement_date: string | null;
    /** Command always; client sees their own purchase figures too. */
    purchase_price: number | null;
  }>;
  /** The journey that produced this record — derived, shared with stamps. */
  journey: PassportJourney;
  ownership: Array<{
    name: string;
    party_kind: string;
    relationship: string | null;
    ownership_percent: number | null;
    control_type: string | null;
    is_ubo: boolean;
    verification_state: string | null;
    verified: boolean;
  }>;
  stamps: PassportStamp[];
  /**
   * The rest of the certification set — what this case is on track to earn
   * and has not. Never mixed into `stamps`: these carry no record, so a
   * consumer that treats one as earned would be asserting a control that was
   * never performed.
   */
  pending_stamps: PendingStamp[];
  /** Command: raw hash-chained events. Client: CONSTRUCTED timeline. */
  history: Array<{
    id: string | null;
    at: string;
    title: string;
    detail: string | null;
    source: string;
  }>;
  /** Command-only sections; structurally absent for the client. */
  screening?: {
    performed: boolean;
    subjects_total: number;
    subjects_completed: number;
    last_completed_at: string | null;
    pep_result: string | null;
    pep_determined_at: string | null;
    list_freshness: Record<string, string>;
  };
  funding?: {
    sof_total: number;
    sof_verified: number;
    sow_total: number;
    sow_verified: number;
    edd_present: boolean;
    edd_completed: boolean;
  };
  partners?: Array<{
    org_name: string | null;
    org_type: string | null;
    portal_type: string | null;
    link_state: string | null;
    legal_route: string | null;
    grant_created_at: string | null;
    grant_expires_at: string | null;
    grant_revoked_at: string | null;
    attestation_version: number | null;
    version_label: string | null;
    last_viewed_at: string | null;
    assessment_status: string | null;
    assessment_decided_at: string | null;
    assessor_name: string | null;
    disclosure: PassportDisclosureFact[];
  }>;
  open_requests: PassportClientRequestFact[];
};

/* ── identity allow-lists (questionnaire keys are the contract) ─────────── */

// personal_details deliberately EXCLUDES `pep` and `adverse`: they are
// screening-adjacent self-declarations, and no Passport projection carries
// screening-adjacent flags. The command view has real screening records in
// their own section; the client already answered these once and re-showing
// them adds nothing.
const PERSONAL_FIELDS: Array<{ key: string; label: string }> = [
  { key: "full_name", label: "Full legal name" },
  { key: "dob", label: "Date of birth" },
  { key: "citizenship", label: "Citizenship" },
  { key: "tax_residency", label: "Tax residency" },
  { key: "address", label: "Residential address" },
  { key: "occupation", label: "Occupation" },
];

const ENTITY_FIELDS: Array<{ key: string; label: string }> = [
  { key: "entity_name", label: "Entity name" },
  { key: "abn_acn", label: "ABN / ACN" },
  { key: "registration_place", label: "Place of registration" },
  { key: "registered_address", label: "Registered address" },
  { key: "trustee_type", label: "Trustee type" },
];

function allowListedFields(
  payload: Record<string, unknown> | null,
  fields: Array<{ key: string; label: string }>,
): Array<{ key: string; label: string; value: string }> {
  if (!payload) return [];
  const out: Array<{ key: string; label: string; value: string }> = [];
  for (const f of fields) {
    const v = payload[f.key];
    if (typeof v === "string" && v.trim()) out.push({ key: f.key, label: f.label, value: v.trim().slice(0, 300) });
  }
  return out;
}

/* ── client tripwire ────────────────────────────────────────────────────── */

/**
 * Restricted vocabulary that must never appear as a KEY anywhere in a client
 * view. Deep-scanned over the finished object; a hit throws. This is the
 * fail-closed backstop behind the allow-lists, mirroring the attestation
 * restricted-key tripwire — belt AND braces, because the failure mode
 * (internal compliance material on a client's screen) is not recoverable.
 */
const CLIENT_RESTRICTED_KEYS =
  /(risk_(rating|score)|screening|sanction|pep(\b|_)|adverse|match_|mlro|suspic|smr(\b|_)|austrac|reviewer_note|internal_note|decision_note|rationale|biometric|liveness_score|face_match|provider_(payload|reference|secret)|storage_(path|bucket)|access_token|secret|api_key)/i;

export function findClientRestrictedKeys(value: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findClientRestrictedKeys(v, `${path}[${i}]`)));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (CLIENT_RESTRICTED_KEYS.test(k)) hits.push(p);
      hits.push(...findClientRestrictedKeys(v, p));
    }
  }
  return hits;
}

export function assertClientSafe(view: PassportView): void {
  const hits = findClientRestrictedKeys(view);
  if (hits.length > 0) {
    throw new Error(`client passport view carries restricted keys: ${hits.slice(0, 5).join(", ")}`);
  }
}

/**
 * What a relying entity may never hold, whatever the arrangement says.
 *
 * Deliberately SHORTER than the client list, and the difference is the point.
 * A client is protected from vocabulary written about them; a partner relying
 * under s 37A has to see the customer due diligence — that screening ran,
 * what the PEP determination concluded, which documents were held, who the
 * beneficial owners are — or the reliance is worthless and they must repeat
 * the CDD themselves.
 *
 * What stays out is the issuing organisation's own REASONING and anything
 * that could identify a report or a suspicion: risk ratings and scores,
 * screening MATCH content, adverse-media findings, MLRO and reviewer notes,
 * SMR/AUSTRAC material, biometric media and scores, provider payloads,
 * storage paths and credentials. None of that is a due-diligence outcome and
 * none of it may leave this building.
 */
const PARTNER_RESTRICTED_KEYS =
  /(risk_(rating|score)|match_|mlro|suspic|smr(\b|_)|austrac|adverse|reviewer_note|internal_note|decision_note|rationale|biometric|liveness_score|face_match|provider_(payload|reference|secret)|storage_(path|bucket)|access_token|secret|api_key)/i;

/**
 * PEP keys are allowed by exception rather than by pattern.
 *
 * `pep_result` and `pep_determined_at` are the determination — an outcome a
 * relying entity needs. Anything else beginning `pep_` is the reasoning
 * behind it, which is not disclosed. Listing the two that may travel is
 * safer than a pattern that tries to describe the rest.
 */
const PARTNER_ALLOWED_PEP_KEYS = new Set(["pep_result", "pep_determined_at"]);

/**
 * One object whose KEYS are data rather than field names.
 *
 * `list_freshness` is keyed by sanctions list code — `un`, `dfat`, `ofac`
 * today, whatever is loaded tomorrow. A code that happened to match the
 * restricted pattern (an `austrac` list is entirely plausible) would make
 * this assertion throw on a perfectly safe projection, and because it fails
 * CLOSED that would take the partner's whole document down. Its values are
 * timestamps and are still walked.
 */
const PARTNER_DATA_KEYED = new Set(["list_freshness"]);

export function findPartnerRestrictedKeys(value: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findPartnerRestrictedKeys(v, `${path}[${i}]`)));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      const dataKeyed = PARTNER_DATA_KEYED.has(k);
      if (!dataKeyed) {
        if (PARTNER_RESTRICTED_KEYS.test(k)) hits.push(p);
        else if (/^pep(\b|_)/i.test(k) && !PARTNER_ALLOWED_PEP_KEYS.has(k)) hits.push(p);
      }
      hits.push(...(dataKeyed
        ? Object.values(v && typeof v === "object" ? v as Record<string, unknown> : {})
          .flatMap((inner, i) => findPartnerRestrictedKeys(inner, `${p}[${i}]`))
        : findPartnerRestrictedKeys(v, p)));
    }
  }
  return hits;
}

export function assertPartnerSafe(view: PassportView): void {
  const hits = findPartnerRestrictedKeys(view);
  if (hits.length > 0) {
    throw new Error(`partner passport view carries restricted keys: ${hits.slice(0, 5).join(", ")}`);
  }
}

/* ── assembler ──────────────────────────────────────────────────────────── */

const METHOD_ACCEPTED = new Set(["electronic_idv", "document_sighting", "dvs"]);

export function buildPassportView(audience: PassportAudience, input: PassportViewInput): PassportView {
  const attestations = [...(input.attestations ?? [])].sort((a, b) => a.version - b.version);
  const current = attestations.filter((a) => !a.superseded_at).pop() ?? null;
  const state = derivePassportState({
    attestations,
    service_gate_status: input.case.service_gate_status,
    case_status: input.case.status,
    material_inputs_current: input.material_inputs_current,
    open_refresh_obligations: input.open_refresh_obligations,
  });

  const allStamps = derivePassportStamps(input.stamp_input);
  /* A partner reads the same certification impressions a client does. The
     command-only stamps name internal review steps rather than the customer's
     due diligence, and a relying entity has no use for them. */
  const stamps = audience === "command" ? allStamps : clientSafeStamps(allStamps);

  // What the case is still on track to earn. Kept in its OWN field rather
  // than folded in beside the earned stamps: everything downstream that
  // counts, filters or seals on `stamps` must keep meaning "earned", and a
  // pending entry carries no timestamp, version, actor or source to count.
  const allPending = derivePendingStamps(input.stamp_input, allStamps, {
    subject_type: input.case.subject_type ?? null,
    case_status: input.case.status,
    case_stage: input.case.case_stage ?? null,
    service_gate_status: input.case.service_gate_status ?? null,
  });
  const pending_stamps = audience === "command" ? allPending : clientSafePending(allPending);

  // State derivation reasons are Command diagnostics. The client sees the
  // label and tone; the machine codes (e.g. `service_gate_regressed`) name
  // internal workflow the client view must not carry.
  const stateForAudience = audience === "command" ? state : { ...state, reasons: [] };

  // Verification parties: collapse checks per party label; no provider, no
  // scores — component status and timing only.
  const partyMap = new Map<string, PassportView["verification"]["parties"][number]>();
  /* The facts behind the PASSED check, kept per party.
     The Client Identity page needs more than the descriptor: where there is
     no portrait it has to say WHY, and that answer lives in the capture
     objects rather than in the (null) descriptor they produce. */
  const portraitFacts = new Map<string, {
    captureObjects: unknown; documentChoice: unknown; issuingState: unknown;
    completedAt: string | null; backfillStamp: unknown;
  }>();
  for (const c of input.stamp_input.verification_checks ?? []) {
    const key = c.party_label ?? input.case.subject_display_name ?? "Subject";
    const entry = partyMap.get(key)
      ?? { party: key, verified: false, method: null, completed_at: null, components: [], portrait: null };
    entry.components.push({ check_type: c.check_type, status: c.status, completed_at: c.completed_at });
    if (c.status === "passed" && METHOD_ACCEPTED.has(c.check_type)) {
      entry.verified = true;
      entry.method = c.check_type;
      entry.completed_at = c.completed_at;
      /* Only from the check that PASSED. A portrait extracted during a failed
         or superseded attempt is not the evidence this party was verified
         on, and putting it on the document would say it was. */
      entry.portrait = describeIdentityPortrait({
        captureObjects: c.capture_objects,
        documentChoice: c.document_choice,
        issuingState: c.issuing_state,
        completedAt: c.completed_at,
      }) ?? entry.portrait;
      portraitFacts.set(key, {
        captureObjects: c.capture_objects,
        documentChoice: c.document_choice,
        issuingState: c.issuing_state,
        completedAt: c.completed_at,
        backfillStamp: c.portrait_backfill,
      });
    }
    partyMap.set(key, entry);
  }

  /* ── The holder's photograph, for the Client Identity page ───────────
     The bio page is about the SUBJECT, so the slot follows the subject's own
     party where there is one and the first party otherwise — a sole trader's
     case labels the party with their name, an entity's with the individual
     who was verified, and neither should leave the page blank. */
  const subjectPartyKey = input.case.subject_display_name ?? "Subject";
  const subjectParty = partyMap.get(subjectPartyKey) ?? [...partyMap.values()][0] ?? null;
  const subjectFacts = subjectParty ? portraitFacts.get(subjectParty.party) : undefined;
  const identityPortrait = describeIdentityPortraitSlot({
    captureObjects: subjectFacts?.captureObjects ?? null,
    documentChoice: subjectFacts?.documentChoice as string | null | undefined,
    issuingState: subjectFacts?.issuingState as string | null | undefined,
    completedAt: subjectFacts?.completedAt ?? null,
    verified: Boolean(subjectParty?.verified),
    /* Distinguishes "on its way" from "read and there was none". Every
       audience gets the same reading: the Command Centre's document and the
       partner's are the same document, and a photograph that is arriving is
       not a staff-only fact. */
    backfillStamp: subjectFacts?.backfillStamp ?? null,
  });

  const versions: PassportVersionRow[] = attestations.map((a) => ({
    version: a.version,
    label: passportVersionLabel(a.version),
    state: versionRegisterState(a, attestations),
    issued_at: a.issued_at,
    superseded_at: a.superseded_at,
    fingerprint_short: shortFingerprint(a.payload_sha256),
    schema_version: a.schema_version ?? 1,
  }));

  // The journey is derived from the SAME facts as the stamps, so the two
  // can never disagree about what has happened.
  const journey = derivePassportJourney(input.stamp_input, audience);

  const view: PassportView = {
    audience,
    header: {
      credential: passportCredential(input.case.case_reference, current?.version ?? null),
      case_reference: input.case.case_reference,
      subject: input.case.subject_display_name,
      subject_type: input.case.subject_type,
      issuer_org: input.issuer_org,
      officer_label: input.officer_label,
      state: stateForAudience,
      current_version_label: passportVersionLabel(current?.version ?? null),
      evidence_fingerprint: current?.payload_sha256 ?? null,
      evidence_fingerprint_short: shortFingerprint(current?.payload_sha256),
      first_issued_at: attestations[0]?.issued_at ?? null,
      last_issued_at: current?.issued_at ?? attestations[attestations.length - 1]?.issued_at ?? null,
      opened_at: input.case.opened_at,
    },
    versions,
    identity: {
      portrait: identityPortrait,
      fields: [
        ...allowListedFields(input.personal_details, PERSONAL_FIELDS),
        ...allowListedFields(input.entity_details, ENTITY_FIELDS),
      ],
    },
    verification: { parties: [...partyMap.values()] },
    documents: (input.documents ?? []).map((d) => ({
      id: d.id,
      label: d.requirement_label ?? d.requirement_code ?? "Document",
      required: Boolean(d.required),
      status: d.status,
      uploaded_at: d.created_at,
      version_number: d.version_number,
    })),
    transactions: (input.transactions ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      property_address: t.property_address,
      contract_date: t.contract_date,
      settlement_date: t.settlement_date,
      purchase_price: t.purchase_price,
    })),
    journey,
    ownership: (input.ownership ?? []).map((o) => ({
      name: o.name,
      party_kind: o.party_kind,
      relationship: o.relationship,
      ownership_percent: o.ownership_percent,
      control_type: o.control_type,
      is_ubo: Boolean(o.is_ubo),
      verification_state: o.verification_state,
      verified: ["verified", "waived"].includes(String(o.verification_state)),
    })),
    stamps,
    pending_stamps,
    /* Raw event summaries are written by and for staff and can carry
       reviewer vocabulary, so only the Command Centre reads them. The client
       and the partner get the CONSTRUCTED journey — the same milestones,
       assembled from stamps, which is what a Journey Record leaf is for. */
    history: audience === "command"
      ? (input.events ?? []).map((e) => ({
          id: e.id,
          at: e.created_at,
          title: e.summary,
          detail: e.category,
          source: e.actor_label ?? "System",
        }))
      // Client history is CONSTRUCTED — stamps plus the client's own
      // requests. Raw event summaries never reach the client, because a
      // summary written for staff can carry vocabulary a client must not see.
      : [
          ...stamps.map((s) => ({
            id: null,
            at: s.at,
            title: s.title,
            detail: s.org,
            source: s.portal,
          })),
          ...(input.client_requests ?? []).map((r) => ({
            id: r.id,
            at: r.created_at,
            title: r.subject ? `Request: ${r.subject}` : "Information request",
            detail: r.status === "open" ? "Action required" : "Answered",
            source: "Client Portal",
          })),
        ].sort((a, b) => a.at.localeCompare(b.at)),
    open_requests: (input.client_requests ?? []).filter((r) => r.status === "open"),
  };

  /* ── the families that answer "what was performed, and what did it
     conclude" ───────────────────────────────────────────────────────────
     The Command Centre holds them, and so does a relying entity: reliance
     under s 37A means the partner does not repeat the customer due diligence,
     and a partner who cannot see the screening, the funding enquiries or the
     ownership tracing has been given nothing to rely ON. What they do not
     get is the reasoning — no match content, no notes, no scores — and
     `assertPartnerSafe` enforces that structurally below.

     `partners` is the exception, and it is not a due-diligence outcome: it is
     a register of which OTHER organisations hold this record and what each of
     them decided. That belongs to the issuing organisation and to those
     partners, never to a competitor holding the same customer's passport. */
  if (audience === "command" || audience === "partner") {
    if (input.screening) {
      const subjects = input.screening.subjects ?? [];
      const terminal = new Set(["completed", "false_positive", "confirmed_match", "not_required"]);
      view.screening = {
        performed: subjects.length > 0,
        subjects_total: subjects.length,
        subjects_completed: subjects.filter((s) => terminal.has(s.state)).length,
        last_completed_at: subjects.reduce<string | null>(
          (best, s) => (s.completed_at && (!best || s.completed_at > best) ? s.completed_at : best),
          null,
        ),
        pep_result: input.screening.pep_result,
        pep_determined_at: input.screening.pep_determined_at,
        list_freshness: input.screening.list_freshness ?? {},
      };
    }
    if (input.funding) {
      view.funding = {
        sof_total: input.funding.sof.length,
        sof_verified: input.funding.sof.filter((r) => r.verified).length,
        sow_total: input.funding.sow.length,
        sow_verified: input.funding.sow.filter((r) => r.verified).length,
        edd_present: input.funding.edd.length > 0,
        edd_completed: input.funding.edd.some((e) => e.status === "completed"),
      };
    }
    if (input.partners && audience === "command") {
      view.partners = input.partners.map((p) => ({
        ...p,
        version_label: passportVersionLabel(p.attestation_version),
        disclosure: p.disclosure ?? [],
      }));
    }
  }

  // Structural, not cosmetic: neither view was ever built by copying the
  // command payload and hiding fields, and both fail closed on a widening.
  if (audience === "client") assertClientSafe(view);
  if (audience === "partner") assertPartnerSafe(view);

  return view;
}
