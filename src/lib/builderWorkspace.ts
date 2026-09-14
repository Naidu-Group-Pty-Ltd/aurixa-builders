/**
 * Builder workspace domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderWorkspace.ts` on the
 * edge side — keep the two in step.
 *
 * DATA BOUNDARY: the activity entry models what changed and when. It carries no
 * `previous_state`, `new_state`, `ip_address` or `user_agent`, because the
 * portal function never sends them. Settings carry contact and display
 * preferences; nothing here holds money, a client financial position, an AML
 * determination or a credential.
 */

export const BUILDER_LANDING_PAGES = [
  'dashboard', 'projects', 'inventory', 'transactions',
  'construction', 'documents', 'messages', 'tasks',
] as const;
export type BuilderLandingPage = (typeof BUILDER_LANDING_PAGES)[number];

export const BUILDER_DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export type BuilderDateFormat = (typeof BUILDER_DATE_FORMATS)[number];

export const BUILDER_EMAIL_DIGESTS = ['off', 'daily', 'weekly'] as const;
export type BuilderEmailDigest = (typeof BUILDER_EMAIL_DIGESTS)[number];

export interface BuilderOrganisationSettings {
  id: string;
  organisation_id: string;
  display_name: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  timezone: string;
  default_landing_page: BuilderLandingPage;
  notify_on_defect: boolean;
  notify_on_inspection: boolean;
  notify_on_variation: boolean;
  notify_on_message: boolean;
  notify_on_task: boolean;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BuilderUserPreferences {
  id: string;
  builder_user_id: string;
  default_organisation_id: string | null;
  landing_page: BuilderLandingPage;
  timezone: string;
  date_format: BuilderDateFormat;
  email_digest: BuilderEmailDigest;
  notify_task_assigned: boolean;
  notify_message_posted: boolean;
  notify_status_change: boolean;
  /**
   * When this user finished or skipped the guided onboarding tour. NULL means
   * the tour is still due. Server-stamped — the Builder Portal persists nothing
   * in the browser, so this is where tour state lives.
   */
  tour_completed_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

/** No before/after state and no request metadata — the server never sends them. */
export interface BuilderActivityEntry {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_type: string;
  reason: string | null;
  created_at: string;
}

export interface BuilderWorkspaceSummary {
  projects: number;
  units: number;
  transactions: number;
  construction_cases: number;
  open_defects: number;
  documents: number;
  open_conversations: number;
  open_tasks: number;
  overdue_tasks: number;
  unread_messages: number;
  unread_notifications: number;
}

export const LANDING_PAGE_LABELS: Record<BuilderLandingPage, string> = {
  dashboard: 'Dashboard', projects: 'Projects', inventory: 'Inventory',
  transactions: 'Transactions', construction: 'Construction',
  documents: 'Documents', messages: 'Messages', tasks: 'Tasks',
};

export const EMAIL_DIGEST_LABELS: Record<BuilderEmailDigest, string> = {
  off: 'No digest', daily: 'Daily', weekly: 'Weekly',
};

export const ACTIVITY_ENTITY_LABELS: Record<string, string> = {
  project: 'Project', project_party: 'Project party',
  stage: 'Stage', building: 'Building', lot: 'Lot',
  unit: 'Unit', unit_price: 'Unit price', unit_hold: 'Unit hold',
  reservation: 'Reservation', allocation: 'Allocation',
  transaction: 'Transaction', transaction_party: 'Transaction party',
  construction_case: 'Build', construction_stage: 'Build stage', milestone: 'Milestone',
  progress_update: 'Progress update', photograph: 'Photograph',
  variation: 'Variation', variation_approval: 'Variation approval',
  progress_claim: 'Progress claim', inspection: 'Inspection', defect: 'Defect',
  practical_completion: 'Practical completion', handover: 'Handover',
  warranty_claim: 'Warranty claim',
  document: 'Document', document_version: 'Document version',
  conversation: 'Conversation', message: 'Message',
  task: 'Task', task_assignment: 'Task assignment',
};

/** The record types the portal activity feed can be filtered by. */
export const BUILDER_ACTIVITY_ENTITY_TYPES = Object.keys(ACTIVITY_ENTITY_LABELS);

export const ACTOR_TYPE_LABELS: Record<string, string> = {
  builder_user: 'Portal user',
  command_user: 'Aurixa Systems',
  service_role: 'Automation',
  system: 'System',
};

/**
 * A readable label for an audited action. The action names are stable server
 * identifiers; this only reshapes them for display.
 */
export function activityActionLabel(action: string): string {
  return action
    .replace(/^builder_/, '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export function formatWorkspaceTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('en-AU') : '—';
}

/**
 * A small set of timezones the portal offers. The server accepts any IANA-shaped
 * value, so this is a convenience list rather than the constraint.
 */
export const BUILDER_TIMEZONES = [
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane',
  'Australia/Adelaide', 'Australia/Perth', 'Australia/Darwin', 'Australia/Hobart',
  'Pacific/Auckland', 'UTC',
];
