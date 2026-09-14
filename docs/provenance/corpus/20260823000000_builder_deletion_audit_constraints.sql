-- ===========================================================================
-- Builder / Developer Portal — deletion lifecycle, production corrections
--
-- Two defects that only a real database could show. Both stopped a removal that
-- the policy in 20260822000000 intends to allow; neither is a policy change.
--
-- DEFECT 1 — invalid entity_type
--
--   new row for relation "builder_portal_activity_log" violates check
--   constraint "builder_portal_activity_log_entity_type_check"
--
-- builder_portal_activity_log.entity_type is constrained to
-- ('organisation','portal_user','membership','membership_permissions','session').
-- builder_admin_delete_user wrote 'user'. Every other writer in the schema uses
-- 'portal_user'; this one was simply wrong, and had been since 20260820000000 —
-- it never surfaced because the old policy refused before reaching the audit
-- write. The membership and organisation commands already use permitted values.
--
-- DEFECT 2 — the audit log's own foreign keys blocked every parent deletion
--
--   BUILDER_ACTIVITY_LOG_APPEND_ONLY
--
-- builder_portal_activity_log.organisation_id and .builder_user_id are declared
-- ON DELETE SET NULL, and the table carries a BEFORE UPDATE OR DELETE trigger
-- that raises BUILDER_ACTIVITY_LOG_APPEND_ONLY. Deleting an organisation
-- therefore made PostgreSQL issue
--
--   UPDATE ONLY builder_portal_activity_log SET organisation_id = NULL ...
--
-- which the trigger rejected, failing the whole deletion. Because every
-- administrative action writes a log row, no user or organisation that had ever
-- been touched could be deleted — the two guarantees contradicted each other.
--
-- The fix drops those two foreign keys. This is the correct resolution rather
-- than a workaround:
--
--   * It makes the append-only guarantee true. Today a deletion silently
--     rewrites historical audit rows, which is precisely what an append-only
--     log must not permit.
--   * It preserves MORE evidence. The ids are kept forever instead of being
--     blanked, so a removed user's or organisation's history stays joinable —
--     which is how entity_id, deliberately unconstrained, already behaves.
--   * An audit trail is expected to outlive the records it describes, so a
--     foreign key to a deletable row is the wrong constraint for it to carry.
--
-- No column, no row and no value changes: only the two constraints are dropped.
-- Existing ids stay exactly as they are.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The audit log stops being rewritten by its own foreign keys.
-- ---------------------------------------------------------------------------
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_organisation_id_fkey;
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_builder_user_id_fkey;

COMMENT ON COLUMN public.builder_portal_activity_log.organisation_id IS
  'The organisation this record concerns. Deliberately not a foreign key: the audit trail outlives the records it describes, and an ON DELETE SET NULL here would rewrite history and be rejected by the append-only trigger.';
COMMENT ON COLUMN public.builder_portal_activity_log.builder_user_id IS
  'The portal user this record concerns. Deliberately not a foreign key, for the same reason as organisation_id.';

-- ---------------------------------------------------------------------------
-- 2. The three commands, unchanged apart from the corrected entity_type.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_admin_delete_membership(
  _actor_user_id uuid,
  _actor_type text,
  _membership_id uuid,
  _expected_version bigint,
  _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_membership public.builder_organisation_memberships;
  v_reason text := NULLIF(btrim(_reason), '');
  v_permissions_removed bigint;
  v_access_removed bigint;
  v_next_primary uuid;
  v_sessions_revoked integer := 0;
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_REASON_REQUIRED';
  END IF;

  SELECT * INTO v_membership FROM public.builder_organisation_memberships
  WHERE id = _membership_id
  FOR UPDATE;

  IF v_membership.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBERSHIP_NOT_FOUND';
  END IF;

  IF _expected_version IS NULL OR v_membership.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_membership.row_version);
  END IF;

  -- Evidence first: the membership row is about to stop existing, so the audit
  -- record has to carry everything worth knowing about it.
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_membership_removed',
    'membership', v_membership.id,
    v_membership.organisation_id, v_membership.builder_user_id,
    jsonb_build_object(
      'membership_id', v_membership.id,
      'builder_user_id', v_membership.builder_user_id,
      'organisation_id', v_membership.organisation_id,
      'membership_role', v_membership.membership_role,
      'is_primary', v_membership.is_primary,
      'status', v_membership.status,
      'revoked_at', v_membership.revoked_at,
      'revoked_reason', v_membership.revoked_reason),
    NULL, v_reason,
    jsonb_build_object('removal', 'permanent', 'removed_at', now()));

  -- Category A: access rows that exist only because this membership does.
  DELETE FROM public.builder_membership_permissions WHERE membership_id = _membership_id;
  GET DIAGNOSTICS v_permissions_removed = ROW_COUNT;

  DELETE FROM public.builder_project_access
  WHERE builder_user_id = v_membership.builder_user_id
    AND organisation_id = v_membership.organisation_id;
  GET DIAGNOSTICS v_access_removed = ROW_COUNT;

  DELETE FROM public.builder_organisation_memberships WHERE id = _membership_id;

  -- The primary flag moves to another live membership when one exists;
  -- otherwise the user simply has no primary organisation.
  IF v_membership.is_primary THEN
    SELECT id INTO v_next_primary FROM public.builder_organisation_memberships
    WHERE builder_user_id = v_membership.builder_user_id
      AND revoked_at IS NULL AND status = 'active'
    ORDER BY created_at
    LIMIT 1;

    IF v_next_primary IS NOT NULL THEN
      UPDATE public.builder_organisation_memberships
      SET is_primary = true WHERE id = v_next_primary;
    END IF;
  END IF;

  -- Losing the last membership that confers access must end the sessions it
  -- was carrying. The membership trigger only fires on UPDATE.
  IF NOT EXISTS (SELECT 1 FROM public.builder_accessible_organisations(v_membership.builder_user_id)) THEN
    v_sessions_revoked := public.builder_revoke_user_sessions(
      v_membership.builder_user_id, 'membership_removed');
  END IF;

  RETURN jsonb_build_object(
    'removed', true,
    'id', _membership_id,
    'membership_id', _membership_id,
    'builder_user_id', v_membership.builder_user_id,
    'organisation_id', v_membership.organisation_id,
    'permission_overrides_removed', v_permissions_removed,
    'project_access_removed', v_access_removed,
    'promoted_primary_membership_id', v_next_primary,
    'sessions_revoked', v_sessions_revoked);
