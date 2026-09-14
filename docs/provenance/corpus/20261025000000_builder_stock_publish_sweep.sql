-- Builder Stock — a stock list that is READY must publish itself.
--
-- REPORTED, 30 AUGUST 2026. A replacement import landed correctly: 18 detected,
-- 0 new, 18 updated, every row patched and waiting. Publication readiness
-- answered TRUE. `published_at` stayed NULL, and the Marketplace went on
-- serving the superseded dataset — including the five properties the new source
-- no longer contains — indefinitely.
--
--
-- WHY. PUBLICATION WAS A SIDE EFFECT OF AN ITEM FINISHING.
--
-- The only caller of `publish_builder_stock_upload` anywhere is the image
-- settler, inside the branch that has just completed a claimed property:
--
--     if (claimed.upload_id && claimed.lifecycle_status === 'staged') {
--       publication = await publishUploadIfReady(supabase, claimed.upload_id);
--
-- Three conditions, and a matched-only replacement fails every one of them.
--
--   1. IT ASKS ONLY AFTER SETTLING AN ITEM. An import whose rows all MATCHED
--      stages nothing and inserts nothing, so it owes no image work: the claim
--      returns empty, the branch never runs, and nobody ever asks. This is the
--      most consequential kind of upload there is — a builder re-uploading
--      their list is the ordinary case — and it is exactly the kind that
--      generates no work to hang the question on.
--
--   2. `lifecycle_status === 'staged'`. A matched row is `active`; it is the
--      staged rows that are new. An upload with none is invisible to the test.
--
--   3. `claimed.upload_id`. A matched row awaiting cutover still carries the
--      OLD upload's id — re-pointing it is step 1 of the cutover itself. The
--      new upload's id lives in `pending_upload_id`, so the one id in hand is
--      the wrong one to publish.
--
-- Any one of the three is fatal on its own. Together they mean the safe
-- publication machinery — which is correct, and which #2365 proved end to end
-- — had no way to be invoked for the commonest upload in the product.
--
--
-- THE FIX: THE SCHEDULER ASKS, EVERY MINUTE, ABOUT THE CURRENT UPLOAD.
--
-- Publication becomes its own question rather than a consequence of unrelated
-- work. The tick already runs each minute while anything is outstanding; it now
-- sweeps for an upload that is ready and has not published. An upload owing no
-- image work is precisely the one that publishes on the first sweep, which is
-- the case that could not previously publish at all.
--
-- Nothing about readiness changes. `publish_builder_stock_upload` still
-- evaluates it inside the same statement that flips the rows, still refuses
-- when it is not met, and still archives only what the superseded uploads
-- supply. This adds a caller; it does not add a rule.


-- ── Only the CURRENT upload may publish ─────────────────────────────────────
/*
 * A SUPERSEDED UPLOAD IS NOT A PUBLISHABLE ONE, AND THIS IS NOT THEORETICAL.
 *
 * Measured on the reported deployment: an earlier replacement that never
 * published was ALSO `ready`, holding five pending patches — the five the
 * current source drops. Publishing it would have re-pointed those five rows to
 * ITSELF, taking them out of the current upload's `replaces_upload_ids`, so the
 * cutover's archive step would no longer recognise them as removed and they
 * would have stayed on the Marketplace for ever. A sweep that published
 * "anything ready" would therefore have permanently broken the very membership
 * it exists to correct.
 *
 * So the authority rule the product already states — the newest upload IS the
 * stock list — is enforced here rather than assumed by the caller. It lives in
 * the function and not only in the sweep, because the settler calls this
 * directly too, and a guard only one caller honours is not a guard.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_upload_superseded(p_upload_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.builder_stock_uploads AS newer
      JOIN public.builder_stock_uploads AS this ON this.id = p_upload_id
     WHERE newer.organisation_id = this.organisation_id
       AND newer.id <> this.id
       AND newer.deleted_at IS NULL
       AND newer.created_at > this.created_at
  );
$$;

REVOKE ALL ON FUNCTION public.builder_stock_upload_superseded(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_upload_superseded(uuid)
  TO postgres, service_role;


-- ── The cutover, with the authority rule in front of it ─────────────────────
/*
 * Identical to 20261022000000 in every respect except the two refusals at the
 * top. The three ordered steps, the named-column patch, the archive predicate
 * and the readiness evaluation are unchanged and deliberately restated in full
 * rather than patched, so this file is the whole of what runs.
 */
CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload(p_upload_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ready boolean;
  v_staged bigint;
  v_outstanding bigint;
  v_replaces uuid[];
  v_published integer := 0;
  v_archived integer := 0;
  v_patched integer := 0;
  v_deleted timestamptz;
  v_already timestamptz;
BEGIN
  SELECT deleted_at, published_at INTO v_deleted, v_already
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  IF v_already IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'already_published');
  END IF;

  -- A deleted upload is not a stock list, and a superseded one is somebody's
  -- abandoned draft. Neither may move the Marketplace.
  IF v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'deleted');
  END IF;

  IF public.builder_stock_upload_superseded(p_upload_id) THEN
    RETURN jsonb_build_object('published', false, 'reason', 'superseded');
  END IF;

  SELECT staged, source_outstanding, ready
    INTO v_staged, v_outstanding, v_ready
    FROM public.builder_stock_publication_readiness(p_upload_id);

  IF NOT coalesce(v_ready, false) THEN
    RETURN jsonb_build_object(
      'published', false, 'reason', 'not_ready',
      'staged', coalesce(v_staged, 0), 'source_outstanding', coalesce(v_outstanding, 0));
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
   */
  UPDATE public.builder_stock_items AS i
     SET external_reference = coalesce(i.pending_patch->>'external_reference', i.external_reference),
         development_name   = coalesce(i.pending_patch->>'development_name', i.development_name),
         project_name       = coalesce(i.pending_patch->>'project_name', i.project_name),
         address_line       = coalesce(i.pending_patch->>'address_line', i.address_line),
         suburb             = coalesce(i.pending_patch->>'suburb', i.suburb),
         state              = coalesce(i.pending_patch->>'state', i.state),
         postcode           = coalesce(i.pending_patch->>'postcode', i.postcode),
         lot_number         = coalesce(i.pending_patch->>'lot_number', i.lot_number),
         unit_number        = coalesce(i.pending_patch->>'unit_number', i.unit_number),
         bedrooms           = coalesce((i.pending_patch->>'bedrooms')::numeric, i.bedrooms),
         bathrooms          = coalesce((i.pending_patch->>'bathrooms')::numeric, i.bathrooms),
         car_spaces         = coalesce((i.pending_patch->>'car_spaces')::numeric, i.car_spaces),
         property_type      = coalesce(i.pending_patch->>'property_type', i.property_type),
         land_size_sqm      = coalesce((i.pending_patch->>'land_size_sqm')::numeric, i.land_size_sqm),
         building_size_sqm  = coalesce((i.pending_patch->>'building_size_sqm')::numeric, i.building_size_sqm),
         price              = coalesce((i.pending_patch->>'price')::numeric, i.price),
         price_display      = coalesce(i.pending_patch->>'price_display', i.price_display),
         expected_completion= coalesce(i.pending_patch->>'expected_completion', i.expected_completion),
         description        = coalesce(i.pending_patch->>'description', i.description),
         availability_status= coalesce(i.pending_patch->>'availability_status', i.availability_status),
         builder_project_id = coalesce((i.pending_patch->>'builder_project_id')::uuid, i.builder_project_id),
         builder_unit_id    = coalesce((i.pending_patch->>'builder_unit_id')::uuid, i.builder_unit_id),
         source_row         = coalesce(i.pending_patch->'source_row', i.source_row),
         upload_id          = p_upload_id,
         last_seen_at       = now(),
         pending_patch      = NULL,
         pending_upload_id  = NULL,
         updated_at         = now()
   WHERE i.pending_upload_id = p_upload_id;
  GET DIAGNOSTICS v_patched = ROW_COUNT;

  -- 2. Promote this upload's staged rows.
  UPDATE public.builder_stock_items
     SET lifecycle_status = 'active', updated_at = now()
   WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';
  GET DIAGNOSTICS v_published = ROW_COUNT;

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

  UPDATE public.builder_stock_uploads
     SET published_at = now(), updated_at = now()
   WHERE id = p_upload_id AND published_at IS NULL;

  RETURN jsonb_build_object(
    'published', true, 'promoted', v_published,
    'patched', v_patched, 'archived', v_archived);
