-- ===========================================================================
-- THE WORK THE TICK STAYS AWAKE FOR CAN START A WORKER.
--
-- MEASURED IN PRODUCTION, 19 SEPTEMBER 2026. Upload `c2b7faa1` (13
-- properties, `export.csv`) imported at 10:38:59, published all thirteen at
-- 10:46:02 and then sat at `status = 'enriching'` indefinitely. The builder's
-- Stock List read `Properties listed 13 · No imagery outstanding` beside
-- `Stock lists uploaded 1 · 1 still being read`, under a spinner saying
-- `Bringing in your stock list`. Both sentences were true and the page
-- contradicted itself, for ever.
--
-- The cron job was not dead. `cron job 12` — this function — started and
-- completed every minute without a gap the whole time (Postgres logs, through
-- 11:10:00). It did not unschedule itself either, correctly: `v_upload_completion`
-- counts an upload at `enriching` whose properties are finished, so the
-- keep-alive sum was never zero.
--
-- IT WOKE UP EVERY MINUTE, FOUND WORK, AND STARTED NOTHING. The tick's only
-- act is `builder_stock_dispatch_image_workers(2)`, whose first statement is
--
--     SELECT claimable INTO v_claimable FROM public.builder_stock_image_work_pending();
--     IF coalesce(v_claimable, 0) = 0 THEN RETURN 0; END IF;
--
-- and `builder_stock_image_work_pending` counts ONE kind of work: items whose
-- `image_work_stage <> 'settled'`. The keep-alive above asks SIX questions.
-- For the other five the tick is awake and mute. The settler's own last run
-- said so in its own numbers — `claimable: 0, outstanding: 0` at 10:46:02.655
-- — and `/functions/v1/builder-stock-image-settler` was not invoked once in
-- the twenty-five minutes that followed.
--
-- WHY THAT STRANDS AN IMPORT. `settleCompletedUploads` — the only thing in
-- this product that moves an upload off `enriching` — rides inside the
-- settler's `runTickHousekeeping`. It is reached by STARTING that function.
-- So once the last photograph settles, the one act still owed has no route to
-- a worker, and the design's own recovery path (claim nothing → the item
-- queue is drained → fall through to the upload sweep → housekeeping) is
-- unreachable for exactly the same reason: it needs an invocation, and only
-- image work starts one.
--
-- THE RULE. A tick that reached this line has already established that its
-- keep-alive sum is non-zero — it returns above otherwise. So if nothing was
-- dispatched, work exists and no worker was started, and ONE is started here.
-- The condition is deliberately `v_dispatched = 0` rather than a list of the
-- terms that are not image work: a condition naming terms is one more copy of
-- the keep-alive sum to keep in step, and two copies of that sum drifting
-- apart is the whole defect above.
--
-- ONE, NOT TWO. The settler that claims nothing falls through to the upload
-- sweep and does every housekeeping pass there; a second isolate would find
-- the lease held and return. Throughput here is not the point — reaching the
-- work at all is.
--
-- AND IT CANNOT FAIL THE TICK. `cron_invoke_signed_function` RAISES when the
-- vault has no `supabase_url`, so it is wrapped exactly as
-- `builder_stock_dispatch_image_workers` wraps its own loop: dispatch is the
-- accelerator, never the guarantee, and a vault hiccup must not take the
-- watchdog and the publication sweeps down with it.
--
-- The caller is named `housekeeping` so the reason for the invocation is on
-- the request rather than inferred. That is safe on the wire: the settler
-- calls `verifyInternal` with no `allowedCallers`, and the caller string is
-- inside the HMAC, so it can be read and cannot be forged —
-- `builder_stock_dispatch_image_workers` has been sending `dispatch` through
-- the same door in production all along.
--
-- NOTHING ELSE CHANGES. The function is otherwise byte-identical to the
-- definition `20260919030000_first_publication_publishes_what_is_ready.sql`
-- installed: the same six keep-alive terms, the same sweeps in the same
-- order, the same unschedule condition, the same `builder_stock_dispatch_image_workers(2)`
-- first. No image rule, no publication rule and no eligibility rule is
-- touched, and an upload that completes today completes in exactly the same
-- way.
--
-- WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO THE BASELINE.
-- `00000000000000_network_baseline.sql` still carries the ORIGINAL body,
-- which dispatched two workers unconditionally. It is a generated snapshot of
-- the schema as it stood on 14 September — `build-baseline.mjs` writes it and
-- `.baseline-fingerprint` freezes it, and `baseline-check.mjs` applies it
-- alone against a bootstrap and fails on any drift. It is superseded in
-- ledger order by `20260915200000_stock_image_invariant.sql` (which
-- introduced the dispatch gate) and then by `20260919030000`. Editing it
-- would break the fingerprint and would still not reach production. This file
-- is the last writer, in production and in a rebuild alike.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_target integer;
  v_sanitization integer;
  v_provenance integer;
  v_outstanding integer;
  v_fallback integer;
  v_item_work integer;
  v_publications integer;
  v_upload_completion integer;
  v_blocked integer;
  v_dispatched integer;
