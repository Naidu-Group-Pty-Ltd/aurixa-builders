-- A JOIN REQUEST IS A GRANT, SO IT WAITS TOO.
--
-- Found by the independent security review of 20260928090000, on 28 Sep 2026.
--
-- That migration made a grant to an account that cannot sign in yet WAIT
-- (`invited`), so that accepting one organisation's invitation can never bring
-- another organisation's membership alive. It reached the three edge functions
-- that grant a membership and NOT the one that grants one in SQL:
-- `builder_decide_org_join_request` wrote `status = 'active'` unconditionally.
--
-- So approving a join request re-created the exact pre-condition the rule
-- exists to remove — a LIVE membership on an account whose mailbox nobody has
-- proved — and the structural half of the guarantee stopped covering that
-- account. Self-registration is closed, so no NEW join request can be written,
-- but `approve_join_request` is live in the portal and renders on the Settings
-- page, so any legacy pending row was exploitable.
--
-- Two changes, and nothing else about the function moves.
--
--  1. The status is decided the same way every other door decides it: live
--     where the account already signs in (`password_hash` or
--     `invite_accepted_at`), waiting where it does not.
--
--  2. A waiting membership that ALREADY exists here is promoted. Without this
--     the existence guard below saw the row, skipped the insert, stamped the
--     request `approved`, answered `membership_created = false`, and left the
--     member with no access and no repair path anywhere — `reactivate` refuses
--     anything that is not `suspended`, and the members list offered no
--     cancel. Approving IS this organisation's decision to let them in, so it
--     promotes; and only from `invited`, never from `suspended`, which is an
--     administrator's decision a join approval may not undo.
--
-- Re-runnable, and it changes no existing row: `CREATE OR REPLACE` on one
-- function body.

CREATE OR REPLACE FUNCTION public.builder_decide_org_join_request(
  _request_id uuid,
  _organisation_id uuid,
  _decided_by uuid,
  _approve boolean)
