-- BUILDER STOCK — CONCURRENCY IS A PROPERTY OF THE RUNTIME, NOT OF THE QUEUE.
--
-- The dispatch count was `least(greatest(v_item_work, 1), 10)`: one invocation
-- per outstanding property, capped at ten. Concurrency therefore scaled with
-- the backlog — the larger the import, the more workers were started at once —
-- and concurrent invocations of one Edge Function share an isolate and its
-- memory ceiling.
--
-- MEASURED, 7 SEPTEMBER 2026, upload `bd7a0ef5` (78 properties). Each linked
-- brochure is 8–12 MB and needs 50–68 MB to read ALONE, electing its facade in
-- about a second. Five concurrent reads peak at 429 MB against a 256 MB
-- ceiling; the isolate dies, every property in flight loses an attempt, and
-- six of them reached the four-attempt kill limit and were retired as though
-- their documents contained no photograph. The whole upload took 161 minutes —
-- 0.48 properties a minute, an order of magnitude BELOW this dispatcher's own
-- ceiling of ten, because each kill discarded everything in flight.
--
-- So the number is fixed and small, and throughput comes from the settler
-- doing more per invocation instead: it now claims one property, finishes it,
-- records it, and only then claims the next, holding exactly one lease at any
-- instant. Two is deliberately conservative — the measurement that justifies
-- three has not been taken yet, and taking it is cheaper than another
-- congestion collapse.
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_target integer;
  v_sanitization integer;
  v_outstanding integer;
  v_fallback integer;
  v_item_work integer;
  v_publications integer;
  v_upload_completion integer;
  v_dispatch integer;
  i integer;
BEGIN
  PERFORM public.publish_ready_builder_stock_uploads();
  PERFORM public.reopen_builder_stock_stranded_items();
  -- And the properties a superseded worker failed on, which the sibling above
  -- cannot see: it reopens on a changed ladder, this on a changed runtime.
  PERFORM public.reopen_builder_stock_runtime_failures();

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

  -- FIXED, and deliberately not derived from any count above. See the header:
  -- a backlog is a reason to work steadily, never a licence to start more
  -- workers inside one memory ceiling.
  v_dispatch := 2;

  FOR i IN 1..v_dispatch LOOP
    PERFORM public.cron_invoke_signed_function(
      'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'Drives builder-stock-image-settler at a FIXED small concurrency and '
  'unschedules its cron job when no work of any kind remains. Concurrency is '
  'a property of the runtime, never of the backlog — see the migration header.';
