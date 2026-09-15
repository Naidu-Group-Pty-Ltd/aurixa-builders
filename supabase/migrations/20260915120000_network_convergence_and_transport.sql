-- ============================================================================
-- Network convergence and the transport handshake's missing half.
--
-- The sync plumbing shipped in 20260914210000 lands envelopes and delivers
-- envelopes; nothing yet turned an envelope into a domain fact, and the
-- per-connection HMAC secret minted at acceptance never reached the one
-- other machine that must hold it. This migration supplies both, as
-- DATABASE commands, because each is a multi-write that must commit whole:
--
--  1. THE INBOUND CONSUMER. "A webhook is not delivery; a sweep converges
--     the mirror" — builder_network_apply_inbound_events() is that sweep.
--     It processes unprocessed ledger rows into
--     builder_stock_selection_announcements idempotently: dedupe_key made
--     the LANDING idempotent, the (connection_id, remote_selection_ref)
--     unique key plus a monotonic source_version guard make the APPLY
--     idempotent and replayable — re-running the sweep over already-applied
--     ledger rows changes nothing, and an out-of-order replay cannot wind an
--     announcement backwards.
--
--     The stock event contract (the clone's Phase 3 producer composes to
--     this; the envelope shape — event_type / dedupe_key / payload /
--     source_version — is the one both inbound doors already parse):
--
--       event_type  stock.selection.announced   (a workspace made a selection)
--                   stock.selection.updated     (its status moved on)
--       payload     remote_selection_ref  uuid the WORKSPACE minted (opaque)
--                   stock_item_id         the network's own stock item id
--                   status                selected|progressed|completed|withdrawn
--                   remote_client_label   optional, what the workspace chose
--                                         to show; never a client identity
--       source_version  monotonic per selection ref; the guard column
--
--     The organisation is DERIVED from the connection row, never read from
--     the payload — a payload cannot claim another builder's property, and a
--     stock_item that does not belong to the connection's organisation is
--     refused by name.
--
--  2. THE BUILDER'S ACKNOWLEDGEMENT, TRANSACTIONALLY OUTBOUND.
--     builder_stock_acknowledge_announcement() stamps the announcement AND
--     queues the stock.selection.acknowledged outbox event in one
--     transaction — the domain write cannot commit without the event nor
--     the event without the write. The dedupe_key is derived from the
--     selection ref, so a retried call after a lost response cannot queue a
--     second delivery.
--
--  3. THE TRANSPORT COURIER COLUMN. workspace_connections gains
--     hmac_provisioned_at: the acceptance-minted symmetric secret is handed
--     out EXACTLY ONCE, over the Mission Control federation door
--     (builder-network-admin provision_transport), for MC — which holds the
--     clone's service credentials and never this project's — to install in
--     the clone's builder_network_connections row. This resolves the
--     documentation conflict in favour of what both shipped codebases
--     already do: the plan's rev-2 line "secrets minted by the clone" is
--     superseded by the network-side minting the acceptance path ships and
--     by the prime's clone-side mirror migration (20261121000000), whose own
--     header says the secret "is written into outbound_hmac_secret by
--     Mission Control's provisioning machinery".
--
--  4. THE DRIVERS. The prime's WP-12 signed-invocation pair
--     (cron_signed_internal_headers / cron_invoke_signed_function, from
--     prime 20260723184115) is ported verbatim: the baseline's own
--     settle_builder_stock_marketplace_eligibility_tick() has called
--     cron_invoke_signed_function() since the squash without any definition
--     existing here — the settler could never be driven. With the pair in
--     place, builder-network-outbox-worker is scheduled the way the prime
--     schedules cross-portal-outbox-worker, and the inbound sweep — pure
--     SQL — is scheduled directly. Both schedules are pg_cron-guarded, so
--     the CI replay (no pg_cron) and a hosted project behave identically.
-- ============================================================================

-- ===========================================================================
-- 1. Schema: the guard column, the apply bookkeeping, the courier stamp
-- ===========================================================================
ALTER TABLE public.builder_stock_selection_announcements
  ADD COLUMN IF NOT EXISTS source_version bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.builder_stock_selection_announcements.source_version IS
  'The workspace''s monotonic version for this selection ref, as carried by the inbound event. The apply sweep refuses to move a row backwards: an out-of-order redelivery is a no-op.';

