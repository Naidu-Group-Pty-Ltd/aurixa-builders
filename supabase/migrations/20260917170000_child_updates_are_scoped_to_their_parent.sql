-- ============================================================================
-- CHILD UPDATES ARE SCOPED TO THEIR PARENT
--
-- The security audit of 16 Sep 2026 found six guarded commands whose UPDATE
-- branch selected the row by primary key alone:
--
--     SELECT * INTO v_existing FROM public.builder_stages
--      WHERE id = _stage_id FOR UPDATE;          -- no parent predicate
--
-- The Edge Function authorised the PARENT (the project, the construction
-- case) and then, on the update path, deliberately passed NULL for it —
-- leaving the child id as the only selector. A signed-in builder with edit
-- rights on one of their own records could therefore rewrite another
-- organisation's stage, building, lot, construction stage, milestone or
-- variation approval, given only its UUID and row version. The delivery case
-- was the worst: the forged approval decision was written into the VICTIM's
-- own audit trail.
--
-- The INSERT branches were always correct — they validate the parent. Only
-- the UPDATE branches were missing the predicate.
--
-- THE FIX, and why it is the smallest safe one:
--
--   * Each UPDATE branch now selects `WHERE id = <child> AND <parent_col> =
--     <parent_param>`. One clause per function. Nothing else in any of the
--     six functions changes — not a column written, not an error code, not a
--     signature, not the INSERT path.
--   * A mismatched or absent parent now matches no row, so the function
--     raises its EXISTING `…_NOT_FOUND` error, which the handlers already map
--     to 404. A cross-tenant attempt is answered exactly like a typo, which
--     is also the right disclosure posture: it reveals nothing about whether
--     the target exists.
--   * Because the predicate lives in SQL, it holds for every present and
--     future caller, not only the handlers patched alongside this migration.
--
-- No data is read, written or deleted here. These are function replacements.
-- ============================================================================

