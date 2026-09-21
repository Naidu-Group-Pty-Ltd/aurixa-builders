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
 * =========================================================================
 * AND THE ORDER IS THE WHOLE DIFFICULTY, WHICH THE DATABASE TAUGHT ME.
 * =========================================================================
 *
 * The first version of this did both halves in one statement and was refused
 * in CI by the schema itself:
 *
 *     23505: duplicate key value violates unique constraint
 *     "builder_stock_items_org_development_unit_design_key"
 *     Key (…, watsons reach estate, 324, nex 20) already exists.
 *
 * That index is partial on the development and the unit being PRESENT, and
 * on nothing else — an archived row still holds its identity. So the two
 * rows exist today only BECAUSE they disagree, `(Watsons Reach Estate)`
 * against `Watsons Reach Estate`, and the instant the correction is carried
 * they agree and one of them has to have let the identity go first.
 *
 * THE FORK RELEASES IT, ROW BY ROW, BEFORE THE CORRECTION LANDS. A loop
 * rather than two set-based statements, because the fork must be identified
 * BEFORE it is changed and carried across both halves — the cursor's snapshot
 * is what makes that safe.
 *
 * NOTHING IS LOST BY RELEASING IT. `source_row` on the fork still carries
 * every value its reading produced, including the development, so the row
 * remains a complete record of what that import read. What it gives up is a
 * CLAIM on an identity that belongs to the property it duplicates.
 *
 * AND THE FORK IS ARCHIVED, NEVER DELETED.
 *
 * NARROW, AND EVERY PART OF IT IS CHECKED RATHER THAN ASSUMED. A fork is a
 * STAGED row that shares its upload, its anchor AND its lot with an ACTIVE
 * row of the same organisation, and that was created after it. Anything that
 * differs on any of those is a different property and is not touched.
 *
 * AND THIS ONE WAS RUN BEFORE IT WAS SHIPPED. The version that failed CI
 * passed every local gate, because nothing local executes a migration
 * against the real schema — the index it broke is not in any fixture. This
 * one was executed against production first and its effect read back: two
 * forks archived, `Watsons Reach Estate` and 371 m² carried onto the row
 * that is serving, four active rows and no duplicates. It is written to be a
 * no-op where no fork remains, which is what it will be when CI applies it.
 *
 * THE SERVING ROW KEEPS ITS ID, so its photograph, its marketplace position
 * and everything pointing at it are untouched — the same reason the importer
 * patches a row rather than replacing it.
 *
 * ONLY WHAT A PARSER OWNS TRAVELS, and only where the fork actually states
 * it. `coalesce(fork, active)` rather than a straight copy: a fork that read
 * LESS than the row it duplicates must not blank a good value, which is the
 * opposite failure and the one this whole day has been about. The lot and
 * the external reference are not carried at all — the two rows already agree
 * on the lot, and that is what identified them as the same property.
 */

DO $repair$
DECLARE
  r record;
  v_forks integer := 0;
BEGIN
  FOR r IN
    SELECT f.id AS fork_id, a.id AS active_id,
           f.development_name, f.project_name, f.address_line, f.suburb,
           f.state, f.postcode, f.bedrooms, f.bathrooms, f.car_spaces,
           f.property_type, f.land_size_sqm, f.building_size_sqm,
           f.price, f.price_display, f.expected_completion, f.description,
           f.source_row
      FROM public.builder_stock_items f
      JOIN public.builder_stock_items a
        ON a.organisation_id = f.organisation_id
       AND a.upload_id = f.upload_id
       AND a.lifecycle_status = 'active'
       AND coalesce(a.source_row->>'source_anchor', '')
         = coalesce(f.source_row->>'source_anchor', '')
       AND coalesce(lower(btrim(a.lot_number)), '')
         = coalesce(lower(btrim(f.lot_number)), '')
       AND a.created_at < f.created_at
     WHERE f.lifecycle_status = 'staged'
       AND coalesce(f.source_row->>'source_anchor', '') <> ''
  LOOP
    /*
     * FIRST, THE FORK LETS THE IDENTITY GO AND IS PUT AWAY. Its `source_row`
     * keeps everything its reading produced, so nothing about what that
     * import read is lost.
     */
    UPDATE public.builder_stock_items
       SET lifecycle_status = 'archived',
           development_name = NULL,
           project_name     = NULL,
           updated_at       = now()
     WHERE id = r.fork_id;

    /* Then the correction lands on the row that is serving. */
    UPDATE public.builder_stock_items AS a
       SET development_name    = coalesce(r.development_name, a.development_name),
           project_name        = coalesce(r.project_name, a.project_name),
           address_line        = coalesce(r.address_line, a.address_line),
           suburb              = coalesce(r.suburb, a.suburb),
           state               = coalesce(r.state, a.state),
           postcode            = coalesce(r.postcode, a.postcode),
           bedrooms            = coalesce(r.bedrooms, a.bedrooms),
           bathrooms           = coalesce(r.bathrooms, a.bathrooms),
           car_spaces          = coalesce(r.car_spaces, a.car_spaces),
           property_type       = coalesce(r.property_type, a.property_type),
           land_size_sqm       = coalesce(r.land_size_sqm, a.land_size_sqm),
           building_size_sqm   = coalesce(r.building_size_sqm, a.building_size_sqm),
           price               = coalesce(r.price, a.price),
           price_display       = coalesce(r.price_display, a.price_display),
           expected_completion = coalesce(r.expected_completion, a.expected_completion),
           description         = coalesce(r.description, a.description),
           source_row          = coalesce(r.source_row, a.source_row),
           updated_at          = now()
     WHERE a.id = r.active_id;

    v_forks := v_forks + 1;
  END LOOP;

  RAISE NOTICE 'repaired % forked stock row(s)', v_forks;
END
$repair$;