BEGIN
  PERFORM public.builder_stock_image_watchdog();
  PERFORM public.publish_ready_builder_stock_uploads();
  PERFORM public.reopen_builder_stock_stranded_items();
  -- And the properties a superseded worker failed on, which the sibling above
  -- cannot see: it reopens on a changed ladder, this on a changed runtime.
  PERFORM public.reopen_builder_stock_runtime_failures();

  SELECT marketplace_eligibility_version, image_sanitization_version,
         source_images_version
    INTO v_target, v_sanitization, v_provenance
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);
  v_sanitization := coalesce(v_sanitization, 0);
  v_provenance := coalesce(v_provenance, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
          OR coalesce(image_sanitization_settled_version, -1) < v_sanitization
          -- WAS `source_images_settled_version IS NULL`. An upload re-read
          -- under an older extractor is outstanding in exactly the way an
          -- upload never read is, and only the second was countable.
          OR coalesce(source_images_settled_version, -1) < v_provenance);

  SELECT count(*) INTO v_fallback
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND enrichment_status IN ('pending', 'enriching');

  SELECT count(*) INTO v_item_work
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND image_work_stage <> ALL (ARRAY['settled', 'failed']);

  v_publications := public.builder_stock_publications_pending();

  SELECT count(*) INTO v_upload_completion
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status IN ('enriching', 'partially_complete')
     AND NOT EXISTS (
       SELECT 1
         FROM public.builder_stock_items it
        WHERE it.upload_id = u.id
          AND it.lifecycle_status = 'active'
          AND it.enrichment_status IN ('pending', 'enriching')
     );

  -- A blocked invariant upload keeps the tick alive so the watchdog keeps
  -- stamping and a fixed pipeline resumes work without anything re-arming it.
  /*
   * AND A PUBLISHED LIST THAT STILL HOLDS PROPERTIES BACK COUNTS HERE TOO.
   *
   * This was `published_at IS NULL`, which was the same question as "is
   * anything still owed" right up until a first list could publish part of
   * itself. It is the counter that keeps the every-minute tick SCHEDULED:
   * with the held-back rows sitting at `failed` and the upload now stamped
   * published, every term in the sum could reach zero, the tick would
   * unschedule itself, and the builder's next supplied picture would sit in
   * the table with nothing running to look at it. That is the "picture
   * saved, card still blank" failure again, arriving by a different door.
   */
  SELECT count(*) INTO v_blocked
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.image_invariant
     AND NOT public.builder_stock_upload_superseded(u.id)
     AND (u.published_at IS NULL OR EXISTS (
       SELECT 1 FROM public.builder_stock_items i
        WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'));

  IF v_outstanding + v_fallback + v_item_work + v_publications
     + v_upload_completion + v_blocked = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  -- Steady-state trickle: the tick tops the fleet up by at most two workers a
  -- minute; the import-time kick is what starts a fresh upload six-wide.
  v_dispatched := public.builder_stock_dispatch_image_workers(2);

  /*
   * AND THE WORK THAT IS NOT IMAGE WORK STILL NEEDS A WORKER.
   *
   * Reaching this line means the keep-alive sum is non-zero: every return
   * above is taken when it is zero. So `v_dispatched = 0` says exactly
   * "this tick found work and started nobody", which is the state upload
   * `c2b7faa1` sat in for twenty-five minutes with the cron firing every
   * one of them. One settler, which claims nothing, finds the item queue
   * drained, falls through to the upload sweep and runs every housekeeping
   * pass the tick owes — `settleCompletedUploads` among them.
   */
  IF coalesce(v_dispatched, 0) = 0 THEN
    BEGIN
      PERFORM public.cron_invoke_signed_function(
        'builder-stock-image-settler', '{}'::jsonb, 'housekeeping');
    EXCEPTION WHEN OTHERS THEN
      -- Never fails the tick. Same rule, and the same reason, as the
      -- dispatcher's own loop.
      NULL;
    END;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'Watchdog first, then publication and re-open sweeps, then a dispatch derived from the claimable backlog (≤2/min steady; the import-time kick handles bursts). A tick that finds work and dispatches no image worker starts ONE settler anyway, because upload completion and the blocked-upload recovery are done inside that function and only image work used to be able to start it. Terminal ''failed'' items are deliberately NOT counted as work — they are a person''s queue — but a blocked invariant upload keeps the tick alive so recovery needs no re-arming.';

-- ---------------------------------------------------------------------------
-- The proof.
--
-- HALF OF IT IS BY EFFECT AND HALF IS ON THE DEPLOYED TEXT, deliberately, and
-- the split is the same one `20260919030000` made about this same function and
-- for the same reason: the behaviour that matters — a tick starting a worker,
-- or unscheduling itself — fires only on conditions spanning the WHOLE
-- database, which a proof running inside one populated transaction cannot
-- manufacture without deleting other people's rows.
--
-- So the PREMISE is measured against real rows through the real function, and
-- the CONSEQUENCE is read out of `pg_get_functiondef`, which is the text the
-- database will actually run rather than the text of this file. The first
-- version of a check like this re-implemented the query it was testing and
-- passed against a mutant that changed the function; nothing here re-states a
-- query it is judging.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_org uuid; v_upload uuid; v_item uuid; v_img uuid;
  v_before bigint; v_after bigint;
  v_before_out bigint; v_after_out bigint;
  v_src text;
BEGIN
  -- === 1. BY EFFECT: a finished property is invisible to the dispatcher. ===
  --
  -- `builder_stock_dispatch_image_workers` starts nothing when
  -- `builder_stock_image_work_pending().claimable` is zero, and that view
  -- counts only `image_work_stage <> 'settled'`. Measured as a DIFFERENTIAL
  -- across a real insert, because the function is deployment-wide and this
  -- database is populated: what is asserted is that the new property moves
  -- neither number, which is the premise the branch above exists for.
  SELECT claimable, outstanding INTO v_before, v_before_out
    FROM public.builder_stock_image_work_pending();

  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Housekeeping Dispatch Proof Org', 'builder', 'active', true, now())
  RETURNING id INTO v_org;

  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'housekeeping.csv', 'proof/housekeeping.csv', 'enriching')
  RETURNING id INTO v_upload;

  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_upload, 'active', '1 Finished Street', 'Truganina')
  RETURNING id INTO v_item;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_item, v_upload, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/finished.jpg')
  RETURNING id INTO v_img;

  /*
   * THE EXACT 19 SEPTEMBER SHAPE. The ladder is settled and carrying the
   * builder's own photograph, while `enrichment_status` still reads the
   * `pending` its import gave it — the legacy latch `uploadCompletion.ts`
   * documents, measured at 83 of 91 properties on 7 September. This property
   * is finished and its upload is one act from `complete`.
   */
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img,
         image_work_stage = 'settled',
         enrichment_status = 'pending'
   WHERE id = v_item;

  SELECT claimable, outstanding INTO v_after, v_after_out
    FROM public.builder_stock_image_work_pending();

  IF v_after <> v_before OR v_after_out <> v_before_out THEN
    RAISE EXCEPTION 'a settled property reached the image-work queue (claimable % -> %, outstanding % -> %) — the premise of the housekeeping dispatch no longer holds',
      v_before, v_after, v_before_out, v_after_out;
  END IF;

  -- === 2. ON THE DEPLOYED TEXT: work found, nothing dispatched, one worker. ==
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'settle_builder_stock_marketplace_eligibility_tick';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'the settlement tick is missing';
  END IF;

  -- The dispatcher still runs FIRST and its answer is what the branch reads.
  -- A fallback that ignored the return value would start a second worker on
  -- every tick of a healthy import.
  IF v_src !~ 'v_dispatched\s*:=\s*public\.builder_stock_dispatch_image_workers\(2\)' THEN
    RAISE EXCEPTION 'the tick no longer reads what the image dispatcher did, so it cannot tell a tick that started workers from one that started none';
  END IF;
  IF v_src !~ 'coalesce\(v_dispatched, 0\) = 0.{0,200}cron_invoke_signed_function\(\s*''builder-stock-image-settler''' THEN
    RAISE EXCEPTION 'a tick that finds work and dispatches no image worker still starts nobody — upload completion has no route to a worker';
  END IF;

  -- === 3. THE KEEP-ALIVE IS UNCHANGED, so the new branch can never fire on
  --        a tick that should have retired instead. All six terms, and the
  --        unschedule that sums them, must still be there.
  IF v_src !~ 'v_outstanding \+ v_fallback \+ v_item_work \+ v_publications\s*\+ v_upload_completion \+ v_blocked = 0' THEN
    RAISE EXCEPTION 'the tick''s retirement condition changed shape — the housekeeping dispatch is only safe because reaching it proves the sum is non-zero';
  END IF;
  IF position('cron.unschedule(''settle-builder-stock-marketplace-eligibility'')' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the tick can no longer unschedule itself, so an idle deployment would run this job for ever';
  END IF;
  IF position('i.lifecycle_status = ''staged''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the tick no longer counts a published list that still holds properties back';
  END IF;

  RAISE EXCEPTION 'proof complete — rolling back' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'proof complete — rolling back' THEN RAISE; END IF;
END;
$assert$;

COMMIT;