-- ---------------------------------------------------------------- builder_upsert_stage
CREATE OR REPLACE FUNCTION public.builder_upsert_stage(_actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid, _stage_id uuid, _project_id uuid, _payload jsonb DEFAULT '{}'::jsonb, _expected_version bigint DEFAULT NULL::bigint, _reason text DEFAULT NULL::text) RETURNS public.builder_stages
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_existing public.builder_stages; v_row public.builder_stages; v_org uuid;
BEGIN
  IF _stage_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_stages
    WHERE id = _stage_id AND project_id = _project_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STAGE_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_stages SET
      name         = CASE WHEN _payload ? 'name' THEN _payload->>'name' ELSE name END,
      stage_number = CASE WHEN _payload ? 'stage_number' THEN _payload->>'stage_number' ELSE stage_number END,
      description  = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      status       = CASE WHEN _payload ? 'status' THEN _payload->>'status' ELSE status END,
      estimated_completion_date = CASE WHEN _payload ? 'estimated_completion_date'
        THEN (_payload->>'estimated_completion_date')::date ELSE estimated_completion_date END,
      actual_completion_date = CASE WHEN _payload ? 'actual_completion_date'
        THEN (_payload->>'actual_completion_date')::date ELSE actual_completion_date END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _project_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_projects WHERE id = _project_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_stages(project_id, name, stage_number, description,
      status, estimated_completion_date)
    VALUES (_project_id, _payload->>'name', _payload->>'stage_number', _payload->>'description',
      COALESCE(_payload->>'status','planned'), (_payload->>'estimated_completion_date')::date)
    RETURNING * INTO v_row;
  END IF;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_row.project_id;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _stage_id IS NULL THEN 'builder_stage_created' ELSE 'builder_stage_updated' END,
    'stage', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _stage_id IS NULL THEN NULL
         ELSE jsonb_build_object('name', v_existing.name, 'status', v_existing.status) END,
    jsonb_build_object('name', v_row.name, 'status', v_row.status, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('project_id', v_row.project_id));
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- builder_upsert_building
CREATE OR REPLACE FUNCTION public.builder_upsert_building(_actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid, _building_id uuid, _project_id uuid, _stage_id uuid DEFAULT NULL::uuid, _payload jsonb DEFAULT '{}'::jsonb, _expected_version bigint DEFAULT NULL::bigint, _reason text DEFAULT NULL::text) RETURNS public.builder_buildings
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_existing public.builder_buildings; v_row public.builder_buildings; v_org uuid;
BEGIN
  IF _building_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_buildings
    WHERE id = _building_id AND project_id = _project_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_BUILDING_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_buildings SET
      name          = CASE WHEN _payload ? 'name' THEN _payload->>'name' ELSE name END,
      building_code = CASE WHEN _payload ? 'building_code' THEN _payload->>'building_code' ELSE building_code END,
      level_count   = CASE WHEN _payload ? 'level_count' THEN (_payload->>'level_count')::integer ELSE level_count END,
      status        = CASE WHEN _payload ? 'status' THEN _payload->>'status' ELSE status END,
      stage_id      = COALESCE(_stage_id, stage_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _project_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_REQUIRED';
    END IF;
    INSERT INTO public.builder_buildings(project_id, stage_id, name, building_code, level_count, status)
    VALUES (_project_id, _stage_id, _payload->>'name', _payload->>'building_code',
            (_payload->>'level_count')::integer, COALESCE(_payload->>'status','planned'))
    RETURNING * INTO v_row;
  END IF;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_row.project_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _building_id IS NULL THEN 'builder_building_created' ELSE 'builder_building_updated' END,
    'building', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _building_id IS NULL THEN NULL ELSE jsonb_build_object('name', v_existing.name) END,
    jsonb_build_object('name', v_row.name, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('project_id', v_row.project_id));
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- builder_upsert_lot
CREATE OR REPLACE FUNCTION public.builder_upsert_lot(_actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid, _lot_id uuid, _project_id uuid, _stage_id uuid DEFAULT NULL::uuid, _payload jsonb DEFAULT '{}'::jsonb, _expected_version bigint DEFAULT NULL::bigint, _reason text DEFAULT NULL::text) RETURNS public.builder_lots
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_existing public.builder_lots; v_row public.builder_lots; v_org uuid;
BEGIN
  IF _lot_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_lots
    WHERE id = _lot_id AND project_id = _project_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_LOT_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_lots SET
      lot_number    = CASE WHEN _payload ? 'lot_number' THEN _payload->>'lot_number' ELSE lot_number END,
      plan_number   = CASE WHEN _payload ? 'plan_number' THEN _payload->>'plan_number' ELSE plan_number END,
      land_area_sqm = CASE WHEN _payload ? 'land_area_sqm' THEN (_payload->>'land_area_sqm')::numeric ELSE land_area_sqm END,
      frontage_m    = CASE WHEN _payload ? 'frontage_m' THEN (_payload->>'frontage_m')::numeric ELSE frontage_m END,
      titled        = CASE WHEN _payload ? 'titled' THEN (_payload->>'titled')::boolean ELSE titled END,
      titled_at     = CASE WHEN _payload ? 'titled_at' THEN (_payload->>'titled_at')::date ELSE titled_at END,
      status        = CASE WHEN _payload ? 'status' THEN _payload->>'status' ELSE status END,
      stage_id      = COALESCE(_stage_id, stage_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _project_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_REQUIRED';
    END IF;
    INSERT INTO public.builder_lots(project_id, stage_id, lot_number, plan_number,
      land_area_sqm, frontage_m, titled, status)
    VALUES (_project_id, _stage_id, _payload->>'lot_number', _payload->>'plan_number',
      (_payload->>'land_area_sqm')::numeric, (_payload->>'frontage_m')::numeric,
      COALESCE((_payload->>'titled')::boolean, false), COALESCE(_payload->>'status','planned'))
    RETURNING * INTO v_row;
  END IF;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_row.project_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _lot_id IS NULL THEN 'builder_lot_created' ELSE 'builder_lot_updated' END,
    'lot', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _lot_id IS NULL THEN NULL ELSE jsonb_build_object('lot_number', v_existing.lot_number) END,
    jsonb_build_object('lot_number', v_row.lot_number, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('project_id', v_row.project_id));
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- builder_upsert_construction_stage
CREATE OR REPLACE FUNCTION public.builder_upsert_construction_stage(_actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid, _stage_id uuid, _construction_case_id uuid, _payload jsonb DEFAULT '{}'::jsonb, _expected_version bigint DEFAULT NULL::bigint, _reason text DEFAULT NULL::text) RETURNS public.builder_construction_stages
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_existing public.builder_construction_stages; v_row public.builder_construction_stages;
        v_org uuid; v_case uuid;
BEGIN
  IF _stage_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_construction_stages
    WHERE id = _stage_id AND construction_case_id = _construction_case_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_STAGE_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_construction_stages SET
      name = CASE WHEN _payload ? 'name' THEN _payload->>'name' ELSE name END,
      stage_key = CASE WHEN _payload ? 'stage_key' THEN _payload->>'stage_key' ELSE stage_key END,
      sequence_number = CASE WHEN _payload ? 'sequence_number' THEN (_payload->>'sequence_number')::smallint ELSE sequence_number END,
      status = CASE WHEN _payload ? 'status' THEN _payload->>'status' ELSE status END,
      planned_start_date = CASE WHEN _payload ? 'planned_start_date' THEN (_payload->>'planned_start_date')::date ELSE planned_start_date END,
      planned_end_date = CASE WHEN _payload ? 'planned_end_date' THEN (_payload->>'planned_end_date')::date ELSE planned_end_date END,
      actual_start_date = CASE WHEN _payload ? 'actual_start_date' THEN (_payload->>'actual_start_date')::date ELSE actual_start_date END,
      actual_end_date = CASE WHEN _payload ? 'actual_end_date' THEN (_payload->>'actual_end_date')::date ELSE actual_end_date END,
      percent_complete = CASE WHEN _payload ? 'percent_complete' THEN (_payload->>'percent_complete')::numeric ELSE percent_complete END,
      notes = CASE WHEN _payload ? 'notes' THEN _payload->>'notes' ELSE notes END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _construction_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_construction_stages(construction_case_id, name, stage_key,
      sequence_number, status, planned_start_date, planned_end_date, notes)
    VALUES (_construction_case_id, _payload->>'name', COALESCE(_payload->>'stage_key','other'),
      COALESCE((_payload->>'sequence_number')::smallint, 1),
      COALESCE(_payload->>'status','not_started'),
      (_payload->>'planned_start_date')::date, (_payload->>'planned_end_date')::date,
      _payload->>'notes')
    RETURNING * INTO v_row;
  END IF;

  SELECT c.transaction_id INTO v_case FROM public.builder_construction_cases c
  WHERE c.id = v_row.construction_case_id;
  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_case;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _stage_id IS NULL THEN 'builder_construction_stage_created'
         ELSE 'builder_construction_stage_updated' END,
    'construction_stage', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _stage_id IS NULL THEN NULL ELSE jsonb_build_object('name', v_existing.name,
      'status', v_existing.status) END,
    jsonb_build_object('name', v_row.name, 'status', v_row.status,
                       'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- builder_upsert_milestone
CREATE OR REPLACE FUNCTION public.builder_upsert_milestone(_actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid, _milestone_id uuid, _construction_case_id uuid, _construction_stage_id uuid DEFAULT NULL::uuid, _payload jsonb DEFAULT '{}'::jsonb, _expected_version bigint DEFAULT NULL::bigint, _reason text DEFAULT NULL::text) RETURNS public.builder_construction_milestones
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_existing public.builder_construction_milestones;
        v_row public.builder_construction_milestones; v_org uuid; v_txn uuid;
BEGIN
  IF _milestone_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_construction_milestones
    WHERE id = _milestone_id AND construction_case_id = _construction_case_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MILESTONE_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    -- Status is NOT writable here: it moves only through the transition command.
    UPDATE public.builder_construction_milestones SET
      name = CASE WHEN _payload ? 'name' THEN _payload->>'name' ELSE name END,
      milestone_key = CASE WHEN _payload ? 'milestone_key' THEN _payload->>'milestone_key' ELSE milestone_key END,
      planned_date = CASE WHEN _payload ? 'planned_date' THEN (_payload->>'planned_date')::date ELSE planned_date END,
      is_customer_visible = CASE WHEN _payload ? 'is_customer_visible' THEN (_payload->>'is_customer_visible')::boolean ELSE is_customer_visible END,
      notes = CASE WHEN _payload ? 'notes' THEN _payload->>'notes' ELSE notes END,
      construction_stage_id = COALESCE(_construction_stage_id, construction_stage_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _construction_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_construction_milestones(construction_case_id,
      construction_stage_id, name, milestone_key, planned_date, is_customer_visible, notes)
    VALUES (_construction_case_id, _construction_stage_id, _payload->>'name',
      _payload->>'milestone_key', (_payload->>'planned_date')::date,
      COALESCE((_payload->>'is_customer_visible')::boolean, true), _payload->>'notes')
    RETURNING * INTO v_row;
  END IF;

  SELECT transaction_id INTO v_txn FROM public.builder_construction_cases
  WHERE id = v_row.construction_case_id;
  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_txn;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _milestone_id IS NULL THEN 'builder_milestone_created'
         ELSE 'builder_milestone_updated' END,
    'milestone', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _milestone_id IS NULL THEN NULL ELSE jsonb_build_object('name', v_existing.name) END,
    jsonb_build_object('name', v_row.name, 'status', v_row.status,
                       'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- builder_upsert_variation_approval
CREATE OR REPLACE FUNCTION public.builder_upsert_variation_approval(_actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid, _approval_id uuid, _variation_id uuid, _payload jsonb DEFAULT '{}'::jsonb, _expected_version bigint DEFAULT NULL::bigint, _reason text DEFAULT NULL::text) RETURNS public.builder_variation_approvals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_existing public.builder_variation_approvals;
        v_row public.builder_variation_approvals; v_case uuid;
BEGIN
  IF _approval_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_variation_approvals
    WHERE id = _approval_id AND variation_id = _variation_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_APPROVAL_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_variation_approvals SET
      approver_role = CASE WHEN _payload ? 'approver_role' THEN _payload->>'approver_role' ELSE approver_role END,
      approver_name = CASE WHEN _payload ? 'approver_name' THEN _payload->>'approver_name' ELSE approver_name END,
      decision = CASE WHEN _payload ? 'decision' THEN _payload->>'decision' ELSE decision END,
      decided_at = CASE WHEN _payload ? 'decision' AND _payload->>'decision' <> 'pending'
                        THEN COALESCE(decided_at, now()) ELSE decided_at END,
      comments = CASE WHEN _payload ? 'comments' THEN _payload->>'comments' ELSE comments END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _variation_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_VARIATION_NOT_FOUND';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_variations WHERE id = _variation_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_VARIATION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_variation_approvals(variation_id, approver_role, approver_name,
      decision, comments)
    VALUES (_variation_id, COALESCE(_payload->>'approver_role','purchaser'),
      _payload->>'approver_name', COALESCE(_payload->>'decision','pending'),
      _payload->>'comments')
    RETURNING * INTO v_row;
  END IF;

  SELECT construction_case_id INTO v_case FROM public.builder_variations
  WHERE id = v_row.variation_id;
  INSERT INTO public.builder_delivery_status_history(construction_case_id, entity_kind, entity_id,
    from_status, to_status, changed_by_type, changed_by_builder_user_id, changed_by_user_id, reason)
  VALUES (v_case, 'variation_approval', v_row.id,
    CASE WHEN _approval_id IS NULL THEN NULL ELSE v_existing.decision END,
    v_row.decision, _actor_type, _actor_builder_user_id, _actor_user_id, _reason);

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _approval_id IS NULL THEN 'builder_variation_approval_added'
         ELSE 'builder_variation_approval_updated' END,
    'variation_approval', v_row.id, public.builder_delivery_org(v_case), _actor_builder_user_id,
    CASE WHEN _approval_id IS NULL THEN NULL
         ELSE jsonb_build_object('decision', v_existing.decision) END,
    jsonb_build_object('decision', v_row.decision, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('variation_id', v_row.variation_id));
  RETURN v_row;
END $$;

-- ===========================================================================
-- Privileges: replaced functions keep their ACL, but state it explicitly so
-- this migration is correct whatever order it applies in.
-- ===========================================================================
DO $acl$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.builder_upsert_stage(uuid,text,uuid,uuid,uuid,jsonb,bigint,text)',
    'public.builder_upsert_building(uuid,text,uuid,uuid,uuid,uuid,jsonb,bigint,text)',
    'public.builder_upsert_lot(uuid,text,uuid,uuid,uuid,uuid,jsonb,bigint,text)',
    'public.builder_upsert_construction_stage(uuid,text,uuid,uuid,uuid,jsonb,bigint,text)',
    'public.builder_upsert_milestone(uuid,text,uuid,uuid,uuid,uuid,jsonb,bigint,text)',
    'public.builder_upsert_variation_approval(uuid,text,uuid,uuid,uuid,jsonb,bigint,text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END $acl$;

-- ===========================================================================
-- Assertions — the predicate is present in every one of the six, the
-- service role still holds EXECUTE, and neither public role does.
-- ===========================================================================
DO $assert$
DECLARE
  v_checks text[][] := ARRAY[
    ARRAY['public.builder_upsert_stage(uuid,text,uuid,uuid,uuid,jsonb,bigint,text)',              'project_id = _project_id FOR UPDATE'],
    ARRAY['public.builder_upsert_building(uuid,text,uuid,uuid,uuid,uuid,jsonb,bigint,text)',      'project_id = _project_id FOR UPDATE'],
    ARRAY['public.builder_upsert_lot(uuid,text,uuid,uuid,uuid,uuid,jsonb,bigint,text)',           'project_id = _project_id FOR UPDATE'],
    ARRAY['public.builder_upsert_construction_stage(uuid,text,uuid,uuid,uuid,jsonb,bigint,text)', 'construction_case_id = _construction_case_id FOR UPDATE'],
    ARRAY['public.builder_upsert_milestone(uuid,text,uuid,uuid,uuid,uuid,jsonb,bigint,text)',     'construction_case_id = _construction_case_id FOR UPDATE'],
    ARRAY['public.builder_upsert_variation_approval(uuid,text,uuid,uuid,uuid,jsonb,bigint,text)', 'variation_id = _variation_id FOR UPDATE']
  ];
  v_i integer;
  v_def text;
BEGIN
  FOR v_i IN 1 .. array_length(v_checks, 1) LOOP
    v_def := pg_get_functiondef(v_checks[v_i][1]::regprocedure);
    IF position(v_checks[v_i][2] IN v_def) = 0 THEN
      RAISE EXCEPTION 'assertion failed: % is missing its parent predicate (%)',
        v_checks[v_i][1], v_checks[v_i][2];
    END IF;
    IF NOT has_function_privilege('service_role', v_checks[v_i][1]::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'assertion failed: service_role lost EXECUTE on %', v_checks[v_i][1];
    END IF;
    IF has_function_privilege('anon', v_checks[v_i][1]::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_checks[v_i][1]::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'assertion failed: % is still callable by anon/authenticated', v_checks[v_i][1];
    END IF;
  END LOOP;
END $assert$;
