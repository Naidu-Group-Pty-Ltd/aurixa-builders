-- ===========================================================================
-- Bootstrap builder_stock_uploads AHEAD of the migrations that consume it —
-- the fix for the fleet-wide replay halt.
--
-- ## The fault
--
-- Three builder-stock migrations carry version strings EARLIER than the
-- migration that creates their tables:
--
--   20260816140000_builder_stock_source_image_settlement.sql      needs builder_stock_uploads
--   20260818120000_builder_stock_marketplace_eligibility_settlement needs builder_stock_uploads
--   20260819090000_builder_stock_eligibility_target_version        needs builder_stock_uploads
--                                                                  (and creates
--                                                                  builder_stock_settlement_target,
--                                                                  which ten later files need)
--
-- while builder_stock_uploads is created by
-- 20260915000000_builder_stock_list_marketplace.sql. The prime and the early
-- clones hold all of them because they were applied in MERGE order; a fresh
-- replay runs in VERSION order, so it reaches 20260816140000 first, fails on
-- `relation "public.builder_stock_uploads" does not exist` — and Mission
-- Control's applyPrimeMigrations then HALTS THE WHOLE REPLAY ("schema state
-- beyond this point is undefined"), so nothing after 20260816140000 ever
-- applies to that clone. Every clone whose pending set includes these files
-- stops at the same line, which is what a fleet-wide sync failure looks like.
--
-- It compounds: 20260816140000 is also a frozen VERSION COLLISION
-- (MIGRATION_VERSION_COLLISIONS.json) with
-- 20260816140000_seed_template_library_v8_investment_narrative.sql. The
-- builder file sorts first within the shared version, so its failure also
-- stops the template seed at the same version from ever running.
--
-- ## Why a hoisted bootstrap, not a rename
--
-- Renumbering the thirteen affected files above 20260916000000 would make
-- them PENDING again on every clone that already applied them under the old
-- versions — re-running thirteen files that were never written to re-run.
-- This file re-runs nothing anywhere: it is CREATE TABLE IF NOT EXISTS with
-- the table's 20260915000000 shape copied verbatim, so it no-ops on the
-- prime, no-ops on any clone that already holds the table, and on a fresh
-- replay it simply puts the table in place before its first consumer.
--
-- ## The shape is the CURRENT one, not 20260915000000's
--
-- The three August files were written against the table as it is in
-- production — including `deleted_at` and the url-source columns that
-- 20260916000000 adds — so a bootstrap carrying only the 20260915000000
-- shape still fails them (`column "deleted_at" does not exist`, measured).
-- This file therefore carries the base shape PLUS 20260916000000's additions,
-- verbatim. Both later migrations stay correct over it: 20260915000000
-- creates the table IF NOT EXISTS and drop-recreates its policy and touch
-- trigger by name, and 20260916000000 adds every column IF NOT EXISTS and
-- drop-recreates its constraints by name.
--
-- ## What is deliberately NOT here
--
-- No indexes and no touch trigger: 20260915000000 / 20260916000000 own those
-- and create them guarded, so this file owns exactly one thing — existence in
-- the shape the corpus assumes. RLS and the service-role-only policy ARE
-- here, because between this version and 20260915000000 the table must not
-- exist unprotected.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.builder_stock_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  uploaded_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,

  original_filename text NOT NULL CHECK (length(btrim(original_filename)) > 0),
  -- What the browser CLAIMED. The detected type is recorded separately,
  -- because a declared content-type is a claim by the uploader, not evidence.
  declared_content_type text,
  detected_content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  file_sha256 text,

  storage_bucket text NOT NULL DEFAULT 'builder-stock-lists',
  storage_path text NOT NULL,

  -- The staged lifecycle. A failure in enrichment lands on `partially_complete`
  -- and never on `failed`: the properties are imported and must stay.
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','parsing','imported','enriching','complete',
                      'partially_complete','failed')),
  parse_strategy text,

  records_detected integer NOT NULL DEFAULT 0,
  records_imported integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  records_failed integer NOT NULL DEFAULT 0,

  -- Per-stage image counts: { document: {ready, failed}, google: {...}, internet: {...} }
  image_stage_summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Two error fields on purpose. `error_message` is shown to the builder;
  -- `error_detail` is the internal diagnosis and is never returned to a
  -- portal caller.
  error_code text,
  error_message text,
  error_detail jsonb,

  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 20260916000000_builder_stock_url_sources_and_deletion additions, carried
  -- here because the August consumers assume them. That migration re-adds
  -- every one IF NOT EXISTS and re-states both CHECKs DROP-first.
  source_type text NOT NULL DEFAULT 'file',
  source_url text,
  final_url text,
  source_title text,
  retrieved_at timestamptz,
  deleted_at timestamptz,
  deleted_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  CONSTRAINT builder_stock_uploads_source_type_check
    CHECK (source_type IN ('file', 'url')),
  CONSTRAINT builder_stock_uploads_url_source_has_a_url
    CHECK (source_type <> 'url' OR source_url IS NOT NULL)
);

ALTER TABLE public.builder_stock_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS builder_stock_uploads_service ON public.builder_stock_uploads;
CREATE POLICY builder_stock_uploads_service ON public.builder_stock_uploads
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.builder_stock_uploads FROM anon, authenticated;
GRANT ALL ON public.builder_stock_uploads TO service_role;
