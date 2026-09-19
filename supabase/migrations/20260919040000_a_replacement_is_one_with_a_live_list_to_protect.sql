-- ============================================================================
-- BUILDER STOCK — A REPLACEMENT IS ONE WITH A LIVE LIST TO PROTECT
--
-- `20260919030000` gave a FIRST stock list the right to publish the properties
-- that earned a builder-source photograph, and decided which uploads qualify
-- with:
--
--     coalesce(array_length(u.replaces_upload_ids, 1), 0) = 0
--
-- That is a PROXY for the question atomic cutover actually answers — "is there
-- a live generation that promoting a subset of this upload would mix with?" —
-- and measured against production an hour later, the proxy is wrong in exactly
-- the case the feature was built for.
--
-- WHAT PRODUCTION SAID, 19 September 2026, 03:29. The builder has two uploads:
--
--   2c412938  created 09:26:05  replaces []            published NEVER
--   58010c95  created 09:41:46  replaces [2c412938]    published NEVER
--
-- and every one of the 47 properties belongs to 58010c95 — 46 staged and
-- settled with a ready builder-source primary, 1 staged and failed. The
-- builder re-imported their list fifteen minutes after the first attempt,
-- long before its photographs had finished, so the live upload is a
-- REPLACEMENT of an upload that NEVER WENT LIVE. `first_publication` was
-- false, the new rule did not fire, and the marketplace stayed at zero —
-- which is the outcome the whole migration exists to prevent.
--
-- THE RULE IS THE QUESTION ITSELF: an upload is a first publication when
-- nothing it supersedes is currently serving the marketplace. Nothing live to
-- mix with, nothing for all-or-nothing to protect.
--
-- WHY NOT "THE ORGANISATION HAS NO LIVE ROWS". Still the trap the previous
-- migration named: that reading FLIPS the moment a partial publication makes
-- rows active, and the builder who then fixes their last property finds
-- publication refusing it. This one does not flip, because promoting THIS
-- upload's rows changes nothing about the SUPERSEDED uploads' active counts —
-- they stay at zero, and the answer stays the same for the upload's whole
-- life. That property is asserted below rather than argued for.
--
-- AND IT IS STILL NARROW. A replacement whose predecessor IS live behaves
-- exactly as before: all-or-nothing, the live list untouched until every
-- property of the new one carries its photograph. Nothing about the
-- photograph rule, image identity, role or marketplace eligibility moves.
--
-- Idempotent: every statement is re-runnable.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_publication_readiness(p_upload_id uuid)
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
           /*
            * A REPLACEMENT IS ONE WITH A LIVE LIST TO PROTECT. Not "an upload
            * that names a predecessor" — a predecessor that never published,
            * or whose rows have all been archived, is not a generation on the
            * marketplace and there is nothing for a partial promotion to mix
            * with. Promoting THIS upload's rows cannot change this answer,
            * because it never touches a superseded upload's active count.
            */
           NOT EXISTS (
             SELECT 1 FROM public.builder_stock_items AS live
              WHERE live.lifecycle_status = 'active'
                AND live.upload_id = ANY(coalesce(u.replaces_upload_ids, '{}'))
                AND live.upload_id <> u.id
           ) AS first_publication,
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
    c.total > 0
      AND c.open_work = 0
      AND c.failed_items = 0
      AND c.missing_primary = 0
      AND g.assets_settled
      AND g.manifest_ok
    AS ready,
    c.ready_items,
    coalesce(u.first_publication, false) AS first_publication,
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
  'ready ⟺ every scoped item is settled with a READY builder-source primary photograph, no item failed, no manifest asset pending, enumeration not failed — the all-or-nothing answer a REPLACEMENT publishes on, unchanged. partial_ready ⟺ nothing this upload supersedes is currently live, its image work has finished, at least one property earned its photograph, and neither truncation gate is open — a list with no live generation to protect publishes what is ready and leaves the rest staged.';

