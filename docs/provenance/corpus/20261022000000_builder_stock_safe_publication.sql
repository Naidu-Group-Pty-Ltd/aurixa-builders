-- Builder Stock — a replacement stock list must not blank a working Marketplace.
--
-- WHAT IS STILL BROKEN AFTER #2347. That change made a re-import find the
-- property it already imported: same `source_anchor`, same exact-property
-- identity, update in place, imagery survives. It fixes MATCHED properties
-- completely and it fixes nothing else, which was said at the time.
--
-- A genuinely NEW or UNMATCHED row is still inserted `lifecycle_status =
-- 'active'` inside the import request, before one pixel of its imagery has been
-- looked for. The Marketplace's only visibility gate is
-- `.eq('lifecycle_status','active')`, so that row is on a client's screen
-- immediately, as a card reading "No image found", and it stays that way for
-- however long its source work takes. A replacement list of twenty-three new
-- properties turns a working Marketplace into twenty-three blank cards the
-- instant it is imported.
--
--
-- THE MODEL: A THIRD LIFECYCLE VALUE, AND NOTHING ELSE.
--
-- Every consumer of `lifecycle_status` filters POSITIVELY on `'active'` — the
-- Marketplace, the Builder Portal, the primary-image enforcement, the source
-- repair, the fallback queue, the per-item claim, the pending count and the
-- cron gate. So a third value is invisible everywhere BY CONSTRUCTION. Nothing
-- has to learn to hide it; the serving query already hides anything that is not
-- `'active'`.
--
-- That is why this is `staged` rather than a shadow table, a second items
-- table, a publication pointer on the organisation, or a `published` flag with
-- its own semantics. It is one CHECK constraint and one word.
--
--     import          new/unmatched rows arrive `staged`  (invisible)
--                     matched rows stay `active`          (#2347, keeps serving)
--     processing      the per-item engine works `active` AND `staged`
--     readiness       every staged row of the upload has been through `source`
--     cutover         ONE transaction: staged -> active, superseded -> archived
--     failure         nothing ever flips; the published set is untouched
--
--
-- THE CRUX, AND IT IS THE HALF THAT IS EASY TO MISS. Processing must SEE staged
-- rows or they can never reach readiness and would be stranded invisible for
-- ever. The claim, the pending count and the cron gate all filter `= 'active'`
-- today, so all three are widened here to `IN ('active','staged')`.
--
--     SERVING     stays  = 'active'
--     PROCESSING becomes IN ('active','staged')
--
-- Those two lines are the whole mechanism.


-- STAGING FIXES MEMBERSHIP. IT DOES NOTHING ABOUT VALUES, and that is the
-- second half.
--
-- #2347 updates a matched property IN PLACE — which is exactly what preserves
-- its earned imagery — and `writablePatch` writes price, availability,
-- description, land and building size onto a row whose `lifecycle_status` is
-- `active`. The Marketplace serves that row. So the instant a replacement list
-- is imported a client sees A's NEW price beside B's OLD membership: a hybrid
-- dataset, published, while the replacement is still processing and might never
-- finish. Proved behaviourally before this was written — the Marketplace read
-- returned 850000/reserved with C invisible and B still standing.
--
-- So a matched row's new values go to `pending_patch`, a column nothing serves,
-- and the row's own columns are left exactly as they are. A PATCH RATHER THAN A
-- REPLACEMENT ROW, because the row id must not change: it is what
-- `builder_stock_item_images.stock_item_id` and `primary_image_id` point at, so
-- a swap would strand the property's imagery on the old id and it would have to
-- be rebuilt.


-- ── The third value ─────────────────────────────────────────────────────────
ALTER TABLE public.builder_stock_items
  DROP CONSTRAINT IF EXISTS builder_stock_items_lifecycle_status_check;

ALTER TABLE public.builder_stock_items
  ADD CONSTRAINT builder_stock_items_lifecycle_status_check
  CHECK (lifecycle_status IN ('active', 'staged', 'archived'));

/*
 * WHICH UPLOADS THIS ONE REPLACES.
 *
 * Written by the import: the uploads that were supplying the rows this import
 * matched. It is how the cutover knows which still-active rows are REMOVED
 * properties rather than a different stock list the builder legitimately keeps
 * beside this one.
 *
 * It has to be recorded rather than derived, and #2347 is why: a matched row's
 * `upload_id` is RE-POINTED to the new upload during the import, so by cutover
 * time the evidence of which upload used to supply it is gone from the row. A
 * rule like "archive anything whose upload_id is not mine" would read a
 * coexisting second list as removed stock and archive it.
 */
ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS replaces_upload_ids uuid[] NOT NULL DEFAULT '{}',
  /* When the cutover happened. NULL means this upload has never published. */
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

/*
 * A MATCHED PROPERTY'S REPLACEMENT VALUES, HELD BACK.
 *
 * `pending_patch` is the writable subset of one import's normalised record;
 * `pending_upload_id` says which upload is waiting to apply it. Nothing serves
 * either, so the published row goes on reading exactly as it did while the
 * replacement is processed — and if the replacement never becomes ready, the
 * patch is simply never applied.
 */
ALTER TABLE public.builder_stock_items
  ADD COLUMN IF NOT EXISTS pending_patch jsonb,
  ADD COLUMN IF NOT EXISTS pending_upload_id uuid;

/*
 * The claim's index, re-stated for the widened predicate.
 *
 * The partial index from 20261019000000 says `lifecycle_status = 'active'`, so
 * a staged row would not be in it and the claim would fall back to a sequential
 * scan of the table for exactly the rows that need claiming most.
 */
DROP INDEX IF EXISTS builder_stock_items_image_work_queue_idx;
CREATE INDEX IF NOT EXISTS builder_stock_items_image_work_queue_idx
  ON public.builder_stock_items (image_work_next_attempt_at, id)
  WHERE lifecycle_status IN ('active', 'staged') AND image_work_stage <> 'settled';


-- ── Processing sees staged; serving does not ────────────────────────────────
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
      -- STAGED ROWS ARE PROCESSED. They are invisible to the Marketplace and
      -- must still reach readiness, or a replacement upload could never
      -- publish and its properties would be stranded unseen for ever.
      WHERE c.lifecycle_status IN ('active', 'staged')
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
  WHERE i.lifecycle_status IN ('active', 'staged')
    AND i.image_work_stage <> 'settled';
$$;

REVOKE ALL ON FUNCTION public.builder_stock_image_work_pending()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_work_pending()
  TO postgres, service_role;


-- ── Is this upload ready to be published? ───────────────────────────────────
/*
 * READINESS IS ONE QUESTION: has every staged row had its OWN source work run?
 *
 * Not "does every row have a picture" — a property whose builder supplied
 * nothing is a legitimate blank, and blocking on it would mean a replacement
 * list could never publish because of one property nobody has a photograph of.
 * The rule is that no row is blank merely because nobody has LOOKED yet.
 *
 * `image_work_stage <> 'source'` is exactly that test: the per-item engine
 * advances a property off `source` only when its source stage completed, and a
 * package that exhausted MAX_PACKAGE_ATTEMPTS is written its terminal
 * `no_deterministic_image` verdict by the repair itself and advances too. So a
 * genuinely terminal no-image property IS ready, which is the correct answer.
 *
 * Primary selection needs no separate test: `settleClaimedItem` runs
 * `chooseAndStorePrimaryImage` after EVERY stage, so a builder photograph found
 * during `source` is already on the card before the stage advances.
 *
 * The fallback ladder deliberately does NOT gate publication. It runs after
 * `source`, it can only ever ADD an image to a card that would otherwise be
 * blank, and `chooseDisplayableImage` keeps builder imagery ahead of it — so
 * letting it continue past the cutover cannot produce the blank-Marketplace
 * failure this exists to prevent.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_publication_readiness(p_upload_id uuid)
RETURNS TABLE (staged bigint, source_outstanding bigint, ready boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*) AS staged,
    count(*) FILTER (
      WHERE i.lifecycle_status = 'staged' AND i.image_work_stage = 'source'
    ) AS source_outstanding,
    count(*) > 0 AND count(*) FILTER (
      WHERE i.lifecycle_status = 'staged' AND i.image_work_stage = 'source'
    ) = 0 AS ready
  FROM public.builder_stock_items AS i
  WHERE (i.upload_id = p_upload_id AND i.lifecycle_status = 'staged')
     -- A MATCHED PROPERTY WAITING ONLY ON ITS PATCH COUNTS TOO. An import whose
     -- rows ALL matched stages nothing at all, and a readiness rule that looked
     -- only at staged rows would answer "nothing here" for ever — so the new
     -- prices would never publish. It owes no source work: its imagery is
     -- already earned and its row is already serving.
     OR (i.pending_upload_id = p_upload_id);
$$;

REVOKE ALL ON FUNCTION public.builder_stock_publication_readiness(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_publication_readiness(uuid)
  TO postgres, service_role;


-- ── The cutover ─────────────────────────────────────────────────────────────
/*
 * ATOMIC, BECAUSE HALF A DATASET IS THE FAILURE.
 *
 * A `LANGUAGE sql` function is one statement to the caller and runs in a single
 * implicit transaction, so the Marketplace can observe the moment before and
 * the moment after and nothing in between. It can never serve some rows from
 * the old list and some from the new because one UPDATE landed first — which is
 * exactly what row-at-a-time publication from the edge would produce, and why
 * this is not done there.
 *
 * IT REFUSES UNLESS READY. Publication is not a command the caller may insist
 * on; the readiness rule is evaluated INSIDE the same statement that flips the
 * rows, so nothing can change between the check and the act.
 *
 * WHAT IS ARCHIVED. Only rows whose CURRENT supplier is one of the uploads this
 * one replaces. #2347 re-points a matched row's `upload_id` to the new upload
 * during the import, so any row still carrying a superseded upload's id is by
 * definition one the new list did not contain: a removed property. A stock list
 * the builder keeps beside this one has an upload id that is not in
 * `replaces_upload_ids` and is never touched.
 *
 * Archived, never deleted — the same rule `delete_upload` follows, for the same
 * reason: an adviser's selection against that property survives.
 */
CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload(p_upload_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ready boolean;
  v_staged bigint;
  v_outstanding bigint;
  v_replaces uuid[];
  v_published integer := 0;
  v_archived integer := 0;
  v_patched integer := 0;
BEGIN
  SELECT staged, source_outstanding, ready
    INTO v_staged, v_outstanding, v_ready
    FROM public.builder_stock_publication_readiness(p_upload_id);

  IF NOT coalesce(v_ready, false) THEN
    RETURN jsonb_build_object(
      'published', false, 'reason', 'not_ready',
      'staged', coalesce(v_staged, 0), 'source_outstanding', coalesce(v_outstanding, 0));
  END IF;

  SELECT coalesce(replaces_upload_ids, '{}') INTO v_replaces
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  /*
   * 1. APPLY EVERY HELD-BACK PATCH — FIRST, and the order is load-bearing.
   *
   * This is what re-points a matched row's `upload_id` to this upload, and step
   * 3 archives by `upload_id`. Do it after, and every kept property would look
   * like a removed one.
   *
   * EVERY COLUMN IS NAMED. A `jsonb_populate_record` over the whole row would
   * let whatever ended up in that column write any field of the table, which is
   * mass assignment through a jsonb door. This list is exactly `writablePatch`
   * plus the three the import controls, and a key that is not here cannot be
   * written however it got into the patch.
   */
  UPDATE public.builder_stock_items AS i
     SET external_reference = coalesce(i.pending_patch->>'external_reference', i.external_reference),
         development_name   = coalesce(i.pending_patch->>'development_name', i.development_name),
         project_name       = coalesce(i.pending_patch->>'project_name', i.project_name),
         address_line       = coalesce(i.pending_patch->>'address_line', i.address_line),
         suburb             = coalesce(i.pending_patch->>'suburb', i.suburb),
         state              = coalesce(i.pending_patch->>'state', i.state),
         postcode           = coalesce(i.pending_patch->>'postcode', i.postcode),
         lot_number         = coalesce(i.pending_patch->>'lot_number', i.lot_number),
         unit_number        = coalesce(i.pending_patch->>'unit_number', i.unit_number),
         bedrooms           = coalesce((i.pending_patch->>'bedrooms')::numeric, i.bedrooms),
         bathrooms          = coalesce((i.pending_patch->>'bathrooms')::numeric, i.bathrooms),
         car_spaces         = coalesce((i.pending_patch->>'car_spaces')::numeric, i.car_spaces),
         property_type      = coalesce(i.pending_patch->>'property_type', i.property_type),
         land_size_sqm      = coalesce((i.pending_patch->>'land_size_sqm')::numeric, i.land_size_sqm),
         building_size_sqm  = coalesce((i.pending_patch->>'building_size_sqm')::numeric, i.building_size_sqm),
         price              = coalesce((i.pending_patch->>'price')::numeric, i.price),
         price_display      = coalesce(i.pending_patch->>'price_display', i.price_display),
         expected_completion= coalesce(i.pending_patch->>'expected_completion', i.expected_completion),
         description        = coalesce(i.pending_patch->>'description', i.description),
         availability_status= coalesce(i.pending_patch->>'availability_status', i.availability_status),
         builder_project_id = coalesce((i.pending_patch->>'builder_project_id')::uuid, i.builder_project_id),
         builder_unit_id    = coalesce((i.pending_patch->>'builder_unit_id')::uuid, i.builder_unit_id),
         source_row         = coalesce(i.pending_patch->'source_row', i.source_row),
         upload_id          = p_upload_id,
         last_seen_at       = now(),
         pending_patch      = NULL,
         pending_upload_id  = NULL,
         updated_at         = now()
   WHERE i.pending_upload_id = p_upload_id;
  GET DIAGNOSTICS v_patched = ROW_COUNT;

  -- 2. Promote this upload's staged rows.
  UPDATE public.builder_stock_items
     SET lifecycle_status = 'active', updated_at = now()
   WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';
  GET DIAGNOSTICS v_published = ROW_COUNT;

  -- 3. Archive what the superseded uploads still supply. Anything still
  --    carrying one of their ids is a property the new list did not contain.
  IF array_length(v_replaces, 1) IS NOT NULL THEN
    UPDATE public.builder_stock_items
       SET lifecycle_status = 'archived', updated_at = now()
     WHERE lifecycle_status = 'active'
       AND upload_id = ANY(v_replaces)
       AND upload_id <> p_upload_id;
    GET DIAGNOSTICS v_archived = ROW_COUNT;
  END IF;

  UPDATE public.builder_stock_uploads
     SET published_at = now(), updated_at = now()
   WHERE id = p_upload_id AND published_at IS NULL;

  RETURN jsonb_build_object(
    'published', true, 'promoted', v_published,
    'patched', v_patched, 'archived', v_archived);
END;
$$;

REVOKE ALL ON FUNCTION public.publish_builder_stock_upload(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_builder_stock_upload(uuid)
  TO postgres, service_role;


-- ── The scheduler counts staged work too ────────────────────────────────────
--
-- Same reason as the claim: a staged property owes work, and an engine that
-- retires while a replacement upload is still being processed would strand it
-- invisible for ever — the blank Marketplace this file exists to prevent,
-- reached from the other side.
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $tick$
DECLARE
  v_outstanding integer := 0;
  v_fallback integer := 0;
  v_item_work integer := 0;
  v_target integer;
  v_sanitization integer;
BEGIN
  SELECT marketplace_eligibility_version, image_sanitization_version
    INTO v_target, v_sanitization
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);
  v_sanitization := coalesce(v_sanitization, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
          OR coalesce(image_sanitization_settled_version, -1) < v_sanitization
          OR source_images_settled_version IS NULL);

  SELECT count(*) INTO v_fallback
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND enrichment_status IN ('pending', 'enriching');

  SELECT count(*) INTO v_item_work
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND image_work_stage <> 'settled';

  IF v_outstanding + v_fallback + v_item_work = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  PERFORM public.cron_invoke_signed_function(
    'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
END;
$tick$;

REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;