ALTER TABLE public.builder_network_inbound_events
  ADD COLUMN IF NOT EXISTS apply_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS apply_error text;

COMMENT ON COLUMN public.builder_network_inbound_events.apply_error IS
  'Why the apply sweep could not (or will not) converge this event. Set together with processed_at for terminal refusals — clearing processed_at replays the event after a fix ships; NULL on every applied event.';

ALTER TABLE public.workspace_connections
  ADD COLUMN IF NOT EXISTS hmac_provisioned_at timestamptz;

COMMENT ON COLUMN public.workspace_connections.hmac_provisioned_at IS
  'When the acceptance-minted outbound_hmac_secret was handed to Mission Control''s provisioning machinery (builder-network-admin provision_transport) for installation in the clone. The secret is returned exactly once; after this is set, only rotate_transport can produce a new one. Revocation clears the secret itself.';

-- ===========================================================================
-- 2. The inbound apply sweep
-- ===========================================================================

-- A terminal refusal: the ledger row keeps the reason, processed_at makes
-- the sweep move on, and the operational event makes it visible. Clearing
-- processed_at is the documented replay lever once a fix ships.
CREATE OR REPLACE FUNCTION public.builder_network_mark_inbound_refused(
  _event_id uuid,
  _connection_id uuid,
  _event_type text,
  _reason text,
  _severity text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  UPDATE public.builder_network_inbound_events
     SET processed_at = now(), apply_error = _reason,
         apply_attempts = apply_attempts + 1
   WHERE id = _event_id;
  INSERT INTO public.portal_operational_events(
    event_name, severity, request_id, actor_type, portal, success, metadata)
  VALUES ('builder_network_inbound_apply_refused', _severity, _event_id::text,
          'system', 'builder', false,
          jsonb_build_object('connection_id', _connection_id,
                             'event_type', _event_type, 'reason', _reason));
END $fn$;

REVOKE ALL ON FUNCTION public.builder_network_mark_inbound_refused(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_mark_inbound_refused(uuid, uuid, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.builder_network_apply_inbound_events(
  _limit integer DEFAULT 50)
RETURNS TABLE (applied integer, refused integer, deferred integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_event record;
  v_connection record;
  v_payload jsonb;
  v_ref uuid;
  v_item uuid;
  v_status text;
  v_label text;
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
          remote_selection_ref, remote_client_label, status, source_version)
        VALUES (v_connection.id, v_item, v_connection.builder_organisation_id,
                v_ref, v_label, v_status, COALESCE(v_event.source_version, 0))
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
              source_version = EXCLUDED.source_version
          WHERE EXCLUDED.source_version
                  >= public.builder_stock_selection_announcements.source_version;

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

COMMENT ON FUNCTION public.builder_network_apply_inbound_events(integer) IS
  'The inbound consumer sweep: converges unprocessed builder_network_inbound_events into domain tables (stock selection announcements), idempotent by (connection_id, remote_selection_ref) with a monotonic source_version guard. Safe to re-run at any time; driven by pg_cron and opportunistically after each landing.';

-- ===========================================================================
-- 3. The acknowledgement, with its outbox event, in one transaction
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_stock_acknowledge_announcement(
  _announcement_id uuid,
  _organisation_id uuid,
  _builder_user_id uuid)
RETURNS SETOF public.builder_stock_selection_announcements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_row public.builder_stock_selection_announcements;
  v_version bigint;
BEGIN
  -- One winner, organisation-scoped: a forged id from another organisation
  -- matches no row and reads as not-found, never forbidden.
  UPDATE public.builder_stock_selection_announcements a
     SET status = 'builder_acknowledged',
         acknowledged_at = now(),
         acknowledged_by_builder_user_id = _builder_user_id
   WHERE a.id = _announcement_id
     AND a.organisation_id = _organisation_id
     AND a.status = 'selected'
  RETURNING a.* INTO v_row;

  IF v_row.id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.builder_stock_selection_announcements a
      WHERE a.id = _announcement_id AND a.organisation_id = _organisation_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE';
    END IF;
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ANNOUNCEMENT_NOT_FOUND';
  END IF;

  -- The outbound version is the connection's outbound stamp counter — one
  -- monotonic series per connection, bumped with the write it describes.
  INSERT INTO public.builder_network_stamps(connection_id, side, stamp, source_version)
  VALUES (v_row.connection_id, 'outbound',
          jsonb_build_object('count', 1, 'latest', to_jsonb(now()),
                             'pendingRequests', 0, 'attention', 0),
          1)
  ON CONFLICT (connection_id, side) DO UPDATE
    SET source_version = public.builder_network_stamps.source_version + 1,
        stamp = EXCLUDED.stamp,
        updated_at = now()
  RETURNING source_version INTO v_version;

  -- Idempotent by construction: the acknowledgement of one selection ref is
  -- one fact, so its dedupe_key is derived, and a retry lands ON CONFLICT.
  -- Composed to the privacy contract's vocabulary — the worker re-gates
  -- before the wire.
  INSERT INTO public.builder_network_outbox(
    connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (
    v_row.connection_id,
    'stock.selection.acknowledged',
    'stock.selection.acknowledged:' || v_row.connection_id || ':' || v_row.remote_selection_ref,
    jsonb_build_object(
      'remote_selection_ref', v_row.remote_selection_ref,
      'stock_item_id', v_row.stock_item_id,
      'status', 'builder_acknowledged',
      'acknowledged_at', v_row.acknowledged_at),
    v_version)
  ON CONFLICT (dedupe_key) DO NOTHING;

  -- The activity entry rides the same transaction: an acknowledgement that
  -- rolled back logs nothing.
  PERFORM public.builder_log_activity(
    _builder_user_id, 'builder_user', 'builder_stock_selection_acknowledged',
    'stock_selection', v_row.id, _organisation_id, _builder_user_id,
    NULL,
    jsonb_build_object('remote_selection_ref', v_row.remote_selection_ref,
                       'connection_id', v_row.connection_id),
    NULL, '{}'::jsonb);

  RETURN NEXT v_row;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid) IS
  'Stamp one selected announcement builder_acknowledged and queue the stock.selection.acknowledged outbox event in the same transaction — the domain write and the outbound event commit together or not at all.';

-- ===========================================================================
-- 4. WP-12 signed invocation, ported (prime 20260723184115)
--
-- The baseline's settlement tick has called cron_invoke_signed_function()
-- since the squash; the definition never travelled. Verbatim port, matching
-- supabase/functions/_shared/auth_v2.ts::verifyInternal on this project.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.cron_signed_internal_headers(
  method        text,
  function_name text,
  body          jsonb DEFAULT '{}'::jsonb,
  caller        text  DEFAULT 'pg_cron',
  extra         jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_secret_v1 text;
  v_secret_v2 text;
  v_key_id    text;
  v_secret    text;
  v_anon      text;
  v_srk       text;
  v_ts        text;
  v_nonce     text;
  v_body_txt  text;
  v_body_hash text;
  v_path      text;
  v_message   text;
  v_signature text;
  v_gateway_auth text;
  v_apikey    text;
BEGIN
  SELECT decrypted_secret INTO v_secret_v1
    FROM vault.decrypted_secrets WHERE name = 'internal_edge_secret' LIMIT 1;
  SELECT decrypted_secret INTO v_secret_v2
    FROM vault.decrypted_secrets WHERE name = 'internal_edge_secret_v2' LIMIT 1;

  IF COALESCE(length(v_secret_v2), 0) >= 16 THEN
    v_key_id := 'v2';
    v_secret := v_secret_v2;
  ELSIF COALESCE(length(v_secret_v1), 0) >= 16 THEN
    v_key_id := 'v1';
    v_secret := v_secret_v1;
  ELSE
    RAISE EXCEPTION 'cron_signed_internal_headers: internal_edge_secret not configured in vault';
  END IF;

  v_path      := '/functions/v1/' || function_name;
  v_ts        := extract(epoch FROM clock_timestamp())::bigint::text;
  v_nonce     := encode(extensions.gen_random_bytes(16), 'hex');
  v_body_txt  := COALESCE(body::text, '{}');
  v_body_hash := encode(extensions.digest(v_body_txt::bytea, 'sha256'), 'hex');

  v_message := upper(method)
    || E'\n' || v_path
    || E'\n' || v_ts
    || E'\n' || v_nonce
    || E'\n' || caller
    || E'\n' || v_key_id
    || E'\n' || v_body_hash;

  v_signature := encode(extensions.hmac(v_message::bytea, v_secret::bytea, 'sha256'), 'hex');

  -- Gateway auth: prefer anon so the service_role key isn't sprayed across the wire.
  SELECT decrypted_secret INTO v_anon
    FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key' LIMIT 1;

  IF COALESCE(length(v_anon), 0) >= 16 THEN
    v_apikey       := v_anon;
    v_gateway_auth := 'Bearer ' || v_anon;
  ELSE
    SELECT decrypted_secret INTO v_srk
      FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1;
    IF COALESCE(length(v_srk), 0) < 16 THEN
      RAISE EXCEPTION 'cron_signed_internal_headers: neither supabase_anon_key nor supabase_service_role_key is configured in vault';
    END IF;
    v_apikey       := v_srk;
    v_gateway_auth := 'Bearer ' || v_srk;
  END IF;

  RETURN jsonb_build_object(
    'Content-Type',         'application/json',
    'apikey',               v_apikey,
    'Authorization',        v_gateway_auth,
    'X-Internal-Timestamp', v_ts,
    'X-Internal-Nonce',     v_nonce,
    'X-Internal-Caller',    caller,
    'X-Internal-Key-Id',    v_key_id,
    'X-Internal-Signature', v_signature
  ) || COALESCE(extra, '{}'::jsonb);
END $fn$;

REVOKE ALL ON FUNCTION public.cron_signed_internal_headers(text, text, jsonb, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_signed_internal_headers(text, text, jsonb, text, jsonb)
  TO postgres, service_role;

COMMENT ON FUNCTION public.cron_signed_internal_headers(text, text, jsonb, text, jsonb) IS
  'WP-12 (ported from the prime): builds the signed X-Internal-* header envelope matching verifyInternal in supabase/functions/_shared/auth_v2.ts. Restricted to postgres/service_role.';

CREATE OR REPLACE FUNCTION public.cron_invoke_signed_function(
  function_name text,
  body          jsonb DEFAULT '{}'::jsonb,
  caller        text  DEFAULT 'pg_cron')
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_url     text;
  v_headers jsonb;
  v_req_id  bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
  IF v_url IS NULL OR length(v_url) = 0 THEN
    RAISE EXCEPTION 'cron_invoke_signed_function: supabase_url not configured in vault';
  END IF;

  v_headers := public.cron_signed_internal_headers('POST', function_name, body, caller);

  SELECT net.http_post(
    url     := rtrim(v_url, '/') || '/functions/v1/' || function_name,
    headers := v_headers,
    body    := body
  ) INTO v_req_id;

  RETURN v_req_id;
END $fn$;

REVOKE ALL ON FUNCTION public.cron_invoke_signed_function(text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_invoke_signed_function(text, jsonb, text)
  TO postgres, service_role;

COMMENT ON FUNCTION public.cron_invoke_signed_function(text, jsonb, text) IS
  'WP-12 (ported from the prime): schedules a signed pg_net POST to an edge function. Requires vault secrets supabase_url, internal_edge_secret (or _v2), and supabase_anon_key or supabase_service_role_key.';

-- ===========================================================================
-- 5. The drivers, pg_cron-guarded
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- The inbound sweep is pure SQL: pg_cron runs it directly, no HTTP, no
    -- secrets. A sweep with nothing to claim is one cheap indexed read.
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-inbound-apply-1min') THEN
      PERFORM cron.schedule(
        'builder-network-inbound-apply-1min',
        '* * * * *',
        $job$SELECT public.builder_network_apply_inbound_events(50);$job$
      );
    END IF;

    -- The outbox worker delivers over HTTP and authenticates on the signed
    -- internal envelope, exactly as the prime drives its cross-portal worker.
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-outbox-worker-1min') THEN
      PERFORM cron.schedule(
        'builder-network-outbox-worker-1min',
        '* * * * *',
        $job$SELECT public.cron_invoke_signed_function('builder-network-outbox-worker', '{}'::jsonb, 'pg_cron');$job$
      );
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- 6. Post-migration assertions
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='builder_stock_selection_announcements'
      AND column_name='source_version'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: announcements have no source_version guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='workspace_connections'
      AND column_name='hmac_provisioned_at'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: workspace_connections has no hmac_provisioned_at';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='builder_network_apply_inbound_events'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the inbound apply sweep is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='builder_stock_acknowledge_announcement'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the transactional acknowledgement is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='cron_invoke_signed_function'
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: cron_invoke_signed_function is still undefined';
  END IF;
  RAISE NOTICE 'network convergence installed: sweep, transactional acknowledgement, WP-12 drivers';
END $$;
