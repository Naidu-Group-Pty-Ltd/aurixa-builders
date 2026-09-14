/**
 * Shared Builder Transaction domain helpers.
 *
 * Mirrors `_shared/builderProjects.ts` and `_shared/builderInventory.ts`: one
 * place for enums, audience select lists, normalisation and the error-to-HTTP
 * table so the portal-facing (`builder-portal-transactions`) and Command Centre
 * facing (`builder-transactions-admin`) functions can never drift apart.
 *
 * DATA BOUNDARY: no select list here names a cost, margin, supplier price,
 * contractor price or commission column, because none exists — the migration
 * asserts that at apply time. The purchaser is carried by name and contact only;
 * no client income, expense, asset, liability, employment, borrowing-capacity,
 * serviceability or AML field is reachable from this module.
 */

export const BUILDER_TRANSACTION_TYPES = [
  'off_the_plan', 'house_and_land', 'established', 'land_only',
  'build_only', 'knockdown_rebuild', 'other',
] as const;

export const BUILDER_TRANSACTION_STATUSES = [
  'lead', 'reserved', 'contract_issued', 'contract_signed', 'unconditional',
  'construction', 'practical_completion', 'settled', 'cancelled', 'lapsed',
] as const;

export const BUILDER_TRANSACTION_PARTY_ROLES = [
  'purchaser', 'purchaser_solicitor', 'vendor', 'vendor_solicitor',
  'sales_agent', 'broker', 'guarantor', 'other',
] as const;

/**
 * Shared transaction columns. Explicit allow-list — never `select('*')`.
 * `builder_notes` is deliberately absent: it is Builder-private and appears only
 * in the detail projections below.
 */
const TRANSACTION_SHARED_SELECT = `
  id, project_id, unit_id, organisation_id, client_id,
  transaction_reference, transaction_type, status,
  purchaser_name, purchaser_email, purchaser_phone,
  contract_price, deposit_amount, deposit_received,
  contract_issued_date, contract_signed_date, unconditional_date, sunset_date,
  estimated_settlement_date, actual_settlement_date,
  shared_summary, risk_flag,
  row_version, opened_at, closed_at, created_at, updated_at
`;

export const BUILDER_TRANSACTION_PORTAL_LIST_SELECT = TRANSACTION_SHARED_SELECT;
export const BUILDER_TRANSACTION_PORTAL_DETAIL_SELECT =
  `${TRANSACTION_SHARED_SELECT}, builder_notes, risk_notes`;
export const BUILDER_TRANSACTION_COMMAND_CENTRE_SELECT =
  `${TRANSACTION_SHARED_SELECT}, builder_notes, risk_notes`;

export const BUILDER_TRANSACTION_PARTY_SELECT = `
  id, transaction_id, role, name, organisation, email, phone, reference,
  is_primary_contact, notes, row_version, created_at, updated_at
`;

export const BUILDER_TRANSACTION_HISTORY_SELECT = `
  id, from_status, to_status, changed_by_type, reason, created_at
`;

export const BUILDER_PIPELINE_STAGE_SELECT = `
  status, stage_key, stage_label, stage_order, is_terminal
`;

/**
 * The case-link projection. Deliberately narrow: the Builder audience sees THAT
 * a case exists and which slots are filled, never the Legal matter's contents,
 * the Finance file's contents or any client financial position.
 */
