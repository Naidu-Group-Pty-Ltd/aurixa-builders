-- ============================================================================
-- BUILDER STOCK — A MANIFEST ROW RECORDS WHAT HAPPENED TO ITS BRANCH
--
-- `builder_stock_source_assets` is the durable record of every document the
-- builder's stock list points at, and publication requires that none of them
-- is still `pending`: a list we could not fully READ must never publish as
-- though it were complete.
--
-- MEASURED ON PRODUCTION, 19 September 2026. The live upload holds 110
-- pending rows and cannot publish — a gate `publication_blocked_reason` never
-- mentions, so the upload advertised "1 of 47 without a photo, 1 failed"
-- while a second, unnamed condition held it as well. Repairing the property
-- it named would have changed nothing.
--
-- Every one of those 110 rows belongs to a property that has SETTLED WITH A
-- READY BUILDER-SOURCE PHOTOGRAPH (owner_working 0, owner_failed 0,
-- owner_has_primary 110). None of them is outstanding work. They are two
-- populations:
--
--   72  THE BRANCH WAS ANSWERED AND THE ROW NEVER HEARD. A verdict is written
--       by `syncSourceAssetState` against the upload that was CURRENT when
--       the work ran. A replacement upload re-enumerates the same branches as
--       fresh `pending` rows under its own id — and the branch is already
--       terminal, so `openBranches` never offers it again and the new row is
--       never resolved. Measured: 72 of the 110 name a branch this property
--       has a banked verdict for, and 67 name one another upload resolved.
--
--   38  THE BRANCH WAS NEVER OPENED. A property that finds its photograph in
--       the first document it opens stops there — `allBranchesTerminal` is
--       required to answer "no deterministic image", not to accept one. The
--       remaining documents are never read, and their rows stay `pending`
--       for ever. Measured: 110 − 72 = 38, all on settled properties.
--
-- Between them these make a stock list permanently unpublishable once it has
-- been re-imported or once any property settles early — which is every list.
-- Nothing in this deployment has ever published.
--
-- WHAT THIS DOES NOT DO: weaken the gate. The gate asks whether enumerated
-- source work is still outstanding, and neither population is outstanding —
-- one was done and not recorded, the other was deliberately not needed. An
-- asset pending on a property that is NOT settled with a ready builder-source
-- photograph still blocks publication exactly as before, and a failed
-- enumeration (`source_manifest_state`) is a separate condition this does not
-- touch. That property is asserted below, not asserted in prose.
--
-- ONE PLACE DECIDES. The obvious alternative is to fix the two producers —
-- carry the verdict forward when enumerating, and close the unopened rows
-- when a property settles. That is two new rules in two modules that must
-- agree with each other and with this one for ever, and it repairs nothing
-- already in the table. A reconciliation run by the sweep that is about to
-- read the answer is one rule, idempotent, and fixes the 224 rows already
-- sitting in production.
--
-- Idempotent: every statement is re-runnable.
-- ============================================================================

-- ============================================================================
-- 1. A branch that was never needed has its own word for it
--
-- NOT `no_image`, which asserts the document names no photograph — a verdict
-- nobody reached, about a document nobody opened. Inventing a finding we did
-- not make is the failure this repository keeps paying for.
-- ============================================================================

ALTER TABLE public.builder_stock_source_assets
  DROP CONSTRAINT IF EXISTS builder_stock_source_assets_state_check;

ALTER TABLE public.builder_stock_source_assets
  ADD CONSTRAINT builder_stock_source_assets_state_check
  CHECK (state = ANY (ARRAY[
    'pending'::text, 'stored'::text, 'no_image'::text,
    'unreadable'::text, 'unsupported'::text, 'failed'::text,
    'not_required'::text]));

COMMENT ON COLUMN public.builder_stock_source_assets.state IS
  'What happened to this document. `pending` is outstanding work and blocks publication. `not_required` means the property was satisfied by another of its documents so this one was never opened — a fact about our reading, never a finding about the document.';

-- ============================================================================
-- 2. The reconciliation
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_stock_reconcile_source_manifest(p_upload_id uuid)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_inherited integer := 0;
  v_not_required integer := 0;
