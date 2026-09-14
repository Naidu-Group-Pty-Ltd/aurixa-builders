-- Builder / Developer Portal — Phase 1: secure session foundation.
--
-- Phase 0 finding NOCOPY-02: the Solicitor Portal still carries a plaintext
-- `session_token` column and a legacy header/body token carrier. Builder is
-- cookie-only from its first commit, so no such path is ever created and there
-- is nothing to migrate away from later.
--
-- Invariants enforced here rather than merely documented:
--   * Only a SHA-256 hash of the session token is ever stored. The column is
--     CHECK-constrained to 64 lowercase hex characters, so a raw token is not a
--     storable value.
--   * No database API accepts or returns a raw token. builder_issue_session()
--     takes a hash that the Edge Function computed; the raw token exists only in
--     the Edge Function's memory and the Set-Cookie header.
--   * Idle expiry can never exceed absolute expiry.
--   * Revocation is checked inside the same statement that touches the session,
--     so a session revoked concurrently cannot serve an in-flight request.

CREATE TABLE IF NOT EXISTS public.builder_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,

  -- SHA-256 hex digest. A raw token cannot satisfy this constraint.
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  created_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),

  revoked_at timestamptz,
  revoked_reason text,

  -- Fingerprints, not identifiers: hashed so a session row does not become a
  -- record of where a person was.
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent_hash text CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[0-9a-f]{64}$'),
  device_label text CHECK (device_label IS NULL OR length(device_label) <= 120),

  CONSTRAINT builder_portal_sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT builder_portal_sessions_absolute_after_creation CHECK (absolute_expires_at > created_at),
  CONSTRAINT builder_portal_sessions_revocation_reason CHECK (
    revoked_at IS NULL OR revoked_reason IS NOT NULL)
);

-- A token hash identifies exactly one session.
CREATE UNIQUE INDEX IF NOT EXISTS builder_portal_sessions_token_hash_key
  ON public.builder_portal_sessions(token_hash);

