/*
 * A RE-READ OF A PUBLISHED STOCK LIST COULD NEVER CHANGE A SINGLE VALUE.
 *
 * MEASURED IN PRODUCTION, 21 SEPTEMBER 2026, and proved by calling the
 * function rather than by reading it. `LOT 266 Crowlea Estate` was re-read at
 * 10:49 and the reading was RIGHT — the import log records
 * `development_name:leading_field_name`, `land_size_sqm:below`,
 * `house_design:filename` — and the row's columns stayed empty. The corrected
 * values sat in `pending_patch`:
 *
 *     {"development_name": "Warragul", "land_size_sqm": 520,
 *      "expected_completion": "Q2 2027", ...}
 *
 * and `publish_builder_stock_upload` answered `already_published` and applied
 * nothing. It would have answered that for ever.
 *
 * WHY THE PATCH IS HELD BACK IS STILL RIGHT. A published property's new
 * values must not appear while a replacement is half-processed — A's new
 * price beside B's old membership. The hold-back is not the defect. The
 * defect is that the only thing which APPLIES a held-back patch sits below an
 * early return that a second publication of the same upload always takes.
 *
 * THAT BRANCH HAD ALREADY LEARNED THIS LESSON ONCE, in its own words:
 * "ALREADY PUBLISHED IS NOT ALWAYS NOTHING LEFT TO DO". It learned it for a
 * staged row waiting on its photograph and missed the patch beside it.
 *
 * A HELD-BACK PATCH IS THIS UPLOAD'S OWN CORRECTED VALUES AND NOTHING ELSE
 * WILL EVER APPLY THEM, so it is applied before that return, keyed on
 * `pending_upload_id = p_upload_id` — never another upload's, and never a
 * membership change: the promote and archive steps are untouched and stay
 * exactly where they were.
 *
 * AND IT IS WRITTEN ONCE. `apply_builder_stock_pending_patch` is the block
 * that used to live inline, lifted verbatim, so the two call sites cannot
 * drift into applying a patch two different ways — which is the whole reason
 * the previous migration had to make both ends agree about a null.
 */

