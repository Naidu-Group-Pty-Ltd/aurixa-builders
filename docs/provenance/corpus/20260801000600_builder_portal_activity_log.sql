-- Builder / Developer Portal — trusted audit for access-control mutations.
--
-- Correction P4 from the Solicitor Portal alignment review of PR #1749.
--
-- The Phase 1 report claimed "Phase 1 has no high-risk mutation", so audit was
-- left as a best-effort operational event written from a `finally` block. That
-- claim was wrong: granting and revoking organisation membership IS the
-- access-control decision for the whole portal, and so are user status, and
-- organisation status, permission overrides and administrative session
-- revocation.
--
-- Two things are fixed here:
--
--  1. A Builder-domain activity log, modelled directly on
--     `solicitor_portal_activity_log` (20260730110751). No new platform-wide
--     audit architecture is invented.
--
--  2. Phase 0 finding NOCOPY-04 — fail closed. The Solicitor Portal writes its
--     activity row with a `try/catch` that swallows failures and lets the
--     mutation commit anyway. Builder must not copy that. Each access-control
--     mutation is performed by a guarded command function that writes the state
--     change AND the audit record in the same transaction, so a failed audit
--     write aborts the mutation rather than leaving it unrecorded.
--
-- Nothing in the session, membership, permission, terms or rollout model is
-- redesigned. The tables and constraints from Phase 1 are unchanged; these
-- commands are a transactional wrapper around writes the admin Edge Function
-- was already making.

