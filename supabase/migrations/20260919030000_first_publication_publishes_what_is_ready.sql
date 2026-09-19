-- ============================================================================
-- BUILDER STOCK — A FIRST STOCK LIST IS NOT HELD HOSTAGE BY ONE BAD ROW
--
-- THE PROBLEM, measured on the 18 September import. 47 properties imported,
-- 46 earned a ready builder-source photograph, and ONE — Lot 1037 Vanta 20 —
-- carries a brochure and a stage plan whose covers both name `Lot 1307
-- Fuchsia Street`, a SIBLING property. That is a genuine builder-source
-- deficiency: nothing in this pipeline can fix it and nothing in this
-- pipeline should pretend to. The publication invariant is strict and
-- correct, so the whole list stayed staged and the builder's marketplace
-- showed ZERO properties because one row of 47 had bad data.
--
-- Zero is the wrong answer to that. Forty-six correct properties are being
-- withheld to punish one incorrect one, and the builder has no way to see
-- any of their work until they fix a row they may not even be able to fix.
--
-- WHAT DOES NOT CHANGE, and this is most of the migration's value:
--
--   • THE PHOTOGRAPH RULE. A property goes live only with a primary that is
--     an `uploaded_document` / `source_supplied` / `ready` image. Identical
--     three conditions, no new state, nothing relaxed. Image identity, role
--     and marketplace eligibility are untouched — this decides WHICH READY
--     ROWS MAY GO, never what "ready" means.
--   • ATOMIC CUTOVER FOR A REPLACEMENT. An upload that supersedes a live
--     list still publishes all-or-nothing. That protection exists because a
--     partial promotion there leaves the marketplace showing some rows from
--     the new generation beside some from the old, and it is kept exactly.
--   • A PENDING ASSET OR A FAILED ENUMERATION STILL BLOCKS EVERYTHING. A
--     truncated read of the builder's own list is not a list with some rows
--     missing; it is a list we cannot vouch for, and neither path publishes
--     from one.
--
-- THE RULE. An upload that SUPERSEDES NOTHING, whose image work has finished,
-- and which earned at least one ready property, publishes THE READY ONES. The
-- rest stay staged, in `Action Required`, waiting on the builder.
--
-- WHY "SUPERSEDES NOTHING" AND NOT "THE ORGANISATION HAS NO LIVE ROWS". The
-- second reading is the obvious one and it is a trap: it FLIPS the moment the
-- first partial publication makes rows active. The builder then fixes their
-- last property, it settles ready — and publication refuses it, because the
-- upload has become a "replacement" of itself. `replaces_upload_ids` is
-- written once at import and never changes, so the mode is a fact about the
-- upload for its whole life. (And an upload that supersedes nothing has no
-- predecessor generation to mix with, which is the thing atomic cutover
-- protects.)
--
-- Idempotent: every statement is re-runnable.
-- ============================================================================

-- ============================================================================
-- 1. The photograph rule, stated ONCE
--
-- These three conditions were written out in full in three places —
-- `builder_stock_publication_readiness`, `builder_stock_image_progress` and
-- (from this migration) the promote step. Three copies of one rule is how two
-- of them come to disagree, and this one decides whether a property is on the
-- marketplace. It is a scalar over the images table so the set-based callers
-- keep their shape.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_photo_is_source_ready(p_image_id uuid)
RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.builder_stock_item_images AS im
     WHERE im.id = p_image_id
       AND im.source_stage        = 'uploaded_document'
       AND im.verification_status = 'source_supplied'
       AND im.processing_status   = 'ready');
$$;

COMMENT ON FUNCTION public.builder_stock_photo_is_source_ready(uuid) IS
  'The publication photograph rule, in one place: a primary image counts only when it is the builder''s own, from their own document, and ready to draw. NULL (no primary) answers false. Nothing may relax these three conditions to make a property publishable.';

REVOKE ALL ON FUNCTION public.builder_stock_photo_is_source_ready(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_photo_is_source_ready(uuid) TO service_role;

-- ============================================================================
-- 2. Readiness gains a dimension. The `ready` column is UNCHANGED — the strict
--    all-or-nothing answer every existing caller reads. What is added is the
--    second question: is this a first publication, and is there anything in it
--    that could go live?
--
--    Columns are ADDED, never reordered or removed: every caller names its
--    columns (`SELECT staged, source_outstanding, ... INTO`) or reads into a
--    `record`, so adding is safe.
-- ============================================================================

DROP FUNCTION IF EXISTS public.builder_stock_publication_readiness(uuid);

CREATE FUNCTION public.builder_stock_publication_readiness(p_upload_id uuid)
RETURNS TABLE(
  staged bigint,
  source_outstanding bigint,
  missing_primary bigint,
  failed_items bigint,
  ready boolean,
  ready_items bigint,
  first_publication boolean,
  partial_ready boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH upload AS (
    SELECT u.id,
           coalesce(array_length(u.replaces_upload_ids, 1), 0) = 0 AS first_publication,
           u.source_manifest_state
      FROM public.builder_stock_uploads AS u
     WHERE u.id = p_upload_id
  ),
  scope AS (
    SELECT i.*
      FROM public.builder_stock_items AS i
     WHERE (i.upload_id = p_upload_id AND i.lifecycle_status = 'staged')
        -- A matched property waiting only on its held-back patch counts too.
        OR (i.pending_upload_id = p_upload_id)
  ),
  counts AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (
        WHERE s.lifecycle_status = 'staged' AND s.image_work_stage = 'source'
      ) AS source_outstanding,
      count(*) FILTER (
        WHERE s.image_work_stage NOT IN ('settled', 'failed')
      ) AS open_work,
      count(*) FILTER (WHERE s.image_work_stage = 'failed') AS failed_items,
      count(*) FILTER (
        WHERE NOT public.builder_stock_photo_is_source_ready(s.primary_image_id)
      ) AS missing_primary,
      /*
       * A property that may go live ON ITS OWN: the ladder finished for it AND
       * it holds a ready builder-source photograph. Exactly the conjunction
       * `ready` asserts over every row, asked of one row.
       */
      count(*) FILTER (
        WHERE s.image_work_stage = 'settled'
          AND public.builder_stock_photo_is_source_ready(s.primary_image_id)
      ) AS ready_items
    FROM scope AS s
  ),
  gates AS (
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.builder_stock_source_assets a
         WHERE a.upload_id = p_upload_id AND a.state = 'pending') AS assets_settled,
      NOT EXISTS (
        SELECT 1 FROM public.builder_stock_uploads u
         WHERE u.id = p_upload_id AND u.source_manifest_state = 'failed') AS manifest_ok
  )
  SELECT
    c.total AS staged,
    c.source_outstanding,
    c.missing_primary,
    c.failed_items,
    /*
     * THE INVARIANT, UNCHANGED: publication of the WHOLE list requires every
     * scoped property settled, none failed, every primary a ready
     * builder-source photograph, and no manifest asset still owed. 49 ready
     * and 1 failed is NOT a publishable LIST. There is no legacy branch.
     */
    c.total > 0
      AND c.open_work = 0
      AND c.failed_items = 0
      AND c.missing_primary = 0
      AND g.assets_settled
      AND g.manifest_ok
    AS ready,
    c.ready_items,
    coalesce(u.first_publication, false) AS first_publication,
    /*
     * AND THE SECOND ANSWER. A first list publishes the properties that
     * earned their photograph once the work has FINISHED — never while rows
     * are still climbing the ladder, because a marketplace whose count creeps
     * for ten minutes is not a list going live, it is a list being watched.
     * The two truncation gates bind here exactly as above: a list we could
     * not fully read is not a list with some rows missing.
     */
    coalesce(u.first_publication, false)
      AND c.open_work = 0
      AND c.ready_items > 0
      AND g.assets_settled
      AND g.manifest_ok
    AS partial_ready
  FROM counts AS c
  CROSS JOIN gates AS g
  LEFT JOIN upload AS u ON true;
