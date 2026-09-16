-- ============================================================================
-- AN ACTIVATION OPENS A PROJECT
--
-- Until now an agency activation fanned out into a task and notifications and
-- stopped there: the builder was told, but the telling was the whole product.
-- This migration makes the activation the ENTRY POINT into a working record.
-- When a selection announcement is applied, the fan-out now also:
--
--   1. opens a `builder_projects` row for the activated property — named and
--      addressed from the stock item, status `planning`, with a shared summary
--      that says which agency opened it;
--   2. grants `builder_project_access` to every active member of the builder
--      organisation (access_role mapped from their membership_role), because a
--      project nobody can see is not a project;
--   3. links `builder_stock_items.builder_project_id` (only when unset — a
--      manual link is somebody's decision and is never overwritten) and stamps
--      `builder_stock_selection_announcements.activation_project_id`;
--   4. on withdrawal, closes the pending work it opened: the open task (as
--      before) AND the project — but the project only while it is exactly as
--      the fan-out left it (status `planning`, row_version 1). One edit or one
--      transition by anyone means people are working in it, and a withdrawal
--      then only marks the activation card, never their record.
--
-- One project per ANNOUNCEMENT, not per stock item: two clients activating the
-- same property are two prospective engagements, and one agency's withdrawal
-- must never cancel the other's record. The stock item keeps pointing at the
-- first project it was linked to.
--
-- The sweep (`builder_network_apply_inbound_events`) now calls the fan-out for
-- EVERY known announcement status and the fan-out itself decides: an active
-- selection grows project + task + notifications; `builder_acknowledged` only
-- ensures the project exists (its alerts were already sent, its task already
-- completed by the acknowledgement RPC); `withdrawn` closes pending work.
-- All of it stays inside the sweep's per-event transaction and under the
-- announcement's FOR UPDATE lock, so the door's opportunistic sweep and the
-- cron sweep cannot double-create anything.
--
-- A backfill at the end visits every existing non-withdrawn announcement so
-- activations that happened before this migration get their project the moment
-- this applies — and an assertion proves none is left without one.
-- ============================================================================

-- ===========================================================================
-- 1. The announcement points at the project it opened
-- ===========================================================================
ALTER TABLE public.builder_stock_selection_announcements
  ADD COLUMN IF NOT EXISTS activation_project_id uuid
    REFERENCES public.builder_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS builder_stock_announcements_activation_project_idx
  ON public.builder_stock_selection_announcements(activation_project_id)
  WHERE activation_project_id IS NOT NULL;

COMMENT ON COLUMN public.builder_stock_selection_announcements.activation_project_id IS
  'The builder_projects row this activation opened. Set by builder_stock_activation_fanout; SET NULL if the project is deleted (the announcement remains the domain record).';

-- ===========================================================================
-- 2. Fan-out v2 — the whole activation lifecycle in one place
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_stock_activation_fanout(_announcement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_a record;
  v_item record;
  v_agency_name text;
  v_contact jsonb;
  v_contact_line text;
  v_label text;
  v_task_id uuid;
  v_title text;
  v_body text;
  v_notified integer := 0;
  v_assigned integer := 0;
  v_task_created boolean := false;
  v_project_id uuid;
  v_project_created boolean := false;
  v_project_cancelled boolean := false;
  v_task_cancelled integer := 0;
  v_granted integer := 0;
  v_project_type text;
  v_untouched public.builder_projects;
BEGIN
  -- Locked: the door's opportunistic sweep and pg_cron's scheduled one can
  -- both reach an announcement in the same minute, and notifications alone
  -- are key-guarded — the task and the project are not. The second caller
  -- waits, re-reads the pointers the first one wrote, and creates nothing.
  SELECT a.*, wc.workspace_id INTO v_a
  FROM public.builder_stock_selection_announcements a
  JOIN public.workspace_connections wc ON wc.id = a.connection_id
  WHERE a.id = _announcement_id
  FOR UPDATE OF a;
  IF v_a.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'announcement_not_found');
  END IF;
  IF v_a.status NOT IN ('selected', 'progressed', 'completed',
                        'builder_acknowledged', 'withdrawn') THEN
    RETURN jsonb_build_object('skipped', 'status_' || v_a.status);
  END IF;

  -- The agency's name: the event's disclosure first, the directory the
  -- workspace asserted to this network second, and an honest generic last.
  SELECT COALESCE(
           nullif(btrim(COALESCE(v_a.agency_name, '')), ''),
           nullif(btrim(COALESCE(r.display_name, '')), ''),
           nullif(btrim(COALESCE(r.slug, '')), ''),
           'A connected agency')
  INTO v_agency_name
  FROM (SELECT 1) one
  LEFT JOIN public.workspace_registry r ON r.id = v_a.workspace_id;

  -- ------------------------------------------------------------- withdrawal
  -- Close the pending work this activation opened, and nothing anybody has
  -- made their own: a task somebody finished stays finished, and a project
  -- somebody edited or transitioned (row_version > 1, or no longer planning)
  -- stays theirs — the withdrawn card on the record says what happened.
  IF v_a.status = 'withdrawn' THEN
    IF v_a.activation_task_id IS NOT NULL THEN
      UPDATE public.builder_tasks t
         SET status = 'cancelled'
       WHERE t.id = v_a.activation_task_id
         AND t.status IN ('open', 'in_progress', 'blocked');
      GET DIAGNOSTICS v_task_cancelled = ROW_COUNT;
    END IF;

    IF v_a.activation_project_id IS NOT NULL THEN
      SELECT * INTO v_untouched
      FROM public.builder_projects
      WHERE id = v_a.activation_project_id
        AND status = 'planning' AND row_version = 1
      FOR UPDATE;
      IF v_untouched.id IS NOT NULL THEN
        -- The governed transition: history row and trusted audit inside this
        -- same transaction, exactly as a human cancellation would write them.
        PERFORM public.builder_transition_project(
          v_untouched.id, v_untouched.row_version, 'planning', 'cancelled',
          left('Activation withdrawn by ' || v_agency_name, 500),
          'system', NULL, NULL);
        v_project_cancelled := true;
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'withdrawn', true,
      'task_cancelled', v_task_cancelled > 0,
      'project_cancelled', v_project_cancelled);
  END IF;

  SELECT id, address_line, suburb, state, postcode, lot_number,
         external_reference, development_name, project_name, property_type,
         organisation_id, builder_project_id
  INTO v_item
  FROM public.builder_stock_items WHERE id = v_a.stock_item_id;
  IF v_item.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'stock_item_missing');
  END IF;

  v_contact := COALESCE(v_a.agency_contact, '{}'::jsonb);
  v_contact_line := concat_ws(' · ',
    nullif(btrim(COALESCE(v_contact->>'contact_name', '')), ''),
    nullif(btrim(COALESCE(v_contact->>'contact_email', '')), ''),
    nullif(btrim(COALESCE(v_contact->>'contact_phone', '')), ''));

  v_label := concat_ws(', ',
    nullif(concat_ws(' ', CASE WHEN nullif(btrim(COALESCE(v_item.lot_number,'')), '') IS NOT NULL
                               AND position('lot' in lower(COALESCE(v_item.address_line,''))) = 0
                          THEN 'Lot ' || btrim(v_item.lot_number) END,
                          nullif(btrim(COALESCE(v_item.address_line, '')), '')), ''),
    nullif(btrim(COALESCE(v_item.suburb, '')), ''),
    nullif(btrim(COALESCE(v_item.state, '')), ''));
  IF v_label IS NULL OR v_label = '' THEN
    v_label := COALESCE(nullif(btrim(COALESCE(v_item.external_reference, '')), ''), 'A stock property');
  END IF;

  -- ------------------------------------------------------------- the project
  -- The working record the notification's "View project" opens. Only field
  -- values that satisfy builder_projects' own CHECKs are copied: a state that
  -- is not an AU state and a postcode that is not four digits stay NULL rather
  -- than fail the whole fan-out over spreadsheet noise.
  IF v_a.activation_project_id IS NULL THEN
    v_project_type := CASE
      WHEN lower(COALESCE(v_item.property_type, '')) LIKE '%town%'   THEN 'townhouse'
      WHEN lower(COALESCE(v_item.property_type, '')) LIKE '%apart%'
        OR lower(COALESCE(v_item.property_type, '')) LIKE '%unit%'   THEN 'apartment'
      WHEN lower(COALESCE(v_item.property_type, '')) LIKE '%duplex%' THEN 'duplex'
      WHEN lower(COALESCE(v_item.property_type, '')) LIKE '%land%'   THEN 'land_only'
      ELSE 'house_and_land' END;

    INSERT INTO public.builder_projects(
      builder_organisation_id, name, project_type, status,
      address_line, suburb, state, postcode, lot_number, shared_summary)
    VALUES (
      v_a.organisation_id,
      left(v_label, 200),
      v_project_type,
      'planning',
      nullif(btrim(COALESCE(v_item.address_line, '')), ''),
      nullif(btrim(COALESCE(v_item.suburb, '')), ''),
      CASE WHEN upper(btrim(COALESCE(v_item.state, ''))) IN
                ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')
           THEN upper(btrim(v_item.state)) END,
      CASE WHEN btrim(COALESCE(v_item.postcode, '')) ~ '^[0-9]{4}$'
           THEN btrim(v_item.postcode) END,
      nullif(btrim(COALESCE(v_item.lot_number, '')), ''),
      left('Opened automatically when ' || v_agency_name
        || ' activated this property for a client'
        || CASE WHEN nullif(btrim(COALESCE(v_a.remote_client_label, '')), '') IS NOT NULL
                THEN ' (client reference: ' || btrim(v_a.remote_client_label) || ')' ELSE '' END
        || '. The activation record and the agency contact details stay attached to this project.',
        2000))
    RETURNING id INTO v_project_id;
    v_project_created := true;

    -- The opening entry, in the same append-only history a human change writes.
    INSERT INTO public.builder_project_status_history(
      project_id, from_status, to_status, changed_by_type, reason)
    VALUES (v_project_id, NULL, 'planning', 'system',
            left('Project opened from an activation by ' || v_agency_name, 1000));

    -- Every active member can see the record; roles follow their standing in
    -- the organisation. The unique (builder_user_id, project_id) key makes a
    -- replay grant nothing twice.
    INSERT INTO public.builder_project_access(
      builder_user_id, project_id, organisation_id, organisation_side, access_role)
    SELECT m.builder_user_id, v_project_id, v_a.organisation_id, 'builder',
           CASE m.membership_role
             WHEN 'owner'         THEN 'responsible'
             WHEN 'administrator' THEN 'supervisor'
             WHEN 'manager'       THEN 'supervisor'
             WHEN 'read_only'     THEN 'read_only'
             ELSE 'team_member' END
    FROM public.builder_organisation_memberships m
    JOIN public.builder_portal_users u ON u.id = m.builder_user_id
    WHERE m.organisation_id = v_a.organisation_id
      AND m.status = 'active' AND m.revoked_at IS NULL
      AND u.is_active = true
    ON CONFLICT (builder_user_id, project_id) DO NOTHING;
    GET DIAGNOSTICS v_granted = ROW_COUNT;

    UPDATE public.builder_stock_items
       SET builder_project_id = v_project_id
     WHERE id = v_item.id AND builder_project_id IS NULL;

    UPDATE public.builder_stock_selection_announcements
       SET activation_project_id = v_project_id, updated_at = now()
     WHERE id = v_a.id;
  ELSE
    v_project_id := v_a.activation_project_id;
  END IF;

  -- An acknowledged announcement does not GROW the alert fan-out — its
  -- notifications were sent when it was active and its task was completed by
  -- the acknowledgement RPC. It only needed its project ensured above (the
  -- backfill path for activations acknowledged before projects existed).
  IF v_a.status = 'builder_acknowledged' THEN
    IF v_project_created THEN
      PERFORM public.builder_log_activity(
        NULL, 'system', 'builder_stock_activation_fanned_out',
        'stock_selection', v_a.id, v_a.organisation_id, NULL,
        NULL,
        jsonb_build_object(
          'stock_item_id', v_item.id,
          'project_id', v_project_id,
          'project_created', true,
          'granted', v_granted,
          'agency_name', v_agency_name),
        NULL, '{}'::jsonb);
    END IF;
    RETURN jsonb_build_object(
      'project_id', v_project_id, 'project_created', v_project_created,
      'granted', v_granted, 'task_created', false, 'notified', 0);
  END IF;

  v_title := left('Property activated by ' || v_agency_name, 200);
  v_body := left(
    v_label || ' has been activated for a client by ' || v_agency_name
    || CASE WHEN v_contact_line <> '' THEN ' — contact ' || v_contact_line ELSE '' END
    || CASE WHEN nullif(btrim(COALESCE(v_a.remote_client_label, '')), '') IS NOT NULL
            THEN ' (client reference: ' || btrim(v_a.remote_client_label) || ')' ELSE '' END
    || '.', 2000);

  -- ---------------------------------------------------------------- the task
  -- One live task per announcement. If the pointer is set the fan-out already
  -- ran; a deleted task is NOT resurrected (deleting it was somebody's act,
  -- and the FK set the pointer NULL — but the unique notification keys still
  -- stop a duplicate storm, and the announcement remains the domain record).
  IF v_a.activation_task_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.builder_notifications n
       WHERE n.source_announcement_id = v_a.id)
  THEN
    INSERT INTO public.builder_tasks(
      scope_type, scope_id, organisation_id, title, description,
      status, priority, due_date, created_by_builder_user_id)
    VALUES (
      'stock_item', v_item.id, v_a.organisation_id,
      left('Respond to activation: ' || v_label, 200),
      left('Property: ' || v_label
        || E'\nActivated by: ' || v_agency_name
        || CASE WHEN v_contact_line <> '' THEN E'\nAgency contact: ' || v_contact_line ELSE '' END
        || CASE WHEN nullif(btrim(COALESCE(v_a.remote_client_label, '')), '') IS NOT NULL
                THEN E'\nClient reference: ' || btrim(v_a.remote_client_label) ELSE '' END
        || E'\n\nOpen the project to review the property and acknowledge the activation so the agency knows you have it.', 8000),
      'open', 'high', current_date + 3, NULL)
    RETURNING id INTO v_task_id;
    v_task_created := true;

    UPDATE public.builder_stock_selection_announcements
       SET activation_task_id = v_task_id, updated_at = now()
     WHERE id = v_a.id;

    -- Assigned to every active member: "My tasks" is where people look, and
    -- stock is the organisation's, not one project team's.
    INSERT INTO public.builder_task_assignments(task_id, builder_user_id, assigned_by_builder_user_id)
    SELECT v_task_id, m.builder_user_id, NULL
    FROM public.builder_organisation_memberships m
    JOIN public.builder_portal_users u ON u.id = m.builder_user_id
    WHERE m.organisation_id = v_a.organisation_id
      AND m.status = 'active' AND m.revoked_at IS NULL
      AND u.is_active = true
    ON CONFLICT (task_id, builder_user_id) DO NOTHING;
    GET DIAGNOSTICS v_assigned = ROW_COUNT;
  ELSE
    v_task_id := v_a.activation_task_id;
  END IF;

  -- ------------------------------------------------------------ notifications
  -- One per active member, keyed (announcement, user) so replays and races
  -- land ON CONFLICT. `entity_kind = 'stock_selection'` is the contract the
  -- Dashboard pop-up has always watched for.
  INSERT INTO public.builder_notifications(
    builder_user_id, organisation_id, notification_type, title, body,
    scope_type, scope_id, entity_kind, entity_id, source_announcement_id)
  SELECT m.builder_user_id, v_a.organisation_id, 'stock_selection', v_title, v_body,
         NULL, NULL, 'stock_selection', v_a.id, v_a.id
  FROM public.builder_organisation_memberships m
  JOIN public.builder_portal_users u ON u.id = m.builder_user_id
  WHERE m.organisation_id = v_a.organisation_id
    AND m.status = 'active' AND m.revoked_at IS NULL
    AND u.is_active = true
  ON CONFLICT (source_announcement_id, builder_user_id) WHERE source_announcement_id IS NOT NULL
  DO NOTHING;
  GET DIAGNOSTICS v_notified = ROW_COUNT;

  IF v_task_created OR v_notified > 0 OR v_project_created THEN
    PERFORM public.builder_log_activity(
      NULL, 'system', 'builder_stock_activation_fanned_out',
      'stock_selection', v_a.id, v_a.organisation_id, NULL,
      NULL,
      jsonb_build_object(
        'stock_item_id', v_item.id,
        'task_id', v_task_id,
        'task_created', v_task_created,
        'notified', v_notified,
        'project_id', v_project_id,
        'project_created', v_project_created,
        'granted', v_granted,
        'agency_name', v_agency_name),
      NULL, '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'task_id', v_task_id, 'task_created', v_task_created,
    'assigned', v_assigned, 'notified', v_notified,
    'project_id', v_project_id, 'project_created', v_project_created,
    'granted', v_granted);
