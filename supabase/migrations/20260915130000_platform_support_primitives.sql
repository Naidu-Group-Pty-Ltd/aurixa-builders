-- ============================================================================
-- Platform support primitives the active runtime calls and the squash left
-- behind.
--
-- The runtime-contract sweep (baseline-check §4, added with this remediation)
-- extracts every `.from()` / `.rpc()` literal in the ACTIVE functions and
-- proves it against the rebuilt schema. Its first run found six objects the
-- extraction never carried, each with a live caller:
--
--   check_and_bump_rate_limit        builder-portal-register / verify-email —
--                                    the RPC errored, the error was read as
--                                    "no answer", and the PUBLIC registration
--                                    door ran with its rate limit silently OFF.
--   security_consume_rate_limit      authRateLimit.ts tier 1 — every auth
--                                    limiter fell to its per-isolate memory
--                                    tier (a real ceiling, but per-isolate).
--   provider_circuit_*               llmRouter breakers for the stock image /
--                                    extraction providers.
--   agent_model_assignments          llmRouter THROWS when this table is
--                                    unreadable — every model-driven stock
--                                    import (PDF / URL extraction) failed.
--   api_usage_log                    logApiUsage — metering lost, one warning
--                                    per outbound call.
--   record_portal_operational_event  login failure telemetry, projects,
--                                    document processor.
--   global_report_settings           brand-config — fell back to compiled
--                                    defaults on every email send.
--
-- Everything below is the PRIME's own definition, ported: the rate-limit and
-- circuit primitives from 20260722000000 / 20260725120000 / 20260803020000
-- (the repair migration's header carries the six-week outage that taught the
-- fail-open rule), the observability RPC from 20260730290000 (the standalone
-- already carries both tables it writes), and the three tables at their
-- current prime shape with clone-side foreign keys omitted — the boundary
-- rule: no FK may leave the network.
-- ============================================================================

-- ===========================================================================
-- 1. Rate-limit store and primitives
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  bucket_key   text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_rate_limits_bucket_key_length
    CHECK (char_length(bucket_key) BETWEEN 1 AND 200)
);
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) touches this table.
REVOKE ALL ON public.auth_rate_limits FROM anon, authenticated;
GRANT ALL ON public.auth_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.check_and_bump_rate_limit(
  p_key text, p_max integer, p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF char_length(p_key) NOT BETWEEN 1 AND 200
     OR p_max < 1
     OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate-limit parameters' USING ERRCODE = '22023';
  END IF;

  -- Amortized bounded cleanup avoids a full-table delete on a public request.
  DELETE FROM public.auth_rate_limits
  WHERE ctid IN (
    SELECT ctid
    FROM public.auth_rate_limits
    WHERE updated_at < now() - interval '24 hours'
    ORDER BY updated_at
    LIMIT 100
  );

  INSERT INTO public.auth_rate_limits AS limits (bucket_key, window_start, count, updated_at)
    VALUES (p_key, now(), 1, now())
  ON CONFLICT (bucket_key) DO UPDATE
    SET count = CASE WHEN limits.window_start < now() - make_interval(secs => p_window_seconds)
                     THEN 1 ELSE limits.count + 1 END,
        window_start = CASE WHEN limits.window_start < now() - make_interval(secs => p_window_seconds)
                     THEN now() ELSE limits.window_start END,
        updated_at = now()
  RETURNING limits.count INTO v_count;

  RETURN v_count <= p_max;
END
$$;

REVOKE ALL ON FUNCTION public.check_and_bump_rate_limit(text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_bump_rate_limit(text,integer,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.security_consume_rate_limit(
  p_key text, p_max integer, p_window_seconds integer
) RETURNS TABLE(allowed boolean, count integer, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
  v_window_start timestamptz;
BEGIN
  IF p_key !~ '^[a-z0-9:_./-]{1,200}$' OR p_max < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate-limit parameters' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.auth_rate_limits AS limits (bucket_key, window_start, count, updated_at)
  VALUES (p_key, now(), 1, now())
  ON CONFLICT (bucket_key) DO UPDATE SET
    count = CASE WHEN limits.window_start <= now() - make_interval(secs => p_window_seconds) THEN 1 ELSE limits.count + 1 END,
    window_start = CASE WHEN limits.window_start <= now() - make_interval(secs => p_window_seconds) THEN now() ELSE limits.window_start END,
    updated_at = now()
  RETURNING limits.count, limits.window_start INTO v_count, v_window_start;
  RETURN QUERY SELECT v_count <= p_max, v_count, GREATEST(p_max - v_count, 0),
    GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => p_window_seconds) - now())))::integer);
