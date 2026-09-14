BEGIN;

-- ============================================================================
-- Builder Stock — drain the image queue in minutes, not half an hour.
--
-- MEASURED, ACROSS SIXTEEN PRODUCTION IMPORTS OF THE SAME 23-PROPERTY LIST.
-- How many properties end up showing the builder's own photograph is a
-- function of ONE variable: how long the list is left alone before somebody
-- deletes it and imports it again.
--
--     list        alive        with photo    builder photo
--     9207244e     3.8 min          4              4
--     0769de7c     8.7 min          4              4
--     359ede09    10   min          7              7
--     eccc9840   118   min         10             10
--     479689a0    96   min         18             17
--     4dfe1be7   938   min         20             17
--     55d12d53   432   min         21             17
--
-- The pipeline is not broken and the photographs are not wrong. The engine
-- settles ONE property per invocation and pg_cron invokes it ONCE A MINUTE, so
-- a 23-property list needs 23 minutes at the very best and longer whenever a
-- linked Drive package has to be downloaded and parsed. Every operator who
-- looked at a half-filled Marketplace after four minutes, concluded it was
-- broken and re-imported threw away every photograph already found and
-- restarted that clock from zero. Sixteen times.
--
-- ONE PROPERTY PER INVOCATION IS NOT THE PROBLEM AND IS NOT CHANGED. That rule
-- is what stops a package that kills its worker from taking twenty-two
-- unrelated properties down with it, and the settler's own comment states the
-- remedy exactly: "Throughput comes from invoking more often, never from
-- widening this number." So this widens the INVOCATION RATE and nothing else.
--
-- The tick now dispatches one invocation per claimable property, capped. Each
-- lands in its own worker and claims its own row: `claim_builder_stock_image_work`
-- takes `FOR UPDATE SKIP LOCKED` with `p_limit = 1`, so ten concurrent
-- invocations take ten DIFFERENT properties and a lease somebody else holds is
-- stepped over rather than waited for. A worker that dies takes exactly one
-- property's attempt with it, exactly as before.
--
-- THE CAP IS THE SAFETY. It bounds concurrent workers, the vendor calls they
-- make and the rows they lease, so a thousand-property list cannot dispatch a
-- thousand workers. At ten a tick a 23-property list drains in about three
-- minutes instead of twenty-three.
-- ============================================================================

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
  v_target integer;
  v_sanitization integer;
  v_dispatch integer;
  i integer;
BEGIN
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

  -- Unchanged: retire only when BOTH queues are empty.
  IF v_outstanding + v_fallback + v_item_work = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  /*
   * ONE WORKER PER PROPERTY THAT COULD BE CLAIMED RIGHT NOW, capped.
   *
   * `v_item_work` counts properties still owed a stage. A property already
   * leased by a live worker is stepped over by the claim rather than waited
   * for, so dispatching for it costs one cheap no-op tick and never a
   * duplicate — which is why this is sized off the queue rather than off a
   * count of free rows nobody can compute without racing it.
   *
   * At least one always goes, because the upload-level and fallback queues
   * (`v_outstanding`, `v_fallback`) are drained by the same function through
   * its other paths and can be non-zero while `v_item_work` is zero.
   */
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

COMMIT;
