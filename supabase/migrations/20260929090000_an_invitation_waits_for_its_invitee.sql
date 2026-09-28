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
--     And it RECORDS WHAT IT WAS MINTED FOR (`invite_requires_password`) and
--     WHETHER ITS LINK WAS HANDED TO THE INVITER (`invite_link_handed`). On a
--     deployment with no mail provider the inviter holds a password-setting
--     link, and had it become a one-click join once the person started signing
--     in elsewhere, the inviter could accept on their behalf (independent
--     review of doc 68). A handed link therefore keeps the kind it was minted
--     for. A link only the mailbox holds follows the account, so a person
--     invited by two organisations before they had an account can accept both
--     (the second review) — but only where the account's own password was set
--     through such a link too (`builder_portal_users.password_set_by_mailbox_link_at`),
--     so a link minted before an inviter set the password through a handed link
--     does not become a join for the inviter's account (the third review). A
--     join minted AFTER that is the person's to accept like any other; on a
--     deployment with no mail provider the inviter holds whatever account they
--     set a password for (doc 68 §8).
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
--     refused rather than queued without end. A caller may name a SCOPE (an
--     organisation) and a ceiling on how many of its sends may wait at once,
--     so one organisation's burst cannot fill the queue that every other
--     organisation's invitations wait in. A scope whose send is refused is
--     stamped, so its own administrators can be told (the second review).
--
--  4. ONE DELIVERY READING FOR THE WHOLE DEPLOYMENT, taken by sending a check
--     to a sink that belongs to nobody — never from a real invitation, so it
--     cannot say whether any particular address or message failed. One checker
--     at a time, and only once the last reading is stale. Read under a scope,
--     it also says whether that scope's own sends were held back lately, and
--     never another scope's.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS — over
-- itself, and over an earlier draft of itself (whose function signatures are
-- dropped before the ones below are created). No database has run a draft:
-- the version is absent from production's ledger.

-- ---------------------------------------------------------------------------
-- 1 and 2. The seat's own invitation, and the name the inviter typed.
-- ---------------------------------------------------------------------------
ALTER TABLE public.builder_organisation_memberships
  ADD COLUMN IF NOT EXISTS invite_token_hash text,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS invite_requires_password boolean,
  ADD COLUMN IF NOT EXISTS invite_link_handed boolean,
  ADD COLUMN IF NOT EXISTS invited_name text;

ALTER TABLE public.builder_organisation_memberships
  DROP CONSTRAINT IF EXISTS builder_memberships_token_on_waiting_seat;
ALTER TABLE public.builder_organisation_memberships
  ADD CONSTRAINT builder_memberships_token_on_waiting_seat
  CHECK (invite_token_hash IS NULL OR (status = 'invited' AND revoked_at IS NULL
                                       AND invite_token_expires_at IS NOT NULL
                                       AND invite_requires_password IS NOT NULL
                                       AND invite_link_handed IS NOT NULL));

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
COMMENT ON COLUMN public.builder_organisation_memberships.invite_requires_password IS
  'What this seat''s token was minted for: true, a first invitation that sets a '
  'password; false, a join for an account that already signs in.';
COMMENT ON COLUMN public.builder_organisation_memberships.invite_link_handed IS
  'Whether this seat''s link was handed to the inviter (a deployment with no mail '
  'provider). A handed link keeps the kind it was minted for, and acceptance '
  'refuses it once the account no longer matches; a link only the mailbox holds '
  'follows the account.';
-- When the account's password was set by accepting a seat invitation that
-- only its mailbox held. Nothing else sets it, so NULL is every account whose
-- password came any other way — a handed link, an operator's link, a
-- registration — and for those a mailbox-held link keeps the kind it was
-- minted for. Existing accounts read NULL; no row is written.
ALTER TABLE public.builder_portal_users
  ADD COLUMN IF NOT EXISTS password_set_by_mailbox_link_at timestamptz;
COMMENT ON COLUMN public.builder_portal_users.password_set_by_mailbox_link_at IS
  'When this account''s password was set through a seat invitation only its mailbox '
  'held (doc 68). NULL for a password set any other way.';

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
    NEW.invite_requires_password := NULL;
    NEW.invite_link_handed := NULL;
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

-- One row per reserved send while it is still ahead, so a scope's queue can be
-- counted. Rows older than five minutes are removed by the next reservation.
CREATE TABLE IF NOT EXISTS public.builder_email_send_reservations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL CHECK (scope ~ '^[a-z0-9:_.-]{1,120}$'),
  slot_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS builder_email_send_reservations_scope_idx
  ON public.builder_email_send_reservations (scope, slot_at);
ALTER TABLE public.builder_email_send_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_email_send_reservations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_email_send_reservations TO service_role;
-- The identity column's sequence is a new object too, granted like one.
REVOKE ALL ON SEQUENCE public.builder_email_send_reservations_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.builder_email_send_reservations_id_seq TO service_role;