END;
$$;

REVOKE ALL ON FUNCTION public.publish_builder_stock_upload(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_builder_stock_upload(uuid)
  TO postgres, service_role;


-- ── How many cutovers are owed right now ────────────────────────────────────
/*
 * The scheduler needs this for the same reason it needs the work queue: the
 * retirement test is a sum, and a quantity missing from that sum is a quantity
 * the sweep can retire on top of. An upload that owes no image work is ready
 * the moment it is imported and contributes nothing to the other three counts,
 * so without this the tick could unschedule itself with a cutover pending — the
 * identical failure, arrived at from the other side.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_publications_pending()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
    FROM public.builder_stock_uploads AS u
   WHERE u.published_at IS NULL
     AND u.deleted_at IS NULL
     AND NOT public.builder_stock_upload_superseded(u.id)
     AND (SELECT ready FROM public.builder_stock_publication_readiness(u.id));
$$;

REVOKE ALL ON FUNCTION public.builder_stock_publications_pending()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_publications_pending()
  TO postgres, service_role;


-- ── The sweep ───────────────────────────────────────────────────────────────
/*
 * Every unpublished, undeleted, unsuperseded upload is offered to the cutover.
 * ASKING IS THE WHOLE POINT and refusing is the normal answer: readiness is
 * evaluated inside `publish_builder_stock_upload`, in the same statement that
 * flips the rows, so this can never publish something that is not ready and
 * cannot race with the work that makes it ready.
 *
 * It returns what it did rather than nothing, so a run leaves evidence.
 */
CREATE OR REPLACE FUNCTION public.publish_ready_builder_stock_uploads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_upload record;
  v_result jsonb;
  v_published integer := 0;
  v_considered integer := 0;
  v_details jsonb := '[]'::jsonb;
BEGIN
  FOR v_upload IN
    SELECT u.id
      FROM public.builder_stock_uploads AS u
     WHERE u.published_at IS NULL
       AND u.deleted_at IS NULL
       AND NOT public.builder_stock_upload_superseded(u.id)
     ORDER BY u.created_at
  LOOP
    v_considered := v_considered + 1;
    v_result := public.publish_builder_stock_upload(v_upload.id);
    IF (v_result->>'published')::boolean THEN
      v_published := v_published + 1;
      v_details := v_details || jsonb_build_object('upload_id', v_upload.id, 'result', v_result);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'considered', v_considered, 'published', v_published, 'cutovers', v_details);
