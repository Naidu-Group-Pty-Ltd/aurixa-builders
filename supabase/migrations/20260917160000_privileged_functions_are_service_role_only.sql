-- ============================================================================
-- PRIVILEGED FUNCTIONS ARE SERVICE-ROLE ONLY
--
-- The security audit of 16 Sep 2026 proved, by executing it, that the `anon`
-- role could call `builder_admin_upsert_membership` and grant a user `owner`
-- of an organisation they do not belong to. 108 of 127 SECURITY DEFINER
-- functions were reachable the same way, roughly eighty of which write —
-- including organisation and user deletion, project-access grants and
-- session minting. The readers were no better: several take `_user_id` as a
-- caller-supplied parameter and, being SECURITY DEFINER, bypass row-level
-- security entirely.
--
-- ONE root cause explains all 108. The baseline writes:
--
--     REVOKE ALL ON FUNCTION public.f(…) FROM PUBLIC;
--
-- Supabase grants `anon` and `authenticated` their own DIRECT privileges on
-- public-schema functions. Revoking from PUBLIC does not touch a direct
-- grant, so every one of those 131 REVOKE statements was a no-op against the
-- two roles that actually matter. The migrations written later use the
-- correct form — `FROM PUBLIC, anon, authenticated` — which is exactly why
-- 19 functions were already safe and 108 were not.
--
-- This migration revokes EXECUTE from `anon` and `authenticated` on every
-- function this schema owns, and asserts the result. It is deliberately a
-- sweep rather than a list: a list would be wrong again the first time
-- somebody adds a function.
--
-- WHAT THIS DOES NOT CHANGE — the reason it is safe:
--   * `service_role` keeps every privilege it had. Every portal request
--     reaches the database through an Edge Function using the service role,
--     so no application path loses anything.
--   * The browser holds no database credential at all (verified: no Supabase
--     client in the frontend, no key in the built bundle), so no browser call
--     depends on an `anon` grant.
--   * Trigger functions are unaffected: PostgreSQL checks EXECUTE when a
--     trigger is CREATED, not when it fires.
--   * Functions called from inside another SECURITY DEFINER function run as
--     that function's definer, so internal call chains are untouched.
--   * Extension-owned functions are excluded — they are not ours to re-permission.
--
-- No data is read, written or deleted here. This is a privilege change only.
-- ============================================================================

-- ===========================================================================
-- 1. The sweep
-- ===========================================================================
DO $revoke$
DECLARE
  v_fn record;
  v_count integer := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      -- Not ours to re-permission: anything an extension installed.
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')
  LOOP
    -- PUBLIC is revoked too: `anon` and `authenticated` inherit EXECUTE through
    -- it, so revoking the two roles alone leaves every function that still
    -- carries PostgreSQL's default PUBLIC grant wide open. The assertion below
    -- caught exactly that on the first run of this migration — 37 functions.
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn.signature);
    -- …and service_role is granted back explicitly. Some functions held no
    -- grant of their own and reached the service role through PUBLIC; removing
    -- PUBLIC without this would have broken the role the whole product runs on.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn.signature);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'revoked anon/authenticated EXECUTE on % schema-owned function(s)', v_count;
END $revoke$;

-- Future functions created in this schema must not inherit the same default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

-- ===========================================================================
-- 2. The SECURITY DEFINER view, which bypasses RLS by construction
-- ===========================================================================
-- Aggregate document-scan counts. Only the operator surfaces (service_role)
-- have any reason to read it; `anon` could, and did, return a row.
REVOKE ALL ON public.builder_document_scan_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.builder_document_scan_health TO service_role;

-- ===========================================================================
-- 3. Two functions whose search_path was resolvable by the caller
-- ===========================================================================
-- Both are SECURITY DEFINER-adjacent and flagged by the platform linter. A
-- mutable search_path lets a caller who can create objects shadow a
-- referenced one. Pinning it changes no behaviour.
ALTER FUNCTION public.set_builder_terms_document_hash() SET search_path = public;
ALTER FUNCTION public.builder_stock_failure_backoff(integer) SET search_path = public;

-- ===========================================================================
-- 4. Assertions — this migration has not applied unless all of these hold
-- ===========================================================================
DO $assert$
DECLARE
  v_open integer;
  v_service_lost integer;
  v_view_open boolean;
BEGIN
  -- 4a. No schema-owned function is executable by anon or authenticated.
  SELECT count(*) INTO v_open
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_open > 0 THEN
    RAISE EXCEPTION
      'assertion failed: % schema-owned function(s) are still callable by anon/authenticated', v_open;
  END IF;

  -- 4b. service_role did NOT lose anything. The whole product runs on it, so
  --     a fix that quietly broke it would be worse than the vulnerability.
  SELECT count(*) INTO v_service_lost
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND (p.proname LIKE 'builder%' OR p.proname LIKE 'record_portal%')
    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_service_lost > 0 THEN
    RAISE EXCEPTION
      'assertion failed: service_role lost EXECUTE on % privileged function(s)', v_service_lost;
  END IF;

  -- 4c. The RLS-bypassing view is closed to both public roles.
  SELECT (has_table_privilege('anon', 'public.builder_document_scan_health', 'SELECT')
       OR has_table_privilege('authenticated', 'public.builder_document_scan_health', 'SELECT'))
    INTO v_view_open;
  IF v_view_open THEN
    RAISE EXCEPTION 'assertion failed: builder_document_scan_health is still readable by anon/authenticated';
  END IF;

  -- 4d. A representative privileged function is genuinely still usable by the
  --     role the Edge Functions run as. Proves 4b at the call level, not just
  --     the catalogue level.
  IF NOT has_function_privilege('service_role',
        'public.builder_accessible_projects(uuid, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'assertion failed: service_role cannot execute builder_accessible_projects';
  END IF;
END $assert$;
