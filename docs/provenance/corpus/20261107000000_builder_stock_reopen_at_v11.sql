-- ===========================================================================
-- Builder Stock — send the affected properties back through the pipeline at
-- PROVENANCE_VERSION 11.
--
-- WHY THE VERSION ROSE. The cover rule read a lot number as ONE token, and a
-- PDF's text layer breaks a number wherever the exporter placed its glyph
-- runs. Measured live, 2 September 2026, on the Watsons Reach stock list:
-- the supplied brochure for lot 103 extracts its identity line as
-- "2 1 Lot 10 3 Watsons Reach Estate" — the page a person reads says
-- "Lot 103", the token stream says "Lot 10" then "3" — so the reader
-- concluded the document was about some other lot and refused the builder's
-- own brochure. A run of digit tokens after Lot/Unit is now read fused as
-- well as strictly (`lotDesignationReadings`), so every `not_identified`
-- banked at 10 was judged under the split-blind reading and is stale by
-- definition.
--
-- Same mechanics as `20261104000000`/`20261105000000`/`20261106000000`: only
-- the queue columns `reopenImageWork` writes — no image pointer, no
-- provenance edit, no cron call — and the `builder_stock_items_rearm_settlement`
-- trigger re-arms the engine off this UPDATE. Rows holding a builder-supplied
-- image and no banked record are left alone.
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