END $fn$;
REVOKE ALL ON FUNCTION public.builder_stock_activation_fanout(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_activation_fanout(uuid) TO service_role;
COMMENT ON FUNCTION public.builder_stock_activation_fanout(uuid) IS
  'The whole activation lifecycle for one announcement: ensure the project (created, granted to active members, linked to the stock item), grow the pending task and per-member notifications for active statuses, and on withdrawal cancel the open task and an untouched planning project. Idempotent per announcement; called by the inbound convergence sweep for every known status and by the backfill.';

-- ===========================================================================
-- 3. The sweep delegates every status to the fan-out
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_network_apply_inbound_events(_limit integer DEFAULT 50)
RETURNS TABLE(applied integer, refused integer, deferred integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_event record;
  v_connection record;
  v_payload jsonb;
  v_ref uuid;
  v_item uuid;
  v_status text;
  v_label text;
  v_agency jsonb;
  v_agency_name text;
  v_agency_contact jsonb;
  v_announcement record;
  v_applied integer := 0;
  v_refused integer := 0;
  v_deferred integer := 0;
  v_touched uuid[] := '{}';
  v_conn_list uuid[];
  v_conn uuid;
  v_pending integer;
BEGIN
  FOR v_event IN
    SELECT e.* FROM public.builder_network_inbound_events e
    WHERE e.processed_at IS NULL
    ORDER BY e.received_at
    LIMIT greatest(1, least(_limit, 500))
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      SELECT c.id, c.state, c.builder_organisation_id INTO v_connection
      FROM public.workspace_connections c WHERE c.id = v_event.connection_id;

      IF v_connection.id IS NULL OR v_connection.state = 'revoked' THEN
        -- The door only accepts active connections, so a revoked one here
        -- means revocation happened after landing: nothing lawful remains to
        -- converge into.
        PERFORM public.builder_network_mark_inbound_refused(
          v_event.id, v_event.connection_id, v_event.event_type,
          'connection_revoked', 'warning');
        v_refused := v_refused + 1;
        CONTINUE;
      END IF;

      IF v_event.event_type IN ('stock.selection.announced', 'stock.selection.updated') THEN
        v_payload := COALESCE(v_event.payload, '{}'::jsonb);

        BEGIN
          v_ref := (v_payload->>'remote_selection_ref')::uuid;
        EXCEPTION WHEN others THEN v_ref := NULL; END;
        BEGIN
          v_item := (v_payload->>'stock_item_id')::uuid;
        EXCEPTION WHEN others THEN v_item := NULL; END;
        v_status := COALESCE(nullif(btrim(v_payload->>'status'), ''), 'selected');
        v_label := nullif(btrim(COALESCE(v_payload->>'remote_client_label', '')), '');

        -- The agency block is the workspace's authorised self-disclosure:
        -- its own name and an outward contact. Cleaned key by key; anything
        -- else in the block is dropped here, not stored.
        v_agency := CASE WHEN jsonb_typeof(v_payload->'agency') = 'object'
                         THEN v_payload->'agency' ELSE NULL END;
        v_agency_name := left(nullif(btrim(COALESCE(v_agency->>'name', '')), ''), 200);
        v_agency_contact := NULL;
        IF v_agency IS NOT NULL THEN
          v_agency_contact := jsonb_strip_nulls(jsonb_build_object(
            'contact_name',  left(nullif(btrim(COALESCE(v_agency->>'contact_name',  '')), ''), 200),
            'contact_email', left(nullif(btrim(COALESCE(v_agency->>'contact_email', '')), ''), 320),
            'contact_phone', left(nullif(btrim(COALESCE(v_agency->>'contact_phone', '')), ''), 60)));
          IF v_agency_contact = '{}'::jsonb THEN v_agency_contact := NULL; END IF;
        END IF;

        IF v_ref IS NULL OR v_item IS NULL THEN
          PERFORM public.builder_network_mark_inbound_refused(
            v_event.id, v_connection.id, v_event.event_type,
            'invalid_payload', 'warning');
          v_refused := v_refused + 1;
          CONTINUE;
        END IF;
        -- The workspace never sets the builder's own act, and an unknown
        -- status is refused rather than stored — a vocabulary drift must be
        -- a visible failure, not a CHECK-constraint surprise mid-upsert.
        IF v_status NOT IN ('selected', 'progressed', 'completed', 'withdrawn') THEN
          PERFORM public.builder_network_mark_inbound_refused(
            v_event.id, v_connection.id, v_event.event_type,
            'invalid_status:' || left(v_status, 40), 'warning');
          v_refused := v_refused + 1;
          CONTINUE;
        END IF;

        -- The property must be THIS connection's builder's. The organisation
        -- comes from the connection row — the payload holds no authority.
        IF NOT EXISTS (
          SELECT 1 FROM public.builder_stock_items i
          WHERE i.id = v_item
            AND i.organisation_id = v_connection.builder_organisation_id
        ) THEN
          PERFORM public.builder_network_mark_inbound_refused(
            v_event.id, v_connection.id, v_event.event_type,
            'stock_item_not_ours', 'critical');
          v_refused := v_refused + 1;
          CONTINUE;
        END IF;

        INSERT INTO public.builder_stock_selection_announcements(
          connection_id, stock_item_id, organisation_id,
          remote_selection_ref, remote_client_label, status, source_version,
          agency_name, agency_contact)
        VALUES (v_connection.id, v_item, v_connection.builder_organisation_id,
                v_ref, v_label, v_status, COALESCE(v_event.source_version, 0),
                v_agency_name, v_agency_contact)
        ON CONFLICT (connection_id, remote_selection_ref) DO UPDATE
          SET status = CASE
                -- The builder's acknowledgement survives a replay of the
                -- original announcement; a real progression still lands.
                WHEN public.builder_stock_selection_announcements.status = 'builder_acknowledged'
                     AND EXCLUDED.status = 'selected'
                  THEN public.builder_stock_selection_announcements.status
                ELSE EXCLUDED.status END,
              remote_client_label = EXCLUDED.remote_client_label,
              stock_item_id = EXCLUDED.stock_item_id,
              source_version = EXCLUDED.source_version,
              -- A later event without the block never erases what an earlier
              -- one disclosed.
              agency_name = COALESCE(EXCLUDED.agency_name,
                public.builder_stock_selection_announcements.agency_name),
              agency_contact = COALESCE(EXCLUDED.agency_contact,
                public.builder_stock_selection_announcements.agency_contact)
          WHERE EXCLUDED.source_version
                  >= public.builder_stock_selection_announcements.source_version;

        -- Re-read the row the upsert left standing (a stale event's UPDATE is
        -- suppressed by the version guard, and RETURNING would say nothing).
        SELECT a.* INTO v_announcement
        FROM public.builder_stock_selection_announcements a
        WHERE a.connection_id = v_connection.id AND a.remote_selection_ref = v_ref;

        IF v_announcement.id IS NOT NULL THEN
          -- THE FAN-OUT — for every status the vocabulary admits. Inside the
          -- same transaction as the application, and the function itself
          -- decides what the row needs: an active selection grows its
          -- project, task and notifications; an acknowledged one only
          -- ensures the project; a withdrawal closes the pending work it
          -- opened (the open task, and a project nobody has touched).
          PERFORM public.builder_stock_activation_fanout(v_announcement.id);
        END IF;

        UPDATE public.builder_network_inbound_events
           SET processed_at = now(), apply_error = NULL,
               apply_attempts = apply_attempts + 1
         WHERE id = v_event.id;
        v_applied := v_applied + 1;
        v_touched := v_touched || v_connection.id;
      ELSE
        -- Unknown vocabulary: terminal with the reason recorded, so a newer
        -- clone shipping a newer event type is VISIBLE here rather than a
        -- queue that silently never drains. Replay after deploying the
        -- handler: clear processed_at on the affected rows.
        PERFORM public.builder_network_mark_inbound_refused(
          v_event.id, v_connection.id, v_event.event_type,
          'unhandled_event_type:' || left(v_event.event_type, 60), 'warning');
        v_refused := v_refused + 1;
      END IF;
    EXCEPTION WHEN others THEN
      -- A transient failure defers the event (attempts bumped, error
      -- recorded, processed_at left NULL so the next sweep retries) until
      -- the attempt budget is spent — then it dead-letters loudly.
      IF v_event.apply_attempts + 1 >= 5 THEN
        UPDATE public.builder_network_inbound_events
           SET processed_at = now(), apply_attempts = apply_attempts + 1,
               apply_error = left('dead:' || SQLERRM, 500)
         WHERE id = v_event.id;
        INSERT INTO public.portal_operational_events(
          event_name, severity, request_id, actor_type, portal, success, metadata)
        VALUES ('builder_network_inbound_apply_dead', 'critical',
                v_event.id::text, 'system', 'builder', false,
                jsonb_build_object('connection_id', v_event.connection_id,
                                   'event_type', v_event.event_type,
                                   'error', left(SQLERRM, 200)));
        v_refused := v_refused + 1;
      ELSE
        UPDATE public.builder_network_inbound_events
           SET apply_attempts = apply_attempts + 1,
               apply_error = left(SQLERRM, 500)
         WHERE id = v_event.id;
        v_deferred := v_deferred + 1;
      END IF;
    END;
  END LOOP;

  -- The inbound stamp keeps saying WHETHER anything waits; applying events
  -- is exactly what changes the answer. source_version is the sender's and
  -- is not moved here.
  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_conn_list FROM unnest(v_touched) c;
  FOREACH v_conn IN ARRAY v_conn_list
  LOOP
    SELECT count(*)::integer INTO v_pending
    FROM public.builder_network_inbound_events e
    WHERE e.connection_id = v_conn AND e.processed_at IS NULL;
    UPDATE public.builder_network_stamps s
       SET stamp = jsonb_build_object(
             'count', v_pending,
             'latest', to_jsonb((SELECT max(e.received_at) FROM public.builder_network_inbound_events e
                                 WHERE e.connection_id = v_conn AND e.processed_at IS NULL)),
             'pendingRequests', v_pending,
             'attention', 0),
           updated_at = now()
     WHERE s.connection_id = v_conn AND s.side = 'inbound';
  END LOOP;

  applied := v_applied;
  refused := v_refused;
  deferred := v_deferred;
  RETURN NEXT;
END $fn$;
REVOKE ALL ON FUNCTION public.builder_network_apply_inbound_events(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_apply_inbound_events(integer)
  TO service_role;

-- ===========================================================================
-- 4. Backfill — activations that happened before projects existed get theirs
-- ===========================================================================
DO $backfill$
DECLARE
  v_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_id IN
    SELECT a.id FROM public.builder_stock_selection_announcements a
    WHERE a.activation_project_id IS NULL AND a.status <> 'withdrawn'
    ORDER BY a.created_at
  LOOP
    PERFORM public.builder_stock_activation_fanout(v_id);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'activation project backfill visited % announcement(s)', v_count;
END $backfill$;

-- ===========================================================================
-- 5. Assertions — this migration is not "applied" if any of these is untrue
-- ===========================================================================
DO $assert$
DECLARE
  v_def text;
  v_missing integer;
BEGIN
  -- The pointer column exists.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'builder_stock_selection_announcements'
      AND column_name = 'activation_project_id'
  ) THEN
    RAISE EXCEPTION 'assertion failed: activation_project_id column is missing';
  END IF;

  -- The fan-out creates, grants and links the project, and cancels through
  -- the governed transition.
  SELECT pg_get_functiondef('public.builder_stock_activation_fanout(uuid)'::regprocedure)
    INTO v_def;
  IF position($src$INSERT INTO public.builder_projects($src$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'assertion failed: fan-out does not create the project';
  END IF;
  IF position($src$INSERT INTO public.builder_project_access($src$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'assertion failed: fan-out does not grant project access';
  END IF;
  IF position($src$SET builder_project_id = v_project_id$src$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'assertion failed: fan-out does not link the stock item';
  END IF;
  IF position($src$builder_transition_project($src$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'assertion failed: withdrawal does not use the governed transition';
  END IF;
  IF position($src$status = 'planning' AND row_version = 1$src$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'assertion failed: withdrawal cancel is not limited to untouched projects';
  END IF;

  -- The sweep delegates to the fan-out and no longer cancels tasks inline.
  SELECT pg_get_functiondef('public.builder_network_apply_inbound_events(integer)'::regprocedure)
    INTO v_def;
  IF position($src$builder_stock_activation_fanout(v_announcement.id)$src$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'assertion failed: sweep does not call the fan-out';
  END IF;
  IF position($src$UPDATE public.builder_tasks$src$ IN v_def) > 0 THEN
    RAISE EXCEPTION 'assertion failed: sweep still cancels tasks inline';
  END IF;

  -- The backfill converged: inside this same transaction, no live activation
  -- is left without its project.
  SELECT count(*) INTO v_missing
  FROM public.builder_stock_selection_announcements a
  WHERE a.activation_project_id IS NULL AND a.status <> 'withdrawn';
  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'assertion failed: % live announcement(s) still have no project', v_missing;
  END IF;
END $assert$;
