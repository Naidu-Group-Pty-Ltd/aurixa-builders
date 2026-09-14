-- Builder Stock — imagery becomes a queue of PROPERTIES, not one walk over an
-- upload.
--
-- INERT ON PURPOSE. This migration adds columns, an index and three functions
-- and changes no behaviour whatsoever: nothing in `supabase/functions/**` reads
-- or writes any of it yet. It ships and is applied first precisely so the edge
-- code that needs it can never arrive before the capability does — the failure
-- that took the whole marketplace down on 29 August, when a settler requiring
-- `claim_builder_stock_settlement_lease` deployed automatically on `main` while
-- its migration was still waiting to be dispatched by hand, and every tick
-- answered 503.
--
--
-- WHAT IT IS FOR
--
-- One upload's imagery is settled by ONE ordered walk with no cursor:
-- `repairSourceImagesForUpload` reads every active item of the upload
-- `ORDER BY created_at ASC`, works under a 12-second budget and per-run caps,
-- and ends the whole run on the first cap it hits — `outcome.incomplete = true;
-- break;`. The marker is not written, so the next tick starts again from row 1.
--
-- PRODUCTION, 29 AUGUST 2026. Upload `d49ca895` imported 23 properties at
-- 01:53:54. Twenty-six hours later the walk had reached item 13 of 23, and
-- items 14 to 23 — Lot 13 Hummock Rise and Lot 1663 Ringer Street among them —
-- had never been read even once. In one seventeen-minute window the settler
-- logged SIX `CPU Time exceeded` kills, TEN `lease_held` skips and NOT ONE
-- completed tick:
--
--     02:19:09  CPU Time exceeded      (claimed the lease, killed, no release)
--     02:20:01  lease_held
--     02:21:01  lease_held
--     02:22:08  lease claim: canceling statement due to statement timeout
--     02:23:07  CPU Time exceeded
--     02:24:01  lease_held
--     ...
--
-- A killed worker runs no `finally`, so it holds the 120-second lease until it
-- expires; the next tick claims, dies at the same place, and holds it again.
-- Nothing in that loop can leave it.
--
-- The shape of the fix is not new here. `claim_listing_enrichment`
-- (20260803162826) already solves exactly this for listing enrichment —
-- `FOR UPDATE SKIP LOCKED`, a per-row lease, `next_attempt_at`, an attempt
-- counter incremented IN the claim — and this is that pattern applied to
-- builder stock, deliberately rather than a second invention.
--
--
-- WHY COLUMNS AND NOT A QUEUE TABLE
--
-- The work is a property of the property. `builder_stock_items` already carries
-- `enrichment_status`, `primary_image_id` and `source_provenance_result`, and a
-- side table would need a row per item, a foreign key, a backfill and a join on
-- the read path to say something the item itself knows. What it cannot already
-- carry is a lease, a durable attempt count and a next-attempt time, so those
-- are added and nothing else is.


