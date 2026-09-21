-- ===========================================================================
-- A STRANDED FINALISATION IS WORK, SO THE TICK STAYS AWAKE FOR IT.
--
-- WHAT SHIPPED AN HOUR AGO, AND WHY IT COULD NOT RUN.
--
-- `recoverAbandonedFinalisations` writes the outcome an import never wrote:
-- `runStockImport` stamps `status = 'imported'` BEFORE it writes the
-- properties, only the caller's `finishImport` moves it on, and a worker
-- killed in that window leaves a row nothing in the product can finish. It
-- rides inside the settler's `runTickHousekeeping`, beside
-- `settleCompletedUploads`, which is the one shared body every settler exit
-- calls.
--
-- IT IS REACHED BY STARTING THAT FUNCTION, AND NOTHING WOULD START IT.
-- Measured immediately after the deploy of 21 SEPTEMBER 2026: upload
-- `5511d2e2` still read `status: imported`, `processing_completed_at: null`,
-- `records_detected: 0` beside its live property and its nine stored images,
-- and `/functions/v1/builder-stock-image-settler` was not invoked ONCE in the
-- twenty minutes that followed. `cron.job` held four rows and
-- `settle-builder-stock-marketplace-eligibility` was not among them: the tick
-- had already unscheduled itself, correctly, because every term of its
-- keep-alive sum was zero.
--
-- THIS IS `20260919110000`'s DEFECT ONE LEVEL UP. That migration's own header
-- records the rule — "the cron tick starts a settler only for claimable IMAGE
-- work" — and fixed the case where the tick was AWAKE and started nobody.
-- Here the tick is not awake at all, because the sum it retires on asks six
-- questions and a stranded finalisation is not one of them. Adding a pass to
-- the housekeeping body reaches every exit by construction; it does not make
-- an exit happen.
--
-- SO THE SUM GAINS A SEVENTH TERM. It counts exactly what
-- `recoverAbandonedFinalisation` will act on — an upload at `imported`, not
-- deleted, whose run cannot still be in flight — and it is deliberately the
-- same question rather than a looser one: a term that counts rows the
-- recovery will refuse is a tick that never retires.
--
-- AND IT STOPS, which is the bound every term here has to carry. The pass
-- this keeps alive is the pass that discharges it: the recovery moves the row
-- to `enriching`, at which point `v_upload_completion` owns it and settles it
-- to `complete`. Verified on the shape rather than assumed — the recovery's
-- write is conditioned on `status = 'imported'`, so a row it has moved cannot
-- be counted here again.
--
-- THE FIFTEEN MINUTES IS `ABANDONED_PARSE_MS`, and it is spelled twice: once
-- in `uploadCompletion.ts` and once here. `builderStockStrandedTickTerm.spec`
-- reads both and fails if they drift, because a window that disagrees with
-- itself is a tick that wakes for work the recovery will not do, or sleeps
-- through work it would.
-- ===========================================================================

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
  v_stranded integer;
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

  /*
   * AND AN IMPORT WHOSE RUN WAS KILLED BEFORE IT WROTE ITS OWN OUTCOME.
   *
   * `imported` is stamped before the properties are written, so it is a LIVE
   * status for the seconds an import spends writing them — which is why the
   * age test is here and not merely implied. An edge invocation cannot
   * outlive its own ceiling of roughly 150 seconds, so fifteen minutes
   * cannot mistake a running import for an abandoned one.
   *
   * An unreadable start stamp counts: every path that sets this status
   * stamps the start in the same write, so a row without one is not an
   * import in flight. Same rule, same direction, as `finalisationIsAbandoned`.
   */
  SELECT count(*) INTO v_stranded
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status = 'imported'
     AND (u.processing_started_at IS NULL
          OR u.processing_started_at < now() - interval '15 minutes');

  -- A blocked invariant upload keeps the tick alive so the watchdog keeps
  -- stamping and a fixed pipeline resumes work without anything re-arming it.
  SELECT count(*) INTO v_blocked
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.image_invariant
     AND NOT public.builder_stock_upload_superseded(u.id)
     AND (u.published_at IS NULL OR EXISTS (
       SELECT 1 FROM public.builder_stock_items i
        WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'));

  IF v_outstanding + v_fallback + v_item_work + v_publications
     + v_upload_completion + v_stranded + v_blocked = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  -- Steady-state top-up, at most four workers a minute. See `20260920050000`
  -- for the measurement that chose four; unchanged here.
  v_dispatched := public.builder_stock_dispatch_image_workers(4);

  /*
   * AND THE WORK THAT IS NOT IMAGE WORK STILL NEEDS A WORKER.
   *
   * Reaching this line means the keep-alive sum is non-zero: every return
   * above is taken when it is zero. So `v_dispatched = 0` says exactly "this
   * tick found work and started nobody" — which is now also the state a
   * stranded finalisation produces, since it makes no image work claimable.
   * One settler, which claims nothing, finds the item queue drained, falls
   * through to the upload sweep and runs every housekeeping pass the tick
   * owes — `recoverAbandonedFinalisations` and `settleCompletedUploads`
   * among them.
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

-- ===========================================================================
-- THE SAME SELF-CHECKS THE PREVIOUS REVISION CARRIED, PLUS THE NEW TERM.
--
-- `20260919110000` asserts the retirement condition's SHAPE because the
-- housekeeping dispatch below it is only safe while reaching that line proves
-- the sum is non-zero. The shape has changed by exactly one term, so the
-- assertion is restated rather than dropped — dropping it is how the next
-- edit to this sum stops being checked at all.
-- ===========================================================================
DO $$
DECLARE
  v_tick text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_tick
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'settle_builder_stock_marketplace_eligibility_tick';

  IF v_tick IS NULL THEN
    RAISE EXCEPTION 'the settlement tick is missing';
  END IF;

  IF v_tick !~ 'v_outstanding \+ v_fallback \+ v_item_work \+ v_publications\s*\+ v_upload_completion \+ v_stranded \+ v_blocked = 0' THEN
    RAISE EXCEPTION 'the tick''s retirement condition changed shape — the housekeeping dispatch is only safe because reaching it proves the sum is non-zero';
  END IF;

  IF position('cron.unschedule(''settle-builder-stock-marketplace-eligibility'')' IN v_tick) = 0 THEN
    RAISE EXCEPTION 'the tick can no longer unschedule itself, so an idle deployment would run this job for ever';
  END IF;

  IF position('i.lifecycle_status = ''staged''' IN v_tick) = 0 THEN
    RAISE EXCEPTION 'the blocked-upload term no longer counts a published list that still holds properties back';
  END IF;

  IF v_tick !~ 'u\.status = ''imported''' THEN
    RAISE EXCEPTION 'the tick no longer counts a stranded finalisation, so a killed import has nothing to start the pass that recovers it';
  END IF;

  IF position('interval ''15 minutes''' IN v_tick) = 0 THEN
    RAISE EXCEPTION 'the stranded-finalisation window changed — it must stay ABANDONED_PARSE_MS, or the tick wakes for work the recovery refuses';
  END IF;
END;
$$;

-- ===========================================================================
-- AND THE ROWS ALREADY STRANDED GET THE TICK BACK.
--
-- The term above keeps a tick alive; it cannot wake one that has already
-- retired, and on this deployment it had — `cron.job` held four rows and this
-- was not one of them while upload `5511d2e2` sat unrecoverable. A future
-- kill is covered without this block, because the import that precedes it
-- calls `ensure_builder_stock_settlement_scheduled()` and the tick is
-- therefore running when the kill happens.
--
-- CONDITIONAL ON THERE BEING WORK, so a deployment with nothing stranded does
-- not get a cron job it has no use for. The tick retires itself on its first
-- run in that case anyway, but arming it unconditionally would state that
-- there is work to do, and there would not be.
-- ===========================================================================
DO $$
DECLARE
  v_stranded integer;
BEGIN
  SELECT count(*) INTO v_stranded
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status = 'imported'
     AND (u.processing_started_at IS NULL
          OR u.processing_started_at < now() - interval '15 minutes');

  IF v_stranded > 0 THEN
    PERFORM public.ensure_builder_stock_settlement_scheduled();
    RAISE NOTICE 'armed the settlement tick for % stranded finalisation(s)', v_stranded;
  END IF;
END;
$$;
