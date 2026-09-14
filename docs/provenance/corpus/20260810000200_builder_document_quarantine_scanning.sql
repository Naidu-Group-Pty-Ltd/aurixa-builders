-- Builder / Developer Portal — document quarantine and malware scanning (B1).
--
-- Until now `builder_document_versions` carried storage_path, file_name,
-- content_type, byte_size and checksum — and no scan state, no lifecycle state
-- and no quarantine. An upload was immediately downloadable by anyone holding a
-- grant, with nothing having inspected it. `get_builder_cutover_readiness`
-- reports that as a required failing check, so the portal cannot go live.
--
-- This migration closes it by GENERALISING the shared immutable-document
-- processing architecture (Phase 9, `20260730250000`) rather than building a
-- second document processor:
--
--   * `document_processing_jobs` gains a `portal` discriminator and a nullable
--     `builder_document_version_id`, exactly mirroring the ownership shape
--     `20260801000400` used for the rollout tables. Solicitor rows keep their
--     meaning and `document_version_id` is never dropped.
--   * `claim_document_processing_jobs(worker, limit)` is preserved UNCHANGED,
--     because the deployed legal-document-processor calls it and its behaviour
--     must not change. `claim_builder_document_processing_jobs(worker, limit)`
--     is its Builder sibling over the same queue.
--   * The scanner itself is the shared one. `_shared/immutableDocuments.ts`
--     provides MIME detection, SHA-256 and `scanDocument()` for both portals, so
--     there is one scanning contract and one provider configuration.
--
-- Lifecycle, matching the shared service:
--
--   upload_pending -> quarantined -> scanning -> available    (clean)
--                                             -> rejected     (infected)
--                                             -> quarantined  (error, retryable)
--
-- A version is downloadable ONLY at `available` with `malware_scan_status =
-- 'clean'`. Everything else is blocked, including the moment between upload and
-- scan. Fail-closed by construction: the default state is quarantined, not
-- available, so a version that never reaches the scanner is never servable.

-- ===========================================================================
-- 0. Preconditions
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_documents','builder_document_versions',
                           'document_processing_jobs','builder_portal_activity_log']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'PRE-MIGRATION FAILURE: required table public.% is absent', t;
    END IF;
  END LOOP;
END $$;

CREATE TEMP TABLE _builder_docscan_premigration AS
SELECT
  (SELECT count(*) FROM public.document_processing_jobs) AS jobs,
  (SELECT count(*) FROM public.builder_document_versions) AS builder_versions;

-- ===========================================================================
-- 1. Scan and lifecycle state on Builder document versions
--
-- Defaults are deliberately the SAFE end of each enum: a row created by any
-- path that predates this migration, or by a caller that forgets to set them,
-- is quarantined and unscanned rather than available and clean.
-- ===========================================================================
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS storage_bucket text NOT NULL DEFAULT 'builder-documents';
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'quarantined';
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS malware_scan_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS detected_mime_type text;
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS scan_provider text;
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS scan_reference text;
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS scan_details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS scanned_at timestamptz;
ALTER TABLE public.builder_document_versions
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;

ALTER TABLE public.builder_document_versions
  DROP CONSTRAINT IF EXISTS builder_document_versions_lifecycle_check;
ALTER TABLE public.builder_document_versions
  ADD CONSTRAINT builder_document_versions_lifecycle_check
  CHECK (lifecycle_status IN ('upload_pending','quarantined','scanning','available','superseded','rejected'));

ALTER TABLE public.builder_document_versions
  DROP CONSTRAINT IF EXISTS builder_document_versions_scan_check;
ALTER TABLE public.builder_document_versions
  ADD CONSTRAINT builder_document_versions_scan_check
  CHECK (malware_scan_status IN ('pending','scanning','clean','infected','error'));

-- The invariant the whole feature exists to enforce: `available` requires a
-- clean scan. A database-level CHECK makes it unrepresentable, so no future
-- code path can publish an unscanned version by mistake.
ALTER TABLE public.builder_document_versions
  DROP CONSTRAINT IF EXISTS builder_document_versions_available_requires_clean;