BEGIN
  /*
   * a) A VERDICT REACHED FOR THIS BRANCH IS THIS BRANCH'S VERDICT, whichever
   *    upload was current when the work ran. Matched on the property and the
   *    exact document reference, so nothing is carried between properties or
   *    between different documents of one property. The newest resolved row
   *    wins, which is the same row `syncSourceAssetState` would have written.
   */
  UPDATE public.builder_stock_source_assets AS a
     SET state = s.state,
         state_detail = s.state_detail,
         image_id = coalesce(s.image_id, a.image_id),
         updated_at = now()
    FROM (
      SELECT DISTINCT ON (q.stock_item_id, q.kind, q.reference)
             q.stock_item_id, q.kind, q.reference, q.state, q.state_detail, q.image_id
        FROM public.builder_stock_source_assets AS q
       WHERE q.state <> 'pending'
       ORDER BY q.stock_item_id, q.kind, q.reference, q.updated_at DESC
    ) AS s
   WHERE a.upload_id = p_upload_id
     AND a.state = 'pending'
     AND a.stock_item_id = s.stock_item_id
     AND a.kind = s.kind
     AND a.reference = s.reference;
  GET DIAGNOSTICS v_inherited = ROW_COUNT;

  /*
   * b) A DOCUMENT NOBODY NEEDED TO OPEN IS NOT OUTSTANDING WORK.
   *
   *    Only where the property is SETTLED and holds a ready builder-source
   *    photograph. A property still climbing the ladder, one that failed, and
   *    one that settled blank all keep their pending rows and keep blocking —
   *    which is the whole point of the gate and is asserted, not assumed.
   */
  UPDATE public.builder_stock_source_assets AS a
     SET state = 'not_required',
         state_detail = 'the property was satisfied by another of its documents, so this one was not opened',
         updated_at = now()
   WHERE a.upload_id = p_upload_id
     AND a.state = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.builder_stock_items AS i
        WHERE i.id = a.stock_item_id
          AND i.image_work_stage = 'settled'
          AND public.builder_stock_photo_is_source_ready(i.primary_image_id));
  GET DIAGNOSTICS v_not_required = ROW_COUNT;

  RETURN jsonb_build_object(
    'inherited', v_inherited, 'not_required', v_not_required);
END;
$$;

COMMENT ON FUNCTION public.builder_stock_reconcile_source_manifest(uuid) IS
  'Brings one upload''s source manifest up to date with what actually happened to its documents: a verdict reached under another upload is adopted, and a document never opened because the property was already satisfied is recorded as not required. Never resolves a row for a property that is unsettled, failed, or settled without a ready builder-source photograph — those stay pending and keep blocking publication.';

