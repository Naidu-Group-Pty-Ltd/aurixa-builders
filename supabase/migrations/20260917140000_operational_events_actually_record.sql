-- ============================================================================
-- OPERATIONAL EVENTS ACTUALLY RECORD
--
-- `portal_operational_events` was empty. Not sparse — EMPTY. Every operational
-- event this platform has ever tried to record has been thrown away, and the
-- whole alerting stream with it: malware detections, blocked stock
-- publications, dead-lettered network events, privacy violations, the lot.
--
-- The cause is one predicate. `record_portal_operational_event` screens the
-- metadata for sensitive field names with:
--
--     jsonb_path_exists(metadata, '$.**.keyvalue() ? (@.key like_regex "…")')
--
-- `$.**` walks EVERY node, scalars included, and `.keyvalue()` may only be
-- applied to an object. So the moment metadata carries any string or number —
-- which every real caller's does — the function raises
--
--     2203C: jsonpath item method .keyvalue() can only be applied to an object
--
-- and the caller either swallows it or rolls back. The screen meant to protect
-- the telemetry silently destroyed all of it.
--
-- The fix selects object nodes before asking for their keys:
--
--     'strict $.**?(@.type() == "object").keyvalue() ? (@.key like_regex "…")'
--
-- Nothing else about the function changes: the same required dimensions, the
-- same severity vocabulary, the same forbidden-field list, the same alert
-- escalation. The screen still refuses a forbidden key at any depth, including
-- inside an array of objects — the assertions below prove both halves, because
-- a fix that recorded everything by weakening the screen would be worse than
-- the bug.
--
-- Found while verifying that the newly closed registration door records its
-- refusals. It did not. Now it does.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_portal_operational_event(
  _event_name text, _severity text, _correlation_id uuid, _request_id text,
  _actor_type text, _actor_id uuid, _portal text, _case_id uuid, _matter_id uuid,
  _firm_id uuid, _duration_ms integer, _success boolean,
  _metadata jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE e public.portal_operational_events%ROWTYPE; alert_name text;
BEGIN
  IF _correlation_id IS NULL OR NULLIF(trim(_event_name),'') IS NULL
     OR NULLIF(trim(_actor_type),'') IS NULL OR NULLIF(trim(_portal),'') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OBSERVABILITY_DIMENSIONS_REQUIRED';
  END IF;
  IF _severity NOT IN ('info','warning','high','critical') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_EVENT_SEVERITY';
  END IF;
  -- THE FIX: only object nodes are asked for their keys. `$.**` alone yields
  -- scalars too, and `.keyvalue()` on a scalar is a hard error that took the
  -- whole event with it.
  IF jsonb_path_exists(COALESCE(_metadata,'{}'),
       'strict $.**?(@.type() == "object").keyvalue() ? (@.key like_regex "(?i)^(internal_notes|risk_notes|contract_text|raw_content|income|expenses|assets|liabilities|borrowing_capacity|smr|aml_restricted)$")') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='SENSITIVE_TELEMETRY_FIELD_FORBIDDEN';
  END IF;
  INSERT INTO public.portal_operational_events(
    event_name,severity,correlation_id,request_id,actor_type,actor_id,portal,
    case_id,matter_id,firm_id,duration_ms,success,metadata)
  VALUES(left(_event_name,120),_severity,_correlation_id,left(_request_id,200),
         left(_actor_type,80),_actor_id,left(_portal,80),_case_id,_matter_id,
         _firm_id,_duration_ms,_success,COALESCE(_metadata,'{}'))
  RETURNING * INTO e;
  alert_name := CASE WHEN _event_name IN (
    'cross_firm_access_attempt','audit_chain_failure','mandatory_audit_write_failure',
    'dead_lettered_settlement_event','document_malware_detected',
    'client_projection_privacy_violation','cross_client_case_link_attempt',
    'excessive_authentication_failures','builder_stock_publication_blocked',
    'builder_stock_image_processing_failed','builder_stock_source_enumeration_failed')
    THEN _event_name END;
  IF alert_name IS NOT NULL THEN
    INSERT INTO public.portal_operational_alerts(event_id,alert_type,severity,summary)
    VALUES(e.id,alert_name,CASE WHEN _severity='critical' THEN 'critical' ELSE 'high' END,
           left(replace(alert_name,'_',' '),240));
  END IF;
  RETURN e.id;
END $function$;

REVOKE ALL ON FUNCTION public.record_portal_operational_event(
  text,text,uuid,text,text,uuid,text,uuid,uuid,uuid,integer,boolean,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_portal_operational_event(
  text,text,uuid,text,text,uuid,text,uuid,uuid,uuid,integer,boolean,jsonb)
  TO service_role;

-- ===========================================================================
-- Assertions — both halves, or this migration has not applied
-- ===========================================================================
DO $assert$
DECLARE
  v_id uuid;
  v_caught boolean;
BEGIN
  -- 1. An ordinary event, of exactly the shape every real caller sends,
  --    RECORDS. This is the half that has never worked.
  v_id := public.record_portal_operational_event(
    'migration_selftest_records', 'info', gen_random_uuid(), 'migration-selftest',
    'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
    jsonb_build_object('reason','invitation_only','ip','203.0.113.7','count',3));
  IF v_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.portal_operational_events WHERE id = v_id) THEN
    RAISE EXCEPTION 'assertion failed: an ordinary operational event still does not record';
  END IF;

  -- 2. The screen still refuses a forbidden field — nested, which is where a
  --    weakened screen would quietly stop looking.
  v_caught := false;
  BEGIN
    PERFORM public.record_portal_operational_event(
      'migration_selftest_forbidden', 'info', gen_random_uuid(), 'migration-selftest',
      'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
      jsonb_build_object('outer', jsonb_build_object('internal_notes','must never land')));
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%SENSITIVE_TELEMETRY_FIELD_FORBIDDEN%' THEN v_caught := true;
    ELSE RAISE EXCEPTION 'assertion failed: forbidden metadata raised the wrong error (%)', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'assertion failed: a nested forbidden field was accepted';
  END IF;

  -- 3. …and inside an array of objects, too.
  v_caught := false;
  BEGIN
    PERFORM public.record_portal_operational_event(
      'migration_selftest_forbidden_array', 'info', gen_random_uuid(), 'migration-selftest',
      'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
      jsonb_build_object('list', jsonb_build_array(jsonb_build_object('aml_restricted', true))));
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%SENSITIVE_TELEMETRY_FIELD_FORBIDDEN%' THEN v_caught := true;
    ELSE RAISE EXCEPTION 'assertion failed: forbidden array metadata raised the wrong error (%)', SQLERRM;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'assertion failed: a forbidden field inside an array was accepted';
  END IF;

  -- The self-test rows are proof, not history: remove them so the stream
  -- starts clean for the events that matter.
  DELETE FROM public.portal_operational_events
   WHERE request_id = 'migration-selftest';
END $assert$;