$$;

COMMENT ON FUNCTION public.builder_stock_publication_readiness(uuid) IS
  'ready ⟺ every scoped item is settled with a READY builder-source primary photograph, no item failed, no manifest asset pending, enumeration not failed — the all-or-nothing answer, unchanged, and the only one a REPLACEMENT upload may publish on. partial_ready ⟺ this upload supersedes nothing, its image work has finished, at least one property earned its photograph, and neither truncation gate is open — a FIRST list publishes what is ready and leaves the rest staged.';

REVOKE ALL ON FUNCTION public.builder_stock_publication_readiness(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_publication_readiness(uuid) TO service_role;

-- ============================================================================
-- 3. Progress reads the shared rule rather than its own copy of it
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_image_progress(p_organisation_id uuid)
RETURNS TABLE(
  upload_id uuid,
  total bigint,
  photos_ready bigint,
  failed bigint,
  working bigint,
  manifest_state text,
  failure_state text,
  blocked_reason text,
  published boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    u.id AS upload_id,
    count(i.id) AS total,
    count(i.id) FILTER (
      WHERE public.builder_stock_photo_is_source_ready(i.primary_image_id)
    ) AS photos_ready,
    count(i.id) FILTER (WHERE i.image_work_stage = 'failed') AS failed,
    count(i.id) FILTER (
      WHERE i.image_work_stage NOT IN ('settled', 'failed')
    ) AS working,
    u.source_manifest_state AS manifest_state,
    u.image_failure_state AS failure_state,
    u.publication_blocked_reason AS blocked_reason,
    u.published_at IS NOT NULL AS published
  FROM public.builder_stock_uploads AS u
  LEFT JOIN public.builder_stock_items AS i
    ON (i.upload_id = u.id OR i.pending_upload_id = u.id)
   AND i.lifecycle_status IN ('active', 'staged')
  WHERE u.organisation_id = p_organisation_id
    AND u.deleted_at IS NULL
    AND (u.published_at IS NULL OR u.updated_at > now() - interval '2 days')
  GROUP BY u.id, u.source_manifest_state, u.image_failure_state,
           u.publication_blocked_reason, u.published_at, u.created_at
  ORDER BY u.created_at DESC;
$$;

COMMENT ON FUNCTION public.builder_stock_image_progress(uuid) IS
  'The truthful aggregate behind "Processing property photos — X of Y ready": real counts from real item state, per recent upload of one organisation. photos_ready reads builder_stock_photo_is_source_ready, the one statement of the publication photograph rule — a Street View or web image never counts as a photo here.';

REVOKE ALL ON FUNCTION public.builder_stock_image_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_progress(uuid) TO service_role;

-- ============================================================================
-- 4. publish: one promote rule, two ways of earning it
--
-- The promote step now filters on the PER-ITEM photograph rule. For a
-- replacement upload that filter is a no-op and the behaviour is provably
-- unchanged: `ready` asserts, over every scoped row, that the ladder finished
-- AND nothing failed AND every primary is a ready builder-source photograph —
-- so every staged row of a ready upload satisfies the filter and all of them
-- promote, exactly as the unfiltered UPDATE did.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload(p_upload_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ready boolean;
  v_partial boolean;
  v_first boolean;
  v_staged bigint;
  v_outstanding bigint;
  v_missing bigint;
  v_failed bigint;
  v_ready_items bigint;
  v_replaces uuid[];
  v_published integer := 0;
  v_archived integer := 0;
  v_patched integer := 0;
  v_withheld integer := 0;
  v_deleted timestamptz;
  v_already timestamptz;
  v_reason text;
  v_mode text;
BEGIN
  SELECT deleted_at, published_at INTO v_deleted, v_already
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  -- A deleted upload is not a stock list, and a superseded one is somebody's
  -- abandoned draft. Neither may move the Marketplace. Asked BEFORE the
  -- already-published branch, because a late promotion must answer to them too.
  IF v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'deleted');
  END IF;

  IF public.builder_stock_upload_superseded(p_upload_id) THEN
    RETURN jsonb_build_object('published', false, 'reason', 'superseded');
  END IF;

  SELECT staged, source_outstanding, missing_primary, failed_items,
         ready, ready_items, first_publication, partial_ready
    INTO v_staged, v_outstanding, v_missing, v_failed,
         v_ready, v_ready_items, v_first, v_partial
    FROM public.builder_stock_publication_readiness(p_upload_id);

  /*
   * ALREADY PUBLISHED IS NOT ALWAYS NOTHING LEFT TO DO.
   *
   * A first publication leaves the un-ready properties staged, so the case
   * this branch used to swallow is the one that matters most: the builder
   * goes and fixes the row the list told them about, it settles with their
   * own photograph, `publishUploadIfReady` is called on the next completed
   * item — and the answer was `already_published`, for ever. The property
   * they had just repaired would never reach the marketplace and nothing
   * anywhere would say why.
   *
   * Only for a FIRST publication. A published replacement has no staged rows
   * left (its cutover promoted all of them) and must never grow a second one.
   */
  IF v_already IS NOT NULL THEN
    IF NOT coalesce(v_first, false) THEN
      RETURN jsonb_build_object('published', false, 'reason', 'already_published');
    END IF;

    UPDATE public.builder_stock_items
       SET lifecycle_status = 'active', updated_at = now()
     WHERE upload_id = p_upload_id
       AND lifecycle_status = 'staged'
       AND image_work_stage = 'settled'
       AND public.builder_stock_photo_is_source_ready(primary_image_id);
    GET DIAGNOSTICS v_published = ROW_COUNT;

    IF v_published = 0 THEN
      RETURN jsonb_build_object('published', false, 'reason', 'already_published');
    END IF;

    SELECT count(*) INTO v_withheld
      FROM public.builder_stock_items
     WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';

    v_reason := CASE WHEN v_withheld > 0 THEN format(
      '%s of %s properties are live; %s still needs a photograph from you',
      coalesce(v_staged, 0) - v_withheld, coalesce(v_staged, 0), v_withheld) END;
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason,
           image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END,
           updated_at = now()
     WHERE id = p_upload_id;

    BEGIN
      PERFORM public.record_portal_operational_event(
        'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
        'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
        jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                           'withheld', v_withheld, 'mode', 'late'));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- telemetry must never fail a cutover
    END;

    RETURN jsonb_build_object(
      'published', true, 'mode', 'late', 'promoted', v_published,
      'patched', 0, 'archived', 0, 'withheld', v_withheld);
  END IF;

  IF coalesce(v_ready, false) THEN
    v_mode := 'atomic';
  ELSIF coalesce(v_partial, false) THEN
    v_mode := 'first_publication';
  ELSE
    /*
     * REFUSED, AND THE REASON SAYS WHICH KIND OF REFUSAL IT IS. A first list
     * with nothing ready yet is a different sentence from a replacement
     * holding back for one bad row, and an operator reading the upload row
     * should not have to infer which.
     */
    v_reason := CASE
      WHEN coalesce(v_first, false) AND coalesce(v_ready_items, 0) = 0 THEN format(
        'awaiting source photographs: no property of %s has a ready builder-source photo yet, %s failed, %s still reading their source',
        coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0))
      ELSE format(
        'awaiting source photographs: %s of %s properties without a ready builder-source photo, %s failed, %s still reading their source',
        coalesce(v_missing, 0), coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0))
    END;
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason, updated_at = now()
     WHERE id = p_upload_id
       AND publication_blocked_reason IS DISTINCT FROM v_reason;
    RETURN jsonb_build_object(
      'published', false, 'reason', 'not_ready',
      'staged', coalesce(v_staged, 0), 'source_outstanding', coalesce(v_outstanding, 0),
      'missing_primary', coalesce(v_missing, 0), 'failed_items', coalesce(v_failed, 0),
      'ready_items', coalesce(v_ready_items, 0),
      'first_publication', coalesce(v_first, false));
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
   * mass assignment through a jsonb door.
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

  /*
   * 2. Promote this upload's staged rows THAT EARNED THEIR PHOTOGRAPH.
   *
   * Under `atomic` this filter is satisfied by every staged row — that is
   * what `ready` means — so a replacement's cutover is byte-for-byte the
   * behaviour it has always had. Under `first_publication` it is the whole
   * point: 46 go live and the one whose documents name somebody else's
   * property stays staged, in Action Required, where the builder can see it.
   */
  UPDATE public.builder_stock_items
     SET lifecycle_status = 'active', updated_at = now()
   WHERE upload_id = p_upload_id
     AND lifecycle_status = 'staged'
     AND image_work_stage = 'settled'
     AND public.builder_stock_photo_is_source_ready(primary_image_id);
  GET DIAGNOSTICS v_published = ROW_COUNT;

  SELECT count(*) INTO v_withheld
    FROM public.builder_stock_items
   WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';

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

  /*
   * THE BLOCKED REASON STAYS HONEST, AND `image_failure_state` STAYS SET.
   *
   * A first publication that withheld rows is published AND still owes the
   * builder something. Clearing both — as the atomic path rightly does when
   * it publishes everything — would take away the only thing on the Stock
   * List telling them a property of theirs is not on the marketplace.
   */
  UPDATE public.builder_stock_uploads
     SET published_at = now(),
         publication_blocked_reason = CASE WHEN v_withheld > 0 THEN format(
           '%s of %s properties are live; %s still needs a photograph from you',
           v_published, coalesce(v_staged, 0), v_withheld) END,
         image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END,
         updated_at = now()
   WHERE id = p_upload_id AND published_at IS NULL;

  BEGIN
    PERFORM public.record_portal_operational_event(
      'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
      'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
      jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                         'patched', v_patched, 'archived', v_archived,
                         'withheld', v_withheld, 'mode', v_mode));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- telemetry must never fail a cutover
  END;

  RETURN jsonb_build_object(
    'published', true, 'mode', v_mode, 'promoted', v_published,
    'patched', v_patched, 'archived', v_archived, 'withheld', v_withheld);
