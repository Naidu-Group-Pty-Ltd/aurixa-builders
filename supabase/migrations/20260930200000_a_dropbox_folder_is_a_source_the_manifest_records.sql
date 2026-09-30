/*
 * A DROPBOX FOLDER IS A SOURCE THE MANIFEST RECORDS.
 *
 * MEASURED 30 SEPTEMBER 2026. Provenance 28 taught the reader a new kind of
 * builder source, `dropbox_folder`, and the source-asset manifest's CHECK on
 * `branch_kind` was never told. Every import of a list that links a Dropbox
 * shared folder then had its manifest write refused by the database
 * ("violates check constraint builder_stock_source_assets_branch_kind_check"),
 * the importer stamped `source_manifest_state = 'failed'`, and
 * `builder_stock_publication_readiness` refuses to publish any list whose
 * manifest failed — so a list with every property photographed could never
 * go live, and "Fetch the link again" failed the same way every time. One
 * list was caught: 41 properties, 41 photographs, nothing on the marketplace.
 *
 * 1. The CHECK names every kind `sourceBranches.pure.ts` declares; a spec now
 *    fails whenever the two differ, so a new kind cannot ship without it.
 * 2. A list blocked by THAT refusal alone had its sources read to the end —
 *    the database, not the source, declined to record one kind. Its manifest
 *    state is cleared (the next read writes the manifest under the corrected
 *    CHECK) and it is published through the ordinary function, which applies
 *    every readiness rule it always has. A list whose manifest failed for any
 *    other reason is not touched.
 */
ALTER TABLE public.builder_stock_source_assets
  DROP CONSTRAINT IF EXISTS builder_stock_source_assets_branch_kind_check;
ALTER TABLE public.builder_stock_source_assets
  ADD CONSTRAINT builder_stock_source_assets_branch_kind_check
  CHECK (branch_kind IS NULL OR branch_kind IN
    ('direct_image', 'drive_file', 'drive_folder', 'dropbox_folder', 'document', 'unsupported'));

DO $$
DECLARE
  v_upload record;
  v_result jsonb;
BEGIN
  FOR v_upload IN
    SELECT id
      FROM public.builder_stock_uploads
     WHERE source_manifest_state = 'failed'
       AND deleted_at IS NULL
       AND error_detail::text LIKE '%builder_stock_source_assets_branch_kind_ch%'
  LOOP
    UPDATE public.builder_stock_uploads
       SET source_manifest_state = NULL
     WHERE id = v_upload.id;
    v_result := public.publish_builder_stock_upload(v_upload.id);
    RAISE NOTICE 'upload % republished after the manifest refusal: %', v_upload.id, v_result;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.builder_stock_source_assets'::regclass
       AND conname = 'builder_stock_source_assets_branch_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%dropbox_folder%'
  ) THEN
    RAISE EXCEPTION 'the branch_kind CHECK does not admit dropbox_folder';
  END IF;
END;
$$;
