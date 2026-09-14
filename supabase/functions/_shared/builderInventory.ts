/**
 * Shared Builder Inventory domain helpers.
 *
 * Mirrors `_shared/legalMatters.ts` / `_shared/builderProjects.ts`: one place for
 * enums, audience select lists and normalisation so the portal-facing
 * (`builder-portal-inventory`) and Command Centre facing
 * (`builder-inventory-admin`) functions can never drift apart.
 *
 * DATA BOUNDARY: no select list here names a cost, margin, supplier price or
 * contractor price column, because none exists — the migration asserts that at
 * apply time. The customer-facing list price is the only commercial figure.
 */

export const BUILDER_UNIT_TYPES = [
  'house', 'townhouse', 'apartment', 'duplex', 'land', 'terrace', 'other',
] as const;

export const BUILDER_AVAILABILITY_STATUSES = [
  'available', 'on_hold', 'reserved', 'contracted', 'settled', 'withdrawn',
] as const;

export const BUILDER_RELEASE_STATUSES = [
  'unreleased', 'coming_soon', 'released', 'sold_out',
] as const;

export const BUILDER_STAGE_STATUSES = [
  'planned', 'released', 'under_construction', 'completed', 'on_hold', 'cancelled',
] as const;

export const BUILDER_LOT_STATUSES = [
  'planned', 'registered', 'titled', 'settled', 'withdrawn',
] as const;

export const BUILDER_PRICE_BASES = ['fixed', 'from', 'indicative', 'on_application'] as const;

export const BUILDER_RESERVATION_STATUSES = [
  'active', 'contracted', 'cancelled', 'expired', 'lapsed',
] as const;

export const BUILDER_ALLOCATION_TYPES = [
  'sales_channel', 'display', 'staff', 'investor', 'other',
] as const;

export const BUILDER_ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Shared unit columns. Explicit allow-list — never `select('*')`. */
const UNIT_SHARED_SELECT = `
  id, project_id, stage_id, building_id, lot_id,
  unit_number, unit_type, bedrooms, bathrooms, car_spaces,
  internal_area_sqm, external_area_sqm, level_number, aspect,
  availability_status, release_status, released_at,
  estimated_completion_date, description,
  row_version, created_at, updated_at
`;

export const BUILDER_UNIT_PORTAL_LIST_SELECT = UNIT_SHARED_SELECT;
export const BUILDER_UNIT_PORTAL_DETAIL_SELECT = UNIT_SHARED_SELECT;
export const BUILDER_UNIT_COMMAND_CENTRE_SELECT = UNIT_SHARED_SELECT;

export const BUILDER_STAGE_SELECT = `
  id, project_id, name, stage_number, description, status,
  estimated_completion_date, actual_completion_date, row_version, created_at, updated_at
`;

export const BUILDER_BUILDING_SELECT = `
  id, project_id, stage_id, name, building_code, level_count, status,
  row_version, created_at, updated_at
`;

export const BUILDER_LOT_SELECT = `
  id, project_id, stage_id, lot_number, plan_number, land_area_sqm, frontage_m,
  titled, titled_at, status, row_version, created_at, updated_at
`;

export const BUILDER_PRICING_SELECT = `
  id, unit_id, list_price, price_basis, effective_from, effective_to,
  is_current, reason, row_version, created_at
`;

export const BUILDER_HOLD_SELECT = `
  id, unit_id, organisation_id, held_by_builder_user_id, hold_reference, reason,
  expires_at, status, released_at, released_reason, row_version, created_at
`;

export const BUILDER_RESERVATION_SELECT = `
  id, unit_id, organisation_id, reservation_reference, purchaser_name,
  purchaser_email, purchaser_phone, reserved_by_builder_user_id, reservation_fee,
  reserved_at, expires_at, status, cancelled_reason, row_version, created_at, updated_at
`;

export const BUILDER_ALLOCATION_SELECT = `
  id, unit_id, allocated_to_organisation_id, allocation_type, reference,
  expires_at, status, released_at, released_reason, row_version, created_at
`;

export const BUILDER_UNIT_HISTORY_SELECT = `
  id, status_kind, from_status, to_status, changed_by_type, reason, created_at
`;

