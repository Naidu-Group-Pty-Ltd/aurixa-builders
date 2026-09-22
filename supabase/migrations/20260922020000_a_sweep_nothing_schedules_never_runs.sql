-- ===========================================================================
-- A RECOVERY MECHANISM NOTHING SCHEDULES IS NOT A RECOVERY MECHANISM.
-- ===========================================================================
--
-- MEASURED 22 SEPTEMBER 2026 on the production project. `Lot 37 - Miami 190 -
-- Property Package.pdf` sat at `reader_settled_version: 6` while the deployed
-- reader was at 8, through two deploys, and was never re-read. `cron.job` held
-- four jobs and `settle-builder-stock-marketplace-eligibility` was not among
-- them: the settlement tick had unscheduled itself, correctly, at a moment when
-- every queue it counts was empty.
--
-- THE TICK COUNTS SEVEN KINDS OF WORK AND THE READER SWEEP IS NONE OF THEM.
-- `v_outstanding + v_fallback + v_item_work + v_publications +
-- v_upload_completion + v_stranded + v_blocked` — a source that has fallen
-- behind the current reader appears in no term, so the tick retires while that
-- work exists and nothing brings it back. The reader sweep runs only on the
-- settler's quiet exit, and the settler runs only when something dispatches it.
--
-- AND RAISING THE READER VERSION CANNOT ASK AGAIN IF THE ASKER HAS RETIRED.
-- That is the part worth writing down, because the version bump is the
-- documented mechanism for reaching rows that already exist —
-- `readerVersion.pure.ts` says so in those words, and it was relied on three
-- times in one day while nothing was listening. A version is a statement about
-- what SHOULD be re-read; it is not a scheduler.
--
-- WHY A STANDING HEARTBEAT RATHER THAN AN EIGHTH TERM IN THE SUM. The count the
-- tick would need is "sources behind the CURRENT reader", and the current
-- reader is a TypeScript constant. Teaching SQL that number means keeping it in
-- two places, which is the drift this repository has paid for repeatedly — the
-- clone's `42P01` against PostgREST's `PGRST205`, the AML `.or()` the double
-- agreed with. So SQL is told nothing about versions: it wakes the settler on a
-- slow clock and the settler, which holds the constant, decides. An idle wake
-- reaches the quiet exit, finds nothing outstanding and returns.
--
-- FIFTEEN MINUTES, AND IT NEVER UNSCHEDULES ITSELF. The minute tick's
-- self-retirement is right for import throughput, where work is created by a
-- request that can re-arm it. Re-read work is created by a DEPLOY, which has
-- nothing to re-arm with — so this one is permanent by design. A latency of up
-- to a quarter of an hour on a repair that had no latency at all because it
-- never happened is the trade being made.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_reader_sweep_heartbeat()
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  /*
   * One settler, unconditionally. It claims nothing, finds the item queue
   * drained, reaches the quiet exit and runs `settleReaderVersion`, which
   * takes at most one source per tick and starts none without its own
   * reserve. A deployment with nothing outstanding pays one cheap invocation.
   *
   * Best-effort, exactly as `builder_stock_dispatch_image_workers` is: a
   * missing vault entry or a pg_net hiccup must never fail a cron tick.
   */
  BEGIN
    PERFORM public.cron_invoke_signed_function(
      'builder-stock-image-settler', '{}'::jsonb, 'reader_sweep_heartbeat');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_reader_sweep_heartbeat() IS
  'Wakes one settler on a slow clock so the reader-version sweep has a scheduler of its own. The settlement tick retires when its own queues are empty and does not count sources behind the current reader, so raising DETERMINISTIC_READER_VERSION could create work nothing would ever perform.';

REVOKE ALL ON FUNCTION public.builder_stock_reader_sweep_heartbeat()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_reader_sweep_heartbeat() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'builder-stock-reader-sweep-15min'
    ) THEN
      PERFORM cron.schedule(
        'builder-stock-reader-sweep-15min',
        '*/15 * * * *',
        $job$SELECT public.builder_stock_reader_sweep_heartbeat();$job$);
    END IF;
  END IF;
END $$;
