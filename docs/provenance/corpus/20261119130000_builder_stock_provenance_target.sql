-- ===========================================================================
-- BUILDER STOCK — THE EXTRACTOR VERSION IS THE ONE MARKER THE SCHEDULER
-- COULD NOT SEE.
--
-- `builder_stock_settlement_target` holds a target per settlement concern and
-- the tick counts an upload as outstanding when its marker is behind. That is
-- how a rules change reaches uploads that were already settled under the old
-- rules — and the migration that introduced it said exactly why:
--
--     `coalesce(marker, -1) < target` is what replaces `marker IS NULL`. An
--     upload that has never been judged and one judged under an older
--     algorithm are the same kind of outstanding, and only the second of
--     those was previously countable.
--
-- That correction was applied to `marketplace_eligibility_settled_version`,
-- and later to `image_sanitization_settled_version`. It was never applied to
-- the third marker. The provenance half of the predicate has read
--
--     OR source_images_settled_version IS NULL
--
-- from that day to this, so an upload judged under an OLDER extractor is not
-- outstanding — only one never judged at all is. The function's own comment
-- has claimed "(or has provenance work outstanding)" the whole time.
--
-- WHAT THAT COST, MEASURED 11 SEPTEMBER 2026. `PROVENANCE_VERSION` went to 24
-- to re-ask the negatives banked at 23 — the documented mechanism, since
-- `negativeProvenanceStillStands` keeps a negative recorded at the current
-- version and `repairSourceImages` skips a row already banked at it. The
-- deploy succeeded. Four uploads sat at 23 with the code at 24. The tick
-- computed `v_outstanding = 0`, because all four had a non-null marker, and
-- unscheduled its own job. The settler was invoked once by hand, answered
-- `{"claimed":0}`, and the job removed itself again. Nothing re-derived.
--
-- So the bump was inert, and every bump before it was inert in the same way
-- unless something else happened to requeue the items — which is why v22
-- "deployed cleanly and changed nothing in production", the observation the
-- v23 entry in `sourceImages.ts` opens with. The capability shipped; the
-- scheduler never asked for it.
--
-- THE CHANGE IS THE THIRD MARKER GETTING WHAT THE FIRST TWO HAVE: a target
-- column, a monotonic setter that also puts the job back, and a `<`
-- comparison in the tick. Nothing else about the tick moves — the
-- publications, upload-completion and fallback counts, the reopen calls and
-- the fixed dispatch of 2 are reproduced verbatim from
-- `20261113110001_builder_stock_settler_fixed_concurrency.sql`.
-- ===========================================================================

BEGIN;

-- ── The target ─────────────────────────────────────────────────────────────
--
-- DEFAULT 0 rather than the current version: on a restored snapshot the column
-- arrives before the seed below, and a default of "current" would mark every
-- upload as settled at a version it was never judged under. Zero is behind
-- everything, which is the safe direction — the worst case is one re-read.
ALTER TABLE public.builder_stock_settlement_target
  ADD COLUMN IF NOT EXISTS source_images_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.builder_stock_settlement_target.source_images_version IS
  'The extractor version (PROVENANCE_VERSION) uploads must have been re-read '
  'under. An upload whose source_images_settled_version is below this has '
  'provenance work outstanding. Raised only by '
  'set_builder_stock_source_images_target, which also re-schedules the sweep.';

-- ── The setter ─────────────────────────────────────────────────────────────
--
-- MONOTONIC BY CONSTRUCTION, for the reason its two siblings are: migrations
-- apply in order on a fresh database and in an unpredictable order against a
-- restored snapshot, and a target that can go DOWN silently marks a re-read as
-- finished. A mistaken bump is corrected by bumping again.
--
-- AND SCHEDULING IS THE OTHER HALF, which is the whole point of this
-- migration. The sweep's job removes itself when the queue empties — it is a
-- repair, not a service — so raising the target has to put it back, or the new
-- target is a number nobody acts on. That is precisely what happened to every
-- provenance bump: the number moved in the code and no job existed to read it.
CREATE OR REPLACE FUNCTION public.set_builder_stock_source_images_target(p_version integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_version integer;
BEGIN
  INSERT INTO public.builder_stock_settlement_target (id, source_images_version)
  VALUES (true, p_version)
  ON CONFLICT (id) DO UPDATE
    SET source_images_version =
          GREATEST(public.builder_stock_settlement_target.source_images_version,
                   EXCLUDED.source_images_version),
        updated_at = now()
  RETURNING source_images_version INTO v_version;

  -- Through the function that OWNS the schedule rather than a second copy of
  -- the cron string: `ensure_builder_stock_settlement_scheduled` is already
  -- idempotent, already checks for pg_cron, and is what every other caller
  -- uses. Two places naming a schedule is how two schedules come to differ —
  -- the eligibility setter still says `*/5 * * * *` while the job this repair
  -- actually runs on is every minute.
  PERFORM public.ensure_builder_stock_settlement_scheduled();

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.set_builder_stock_source_images_target(integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_builder_stock_source_images_target(integer)
  TO postgres, service_role;

COMMENT ON FUNCTION public.set_builder_stock_source_images_target(integer) IS
  'Raises the extractor (provenance) settlement target and re-schedules the '
  'builder stock sweep, because the sweep unschedules itself when idle. '
  'Monotonic: the target never goes down.';

-- ── The tick, with the provenance half finally comparable ───────────────────
--
-- One clause changes. Everything else is the deployed function verbatim.
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_target integer;
  v_sanitization integer;
  v_provenance integer;
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

  -- FIXED, and deliberately not derived from any count above: a backlog is a
  -- reason to work steadily, never a licence to start more workers inside one
  -- memory ceiling.
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
  'unschedules its cron job when no work of any kind remains. All three '
  'settlement markers are compared against their targets, the extractor '
  'version included — see the migration header for what testing that one with '
  'IS NULL cost.';

-- An index answering the provenance half, matching the one the eligibility
-- half already has.
CREATE INDEX IF NOT EXISTS builder_stock_uploads_source_images_marker_idx
  ON public.builder_stock_uploads (source_images_settled_version)
  WHERE deleted_at IS NULL;

-- ── This deployment's target ────────────────────────────────────────────────
--
-- MUST EQUAL `PROVENANCE_VERSION`. A bump ships both halves in one deployment;
-- `builderStockProvenanceTarget.test.ts` reads this file and fails when they
-- disagree, exactly as the eligibility target's test does.
SELECT public.set_builder_stock_source_images_target(24);

COMMIT;