export const BUILDER_CASE_LINK_SELECT = `
  id, case_id, builder_transaction_id, link_source, linked_at
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
 * Build a sanitised transaction payload.
 *
 * `status` is NOT writable here — it moves only through the transition command,
 * which writes history. `client_id` is not writable here either: setting the
 * client is its own audited command because it is what makes a case possible.
 */
export function buildTransactionPayload(
  body: Record<string, any>, { isCreate, audience }: { isCreate: boolean; audience: 'builder' | 'command_centre' },
) {
  const payload: Record<string, unknown> = {};
  if ('transaction_reference' in body && audience === 'command_centre') {
    payload.transaction_reference = cleanText(body.transaction_reference, 60);
  }
  if ('transaction_type' in body) {
    payload.transaction_type = cleanEnum(body.transaction_type, BUILDER_TRANSACTION_TYPES, 'off_the_plan');
  }
  if ('purchaser_name' in body) payload.purchaser_name = cleanText(body.purchaser_name, 200);
  if ('purchaser_email' in body) {
    payload.purchaser_email = cleanText(body.purchaser_email, 200)?.toLowerCase() ?? null;
  }
  if ('purchaser_phone' in body) payload.purchaser_phone = cleanText(body.purchaser_phone, 40);
  if ('contract_price' in body) payload.contract_price = cleanNumber(body.contract_price);
  if ('deposit_amount' in body) payload.deposit_amount = cleanNumber(body.deposit_amount);
  if ('deposit_received' in body) payload.deposit_received = !!body.deposit_received;
  for (const field of ['contract_issued_date', 'contract_signed_date', 'unconditional_date',
    'sunset_date', 'estimated_settlement_date', 'actual_settlement_date'] as const) {
    if (field in body) payload[field] = cleanDate(body[field]);
  }
  if ('shared_summary' in body) payload.shared_summary = cleanText(body.shared_summary, 4000);
  if ('builder_notes' in body) payload.builder_notes = cleanText(body.builder_notes, 8000);
  if ('risk_flag' in body) payload.risk_flag = !!body.risk_flag;
  if ('risk_notes' in body) payload.risk_notes = cleanText(body.risk_notes, 4000);
  if (isCreate && !('transaction_type' in payload)) payload.transaction_type = 'off_the_plan';
  return payload;
}

export function buildTransactionPartyPayload(body: Record<string, any>) {
  return {
    role: cleanEnum(body.role, BUILDER_TRANSACTION_PARTY_ROLES, 'other'),
    name: cleanText(body.name, 200),
    organisation: cleanText(body.organisation, 200),
    email: cleanText(body.email, 200)?.toLowerCase() ?? null,
    phone: cleanText(body.phone, 40),
    reference: cleanText(body.reference, 60),
    is_primary_contact: !!body.is_primary_contact,
    notes: cleanText(body.notes, 4000),
  };
}

/**
 * Map a guarded-command failure onto the HTTP error contract. The keys are the
 * exact MESSAGE strings the transaction commands raise; both functions use this
 * one table so their error contracts cannot drift.
 */
const COMMAND_FAILURES: ReadonlyArray<
  [string, { status: number; error: string; code?: string }]
> = [
  ['BUILDER_STALE_WRITE', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_VERSION', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_STATUS', { status: 409, error: 'This record was changed by another user', code: 'STALE_STATUS' }],
  ['INVALID_TRANSITION', { status: 409, error: 'That status change is not allowed', code: 'INVALID_TRANSITION' }],
  ['BUILDER_TRANSACTION_NOT_FOUND', { status: 404, error: 'Transaction not found' }],
  ['BUILDER_PARTY_NOT_FOUND', { status: 404, error: 'Party not found' }],
  ['BUILDER_PARTY_NAME_REQUIRED', { status: 400, error: 'A party name is required' }],
  ['BUILDER_PROJECT_NOT_FOUND', { status: 404, error: 'Project not found' }],
  ['BUILDER_PROJECT_REQUIRED', { status: 400, error: 'A project and organisation are required' }],
  ['BUILDER_CLIENT_NOT_FOUND', { status: 404, error: 'Client not found' }],
  ['BUILDER_TRANSACTION_PARENT_MISMATCH', { status: 400, error: 'That unit belongs to a different project' }],
  ['BUILDER_TRANSACTION_ORG_MISMATCH', { status: 400, error: 'That organisation is not a party to this project' }],
  ['BUILDER_TRANSACTION_HAS_NO_CLIENT', { status: 409, error: 'Set a client before linking this transaction to a case', code: 'NO_CLIENT' }],
  ['BUILDER_TRANSACTION_CASE_LINKED', { status: 409, error: 'Unlink the transaction from its case before changing the client', code: 'CASE_LINKED' }],
  ['BUILDER_CASE_SLOT_TAKEN', { status: 409, error: 'That case already has a builder transaction', code: 'SLOT_TAKEN' }],
  ['BUILDER_CASE_LINK_NOT_FOUND', { status: 404, error: 'This transaction is not linked to a case' }],
  ['CROSS_CLIENT_CASE_LINK', { status: 409, error: 'That case belongs to a different client', code: 'CROSS_CLIENT' }],
  ['CASE_NOT_FOUND', { status: 404, error: 'Case not found' }],
  ['builder_transactions_one_live_per_unit', { status: 409, error: 'That unit already has a live transaction', code: 'UNIT_TAKEN' }],
  ['REASON_REQUIRED', { status: 400, error: 'A reason is required' }],
];

export function transactionCommandFailure(
  message: string,
): { status: number; error: string; code?: string } | null {
  for (const [needle, response] of COMMAND_FAILURES) {
    if (message.includes(needle)) return response;
  }
  return null;
}

/** Transitions the portal offers. The database is the authority. */
export function allowedTransactionTransitions(from: string): string[] {
  const terminal = ['cancelled', 'lapsed'];
  switch (from) {
    case 'settled': case 'cancelled': case 'lapsed': return [];
    case 'lead': return ['reserved', 'contract_issued', ...terminal];
    case 'reserved': return ['contract_issued', 'lead', ...terminal];
    case 'contract_issued': return ['contract_signed', 'reserved', ...terminal];
    case 'contract_signed': return ['unconditional', 'contract_issued', ...terminal];
    case 'unconditional': return ['construction', 'practical_completion', 'settled', ...terminal];
    case 'construction': return ['practical_completion', 'unconditional', ...terminal];
    case 'practical_completion': return ['settled', 'construction', ...terminal];
    default: return [];
  }
}
