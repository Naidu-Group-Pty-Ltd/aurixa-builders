-- ===========================================================================
-- Builder / Developer Portal — guarded safe-deletion commands
--
-- WHY THIS MIGRATION EXISTS
--
-- The Command Centre needs "safely remove" for a portal user, an organisation
-- and a membership. Those three cannot be implemented safely from the Edge
-- Function alone, for two reasons that are properties of the existing schema
-- rather than preferences:
--
--  1. TOCTOU. The Phase 1 schema attaches ON DELETE CASCADE to most Builder
--     child tables — builder_organisation_memberships, builder_project_access,
--     builder_document_grants, builder_conversation_participants,
--     builder_notifications, builder_reservations, builder_transactions,
--     builder_tasks, builder_unit_holds, builder_documents and
--     builder_conversations all cascade from the user or the organisation.
--     A check-then-delete pair issued as two PostgREST calls is not atomic: a
--     project or a transaction created between the two statements would be
--     destroyed by the cascade, silently, with no way to recover it. The guard
--     has to hold a lock on the parent row and count dependants inside the same
--     transaction as the DELETE.
--
--  2. Audit evidence. builder_portal_activity_log.builder_user_id and
--     .organisation_id are ON DELETE SET NULL, so deleting the parent blanks
--     the link from every historical audit row. The removal record therefore
--     has to be written *before* the DELETE and has to carry the identity
--     (id, email, legal name) in its own payload, in the same transaction, or
--     the trail cannot answer "who was removed?" afterwards. entity_id has no
--     foreign key, so it survives the SET NULL and keeps the rows joinable.
--
-- These functions follow the established Phase 1 pattern exactly: guarded
-- command, mutation and trusted audit in one transaction, failures raised as
-- exceptions the Edge Function maps onto the HTTP contract.
--
-- The migration is additive. It creates three functions and changes no table,
-- no column, no constraint and no row.
--
-- POLICY
--
-- Removal is for records created in error and never used. Anything that has
-- been granted access, done work or accumulated history is refused with
-- BUILDER_HAS_DEPENDENTS and must be revoked, suspended or closed instead —
-- those transitions already exist and preserve everything.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Defect fix: moving the primary organisation
--
-- `builder_memberships_one_primary_key` is a partial unique index over
-- (builder_user_id) WHERE is_primary AND revoked_at IS NULL, so a user may hold
-- at most one primary membership. builder_admin_upsert_membership takes an
-- _is_primary argument but never clears the flag from the membership that
-- currently holds it, so marking a second membership primary raises 23505 and
-- the Command Centre cannot change a user's primary organisation at all.
--
-- The flag is moved here, inside the same transaction as the write that sets
-- it, because doing it in two statements from the Edge Function would leave a
-- window where the user has either two primaries or none.
--
-- Everything else about the function is unchanged; this is the same body with
-- the clearing UPDATE added.
-- ---------------------------------------------------------------------------
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

  -- Move the primary flag off whichever live membership holds it, so the
  -- partial unique index is satisfied by the write below.
  IF COALESCE(_is_primary, false) THEN
    UPDATE public.builder_organisation_memberships
    SET is_primary = false
    WHERE builder_user_id = _builder_user_id
      AND revoked_at IS NULL
      AND is_primary
      AND (v_existing.id IS NULL OR id <> v_existing.id);
  END IF;

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

