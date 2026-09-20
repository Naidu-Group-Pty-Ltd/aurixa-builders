-- ============================================================================
-- A HARD MONTHLY CEILING ON BUILDER STOCK'S ASSISTED READER.
-- ============================================================================
--
-- US$10 per calendar month for `builder_stock_extraction`, covering BOTH the
-- primary model and the fallback, enforced before any provider is called.
--
-- WHY A RESERVATION AND NOT A BALANCE CHECK. "Read the spend, decide, then
-- call" is two statements with a gap between them, and Stock List uploads
-- process concurrently — six settler invocations fan out from one import. Ten
-- requests can each read $9.98 spent, each conclude there is room, and each
-- spend. The ceiling is then a suggestion.
--
-- So the decision and the commitment are ONE statement. `ai_budget_reserve`
-- is a single UPDATE whose WHERE clause carries the ceiling test:
--
--     UPDATE ... SET reserved = reserved + amount
--      WHERE committed + reserved + amount <= cap
--     RETURNING ...
--
-- Postgres takes a row lock for the duration of that UPDATE, so concurrent
-- callers serialise on the budget row and each one tests against what the
-- others have ALREADY reserved. A caller that does not fit gets zero rows
-- back, which is the refusal. There is no window in which two requests can
-- both believe the same dollar is free.
--
-- THE MONTH RESETS ITSELF. The primary key is (agent_key, period_month), and
-- `period_month` is derived from `now()` at UTC inside these functions. A new
-- calendar month is simply a row that does not exist yet, created on first
-- use with a fresh cap. Nothing has to run on a schedule to reset it — which
-- matters, because `THE_CLONING_ENGINE.md` records six pg_cron jobs that were
-- never scheduled at all, silently, and a ceiling whose reset depends on a
-- worker fails in the expensive direction under exactly that fault.
--
-- RESERVE HIGH, SETTLE TRUE. A reservation is the WORST case the request
-- could cost. The actual cost is known only after the provider answers —
-- OpenRouter returns it on every response — so `ai_budget_settle` moves the
-- true figure into `committed` and hands the difference back. An abandoned
-- reservation (the Edge Function was killed mid-call) is reclaimed on the next
-- reserve, because a leaked hold would otherwise eat the month.
--
-- WHAT THIS IS NOT. It is not a second billing system. `api_usage_log` remains
-- the ledger of what was spent and on whose credential; this table answers a
-- different question — may this call happen at all — and is the only thing
-- that can answer it before the money is spent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The ceiling, one row per agent per calendar month.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_spend_budgets (
  agent_key        text        NOT NULL,
  period_month     date        NOT NULL,
  cap_micros       bigint      NOT NULL,
  -- Settled spend. Only `ai_budget_settle` moves money here.
  committed_micros bigint      NOT NULL DEFAULT 0,
  -- Held by calls in flight. Released or committed when each one finishes.
  reserved_micros  bigint      NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_key, period_month),
  CONSTRAINT ai_spend_budgets_non_negative
    CHECK (cap_micros >= 0 AND committed_micros >= 0 AND reserved_micros >= 0)
);

ALTER TABLE public.ai_spend_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_spend_budgets FROM anon, authenticated;
GRANT ALL ON public.ai_spend_budgets TO service_role;

-- ---------------------------------------------------------------------------
-- 2. One row per hold, so a settle can be matched to its reserve.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_spend_reservations (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key     text        NOT NULL,
  period_month  date        NOT NULL,
  amount_micros bigint      NOT NULL CHECK (amount_micros >= 0),
  -- `open` is in flight. The other three are terminal and mutually exclusive.
  state         text        NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'settled', 'released', 'expired')),
  -- What it actually cost. Null until settled.
  actual_micros bigint      CHECK (actual_micros IS NULL OR actual_micros >= 0),
  model_id      text,
  route         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);

ALTER TABLE public.ai_spend_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_spend_reservations FROM anon, authenticated;
GRANT ALL ON public.ai_spend_reservations TO service_role;

-- Only open reservations are ever scanned (for reclamation), so the index is
-- partial: the settled rows are history and are never read by the hot path.
CREATE INDEX IF NOT EXISTS ai_spend_reservations_open_idx
  ON public.ai_spend_reservations (agent_key, period_month, created_at)
  WHERE state = 'open';

