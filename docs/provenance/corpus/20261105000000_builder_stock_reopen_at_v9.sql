-- ===========================================================================
-- Builder Stock — send the affected properties back through the pipeline at
-- PROVENANCE_VERSION 9.
--
-- WHY THE VERSION ROSE. Two reader capabilities changed in the change that
-- carries this migration. (1) A locked-export Google Sheet's link targets are
-- now recovered from the `htmlview/sheet` grid, so rows whose links used to
-- vanish at the door can name their documents at all. (2) The PDF object
-- index is memoised per document, taking the heaviest live brochure from
-- ~5.9 s of parser CPU — an edge-worker kill on every attempt, and an
-- operational retirement at version 8 — to ~0.5 s. A negative banked at 8 was
-- decided by a reader that could not afford the document; it must not keep
-- standing over one that can.
--
-- `settleItemImages.ts` records the rule this obeys: a property at `settled`
-- is never claimed again, so a version bump ships with the migration that
-- sends the affected properties back to the stage that must re-run them. As
-- with `20261104000000`, this writes ONLY the queue columns `reopenImageWork`
-- writes: no image pointer, no provenance edit, no cron call — the
-- `builder_stock_items_rearm_settlement` trigger fires on this UPDATE and
-- re-arms the engine itself.
--
-- The set is the same shape as last time: rows holding any banked provenance
-- record (all now stale at 9), rows with a blank card, and rows whose card
-- came from the external ladder (so a builder's own brochure, now readable,
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