REVOKE ALL ON FUNCTION public.builder_stock_publication_readiness(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_publication_readiness(uuid) TO service_role;

-- ============================================================================
-- Post-migration assertions — shapes, not hopes
-- ============================================================================

DO $$
DECLARE
  v_org uuid; v_first uuid; v_second uuid; v_third uuid;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_img uuid; v_r record; v_res jsonb;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Superseded Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;

  -- ------------------------------------------------------------------
  -- THE PRODUCTION SHAPE: a list re-imported before it ever went live.
  -- The second upload names the first as its predecessor, and the first
  -- has nothing on the marketplace.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'first.csv', 'proof/first.csv', 'enriching') RETURNING id INTO v_first;
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status, replaces_upload_ids)
  VALUES (v_org, 'reimport.csv', 'proof/reimport.csv', 'enriching', ARRAY[v_first])
  RETURNING id INTO v_second;

  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_second, 'staged', '1 Reimport Road', 'Truganina') RETURNING id INTO v_a;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_second, 'staged', '2 Reimport Road', 'Truganina', 'failed') RETURNING id INTO v_b;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_a, v_second, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/a.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_a;

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_second);
  IF NOT v_r.first_publication THEN
    RAISE EXCEPTION 'an upload superseding a list that never went live was treated as a replacement';
  END IF;
  IF NOT v_r.partial_ready OR v_r.ready THEN
    RAISE EXCEPTION 're-imported first list did not offer a first publication (partial %, ready %)',
      v_r.partial_ready, v_r.ready;
  END IF;
  v_res := public.publish_builder_stock_upload(v_second);
  IF (v_res->>'promoted')::int <> 1 OR (v_res->>'withheld')::int <> 1
     OR v_res->>'mode' <> 'first_publication' THEN
    RAISE EXCEPTION 're-imported first list did not publish its one ready property (%)', v_res;
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_b) <> 'staged' THEN
    RAISE EXCEPTION 'a property with no builder-source photograph reached the marketplace';
  END IF;

  -- AND THE ANSWER DOES NOT FLIP once that publication has made rows live.
  -- This is the property the whole formulation turns on: the rows promoted
  -- belong to THIS upload, so the superseded upload's active count — which is
  -- what the rule reads — is untouched.
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_second);
  IF NOT v_r.first_publication THEN
    RAISE EXCEPTION 'the mode flipped after its own partial publication — the builder can no longer repair a row';
  END IF;

  -- ------------------------------------------------------------------
  -- AND A REPLACEMENT OF A LIVE LIST IS STILL ALL-OR-NOTHING.
  -- ------------------------------------------------------------------
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status, replaces_upload_ids)
  VALUES (v_org, 'third.csv', 'proof/third.csv', 'enriching', ARRAY[v_second])
  RETURNING id INTO v_third;

  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_third, 'staged', '3 Replacement Way', 'Truganina') RETURNING id INTO v_c;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_third, 'staged', '4 Replacement Way', 'Truganina', 'failed') RETURNING id INTO v_d;

  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_c, v_third, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/c.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_c;

  -- `v_second` now HAS a live property, so `v_third` is a real replacement.
  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_third);
  IF v_r.first_publication THEN
    RAISE EXCEPTION 'an upload superseding a LIVE list called itself a first publication';
  END IF;
  IF v_r.partial_ready THEN
    RAISE EXCEPTION 'a replacement of a live list offered a partial publication';
  END IF;
  v_res := public.publish_builder_stock_upload(v_third);
  IF (v_res->>'published')::boolean OR v_res->>'reason' <> 'not_ready' THEN
    RAISE EXCEPTION 'a replacement of a live list published with a failed property (%)', v_res;
  END IF;
  IF (SELECT count(*) FROM public.builder_stock_items
       WHERE upload_id = v_second AND lifecycle_status = 'active') <> 1 THEN
    RAISE EXCEPTION 'a refused replacement disturbed the live stock list';
  END IF;

  RAISE EXCEPTION 'proof complete — rolling back' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'proof complete — rolling back' THEN RAISE; END IF;
END $$;
