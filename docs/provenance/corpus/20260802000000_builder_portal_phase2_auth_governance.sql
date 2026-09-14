-- Builder / Developer Portal — Phase 2: authentication, governance and session context.
--
-- Additive only. Every Phase 1 table, constraint, policy and function is reused
-- unchanged; this closes the five gaps the mirroring inventory identified
-- (docs/builder-portal/13-phase-2-mirroring-inventory.md §6).
--
-- Solicitor blueprint:
--   20260730110751  solicitor_portal_users login-attempt columns
--   20260730190000  solicitor_onboarding_steps
--   20260730130000  consume_solicitor_portal_reset_attempt
--
-- Divergences from that blueprint, all deliberate (Phase 0 NOCOPY findings):
--   * Reset and invite tokens are compared by HASH. Phase 1 stores
--     reset_token_hash / invite_token_hash and no plaintext column exists, so
--     the reset-attempt function takes a hash rather than returning a secret.
--   * Terms acceptance, onboarding completion and organisation selection are
--     guarded commands that write a trusted audit row in the same transaction.

-- ===========================================================================
-- 1. Login attempt tracking
-- ===========================================================================
ALTER TABLE public.builder_portal_users
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

ALTER TABLE public.builder_portal_users
  DROP CONSTRAINT IF EXISTS builder_portal_users_failed_attempts_sane;
ALTER TABLE public.builder_portal_users
  ADD CONSTRAINT builder_portal_users_failed_attempts_sane
  CHECK (failed_login_attempts >= 0 AND failed_login_attempts <= 1000);

COMMENT ON COLUMN public.builder_portal_users.locked_until IS
  'Set when failed_login_attempts reaches the lockout threshold. Login returns the generic credential error while locked, so lockout is never observable without valid credentials.';

-- ===========================================================================
-- 2. Onboarding steps
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_onboarding_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  step_key text NOT NULL CHECK (step_key IN
    ('profile_confirmed', 'organisation_confirmed', 'contact_confirmed', 'security_reviewed')),
  mandatory boolean NOT NULL DEFAULT true,
  completed_at timestamptz,
  completed_session_id uuid REFERENCES public.builder_portal_sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_user_id, step_key)
);

CREATE INDEX IF NOT EXISTS builder_onboarding_steps_user_idx
  ON public.builder_onboarding_steps(builder_user_id);

COMMENT ON TABLE public.builder_onboarding_steps IS
  'Per-user Builder onboarding checklist. Mirrors solicitor_onboarding_steps. Onboarding confirms identity and organisation context only — it never creates business records.';

