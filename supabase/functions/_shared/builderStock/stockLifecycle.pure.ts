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
 * Where a newly IMPORTED property starts.
 *
 * STAGED ONLY WHERE THERE IS SOMETHING TO PROTECT. An organisation with no
 * published stock has no working Marketplace to blank, and staging its first
 * upload would leave it looking at an empty page until the imagery finished —
 * turning a fix for the replacement case into a regression for the first-run
 * case. So the very first list publishes as it always did, and every list after
 * it stages.
 *
 * This decides the INSERT only. A row the import MATCHED is updated in place
 * and keeps whatever lifecycle it already had, which is what lets #2347's
 * unchanged properties go on serving their correct imagery throughout.
 */
export function lifecycleForNewProperty(
  input: { organisationHasPublishedStock: boolean },
): StockLifecycle {
  return input.organisationHasPublishedStock ? 'staged' : 'active';
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
 *   `archived`  is revived — to `staged` where there is a Marketplace to
 *               protect, and to `active` where there is not, exactly as a
 *               brand-new property would be.
 */
export function lifecycleForMatchedProperty(
  current: unknown,
  newProperty: StockLifecycle,
): StockLifecycle {
  if (current === 'active') return 'active';
  if (current === 'staged') return 'staged';
  return newProperty;
}
