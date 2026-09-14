-- Builder Stock — a property whose picture was taken away after it settled
-- must be looked at again.
--
-- #2373 fixed the ladder: a measured refusal is an answer, a skip is not an
-- exhaustion, and `chooseAndStorePrimaryImage` re-opens a settled property
-- whose pointer it has just cleared. That last hook is correct and it cannot
-- reach the properties this exists for, because it runs only while something
-- is processing the item — and the per-item claim selects
-- `image_work_stage <> 'settled'`. A property that settled BEFORE its verdict
-- changed is therefore invisible to every part of the engine, permanently.
--
-- Measured: two properties settled at 09:22 on 29 August holding a builder
-- cover the ladder judged displayable. The cover was re-measured as an
-- annotated marketing tile at 03:08 the next day. Both cards went blank, and
-- nothing in the system was ever going to ask about them again.
--
--
-- THE RULE, AND IT IS A FACT ABOUT TIME RATHER THAN ABOUT IMAGES.
--
-- `settled` is a conclusion drawn from the rows a property held at one moment.
-- Where a row has been re-judged SINCE that moment, the conclusion was drawn
-- from evidence that no longer stands, and the property is owed another look.
--
--     settled at T, and an image updated after T   ->  re-open
--
-- That is expressible here exactly, needs no image semantics in SQL, and is
-- self-limiting: re-opening stamps `image_work_updated_at`, so a property is
-- re-opened once per re-judgement and never in a loop. The engine then decides
-- what to do with it — `nextImageStage` is still the only thing that ranks a
-- ladder, and a property that is genuinely out of stages settles again on its
-- next pass.
--
-- ONLY BLANK ONES. A property showing a picture has nothing to gain and would
-- pay for a stage to be told so.


CREATE OR REPLACE FUNCTION public.reopen_builder_stock_stranded_items()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reopened integer := 0;
BEGIN
  UPDATE public.builder_stock_items AS i
     SET image_work_stage = 'eligibility',
         image_work_next_attempt_at = now(),
         image_work_claim_until = NULL,
         image_work_updated_at = now(),
         updated_at = now()
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND i.image_work_stage = 'settled'
     AND i.primary_image_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM public.builder_stock_item_images AS x
        WHERE x.stock_item_id = i.id
          -- Re-judged after the property concluded it had nothing to show.
          AND x.updated_at > i.image_work_updated_at
     );
  GET DIAGNOSTICS v_reopened = ROW_COUNT;
  RETURN v_reopened;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_builder_stock_stranded_items()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_builder_stock_stranded_items()
  TO postgres, service_role;


-- ── The tick re-opens before it counts ──────────────────────────────────────
/*
 * Same shape and same reason as the publication sweep in 20261025000000: a
 * quantity the tick cannot see is one it can retire on top of. A stranded
 * property contributes nothing to `v_item_work` precisely BECAUSE it is
 * settled, so the re-open has to happen before the counting or the scheduler
 * would go quiet with work owed.
 *
 * Everything else in this function is carried through unchanged.
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