export const BUILDER_RESERVATION_HISTORY_SELECT = `
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

/** Build a sanitised unit payload. Availability and release are NOT writable
 *  here — they move only through their transition commands, which write history. */
export function buildUnitPayload(body: Record<string, any>, { isCreate }: { isCreate: boolean }) {
  const payload: Record<string, unknown> = {};
  if ('unit_number' in body) payload.unit_number = cleanText(body.unit_number, 60);
  if ('unit_type' in body) payload.unit_type = cleanEnum(body.unit_type, BUILDER_UNIT_TYPES, 'house');
  for (const field of ['bedrooms', 'car_spaces', 'level_number'] as const) {
    if (field in body) payload[field] = cleanNumber(body[field]);
  }
  for (const field of ['bathrooms', 'internal_area_sqm', 'external_area_sqm'] as const) {
    if (field in body) payload[field] = cleanNumber(body[field]);
  }
  if ('aspect' in body) payload.aspect = cleanEnum(body.aspect, BUILDER_ASPECTS);
  if ('estimated_completion_date' in body) {
    payload.estimated_completion_date = cleanDate(body.estimated_completion_date);
  }
  if ('description' in body) payload.description = cleanText(body.description, 4000);
  if (isCreate && !payload.unit_number) payload.unit_number = null;
  return payload;
}

export function buildStagePayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('name' in body) payload.name = cleanText(body.name, 200);
  if ('stage_number' in body) payload.stage_number = cleanText(body.stage_number, 40);
  if ('description' in body) payload.description = cleanText(body.description, 4000);
  if ('status' in body) payload.status = cleanEnum(body.status, BUILDER_STAGE_STATUSES);
  if ('estimated_completion_date' in body) {
    payload.estimated_completion_date = cleanDate(body.estimated_completion_date);
  }
  if ('actual_completion_date' in body) {
    payload.actual_completion_date = cleanDate(body.actual_completion_date);
  }
  return payload;
}

export function buildBuildingPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('name' in body) payload.name = cleanText(body.name, 200);
  if ('building_code' in body) payload.building_code = cleanText(body.building_code, 40);
  if ('level_count' in body) payload.level_count = cleanNumber(body.level_count);
  if ('status' in body) {
    payload.status = cleanEnum(body.status,
      ['planned', 'under_construction', 'completed', 'on_hold', 'cancelled'] as const);
  }
  return payload;
}

export function buildLotPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('lot_number' in body) payload.lot_number = cleanText(body.lot_number, 60);
  if ('plan_number' in body) payload.plan_number = cleanText(body.plan_number, 60);
  if ('land_area_sqm' in body) payload.land_area_sqm = cleanNumber(body.land_area_sqm);
  if ('frontage_m' in body) payload.frontage_m = cleanNumber(body.frontage_m);
  if ('titled' in body) payload.titled = !!body.titled;
  if ('titled_at' in body) payload.titled_at = cleanDate(body.titled_at);
  if ('status' in body) payload.status = cleanEnum(body.status, BUILDER_LOT_STATUSES);
  return payload;
}

export function buildReservationPayload(body: Record<string, any>) {
  return {
    reservation_reference: cleanText(body.reservation_reference, 60),
    purchaser_name: cleanText(body.purchaser_name, 200),
    purchaser_email: cleanText(body.purchaser_email, 200)?.toLowerCase() ?? null,
    purchaser_phone: cleanText(body.purchaser_phone, 40),
    reservation_fee: cleanNumber(body.reservation_fee),
    expires_at: body.expires_at ? String(body.expires_at) : null,
  };
}

/**
 * Map a guarded-command failure onto the HTTP error contract.
 *
 * The keys are the exact MESSAGE strings the inventory commands raise. Both the
 * portal-facing and Command Centre functions use this one table so their error
 * contracts cannot drift. Ordering matters only where one code is a substring of
 * another — none currently is, and new codes must preserve that.
 */
const COMMAND_FAILURES: ReadonlyArray<
  [string, { status: number; error: string; code?: string }]
> = [
  ['BUILDER_STALE_WRITE', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_VERSION', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_STATUS', { status: 409, error: 'This record was changed by another user', code: 'STALE_STATUS' }],
  ['INVALID_TRANSITION', { status: 409, error: 'That status change is not allowed', code: 'INVALID_TRANSITION' }],
  ['BUILDER_UNIT_NOT_FOUND', { status: 404, error: 'Unit not found' }],
  ['BUILDER_STAGE_NOT_FOUND', { status: 404, error: 'Stage not found' }],
  ['BUILDER_BUILDING_NOT_FOUND', { status: 404, error: 'Building not found' }],
  ['BUILDER_LOT_NOT_FOUND', { status: 404, error: 'Lot not found' }],
  ['BUILDER_HOLD_NOT_FOUND', { status: 404, error: 'Hold not found' }],
  ['BUILDER_RESERVATION_NOT_FOUND', { status: 404, error: 'Reservation not found' }],
  ['BUILDER_ALLOCATION_NOT_FOUND', { status: 404, error: 'Allocation not found' }],
  ['BUILDER_PROJECT_NOT_FOUND', { status: 404, error: 'Project not found' }],
  ['BUILDER_PROJECT_REQUIRED', { status: 400, error: 'A project is required' }],
  ['BUILDER_ORG_NOT_FOUND', { status: 404, error: 'Organisation not found' }],
  ['BUILDER_UNIT_PARENT_MISMATCH', { status: 400, error: 'That parent belongs to a different project' }],
  ['BUILDER_STAGE_PARENT_MISMATCH', { status: 400, error: 'That stage belongs to a different project' }],
  ['BUILDER_UNIT_NOT_AVAILABLE', { status: 409, error: 'This unit is not available', code: 'UNIT_NOT_AVAILABLE' }],
  ['BUILDER_UNIT_NOT_RESERVABLE', { status: 409, error: 'This unit cannot be reserved', code: 'UNIT_NOT_RESERVABLE' }],
  ['BUILDER_UNIT_PRICE_REQUIRED', { status: 409, error: 'Set a price before releasing this unit', code: 'PRICE_REQUIRED' }],
  ['BUILDER_HOLD_NOT_ACTIVE', { status: 409, error: 'This hold is no longer active', code: 'HOLD_NOT_ACTIVE' }],
  ['BUILDER_ALLOCATION_NOT_ACTIVE', { status: 409, error: 'This allocation is no longer active', code: 'ALLOCATION_NOT_ACTIVE' }],
  ['BUILDER_HOLD_EXPIRY_INVALID', { status: 400, error: 'The hold expiry must be in the future' }],
  ['BUILDER_RESERVATION_EXPIRY_INVALID', { status: 400, error: 'The reservation expiry must be in the future' }],
  ['BUILDER_ALLOCATION_EXPIRY_INVALID', { status: 400, error: 'The allocation expiry must be in the future' }],
  ['BUILDER_PURCHASER_REQUIRED', { status: 400, error: 'A purchaser name is required' }],
  ['BUILDER_INVALID_PRICE_BASIS', { status: 400, error: 'Invalid price basis' }],
  ['BUILDER_INVALID_PRICE', { status: 400, error: 'Invalid list price' }],
  ['BUILDER_INVALID_ALLOCATION_TYPE', { status: 400, error: 'Invalid allocation type' }],
  ['REASON_REQUIRED', { status: 400, error: 'A reason is required' }],
];

export function inventoryCommandFailure(
  message: string,
): { status: number; error: string; code?: string } | null {
  for (const [needle, response] of COMMAND_FAILURES) {
    if (message.includes(needle)) return response;
  }
  return null;
}

/** Availability transitions the portal offers. The database is the authority. */
export function allowedAvailabilityTransitions(from: string): string[] {
  switch (from) {
    case 'settled': return [];
    case 'available': return ['on_hold', 'reserved', 'withdrawn'];
    case 'on_hold': return ['available', 'reserved', 'withdrawn'];
    case 'reserved': return ['available', 'contracted', 'withdrawn'];
    case 'contracted': return ['settled', 'available'];
    case 'withdrawn': return ['available'];
    default: return [];
  }
}
