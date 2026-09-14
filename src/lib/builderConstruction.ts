/**
 * Builder construction domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderConstruction.ts` on the
 * edge side — keep the two in step.
 *
 * DATA BOUNDARY: no type here carries a cost, margin, supplier price, contractor
 * price or commission. A milestone carries no amount and no payment flag —
 * Finance owns `build_progress_payments` and every commission trigger on it.
 */

export type BuilderConstructionStatus =
  | 'not_started' | 'site_preparation' | 'under_construction' | 'on_hold'
  | 'practical_completion' | 'handover' | 'completed' | 'cancelled';

export type BuilderConstructionStageKey =
  | 'site_preparation' | 'base' | 'frame' | 'lockup' | 'fixing'
  | 'practical_completion' | 'handover' | 'other';

export type BuilderConstructionStageStatus =
  | 'not_started' | 'in_progress' | 'complete' | 'on_hold' | 'skipped';

export type BuilderMilestoneStatus =
  | 'pending' | 'in_progress' | 'achieved' | 'missed' | 'waived';

export type BuilderConstructionDateKind =
  | 'site_start' | 'estimated_completion' | 'practical_completion' | 'actual_completion';

export interface BuilderConstructionCase {
  id: string;
  transaction_id: string;
  project_id: string;
  unit_id: string | null;
  case_reference: string | null;
  status: BuilderConstructionStatus;
  site_supervisor_name: string | null;
  site_supervisor_email: string | null;
  site_supervisor_phone: string | null;
  site_start_date: string | null;
  estimated_completion_date: string | null;
  actual_completion_date: string | null;
  practical_completion_date: string | null;
  percent_complete: number;
  shared_summary: string | null;
  weather_delay_days: number;
  variation_delay_days: number;
  row_version: number;
  created_at: string;
  updated_at: string;
  /** Present only on the authenticated detail contract. */
  builder_notes?: string | null;
}

