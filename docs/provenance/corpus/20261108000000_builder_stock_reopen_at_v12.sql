-- ===========================================================================
-- Builder Stock — send the affected properties back through the pipeline at
-- PROVENANCE_VERSION 12.
--
-- WHY THE VERSION ROSE. The compressed-object recovery kept the FIRST copy
-- of each object number, and an incrementally updated PDF appends each
-- revision after the one it replaces — so the reader served the STALE
-- generation of any updated dictionary. Measured live, 2 September 2026, on
-- the Watsons Reach lot 102 brochure (five generations, twenty-one object
-- streams): the stale page dictionary mapped its pictures to the template's
-- sample artwork — another design's floor plan, labelled LOT 414 — while the
-- newest generation, never read, mapped the builder's real 1920x1080 facade
-- render. Recovery is last-generation-wins now (`recoverCompressedObjects`),
-- agreeing with the raw byte scan, and the same document now yields that
-- render as its single qualifying cover hero. Every negative banked at 11
-- against such a document was judged on the wrong generation's pictures and
-- is stale by definition.
--
-- Same mechanics as the previous reopen migrations: only the queue columns
-- `reopenImageWork` writes — no image pointer, no provenance edit, no cron
-- call — and the `builder_stock_items_rearm_settlement` trigger re-arms the
-- engine off this UPDATE. Rows holding a builder-supplied image and no
-- banked record are left alone.
-- ===========================================================================

UPDATE public.builder_stock_items AS i
SET
  enrichment_status          = 'pending',
  image_work_stage           = 'source',
  image_work_claim_until     = NULL,
  image_work_attempts        = 0,
  image_work_next_attempt_at = now(),
  image_work_updated_at      = now()
WHERE i.lifecycle_status = 'active'
  AND (
    i.source_provenance_result IS NOT NULL
    OR i.primary_image_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.builder_stock_item_images m
      WHERE m.id = i.primary_image_id
        AND m.source_stage IN ('internet_search', 'google_maps')
    )
  );