-- ── The per-item work state ─────────────────────────────────────────────────
ALTER TABLE public.builder_stock_items
  /*
   * WHICH QUESTION THIS PROPERTY IS WAITING ON.
   *
   * The four names are the settlement phases that already exist, per property
   * instead of per upload, plus a terminal one. `source` is first because it
   * is the phase that DISCOVERS images; the other two judge and repair
   * pictures it has already found, and `fallback` is the three-stage ladder,
   * which #2305's rule keeps behind the source phase for this property.
   */
  ADD COLUMN IF NOT EXISTS image_work_stage text NOT NULL DEFAULT 'source',

  /*
   * THE LEASE, AND IT IS PER PROPERTY.
   *
   * The lease this replaces is a single boolean row for the whole deployment,
   * held for 120 seconds against a worst COMPLETED tick of 16.9 seconds. Two
   * workers may never own one property; they may freely own different ones.
   *
   * It EXPIRES rather than being released, because the thing that kills these
   * invocations runs no `finally` and returns nothing. A kill costs one
   * property one lease term, and costs every other property nothing at all.
   */
  ADD COLUMN IF NOT EXISTS image_work_claim_until timestamptz,

  /*
   * WHEN THIS PROPERTY MAY BE CLAIMED AGAIN. Set by the claim itself, so a
   * property that kills its worker backs off instead of being handed to the
   * next tick a minute later — which is what let one property consume every
   * tick for twenty-six hours.
   */
  ADD COLUMN IF NOT EXISTS image_work_next_attempt_at timestamptz NOT NULL DEFAULT now(),

  /*
   * HOW MANY TIMES THIS PROPERTY HAS BEEN CLAIMED AT THIS STAGE, and it is for
   * the BACKOFF and nothing else.
   *
   * IT IS NOT A RETIREMENT COUNTER AND MUST NEVER BE USED AS ONE. A property
   * legitimately needs several claims to move through its stages, and the
   * dangerous operation that has to be retired after a fixed number of
   * attempts is the linked-package recovery — which counts itself, in
   * `source_provenance_result`, keyed by provenance version, package reference
   * and source anchor, at `MAX_PACKAGE_ATTEMPTS = 2`. That counter is written
   * BEFORE the download begins so a kill leaves evidence, and it is the only
   * thing that may retire a package. Spending its allowance on an eligibility
   * sweep or a Street View call would retire a package nobody had opened.
   *
   * `complete_builder_stock_image_work` resets this to zero whenever the stage
   * CHANGES, so it is stage-scoped by construction rather than by convention.
   */
  ADD COLUMN IF NOT EXISTS image_work_attempts integer NOT NULL DEFAULT 0,

  /* What happened last, in the worker's own words. Observable, not decisive. */
  ADD COLUMN IF NOT EXISTS image_work_last_result text,
  ADD COLUMN IF NOT EXISTS image_work_last_error text,
  ADD COLUMN IF NOT EXISTS image_work_updated_at timestamptz;

DO $stage_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'builder_stock_items_image_work_stage_check'
  ) THEN
    ALTER TABLE public.builder_stock_items
      ADD CONSTRAINT builder_stock_items_image_work_stage_check
      CHECK (image_work_stage IN ('source', 'eligibility', 'sanitization', 'fallback', 'settled'));
  END IF;
END;
$stage_check$;

/*
 * The claim's own index.
 *
 * Partial, because a settled property is the overwhelming majority of the table
 * and is never a candidate. Ordered by the same expression the claim orders by,
 * so selecting the next few properties is a range scan rather than a sort of
 * everything an organisation holds.
 */
CREATE INDEX IF NOT EXISTS builder_stock_items_image_work_queue_idx
  ON public.builder_stock_items (image_work_next_attempt_at, id)
  WHERE lifecycle_status = 'active' AND image_work_stage <> 'settled';


-- ── Taking work ─────────────────────────────────────────────────────────────
/*
 * Claim up to `p_limit` properties that are due, and answer with them.
 *
 * `FOR UPDATE SKIP LOCKED` is what removes head-of-line blocking: a row another
 * transaction holds is stepped over rather than waited for, so a property being
 * worked on — or one whose worker was killed and whose lease has not yet
 * expired — is simply not in anybody else's answer.
 *
 * THE ATTEMPT AND THE BACKOFF ARE WRITTEN IN THE CLAIM, WHICH IS THE POINT.
 * They commit with the claim, before the caller does anything expensive, so an
 * invocation killed on a resource limit — no `finally`, no throw, no response —
 * still leaves the count raised and the next attempt pushed out. A counter
 * written after the work is a counter a kill can never reach, and this
 * repository has already watched one property sit at `attempts: 1` for a day
 * because of it.
 *
 * The backoff doubles from 30 seconds and is capped at an hour: long enough
 * that a property which kills its worker stops monopolising the queue, short
 * enough that a transient failure is not parked for a day.
 *
 * `p_organisation_id` is optional and narrows the claim; the default claims
 * across the deployment, which is what a cron-driven worker wants.
 */
