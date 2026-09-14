/**
 * Shared Builder Workspace domain helpers — dashboard summaries, activity
 * history, organisation settings and user settings.
 *
 * Mirrors `_shared/builderCollaboration.ts`. This module adds no business
 * aggregate: it shapes the request for, and the response from, functions that
 * read across the modules already built.
 *
 * DATA BOUNDARY:
 *   * The activity projection carries what changed and when. It deliberately
 *     omits `previous_state`, `new_state`, `ip_address` and `user_agent` —
 *     those are the Command Centre's forensic record, not a portal user's.
 *   * Settings carry contact and display preferences. No money, no client
 *     financial position, no AML determination, no credential.
 */

export const BUILDER_LANDING_PAGES = [
  'dashboard', 'projects', 'inventory', 'transactions',
  'construction', 'documents', 'messages', 'tasks',
] as const;

export const BUILDER_DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;

export const BUILDER_EMAIL_DIGESTS = ['off', 'daily', 'weekly'] as const;

/**
 * Entity types the portal activity feed may filter on. Identity and
 * administration are absent by construction — the database refuses them too,
 * but a request naming one is rejected before it reaches the query.
 */
export const BUILDER_ACTIVITY_ENTITY_TYPES = [
  'project', 'project_party',
  'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
  'reservation', 'allocation',
  'transaction', 'transaction_party',
  'construction_case', 'construction_stage', 'milestone',
  'progress_update', 'photograph',
  'variation', 'variation_approval', 'progress_claim',
  'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim',
  'document', 'document_version', 'conversation', 'message',
  'task', 'task_assignment',
] as const;

/** Explicit allow-lists — never `select('*')`. */
export const BUILDER_ORGANISATION_SETTINGS_SELECT = `
  id, organisation_id, display_name, primary_contact_name, primary_contact_email,
  primary_contact_phone, timezone, default_landing_page, notify_on_defect,
  notify_on_inspection, notify_on_variation, notify_on_message, notify_on_task,
  row_version, created_at, updated_at
`;

export const BUILDER_USER_PREFERENCES_SELECT = `
  id, builder_user_id, default_organisation_id, landing_page, timezone, date_format,
  email_digest, notify_task_assigned, notify_message_posted, notify_status_change,
  tour_completed_at, row_version, created_at, updated_at
`;

export function cleanText(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().slice(0, max);
  return s.length ? s : null;
}

export function cleanEnum<T extends readonly string[]>(
  value: unknown, allowed: T, fallback: T[number] | null = null,
): T[number] | null {
  const s = String(value ?? '').trim();
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : fallback;
}

export function cleanLimit(value: unknown, fallback = 50, max = 200): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** A timezone is stored as text; only an IANA-shaped value is accepted. */
export function cleanTimezone(value: unknown): string | null {
  const s = cleanText(value, 64);
  if (!s) return null;
  return /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/.test(s) ? s : null;
}

export function buildOrganisationSettingsPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('display_name' in body) payload.display_name = cleanText(body.display_name, 200);
  if ('primary_contact_name' in body) {
    payload.primary_contact_name = cleanText(body.primary_contact_name, 200);
  }
  if ('primary_contact_email' in body) {
    const email = cleanText(body.primary_contact_email, 255);
    payload.primary_contact_email = email && email.includes('@') ? email : null;
  }
  if ('primary_contact_phone' in body) {
    payload.primary_contact_phone = cleanText(body.primary_contact_phone, 60);
  }
  if ('timezone' in body) payload.timezone = cleanTimezone(body.timezone);
  if ('default_landing_page' in body) {
    payload.default_landing_page = cleanEnum(
      body.default_landing_page, BUILDER_LANDING_PAGES, 'dashboard');
  }
  for (const flag of ['notify_on_defect', 'notify_on_inspection', 'notify_on_variation',
    'notify_on_message', 'notify_on_task']) {
    if (flag in body) payload[flag] = !!body[flag];
  }
  return payload;
}

export function buildUserPreferencesPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  // A default organisation is a PREFERENCE. The database still validates it
  // against a live active membership, so this only carries the request.
  if ('default_organisation_id' in body) {
    payload.default_organisation_id = cleanText(body.default_organisation_id, 64);
  }
  if ('landing_page' in body) {
    payload.landing_page = cleanEnum(body.landing_page, BUILDER_LANDING_PAGES, 'dashboard');
  }
  if ('timezone' in body) payload.timezone = cleanTimezone(body.timezone);
  if ('date_format' in body) {
    payload.date_format = cleanEnum(body.date_format, BUILDER_DATE_FORMATS, 'DD/MM/YYYY');
  }
  if ('email_digest' in body) {
    payload.email_digest = cleanEnum(body.email_digest, BUILDER_EMAIL_DIGESTS, 'daily');
  }
  for (const flag of ['notify_task_assigned', 'notify_message_posted', 'notify_status_change']) {
    if (flag in body) payload[flag] = !!body[flag];
  }
  return payload;
}

/** Map a guarded-command failure onto the HTTP error contract. */
const COMMAND_FAILURES: ReadonlyArray<
  [string, { status: number; error: string; code?: string }]
> = [
  ['BUILDER_STALE_WRITE', { status: 409, error: 'These settings were changed by someone else', code: 'STALE_VERSION' }],
  ['STALE_VERSION', { status: 409, error: 'These settings were changed by someone else', code: 'STALE_VERSION' }],
  ['BUILDER_ORGANISATION_NOT_FOUND', { status: 404, error: 'Organisation not found' }],
  ['BUILDER_USER_NOT_FOUND', { status: 404, error: 'That portal user does not exist' }],
  ['BUILDER_PREFERENCE_OWNER_REQUIRED', { status: 400, error: 'A user is required' }],
  ['BUILDER_NOT_A_MEMBER', { status: 403, error: 'You are not a member of that organisation' }],
  ['builder_organisation_settings_default_landing_page_check', { status: 400, error: 'That landing page is not available' }],
  ['builder_organisation_settings_primary_contact_email_check', { status: 400, error: 'That email address is not valid' }],
  ['builder_user_preferences_landing_page_check', { status: 400, error: 'That landing page is not available' }],
  ['builder_user_preferences_date_format_check', { status: 400, error: 'That date format is not available' }],
  ['builder_user_preferences_email_digest_check', { status: 400, error: 'That digest setting is not available' }],
];

export function workspaceCommandFailure(
  message: string,
): { status: number; error: string; code?: string } | null {
  for (const [needle, response] of COMMAND_FAILURES) {
    if (message.includes(needle)) return response;
  }
  return null;
}

/** A human label for each audited action the portal feed can show. */
export function activityActionLabel(action: string): string {
  return action
    .replace(/^builder_/, '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
