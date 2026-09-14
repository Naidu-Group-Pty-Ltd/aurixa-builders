/**
 * Builder project domain constants shared by the Builder Portal and the
 * Command Centre admin surfaces. Mirrors `_shared/builderProjects.ts` on the
 * edge side — keep the two in step, exactly as `src/lib/legalMatters.ts`
 * mirrors `_shared/legalMatters.ts`.
 */

export type BuilderProjectStatus =
  | 'planning' | 'pre_sales' | 'approved' | 'under_construction'
  | 'practical_completion' | 'handover' | 'completed' | 'on_hold' | 'cancelled';

export type BuilderProjectType =
  | 'house_and_land' | 'townhouse' | 'apartment' | 'duplex'
  | 'land_only' | 'knockdown_rebuild' | 'commercial' | 'other';

export type BuilderPartyRole =
  | 'developer' | 'builder' | 'site_supervisor' | 'project_manager' | 'sales_agent'
  | 'architect' | 'engineer' | 'certifier' | 'surveyor' | 'contractor'
  | 'purchaser' | 'other';

export type BuilderOrganisationSide = 'developer' | 'builder';

export interface BuilderProject {
  id: string;
  development_id: string | null;
  developer_organisation_id: string | null;
  builder_organisation_id: string | null;
  project_reference: string | null;
  name: string;
  project_type: BuilderProjectType;
  status: BuilderProjectStatus;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lot_number: string | null;
  plan_number: string | null;
  estimated_start_date: string | null;
  estimated_completion_date: string | null;
  actual_start_date: string | null;
  actual_completion_date: string | null;
  shared_summary: string | null;
  risk_flag: boolean;
  risk_notes: string | null;
  row_version: number;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present only on the authenticated Builder detail contract. */
  builder_notes?: string | null;
  /** Joined for display by the list endpoint. */
  developer_organisation_name?: string | null;
  builder_organisation_name?: string | null;
}

export interface BuilderProjectParty {
  id: string;
  project_id: string;
  role: BuilderPartyRole;
  name: string;
  organisation: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  reference: string | null;
  is_primary_contact: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuilderProjectStatusHistoryEntry {
  id: string;
  from_status: BuilderProjectStatus | null;
  to_status: BuilderProjectStatus;
  changed_by_type: string;
  reason: string | null;
  created_at: string;
}

export const PROJECT_STATUS_ORDER: BuilderProjectStatus[] = [
  'planning', 'pre_sales', 'approved', 'under_construction',
  'practical_completion', 'handover', 'completed', 'on_hold', 'cancelled',
];

export const PROJECT_STATUS_LABELS: Record<BuilderProjectStatus, string> = {
  planning: 'Planning',
  pre_sales: 'Pre-sales',
  approved: 'Approved',
  under_construction: 'Under construction',
  practical_completion: 'Practical completion',
  handover: 'Handover',
  completed: 'Completed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
};

/** Semantic tokens only — no raw palette classes (repository style rule). */
export const PROJECT_STATUS_CLASSES: Record<BuilderProjectStatus, string> = {
  planning: 'border-border text-muted-foreground',
  pre_sales: 'border-primary/40 text-primary',
  approved: 'border-primary/40 text-primary',
  under_construction: 'border-primary/60 text-primary',
  practical_completion: 'border-accent/60 text-accent',
  handover: 'border-accent/60 text-accent',
  completed: 'border-border text-muted-foreground',
  on_hold: 'border-destructive/40 text-destructive',
  cancelled: 'border-destructive/60 text-destructive',
};

export const PROJECT_TYPE_LABELS: Record<BuilderProjectType, string> = {
  house_and_land: 'House & land',
  townhouse: 'Townhouse',
  apartment: 'Apartment',
  duplex: 'Duplex',
  land_only: 'Land only',
  knockdown_rebuild: 'Knockdown rebuild',
  commercial: 'Commercial',
  other: 'Other',
};

export const PARTY_ROLE_LABELS: Record<BuilderPartyRole, string> = {
  developer: 'Developer',
  builder: 'Builder',
  site_supervisor: 'Site supervisor',
  project_manager: 'Project manager',
  sales_agent: 'Sales agent',
  architect: 'Architect',
  engineer: 'Engineer',
  certifier: 'Certifier',
  surveyor: 'Surveyor',
  contractor: 'Contractor',
  purchaser: 'Purchaser',
  other: 'Other',
};

export const ACCESS_ROLE_LABELS: Record<string, string> = {
  responsible: 'Responsible',
  team_member: 'Team member',
  supervisor: 'Supervisor',
  read_only: 'Read only',
};

/**
 * Which transitions the portal offers. Mirrors
 * `builder_is_project_transition_allowed` in the Phase 3 migration; the database
 * is the authority and rejects anything this list gets wrong.
 */
export function allowedProjectTransitions(from: BuilderProjectStatus): BuilderProjectStatus[] {
  switch (from) {
    case 'completed':
    case 'cancelled':
      return [];
    case 'on_hold':
      return ['planning', 'pre_sales', 'approved', 'under_construction', 'cancelled'];
    case 'planning':
      return ['pre_sales', 'approved', 'on_hold', 'cancelled'];
    case 'pre_sales':
      return ['approved', 'planning', 'on_hold', 'cancelled'];
    case 'approved':
      return ['under_construction', 'pre_sales', 'on_hold', 'cancelled'];
    case 'under_construction':
      return ['practical_completion', 'on_hold', 'cancelled'];
    case 'practical_completion':
      return ['handover', 'under_construction', 'on_hold', 'cancelled'];
    case 'handover':
      return ['completed', 'practical_completion', 'on_hold', 'cancelled'];
    default:
      return [];
  }
}

export function formatProjectDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-AU') : '—';
}

export function formatProjectAddress(
  project: Pick<BuilderProject, 'address_line' | 'suburb' | 'state' | 'postcode'>,
): string {
  return [project.address_line, project.suburb, project.state, project.postcode]
    .filter(Boolean).join(', ') || 'No address recorded';
}

/** Days until a date, rendered the way the Solicitor list renders a countdown. */
export function countdownLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const target = new Date(value);
  if (!Number.isFinite(target.getTime())) return null;
  const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'Today';
  return days > 0 ? `In ${days} day${days === 1 ? '' : 's'}` : `${Math.abs(days)} day${days === -1 ? '' : 's'} ago`;
}
