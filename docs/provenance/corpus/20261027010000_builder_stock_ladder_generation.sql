-- Builder Stock — when the ladder itself gets better, the properties that
-- concluded "nothing to show" under the old one have to be asked again.
--
--
-- WHY THIS EXISTS AT ALL.
--
-- `settleItemImages.ts` opens by stating the rule and admitting it has no
-- mechanism: "A VERSION BUMP MUST RE-OPEN THE PROPERTIES IT AFFECTS, and
-- nothing here can do that for it ... a property at `settled` is never claimed
-- again." The upload-level markers it replaced went stale on their own when a
-- classifier version rose; `image_work_stage` does not. So every improvement
-- to the ladder has, until now, applied to future uploads only, and the
-- properties it was written for stayed blank for ever.
--
-- 20261026000000 added the first half of the answer — a property re-opens when
-- one of its own IMAGES is re-judged after it settled. That is a fact about
-- evidence, and it cannot see a change to the ENGINE: no image moves when the
-- ladder learns to compose an address, or stops crediting a provider outage as
-- a completed stage. Those properties hold exactly the rows they held before,
-- and every one of them is still settled and still blank.
--
--
-- THE RULE, AND IT IS AGAIN A FACT ABOUT TIME.
--
--     settled before the ladder last changed, and still blank  ->  re-open
--
-- One timestamp on the single-row settlement target says when the ladder last
-- changed. A property whose conclusion predates it drew that conclusion from
-- an engine that no longer exists, so it is owed another pass.
--
-- It is SELF-LIMITING for the same reason its sibling is: re-opening stamps
-- `image_work_updated_at`, and settling stamps it again, so a property is
-- re-opened once per ladder generation and never in a loop. It is DURABLE
-- where a one-shot UPDATE in a deploy migration is not — a property still
-- mid-ladder when this ships settles a minute later and is picked up on the
-- next tick, rather than being missed by a statement that has already run.
-- And it names nothing: no upload, no organisation, no source type, no
-- property. Every future ladder change is one line in its own migration.
--
-- ONLY BLANK ONES, unchanged. A property showing a picture has nothing to gain
-- and would pay for a stage to be told so.

--
-- ── THE ORDER THIS SHIPS IN IS NOT INTERCHANGEABLE ──────────────────────────
--
--     the Edge Functions first, verified live, and THEN this migration.
--
-- Migrations and functions deploy from separate workflows here, so the order
-- is a decision rather than a consequence. Applied FIRST, this re-arms the
-- scheduler and re-opens 87 properties into the ladder that is still running
-- the OLD code: it composes no address, finds nothing, and settles each one
-- again — stamping `image_work_updated_at` PAST the generation, which is the
-- one thing that makes a property invisible to this function for ever. The
-- fix would then land correct and permanently inert, with no error anywhere.
--
-- Re-opening is cheap and repeatable; being stamped past a generation is not.
-- So the migration goes last, and `settle_builder_stock_marketplace_eligibility_tick`
-- is the thing to watch afterwards.

ALTER TABLE public.builder_stock_settlement_target
  ADD COLUMN IF NOT EXISTS image_ladder_generation_at timestamptz;

COMMENT ON COLUMN public.builder_stock_settlement_target.image_ladder_generation_at IS
  'When the image ladder last changed what it is capable of. A settled property with no picture whose own conclusion predates this is re-opened exactly once. Raise it — SET image_ladder_generation_at = now() — in the migration that ships any change to what a stage can find, refuse or retry.';

