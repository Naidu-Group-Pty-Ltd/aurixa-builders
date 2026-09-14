/**
 * Shared Partner Compliance Workspace — contracts (Phase 4/5).
 *
 * ONE component implementation serves the Finance, Builder/Developer and
 * Solicitor portals. Portal differences travel through the
 * `PartnerPortalAdapter` (presentation and context only) and the
 * `PartnerWorkspaceClient` (the portal's own authenticated transport).
 * Neither carries authority: every security decision is made server-side
 * in `aml-reliance` from the portal session.
 *
 * The DTO types re-export the server's pure-domain shapes so there is a
 * single source of truth for what a partner may see.
 */

export type {
  PartnerWorkspaceDto,
  PartnerWorkspaceLinkDto,
  PartnerAttestationState,
  DeterminationOutcome,
} from "../../../supabase/functions/_shared/aml/partnerWorkspace";
export {
  DETERMINATION_OUTCOMES,
  REQUESTABLE_RECORD_CLASSES,
  RESPONSIBILITY_NOTICE,
} from "../../../supabase/functions/_shared/aml/partnerWorkspace";
import type { PartnerWorkspaceDto } from "../../../supabase/functions/_shared/aml/partnerWorkspace";
import type { PartnerSurfaceMode } from "@/lib/aml/partnerSurface";
import type { MatterPassportState } from "@/lib/aml/partnerMatterIndex";
import type { PassportView } from "@/lib/aml/passport";

export type { PartnerSurfaceMode, MatterPassportState };

export interface PartnerLinkSummary {
  id: string;
  relationship_role: string;
  legal_route: string;
  state: string;
  portal_type: string;
  linked_at: string;
  ended_at: string | null;
  end_reason_code: string | null;
  purchase_file_id: string | null;
  legal_matter_id: string | null;
  /**
   * The matter's standing and, where the record may be READ, whose it is.
   *
   * `subject_label` and `case_reference` are sent by the server ONLY when
   * that matter's Passport is disclosable to this organisation — they are
   * printed on page one of the document itself, so naming them there
   * discloses nothing new, and naming them on a withheld matter would be a
   * disclosure made by a list rather than by a decision. Absent on a
   * deployment serving a build that predates this.
   */
  passport_state?: MatterPassportState | null;
  subject_label?: string | null;
  case_reference?: string | null;
  expires_at?: string | null;
}

export interface PartnerWorkspaceDirectory {
  organisation: { legal_name: string; classification_status: string };
  links: PartnerLinkSummary[];
  /**
   * What this partner's compliance page IS, decided server-side.
   *
   * Absent on a deployment serving a build that predates it, which reads as
   * `full` — today's behaviour — rather than as a narrower page the operator
   * never asked for.
   */
  surface_mode?: PartnerSurfaceMode;
}

/**
 * The Compliance Passport as the partner's own portal receives it.
 *
 * `passport` is the SAME `PassportView` the Command Centre renders and the
 * emailed link serves, built for the partner audience by the one assembler.
 * It is `null` whenever the record is not disclosable, and
 * `passport_availability` says which of those reasons applies — a blank area
 * with no explanation is the failure mode this programme keeps finding.
 */
export interface PartnerWorkspaceResponse {
  workspace: PartnerWorkspaceDto;
  surface_mode?: PartnerSurfaceMode;
  passport?: PassportView | null;
  passport_availability?: { code: string; message: string };
}

/** Result envelope every client method resolves to. `error` carries the
 * server's partner-safe message only. */
export interface PartnerClientResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

/**
 * The portal-supplied transport. Each portal implements this over its OWN
 * existing authenticated invoke helper (finance token / builder cookie /
 * solicitor cookie). Implementations must never add organisation or tenant
 * identifiers — the server derives those from the session.
 */
export interface PartnerWorkspaceClient {
  getDirectory(): Promise<PartnerClientResult<PartnerWorkspaceDirectory>>;
  getWorkspace(linkId: string): Promise<PartnerClientResult<PartnerWorkspaceResponse>>;
  requestRecords(input: {
    linkId: string; recordCodes: string[]; rationale: string; dueAt?: string;
  }): Promise<PartnerClientResult<{ request: unknown }>>;
  listRequests(linkId: string): Promise<PartnerClientResult<{ requests: PartnerRecordsRequestView[] }>>;
  recordDetermination(input: {
    linkId: string; outcome: string; decisionBasis: string;
    conditions?: string; responsibilityAcknowledged: boolean;
  }): Promise<PartnerClientResult<{ assessment: unknown }>>;
  listDeliveries(linkId: string): Promise<PartnerClientResult<{ deliveries: unknown[] }>>;
  getAuditReceipt(linkId: string): Promise<PartnerClientResult<{ receipt: Record<string, unknown> }>>;
  /**
   * Stage B: controlled, expiring, audited access to ONE approved P3
   * evidence object. Optional — where a transport does not provide it the
   * UI shows no access control at all (fails closed). The server derives
   * the organisation from the session and returns a short-lived signed URL
   * that is displayed once and never stored.
   */
  getEvidenceAccess?(input: {
    linkId: string; deliveryId: string; retrievalReason: string;
  }): Promise<PartnerClientResult<{ access: PartnerEvidenceAccess }>>;
}

export interface PartnerEvidenceAccess {
  url: string;
  filename: string;
  mime_type: string | null;
  expires_at: string;
  record_code: string;
  safe_label: string;
}

export interface PartnerRecordsRequestView {
  id: string;
  requested_record_codes: string[];
  rationale?: string;
  scope_evaluation?: Array<{ code: string; label: string | null; scope: string }>;
  status: string;
  requested_at: string;
  due_at: string | null;
  approved_record_codes?: string[];
  denied_record_codes?: string[];
  origin_response_message: string | null;
  reviewed_at?: string | null;
}

/**
 * Presentation-and-context adapter. It can hide optional panels and label
 * things in the portal's own vocabulary; it can never widen what the
 * server returned, and it makes no security decisions.
 */
export interface PartnerPortalAdapter {
  portalType: "finance" | "builder" | "developer" | "solicitor_conveyancer";
  workspaceTitle: string;
  /** e.g. "Purchase file", "Project sale", "Matter". */
  matterLabel: string;
  /**
   * The short noun this portal files a matter under — "File", "Contract",
   * "Matter". Used where the partner's OWN reference leads, because their
   * file number is what they filed it under and the issuing organisation's
   * case reference is a foreign key to them.
   */
  ownReferenceLabel?: string;
  /** e.g. "Lender / broker", "Builder", "Acting solicitor". */
  roleLabel: string;
  formatReference: (link: {
    purchase_file_id: string | null; legal_matter_id: string | null; id: string;
  }) => string;
  /** Optional portal-specific intro rendered ABOVE the fixed statutory
   * responsibility notice. It supplements the notice; it never replaces it. */
  responsibilityIntro?: string;
  panels: {
    procedures: boolean;
    determination: boolean;
    recordsRequests: boolean;
    deliveries: boolean;
    auditReceipt: boolean;
    clarification: boolean;
  };
  support: {
    operationalLabel: string;
    /** In-portal destination (route) for operational questions. */
    operationalHref: string;
    complianceLabel: string;
  };
  /** Optional safe deadline labels keyed by task kind. */
  deadlineLabels?: Record<string, string>;
}
