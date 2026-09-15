-- ============================================================================
-- BUILDER STOCK: THE SOURCE-PHOTOGRAPH INVARIANT
--
-- Every Builder Stock list contains photographs. A property whose card is
-- blank is therefore never "a property with no photo" — it is a property
-- whose photo OUR pipeline failed to obtain. This migration makes the
-- database state that truth instead of hiding it:
--
--   1. "No photo obtained" stops being a successful terminal state. Items
--      gain a real-failure counter and a terminal 'failed' work stage that is
--      DISTINCT from 'settled': settled means done WITH a photograph; failed
--      means our processing is exhausted and a person must look.
--   2. The claim RPC stops punishing orchestration. The old claim wrote
--      exponential backoff (30·2^n s, capped at an hour) AT CLAIM TIME, so a
--      worker killed by the runtime pushed a HEALTHY property 32 minutes into
--      the future. Measured in production on 2026-09-15: six properties spent
--      ~25 minutes cycling deferrals and stalls before settling blank. The
--      lease now carries exclusivity alone; failure backoff is written only
--      by an explicit failure completion or by the watchdog reclaiming an
--      expired lease, and it is bounded at FIVE minutes, not an hour.
--   3. Publication readiness for uploads created from here on requires 100%
--      builder-source photo coverage: every scoped item settled, none failed,
--      every primary_image_id pointing at a READY image whose provenance is
--      the builder's own source (uploaded_document / source_supplied). The
--      readiness gate is scoped by uploads.image_invariant purely as a
--      deployment safety: existing in-flight uploads keep the old rule until
--      the historical recovery flips them, and the flip is the recovery's
--      final act. The end state is universal.
--   4. Client visibility is enforced at the database boundary NOW, for all
--      rows old and new: builder_stock_item_client_visible() is the single
--      predicate, and builder_stock_publications refuses to offer a
--      connection any item that lacks a ready builder-source photograph.
--      The builder's own portal list is deliberately NOT gated — that is the
--      remediation surface — but nothing blank can be offered outward.
--   5. A durable source-asset manifest (builder_stock_source_assets) exists
--      for the workers to enumerate a source ONCE per upload and consume it
--      per item, instead of re-downloading and re-parsing the whole document
--      per item per attempt (measured: a Notion source re-read ~9 s per item
--      forever; a Drive package re-listed per claim).
--   6. A watchdog runs inside the existing settlement tick: it reclaims
--      expired leases, closes archived strands (511 archived rows were
--      sitting in non-settled stages, permanently off-queue but counted as
--      outstanding), re-opens settled-blank items that still owe source
--      work, terminates repeat offenders into 'failed', stamps upload-level
--      attention/failure states, and emits operational events so operations
--      hears before the builder does.
--   7. Dispatch stops being cron-serial: the tick and a new kick RPC fan out
--      bounded signed invocations derived from the claimable backlog. Cron
--      remains the watchdog and the guarantee; it is no longer the throughput.
--
-- Everything here is idempotent. Nothing here deletes or rewrites a
-- property, an image row, a selection or an announcement.
-- ============================================================================

-- ============================================================================
-- 1. Items: real-failure accounting and the 'failed' terminal stage
-- ============================================================================

ALTER TABLE public.builder_stock_items
  ADD COLUMN IF NOT EXISTS image_work_failures integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.builder_stock_items.image_work_failures IS
  'Real image-work failures only: an explicit failure completion, or a lease the watchdog had to reclaim because the worker died. Orchestration deferrals and clean handbacks never touch it. Drives the bounded (≤5 min) retry backoff and the ≥12 terminal ceiling; image_work_attempts remains the claim counter and is observability only.';

DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'public.builder_stock_items'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ~ 'image_work_stage';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.builder_stock_items DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE public.builder_stock_items
  ADD CONSTRAINT builder_stock_items_image_work_stage_check CHECK (
    image_work_stage = ANY (ARRAY['source', 'eligibility', 'sanitization', 'fallback', 'settled', 'failed']));

COMMENT ON CONSTRAINT builder_stock_items_image_work_stage_check
  ON public.builder_stock_items IS
  'settled = the ladder finished (with a photograph, for invariant uploads). failed = image processing is exhausted and requires intervention: the property is NOT client-visible and its upload is NOT publishable. failed is never reached by "the document names no photo" — only by our own processing giving out.';