INSERT INTO public.builder_stock_settlement_target (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;


-- ── This generation ─────────────────────────────────────────────────────────
/*
 * Two changes ship with this migration, and each on its own leaves a property
 * settled and blank that the new ladder can serve:
 *
 *   1. `geocodableAddress` composes a findable line from the lot and the named
 *      estate where the source supplied no address column. Stage 3 refused 86
 *      of 89 properties on one upload for "no street address to look up"; the
 *      identity was in the row the whole time, split across three columns.
 *
 *   2. `stageWasAttempted` no longer counts an operational FAILURE as a stage
 *      that ran. 58 properties on that same upload had stage 2 retired by
 *      "The property search service did not respond" — an outage, which says
 *      nothing whatever about the property.
 */
UPDATE public.builder_stock_settlement_target
   SET image_ladder_generation_at = now(),
       updated_at = now();


-- ── The re-open reads both facts ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_builder_stock_stranded_items()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reopened integer := 0;
  v_generation timestamptz;
BEGIN
  SELECT image_ladder_generation_at INTO v_generation
    FROM public.builder_stock_settlement_target
   LIMIT 1;

  WITH reopened AS (
    UPDATE public.builder_stock_items AS i
       SET image_work_stage = 'eligibility',
           image_work_next_attempt_at = now(),
           image_work_claim_until = NULL,
           image_work_attempts = 0,
           -- A property is being asked again, so the terminal enrichment
           -- verdict from the previous generation must not keep it out of the
           -- fallback queue `settleFallbackImages` reads.
           enrichment_status = 'pending',
           image_work_updated_at = now(),
           updated_at = now()
     WHERE i.lifecycle_status IN ('active', 'staged')
       AND i.image_work_stage = 'settled'
       AND i.primary_image_id IS NULL
       AND (
         -- Its own evidence was re-judged after it concluded. (20261026000000)
         EXISTS (
           SELECT 1
             FROM public.builder_stock_item_images AS x
            WHERE x.stock_item_id = i.id
              AND x.updated_at > i.image_work_updated_at
         )
         -- Or the engine that drew the conclusion has since changed.
         OR (v_generation IS NOT NULL AND i.image_work_updated_at < v_generation)
       )
    RETURNING i.id
  )
  /*
   * AND THE BOOKKEEPING THE OLD LADDER LEFT BEHIND GOES WITH IT.
   *
   * Re-opening a property is not enough on its own. `nextImageStage` reads
   * `stage-status` rows to decide which rungs are still owed, and the rows the
   * previous generation wrote say the rungs were climbed. On the measured
   * upload, 86 properties hold a `google_maps` row reading "This property has
   * no street address to look up" — a refusal caused by a MISSING INPUT that
   * this generation supplies. Leave those rows and every property re-opens,
   * finds both stages recorded as done, and settles blank again immediately:
   * the fix would run, cost a claim each, and change nothing.
   *
   * These rows are pure bookkeeping. A `stage-status` row never carries an
   * image — a real Street View is `streetview`, a real search result is its own
   * URL — so deleting them destroys no picture and no provenance. What it
   * destroys is a conclusion that, by the definition of a new generation, no
   * longer stands.
   *
   * SCOPED TO THE TWO PAID STAGES AND TO `stage-status` ALONE. Nothing here can
   * touch a builder-supplied row, a stored photograph, or the package attempt
   * counters that stage 1 keeps.
   */
  , cleared AS (
    DELETE FROM public.builder_stock_item_images AS x
     USING reopened AS r
     WHERE x.stock_item_id = r.id
       AND x.source_reference = 'stage-status'
       AND x.source_stage IN ('internet_search', 'google_maps')
    RETURNING x.id
  )
  -- A data-modifying CTE always runs to completion whether or not the primary
  -- query reads it, so `cleared` is executed and the count is the PROPERTIES.
  SELECT count(*) INTO v_reopened FROM reopened;

  RETURN v_reopened;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_builder_stock_stranded_items()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_builder_stock_stranded_items()
  TO postgres, service_role;


-- ── And the scheduler has to be awake to run it ─────────────────────────────
/*
 * THE TICK UNSCHEDULES ITSELF WHEN EVERY COUNT IS ZERO, and a deployment whose
 * properties have all settled blank is exactly that state. Re-opening from
 * inside the tick therefore cannot start: the job is already gone.
 *
 * `builder_stock_items_rearm_settlement` re-arms on INSERT, so a new upload
 * always wakes it. Raising a ladder generation is the other event that creates
 * work out of nothing, so it re-arms too — otherwise this fix would ship
 * correct and inert until somebody happened to upload.
 *
 * Through the SAME function the insert trigger calls, so the schedule is
 * stated in exactly one place and this migration cannot drift from it.
 */
DO $rearm$
BEGIN
  PERFORM public.ensure_builder_stock_settlement_scheduled();
END;
$rearm$;