CREATE OR REPLACE FUNCTION public.apply_builder_stock_pending_patch(p_upload_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_patched integer := 0;
BEGIN
  /*
   * EVERY COLUMN IS NAMED. A `jsonb_populate_record` over the whole row would
   * let whatever ended up in that column write any field of the table, which
   * is mass assignment through a jsonb door.
   *
   * AND EVERY COLUMN ANSWERS TO KEY PRESENCE. `?` is strictly true or false
   * and is the only thing that tells a patch which STATES NOTHING for a
   * column apart from a patch which does not mention it. WHICH columns may be
   * unsaid is `UNSAYABLE_ON_REREAD` in `importStock.ts` and is named once.
   */
  UPDATE public.builder_stock_items AS i
     SET external_reference = CASE WHEN i.pending_patch ? 'external_reference'
                                   THEN i.pending_patch->>'external_reference' ELSE i.external_reference END,
         development_name   = CASE WHEN i.pending_patch ? 'development_name'
                                   THEN i.pending_patch->>'development_name' ELSE i.development_name END,
         project_name       = CASE WHEN i.pending_patch ? 'project_name'
                                   THEN i.pending_patch->>'project_name' ELSE i.project_name END,
         address_line       = CASE WHEN i.pending_patch ? 'address_line'
                                   THEN i.pending_patch->>'address_line' ELSE i.address_line END,
         suburb             = CASE WHEN i.pending_patch ? 'suburb'
                                   THEN i.pending_patch->>'suburb' ELSE i.suburb END,
         state              = CASE WHEN i.pending_patch ? 'state'
                                   THEN i.pending_patch->>'state' ELSE i.state END,
         postcode           = CASE WHEN i.pending_patch ? 'postcode'
                                   THEN i.pending_patch->>'postcode' ELSE i.postcode END,
         lot_number         = CASE WHEN i.pending_patch ? 'lot_number'
                                   THEN i.pending_patch->>'lot_number' ELSE i.lot_number END,
         unit_number        = CASE WHEN i.pending_patch ? 'unit_number'
                                   THEN i.pending_patch->>'unit_number' ELSE i.unit_number END,
         bedrooms           = CASE WHEN i.pending_patch ? 'bedrooms'
                                   THEN (i.pending_patch->>'bedrooms')::numeric ELSE i.bedrooms END,
         bathrooms          = CASE WHEN i.pending_patch ? 'bathrooms'
                                   THEN (i.pending_patch->>'bathrooms')::numeric ELSE i.bathrooms END,
         car_spaces         = CASE WHEN i.pending_patch ? 'car_spaces'
                                   THEN (i.pending_patch->>'car_spaces')::numeric ELSE i.car_spaces END,
         property_type      = CASE WHEN i.pending_patch ? 'property_type'
                                   THEN i.pending_patch->>'property_type' ELSE i.property_type END,
         land_size_sqm      = CASE WHEN i.pending_patch ? 'land_size_sqm'
                                   THEN (i.pending_patch->>'land_size_sqm')::numeric ELSE i.land_size_sqm END,
         building_size_sqm  = CASE WHEN i.pending_patch ? 'building_size_sqm'
                                   THEN (i.pending_patch->>'building_size_sqm')::numeric ELSE i.building_size_sqm END,
         price              = CASE WHEN i.pending_patch ? 'price'
                                   THEN (i.pending_patch->>'price')::numeric ELSE i.price END,
         price_display      = CASE WHEN i.pending_patch ? 'price_display'
                                   THEN i.pending_patch->>'price_display' ELSE i.price_display END,
         expected_completion= CASE WHEN i.pending_patch ? 'expected_completion'
                                   THEN i.pending_patch->>'expected_completion' ELSE i.expected_completion END,
         description        = CASE WHEN i.pending_patch ? 'description'
                                   THEN i.pending_patch->>'description' ELSE i.description END,
         availability_status= CASE WHEN i.pending_patch ? 'availability_status'
                                   THEN i.pending_patch->>'availability_status' ELSE i.availability_status END,
         builder_project_id = CASE WHEN i.pending_patch ? 'builder_project_id'
                                   THEN (i.pending_patch->>'builder_project_id')::uuid ELSE i.builder_project_id END,
         builder_unit_id    = CASE WHEN i.pending_patch ? 'builder_unit_id'
                                   THEN (i.pending_patch->>'builder_unit_id')::uuid ELSE i.builder_unit_id END,
         source_row         = coalesce(i.pending_patch->'source_row', i.source_row),
         upload_id          = p_upload_id,
         last_seen_at       = now(),
         pending_patch      = NULL,
         pending_upload_id  = NULL,
         updated_at         = now()
   WHERE i.pending_upload_id = p_upload_id;
  GET DIAGNOSTICS v_patched = ROW_COUNT;
  RETURN v_patched;
END;
$function$;

-- Callable only from the publication function that owns it.
REVOKE ALL ON FUNCTION public.apply_builder_stock_pending_patch(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload(p_upload_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ready boolean;
  v_partial boolean;
  v_first boolean;
  v_staged bigint;
  v_outstanding bigint;
  v_missing bigint;
  v_failed bigint;
  v_ready_items bigint;
  v_replaces uuid[];
  v_published integer := 0;
  v_archived integer := 0;
  v_patched integer := 0;
  v_withheld integer := 0;
  v_deleted timestamptz;
  v_already timestamptz;
  v_reason text;
  v_mode text;
BEGIN
  SELECT deleted_at, published_at INTO v_deleted, v_already
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  -- A deleted upload is not a stock list, and a superseded one is somebody's
  -- abandoned draft. Neither may move the Marketplace. Asked BEFORE the
  -- already-published branch, because a late promotion must answer to them too.
  IF v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'deleted');
  END IF;

  IF public.builder_stock_upload_superseded(p_upload_id) THEN
    RETURN jsonb_build_object('published', false, 'reason', 'superseded');
  END IF;

  SELECT staged, source_outstanding, missing_primary, failed_items,
         ready, ready_items, first_publication, partial_ready
    INTO v_staged, v_outstanding, v_missing, v_failed,
         v_ready, v_ready_items, v_first, v_partial
    FROM public.builder_stock_publication_readiness(p_upload_id);

  /*
   * ALREADY PUBLISHED IS NOT ALWAYS NOTHING LEFT TO DO.
   *
   * A first publication leaves the un-ready properties staged, so the case
   * this branch used to swallow is the one that matters most: the builder
   * goes and fixes the row the list told them about, it settles with their
   * own photograph, `publishUploadIfReady` is called on the next completed
   * item — and the answer was `already_published`, for ever. The property
   * they had just repaired would never reach the marketplace and nothing
   * anywhere would say why.
   *
   * Only for a FIRST publication. A published replacement has no staged rows
   * left (its cutover promoted all of them) and must never grow a second one.
   */
  IF v_already IS NOT NULL THEN
    /*
     * THE HELD-BACK PATCH IS APPLIED FIRST, AND BEFORE ANY RETURN.
     *
     * A second publication of the SAME upload is what a re-read produces, and
     * this branch used to return above the only step that applies a patch —
     * so a corrected reading was written to `pending_patch` and stranded
     * there permanently. Keyed on this upload's own held-back rows, so it can
     * move nothing that belongs to another list, and it changes no
     * membership: the promote below is untouched.
     */
    v_patched := public.apply_builder_stock_pending_patch(p_upload_id);

    IF NOT coalesce(v_first, false) THEN
      RETURN jsonb_build_object(
        'published', false, 'reason', 'already_published', 'patched', v_patched);
    END IF;

    UPDATE public.builder_stock_items
       SET lifecycle_status = 'active', updated_at = now()
     WHERE upload_id = p_upload_id
       AND lifecycle_status = 'staged'
       AND image_work_stage = 'settled'
       AND public.builder_stock_photo_is_source_ready(primary_image_id);
    GET DIAGNOSTICS v_published = ROW_COUNT;

    IF v_published = 0 THEN
      RETURN jsonb_build_object(
        'published', false, 'reason', 'already_published', 'patched', v_patched);
    END IF;

    SELECT count(*) INTO v_withheld
      FROM public.builder_stock_items
     WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';

    v_reason := CASE WHEN v_withheld > 0 THEN format(
      '%s of %s properties are live; %s still needs a photograph from you',
      coalesce(v_staged, 0) - v_withheld, coalesce(v_staged, 0), v_withheld) END;
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason,
           image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END,
           updated_at = now()
     WHERE id = p_upload_id;

    BEGIN
      PERFORM public.record_portal_operational_event(
        'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
        'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
        jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                           'withheld', v_withheld, 'mode', 'late'));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- telemetry must never fail a cutover
    END;

    RETURN jsonb_build_object(
      'published', true, 'mode', 'late', 'promoted', v_published,
      'patched', v_patched, 'archived', 0, 'withheld', v_withheld);
  END IF;

  IF coalesce(v_ready, false) THEN
    v_mode := 'atomic';
  ELSIF coalesce(v_partial, false) THEN
    v_mode := 'first_publication';
  ELSE
    /*
     * REFUSED, AND THE REASON SAYS WHICH KIND OF REFUSAL IT IS. A first list
     * with nothing ready yet is a different sentence from a replacement
     * holding back for one bad row, and an operator reading the upload row
     * should not have to infer which.
     */
    v_reason := CASE
      WHEN coalesce(v_first, false) AND coalesce(v_ready_items, 0) = 0 THEN format(
        'awaiting source photographs: no property of %s has a ready builder-source photo yet, %s failed, %s still reading their source',
        coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0))
      ELSE format(
        'awaiting source photographs: %s of %s properties without a ready builder-source photo, %s failed, %s still reading their source',
        coalesce(v_missing, 0), coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0))
    END;
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason, updated_at = now()
     WHERE id = p_upload_id
       AND publication_blocked_reason IS DISTINCT FROM v_reason;
    RETURN jsonb_build_object(
      'published', false, 'reason', 'not_ready',
      'staged', coalesce(v_staged, 0), 'source_outstanding', coalesce(v_outstanding, 0),
      'missing_primary', coalesce(v_missing, 0), 'failed_items', coalesce(v_failed, 0),
      'ready_items', coalesce(v_ready_items, 0),
      'first_publication', coalesce(v_first, false));
  END IF;

  SELECT coalesce(replaces_upload_ids, '{}') INTO v_replaces
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  /*
   * 1. APPLY EVERY HELD-BACK PATCH — FIRST, and the order is load-bearing.
   *
   * This is what re-points a matched row's `upload_id` to this upload, and step
   * 3 archives by `upload_id`. Do it after, and every kept property would look
   * like a removed one.
   *
   * EVERY COLUMN IS NAMED. A `jsonb_populate_record` over the whole row would
   * let whatever ended up in that column write any field of the table, which is
   * mass assignment through a jsonb door.
   *
   * AND EVERY COLUMN ANSWERS TO KEY PRESENCE. `?` is strictly true or false
   * and is the only thing that tells a patch which STATES NOTHING for a
   * column apart from a patch which does not mention it — see this
   * migration's header.
   */
  v_patched := public.apply_builder_stock_pending_patch(p_upload_id);

  /*
   * 2. Promote this upload's staged rows THAT EARNED THEIR PHOTOGRAPH.
   *
   * Under `atomic` this filter is satisfied by every staged row — that is
   * what `ready` means — so a replacement's cutover is byte-for-byte the
   * behaviour it has always had. Under `first_publication` it is the whole
   * point: 46 go live and the one whose documents name somebody else's
   * property stays staged, in Action Required, where the builder can see it.
   */
  UPDATE public.builder_stock_items
     SET lifecycle_status = 'active', updated_at = now()
   WHERE upload_id = p_upload_id
     AND lifecycle_status = 'staged'
     AND image_work_stage = 'settled'
     AND public.builder_stock_photo_is_source_ready(primary_image_id);
  GET DIAGNOSTICS v_published = ROW_COUNT;

  SELECT count(*) INTO v_withheld
    FROM public.builder_stock_items
   WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';

  -- 3. Archive what the superseded uploads still supply. Anything still
  --    carrying one of their ids is a property the new list did not contain.
  IF array_length(v_replaces, 1) IS NOT NULL THEN
    UPDATE public.builder_stock_items
       SET lifecycle_status = 'archived', updated_at = now()
     WHERE lifecycle_status = 'active'
       AND upload_id = ANY(v_replaces)
       AND upload_id <> p_upload_id;
    GET DIAGNOSTICS v_archived = ROW_COUNT;
  END IF;

  /*
   * THE BLOCKED REASON STAYS HONEST, AND `image_failure_state` STAYS SET.
   *
   * A first publication that withheld rows is published AND still owes the
   * builder something. Clearing both — as the atomic path rightly does when
   * it publishes everything — would take away the only thing on the Stock
   * List telling them a property of theirs is not on the marketplace.
   */
  UPDATE public.builder_stock_uploads
     SET published_at = now(),
         publication_blocked_reason = CASE WHEN v_withheld > 0 THEN format(
           '%s of %s properties are live; %s still needs a photograph from you',
           v_published, coalesce(v_staged, 0), v_withheld) END,
         image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END,
         updated_at = now()
   WHERE id = p_upload_id AND published_at IS NULL;

  BEGIN
    PERFORM public.record_portal_operational_event(
      'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
      'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
      jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                         'patched', v_patched, 'archived', v_archived,
                         'withheld', v_withheld, 'mode', v_mode));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- telemetry must never fail a cutover
  END;

  RETURN jsonb_build_object(
    'published', true, 'mode', v_mode, 'promoted', v_published,
    'patched', v_patched, 'archived', v_archived, 'withheld', v_withheld);
END;
$function$;

/*
 * AND THE PATCHES ALREADY STRANDED ARE APPLIED ONCE, HERE.
 *
 * Every one of them is a corrected reading this pipeline produced and then
 * could not deliver, for rows whose upload is already published — exactly
 * the state the fix above prevents from recurring. It writes only what the
 * reader wrote, through the one function that applies a patch, and it
 * touches no membership: nothing is promoted, archived or deleted.
 */
DO $repair$
DECLARE
  v_upload uuid;
  v_rows integer;
  v_total integer := 0;
BEGIN
  FOR v_upload IN
    SELECT DISTINCT i.pending_upload_id
      FROM public.builder_stock_items i
      JOIN public.builder_stock_uploads u ON u.id = i.pending_upload_id
     WHERE i.pending_patch IS NOT NULL
       AND u.published_at IS NOT NULL
       AND u.deleted_at IS NULL
  LOOP
    v_rows := public.apply_builder_stock_pending_patch(v_upload);
    v_total := v_total + v_rows;
  END LOOP;
  RAISE NOTICE 'applied % stranded stock patch row(s)', v_total;
END
$repair$;