END;
$$;

COMMENT ON FUNCTION public.publish_builder_stock_upload(uuid) IS
  'Promotes an upload''s staged properties that hold a ready builder-source photograph. mode=atomic is the all-or-nothing cutover every REPLACEMENT upload answers to, unchanged. mode=first_publication publishes what is ready from a list that supersedes nothing and leaves the rest staged. mode=late promotes a property a builder repaired after their first list went live — the case `already_published` used to swallow for ever.';

-- ============================================================================
-- 5. The watchdog keeps watching a list that went live with rows held back
--
-- Its upload-level surfacing loop filtered on `published_at IS NULL`, which
-- was the same question as "is anything still owed" right up until this
-- migration. It is not any more: a first publication sets `published_at` and
-- leaves the un-ready properties staged, so the old filter would drop exactly
-- the uploads that still owe their builder something — and this loop is the
-- only thing that pages a person when one goes wrong later.
--
-- Everything else in the function is byte-identical to the 2026-09-15
-- definition: the lease reclaim, the archived-row close, the blank re-open,
-- the terminal failure and the two telemetry blocks are untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_image_watchdog() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_reclaimed integer := 0;
  v_archived_closed integer := 0;
  v_reopened integer := 0;
  v_terminal integer := 0;
  v_attention integer := 0;
  v_upload record;
  v_ready boolean;
  v_missing bigint;
  v_failed bigint;
  v_state text;
  v_reason text;
