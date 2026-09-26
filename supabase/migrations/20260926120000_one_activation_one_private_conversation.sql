-- ============================================================================
-- One activation, one private conversation. The Builders Network's half.
--
-- The Command Centre's half is `npc-property-dashbord`'s
-- `20261222090000_one_activation_one_private_conversation.sql`; the two share
-- one contract, `docs/builder-portal/62-…` (the Command Centre's 52).
--
-- WHAT CHANGES. Step 5 (20260925180000) gave a PROPERTY one conversation on a
-- connection and let any member with `inventory` access read and write it. A
-- conversation now belongs to ONE ACTIVATION (announcement), and only its
-- participants may read, poll, write, retry, list participants, invite or
-- leave. How a message travels does not change.
--
-- ITS IDENTITY. md5('agency.activation:' || connection id || ':' ||
-- remote_selection_ref), computed identically by the Command Centre. The one
-- conversation that exists already keeps its id; its row records which
-- activation it belongs to (`selection_ref`).
--
-- MEMBERSHIP IS LOCAL. A row with a `builder_user_id` is one of this
-- organisation's members and grants that member access; the agency's
-- participants are display records and grant nothing to anyone.
--
-- THE ACKNOWLEDGEMENT opens the conversation with the member who acknowledged
-- it, announces them, and tells the agency their display name — and nothing
-- else about them.
--
-- THE COMPANY'S CONTACT. A property now carries its builder organisation's
-- own public `contact_email`, `contact_phone` and `website`, read from
-- `builder_organisations`, never from a person, and omitted when empty.
--
-- NOTHING IS GUESSED. No existing conversation is bound here;
-- `builder_agency_seed_activation_conversation` does that, called by the
-- `agency-chat-backfill` phase only where both projects agree.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The records.
-- ---------------------------------------------------------------------------
ALTER TABLE public.builder_agency_conversations
  ADD COLUMN IF NOT EXISTS selection_ref uuid;
ALTER TABLE public.builder_agency_conversations
  DROP CONSTRAINT IF EXISTS builder_agency_conversations_pair;
CREATE UNIQUE INDEX IF NOT EXISTS builder_agency_conversations_activation_key
  ON public.builder_agency_conversations (connection_id, selection_ref)
  WHERE selection_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_agency_conversations_item_idx
  ON public.builder_agency_conversations (connection_id, stock_item_id);

CREATE TABLE IF NOT EXISTS public.builder_agency_conversation_participants (
  conversation_id uuid NOT NULL
    REFERENCES public.builder_agency_conversations(id) ON DELETE CASCADE,
  -- Random, minted once per (conversation, person). Never a user id.
  participant_ref uuid NOT NULL,
  side text NOT NULL CHECK (side IN ('builder', 'command_centre')),
  -- This organisation's member, for builder participants only.
  builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('joined', 'left')),
  version integer NOT NULL CHECK (version >= 1),
  joined_at timestamptz,
  left_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, participant_ref),
  CONSTRAINT builder_agency_participants_remote_grants_nothing
    CHECK (side = 'builder' OR builder_user_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS builder_agency_participants_local_key
  ON public.builder_agency_conversation_participants (conversation_id, builder_user_id)
  WHERE builder_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_agency_participants_user_idx
  ON public.builder_agency_conversation_participants (builder_user_id)
  WHERE builder_user_id IS NOT NULL;

ALTER TABLE public.builder_agency_conversation_participants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_agency_conversation_participants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_agency_conversation_participants TO service_role;

DROP INDEX IF EXISTS public.builder_network_inbound_events_message_pending_idx;
CREATE INDEX IF NOT EXISTS builder_network_inbound_events_message_pending_idx
  ON public.builder_network_inbound_events (received_at, id)
  WHERE message_applied_at IS NULL
    AND event_type IN ('agency.message.posted', 'agency.message.receipt', 'agency.message.participant');

-- ---------------------------------------------------------------------------
-- 2. The derivation, names and participant events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_agency_activation_conversation_id(
  _connection_id uuid, _selection_ref uuid)
RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT
AS $fn$
  SELECT md5('agency.activation:' || _connection_id::text || ':' || _selection_ref::text)::uuid
$fn$;

-- A member's name, only while they are an active member of the organisation.
CREATE OR REPLACE FUNCTION public.builder_agency_member_display_name(_user_id uuid, _organisation_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT left(nullif(btrim(u.name), ''), 200)
    FROM public.builder_portal_users u
   WHERE u.id = _user_id
     AND EXISTS (SELECT 1 FROM public.builder_active_membership(_user_id, _organisation_id))
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_announce_participant(
  _conversation_id uuid, _participant_ref uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_p public.builder_agency_conversation_participants%ROWTYPE;
  v_c public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM public.builder_agency_conversation_participants
   WHERE conversation_id = _conversation_id AND participant_ref = _participant_ref AND side = 'builder';
  SELECT * INTO v_c FROM public.builder_agency_conversations WHERE id = _conversation_id;
  IF v_p.participant_ref IS NULL OR v_c.id IS NULL THEN RETURN; END IF;
  PERFORM public.builder_agency_enqueue(v_c.connection_id, 'agency.message.participant',
    'agency.participant:' || v_c.id || ':' || v_p.participant_ref || ':' || v_p.version,
    jsonb_build_object(
      'schema_version', 1,
      'conversation_id', v_c.id,
      'stock_item_id', v_c.stock_item_id,
      'participant_ref', v_p.participant_ref,
      'display_name', v_p.display_name,
      'side', 'builder',
      'state', v_p.state,
      'version', v_p.version));
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_join_local(
  _conversation_id uuid, _user_id uuid, _display_name text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_p public.builder_agency_conversation_participants%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM public.builder_agency_conversation_participants
   WHERE conversation_id = _conversation_id AND builder_user_id = _user_id
   FOR UPDATE;
  IF v_p.participant_ref IS NULL THEN
    INSERT INTO public.builder_agency_conversation_participants(
      conversation_id, participant_ref, side, builder_user_id, display_name, state, version, joined_at)
    VALUES (_conversation_id, gen_random_uuid(), 'builder', _user_id, _display_name, 'joined', 1, now())
    ON CONFLICT (conversation_id, builder_user_id) WHERE builder_user_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_p;
    IF v_p.participant_ref IS NULL THEN RETURN false; END IF;
  ELSIF v_p.state = 'joined' THEN
    RETURN false;
  ELSE
    UPDATE public.builder_agency_conversation_participants
       SET state = 'joined', version = version + 1, display_name = _display_name,
           joined_at = now(), left_at = NULL, updated_at = now()
     WHERE conversation_id = _conversation_id AND participant_ref = v_p.participant_ref;
  END IF;
  PERFORM public.builder_agency_announce_participant(_conversation_id, v_p.participant_ref);
  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_is_participant(_conversation_id uuid, _builder_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.builder_agency_conversation_participants p
     WHERE p.conversation_id = _conversation_id AND p.builder_user_id = _builder_user_id
       AND p.side = 'builder' AND p.state = 'joined')
$fn$;

-- Why a conversation takes nothing new right now, or NULL when it does. Holds
-- the rows that decide it for the caller's transaction.
CREATE OR REPLACE FUNCTION public.builder_agency_conversation_closed_reason(_conversation_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_c public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM public.builder_agency_conversations WHERE id = _conversation_id;
  IF v_c.id IS NULL THEN RETURN 'not_found'; END IF;
  PERFORM 1 FROM public.workspace_connections c WHERE c.id = v_c.connection_id FOR SHARE;
  IF v_c.selection_ref IS NOT NULL THEN
    PERFORM 1 FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = v_c.connection_id AND a.remote_selection_ref = v_c.selection_ref FOR SHARE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_connections c
                  WHERE c.id = v_c.connection_id AND c.state = 'active'
                    AND c.builder_organisation_id = v_c.organisation_id) THEN
    RETURN 'not_connected';
  END IF;
  IF v_c.selection_ref IS NULL THEN RETURN 'not_activated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_stock_selection_announcements a
                  WHERE a.connection_id = v_c.connection_id AND a.remote_selection_ref = v_c.selection_ref
                    AND a.organisation_id = v_c.organisation_id AND a.stock_item_id = v_c.stock_item_id
                    AND a.status <> 'withdrawn') THEN
    RETURN 'withdrawn';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_stock_selection_announcements a
                  WHERE a.connection_id = v_c.connection_id AND a.remote_selection_ref = v_c.selection_ref
                    AND a.acknowledged_at IS NOT NULL) THEN
    RETURN 'not_acknowledged';
  END IF;
  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Writing (the builder's side). The per-property form is gone.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.builder_agency_post_message(uuid, uuid, uuid, uuid, uuid, text);
CREATE FUNCTION public.builder_agency_post_message(
  _organisation_id uuid,
  _conversation_id uuid,
  _sender_builder_user_id uuid,
  _client_message_id uuid,
  _body text)
RETURNS SETOF public.builder_agency_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_body text := btrim(COALESCE(_body, ''));
  v_c public.builder_agency_conversations%ROWTYPE;
  v_existing public.builder_agency_messages%ROWTYPE;
  v_name text;
  v_id uuid;
BEGIN
  IF _client_message_id IS NULL OR length(v_body) = 0 OR length(v_body) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_INVALID';
  END IF;

  -- The same send again is the same row (Step 5's rule), bound to its text,
  -- its conversation and its organisation.
  SELECT * INTO v_existing FROM public.builder_agency_messages m
   WHERE m.sender_builder_user_id = _sender_builder_user_id
     AND m.client_message_id = _client_message_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.conversation_id <> _conversation_id OR v_existing.body <> v_body
       OR NOT EXISTS (SELECT 1 FROM public.builder_agency_conversations c
                       WHERE c.id = v_existing.conversation_id AND c.organisation_id = _organisation_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_ID_REUSED';
    END IF;
    -- Answered only to someone still in the conversation: repeating an
    -- earlier send is never a way back in after leaving.
    IF NOT public.builder_agency_is_participant(v_existing.conversation_id, _sender_builder_user_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_NOT_A_PARTICIPANT';
    END IF;
    RETURN NEXT v_existing;
    RETURN;
  END IF;

  SELECT * INTO v_c FROM public.builder_agency_conversations
   WHERE id = _conversation_id AND organisation_id = _organisation_id;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.builder_agency_conversation_participants p
   WHERE p.conversation_id = v_c.id AND p.builder_user_id = _sender_builder_user_id FOR SHARE;
  IF NOT public.builder_agency_is_participant(v_c.id, _sender_builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_NOT_A_PARTICIPANT';
  END IF;
  IF public.builder_agency_conversation_closed_reason(v_c.id) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_OPEN';
  END IF;
  v_name := public.builder_agency_member_display_name(_sender_builder_user_id, _organisation_id);
  IF v_name IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_SENDER_NOT_A_MEMBER';
  END IF;

  v_id := gen_random_uuid();
  BEGIN
    INSERT INTO public.builder_agency_messages(
      id, conversation_id, side, sender_builder_user_id, client_message_id,
      sender_display_name, body, sent_at, delivery_state, delivery_generation)
    VALUES (v_id, v_c.id, 'builder', _sender_builder_user_id, _client_message_id,
            v_name, v_body, clock_timestamp(), 'queued', 1);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.builder_agency_messages m
     WHERE m.sender_builder_user_id = _sender_builder_user_id
       AND m.client_message_id = _client_message_id;
    IF v_existing.id IS NULL THEN
      RAISE;
    END IF;
    IF v_existing.conversation_id <> v_c.id OR v_existing.body <> v_body THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_ID_REUSED';
    END IF;
    RETURN NEXT v_existing;
    RETURN;
  END;

  UPDATE public.builder_agency_conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'), now())
   WHERE id = v_c.id;

  PERFORM public.builder_agency_enqueue(v_c.connection_id, 'agency.message.posted',
    'agency.message:' || v_id || ':1', public.builder_agency_message_payload(v_id));
  PERFORM public.builder_agency_kick_outbox();

  RETURN QUERY SELECT * FROM public.builder_agency_messages WHERE id = v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_retry_message(
  _organisation_id uuid, _message_id uuid, _sender_builder_user_id uuid)
RETURNS SETOF public.builder_agency_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_message public.builder_agency_messages%ROWTYPE;
  v_c public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT m.* INTO v_message
    FROM public.builder_agency_messages m
    JOIN public.builder_agency_conversations c ON c.id = m.conversation_id
   WHERE m.id = _message_id AND c.organisation_id = _organisation_id
     AND m.side = 'builder' AND m.sender_builder_user_id = _sender_builder_user_id
   FOR UPDATE OF m;
  IF v_message.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_NOT_RETRYABLE';
  END IF;
  SELECT * INTO v_c FROM public.builder_agency_conversations WHERE id = v_message.conversation_id;
  PERFORM 1 FROM public.builder_agency_conversation_participants p
   WHERE p.conversation_id = v_c.id AND p.builder_user_id = _sender_builder_user_id FOR SHARE;
  IF NOT public.builder_agency_is_participant(v_c.id, _sender_builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_NOT_A_PARTICIPANT';
  END IF;
  IF v_message.delivery_state <> 'failed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_MESSAGE_NOT_RETRYABLE';
  END IF;
  IF public.builder_agency_conversation_closed_reason(v_c.id) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_OPEN';
  END IF;

  UPDATE public.builder_agency_messages
     SET delivery_state = 'queued', delivery_generation = delivery_generation + 1,
         failure_reason = NULL
   WHERE id = _message_id;
  PERFORM public.builder_agency_enqueue(v_c.connection_id, 'agency.message.posted',
    'agency.message:' || _message_id || ':' || (v_message.delivery_generation + 1),
    public.builder_agency_message_payload(_message_id));
  PERFORM public.builder_agency_kick_outbox();

  RETURN QUERY SELECT * FROM public.builder_agency_messages WHERE id = _message_id;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Inviting and leaving. There is no operation that removes anyone.
-- ---------------------------------------------------------------------------
-- A colleague may be invited when they are an active member of THIS
-- organisation who holds `inventory` view — read from the organisation's own
-- rows, never from the caller.
CREATE OR REPLACE FUNCTION public.builder_agency_invitee_eligible(_user_id uuid, _organisation_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT public.builder_resolve_permission(_user_id, _organisation_id, 'inventory', 'view')
     AND public.builder_agency_member_display_name(_user_id, _organisation_id) IS NOT NULL
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_invite_participant(
  _organisation_id uuid, _conversation_id uuid, _actor_builder_user_id uuid, _invitee_builder_user_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_c public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM public.builder_agency_conversations
   WHERE id = _conversation_id AND organisation_id = _organisation_id FOR UPDATE;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_FOUND';
  END IF;
  IF NOT public.builder_agency_is_participant(v_c.id, _actor_builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_NOT_A_PARTICIPANT';
  END IF;
  IF public.builder_agency_conversation_closed_reason(v_c.id) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_OPEN';
  END IF;
  IF _invitee_builder_user_id IS NULL
     OR NOT public.builder_agency_invitee_eligible(_invitee_builder_user_id, _organisation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_INVITEE_NOT_ELIGIBLE';
  END IF;
  IF public.builder_agency_is_participant(v_c.id, _invitee_builder_user_id) THEN
    RETURN 'already_participant';
  END IF;
  PERFORM public.builder_agency_join_local(v_c.id, _invitee_builder_user_id,
    public.builder_agency_member_display_name(_invitee_builder_user_id, _organisation_id));
  PERFORM public.builder_agency_kick_outbox();
  RETURN 'joined';
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_invite_candidates(
  _organisation_id uuid, _conversation_id uuid, _actor_builder_user_id uuid)
RETURNS TABLE(user_id uuid, display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.builder_agency_conversations c
                  WHERE c.id = _conversation_id AND c.organisation_id = _organisation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_FOUND';
  END IF;
  IF NOT public.builder_agency_is_participant(_conversation_id, _actor_builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_NOT_A_PARTICIPANT';
  END IF;
  RETURN QUERY
    SELECT m.builder_user_id, public.builder_agency_member_display_name(m.builder_user_id, _organisation_id)
      FROM public.builder_organisation_memberships m
     WHERE m.organisation_id = _organisation_id AND m.status = 'active'
       AND public.builder_agency_invitee_eligible(m.builder_user_id, _organisation_id)
       AND NOT public.builder_agency_is_participant(_conversation_id, m.builder_user_id)
     -- Every eligible colleague, in a stable order: the caller reads them a
     -- page at a time, so nobody past a fixed count is left uninvitable.
     ORDER BY 2, 1;
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_leave_conversation(
  _organisation_id uuid, _conversation_id uuid, _actor_builder_user_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_c public.builder_agency_conversations%ROWTYPE;
  v_p public.builder_agency_conversation_participants%ROWTYPE;
  v_live boolean;
BEGIN
  SELECT * INTO v_c FROM public.builder_agency_conversations
   WHERE id = _conversation_id AND organisation_id = _organisation_id FOR UPDATE;
  IF v_c.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_CONVERSATION_NOT_FOUND';
  END IF;
  SELECT * INTO v_p FROM public.builder_agency_conversation_participants
   WHERE conversation_id = v_c.id AND builder_user_id = _actor_builder_user_id AND state = 'joined'
   FOR UPDATE;
  IF v_p.participant_ref IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_NOT_A_PARTICIPANT';
  END IF;
  -- Live is the same open/closed decision every other act reads: a
  -- conversation closed for ANY reason can be left, so nobody is held in one
  -- that no act of theirs can reopen.
  v_live := public.builder_agency_conversation_closed_reason(v_c.id) IS NULL;
  IF v_live AND NOT EXISTS (
    SELECT 1 FROM public.builder_agency_conversation_participants o
     WHERE o.conversation_id = v_c.id AND o.side = 'builder' AND o.state = 'joined'
       AND o.builder_user_id IS NOT NULL AND o.participant_ref <> v_p.participant_ref) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_LAST_PARTICIPANT';
  END IF;
  UPDATE public.builder_agency_conversation_participants
     SET state = 'left', version = version + 1, left_at = now(), updated_at = now()
   WHERE conversation_id = v_c.id AND participant_ref = v_p.participant_ref;
  PERFORM public.builder_agency_announce_participant(v_c.id, v_p.participant_ref);
  PERFORM public.builder_agency_kick_outbox();
  RETURN 'left';
END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. The acknowledgement opens the conversation. Exactly the previous
--    definition (20260916170000), plus the conversation and the name.
-- ---------------------------------------------------------------------------
-- Open (or find) an activation's conversation and add a member to it.
CREATE OR REPLACE FUNCTION public.builder_agency_open_activation_conversation(
  _announcement_id uuid, _conversation_id uuid, _builder_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_a public.builder_stock_selection_announcements%ROWTYPE;
  v_conversation uuid;
  v_name text;
BEGIN
  SELECT * INTO v_a FROM public.builder_stock_selection_announcements WHERE id = _announcement_id;
  SELECT c.id INTO v_conversation FROM public.builder_agency_conversations c
   WHERE c.connection_id = v_a.connection_id AND c.selection_ref = v_a.remote_selection_ref;
  IF v_conversation IS NULL THEN
    v_conversation := COALESCE(_conversation_id,
      public.builder_agency_activation_conversation_id(v_a.connection_id, v_a.remote_selection_ref));
    INSERT INTO public.builder_agency_conversations(id, connection_id, stock_item_id, organisation_id, selection_ref)
    VALUES (v_conversation, v_a.connection_id, v_a.stock_item_id, v_a.organisation_id, v_a.remote_selection_ref)
    ON CONFLICT (id) DO UPDATE
      SET selection_ref = COALESCE(public.builder_agency_conversations.selection_ref, EXCLUDED.selection_ref);
  END IF;
  v_name := public.builder_agency_member_display_name(_builder_user_id, v_a.organisation_id);
  IF v_name IS NOT NULL THEN
    PERFORM public.builder_agency_join_local(v_conversation, _builder_user_id, v_name);
  END IF;
  RETURN v_conversation;
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_stock_acknowledge_announcement(
  _announcement_id uuid, _organisation_id uuid, _builder_user_id uuid)
RETURNS SETOF public.builder_stock_selection_announcements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_row public.builder_stock_selection_announcements;
  v_version bigint;
  v_name text;
BEGIN
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

  -- The acknowledger, by the name a person reads. Never an id.
  v_name := public.builder_agency_member_display_name(_builder_user_id, _organisation_id);

  INSERT INTO public.builder_network_outbox(
    connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (
    v_row.connection_id,
    'stock.selection.acknowledged',
    'stock.selection.acknowledged:' || v_row.connection_id || ':' || v_row.remote_selection_ref,
    jsonb_strip_nulls(jsonb_build_object(
      'remote_selection_ref', v_row.remote_selection_ref,
      'stock_item_id', v_row.stock_item_id,
      'status', 'builder_acknowledged',
      'acknowledged_at', v_row.acknowledged_at,
      'acknowledged_by_display_name', v_name)),
    v_version)
  ON CONFLICT (dedupe_key) DO NOTHING;

  -- The activation's private conversation, opened with its acknowledger.
  PERFORM public.builder_agency_open_activation_conversation(v_row.id, NULL, _builder_user_id);

  UPDATE public.builder_tasks t
     SET status = 'done',
         completed_at = COALESCE(t.completed_at, now())
   WHERE t.id = v_row.activation_task_id
     AND t.status IN ('open', 'in_progress', 'blocked');

  PERFORM public.builder_log_activity(
    _builder_user_id, 'builder_user', 'builder_stock_selection_acknowledged',
    'stock_selection', v_row.id, _organisation_id, _builder_user_id,
    NULL,
    jsonb_build_object('remote_selection_ref', v_row.remote_selection_ref,
                       'connection_id', v_row.connection_id,
                       'activation_task_id', v_row.activation_task_id),
    NULL, '{}'::jsonb);

  PERFORM public.builder_agency_kick_outbox();
  RETURN NEXT v_row;
END $fn$;

-- ---------------------------------------------------------------------------
-- 6. Binding a conversation that already existed (the backfill phase only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_agency_seed_activation_conversation(
  _announcement_id uuid, _conversation_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_a public.builder_stock_selection_announcements%ROWTYPE;
  v_c public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.builder_stock_selection_announcements WHERE id = _announcement_id FOR UPDATE;
  IF v_a.id IS NULL OR v_a.acknowledged_at IS NULL OR v_a.acknowledged_by_builder_user_id IS NULL
     OR v_a.status = 'withdrawn' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_SEED_NOT_ACKNOWLEDGED';
  END IF;
  SELECT * INTO v_c FROM public.builder_agency_conversations WHERE id = _conversation_id FOR UPDATE;
  IF v_c.id IS NOT NULL THEN
    IF v_c.connection_id <> v_a.connection_id OR v_c.stock_item_id <> v_a.stock_item_id
       OR v_c.organisation_id <> v_a.organisation_id
       OR (v_c.selection_ref IS NOT NULL AND v_c.selection_ref <> v_a.remote_selection_ref)
       OR EXISTS (SELECT 1 FROM public.builder_agency_conversations o
                   WHERE o.connection_id = v_a.connection_id AND o.selection_ref = v_a.remote_selection_ref
                     AND o.id <> v_c.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_SEED_MISMATCH';
    END IF;
  ELSIF _conversation_id <> public.builder_agency_activation_conversation_id(v_a.connection_id, v_a.remote_selection_ref)
     OR EXISTS (SELECT 1 FROM public.builder_agency_conversations o
                 WHERE o.connection_id = v_a.connection_id AND o.selection_ref = v_a.remote_selection_ref) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_SEED_MISMATCH';
  END IF;
  IF public.builder_agency_member_display_name(v_a.acknowledged_by_builder_user_id, v_a.organisation_id) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENCY_SEED_ACKNOWLEDGER_INACTIVE';
  END IF;
  IF v_c.id IS NOT NULL AND v_c.selection_ref = v_a.remote_selection_ref AND EXISTS (
    SELECT 1 FROM public.builder_agency_conversation_participants p
     WHERE p.conversation_id = v_c.id AND p.builder_user_id = v_a.acknowledged_by_builder_user_id) THEN
    RETURN 'already_seeded';
  END IF;
  IF v_c.id IS NOT NULL THEN
    UPDATE public.builder_agency_conversations SET selection_ref = v_a.remote_selection_ref WHERE id = v_c.id;
  END IF;
  PERFORM public.builder_agency_open_activation_conversation(v_a.id, _conversation_id, v_a.acknowledged_by_builder_user_id);
  PERFORM public.builder_agency_kick_outbox();
  RETURN 'seeded';
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Receiving: the agency's messages, receipts and participants.
-- ---------------------------------------------------------------------------
-- Which conversation an event names: its row, on this connection and
-- property; or, new, the derivation of a live, ACKNOWLEDGED activation of
-- this property on this connection (created then). NULL for anything else:
-- the acknowledgement is what opens a conversation, so nothing signed can
-- open one, or put anybody or anything in it, ahead of it.
CREATE OR REPLACE FUNCTION public.builder_agency_resolve_conversation(
  _connection_id uuid, _conversation_id uuid, _stock_item_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_a public.builder_stock_selection_announcements%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.builder_agency_conversations c
              WHERE c.id = _conversation_id AND c.connection_id = _connection_id
                AND c.stock_item_id = _stock_item_id) THEN
    RETURN _conversation_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.builder_agency_conversations c WHERE c.id = _conversation_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_a FROM public.builder_stock_selection_announcements a
   WHERE a.connection_id = _connection_id AND a.stock_item_id = _stock_item_id AND a.status <> 'withdrawn'
     AND a.acknowledged_at IS NOT NULL
     AND public.builder_agency_activation_conversation_id(_connection_id, a.remote_selection_ref) = _conversation_id
     AND NOT EXISTS (SELECT 1 FROM public.builder_agency_conversations o
                      WHERE o.connection_id = _connection_id AND o.selection_ref = a.remote_selection_ref)
   LIMIT 1;
  IF v_a.id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.builder_agency_conversations(id, connection_id, stock_item_id, organisation_id, selection_ref)
  VALUES (_conversation_id, _connection_id, _stock_item_id, v_a.organisation_id, v_a.remote_selection_ref)
  ON CONFLICT (id) DO NOTHING;
  RETURN _conversation_id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.builder_agency_apply_participant_event(
  _connection record, _payload jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_conversation uuid;
  v_ref uuid;
  v_item uuid;
  v_version integer;
  v_name text := btrim(COALESCE(_payload->>'display_name', ''));
  v_state text := _payload->>'state';
  v_existing public.builder_agency_conversation_participants%ROWTYPE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(_payload) k
     WHERE k <> ALL (ARRAY['conversation_id', 'display_name', 'participant_ref', 'schema_version',
                           'side', 'state', 'stock_item_id', 'version']))
     OR (SELECT count(*) FROM jsonb_object_keys(_payload)) <> 8
     OR EXISTS (
    SELECT 1 FROM jsonb_each(_payload) kv
     WHERE jsonb_typeof(kv.value) <> CASE WHEN kv.key IN ('version', 'schema_version') THEN 'number' ELSE 'string' END) THEN
    RETURN 'refused:invalid_payload';
  END IF;
  BEGIN
    v_conversation := (_payload->>'conversation_id')::uuid;
    v_ref := (_payload->>'participant_ref')::uuid;
    v_item := (_payload->>'stock_item_id')::uuid;
    v_version := (_payload->>'version')::integer;
  EXCEPTION WHEN others THEN
    RETURN 'refused:invalid_payload';
  END;
  IF (_payload->>'schema_version') <> '1' OR v_version IS NULL OR v_version < 1
     OR (_payload->>'version') !~ '^[0-9]+$'
     OR v_state NOT IN ('joined', 'left') OR length(v_name) NOT BETWEEN 1 AND 200 THEN
    RETURN 'refused:invalid_payload';
  END IF;
  -- Always the SENDER's own side: an agency announces agency participants.
  IF _payload->>'side' <> 'command_centre' THEN
    RETURN 'refused:side_mismatch';
  END IF;
  IF _connection.state <> 'active' THEN
    RETURN 'refused:connection_not_active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_stock_items i
                  WHERE i.id = v_item AND i.organisation_id = _connection.builder_organisation_id) THEN
    RETURN 'refused:stock_item_not_ours';
  END IF;
  v_conversation := public.builder_agency_resolve_conversation(_connection.id, v_conversation, v_item);
  IF v_conversation IS NULL THEN
    RETURN 'refused:conversation_mismatch';
  END IF;

  SELECT * INTO v_existing FROM public.builder_agency_conversation_participants
   WHERE conversation_id = v_conversation AND participant_ref = v_ref FOR UPDATE;
  IF v_existing.participant_ref IS NOT NULL AND (v_existing.side <> 'command_centre' OR v_existing.builder_user_id IS NOT NULL) THEN
    RETURN 'refused:participant_conflict';
  END IF;
  INSERT INTO public.builder_agency_conversation_participants(
    conversation_id, participant_ref, side, builder_user_id, display_name, state, version, joined_at, left_at)
  VALUES (v_conversation, v_ref, 'command_centre', NULL, v_name, v_state, v_version,
          CASE WHEN v_state = 'joined' THEN now() END, CASE WHEN v_state = 'left' THEN now() END)
  ON CONFLICT (conversation_id, participant_ref) DO UPDATE
     SET display_name = EXCLUDED.display_name, state = EXCLUDED.state, version = EXCLUDED.version,
         joined_at = COALESCE(EXCLUDED.joined_at, public.builder_agency_conversation_participants.joined_at),
         left_at = EXCLUDED.left_at, updated_at = now()
   WHERE EXCLUDED.version > public.builder_agency_conversation_participants.version
     AND public.builder_agency_conversation_participants.side = 'command_centre'
     AND public.builder_agency_conversation_participants.builder_user_id IS NULL;
  RETURN 'applied';
END
$fn$;

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
  v_c public.builder_agency_conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.builder_network_inbound_events WHERE id = _event_id;
  v_payload := COALESCE(v_event.payload, '{}'::jsonb);

  SELECT c.id, c.state, c.builder_organisation_id INTO v_connection
    FROM public.workspace_connections c WHERE c.id = v_event.connection_id
   FOR SHARE;
  IF v_connection.id IS NULL THEN
    RETURN 'refused:connection_not_active';
  END IF;
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RETURN 'refused:invalid_payload';
  END IF;

  -- ── An agency participant: display only ─────────────────────────────────
  IF v_event.event_type = 'agency.message.participant' THEN
    RETURN public.builder_agency_apply_participant_event(v_connection, v_payload);
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_payload) k
     WHERE k <> ALL (CASE WHEN v_event.event_type = 'agency.message.posted'
                          THEN ARRAY['body', 'conversation_id', 'generation', 'message_id', 'schema_version',
                                     'sender_display_name', 'sent_at', 'stock_item_id']
                          ELSE ARRAY['conversation_id', 'generation', 'message_id', 'outcome', 'reason',
                                     'schema_version'] END)) THEN
    RETURN 'refused:invalid_payload';
  END IF;
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

  -- ── A receipt for something this side sent (unchanged) ──────────────────
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

  -- ── The agency's message ────────────────────────────────────────────────
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

  IF v_item IS NULL OR v_sent IS NULL OR NOT isfinite(v_sent)
     OR (v_payload->>'sent_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
     OR v_sent > now() + interval '5 minutes'
     OR length(v_body) NOT BETWEEN 1 AND 4000
     OR length(v_name) NOT BETWEEN 1 AND 200 THEN
    v_reason := 'invalid_message';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.builder_stock_items i
     WHERE i.id = v_item AND i.organisation_id = v_connection.builder_organisation_id) THEN
    v_reason := 'stock_item_not_ours';
  ELSIF public.builder_agency_resolve_conversation(v_connection.id, v_conversation_id, v_item) IS NULL THEN
    v_reason := 'conversation_mismatch';
  ELSE
    SELECT * INTO v_c FROM public.builder_agency_conversations WHERE id = v_conversation_id;
    -- Held, so a withdrawal cannot commit between the check and the insert.
    PERFORM 1 FROM public.builder_stock_selection_announcements a
     WHERE a.connection_id = v_connection.id AND a.stock_item_id = v_item
       AND (v_c.selection_ref IS NULL OR a.remote_selection_ref = v_c.selection_ref)
       AND a.status <> 'withdrawn'
     FOR SHARE OF a;
    -- Open while ITS activation is live; a conversation never bound to one
    -- keeps Step 5's rule until it is.
    IF NOT EXISTS (
      SELECT 1 FROM public.builder_stock_selection_announcements a
       WHERE a.connection_id = v_connection.id AND a.stock_item_id = v_item
         AND (v_c.selection_ref IS NULL OR (a.remote_selection_ref = v_c.selection_ref AND a.acknowledged_at IS NOT NULL))
         AND a.status <> 'withdrawn') THEN
      SELECT * INTO v_existing FROM public.builder_agency_messages WHERE id = v_message_id;
      IF v_existing.id IS NULL
         OR v_existing.conversation_id <> v_conversation_id OR v_existing.side <> 'command_centre'
         OR v_existing.body <> v_body OR v_existing.sender_display_name <> left(v_name, 200)
         OR v_existing.sent_at <> v_sent THEN
        v_reason := 'conversation_not_open';
      END IF;
      v_existing := NULL;
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT * INTO v_existing FROM public.builder_agency_messages WHERE id = v_message_id;
    IF v_existing.id IS NOT NULL
       AND (v_existing.conversation_id <> v_conversation_id OR v_existing.side <> 'command_centre'
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
    INSERT INTO public.builder_agency_messages(
      id, conversation_id, side, sender_display_name, body, sent_at, received_at)
    VALUES (v_message_id, v_conversation_id, 'command_centre', left(v_name, 200), v_body, v_sent, now())
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
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

  PERFORM public.builder_agency_enqueue(v_connection.id, 'agency.message.receipt',
    'agency.receipt:' || v_message_id || ':' || v_generation,
    jsonb_build_object('schema_version', 1, 'message_id', v_message_id,
      'conversation_id', v_conversation_id, 'generation', v_generation,
      'outcome', 'accepted'));
  RETURN 'applied';
END
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
       AND e.event_type IN ('agency.message.posted', 'agency.message.receipt', 'agency.message.participant')
       -- An event about a conversation never overtakes the activation it
       -- depends on (Step 5's rule, now for participants too).
       AND NOT (e.event_type IN ('agency.message.posted', 'agency.message.participant') AND EXISTS (
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

DROP TRIGGER IF EXISTS trg_builder_agency_message_lane ON public.builder_network_inbound_events;
CREATE TRIGGER trg_builder_agency_message_lane
  BEFORE INSERT ON public.builder_network_inbound_events
  FOR EACH ROW
  WHEN (NEW.event_type IN ('agency.message.posted', 'agency.message.receipt', 'agency.message.participant'))
  EXECUTE FUNCTION public.builder_agency_message_lane();

-- ---------------------------------------------------------------------------
-- 8. The builder company's own contact details travel with its properties.
--    Exactly the previous composer (20260925160000), plus three keys on the
--    organisation object, omitted when empty.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_compose_stock_item_payload(_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_i public.builder_stock_items;
  v_org record;
  v_img public.builder_stock_item_images;
  v_image jsonb := NULL;
  v_photos jsonb;
BEGIN
  SELECT * INTO v_i FROM public.builder_stock_items WHERE id = _item_id;
  IF v_i.id IS NULL THEN RETURN NULL; END IF;

  SELECT legal_name, trading_name, contact_email, contact_phone, website INTO v_org
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
          'source_column',                 v_img.source_detail->'source_column',
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

  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', g.id, 'position', g.n - 1, 'content_type', img.content_type)) ORDER BY g.n),
         '[]'::jsonb)
    INTO v_photos
    FROM unnest(public.builder_network_stock_item_gallery(v_i.id)) WITH ORDINALITY AS g(id, n)
    JOIN public.builder_stock_item_images img ON img.id = g.id
   WHERE g.n <= 12;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', v_i.id,
    'organisation_id', v_i.organisation_id,
    'upload_id', v_i.upload_id,
    'first_upload_id', v_i.first_upload_id,
    'created_by_builder_user_id', v_i.created_by_builder_user_id,
    'external_reference', v_i.external_reference,
    'development_name', v_i.development_name,
    'project_name', v_i.project_name,
    'address_line', COALESCE(v_i.manual_stats->'values'->>'address_line', v_i.address_line),
    'suburb',       COALESCE(v_i.manual_stats->'values'->>'suburb',       v_i.suburb),
    'state',        COALESCE(v_i.manual_stats->'values'->>'state',        v_i.state),
    'postcode',     COALESCE(v_i.manual_stats->'values'->>'postcode',     v_i.postcode),
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
    'manual_stats', CASE WHEN NOT COALESCE(v_i.manual_stats->'values' ?| ARRAY[
        'bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm'], false)
      THEN NULL ELSE
      jsonb_strip_nulls(jsonb_build_object(
        'values', jsonb_strip_nulls(jsonb_build_object(
          'bedrooms',          v_i.manual_stats->'values'->'bedrooms',
          'bathrooms',         v_i.manual_stats->'values'->'bathrooms',
          'car_spaces',        v_i.manual_stats->'values'->'car_spaces',
          'building_size_sqm', v_i.manual_stats->'values'->'building_size_sqm',
          'land_size_sqm',     v_i.manual_stats->'values'->'land_size_sqm')),
        'recorded_at', v_i.manual_stats->'recorded_at')) END,
    'item_created_at', v_i.created_at,
    'item_updated_at', v_i.updated_at,
    'organisation', jsonb_strip_nulls(jsonb_build_object(
      'id', v_i.organisation_id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name,
      'contact_email', nullif(btrim(v_org.contact_email), ''),
      'contact_phone', nullif(btrim(v_org.contact_phone), ''),
      'website', nullif(btrim(v_org.website), ''))),
    'primary_image', v_image,
    'media', jsonb_build_object(
      'schema_version', 1,
      'photos', v_photos,
      'documents', public.builder_network_property_documents(v_i.source_row))));
END $function$;

-- A changed company contact is a changed property to every agency listing it.
CREATE OR REPLACE FUNCTION public.builder_network_organisation_contact_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public.builder_network_enqueue_stock_item(i.id)
     FROM public.builder_stock_items i
    WHERE i.organisation_id = NEW.id AND i.lifecycle_status = 'active';
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_builder_network_organisation_contact_changed ON public.builder_organisations;
CREATE TRIGGER trg_builder_network_organisation_contact_changed
  AFTER UPDATE OF contact_email, contact_phone, website ON public.builder_organisations
  FOR EACH ROW
  WHEN (ROW(OLD.contact_email, OLD.contact_phone, OLD.website)
        IS DISTINCT FROM ROW(NEW.contact_email, NEW.contact_phone, NEW.website))
  EXECUTE FUNCTION public.builder_network_organisation_contact_changed();

-- ---------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.builder_agency_activation_conversation_id(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_member_display_name(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_announce_participant(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_join_local(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_is_participant(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_conversation_closed_reason(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_post_message(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_retry_message(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_invitee_eligible(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_invite_participant(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_invite_candidates(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_leave_conversation(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_open_activation_conversation(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_seed_activation_conversation(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_resolve_conversation(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_apply_participant_event(record, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_apply_message_event(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_agency_apply_message_events(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_compose_stock_item_payload(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_organisation_contact_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_agency_activation_conversation_id(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_is_participant(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_conversation_closed_reason(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_post_message(uuid, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_retry_message(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_invite_participant(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_invite_candidates(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_leave_conversation(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_seed_activation_conversation(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_agency_apply_message_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. Asserted by effect.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF public.builder_agency_activation_conversation_id(
       '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
     IS DISTINCT FROM md5('agency.activation:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002')::uuid THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the conversation id is not the shared derivation';
  END IF;
  IF has_table_privilege('authenticated', 'public.builder_agency_conversation_participants', 'SELECT')
     OR has_table_privilege('anon', 'public.builder_agency_conversation_participants', 'SELECT')
     OR has_function_privilege('authenticated', 'public.builder_agency_post_message(uuid,uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.builder_agency_invite_participant(uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a private conversation is reachable from a browser role';
  END IF;
  IF position('builder_agency_open_activation_conversation' IN
       pg_get_functiondef('public.builder_stock_acknowledge_announcement(uuid,uuid,uuid)'::regprocedure)) = 0
     OR position('activation_task_id' IN
       pg_get_functiondef('public.builder_stock_acknowledge_announcement(uuid,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: acknowledging does not open the conversation and close its task';
  END IF;
END $$;

COMMIT;

-- The builder company's contact details reach every agency now, not only on
-- the next change: each live property of an organisation that states any is
-- sent once more (idempotent at the receiver).
SELECT public.builder_network_enqueue_stock_item(i.id)
  FROM public.builder_stock_items i
  JOIN public.builder_organisations o ON o.id = i.organisation_id
 WHERE i.lifecycle_status = 'active'
   AND (nullif(btrim(o.contact_email), '') IS NOT NULL OR nullif(btrim(o.contact_phone), '') IS NOT NULL
        OR nullif(btrim(o.website), '') IS NOT NULL);
