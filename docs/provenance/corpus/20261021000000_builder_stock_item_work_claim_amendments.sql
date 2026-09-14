-- Builder Stock — the two halves of the per-item work claim that did not land.
--
-- WHY THIS IS A SECOND FILE. `20261019000000_builder_stock_item_work_claim.sql`
-- was merged and applied to production carrying only the first of its branch's
-- three commits; the other two — a `p_reset_attempts` argument, and the cron
-- gate's third queue — were pushed after the merge and never reached `main`.
-- Editing the first file would not help: migrations here are dispatched by
-- hand, one file at a time, and a file that has already been applied is never
-- dispatched again, so production would keep the version it has. A new file is
-- the only thing that reaches a database that has already run the first one.
--
-- NEITHER HALF IS OPTIONAL, AND BOTH ARE BLOCKING FOR THE EDGE CODE.
--
-- 1. `complete_builder_stock_image_work` is deployed with FIVE arguments. The
--    settler calls it with SIX. PostgREST resolves a function by the names in
--    the request body, so a six-argument call against the five-argument
--    function answers PGRST202, "Could not find the function in the schema
--    cache" — which `isMissingCapability` correctly classifies as an
--    undeployed migration. The claim would therefore SUCCEED and the
--    completion would silently report "not deployed": every property claimed,
--    worked, never advanced, and left leased until its lease expired. That is
--    worse than the head-of-line blocking being removed.
--
-- 2. The cron gate counts two queues — uploads below a settlement marker, and
--    active properties whose `enrichment_status` is pending or enriching —
--    and neither can see a property that still owes per-item image work.
--    THIS IS NOT HYPOTHETICAL ANY MORE: at the moment the first file was
--    applied, both of those queues were empty, the job had already
--    unscheduled itself, and `cron.job` held no builder-stock entry at all
--    while `builder_stock_image_work_pending()` reported 23 outstanding
--    properties. Without this, the per-item engine would ship with nothing to
--    wake it.


-- ── One overload, not two ───────────────────────────────────────────────────
--
-- Created before the old one is dropped, so there is no window in which
-- neither exists. Dropping matters: with both present a five-argument call
-- matches BOTH candidates — the sixth parameter has a default — and PostgREST
-- answers 300 Multiple Choices rather than picking one.
CREATE OR REPLACE FUNCTION public.complete_builder_stock_image_work(
  p_item_id uuid,
  p_next_stage text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT 0,
  p_reset_attempts boolean DEFAULT false
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.builder_stock_items AS i
     SET image_work_stage = coalesce(p_next_stage, i.image_work_stage),
         /*
          * A RESUMABLE STEP THAT PROGRESSED MUST NOT ACCUMULATE BACKOFF.
          *
          * Some stages are legitimately resumable: a source read that stored
          * what it could and will store the rest next tick has made progress,
          * and counting that as a failed attempt would push a HEALTHY
          * property's backoff towards the hour cap for doing exactly what it
          * is supposed to do.
          *
          * The asymmetry is the design. A worker that RETURNS and reports
          * progress clears the count; a worker that is KILLED returns nothing,
          * clears nothing, and the count it raised inside the claim stands.
          * The counter measures silence, not work.
          *
          * It is still not a package retirement counter and must never be used
          * as one — `MAX_PACKAGE_ATTEMPTS = 2` lives in
          * `source_provenance_result`, is written before the download begins,
          * and is untouched by anything here.
          */
         image_work_attempts = CASE
           WHEN coalesce(p_reset_attempts, false) THEN 0
           WHEN p_next_stage IS NOT NULL AND p_next_stage IS DISTINCT FROM i.image_work_stage
             THEN 0
           ELSE i.image_work_attempts
         END,
         image_work_claim_until = NULL,
         image_work_next_attempt_at =
           now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 0), 0)),
         image_work_last_result = left(p_result, 200),
         image_work_last_error = left(p_error, 500),
         image_work_updated_at = now()
   WHERE i.id = p_item_id
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.complete_builder_stock_image_work(uuid, text, text, text, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_builder_stock_image_work(uuid, text, text, text, integer, boolean)
  TO postgres, service_role;

DROP FUNCTION IF EXISTS public.complete_builder_stock_image_work(uuid, text, text, text, integer);


-- ── The scheduler must not retire while a property still owes work ──────────
--
-- Moves in exactly one direction: it can only keep the sweep ALIVE longer,
-- never retire it earlier. The re-arm on INSERT (20261012000000) is untouched
-- and is still what wakes a new import; this governs only when the engine may
-- sleep.
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
   WHERE lifecycle_status = 'active'
     AND enrichment_status IN ('pending', 'enriching');

  /*
   * THE THIRD QUEUE. A property that has not reached `settled` still owes
   * work, whatever its `enrichment_status` says — the two answer different
   * questions, and a property can complete the fallback ladder while its
   * source or eligibility stage is still outstanding.
   *
   * OUTSTANDING, NOT CLAIMABLE. A property leased by a live invocation, or
   * backing off after one was killed, is not claimable this minute and is
   * absolutely not finished. Sleeping on `claimable = 0` would retire the
   * engine at precisely the moment a worker died — which is the state
   * production spent seventeen minutes in on 29 August: six `CPU Time
   * exceeded`, ten `lease_held`, not one completed tick.
   *
   * The column is read defensively because this function is REPLACED by a
   * later migration than the one that adds it, and a database that somehow
   * has only this file must still tick rather than error every minute.
   */
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'builder_stock_items'
       AND column_name = 'image_work_stage'
  ) THEN
    EXECUTE $count$
      SELECT count(*) FROM public.builder_stock_items
       WHERE lifecycle_status = 'active' AND image_work_stage <> 'settled'
    $count$ INTO v_item_work;
  END IF;

  IF v_outstanding + v_fallback + v_item_work = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  PERFORM public.cron_invoke_signed_function(
    'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
END;
$tick$;

REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;


-- ── And put the engine back ─────────────────────────────────────────────────
--
-- THE JOB IS GONE RIGHT NOW. Both of the gate's old queues reached zero, so it
-- unscheduled itself — correctly, under the rules it had. Under the third
-- queue it should be running, because 23 active properties are outstanding, so
-- this re-arms it through the one function that owns the schedule rather than
-- calling `cron.schedule` a third time in a third file.
DO $rearm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (
      SELECT 1 FROM public.builder_stock_items
       WHERE lifecycle_status = 'active' AND image_work_stage <> 'settled'
    ) THEN
      PERFORM public.ensure_builder_stock_settlement_scheduled();
    END IF;
  END IF;
END;
$rearm$;
