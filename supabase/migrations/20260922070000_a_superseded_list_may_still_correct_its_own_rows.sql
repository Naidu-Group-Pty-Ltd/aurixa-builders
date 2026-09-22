/*
 * A CORRECTED READING MUST REACH THE CUSTOMER THROUGH *EVERY* EARLY RETURN.
 *
 * `20260921110000_a_reread_of_a_published_list_must_be_able_to_correct_it`
 * found that `publish_builder_stock_upload` returned `already_published`
 * above the only step that applies a held-back patch, so a re-read of a
 * published list could never change a single value. It moved the patch above
 * that return. It left the return beside it.
 *
 * `superseded` is the other one, and it is the broader of the two.
 * `builder_stock_upload_superseded` is satisfied by ANY later non-deleted
 * upload in the same organisation — not by one that replaced these rows, by
 * any later one at all. So a builder who uploads a second, unrelated stock
 * list makes every earlier list permanently uncorrectable.
 *
 * MEASURED 22 SEPTEMBER 2026, by the acceptance gate's stranded-patch count
 * and then by calling the function directly: twelve rows holding a patch,
 * eleven documents, three organisations, and
 * `{"reason": "superseded", "published": false}` with nothing applied.
 *
 * THE RETURN STAYS AND ONLY THE PATCH MOVES ABOVE IT, for the reason the
 * previous migration gave: the guard protects the MARKETPLACE — an abandoned
 * draft may not promote its own staged rows or archive somebody else's — and
 * applying a patch keyed on `pending_upload_id = p_upload_id` does neither.
 *
 * Nothing else in the function changes. It is reproduced whole because that
 * is how this repository replaces a function, and the diff against
 * 20260921110000 is this one branch.
 */

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
    /*
     * AND THE HELD-BACK PATCH IS APPLIED HERE TOO, FOR THE SAME REASON AS
     * THE BRANCH BELOW.
     *
     * The previous migration moved the patch above `already_published` and
     * left it below this one, which is the other return a second publication
     * of the same upload can take — and the broader of the two, because
     * `builder_stock_upload_superseded` is satisfied by ANY later
     * non-deleted upload in the organisation, related or not. A builder who
     * uploads a second, unrelated stock list therefore makes every earlier
     * list permanently uncorrectable: a re-read writes the right values into
     * `pending_patch`, asks to publish, is told `superseded`, and nothing
     * anywhere will ever apply them.
     *
     * MEASURED 22 SEPTEMBER 2026 in the acceptance gate, which counts
     * stranded patches as one of its named zeroes: TWELVE rows carrying a
     * held-back patch whose upload answers `superseded`, across eleven
     * documents in three organisations. Calling the function by hand on one
     * of them returns `{"reason": "superseded", "published": false}` and
     * applies nothing, exactly as `already_published` did for Crowlea Estate.
     *
     * WHY IT IS SAFE, AND WHY THE RETURN STAYS. What this guard protects is
     * the MARKETPLACE: an abandoned draft must not promote its staged rows
     * or archive somebody else's. Applying a patch does neither. It is keyed
     * on `pending_upload_id = p_upload_id`, so it touches only rows THIS
     * upload is holding values for, and a row a newer list matched has
     * already had its `pending_patch` overwritten by that list's own import —
     * so a row still carrying this upload's patch is one this upload still
     * supplies. The promote and archive steps below are untouched and stay
     * behind the return.
     */
    v_patched := public.apply_builder_stock_pending_patch(p_upload_id);
    RETURN jsonb_build_object(
      'published', false, 'reason', 'superseded', 'patched', v_patched);
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
