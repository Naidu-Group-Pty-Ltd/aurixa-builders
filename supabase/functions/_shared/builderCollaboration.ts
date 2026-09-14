/**
 * Shared Builder Collaboration domain helpers — documents and their versions,
 * document permissions, conversations and messages, tasks and assignments, and
 * notifications with unread counts.
 *
 * Mirrors `_shared/builderDelivery.ts`. Unlike the delivery aggregates, which
 * all hang off the construction case, a collaboration row may be attached to
 * ANY Builder aggregate. So every row carries a discriminated
 * `(scope_type, scope_id)` pair and one database resolver
 * (`builder_resolve_scope_permission`) dispatches to the resolver that already
 * governs that aggregate. This module never decides access — it only shapes the
 * request for, and the response from, that resolver.
 *
 * DATA BOUNDARY:
 *   * A document is metadata. The bytes live in storage and `storage_path` is
 *     STRIPPED from every response; a caller receives a short-lived signed URL
 *     only after the server has resolved their permission.
 *   * A message is text between Builder users. No Client, Finance, Solicitor or
 *     AML field is selected anywhere in this module.
 *   * A notification is a POINTER. It names what happened and what it happened
 *     to; it never carries a copy of the record.
 */

export const BUILDER_SCOPE_TYPES = [
  'project', 'unit', 'transaction', 'construction_case',
] as const;
export type BuilderScopeType = (typeof BUILDER_SCOPE_TYPES)[number];

export const BUILDER_DOCUMENT_TYPES = [
  'contract', 'plan', 'specification', 'permit', 'certificate', 'variation',
  'claim', 'inspection_report', 'defect_report', 'handover_pack', 'warranty',
  'photo', 'other',
] as const;

export const BUILDER_DOCUMENT_STATUSES = [
  'active', 'superseded', 'archived', 'withdrawn',
] as const;

export const BUILDER_CONVERSATION_STATUSES = ['open', 'resolved', 'archived'] as const;

export const BUILDER_TASK_STATUSES = [
  'open', 'in_progress', 'blocked', 'done', 'cancelled',
] as const;

export const BUILDER_TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const BUILDER_NOTIFICATION_TYPES = [
  'general', 'task_assigned', 'task_due', 'message', 'defect_raised',
  'inspection_scheduled', 'status_change', 'document_added', 'variation_decision',
] as const;

/**
 * Explicit allow-lists — never `select('*')`.
 *
 * `builder_documents` has no storage column at all; the path lives on the
 * version row and is deliberately absent from BUILDER_DOCUMENT_VERSION_SELECT.
 */
export const BUILDER_DOCUMENT_SELECT = `
  id, scope_type, scope_id, title, description, document_type, status,
  current_version_id, is_customer_visible, row_version, created_at, updated_at
`;

/** No `storage_path`. A path is resolved into a signed URL, never returned raw. */
export const BUILDER_DOCUMENT_VERSION_SELECT = `
  id, document_id, version_number, file_name, content_type, byte_size, checksum,
  change_note, uploaded_by_type, uploaded_by_builder_user_id, created_at,
  lifecycle_status, malware_scan_status, detected_mime_type, scanned_at
`;

export const BUILDER_DOCUMENT_GRANT_SELECT = `
  id, document_id, builder_user_id, can_download, granted_at, revoked_at,
  revocation_reason, row_version, created_at, updated_at
`;

export const BUILDER_CONVERSATION_SELECT = `
  id, scope_type, scope_id, subject, status, last_message_at, message_count,
  row_version, created_at, updated_at
`;

export const BUILDER_PARTICIPANT_SELECT = `
  id, conversation_id, builder_user_id, last_read_at, joined_at, left_at,
  row_version, created_at, updated_at
`;

export const BUILDER_MESSAGE_SELECT = `
  id, conversation_id, body, author_type, author_builder_user_id,
  author_display_name, created_at
`;

export const BUILDER_TASK_SELECT = `
  id, scope_type, scope_id, title, description, status, priority, due_date,
  completed_at, created_by_builder_user_id, row_version, created_at, updated_at
`;

export const BUILDER_TASK_ASSIGNMENT_SELECT = `
  id, task_id, builder_user_id, assigned_at, assigned_by_builder_user_id,
  unassigned_at, row_version, created_at, updated_at
`;