CREATE OR REPLACE FUNCTION public.claim_builder_stock_image_work(
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 120,
  p_organisation_id uuid DEFAULT NULL
) RETURNS SETOF public.builder_stock_items
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.builder_stock_items AS i
     SET image_work_claim_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         image_work_attempts = i.image_work_attempts + 1,
         image_work_next_attempt_at = now() + make_interval(
           secs => least(30 * power(2, least(i.image_work_attempts, 7))::integer, 3600)),
         image_work_updated_at = now()
   WHERE i.id IN (
     SELECT c.id
       FROM public.builder_stock_items AS c
      WHERE c.lifecycle_status = 'active'
        AND c.image_work_stage <> 'settled'
        AND c.image_work_next_attempt_at <= now()
        AND (c.image_work_claim_until IS NULL OR c.image_work_claim_until < now())
        AND (p_organisation_id IS NULL OR c.organisation_id = p_organisation_id)
      ORDER BY c.image_work_next_attempt_at, c.id
      LIMIT greatest(coalesce(p_limit, 1), 0)
        FOR UPDATE SKIP LOCKED
   )
  RETURNING i.*;
$$;

REVOKE ALL ON FUNCTION public.claim_builder_stock_image_work(integer, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_builder_stock_image_work(integer, integer, uuid)
  TO postgres, service_role;


-- ── Giving it back ──────────────────────────────────────────────────────────
/*
 * Finish a claim: record what happened, move the stage, release the lease.
 *
 * THE ATTEMPT COUNT RESETS WHEN THE STAGE CHANGES, and that is the rule that
 * keeps the generic counter away from the package allowance. Moving from
 * `source` to `eligibility` is progress, not a retry, so the backoff starts
 * again from nothing; being handed `source` twice is a retry and keeps
 * counting. The package's own attempt count in `source_provenance_result` is
 * untouched by any of this, at either stage.
 *
 * `p_retry_after_seconds` lets a worker say "not yet" without spending an
 * attempt's worth of backoff — a property waiting on evidence another property
 * is about to supply, rather than one that failed.
 */
CREATE OR REPLACE FUNCTION public.complete_builder_stock_image_work(
  p_item_id uuid,
  p_next_stage text DEFAULT NULL,
  p_result text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT 0
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.builder_stock_items AS i
     SET image_work_stage = coalesce(p_next_stage, i.image_work_stage),
         image_work_attempts = CASE
           WHEN p_next_stage IS NOT NULL AND p_next_stage IS DISTINCT FROM i.image_work_stage
             THEN 0
           ELSE i.image_work_attempts
         END,
         image_work_claim_until = NULL,
         image_work_next_attempt_at =
           now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 0), 0)),
         image_work_last_result = left(p_result, 200),
         image_work_last_error = left(p_error, 500),
         image_work_updated_at = now()
   WHERE i.id = p_item_id
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.complete_builder_stock_image_work(uuid, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_builder_stock_image_work(uuid, text, text, text, integer)
  TO postgres, service_role;


-- ── Is there anything to do? ────────────────────────────────────────────────
/*
 * How many properties are claimable RIGHT NOW, and how many are outstanding at
 * all.
 *
 * The scheduler needs both and they are different questions. Nothing claimable
 * with work outstanding means every candidate is leased or backing off — a
 * reason to keep the job alive and do nothing this minute. Nothing outstanding
 * means the job may retire.
 *
 * ANSWERING "NOTHING TO DO" ON A FAILED READ IS HOW A SWEEP GOES PERMANENTLY
 * QUIET, so this counts rather than probes, and a caller that cannot execute it
 * gets an error rather than a zero.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_image_work_pending()
RETURNS TABLE (claimable bigint, outstanding bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*) FILTER (
      WHERE i.image_work_next_attempt_at <= now()
        AND (i.image_work_claim_until IS NULL OR i.image_work_claim_until < now())
    ) AS claimable,
    count(*) AS outstanding
  FROM public.builder_stock_items AS i
  WHERE i.lifecycle_status = 'active'
    AND i.image_work_stage <> 'settled';
$$;

REVOKE ALL ON FUNCTION public.builder_stock_image_work_pending()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_work_pending()
  TO postgres, service_role;


-- ── Bringing the existing stock into the queue ──────────────────────────────
--
-- EVERY ACTIVE PROPERTY STARTS AT `source`, DUE NOW, which is what the column
-- default already says — so the backfill is the default and there is nothing to
-- write. It is stated here rather than left implicit because it is a decision:
-- a deployment applying this migration acquires a queue holding every property
-- it currently serves, and that is correct. The per-item stage is authoritative
-- only once the edge code reads it, which is a later change; until then these
-- columns are inert and the upload-level markers still decide everything.
