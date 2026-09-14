/**
 * Builder / Developer Portal — document safety constants and helpers.
 *
 * Deliberately thin. Every primitive that decides whether a file is safe —
 * MIME sniffing, SHA-256, and the malware scan itself — comes from
 * `_shared/immutableDocuments.ts`, which is the same module the Solicitor
 * pipeline uses. There is ONE scanning contract and ONE provider configuration
 * for the whole application; this file only carries the Builder-specific
 * bucket, limits and allow-list.
 */

/** Private bucket. Never public; every read is a short-lived signed URL. */
export const BUILDER_DOCUMENT_BUCKET = 'builder-documents';

/** Object paths must live under this prefix. */
export const BUILDER_DOCUMENT_STORAGE_PREFIX = 'documents/';

/** Signed URLs are deliberately short-lived — a leaked link outlives nothing. */
export const BUILDER_DOCUMENT_URL_TTL_SECONDS = 300;

/**
 * 25 MB. Lower than the legal limit: Builder documents are plans, certificates,
 * inspection reports and site photographs, not discovery bundles.
 */
export const MAX_BUILDER_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * What a Builder organisation may upload. Enforced against the DETECTED type
 * after download, not the declared one — a declared content-type is a claim by
 * the uploader, not evidence.
 */
export const BUILDER_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);

/**
 * Reject traversal, absolute paths and anything outside the Builder prefix.
 * A storage path is caller-supplied, so it is treated as hostile.
 */
export function isAcceptableBuilderStoragePath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false;
  if (path.length > 400) return false;
  return path.startsWith(BUILDER_DOCUMENT_STORAGE_PREFIX);
}

/** True when the detected type is one a Builder organisation may store. */
export function isAllowedBuilderMime(mime: string | null | undefined): boolean {
  return !!mime && BUILDER_ALLOWED_MIME_TYPES.has(mime.toLowerCase().split(';')[0].trim());
}
