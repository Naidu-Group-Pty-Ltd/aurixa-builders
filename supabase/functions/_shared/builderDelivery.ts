/**
 * Shared Builder Delivery domain helpers — variations, variation approvals,
 * progress claims, inspections, defects, practical completion, handover and
 * warranty.
 *
 * Mirrors `_shared/builderConstruction.ts`. Every one of these aggregates is a
 * child of the construction case and is authorised by the SAME resolver, so one
 * shared module serves both the portal-facing (`builder-portal-delivery`) and
 * the Command Centre facing (`builder-delivery-admin`) function.
 *
 * DATA BOUNDARY:
 *   * A variation exposes the customer-facing variation price only.
 *   * A progress claim exposes what was claimed and certified, plus a nullable
 *     `finance_payment_id` POINTER. Receipt, reconciliation and commission stay
 *     with Finance on `build_progress_payments` and are never selected here.
 *   * Defects, inspections, practical completion, handover and warranty records
 *     carry no money at all — the migration asserts that at apply time.
 */

export const BUILDER_DELIVERY_KINDS = [
  'variation', 'progress_claim', 'inspection', 'defect',
  'practical_completion', 'handover', 'warranty_claim',
] as const;

export const BUILDER_VARIATION_ORIGINS = [
  'purchaser', 'builder', 'consultant', 'authority', 'site_condition', 'other',
] as const;

export const BUILDER_VARIATION_STATUSES = [
  'draft', 'submitted', 'approved', 'rejected', 'withdrawn', 'superseded',
] as const;

export const BUILDER_APPROVER_ROLES = [
  'purchaser', 'builder', 'developer', 'consultant', 'authority',
] as const;

export const BUILDER_APPROVAL_DECISIONS = ['pending', 'approved', 'rejected'] as const;

export const BUILDER_CLAIM_STATUSES = [
  'draft', 'submitted', 'certified', 'disputed', 'withdrawn', 'closed',
] as const;

export const BUILDER_INSPECTION_TYPES = [
  'quality', 'frame', 'waterproofing', 'pre_plaster',
  'practical_completion', 'handover', 'warranty', 'authority', 'other',
] as const;

export const BUILDER_INSPECTION_STATUSES = [
  'scheduled', 'rescheduled', 'in_progress', 'passed', 'failed',
  'passed_with_defects', 'cancelled',
] as const;

export const BUILDER_DEFECT_SEVERITIES = ['cosmetic', 'minor', 'major', 'critical'] as const;

export const BUILDER_DEFECT_STATUSES = [
  'open', 'acknowledged', 'in_rectification', 'rectified', 'verified', 'rejected', 'closed',
] as const;

export const BUILDER_DEFECT_RAISERS = [
  'builder', 'purchaser', 'inspector', 'developer', 'authority',
] as const;

export const BUILDER_PC_STATUSES = [
  'not_reached', 'notified', 'inspected', 'disputed', 'achieved',
] as const;

export const BUILDER_HANDOVER_STATUSES = [
  'not_scheduled', 'scheduled', 'walkthrough_complete', 'keys_released', 'completed',
] as const;

export const BUILDER_WARRANTY_TYPES = [
  'structural', 'non_structural', 'statutory', 'manufacturer', 'other',
] as const;

export const BUILDER_WARRANTY_CLAIM_STATUSES = [
  'lodged', 'under_review', 'accepted', 'rejected', 'rectified', 'closed',
] as const;

/** Explicit allow-lists — never `select('*')`. */
export const BUILDER_VARIATION_SELECT = `
  id, construction_case_id, variation_number, title, description, origin, status,
  variation_price, time_impact_days, submitted_at, decided_at,
  row_version, created_at, updated_at
`;

export const BUILDER_VARIATION_APPROVAL_SELECT = `
  id, variation_id, approver_role, approver_name, decision, decided_at, comments,
  row_version, created_at, updated_at
`;

/**
 * The claim projection. `finance_payment_id` is a POINTER — the Builder audience
 * learns only that Finance has a record, never its amount, receipt date or
 * commission. Nothing is read from `build_progress_payments`.
 */
export const BUILDER_CLAIM_SELECT = `
  id, construction_case_id, milestone_id, claim_number, claimed_amount, status,
  claimed_at, certified_at, certified_amount, dispute_reason, notes,
  finance_payment_id, row_version, created_at, updated_at
`;

export const BUILDER_INSPECTION_SELECT = `
  id, construction_case_id, construction_stage_id, inspection_type, title, status,
  inspector_name, inspector_organisation, scheduled_for, performed_at, outcome_notes,
  defect_count, is_customer_visible, row_version, created_at, updated_at
`;

export const BUILDER_DEFECT_SELECT = `
  id, construction_case_id, inspection_id, defect_number, title, description, location,
  severity, status, raised_by_type, raised_at, due_date, rectified_at, verified_at,
  is_customer_visible, row_version, created_at, updated_at
`;

