-- AN INVITATION WAITS FOR ITS INVITEE — WHOEVER THEY ALREADY ARE (doc 68).
--
-- Additive, and it changes no existing row: every membership and every account
-- reads the same after this as before it (the rebuild check proves it by
-- comparing both, whole, either side of this file).
--
--  1. A SEAT CARRIES ITS OWN INVITATION. The invite token lived in the
--     account's ONE slot (`builder_portal_users.invite_token_hash`), so a second
--     organisation inviting the same pending address replaced the first
--     organisation's token and its link stopped working with nothing to say
--     why. Each organisation's invitation now lives on that organisation's own
--     waiting seat: nothing any other organisation does can reach it. The
--     account slot stays, untouched, for the tokens the operator's doors mint
--     and for any issued before this.
--
--     A token may sit only on a seat that is waiting and live (CHECK), is
--     unique across seats (index), and is destroyed by whatever moves the seat
--     on — acceptance, suspension, removal, by any path (trigger) — so no
--     second function has to remember to clear it.
--
--  2. THE NAME THE INVITER TYPED. A waiting seat is drawn on the members list
--     under the name this organisation typed, never the account's: the account
--     carries another organisation's typed name or the person's registered
--     one, and showing either told an administrator where an address already
--     belonged. Bounded at the registration door's 200 characters.
--
--  3. SENDS ARE PACED. Invitations are sent after the answer, one reservation
--     at a time under a row lock: each send waits for its slot, slots are
--     spaced as the caller asks, and a reservation past the longest wait is
--     refused rather than queued without end.
--
--  4. ONE DELIVERY READING FOR THE WHOLE DEPLOYMENT, taken by sending a check
--     to a sink that belongs to nobody — never from a real invitation, so it
--     cannot say whether any particular address or message failed. One checker
--     at a time, and only once the last reading is stale.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.

-- ---------------------------------------------------------------------------
-- 1 and 2. The seat's own invitation, and the name the inviter typed.
-- ---------------------------------------------------------------------------
ALTER TABLE public.builder_organisation_memberships
  ADD COLUMN IF NOT EXISTS invite_token_hash text,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS invited_name text;

ALTER TABLE public.builder_organisation_memberships
  DROP CONSTRAINT IF EXISTS builder_memberships_token_on_waiting_seat;
ALTER TABLE public.builder_organisation_memberships
  ADD CONSTRAINT builder_memberships_token_on_waiting_seat
  CHECK (invite_token_hash IS NULL OR (status = 'invited' AND revoked_at IS NULL
                                       AND invite_token_expires_at IS NOT NULL));

-- The same shape the account slot holds (`builder_portal_users_invite_token_hash_check`):
-- a peppered HMAC-SHA256 in hex, never a plaintext token.
ALTER TABLE public.builder_organisation_memberships
  DROP CONSTRAINT IF EXISTS builder_memberships_invite_token_hash_check;