RETURNS TABLE (request_id uuid, request_status text, membership_created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_request record;
  v_requester record;
  v_created boolean := false;
  v_primary boolean;
  v_grant_status text;
  v_promoted integer := 0;
BEGIN
  -- The decider must hold a LIVE owner/administrator membership of the very
  -- organisation the request names. A forged organisation id therefore
  -- cannot widen reach: the request row is matched against the same id.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_organisation_memberships m
    WHERE m.builder_user_id = _decided_by
      AND m.organisation_id = _organisation_id
      AND m.revoked_at IS NULL
      AND m.status = 'active'
      AND m.membership_role IN ('owner', 'administrator')
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_NOT_ORG_ADMIN';
  END IF;

  -- One winner: the conditional UPDATE is the whole concurrency story. A
  -- duplicate or concurrent decision finds status <> 'pending' and is told
  -- the request was already decided rather than silently re-deciding it.
  UPDATE public.builder_org_join_requests r
     SET status = CASE WHEN _approve THEN 'approved' ELSE 'declined' END,
         decided_by = _decided_by,
         decided_at = now()
   WHERE r.id = _request_id
     AND r.organisation_id = _organisation_id
     AND r.status = 'pending'
  RETURNING r.id, r.builder_user_id, r.organisation_id, r.status INTO v_request;

  IF v_request.id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.builder_org_join_requests r
      WHERE r.id = _request_id AND r.organisation_id = _organisation_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_JOIN_REQUEST_ALREADY_DECIDED';
    END IF;
    -- Absent here includes "belongs to another organisation": the probe is
    -- scoped, so cross-organisation ids read as not-found, never forbidden.
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_JOIN_REQUEST_NOT_FOUND';
  END IF;

  IF _approve THEN
    SELECT u.id, u.status, u.revoked_at, u.password_hash, u.invite_accepted_at INTO v_requester
    FROM public.builder_portal_users u WHERE u.id = v_request.builder_user_id;
    -- A revoked account is an operator decision this surface may not undo.
    -- The RAISE rolls the decision stamp back too: the request stays pending
    -- for an operator to resolve, rather than reading approved-but-refused.
    IF v_requester.id IS NULL OR v_requester.revoked_at IS NOT NULL
       OR v_requester.status = 'revoked' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_JOIN_REQUEST_USER_REVOKED';
    END IF;

    -- A GRANT TO AN ACCOUNT THAT CANNOT SIGN IN YET WAITS, here as everywhere.
    -- This door wrote 'active' unconditionally, which re-created the very
    -- pre-condition 20260928090000 exists to remove: a LIVE membership on an
    -- account whose mailbox nobody has proved. `builder_accessible_organisations`
    -- requires 'active', so a waiting row is invisible until this
    -- organisation's own invitation is accepted.
    v_grant_status := CASE
      WHEN v_requester.password_hash IS NOT NULL OR v_requester.invite_accepted_at IS NOT NULL
        THEN 'active' ELSE 'invited' END;

    -- An account that already holds a WAITING membership here gets no insert
    -- below (the guard sees it) and would have got no promotion either: the
    -- request stamped `approved`, `membership_created` came back false, and the
    -- member had no access with nothing on the members screen able to repair it
    -- — `reactivate` refuses anything that is not `suspended`. Approving is the
    -- organisation's own decision to let them in, so it promotes.
    IF v_grant_status = 'active' THEN
      UPDATE public.builder_organisation_memberships m
         SET status = 'active', granted_by = _decided_by
       WHERE m.builder_user_id = v_request.builder_user_id
         AND m.organisation_id = _organisation_id
         AND m.status = 'invited'
         AND m.revoked_at IS NULL;
      GET DIAGNOSTICS v_promoted = ROW_COUNT;
      IF v_promoted > 0 THEN v_created := true; END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.builder_organisation_memberships m
      WHERE m.builder_user_id = v_request.builder_user_id
        AND m.organisation_id = _organisation_id
        AND m.revoked_at IS NULL
    ) THEN
      -- Their first reachable organisation becomes primary; joining a second
      -- one never steals the flag (builder_memberships_one_primary_key).
      SELECT NOT EXISTS (
        SELECT 1 FROM public.builder_organisation_memberships m
        WHERE m.builder_user_id = v_request.builder_user_id
          AND m.is_primary AND m.revoked_at IS NULL
      ) INTO v_primary;
      BEGIN
        INSERT INTO public.builder_organisation_memberships(
          builder_user_id, organisation_id, membership_role, is_primary,
          status, granted_by)
        VALUES (v_request.builder_user_id, _organisation_id, 'member',
                v_primary, v_grant_status, _decided_by);
        v_created := true;
      EXCEPTION WHEN unique_violation THEN
        -- Either the live-membership key (an invite landed concurrently —
        -- membership exists, which is the state approval wanted) or the
        -- one-primary key (another primary appeared concurrently) — retry
        -- once as an ordinary secondary membership.
        IF NOT EXISTS (
          SELECT 1 FROM public.builder_organisation_memberships m
          WHERE m.builder_user_id = v_request.builder_user_id
            AND m.organisation_id = _organisation_id
            AND m.revoked_at IS NULL
        ) THEN
          INSERT INTO public.builder_organisation_memberships(
            builder_user_id, organisation_id, membership_role, is_primary,
            status, granted_by)
          VALUES (v_request.builder_user_id, _organisation_id, 'member',
                  false, v_grant_status, _decided_by);
          v_created := true;
        END IF;
      END;
    END IF;

    -- A member needs their checklist whichever door they came through.
    PERFORM public.builder_ensure_onboarding_steps(v_request.builder_user_id);
  END IF;

  PERFORM public.builder_log_activity(
    _decided_by, 'builder_user',
    CASE WHEN _approve THEN 'builder_org_join_request_approved'
         ELSE 'builder_org_join_request_declined' END,
    'membership', v_request.id, _organisation_id, v_request.builder_user_id,
    NULL,
    jsonb_build_object(
      'join_request_id', v_request.id,
      'requester_builder_user_id', v_request.builder_user_id,
      'membership_created', v_created),
    NULL,
    jsonb_build_object('decided_by', _decided_by));

  request_id := v_request.id;
  request_status := v_request.status;
  membership_created := v_created;
  RETURN NEXT;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_decide_org_join_request(uuid, uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_decide_org_join_request(uuid, uuid, uuid, boolean)
  TO service_role;

COMMENT ON FUNCTION public.builder_decide_org_join_request(uuid, uuid, uuid, boolean) IS
  'Approve or decline one pending builder_org_join_requests row, stamping the decision and (on approval) granting the member-role membership in the same transaction. The decider must hold a live owner/administrator membership of the request''s organisation. Concurrency is settled by the conditional UPDATE on status=pending.';

-- ===========================================================================
-- Backfill: every user created before register seeded onboarding steps.
-- Idempotent — the RPC's ON CONFLICT DO NOTHING makes re-running free.
-- ===========================================================================
DO $$
DECLARE v_user uuid; v_repaired integer := 0;
BEGIN
  FOR v_user IN
    SELECT u.id FROM public.builder_portal_users u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.builder_onboarding_steps s WHERE s.builder_user_id = u.id)
  LOOP
    PERFORM public.builder_ensure_onboarding_steps(v_user);
    v_repaired := v_repaired + 1;
  END LOOP;
  RAISE NOTICE 'onboarding backfill: % user(s) repaired', v_repaired;
END $$;