ALTER TABLE public.builder_document_versions
  ADD CONSTRAINT builder_document_versions_available_requires_clean
  CHECK (lifecycle_status <> 'available' OR malware_scan_status = 'clean') NOT VALID;

-- Any version that predates this migration has never been scanned, so it must
-- not be treated as safe. Quarantine them and let the processor re-verify.
UPDATE public.builder_document_versions
SET lifecycle_status = 'quarantined', malware_scan_status = 'pending'
WHERE lifecycle_status NOT IN ('rejected') AND malware_scan_status <> 'clean';

ALTER TABLE public.builder_document_versions
  VALIDATE CONSTRAINT builder_document_versions_available_requires_clean;

CREATE INDEX IF NOT EXISTS builder_document_versions_scan_queue_idx
  ON public.builder_document_versions (malware_scan_status, created_at)
  WHERE malware_scan_status IN ('pending', 'error');

COMMENT ON COLUMN public.builder_document_versions.lifecycle_status IS
  'Quarantine lifecycle. Only `available` is downloadable, and a CHECK constraint requires malware_scan_status = clean for that state.';

-- ===========================================================================
-- 2. Immutability once a verdict exists
--
-- Mirrors guard_immutable_document_version(): the identifying fields of a
-- version that has been scanned clean or infected cannot be rewritten, so a
-- clean verdict cannot be transplanted onto different bytes.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.guard_builder_document_version_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_DOCUMENT_VERSION_IMMUTABLE',
      DETAIL='document versions are append-only';
  END IF;

  IF OLD.malware_scan_status IN ('clean','infected')
     AND (OLD.document_id      IS DISTINCT FROM NEW.document_id
       OR OLD.version_number   IS DISTINCT FROM NEW.version_number
       OR OLD.storage_bucket   IS DISTINCT FROM NEW.storage_bucket
       OR OLD.storage_path     IS DISTINCT FROM NEW.storage_path
       OR OLD.sha256           IS DISTINCT FROM NEW.sha256
       OR OLD.byte_size        IS DISTINCT FROM NEW.byte_size
       OR OLD.detected_mime_type IS DISTINCT FROM NEW.detected_mime_type)
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_DOCUMENT_VERSION_IMMUTABLE',
      DETAIL='a scanned version cannot have its identity or content rewritten';
  END IF;

  RETURN NEW;
END $$;

-- The Phase-collaboration trigger refused EVERY update, which was correct when
-- a version had no lifecycle. The scan lifecycle must legitimately write
-- lifecycle_status, malware_scan_status, sha256 and the scan verdict onto an
-- existing row, so the blanket refusal is replaced by the state-aware guard
-- above: freely mutable while unscanned, identity-locked once a verdict exists,
-- never deletable.
DROP TRIGGER IF EXISTS trg_builder_document_versions_immutable ON public.builder_document_versions;

DROP TRIGGER IF EXISTS trg_guard_builder_document_version_immutable ON public.builder_document_versions;
CREATE TRIGGER trg_guard_builder_document_version_immutable
  BEFORE UPDATE OR DELETE ON public.builder_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_builder_document_version_immutable();

-- ===========================================================================
-- 3. Generalise the shared processing queue
--
-- Same discriminated-ownership shape as the rollout generalisation: add a
-- portal column and a Builder owner, make the Solicitor owner nullable, and
-- enforce exactly-one-owner with a CHECK.
-- ===========================================================================
ALTER TABLE public.document_processing_jobs
  ADD COLUMN IF NOT EXISTS portal text NOT NULL DEFAULT 'solicitor';
ALTER TABLE public.document_processing_jobs
  ADD COLUMN IF NOT EXISTS builder_document_version_id uuid
    REFERENCES public.builder_document_versions(id) ON DELETE CASCADE;

ALTER TABLE public.document_processing_jobs
  DROP CONSTRAINT IF EXISTS document_processing_jobs_portal_check;