export const BUILDER_NOTIFICATION_SELECT = `
  id, notification_type, title, body, scope_type, scope_id, entity_kind,
  entity_id, read_at, created_at
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
 * A scope pair from a request body is a REQUEST, not authority. It names which
 * aggregate to ask about; the database resolver then decides. An unrecognised
 * scope type resolves to null and the caller rejects the request outright.
 */
export function readScope(
  body: Record<string, unknown>,
): { scopeType: BuilderScopeType; scopeId: string } | null {
  const scopeType = cleanEnum(body.scope_type, BUILDER_SCOPE_TYPES);
  const scopeId = cleanText(body.scope_id, 64);
  if (!scopeType || !scopeId) return null;
  return { scopeType, scopeId };
}

/** The permission key each collaboration surface resolves against. */
export function permissionKeyForScopeSurface(
  surface: 'documents' | 'messages' | 'tasks',
): string {
  return surface;
}

export function buildDocumentPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('title' in body) payload.title = cleanText(body.title, 200);
  if ('description' in body) payload.description = cleanText(body.description, 4000);
  if ('document_type' in body) {
    payload.document_type = cleanEnum(body.document_type, BUILDER_DOCUMENT_TYPES, 'other');
  }
  if ('status' in body) {
    payload.status = cleanEnum(body.status, BUILDER_DOCUMENT_STATUSES, 'active');
  }
  if ('is_customer_visible' in body) payload.is_customer_visible = !!body.is_customer_visible;
  return payload;
}

/**
 * A version payload. `storage_path` is the ONLY place a path is accepted, and it
 * is confined to the storage prefix the portal owns — a caller cannot aim a
 * version at an object belonging to another portal's bucket path.
 */
export function buildVersionPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  payload.storage_path = cleanText(body.storage_path, 500);
  payload.file_name = cleanText(body.file_name, 255);
  if ('content_type' in body) payload.content_type = cleanText(body.content_type, 120);
  if ('byte_size' in body) payload.byte_size = cleanNumber(body.byte_size);
  if ('checksum' in body) payload.checksum = cleanText(body.checksum, 128);
  if ('change_note' in body) payload.change_note = cleanText(body.change_note, 1000);
  return payload;
}

export const BUILDER_DOCUMENT_BUCKET = 'builder-documents';
export const BUILDER_DOCUMENT_STORAGE_PREFIX = 'documents/';
export const BUILDER_DOCUMENT_URL_TTL_SECONDS = 300;

/**
 * A path outside the Builder prefix is refused before it reaches the database.
 * A caller supplies a path; that path is not authority, and traversal, absolute
 * paths and any prefix but ours are rejected so an upload cannot be aimed at
 * another portal's objects.
 */
export function isAcceptableStoragePath(path: string | null): boolean {
  if (!path) return false;
  if (path.includes('..') || path.startsWith('/')) return false;
  return path.startsWith(BUILDER_DOCUMENT_STORAGE_PREFIX);
}

export function buildConversationPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  payload.subject = cleanText(body.subject, 200);
  return payload;
}

export function buildTaskPayload(body: Record<string, any>) {
  const payload: Record<string, unknown> = {};
  if ('title' in body) payload.title = cleanText(body.title, 200);
  if ('description' in body) payload.description = cleanText(body.description, 8000);
  if ('status' in body) payload.status = cleanEnum(body.status, BUILDER_TASK_STATUSES, 'open');
  if ('priority' in body) {
    payload.priority = cleanEnum(body.priority, BUILDER_TASK_PRIORITIES, 'normal');
  }
  if ('due_date' in body) payload.due_date = cleanDate(body.due_date);
  return payload;
}

/** Map a guarded-command failure onto the HTTP error contract. */
const COMMAND_FAILURES: ReadonlyArray<
  [string, { status: number; error: string; code?: string }]
> = [
  ['BUILDER_STALE_WRITE', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['STALE_VERSION', { status: 409, error: 'This record was changed by another user', code: 'STALE_VERSION' }],
  ['BUILDER_DOCUMENT_NOT_FOUND', { status: 404, error: 'Document not found' }],
  ['BUILDER_DOCUMENT_TITLE_REQUIRED', { status: 400, error: 'A document title is required' }],
  ['BUILDER_DOCUMENT_FILE_REQUIRED', { status: 400, error: 'A file is required' }],
  ['BUILDER_DOCUMENT_VERSION_IMMUTABLE', { status: 409, error: 'A document version cannot be changed' }],
  ['BUILDER_DOCUMENT_GRANT_NOT_FOUND', { status: 404, error: 'That permission does not exist' }],
  ['BUILDER_CONVERSATION_NOT_FOUND', { status: 404, error: 'Conversation not found' }],
  ['BUILDER_CONVERSATION_SUBJECT_REQUIRED', { status: 400, error: 'A subject is required' }],
  ['BUILDER_CONVERSATION_ARCHIVED', { status: 409, error: 'This conversation is archived' }],
  ['BUILDER_MESSAGE_BODY_REQUIRED', { status: 400, error: 'A message cannot be empty' }],
  ['BUILDER_MESSAGE_IMMUTABLE', { status: 409, error: 'A message cannot be changed' }],
  ['BUILDER_NOT_A_PARTICIPANT', { status: 403, error: 'You are not in this conversation' }],
  ['BUILDER_TASK_NOT_FOUND', { status: 404, error: 'Task not found' }],
  ['BUILDER_TASK_TITLE_REQUIRED', { status: 400, error: 'A task title is required' }],
  ['BUILDER_ASSIGNMENT_NOT_FOUND', { status: 404, error: 'That assignment does not exist' }],
  ['BUILDER_NOTIFICATION_READER_REQUIRED', { status: 400, error: 'A reader is required' }],
  ['BUILDER_SCOPE_TARGET_NOT_FOUND', { status: 404, error: 'That record no longer exists' }],
];

export function collaborationCommandFailure(
  message: string,
): { status: number; error: string; code?: string } | null {
  for (const [needle, response] of COMMAND_FAILURES) {
    if (message.includes(needle)) return response;
  }
  return null;
}
