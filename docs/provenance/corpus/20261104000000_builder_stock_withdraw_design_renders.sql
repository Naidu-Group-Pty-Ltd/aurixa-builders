-- ===========================================================================
-- Builder Stock — WITHDRAW the design-render capability.
--
-- WHAT IS BEING REMOVED, AND WHY.
--
-- `20261102000000_builder_design_images.sql` added a table behind a feature
-- that let a builder (or staff on their behalf) upload ONE picture against a
-- house DESIGN, which was then fanned out to every lot whose stock row states
-- that design — and to every future lot of that design, for ever.
--
-- It was built for a real symptom: thirteen of the live source's rows appeared
-- to attach no document at all, so nothing could be read for them. That
-- diagnosis was wrong. Those rows DO carry a brochure — a Dropbox link behind
-- the word `Brochure` in the DOWNLOAD column — and the reasons they were not
-- being read were a package reader that refused any host but Google Drive, a
-- worker killed decoding twelve pages of a 13 MB PDF, and an attempt claim
-- released before the picture it protected was durable. All three are fixed in
-- the change that carries this migration.
--
-- So the capability was a manual workaround for a data-loss bug, and it is
-- withdrawn on its own terms as well: a matching design STRING is not evidence
-- that a photograph is of a particular house. One person's upload would have
-- reached lots nobody had looked at, and kept reaching new ones as the stock
-- list grew. Correct blank beats a plausible wrong house — the same rule the
-- rest of this subsystem is built on.
--
-- WHAT IS NOT BEING REMOVED. The PER-PROPERTY override stays. It names one
-- property, reaches no other, and is the guarantee that somebody can always
-- fix one card; it serves a legitimate administrative purpose and is never
-- part of ordinary stock ingestion.
--
--
-- WHY IT IS SAFE TO DROP THE TABLE RATHER THAN LEAVE IT.
--
-- Measured against production before writing this:
--
--     builder_design_images                                  0 rows
--     inbound foreign keys                                   0
--     dependent views / materialised views                   none
--     builder_stock_item_images WHERE source_reference
--       LIKE 'builder-design:%'  (the fan-out rows)          0
--     storage.objects under `builder-designs/`               0
--
-- Nothing was ever supplied through it, so there is no record to destroy and
-- no image to orphan. This is a FORWARD migration: the applied history is
-- untouched and `20261102000000` still stands as the record that the table
-- existed.
--
--
-- AND THE PROPERTIES ARE SENT BACK TO BE READ AGAIN.
--
-- `PROVENANCE_VERSION` rises to 8 in the same change, because a negative now
-- says WHY it is negative — read-and-nothing-there, or we-could-not-read-it —
-- and every record banked at 7 or below cannot say which it was. Raising the
-- version is what makes those records stop standing.
--
-- `settleItemImages.ts` records the rule this obeys: a property at `settled`
-- is never claimed again, so a version bump has to ship with the migration
-- that sends the affected properties back to the stage that must re-run them.
-- This writes ONLY the queue columns `reopenImageWork` itself writes. It sets
-- no `primary_image_id`, edits no `source_provenance_result`, invents no
-- image, and schedules no cron job — the `builder_stock_items_rearm_settlement`
-- trigger fires on `UPDATE OF enrichment_status, image_work_stage` and re-arms
-- the engine by itself, which is exactly what that trigger was widened for.
--
-- The set is narrowed to the properties the bump can change:
--   * anything holding a banked provenance record (all now unclassified);
--   * anything whose card is blank;
--   * anything whose card came from the external search ladder, so a builder's
--     own brochure can take it back — and so a candidate accepted under the
--     old identity rule is re-judged under the new one.
-- A property already holding a builder-supplied image and no banked negative
-- has nothing to gain and is left alone.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The design-render store, and the fan-out rows it owned.
-- ---------------------------------------------------------------------------

-- Defensive and a no-op in production (measured: 0 rows). A deployment that
-- somehow holds fan-out rows must not keep pictures whose origin has been
-- withdrawn: `enforceStrictPrimaryImages` re-decides each card on its own
-- sweep, and the reopen below covers every property this touches.
DELETE FROM public.builder_stock_item_images
WHERE source_reference LIKE 'builder-design:%';

DROP TABLE IF EXISTS public.builder_design_images;

-- ---------------------------------------------------------------------------
-- 2. Send the affected properties back through the pipeline at version 8.
-- ---------------------------------------------------------------------------

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
