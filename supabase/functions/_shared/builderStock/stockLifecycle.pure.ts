/**
 * Builder Stock — what a property's lifecycle value means, in one place.
 *
 * THREE VALUES AND TWO RULES, and keeping the two rules apart is the whole of
 * safe publication:
 *
 *   `active`    published. The Marketplace and both portals serve it.
 *   `staged`    imported, being processed, INVISIBLE. A replacement list's new
 *               properties live here until the upload reaches readiness.
 *   `archived`  withdrawn. Kept for the audit trail and for the adviser
 *               selections made against it; never served, never processed.
 *
 *   SERVED      is `active` alone.
 *   PROCESSED   is `active` OR `staged`.
 *
 * WHY THE SECOND RULE EXISTS AT ALL, since it is the half that is easy to miss.
 * A staged row has to have its imagery worked out or it can never reach
 * readiness — and a row that cannot reach readiness can never be published, so
 * it would sit invisible for ever. Every queue, claim and repair therefore has
 * to widen while every read stays exactly as it was.
 *
 * WHY A THIRD VALUE RATHER THAN A FLAG OR A SHADOW TABLE. Every consumer of
 * `lifecycle_status` already filters POSITIVELY on `'active'` — the
 * Marketplace, the Builder Portal, the primary-image enforcement, the source
 * repair, the fallback queue, the per-item claim, the pending count, the cron
 * gate. So a third value is invisible everywhere by construction: nothing has
 * to learn to hide it, because the serving query already hides anything that is
 * not `'active'`. A boolean `published` column beside `active` would have meant
 * auditing all of them and hoping.
 *
 * Pure: no IO, no clock, no imports.
 */

export type StockLifecycle = 'active' | 'staged' | 'archived';

/** Published. What the Marketplace and the portals serve — and only this. */
export const SERVED_LIFECYCLE = 'active' as const;

/**
 * What the image engine works on.
 *
 * Order matters only for readability. Both values are equally claimable, and a
 * staged property is not lower priority than a published one: a replacement
 * upload that cannot finish is a Marketplace that cannot update.
 */
export const PROCESSED_LIFECYCLE: readonly StockLifecycle[] = ['active', 'staged'];

/** Is this row on the Marketplace right now? */
export function isServed(lifecycle: unknown): boolean {
  return lifecycle === SERVED_LIFECYCLE;
}

/** Does the image engine owe this row any work? */
export function isProcessed(lifecycle: unknown): boolean {
  return lifecycle === 'active' || lifecycle === 'staged';
}

/**
 * Where a newly IMPORTED property starts: STAGED, always.
 *
 * This used to publish an organisation's FIRST list immediately — "an empty
 * page is worse than a slow one" — which meant the very upload with the least
 * proven imagery was the only one that skipped the readiness gate, and the
 * client-visibility predicate (defence-in-depth, never the mechanism) was all
 * that stood between a first import and a blank Marketplace card. One
 * publication model for every upload: rows import staged, the settler asks
 * `publish_builder_stock_upload` as their photographs settle, and the whole
 * list goes live in one cutover the moment every property carries its
 * builder-source photograph. The builder is not looking at an empty page in
 * the meantime — the portal's progress banner reads the same per-upload
 * arithmetic the gate does ("Processing property photos — X of Y ready").
 *
 * This decides the INSERT only. A row the import MATCHED is updated in place
 * and keeps whatever lifecycle it already had, which is what lets #2347's
 * unchanged properties go on serving their correct imagery throughout.
 */
export function lifecycleForNewProperty(): StockLifecycle {
  return 'staged';
}

/**
 * Where a MATCHED property ends up.
 *
 * The importer has always written `lifecycle_status: 'active'` on every match,
 * which existed to REVIVE a row a new list re-supplies after it was archived.
 * Left alone that would also promote a `staged` row to published on the next
 * re-import — publishing a replacement property whose imagery nobody has looked
 * for yet, which is the exact failure staging exists to prevent, reached
 * through the one path that looked harmless.
 *
 *   `active`    stays published. #2347's unchanged property goes on serving
 *               its correct imagery throughout the replacement.
 *   `staged`    stays invisible. It publishes when its upload is ready and
 *               never because it was mentioned again.
 *   `archived`  is revived — to `staged`, exactly as a brand-new property
 *               would be, and publishes with its upload's cutover.
 */
export function lifecycleForMatchedProperty(
  current: unknown,
  newProperty: StockLifecycle,
): StockLifecycle {
  if (current === 'active') return 'active';
  if (current === 'staged') return 'staged';
  return newProperty;
}

/**
 * WHICH UPLOAD'S SOURCE THE IMAGE WORK INSPECTS.
 *
 * NOT THE SAME QUESTION AS WHICH UPLOAD IS SERVED, and conflating them is the
 * defect this names. `itemWorkClaim.ts` has always stated the contract: a
 * MATCHED row's `upload_id` is still the OLD one, because re-pointing it is
 * step 1 of the atomic cutover itself, so until publication the id of the
 * upload actually waiting on this property lives in `pending_upload_id` and
 * nowhere else — "asking to publish `upload_id` on such a row asks about the
 * dataset already on screen".
 *
 * The source stage asked `item.upload_id` anyway while the telemetry beside it
 * read `pending_upload_id ?? upload_id`, so the two disagreed about which
 * document was being settled. On a FIRST import they cannot: `pending_upload_id`
 * is null and both resolve to the same upload, which is why the 18 September
 * incident never exposed it — all 47 rows carried a null. On a REPLACEMENT they
 * do, and the consequence is not cosmetic: the stage re-reads the OLD builder
 * source, derives the OLD row's branches, and settles the replacement's imagery
 * against a document the builder has already superseded.
 *
 * So the rule is spelled ONCE, here, beside the lifecycle it belongs to, and
 * every caller that settles SOURCE work asks for it. It deliberately says
 * nothing about what the marketplace serves: `upload_id` remains the serving
 * supplier until `publish_builder_stock_upload` flips the rows in one
 * statement, and nothing in this function is read by that path.
 *
 * `null` only where the property has no upload at all — a row with no source
 * document, which the source stage moves past rather than retrying for ever.
 */
export function sourceWorkUploadId(item: {
  upload_id?: string | null;
  pending_upload_id?: string | null;
}): string | null {
  return item?.pending_upload_id ?? item?.upload_id ?? null;
}