ALTER TABLE public.document_processing_jobs
  ADD CONSTRAINT document_processing_jobs_portal_check
  CHECK (portal IN ('solicitor','builder'));

ALTER TABLE public.document_processing_jobs
  ALTER COLUMN document_version_id DROP NOT NULL;

ALTER TABLE public.document_processing_jobs
  DROP CONSTRAINT IF EXISTS document_processing_jobs_owner_agree;
ALTER TABLE public.document_processing_jobs
  ADD CONSTRAINT document_processing_jobs_owner_agree CHECK (
    (portal = 'solicitor' AND document_version_id IS NOT NULL AND builder_document_version_id IS NULL)
    OR
    (portal = 'builder' AND builder_document_version_id IS NOT NULL AND document_version_id IS NULL)
  ) NOT VALID;
ALTER TABLE public.document_processing_jobs
  VALIDATE CONSTRAINT document_processing_jobs_owner_agree;

CREATE UNIQUE INDEX IF NOT EXISTS document_processing_jobs_builder_key
  ON public.document_processing_jobs (builder_document_version_id)
  WHERE builder_document_version_id IS NOT NULL;

COMMENT ON TABLE public.document_processing_jobs IS
  'Shared document scanning queue. Since the Builder generalisation it carries both Solicitor and Builder versions, discriminated by the portal column.';

-- ===========================================================================
-- 4. Register an uploaded Builder version — enqueue for scanning
--
-- Called after the bytes land in private storage. Moves the version out of
-- upload_pending into quarantined and enqueues exactly one job.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_register_uploaded_document_version(
  _document_version_id uuid,
  _actor_builder_user_id uuid DEFAULT NULL,
  _actor_type text DEFAULT 'builder_user')
RETURNS public.builder_document_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.builder_document_versions; v_org uuid;
BEGIN
  SELECT * INTO v FROM public.builder_document_versions
  WHERE id = _document_version_id FOR UPDATE;
  IF v.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_VERSION_NOT_FOUND';
  END IF;
  IF v.lifecycle_status NOT IN ('upload_pending','quarantined') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_INVALID_STATE',
      DETAIL = format('lifecycle_status=%s', v.lifecycle_status);
  END IF;

  UPDATE public.builder_document_versions
  SET lifecycle_status = 'quarantined',
      malware_scan_status = 'pending',
      uploaded_at = COALESCE(uploaded_at, now())
  WHERE id = v.id
  RETURNING * INTO v;

  -- Idempotent: re-registering the same version does not queue it twice.
  INSERT INTO public.document_processing_jobs(portal, builder_document_version_id, document_version_id)
  VALUES ('builder', v.id, NULL)
  ON CONFLICT DO NOTHING;

  SELECT organisation_id INTO v_org FROM public.builder_documents WHERE id = v.document_id;

  PERFORM public.builder_log_activity(
    NULL, _actor_type, 'builder_document_version_quarantined',
    'document_version', v.id, v_org, _actor_builder_user_id,
    NULL,
    jsonb_build_object('lifecycle_status', v.lifecycle_status,
                       'malware_scan_status', v.malware_scan_status),
    NULL, jsonb_build_object('document_id', v.document_id));

  RETURN v;
END $$;

