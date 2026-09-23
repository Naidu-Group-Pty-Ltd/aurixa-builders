-- ============================================================================
-- A RE-READ CROSSES ISOLATES THE WAY AN IMPORT DOES
-- ============================================================================
--
-- MEASURED 22 and 23 September 2026, production: the image settler was killed
-- twelve times between 10:09:06 and 10:35:07 on the 22nd and three more times
-- on the 23rd (05:40:08, 05:43:07, 05:45:08), every time inside the reader
-- sweep's re-read of `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`. The
-- sweep re-read inline — the document parsed and its pictures decoded in one
-- isolate, which is the shape `20260923100000` took out of the import — and a
-- kill writes nothing, so the row stayed outstanding with no bound on its
-- attempts and stood at the head of the queue on every quiet tick.
--
-- So the reader version was fenced at 13, and the only live source on this
-- project today is the document that needs 14: `LOT 4327 Jubilee Estate -
-- ENZO 10.5 MODERN - BROCHURE V002 - Copy.pdf`, 7,762,286 bytes of the same
-- class, which imported its price and land size and none of the address, the
-- configuration, the build size or the design its page prints.
--
-- The sweep now reads the way the import reads. The isolate that parses a
-- document hands its pictures to a later one, and the sweep carries its own
-- place in that chain between ticks — which is the one thing it needs from
-- the schema. See `readerSweepAttempt.pure.ts`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WHERE A RE-READ STANDS
-- ----------------------------------------------------------------------------
/*
 * One small record per upload, written by the sweep and read by nothing else:
 * the reader version the re-read is at, how many ticks began it, how many of
 * those neither finished nor handed on, the hand-offs its chain has made, and
 * the `processing_started_at` of the import attempt whose checkpoint it took.
 *
 * WRITTEN BEFORE THE WORK, WHICH IS THE POINT. The tick the runtime kills is
 * the one that can write nothing afterwards, so a tick that counted itself on
 * the way out would count every tick except the ones that matter.
 *
 * NULL is the ordinary state — no re-read has ever been under way — and a
 * record at another reader version is read as NULL, so raising the version
 * begins every source afresh without anything here being cleared.
 */
ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS reader_sweep_attempt jsonb;

COMMENT ON COLUMN public.builder_stock_uploads.reader_sweep_attempt IS
  'The reader sweep''s record of a re-read at one reader version: ticks begun, ticks that neither finished nor handed on, hand-offs made, and which import attempt''s checkpoint it holds. Written before each tick works, so a killed tick is still counted. See readerSweepAttempt.pure.ts.';

-- ----------------------------------------------------------------------------
-- AND THE NEXT TICK STARTS NOW
-- ----------------------------------------------------------------------------
/*
 * THE SAME DISPATCHER, THE SAME CONTRACT. `builder_stock_dispatch_import_
 * continuation` starts an import's successor through the signed internal
 * dispatcher the moment its predecessor hands on; this starts the settler
 * whose quiet exit resumes a handed-on re-read, for the same reason — a
 * crossing that waits for a clock is a crossing that costs the clock.
 *
 * AN ACCELERATOR, NEVER THE GUARANTEE. The settler's reader sweep also runs
 * on `builder-stock-reader-sweep-15min` (`20260922020000`), which never
 * unschedules itself, so a dispatch that is lost — no vault entry, a pg_net
 * hiccup, a settler that fails to boot — costs latency and never the re-read.
 *
 * NOTHING HERE DECIDES WHAT IS OWED. SQL is told nothing about reader
 * versions, for the reason `20260922020000` records: the version is a
 * TypeScript constant, and a second copy of it here is the drift this
 * repository has paid for repeatedly. The settler that answers decides.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_dispatch_reader_sweep()
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  BEGIN
    PERFORM public.cron_invoke_signed_function(
      'builder-stock-image-settler', '{}'::jsonb, 'reader_sweep_continuation');
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_dispatch_reader_sweep() IS
  'Start one settler NOW so a reader-sweep re-read that handed its pictures on is resumed in seconds. Best-effort: the fifteen-minute reader-sweep heartbeat reaches the same upload.';

REVOKE ALL ON FUNCTION public.builder_stock_dispatch_reader_sweep()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_dispatch_reader_sweep() TO service_role;
