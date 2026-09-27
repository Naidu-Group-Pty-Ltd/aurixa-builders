-- ============================================================================
-- Organisation members are managed in the portal.
--
-- WHO. Exactly the authority the portal already applies to invitations and
-- join requests (builder-portal-invite, builder_decide_org_join_request): an
-- ACTIVE owner or administrator of THIS organisation. Nothing new is granted.
--   * An administrator may manage members who are not owners.
--   * Only an owner may change, suspend or remove an owner.
--   * Nobody manages their own membership here (fail closed).
--   * `owner` is never assignable here, exactly as it is not invitable:
--     granting ownership is a transfer of control with its own ceremony.
--
-- WHAT. set_role (administrator | manager | member | read_only), suspend
-- (active -> suspended), reactivate (suspended -> active), remove (revoked,
-- the same state builder_admin_revoke_membership writes). Every act is one
-- statement under a lock on the organisation row, so two administrators
-- cannot race an organisation to zero owners.
--
-- THE LAST OWNER. No act may leave the organisation without an active owner
-- whose account is active: BUILDER_LAST_OWNER, and nothing is written.
--
-- WHAT IT DOES NOT TOUCH. Authorship, messages, projects, activations,
-- conversations and the activity log are never rewritten. Losing the last
-- accessible organisation revokes the user's sessions through the EXISTING
-- trigger (builder_revoke_sessions_on_membership_loss), and the existing
-- resolvers already deny a suspended or revoked membership, so access ends on
-- the next request and a new session cannot be issued.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_org_manage_membership(
  _actor_builder_user_id uuid,
  _organisation_id uuid,
  _membership_id uuid,
  _action text,
  _role text DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_organisation_memberships
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
  v_actor_role text;
  v_target public.builder_organisation_memberships;
  v_row public.builder_organisation_memberships;
  v_other_owners integer;
BEGIN
  IF _action NOT IN ('set_role', 'suspend', 'reactivate', 'remove') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBER_ACTION_UNKNOWN';
  END IF;

  -- Serialise every membership decision in this organisation.
  PERFORM 1 FROM public.builder_organisations WHERE id = _organisation_id FOR UPDATE;

  SELECT m.membership_role INTO v_actor_role
    FROM public.builder_organisation_memberships m
    JOIN public.builder_portal_users u ON u.id = m.builder_user_id
   WHERE m.builder_user_id = _actor_builder_user_id
     AND m.organisation_id = _organisation_id
     AND m.revoked_at IS NULL AND m.status = 'active'
     AND u.is_active AND u.status = 'active' AND u.revoked_at IS NULL;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'administrator') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_NOT_ORG_ADMIN';
  END IF;

  -- Scoped to THIS organisation: another organisation's id reads as absent.
  SELECT * INTO v_target FROM public.builder_organisation_memberships
   WHERE id = _membership_id AND organisation_id = _organisation_id AND revoked_at IS NULL
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBERSHIP_NOT_FOUND';
  END IF;

  IF v_target.builder_user_id = _actor_builder_user_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBER_SELF_MANAGEMENT';
  END IF;
  IF v_target.membership_role = 'owner' AND v_actor_role <> 'owner' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_OWNER_ONLY';
  END IF;

  IF _action = 'set_role' THEN
    IF _role IS NULL OR _role NOT IN ('administrator', 'manager', 'member', 'read_only') THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBER_ROLE_INVALID';
    END IF;
    IF _role = v_target.membership_role THEN
      RETURN v_target;
    END IF;
  ELSIF _action = 'suspend' AND v_target.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBER_NOT_ACTIVE';
  ELSIF _action = 'reactivate' AND v_target.status <> 'suspended' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MEMBER_NOT_SUSPENDED';
  END IF;

  -- The last owner: any act that stops the target being an active owner must
  -- leave at least one OTHER active owner with an active account.
  IF v_target.membership_role = 'owner' AND _action IN ('set_role', 'suspend', 'remove') THEN
    SELECT count(*) INTO v_other_owners
      FROM public.builder_organisation_memberships m
      JOIN public.builder_portal_users u ON u.id = m.builder_user_id
     WHERE m.organisation_id = _organisation_id AND m.id <> v_target.id
       AND m.membership_role = 'owner' AND m.status = 'active' AND m.revoked_at IS NULL
       AND u.is_active AND u.status = 'active' AND u.revoked_at IS NULL;
    IF v_other_owners = 0 THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_LAST_OWNER';
    END IF;
  END IF;

  IF _action = 'set_role' THEN
    UPDATE public.builder_organisation_memberships SET membership_role = _role
     WHERE id = v_target.id RETURNING * INTO v_row;
  ELSIF _action = 'suspend' THEN
    UPDATE public.builder_organisation_memberships SET status = 'suspended'
     WHERE id = v_target.id RETURNING * INTO v_row;
  ELSIF _action = 'reactivate' THEN
    UPDATE public.builder_organisation_memberships SET status = 'active'
     WHERE id = v_target.id RETURNING * INTO v_row;
  ELSE
    UPDATE public.builder_organisation_memberships
       SET status = 'revoked', revoked_at = now(),
           revoked_reason = COALESCE(NULLIF(btrim(_reason), ''), 'removed by an organisation administrator'),
           is_primary = false
     WHERE id = v_target.id RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    NULL, 'builder_user',
    CASE _action WHEN 'set_role' THEN 'builder_membership_role_changed'
                 WHEN 'suspend' THEN 'builder_membership_suspended'
                 WHEN 'reactivate' THEN 'builder_membership_reactivated'
                 ELSE 'builder_membership_revoked' END,
    'membership', v_row.id, _organisation_id, _actor_builder_user_id,
    jsonb_build_object('membership_role', v_target.membership_role, 'status', v_target.status),
    jsonb_build_object('membership_role', v_row.membership_role, 'status', v_row.status),
    NULLIF(btrim(COALESCE(_reason, '')), ''),
    jsonb_build_object('target_builder_user_id', v_row.builder_user_id, 'actor_role', v_actor_role));

  RETURN v_row;
END $fn$;

COMMENT ON FUNCTION public.builder_org_manage_membership(uuid, uuid, uuid, text, text, text) IS
  'Portal member management: an active owner/administrator changes a role, suspends, reactivates or removes a member of their own organisation. Owners only by owners; never self; never the last active owner; owner never assignable. Audited.';

REVOKE ALL ON FUNCTION public.builder_org_manage_membership(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_org_manage_membership(uuid, uuid, uuid, text, text, text) TO service_role;