BEGIN
  /*
   * a) A lease that expired is a worker that DIED — the one case the old
   *    claim-time backoff was designed for, now handled where the evidence
   *    is. Real failure: counted, bounded backoff, claim cleared.
   */
  UPDATE public.builder_stock_items AS i
     SET image_work_claim_until = NULL,
         image_work_failures = i.image_work_failures + 1,
         image_work_next_attempt_at = now() + public.builder_stock_failure_backoff(i.image_work_failures + 1),
         image_work_last_error = left('worker lease expired without completion; reclaimed by watchdog', 500),
         image_work_updated_at = now()
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND i.image_work_stage <> ALL (ARRAY['settled', 'failed'])
     AND i.image_work_claim_until IS NOT NULL
     AND i.image_work_claim_until < now() - interval '30 seconds';
  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

  /*
   * b) An archived row owes no image work: archiving closed its ladder.
   *    511 archived rows were sitting in non-settled stages — never claimable
   *    (the claim requires active/staged) yet impossible to distinguish from
   *    a backlog. Close them.
   */
  UPDATE public.builder_stock_items
     SET image_work_stage = 'settled',
         image_work_claim_until = NULL,
         image_work_updated_at = now()
   WHERE lifecycle_status = 'archived'
     AND image_work_stage <> 'settled';
  GET DIAGNOSTICS v_archived_closed = ROW_COUNT;

  /*
   * c) A SERVED-OR-STAGED PROPERTY SETTLED BLANK IS NEVER FINISHED. Whatever
   *    wrote 'settled' with no primary image converted our failure into "no
   *    photograph", which the product forbids. Re-open it — bounded: each
   *    reopen is a counted failure, and at the twelfth the item moves to
   *    'failed' (d below) where a person can see it, instead of churning.
   */
  UPDATE public.builder_stock_items AS i
     SET image_work_stage = 'source',
         enrichment_status = 'pending',
         image_work_failures = i.image_work_failures + 1,
         image_work_next_attempt_at = now(),
         image_work_claim_until = NULL,
         image_work_updated_at = now()
   WHERE i.id IN (
     SELECT c.id FROM public.builder_stock_items AS c
      WHERE c.lifecycle_status IN ('active', 'staged')
        AND c.image_work_stage = 'settled'
        AND c.primary_image_id IS NULL
        AND c.image_work_failures < 12
        AND c.image_work_updated_at < now() - interval '10 minutes'
      ORDER BY c.image_work_updated_at
      LIMIT 500
   );
  GET DIAGNOSTICS v_reopened = ROW_COUNT;

  UPDATE public.builder_stock_items AS i
     SET image_work_stage = 'failed',
         image_work_claim_until = NULL,
         image_work_last_result = left('image processing exhausted after repeated failures; requires intervention', 200),
         image_work_updated_at = now()
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND i.image_work_stage = 'settled'
     AND i.primary_image_id IS NULL
     AND i.image_work_failures >= 12;
  GET DIAGNOSTICS v_terminal = ROW_COUNT;

  /*
   * d) Upload-level surfacing: an invariant upload stuck unpublished gets an
   *    honest state a person and an alert can act on. Events fire only on a
   *    TRANSITION, never every minute.
   */
  FOR v_upload IN
    SELECT u.id, u.image_failure_state
      FROM public.builder_stock_uploads AS u
     WHERE u.deleted_at IS NULL
       AND u.image_invariant
       AND u.created_at < now() - interval '10 minutes'
       /*
        * PUBLISHED IS NO LONGER THE SAME AS FINISHED. A first publication
        * puts the ready properties on the marketplace and leaves the rest
        * staged, so `published_at IS NULL` would drop exactly the uploads
        * that still owe their builder something — and this loop is what
        * pages a person when one of them goes wrong later.
        */
       AND (u.published_at IS NULL OR EXISTS (
         SELECT 1 FROM public.builder_stock_items i
          WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'))
       AND NOT public.builder_stock_upload_superseded(u.id)
  LOOP
    SELECT ready, missing_primary, failed_items
      INTO v_ready, v_missing, v_failed
      FROM public.builder_stock_publication_readiness(v_upload.id);
    IF coalesce(v_ready, false) THEN
      CONTINUE;
    END IF;
    /*
     * A published-and-settled upload owes nothing even though `ready` is
     * false for it: once its ready rows went live they left the staged
     * scope, so readiness answers about what REMAINS. Without this, a
     * finished first publication would be flagged `attention` for ever.
     */
    IF NOT EXISTS (
      SELECT 1 FROM public.builder_stock_items i
       WHERE i.upload_id = v_upload.id AND i.lifecycle_status = 'staged') THEN
      CONTINUE;
    END IF;
    v_state := CASE WHEN coalesce(v_failed, 0) > 0 THEN 'failed' ELSE 'attention' END;
    IF v_state IS DISTINCT FROM v_upload.image_failure_state THEN
      v_attention := v_attention + 1;
      v_reason := format('%s properties without a ready builder-source photo, %s failed',
                         coalesce(v_missing, 0), coalesce(v_failed, 0));
      UPDATE public.builder_stock_uploads
         SET image_failure_state = v_state,
             publication_blocked_reason = coalesce(publication_blocked_reason, v_reason),
             updated_at = now()
       WHERE id = v_upload.id;
      BEGIN
        PERFORM public.record_portal_operational_event(
          'builder_stock_publication_blocked',
          CASE WHEN v_state = 'failed' THEN 'critical' ELSE 'high' END,
          gen_random_uuid(), NULL, 'system', NULL, 'builder', NULL, NULL, NULL,
          NULL, false,
          jsonb_build_object('upload_id', v_upload.id, 'state', v_state, 'reason', v_reason));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END LOOP;

  IF v_reclaimed > 0 OR v_terminal > 0 THEN
    BEGIN
      PERFORM public.record_portal_operational_event(
        'builder_stock_image_watchdog_intervened',
        CASE WHEN v_terminal > 0 THEN 'high' ELSE 'warning' END,
        gen_random_uuid(), NULL, 'system', NULL, 'builder', NULL, NULL, NULL,
        NULL, false,
        jsonb_build_object('reclaimed_leases', v_reclaimed, 'reopened_blank', v_reopened,
                           'terminal_failed', v_terminal, 'archived_closed', v_archived_closed));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'reclaimed_leases', v_reclaimed,
    'archived_closed', v_archived_closed,
    'reopened_blank', v_reopened,
    'terminal_failed', v_terminal,
    'uploads_flagged', v_attention);
END;
$$;


-- ============================================================================
-- 6. Post-migration assertions — shapes, not hopes
--
-- Every one of these runs the REAL functions against REAL rows and rolls
-- back. Reading the source would prove the text says the right thing; only
-- execution proves the rules hold. That is the same discipline the retention
-- purge and the verification self-test answer to: asserted by effect, never
-- by configuration.
-- ============================================================================

DO $$
DECLARE
  v_org uuid; v_first uuid; v_second uuid; v_replacement uuid;
  v_good uuid; v_bad uuid; v_third uuid; v_gated uuid; v_gated_item uuid;
  v_failed_upload uuid; v_ok_item uuid; v_fail_item uuid;
  v_blank_upload uuid; v_late_upload uuid;
  v_late_ok uuid; v_late_fixed uuid; v_late_never uuid; v_late_failed uuid;
  v_derived_upload uuid; v_derived_item uuid;
  v_unverified_item uuid; v_demoted_item uuid;
  v_img uuid;
  v_r record; v_res jsonb;
  v_active bigint; v_staged bigint;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('First Publication Proof Org', 'builder', 'active', true, now())
  RETURNING id INTO v_org;

  -- ------------------------------------------------------------------
  -- A FIRST LIST: one good property, one whose documents name somebody
  -- else's house. This is the 18 September shape, at 2 instead of 47.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'first.csv', 'proof/first.csv', 'enriching') RETURNING id INTO v_first;

  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_first, 'staged', '1 Good Street', 'Truganina') RETURNING id INTO v_good;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_first, 'staged', '2 Bad Source Street', 'Truganina') RETURNING id INTO v_bad;

  -- NOTHING READY YET, AND STILL WORKING: neither path may publish.
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_first);
  IF v_r.ready OR v_r.partial_ready OR NOT v_r.first_publication THEN
    RAISE EXCEPTION 'a first list published while its work was outstanding (ready %, partial %, first %)',
      v_r.ready, v_r.partial_ready, v_r.first_publication;
  END IF;
  v_res := public.publish_builder_stock_upload(v_first);
  IF (v_res->>'published')::boolean THEN
    RAISE EXCEPTION 'a first list with no ready property published (%)', v_res;
  END IF;

  -- The good one earns a real builder-source photograph; the bad one fails.
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_good, v_first, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/good.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_good;
  UPDATE public.builder_stock_items
     SET image_work_stage = 'failed' WHERE id = v_bad;

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_first);
  IF v_r.ready THEN
    RAISE EXCEPTION 'the strict invariant passed a list with a failed property';
  END IF;
  IF NOT v_r.partial_ready OR v_r.ready_items <> 1 THEN
    RAISE EXCEPTION 'a first list with one ready property did not offer a first publication (partial %, ready_items %)',
      v_r.partial_ready, v_r.ready_items;
  END IF;

  v_res := public.publish_builder_stock_upload(v_first);
  IF NOT (v_res->>'published')::boolean
     OR v_res->>'mode' <> 'first_publication'
     OR (v_res->>'promoted')::int <> 1
     OR (v_res->>'withheld')::int <> 1 THEN
    RAISE EXCEPTION 'the first publication did not publish exactly the ready property (%)', v_res;
  END IF;

  -- THE PHOTOGRAPH RULE HELD: the bad row is still staged, not on the market.
  SELECT count(*) FILTER (WHERE lifecycle_status = 'active'),
         count(*) FILTER (WHERE lifecycle_status = 'staged')
    INTO v_active, v_staged
    FROM public.builder_stock_items WHERE upload_id = v_first;
  IF v_active <> 1 OR v_staged <> 1 THEN
    RAISE EXCEPTION 'first publication moved the wrong rows (active %, staged %)', v_active, v_staged;
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_bad) <> 'staged' THEN
    RAISE EXCEPTION 'a property with no builder-source photograph reached the marketplace';
  END IF;

  -- AND THE BUILDER IS STILL TOLD. Publishing part of a list must not clear
  -- the only thing on the page saying a property of theirs is held back.
  IF (SELECT publication_blocked_reason FROM public.builder_stock_uploads WHERE id = v_first) IS NULL THEN
    RAISE EXCEPTION 'a partial publication cleared the reason the builder reads';
  END IF;

  -- ------------------------------------------------------------------
  -- THE BUILDER FIXES IT. The row settles with their own picture and must
  -- reach the marketplace — the case `already_published` used to swallow.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_bad, v_first, 'uploaded_document', 'builder-supplied:proof/fixed.jpg',
     'source_supplied', 'ready', 'proof/fixed.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_bad;

  v_res := public.publish_builder_stock_upload(v_first);
  IF NOT (v_res->>'published')::boolean
     OR v_res->>'mode' <> 'late'
     OR (v_res->>'promoted')::int <> 1
     OR (v_res->>'withheld')::int <> 0 THEN
    RAISE EXCEPTION 'a repaired property did not reach the marketplace (%)', v_res;
  END IF;
  IF (SELECT publication_blocked_reason FROM public.builder_stock_uploads WHERE id = v_first) IS NOT NULL THEN
    RAISE EXCEPTION 'the list is complete and still says something is owed';
  END IF;

  -- ASKING AGAIN WITH NOTHING LEFT IS STILL `already_published`.
  v_res := public.publish_builder_stock_upload(v_first);
  IF (v_res->>'published')::boolean OR v_res->>'reason' <> 'already_published' THEN
    RAISE EXCEPTION 'a finished list published a second time (%)', v_res;
  END IF;

  -- ------------------------------------------------------------------
  -- A REPLACEMENT UPLOAD IS UNCHANGED: all or nothing, however many of its
  -- properties are ready. This is the protection the whole migration must
  -- not weaken.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status, replaces_upload_ids)
  VALUES (v_org, 'second.csv', 'proof/second.csv', 'enriching', ARRAY[v_first])
  RETURNING id INTO v_replacement;

  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_replacement, 'staged', '3 Replacement Way', 'Truganina') RETURNING id INTO v_second;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_replacement, 'staged', '4 Replacement Way', 'Truganina') RETURNING id INTO v_third;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_second, v_replacement, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/second.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_second;
  UPDATE public.builder_stock_items
     SET image_work_stage = 'failed' WHERE id = v_third;

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_replacement);
  IF v_r.first_publication THEN
    RAISE EXCEPTION 'an upload that supersedes a live list called itself a first publication';
  END IF;
  IF v_r.partial_ready THEN
    RAISE EXCEPTION 'a replacement offered a partial publication (ready_items %)', v_r.ready_items;
  END IF;
  v_res := public.publish_builder_stock_upload(v_replacement);
  IF (v_res->>'published')::boolean OR v_res->>'reason' <> 'not_ready' THEN
    RAISE EXCEPTION 'a replacement upload with a failed property published (%)', v_res;
  END IF;
  -- The live list it would replace is untouched: nothing was archived.
  IF (SELECT count(*) FROM public.builder_stock_items
       WHERE upload_id = v_first AND lifecycle_status = 'active') <> 2 THEN
    RAISE EXCEPTION 'a refused replacement disturbed the live stock list';
  END IF;

  -- And once every property of it is ready, it cuts over atomically.
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_third, v_replacement, 'uploaded_document', 'brochure#page2',
     'source_supplied', 'ready', 'proof/third.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_third;

  v_res := public.publish_builder_stock_upload(v_replacement);
  IF NOT (v_res->>'published')::boolean
     OR v_res->>'mode' <> 'atomic'
     OR (v_res->>'promoted')::int <> 2
     OR (v_res->>'archived')::int <> 2 THEN
    RAISE EXCEPTION 'the replacement cutover was not atomic (%)', v_res;
  END IF;

  -- ------------------------------------------------------------------
  -- A PICTURE THAT IS NOT FROM THE BUILDER'S OWN DOCUMENT IS NOT A
  -- PUBLICATION PHOTOGRAPH.
  --
  -- `source_stage` is the condition that separates the builder's own
  -- brochure page from a Street View still or a web image, and it is the one
  -- a well-meaning relaxation reaches for first. Every other property in
  -- this proof carries `uploaded_document`, so without this case dropping
  -- that condition changes nothing observable.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'derived.csv', 'proof/derived.csv', 'enriching') RETURNING id INTO v_derived_upload;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_derived_upload, 'staged', '14 Streetview Street', 'Truganina') RETURNING id INTO v_derived_item;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, external_url)
  VALUES (v_org, v_derived_item, v_derived_upload, 'google_maps', 'streetview',
     'source_supplied', 'ready', 'https://example.invalid/streetview.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_derived_item;

  IF public.builder_stock_photo_is_source_ready(v_img) THEN
    RAISE EXCEPTION 'an image from outside the builder''s own document passed the photograph rule';
  END IF;

  /*
   * THE OTHER TWO CONDITIONS, EACH ON A PROPERTY OF ITS OWN. All three are
   * one `AND`, so a proof where every image satisfies all three cannot tell
   * which of them is load-bearing — dropping any one would change nothing
   * observable and the rule would be asserted only in appearance.
   */
  -- Out of the builder's document, but this platform has not established it
  -- is the builder's own statement about the property.
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_derived_upload, 'staged', '15 Unverified Way', 'Truganina') RETURNING id INTO v_unverified_item;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_unverified_item, v_derived_upload, 'uploaded_document', 'brochure#page4',
     'unverified', 'ready', 'proof/unverified.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_unverified_item;
  IF public.builder_stock_photo_is_source_ready(v_img) THEN
    RAISE EXCEPTION 'an unverified image passed the photograph rule';
  END IF;

  /*
   * AND `unavailable` IS NOT `ready`, which is not a hypothetical condition.
   * On 19 Sep 2026 every builder-supplied picture in production was demoted
   * to exactly this status by the source repair, and the property it led
   * retired blank. A publication rule that accepted anything short of
   * `ready` would have put those blank cards on the marketplace instead.
   */
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_derived_upload, 'staged', '16 Demoted Drive', 'Truganina') RETURNING id INTO v_demoted_item;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_demoted_item, v_derived_upload, 'uploaded_document', 'builder-supplied:proof/demoted.jpg',
     'source_supplied', 'unavailable', 'proof/demoted.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_demoted_item;
  IF public.builder_stock_photo_is_source_ready(v_img) THEN
    RAISE EXCEPTION 'an image this pipeline could not vouch for passed the photograph rule';
  END IF;

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_derived_upload);
  IF v_r.ready OR v_r.partial_ready OR v_r.ready_items <> 0 OR v_r.missing_primary <> 3 THEN
    RAISE EXCEPTION 'a property led by an image short of the rule was treated as photographed (ready %, partial %, ready_items %, missing %)',
      v_r.ready, v_r.partial_ready, v_r.ready_items, v_r.missing_primary;
  END IF;
  v_res := public.publish_builder_stock_upload(v_derived_upload);
  IF (v_res->>'published')::boolean THEN
    RAISE EXCEPTION 'a property led by a location-derived image published (%)', v_res;
  END IF;

  -- ------------------------------------------------------------------
  -- A LIST WHOSE PROPERTIES ALL SETTLED BLANK PUBLISHES NOTHING.
  --
  -- `ready_items` must count the PHOTOGRAPH, not merely the end of the
  -- ladder. Counting settled rows alone would make `partial_ready` true for
  -- a list with nothing publishable in it — publication would then stamp
  -- `published_at`, promote zero properties, and leave a builder with a
  -- list that calls itself live and shows nobody anything.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'blank.csv', 'proof/blank.csv', 'enriching') RETURNING id INTO v_blank_upload;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_blank_upload, 'staged', '8 Blank Boulevard', 'Truganina', 'settled');
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_blank_upload, 'staged', '9 Blank Boulevard', 'Truganina', 'settled');

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_blank_upload);
  IF v_r.ready_items <> 0 THEN
    RAISE EXCEPTION 'a settled property with no photograph was counted as ready (ready_items %)', v_r.ready_items;
  END IF;
  IF v_r.partial_ready THEN
    RAISE EXCEPTION 'a list with nothing publishable in it was offered a first publication';
  END IF;
  v_res := public.publish_builder_stock_upload(v_blank_upload);
  IF (v_res->>'published')::boolean THEN
    RAISE EXCEPTION 'a list of blank properties published (%)', v_res;
  END IF;
  IF (SELECT published_at FROM public.builder_stock_uploads WHERE id = v_blank_upload) IS NOT NULL THEN
    RAISE EXCEPTION 'a refused list was stamped published';
  END IF;

  -- ------------------------------------------------------------------
  -- THE LATE PROMOTION ANSWERS TO THE PHOTOGRAPH RULE TOO.
  --
  -- It is a second promote step and therefore a second chance to get the
  -- rule wrong. Proved with a list where a repaired property and an
  -- unrepaired one are staged together: exactly one may move.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'late.csv', 'proof/late.csv', 'enriching') RETURNING id INTO v_late_upload;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_late_upload, 'staged', '10 Late Lane', 'Truganina') RETURNING id INTO v_late_ok;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_late_upload, 'staged', '11 Late Lane', 'Truganina', 'settled') RETURNING id INTO v_late_fixed;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_late_upload, 'staged', '12 Late Lane', 'Truganina', 'settled') RETURNING id INTO v_late_never;
  -- The pipeline gave up on this one, and it HOLDS a ready picture. That is
  -- the only shape that separates "settled" from "failed" in the promote
  -- filter; without it, widening the late promotion to failed rows changes
  -- nothing observable and the rule is not actually asserted.
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_late_upload, 'staged', '13 Late Lane', 'Truganina', 'failed') RETURNING id INTO v_late_failed;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_late_failed, v_late_upload, 'uploaded_document', 'brochure#page9',
     'source_supplied', 'ready', 'proof/late-failed.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img WHERE id = v_late_failed;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_late_ok, v_late_upload, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/late-ok.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_late_ok;

  v_res := public.publish_builder_stock_upload(v_late_upload);
  IF (v_res->>'promoted')::int <> 1 OR (v_res->>'withheld')::int <> 3 THEN
    RAISE EXCEPTION 'the first publication of the late-promotion list was wrong (%)', v_res;
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_late_failed) <> 'staged' THEN
    RAISE EXCEPTION 'a first publication published a property the pipeline gave up on';
  END IF;

  -- One of the two held-back properties is repaired. The other is not.
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_late_fixed, v_late_upload, 'uploaded_document', 'builder-supplied:proof/late-fixed.jpg',
     'source_supplied', 'ready', 'proof/late-fixed.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img WHERE id = v_late_fixed;

  v_res := public.publish_builder_stock_upload(v_late_upload);
  IF v_res->>'mode' <> 'late'
     OR (v_res->>'promoted')::int <> 1
     OR (v_res->>'withheld')::int <> 2 THEN
    RAISE EXCEPTION 'the late promotion moved the wrong number of properties (%)', v_res;
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_late_failed) <> 'staged' THEN
    RAISE EXCEPTION 'the late promotion published a property the pipeline gave up on';
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_late_never) <> 'staged' THEN
    RAISE EXCEPTION 'the late promotion published a property with no photograph';
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_late_fixed) <> 'active' THEN
    RAISE EXCEPTION 'the late promotion left a repaired property staged';
  END IF;
  IF (SELECT publication_blocked_reason FROM public.builder_stock_uploads WHERE id = v_late_upload) IS NULL THEN
    RAISE EXCEPTION 'a late promotion that still holds a property back cleared the builder''s reason';
  END IF;

  -- ------------------------------------------------------------------
  -- A FAILED PROPERTY BLOCKS THE STRICT INVARIANT ON ITS OWN.
  --
  -- Asserted with a property that HOLDS a ready builder-source photograph
  -- and is still marked failed, because that is the only way to separate the
  -- two conditions. Everywhere else in this proof a failed property also has
  -- no picture, so `missing_primary` catches it and `failed_items` is never
  -- the reason — a mutation removing `failed_items = 0` from `ready` passed
  -- the whole suite. "49 ready and 1 failed is not publishable" needs the
  -- 1 to be failed for some reason other than the picture.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'failed.csv', 'proof/failed.csv', 'enriching') RETURNING id INTO v_failed_upload;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_failed_upload, 'staged', '6 Photographed Place', 'Truganina') RETURNING id INTO v_ok_item;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_failed_upload, 'staged', '7 Photographed Place', 'Truganina') RETURNING id INTO v_fail_item;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_ok_item, v_failed_upload, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/ok.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_ok_item;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_fail_item, v_failed_upload, 'uploaded_document', 'brochure#page2',
     'source_supplied', 'ready', 'proof/failed-but-pictured.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'failed' WHERE id = v_fail_item;

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_failed_upload);
  IF v_r.missing_primary <> 0 OR v_r.failed_items <> 1 THEN
    RAISE EXCEPTION 'the failed-with-a-photograph control is not the shape it claims (missing %, failed %)',
      v_r.missing_primary, v_r.failed_items;
  END IF;
  IF v_r.ready THEN
    RAISE EXCEPTION 'the strict invariant passed a list holding a failed property';
  END IF;

  -- The first-publication path still offers the ONE that settled, and never
  -- the failed one — a property the pipeline gave up on is not live stock
  -- however good its picture looks.
  IF NOT v_r.partial_ready OR v_r.ready_items <> 1 THEN
    RAISE EXCEPTION 'a first list did not offer its one settled property (partial %, ready_items %)',
      v_r.partial_ready, v_r.ready_items;
  END IF;
  v_res := public.publish_builder_stock_upload(v_failed_upload);
  IF (v_res->>'promoted')::int <> 1 OR (v_res->>'withheld')::int <> 1 THEN
    RAISE EXCEPTION 'a failed property with a photograph was published (%)', v_res;
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_fail_item) <> 'staged' THEN
    RAISE EXCEPTION 'a property the pipeline gave up on reached the marketplace';
  END IF;

  -- ------------------------------------------------------------------
  -- THE TRUNCATION GATES BIND BOTH PATHS. A list we could not fully read
  -- is not a list with some rows missing.
  --
  -- ON ITS OWN UPLOAD, and that is the point. The first version of this
  -- asserted the gate against `v_first` AFTER both its properties had been
  -- promoted — so the staged scope was empty, `ready_items` was 0, and
  -- `partial_ready` was false for a reason that had nothing to do with the
  -- manifest. A mutation that removed both gates from the partial path
  -- passed it. The gate needs a list that WOULD otherwise publish.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'gated.csv', 'proof/gated.csv', 'enriching') RETURNING id INTO v_gated;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_gated, 'staged', '5 Gated Grove', 'Truganina') RETURNING id INTO v_gated_item;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_gated_item, v_gated, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/gated.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_gated_item;

  -- It would publish: one ready property, work finished, supersedes nothing.
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_gated);
  IF NOT v_r.partial_ready OR NOT v_r.ready THEN
    RAISE EXCEPTION 'the gate control did not stand up (partial %, ready %)', v_r.partial_ready, v_r.ready;
  END IF;

  -- A FAILED ENUMERATION closes both answers.
  UPDATE public.builder_stock_uploads SET source_manifest_state = 'failed' WHERE id = v_gated;
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_gated);
  IF v_r.partial_ready OR v_r.ready THEN
    RAISE EXCEPTION 'a list whose enumeration failed was offered publication (partial %, ready %)',
      v_r.partial_ready, v_r.ready;
  END IF;
  v_res := public.publish_builder_stock_upload(v_gated);
  IF (v_res->>'published')::boolean THEN
    RAISE EXCEPTION 'a list whose enumeration failed published (%)', v_res;
  END IF;
  UPDATE public.builder_stock_uploads SET source_manifest_state = 'complete' WHERE id = v_gated;

  -- A PENDING SOURCE ASSET closes both answers too: a document of theirs is
  -- still owed, so this list is not yet the list they gave us.
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_gated, v_org, v_gated_item, 'row_branch', 'document', 'proof/pending.pdf', 'pending');
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_gated);
  IF v_r.partial_ready OR v_r.ready THEN
    RAISE EXCEPTION 'a list still owing a source asset was offered publication (partial %, ready %)',
      v_r.partial_ready, v_r.ready;
  END IF;
  v_res := public.publish_builder_stock_upload(v_gated);
  IF (v_res->>'published')::boolean THEN
    RAISE EXCEPTION 'a list still owing a source asset published (%)', v_res;
  END IF;

  -- And with both gates clear it publishes, which proves the two refusals
  -- above were the gates and not some other absence.
  UPDATE public.builder_stock_source_assets SET state = 'stored' WHERE upload_id = v_gated;
  v_res := public.publish_builder_stock_upload(v_gated);
  IF NOT (v_res->>'published')::boolean OR (v_res->>'promoted')::int <> 1 THEN
    RAISE EXCEPTION 'the gated list did not publish once its gates cleared (%)', v_res;
  END IF;

  -- A nonexistent upload is refused outright by both answers.
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(gen_random_uuid());
  IF v_r.ready OR v_r.partial_ready THEN
    RAISE EXCEPTION 'readiness answered yes for an upload that does not exist';
  END IF;

  RAISE EXCEPTION 'proof complete — rolling back' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'proof complete — rolling back' THEN RAISE; END IF;
END $$;

-- The photograph rule answers false for a property with no primary at all,
-- which is the reading every caller depends on.
DO $$
BEGIN
  IF public.builder_stock_photo_is_source_ready(NULL) THEN
    RAISE EXCEPTION 'the photograph rule passed a property with no primary image';
  END IF;
  IF public.builder_stock_photo_is_source_ready(gen_random_uuid()) THEN
    RAISE EXCEPTION 'the photograph rule passed an image that does not exist';
  END IF;
END $$;
