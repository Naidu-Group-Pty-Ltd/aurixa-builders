-- ═══════════════════════════════════════════════════════════════════════════
-- Builder Stock — keep the autonomous sweep alive for fallback enrichment.
--
-- THE DEFECT THIS FIXES, MEASURED IN PRODUCTION ON 28 AUGUST 2026.
--
-- `settle_builder_stock_marketplace_eligibility_tick()` is what pg_cron
-- actually runs, and it decided whether to invoke `builder-stock-image-settler`
-- from ONE question: is any UPLOAD behind on provenance, display eligibility or
-- overlay removal? It never read `builder_stock_items`.
--
-- So the moment settlement finished it did two things in the same breath: it
-- unscheduled the cron job, and it RETURNED WITHOUT INVOKING THE FUNCTION. Not
-- "invoked it and got nothing" — never called it at all.
--
-- PR #2318 had just given the settler a fallback-enrichment phase: the stage-B
-- (a web photograph verified against the exact property) and stage-C (Street
-- View bound to the address) ladder that a property gets when its builder
-- supplied no usable picture. That phase lives on the settler's
-- empty-settlement-queue branch — which is precisely the moment this function
-- stops calling it. The completion rule was written one layer too high: the
-- edge function reported `complete: fallback.remaining === 0` faithfully, and
-- nothing was left to listen.
--
-- The visible cost was three properties on the live Marketplace reading "No
-- image found" — Lot 13 Hummock Rise, Lot 1663 Ringer Street and Lot 3 Rose
-- Street Yamanto — each with a correct terminal stage-A answer
-- (`no_deterministic_image`: their builder's package names no document for that
-- exact lot), zero image rows of any kind, and `enrichment_status = 'pending'`.
-- They were not blank because the ladder judged them. They were blank because
-- nothing ever asked.
--
-- THE CHANGE IS THE SMALLEST ONE THAT ANSWERS THE RIGHT QUESTION. The gate now
-- counts both queues and invokes while EITHER has work; it may go quiet only
-- when BOTH are empty. Everything else is preserved verbatim: the target-version
-- reads, the eligibility and sanitization comparisons, the deleted-upload
-- filter, the signed invocation, SECURITY DEFINER, the search_path, the grants
-- and the cron job name.
--
-- SQL ANSWERS ONE QUESTION AND NOT TWO. "Is there still autonomous Builder
-- Stock work?" — nothing more. Which stage a property is owed, whether a web
-- result is truly that property, whether Street View has coverage and which
-- picture wins remain the edge function's, in `enrichStockItem` and
-- `imagePriority.pure.ts`. A second copy of the ladder in PL/pgSQL is how the
-- two would come to disagree about which house is on somebody's card.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_outstanding integer;
  v_fallback integer;
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

  /*
   * THE SECOND QUEUE. The same semantic queue the Builder Portal's
   * `enrich_images` loop and the settler's own fallback phase use — an active
   * property that has not been through image enrichment. `complete`, `partial`
   * and `failed` are terminal here exactly as they are terminal there, so a
   * property that genuinely has no picture available cannot hold the cron open
   * for ever.
   */
  SELECT count(*) INTO v_fallback
    FROM public.builder_stock_items
   WHERE lifecycle_status = 'active'
     AND enrichment_status IN ('pending', 'enriching');

  IF v_outstanding + v_fallback = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  /*
   * ONE invocation, whichever queue is behind. The settler decides for itself
   * which phase this tick is — settlement while any upload is outstanding, the
   * fallback ladder only once none is — so waking it twice would buy the same
   * tick twice.
   */
  PERFORM public.cron_invoke_signed_function(
    'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
END;
$$;

/*
 * Re-stated rather than relied upon. `CREATE OR REPLACE` preserves existing
 * grants, so this is a no-op on a database that already has them — but a
 * function that reaches `cron.unschedule` and a signed invoker must never be
 * one PUBLIC grant away from anybody, and the previous migration records what
 * it cost to assume otherwise. PUBLIC is named first because revoking from
 * `anon` alone is a no-op while PUBLIC holds it.
 */
REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'One tick of the Builder Stock image deployment repair. Invokes '
  'builder-stock-image-settler while any upload is behind on provenance, '
  'display eligibility or overlay removal, OR any active property is still '
  'awaiting fallback image enrichment, then unschedules its own cron job only '
  'when both queues are empty. Restricted to postgres/service_role.';