-- ===========================================================================
-- 1. Activity log
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_portal_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Acting internal user. NULL means a verified service-role call: verifyAuth()
  -- returns the literal string 'service_role' as its identity, which is not a
  -- uuid, so it is recorded in actor_type instead of being coerced.
  actor_user_id uuid,
  actor_type text NOT NULL DEFAULT 'command_user'
    CHECK (actor_type IN ('command_user', 'service_role', 'builder_user', 'system')),

  action text NOT NULL CHECK (btrim(action) <> ''),

  -- Target record and its organisation context.
  entity_type text CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session')),
  entity_id uuid,
  organisation_id uuid REFERENCES public.builder_organisations(id) ON DELETE SET NULL,
  builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,

  -- Before and after, so a reviewer can see what actually changed.
  previous_state jsonb,
  new_state jsonb,
  reason text,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS builder_portal_activity_log_org_idx
  ON public.builder_portal_activity_log (organisation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_portal_activity_log_user_idx
  ON public.builder_portal_activity_log (builder_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_portal_activity_log_actor_idx
  ON public.builder_portal_activity_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_portal_activity_log_action_idx
  ON public.builder_portal_activity_log (action, created_at DESC);

COMMENT ON TABLE public.builder_portal_activity_log IS
  'Trusted Builder Portal audit trail. Access-control mutations write here inside the same transaction as the state change, so a failed audit write aborts the mutation (Phase 0 NOCOPY-04).';
COMMENT ON COLUMN public.builder_portal_activity_log.actor_user_id IS
  'Internal Command Centre user id, or NULL for a verified service-role call. Never carries the literal string service_role.';

-- The audit trail is append-only. An audit record that can be edited or deleted
-- is not evidence.
CREATE OR REPLACE FUNCTION public.builder_activity_log_is_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001',
    MESSAGE = 'BUILDER_ACTIVITY_LOG_APPEND_ONLY',
    DETAIL = 'builder_portal_activity_log rows cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_activity_log_append_only ON public.builder_portal_activity_log;
CREATE TRIGGER trg_builder_activity_log_append_only
  BEFORE UPDATE OR DELETE ON public.builder_portal_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.builder_activity_log_is_append_only();

-- ===========================================================================
-- 2. Audit writer
--
-- Deliberately NOT exception-safe. It raises on failure so the calling command
-- rolls back. This is the inverse of logSolicitorActivity(), which swallows.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_log_activity(
  _actor_user_id uuid,
  _actor_type text,
  _action text,
  _entity_type text,
  _entity_id uuid,
  _organisation_id uuid,
  _builder_user_id uuid,
  _previous_state jsonb,
  _new_state jsonb,
  _reason text,
  _metadata jsonb DEFAULT '{}'::jsonb,
  _ip_address text DEFAULT NULL,
  _user_agent text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.builder_portal_activity_log(
    actor_user_id, actor_type, action, entity_type, entity_id,
    organisation_id, builder_user_id, previous_state, new_state, reason,
    metadata, ip_address, user_agent)
  VALUES (
    _actor_user_id, COALESCE(NULLIF(btrim(_actor_type), ''), 'command_user'),
    _action, _entity_type, _entity_id,
    _organisation_id, _builder_user_id, _previous_state, _new_state, _reason,
    COALESCE(_metadata, '{}'::jsonb), _ip_address, _user_agent)
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BUILDER_AUDIT_WRITE_FAILED';
  END IF;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION public.builder_log_activity IS
  'Writes a trusted Builder audit record. Raises rather than swallowing, so a caller inside a transaction rolls its mutation back when audit fails.';

-- ===========================================================================
-- 3. Guarded access-control commands
--
-- Each performs its mutation and its audit write in one transaction. A plpgsql
-- function invoked through RPC runs in a single transaction, so an exception
-- from builder_log_activity() rolls back the state change with it.
--
-- Every command takes _expected_version and returns 409-equivalent errors as
-- exceptions the Edge Function maps to HTTP status codes, preserving the
-- concurrency contract Phase 1 already established.
-- ===========================================================================

-- 3a. Membership granted / membership role changed
CREATE OR REPLACE FUNCTION public.builder_admin_upsert_membership(
  _actor_user_id uuid,
  _actor_type text,
  _builder_user_id uuid,
  _organisation_id uuid,
  _membership_role text,
  _is_primary boolean,
  _expected_version bigint DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_organisation_memberships
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.builder_organisation_memberships;
  v_row public.builder_organisation_memberships;
  v_org_status text;
  v_user_status text;
BEGIN
  SELECT status INTO v_org_status FROM public.builder_organisations WHERE id = _organisation_id;
  IF v_org_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;
  IF v_org_status = 'closed' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_CLOSED';
  END IF;

  SELECT status INTO v_user_status FROM public.builder_portal_users WHERE id = _builder_user_id;
  IF v_user_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;
  IF v_user_status = 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_REVOKED';
  END IF;

  SELECT * INTO v_existing FROM public.builder_organisation_memberships
  WHERE builder_user_id = _builder_user_id AND organisation_id = _organisation_id
    AND revoked_at IS NULL
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;

    UPDATE public.builder_organisation_memberships
    SET membership_role = _membership_role, is_primary = COALESCE(_is_primary, false)
    WHERE id = v_existing.id
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_membership_role_changed',
      'membership', v_row.id, _organisation_id, _builder_user_id,
      jsonb_build_object('membership_role', v_existing.membership_role,
                         'is_primary', v_existing.is_primary,
                         'status', v_existing.status),
      jsonb_build_object('membership_role', v_row.membership_role,
                         'is_primary', v_row.is_primary,
                         'status', v_row.status),
      _reason, '{}'::jsonb);
  ELSE
    INSERT INTO public.builder_organisation_memberships(
      builder_user_id, organisation_id, membership_role, is_primary, status, granted_by)
    VALUES (_builder_user_id, _organisation_id, _membership_role,
            COALESCE(_is_primary, false), 'active', _actor_user_id)
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_membership_granted',
      'membership', v_row.id, _organisation_id, _builder_user_id,
      NULL,
      jsonb_build_object('membership_role', v_row.membership_role,
                         'is_primary', v_row.is_primary,
                         'status', v_row.status),
      _reason, '{}'::jsonb);
  END IF;

  RETURN v_row;
END $$;

-- 3b. Membership revoked
CREATE OR REPLACE FUNCTION public.builder_admin_revoke_membership(
  _actor_user_id uuid,
  _actor_type text,
  _membership_id uuid,
  _reason text)
RETURNS public.builder_organisation_memberships
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_organisation_memberships; v_row public.builder_organisation_memberships;
BEGIN
  SELECT * INTO v_existing FROM public.builder_organisation_memberships
  WHERE id = _membership_id AND revoked_at IS NULL
  FOR UPDATE;

  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBERSHIP_NOT_FOUND_OR_REVOKED';
  END IF;

  UPDATE public.builder_organisation_memberships
  SET status = 'revoked', revoked_at = now(),
      revoked_reason = COALESCE(NULLIF(btrim(_reason), ''), 'revoked by administrator')
  WHERE id = _membership_id
  RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_membership_revoked',
    'membership', v_row.id, v_row.organisation_id, v_row.builder_user_id,
    jsonb_build_object('membership_role', v_existing.membership_role, 'status', v_existing.status),
    jsonb_build_object('status', v_row.status, 'revoked_at', v_row.revoked_at),
    v_row.revoked_reason, '{}'::jsonb);

  RETURN v_row;
END $$;

-- 3c. User suspended or revoked
CREATE OR REPLACE FUNCTION public.builder_admin_set_user_status(
  _actor_user_id uuid,
  _actor_type text,
  _builder_user_id uuid,
  _status text,
  _expected_version bigint,
  _reason text DEFAULT NULL)
RETURNS public.builder_portal_users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_portal_users; v_row public.builder_portal_users; v_revoked integer := 0;
BEGIN
  IF _status NOT IN ('invited','active','suspended','revoked') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNKNOWN_USER_STATUS';
  END IF;

  SELECT * INTO v_existing FROM public.builder_portal_users WHERE id = _builder_user_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version);
  END IF;

  UPDATE public.builder_portal_users
  SET status = _status,
      is_active = (_status = 'active'),
      revoked_at = CASE WHEN _status = 'revoked' THEN now() ELSE NULL END,
      revoked_reason = CASE WHEN _status = 'revoked'
        THEN COALESCE(NULLIF(btrim(_reason), ''), 'revoked by administrator') ELSE NULL END,
      updated_by = _actor_user_id
  WHERE id = _builder_user_id
  RETURNING * INTO v_row;

  -- Deactivation must not leave a usable session behind. The Phase 1 trigger
  -- already covers active -> non-active; this also covers invited -> suspended.
  IF _status <> 'active' THEN
    v_revoked := public.builder_revoke_user_sessions(_builder_user_id, 'user_' || _status, NULL);
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_user_' || _status,
    'portal_user', v_row.id, NULL, v_row.id,
    jsonb_build_object('status', v_existing.status, 'is_active', v_existing.is_active),
    jsonb_build_object('status', v_row.status, 'is_active', v_row.is_active),
    _reason, jsonb_build_object('sessions_revoked', v_revoked));

  RETURN v_row;