END $$;

CREATE OR REPLACE FUNCTION public.builder_admin_delete_user(
  _actor_user_id uuid,
  _actor_type text,
  _builder_user_id uuid,
  _expected_version bigint,
  _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user public.builder_portal_users;
  v_blockers text[] := ARRAY[]::text[];
  v_reason text := NULLIF(btrim(_reason), '');
  v_count bigint;
  v_membership_ids uuid[];
  v_organisation_ids uuid[];
  v_sessions_revoked integer := 0;
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_REASON_REQUIRED';
  END IF;

  SELECT * INTO v_user FROM public.builder_portal_users
  WHERE id = _builder_user_id
  FOR UPDATE;

  IF v_user.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;

  IF _expected_version IS NULL OR v_user.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_user.row_version);
  END IF;

  -- ---- Category B. Business work this account produced. Counted under the
  -- ---- lock taken above, so nothing can be created between check and delete.
  SELECT count(*) INTO v_count FROM public.builder_document_versions
    WHERE uploaded_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('uploaded documents (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_messages
    WHERE author_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('authored messages (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_reservations
    WHERE reserved_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('reservations (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_unit_holds
    WHERE held_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('unit holds (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_tasks
    WHERE created_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('tasks (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_task_assignments
    WHERE builder_user_id = _builder_user_id
       OR assigned_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('task assignments (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_construction_progress_updates
    WHERE created_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('construction progress updates (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_construction_photographs
    WHERE uploaded_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('construction photographs (%s)', v_count)); END IF;

  SELECT (
      (SELECT count(*) FROM public.builder_construction_status_history WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_construction_date_history   WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_delivery_status_history     WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_project_status_history      WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_reservation_status_history  WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_transaction_status_history  WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_unit_status_history         WHERE changed_by_builder_user_id = _builder_user_id)
  ) INTO v_count;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('status history entries (%s)', v_count)); END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HAS_DEPENDENTS',
      DETAIL = format('dependents=%s', array_to_string(v_blockers, ', '));
  END IF;

  -- Memberships are named in the audit snapshot, so they are collected before
  -- they are deleted.
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]),
         coalesce(array_agg(DISTINCT organisation_id), ARRAY[]::uuid[])
  INTO v_membership_ids, v_organisation_ids
  FROM public.builder_organisation_memberships
  WHERE builder_user_id = _builder_user_id;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_user_removed',
    'portal_user', v_user.id, NULL, NULL,
    jsonb_build_object(
      'builder_user_id', v_user.id,
      'email', v_user.email,
      'name', v_user.name,
      'job_title', v_user.job_title,
      'status', v_user.status,
      'invited_at', v_user.invited_at,
      'invite_accepted_at', v_user.invite_accepted_at,
      'membership_ids', to_jsonb(v_membership_ids),
      'organisation_ids', to_jsonb(v_organisation_ids)),
    NULL, v_reason,
    jsonb_build_object('removal', 'permanent', 'removed_at', now()));

  -- End the sessions before the rows go, so the count is meaningful.
  v_sessions_revoked := public.builder_revoke_user_sessions(_builder_user_id, 'user_removed');

  -- ---- Category A. Access and account rows, deleted explicitly so the scope
  -- ---- of a removal is visible here rather than implied by a cascade.
  DELETE FROM public.builder_membership_permissions
  WHERE membership_id IN (
    SELECT id FROM public.builder_organisation_memberships WHERE builder_user_id = _builder_user_id);
  DELETE FROM public.builder_organisation_memberships WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_project_access WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_document_grants WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_conversation_participants WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_notifications WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_onboarding_steps WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_user_preferences WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_portal_sessions WHERE builder_user_id = _builder_user_id;

  -- Invitation and reset state are columns on this row and go with it.
  DELETE FROM public.builder_portal_users WHERE id = _builder_user_id;

  RETURN jsonb_build_object(
    'removed', true,
    'id', _builder_user_id,
    'builder_user_id', _builder_user_id,
    'memberships_removed', coalesce(array_length(v_membership_ids, 1), 0),
    'sessions_revoked', v_sessions_revoked);
END $$;

CREATE OR REPLACE FUNCTION public.builder_admin_delete_organisation(
  _actor_user_id uuid,
  _actor_type text,
  _organisation_id uuid,
  _expected_version bigint,
  _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org public.builder_organisations;
  v_blockers text[] := ARRAY[]::text[];
  v_reason text := NULLIF(btrim(_reason), '');
  v_count bigint;
  v_membership_ids uuid[];
  v_user_ids uuid[];
  v_user_id uuid;
  v_sessions_revoked integer := 0;
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_REASON_REQUIRED';
  END IF;

  SELECT * INTO v_org FROM public.builder_organisations
  WHERE id = _organisation_id
  FOR UPDATE;

  IF v_org.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;

  IF _expected_version IS NULL OR v_org.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_org.row_version);
  END IF;

  -- ---- Category B.
  SELECT count(*) INTO v_count FROM public.builder_projects
    WHERE builder_organisation_id = _organisation_id
       OR developer_organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('projects (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_reservations
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('reservations (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_transactions
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('transactions (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_unit_holds
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('unit holds (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_tasks
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('tasks (%s)', v_count)); END IF;

  SELECT count(*) INTO v_count FROM public.builder_documents
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('documents (%s)', v_count)); END IF;

  -- A conversation that carries messages is business correspondence. An empty
  -- one is a shell and is removed as Category A below.
  SELECT count(*) INTO v_count FROM public.builder_conversations
    WHERE organisation_id = _organisation_id AND message_count > 0;
  IF v_count > 0 THEN v_blockers := array_append(v_blockers, format('conversations with messages (%s)', v_count)); END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HAS_DEPENDENTS',
      DETAIL = format('dependents=%s', array_to_string(v_blockers, ', '));
  END IF;

  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]),
         coalesce(array_agg(DISTINCT builder_user_id), ARRAY[]::uuid[])
  INTO v_membership_ids, v_user_ids
  FROM public.builder_organisation_memberships
  WHERE organisation_id = _organisation_id;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_organisation_removed',
    'organisation', v_org.id, NULL, NULL,
    jsonb_build_object(
      'organisation_id', v_org.id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name,
      'abn', v_org.abn,
      'acn', v_org.acn,
      'org_type', v_org.org_type,
      'status', v_org.status,
      'membership_ids', to_jsonb(v_membership_ids),
      'affected_user_ids', to_jsonb(v_user_ids)),
    NULL, v_reason,
    jsonb_build_object('removal', 'permanent', 'removed_at', now()));

  -- ---- Category A.
  DELETE FROM public.builder_membership_permissions
  WHERE membership_id IN (
    SELECT id FROM public.builder_organisation_memberships WHERE organisation_id = _organisation_id);
  DELETE FROM public.builder_organisation_memberships WHERE organisation_id = _organisation_id;
  DELETE FROM public.builder_project_access WHERE organisation_id = _organisation_id;
  DELETE FROM public.builder_notifications WHERE organisation_id = _organisation_id;
  DELETE FROM public.builder_conversation_participants
  WHERE conversation_id IN (
    SELECT id FROM public.builder_conversations WHERE organisation_id = _organisation_id);
  DELETE FROM public.builder_conversations WHERE organisation_id = _organisation_id;
  DELETE FROM public.builder_organisation_settings WHERE organisation_id = _organisation_id;

  DELETE FROM public.builder_organisations WHERE id = _organisation_id;

  -- The users survive. Anyone who now holds no access loses their sessions.
  FOREACH v_user_id IN ARRAY v_user_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.builder_accessible_organisations(v_user_id)) THEN
      v_sessions_revoked := v_sessions_revoked
        + public.builder_revoke_user_sessions(v_user_id, 'organisation_removed');
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'removed', true,
    'id', _organisation_id,
    'organisation_id', _organisation_id,
    'memberships_removed', coalesce(array_length(v_membership_ids, 1), 0),
    'affected_user_count', coalesce(array_length(v_user_ids, 1), 0),
    'sessions_revoked', v_sessions_revoked);
END $$;

REVOKE ALL ON FUNCTION public.builder_admin_delete_user(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_delete_organisation(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_delete_membership(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
