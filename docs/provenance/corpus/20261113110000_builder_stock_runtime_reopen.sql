-- BUILDER STOCK — REOPENING WHAT THE WORKER BROKE, AND NOTHING ELSE.
--
-- `RUNTIME_VERSION` (runtimeVersion.pure.ts) lets a branch be ASKED again once
-- the worker that failed it is superseded. On its own that is inert, and this
-- migration exists because it was: the queue only claims rows whose
-- `image_work_stage <> 'settled'`, and the six properties of upload
-- `bd7a0ef5` are settled. `reopen_builder_stock_stranded_items` is the only
-- thing that pulls a settled row back, and it reopens on exactly two grounds —
-- one of the row's images was re-judged after it concluded, or the ladder
-- GENERATION moved. A runtime bump moves neither.
--
-- MEASURED against production, 7 September 2026, for all six rows:
--
--   image_work_stage        settled
--   primary_image_id        null
--   reopens_on_generation   false   (updated 07-09; generation 30-08)
--   reopens_on_image        false
--
-- So the attempt counter reset and nothing ever asked. A worker fix that
-- cannot reach the rows it fixes is not a fix.
--
-- THE VERSION HAS TO LIVE IN THE DATABASE, because the predicate that reopens
-- rows is SQL. It mirrors `marketplace_eligibility_version` and
-- `image_sanitization_version`, which are here for the same reason;
-- `builderStockRuntimeVersionParity.test.ts` fails if this value and the
-- TypeScript constant ever drift.
ALTER TABLE public.builder_stock_settlement_target
  ADD COLUMN IF NOT EXISTS image_runtime_version integer NOT NULL DEFAULT 0;

-- Serial claiming, fixed concurrency of two, and the whole heavy PDF path
-- behind one decode slot. See `runtimeVersion.pure.ts`, which must hold 1.
UPDATE public.builder_stock_settlement_target SET image_runtime_version = 1;

COMMENT ON COLUMN public.builder_stock_settlement_target.image_runtime_version IS
  'How reliably the worker can OPEN a document — distinct from what the '
  'extractor understands. Raising it reopens properties whose branches failed '
  'because WE could not process them, and nothing else. Must equal '
  'RUNTIME_VERSION in runtimeVersion.pure.ts.';

-- ---------------------------------------------------------------------------

/*
 * Reopen the properties a superseded worker failed on.
 *
 * DELIBERATELY ITS OWN FUNCTION rather than a third arm of
 * `reopen_builder_stock_stranded_items`. That one answers "has the ladder
 * changed under this conclusion" and reopens to `eligibility`; this answers
 * "was this conclusion OUR failure rather than the document's" and must reopen
 * to `source`, because the package recovery it needs to re-run lives on the
 * first rung. Two questions, two predicates, each revertible on its own.
 *
 * WHAT COUNTS AS OUR FAILURE, and the asymmetry is the whole point:
 *
 *   a bare attempt record         a step that started and never returned —
 *                                 the shape a kill leaves. The six are here.
 *   an operational retirement     but ONLY one carrying `runtime_version`,
 *     STAMPED with a runtime      which `recordPackageUnprocessable` writes
 *                                 and `recordPackageUnreachable` does not.
 *
 * A dead link is therefore untouched however good the worker gets — a faster
 * worker cannot open a 404, and re-chasing them on every runtime change is a
 * treadmill. A document that ANSWERED is untouched for the stronger reason
 * that what it told us is still true. Neither carries the stamp, and that
 * absence is what excludes them here.
 */
CREATE OR REPLACE FUNCTION public.reopen_builder_stock_runtime_failures()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reopened integer := 0;
  v_runtime integer;
BEGIN
  SELECT image_runtime_version INTO v_runtime
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  IF v_runtime IS NULL THEN
    RETURN 0;
  END IF;

  WITH reopened AS (
    UPDATE public.builder_stock_items AS i
       SET image_work_stage = 'source',
           image_work_next_attempt_at = now(),
           image_work_claim_until = NULL,
           image_work_attempts = 0,
           -- Asked again, so the terminal enrichment verdict must not keep it
           -- out of the fallback queue. Same reasoning as the sibling reopen.
           enrichment_status = 'pending',
           image_work_updated_at = now(),
           updated_at = now()
     WHERE i.lifecycle_status IN ('active', 'staged')
       AND i.image_work_stage = 'settled'
       AND i.primary_image_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_each(
             coalesce(i.source_provenance_result -> 'branches', '{}'::jsonb)) AS b(k, v)
          WHERE (
            -- A step that began and never came back.
            v ->> 'result' = 'package_recovery_attempt'
            AND coalesce((v ->> 'runtime_version')::integer, 0) < v_runtime
          )
          OR (
            -- A retirement we caused, stamped with the runtime that caused it.
            v ->> 'result' = 'no_deterministic_image'
            AND v ? 'runtime_version'
            AND coalesce((v ->> 'runtime_version')::integer, 0) < v_runtime
          )
       )
    RETURNING i.id
  )
  SELECT count(*) INTO v_reopened FROM reopened;

  RETURN coalesce(v_reopened, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_builder_stock_runtime_failures()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_builder_stock_runtime_failures()
  TO postgres, service_role;

COMMENT ON FUNCTION public.reopen_builder_stock_runtime_failures() IS
  'Returns settled, pictureless properties to the source rung when the worker '
  'that failed their documents has been superseded. Reopens ONLY branches '
  'carrying evidence of our own failure — never a dead link, never a document '
  'that answered.';
