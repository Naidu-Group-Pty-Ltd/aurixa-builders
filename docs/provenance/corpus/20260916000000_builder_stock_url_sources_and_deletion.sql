-- Builder Stock List — URL sources, and deleting a source
--
-- Two additions to the EXISTING import audit record. No new stock table, no
-- second pipeline: a URL is another way to reach `builder_stock_uploads`, and
-- everything after that is the path a file already takes.
--
--   1. Where the bytes came from — `source_type`, plus the URL metadata that
--      only a fetched source has.
--   2. A source a builder has removed — `deleted_at`, because an upload is
--      referenced by the stock it created AND by client selections made
--      against that stock. Hard-deleting it would either orphan an activation
--      or cascade one away, and a selection already made for a client must
--      survive the builder tidying up their sources.

-- ===========================================================================
-- 1. Where the source came from
-- ===========================================================================
ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'file',
  -- The URL the builder submitted, before redirects. Kept verbatim so the
  -- history shows what they typed.
  ADD COLUMN IF NOT EXISTS source_url text,
  -- Where the fetch actually ended up. Different from `source_url` whenever a
  -- share link redirected, which is the normal case for hosted documents.
  ADD COLUMN IF NOT EXISTS final_url text,
  -- A page title or shortened URL. What the history row is labelled with when
  -- there is no filename.
  ADD COLUMN IF NOT EXISTS source_title text,
  ADD COLUMN IF NOT EXISTS retrieved_at timestamptz;

ALTER TABLE public.builder_stock_uploads
  DROP CONSTRAINT IF EXISTS builder_stock_uploads_source_type_check;
ALTER TABLE public.builder_stock_uploads
  ADD CONSTRAINT builder_stock_uploads_source_type_check
  CHECK (source_type IN ('file', 'url'));

-- A URL source must say where it came from, or the history cannot label it and
-- the audit record cannot answer "what did we actually fetch".
ALTER TABLE public.builder_stock_uploads
  DROP CONSTRAINT IF EXISTS builder_stock_uploads_url_source_has_a_url;
ALTER TABLE public.builder_stock_uploads
  ADD CONSTRAINT builder_stock_uploads_url_source_has_a_url
  CHECK (source_type <> 'url' OR source_url IS NOT NULL);

COMMENT ON COLUMN public.builder_stock_uploads.source_type IS
  'file = the builder uploaded bytes; url = the server fetched them. Both end in the same extraction, normalisation and import path.';
COMMENT ON COLUMN public.builder_stock_uploads.final_url IS
  'The URL the fetch settled on after redirects, each of which was SSRF-checked. Never the URL the browser claimed.';

-- ===========================================================================
-- 2. Removing a source
--
-- Soft delete. `builder_stock_items.upload_id` and
-- `builder_stock_selections.source_upload_id` both point here, and a client
-- selection is the one thing this feature must never destroy to satisfy a
-- tidy-up action.
-- ===========================================================================
ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS builder_stock_uploads_live_idx
  ON public.builder_stock_uploads(organisation_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.builder_stock_uploads.deleted_at IS
  'The builder removed this source. The row stays: stock it created and selections made against that stock still reference it.';

-- ===========================================================================
-- 3. The duplicate guard must not outlive the source
--
-- `builder_stock_uploads_org_sha_key` stops the same bytes being imported
-- twice. Once a source is deleted the builder is entitled to add it again —
-- with the old index that second import failed as a duplicate of a source that
-- is no longer there. Deleted rows are now excluded from the key.
-- ===========================================================================
DROP INDEX IF EXISTS public.builder_stock_uploads_org_sha_key;
CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_uploads_org_sha_key
  ON public.builder_stock_uploads(organisation_id, file_sha256)
  WHERE file_sha256 IS NOT NULL AND deleted_at IS NULL;

-- ===========================================================================
-- 4. Nothing else changes
--
-- `builder_stock_items.lifecycle_status` already carries `archived`, and both
-- read paths already filter on `active`, so archiving the stock a deleted
-- source currently supplies removes it from the Property Marketplace through
-- the rules that are already there. No marketplace change is needed.
-- ===========================================================================
