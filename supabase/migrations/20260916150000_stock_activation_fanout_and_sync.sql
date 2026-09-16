-- ============================================================================
-- Stock activation fan-out + outbound stock mirror sync (Builders Network E4/E5).
--
-- THE ACTIVATION MUST REACH THE PEOPLE WHO ACT ON IT. Until now an agency's
-- selection converged into `builder_stock_selection_announcements` and waited
-- for somebody to open the Stock List. This migration makes every applied
-- announcement fan out, in the same convergence transaction, into the surfaces
-- a builder actually watches:
--
--   * one PENDING TASK (scope `stock_item`) naming the property, the agency
--     and the agency's contact details, assigned to every active member of the
--     organisation — so the Tasks page and "My tasks" both carry it;
--   * one NOTIFICATION per active member (`notification_type =
--     'stock_selection'`, `entity_kind = 'stock_selection'`) — the bell, the
--     Notifications page, AND the Dashboard, whose pop-up has watched for
--     exactly that entity_kind since before the portal was extracted.
--
-- UNIVERSAL, NOT A ONE-TIME FIX. The fan-out lives INSIDE
-- `builder_network_apply_inbound_events` — the sweep pg_cron drives every
-- minute and the inbound door runs opportunistically — so every future
-- activation from every present and future connection fans out with no
-- operator involvement. It is idempotent per announcement (a replayed
-- delivery, a re-run sweep and a second sweep racing the first all land on
-- unique keys), and a backfill at the end of this file converges any
-- announcement that arrived before the code did.
--
-- WHO ACTIVATED, WITH CONTACT DETAILS — an authorised disclosure. The event
-- may now carry an `agency` block ({name, contact_name, contact_email,
-- contact_phone}) composed by the workspace's producer. That is the
-- product owner's explicit decision to disclose the AGENCY'S OWN outward
-- identity to the builder it activated; it is not client PII, staff ids or
-- internal notes, and the privacy contract's forbidden sets are unchanged.
-- The agency's display NAME also resolves from `workspace_registry` (the
-- directory the workspace asserted to this network), so a payload without the
-- block still fans out with an honest name.
--
-- THE MARKETPLACE THE BUTTON LIVES ON MUST SHOW THIS NETWORK'S REAL STOCK.
-- The workspace's Property Marketplace reads a mirror seeded at extraction
-- time and updated by nothing — its "active" rows are properties this network
-- has since archived, so an activation aimed at what an adviser can SEE would
-- be refused here as `stock_item_not_ours` or announce a dead listing. So this
-- migration also ships the outbound half of the stock mirror sync:
--
--   * `stock.item.upserted` — composed into `builder_network_outbox` whenever
--     a stock item's marketplace projection changes, KEY BY KEY (never a
--     spread of `source_row`, whose columns are whatever a builder typed into
--     a spreadsheet), one event per active connection serving that
--     organisation;
--   * `stock.catalog.reconciled` — the complete list of this organisation's
--     active item ids, daily by pg_cron and on demand, so the consumer can
--     archive mirror rows this network no longer stands behind. Self-healing:
--     a missed event is corrected within a day, forever;
--   * `builder_network_backfill_stock_sync(connection)` — the full catalogue,
--     enqueued automatically the moment a connection becomes ACTIVE, so a new
--     agency's marketplace converges without anyone running anything.
--
-- The image on a mirror card is served BY THIS NETWORK: the payload names the
-- primary image id and the consumer points its mirror row at the network's
-- public stock-image endpoint. No bytes cross in events, no second copy of a
-- photograph exists to go stale, and the builder-source-only display rule is
-- enforced where the bytes are served as well as where the pointer is chosen.
-- ============================================================================