-- Seed the mandatory checklist for a user. Idempotent, so a resent invite or a
-- re-run never duplicates or resets a completed step.
CREATE OR REPLACE FUNCTION public.builder_ensure_onboarding_steps(_builder_user_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inserted integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.builder_portal_users WHERE id = _builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;

  WITH seeded AS (
    INSERT INTO public.builder_onboarding_steps(builder_user_id, step_key, mandatory)
    SELECT _builder_user_id, k, true
    FROM unnest(ARRAY['profile_confirmed','organisation_confirmed','contact_confirmed','security_reviewed']) AS k
    ON CONFLICT (builder_user_id, step_key) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer INTO v_inserted FROM seeded;

  RETURN v_inserted;
END $$;

-- ===========================================================================
-- 3. Server-held active organisation context
--
-- Phase 1 permits a user to hold memberships in several organisations. The
-- selected organisation is held on the SESSION ROW, never in a browser value:
-- a forged client field cannot change what the server considers active, and the
-- guard re-verifies membership at selection time as well as on every read.
-- ===========================================================================
ALTER TABLE public.builder_portal_sessions
  ADD COLUMN IF NOT EXISTS active_organisation_id uuid
    REFERENCES public.builder_organisations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS builder_portal_sessions_active_org_idx
  ON public.builder_portal_sessions(active_organisation_id)
  WHERE active_organisation_id IS NOT NULL;

COMMENT ON COLUMN public.builder_portal_sessions.active_organisation_id IS
  'Server-held active organisation for this session. Only set through builder_select_session_organisation(), which re-verifies membership. Never trusted from the browser.';

-- A session may only point at an organisation its owner can actually reach.
-- Enforced by trigger so no code path — including a future one — can set it
-- without the membership check.
CREATE OR REPLACE FUNCTION public.builder_guard_session_organisation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.active_organisation_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.builder_accessible_organisations(NEW.builder_user_id) a
    WHERE a.organisation_id = NEW.active_organisation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_ORGANISATION_NOT_ACCESSIBLE',
      DETAIL='the session owner holds no active membership of that organisation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_guard_session_organisation ON public.builder_portal_sessions;
CREATE TRIGGER trg_builder_guard_session_organisation
  BEFORE INSERT OR UPDATE OF active_organisation_id, builder_user_id
  ON public.builder_portal_sessions
  FOR EACH ROW EXECUTE FUNCTION public.builder_guard_session_organisation();

-- Guarded selection command: verifies membership, sets the context and writes a
-- trusted audit row in one transaction.
CREATE OR REPLACE FUNCTION public.builder_select_session_organisation(
  _session_id uuid,
  _builder_user_id uuid,
  _organisation_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_previous uuid; v_updated uuid;
BEGIN
  SELECT active_organisation_id INTO v_previous
  FROM public.builder_portal_sessions
  WHERE id = _session_id AND builder_user_id = _builder_user_id AND revoked_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SESSION_NOT_FOUND';
  END IF;

  -- The trigger enforces this too; raising here gives the Edge Function a
  -- specific error to map onto 403 rather than a generic constraint failure.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_accessible_organisations(_builder_user_id) a
    WHERE a.organisation_id = _organisation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORGANISATION_NOT_ACCESSIBLE';
  END IF;

  UPDATE public.builder_portal_sessions
  SET active_organisation_id = _organisation_id
  WHERE id = _session_id AND builder_user_id = _builder_user_id AND revoked_at IS NULL
  RETURNING active_organisation_id INTO v_updated;

  PERFORM public.builder_log_activity(
    NULL, 'builder_user', 'builder_active_organisation_selected',
    'session', _session_id, _organisation_id, _builder_user_id,
    jsonb_build_object('active_organisation_id', v_previous),
    jsonb_build_object('active_organisation_id', v_updated),
    NULL, '{}'::jsonb);

  RETURN v_updated;
END $$;

-- ===========================================================================
-- 4. Terms acceptance — guarded, fail-closed, one per user and version
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_accept_current_terms(
  _builder_user_id uuid,
  _session_id uuid,
  _ip_hash text DEFAULT NULL,
  _user_agent_hash text DEFAULT NULL)
RETURNS TABLE (terms_version_id uuid, version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_terms record;
BEGIN
  -- Session ownership, the same check builder_select_session_organisation
  -- performs below. Without it the function trusts whatever pair of ids it is
  -- handed, so a caller holding one valid session could record an acceptance
  -- against another user, or a revoked session could still write one.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_portal_sessions
    WHERE id = _session_id AND builder_user_id = _builder_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SESSION_NOT_FOUND';
  END IF;

  -- Aliased deliberately: this function's OUT column is also called `version`,
  -- so selecting the column under its own name makes the reference ambiguous
  -- and the function fails at runtime for every caller.
  SELECT ptv.id AS terms_id, ptv.version AS terms_version INTO v_terms
  FROM public.portal_terms_versions ptv
  WHERE ptv.portal = 'builder' AND ptv.retired_at IS NULL AND ptv.effective_at <= now()
  ORDER BY ptv.effective_at DESC LIMIT 1;

  IF v_terms.terms_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TERMS_UNAVAILABLE';
  END IF;

  -- portal_terms_acceptances carries the Phase 1 ownership constraints:
  -- exactly one owner, owner must agree with the portal, and the trigger
  -- matches the acceptance portal to the version portal. A user therefore
  -- cannot accept on another user's or another portal's behalf.
  -- Bare `ON CONFLICT DO NOTHING` rather than a column inference list: this
  -- function's OUT column is also called `terms_version_id`, and an inference
  -- list is an expression context where plpgsql resolves that name to the OUT
  -- variable, making the reference ambiguous and failing at runtime. Only one
  -- row is inserted, so "any unique violation" is the same conflict either way.
  INSERT INTO public.portal_terms_acceptances(
    terms_version_id, portal, builder_user_id, ip_hash, user_agent_hash)
  VALUES (v_terms.terms_id, 'builder', _builder_user_id, _ip_hash, _user_agent_hash)
  ON CONFLICT DO NOTHING;

  UPDATE public.builder_portal_users
  SET has_accepted_current_terms = true, terms_accepted_at = now()
  WHERE id = _builder_user_id;

  PERFORM public.builder_log_activity(
    NULL, 'builder_user', 'builder_terms_accepted',
    'portal_user', _builder_user_id, NULL, _builder_user_id,
    NULL, jsonb_build_object('terms_version_id', v_terms.terms_id, 'version', v_terms.terms_version),
    NULL, jsonb_build_object('session_id', _session_id));

  terms_version_id := v_terms.terms_id;
  version := v_terms.terms_version;
  RETURN NEXT;
END $$;

-- ===========================================================================
-- 5. Onboarding completion — guarded, fail-closed
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_complete_onboarding(
  _builder_user_id uuid,
  _session_id uuid,
  _step_key text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mandatory_total integer; v_mandatory_done integer; v_complete boolean;
BEGIN
  -- Session ownership, as in builder_accept_current_terms and
  -- builder_select_session_organisation. `completed_session_id` is stamped from
  -- `_session_id`, so an unverified pair would attribute a completion to a
  -- session that does not belong to the user.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_portal_sessions
    WHERE id = _session_id AND builder_user_id = _builder_user_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SESSION_NOT_FOUND';
  END IF;

  PERFORM public.builder_ensure_onboarding_steps(_builder_user_id);

  UPDATE public.builder_onboarding_steps
  SET completed_at = COALESCE(completed_at, now()),
      completed_session_id = COALESCE(completed_session_id, _session_id)
  WHERE builder_user_id = _builder_user_id
    AND (_step_key IS NULL OR step_key = _step_key);

  SELECT count(*) FILTER (WHERE mandatory),
         count(*) FILTER (WHERE mandatory AND completed_at IS NOT NULL)
  INTO v_mandatory_total, v_mandatory_done
  FROM public.builder_onboarding_steps
  WHERE builder_user_id = _builder_user_id;

  v_complete := v_mandatory_total > 0 AND v_mandatory_done = v_mandatory_total;

  UPDATE public.builder_portal_users
  SET has_completed_onboarding = v_complete
  WHERE id = _builder_user_id;

  PERFORM public.builder_log_activity(
    NULL, 'builder_user', 'builder_onboarding_updated',
    'portal_user', _builder_user_id, NULL, _builder_user_id,
    NULL, jsonb_build_object('step_key', _step_key, 'mandatory_complete', v_complete),
    NULL, jsonb_build_object('session_id', _session_id));

  RETURN v_complete;
END $$;

-- ===========================================================================
-- 6. Atomic reset-attempt consumption
--
-- Mirrors consume_solicitor_portal_reset_attempt, with one deliberate
-- difference: Phase 1 stores only reset_token_hash, so this function takes the
-- candidate HASH and answers match/no-match. No secret is ever returned.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.consume_builder_portal_reset_attempt(
  p_email text, p_token_hash text, p_max integer)
RETURNS TABLE (status text, user_id uuid, invite_accepted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_hash text; v_expires_at timestamptz; v_attempts integer;
  v_invite_accepted timestamptz;
BEGIN
  -- Every RETURNING target is table-qualified: this function's OUT columns
  -- include `user_id` and `invite_accepted_at`, and an unqualified reference in
  -- RETURNING resolves ambiguously against them, failing at runtime.
  UPDATE public.builder_portal_users u
     SET reset_attempts = COALESCE(u.reset_attempts, 0) + 1
   WHERE u.id = (
     SELECT b.id FROM public.builder_portal_users b
      WHERE lower(btrim(b.email)) = lower(btrim(p_email))
        AND b.reset_token_hash IS NOT NULL
        AND b.is_active AND b.revoked_at IS NULL
      LIMIT 1)
  RETURNING u.id, u.reset_token_hash, u.reset_token_expires_at, u.reset_attempts, u.invite_accepted_at
       INTO v_id, v_hash, v_expires_at, v_attempts, v_invite_accepted;

  IF v_id IS NULL THEN
    status := 'not_found'; user_id := NULL; invite_accepted_at := NULL;
    RETURN NEXT; RETURN;
  END IF;

  IF v_attempts > p_max THEN
    status := 'too_many'; user_id := v_id; invite_accepted_at := v_invite_accepted;
    RETURN NEXT; RETURN;
  END IF;

  IF v_expires_at IS NULL OR v_expires_at < now() THEN
    status := 'expired'; user_id := v_id; invite_accepted_at := v_invite_accepted;
    RETURN NEXT; RETURN;
  END IF;

  -- Hash comparison. A mismatch is reported as not_found so a caller cannot
  -- distinguish "wrong code" from "no such account" (Phase 0 SEC-12).
  IF p_token_hash IS NULL OR v_hash IS DISTINCT FROM p_token_hash THEN
    status := 'not_found'; user_id := NULL; invite_accepted_at := NULL;
    RETURN NEXT; RETURN;
  END IF;

  status := 'ok'; user_id := v_id; invite_accepted_at := v_invite_accepted;
  RETURN NEXT;
END $$;

-- ===========================================================================
-- 7. Rollout definition default stays OFF
--
-- builder_portal_identity_v1 was seeded 'off' in Phase 1. Asserted here so a
-- later edit cannot silently enable the external portal for every organisation.
-- ===========================================================================
DO $$
DECLARE v_mode text;
BEGIN
  SELECT default_mode INTO v_mode FROM public.cross_portal_feature_definitions
  WHERE feature_key = 'builder_portal_identity_v1';

  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: builder_portal_identity_v1 is not defined';
  END IF;
  IF v_mode <> 'off' THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: builder_portal_identity_v1 default_mode is % — Phase 2 requires off', v_mode;
  END IF;
END $$;

-- ===========================================================================
-- 8. RLS and grants — deny by default, matching every other Builder object
-- ===========================================================================
ALTER TABLE public.builder_onboarding_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_onboarding_steps_service ON public.builder_onboarding_steps;
CREATE POLICY builder_onboarding_steps_service ON public.builder_onboarding_steps
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.builder_onboarding_steps FROM anon, authenticated;
GRANT ALL ON public.builder_onboarding_steps TO service_role;

REVOKE ALL ON FUNCTION public.builder_ensure_onboarding_steps(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_select_session_organisation(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_accept_current_terms(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_complete_onboarding(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_builder_portal_reset_attempt(text, text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.builder_ensure_onboarding_steps(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_select_session_organisation(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_accept_current_terms(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_complete_onboarding(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_builder_portal_reset_attempt(text, text, integer) TO service_role;

-- ===========================================================================
-- 9. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_ensure_onboarding_steps','builder_select_session_organisation',
    'builder_accept_current_terms','builder_complete_onboarding',
    'consume_builder_portal_reset_attempt','builder_guard_session_organisation']) AS f
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: Phase 2 function(s) missing: %', v_missing;
  END IF;

  -- No plaintext credential column may have appeared.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='builder_portal_users'
      AND column_name IN ('session_token','reset_token','invite_token')) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a plaintext credential column exists on builder_portal_users';
  END IF;

  RAISE NOTICE 'builder phase 2: login tracking, onboarding steps, session organisation context and reset consumption installed';
END $$;