REVOKE ALL ON FUNCTION public.builder_stock_reconcile_source_manifest(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_reconcile_source_manifest(uuid) TO service_role;

-- ============================================================================
-- 3. The sweep reconciles before it reads
--
-- Here rather than in the tick, because this is the loop that already walks
-- exactly the uploads whose publication is about to be decided — and a
-- manifest read a moment before the answer is computed cannot be stale by the
-- time it is used. Everything else is byte-identical to the 2026-09-19
-- definition.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.publish_ready_builder_stock_uploads() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_upload record;
  v_result jsonb;
  v_published integer := 0;
  v_considered integer := 0;
  v_reconciled integer := 0;
  v_details jsonb := '[]'::jsonb;
  v_fix jsonb;
BEGIN
  FOR v_upload IN
    SELECT u.id
      FROM public.builder_stock_uploads AS u
     WHERE u.deleted_at IS NULL
       AND NOT public.builder_stock_upload_superseded(u.id)
       AND (u.published_at IS NULL OR EXISTS (
         SELECT 1 FROM public.builder_stock_items i
          WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'))
     ORDER BY u.created_at
  LOOP
    v_considered := v_considered + 1;
    v_fix := public.builder_stock_reconcile_source_manifest(v_upload.id);
    v_reconciled := v_reconciled
      + coalesce((v_fix->>'inherited')::integer, 0)
      + coalesce((v_fix->>'not_required')::integer, 0);
    v_result := public.publish_builder_stock_upload(v_upload.id);
    IF (v_result->>'published')::boolean THEN
      v_published := v_published + 1;
      v_details := v_details || jsonb_build_object('upload_id', v_upload.id, 'result', v_result);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'considered', v_considered, 'published', v_published,
    'manifest_rows_reconciled', v_reconciled, 'cutovers', v_details);
END;
$$;

-- ============================================================================
-- 4. Post-migration assertions — shapes, not hopes
-- ============================================================================

DO $$
DECLARE
  v_org uuid; v_old uuid; v_new uuid;
  v_done uuid; v_early uuid; v_blank uuid; v_working uuid;
  v_img uuid; v_r record; v_fix jsonb;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Manifest Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'old.csv', 'proof/old.csv', 'enriching') RETURNING id INTO v_old;
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status, replaces_upload_ids)
  VALUES (v_org, 'new.csv', 'proof/new.csv', 'enriching', ARRAY[v_old]) RETURNING id INTO v_new;

  -- FOUR PROPERTIES, one per case the reconciliation has to tell apart.
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_new, 'staged', '1 Answered Street', 'Truganina') RETURNING id INTO v_done;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_new, 'staged', '2 Early Street', 'Truganina') RETURNING id INTO v_early;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_new, 'staged', '3 Blank Street', 'Truganina', 'settled') RETURNING id INTO v_blank;
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
  VALUES (v_org, v_new, 'staged', '4 Working Street', 'Truganina', 'source') RETURNING id INTO v_working;

  -- The two settled-with-a-photograph ones.
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_done, v_new, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/done.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_done;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_early, v_new, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/early.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_early;

  -- (a) ANSWERED UNDER THE OLD UPLOAD, pending under the new one.
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state, state_detail)
  VALUES (v_old, v_org, v_done, 'row_branch', 'document', 'https://example.invalid/a?usp=drive_link',
          'stored', 'the builder''s filed photograph was stored from this link');
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_new, v_org, v_done, 'row_branch', 'document', 'https://example.invalid/a?usp=drive_link', 'pending');

  -- (b) NEVER OPENED: a second document of a property already satisfied.
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_new, v_org, v_early, 'row_branch', 'document', 'https://example.invalid/b?usp=drive_link', 'pending');

  -- (c) A SETTLED BLANK property and (d) one STILL WORKING. Both must keep
  --     their pending rows: these are the cases the gate exists for.
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_new, v_org, v_blank, 'row_branch', 'document', 'https://example.invalid/c?usp=drive_link', 'pending');
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_new, v_org, v_working, 'row_branch', 'document', 'https://example.invalid/d?usp=drive_link', 'pending');

  /*
   * (e) A SECOND DOCUMENT OF THE SAME PROPERTY, answered under the old
   *     upload. This is what makes the reference match load-bearing: the
   *     property now has one answered document and one outstanding one, so a
   *     reconciliation that carried a verdict between DIFFERENT documents of
   *     one property would resolve (d) as well. Without this case, dropping
   *     `reference` from the match changes nothing observable and the
   *     condition is asserted only in appearance.
   */
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state, state_detail)
  VALUES (v_old, v_org, v_working, 'row_branch', 'document', 'https://example.invalid/e?usp=drive_link',
          'no_image', 'that document names no image for this property');
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_new, v_org, v_working, 'row_branch', 'document', 'https://example.invalid/e?usp=drive_link', 'pending');

  /*
   * (f) A PENDING ROW ON THE OTHER UPLOAD, whose branch this upload has
   *     answered. Reconciling THIS upload must not touch it: the function
   *     takes an upload id and is called per upload by the sweep, and one
   *     that quietly repaired every upload in the table would be doing work
   *     nobody asked for on lists nobody is publishing.
   */
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state, state_detail)
  VALUES (v_new, v_org, v_done, 'row_branch', 'document', 'https://example.invalid/f?usp=drive_link',
          'stored', 'stored from this link');
  INSERT INTO public.builder_stock_source_assets
    (upload_id, organisation_id, stock_item_id, kind, branch_kind, reference, state)
  VALUES (v_old, v_org, v_done, 'row_branch', 'document', 'https://example.invalid/f?usp=drive_link', 'pending');

  -- Before: five pending, and the upload cannot publish on that alone.
  IF (SELECT count(*) FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND state = 'pending') <> 5 THEN
    RAISE EXCEPTION 'the manifest proof did not set up five pending rows';
  END IF;

  v_fix := public.builder_stock_reconcile_source_manifest(v_new);
  IF (v_fix->>'inherited')::int <> 2 OR (v_fix->>'not_required')::int <> 1 THEN
    RAISE EXCEPTION 'the reconciliation did not resolve exactly two inherited and one not-required (%)', v_fix;
  END IF;

  -- (e) was adopted; (d), a DIFFERENT document of the same property with no
  -- verdict anywhere, was not touched.
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_working
         AND reference = 'https://example.invalid/e?usp=drive_link') <> 'no_image' THEN
    RAISE EXCEPTION 'a second document answered under another upload was not adopted';
  END IF;
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_working
         AND reference = 'https://example.invalid/d?usp=drive_link') <> 'pending' THEN
    RAISE EXCEPTION 'a verdict was carried between DIFFERENT documents of one property';
  END IF;

  -- AND THE OTHER UPLOAD WAS NOT TOUCHED.
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_old AND stock_item_id = v_done
         AND reference = 'https://example.invalid/f?usp=drive_link') <> 'pending' THEN
    RAISE EXCEPTION 'reconciling one upload reached into another';
  END IF;

  -- (a) adopted the OLD upload's verdict, with its detail.
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_done
         AND reference = 'https://example.invalid/a?usp=drive_link') <> 'stored' THEN
    RAISE EXCEPTION 'a branch answered under another upload was not adopted';
  END IF;
  IF (SELECT state_detail FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_done
         AND reference = 'https://example.invalid/a?usp=drive_link') IS NULL THEN
    RAISE EXCEPTION 'the adopted verdict lost the reason that came with it';
  END IF;

  -- (b) recorded as never needed, and NOT as a finding about the document.
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_early) <> 'not_required' THEN
    RAISE EXCEPTION 'a document nobody opened was not recorded as not required';
  END IF;

  -- (c) and (d) STILL BLOCK. This is the gate, and it is the assertion that
  --     makes the two above safe.
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_blank) <> 'pending' THEN
    RAISE EXCEPTION 'a settled BLANK property had its outstanding document closed';
  END IF;
  IF (SELECT state FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND stock_item_id = v_working
         AND reference = 'https://example.invalid/d?usp=drive_link') <> 'pending' THEN
    RAISE EXCEPTION 'a property still reading its source had its outstanding document closed';
  END IF;

  SELECT * INTO v_r FROM public.builder_stock_publication_readiness(v_new);
  IF v_r.ready OR v_r.partial_ready THEN
    RAISE EXCEPTION 'publication was offered while two documents are genuinely outstanding (ready %, partial %)',
      v_r.ready, v_r.partial_ready;
  END IF;

  -- Give the blank one a photograph and settle the working one, and the last
  -- two rows resolve — which proves the gate opens on the real condition and
  -- not on the passage of time.
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_blank, v_new, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/blank.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items SET primary_image_id = v_img WHERE id = v_blank;
  INSERT INTO public.builder_stock_item_images
    (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
     verification_status, processing_status, storage_path)
  VALUES (v_org, v_working, v_new, 'uploaded_document', 'brochure#page1',
     'source_supplied', 'ready', 'proof/working.jpg') RETURNING id INTO v_img;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_img, image_work_stage = 'settled' WHERE id = v_working;

  /*
   * AND THE SWEEP IS WHAT RUNS IT. Everything above calls the reconciliation
   * directly, which proves the rule and not the WIRING — a sweep that stopped
   * calling it would leave every assertion above passing while no upload in
   * production was ever reconciled. So the last step goes through
   * `publish_ready_builder_stock_uploads`, exactly as the every-minute tick
   * does, and the upload publishes on the strength of that one call.
   */
  IF (SELECT count(*) FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND state = 'pending') <> 2 THEN
    RAISE EXCEPTION 'the sweep proof did not begin with two outstanding documents';
  END IF;

  v_fix := public.publish_ready_builder_stock_uploads();
  IF coalesce((v_fix->>'manifest_rows_reconciled')::int, 0) < 2 THEN
    RAISE EXCEPTION 'the sweep did not reconcile the manifest before reading it (%)', v_fix;
  END IF;
  IF NOT (v_fix->'cutovers' @> jsonb_build_array(
            jsonb_build_object('upload_id', v_new))) THEN
    RAISE EXCEPTION 'the sweep did not publish THIS upload after reconciling it (%)', v_fix;
  END IF;
  IF (SELECT count(*) FROM public.builder_stock_source_assets
       WHERE upload_id = v_new AND state = 'pending') <> 0 THEN
    RAISE EXCEPTION 'the manifest did not converge';
  END IF;
  IF (SELECT count(*) FROM public.builder_stock_items
       WHERE upload_id = v_new AND lifecycle_status = 'active') <> 4 THEN
    RAISE EXCEPTION 'the four photographed properties did not reach the marketplace';
  END IF;

  -- And it is IDEMPOTENT: a second pass changes nothing.
  v_fix := public.builder_stock_reconcile_source_manifest(v_new);
  IF (v_fix->>'inherited')::int <> 0 OR (v_fix->>'not_required')::int <> 0 THEN
    RAISE EXCEPTION 'the reconciliation is not idempotent (%)', v_fix;
  END IF;

  RAISE EXCEPTION 'proof complete — rolling back' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'proof complete — rolling back' THEN RAISE; END IF;
END $$;