-- ===========================================================================
-- 1. Schema: what an announcement now records, and where its fan-out landed
-- ===========================================================================
ALTER TABLE public.builder_stock_selection_announcements
  ADD COLUMN IF NOT EXISTS agency_name text,
  ADD COLUMN IF NOT EXISTS agency_contact jsonb,
  ADD COLUMN IF NOT EXISTS activation_task_id uuid
    REFERENCES public.builder_tasks(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.builder_stock_selection_announcements.agency_name IS
  'The activating agency''s display name as the event disclosed it. Falls back to workspace_registry.display_name at fan-out time when absent.';
COMMENT ON COLUMN public.builder_stock_selection_announcements.agency_contact IS
  'The agency''s outward contact for this activation: contact_name / contact_email / contact_phone only. An authorised disclosure of the AGENCY''s identity — never client PII.';
COMMENT ON COLUMN public.builder_stock_selection_announcements.activation_task_id IS
  'The pending task this announcement fanned out into. One per announcement; NULL means the fan-out has not run (or the task was deleted, in which case the fan-out will not recreate it — the announcement itself remains the record).';

-- The notification a fan-out writes is keyed to its announcement so a replay
-- cannot write a second one for the same person.
ALTER TABLE public.builder_notifications
  ADD COLUMN IF NOT EXISTS source_announcement_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS builder_notifications_announcement_user_key
  ON public.builder_notifications (source_announcement_id, builder_user_id)
  WHERE source_announcement_id IS NOT NULL;

-- The two vocabularies grow one word each. Additive: every existing row and
-- every existing writer remains valid.
ALTER TABLE public.builder_tasks DROP CONSTRAINT IF EXISTS builder_tasks_scope_type_check;
ALTER TABLE public.builder_tasks ADD CONSTRAINT builder_tasks_scope_type_check
  CHECK (scope_type = ANY (ARRAY[
    'project'::text, 'unit'::text, 'transaction'::text, 'construction_case'::text,
    'stock_item'::text]));

ALTER TABLE public.builder_notifications DROP CONSTRAINT IF EXISTS builder_notifications_notification_type_check;
ALTER TABLE public.builder_notifications ADD CONSTRAINT builder_notifications_notification_type_check
  CHECK (notification_type = ANY (ARRAY[
    'general'::text, 'task_assigned'::text, 'task_due'::text, 'message'::text,
    'defect_raised'::text, 'inspection_scheduled'::text, 'status_change'::text,
    'document_added'::text, 'variation_decision'::text, 'stock_selection'::text]));

-- ===========================================================================
-- 2. The stock_item scope: organisation-anchored, not project-anchored
--
-- Every earlier collaboration scope walks up to a project and resolves the
-- caller's project matrix. A stock activation has no project — stock belongs
-- to the ORGANISATION — so its resolver is the active membership itself, and
-- it answers only for the surface that needs it: tasks, view and edit. It
-- deliberately does NOT open documents or messages on a stock scope, and it
-- cannot widen any other scope because the dispatcher hands it stock_item and
-- nothing else.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_resolve_stock_item_permission(
  _user_id uuid, _item_id uuid, _permission_key text DEFAULT 'tasks', _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT _permission_key = 'tasks'
     AND _level IN ('view', 'edit')
     AND EXISTS (
       SELECT 1
       FROM public.builder_stock_items i
       JOIN public.builder_organisation_memberships m
         ON m.organisation_id = i.organisation_id
       JOIN public.builder_portal_users u ON u.id = m.builder_user_id
       WHERE i.id = _item_id
         AND m.builder_user_id = _user_id
         AND m.status = 'active' AND m.revoked_at IS NULL
         AND u.is_active = true);
$fn$;
REVOKE ALL ON FUNCTION public.builder_resolve_stock_item_permission(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_resolve_stock_item_permission(uuid, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.builder_resolve_scope_permission(
  _user_id uuid, _scope_type text, _scope_id uuid,
  _permission_key text DEFAULT 'documents', _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN CASE _scope_type
    WHEN 'project' THEN
      public.builder_resolve_project_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'unit' THEN
      public.builder_resolve_unit_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'transaction' THEN
      public.builder_resolve_transaction_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'construction_case' THEN
      public.builder_resolve_construction_permission(_user_id, _scope_id, _permission_key, _level)
    WHEN 'stock_item' THEN
      public.builder_resolve_stock_item_permission(_user_id, _scope_id, _permission_key, _level)
    ELSE false
  END;
END $fn$;

-- The row-level scope guard (`trg_builder_tasks_scope` and its siblings)
-- validates existence through this dispatcher before any permission question
-- is asked, so it learns the new scope with the others.
CREATE OR REPLACE FUNCTION public.builder_scope_exists(_scope_type text, _scope_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN CASE _scope_type
    WHEN 'project' THEN EXISTS (SELECT 1 FROM public.builder_projects WHERE id = _scope_id)
    WHEN 'unit' THEN EXISTS (SELECT 1 FROM public.builder_units WHERE id = _scope_id)
    WHEN 'transaction' THEN EXISTS (SELECT 1 FROM public.builder_transactions WHERE id = _scope_id)
    WHEN 'construction_case' THEN
      EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _scope_id)
    WHEN 'stock_item' THEN EXISTS (SELECT 1 FROM public.builder_stock_items WHERE id = _scope_id)
    ELSE false
  END;
END $fn$;

CREATE OR REPLACE FUNCTION public.builder_scope_org(_scope_type text, _scope_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_org uuid;
BEGIN
  IF _scope_type = 'project' THEN
    SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
    FROM public.builder_projects WHERE id = _scope_id;
  ELSIF _scope_type = 'unit' THEN
    SELECT COALESCE(p.developer_organisation_id, p.builder_organisation_id) INTO v_org
    FROM public.builder_units u JOIN public.builder_projects p ON p.id = u.project_id
    WHERE u.id = _scope_id;
  ELSIF _scope_type = 'transaction' THEN
    SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = _scope_id;
  ELSIF _scope_type = 'construction_case' THEN
    SELECT t.organisation_id INTO v_org
    FROM public.builder_construction_cases c
    JOIN public.builder_transactions t ON t.id = c.transaction_id
    WHERE c.id = _scope_id;
  ELSIF _scope_type = 'stock_item' THEN
    SELECT organisation_id INTO v_org FROM public.builder_stock_items WHERE id = _scope_id;
  END IF;
  RETURN v_org;
END $fn$;

-- ===========================================================================
-- 3. The fan-out itself — idempotent per announcement, safe to call always
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
BEGIN
  -- Locked: the door's opportunistic sweep and pg_cron's scheduled one can
  -- both reach an announcement in the same minute, and notifications alone
  -- are key-guarded — the task is not. The second caller waits, re-reads the
  -- pointer the first one wrote, and creates nothing.
  SELECT a.*, wc.workspace_id INTO v_a
  FROM public.builder_stock_selection_announcements a
  JOIN public.workspace_connections wc ON wc.id = a.connection_id
  WHERE a.id = _announcement_id
  FOR UPDATE OF a;
  IF v_a.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'announcement_not_found');
  END IF;
  -- Withdrawn and already-acknowledged announcements do not GROW a fan-out;
  -- what they already fanned out into is handled by the sweep's own
  -- transitions (a withdrawal cancels the open task, below).
  IF v_a.status NOT IN ('selected', 'progressed', 'completed') THEN
    RETURN jsonb_build_object('skipped', 'status_' || v_a.status);
  END IF;

  SELECT id, address_line, suburb, state, lot_number, external_reference,
         development_name, organisation_id
  INTO v_item
  FROM public.builder_stock_items WHERE id = v_a.stock_item_id;
  IF v_item.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'stock_item_missing');
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
        || E'\n\nReview the property in your Stock List and acknowledge the activation so the agency knows you have it.', 8000),
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

  IF v_task_created OR v_notified > 0 THEN
    PERFORM public.builder_log_activity(
      NULL, 'system', 'builder_stock_activation_fanned_out',
      'stock_selection', v_a.id, v_a.organisation_id, NULL,
      NULL,
      jsonb_build_object(
        'stock_item_id', v_item.id,
        'task_id', v_task_id,
        'task_created', v_task_created,
        'notified', v_notified,
        'agency_name', v_agency_name),
      NULL, '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'task_id', v_task_id, 'task_created', v_task_created,
    'assigned', v_assigned, 'notified', v_notified);
END $fn$;
REVOKE ALL ON FUNCTION public.builder_stock_activation_fanout(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_activation_fanout(uuid) TO service_role;
COMMENT ON FUNCTION public.builder_stock_activation_fanout(uuid) IS
  'Fan one applied selection announcement out into a pending stock_item task (assigned to every active member) and a stock_selection notification per active member. Idempotent per announcement; called by the inbound convergence sweep and by the backfill.';

-- ===========================================================================
-- 4. The convergence sweep learns the agency block, the fan-out and the
--    withdrawal transition. Same function, same guarantees, three additions.
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
          IF v_announcement.status IN ('selected', 'progressed', 'completed') THEN
            -- THE FAN-OUT. Inside the same transaction as the application:
            -- the announcement cannot converge without its task and
            -- notifications, and a replay finds every key already taken.
            PERFORM public.builder_stock_activation_fanout(v_announcement.id);
          ELSIF v_announcement.status = 'withdrawn'
                AND v_announcement.activation_task_id IS NOT NULL THEN
            -- A withdrawal closes the pending work it opened — but never a
            -- task somebody already finished or cancelled themselves.
            UPDATE public.builder_tasks t
               SET status = 'cancelled'
             WHERE t.id = v_announcement.activation_task_id
               AND t.status IN ('open', 'in_progress', 'blocked');
          END IF;
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
-- 5. Outbound stock mirror sync — the marketplace shows what this network
--    actually stands behind
-- ===========================================================================

/**
 * One item's marketplace projection, composed KEY BY KEY.
 *
 * `source_row` is never spread: its columns are whatever a builder typed into
 * a spreadsheet, and the privacy contract throws on key names nobody here
 * chose. The one value the marketplace reads from it (`house_design`) is
 * lifted out by name. `source_detail` on the image is likewise a WHITELIST of
 * the display-rule keys — role, hashes, the eligibility verdict, and the
 * sanitisation clearance/derivative records that let the consumer's own
 * display predicate reach the same answer this network's did.
 */
CREATE OR REPLACE FUNCTION public.builder_network_compose_stock_item_payload(_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_i public.builder_stock_items;
  v_org record;
  v_img public.builder_stock_item_images;
  v_image jsonb := NULL;
BEGIN
  SELECT * INTO v_i FROM public.builder_stock_items WHERE id = _item_id;
  IF v_i.id IS NULL THEN RETURN NULL; END IF;

  SELECT legal_name, trading_name INTO v_org
  FROM public.builder_organisations WHERE id = v_i.organisation_id;

  IF v_i.primary_image_id IS NOT NULL THEN
    SELECT * INTO v_img FROM public.builder_stock_item_images WHERE id = v_i.primary_image_id;
    IF v_img.id IS NOT NULL
       AND v_img.source_stage = 'uploaded_document'
       AND v_img.verification_status = 'source_supplied'
       AND v_img.processing_status = 'ready'
    THEN
      v_image := jsonb_build_object(
        'id', v_img.id,
        'source_stage', v_img.source_stage,
        'verification_status', v_img.verification_status,
        'processing_status', v_img.processing_status,
        'content_type', v_img.content_type,
        'byte_size', v_img.byte_size,
        'position', 0,
        'source_detail', jsonb_strip_nulls(jsonb_build_object(
          'role',                          v_img.source_detail->'role',
          'role_evidence_level',           v_img.source_detail->'role_evidence_level',
          'stored_sha256',                 v_img.source_detail->'stored_sha256',
          'provenance_version',            v_img.source_detail->'provenance_version',
          'marketplace_measured',          v_img.source_detail->'marketplace_measured',
          'marketplace_measured_sha256',   v_img.source_detail->'marketplace_measured_sha256',
          'marketplace_display_eligible',  v_img.source_detail->'marketplace_display_eligible',
          'marketplace_eligibility_state', v_img.source_detail->'marketplace_eligibility_state',
          'marketplace_rejection_reason',  v_img.source_detail->'marketplace_rejection_reason',
          'marketplace_eligibility_version', v_img.source_detail->'marketplace_eligibility_version',
          'sanitized_derivative',          v_img.source_detail->'sanitized_derivative',
          'sanitization_clearance',        v_img.source_detail->'sanitization_clearance')));
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', v_i.id,
    'organisation_id', v_i.organisation_id,
    'upload_id', v_i.upload_id,
    'first_upload_id', v_i.first_upload_id,
    'created_by_builder_user_id', v_i.created_by_builder_user_id,
    'external_reference', v_i.external_reference,
    'development_name', v_i.development_name,
    'project_name', v_i.project_name,
    'address_line', v_i.address_line,
    'suburb', v_i.suburb,
    'state', v_i.state,
    'postcode', v_i.postcode,
    'lot_number', v_i.lot_number,
    'unit_number', v_i.unit_number,
    'bedrooms', v_i.bedrooms,
    'bathrooms', v_i.bathrooms,
    'car_spaces', v_i.car_spaces,
    'property_type', v_i.property_type,
    'land_size_sqm', v_i.land_size_sqm,
    'building_size_sqm', v_i.building_size_sqm,
    'price', v_i.price,
    'price_display', v_i.price_display,
    'availability_status', v_i.availability_status,
    'expected_completion', v_i.expected_completion,
    'description', v_i.description,
    'lifecycle_status', v_i.lifecycle_status,
    'enrichment_status', v_i.enrichment_status,
    'image_work_stage', v_i.image_work_stage,
    'house_design', v_i.source_row->>'house_design',
    'manual_stats', CASE WHEN v_i.manual_stats IS NULL THEN NULL ELSE
      jsonb_strip_nulls(jsonb_build_object(
        'bedrooms',          v_i.manual_stats->'bedrooms',
        'bathrooms',         v_i.manual_stats->'bathrooms',
        'car_spaces',        v_i.manual_stats->'car_spaces',
        'building_size_sqm', v_i.manual_stats->'building_size_sqm',
        'land_size_sqm',     v_i.manual_stats->'land_size_sqm')) END,
    'item_created_at', v_i.created_at,
    'item_updated_at', v_i.updated_at,
    'organisation', jsonb_build_object(
      'id', v_i.organisation_id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name),
    'primary_image', v_image));
END $fn$;
REVOKE ALL ON FUNCTION public.builder_network_compose_stock_item_payload(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_compose_stock_item_payload(uuid)
  TO service_role;

/** Bump one connection's outbound version series and return the new value. */
CREATE OR REPLACE FUNCTION public.builder_network_next_outbound_version(_connection_id uuid)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_version bigint;
BEGIN
  INSERT INTO public.builder_network_stamps(connection_id, side, stamp, source_version)
  VALUES (_connection_id, 'outbound',
          jsonb_build_object('count', 1, 'latest', to_jsonb(now()),
                             'pendingRequests', 0, 'attention', 0),
          1)
  ON CONFLICT (connection_id, side) DO UPDATE
    SET source_version = public.builder_network_stamps.source_version + 1,
        stamp = EXCLUDED.stamp,
        updated_at = now()
  RETURNING source_version INTO v_version;
  RETURN v_version;
END $fn$;
REVOKE ALL ON FUNCTION public.builder_network_next_outbound_version(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_next_outbound_version(uuid) TO service_role;

/** Enqueue one item's upsert for every active connection serving its organisation. */
CREATE OR REPLACE FUNCTION public.builder_network_enqueue_stock_item(_item_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_conn record;
  v_payload jsonb;
  v_version bigint;
  v_count integer := 0;
BEGIN
  v_payload := public.builder_network_compose_stock_item_payload(_item_id);
  IF v_payload IS NULL THEN RETURN 0; END IF;
  FOR v_conn IN
    SELECT c.id
    FROM public.workspace_connections c
    JOIN public.builder_stock_items i ON i.organisation_id = c.builder_organisation_id
    WHERE i.id = _item_id AND c.state = 'active'
  LOOP
    v_version := public.builder_network_next_outbound_version(v_conn.id);
    INSERT INTO public.builder_network_outbox(
      connection_id, event_type, dedupe_key, payload, source_version)
    VALUES (v_conn.id, 'stock.item.upserted',
            'stock.item:' || v_conn.id || ':' || _item_id || ':' || v_version,
            v_payload, v_version)
    ON CONFLICT (dedupe_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.builder_network_enqueue_stock_item(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_enqueue_stock_item(uuid) TO service_role;

/**
 * The complete active catalogue, as one authoritative id list per connection.
 * The consumer archives mirror rows this network no longer lists — the
 * self-healing pass that makes a missed incremental event a one-day defect
 * instead of a permanent lie. Oversized catalogues fail LOUDLY (operational
 * event, nothing enqueued) rather than shipping a truncated list something
 * downstream would treat as complete.
 */
CREATE OR REPLACE FUNCTION public.builder_network_enqueue_stock_reconcile(_connection_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_conn record;
  v_ids uuid[];
  v_payload jsonb;
  v_version bigint;
  v_count integer := 0;
BEGIN
  FOR v_conn IN
    SELECT c.id, c.builder_organisation_id
    FROM public.workspace_connections c
    WHERE c.state = 'active'
      AND (_connection_id IS NULL OR c.id = _connection_id)
      AND c.builder_organisation_id IS NOT NULL
  LOOP
    SELECT COALESCE(array_agg(i.id ORDER BY i.id), '{}') INTO v_ids
    FROM public.builder_stock_items i
    WHERE i.organisation_id = v_conn.builder_organisation_id
      AND i.lifecycle_status = 'active';

    v_payload := jsonb_build_object(
      'organisation_id', v_conn.builder_organisation_id,
      'active_item_ids', to_jsonb(v_ids));

    IF octet_length(v_payload::text) > 200000 THEN
      INSERT INTO public.portal_operational_events(
        event_name, severity, request_id, actor_type, portal, success, metadata)
      VALUES ('builder_network_stock_reconcile_oversized', 'critical',
              v_conn.id::text, 'system', 'builder', false,
              jsonb_build_object('connection_id', v_conn.id,
                                 'active_items', COALESCE(array_length(v_ids, 1), 0)));
      CONTINUE;
    END IF;

    v_version := public.builder_network_next_outbound_version(v_conn.id);
    INSERT INTO public.builder_network_outbox(
      connection_id, event_type, dedupe_key, payload, source_version)
    VALUES (v_conn.id, 'stock.catalog.reconciled',
            'stock.catalog:' || v_conn.id || ':' || v_version,
            v_payload, v_version)
    ON CONFLICT (dedupe_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.builder_network_enqueue_stock_reconcile(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_enqueue_stock_reconcile(uuid) TO service_role;

/** Everything a newly active connection's marketplace needs, enqueued at once. */
CREATE OR REPLACE FUNCTION public.builder_network_backfill_stock_sync(_connection_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_conn record;
  v_item record;
  v_count integer := 0;
BEGIN
  FOR v_conn IN
    SELECT c.id, c.builder_organisation_id
    FROM public.workspace_connections c
    WHERE c.state = 'active'
      AND (_connection_id IS NULL OR c.id = _connection_id)
      AND c.builder_organisation_id IS NOT NULL
  LOOP
    FOR v_item IN
      SELECT i.id FROM public.builder_stock_items i
      WHERE i.organisation_id = v_conn.builder_organisation_id
        AND i.lifecycle_status = 'active'
      ORDER BY i.created_at
    LOOP
      v_count := v_count + public.builder_network_enqueue_stock_item(v_item.id);
    END LOOP;
  END LOOP;
  v_count := v_count + public.builder_network_enqueue_stock_reconcile(_connection_id);
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.builder_network_backfill_stock_sync(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_backfill_stock_sync(uuid) TO service_role;

-- ------------------------------------------------------------- the triggers
-- The item trigger fires on the marketplace PROJECTION changing — never on
-- image-work lease churn (`image_work_claim_until` moves on every claim and
-- says nothing a marketplace card reads).
CREATE OR REPLACE FUNCTION public.builder_network_stock_item_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_status = 'active' THEN
      PERFORM public.builder_network_enqueue_stock_item(NEW.id);
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.lifecycle_status, NEW.availability_status, NEW.address_line, NEW.suburb,
         NEW.state, NEW.postcode, NEW.lot_number, NEW.unit_number, NEW.bedrooms,
         NEW.bathrooms, NEW.car_spaces, NEW.property_type, NEW.land_size_sqm,
         NEW.building_size_sqm, NEW.price, NEW.price_display, NEW.expected_completion,
         NEW.description, NEW.development_name, NEW.project_name, NEW.external_reference,
         NEW.primary_image_id, NEW.manual_stats, NEW.source_row->>'house_design',
         NEW.enrichment_status, NEW.image_work_stage)
     IS DISTINCT FROM
     ROW(OLD.lifecycle_status, OLD.availability_status, OLD.address_line, OLD.suburb,
         OLD.state, OLD.postcode, OLD.lot_number, OLD.unit_number, OLD.bedrooms,
         OLD.bathrooms, OLD.car_spaces, OLD.property_type, OLD.land_size_sqm,
         OLD.building_size_sqm, OLD.price, OLD.price_display, OLD.expected_completion,
         OLD.description, OLD.development_name, OLD.project_name, OLD.external_reference,
         OLD.primary_image_id, OLD.manual_stats, OLD.source_row->>'house_design',
         OLD.enrichment_status, OLD.image_work_stage)
  THEN
    PERFORM public.builder_network_enqueue_stock_item(NEW.id);
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_builder_network_stock_item_sync ON public.builder_stock_items;
CREATE TRIGGER trg_builder_network_stock_item_sync
  AFTER INSERT OR UPDATE ON public.builder_stock_items
  FOR EACH ROW EXECUTE FUNCTION public.builder_network_stock_item_changed();

-- A primary image whose verdict or clearance moves changes what the mirror
-- card may draw, even when the item row itself never moved.
CREATE OR REPLACE FUNCTION public.builder_network_stock_image_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_item uuid;
BEGIN
  FOR v_item IN
    SELECT i.id FROM public.builder_stock_items i WHERE i.primary_image_id = NEW.id
  LOOP
    PERFORM public.builder_network_enqueue_stock_item(v_item);
  END LOOP;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_builder_network_stock_image_sync ON public.builder_stock_item_images;
CREATE TRIGGER trg_builder_network_stock_image_sync
  AFTER UPDATE ON public.builder_stock_item_images
  FOR EACH ROW
  WHEN (OLD.source_detail IS DISTINCT FROM NEW.source_detail
        OR OLD.processing_status IS DISTINCT FROM NEW.processing_status
        OR OLD.storage_path IS DISTINCT FROM NEW.storage_path)
  EXECUTE FUNCTION public.builder_network_stock_image_changed();

-- A connection that becomes ACTIVE gets the whole catalogue without anyone
-- running anything — this is what makes onboarding the NEXT agency a
-- provisioning act rather than an engineering one.
CREATE OR REPLACE FUNCTION public.builder_network_connection_activated()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.state = 'active' AND OLD.state IS DISTINCT FROM 'active' THEN
    PERFORM public.builder_network_backfill_stock_sync(NEW.id);
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_builder_network_connection_activated ON public.workspace_connections;
CREATE TRIGGER trg_builder_network_connection_activated
  AFTER UPDATE ON public.workspace_connections
  FOR EACH ROW EXECUTE FUNCTION public.builder_network_connection_activated();

-- ----------------------------------------------------------------- the cron
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-stock-reconcile-daily') THEN
      PERFORM cron.schedule(
        'builder-network-stock-reconcile-daily',
        '7 18 * * *',
        $job$SELECT public.builder_network_enqueue_stock_reconcile();$job$);
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- 6. Backfill: any announcement that arrived before this code fans out now
-- ===========================================================================
DO $$
DECLARE v_row record;
BEGIN
  FOR v_row IN
    SELECT id FROM public.builder_stock_selection_announcements
    WHERE status IN ('selected', 'progressed', 'completed')
  LOOP
    PERFORM public.builder_stock_activation_fanout(v_row.id);
  END LOOP;
END $$;

-- ===========================================================================
-- 7. Post-migration assertions — shape here, behaviour in the proofs
-- ===========================================================================
DO $$
DECLARE v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='builder_stock_selection_announcements'
      AND column_name IN ('agency_name','agency_contact','activation_task_id')
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: announcements did not gain the agency/fan-out columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'builder_tasks_scope_type_check'
      AND position('stock_item' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: builder_tasks does not accept the stock_item scope';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'builder_notifications_notification_type_check'
      AND position('stock_selection' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: builder_notifications does not accept stock_selection';
  END IF;

  v_def := pg_get_functiondef('public.builder_resolve_scope_permission(uuid,text,uuid,text,text)'::regprocedure);
  IF position('stock_item' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the scope dispatcher never learned stock_item';
  END IF;
  v_def := pg_get_functiondef('public.builder_scope_exists(text,uuid)'::regprocedure);
  IF position('stock_item' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the scope guard would refuse every stock task at the row';
  END IF;

  v_def := pg_get_functiondef('public.builder_network_apply_inbound_events(integer)'::regprocedure);
  IF position('builder_stock_activation_fanout' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the convergence sweep does not fan out';
  END IF;
  IF position('agency_contact' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the convergence sweep does not store the agency disclosure';
  END IF;

  v_def := pg_get_functiondef('public.builder_network_compose_stock_item_payload(uuid)'::regprocedure);
  IF position($src$'source_row', v_i.source_row$src$ IN v_def) > 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the sync payload spreads source_row';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_builder_network_stock_item_sync'
      AND tgrelid = 'public.builder_stock_items'::regclass
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: items do not enqueue their own sync';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_builder_network_connection_activated'
      AND tgrelid = 'public.workspace_connections'::regclass
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a new connection would not backfill';
  END IF;

  -- The fan-out refuses nonsense rather than inventing work.
  IF (public.builder_stock_activation_fanout(gen_random_uuid())->>'skipped') <> 'announcement_not_found' THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the fan-out invented work for a missing announcement';
  END IF;

  RAISE NOTICE 'stock activation fan-out and outbound sync installed';
END $$;