-- The queue index must stop offering terminal rows.
DROP INDEX IF EXISTS public.builder_stock_items_image_work_queue_idx;
CREATE INDEX builder_stock_items_image_work_queue_idx
  ON public.builder_stock_items (image_work_next_attempt_at, id)
  WHERE lifecycle_status = ANY (ARRAY['active', 'staged'])
    AND image_work_stage <> ALL (ARRAY['settled', 'failed']);

-- ============================================================================
-- 2. Uploads: manifest bookkeeping, failure surfacing, and the rollout scope
-- ============================================================================

ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS source_manifest_state text NOT NULL DEFAULT 'pending'
    CHECK (source_manifest_state IN ('pending', 'enumerating', 'complete', 'failed')),
  ADD COLUMN IF NOT EXISTS source_manifest_cursor jsonb,
  ADD COLUMN IF NOT EXISTS image_failure_state text NOT NULL DEFAULT 'none'
    CHECK (image_failure_state IN ('none', 'attention', 'failed')),
  ADD COLUMN IF NOT EXISTS publication_blocked_reason text,
  ADD COLUMN IF NOT EXISTS image_invariant boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.builder_stock_uploads.image_invariant IS
  'TEMPORARY rollout scoping for the 100% source-photo publication gate, nothing more. Uploads existing before 20260915200000 are backfilled false so an in-flight legacy import is not stranded mid-publish; every new upload is true. The historical recovery job flips the remainder true as its final act — the end state is one universal invariant, with no grandfathered rows. Client visibility (builder_stock_item_client_visible) is NOT scoped by this column and is universal from this migration onward.';

COMMENT ON COLUMN public.builder_stock_uploads.source_manifest_state IS
  'Whether builder_stock_source_assets holds the complete enumeration of this upload''s source. pending = not started; enumerating = chunked enumeration in progress (source_manifest_cursor is the durable continuation); complete = every discoverable asset is manifested; failed = enumeration itself failed and the upload cannot publish under the invariant.';

COMMENT ON COLUMN public.builder_stock_uploads.publication_blocked_reason IS
  'Why publish_builder_stock_upload last refused this upload, in operator-readable form. Cleared on successful publication. This is the answer to "why is this stock list not published?" without reverse-engineering item rows.';

-- Everything that exists AT APPLY TIME keeps the legacy publication rule
-- until the historical recovery flips it: every row present now predates the
-- corrected pipeline by definition. The migration ledger guarantees this file
-- applies exactly once, so the now() cutoff cannot demote later uploads.
UPDATE public.builder_stock_uploads AS u
   SET image_invariant = false
 WHERE u.image_invariant = true
   AND u.created_at < now();

-- ============================================================================
-- 3. The durable source-asset manifest
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.builder_stock_source_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.builder_stock_uploads(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  stock_item_id uuid REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('embedded_media', 'row_branch')),
  reference text NOT NULL,
  branch_kind text CHECK (branch_kind IS NULL OR branch_kind IN
    ('direct_image', 'drive_file', 'drive_folder', 'document', 'unsupported')),
  source_anchor text,
  column_header text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending', 'stored', 'no_image', 'unreadable', 'unsupported', 'failed')),
  state_detail text,
  image_id uuid REFERENCES public.builder_stock_item_images(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  content_sha256 text,
  byte_size bigint,
  enumerated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The same brochure URL may legitimately serve several rows; the same
  -- embedded part may be attributed to nobody (stock_item_id NULL) until the
  -- anchors resolve. One manifest row per (upload, item, kind, reference).
  UNIQUE NULLS NOT DISTINCT (upload_id, stock_item_id, kind, reference)
);

COMMENT ON TABLE public.builder_stock_source_assets IS
  'The durable manifest of everything the builder''s uploaded source supplies: every embedded media part and every row-linked branch, enumerated ONCE per upload and consumed per item. Replaces re-downloading and re-parsing the whole source document per item per attempt. state=pending is OWED WORK and blocks publication under the invariant; no_image is a genuinely inspected "this asset presents no photograph for this row" (a floor plan, a logo); unreadable/failed are OUR faults and are never converted into "no photograph exists". unsupported records a URL shape we do not traverse, visibly, instead of silently dropping it from evidence.';

CREATE INDEX IF NOT EXISTS builder_stock_source_assets_upload_state_idx
  ON public.builder_stock_source_assets (upload_id, state);
CREATE INDEX IF NOT EXISTS builder_stock_source_assets_item_idx
  ON public.builder_stock_source_assets (stock_item_id)
  WHERE state = 'pending';

