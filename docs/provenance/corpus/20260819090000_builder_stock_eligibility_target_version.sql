-- Builder stock — making a FUTURE classifier improvement reach production on
-- its own.
--
-- WHAT WAS BROKEN. Display eligibility is versioned, and the intent was that
-- bumping `MARKETPLACE_ELIGIBILITY_VERSION` brings every already-judged image
-- back for a second look under the better rules. It could not. The sweep's cron
-- job decides whether there is work left by counting uploads in SQL, and SQL
-- cannot see a TypeScript constant — so the previous migration counted
-- `marketplace_eligibility_settled_version IS NULL`, which is only ever true
-- once. The sequence was:
--
--   version 1 ships   → every upload reaches marker 1 → the job unschedules
--                       ITSELF, correctly, because the first audit is done
--   version 2 ships   → nothing anywhere is looking. No job is scheduled, no
--                       upload is NULL, and the improved classifier is applied
--                       to new imports only. Every image already in the bucket
--                       keeps the verdict the old rules gave it, for ever.
--
-- WHAT FIXES IT. A target the DATABASE holds, so "is there work outstanding"
-- becomes `settled_version < target` rather than `settled_version IS NULL`, and
-- raising the target is what re-schedules the job. A classifier change is then
-- one deployment carrying both halves: the constant in
-- `_shared/builderStock/marketplaceEligibility.pure.ts`, and a migration
-- calling `set_builder_stock_eligibility_target(N)` beside it. A test asserts
-- the two agree, because a bump that ships only one half is exactly the failure
-- above wearing a different hat.
--
-- The target is deliberately NOT the provenance version and never moves with
-- it. The two algorithms change for their own reasons; that separation is the
-- whole point of there being two markers.
--
-- Nothing here reads, writes or rewrites an image.

BEGIN;

-- ── The target ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.builder_stock_settlement_target (
  -- One row, enforced by the type rather than by convention: a second row
  -- would give the sweep two answers and no way to choose.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  marketplace_eligibility_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.builder_stock_settlement_target IS
  'The Builder Stock display-eligibility version production is being brought '
  'to. Exactly one row. Raised by set_builder_stock_eligibility_target() in the '
  'same deployment as a MARKETPLACE_ELIGIBILITY_VERSION bump; an upload whose '
  'marketplace_eligibility_settled_version is below it has a re-audit '
  'outstanding.';

ALTER TABLE public.builder_stock_settlement_target ENABLE ROW LEVEL SECURITY;

-- No policy is declared, so PostgREST exposes nothing to anon or authenticated.
-- The settler holds a service-role client, which bypasses RLS; that is the only
-- reader. The target is a deployment fact, not tenant data.
REVOKE ALL ON TABLE public.builder_stock_settlement_target FROM anon, authenticated;
GRANT SELECT ON TABLE public.builder_stock_settlement_target TO service_role;

INSERT INTO public.builder_stock_settlement_target (id, marketplace_eligibility_version)
VALUES (true, 0)
ON CONFLICT (id) DO NOTHING;

-- ── Raising it ──────────────────────────────────────────────────────────────

/**
 * Raise the display-eligibility target and make sure something is driving it.
 *
 * MONOTONIC BY CONSTRUCTION. `GREATEST` rather than an assignment: migrations
 * are applied in order on a fresh database and in an unpredictable order
 * against one restored from a snapshot, and a target that can go DOWN would
 * silently mark a re-audit as finished. Lowering it is not a thing this
 * supports; a mistaken bump is corrected by bumping again.
 *
 * SCHEDULING IS THE OTHER HALF. The sweep's job removes itself when the queue
 * empties — it is a repair, not a service — so raising the target has to put it
 * back, or the new target is a number nobody acts on.
 */
CREATE OR REPLACE FUNCTION public.set_builder_stock_eligibility_target(p_version integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_version integer;
BEGIN
  INSERT INTO public.builder_stock_settlement_target (id, marketplace_eligibility_version)
  VALUES (true, p_version)
  ON CONFLICT (id) DO UPDATE
    SET marketplace_eligibility_version =
          GREATEST(public.builder_stock_settlement_target.marketplace_eligibility_version,
                   EXCLUDED.marketplace_eligibility_version),
        updated_at = now()
  RETURNING marketplace_eligibility_version INTO v_version;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.schedule(
        'settle-builder-stock-marketplace-eligibility',
        '*/5 * * * *',
        $job$SELECT public.settle_builder_stock_marketplace_eligibility_tick();$job$
      );
    END IF;
  END IF;

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.set_builder_stock_eligibility_target(integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_builder_stock_eligibility_target(integer)
  TO postgres, service_role;

COMMENT ON FUNCTION public.set_builder_stock_eligibility_target(integer) IS
  'Raise the Builder Stock display-eligibility target (never lowers it) and '
  'reschedule the settlement sweep if it had unscheduled itself. Call this from '
  'the same migration that ships a MARKETPLACE_ELIGIBILITY_VERSION bump.';

-- ── The tick reads the target ───────────────────────────────────────────────

/**
 * One tick of the display-eligibility deployment repair, now keyed on the
 * target rather than on NULL.
 *
 * Same shape as before: it calls the settler through the signed internal
 * envelope and decides whether to stop by reading the TABLE rather than the
 * function's reply, because pg_net is fire-and-forget and waiting on the reply
 * would make the job block on the work it just asked for.
 *
 * `coalesce(marker, -1) < target` is what replaces `marker IS NULL`. An upload
 * that has never been judged and one judged under an older algorithm are the
 * same kind of outstanding, and only the second of those was previously
 * countable.
 */
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_outstanding integer;
  v_target integer;
BEGIN
  SELECT marketplace_eligibility_version INTO v_target
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
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

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'One tick of the Builder Stock marketplace display-eligibility deployment '
  'repair. Invokes builder-stock-image-settler while any upload sits below the '
  'target in builder_stock_settlement_target (or has provenance work '
  'outstanding), then unschedules its own cron job. Restricted to '
  'postgres/service_role.';

-- An index that answers the tick's predicate for the "behind the target" half.
-- The IS NULL partial index from the previous migration still serves the rows
-- that have never been judged.
CREATE INDEX IF NOT EXISTS builder_stock_uploads_eligibility_marker_idx
  ON public.builder_stock_uploads (marketplace_eligibility_settled_version)
  WHERE deleted_at IS NULL;

-- ── This deployment's target ────────────────────────────────────────────────
--
-- MUST EQUAL `MARKETPLACE_ELIGIBILITY_VERSION`. A bump ships both halves in one
-- deployment; `builderStockMarketplaceEligibility.test.ts` reads this file and
-- fails when they disagree.
SELECT public.set_builder_stock_eligibility_target(1);

COMMIT;