END $$;

-- 3d. Organisation suspended or closed (and reactivated)
CREATE OR REPLACE FUNCTION public.builder_admin_set_organisation_status(
  _actor_user_id uuid,
  _actor_type text,
  _organisation_id uuid,
  _status text,
  _expected_version bigint,
  _reason text DEFAULT NULL)
RETURNS public.builder_organisations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.builder_organisations; v_row public.builder_organisations;
  v_member record; v_revoked integer := 0;
BEGIN
  IF _status NOT IN ('pending_activation','active','suspended','closed') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNKNOWN_ORG_STATUS';
  END IF;

  SELECT * INTO v_existing FROM public.builder_organisations WHERE id = _organisation_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version);
  END IF;

  UPDATE public.builder_organisations
  SET status = _status,
      is_active = (_status = 'active'),
      activated_at = CASE WHEN _status = 'active' THEN now() ELSE NULL END,
      suspended_at = CASE WHEN _status = 'suspended' THEN now() ELSE NULL END,
      suspension_reason = CASE WHEN _status = 'suspended' THEN NULLIF(btrim(_reason), '') ELSE NULL END,
      updated_by = _actor_user_id
  WHERE id = _organisation_id
  RETURNING * INTO v_row;

  -- Losing organisation activity must end its members' sessions. Membership
  -- rows do not change here, so the membership trigger does not observe this.
  IF _status <> 'active' THEN
    FOR v_member IN
      SELECT builder_user_id FROM public.builder_organisation_memberships
      WHERE organisation_id = _organisation_id AND revoked_at IS NULL
    LOOP
      v_revoked := v_revoked + public.builder_revoke_user_sessions(
        v_member.builder_user_id, 'organisation_' || _status, NULL);
    END LOOP;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_organisation_' || _status,
    'organisation', v_row.id, v_row.id, NULL,
    jsonb_build_object('status', v_existing.status, 'is_active', v_existing.is_active),
    jsonb_build_object('status', v_row.status, 'is_active', v_row.is_active),
    _reason, jsonb_build_object('sessions_revoked', v_revoked));

  RETURN v_row;
END $$;

