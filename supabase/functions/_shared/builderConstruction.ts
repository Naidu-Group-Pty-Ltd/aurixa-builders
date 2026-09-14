/**
 * Shared Builder Construction domain helpers.
 *
 * Mirrors `_shared/builderTransactions.ts`: one place for enums, audience select
 * lists, normalisation and the error-to-HTTP table so the portal-facing
 * (`builder-portal-construction`) and Command Centre facing
 * (`builder-construction-admin`) functions can never drift apart.
 *
 * DATA BOUNDARY: no select list here names a cost, margin, supplier price,
 * contractor price or commission column, because none exists — the migration
 * asserts that at apply time. A milestone carries no amount and no payment flag:
 * Finance owns `build_progress_payments` and every commission trigger on it.
 */

export const BUILDER_CONSTRUCTION_STATUSES = [
  'not_started', 'site_preparation', 'under_construction', 'on_hold',
  'practical_completion', 'handover', 'completed', 'cancelled',
] as const;

export const BUILDER_CONSTRUCTION_STAGE_KEYS = [
  'site_preparation', 'base', 'frame', 'lockup', 'fixing',
  'practical_completion', 'handover', 'other',
] as const;

export const BUILDER_CONSTRUCTION_STAGE_STATUSES = [
  'not_started', 'in_progress', 'complete', 'on_hold', 'skipped',
] as const;

export const BUILDER_MILESTONE_STATUSES = [
  'pending', 'in_progress', 'achieved', 'missed', 'waived',
] as const;

export const BUILDER_CONSTRUCTION_DATE_KINDS = [
  'site_start', 'estimated_completion', 'practical_completion', 'actual_completion',
] as const;

export const BUILDER_PHOTO_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
] as const;

/** Shared case columns. Explicit allow-list — never `select('*')`. */
const CASE_SHARED_SELECT = `
  id, transaction_id, project_id, unit_id, case_reference, status,
  site_supervisor_name, site_supervisor_email, site_supervisor_phone,
  site_start_date, estimated_completion_date, actual_completion_date,
  practical_completion_date, percent_complete, shared_summary,
  weather_delay_days, variation_delay_days,
  row_version, created_at, updated_at
`;

export const BUILDER_CONSTRUCTION_PORTAL_LIST_SELECT = CASE_SHARED_SELECT;
export const BUILDER_CONSTRUCTION_PORTAL_DETAIL_SELECT = `${CASE_SHARED_SELECT}, builder_notes`;
export const BUILDER_CONSTRUCTION_COMMAND_CENTRE_SELECT = `${CASE_SHARED_SELECT}, builder_notes`;

export const BUILDER_CONSTRUCTION_STAGE_SELECT = `
  id, construction_case_id, name, stage_key, sequence_number, status,
  planned_start_date, planned_end_date, actual_start_date, actual_end_date,
  percent_complete, notes, row_version, created_at, updated_at
`;

export const BUILDER_MILESTONE_SELECT = `
  id, construction_case_id, construction_stage_id, name, milestone_key, status,
  planned_date, achieved_date, is_customer_visible, notes,
  row_version, created_at, updated_at
`;

export const BUILDER_PROGRESS_UPDATE_SELECT = `
  id, construction_case_id, construction_stage_id, title, body, percent_complete,
  update_date, is_customer_visible, created_by_type, row_version, created_at
`;

/**
 * Photograph metadata. `storage_path` is deliberately included: the Edge
 * Function needs it to mint a short-lived signed URL AFTER it has resolved the
 * caller's permission. It is never rendered and never becomes a public URL.
 */
export const BUILDER_PHOTOGRAPH_SELECT = `
  id, construction_case_id, progress_update_id, construction_stage_id,
  storage_path, file_name, content_type, byte_size, caption, taken_at,
  is_customer_visible, uploaded_by_type, row_version, created_at
`;

export const BUILDER_CONSTRUCTION_HISTORY_SELECT = `
  id, entity_kind, entity_id, from_status, to_status, changed_by_type, reason, created_at
`;

