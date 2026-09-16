/**
 * Builder collaboration domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderCollaboration.ts` on
 * the edge side — keep the two in step.
 *
 * DATA BOUNDARY: a document is metadata and a version reference; the storage
 * path is never modelled here because the server never sends one. A message is
 * text between Builder users. A notification is a pointer. Nothing on this file
 * carries money, a client financial position, an AML determination or a
 * privileged legal field.
 */

export const BUILDER_SCOPE_TYPES = [
  'project', 'unit', 'transaction', 'construction_case',
] as const;
export type BuilderScopeType = (typeof BUILDER_SCOPE_TYPES)[number];

export type BuilderDocumentType =
  | 'contract' | 'plan' | 'specification' | 'permit' | 'certificate' | 'variation'
  | 'claim' | 'inspection_report' | 'defect_report' | 'handover_pack' | 'warranty'
  | 'photo' | 'other';

export type BuilderDocumentStatus = 'active' | 'superseded' | 'archived' | 'withdrawn';
export type BuilderConversationStatus = 'open' | 'resolved' | 'archived';
export type BuilderTaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type BuilderTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type BuilderNotificationType =
  | 'general' | 'task_assigned' | 'task_due' | 'message' | 'defect_raised'
  | 'inspection_scheduled' | 'status_change' | 'document_added' | 'variation_decision'
  | 'stock_selection';

export interface BuilderDocument {
  id: string;
  scope_type: BuilderScopeType;
  scope_id: string;
  title: string;
  description: string | null;
  document_type: BuilderDocumentType;
  status: BuilderDocumentStatus;
  current_version_id: string | null;
  is_customer_visible: boolean;
  row_version: number;
  created_at: string;
  updated_at: string;
}

/** No storage path: the server strips it and hands out a signed URL instead. */
export interface BuilderDocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  file_name: string;
  content_type: string;
  byte_size: number | null;
  checksum: string | null;
  change_note: string | null;
  uploaded_by_type: string;
  uploaded_by_builder_user_id: string | null;
  created_at: string;
}

