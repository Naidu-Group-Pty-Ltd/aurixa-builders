-- ============================================================================
-- BUILDER STOCK — THE INVARIANT BECOMES UNIVERSAL, AND THE READER CATCHES UP
--
-- Three closures, each ending a temporary state the 2026-09-15 rollout was
-- explicit about:
--
--   1. PROVENANCE TARGET 26. With no PDF worker configured, the in-process
--      election refused every brochure over 6 MB, and after six refusals
--      retired the link as one that answers nothing. Forensics run
--      34939752502 (2026-09-15) proved five live blank properties' own
--      row-exclusive brochures are 7.2–10.2 MB and each elects its facade
--      from page 1 in seconds through the pipeline's own election once the
--      bytes are allowed in. The runtime now elects in-process to the 25 MB
--      ingest cap; raising the target is what re-opens the size-refusal
--      retirements banked at 25.
--
--   2. NO LEGACY PUBLICATION BRANCH. `builder_stock_publication_readiness`
--      carried a pre-invariant rule ("no staged item still reading its
--      source") scoped by `uploads.image_invariant = false`, promised as
--      temporary. It is gone: readiness is the strict 100% builder-source
--      photograph rule for EVERY upload. A settled-blank property can no
--      longer be published by any upload, whatever its vintage.
--
--   3. THE FLAG ITSELF IS RETIRED. Remaining `image_invariant = false` rows
--      (the one live legacy upload converging with its six properties, and
--      three deleted historical rows) flip to true, the column keeps a
--      comment saying it decides nothing any more, and nothing reads it.
--      No permanent grandfathered state remains anywhere.
--
-- Idempotent: every statement is re-runnable.
-- ============================================================================

-- 1. Re-open what the 6 MB line retired: the reader can now read it.
SELECT public.set_builder_stock_source_images_target(26);

-- 2. Readiness: one rule, every upload. Same signature, same shape the
--    publish RPC and the watchdog already read; only the legacy branch and
--    the strictness scoping are gone.
CREATE OR REPLACE FUNCTION public.builder_stock_publication_readiness(p_upload_id uuid)
RETURNS TABLE(staged bigint, source_outstanding bigint, missing_primary bigint, failed_items bigint, ready boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH scope AS (
    SELECT i.*
      FROM public.builder_stock_items AS i
     WHERE (i.upload_id = p_upload_id AND i.lifecycle_status = 'staged')
        -- A matched property waiting only on its held-back patch counts too.
        OR (i.pending_upload_id = p_upload_id)
  ),
  counts AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (
        WHERE s.lifecycle_status = 'staged' AND s.image_work_stage = 'source'
      ) AS source_outstanding,
      count(*) FILTER (
        WHERE s.image_work_stage NOT IN ('settled', 'failed')
      ) AS open_work,
      count(*) FILTER (WHERE s.image_work_stage = 'failed') AS failed_items,
      count(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM public.builder_stock_item_images im
           WHERE im.id = s.primary_image_id
             AND im.source_stage = 'uploaded_document'
             AND im.verification_status = 'source_supplied'
             AND im.processing_status = 'ready'
        )
      ) AS missing_primary
    FROM scope AS s
  )
  SELECT
    c.total AS staged,
    c.source_outstanding,
    c.missing_primary,
    c.failed_items,
    /*
     * THE INVARIANT, FOR EVERY UPLOAD: publication requires every scoped
     * property settled, none failed, every primary a ready builder-source
     * photograph, and no manifest asset still owed. 49 ready and 1 failed is
     * NOT publishable. There is no legacy branch to fall into.
     */
    c.total > 0
      AND c.open_work = 0
      AND c.failed_items = 0
      AND c.missing_primary = 0
      AND NOT EXISTS (
        SELECT 1 FROM public.builder_stock_source_assets a
         WHERE a.upload_id = p_upload_id AND a.state = 'pending')
      AND NOT EXISTS (
        SELECT 1 FROM public.builder_stock_uploads u
         WHERE u.id = p_upload_id AND u.source_manifest_state = 'failed')
    AS ready
  FROM counts AS c;
$$;

COMMENT ON FUNCTION public.builder_stock_publication_readiness(uuid) IS
  'ready ⟺ every scoped item is settled with a READY builder-source primary photograph, no item failed, no manifest asset pending, enumeration not failed. One rule for every upload — the pre-invariant legacy branch was removed 2026-09-16 and must not return.';

-- 3. Retire the scoping flag: flip every remaining false, then say plainly
--    that the column decides nothing.
UPDATE public.builder_stock_uploads
   SET image_invariant = true
 WHERE image_invariant = false;

COMMENT ON COLUMN public.builder_stock_uploads.image_invariant IS
  'RETIRED 2026-09-16. The source-photograph publication invariant is universal; no reader consults this column and no row may hold false. Kept only as a record of the 2026-09-15 rollout scoping.';

-- ============================================================================
-- Post-migration assertions — shapes, not hopes
-- ============================================================================

DO $$
DECLARE
  v_target integer;
  v_legacy bigint;
  v_src text;
BEGIN
  SELECT source_images_version INTO v_target
    FROM public.builder_stock_settlement_target WHERE id = true;
  IF coalesce(v_target, 0) < 26 THEN
    RAISE EXCEPTION 'provenance target did not reach 26 (found %)', v_target;
  END IF;

  SELECT count(*) INTO v_legacy
    FROM public.builder_stock_uploads WHERE image_invariant = false;
  IF v_legacy <> 0 THEN
    RAISE EXCEPTION '% upload(s) still carry image_invariant = false', v_legacy;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'builder_stock_publication_readiness';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'builder_stock_publication_readiness is missing';
  END IF;
  IF position('image_invariant' IN v_src) > 0 THEN
    RAISE EXCEPTION 'readiness still consults image_invariant — the legacy branch survived';
  END IF;

  -- The strict rule still refuses a nonexistent upload outright.
  IF EXISTS (
    SELECT 1 FROM public.builder_stock_publication_readiness(gen_random_uuid())
     WHERE ready
  ) THEN
    RAISE EXCEPTION 'readiness answered ready for an upload that does not exist';
  END IF;
END $$;