-- 3e. Permission overrides changed
CREATE OR REPLACE FUNCTION public.builder_admin_set_membership_permissions(
  _actor_user_id uuid,
  _actor_type text,
  _membership_id uuid,
  _overrides jsonb,
  _reason text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_membership public.builder_organisation_memberships;
  v_previous jsonb;
  v_new jsonb;
  v_entry jsonb;
  v_applied integer := 0;
BEGIN
  SELECT * INTO v_membership FROM public.builder_organisation_memberships
  WHERE id = _membership_id AND revoked_at IS NULL
  FOR UPDATE;
  IF v_membership.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBERSHIP_NOT_FOUND_OR_REVOKED';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'permission_key', permission_key, 'view', view_decision,
           'edit', edit_decision, 'delete', delete_decision) ORDER BY permission_key), '[]'::jsonb)
  INTO v_previous
  FROM public.builder_membership_permissions
  WHERE membership_id = _membership_id AND scope_type = 'organisation';

  DELETE FROM public.builder_membership_permissions
  WHERE membership_id = _membership_id AND scope_type = 'organisation';

  FOR v_entry IN SELECT * FROM jsonb_array_elements(COALESCE(_overrides, '[]'::jsonb))
  LOOP
    -- The forbidden-key and projection-writability triggers from Phase 1 still
    -- apply; an attempt to smuggle one through raises and rolls the whole
    -- command back, audit included.
    INSERT INTO public.builder_membership_permissions(
      membership_id, permission_key, scope_type,
      view_decision, edit_decision, delete_decision, reason, granted_by)
    VALUES (
      _membership_id,
      v_entry ->> 'permission_key',
      'organisation',
      COALESCE(v_entry ->> 'view_decision', 'inherit'),
      COALESCE(v_entry ->> 'edit_decision', 'inherit'),
      COALESCE(v_entry ->> 'delete_decision', 'inherit'),
      NULLIF(btrim(COALESCE(v_entry ->> 'reason', '')), ''),
      _actor_user_id);
    v_applied := v_applied + 1;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'permission_key', permission_key, 'view', view_decision,
           'edit', edit_decision, 'delete', delete_decision) ORDER BY permission_key), '[]'::jsonb)
  INTO v_new
  FROM public.builder_membership_permissions
  WHERE membership_id = _membership_id AND scope_type = 'organisation';

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_membership_permissions_changed',
    'membership_permissions', _membership_id,
    v_membership.organisation_id, v_membership.builder_user_id,
    v_previous, v_new, _reason,
    jsonb_build_object('applied', v_applied));

  RETURN v_applied;
END $$;

-- 3f. Administrative session revocation
CREATE OR REPLACE FUNCTION public.builder_admin_revoke_user_sessions(
  _actor_user_id uuid,
  _actor_type text,
  _builder_user_id uuid,
  _reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_revoked integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.builder_portal_users WHERE id = _builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;

  v_revoked := public.builder_revoke_user_sessions(
    _builder_user_id, COALESCE(NULLIF(btrim(_reason), ''), 'revoked by administrator'), NULL);

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_sessions_revoked',
    'session', NULL, NULL, _builder_user_id,
    NULL, jsonb_build_object('revoked', v_revoked), _reason,
    jsonb_build_object('revoked', v_revoked));

  RETURN v_revoked;
END $$;

-- ===========================================================================
-- 4. RLS and grants — deny by default, matching every other Builder table
-- ===========================================================================
ALTER TABLE public.builder_portal_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_portal_activity_log_service ON public.builder_portal_activity_log;
CREATE POLICY builder_portal_activity_log_service ON public.builder_portal_activity_log
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.builder_portal_activity_log FROM anon, authenticated;
GRANT ALL ON public.builder_portal_activity_log TO service_role;

REVOKE ALL ON FUNCTION public.builder_log_activity(uuid, text, text, text, uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_upsert_membership(uuid, text, uuid, uuid, text, boolean, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_revoke_membership(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_set_user_status(uuid, text, uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_set_organisation_status(uuid, text, uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_set_membership_permissions(uuid, text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_revoke_user_sessions(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.builder_log_activity(uuid, text, text, text, uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_upsert_membership(uuid, text, uuid, uuid, text, boolean, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_revoke_membership(uuid, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_set_user_status(uuid, text, uuid, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_set_organisation_status(uuid, text, uuid, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_set_membership_permissions(uuid, text, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_revoke_user_sessions(uuid, text, uuid, text) TO service_role;

-- ===========================================================================
-- 5. Post-migration assertion
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_log_activity','builder_admin_upsert_membership','builder_admin_revoke_membership',
    'builder_admin_set_user_status','builder_admin_set_organisation_status',
    'builder_admin_set_membership_permissions','builder_admin_revoke_user_sessions']) AS f
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: guarded Builder audit command(s) missing: %', v_missing;
  END IF;

  RAISE NOTICE 'builder audit: activity log and 6 guarded access-control commands installed';
END $$;
