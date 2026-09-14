-- Builder stock — settling every existing source's imagery under the current
-- rules, once, without anybody pressing a button.
--
-- Changing what counts as a property's PRIMARY image made every image row
-- written before that change out of date by definition: those rows prove where
-- their bytes came from and say nothing about what the source presented them
-- as. Until now the only thing that could bring them up to date was the Builder
-- Portal's "Source images" button, one stock list at a time. That is a
-- maintenance tool, and normal operation had come to depend on it.
--
-- This is the database half of making it automatic:
--
--   * `source_images_settled_version` records how far an upload's imagery has
--     been brought. It is the queue and the terminal marker at once, so a sweep
--     converges instead of re-reading every source for ever — which is exactly
--     what "does this upload have properties with no picture" would have done
--     to a spreadsheet that carries no imagery at all.
--   * a cron job drives `builder-stock-image-settler` until nothing is left,
--     then UNSCHEDULES ITSELF. This is a deployment repair, not a service: it
--     must not still be running next month burning reads on settled uploads.
--
-- Nothing here touches stock. No item is created or deleted; no price,
-- availability, configuration, status, selection, builder or project/unit
-- linkage is written. Those guarantees belong to `repairSourceImages.ts` and
-- are unchanged.

BEGIN;

-- ── The marker ──────────────────────────────────────────────────────────────

ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS source_images_settled_version integer;

COMMENT ON COLUMN public.builder_stock_uploads.source_images_settled_version IS
  'The image-provenance version this upload''s imagery was last re-derived '
  'under (see PROVENANCE_VERSION in _shared/builderStock/sourceImages.ts). '
  'NULL or below the current version means the source has not been read under '
  'the current primary-image rules and the settler will read it once. Written '
  'only by a COMPLETE settlement pass, so a run that hit its wall clock is '
  'never mistaken for a finished one.';

-- Deliberately left NULL for every existing row: they were all written before
-- roles existed, so they all have exactly one pass of work outstanding.

-- Partial index: the sweep only ever asks for the outstanding ones, and once
-- the deployment repair has finished this matches nothing.
CREATE INDEX IF NOT EXISTS builder_stock_uploads_unsettled_images_idx
  ON public.builder_stock_uploads (created_at)
  WHERE deleted_at IS NULL AND source_images_settled_version IS NULL;

-- ── Driving it ──────────────────────────────────────────────────────────────

/**
 * One tick of the deployment repair.
 *
 * Calls the settler with a signed internal envelope — the same helper every
 * other cron-driven function in this project uses — and unschedules the job
 * once no upload is outstanding. Unscheduling reads the TABLE rather than the
 * function's reply, because pg_net is fire-and-forget: the reply arrives in
 * `net._http_response` after this statement has returned, and waiting for it
 * would make the job block on the work it just asked for.
 */
CREATE OR REPLACE FUNCTION public.settle_builder_stock_source_images_tick()
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
     AND source_images_settled_version IS NULL;

  IF v_outstanding = 0 THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'settle-builder-stock-source-images') THEN
      PERFORM cron.unschedule('settle-builder-stock-source-images');
    END IF;
    RETURN;
  END IF;

  PERFORM public.cron_invoke_signed_function(
    'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
END;
$$;

REVOKE ALL ON FUNCTION public.settle_builder_stock_source_images_tick() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_source_images_tick() TO postgres, service_role;

COMMENT ON FUNCTION public.settle_builder_stock_source_images_tick() IS
  'One tick of the Builder Stock image settlement deployment repair. Invokes '
  'builder-stock-image-settler while any upload is unsettled, then unschedules '
  'its own cron job. Restricted to postgres/service_role.';

DO $schedule$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'settle-builder-stock-source-images'
    ) THEN
      -- Every five minutes: the settler reads whole documents, so a tighter
      -- cadence would overlap itself for no gain. It stops on its own.
      PERFORM cron.schedule(
        'settle-builder-stock-source-images',
        '*/5 * * * *',
        $job$SELECT public.settle_builder_stock_source_images_tick();$job$
      );
    END IF;
  END IF;
END;
$schedule$;

COMMIT;
