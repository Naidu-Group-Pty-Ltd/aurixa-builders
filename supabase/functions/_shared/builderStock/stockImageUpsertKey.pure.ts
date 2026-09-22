/**
 * ===========================================================================
 * AN UPSERT KEYED ON A NULLABLE COLUMN IS NOT AN UPSERT WHEN IT IS NULL.
 * ===========================================================================
 *
 * Every writer of `builder_stock_item_images` upserts, and every one of them
 * named the same conflict target as a literal:
 *
 *     onConflict: 'stock_item_id,source_stage,source_reference'
 *
 * which is right for an image attributed to a property and silently wrong for
 * one that is not. A UNIQUE index in PostgreSQL treats NULLs as DISTINCT, so
 * two rows holding `(NULL, 'uploaded_document', 'page1:…')` do not conflict,
 * `ON CONFLICT` has nothing to fire on, and the upsert INSERTS.
 *
 * MEASURED 22 SEPTEMBER 2026 through the real image settler: one document with
 * two pictures produced SEVEN rows — one attributed and six orphans, identical
 * sha256, identical storage path, six tenths of a second apart, one per
 * settlement pass. A write designed to be idempotent was idempotent for every
 * attributed image and for no unattributed one, and each repeat was an image
 * row belonging to no property.
 *
 * So the key is chosen from the row rather than assumed, once, here. The
 * unattached case is scoped by the UPLOAD, which is the thing an unattributed
 * image does belong to — see the partial index in
 * `20260922060000_an_upsert_keyed_on_a_null_is_not_an_upsert.sql`, and in
 * particular why the existing index is NOT simply made `NULLS NOT DISTINCT`:
 * `source_reference` is a position inside a document, two builders' uploads
 * can produce the same one, and merging those rows would be a cross-tenant
 * collision — a far worse defect than the one being fixed.
 *
 * NINE CALL SITES, ONE RULE. Nine literals is how one of them comes to be
 * wrong, and this one was wrong in all nine.
 */

/** The conflict target for an image row, decided by whether it is attributed. */
export function stockImageUpsertKey(stockItemId: unknown): string {
  return String(stockItemId ?? '').trim()
    ? 'stock_item_id,source_stage,source_reference'
    : 'upload_id,source_stage,source_reference';
}
