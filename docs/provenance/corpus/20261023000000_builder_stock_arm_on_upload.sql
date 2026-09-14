BEGIN;

-- ============================================================================
-- Builder Stock — the engine must arm itself for a re-import that MATCHES
-- everything.
--
-- WHAT THIS FIXES, AND WHY IT ONLY APPEARS NOW. Image processing used to have
-- two drivers: the autonomous settler, and a `while` loop in the builder's
-- browser calling `enrich_images` until the server said there was nothing
-- left. The browser loop is gone (it could not finish, could not survive a
-- killed worker, and held an import dialog open for twenty minutes on a list
-- that had committed in nineteen seconds), so the settler is now the ONLY
-- driver. That makes one pre-existing gap in its arming fatal rather than
-- merely untidy.
--
-- THE GAP. `settle_builder_stock_marketplace_eligibility_tick` unschedules
-- itself the moment both queues are empty — correct, and what keeps an idle
-- deployment idle. The job is re-armed by an AFTER INSERT trigger on
-- `builder_stock_items`: "armed by the rows themselves, not by the code that
-- wrote them", so that every path which can create work re-arms the engine,
-- including paths nobody has written yet.
--
-- But a REPLACEMENT import of a list already held inserts no items at all. It
-- MATCHES every property and UPDATEs it — that is exactly what #2347's
-- identity rules and #2355's staged publication exist to do — and an UPDATE
-- fires no INSERT trigger. So: cron retires on an empty queue, the builder
-- re-imports the same source over the top, 23 rows are re-queued for imagery
-- by the importer, and nothing ever wakes the settler up. Before this change
-- the browser loop would have carried it. Now nothing would.
--
-- THE FIX IS THE SAME PRINCIPLE, ONE TABLE OUT. Every import — file, URL,
-- first-run or replacement — inserts exactly one `builder_stock_uploads` row,
-- and that row is itself what the tick counts as outstanding work while
-- `source_images_settled_version` is NULL. So the row that says "there is work
-- to do" is the row that arms the engine, and no import path has to remember
-- to.
--
-- Cheaper than widening the items trigger to UPDATE, too: this fires once per
-- import, and never on the settler's own per-item completions.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_uploads_rearm_settlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.ensure_builder_stock_settlement_scheduled();
  RETURN NULL;
END;
$$;

/*
 * A TRIGGER FUNCTION IS STILL A FUNCTION — the same rule this engine's other
 * trigger carries, for the same reason. `CREATE FUNCTION` grants EXECUTE to
 * PUBLIC by default and `anon` inherits it, so a SECURITY DEFINER body that
 * reaches `cron.schedule` would ship callable by the publishable key in the
 * browser bundle. The trigger fires as the table owner and needs no grant.
 * PUBLIC is named first because revoking from `anon` alone is a no-op while
 * PUBLIC holds it.
 */
REVOKE ALL ON FUNCTION public.builder_stock_uploads_rearm_settlement()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_uploads_rearm_settlement()
  TO postgres, service_role;

-- Statement level: one probe per import, not one per row.
DROP TRIGGER IF EXISTS builder_stock_uploads_rearm_settlement ON public.builder_stock_uploads;
CREATE TRIGGER builder_stock_uploads_rearm_settlement
  AFTER INSERT ON public.builder_stock_uploads
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.builder_stock_uploads_rearm_settlement();

-- ── Arm the live database if it is already carrying work ────────────────────
--
-- Only where there is something to do; an idle deployment stays idle, and
-- `ensure_builder_stock_settlement_scheduled` is a no-op when the job exists.
DO $rearm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (
      SELECT 1 FROM public.builder_stock_items
       WHERE lifecycle_status IN ('active', 'staged')
         AND (enrichment_status IN ('pending', 'enriching')
              OR image_work_stage <> 'settled')
    ) OR EXISTS (
      SELECT 1 FROM public.builder_stock_uploads
       WHERE deleted_at IS NULL AND source_images_settled_version IS NULL
    ) THEN
      PERFORM public.ensure_builder_stock_settlement_scheduled();
    END IF;
  END IF;
END;
$rearm$;

COMMIT;
