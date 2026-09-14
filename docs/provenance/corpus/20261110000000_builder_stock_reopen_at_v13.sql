-- ===========================================================================
-- Builder Stock — send the affected properties back through the pipeline at
-- PROVENANCE_VERSION 13.
--
-- WHY THE VERSION ROSE. `selectCoverHero` refused every cover page presenting
-- more than one unrepeated photograph, on the reasoning that a page
-- presenting a choice has not said which picture is the property's. That is
-- right where OWNERSHIP is the question, and wrong where the page has already
-- answered by how it drew them.
--
-- Measured live, 3 September 2026, on a builder's own single-property
-- brochure uploaded as a stock list (LOT 1731 VERV UND VANTA 23, Austin
-- Estate, Lara): both photographs on page 1 were found, attributed and
-- stored — the facade render covering 47.5% of the page and the only other
-- 14.2% — and the card read "No image found" because neither was given a
-- role. A photograph the cover draws at least twice the page of any other is
-- now taken as the hero; comparable sizes still answer no image. Every
-- negative banked at 12 against such a document was judged before the page's
-- own emphasis was read, and is stale by definition.
--
-- Same mechanics as the previous reopen migrations: only the queue columns
-- `reopenImageWork` writes — no image pointer, no provenance edit, no cron
-- call — and the `builder_stock_items_rearm_settlement` trigger re-arms the
-- engine off this UPDATE. Rows holding a builder-supplied image and no banked
-- record are left alone.
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
