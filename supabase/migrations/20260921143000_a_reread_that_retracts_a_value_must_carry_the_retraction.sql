/*
 * THE FORK THE LOT 48 RE-READ LEFT, AND WHY THE FIRST REPAIR CANNOT TOUCH IT.
 *
 * `20260921113000` repairs a fork against the ACTIVE row it duplicates, and
 * it carries the fork's values with `coalesce(fork, active)` so a thinner
 * reading can never blank a good value. Both choices were right for the forks
 * it was written for and both are wrong here.
 *
 * MEASURED 21 SEPTEMBER 2026. The reader sweep re-read
 * `LOT 48 - EMBER - FLYER.pdf` at 12:47:05 and produced the correct reading —
 * no unit number, the design `Ember` from the filename, `35 Cockrell Rd /
 * Mernda VIC 3754` — and INSERTED it as a second row beside the 12:02 row
 * still carrying `unit_number = '115.30m 12.41sq'`, a floor plan's area
 * schedule read as a designation. `importStock.ts` stops that recurring
 * (see `reReadHoldsSameProperty`); this puts the two rows already in the
 * database back together.
 *
 * TWO THINGS DIFFER FROM THE FIRST REPAIR.
 *
 * NEITHER ROW IS ACTIVE. This upload has never published — the flyer's
 * photograph was never elected, so publication is blocked on it — so both
 * rows are `staged` and the first repair's join finds nothing. The survivor
 * is therefore the OLDER row, for the reason the first repair kept the active
 * one: it is the row that has existed, that anything pointing at this
 * property points at, and whose id must not change.
 *
 * AND THE CORRECTION IS A RETRACTION. `coalesce(fork, active)` can only ever
 * FILL. What this fork states about `unit_number` is that there is not one,
 * and a repair that cannot carry that leaves the card titled
 * "Unit 115.30m 12.41sq" — the correction losing to the document it corrects,
 * which is the defect this whole day has been about.
 *
 * So the newer reading is taken AS STATED, nulls included, for the columns a
 * parser owns — and for those columns only. That vocabulary is not invented
 * here: it is `UNSAYABLE_ON_REREAD` in `importStock.ts`, the same list that
 * lets a builder's own "Read again" retract a value, and the rule it encodes
 * is that the SAME source re-read by a better reader is authoritative about
 * what it says and what it does not. Everything outside that list — the id,
 * the lot, the external reference, the lifecycle, the upload, the imagery,
 * every pointer — is untouched.
 *
 * NARROW, AND EVERY PART CHECKED RATHER THAN ASSUMED. A fork is a row that
 * shares its ORGANISATION, its UPLOAD, its ANCHOR and its LOT with an older
 * row and was created after it. Anything differing on any of those is a
 * different property and is not touched. The fork is ARCHIVED, never deleted,
 * and it releases its identity first for the reason `20260921113000` records:
 * the unique index is partial on presence, so an archived row still holds a
 * claim.
 *
 * It is written to be a no-op where no fork remains, which is what it will be
 * on every deployment but this one.
 */

DO $repair$
DECLARE
  r record;
  v_forks integer := 0;
BEGIN
  FOR r IN
    SELECT f.id AS fork_id, k.id AS keep_id,
           f.development_name, f.project_name, f.address_line, f.suburb,
           f.state, f.postcode, f.bedrooms, f.bathrooms, f.car_spaces,
           f.property_type, f.land_size_sqm, f.building_size_sqm,
           f.price, f.price_display, f.expected_completion, f.description,
           f.unit_number, f.source_row
      FROM public.builder_stock_items f
      JOIN public.builder_stock_items k
        ON k.organisation_id = f.organisation_id
       AND k.upload_id = f.upload_id
       AND coalesce(k.source_row->>'source_anchor', '')
         = coalesce(f.source_row->>'source_anchor', '')
       AND coalesce(lower(btrim(k.lot_number)), '')
         = coalesce(lower(btrim(f.lot_number)), '')
       AND k.created_at < f.created_at
       AND k.lifecycle_status <> 'archived'
     WHERE f.lifecycle_status = 'staged'
       AND coalesce(f.source_row->>'source_anchor', '') <> ''
       AND coalesce(lower(btrim(f.lot_number)), '') <> ''
  LOOP
    /*
     * The fork lets its identity go and is put away. Its `source_row` keeps
     * every value its reading produced, so nothing about what that import
     * read is lost.
     */
    UPDATE public.builder_stock_items
       SET lifecycle_status = 'archived',
           development_name = NULL,
           project_name     = NULL,
           unit_number      = NULL,
           updated_at       = now()
     WHERE id = r.fork_id;

    /*
     * Then the newer reading lands on the row that stays — AS STATED. Every
     * column here is one `UNSAYABLE_ON_REREAD` names, so a null is the source
     * saying it carries no such value rather than an absence to be filled.
     */
    UPDATE public.builder_stock_items AS k
       SET unit_number         = r.unit_number,
           development_name    = r.development_name,
           project_name        = r.project_name,
           address_line        = r.address_line,
           suburb              = r.suburb,
           state               = r.state,
           postcode            = r.postcode,
           bedrooms            = r.bedrooms,
           bathrooms           = r.bathrooms,
           car_spaces          = r.car_spaces,
           property_type       = r.property_type,
           land_size_sqm       = r.land_size_sqm,
           building_size_sqm   = r.building_size_sqm,
           price               = r.price,
           price_display       = r.price_display,
           expected_completion = r.expected_completion,
           description         = r.description,
           source_row          = coalesce(r.source_row, k.source_row),
           /*
            * AND THE PROPERTY GOES BACK IN THE IMAGE QUEUE. Its label has
            * just changed, and the label is what the cover election
            * identifies pages by — so the question "which picture leads this
            * card" has to be asked again. `image_work_stage` is pipeline
            * state, never property data: no price, availability,
            * configuration, selection or linkage is written here.
            */
           image_work_stage           = 'source',
           image_work_claim_until     = NULL,
           image_work_next_attempt_at = now(),
           image_work_failures        = 0,
           image_work_updated_at      = now(),
           updated_at                 = now()
     WHERE k.id = r.keep_id;

    v_forks := v_forks + 1;
  END LOOP;

  RAISE NOTICE 'merged % re-read fork(s)', v_forks;
END
$repair$;