export const BUILDER_PC_SELECT = `
  id, construction_case_id, status, notified_at, inspected_at, achieved_at,
  certificate_reference, outstanding_defect_count, dispute_reason, notes,
  row_version, created_at, updated_at
`;

export const BUILDER_HANDOVER_SELECT = `
  id, construction_case_id, status, scheduled_for, walkthrough_at, keys_released_at,
  completed_at, attendee_names, key_set_count, manual_provided, notes,
  row_version, created_at, updated_at
`;

export const BUILDER_WARRANTY_SELECT = `
  id, construction_case_id, warranty_type, provider_name, policy_reference,
  starts_on, expires_on, notes, row_version, created_at, updated_at
`;

export const BUILDER_WARRANTY_CLAIM_SELECT = `
  id, construction_case_id, warranty_id, claim_number, title, description, status,
  lodged_at, decided_at, rectified_at, decision_notes, row_version, created_at, updated_at
`;

export const BUILDER_DELIVERY_HISTORY_SELECT = `
  id, entity_kind, entity_id, from_status, to_status, changed_by_type, reason, created_at
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
 * Status is never in any payload below — every aggregate moves only through
 * `builder_transition_delivery`, which writes the history row.
 */
export function buildVariationPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('variation_number' in body) payload.variation_number = cleanText(body.variation_number, 60);
  if ('title' in body) payload.title = cleanText(body.title, 200);
  if ('description' in body) payload.description = cleanText(body.description, 8000);
  if ('origin' in body) payload.origin = cleanEnum(body.origin, BUILDER_VARIATION_ORIGINS, 'purchaser');
  if ('variation_price' in body) payload.variation_price = cleanNumber(body.variation_price);
  if ('time_impact_days' in body) payload.time_impact_days = cleanNumber(body.time_impact_days);
  return payload;
}

export function buildApprovalPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('approver_role' in body) {
    payload.approver_role = cleanEnum(body.approver_role, BUILDER_APPROVER_ROLES, 'purchaser');
  }
  if ('approver_name' in body) payload.approver_name = cleanText(body.approver_name, 200);
  if ('decision' in body) {
    payload.decision = cleanEnum(body.decision, BUILDER_APPROVAL_DECISIONS, 'pending');
  }
  if ('comments' in body) payload.comments = cleanText(body.comments, 4000);
  return payload;
}

export function buildClaimPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('claim_number' in body) payload.claim_number = cleanText(body.claim_number, 60);
  if ('claimed_amount' in body) payload.claimed_amount = cleanNumber(body.claimed_amount);
  if ('certified_amount' in body) payload.certified_amount = cleanNumber(body.certified_amount);
  if ('dispute_reason' in body) payload.dispute_reason = cleanText(body.dispute_reason, 4000);
  if ('notes' in body) payload.notes = cleanText(body.notes, 4000);
  return payload;
}

export function buildInspectionPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('inspection_type' in body) {
    payload.inspection_type = cleanEnum(body.inspection_type, BUILDER_INSPECTION_TYPES, 'quality');
  }
  if ('title' in body) payload.title = cleanText(body.title, 200);
  if ('inspector_name' in body) payload.inspector_name = cleanText(body.inspector_name, 200);
  if ('inspector_organisation' in body) {
    payload.inspector_organisation = cleanText(body.inspector_organisation, 200);
  }
  if ('scheduled_for' in body) {
    payload.scheduled_for = body.scheduled_for ? String(body.scheduled_for) : null;
  }
  if ('outcome_notes' in body) payload.outcome_notes = cleanText(body.outcome_notes, 8000);
  if ('is_customer_visible' in body) payload.is_customer_visible = !!body.is_customer_visible;
  return payload;
}

export function buildDefectPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('defect_number' in body) payload.defect_number = cleanText(body.defect_number, 60);
  if ('title' in body) payload.title = cleanText(body.title, 200);
  if ('description' in body) payload.description = cleanText(body.description, 8000);
  if ('location' in body) payload.location = cleanText(body.location, 200);
  if ('severity' in body) {
    payload.severity = cleanEnum(body.severity, BUILDER_DEFECT_SEVERITIES, 'minor');
  }
  if ('raised_by_type' in body) {
    payload.raised_by_type = cleanEnum(body.raised_by_type, BUILDER_DEFECT_RAISERS, 'builder');
  }
  if ('due_date' in body) payload.due_date = cleanDate(body.due_date);
  if ('is_customer_visible' in body) payload.is_customer_visible = !!body.is_customer_visible;
  return payload;
}

export function buildDeliveryRecordPayload(kind: string, body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if (kind === 'practical_completion') {
    if ('certificate_reference' in body) {
      payload.certificate_reference = cleanText(body.certificate_reference, 120);
    }
    if ('outstanding_defect_count' in body) {
      payload.outstanding_defect_count = cleanNumber(body.outstanding_defect_count);
    }
    if ('dispute_reason' in body) payload.dispute_reason = cleanText(body.dispute_reason, 4000);
  } else if (kind === 'handover') {
    if ('scheduled_for' in body) {
      payload.scheduled_for = body.scheduled_for ? String(body.scheduled_for) : null;
    }
    if ('attendee_names' in body) payload.attendee_names = cleanText(body.attendee_names, 1000);
    if ('key_set_count' in body) payload.key_set_count = cleanNumber(body.key_set_count);
    if ('manual_provided' in body) payload.manual_provided = !!body.manual_provided;
  } else {
    if ('warranty_type' in body) {
      payload.warranty_type = cleanEnum(body.warranty_type, BUILDER_WARRANTY_TYPES, 'structural');
    }
    if ('provider_name' in body) payload.provider_name = cleanText(body.provider_name, 200);
    if ('policy_reference' in body) payload.policy_reference = cleanText(body.policy_reference, 120);
    if ('starts_on' in body) payload.starts_on = cleanDate(body.starts_on);
    if ('expires_on' in body) payload.expires_on = cleanDate(body.expires_on);
  }
  if ('notes' in body) payload.notes = cleanText(body.notes, 8000);
  return payload;
}

export function buildWarrantyClaimPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('claim_number' in body) payload.claim_number = cleanText(body.claim_number, 60);
  if ('title' in body) payload.title = cleanText(body.title, 200);
  if ('description' in body) payload.description = cleanText(body.description, 8000);
  if ('decision_notes' in body) payload.decision_notes = cleanText(body.decision_notes, 4000);
  return payload;
}

/** Map a guarded-command failure onto the HTTP error contract. */
const COMMAND_FAILURES: ReadonlyArray<
  [string, { status: number; error: string; code?: string }]
> = [
  ['BUILDER_STALE_WRITE', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_VERSION', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_STATUS', { status: 409, error: 'This record was changed by another user', code: 'STALE_STATUS' }],
  ['INVALID_TRANSITION', { status: 409, error: 'That status change is not allowed', code: 'INVALID_TRANSITION' }],
  ['BUILDER_VARIATION_NOT_FOUND', { status: 404, error: 'Variation not found' }],
  ['BUILDER_APPROVAL_NOT_FOUND', { status: 404, error: 'Approval not found' }],
  ['BUILDER_CLAIM_NOT_FOUND', { status: 404, error: 'Progress claim not found' }],
  ['BUILDER_CLAIM_AMOUNT_REQUIRED', { status: 400, error: 'A claimed amount is required' }],
  ['BUILDER_INSPECTION_NOT_FOUND', { status: 404, error: 'Inspection not found' }],
  ['BUILDER_DEFECT_NOT_FOUND', { status: 404, error: 'Defect not found' }],
  ['BUILDER_WARRANTY_CLAIM_NOT_FOUND', { status: 404, error: 'Warranty claim not found' }],
  ['BUILDER_DELIVERY_NOT_FOUND', { status: 404, error: 'Record not found' }],
  ['BUILDER_CONSTRUCTION_NOT_FOUND', { status: 404, error: 'Construction case not found' }],
  ['BUILDER_CONSTRUCTION_REQUIRED', { status: 400, error: 'A construction case is required' }],
  ['BUILDER_DELIVERY_PARENT_MISMATCH', { status: 400, error: 'That parent belongs to a different construction case' }],
  ['BUILDER_MILESTONE_PARENT_MISMATCH', { status: 400, error: 'That stage belongs to a different construction case' }],
  ['BUILDER_INVALID_DELIVERY_KIND', { status: 400, error: 'Unknown record type' }],
  ['builder_warranties_window_valid', { status: 400, error: 'The warranty must expire after it starts' }],
  ['REASON_REQUIRED', { status: 400, error: 'A reason is required' }],
];

export function deliveryCommandFailure(
  message: string,
): { status: number; error: string; code?: string } | null {
  for (const [needle, response] of COMMAND_FAILURES) {
    if (message.includes(needle)) return response;
  }
  return null;
}

/**
 * Transitions the portal offers, per aggregate. Mirrors
 * `builder_is_delivery_transition_allowed`; the database is the authority.
 */
export function allowedDeliveryTransitions(kind: string, from: string): string[] {
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

/** The permission key each delivery aggregate resolves against. */
export function permissionKeyFor(kind: string): string {
  switch (kind) {
    case 'variation': return 'variations';
    case 'progress_claim': return 'progress_claims';
    case 'inspection': return 'inspections';
    case 'defect': return 'defects';
    default: return 'handover';
  }
}