-- When each scope last had a send refused — for its own full share, or because
-- the whole queue was full — so that scope's administrators can be told their
-- invitation emails were held back. One row per scope, overwritten.
CREATE TABLE IF NOT EXISTS public.builder_email_send_scope_refusals (
  scope text PRIMARY KEY CHECK (scope ~ '^[a-z0-9:_.-]{1,120}$'),
  refused_at timestamptz NOT NULL
);
ALTER TABLE public.builder_email_send_scope_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_email_send_scope_refusals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.builder_email_send_scope_refusals TO service_role;

-- An earlier draft took two arguments; a database that ran it keeps that
-- signature beside this one unless it is dropped.
DROP FUNCTION IF EXISTS public.builder_reserve_email_send_slot(integer, integer);

-- How long this send must wait for its slot, in milliseconds; NULL when the
-- queue is already longer than _max_wait_ms, or when _scope already has
-- _scope_max_queued sends waiting — in either case nothing is reserved, and a
-- scope that was refused is stamped.
CREATE OR REPLACE FUNCTION public.builder_reserve_email_send_slot(
  _spacing_ms integer, _max_wait_ms integer, _scope text DEFAULT NULL, _scope_max_queued integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start timestamptz;
BEGIN
  IF _spacing_ms IS NULL OR _spacing_ms < 1 OR _spacing_ms > 60000
     OR _max_wait_ms IS NULL OR _max_wait_ms < 0 OR _max_wait_ms > 600000
     OR (_scope IS NOT NULL AND (_scope !~ '^[a-z0-9:_.-]{1,120}$'
                                 OR _scope_max_queued IS NULL OR _scope_max_queued < 1 OR _scope_max_queued > 1000))
     OR (_scope IS NULL AND _scope_max_queued IS NOT NULL) THEN
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
    IF _scope IS NOT NULL THEN
      INSERT INTO public.builder_email_send_scope_refusals (scope, refused_at)
      VALUES (_scope, clock_timestamp())
      ON CONFLICT (scope) DO UPDATE SET refused_at = excluded.refused_at;
    END IF;
    RETURN NULL;
  END IF;

  IF _scope IS NOT NULL THEN
    DELETE FROM public.builder_email_send_reservations
     WHERE slot_at < clock_timestamp() - interval '5 minutes';
    IF (SELECT count(*) FROM public.builder_email_send_reservations
         WHERE scope = _scope AND slot_at > clock_timestamp()) >= _scope_max_queued THEN
      INSERT INTO public.builder_email_send_scope_refusals (scope, refused_at)
      VALUES (_scope, clock_timestamp())
      ON CONFLICT (scope) DO UPDATE SET refused_at = excluded.refused_at;
      RETURN NULL;
    END IF;
    INSERT INTO public.builder_email_send_reservations (scope, slot_at) VALUES (_scope, v_start);
  END IF;

  UPDATE public.builder_email_send_pacing
     SET next_slot_at = v_start + make_interval(secs => _spacing_ms / 1000.0),
         updated_at = clock_timestamp()
   WHERE id;

  RETURN greatest(0, ceil(extract(epoch FROM (v_start - clock_timestamp())) * 1000))::integer;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_reserve_email_send_slot(integer, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_reserve_email_send_slot(integer, integer, text, integer) TO service_role;

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

-- An earlier draft took no arguments, and beside this one a call with none
-- would be ambiguous.
DROP FUNCTION IF EXISTS public.builder_email_delivery_reading();

-- The reading, and how long the send queue is — one number for the whole
-- deployment, measured on the database's clock — and, read under a scope,
-- whether THAT scope had a send refused within the window. No scope, no window,
-- or another scope's refusal all read false.
CREATE OR REPLACE FUNCTION public.builder_email_delivery_reading(
  _scope text DEFAULT NULL, _held_back_window_seconds integer DEFAULT NULL)
RETURNS TABLE (state text, checked_at timestamptz, backlog_ms integer, scope_held_back boolean)
LANGUAGE sql
SET search_path TO 'public'
AS $fn$
  SELECT h.state, h.checked_at,
         greatest(0, coalesce(ceil(extract(epoch FROM (p.next_slot_at - clock_timestamp())) * 1000), 0))::integer,
         coalesce((SELECT r.refused_at > clock_timestamp() - make_interval(secs => greatest(_held_back_window_seconds, 0))
                     FROM public.builder_email_send_scope_refusals r
                    WHERE r.scope = _scope), false)
    FROM (SELECT true AS id) one
    LEFT JOIN public.builder_email_delivery_health h ON h.id = one.id
    LEFT JOIN public.builder_email_send_pacing p ON p.id = one.id
$fn$;

REVOKE ALL ON FUNCTION public.builder_claim_email_delivery_check(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_record_email_delivery_check(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_email_delivery_reading(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_claim_email_delivery_check(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_record_email_delivery_check(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_email_delivery_reading(text, integer) TO service_role;