export const BUILDER_CONSTRUCTION_DATE_HISTORY_SELECT = `
  id, date_kind, from_date, to_date, reason, changed_by_type, created_at
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

/**
 * Build a sanitised construction-case payload.
 *
 * Status is not writable here — it moves only through the transition command.
 * Dates are not writable here either: each one moves through
 * `builder_set_construction_date`, which records the previous value and a
 * reason, so slippage is auditable rather than silent.
 */
export function buildConstructionCasePayload(
  body: Record<string, any>, { audience }: { audience: 'builder' | 'command_centre' },
) {
  const payload: Record<string, unknown> = {};
  if ('case_reference' in body && audience === 'command_centre') {
    payload.case_reference = cleanText(body.case_reference, 60);
  }
  if ('site_supervisor_name' in body) {
    payload.site_supervisor_name = cleanText(body.site_supervisor_name, 200);
  }
  if ('site_supervisor_email' in body) {
    payload.site_supervisor_email = cleanText(body.site_supervisor_email, 200)?.toLowerCase() ?? null;
  }
  if ('site_supervisor_phone' in body) {
    payload.site_supervisor_phone = cleanText(body.site_supervisor_phone, 40);
  }
  if ('percent_complete' in body) payload.percent_complete = cleanNumber(body.percent_complete);
  if ('shared_summary' in body) payload.shared_summary = cleanText(body.shared_summary, 4000);
  if ('builder_notes' in body) payload.builder_notes = cleanText(body.builder_notes, 8000);
  if ('weather_delay_days' in body) payload.weather_delay_days = cleanNumber(body.weather_delay_days);
  if ('variation_delay_days' in body) {
    payload.variation_delay_days = cleanNumber(body.variation_delay_days);
  }
  return payload;
}

export function buildConstructionStagePayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('name' in body) payload.name = cleanText(body.name, 200);
  if ('stage_key' in body) {
    payload.stage_key = cleanEnum(body.stage_key, BUILDER_CONSTRUCTION_STAGE_KEYS, 'other');
  }
  if ('sequence_number' in body) payload.sequence_number = cleanNumber(body.sequence_number);
  if ('status' in body) {
    payload.status = cleanEnum(body.status, BUILDER_CONSTRUCTION_STAGE_STATUSES);
  }
  for (const field of ['planned_start_date', 'planned_end_date',
    'actual_start_date', 'actual_end_date'] as const) {
    if (field in body) payload[field] = cleanDate(body[field]);
  }
  if ('percent_complete' in body) payload.percent_complete = cleanNumber(body.percent_complete);
  if ('notes' in body) payload.notes = cleanText(body.notes, 4000);
  return payload;
}

export function buildMilestonePayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('name' in body) payload.name = cleanText(body.name, 200);
  if ('milestone_key' in body) payload.milestone_key = cleanText(body.milestone_key, 60);
  if ('planned_date' in body) payload.planned_date = cleanDate(body.planned_date);
  if ('is_customer_visible' in body) payload.is_customer_visible = !!body.is_customer_visible;
  if ('notes' in body) payload.notes = cleanText(body.notes, 4000);
  return payload;
}

export function buildProgressUpdatePayload(body: Record<string, any>) {
  return {
    title: cleanText(body.title, 200),
    body: cleanText(body.body, 8000),
    percent_complete: cleanNumber(body.percent_complete),
    update_date: cleanDate(body.update_date),
    is_customer_visible: body.is_customer_visible === undefined ? true : !!body.is_customer_visible,
  };
}

export function buildPhotographPayload(body: Record<string, any>) {
  return {
    storage_path: cleanText(body.storage_path, 500),
    file_name: cleanText(body.file_name, 200),
    content_type: cleanEnum(body.content_type, BUILDER_PHOTO_CONTENT_TYPES, 'image/jpeg'),
    byte_size: cleanNumber(body.byte_size),
    caption: cleanText(body.caption, 500),
    taken_at: body.taken_at ? String(body.taken_at) : null,
    is_customer_visible: body.is_customer_visible === undefined ? true : !!body.is_customer_visible,
    progress_update_id: cleanText(body.progress_update_id, 64),
    construction_stage_id: cleanText(body.construction_stage_id, 64),
  };
}

/** Map a guarded-command failure onto the HTTP error contract. */
const COMMAND_FAILURES: ReadonlyArray<
  [string, { status: number; error: string; code?: string }]
> = [
  ['BUILDER_STALE_WRITE', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_VERSION', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_STATUS', { status: 409, error: 'This record was changed by another user', code: 'STALE_STATUS' }],
  ['INVALID_TRANSITION', { status: 409, error: 'That status change is not allowed', code: 'INVALID_TRANSITION' }],
  ['BUILDER_CONSTRUCTION_STAGE_NOT_FOUND', { status: 404, error: 'Construction stage not found' }],
  ['BUILDER_CONSTRUCTION_NOT_FOUND', { status: 404, error: 'Construction case not found' }],
  ['BUILDER_CONSTRUCTION_REQUIRED', { status: 400, error: 'A construction case is required' }],
  ['BUILDER_MILESTONE_NOT_FOUND', { status: 404, error: 'Milestone not found' }],
  ['BUILDER_PHOTOGRAPH_NOT_FOUND', { status: 404, error: 'Photograph not found' }],
  ['BUILDER_TRANSACTION_NOT_FOUND', { status: 404, error: 'Transaction not found' }],
  ['BUILDER_TRANSACTION_REQUIRED', { status: 400, error: 'A transaction is required' }],
  ['BUILDER_CONSTRUCTION_PARENT_MISMATCH', { status: 400, error: 'That construction case does not match its transaction' }],
  ['BUILDER_MILESTONE_PARENT_MISMATCH', { status: 400, error: 'That stage belongs to a different construction case' }],
  ['BUILDER_PHOTOGRAPH_PARENT_MISMATCH', { status: 400, error: 'That stage or update belongs to a different construction case' }],
  ['BUILDER_PROGRESS_TITLE_REQUIRED', { status: 400, error: 'A title is required' }],
  ['BUILDER_PHOTOGRAPH_PATH_REQUIRED', { status: 400, error: 'A file is required' }],
  ['BUILDER_INVALID_DATE_KIND', { status: 400, error: 'That date cannot be changed' }],
  ['builder_construction_cases_transaction_id_key', { status: 409, error: 'That transaction already has a construction case', code: 'CASE_EXISTS' }],
  ['REASON_REQUIRED', { status: 400, error: 'A reason is required' }],
];

export function constructionCommandFailure(
  message: string,
): { status: number; error: string; code?: string } | null {
  for (const [needle, response] of COMMAND_FAILURES) {
    if (message.includes(needle)) return response;
  }
  return null;
}

/** Transitions the portal offers. The database is the authority. */
export function allowedConstructionTransitions(from: string): string[] {
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
export function allowedMilestoneTransitions(from: string): string[] {
  switch (from) {
    case 'achieved': return [];
    case 'pending': return ['in_progress', 'achieved', 'missed', 'waived'];
    case 'in_progress': return ['pending', 'achieved', 'missed', 'waived'];
    case 'missed': case 'waived': return ['pending', 'in_progress'];
    default: return [];
  }
}
