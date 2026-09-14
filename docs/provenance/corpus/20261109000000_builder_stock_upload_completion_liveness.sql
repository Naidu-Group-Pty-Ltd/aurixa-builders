-- ===========================================================================
-- Builder Stock — an upload awaiting its own status is WORK.
--
-- THE DEFECT, MEASURED IN PRODUCTION ON 3 SEPTEMBER 2026.
--
-- `settle_builder_stock_marketplace_eligibility_tick` counts four kinds of
-- outstanding work — uploads behind a settlement version, properties owed
-- enrichment, properties owed item work, pending publications — and
-- unschedules the cron job when the sum is zero. That is correct and is what
-- keeps this engine from running for ever.
--
-- The settler now carries a fifth kind: recording an import as FINISHED.
-- Every stage of imagery had moved to the backend, so an import completes
-- with nobody watching, and the upload row's own status (`enriching` ->
-- `complete`) was being written only by the Builder Portal's browser loop.
-- The settler settles it now — but the tick's liveness rule had never heard
-- of that work, so the engine unscheduled itself with the work pending.
--
-- Measured: upload `tq.csv` imported at 14:04 on 2 September (14 detected, 14
-- updated, 0 failed). Its eleven live properties finished — all `settled`,
-- ten drawing the builder's own brochure render — the four counted queues
-- reached zero, the job unscheduled itself, and the upload was left reading
-- `enriching` with nothing left alive to ever move it. A builder reading that
-- history is told an import is still churning, permanently.
--
-- THE CHANGE IS ONE MORE COUNT, and it mirrors the rule the edge function
-- applies (`_shared/builderStock/uploadCompletion.ts`): an upload in a
-- completable status with no active property still owed enrichment. Two
-- implementations of "is this import finished" is how one of them comes to be
-- wrong, so this counts the same shape rather than inventing a second one.
--
-- It converges: the settler settles such an upload on its next tick, the row
-- leaves `enriching`, the count returns to zero and the job unschedules
-- exactly as before. Nothing else in the tick is touched.
--
-- The migration also arms the job through the existing idempotent helper,
-- because the deployment it lands on already has this work outstanding and
-- nothing alive to notice it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_outstanding integer := 0;
  v_fallback integer := 0;
  v_item_work integer := 0;
  v_publications integer := 0;
  v_upload_completion integer := 0;
  v_target integer;
  v_sanitization integer;
  v_dispatch integer;
  i integer;
BEGIN
  -- Publication first: an upload whose rows all matched owes no image work at
  -- all, so every count below can be zero while a cutover is owed.
  PERFORM public.publish_ready_builder_stock_uploads();

  -- Then the properties whose conclusion was drawn from evidence that has
  -- since changed. Before the counting, for the same reason.
  PERFORM public.reopen_builder_stock_stranded_items();

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

  -- An import whose properties are all finished still owes its own record of
  -- being finished. Same rule as `uploadCompletion.ts`: a completable status,
  -- and no ACTIVE property of this upload still owed enrichment.
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

  IF v_outstanding + v_fallback + v_item_work + v_publications
     + v_upload_completion = 0 THEN
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
$function$;

-- CREATE grants EXECUTE to PUBLIC, and `anon` inherits it — so a SECURITY
-- DEFINER function shipped without this is reachable from the browser with
-- the publishable key on any database built from these migrations. The grant
-- is the one this function has carried since 20260818120000, restated because
-- the privileges belong with the definition rather than to whichever earlier
-- migration happened to set them.
REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'Drives builder-stock-image-settler and unschedules its cron job when no '
  'work of ANY kind remains: settlement versions, enrichment, item work, '
  'pending publications, and uploads still owed their own completion record.';

-- The deployment this lands on already holds an upload awaiting completion
-- with nothing alive to notice it. The helper is idempotent.
SELECT public.ensure_builder_stock_settlement_scheduled();
