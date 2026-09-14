/**
 * Builder delivery domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderDelivery.ts` on the
 * edge side — keep the two in step.
 *
 * DATA BOUNDARY: a progress claim carries what was claimed and certified plus a
 * nullable Finance POINTER. No payment, receipt or commission is modelled here.
 * Defects, inspections, practical completion, handover and warranty records
 * carry no money at all.
 */

export type BuilderDeliveryKind =
  | 'variation' | 'progress_claim' | 'inspection' | 'defect'
  | 'practical_completion' | 'handover' | 'warranty_claim';

export type BuilderVariationStatus =
  | 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
export type BuilderClaimStatus =
  | 'draft' | 'submitted' | 'certified' | 'disputed' | 'withdrawn' | 'closed';
export type BuilderInspectionStatus =
  | 'scheduled' | 'rescheduled' | 'in_progress' | 'passed' | 'failed'
  | 'passed_with_defects' | 'cancelled';
export type BuilderDefectStatus =
  | 'open' | 'acknowledged' | 'in_rectification' | 'rectified' | 'verified'
  | 'rejected' | 'closed';
export type BuilderDefectSeverity = 'cosmetic' | 'minor' | 'major' | 'critical';
export type BuilderPcStatus = 'not_reached' | 'notified' | 'inspected' | 'disputed' | 'achieved';
export type BuilderHandoverStatus =
  | 'not_scheduled' | 'scheduled' | 'walkthrough_complete' | 'keys_released' | 'completed';
export type BuilderWarrantyClaimStatus =
  | 'lodged' | 'under_review' | 'accepted' | 'rejected' | 'rectified' | 'closed';

