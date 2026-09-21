/*
 * THE ROWS A COLLIDING ANCHOR ALREADY FORKED.
 *
 * `pdf:page1` is every single-property brochure's anchor, so an
 * organisation-wide anchor index collapses every one of them onto one entry.
 * A re-read then matched somebody else's property, the identity guard
 * correctly refused to carry anything forward, and the import INSERTED a
 * second row instead of correcting the one the builder is looking at.
 *
 * MEASURED 21 SEPTEMBER 2026. Read again on `LOT 324 - NEX 20` reported
 * `imported: 1, updated: 0` and produced a second row carrying the corrected
 * `Watsons Reach Estate` and a land size of 371 — staged, where nobody can
 * see it — beside the original still serving `(Watsons Reach Estate)` and no
 * land size at all. From the outside that is a button that does nothing.
 *
 * `importStock.ts` stops it recurring. This carries the corrections those
 * forks are holding onto the rows that are serving, and then puts the forks
 * away.
 *
 * NARROW, AND EVERY PART OF IT IS CHECKED RATHER THAN ASSUMED. A fork is a
 * STAGED row that shares its upload, its anchor AND its lot with an ACTIVE
 * row of the same organisation, and that was created after it. Anything that
 * differs on any of those is a different property and is not touched.
 *
 * THE SERVING ROW KEEPS ITS ID, so its photograph, its marketplace position
 * and everything pointing at it are untouched — the same reason the importer
 * patches a row rather than replacing it.
 *
 * ONLY WHAT A PARSER OWNS TRAVELS, and only where the fork actually states
 * it. `coalesce(fork, active)` rather than a straight copy: a fork that read
 * LESS than the row it duplicates must not blank a good value, which is the
 * opposite failure and the one this whole day has been about. Identity
 * columns are not copied at all — the two rows already agree on the lot, and
 * the development is carried because that is the correction being delivered.
 *
 * AND THE FORK IS ARCHIVED, NEVER DELETED. It is a real row with a real
 * history; archiving hides it and keeps every byte.
 */

WITH fork AS (
  SELECT f.id AS fork_id, a.id AS active_id
    FROM public.builder_stock_items f
    JOIN public.builder_stock_items a
      ON a.organisation_id = f.organisation_id
     AND a.upload_id = f.upload_id
     AND a.lifecycle_status = 'active'
     AND coalesce(a.source_row->>'source_anchor', '') = coalesce(f.source_row->>'source_anchor', '')
     AND coalesce(lower(trim(a.lot_number)), '') = coalesce(lower(trim(f.lot_number)), '')
     AND a.created_at < f.created_at
   WHERE f.lifecycle_status = 'staged'
     AND coalesce(f.source_row->>'source_anchor', '') <> ''
), carried AS (
  UPDATE public.builder_stock_items AS a
     SET development_name    = coalesce(f.development_name, a.development_name),
         project_name        = coalesce(f.project_name, a.project_name),
         address_line        = coalesce(f.address_line, a.address_line),
         suburb              = coalesce(f.suburb, a.suburb),
         state               = coalesce(f.state, a.state),
         postcode            = coalesce(f.postcode, a.postcode),
         bedrooms            = coalesce(f.bedrooms, a.bedrooms),
         bathrooms           = coalesce(f.bathrooms, a.bathrooms),
         car_spaces          = coalesce(f.car_spaces, a.car_spaces),
         property_type       = coalesce(f.property_type, a.property_type),
         land_size_sqm       = coalesce(f.land_size_sqm, a.land_size_sqm),
         building_size_sqm   = coalesce(f.building_size_sqm, a.building_size_sqm),
         price               = coalesce(f.price, a.price),
         price_display       = coalesce(f.price_display, a.price_display),
         expected_completion = coalesce(f.expected_completion, a.expected_completion),
         description         = coalesce(f.description, a.description),
         source_row          = coalesce(f.source_row, a.source_row),
         updated_at          = now()
    FROM fork
    JOIN public.builder_stock_items f ON f.id = fork.fork_id
   WHERE a.id = fork.active_id
  RETURNING a.id
)
UPDATE public.builder_stock_items
   SET lifecycle_status = 'archived', updated_at = now()
 WHERE id IN (SELECT fork_id FROM fork)
   -- `carried` is a data-modifying CTE, so Postgres runs it to completion
   -- whether or not the primary query reads it. Referenced here so the
   -- dependency is stated rather than relied upon silently.
   AND (SELECT count(*) FROM carried) IS NOT NULL;