-- ---------------------------------------------------------------------------
-- 1. Portal user removal
--
-- Blocked by any membership (live or revoked), any granted access, any
-- authored or attributed business record, and any session — a user who has
-- signed in has history worth keeping. Permitted alongside the delete are only
-- the account's own setup rows: onboarding progress and personal preferences.
-- Those are deleted explicitly here rather than left to a cascade, so the
-- statement says what it removes.
-- ---------------------------------------------------------------------------
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

  -- Protected dependants. Counted under the lock taken above.
  SELECT count(*) INTO v_count FROM public.builder_organisation_memberships
    WHERE builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('organisation memberships (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_project_access
    WHERE builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('project access grants (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_portal_sessions
    WHERE builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('portal sessions (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_document_grants
    WHERE builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('document grants (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_document_versions
    WHERE uploaded_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('uploaded documents (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_messages
    WHERE author_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('messages (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_conversation_participants
    WHERE builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('conversations (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_notifications
    WHERE builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('notifications (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_reservations
    WHERE reserved_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('reservations (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_unit_holds
    WHERE held_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('unit holds (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_tasks
    WHERE created_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('tasks (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_task_assignments
    WHERE builder_user_id = _builder_user_id
       OR assigned_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('task assignments (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_construction_progress_updates
    WHERE created_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('construction progress updates (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_construction_photographs
    WHERE uploaded_by_builder_user_id = _builder_user_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('construction photographs (%s)', v_count); END IF;

  SELECT (
      (SELECT count(*) FROM public.builder_construction_status_history WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_construction_date_history   WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_delivery_status_history     WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_project_status_history      WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_reservation_status_history  WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_transaction_status_history  WHERE changed_by_builder_user_id = _builder_user_id)
    + (SELECT count(*) FROM public.builder_unit_status_history         WHERE changed_by_builder_user_id = _builder_user_id)
  ) INTO v_count;
  IF v_count > 0 THEN v_blockers := v_blockers || format('status history entries (%s)', v_count); END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HAS_DEPENDENTS',
      DETAIL = format('dependents=%s', array_to_string(v_blockers, ', '));
  END IF;

  -- Audit BEFORE the delete, carrying the identity, because
  -- builder_portal_activity_log.builder_user_id is ON DELETE SET NULL.
  -- entity_id has no foreign key and keeps the removed id joinable.
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_user_removed',
    'user', v_user.id, NULL, NULL,
    jsonb_build_object(
      'id', v_user.id, 'email', v_user.email, 'name', v_user.name,
      'status', v_user.status, 'job_title', v_user.job_title,
      'invited_at', v_user.invited_at, 'invite_accepted_at', v_user.invite_accepted_at),
    NULL, v_reason,
    jsonb_build_object('removal', 'permanent', 'dependents_checked', true));

  -- The account's own setup rows, removed explicitly rather than by cascade.
  DELETE FROM public.builder_onboarding_steps WHERE builder_user_id = _builder_user_id;
  DELETE FROM public.builder_user_preferences WHERE builder_user_id = _builder_user_id;

  DELETE FROM public.builder_portal_users WHERE id = _builder_user_id;

  RETURN jsonb_build_object('removed', true, 'builder_user_id', _builder_user_id);
END $$;

COMMENT ON FUNCTION public.builder_admin_delete_user IS
  'Permanently removes a Builder portal user that has no protected dependants. Refuses with BUILDER_HAS_DEPENDENTS otherwise; revoke access instead. Audit is written before the delete because the activity-log link is ON DELETE SET NULL.';

-- ---------------------------------------------------------------------------
-- 2. Organisation removal
--
-- Blocked by any membership, project, access grant, reservation, transaction,
-- task, unit hold, document, conversation or notification. Only the
-- organisation's own settings row is removed with it.
-- ---------------------------------------------------------------------------
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

  SELECT count(*) INTO v_count FROM public.builder_organisation_memberships
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('memberships (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_projects
    WHERE builder_organisation_id = _organisation_id
       OR developer_organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('projects (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_project_access
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('project access grants (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_reservations
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('reservations (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_transactions
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('transactions (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_tasks
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('tasks (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_unit_holds
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('unit holds (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_documents
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('documents (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_conversations
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('conversations (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_notifications
    WHERE organisation_id = _organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('notifications (%s)', v_count); END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HAS_DEPENDENTS',
      DETAIL = format('dependents=%s', array_to_string(v_blockers, ', '));
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_organisation_removed',
    'organisation', v_org.id, NULL, NULL,
    jsonb_build_object(
      'id', v_org.id, 'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name, 'org_type', v_org.org_type,
      'abn', v_org.abn, 'status', v_org.status),
    NULL, v_reason,
    jsonb_build_object('removal', 'permanent', 'dependents_checked', true));

  DELETE FROM public.builder_organisation_settings WHERE organisation_id = _organisation_id;
  DELETE FROM public.builder_organisations WHERE id = _organisation_id;

  RETURN jsonb_build_object('removed', true, 'organisation_id', _organisation_id);
END $$;

COMMENT ON FUNCTION public.builder_admin_delete_organisation IS
  'Permanently removes a Builder organisation that has no protected dependants. Refuses with BUILDER_HAS_DEPENDENTS otherwise; close the organisation instead.';

-- ---------------------------------------------------------------------------
-- 3. Membership removal
--
-- Only a live membership that never conferred anything may be removed. A
-- revoked membership IS the historical record and is retained; so is any
-- membership carrying permission overrides, project access, or an activity
-- trail beyond its own grant.
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
  v_blockers text[] := ARRAY[]::text[];
  v_reason text := NULLIF(btrim(_reason), '');
  v_count bigint;
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

  -- A revoked membership is the evidence that access once existed and was
  -- withdrawn. It is never removed.
  IF v_membership.revoked_at IS NOT NULL THEN
    v_blockers := v_blockers || 'a revoked membership is retained as audit evidence';
  END IF;

  SELECT count(*) INTO v_count FROM public.builder_membership_permissions
    WHERE membership_id = _membership_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('permission overrides (%s)', v_count); END IF;

  SELECT count(*) INTO v_count FROM public.builder_project_access
    WHERE builder_user_id = v_membership.builder_user_id
      AND organisation_id = v_membership.organisation_id;
  IF v_count > 0 THEN v_blockers := v_blockers || format('project access grants (%s)', v_count); END IF;

  -- Any history beyond the original grant means this relationship has a story.
  SELECT count(*) INTO v_count FROM public.builder_portal_activity_log
    WHERE entity_type = 'membership' AND entity_id = _membership_id
      AND action <> 'builder_membership_granted';
  IF v_count > 0 THEN v_blockers := v_blockers || format('membership history entries (%s)', v_count); END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HAS_DEPENDENTS',
      DETAIL = format('dependents=%s', array_to_string(v_blockers, ', '));
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_membership_removed',
    'membership', v_membership.id,
    v_membership.organisation_id, v_membership.builder_user_id,
    jsonb_build_object(
      'id', v_membership.id, 'membership_role', v_membership.membership_role,
      'is_primary', v_membership.is_primary, 'status', v_membership.status),
    NULL, v_reason,
    jsonb_build_object('removal', 'permanent', 'dependents_checked', true));

  DELETE FROM public.builder_organisation_memberships WHERE id = _membership_id;

  RETURN jsonb_build_object('removed', true, 'membership_id', _membership_id);
END $$;

COMMENT ON FUNCTION public.builder_admin_delete_membership IS
  'Permanently removes a live Builder membership that never conferred access. Refuses with BUILDER_HAS_DEPENDENTS otherwise; revoke the membership instead. Never deletes the user or the organisation.';

-- These are service-role commands invoked from the builder-portal-admin Edge
-- Function only, exactly like the Phase 1 guarded commands beside them.
REVOKE ALL ON FUNCTION public.builder_admin_delete_user(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_delete_organisation(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_delete_membership(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