DROP TRIGGER IF EXISTS builder_stock_source_assets_touch ON public.builder_stock_source_assets;
CREATE TRIGGER builder_stock_source_assets_touch
  BEFORE UPDATE ON public.builder_stock_source_assets
  FOR EACH ROW EXECUTE FUNCTION public.builder_stock_touch_updated_at();

ALTER TABLE public.builder_stock_source_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_stock_source_assets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_stock_source_assets TO service_role;

-- ============================================================================
-- 4. The claim stops punishing; completion learns to name a failure
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_builder_stock_image_work(
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 120,
  p_organisation_id uuid DEFAULT NULL::uuid
) RETURNS SETOF public.builder_stock_items
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  UPDATE public.builder_stock_items AS i
     SET image_work_claim_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         /*
          * The attempts counter is OBSERVABILITY (and the workers' branch
          * rotation index), never punishment. The old claim also wrote
          * image_work_next_attempt_at = now() + 30·2^attempts here, which
          * meant a worker killed by the runtime — through no fault of the
          * property — parked a healthy row for up to an hour. Exclusivity is
          * the lease's job; backoff is a FAILURE'S consequence, written by
          * complete_builder_stock_image_work(p_failed => true) or by the
          * watchdog reclaiming an expired lease, and bounded at five minutes.
          */
         image_work_attempts = i.image_work_attempts + 1,
         image_work_updated_at = now()
   WHERE i.id IN (
     SELECT c.id
       FROM public.builder_stock_items AS c
      -- STAGED ROWS ARE PROCESSED. They are invisible to the Marketplace and
      -- must still reach readiness, or a replacement upload could never
      -- publish and its properties would be stranded unseen for ever.
      WHERE c.lifecycle_status IN ('active', 'staged')
        AND c.image_work_stage <> ALL (ARRAY['settled', 'failed'])
        AND c.image_work_next_attempt_at <= now()
        AND (c.image_work_claim_until IS NULL OR c.image_work_claim_until < now())
        AND (p_organisation_id IS NULL OR c.organisation_id = p_organisation_id)
      ORDER BY c.image_work_next_attempt_at, c.id
      LIMIT greatest(coalesce(p_limit, 1), 0)
        FOR UPDATE SKIP LOCKED
   )
  RETURNING i.*;
$$;

-- The bounded failure backoff, in one place so the completion RPC and the
-- watchdog cannot drift apart: failure n waits 30·2^(n−1) seconds capped at
-- five minutes — 30s, 60s, 120s, 240s, then flat 300s. Never the hour.
CREATE OR REPLACE FUNCTION public.builder_stock_failure_backoff(p_failures integer)
RETURNS interval
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT make_interval(secs => least(
    30 * power(2, least(greatest(coalesce(p_failures, 1), 1) - 1, 4))::integer, 300));
$$;

-- The completion RPC gains p_failed. The old six-argument overload is DROPPED
-- rather than kept beside it: PostgREST cannot disambiguate two functions
-- whose named arguments are a subset of each other, and every existing caller
-- names its arguments — they all resolve against this one via the default.
DROP FUNCTION IF EXISTS public.complete_builder_stock_image_work(uuid, text, text, text, integer, boolean);