END;
$$;
REVOKE ALL ON FUNCTION public.security_consume_rate_limit(text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.security_consume_rate_limit(text,integer,integer) TO service_role;

-- ===========================================================================
-- 2. Provider circuit breakers
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.provider_circuit_state (
  scope text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  opened_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.provider_circuit_state TO service_role;
REVOKE ALL ON public.provider_circuit_state FROM anon, authenticated;
ALTER TABLE public.provider_circuit_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.provider_circuit_record_failure(p_scope text, p_threshold integer, p_open_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_failures integer; v_opened timestamptz;
BEGIN
  INSERT INTO public.provider_circuit_state(scope, failures, updated_at) VALUES (p_scope, 1, now())
  ON CONFLICT (scope) DO UPDATE SET failures = public.provider_circuit_state.failures + 1, updated_at = now()
  RETURNING failures, opened_until INTO v_failures, v_opened;
  IF v_failures >= p_threshold THEN
    UPDATE public.provider_circuit_state SET opened_until = now() + make_interval(secs => p_open_seconds), failures = 0 WHERE scope = p_scope;
    RETURN true;
  END IF;
  RETURN false;
END; $$;

CREATE OR REPLACE FUNCTION public.provider_circuit_is_open(p_scope text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT opened_until > now() FROM public.provider_circuit_state WHERE scope = p_scope), false);
$$;

CREATE OR REPLACE FUNCTION public.provider_circuit_record_success(p_scope text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.provider_circuit_state WHERE scope = p_scope;
$$;

REVOKE ALL ON FUNCTION public.provider_circuit_record_failure(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_circuit_is_open(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_circuit_record_success(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_circuit_record_failure(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_circuit_is_open(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_circuit_record_success(text) TO service_role;

-- ===========================================================================
-- 3. The observability RPC (both tables it writes already travelled)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.record_portal_operational_event(_event_name text,_severity text,_correlation_id uuid,_request_id text,_actor_type text,_actor_id uuid,_portal text,_case_id uuid,_matter_id uuid,_firm_id uuid,_duration_ms integer,_success boolean,_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE e public.portal_operational_events%ROWTYPE; alert_name text; BEGIN
 IF _correlation_id IS NULL OR NULLIF(trim(_event_name),'') IS NULL OR NULLIF(trim(_actor_type),'') IS NULL OR NULLIF(trim(_portal),'') IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='OBSERVABILITY_DIMENSIONS_REQUIRED'; END IF;
 IF _severity NOT IN ('info','warning','high','critical') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVALID_EVENT_SEVERITY'; END IF;
 IF jsonb_path_exists(COALESCE(_metadata,'{}'), '$.**.keyvalue() ? (@.key like_regex "(?i)^(internal_notes|risk_notes|contract_text|raw_content|income|expenses|assets|liabilities|borrowing_capacity|smr|aml_restricted)$")') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SENSITIVE_TELEMETRY_FIELD_FORBIDDEN'; END IF;
 INSERT INTO public.portal_operational_events(event_name,severity,correlation_id,request_id,actor_type,actor_id,portal,case_id,matter_id,firm_id,duration_ms,success,metadata)
 VALUES(left(_event_name,120),_severity,_correlation_id,left(_request_id,200),left(_actor_type,80),_actor_id,left(_portal,80),_case_id,_matter_id,_firm_id,_duration_ms,_success,COALESCE(_metadata,'{}')) RETURNING * INTO e;
 alert_name:=CASE WHEN _event_name IN ('cross_firm_access_attempt','audit_chain_failure','mandatory_audit_write_failure','dead_lettered_settlement_event','document_malware_detected','client_projection_privacy_violation','cross_client_case_link_attempt','excessive_authentication_failures') THEN _event_name END;
 IF alert_name IS NOT NULL THEN INSERT INTO public.portal_operational_alerts(event_id,alert_type,severity,summary) VALUES(e.id,alert_name,CASE WHEN _severity='critical' THEN 'critical' ELSE 'high' END,left(replace(alert_name,'_',' '),240)); END IF;
 RETURN e.id;
END $$;

REVOKE ALL ON FUNCTION public.record_portal_operational_event(text,text,uuid,text,text,uuid,text,uuid,uuid,uuid,integer,boolean,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_portal_operational_event(text,text,uuid,text,text,uuid,text,uuid,uuid,uuid,integer,boolean,jsonb)
  TO service_role;

-- ===========================================================================
-- 4. Metering, model assignments, brand settings — current prime shapes,
--    clone-side foreign keys omitted (no FK may leave the network)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.api_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name text NOT NULL,
  endpoint text,
  tokens_used integer,
  prompt_tokens integer,
  completion_tokens integer,
  cost_estimate_usd numeric,
  response_time_ms integer,
  status text NOT NULL DEFAULT 'success',
  model_used text,
  metadata jsonb DEFAULT '{}'::jsonb,
  -- An opaque actor reference in the network edition; the prime's auth.users
  -- FK stays in the clone.
  user_id uuid,
  request_count integer NOT NULL DEFAULT 1,
  mc_reported_at timestamptz,
  mc_attempts integer NOT NULL DEFAULT 0,
  mc_billing_reason text,
  mc_last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_usage_log_service_time_idx
  ON public.api_usage_log (service_name, created_at DESC);
ALTER TABLE public.api_usage_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_usage_log FROM anon, authenticated;
GRANT ALL ON public.api_usage_log TO service_role;

CREATE TABLE IF NOT EXISTS public.agent_model_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key text NOT NULL UNIQUE,
  agent_label text NOT NULL,
  agent_category text NOT NULL DEFAULT 'general',
  agent_description text,
  route text NOT NULL DEFAULT 'gateway',
  model_id text NOT NULL,
  fallback_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  temperature numeric,
  max_tokens integer,
  reasoning_effort text,
  is_active boolean NOT NULL DEFAULT true,
  is_locked boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  last_error text,
  last_tested_at timestamptz,
  last_test_success boolean,
  last_test_result text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_model_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_model_assignments FROM anon, authenticated;
GRANT ALL ON public.agent_model_assignments TO service_role;
-- No seed rows: llmRouter's documented legacy fallback applies while the
-- table is empty, and assignments are an operator decision.

CREATE TABLE IF NOT EXISTS public.global_report_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL UNIQUE,
  setting_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.global_report_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.global_report_settings FROM anon, authenticated;
GRANT ALL ON public.global_report_settings TO service_role;
-- No seed rows: brand-config carries the Aurixa defaults in code and treats
-- an empty table as "use them".

-- ===========================================================================
-- 5. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text := '';
BEGIN
  IF to_regclass('public.auth_rate_limits') IS NULL THEN v_missing := v_missing || ' auth_rate_limits'; END IF;
  IF to_regclass('public.provider_circuit_state') IS NULL THEN v_missing := v_missing || ' provider_circuit_state'; END IF;
  IF to_regclass('public.api_usage_log') IS NULL THEN v_missing := v_missing || ' api_usage_log'; END IF;
  IF to_regclass('public.agent_model_assignments') IS NULL THEN v_missing := v_missing || ' agent_model_assignments'; END IF;
  IF to_regclass('public.global_report_settings') IS NULL THEN v_missing := v_missing || ' global_report_settings'; END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: missing%', v_missing;
  END IF;
  IF NOT (SELECT public.check_and_bump_rate_limit('post_migration:probe', 2, 60)) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: check_and_bump_rate_limit denied its first probe';
  END IF;
  DELETE FROM public.auth_rate_limits WHERE bucket_key = 'post_migration:probe';
  RAISE NOTICE 'platform support primitives installed (rate limits, circuits, telemetry, metering, assignments, settings)';
END $$;