export interface BuilderConstructionStage {
  id: string;
  construction_case_id: string;
  name: string;
  stage_key: BuilderConstructionStageKey;
  sequence_number: number;
  status: BuilderConstructionStageStatus;
  planned_start_date: string | null;
  planned_end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  percent_complete: number;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderMilestone {
  id: string;
  construction_case_id: string;
  construction_stage_id: string | null;
  name: string;
  milestone_key: string | null;
  status: BuilderMilestoneStatus;
  planned_date: string | null;
  achieved_date: string | null;
  is_customer_visible: boolean;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderProgressUpdate {
  id: string;
  construction_case_id: string;
  construction_stage_id: string | null;
  title: string;
  body: string | null;
  percent_complete: number | null;
  update_date: string;
  is_customer_visible: boolean;
  created_by_type: string;
  row_version: number;
  created_at: string;
}

/**
 * Photograph metadata as the browser sees it. `storage_path` is deliberately
 * absent: the server strips it and hands out a short-lived signed URL only after
 * re-resolving the caller's grant.
 */
export interface BuilderPhotograph {
  id: string;
  construction_case_id: string;
  progress_update_id: string | null;
  construction_stage_id: string | null;
  file_name: string;
  content_type: string;
  byte_size: number | null;
  caption: string | null;
  taken_at: string | null;
  is_customer_visible: boolean;
  uploaded_by_type: string;
  row_version: number;
  created_at: string;
}

export interface BuilderConstructionHistoryEntry {
  id: string;
  entity_kind: 'case' | 'stage' | 'milestone';
  entity_id: string;
  from_status: string | null;
  to_status: string;
  changed_by_type: string;
  reason: string | null;
  created_at: string;
}

export interface BuilderConstructionDateHistoryEntry {
  id: string;
  date_kind: BuilderConstructionDateKind;
  from_date: string | null;
  to_date: string | null;
  reason: string;
  changed_by_type: string;
  created_at: string;
}

export const CONSTRUCTION_STATUS_ORDER: BuilderConstructionStatus[] = [
  'not_started', 'site_preparation', 'under_construction', 'on_hold',
  'practical_completion', 'handover', 'completed', 'cancelled',
];

export const CONSTRUCTION_STATUS_LABELS: Record<BuilderConstructionStatus, string> = {
  not_started: 'Not started',
  site_preparation: 'Site preparation',
  under_construction: 'Under construction',
  on_hold: 'On hold',
  practical_completion: 'Practical completion',
  handover: 'Handover',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const CONSTRUCTION_STATUS_CLASSES: Record<BuilderConstructionStatus, string> = {
  not_started: 'border-border text-muted-foreground',
  site_preparation: 'border-primary/40 text-primary',
  under_construction: 'border-primary/60 text-primary',
  on_hold: 'border-destructive/40 text-destructive',
  practical_completion: 'border-accent/60 text-accent',
  handover: 'border-accent/60 text-accent',
  completed: 'border-border text-muted-foreground',
  cancelled: 'border-destructive/60 text-destructive',
};

export const CONSTRUCTION_STAGE_KEY_LABELS: Record<BuilderConstructionStageKey, string> = {
  site_preparation: 'Site preparation',
  base: 'Base',
  frame: 'Frame',
  lockup: 'Lock-up',
  fixing: 'Fixing',
  practical_completion: 'Practical completion',
  handover: 'Handover',
  other: 'Other',
};

export const CONSTRUCTION_STAGE_STATUS_LABELS: Record<BuilderConstructionStageStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
  on_hold: 'On hold',
  skipped: 'Skipped',
};

export const MILESTONE_STATUS_LABELS: Record<BuilderMilestoneStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  achieved: 'Achieved',
  missed: 'Missed',
  waived: 'Waived',
};

export const MILESTONE_STATUS_CLASSES: Record<BuilderMilestoneStatus, string> = {
  pending: 'border-border text-muted-foreground',
  in_progress: 'border-primary/50 text-primary',
  achieved: 'border-primary/60 text-primary',
  missed: 'border-destructive/50 text-destructive',
  waived: 'border-border text-muted-foreground',
};

export const CONSTRUCTION_DATE_KIND_LABELS: Record<BuilderConstructionDateKind, string> = {
  site_start: 'Site start',
  estimated_completion: 'Estimated completion',
  practical_completion: 'Practical completion',
  actual_completion: 'Actual completion',
};

/**
 * Which transitions the portal offers. Mirrors
 * `builder_is_construction_transition_allowed`; the database is the authority
 * and rejects anything this list gets wrong.
 */
export function allowedConstructionTransitions(
  from: BuilderConstructionStatus,
): BuilderConstructionStatus[] {
  switch (from) {
    case 'completed': case 'cancelled': return [];
    case 'on_hold': return ['site_preparation', 'under_construction', 'cancelled'];
    case 'not_started': return ['site_preparation', 'cancelled'];
    case 'site_preparation': return ['under_construction', 'on_hold', 'cancelled'];
    case 'under_construction': return ['practical_completion', 'on_hold', 'cancelled'];
    case 'practical_completion': return ['handover', 'under_construction', 'cancelled'];
    case 'handover': return ['completed', 'practical_completion', 'cancelled'];
    default: return [];
  }
}

/** Mirrors `builder_is_milestone_transition_allowed`. */
export function allowedMilestoneTransitions(
  from: BuilderMilestoneStatus,
): BuilderMilestoneStatus[] {
  switch (from) {
    case 'achieved': return [];
    case 'pending': return ['in_progress', 'achieved', 'missed', 'waived'];
    case 'in_progress': return ['pending', 'achieved', 'missed', 'waived'];
    case 'missed': case 'waived': return ['pending', 'in_progress'];
    default: return [];
  }
}

export function formatConstructionDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-AU') : '—';
}

export function formatPercentComplete(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(Number(value))}%`;
}

/** Whether the current estimate has already passed for a live build. */
export function isConstructionOverdue(record: BuilderConstructionCase): boolean {
  if (!record.estimated_completion_date) return false;
  if (record.status === 'completed' || record.status === 'cancelled') return false;
  return record.estimated_completion_date < new Date().toISOString().slice(0, 10);
}
