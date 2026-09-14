-- ===========================================================================
-- Builder Stock — send the affected properties back through the pipeline at
-- PROVENANCE_VERSION 10.
--
-- WHY THE VERSION ROSE. The cover rule's corroboration test accepted only
-- tokens of the row's DISPLAY label, and that label shows the suburb and
-- hides the estate whenever a lot is present — while a builder's own package
-- cover identifies a lot the way the estate's marketing does. Measured live,
-- 2 September 2026, on the Watsons Reach stock list: the supplied brochure
-- for lot 102 states "Lot 102 Watsons Reach Estate" beside its package price
-- and was refused as the property's cover for not saying "Diggers Rest" (the
-- suburb, which the document never mentions). The builder's own supplied
-- brochure — discovered, fetched and read — became a blank card. The row's
-- other identity names (`development_name`, `project_name`) now travel as
-- corroboration hints for that one test, so every `not_identified` banked at
-- 9 was judged under the narrower rule and is stale by definition.
--
-- `settleItemImages.ts` records the rule this obeys: a property at `settled`
-- is never claimed again, so a version bump ships with the migration that
-- sends the affected properties back to the stage that must re-run them. As
-- with `20261104000000` and `20261105000000`, this writes ONLY the queue
-- columns `reopenImageWork` writes: no image pointer, no provenance edit, no
-- cron call — the `builder_stock_items_rearm_settlement` trigger fires on
-- this UPDATE and re-arms the engine itself.
--
-- The set is the same shape as last time: rows holding any banked provenance
-- record (all now stale at 10), rows with a blank card, and rows whose card
-- came from the external ladder (so a builder's own cover, now recognisable,
-- can take the card back). Rows holding a builder-supplied image and no
-- banked record have nothing to gain and are left alone.
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