ALTER TABLE public.builder_organisation_memberships
  ADD CONSTRAINT builder_memberships_invite_token_hash_check
  CHECK (invite_token_hash IS NULL OR invite_token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE public.builder_organisation_memberships
  DROP CONSTRAINT IF EXISTS builder_memberships_invited_name_length;
ALTER TABLE public.builder_organisation_memberships
  ADD CONSTRAINT builder_memberships_invited_name_length
  CHECK (invited_name IS NULL OR char_length(invited_name) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX IF NOT EXISTS builder_memberships_invite_token_key
  ON public.builder_organisation_memberships (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

COMMENT ON COLUMN public.builder_organisation_memberships.invite_token_hash IS
  'The peppered hash of THIS seat''s own invitation (doc 68). Only on a waiting, '
  'live seat; destroyed when the seat stops waiting. Never plaintext.';
COMMENT ON COLUMN public.builder_organisation_memberships.invited_name IS
  'The name the inviting organisation typed. The members list shows it for a '
  'waiting seat, never the account''s own name.';

CREATE OR REPLACE FUNCTION public.builder_membership_invitation_ends()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM 'invited' OR NEW.revoked_at IS NOT NULL THEN
    NEW.invite_token_hash := NULL;
    NEW.invite_token_expires_at := NULL;
  END IF;
  RETURN NEW;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_membership_invitation_ends() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_builder_membership_invitation_ends ON public.builder_organisation_memberships;
CREATE TRIGGER trg_builder_membership_invitation_ends
  BEFORE UPDATE OF status, revoked_at ON public.builder_organisation_memberships
  FOR EACH ROW EXECUTE FUNCTION public.builder_membership_invitation_ends();

-- ---------------------------------------------------------------------------
-- 3. Paced sends.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.builder_email_send_pacing (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  next_slot_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.builder_email_send_pacing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_email_send_pacing FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_email_send_pacing TO service_role;

-- How long this send must wait for its slot, in milliseconds; NULL when the
-- queue is already longer than _max_wait_ms, in which case nothing is reserved.
CREATE OR REPLACE FUNCTION public.builder_reserve_email_send_slot(_spacing_ms integer, _max_wait_ms integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start timestamptz;
BEGIN
  IF _spacing_ms IS NULL OR _spacing_ms < 1 OR _spacing_ms > 60000
     OR _max_wait_ms IS NULL OR _max_wait_ms < 0 OR _max_wait_ms > 600000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BUILDER_EMAIL_PACING_INVALID';
  END IF;

  INSERT INTO public.builder_email_send_pacing (id, next_slot_at)
  VALUES (true, clock_timestamp())
  ON CONFLICT (id) DO NOTHING;

  -- One reservation at a time: every other caller waits on this row lock, and
  -- reads the slot this one leaves behind.
  SELECT greatest(next_slot_at, clock_timestamp()) INTO v_start
    FROM public.builder_email_send_pacing WHERE id FOR UPDATE;

  IF v_start > clock_timestamp() + make_interval(secs => _max_wait_ms / 1000.0) THEN
    RETURN NULL;
  END IF;

  UPDATE public.builder_email_send_pacing
     SET next_slot_at = v_start + make_interval(secs => _spacing_ms / 1000.0),
         updated_at = clock_timestamp()
   WHERE id;

  RETURN greatest(0, ceil(extract(epoch FROM (v_start - clock_timestamp())) * 1000))::integer;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_reserve_email_send_slot(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_reserve_email_send_slot(integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. One delivery reading for the deployment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.builder_email_delivery_health (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  state text CHECK (state IN ('operational', 'degraded')),
  checked_at timestamptz,
  check_started_at timestamptz
);
ALTER TABLE public.builder_email_delivery_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_email_delivery_health FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_email_delivery_health TO service_role;

-- True for exactly one caller once the reading is stale: that caller runs the
-- check. A check that never reports back releases its claim after _lease_seconds.
CREATE OR REPLACE FUNCTION public.builder_claim_email_delivery_check(_stale_after_seconds integer, _lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_claimed boolean;
BEGIN
  INSERT INTO public.builder_email_delivery_health (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  UPDATE public.builder_email_delivery_health
     SET check_started_at = clock_timestamp()
   WHERE id
     AND (checked_at IS NULL OR checked_at < clock_timestamp() - make_interval(secs => _stale_after_seconds))
     AND (check_started_at IS NULL OR check_started_at < clock_timestamp() - make_interval(secs => _lease_seconds))
  RETURNING true INTO v_claimed;
  RETURN coalesce(v_claimed, false);
END $fn$;

CREATE OR REPLACE FUNCTION public.builder_record_email_delivery_check(_state text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF _state IS NULL OR _state NOT IN ('operational', 'degraded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BUILDER_EMAIL_DELIVERY_STATE_INVALID';
  END IF;
  INSERT INTO public.builder_email_delivery_health (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  UPDATE public.builder_email_delivery_health
     SET state = _state, checked_at = clock_timestamp(), check_started_at = NULL
   WHERE id;
END $fn$;

-- The reading, and how long the send queue is — one number for the whole
-- deployment, measured on the database's clock.
CREATE OR REPLACE FUNCTION public.builder_email_delivery_reading()
RETURNS TABLE (state text, checked_at timestamptz, backlog_ms integer)
LANGUAGE sql
SET search_path TO 'public'
AS $fn$
  SELECT h.state, h.checked_at,
         greatest(0, coalesce(ceil(extract(epoch FROM (p.next_slot_at - clock_timestamp())) * 1000), 0))::integer
    FROM (SELECT true AS id) one
    LEFT JOIN public.builder_email_delivery_health h ON h.id = one.id
    LEFT JOIN public.builder_email_send_pacing p ON p.id = one.id
$fn$;

REVOKE ALL ON FUNCTION public.builder_claim_email_delivery_check(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_record_email_delivery_check(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_email_delivery_reading() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_claim_email_delivery_check(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_record_email_delivery_check(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_email_delivery_reading() TO service_role;