END;
$$;

REVOKE ALL ON FUNCTION public.publish_ready_builder_stock_uploads()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_ready_builder_stock_uploads()
  TO postgres, service_role;


-- ── The tick asks, before it decides whether to retire ──────────────────────
/*
 * Two changes, and nothing else: the sweep runs FIRST, and the count of owed
 * cutovers joins the retirement sum. Publishing before counting matters —
 * publication is what makes an upload stop being outstanding, so a tick that
 * counted first would keep the job alive for one extra minute after every
 * cutover for no reason, and, worse, a tick that never published would keep
 * counting for ever.
 *
 * The per-item fan-out from 20261024000000 is carried through unchanged.
 */
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $tick$
DECLARE
  v_outstanding integer := 0;
  v_fallback integer := 0;
  v_item_work integer := 0;
  v_publications integer := 0;
  v_target integer;
  v_sanitization integer;
  v_dispatch integer;
  i integer;
BEGIN
  /*
   * ASK ABOUT PUBLICATION FIRST, AND UNCONDITIONALLY.
   *
   * Not after the work counts and not only when something is outstanding: an
   * upload whose rows all matched owes no image work at all, so every count
   * below can be zero while a cutover is owed. That upload is the one this
   * exists for.
   */
  PERFORM public.publish_ready_builder_stock_uploads();

  SELECT marketplace_eligibility_version, image_sanitization_version
    INTO v_target, v_sanitization
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);
  v_sanitization := coalesce(v_sanitization, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
          OR coalesce(image_sanitization_settled_version, -1) < v_sanitization
          OR source_images_settled_version IS NULL);

  SELECT count(*) INTO v_fallback
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND enrichment_status IN ('pending', 'enriching');

  SELECT count(*) INTO v_item_work
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND image_work_stage <> 'settled';

  v_publications := public.builder_stock_publications_pending();

  IF v_outstanding + v_fallback + v_item_work + v_publications = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  v_dispatch := least(greatest(v_item_work, 1), 10);

  FOR i IN 1..v_dispatch LOOP
    PERFORM public.cron_invoke_signed_function(
      'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
  END LOOP;
END;
$tick$;

REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;