-- Multiple concurrent sessions per user are supported; this index serves the
-- "list my devices" and "revoke all" paths.
CREATE INDEX IF NOT EXISTS builder_portal_sessions_live_idx
  ON public.builder_portal_sessions(builder_user_id, last_used_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS builder_portal_sessions_expiry_idx
  ON public.builder_portal_sessions(absolute_expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.builder_portal_sessions IS
  'Builder Portal sessions. Separate from solicitor_portal_sessions: no shared row, no shared cookie, no shared resolver. Only SHA-256 token hashes are stored; raw tokens never reach the database.';
COMMENT ON COLUMN public.builder_portal_sessions.token_hash IS
  'SHA-256 hex digest of the session token. The raw token lives only in the HttpOnly __Host-builder_session_token cookie.';

-- ===========================================================================
-- Session commands
--
-- All are SECURITY DEFINER and granted to service_role only. None accepts or
-- returns a raw token.
-- ===========================================================================

-- Issue a session from a hash the Edge Function already computed.
CREATE OR REPLACE FUNCTION public.builder_issue_session(
  _user_id uuid,
  _token_hash text,
  _absolute_expires_at timestamptz,
  _idle_expires_at timestamptz,
  _ip_hash text DEFAULT NULL,
  _user_agent_hash text DEFAULT NULL,
  _device_label text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_session_id uuid; v_ok boolean;
BEGIN
  IF _token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SESSION_TOKEN_NOT_HASHED';
  END IF;

  -- A session may only be issued to an active user who holds at least one
  -- active membership. No membership means no portal access, at the point of
  -- issue as well as at every later authorization check.
  SELECT EXISTS (
    SELECT 1 FROM public.builder_portal_users u
    WHERE u.id = _user_id AND u.is_active AND u.status = 'active' AND u.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM public.builder_accessible_organisations(u.id))
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SESSION_NOT_PERMITTED';
  END IF;

  INSERT INTO public.builder_portal_sessions(
    builder_user_id, token_hash, absolute_expires_at, idle_expires_at,
    ip_hash, user_agent_hash, device_label)
  VALUES (_user_id, _token_hash, _absolute_expires_at,
          LEAST(_idle_expires_at, _absolute_expires_at),
          _ip_hash, _user_agent_hash, _device_label)
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END $$;

-- Resolve a session by hash and slide its idle window. Returns identity only —
-- never the hash, and never anything resembling a token.
CREATE OR REPLACE FUNCTION public.builder_resolve_session(
  _token_hash text, _idle_minutes integer DEFAULT 30)
RETURNS TABLE (session_id uuid, builder_user_id uuid, absolute_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row record; v_new_idle timestamptz;
BEGIN
  IF _token_hash IS NULL OR _token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  SELECT s.id, s.builder_user_id, s.absolute_expires_at, s.idle_expires_at
  INTO v_row
  FROM public.builder_portal_sessions s
  WHERE s.token_hash = _token_hash AND s.revoked_at IS NULL;

  IF v_row.id IS NULL THEN RETURN; END IF;
  IF v_row.absolute_expires_at <= now() OR v_row.idle_expires_at <= now() THEN RETURN; END IF;

  v_new_idle := LEAST(now() + make_interval(mins => GREATEST(_idle_minutes, 1)),
                      v_row.absolute_expires_at);

  -- The revoked_at re-check inside the UPDATE closes the race between a
  -- concurrent revoke and an in-flight request: if the revoke landed first, no
  -- row is updated and the session does not resolve.
  UPDATE public.builder_portal_sessions s
  SET last_used_at = now(), idle_expires_at = v_new_idle
  WHERE s.id = v_row.id AND s.revoked_at IS NULL
  RETURNING s.id, s.builder_user_id, s.absolute_expires_at
  INTO session_id, builder_user_id, absolute_expires_at;

  IF session_id IS NULL THEN RETURN; END IF;

  -- The user and at least one membership must still be live. A user whose last
  -- membership was revoked loses portal access immediately, without waiting for
  -- the session to expire.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_portal_users u
    WHERE u.id = builder_resolve_session.builder_user_id
      AND u.is_active AND u.status = 'active' AND u.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM public.builder_accessible_organisations(u.id))
  ) THEN
    session_id := NULL; builder_user_id := NULL; absolute_expires_at := NULL;
    RETURN;
  END IF;

  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.builder_revoke_session(_session_id uuid, _reason text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH revoked AS (
    UPDATE public.builder_portal_sessions
    SET revoked_at = now(), revoked_reason = COALESCE(NULLIF(btrim(_reason), ''), 'revoked')
    WHERE id = _session_id AND revoked_at IS NULL
    RETURNING id)
  SELECT EXISTS (SELECT 1 FROM revoked);
$$;

-- Revoke every live session for a user. This is the password-reset and
-- password-change invalidation path, and the membership-revocation path.
CREATE OR REPLACE FUNCTION public.builder_revoke_user_sessions(
  _user_id uuid, _reason text, _except_session_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH revoked AS (
    UPDATE public.builder_portal_sessions
    SET revoked_at = now(), revoked_reason = COALESCE(NULLIF(btrim(_reason), ''), 'revoked')
    WHERE builder_user_id = _user_id
      AND revoked_at IS NULL
      AND (_except_session_id IS NULL OR id <> _except_session_id)
    RETURNING id)
  SELECT count(*)::integer FROM revoked;
$$;

COMMENT ON FUNCTION public.builder_revoke_user_sessions(uuid, text, uuid) IS
  'Revokes every live Builder session for a user. Called on password reset, password change, membership revocation and account suspension.';

-- Revoking a user's last active membership must not leave a usable session
-- behind. Enforced in the database so no caller can forget it.
CREATE OR REPLACE FUNCTION public.builder_revoke_sessions_on_membership_loss()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL)
     OR (NEW.status <> 'active' AND OLD.status = 'active') THEN
    IF NOT EXISTS (SELECT 1 FROM public.builder_accessible_organisations(NEW.builder_user_id)) THEN
      PERFORM public.builder_revoke_user_sessions(
        NEW.builder_user_id, 'membership_revoked');
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_membership_session_revocation
  ON public.builder_organisation_memberships;
CREATE TRIGGER trg_builder_membership_session_revocation
  AFTER UPDATE OF status, revoked_at ON public.builder_organisation_memberships
  FOR EACH ROW EXECUTE FUNCTION public.builder_revoke_sessions_on_membership_loss();

-- Suspending or revoking a user kills their sessions in the same transaction.
CREATE OR REPLACE FUNCTION public.builder_revoke_sessions_on_user_deactivation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status <> 'active' AND OLD.status = 'active' THEN
    PERFORM public.builder_revoke_user_sessions(NEW.id, 'user_' || NEW.status);
  ELSIF NEW.password_changed_at IS DISTINCT FROM OLD.password_changed_at
        AND NEW.password_changed_at IS NOT NULL THEN
    PERFORM public.builder_revoke_user_sessions(NEW.id, 'password_changed');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_user_session_revocation ON public.builder_portal_users;
CREATE TRIGGER trg_builder_user_session_revocation
  AFTER UPDATE OF status, password_changed_at ON public.builder_portal_users
  FOR EACH ROW EXECUTE FUNCTION public.builder_revoke_sessions_on_user_deactivation();

-- ===========================================================================
-- RLS — deny by default
-- ===========================================================================
ALTER TABLE public.builder_portal_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_portal_sessions_service ON public.builder_portal_sessions;
CREATE POLICY builder_portal_sessions_service ON public.builder_portal_sessions
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.builder_portal_sessions FROM anon, authenticated;
GRANT ALL ON public.builder_portal_sessions TO service_role;

REVOKE ALL ON FUNCTION public.builder_issue_session(uuid, text, timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_resolve_session(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_revoke_session(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_revoke_user_sessions(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_issue_session(uuid, text, timestamptz, timestamptz, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_resolve_session(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_revoke_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_revoke_user_sessions(uuid, text, uuid) TO service_role;