export interface BuilderVariation {
  id: string;
  construction_case_id: string;
  variation_number: string | null;
  title: string;
  description: string | null;
  origin: string;
  status: BuilderVariationStatus;
  variation_price: number | null;
  time_impact_days: number;
  submitted_at: string | null;
  decided_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderVariationApproval {
  id: string;
  variation_id: string;
  approver_role: string;
  approver_name: string;
  decision: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  comments: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderProgressClaim {
  id: string;
  construction_case_id: string;
  milestone_id: string | null;
  claim_number: string | null;
  claimed_amount: number;
  status: BuilderClaimStatus;
  claimed_at: string | null;
  certified_at: string | null;
  certified_amount: number | null;
  dispute_reason: string | null;
  notes: string | null;
  /** A pointer into Finance. Never an amount, a receipt or a commission. */
  finance_payment_id: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderInspection {
  id: string;
  construction_case_id: string;
  construction_stage_id: string | null;
  inspection_type: string;
  title: string;
  status: BuilderInspectionStatus;
  inspector_name: string | null;
  inspector_organisation: string | null;
  scheduled_for: string | null;
  performed_at: string | null;
  outcome_notes: string | null;
  defect_count: number;
  is_customer_visible: boolean;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderDefect {
  id: string;
  construction_case_id: string;
  inspection_id: string | null;
  defect_number: string | null;
  title: string;
  description: string | null;
  location: string | null;
  severity: BuilderDefectSeverity;
  status: BuilderDefectStatus;
  raised_by_type: string;
  raised_at: string;
  due_date: string | null;
  rectified_at: string | null;
  verified_at: string | null;
  is_customer_visible: boolean;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderPracticalCompletion {
  id: string;
  construction_case_id: string;
  status: BuilderPcStatus;
  notified_at: string | null;
  inspected_at: string | null;
  achieved_at: string | null;
  certificate_reference: string | null;
  outstanding_defect_count: number;
  dispute_reason: string | null;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderHandover {
  id: string;
  construction_case_id: string;
  status: BuilderHandoverStatus;
  scheduled_for: string | null;
  walkthrough_at: string | null;
  keys_released_at: string | null;
  completed_at: string | null;
  attendee_names: string | null;
  key_set_count: number | null;
  manual_provided: boolean;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderWarranty {
  id: string;
  construction_case_id: string;
  warranty_type: string;
  provider_name: string | null;
  policy_reference: string | null;
  starts_on: string | null;
  expires_on: string | null;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderWarrantyClaim {
  id: string;
  construction_case_id: string;
  warranty_id: string | null;
  claim_number: string | null;
  title: string;
  description: string | null;
  status: BuilderWarrantyClaimStatus;
  lodged_at: string;
  decided_at: string | null;
  rectified_at: string | null;
  decision_notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderDeliveryHistoryEntry {
  id: string;
  entity_kind: BuilderDeliveryKind;
  entity_id: string;
  from_status: string | null;
  to_status: string;
  changed_by_type: string;
  reason: string | null;
  created_at: string;
}

export const VARIATION_STATUS_LABELS: Record<BuilderVariationStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved',
  rejected: 'Rejected', withdrawn: 'Withdrawn', superseded: 'Superseded',
};

export const CLAIM_STATUS_LABELS: Record<BuilderClaimStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', certified: 'Certified',
  disputed: 'Disputed', withdrawn: 'Withdrawn', closed: 'Closed',
};

export const INSPECTION_STATUS_LABELS: Record<BuilderInspectionStatus, string> = {
  scheduled: 'Scheduled', rescheduled: 'Rescheduled', in_progress: 'In progress',
  passed: 'Passed', failed: 'Failed', passed_with_defects: 'Passed with defects',
  cancelled: 'Cancelled',
};

export const DEFECT_STATUS_LABELS: Record<BuilderDefectStatus, string> = {
  open: 'Open', acknowledged: 'Acknowledged', in_rectification: 'In rectification',
  rectified: 'Rectified', verified: 'Verified', rejected: 'Rejected', closed: 'Closed',
};

export const DEFECT_SEVERITY_LABELS: Record<BuilderDefectSeverity, string> = {
  cosmetic: 'Cosmetic', minor: 'Minor', major: 'Major', critical: 'Critical',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const DEFECT_SEVERITY_CLASSES: Record<BuilderDefectSeverity, string> = {
  cosmetic: 'border-border text-muted-foreground',
  minor: 'border-border text-muted-foreground',
  major: 'border-accent/60 text-accent',
  critical: 'border-destructive/60 text-destructive',
};

export const DEFECT_STATUS_CLASSES: Record<BuilderDefectStatus, string> = {
  open: 'border-destructive/50 text-destructive',
  acknowledged: 'border-accent/60 text-accent',
  in_rectification: 'border-primary/50 text-primary',
  rectified: 'border-primary/60 text-primary',
  verified: 'border-primary/60 text-primary',
  rejected: 'border-border text-muted-foreground',
  closed: 'border-border text-muted-foreground',
};

export const PC_STATUS_LABELS: Record<BuilderPcStatus, string> = {
  not_reached: 'Not reached', notified: 'Notified', inspected: 'Inspected',
  disputed: 'Disputed', achieved: 'Achieved',
};

export const HANDOVER_STATUS_LABELS: Record<BuilderHandoverStatus, string> = {
  not_scheduled: 'Not scheduled', scheduled: 'Scheduled',
  walkthrough_complete: 'Walkthrough complete', keys_released: 'Keys released',
  completed: 'Completed',
};

export const WARRANTY_CLAIM_STATUS_LABELS: Record<BuilderWarrantyClaimStatus, string> = {
  lodged: 'Lodged', under_review: 'Under review', accepted: 'Accepted',
  rejected: 'Rejected', rectified: 'Rectified', closed: 'Closed',
};

export const DELIVERY_KIND_LABELS: Record<BuilderDeliveryKind, string> = {
  variation: 'Variation', progress_claim: 'Progress claim', inspection: 'Inspection',
  defect: 'Defect', practical_completion: 'Practical completion',
  handover: 'Handover', warranty_claim: 'Warranty claim',
};

/**
 * Which transitions the portal offers, per aggregate. Mirrors
 * `builder_is_delivery_transition_allowed`; the database is the authority and
 * rejects anything this list gets wrong.
 */
export function allowedDeliveryTransitions(kind: BuilderDeliveryKind, from: string): string[] {
  switch (kind) {
    case 'variation':
      if (['approved', 'rejected', 'withdrawn', 'superseded'].includes(from)) return [];
      if (from === 'draft') return ['submitted', 'withdrawn'];
      if (from === 'submitted') return ['approved', 'rejected', 'withdrawn', 'superseded'];
      return [];
    case 'progress_claim':
      if (['closed', 'withdrawn'].includes(from)) return [];
      if (from === 'draft') return ['submitted', 'withdrawn'];
      if (from === 'submitted') return ['certified', 'disputed', 'withdrawn'];
      if (from === 'disputed') return ['certified', 'submitted', 'withdrawn'];
      if (from === 'certified') return ['closed'];
      return [];
    case 'inspection':
      if (['cancelled', 'passed'].includes(from)) return [];
      if (['scheduled', 'rescheduled'].includes(from)) {
        return ['in_progress', 'rescheduled', 'cancelled'].filter((s) => s !== from);
      }
      if (from === 'in_progress') return ['passed', 'failed', 'passed_with_defects', 'cancelled'];
      if (['failed', 'passed_with_defects'].includes(from)) {
        return ['rescheduled', 'passed', 'cancelled'];
      }
      return [];
    case 'defect':
      if (from === 'closed') return [];
      if (from === 'open') return ['acknowledged', 'rejected', 'in_rectification'];
      if (from === 'acknowledged') return ['in_rectification', 'rejected'];
      if (from === 'in_rectification') return ['rectified', 'open'];
      if (from === 'rectified') return ['verified', 'in_rectification'];
      if (from === 'verified') return ['closed'];
      if (from === 'rejected') return ['open', 'closed'];
      return [];
    case 'practical_completion':
      if (from === 'achieved') return [];
      if (from === 'not_reached') return ['notified'];
      if (from === 'notified') return ['inspected', 'disputed'];
      if (from === 'inspected') return ['achieved', 'disputed'];
      if (from === 'disputed') return ['inspected', 'notified'];
      return [];
    case 'handover':
      if (from === 'completed') return [];
      if (from === 'not_scheduled') return ['scheduled'];
      if (from === 'scheduled') return ['walkthrough_complete', 'not_scheduled'];
      if (from === 'walkthrough_complete') return ['keys_released'];
      if (from === 'keys_released') return ['completed'];
      return [];
    case 'warranty_claim':
      if (from === 'closed') return [];
      if (from === 'lodged') return ['under_review', 'rejected'];
      if (from === 'under_review') return ['accepted', 'rejected'];
      if (from === 'accepted') return ['rectified'];
      if (from === 'rectified') return ['closed'];
      if (from === 'rejected') return ['under_review', 'closed'];
      return [];
    default:
      return [];
  }
}

/** The label set for one aggregate's statuses. */
export function statusLabel(kind: BuilderDeliveryKind, status: string): string {
  const maps: Record<string, Record<string, string>> = {
    variation: VARIATION_STATUS_LABELS,
    progress_claim: CLAIM_STATUS_LABELS,
    inspection: INSPECTION_STATUS_LABELS,
    defect: DEFECT_STATUS_LABELS,
    practical_completion: PC_STATUS_LABELS,
    handover: HANDOVER_STATUS_LABELS,
    warranty_claim: WARRANTY_CLAIM_STATUS_LABELS,
  };
  return maps[kind]?.[status] ?? status;
}

export function formatDeliveryDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-AU') : '—';
}

export function formatDeliveryMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: 0,
  }).format(Number(value));
}

export function isDefectOverdue(defect: BuilderDefect): boolean {
  if (!defect.due_date) return false;
  if (['closed', 'rejected', 'verified'].includes(defect.status)) return false;
  return defect.due_date < new Date().toISOString().slice(0, 10);
}
