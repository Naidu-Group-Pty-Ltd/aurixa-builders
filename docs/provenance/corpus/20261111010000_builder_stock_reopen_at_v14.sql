-- ===========================================================================
-- Builder Stock — send every property back through the pipeline at
-- PROVENANCE_VERSION 14.
--
-- WHY THE VERSION ROSE. Version 13 elects the raster a cover draws largest.
-- That is the page's own statement of emphasis, and it is exactly as emphatic
-- when what the page leads with is the floor plan.
--
-- Measured live, 4 September 2026. Lots 109 and 115 Palomino both drew a green
-- line drawing on the marketplace, badged "Builder supplied", from the Vanta 23
-- brochure whose first page gives the plan far more room than the render. Lot
-- 116 — same builder, same estate, the Nex 20 brochure — drew the house. Every
-- attribution was correct; the election was made with no visual information at
-- all. `selectCoverHero` now excludes a candidate whose pixels say floor plan
-- or graphic.
--
-- WHY THIS REOPEN IS WIDER THAN ITS PREDECESSORS. The earlier bumps could only
-- FIND a picture that had been missed, so they reopened the properties holding
-- a banked negative. This one can also WITHDRAW a picture that should never
-- have been elected, and a property showing a plan looks, in every column, like
-- a property that is perfectly settled. So the predicate includes rows holding
-- a builder-supplied primary — they are precisely the ones that may be wrong.
--
-- Street View pointers are deliberately NOT singled out here. `chooseCardImage`
-- no longer ranks them at all, so `enforceStrictPrimaryImages` clears those
-- pointers on its own next pass; naming them in a data migration would be doing
-- by hand what the ranking now does by itself.
--
-- Same mechanics as every previous reopen: only the queue columns
-- `reopenImageWork` writes — no image pointer, no provenance edit, no cron
-- call — and the `builder_stock_items_rearm_settlement` trigger re-arms the
-- engine off this UPDATE.
-- ===========================================================================

UPDATE public.builder_stock_items AS i
SET
  enrichment_status          = 'pending',
  image_work_stage           = 'source',
  image_work_claim_until     = NULL,
  image_work_attempts        = 0,
  image_work_next_attempt_at = now(),
  image_work_updated_at      = now()
WHERE i.lifecycle_status = 'active';
