-- ============================================================================
-- THE RESET ATTEMPT COMPARES THE HASH FIRST
--
-- `consume_builder_portal_reset_attempt` answered `too_many` and `expired`
-- BEFORE it had looked at the code the caller sent, and
-- `builder-portal-reset-password` renders those two as distinguishable
-- responses: 429 "Too many incorrect attempts", 400 "This code has expired",
-- 400 "Invalid or expired code". So the branches were an account oracle.
--
-- Request a reset for an address, then post six wrong six-digit codes at it.
-- An address with NO account has no row for the function to find and answers
-- `not_found` — the generic 400 — every single time. An address WITH an
-- account has its `reset_attempts` incremented past the ceiling by the sixth
-- try and answers `too_many`, a 429. Six requests, no code guessed, and the
-- caller now knows whether somebody works there. The same leak runs through
-- `expired`: any address whose reset code has aged out says so, which no
-- address without an account can ever say.
--
-- The fix is an ORDER, not a new rule. The hash comparison — which already
-- reports a mismatch as `not_found` precisely so a wrong code is
-- indistinguishable from an unknown account (Phase 0 SEC-12) — moves ahead of
-- the two state branches. A caller who does not hold the code now gets
-- `not_found` whatever state the row is in, exactly as an unknown address
-- does. `expired` and `too_many` are still reported, still with their own
-- statuses and their own responses, but only to somebody who has proven they
-- hold the code and therefore already knows the account exists.
--
-- NOTHING ELSE MOVES. Same signature, same OUT columns, same status
-- vocabulary, same relative order of `too_many` before `expired`, and the same
-- attempt counting: the UPDATE at the top still increments on EVERY call that
-- finds a live reset row, so a wrong code costs an attempt exactly as it did
-- before. `builder-portal-reset-password` needs no change and gets none — it
-- already maps all four statuses and nothing it receives has changed shape.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.consume_builder_portal_reset_attempt(p_email text, p_token_hash text, p_max integer) RETURNS TABLE(status text, user_id uuid, invite_accepted_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
DECLARE
  v_id uuid; v_hash text; v_expires_at timestamptz; v_attempts integer;
  v_invite_accepted timestamptz;
BEGIN
  -- Every RETURNING target is table-qualified: this function's OUT columns
  -- include `user_id` and `invite_accepted_at`, and an unqualified reference in
  -- RETURNING resolves ambiguously against them, failing at runtime.
  --
  -- The attempt is consumed HERE, before any branch, which is what makes
  -- concurrent guesses share one counter. Reordering the answers below does
  -- not change that: a wrong code still costs an attempt.
  UPDATE public.builder_portal_users u
     SET reset_attempts = COALESCE(u.reset_attempts, 0) + 1
   WHERE u.id = (
     SELECT b.id FROM public.builder_portal_users b
      WHERE lower(btrim(b.email)) = lower(btrim(p_email))
        AND b.reset_token_hash IS NOT NULL
        AND b.is_active AND b.revoked_at IS NULL
      LIMIT 1)
  RETURNING u.id, u.reset_token_hash, u.reset_token_expires_at, u.reset_attempts, u.invite_accepted_at
       INTO v_id, v_hash, v_expires_at, v_attempts, v_invite_accepted;

  IF v_id IS NULL THEN
    status := 'not_found'; user_id := NULL; invite_accepted_at := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- Hash comparison. A mismatch is reported as not_found so a caller cannot
  -- distinguish "wrong code" from "no such account" (Phase 0 SEC-12).
  --
  -- IT COMES FIRST, and that placement is the whole point. Answering
  -- `too_many` or `expired` to somebody who has not produced the code tells
  -- them an account exists at this address, which is the one thing the generic
  -- answer above exists to withhold.
  IF p_token_hash IS NULL OR v_hash IS DISTINCT FROM p_token_hash THEN
    status := 'not_found'; user_id := NULL; invite_accepted_at := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- Past this line the caller holds the code, so the state of their own reset
  -- is theirs to be told about.
  IF v_attempts > p_max THEN
    status := 'too_many'; user_id := v_id; invite_accepted_at := v_invite_accepted;
    RETURN NEXT; RETURN;
  END IF;

  IF v_expires_at IS NULL OR v_expires_at < now() THEN
    status := 'expired'; user_id := v_id; invite_accepted_at := v_invite_accepted;
    RETURN NEXT; RETURN;
  END IF;

  status := 'ok'; user_id := v_id; invite_accepted_at := v_invite_accepted;
  RETURN NEXT;
END $function$;

REVOKE ALL ON FUNCTION public.consume_builder_portal_reset_attempt(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_builder_portal_reset_attempt(text, text, integer)
  TO service_role;

-- ===========================================================================
-- Assertions — both halves, or this migration has not applied
-- ===========================================================================
DO $assert$
DECLARE
  v_selftest_email text := 'migration-selftest-reset@aurixa.invalid';
  v_good_hash text := repeat('a', 64);
  v_wrong_hash text := repeat('b', 64);
  v_user_id uuid;
  v_status text;
  v_returned_id uuid;
  v_attempts integer;
BEGIN
  -- A throwaway account holding a live reset code. Every case below moves this
  -- one row between states, so the two halves are asserted against the SAME
  -- account rather than against a convenient one.
  INSERT INTO public.builder_portal_users(
    email, name, status, is_active, reset_token_hash, reset_token_expires_at, reset_attempts)
  VALUES (v_selftest_email, 'Migration Selftest', 'active', true,
          v_good_hash, now() + interval '1 hour', 0)
  RETURNING id INTO v_user_id;

  -- 1. THE ORACLE IS CLOSED — an EXPIRED row tells a wrong code nothing.
  UPDATE public.builder_portal_users
     SET reset_token_expires_at = now() - interval '1 hour', reset_attempts = 0
   WHERE id = v_user_id;
  SELECT r.status INTO v_status
    FROM public.consume_builder_portal_reset_attempt(v_selftest_email, v_wrong_hash, 5) r;
  IF v_status IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'assertion failed: an expired row answered % to a wrong code', v_status;
  END IF;

  -- 2. …and neither does an OVER-ATTEMPTED one.
  UPDATE public.builder_portal_users
     SET reset_token_expires_at = now() + interval '1 hour', reset_attempts = 99
   WHERE id = v_user_id;
  SELECT r.status INTO v_status
    FROM public.consume_builder_portal_reset_attempt(v_selftest_email, v_wrong_hash, 5) r;
  IF v_status IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'assertion failed: an over-attempted row answered % to a wrong code', v_status;
  END IF;

  -- 3. Which is exactly what an address with NO account answers. The leak was
  --    the difference between this line and the two above.
  SELECT r.status INTO v_status
    FROM public.consume_builder_portal_reset_attempt(
      'migration-selftest-nobody@aurixa.invalid', v_wrong_hash, 5) r;
  IF v_status IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'assertion failed: an unknown address answered %', v_status;
  END IF;

  -- 4. THE OTHER HALF — the statuses still work for whoever holds the code.
  --    A fix that closed the oracle by never reporting these would strand
  --    every real user behind the generic error.
  UPDATE public.builder_portal_users
     SET reset_token_expires_at = now() + interval '1 hour', reset_attempts = 99
   WHERE id = v_user_id;
  SELECT r.status INTO v_status
    FROM public.consume_builder_portal_reset_attempt(v_selftest_email, v_good_hash, 5) r;
  IF v_status IS DISTINCT FROM 'too_many' THEN
    RAISE EXCEPTION 'assertion failed: a correct code over the ceiling answered %', v_status;
  END IF;

  UPDATE public.builder_portal_users
     SET reset_token_expires_at = now() - interval '1 hour', reset_attempts = 0
   WHERE id = v_user_id;
  SELECT r.status INTO v_status
    FROM public.consume_builder_portal_reset_attempt(v_selftest_email, v_good_hash, 5) r;
  IF v_status IS DISTINCT FROM 'expired' THEN
    RAISE EXCEPTION 'assertion failed: a correct code on an expired row answered %', v_status;
  END IF;

  -- 5. And a correct code on a live row still succeeds, carrying the user id
  --    the handler updates by.
  UPDATE public.builder_portal_users
     SET reset_token_expires_at = now() + interval '1 hour', reset_attempts = 0
   WHERE id = v_user_id;
  SELECT r.status, r.user_id INTO v_status, v_returned_id
    FROM public.consume_builder_portal_reset_attempt(v_selftest_email, v_good_hash, 5) r;
  IF v_status IS DISTINCT FROM 'ok' OR v_returned_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'assertion failed: a correct code on a live row answered % for %',
      v_status, v_returned_id;
  END IF;

  -- 6. The attempt counting is UNCHANGED: a wrong code still costs an attempt,
  --    which is the only thing standing between this endpoint and an unbounded
  --    guessing loop.
  UPDATE public.builder_portal_users SET reset_attempts = 0 WHERE id = v_user_id;
  PERFORM public.consume_builder_portal_reset_attempt(v_selftest_email, v_wrong_hash, 5);
  SELECT reset_attempts INTO v_attempts
    FROM public.builder_portal_users WHERE id = v_user_id;
  IF v_attempts <> 1 THEN
    RAISE EXCEPTION 'assertion failed: a wrong code left reset_attempts at %', v_attempts;
  END IF;

  -- The self-test account is proof, not a user: it goes with the proof.
  DELETE FROM public.builder_portal_users WHERE id = v_user_id;
END $assert$;
