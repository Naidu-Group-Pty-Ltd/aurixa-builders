-- ============================================================================
-- Join-request decisions, and the onboarding rows self-registration owed.
--
-- Registration (extraction plan §5) deliberately never auto-joins on an ABN
-- match: it writes a pending `builder_org_join_requests` row "an owner
-- decides". This migration supplies the deciding half — a single
-- transactional command the portal's owner/administrator surface calls — and
-- repairs the second registration gap: `builder-portal-register` created
-- users without their `builder_onboarding_steps`, so a self-registered user
-- reached the onboarding gate with zero mandatory steps, and
-- `has_completed_mandatory_onboarding` (which requires steps to EXIST and
-- all be complete) could never become true. The runtime now seeds through
-- `builder_ensure_onboarding_steps` exactly as the invite path always has;
-- the backfill below repairs every user created before the fix.
--
-- Why one SECURITY DEFINER command rather than three PostgREST writes:
--   * the decision stamp and the membership grant must COMMIT TOGETHER — a
--     stamped approval with no membership is a lie the requester can see;
--   * concurrency is settled by one conditional UPDATE on status='pending'
--     (the partial unique index allows one open request per (org, user), so
--     the loser of a duplicate decision matches no row and is told so);
--   * the caller's authority is re-verified HERE, against the decider's own
--     live membership of the request's organisation — the edge function's
--     active-organisation scoping is the journey, this is the control.
--
-- Mission Control keeps read-only visibility of the queue
-- (builder-network-admin list_join_requests); nothing here is callable with
-- a federation assertion, so membership authority stays with organisation
-- owners.
-- ============================================================================

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
    SELECT u.id, u.status, u.revoked_at INTO v_requester
    FROM public.builder_portal_users u WHERE u.id = v_request.builder_user_id;
    -- A revoked account is an operator decision this surface may not undo.
    -- The RAISE rolls the decision stamp back too: the request stays pending
    -- for an operator to resolve, rather than reading approved-but-refused.
    IF v_requester.id IS NULL OR v_requester.revoked_at IS NOT NULL
       OR v_requester.status = 'revoked' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_JOIN_REQUEST_USER_REVOKED';
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
                v_primary, 'active', _decided_by);
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
                  false, 'active', _decided_by);
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

-- ===========================================================================
-- Post-migration assertions
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'builder_decide_org_join_request'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: builder_decide_org_join_request is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.builder_portal_users u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.builder_onboarding_steps s WHERE s.builder_user_id = u.id)
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a builder user still has zero onboarding rows';
  END IF;

  RAISE NOTICE 'join-request decisions installed; onboarding rows complete';
END $$;
