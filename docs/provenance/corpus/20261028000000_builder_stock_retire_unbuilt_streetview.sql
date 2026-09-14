-- Builder Stock — a photograph of the road outside an estate is not a
-- photograph of the property, and it must not be on a client's card.
--
--
-- WHAT WAS ON THE SCREEN.
--
-- A house-and-land package whose brochure shows a finished render was served a
-- Street View still of an empty rural road. Measured across the deployment:
-- 58 of 76 cards holding a picture were Street View, and NOT ONE web result
-- had ever been shown. The 18 real photographs all came from builder-supplied
-- documents on a different list.
--
-- Three faults produced it, and this migration is the data half of the third.
--
--   1. The identity check vetoed correct images on marketing boilerplate. An
--      image at `…/lot-310-<estate>-<suburb>-<postcode>.jpg`, titled with the
--      same, was refused `generic_estate_page` because the page also said
--      "house and land packages" — which every builder's site says beside
--      every individual listing.
--
--   2. A verdict was written once, at discovery, against whatever the property
--      knew about itself then, and never revisited. 14 candidates were refused
--      `no_location_evidence` while the property had no suburb; the suburb was
--      recovered minutes later and nothing re-judged them.
--
--   3. Street View stood in for a dwelling that does not exist. A lot in a new
--      estate has no building on it, so the camera photographs dirt.
--
--
-- THE RULE THE CODE NOW HOLDS.
--
-- Stage 3 requires a REAL STREET ADDRESS — one the source supplied, not one
-- composed from a lot number and an estate name. `hasPhotographableStreetAddress`
-- is that test, and a composed line is by construction a lot in an estate.
-- Stage 2 is untouched: naming a property to a search is a different act from
-- pointing a camera at the ground, and the builder's own render of the design
-- on this lot is exactly the reference picture the brochure itself shows.
--
--
-- WHAT THIS STATEMENT DOES, AND WHY IT DELETES.
--
-- The rows already stored were taken under the old rule, and leaving them is
-- not neutral: `imagePriority` ranks a `streetview` row, so the very next pass
-- would choose the same wrong picture again. So the picture is removed and the
-- property is handed back to the ladder, which — with faults 1 and 2 fixed —
-- can now promote the builder's own image it had already found and discarded.
--
-- SCOPED BY THE RULE ITSELF, never by an id: STREET VIEW STILLS belonging to a
-- property with no street address. A property the source addressed keeps every
-- Street View it has. Nothing else in the table is reachable from here — no
-- builder document, no web result, no source photograph.
--
--
-- AND THE STAGE IS NOT THE PRODUCT. `source_stage = 'google_maps'` alone was
-- the first predicate written, and a production dry-run before merge showed it
-- selecting 145 rows rather than 58:
--
--     streetview      58   the stills this exists to remove
--     staticmap        7   satellite tiles, DELIBERATELY RETAINED — the stage
--                          keeps them as honest location imagery and
--                          `imagePriority` ranks only `streetview`, so a tile
--                          can never become a card image in the first place
--     stage-status    47   the ladder's own bookkeeping, which the generation
--     stage-skipped   33   re-open already clears for the rows it re-opens
--
-- Only the first group is a wrong picture on a card. The other three are
-- records that are either useful or somebody else's to manage, and removing
-- them would be destroying data to no purpose. `product` is the discriminator
-- the stage itself writes, and both it and the reference are required.

BEGIN;

-- 1. Let go of the pointer first, or the foreign key refuses the delete.
UPDATE public.builder_stock_items AS i
   SET primary_image_id = NULL,
       updated_at = now()
 WHERE i.primary_image_id IS NOT NULL
   AND coalesce(btrim(i.address_line), '') = ''
   AND EXISTS (
     SELECT 1 FROM public.builder_stock_item_images AS x
      WHERE x.id = i.primary_image_id
        AND x.source_stage = 'google_maps'
        AND x.source_reference = 'streetview'
        AND x.source_detail->>'product' = 'streetview'
   );

-- 2. Remove the location imagery taken of a property that is not built.
DELETE FROM public.builder_stock_item_images AS x
 USING public.builder_stock_items AS i
 WHERE x.stock_item_id = i.id
   AND x.source_stage = 'google_maps'
   AND x.source_reference = 'streetview'
   AND x.source_detail->>'product' = 'streetview'
   AND coalesce(btrim(i.address_line), '') = '';

-- 3. And raise the generation, so every property this affects is looked at
--    again by the ladder that now knows better. `reopen_builder_stock_stranded_items`
--    (20261027010000) does the rest: it re-opens a settled, blank property
--    whose conclusion predates the change, clears the stale stage bookkeeping
--    so the rungs are genuinely re-offered, and returns it to `pending`.
UPDATE public.builder_stock_settlement_target
   SET image_ladder_generation_at = now(),
       updated_at = now();

COMMIT;

-- The scheduler unschedules itself once nothing is owed, so a deployment that
-- has gone quiet has no job left to notice any of this. Same function the
-- insert trigger calls, so the schedule is stated in exactly one place.
DO $rearm$
BEGIN
  PERFORM public.ensure_builder_stock_settlement_scheduled();
END;
$rearm$;