CREATE FUNCTION public.complete_builder_stock_image_work(
  p_item_id uuid,
  p_next_stage text DEFAULT NULL::text,
  p_result text DEFAULT NULL::text,
  p_error text DEFAULT NULL::text,
  p_retry_after_seconds integer DEFAULT 0,
  p_reset_attempts boolean DEFAULT false,
  p_failed boolean DEFAULT false
) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  UPDATE public.builder_stock_items AS i
     SET image_work_stage = coalesce(p_next_stage, i.image_work_stage),
         /*
          * A RESUMABLE STEP THAT PROGRESSED MUST NOT ACCUMULATE BACKOFF.
          * The claim counter clears on stage progress or an explicit reset,
          * exactly as before. What is NEW is the failure ledger below: only
          * an explicit p_failed=true completion raises it, and any completion
          * that moved the item to a different stage clears it — a property
          * that progressed has proven the fault behind it.
          */
         image_work_attempts = CASE
           WHEN coalesce(p_reset_attempts, false) THEN 0
           WHEN p_next_stage IS NOT NULL AND p_next_stage IS DISTINCT FROM i.image_work_stage
             THEN 0
           ELSE i.image_work_attempts
         END,
         image_work_failures = CASE
           WHEN coalesce(p_failed, false) THEN i.image_work_failures + 1
           WHEN p_next_stage IS NOT NULL AND p_next_stage IS DISTINCT FROM i.image_work_stage
             THEN 0
           ELSE i.image_work_failures
         END,
         image_work_claim_until = NULL,
         image_work_next_attempt_at = CASE
           WHEN coalesce(p_failed, false)
             THEN now() + greatest(
               make_interval(secs => greatest(coalesce(p_retry_after_seconds, 0), 0)),
               public.builder_stock_failure_backoff(i.image_work_failures + 1))
           ELSE now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 0), 0))
         END,
         image_work_last_result = left(p_result, 200),
         image_work_last_error = left(p_error, 500),
         image_work_updated_at = now()
   WHERE i.id = p_item_id
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.claim_builder_stock_image_work(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.claim_builder_stock_image_work(integer, integer, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.complete_builder_stock_image_work(uuid, text, text, text, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.complete_builder_stock_image_work(uuid, text, text, text, integer, boolean, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_failure_backoff(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_failure_backoff(integer) TO service_role;

-- The pending counter must not count terminal rows, or the tick would never
-- fall idle and the dispatcher would start workers with nothing claimable.
CREATE OR REPLACE FUNCTION public.builder_stock_image_work_pending()
RETURNS TABLE(claimable bigint, outstanding bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    count(*) FILTER (
      WHERE i.image_work_next_attempt_at <= now()
        AND (i.image_work_claim_until IS NULL OR i.image_work_claim_until < now())
    ) AS claimable,
    count(*) AS outstanding
  FROM public.builder_stock_items AS i
  WHERE i.lifecycle_status IN ('active', 'staged')
    AND i.image_work_stage <> ALL (ARRAY['settled', 'failed']);
$$;

-- ============================================================================
-- 5. Client visibility: one predicate, enforced at the outward boundary
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_item_client_visible(p_item_id uuid)
RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.builder_stock_items AS i
      JOIN public.builder_stock_item_images AS im ON im.id = i.primary_image_id
     WHERE i.id = p_item_id
       AND i.lifecycle_status = 'active'
       AND im.source_stage = 'uploaded_document'
       AND im.verification_status = 'source_supplied'
       AND im.processing_status = 'ready'
  );
$$;

COMMENT ON FUNCTION public.builder_stock_item_client_visible(uuid) IS
  'THE universal Builder Stock visibility invariant: a stock item may be shown to anybody outside the owning builder''s own portal only while it is active AND its primary image is a READY photograph from the builder''s own source (uploaded_document / source_supplied). Street View, web-search imagery and blank cards never satisfy it. The builder''s own list deliberately still shows non-qualifying items — that is the remediation surface — but no outward surface may. Every future externally-serving read path must filter through this predicate; the publications trigger below enforces it at the one outward boundary that exists today.';

CREATE OR REPLACE FUNCTION public.builder_stock_publications_require_source_image()
RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- Withdrawing is always allowed — refusing a withdrawal would pin a
  -- non-qualifying item LIVE, the opposite of the invariant.
  IF NEW.withdrawn_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.builder_stock_item_client_visible(NEW.stock_item_id) THEN
    RAISE EXCEPTION 'STOCK_ITEM_NOT_CLIENT_VISIBLE: item % has no ready builder-source photograph and may not be offered to a connection', NEW.stock_item_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_stock_publications_source_image ON public.builder_stock_publications;
CREATE TRIGGER builder_stock_publications_source_image
  BEFORE INSERT OR UPDATE ON public.builder_stock_publications
  FOR EACH ROW EXECUTE FUNCTION public.builder_stock_publications_require_source_image();

-- ============================================================================
-- 6. Publication readiness: 100% coverage for invariant uploads
-- ============================================================================

DROP FUNCTION IF EXISTS public.builder_stock_publication_readiness(uuid);

CREATE FUNCTION public.builder_stock_publication_readiness(p_upload_id uuid)
RETURNS TABLE(staged bigint, source_outstanding bigint, missing_primary bigint, failed_items bigint, ready boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH scope AS (
    SELECT i.*
      FROM public.builder_stock_items AS i
     WHERE (i.upload_id = p_upload_id AND i.lifecycle_status = 'staged')
        -- A MATCHED PROPERTY WAITING ONLY ON ITS PATCH COUNTS TOO — see the
        -- original readiness rule's comment; the scope is unchanged.
        OR (i.pending_upload_id = p_upload_id)
  ),
  strictness AS (
    SELECT coalesce(
      (SELECT u.image_invariant FROM public.builder_stock_uploads u WHERE u.id = p_upload_id),
      true) AS strict
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
        WHERE NOT EXISTS (
          SELECT 1 FROM public.builder_stock_item_images im
           WHERE im.id = s.primary_image_id
             AND im.source_stage = 'uploaded_document'
             AND im.verification_status = 'source_supplied'
             AND im.processing_status = 'ready'
        )
      ) AS missing_primary
    FROM scope AS s
  )
  SELECT
    c.total AS staged,
    c.source_outstanding,
    c.missing_primary,
    c.failed_items,
    CASE WHEN (SELECT strict FROM strictness) THEN
      /*
       * THE INVARIANT: publication requires every scoped property settled,
       * none failed, every primary a ready builder-source photograph, and no
       * manifest asset still owed. 49 ready and 1 failed is NOT publishable.
       */
      c.total > 0
        AND c.open_work = 0
        AND c.failed_items = 0
        AND c.missing_primary = 0
        AND NOT EXISTS (
          SELECT 1 FROM public.builder_stock_source_assets a
           WHERE a.upload_id = p_upload_id AND a.state = 'pending')
        AND NOT EXISTS (
          SELECT 1 FROM public.builder_stock_uploads u
           WHERE u.id = p_upload_id AND u.source_manifest_state = 'failed')
    ELSE
      -- The legacy rule, verbatim, for pre-invariant uploads until the
      -- historical recovery retires them.
      c.total > 0 AND c.source_outstanding = 0
    END AS ready
  FROM counts AS c;
$$;

COMMENT ON FUNCTION public.builder_stock_publication_readiness(uuid) IS
  'ready ⟺ (invariant uploads) every scoped item is settled with a READY builder-source primary photograph, no item failed, no manifest asset pending, enumeration not failed; (legacy uploads, temporary) no staged item still at stage source. The strict branch is the product contract: a stock list below 100% source-photo coverage stays staged.';

-- ============================================================================
-- 7. publish: same cutover, but a refusal now says WHY on the upload row
-- ============================================================================

CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload(p_upload_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ready boolean;
  v_staged bigint;
  v_outstanding bigint;
  v_missing bigint;
  v_failed bigint;
  v_replaces uuid[];
  v_published integer := 0;
  v_archived integer := 0;
  v_patched integer := 0;
  v_deleted timestamptz;
  v_already timestamptz;
  v_reason text;
BEGIN
  SELECT deleted_at, published_at INTO v_deleted, v_already
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  IF v_already IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'already_published');
  END IF;

  -- A deleted upload is not a stock list, and a superseded one is somebody's
  -- abandoned draft. Neither may move the Marketplace.
  IF v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'deleted');
  END IF;

  IF public.builder_stock_upload_superseded(p_upload_id) THEN
    RETURN jsonb_build_object('published', false, 'reason', 'superseded');
  END IF;

  SELECT staged, source_outstanding, missing_primary, failed_items, ready
    INTO v_staged, v_outstanding, v_missing, v_failed, v_ready
    FROM public.builder_stock_publication_readiness(p_upload_id);

  IF NOT coalesce(v_ready, false) THEN
    v_reason := format(
      'awaiting source photographs: %s of %s properties without a ready builder-source photo, %s failed, %s still reading their source',
      coalesce(v_missing, 0), coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0));
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason, updated_at = now()
     WHERE id = p_upload_id
       AND publication_blocked_reason IS DISTINCT FROM v_reason;
    RETURN jsonb_build_object(
      'published', false, 'reason', 'not_ready',
      'staged', coalesce(v_staged, 0), 'source_outstanding', coalesce(v_outstanding, 0),
      'missing_primary', coalesce(v_missing, 0), 'failed_items', coalesce(v_failed, 0));
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
     SET published_at = now(),
         publication_blocked_reason = NULL,
         image_failure_state = 'none',
         updated_at = now()
   WHERE id = p_upload_id AND published_at IS NULL;

  BEGIN
    PERFORM public.record_portal_operational_event(
      'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
      'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
      jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                         'patched', v_patched, 'archived', v_archived));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- telemetry must never fail a cutover
  END;

  RETURN jsonb_build_object(
    'published', true, 'promoted', v_published,
    'patched', v_patched, 'archived', v_archived);
END;
$$;

-- ============================================================================
-- 8. The watchdog
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
     WHERE u.published_at IS NULL
       AND u.deleted_at IS NULL
       AND u.image_invariant
       AND u.created_at < now() - interval '10 minutes'
       AND NOT public.builder_stock_upload_superseded(u.id)
  LOOP
    SELECT ready, missing_primary, failed_items
      INTO v_ready, v_missing, v_failed
      FROM public.builder_stock_publication_readiness(v_upload.id);
    IF coalesce(v_ready, false) THEN
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

COMMENT ON FUNCTION public.builder_stock_image_watchdog() IS
  'Self-healing for the image pipeline, run by every settlement tick: reclaims expired worker leases (a real failure, bounded backoff — never an hour), closes archived strands, re-opens served/staged properties that settled blank (bounded at 12 counted failures, then terminal ''failed'' where a person can see it), and stamps upload-level attention/failed states with operational events on transition. There is no state in which "the worker died, therefore this property stays Finding a picture forever".';

-- ============================================================================
-- 9. Dispatch: the backlog starts workers; cron guarantees them
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_dispatch_image_workers(p_max integer DEFAULT 2)
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_claimable bigint;
  v_n integer;
  i integer;
BEGIN
  SELECT claimable INTO v_claimable FROM public.builder_stock_image_work_pending();
  IF coalesce(v_claimable, 0) = 0 THEN
    RETURN 0;
  END IF;
  -- Each invocation works a small batch; ceil(claimable/2) invocations keeps
  -- start latency low without starting more isolates than the backlog needs.
  -- Six is the ceiling whatever the backlog: memory ceilings are per-isolate
  -- and a backlog is a reason to work steadily, not to stampede.
  v_n := least(greatest(coalesce(p_max, 0), 0), 6, ceil(v_claimable / 2.0)::integer);
  IF v_n <= 0 THEN
    RETURN 0;
  END IF;
  BEGIN
    FOR i IN 1..v_n LOOP
      PERFORM public.cron_invoke_signed_function(
        'builder-stock-image-settler', '{}'::jsonb, 'dispatch');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- Dispatch is the ACCELERATOR, never the guarantee: the every-minute tick
    -- reaches the same queue. A missing vault entry or pg_net hiccup must not
    -- fail an import or a tick.
    RETURN 0;
  END;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_stock_kick_image_work(p_upload_id uuid DEFAULT NULL)
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  -- Arm the watchdog cadence first — the kick may fire on a cold system whose
  -- idle tick unscheduled itself — then burst up to six workers immediately,
  -- so a six-property upload starts six-wide now instead of one-per-tick.
  PERFORM public.ensure_builder_stock_settlement_scheduled();
  RETURN public.builder_stock_dispatch_image_workers(6);
END;
$$;

COMMENT ON FUNCTION public.builder_stock_kick_image_work(uuid) IS
  'Called by the import path (and the link-recovery callback) the moment work exists: re-arms the settlement schedule and fans out up to six signed settler invocations sized to the claimable backlog. Cron is thereby demoted to watchdog and recovery; normal throughput no longer waits a minute per pair of workers.';

REVOKE ALL ON FUNCTION public.builder_stock_image_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_watchdog() TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_dispatch_image_workers(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_dispatch_image_workers(integer) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_kick_image_work(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_kick_image_work(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_item_client_visible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_item_client_visible(uuid) TO service_role;

-- ============================================================================
-- 10. The tick: watchdog first, derived dispatch, terminal rows not counted
-- ============================================================================

CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_target integer;
  v_sanitization integer;
  v_provenance integer;
  v_outstanding integer;
  v_fallback integer;
  v_item_work integer;
  v_publications integer;
  v_upload_completion integer;
  v_blocked integer;
BEGIN
  PERFORM public.builder_stock_image_watchdog();
  PERFORM public.publish_ready_builder_stock_uploads();
  PERFORM public.reopen_builder_stock_stranded_items();
  -- And the properties a superseded worker failed on, which the sibling above
  -- cannot see: it reopens on a changed ladder, this on a changed runtime.
  PERFORM public.reopen_builder_stock_runtime_failures();

  SELECT marketplace_eligibility_version, image_sanitization_version,
         source_images_version
    INTO v_target, v_sanitization, v_provenance
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);
  v_sanitization := coalesce(v_sanitization, 0);
  v_provenance := coalesce(v_provenance, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
          OR coalesce(image_sanitization_settled_version, -1) < v_sanitization
          -- WAS `source_images_settled_version IS NULL`. An upload re-read
          -- under an older extractor is outstanding in exactly the way an
          -- upload never read is, and only the second was countable.
          OR coalesce(source_images_settled_version, -1) < v_provenance);

  SELECT count(*) INTO v_fallback
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND enrichment_status IN ('pending', 'enriching');

  SELECT count(*) INTO v_item_work
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND image_work_stage <> ALL (ARRAY['settled', 'failed']);

  v_publications := public.builder_stock_publications_pending();

  SELECT count(*) INTO v_upload_completion
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status IN ('enriching', 'partially_complete')
     AND NOT EXISTS (
       SELECT 1
         FROM public.builder_stock_items it
        WHERE it.upload_id = u.id
          AND it.lifecycle_status = 'active'
          AND it.enrichment_status IN ('pending', 'enriching')
     );

  -- A blocked invariant upload keeps the tick alive so the watchdog keeps
  -- stamping and a fixed pipeline resumes work without anything re-arming it.
  SELECT count(*) INTO v_blocked
    FROM public.builder_stock_uploads u
   WHERE u.published_at IS NULL
     AND u.deleted_at IS NULL
     AND u.image_invariant
     AND NOT public.builder_stock_upload_superseded(u.id);

  IF v_outstanding + v_fallback + v_item_work + v_publications
     + v_upload_completion + v_blocked = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  -- Steady-state trickle: the tick tops the fleet up by at most two workers a
  -- minute; the import-time kick is what starts a fresh upload six-wide.
  PERFORM public.builder_stock_dispatch_image_workers(2);
END;
$$;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'Watchdog first, then publication and re-open sweeps, then a dispatch derived from the claimable backlog (≤2/min steady; the import-time kick handles bursts). Terminal ''failed'' items are deliberately NOT counted as work — they are a person''s queue — but a blocked invariant upload keeps the tick alive so recovery needs no re-arming.';

-- ============================================================================
-- 11. One schedule owner: the stale */5 copies route through ensure_()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_builder_stock_eligibility_target(p_version integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
DECLARE
  v_version integer;
BEGIN
  INSERT INTO public.builder_stock_settlement_target (id, marketplace_eligibility_version)
  VALUES (true, p_version)
  ON CONFLICT (id) DO UPDATE
    SET marketplace_eligibility_version =
          GREATEST(public.builder_stock_settlement_target.marketplace_eligibility_version,
                   EXCLUDED.marketplace_eligibility_version),
        updated_at = now()
  RETURNING marketplace_eligibility_version INTO v_version;

  -- Through the function that OWNS the schedule rather than a second copy of
  -- the cron string — two places naming a schedule is how this setter came to
  -- say */5 while the job actually runs every minute.
  PERFORM public.ensure_builder_stock_settlement_scheduled();

  RETURN v_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_builder_stock_sanitization_target(p_version integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
DECLARE
  v_version integer;
BEGIN
  INSERT INTO public.builder_stock_settlement_target (id, image_sanitization_version)
  VALUES (true, p_version)
  ON CONFLICT (id) DO UPDATE
    SET image_sanitization_version =
          GREATEST(public.builder_stock_settlement_target.image_sanitization_version,
                   EXCLUDED.image_sanitization_version),
        updated_at = now()
  RETURNING image_sanitization_version INTO v_version;

  PERFORM public.ensure_builder_stock_settlement_scheduled();

  RETURN v_version;
END;
$$;

-- ============================================================================
-- 12. Progress the frontend can tell the truth with
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
      WHERE EXISTS (
        SELECT 1 FROM public.builder_stock_item_images im
         WHERE im.id = i.primary_image_id
           AND im.source_stage = 'uploaded_document'
           AND im.verification_status = 'source_supplied'
           AND im.processing_status = 'ready')
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
  'The truthful aggregate behind "Processing property photos — X of Y ready": real counts from real item state, per recent upload of one organisation. photos_ready counts READY builder-source primaries only — a Street View or web image never counts as a photo here.';

REVOKE ALL ON FUNCTION public.builder_stock_image_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_progress(uuid) TO service_role;

-- ============================================================================
-- 13. Operations hears: the pipeline's abnormal events page somebody
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_portal_operational_event(_event_name text,_severity text,_correlation_id uuid,_request_id text,_actor_type text,_actor_id uuid,_portal text,_case_id uuid,_matter_id uuid,_firm_id uuid,_duration_ms integer,_success boolean,_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE e public.portal_operational_events%ROWTYPE; alert_name text; BEGIN
 IF _correlation_id IS NULL OR NULLIF(trim(_event_name),'') IS NULL OR NULLIF(trim(_actor_type),'') IS NULL OR NULLIF(trim(_portal),'') IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='OBSERVABILITY_DIMENSIONS_REQUIRED'; END IF;
 IF _severity NOT IN ('info','warning','high','critical') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVALID_EVENT_SEVERITY'; END IF;
 IF jsonb_path_exists(COALESCE(_metadata,'{}'), '$.**.keyvalue() ? (@.key like_regex "(?i)^(internal_notes|risk_notes|contract_text|raw_content|income|expenses|assets|liabilities|borrowing_capacity|smr|aml_restricted)$")') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SENSITIVE_TELEMETRY_FIELD_FORBIDDEN'; END IF;
 INSERT INTO public.portal_operational_events(event_name,severity,correlation_id,request_id,actor_type,actor_id,portal,case_id,matter_id,firm_id,duration_ms,success,metadata)
 VALUES(left(_event_name,120),_severity,_correlation_id,left(_request_id,200),left(_actor_type,80),_actor_id,left(_portal,80),_case_id,_matter_id,_firm_id,_duration_ms,_success,COALESCE(_metadata,'{}')) RETURNING * INTO e;
 alert_name:=CASE WHEN _event_name IN ('cross_firm_access_attempt','audit_chain_failure','mandatory_audit_write_failure','dead_lettered_settlement_event','document_malware_detected','client_projection_privacy_violation','cross_client_case_link_attempt','excessive_authentication_failures','builder_stock_publication_blocked','builder_stock_image_processing_failed','builder_stock_source_enumeration_failed') THEN _event_name END;
 IF alert_name IS NOT NULL THEN INSERT INTO public.portal_operational_alerts(event_id,alert_type,severity,summary) VALUES(e.id,alert_name,CASE WHEN _severity='critical' THEN 'critical' ELSE 'high' END,left(replace(alert_name,'_',' '),240)); END IF;
 RETURN e.id;
END $$;

-- ============================================================================
-- 14. Re-open what the old extractor wrongly closed
--
-- PROVENANCE_VERSION 24 → 25: the extractor gained direct-image ingestion
-- (a row's own linked JPG/PNG/WebP is now the property's photograph), so
-- every `no_deterministic_image` it banked — including "That link is an
-- image rather than a package document" — is stale by definition.
-- RUNTIME 3 → 4: the worker gained the bounded in-process election fallback
-- and honest folder-listing failures, so retirements caused by the OLD
-- runtime's unconfigured-worker starvation re-open too. The versioned
-- re-open machinery (negativeProvenanceStillStands, the reopen sweeps) does
-- the rest; nothing is hand-edited.
-- ============================================================================

SELECT public.set_builder_stock_source_images_target(25);

INSERT INTO public.builder_stock_settlement_target (id, image_runtime_version)
VALUES (true, 4)
ON CONFLICT (id) DO UPDATE
  SET image_runtime_version =
        GREATEST(public.builder_stock_settlement_target.image_runtime_version,
                 EXCLUDED.image_runtime_version),
      updated_at = now();

-- ============================================================================
-- 15. Post-migration assertions — shapes, not hopes
-- ============================================================================

DO $$
DECLARE
  v_missing bigint;
  v_ready boolean;
BEGIN
  -- The readiness function answers its extended shape even for an unknown id.
  SELECT missing_primary, ready INTO v_missing, v_ready
    FROM public.builder_stock_publication_readiness(gen_random_uuid());
  IF v_missing IS DISTINCT FROM 0 OR v_ready IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: readiness shape wrong for empty scope (missing=%, ready=%)', v_missing, v_ready;
  END IF;

  IF to_regprocedure('public.complete_builder_stock_image_work(uuid,text,text,text,integer,boolean,boolean)') IS NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: 7-arg completion RPC missing';
  END IF;
  IF to_regprocedure('public.complete_builder_stock_image_work(uuid,text,text,text,integer,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: old 6-arg completion RPC still present (PostgREST overload ambiguity)';
  END IF;
  IF to_regclass('public.builder_stock_source_assets') IS NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: source-asset manifest table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.builder_stock_items'::regclass
       AND conname = 'builder_stock_items_image_work_stage_check'
       AND pg_get_constraintdef(oid) ~ 'failed'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: image_work_stage CHECK does not carry ''failed''';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.builder_stock_publications'::regclass
       AND tgname = 'builder_stock_publications_source_image'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: publications visibility trigger missing';
  END IF;
END $$;