export interface BuilderDocumentGrant {
  id: string;
  document_id: string;
  builder_user_id: string;
  can_download: boolean;
  granted_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderConversation {
  id: string;
  scope_type: BuilderScopeType;
  scope_id: string;
  subject: string;
  status: BuilderConversationStatus;
  last_message_at: string | null;
  message_count: number;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderConversationParticipant {
  id: string;
  conversation_id: string;
  builder_user_id: string;
  last_read_at: string | null;
  joined_at: string;
  left_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderMessage {
  id: string;
  conversation_id: string;
  body: string;
  author_type: string;
  author_builder_user_id: string | null;
  author_display_name: string | null;
  created_at: string;
}

/**
 * The live stock-activation context the server resolves for a notification or
 * task about one. This is the RECORD's current state, read at list time —
 * property, agency, the agency's outward contact, and where the activation
 * stands now — so the surfaces lay information out instead of truncating a
 * stored sentence, and an acknowledgement made elsewhere reads correctly here.
 */
export type BuilderActivationStatus =
  | 'selected' | 'builder_acknowledged' | 'progressed' | 'completed' | 'withdrawn';

export interface BuilderStockActivation {
  announcement_id: string;
  task_id: string | null;
  stock_item_id: string | null;
  property_label: string | null;
  status: BuilderActivationStatus;
  acknowledged_at: string | null;
  activated_at: string;
  agency_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  client_reference: string | null;
}

export const ACTIVATION_STATUS_LABELS: Record<BuilderActivationStatus, string> = {
  selected: 'Awaiting acknowledgement',
  builder_acknowledged: 'Acknowledged',
  progressed: 'Progressing',
  completed: 'Completed',
  withdrawn: 'Withdrawn by agency',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const ACTIVATION_STATUS_CLASSES: Record<BuilderActivationStatus, string> = {
  selected: 'border-warning/50 bg-warning/10 text-warning',
  builder_acknowledged: 'border-success/50 bg-success/10 text-success',
  progressed: 'border-primary/50 bg-primary/10 text-primary',
  completed: 'border-success/50 bg-success/10 text-success',
  withdrawn: 'border-border bg-muted/40 text-muted-foreground',
};

export interface BuilderTask {
  id: string;
  scope_type: BuilderScopeType;
  scope_id: string;
  title: string;
  description: string | null;
  status: BuilderTaskStatus;
  priority: BuilderTaskPriority;
  due_date: string | null;
  completed_at: string | null;
  created_by_builder_user_id: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
  /** Present on stock-activation tasks: the record's live context. */
  activation?: BuilderStockActivation | null;
}

export interface BuilderTaskAssignment {
  id: string;
  task_id: string;
  builder_user_id: string;
  assigned_at: string;
  assigned_by_builder_user_id: string | null;
  unassigned_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderNotification {
  id: string;
  notification_type: BuilderNotificationType;
  title: string;
  body: string | null;
  scope_type: BuilderScopeType | null;
  scope_id: string | null;
  entity_kind: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
  /** Present on stock-activation notifications: the record's live context. */
  activation?: BuilderStockActivation | null;
}

export interface BuilderUnreadCounts {
  unread_messages: number;
  unread_notifications: number;
  overdue_tasks: number;
}

export const SCOPE_TYPE_LABELS: Record<BuilderScopeType, string> = {
  project: 'Project',
  unit: 'Unit',
  transaction: 'Transaction',
  construction_case: 'Construction case',
};

export const DOCUMENT_TYPE_LABELS: Record<BuilderDocumentType, string> = {
  contract: 'Contract', plan: 'Plan', specification: 'Specification',
  permit: 'Permit', certificate: 'Certificate', variation: 'Variation',
  claim: 'Progress claim', inspection_report: 'Inspection report',
  defect_report: 'Defect report', handover_pack: 'Handover pack',
  warranty: 'Warranty', photo: 'Photograph', other: 'Other',
};

export const DOCUMENT_STATUS_LABELS: Record<BuilderDocumentStatus, string> = {
  active: 'Active', superseded: 'Superseded', archived: 'Archived', withdrawn: 'Withdrawn',
};

export const CONVERSATION_STATUS_LABELS: Record<BuilderConversationStatus, string> = {
  open: 'Open', resolved: 'Resolved', archived: 'Archived',
};

export const TASK_STATUS_LABELS: Record<BuilderTaskStatus, string> = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked',
  done: 'Done', cancelled: 'Cancelled',
};

export const TASK_PRIORITY_LABELS: Record<BuilderTaskPriority, string> = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
};

export const NOTIFICATION_TYPE_LABELS: Record<BuilderNotificationType, string> = {
  general: 'Update', task_assigned: 'Task assigned', task_due: 'Task due',
  message: 'Message', defect_raised: 'Defect raised',
  inspection_scheduled: 'Inspection scheduled', status_change: 'Status change',
  document_added: 'Document added', variation_decision: 'Variation decision',
  stock_selection: 'Property activated',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const TASK_STATUS_CLASSES: Record<BuilderTaskStatus, string> = {
  open: 'border-border text-muted-foreground',
  in_progress: 'border-primary/50 text-primary',
  blocked: 'border-destructive/50 text-destructive',
  done: 'border-primary/60 text-primary',
  cancelled: 'border-border text-muted-foreground',
};

/**
 * Every chip carries a tinted background with its border, because a bare
 * outline in an accent hue disappears against a dark card — the "High" that
 * was invisible on the Tasks screenshot was exactly this.
 */
export const TASK_PRIORITY_CLASSES: Record<BuilderTaskPriority, string> = {
  low: 'border-border bg-muted/40 text-muted-foreground',
  normal: 'border-border bg-muted/40 text-foreground/80',
  high: 'border-warning/50 bg-warning/10 text-warning',
  urgent: 'border-destructive/50 bg-destructive/10 text-destructive',
};

export const DOCUMENT_STATUS_CLASSES: Record<BuilderDocumentStatus, string> = {
  active: 'border-primary/50 text-primary',
  superseded: 'border-border text-muted-foreground',
  archived: 'border-border text-muted-foreground',
  withdrawn: 'border-destructive/50 text-destructive',
};

export function formatCollaborationDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-AU') : '—';
}

export function formatCollaborationTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('en-AU') : '—';
}

/**
 * "12 minutes ago", because a feed is read against NOW — the absolute stamp
 * (with its seconds) belongs in the tooltip, not the reading line. Falls back
 * to the plain date once "ago" stops being how anyone thinks about it.
 */
export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '—';
  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000);
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return parsed.toLocaleDateString('en-AU');
}

/**
 * The due column answers "how soon?", not "which date?" — the date is kept,
 * this rides under it. Overdue is the only state that shouts.
 */
export function describeDueDate(task: Pick<BuilderTask, 'due_date' | 'status'>): {
  text: string; overdue: boolean;
} | null {
  if (!task.due_date) return null;
  if (['done', 'cancelled'].includes(task.status)) return null;
  const today = new Date();
  const due = new Date(`${task.due_date}T00:00:00`);
  if (!Number.isFinite(due.getTime())) return null;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days < 0) {
    const late = Math.abs(days);
    return { text: `${late} day${late === 1 ? '' : 's'} overdue`, overdue: true };
  }
  if (days === 0) return { text: 'Due today', overdue: false };
  if (days === 1) return { text: 'Due tomorrow', overdue: false };
  return { text: `Due in ${days} days`, overdue: false };
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function isTaskOverdue(task: BuilderTask): boolean {
  if (!task.due_date) return false;
  if (['done', 'cancelled'].includes(task.status)) return false;
  return task.due_date < new Date().toISOString().slice(0, 10);
}

/**
 * A document is restricted when any grant is live. The server is the authority —
 * this only decides whether to show the "restricted" marker.
 */
export function isDocumentRestricted(grants: BuilderDocumentGrant[]): boolean {
  return grants.some((grant) => !grant.revoked_at);
}
