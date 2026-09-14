-- Builder Stock — an import must finish its own imagery, with nobody watching.
--
-- PRODUCTION, 28 AUGUST 2026. Upload 4dfe1be7 imported 23 properties at
-- 10:05:33 and sat completely untouched. Every card on the live Marketplace
-- read "No image found", including properties whose builder photographs were
-- sitting in their own linked Drive folder, and the only thing that started the
-- work was a person running cron.schedule by hand. That had already happened
-- once that morning (jobid 121 -> 122 -> 123).
--
-- TWO FAULTS, BOTH IN THE WAKE PATH.
--
-- 1. NOTHING RE-ARMS THE JOB. `cron.schedule` for this job exists in exactly
--    two places, both of them migrations that ran once. `cron.unschedule` lives
--    in the tick itself and fires the moment both queues reach zero — which is
--    correct and deliberate. So the job is a ONE-SHOT: the first upload to
--    finish retires it permanently, and every import after that has no engine
--    at all. The import path settles inline inside the request and then
--    returns; it never touches the schedule. A builder who pastes a link and
--    closes the browser gets nothing.
--
-- 2. THE CADENCE IS SIZED FOR A CRISIS, NOT FOR WORK. Every five minutes, one
--    package per run, so a 23-property upload takes hours. Measured over 101
--    production ticks in the 23 hours to 11:00 on 28 August: median under 7
--    seconds, MAXIMUM 16.9 seconds. The engine is idle for 96% of every
--    interval.
--
-- WHAT THIS DOES NOT DO. It does not raise MAX_PACKAGE_RECOVERIES_PER_RUN, and
-- it does not give a run more CPU, more memory or more wall clock. One tick
-- still does exactly the same small unit of work it did before; it is simply
-- offered more often, and only while there is work.

BEGIN;

-- ── The lease ───────────────────────────────────────────────────────────────
--
-- A MINUTE IS SHORTER THAN THE SETTLER'S OWN BUDGET, SO OVERLAP HAS TO BE
-- IMPOSSIBLE RATHER THAN UNLIKELY.
--
-- `BUDGET_MS` in the settler is 100 seconds. Production has never come close —
-- 16.9s is the worst completed tick on record — but "has not yet" is not a
-- guarantee, and two settlers running at once would read the same queue and
-- start the same package twice. pg_cron's own job is not the thing at risk: it
-- queues a signed HTTP call and returns in milliseconds. The work happens in
-- the edge function, over PostgREST, on no persistent session — so an advisory
-- lock cannot span it and the lease has to be a row.
--
-- Compare-and-set, exactly like the sanitizer's repair claim: a run takes the
-- lease or does nothing at all. The lease EXPIRES rather than being released,
-- so a worker killed on a resource limit — which runs no `finally` and returns
-- nothing, as this repository has already paid to learn — cannot wedge the
-- queue shut. It costs at most one skipped minute.
CREATE TABLE IF NOT EXISTS public.builder_stock_settlement_lease (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  leased_until timestamptz NOT NULL DEFAULT now() - interval '1 second',
  leased_at timestamptz,
  holder text
);