-- ---------------------------------------------------------------------------
-- 3. Reclaim holds whose caller never came back.
-- ---------------------------------------------------------------------------
-- An Edge Function killed on its resource limit leaves `open` forever. Without
-- this the month leaks a reservation at a time until nothing fits. Ten minutes
-- is comfortably past the 90 s the whole model chain is allowed, so a live
-- call can never be reclaimed out from under itself.
CREATE OR REPLACE FUNCTION public.ai_budget_reclaim_expired(
  p_agent_key text,
  p_period    date,
  p_older_than interval DEFAULT interval '10 minutes'
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_freed bigint := 0;
BEGIN
  WITH expired AS (
    UPDATE public.ai_spend_reservations
       SET state = 'expired', settled_at = now()
     WHERE agent_key = p_agent_key
       AND period_month = p_period
       AND state = 'open'
       AND created_at < now() - p_older_than
    RETURNING amount_micros
  )
  SELECT COALESCE(sum(amount_micros), 0) INTO v_freed FROM expired;

  IF v_freed > 0 THEN
    UPDATE public.ai_spend_budgets b
       SET reserved_micros = GREATEST(b.reserved_micros - v_freed, 0),
           updated_at = now()
     WHERE b.agent_key = p_agent_key AND b.period_month = p_period;
  END IF;

  RETURN v_freed;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. RESERVE — the atomic decision.
-- ---------------------------------------------------------------------------
-- Returns `granted = false` and no reservation id when the amount does not fit
-- under the ceiling. The caller must treat that as a refusal to call any
-- provider at all; there is deliberately no "over-cap but close enough" path.
CREATE OR REPLACE FUNCTION public.ai_budget_reserve(
  p_agent_key     text,
  p_amount_micros bigint,
  p_cap_micros    bigint,
  p_model_id      text DEFAULT NULL,
  p_route         text DEFAULT NULL
) RETURNS TABLE (
  granted          boolean,
  reservation_id   uuid,
  remaining_micros bigint,
  cap_micros       bigint,
  committed_micros bigint,
  reserved_micros  bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period date := (date_trunc('month', now() AT TIME ZONE 'utc'))::date;
  v_row    public.ai_spend_budgets%ROWTYPE;
  v_id     uuid;
BEGIN
  -- A month that has not been used yet IS the reset. The cap travels from the
  -- caller so the ceiling stays stated in one place in the application.
  INSERT INTO public.ai_spend_budgets (agent_key, period_month, cap_micros)
  VALUES (p_agent_key, v_period, p_cap_micros)
  ON CONFLICT (agent_key, period_month) DO NOTHING;

  PERFORM public.ai_budget_reclaim_expired(p_agent_key, v_period);

  -- THE WHOLE CEILING, IN ONE STATEMENT. The row lock this UPDATE takes is
  -- what makes concurrent callers see each other's holds.
  UPDATE public.ai_spend_budgets b
     SET reserved_micros = b.reserved_micros + p_amount_micros,
         updated_at      = now()
   WHERE b.agent_key = p_agent_key
     AND b.period_month = v_period
     AND b.committed_micros + b.reserved_micros + p_amount_micros <= b.cap_micros
  RETURNING b.* INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.ai_spend_budgets
     WHERE agent_key = p_agent_key AND period_month = v_period;
    RETURN QUERY SELECT
      false, NULL::uuid,
      GREATEST(COALESCE(v_row.cap_micros, p_cap_micros)
               - COALESCE(v_row.committed_micros, 0)
               - COALESCE(v_row.reserved_micros, 0), 0),
      COALESCE(v_row.cap_micros, p_cap_micros),
      COALESCE(v_row.committed_micros, 0),
      COALESCE(v_row.reserved_micros, 0);
    RETURN;
  END IF;

  INSERT INTO public.ai_spend_reservations
    (agent_key, period_month, amount_micros, model_id, route)
  VALUES (p_agent_key, v_period, p_amount_micros, p_model_id, p_route)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT
    true, v_id,
    GREATEST(v_row.cap_micros - v_row.committed_micros - v_row.reserved_micros, 0),
    v_row.cap_micros, v_row.committed_micros, v_row.reserved_micros;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. SETTLE — the hold becomes the truth.
-- ---------------------------------------------------------------------------
-- `p_actual_micros` is the provider's own reported cost where there is one.
-- It is CLAMPED to the reservation: a settle can never commit more than was
-- held, because the held amount is what the ceiling test admitted. If a
-- provider ever reported more than the worst case we computed, the ledger
-- records the hold and the discrepancy is visible in `api_usage_log` rather
-- than silently blowing the cap.
CREATE OR REPLACE FUNCTION public.ai_budget_settle(
  p_reservation_id uuid,
  p_actual_micros  bigint
) RETURNS TABLE (settled boolean, committed_micros bigint, remaining_micros bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_res    public.ai_spend_reservations%ROWTYPE;
  v_actual bigint;
  v_row    public.ai_spend_budgets%ROWTYPE;
BEGIN
  -- Idempotent by construction: only an `open` reservation is claimed, so a
  -- retried settle after a lost response cannot double-charge.
  UPDATE public.ai_spend_reservations
     SET state = 'settled',
         actual_micros = LEAST(GREATEST(p_actual_micros, 0), amount_micros),
         settled_at = now()
   WHERE id = p_reservation_id AND state = 'open'
  RETURNING * INTO v_res;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  v_actual := v_res.actual_micros;

  -- QUALIFIED, because this function's OUT parameters are called
  -- `committed_micros` and `remaining_micros` and an unqualified reference on
  -- the right-hand side is ambiguous between the column and the variable.
  -- Postgres raises 42702 at RUNTIME, not at CREATE — the function compiles
  -- and fails on first use, which is why it was found by calling it rather
  -- than by reading it.
  UPDATE public.ai_spend_budgets b
     SET committed_micros = b.committed_micros + v_actual,
         reserved_micros  = GREATEST(b.reserved_micros - v_res.amount_micros, 0),
         updated_at = now()
   WHERE b.agent_key = v_res.agent_key AND b.period_month = v_res.period_month
  RETURNING b.* INTO v_row;

  RETURN QUERY SELECT true, v_row.committed_micros,
    GREATEST(v_row.cap_micros - v_row.committed_micros - v_row.reserved_micros, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. RELEASE — nothing was spent, hand it all back.
-- ---------------------------------------------------------------------------
-- For the case where no provider was reached at all: an unconfigured
-- credential, a connection failure, a deadline spent before the first attempt.
CREATE OR REPLACE FUNCTION public.ai_budget_release(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res public.ai_spend_reservations%ROWTYPE;
BEGIN
  UPDATE public.ai_spend_reservations
     SET state = 'released', actual_micros = 0, settled_at = now()
   WHERE id = p_reservation_id AND state = 'open'
  RETURNING * INTO v_res;

  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.ai_spend_budgets b
     SET reserved_micros = GREATEST(b.reserved_micros - v_res.amount_micros, 0),
         updated_at = now()
   WHERE b.agent_key = v_res.agent_key AND b.period_month = v_res.period_month;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. STATUS — read-only, for operators and for the report.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_budget_status(p_agent_key text)
RETURNS TABLE (
  period_month     date,
  cap_micros       bigint,
  committed_micros bigint,
  reserved_micros  bigint,
  remaining_micros bigint,
  open_holds       bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.period_month, b.cap_micros, b.committed_micros, b.reserved_micros,
         GREATEST(b.cap_micros - b.committed_micros - b.reserved_micros, 0),
         (SELECT count(*) FROM public.ai_spend_reservations r
           WHERE r.agent_key = b.agent_key AND r.period_month = b.period_month
             AND r.state = 'open')
    FROM public.ai_spend_budgets b
   WHERE b.agent_key = p_agent_key
     AND b.period_month = (date_trunc('month', now() AT TIME ZONE 'utc'))::date;
$$;

REVOKE ALL ON FUNCTION public.ai_budget_reserve(text, bigint, bigint, text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_budget_settle(uuid, bigint) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_budget_release(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_budget_reclaim_expired(text, date, interval) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_budget_status(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_budget_reserve(text, bigint, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_budget_settle(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_budget_release(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_budget_reclaim_expired(text, date, interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_budget_status(text) TO service_role;
