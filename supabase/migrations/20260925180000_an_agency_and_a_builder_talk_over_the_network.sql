-- ============================================================================
-- An agency and a builder talk about an activated property, over the signed
-- network. The Builders Network's half.
--
-- The Command Centre's half is `npc-property-dashbord`'s
-- `20261221120000_an_agency_and_a_builder_talk_over_the_network.sql`; the two
-- share one contract, written out in `docs/builder-portal/61-…`.
--
-- WHAT A CONVERSATION IS. One per (connection, property), and its id is
-- DERIVED — md5('agency.conversation:' || network connection id || ':' ||
-- stock item id) — so both ends compute the same id without asking each
-- other, repeated "start" attempts converge, and a payload naming a different
-- conversation is refused rather than trusted. It exists only while the
-- property is activated on that connection.
--
-- WHAT A MESSAGE IS. Written on one side with a globally unique id, and
-- carried to the other as `agency.message.posted`. The sender's retry of the
-- same send (a lost response, a double click) is the same row, because the
-- browser's `client_message_id` is unique per sender. The receiver stores the
-- message under the SENDER's id, so a redelivery converges to one row.
--
-- DELIVERED MEANS ACCEPTED. The door's 200 only says the envelope landed; the
-- receiver's sweep then applies it and answers with `agency.message.receipt`
-- (accepted, or refused with a reason). Only an accepted receipt marks a
-- message delivered. A refusal, or an outbox row that dead-letters, marks it
-- failed; a retry re-sends it under a new generation, which the receiver
-- answers again — applying it only once.
--
-- ITS OWN LANE. Both main sweeps refuse an event type they do not know, and
-- terminally. A BEFORE INSERT trigger therefore marks message events consumed
-- for the main sweep the moment they land (`processed_at`), and this sweep
-- keeps its own stamp (`message_applied_at`) — the media sweep's precedent.
-- The main sweep is not changed.
--
-- NOTHING ELSE CROSSES. The payload is composed key by key: ids, the body the
-- person typed, their display name and the server's timestamp. No user id,
-- no client, no note. The outbox worker and the receiving door both assert the
-- network privacy contract on top of this.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.builder_agency_conversations (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.workspace_connections(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CONSTRAINT builder_agency_conversations_pair UNIQUE (connection_id, stock_item_id)
);

CREATE INDEX IF NOT EXISTS builder_agency_conversations_org_idx
  ON public.builder_agency_conversations (organisation_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.builder_agency_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL
    REFERENCES public.builder_agency_conversations(id) ON DELETE CASCADE,
  -- Who wrote it. Outbound messages are the builder's; inbound, the agency's.
  side text NOT NULL CHECK (side IN ('builder', 'command_centre')),
  sender_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  client_message_id uuid,
  sender_display_name text NOT NULL
    CHECK (length(btrim(sender_display_name)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  -- The writing side's server clock: the order both ends sort by, with the id
  -- as the tie-breaker. Never the browser's.
  sent_at timestamptz NOT NULL,
  received_at timestamptz,
  delivery_state text CHECK (delivery_state IN ('queued', 'delivered', 'failed')),
  delivery_generation integer NOT NULL DEFAULT 1 CHECK (delivery_generation >= 1),
  delivered_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A delivery state belongs to what this side sent, and only to that.
  CONSTRAINT builder_agency_messages_state_is_outbound
    CHECK ((side = 'builder') = (delivery_state IS NOT NULL)),
  CONSTRAINT builder_agency_messages_delivered_stamp
    CHECK (delivery_state IS DISTINCT FROM 'delivered' OR delivered_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_agency_messages_client_key
  ON public.builder_agency_messages (sender_builder_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_agency_messages_thread_idx
  ON public.builder_agency_messages (conversation_id, sent_at, id);

ALTER TABLE public.builder_agency_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_agency_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_agency_conversations, public.builder_agency_messages
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_agency_conversations, public.builder_agency_messages TO service_role;

CREATE SEQUENCE IF NOT EXISTS public.builder_agency_message_version_seq;
REVOKE ALL ON SEQUENCE public.builder_agency_message_version_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.builder_agency_message_version_seq TO service_role;

-- The message lane's own stamp on the shared inbox.
ALTER TABLE public.builder_network_inbound_events
  ADD COLUMN IF NOT EXISTS message_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS message_apply_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS message_apply_error text;

CREATE INDEX IF NOT EXISTS builder_network_inbound_events_message_pending_idx
  ON public.builder_network_inbound_events (received_at, id)
  WHERE message_applied_at IS NULL
    AND event_type IN ('agency.message.posted', 'agency.message.receipt');

-- ---------------------------------------------------------------------------
-- 2. The one derivation both ends share.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_agency_conversation_id(
  _network_connection_id uuid, _stock_item_id uuid)
RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT
AS $fn$
  SELECT md5('agency.conversation:' || _network_connection_id::text || ':' || _stock_item_id::text)::uuid
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_message_payload(_message_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'schema_version', 1,
    'conversation_id', m.conversation_id,
    'message_id', m.id,
    'stock_item_id', c.stock_item_id,
    'body', m.body,
    'sender_display_name', m.sender_display_name,
    'sent_at', to_char(m.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'generation', m.delivery_generation)
  FROM public.builder_agency_messages m
  JOIN public.builder_agency_conversations c ON c.id = m.conversation_id
  WHERE m.id = _message_id
$fn$;

-- Ask the outbox worker to run now rather than at the next minute. Never
-- worth failing the write it follows.
CREATE OR REPLACE FUNCTION public.builder_agency_kick_outbox()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  BEGIN
    PERFORM public.cron_invoke_signed_function('builder-network-outbox-worker', '{}'::jsonb, 'agency_message');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_enqueue(
  _connection_id uuid, _event_type text, _dedupe_key text, _payload jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $fn$
  INSERT INTO public.builder_network_outbox(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (_connection_id, _event_type, _dedupe_key, _payload,
          nextval('public.builder_agency_message_version_seq'))
  ON CONFLICT (dedupe_key) DO NOTHING
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_note(
  _event_name text, _severity text, _event_id uuid, _metadata jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  BEGIN
    INSERT INTO public.portal_operational_events(
      event_name, severity, request_id, actor_type, portal, success, metadata)
    VALUES (_event_name, _severity, _event_id::text, 'system', 'builder', false,
            COALESCE(_metadata, '{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '% for inbound event % could not be recorded: %', _event_name, _event_id, SQLERRM;
  END;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Writing a message (the builder's side).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_agency_post_message(
  _organisation_id uuid,
  _connection_id uuid,
  _stock_item_id uuid,
  _sender_builder_user_id uuid,
  _client_message_id uuid,
  _body text)
RETURNS SETOF public.builder_agency_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_body text := btrim(COALESCE(_body, ''));
  v_conversation uuid;
  v_existing public.builder_agency_messages%ROWTYPE;
  v_name text;
  v_id uuid;
BEGIN
  IF _client_message_id IS NULL OR length(v_body) = 0 OR length(v_body) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_INVALID';
  END IF;

  v_conversation := public.builder_agency_conversation_id(_connection_id, _stock_item_id);
  -- The same send again (a lost response, a double click) is the same row, and
  -- it is answered FIRST: a repeat of a message this sender already made is not
  -- a new write, so a relationship that closed since does not turn it into a
  -- failure the sender would read as "not sent". Nothing new is written here.
  -- The key is bound to what was sent: the same key with other text is not
  -- a repeat, and answering it with the original would lose the new text.
  SELECT * INTO v_existing FROM public.builder_agency_messages m
   WHERE m.sender_builder_user_id = _sender_builder_user_id
     AND m.client_message_id = _client_message_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.conversation_id <> v_conversation OR v_existing.body <> v_body
       OR NOT EXISTS (SELECT 1 FROM public.builder_agency_conversations c
                       WHERE c.id = v_existing.conversation_id AND c.organisation_id = _organisation_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_ID_REUSED';
    END IF;
    RETURN NEXT v_existing;
    RETURN;
  END IF;

  -- The relationship, re-read now from rows the caller cannot name for itself,
  -- and held until this message is written: a revocation or a withdrawal
  -- that lands now either commits first (and is seen) or waits for it.
  PERFORM 1 FROM public.workspace_connections c WHERE c.id = _connection_id FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_connections c
     WHERE c.id = _connection_id AND c.builder_organisation_id = _organisation_id
       AND c.state = 'active')
     OR NOT EXISTS (
    SELECT 1 FROM public.builder_stock_items i
     WHERE i.id = _stock_item_id AND i.organisation_id = _organisation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_FOUND';
  END IF;


  PERFORM 1 FROM public.builder_stock_selection_announcements a
   WHERE a.connection_id = _connection_id AND a.stock_item_id = _stock_item_id
     AND a.organisation_id = _organisation_id AND a.status <> 'withdrawn'
   FOR SHARE OF a;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = _connection_id AND a.stock_item_id = _stock_item_id
       AND a.organisation_id = _organisation_id AND a.status <> 'withdrawn') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_OPEN';
  END IF;

  SELECT nullif(btrim(u.name), '') INTO v_name
    FROM public.builder_portal_users u
    JOIN public.builder_organisation_memberships m
      ON m.builder_user_id = u.id AND m.organisation_id = _organisation_id AND m.status = 'active'
   WHERE u.id = _sender_builder_user_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_SENDER_NOT_A_MEMBER';
  END IF;

  INSERT INTO public.builder_agency_conversations(id, connection_id, stock_item_id, organisation_id)
  VALUES (v_conversation, _connection_id, _stock_item_id, _organisation_id)
  ON CONFLICT (id) DO NOTHING;

  v_id := gen_random_uuid();
  BEGIN
    INSERT INTO public.builder_agency_messages(
      id, conversation_id, side, sender_builder_user_id, client_message_id,
      sender_display_name, body, sent_at, delivery_state, delivery_generation)
    VALUES (v_id, v_conversation, 'builder', _sender_builder_user_id, _client_message_id,
            left(v_name, 200), v_body, clock_timestamp(), 'queued', 1);
  EXCEPTION WHEN unique_violation THEN
    -- Two overlapping sends of one message (a double click, a retried request):
    -- the other committed first. Its row IS this send; answer with it.
    SELECT * INTO v_existing FROM public.builder_agency_messages m
     WHERE m.sender_builder_user_id = _sender_builder_user_id
       AND m.client_message_id = _client_message_id;
    IF v_existing.id IS NULL THEN
      RAISE;
    END IF;
    IF v_existing.conversation_id <> v_conversation OR v_existing.body <> v_body THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_ID_REUSED';
    END IF;
    RETURN NEXT v_existing;
    RETURN;
  END;

  UPDATE public.builder_agency_conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'), now())
   WHERE id = v_conversation;

  PERFORM public.builder_agency_enqueue(_connection_id, 'agency.message.posted',
    'agency.message:' || v_id || ':1', public.builder_agency_message_payload(v_id));
  PERFORM public.builder_agency_kick_outbox();

  RETURN QUERY SELECT * FROM public.builder_agency_messages WHERE id = v_id;
END
$fn$;

-- A failed message, sent again by the person who wrote it, under a new
-- generation. The receiver applies it once whatever the generation.
CREATE OR REPLACE FUNCTION public.builder_agency_retry_message(
  _organisation_id uuid, _message_id uuid, _sender_builder_user_id uuid)
RETURNS SETOF public.builder_agency_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_message public.builder_agency_messages%ROWTYPE;
  v_conversation public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT m.* INTO v_message
    FROM public.builder_agency_messages m
    JOIN public.builder_agency_conversations c ON c.id = m.conversation_id
   WHERE m.id = _message_id AND c.organisation_id = _organisation_id
     AND m.side = 'builder' AND m.sender_builder_user_id = _sender_builder_user_id
   FOR UPDATE OF m;
  IF v_message.id IS NULL OR v_message.delivery_state <> 'failed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_NOT_RETRYABLE';
  END IF;
  SELECT * INTO v_conversation FROM public.builder_agency_conversations WHERE id = v_message.conversation_id;
  -- Sending again is writing: the conversation must still be open, exactly
  -- as for a new message, and what makes it open is held until it is sent.
  PERFORM 1 FROM public.workspace_connections c WHERE c.id = v_conversation.connection_id FOR SHARE;
  PERFORM 1 FROM public.builder_stock_selection_announcements a
   WHERE a.connection_id = v_conversation.connection_id
     AND a.stock_item_id = v_conversation.stock_item_id
     AND a.organisation_id = _organisation_id AND a.status <> 'withdrawn'
   FOR SHARE OF a;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_connections c
     WHERE c.id = v_conversation.connection_id AND c.state = 'active'
       AND c.builder_organisation_id = _organisation_id)
     OR NOT EXISTS (
    SELECT 1 FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = v_conversation.connection_id
       AND a.stock_item_id = v_conversation.stock_item_id
       AND a.organisation_id = _organisation_id AND a.status <> 'withdrawn') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_OPEN';
  END IF;

  UPDATE public.builder_agency_messages
     SET delivery_state = 'queued', delivery_generation = delivery_generation + 1,
         failure_reason = NULL
   WHERE id = _message_id;
  PERFORM public.builder_agency_enqueue(v_conversation.connection_id, 'agency.message.posted',
    'agency.message:' || _message_id || ':' || (v_message.delivery_generation + 1),
    public.builder_agency_message_payload(_message_id));
  PERFORM public.builder_agency_kick_outbox();

  RETURN QUERY SELECT * FROM public.builder_agency_messages WHERE id = _message_id;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Receiving (the agency's messages, and the receipts for ours).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_agency_apply_message_event(_event_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_event public.builder_network_inbound_events%ROWTYPE;
  v_connection record;
  v_payload jsonb;
  v_message_id uuid;
  v_conversation_id uuid;
  v_item uuid;
  v_generation integer;
  v_body text;
  v_name text;
  v_sent timestamptz;
  v_reason text;
  v_existing public.builder_agency_messages%ROWTYPE;
  v_outcome text;
  v_inserted integer := 0;
BEGIN
  SELECT * INTO v_event FROM public.builder_network_inbound_events WHERE id = _event_id;
  v_payload := COALESCE(v_event.payload, '{}'::jsonb);

  SELECT c.id, c.state, c.builder_organisation_id INTO v_connection
    FROM public.workspace_connections c WHERE c.id = v_event.connection_id
   -- Held until the event is applied: a revocation that lands now waits,
   -- rather than committing beside a message stored under the old answer.
   FOR SHARE;
  IF v_connection.id IS NULL THEN
    RETURN 'refused:connection_not_active';
  END IF;

  -- Exactly the contract's keys: the door refuses anything else before it is
  -- stored, and this is the same rule where the event is applied.
  IF jsonb_typeof(v_payload) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_payload) = 'object' THEN v_payload ELSE '{}'::jsonb END) k
     WHERE k <> ALL (CASE WHEN v_event.event_type = 'agency.message.posted'
                          THEN ARRAY['body', 'conversation_id', 'generation', 'message_id', 'schema_version',
                                     'sender_display_name', 'sent_at', 'stock_item_id']
                          ELSE ARRAY['conversation_id', 'generation', 'message_id', 'outcome', 'reason',
                                     'schema_version'] END)) THEN
    RETURN 'refused:invalid_payload';
  END IF;
  -- And each value is the contract's JSON type: `->>` would turn an object or
  -- a number into text that passes every later check.
  IF EXISTS (
    SELECT 1 FROM jsonb_each(v_payload) kv
     WHERE NOT (kv.key = 'reason' AND jsonb_typeof(kv.value) = 'null')
       AND jsonb_typeof(kv.value) <> CASE WHEN kv.key IN ('generation', 'schema_version') THEN 'number' ELSE 'string' END) THEN
    RETURN 'refused:invalid_payload';
  END IF;

  BEGIN
    v_message_id := (v_payload->>'message_id')::uuid;
    v_conversation_id := (v_payload->>'conversation_id')::uuid;
    v_generation := (v_payload->>'generation')::integer;
  EXCEPTION WHEN others THEN
    v_message_id := NULL;
  END;
  IF v_message_id IS NULL OR v_conversation_id IS NULL OR v_generation IS NULL OR v_generation < 1
     OR COALESCE((v_payload->>'schema_version')::text, '') <> '1' THEN
    RETURN 'refused:invalid_payload';
  END IF;

  -- ── A receipt for something this side sent ─────────────────────────────
  IF v_event.event_type = 'agency.message.receipt' THEN
    v_outcome := v_payload->>'outcome';
    IF v_outcome IS NULL OR v_outcome NOT IN ('accepted', 'refused') THEN
      RETURN 'refused:invalid_payload';
    END IF;
    SELECT m.* INTO v_existing
      FROM public.builder_agency_messages m
      JOIN public.builder_agency_conversations c ON c.id = m.conversation_id
     WHERE m.id = v_message_id AND m.side = 'builder'
       AND c.id = v_conversation_id AND c.connection_id = v_connection.id
     FOR UPDATE OF m;
    IF v_existing.id IS NULL THEN
      RETURN 'refused:unknown_message';
    END IF;
    -- A receipt for an earlier generation says nothing about the current one.
    IF v_generation <> v_existing.delivery_generation OR v_existing.delivery_state = 'delivered' THEN
      RETURN 'applied';
    END IF;
    IF v_outcome = 'accepted' THEN
      UPDATE public.builder_agency_messages
         SET delivery_state = 'delivered', delivered_at = now(), failure_reason = NULL
       WHERE id = v_message_id;
    ELSE
      UPDATE public.builder_agency_messages
         SET delivery_state = 'failed',
             failure_reason = 'refused:' || left(COALESCE(v_payload->>'reason', 'unspecified'), 60)
       WHERE id = v_message_id;
    END IF;
    RETURN 'applied';
  END IF;

  -- ── The agency's message ──────────────────────────────────────────────
  -- A receipt above settles a message this side already sent and carries no
  -- content, so one that landed before a revocation still applies. New
  -- content needs the relationship to be live when it is stored.
  IF v_connection.state <> 'active' THEN
    RETURN 'refused:connection_not_active';
  END IF;
  BEGIN
    v_item := (v_payload->>'stock_item_id')::uuid;
    v_sent := (v_payload->>'sent_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_item := NULL;
  END;
  v_body := btrim(COALESCE(v_payload->>'body', ''));
  v_name := btrim(COALESCE(v_payload->>'sender_display_name', ''));

  IF v_item IS NOT NULL THEN
    -- The activation is held too, so a withdrawal cannot commit between the
    -- check below and the insert.
    PERFORM 1 FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = v_connection.id AND a.stock_item_id = v_item
       AND a.status <> 'withdrawn'
     FOR SHARE OF a;
  END IF;
  -- The time is a canonical RFC 3339 instant: a word PostgreSQL resolves in
  -- context ('now', 'today', 'epoch') would read differently on every retry
  -- and turn a lost-receipt recovery into a conflict.
  IF v_item IS NULL OR v_sent IS NULL OR NOT isfinite(v_sent)
     OR (v_payload->>'sent_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
     -- Nor from the future beyond ordinary clock skew: a message dated years
     -- ahead would sort above every real message for ever, and enough of them
     -- would crowd the real ones out of a capped read.
     OR v_sent > now() + interval '5 minutes'
     OR length(v_body) NOT BETWEEN 1 AND 4000
     OR length(v_name) NOT BETWEEN 1 AND 200 THEN
    v_reason := 'invalid_message';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.builder_stock_items i
     WHERE i.id = v_item AND i.organisation_id = v_connection.builder_organisation_id) THEN
    v_reason := 'stock_item_not_ours';
  ELSIF v_conversation_id <> public.builder_agency_conversation_id(v_connection.id, v_item) THEN
    v_reason := 'conversation_mismatch';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = v_connection.id AND a.stock_item_id = v_item
       AND a.status <> 'withdrawn') THEN
    -- Closed to NEW messages. One already held here, unchanged, is this
    -- side's own record: its retry (a receipt lost on the way back) is
    -- acknowledged again, or the agency would record a refusal for words
    -- this conversation keeps.
    SELECT * INTO v_existing FROM public.builder_agency_messages WHERE id = v_message_id;
    IF v_existing.id IS NULL
       OR v_existing.conversation_id <> v_conversation_id OR v_existing.side <> 'command_centre'
       OR v_existing.body <> v_body OR v_existing.sender_display_name <> left(v_name, 200)
       OR v_existing.sent_at <> v_sent THEN
      v_reason := 'conversation_not_open';
    END IF;
    v_existing := NULL;
  END IF;

  IF v_reason IS NULL THEN
    SELECT * INTO v_existing FROM public.builder_agency_messages WHERE id = v_message_id;
    IF v_existing.id IS NOT NULL
       AND (v_existing.conversation_id <> v_conversation_id OR v_existing.side <> 'command_centre'
            -- A message id is bound to what it said: a redelivery or retry that
            -- changes the words, the name or the time is not this message.
            OR v_existing.body <> v_body
            OR v_existing.sender_display_name <> left(v_name, 200)
            OR v_existing.sent_at <> v_sent) THEN
      v_reason := 'message_conflict';
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM public.builder_agency_enqueue(v_connection.id, 'agency.message.receipt',
      'agency.receipt:' || v_message_id || ':' || v_generation,
      jsonb_build_object('schema_version', 1, 'message_id', v_message_id,
        'conversation_id', v_conversation_id, 'generation', v_generation,
        'outcome', 'refused', 'reason', v_reason));
    RETURN 'refused:' || v_reason;
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.builder_agency_conversations(id, connection_id, stock_item_id, organisation_id)
    VALUES (v_conversation_id, v_connection.id, v_item, v_connection.builder_organisation_id)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.builder_agency_messages(
      id, conversation_id, side, sender_display_name, body, sent_at, received_at)
    VALUES (v_message_id, v_conversation_id, 'command_centre', left(v_name, 200), v_body, v_sent, now())
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      -- Another sweep stored this id between the lookup and the insert. What
      -- it stored is this message only if it says the same thing; otherwise
      -- the answer is a refusal, never an acknowledgement of words not kept.
      SELECT * INTO v_existing FROM public.builder_agency_messages WHERE id = v_message_id;
      IF v_existing.conversation_id <> v_conversation_id OR v_existing.side <> 'command_centre'
         OR v_existing.body <> v_body OR v_existing.sender_display_name <> left(v_name, 200)
         OR v_existing.sent_at <> v_sent THEN
        v_reason := 'message_conflict';
      END IF;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM public.builder_agency_enqueue(v_connection.id, 'agency.message.receipt',
      'agency.receipt:' || v_message_id || ':' || v_generation,
      jsonb_build_object('schema_version', 1, 'message_id', v_message_id,
        'conversation_id', v_conversation_id, 'generation', v_generation,
        'outcome', 'refused', 'reason', v_reason));
    RETURN 'refused:' || v_reason;
  END IF;

  IF v_inserted > 0 THEN
    UPDATE public.builder_agency_conversations
       SET last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'), v_sent)
     WHERE id = v_conversation_id;
  END IF;

  -- Accepted — answered again for every generation, applied only once.
  PERFORM public.builder_agency_enqueue(v_connection.id, 'agency.message.receipt',
    'agency.receipt:' || v_message_id || ':' || v_generation,
    jsonb_build_object('schema_version', 1, 'message_id', v_message_id,
      'conversation_id', v_conversation_id, 'generation', v_generation,
      'outcome', 'accepted'));
  RETURN 'applied';
END
$fn$;

-- A message whose CURRENT generation reached the other side (its outbox row
-- is delivered) and whose receipt has not come back within the confirmation
-- window is failed as `confirmation_timeout` — never as a refusal, because
-- nobody refused it. Its writer can send it again: the receiver stores the
-- message id once and answers every generation, so a message that WAS
-- accepted (its receipt lost on the way back) is simply confirmed by the next
-- generation's receipt. A late receipt of this same generation still makes it
-- Delivered (it is the truth); one of an older generation changes nothing.
-- Deterministic, set-based, and run by the message sweep's own schedule.
CREATE OR REPLACE FUNCTION public.builder_agency_expire_unconfirmed(
  _window interval DEFAULT interval '15 minutes')
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $fn$
  WITH expired AS (
    UPDATE public.builder_agency_messages m
       SET delivery_state = 'failed', failure_reason = 'confirmation_timeout'
      FROM public.builder_network_outbox o
     WHERE m.side = 'builder' AND m.delivery_state = 'queued'
       AND o.dedupe_key = 'agency.message:' || m.id || ':' || m.delivery_generation
       AND o.status = 'delivered'
       AND o.delivered_at < now() - _window
    RETURNING m.id)
  SELECT count(*)::integer FROM expired
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_apply_message_events(_limit integer DEFAULT 50)
RETURNS TABLE(applied integer, refused integer, deferred integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_event record;
  v_result text;
  v_applied integer := 0;
  v_refused integer := 0;
  v_deferred integer := 0;
BEGIN
  FOR v_event IN
    SELECT e.id, e.connection_id, e.event_type, e.message_apply_attempts
      FROM public.builder_network_inbound_events e
     WHERE e.message_applied_at IS NULL
       AND e.event_type IN ('agency.message.posted', 'agency.message.receipt')
       -- A message never overtakes the activation it depends on: the door's
       -- 200 means an activation LANDED, not that the main sweep applied it,
       -- so a posted message waits (unconsumed, no attempt spent) while an
       -- activation that landed before it on the same connection is still
       -- unapplied, instead of being refused as not open.
       AND NOT (e.event_type = 'agency.message.posted' AND EXISTS (
         SELECT 1 FROM public.builder_network_inbound_events p
          WHERE p.connection_id = e.connection_id AND p.processed_at IS NULL
            AND p.event_type LIKE 'stock.selection.%'
            AND (p.received_at, p.id) < (e.received_at, e.id)))
     ORDER BY e.received_at, e.id
     LIMIT greatest(1, least(_limit, 500))
     FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_result := public.builder_agency_apply_message_event(v_event.id);
      UPDATE public.builder_network_inbound_events
         SET message_applied_at = now(),
             message_apply_attempts = message_apply_attempts + 1,
             message_apply_error = CASE WHEN v_result = 'applied' THEN NULL ELSE left(v_result, 200) END
       WHERE id = v_event.id;
      IF v_result = 'applied' THEN
        v_applied := v_applied + 1;
      ELSE
        v_refused := v_refused + 1;
        PERFORM public.builder_agency_note('builder_agency_message_refused', 'warning', v_event.id,
          jsonb_build_object('connection_id', v_event.connection_id,
                             'event_type', v_event.event_type, 'reason', v_result));
      END IF;
    EXCEPTION WHEN others THEN
      -- One message that cannot be applied never holds up the next: it is
      -- retried on later sweeps, then dead-lettered.
      IF v_event.message_apply_attempts + 1 >= 5 THEN
        UPDATE public.builder_network_inbound_events
           SET message_applied_at = now(), message_apply_attempts = message_apply_attempts + 1,
               message_apply_error = left('dead:' || SQLERRM, 200)
         WHERE id = v_event.id;
        PERFORM public.builder_agency_note('builder_agency_message_apply_dead', 'critical', v_event.id,
          jsonb_build_object('connection_id', v_event.connection_id,
                             'event_type', v_event.event_type, 'error', left(SQLERRM, 200)));
        v_refused := v_refused + 1;
      ELSE
        UPDATE public.builder_network_inbound_events
           SET message_apply_attempts = message_apply_attempts + 1,
               message_apply_error = left(SQLERRM, 200)
         WHERE id = v_event.id;
        v_deferred := v_deferred + 1;
      END IF;
    END;
  END LOOP;

  IF v_applied + v_refused > 0 THEN
    PERFORM public.builder_agency_kick_outbox();
  END IF;
  PERFORM public.builder_agency_expire_unconfirmed();
  applied := v_applied; refused := v_refused; deferred := v_deferred;
  RETURN NEXT;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. The lane, and the transport's verdict.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_agency_message_lane()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $fn$
BEGIN
  -- Consumed for the MAIN sweep on arrival: it would otherwise refuse an
  -- event type it does not handle, terminally. This lane's own stamp
  -- (`message_applied_at`) decides whether the message has been applied.
  NEW.processed_at := COALESCE(NEW.processed_at, now());
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_builder_agency_message_lane ON public.builder_network_inbound_events;
CREATE TRIGGER trg_builder_agency_message_lane
  BEFORE INSERT ON public.builder_network_inbound_events
  FOR EACH ROW
  WHEN (NEW.event_type IN ('agency.message.posted', 'agency.message.receipt'))
  EXECUTE FUNCTION public.builder_agency_message_lane();

-- An outbox row that dead-letters is a message the agency never received.
CREATE OR REPLACE FUNCTION public.builder_agency_message_transport_dead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  BEGIN
    UPDATE public.builder_agency_messages
       SET delivery_state = 'failed', failure_reason = 'not_delivered'
     WHERE id = (NEW.payload->>'message_id')::uuid
       AND delivery_generation = (NEW.payload->>'generation')::integer
       AND delivery_state = 'queued';
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_builder_agency_message_transport_dead ON public.builder_network_outbox;
CREATE TRIGGER trg_builder_agency_message_transport_dead
  AFTER UPDATE OF status ON public.builder_network_outbox
  FOR EACH ROW
  WHEN (NEW.status = 'dead' AND OLD.status IS DISTINCT FROM 'dead'
        AND NEW.event_type = 'agency.message.posted')
  EXECUTE FUNCTION public.builder_agency_message_transport_dead();

-- ---------------------------------------------------------------------------
-- 6. Grants, and the sweep's schedule.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.builder_agency_conversation_id(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_message_payload(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_kick_outbox() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_enqueue(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_note(text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_post_message(uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_retry_message(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_apply_message_event(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_apply_message_events(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_expire_unconfirmed(interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_message_lane() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_message_transport_dead() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_agency_conversation_id(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_post_message(uuid, uuid, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_retry_message(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_apply_message_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_expire_unconfirmed(interval) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-agency-messages-apply-1min') THEN
    PERFORM cron.schedule('builder-agency-messages-apply-1min', '* * * * *',
      $job$SELECT public.builder_agency_apply_message_events(50);$job$);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Asserted by effect.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF public.builder_agency_conversation_id(
       '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
     IS DISTINCT FROM md5('agency.conversation:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002')::uuid THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the conversation id is not the shared derivation';
  END IF;
  IF has_function_privilege('authenticated', 'public.builder_agency_post_message(uuid,uuid,uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.builder_agency_messages', 'SELECT')
     OR has_table_privilege('anon', 'public.builder_agency_messages', 'SELECT') THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: messaging is reachable from a browser role';
  END IF;
END $$;

COMMIT;