-- ===========================================================================
-- 4b. Uploads no longer publish themselves
--
-- The Phase-9-era `builder_add_document_version` set
-- `builder_documents.current_version_id` to the new row immediately, so an
-- unscanned — potentially infected — upload instantly became the version every
-- user of that document saw and could download. That is the heart of B1.
--
-- Redefined here as a forward fix (the merged migration is not edited): a new
-- version is created `upload_pending`, and ONLY
-- `complete_builder_document_processing` promotes it to current, after the
-- scanner returns clean.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_add_document_version(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _document_id uuid, _payload jsonb, _reason text DEFAULT NULL)
RETURNS public.builder_document_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.builder_documents; v_row public.builder_document_versions; v_next integer;
BEGIN
  IF NULLIF(btrim(COALESCE(_payload->>'storage_path','')), '') IS NULL
     OR NULLIF(btrim(COALESCE(_payload->>'file_name','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_FILE_REQUIRED';
  END IF;
  SELECT * INTO d FROM public.builder_documents WHERE id = _document_id FOR UPDATE;
  IF d.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_NOT_FOUND';
  END IF;

  SELECT COALESCE(max(version_number), 0) + 1 INTO v_next
  FROM public.builder_document_versions WHERE document_id = _document_id;

  INSERT INTO public.builder_document_versions(document_id, version_number, storage_path,
    file_name, content_type, byte_size, checksum, change_note,
    uploaded_by_type, uploaded_by_builder_user_id, uploaded_by_user_id,
    lifecycle_status, malware_scan_status)
  VALUES (_document_id, v_next, _payload->>'storage_path', _payload->>'file_name',
    COALESCE(_payload->>'content_type','application/pdf'),
    NULLIF(_payload->>'byte_size','')::bigint, _payload->>'checksum', _payload->>'change_note',
    _actor_type, _actor_builder_user_id, _actor_user_id,
    'upload_pending', 'pending')
  RETURNING * INTO v_row;

  -- Deliberately NOT setting current_version_id. An unscanned version is not
  -- the document.

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_document_version_added',
    'document_version', v_row.id, d.organisation_id, _actor_builder_user_id,
    NULL, jsonb_build_object('version_number', v_row.version_number,
                             'file_name', v_row.file_name,
                             'lifecycle_status', v_row.lifecycle_status),
    _reason, jsonb_build_object('document_id', _document_id));
  RETURN v_row;
END $$;

COMMENT ON FUNCTION public.builder_add_document_version IS
  'Creates an upload_pending version. Promotion to current happens only in complete_builder_document_processing, after a clean scan.';

-- ===========================================================================
-- 5. Portal-aware claim
--
-- claim_document_processing_jobs(worker, limit) is left EXACTLY as Phase 9
-- defined it — it is called by the deployed legal-document-processor and its
-- behaviour must not change. This is the Builder sibling.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.claim_builder_document_processing_jobs(
  _worker_id text, _limit integer DEFAULT 10)
RETURNS TABLE (
  job_id uuid, version_id uuid, storage_bucket text, storage_path text,
  declared_mime_type text, declared_byte_size bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.document_processing_jobs j
    SET status = 'processing', attempts = j.attempts + 1,
        locked_by = _worker_id, locked_at = now(), updated_at = now()
    WHERE j.id IN (
      SELECT j2.id FROM public.document_processing_jobs j2
      WHERE j2.portal = 'builder'
        AND j2.status IN ('queued','failed')
        AND j2.attempts < 5
        AND j2.available_at <= now()
      ORDER BY j2.available_at, j2.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(1, LEAST(COALESCE(_limit, 10), 50)))
    RETURNING j.id, j.builder_document_version_id)
  SELECT c.id, v.id, v.storage_bucket, v.storage_path, v.content_type, v.byte_size
  FROM claimed c
  JOIN public.builder_document_versions v ON v.id = c.builder_document_version_id;
END $$;

-- ===========================================================================
-- 6. Completion — the only path to `available`
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.complete_builder_document_processing(
  _job_id uuid, _worker_id text,
  _sha256 text, _detected_mime text, _byte_size bigint,
  _scan_status text, _scan_provider text, _scan_reference text,
  _scan_details jsonb, _error text DEFAULT NULL)
RETURNS public.builder_document_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.document_processing_jobs; v public.builder_document_versions;
  v_org uuid; v_previous uuid; v_clean boolean;
BEGIN
  IF _scan_status NOT IN ('clean','infected','error') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_UNKNOWN_SCAN_STATUS';
  END IF;

  SELECT * INTO j FROM public.document_processing_jobs
  WHERE id = _job_id AND portal = 'builder' FOR UPDATE;
  IF j.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_JOB_NOT_FOUND';
  END IF;

  SELECT * INTO v FROM public.builder_document_versions
  WHERE id = j.builder_document_version_id FOR UPDATE;
  IF v.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DOCUMENT_VERSION_NOT_FOUND';
  END IF;

  v_clean := (_scan_status = 'clean');

  IF v_clean THEN
    SELECT current_version_id INTO v_previous FROM public.builder_documents WHERE id = v.document_id;

    UPDATE public.builder_document_versions
    SET sha256 = _sha256, detected_mime_type = _detected_mime,
        byte_size = COALESCE(_byte_size, byte_size),
        malware_scan_status = 'clean', lifecycle_status = 'available',
        scan_provider = _scan_provider, scan_reference = _scan_reference,
        scan_details = COALESCE(_scan_details, '{}'::jsonb), scanned_at = now()
    WHERE id = v.id RETURNING * INTO v;

    -- Only a clean version becomes current; an infected upload can never
    -- displace the version people are already relying on.
    UPDATE public.builder_documents
    SET current_version_id = v.id WHERE id = v.document_id;

    IF v_previous IS NOT NULL AND v_previous <> v.id THEN
      UPDATE public.builder_document_versions
      SET lifecycle_status = 'superseded'
      WHERE id = v_previous AND lifecycle_status = 'available';
    END IF;
  ELSE
    UPDATE public.builder_document_versions
    SET sha256 = CASE WHEN _sha256 ~ '^[0-9a-f]{64}$' THEN _sha256 ELSE sha256 END,
        detected_mime_type = _detected_mime,
        malware_scan_status = CASE WHEN _scan_status = 'infected' THEN 'infected' ELSE 'error' END,
        -- An infected file is rejected permanently. A scanner error keeps the
        -- version quarantined so the job can be retried.
        lifecycle_status = CASE WHEN _scan_status = 'infected' THEN 'rejected' ELSE 'quarantined' END,
        scan_provider = _scan_provider, scan_reference = _scan_reference,
        scan_details = COALESCE(_scan_details, '{}'::jsonb), scanned_at = now()
    WHERE id = v.id RETURNING * INTO v;
  END IF;

  -- A scanner error is retryable with backoff until the attempt ceiling, after
  -- which the job is dead-lettered and shows up in builder_document_scan_health.
  UPDATE public.document_processing_jobs
  SET status = CASE
        WHEN _scan_status <> 'error' THEN 'succeeded'
        WHEN j.attempts >= 5 THEN 'dead_lettered'
        ELSE 'failed' END,
      available_at = CASE
        WHEN _scan_status = 'error' AND j.attempts < 5
        THEN now() + (interval '1 minute' * power(2, LEAST(j.attempts, 5)))
        ELSE available_at END,
      last_error = left(_error, 2000),
      updated_at = now()
  WHERE id = j.id;

  SELECT organisation_id INTO v_org FROM public.builder_documents WHERE id = v.document_id;

  PERFORM public.builder_log_activity(
    NULL, 'system',
    CASE WHEN v_clean THEN 'builder_document_scan_passed'
         WHEN _scan_status = 'infected' THEN 'builder_document_malware_detected'
         ELSE 'builder_document_scan_failed' END,
    'document_version', v.id, v_org, NULL,
    NULL,
    jsonb_build_object('lifecycle_status', v.lifecycle_status,
                       'malware_scan_status', v.malware_scan_status,
                       'scan_provider', v.scan_provider),
    left(_error, 500),
    jsonb_build_object('document_id', v.document_id, 'job_id', j.id));

  RETURN v;
END $$;

-- ===========================================================================
-- 7. Download authorisation
--
-- The state half of the decision. The Edge Function still resolves the caller's
-- CURRENT permission and grant separately; this refuses on content safety, and
-- the two together gate the signed URL.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_document_version_is_downloadable(_version_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.builder_document_versions
    WHERE id = _version_id
      AND malware_scan_status = 'clean'
      AND lifecycle_status IN ('available','superseded'));
$$;

COMMENT ON FUNCTION public.builder_document_version_is_downloadable(uuid) IS
  'Content-safety half of the download decision. Never sufficient on its own — the caller''s current permission and grant are resolved separately and both must pass.';

-- ===========================================================================
-- 8. Operational visibility
-- ===========================================================================
CREATE OR REPLACE VIEW public.builder_document_scan_health AS
SELECT
  count(*) FILTER (WHERE v.malware_scan_status = 'pending')  AS pending,
  count(*) FILTER (WHERE v.malware_scan_status = 'scanning') AS scanning,
  count(*) FILTER (WHERE v.malware_scan_status = 'clean')    AS clean,
  count(*) FILTER (WHERE v.malware_scan_status = 'infected') AS infected,
  count(*) FILTER (WHERE v.malware_scan_status = 'error')    AS errored,
  count(*) FILTER (WHERE v.malware_scan_status IN ('pending','scanning')
                     AND v.created_at < now() - interval '1 hour') AS stuck_over_1h,
  (SELECT count(*) FROM public.document_processing_jobs
    WHERE portal = 'builder' AND status = 'failed' AND attempts >= 5) AS dead_lettered
FROM public.builder_document_versions v;

COMMENT ON VIEW public.builder_document_scan_health IS
  'Builder document scanning health. stuck_over_1h and dead_lettered are the signals that the processor is not running or the scanner is unreachable.';

-- ===========================================================================
-- 9. Privileges
-- ===========================================================================
REVOKE ALL ON FUNCTION
  public.builder_register_uploaded_document_version(uuid, uuid, text),
  public.claim_builder_document_processing_jobs(text, integer),
  public.complete_builder_document_processing(uuid, text, text, text, bigint, text, text, text, jsonb, text),
  public.builder_document_version_is_downloadable(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.builder_register_uploaded_document_version(uuid, uuid, text),
  public.claim_builder_document_processing_jobs(text, integer),
  public.complete_builder_document_processing(uuid, text, text, text, bigint, text, text, text, jsonb, text),
  public.builder_document_version_is_downloadable(uuid)
TO service_role;

REVOKE ALL ON public.builder_document_scan_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.builder_document_scan_health TO service_role;

-- ===========================================================================
-- 10. Readiness now has real evidence to evaluate
--
-- get_builder_cutover_readiness already asks for `malware_scan_status` and
-- `lifecycle_status` on builder_document_versions and fails when they are
-- absent. They now exist, so the check evaluates genuine state instead of
-- reporting a missing capability. The blocker is NOT removed — it now measures
-- whether documents are actually clean.
-- ===========================================================================
DO $$
DECLARE v_before record; v_n bigint;
BEGIN
  SELECT * INTO v_before FROM _builder_docscan_premigration;

  IF (SELECT count(*) FROM public.builder_document_versions) <> v_before.builder_versions THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: builder document version count changed'; END IF;
  IF (SELECT count(*) FROM public.document_processing_jobs WHERE portal='solicitor') <> v_before.jobs THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: solicitor processing jobs changed'; END IF;

  -- The Solicitor claim function must be untouched.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='claim_document_processing_jobs')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='claim_document_processing_jobs'
                    AND pg_get_function_identity_arguments(p.oid) = '_worker_id text, _limit integer')
  THEN RAISE EXCEPTION 'POST-MIGRATION FAILURE: solicitor claim signature changed'; END IF;

  -- No Builder version may be available without a clean scan.
  SELECT count(*) INTO v_n FROM public.builder_document_versions
  WHERE lifecycle_status = 'available' AND malware_scan_status <> 'clean';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: % builder version(s) available without a clean scan', v_n; END IF;

  -- Readiness must still be able to see both columns.
  SELECT count(*) INTO v_n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='builder_document_versions'
    AND column_name IN ('malware_scan_status','lifecycle_status');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: readiness evidence columns are absent'; END IF;

  RAISE NOTICE 'builder document quarantine and scanning installed; solicitor pipeline unchanged';
END $$;

DROP TABLE IF EXISTS _builder_docscan_premigration;
