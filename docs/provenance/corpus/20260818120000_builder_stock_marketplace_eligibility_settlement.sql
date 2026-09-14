-- Builder stock — judging every existing card image for DISPLAY, once, without
-- anybody pressing a button.
--
-- A fourth question was added to the image pipeline. Three were already asked
-- and stored: did these bytes come from the builder's source, are they this
-- property's, and did the source designate them as its primary image. All
-- three can answer yes while the picture is still a marketing tile — a facade
-- under a status ribbon, a rebate banner, a suburb label — and that is the
-- question `marketplace_display_eligible` now answers.
--
-- Every image row written before that existed has no verdict, and no verdict
-- is NOT a pass: the display rule fails closed, so those cards show nothing
-- until each image has actually been assessed. This migration is what makes
-- the assessment happen on its own.
--
--   * `marketplace_eligibility_settled_version` is a SECOND marker, separate
--     from `source_images_settled_version` on purpose. Provenance and display
--     eligibility are different algorithms that change at different times:
--     improving the marketing-tile classifier must not re-fetch every Notion
--     page and every Drive package, and re-reading a source must not re-run a
--     classifier that has not changed. Bumping either version schedules its own
--     re-audit and leaves the other alone.
--   * a cron job drives `builder-stock-image-settler` until nothing is left,
--     then UNSCHEDULES ITSELF. This is a deployment repair, not a service.
--
-- Nothing here touches stock, and nothing rewrites an image. The settler
-- re-READS each stored object to measure it and writes only the verdict into
-- `source_detail`. No item is created or deleted; no price, availability,
-- configuration, status, selection, builder or project/unit linkage is
-- written.

BEGIN;

-- ── The marker ──────────────────────────────────────────────────────────────

ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS marketplace_eligibility_settled_version integer;

COMMENT ON COLUMN public.builder_stock_uploads.marketplace_eligibility_settled_version IS
  'The marketplace display-eligibility version this upload''s primary images '
  'were last assessed under (see MARKETPLACE_ELIGIBILITY_VERSION in '
  '_shared/builderStock/marketplaceEligibility.pure.ts). NULL or below the '
  'current version means its images have not been judged under the current '
  'rules and the settler will judge them once. Deliberately independent of '
  'source_images_settled_version: the two versions move for different reasons. '
  'Written only by a COMPLETE pass, so a run that hit its wall clock is never '
  'mistaken for a finished one.';

-- Left NULL for every existing row: they were all written before display
-- eligibility existed, so they all have exactly one pass of work outstanding.

CREATE INDEX IF NOT EXISTS builder_stock_uploads_unjudged_images_idx
  ON public.builder_stock_uploads (created_at)
  WHERE deleted_at IS NULL AND marketplace_eligibility_settled_version IS NULL;

-- ── Driving it ──────────────────────────────────────────────────────────────

/**
 * One tick of the display-eligibility deployment repair.
 *
 * The same shape as the provenance sweep beside it, and for the same reasons:
 * it calls the settler through the signed internal envelope, and it decides
 * whether to stop by reading the TABLE rather than the function's reply,
 * because pg_net is fire-and-forget and waiting for the reply would make the
 * job block on the work it just asked for.
 *
 * It counts BOTH markers. The settler picks up an upload that is behind on
 * either one, so a tick that stopped early on provenance work still has
 * something to do next time, and the job only unschedules when the whole
 * queue — both kinds — is empty.
 */
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_outstanding integer;
BEGIN
  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (marketplace_eligibility_settled_version IS NULL
          OR source_images_settled_version IS NULL);

  IF v_outstanding = 0 THEN
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
$$;

REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'One tick of the Builder Stock marketplace display-eligibility deployment '
  'repair. Invokes builder-stock-image-settler while any upload is unjudged or '
  'unsettled, then unschedules its own cron job. Restricted to '
  'postgres/service_role.';

DO $schedule$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Scheduled unconditionally rather than only when absent: the provenance
    -- sweep beside this one has very likely already unscheduled ITSELF, and
    -- this queue is new work that nothing is currently driving.
    IF NOT EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      -- Every five minutes. The settler reads stored objects and decodes them,
      -- so a tighter cadence would overlap itself for no gain. It stops on its
      -- own once the queue is empty.
      PERFORM cron.schedule(
        'settle-builder-stock-marketplace-eligibility',
        '*/5 * * * *',
        $job$SELECT public.settle_builder_stock_marketplace_eligibility_tick();$job$
      );
    END IF;
  END IF;
END;
$schedule$;

COMMIT;
