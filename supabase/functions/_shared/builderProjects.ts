/**
 * Shared Builder Project domain helpers (Builder Portal — Phase 3).
 *
 * Mirrors `_shared/legalMatters.ts` file-for-file: one place for project enums,
 * field whitelists and normalisation so the portal-facing
 * (`builder-portal-projects`) and Command Centre facing
 * (`builder-projects-admin`) functions can never drift apart.
 */

export const BUILDER_PROJECT_TYPES = [
  'house_and_land', 'townhouse', 'apartment', 'duplex',
  'land_only', 'knockdown_rebuild', 'commercial', 'other',
] as const;

export const BUILDER_PROJECT_STATUSES = [
  'planning', 'pre_sales', 'approved', 'under_construction',
  'practical_completion', 'handover', 'completed', 'on_hold', 'cancelled',
] as const;

export const BUILDER_DEVELOPMENT_STATUSES = [
  'planning', 'active', 'on_hold', 'completed', 'cancelled',
] as const;

export const BUILDER_PARTY_ROLES = [
  'developer', 'builder', 'site_supervisor', 'project_manager', 'sales_agent',
  'architect', 'engineer', 'certifier', 'surveyor', 'contractor', 'purchaser', 'other',
] as const;

export const BUILDER_ORGANISATION_SIDES = ['developer', 'builder'] as const;

export const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);

/** Columns a builder (or staff) may write on a project. Links are handled separately. */
export const PROJECT_TEXT_FIELDS = [
  'project_reference', 'name', 'address_line', 'suburb', 'postcode',
  'lot_number', 'plan_number', 'risk_notes', 'shared_summary',
] as const;

export const BUILDER_PRIVATE_PROJECT_FIELDS = ['builder_notes'] as const;
export const COMMAND_CENTRE_PRIVATE_PROJECT_FIELDS = ['npc_internal_notes'] as const;

export const PROJECT_DATE_FIELDS = [
  'estimated_start_date', 'estimated_completion_date',
  'actual_start_date', 'actual_completion_date',
] as const;

/**
 * Columns returned to portal + staff callers.
 *
 * Deliberately contains NO financial, commission, AML or client-position field.
 * `builder_invoices` and `build_progress_payments` are Finance-owned and are not
 * reachable from this module at all.
 */
const BUILDER_PROJECT_SHARED_SELECT = `
  id, development_id, developer_organisation_id, builder_organisation_id,
  project_reference, name, project_type, status,
  address_line, suburb, state, postcode, lot_number, plan_number,
  estimated_start_date, estimated_completion_date,
  actual_start_date, actual_completion_date,
  shared_summary, risk_flag, risk_notes,
  row_version, opened_at, closed_at, created_at, updated_at
`;

/** List/search responses intentionally contain no audience-private notes. */
export const BUILDER_PROJECT_PORTAL_LIST_SELECT = BUILDER_PROJECT_SHARED_SELECT;
/** Only the authenticated Builder project-detail contract includes builder notes. */
export const BUILDER_PROJECT_PORTAL_DETAIL_SELECT = `${BUILDER_PROJECT_SHARED_SELECT}, builder_notes`;
/** Command Centre has a separate NPC-owned note and cannot read builder notes. */
export const BUILDER_PROJECT_COMMAND_CENTRE_SELECT = `${BUILDER_PROJECT_SHARED_SELECT}, npc_internal_notes`;

export const BUILDER_DEVELOPMENT_SELECT = `
  id, developer_organisation_id, name, development_reference, description,
  address_line, suburb, state, postcode, status, row_version, created_at, updated_at
`;

export const BUILDER_PARTY_SELECT = `
  id, project_id, role, name, organisation, email, phone, address,
  reference, is_primary_contact, notes, created_at, updated_at
`;

export const BUILDER_PROJECT_STATUS_HISTORY_SELECT = `
  id, from_status, to_status, changed_by_type, reason, created_at
`;

export function cleanText(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().slice(0, max);
  return s.length ? s : null;
}

export function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function cleanDate(value: unknown): string | null {
  if (!value) return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function cleanEnum<T extends readonly string[]>(
  value: unknown, allowed: T, fallback: T[number] | null = null,
): T[number] | null {
  const s = String(value ?? '').trim();
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : fallback;
}

export function cleanState(value: unknown): string | null {
  const s = String(value ?? '').trim().toUpperCase();
  return AU_STATES.has(s) ? s : null;
}

export function cleanPostcode(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^\d{4}$/.test(s) ? s : null;
}

/**
 * Build a sanitised project payload from arbitrary input.
 *
 * Mirrors `buildMatterPayload`. Neither audience may write an organisation id
 * or a status through this path: organisations are set at creation by the
 * Command Centre only, and status moves exclusively through
 * `builder_transition_project`.
 */
export function buildProjectPayload(
  body: Record<string, any>,
  { isCreate, audience = 'builder' }: { isCreate: boolean; audience?: 'builder' | 'command_centre' },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const f of PROJECT_TEXT_FIELDS) {
    if (f in body) {
      payload[f] = f === 'postcode'
        ? cleanPostcode(body[f])
        : cleanText(body[f], f === 'shared_summary' || f === 'risk_notes' ? 8000 : 300);
    }
  }

  const privateField = audience === 'builder' ? 'builder_notes' : 'npc_internal_notes';
  if (privateField in body) payload[privateField] = cleanText(body[privateField], 8000);

  for (const f of PROJECT_DATE_FIELDS) {
    // Actual start/completion dates are stamped by the status transition, so the
    // portal may only set the estimates. The Command Centre owns both.
    const estimateOnly = f.startsWith('estimated_');
    if ((audience === 'command_centre' || estimateOnly) && f in body) {
      payload[f] = cleanDate(body[f]);
    }
  }

  if ('state' in body) payload.state = cleanState(body.state);
  if ('project_type' in body) {
    payload.project_type = cleanEnum(body.project_type, BUILDER_PROJECT_TYPES, 'house_and_land');
  }
  if ('risk_flag' in body) payload.risk_flag = !!body.risk_flag;

  if (isCreate) {
    if (!payload.name) payload.name = cleanText(body.address_line, 300) || 'Untitled project';
    if (!payload.project_type) payload.project_type = 'house_and_land';
  }

  return payload;
}

export function buildPartyPayload(body: Record<string, any>): Record<string, unknown> {
  return {
    role: cleanEnum(body.role, BUILDER_PARTY_ROLES, 'other'),
    name: cleanText(body.name, 200),
    organisation: cleanText(body.organisation, 200),
    email: cleanText(body.email, 200)?.toLowerCase() ?? null,
    phone: cleanText(body.phone, 40),
    address: cleanText(body.address, 400),
    reference: cleanText(body.reference, 120),
    is_primary_contact: !!body.is_primary_contact,
    notes: cleanText(body.notes, 4000),
  };
}

export function buildDevelopmentPayload(body: Record<string, any>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if ('name' in body) payload.name = cleanText(body.name, 300);
  if ('development_reference' in body) payload.development_reference = cleanText(body.development_reference, 120);
  if ('description' in body) payload.description = cleanText(body.description, 8000);
  if ('address_line' in body) payload.address_line = cleanText(body.address_line, 300);
  if ('suburb' in body) payload.suburb = cleanText(body.suburb, 200);
  if ('state' in body) payload.state = cleanState(body.state);
  if ('postcode' in body) payload.postcode = cleanPostcode(body.postcode);
  return payload;
}

/**
 * Terminal statuses cannot be moved out of by the portal — Command Centre only.
 * Mirrors `TERMINAL_STATUSES` in `_shared/legalMatters.ts`.
 */
export const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