INSERT INTO public.builder_stock_settlement_lease (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.builder_stock_settlement_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.builder_stock_settlement_lease FROM PUBLIC, anon, authenticated;

/*
 * Take the lease, or answer false.
 *
 * `p_seconds` is the caller's own worst case, not a guess made here: the settler
 * knows its budget and passes it, so the lease can never expire under a run that
 * is still going.
 */
CREATE OR REPLACE FUNCTION public.claim_builder_stock_settlement_lease(
  p_seconds integer DEFAULT 120,
  p_holder text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.builder_stock_settlement_lease
     SET leased_until = now() + make_interval(secs => greatest(p_seconds, 1)),
         leased_at = now(),
         holder = left(coalesce(p_holder, 'settler'), 64)
   WHERE id = true
     AND leased_until <= now()
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.claim_builder_stock_settlement_lease(integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_builder_stock_settlement_lease(integer, text)
  TO postgres, service_role;

/*
 * Hand the lease back the moment a run finishes.
 *
 * Not required for correctness — the lease expires on its own — but a tick that
 * took 7 seconds should not hold the next minute's turn for two minutes.
 */
CREATE OR REPLACE FUNCTION public.release_builder_stock_settlement_lease()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.builder_stock_settlement_lease
     SET leased_until = now() - interval '1 second'
   WHERE id = true;
$$;

REVOKE ALL ON FUNCTION public.release_builder_stock_settlement_lease()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_builder_stock_settlement_lease()
  TO postgres, service_role;

-- ── The re-arm ──────────────────────────────────────────────────────────────
--
-- IDEMPOTENT BY CONSTRUCTION. It schedules only when the job is absent, so
-- calling it on every insert of every import costs one index probe and can
-- never produce a second job. `cron.schedule` on an existing name would replace
-- the job rather than duplicate it, but relying on that would make the
-- behaviour depend on pg_cron's version rather than on this file.
CREATE OR REPLACE FUNCTION public.ensure_builder_stock_settlement_scheduled()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
  ) THEN
    RETURN false;
  END IF;

  /*
   * EVERY MINUTE, AND ONLY WHILE THERE IS WORK.
   *
   * The tick's own gate is what makes this safe to run often: it counts both
   * queues and unschedules itself the moment they are empty, so a minute is the
   * cadence of an ACTIVE import and not a standing load. An idle deployment has
   * no job at all.
   */
  PERFORM cron.schedule(
    'settle-builder-stock-marketplace-eligibility',
    '* * * * *',
    $job$SELECT public.settle_builder_stock_marketplace_eligibility_tick();$job$
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_builder_stock_settlement_scheduled()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_builder_stock_settlement_scheduled()
  TO postgres, service_role;

/*
 * ARMED BY THE ROWS THEMSELVES, NOT BY THE CODE THAT WROTE THEM.
 *
 * The import path could call the function above, and then the next import path
 * would have to remember to as well — a bulk upload, a re-import, a repair, a
 * future format. Attaching it to the INSERT means every way a property can
 * arrive re-arms the engine, including ways nobody has written yet. Statement
 * level, so a 23-row import probes once.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_items_rearm_settlement()
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
 * A TRIGGER FUNCTION IS STILL A FUNCTION.
 *
 * `CREATE FUNCTION` grants EXECUTE to PUBLIC by default and `anon` inherits it,
 * so a SECURITY DEFINER trigger body ships reachable by the publishable key in
 * the browser bundle — and this one reaches `cron.schedule`. The trigger itself
 * fires as the table owner and needs no grant at all; revoking costs nothing
 * and closes a path a page could otherwise call directly. Revoking from `anon`
 * alone is a no-op while PUBLIC holds it, which is why PUBLIC is named first.
 */
REVOKE ALL ON FUNCTION public.builder_stock_items_rearm_settlement()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_items_rearm_settlement()
  TO postgres, service_role;

DROP TRIGGER IF EXISTS builder_stock_items_rearm_settlement ON public.builder_stock_items;
CREATE TRIGGER builder_stock_items_rearm_settlement
  AFTER INSERT ON public.builder_stock_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.builder_stock_items_rearm_settlement();

-- ── Bring the live job onto the new cadence ─────────────────────────────────
--
-- The job as it stands is the five-minute one this migration supersedes. It is
-- unscheduled and re-armed rather than edited, so the schedule comes from one
-- place — `ensure_builder_stock_settlement_scheduled` — and a database that had
-- no job (the state production was actually in) ends up identical to one that
-- did.
DO $rearm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
         AND schedule IS DISTINCT FROM '* * * * *'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;

    -- Only where there is something to do. An idle deployment stays idle.
    IF EXISTS (
      SELECT 1 FROM public.builder_stock_items
       WHERE lifecycle_status = 'active'
         AND enrichment_status IN ('pending', 'enriching')
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
