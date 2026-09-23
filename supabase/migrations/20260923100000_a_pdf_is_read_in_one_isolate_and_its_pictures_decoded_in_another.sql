-- ============================================================================
-- A PDF IS READ IN ONE ISOLATE AND ITS PICTURES ARE DECODED IN ANOTHER
-- ============================================================================
--
-- MEASURED 23 September 2026, production, after `20260922140000` shipped: the
-- same brochure that died on 22 September (`LOT 550 - ENZO 8.5 MODERN-
-- BROCHURE V002.pdf`, 8,530,307 bytes) was imported again through the live
-- portal and died again, three times, on three paths:
--
--     05:35:36  process_upload   546  after the reader, inside the role decode
--     05:40:08  recovery re-run  546  beforeunload reason "cpu": document
--                                     stages 1,155 ms, image_decode 485 ms,
--                                     hard kill 10 ms later
--     05:40:42  "Read again"     546  the same place
--
-- The previous migration's header says the raster class "leaves the importer
-- early ... it is a budget change in the edge function". Production has now
-- answered that: a budget did not leave early enough, because the platform
-- charges CPU the budget's ledger cannot see. The settler's own recorded rule
-- (`workAllowance.pure.ts`) is what the evidence supports — an isolate spends
-- its CPU on ONE kind of heavy work — and on 22 September the settler's
-- `source` stage broke it too: twelve recovery re-runs of this brochure, each
-- parsing it and then decoding its pictures, each killed.
--
-- So a paginated document's pictures are no longer decoded where the document
-- was parsed, by the importer or by the settler. The isolate that parses it
-- writes down what the read produced — here — and the isolates that decode
-- restore it instead of opening the document again. The importer's successor
-- is the continuation `20260922140000` already dispatches (`continue_import`),
-- so this adds no transport: only somewhere to put what was read.
--
-- ----------------------------------------------------------------------------
-- WHAT A ROW HOLDS, AND WHY THERE ARE TWO PER UPLOAD
-- ----------------------------------------------------------------------------
--
-- A row is one read of an upload's CURRENT document, for one PURPOSE.
-- `manifest` is the read itself (rows, row assets, page texts, regions, the
-- page-order verdict, and each picture's metadata and where its bytes were
-- put), stamped with the document's digest and the reader and extractor
-- versions that produced it; a reader of the row that finds any of the three
-- different ignores the row and opens the document again. The pictures' bytes
-- live in storage, in the upload's own prefix. `visual_kinds` is the one
-- expensive answer the read accumulates: what each picture IS, by index,
-- learned a batch at a time.
--
-- THE TWO PURPOSES ARE TWO DIFFERENT READS OF ONE DOCUMENT, and must never be
-- mistaken for each other:
--
--   `import`  the IMPORTER's read, taken with the uploading organisation's
--             name and the document's own name as evidence, and carrying the
--             reading the importer DECIDED (the rows it will write, its
--             strategy, its diagnosis). Written by the isolate that parsed the
--             document and consumed by the successor that attaches the
--             pictures; discarded once the import is over.
--   `settle`  the image settler's read, taken the way its source repair has
--             always read a stored document. Kept while the upload's
--             properties are being settled.
--
-- The importer's rows are a different reading from the settler's, so one
-- serving as the other would put a DIFFERENT reading behind the same
-- property — which is why the purpose is part of the key, not a column
-- somebody could forget to filter on.
--
-- NOTHING HERE IS A NEW FACT ABOUT THE DOCUMENT. Every value is exactly what
-- reading the stored bytes produced; the row exists so that reading happens
-- once rather than once per isolate.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.builder_stock_document_reads (
  upload_id        uuid NOT NULL
                   REFERENCES public.builder_stock_uploads(id) ON DELETE CASCADE,
  purpose          text NOT NULL,
  organisation_id  uuid NOT NULL
                   REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  document_sha256  text NOT NULL,
  manifest         jsonb NOT NULL,
  visual_kinds     jsonb NOT NULL DEFAULT '{}'::jsonb,
  media_bytes      bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_stock_document_reads_pkey PRIMARY KEY (upload_id, purpose),
  CONSTRAINT builder_stock_document_reads_purpose
    CHECK (purpose IN ('import', 'settle')),
  CONSTRAINT builder_stock_document_reads_digest
    CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  -- Asserted with `?`, which is strictly true or false. A test written as
  -- `manifest->'v' IS ...` is NULL on an absent key, and a CHECK passes NULL.
  CONSTRAINT builder_stock_document_reads_manifest_shape
    CHECK (jsonb_typeof(manifest) = 'object' AND manifest ? 'v' AND manifest ? 'pictures'),
  CONSTRAINT builder_stock_document_reads_kinds_shape
    CHECK (jsonb_typeof(visual_kinds) = 'object'),
  CONSTRAINT builder_stock_document_reads_media_bytes
    CHECK (media_bytes >= 0)
);

COMMENT ON TABLE public.builder_stock_document_reads IS
  'A read of an upload''s current document, carried from the isolate that parsed it to the isolates that decode its pictures, so no isolate does both. One per purpose: the importer''s (import) and the image settler''s (settle). See documentRead.pure.ts.';
COMMENT ON COLUMN public.builder_stock_document_reads.visual_kinds IS
  'What each picture is (photo/floorplan/graphic, or null for "nothing is known"), by picture index. Only ever MERGED — see builder_stock_document_read_learn_kinds.';

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.builder_stock_document_reads ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS builder_stock_document_reads_service ON public.builder_stock_document_reads';
  EXECUTE 'CREATE POLICY builder_stock_document_reads_service ON public.builder_stock_document_reads '
    || 'AS PERMISSIVE FOR ALL TO service_role '
    || 'USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')';
  EXECUTE 'REVOKE ALL ON public.builder_stock_document_reads FROM anon, authenticated';
  EXECUTE 'GRANT ALL ON public.builder_stock_document_reads TO service_role';
END $$;

-- ----------------------------------------------------------------------------
-- LEARNING A BATCH OF KINDS, WITHOUT LOSING ANYBODY ELSE'S
-- ----------------------------------------------------------------------------
--
-- Two settlers can work two properties of one document at once, and each may
-- decode a batch. A read-modify-write from either would erase the other's
-- answers, so the merge happens here, in one statement, and only against the
-- read the batch was decoded from — its purpose and its document. A batch
-- that arrives after the document changed describes bytes that are no longer
-- the upload's and changes nothing.
CREATE OR REPLACE FUNCTION public.builder_stock_document_read_learn_kinds(
  p_upload_id uuid, p_purpose text, p_document_sha256 text, p_kinds jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_kinds IS NULL OR jsonb_typeof(p_kinds) <> 'object' THEN
    RETURN false;
  END IF;
  UPDATE public.builder_stock_document_reads
     SET visual_kinds = visual_kinds || p_kinds,
         updated_at = now()
   WHERE upload_id = p_upload_id
     AND purpose = p_purpose
     AND document_sha256 = p_document_sha256;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END $$;

REVOKE ALL ON FUNCTION public.builder_stock_document_read_learn_kinds(uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_read_learn_kinds(uuid, text, text, jsonb)
  TO service_role;
