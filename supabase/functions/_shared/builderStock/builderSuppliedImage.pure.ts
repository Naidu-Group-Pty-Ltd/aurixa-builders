/**
 * BUILDER STOCK — THE PICTURE A BUILDER HANDS OVER DIRECTLY.
 *
 * Every image this product serves is read out of something: a column that
 * names a URL, a brochure page that names a lot, a page cover, a design
 * brochure. That works until there is nothing to read — and on the one live
 * source, thirteen of twenty-six published properties attach no document at
 * all. The pipeline's own fallbacks then offered, for those rows, a Simonds
 * display home, an ABC Homes display home and the land developer's estate
 * marketing, and refused all of them, correctly. The cards stayed blank
 * because there was nothing to read, and no reader fixes that.
 *
 * The one party who certainly has the picture is the builder, and the product
 * had no way for them to hand it over. That is what this module is for.
 *
 * TWO ROUTES, ONE ACT. A builder supplies a picture either FOR A DESIGN — one
 * render, serving every row of theirs that states it — or FOR ONE PROPERTY.
 * The first is the leverage (three uploads cover those thirteen rows, and
 * every future row of those designs for ever); the second is the guarantee
 * (whatever else went wrong, somebody can fix one card).
 *
 * NEITHER INVENTS A LEVEL OR A STAGE. A builder-supplied image is stored as
 * `uploaded_document` / `source_supplied`, which is what it is: bytes the
 * builder gave us for this property. It therefore travels the existing ladder
 * unchanged — `isDisplayableSourceImage`, `rankImage`, `chooseCardImage`, the
 * marketplace eligibility gate — and a card drawing one truthfully says
 * "Builder supplied". In particular it goes through the promotional-overlay
 * rule like any other builder image: a render with "$25,000 REBATE" set over
 * it is refused here exactly as it is when it arrives inside a brochure, and
 * for the same reason.
 *
 * Pure: no IO, no clock, no network.
 */

/**
 * The comparison key for a design name.
 *
 * Case, spacing and punctuation are removed, so `DK 22B`, `dk 22b` and
 * `DK-22B` are one design — which is how a builder types the same house into
 * twenty rows.
 */
/**
 * The design a stored row states, from the one place it can be.
 *
 * `house_design` is the canonical field. A row imported before the `HOUSE`
 * column was mappable carries it in `unmapped` instead — and those rows are
 * exactly the ones this feature exists for, so reading both means a builder
 * does not have to re-read their source before they can supply a render.
 * Re-reading it is still better, and the page says so.
 *
 * Shared because three callers must agree: the surface that offers a builder
 * their designs, the fan-out that attaches a render, and the settler that
 * applies one to stock imported later.
 */
export function designOfStoredRow(sourceRow: unknown): string | null {
  const row = (sourceRow ?? {}) as Record<string, unknown>;
  const canonical = typeof row.house_design === 'string' ? row.house_design.trim() : '';
  if (canonical) return canonical;
  const unmapped = (row.unmapped ?? {}) as Record<string, unknown>;
  for (const key of ['HOUSE', 'House', 'house']) {
    const value = unmapped[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The design a caller states, WHICHEVER OF THE TWO SHAPES it is holding.
 *
 * THE READERS DIFFER IN WHICH THEY HAVE, and a reader that knows only one of
 * them answers null for the other — silently, because null is also the honest
 * answer for a row that states no design.
 *
 *   the normalised record    `house_design` at the top level. What
 *                            `storedSourceRows` hands the repair path, having
 *                            already unwrapped the column.
 *   a database row           the record nested under `source_row`, which is
 *                            the column the import writes it to.
 *
 * MEASURED, 6 SEPTEMBER 2026. The settler carried its own copy that read the
 * nested shape only, while the value it was passed was always the unwrapped
 * one — so the design never reached the election and the design-cover path
 * produced ZERO images across the whole live database: 438 primary images at
 * evidence levels 1, 2 and 3, none at level 4. `storedRowDevelopmentUnitKey`
 * had already been bitten by exactly this and says so in its own header.
 */
export function designOfRecordOrRow(value: unknown): string | null {
  return designOfStoredRow(value)
    ?? designOfStoredRow((value as { source_row?: unknown } | null)?.source_row);
}

/** Where a builder-supplied object lives, so one rule names every path. */
export function propertyImageStoragePath(input: {
  organisationId: string;
  stockItemId: string;
  filename: string;
}): string {
  return `builder-supplied/${input.organisationId}/${input.stockItemId}/${input.filename}`;
}

/**
 * Is this a path this product wrote for a builder-supplied image?
 *
 * Checked before anything is read back out of storage, for the reason
 * `isAcceptableStockStoragePath` exists: a path that arrives in a request body
 * is a lookup key and never authority, and a caller must not be able to name
 * an object outside the prefix above.
 *
 * `builder-designs/…` was a second accepted prefix while one render could be
 * supplied for a house DESIGN and fanned out across the lots stating it. That
 * capability is withdrawn, so nothing writes that prefix any more and a
 * request body naming it is refused rather than quietly honoured.
 */
export function isBuilderSuppliedPath(path: string | null | undefined): boolean {
  const value = String(path ?? '');
  if (!value || value.includes('..') || value.startsWith('/')) return false;
  return /^builder-supplied\/[0-9a-f-]{36}\/[^/]+\/[^/]+$/i.test(value);
}
