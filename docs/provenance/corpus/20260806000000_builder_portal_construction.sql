-- Builder / Developer Portal — Construction: construction cases, construction
-- stages, milestones, progress updates, estimated completion dates and
-- photographs.
--
-- Additive only. Every earlier Builder object is reused unchanged.
--
-- Blueprint:
--   builder_transactions is the parent aggregate, exactly as builder_projects is
--   the parent of inventory. A construction case belongs to ONE transaction and
--   is reached through that transaction's project grant. There is no fourth
--   access table.
--
--     builder_transactions          -> builder_construction_cases
--     builder_transaction_status_history
--                                   -> builder_construction_status_history
--     builder_transition_transaction-> builder_transition_construction_case
--                                      builder_transition_milestone
--
-- DATA BOUNDARY: this module records the BUILD PROGRAMME only — dates,
-- milestones, percentage complete, site photographs. It deliberately holds no
-- build cost, margin, supplier price, contractor price, commission, client
-- financial position or AML determination. Progress CLAIMS (money) are a
-- separate module and are Finance-coordinated; a milestone here is a programme
-- event, never a payment trigger.

-- ===========================================================================
-- 0. Prerequisites
-- ===========================================================================

-- The scope gains `construction_case`. BOTH gates must accept it: the Phase 1
-- column CHECK and the trigger guard.
ALTER TABLE public.builder_membership_permissions
  DROP CONSTRAINT IF EXISTS builder_membership_permissions_scope_type_check;
ALTER TABLE public.builder_membership_permissions
  ADD CONSTRAINT builder_membership_permissions_scope_type_check
  CHECK (scope_type IN ('organisation','development','project','stage','unit',
                        'transaction','construction_case'));

CREATE OR REPLACE FUNCTION public.builder_guard_permission_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.scope_type NOT IN ('organisation', 'project', 'stage', 'unit',
                            'transaction', 'construction_case') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_SCOPE_NOT_AVAILABLE',
      DETAIL=format('scope_type %s is not available', NEW.scope_type);
  END IF;

  IF NEW.scope_type = 'organisation' THEN
    IF NEW.scope_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.builder_organisations WHERE id = NEW.scope_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.scope_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND',
      DETAIL='a narrower scope requires a scope_id';
  END IF;

  IF NEW.scope_type = 'project' AND NOT EXISTS (
    SELECT 1 FROM public.builder_projects WHERE id = NEW.scope_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
  END IF;
  IF NEW.scope_type = 'stage' AND NOT EXISTS (
    SELECT 1 FROM public.builder_stages WHERE id = NEW.scope_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
  END IF;
  IF NEW.scope_type = 'unit' AND NOT EXISTS (
    SELECT 1 FROM public.builder_units WHERE id = NEW.scope_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
  END IF;
  IF NEW.scope_type = 'transaction' AND NOT EXISTS (
    SELECT 1 FROM public.builder_transactions WHERE id = NEW.scope_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
  END IF;
  IF NEW.scope_type = 'construction_case' AND NOT EXISTS (
    SELECT 1 FROM public.builder_construction_cases WHERE id = NEW.scope_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND';
  END IF;

  RETURN NEW;
END $$;

ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session',
     'development', 'project', 'project_party', 'project_access',
     'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
     'reservation', 'allocation',
     'transaction', 'transaction_party', 'transaction_case_link',
     'construction_case', 'construction_stage', 'milestone',
     'progress_update', 'photograph'));

-- ===========================================================================
-- 1. Construction cases
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_construction_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One construction case per transaction. The transaction is the sale; the
  -- construction case is the build that fulfils it.
  transaction_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_transactions(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES public.builder_units(id) ON DELETE SET NULL,

  case_reference text,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','site_preparation','under_construction','on_hold',
                      'practical_completion','handover','completed','cancelled')),

  site_supervisor_name text,
  site_supervisor_email text,
  site_supervisor_phone text,

  -- The build programme. `estimated_completion_date` is the CURRENT estimate;
  -- every change to it is recorded in builder_construction_date_history, so the
  -- purchaser-visible history of slippage is auditable.
  site_start_date date,
  estimated_completion_date date,
  actual_completion_date date,
  practical_completion_date date,

  percent_complete numeric(5,2) NOT NULL DEFAULT 0
    CHECK (percent_complete >= 0 AND percent_complete <= 100),

  shared_summary text,
  builder_notes text,
  weather_delay_days integer NOT NULL DEFAULT 0 CHECK (weather_delay_days >= 0),
  variation_delay_days integer NOT NULL DEFAULT 0 CHECK (variation_delay_days >= 0),

  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_construction_cases_completion_order
    CHECK (actual_completion_date IS NULL OR site_start_date IS NULL
           OR actual_completion_date >= site_start_date)
);
CREATE INDEX IF NOT EXISTS builder_construction_cases_project_idx
  ON public.builder_construction_cases(project_id, status);
CREATE INDEX IF NOT EXISTS builder_construction_cases_unit_idx
  ON public.builder_construction_cases(unit_id);

COMMENT ON TABLE public.builder_construction_cases IS
  'The build programme for one transaction. Holds dates, progress and site contacts only: no build cost, margin, supplier price, contractor price or payment information.';

-- The construction case must sit under the same project and unit as its
-- transaction, or progress could be reported against another project's stock.
CREATE OR REPLACE FUNCTION public.builder_enforce_construction_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_project uuid; v_unit uuid;
BEGIN
  SELECT project_id, unit_id INTO v_project, v_unit
  FROM public.builder_transactions WHERE id = NEW.transaction_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
  END IF;
  IF NEW.project_id IS DISTINCT FROM v_project THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_PARENT_MISMATCH',
      DETAIL='the construction case names a different project than its transaction';
  END IF;
  IF NEW.unit_id IS NOT NULL AND v_unit IS NOT NULL AND NEW.unit_id IS DISTINCT FROM v_unit THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_PARENT_MISMATCH',
      DETAIL='the construction case names a different unit than its transaction';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_enforce_construction_parentage
  ON public.builder_construction_cases;
CREATE TRIGGER trg_builder_enforce_construction_parentage
  BEFORE INSERT OR UPDATE OF transaction_id, project_id, unit_id
  ON public.builder_construction_cases FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_construction_parentage();

-- ===========================================================================
-- 2. Construction stages and milestones
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_construction_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  stage_key text NOT NULL
    CHECK (stage_key IN ('site_preparation','base','frame','lockup','fixing',
                         'practical_completion','handover','other')),
  sequence_number smallint NOT NULL DEFAULT 1 CHECK (sequence_number > 0),
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','complete','on_hold','skipped')),
  planned_start_date date,
  planned_end_date date,
  actual_start_date date,
  actual_end_date date,
  percent_complete numeric(5,2) NOT NULL DEFAULT 0
    CHECK (percent_complete >= 0 AND percent_complete <= 100),
  notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (construction_case_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS builder_construction_stages_case_idx
  ON public.builder_construction_stages(construction_case_id, sequence_number);

CREATE TABLE IF NOT EXISTS public.builder_construction_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  construction_stage_id uuid
    REFERENCES public.builder_construction_stages(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  milestone_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','achieved','missed','waived')),
  planned_date date,
  achieved_date date,
  -- A milestone is a PROGRAMME event. It deliberately carries no amount and no
  -- payment flag: Finance owns build_progress_payments and the commission
  -- triggers on it. A progress claim references a milestone; it is not one.
  is_customer_visible boolean NOT NULL DEFAULT true,
  notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_construction_milestones_case_idx
  ON public.builder_construction_milestones(construction_case_id, status);
CREATE INDEX IF NOT EXISTS builder_construction_milestones_stage_idx
  ON public.builder_construction_milestones(construction_stage_id);

COMMENT ON TABLE public.builder_construction_milestones IS
  'A build programme event. Carries no amount and no payment flag — Finance owns build_progress_payments and every commission trigger.';

-- A stage or milestone must belong to the construction case it names.
CREATE OR REPLACE FUNCTION public.builder_enforce_milestone_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.construction_stage_id IS NULL THEN RETURN NEW; END IF;
  SELECT construction_case_id INTO v_parent
  FROM public.builder_construction_stages WHERE id = NEW.construction_stage_id;
  IF v_parent IS DISTINCT FROM NEW.construction_case_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MILESTONE_PARENT_MISMATCH',
      DETAIL='the stage belongs to a different construction case';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_milestone_parentage ON public.builder_construction_milestones;
CREATE TRIGGER trg_builder_milestone_parentage
  BEFORE INSERT OR UPDATE OF construction_case_id, construction_stage_id
  ON public.builder_construction_milestones FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_milestone_parentage();

-- ===========================================================================
-- 3. Progress updates and photographs
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_construction_progress_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  construction_stage_id uuid
    REFERENCES public.builder_construction_stages(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  body text,
  percent_complete numeric(5,2)
    CHECK (percent_complete IS NULL OR (percent_complete >= 0 AND percent_complete <= 100)),
  update_date date NOT NULL DEFAULT CURRENT_DATE,
  is_customer_visible boolean NOT NULL DEFAULT true,
  created_by_type text NOT NULL DEFAULT 'builder_user'
    CHECK (created_by_type IN ('builder_user','command_user','service_role','system')),
  created_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  created_by_user_id uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_construction_progress_case_idx
  ON public.builder_construction_progress_updates(construction_case_id, update_date DESC);

CREATE TABLE IF NOT EXISTS public.builder_construction_photographs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  progress_update_id uuid
    REFERENCES public.builder_construction_progress_updates(id) ON DELETE SET NULL,
  construction_stage_id uuid
    REFERENCES public.builder_construction_stages(id) ON DELETE SET NULL,
  -- The bytes live in storage. This row is the metadata and the access record;
  -- the path is never a public URL and is only ever handed out by an Edge
  -- Function that has already resolved the caller's permission.
  storage_path text NOT NULL CHECK (length(btrim(storage_path)) > 0),
  file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
  content_type text NOT NULL DEFAULT 'image/jpeg'
    CHECK (content_type IN ('image/jpeg','image/png','image/webp','image/heic')),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size > 0),
  caption text,
  taken_at timestamptz,
  is_customer_visible boolean NOT NULL DEFAULT true,
  uploaded_by_type text NOT NULL DEFAULT 'builder_user'
    CHECK (uploaded_by_type IN ('builder_user','command_user','service_role','system')),
  uploaded_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  uploaded_by_user_id uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (construction_case_id, storage_path)
);
CREATE INDEX IF NOT EXISTS builder_construction_photographs_case_idx
  ON public.builder_construction_photographs(construction_case_id, created_at DESC);

COMMENT ON TABLE public.builder_construction_photographs IS
  'Site photograph metadata. The storage path is never a public URL; it is handed out only by a function that has already resolved the caller''s permission.';

-- A photograph's stage and progress update must belong to the same case.
CREATE OR REPLACE FUNCTION public.builder_enforce_photograph_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.construction_stage_id IS NOT NULL THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_construction_stages WHERE id = NEW.construction_stage_id;
    IF v_parent IS DISTINCT FROM NEW.construction_case_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PHOTOGRAPH_PARENT_MISMATCH',
        DETAIL='the stage belongs to a different construction case';
    END IF;
  END IF;
  IF NEW.progress_update_id IS NOT NULL THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_construction_progress_updates WHERE id = NEW.progress_update_id;
    IF v_parent IS DISTINCT FROM NEW.construction_case_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PHOTOGRAPH_PARENT_MISMATCH',
        DETAIL='the progress update belongs to a different construction case';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_photograph_parentage ON public.builder_construction_photographs;
CREATE TRIGGER trg_builder_photograph_parentage
  BEFORE INSERT OR UPDATE OF construction_case_id, construction_stage_id, progress_update_id
  ON public.builder_construction_photographs FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_photograph_parentage();

-- Progress updates must belong to their stage's case too.
DROP TRIGGER IF EXISTS trg_builder_progress_parentage
  ON public.builder_construction_progress_updates;
CREATE TRIGGER trg_builder_progress_parentage
  BEFORE INSERT OR UPDATE OF construction_case_id, construction_stage_id
  ON public.builder_construction_progress_updates FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_milestone_parentage();

-- ===========================================================================
-- 4. Append-only history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_construction_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  entity_kind text NOT NULL CHECK (entity_kind IN ('case','stage','milestone')),
  entity_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  changed_by_type text NOT NULL DEFAULT 'system'
    CHECK (changed_by_type IN ('builder_user','command_user','service_role','system')),
  changed_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  changed_by_user_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_construction_status_history_idx
  ON public.builder_construction_status_history(construction_case_id, created_at DESC);

-- Estimated completion dates move. Every movement is recorded so a purchaser can
-- see the history of slippage rather than only the current estimate.
CREATE TABLE IF NOT EXISTS public.builder_construction_date_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  date_kind text NOT NULL
    CHECK (date_kind IN ('site_start','estimated_completion','practical_completion','actual_completion')),
  from_date date,
  to_date date,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  changed_by_type text NOT NULL DEFAULT 'system'
    CHECK (changed_by_type IN ('builder_user','command_user','service_role','system')),
  changed_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  changed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_construction_date_history_idx
  ON public.builder_construction_date_history(construction_case_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.builder_construction_history_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001',
    MESSAGE='BUILDER_CONSTRUCTION_HISTORY_APPEND_ONLY',
    DETAIL='construction history rows cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_construction_status_history_append_only
  ON public.builder_construction_status_history;
CREATE TRIGGER trg_builder_construction_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_construction_status_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_construction_history_append_only();
DROP TRIGGER IF EXISTS trg_builder_construction_date_history_append_only
  ON public.builder_construction_date_history;
CREATE TRIGGER trg_builder_construction_date_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_construction_date_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_construction_history_append_only();

-- ===========================================================================
-- 5. Permission resolution
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_resolve_construction_permission(
  _user_id uuid, _construction_case_id uuid, _permission_key text DEFAULT 'construction',
  _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_transaction_id uuid; v_project_id uuid; v_org uuid;
  v_base boolean; v_membership_id uuid; v_scoped text;
BEGIN
  SELECT transaction_id, project_id INTO v_transaction_id, v_project_id
  FROM public.builder_construction_cases WHERE id = _construction_case_id;
  IF v_project_id IS NULL THEN RETURN false; END IF;

  -- The project decision is authoritative for the construction key.
  v_base := public.builder_resolve_project_permission(
    _user_id, v_project_id, _permission_key, _level);
  IF NOT v_base THEN RETURN false; END IF;

  -- A denial on the parent TRANSACTION also denies its construction case: the
  -- build cannot be a way around a denial on the sale it fulfils.
  IF NOT public.builder_resolve_transaction_permission(
       _user_id, v_transaction_id, 'transactions', 'view') THEN
    RETURN false;
  END IF;

  SELECT a.organisation_id INTO v_org FROM public.builder_project_access a
  WHERE a.builder_user_id = _user_id AND a.project_id = v_project_id
    AND a.revoked_at IS NULL;
  IF v_org IS NULL THEN RETURN false; END IF;

  -- HARD GATE: an active membership is required BEFORE any override runs.
  SELECT membership_id INTO v_membership_id
  FROM public.builder_active_membership(_user_id, v_org);
  IF v_membership_id IS NULL THEN RETURN false; END IF;

  SELECT CASE _level WHEN 'view' THEN view_decision
                    WHEN 'edit' THEN edit_decision ELSE delete_decision END
  INTO v_scoped FROM public.builder_membership_permissions
  WHERE membership_id = v_membership_id AND permission_key = _permission_key
    AND scope_type = 'construction_case' AND scope_id = _construction_case_id;
  IF v_scoped = 'deny' THEN RETURN false; END IF;

  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.builder_accessible_construction_cases(
  _user_id uuid, _organisation_id uuid DEFAULT NULL, _permission_key text DEFAULT 'construction')
RETURNS TABLE (construction_case_id uuid, project_id uuid, transaction_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.project_id, c.transaction_id
  FROM public.builder_construction_cases c
  JOIN public.builder_accessible_projects(_user_id, _organisation_id, _permission_key) p
    ON p.project_id = c.project_id
  WHERE public.builder_resolve_construction_permission(_user_id, c.id, _permission_key, 'view');
$$;

-- ===========================================================================
-- 6. Guarded commands — write and trusted audit in ONE transaction
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_upsert_construction_case(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _construction_case_id uuid, _transaction_id uuid,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_construction_cases
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_construction_cases; v_row public.builder_construction_cases;
        v_org uuid; v_project uuid; v_unit uuid; d record;
BEGIN
  IF _construction_case_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_construction_cases
    WHERE id = _construction_case_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    -- Status is NOT writable here: it moves only through the transition command.
    UPDATE public.builder_construction_cases SET
      case_reference = CASE WHEN _payload ? 'case_reference' THEN _payload->>'case_reference' ELSE case_reference END,
      site_supervisor_name  = CASE WHEN _payload ? 'site_supervisor_name' THEN _payload->>'site_supervisor_name' ELSE site_supervisor_name END,
      site_supervisor_email = CASE WHEN _payload ? 'site_supervisor_email' THEN _payload->>'site_supervisor_email' ELSE site_supervisor_email END,
      site_supervisor_phone = CASE WHEN _payload ? 'site_supervisor_phone' THEN _payload->>'site_supervisor_phone' ELSE site_supervisor_phone END,
      percent_complete = CASE WHEN _payload ? 'percent_complete' THEN (_payload->>'percent_complete')::numeric ELSE percent_complete END,
      shared_summary = CASE WHEN _payload ? 'shared_summary' THEN _payload->>'shared_summary' ELSE shared_summary END,
      builder_notes  = CASE WHEN _payload ? 'builder_notes' THEN _payload->>'builder_notes' ELSE builder_notes END,
      weather_delay_days = CASE WHEN _payload ? 'weather_delay_days' THEN (_payload->>'weather_delay_days')::integer ELSE weather_delay_days END,
      variation_delay_days = CASE WHEN _payload ? 'variation_delay_days' THEN (_payload->>'variation_delay_days')::integer ELSE variation_delay_days END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _transaction_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_REQUIRED';
    END IF;
    SELECT project_id, unit_id INTO v_project, v_unit
    FROM public.builder_transactions WHERE id = _transaction_id;
    IF v_project IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_construction_cases(transaction_id, project_id, unit_id,
      case_reference, site_supervisor_name, site_supervisor_email, site_supervisor_phone,
      shared_summary, builder_notes)
    VALUES (_transaction_id, v_project, v_unit,
      _payload->>'case_reference', _payload->>'site_supervisor_name',
      _payload->>'site_supervisor_email', _payload->>'site_supervisor_phone',
      _payload->>'shared_summary', _payload->>'builder_notes')
    RETURNING * INTO v_row;
  END IF;

  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_row.transaction_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _construction_case_id IS NULL THEN 'builder_construction_case_created'
         ELSE 'builder_construction_case_updated' END,
    'construction_case', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _construction_case_id IS NULL THEN NULL
         ELSE jsonb_build_object('status', v_existing.status,
                                 'row_version', v_existing.row_version) END,
    jsonb_build_object('status', v_row.status, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('transaction_id', v_row.transaction_id));
  RETURN v_row;
END $$;

-- Dates move through their own command so every change is recorded with a
-- reason. A silent estimate change is exactly what a purchaser cannot audit.
CREATE OR REPLACE FUNCTION public.builder_set_construction_date(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _construction_case_id uuid, _date_kind text, _new_date date,
  _expected_version bigint, _reason text)
RETURNS public.builder_construction_cases
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_construction_cases; v_row public.builder_construction_cases;
        v_from date; v_org uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  IF _date_kind NOT IN ('site_start','estimated_completion','practical_completion','actual_completion') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_DATE_KIND';
  END IF;

  SELECT * INTO v_existing FROM public.builder_construction_cases
  WHERE id = _construction_case_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
  END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version);
  END IF;

  v_from := CASE _date_kind
    WHEN 'site_start' THEN v_existing.site_start_date
    WHEN 'estimated_completion' THEN v_existing.estimated_completion_date
    WHEN 'practical_completion' THEN v_existing.practical_completion_date
    ELSE v_existing.actual_completion_date END;

  UPDATE public.builder_construction_cases SET
    site_start_date = CASE WHEN _date_kind='site_start' THEN _new_date ELSE site_start_date END,
    estimated_completion_date = CASE WHEN _date_kind='estimated_completion' THEN _new_date ELSE estimated_completion_date END,
    practical_completion_date = CASE WHEN _date_kind='practical_completion' THEN _new_date ELSE practical_completion_date END,
    actual_completion_date = CASE WHEN _date_kind='actual_completion' THEN _new_date ELSE actual_completion_date END
  WHERE id = v_existing.id RETURNING * INTO v_row;

  INSERT INTO public.builder_construction_date_history(construction_case_id, date_kind,
    from_date, to_date, reason, changed_by_type, changed_by_builder_user_id, changed_by_user_id)
  VALUES (_construction_case_id, _date_kind, v_from, _new_date, left(btrim(_reason),1000),
    _actor_type, _actor_builder_user_id, _actor_user_id);

  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_row.transaction_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_construction_date_changed',
    'construction_case', v_row.id, v_org, _actor_builder_user_id,
    jsonb_build_object('date_kind', _date_kind, 'from', v_from),
    jsonb_build_object('date_kind', _date_kind, 'to', _new_date,
                       'row_version', v_row.row_version),
    left(btrim(_reason),1000), '{}'::jsonb);
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_is_construction_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    WHEN _from IN ('completed','cancelled') THEN false
    WHEN _to = 'cancelled' THEN true
    WHEN _from = 'on_hold' THEN _to IN ('site_preparation','under_construction')
    WHEN _to = 'on_hold' THEN _from IN ('site_preparation','under_construction')
    WHEN _from = 'not_started' THEN _to = 'site_preparation'
    WHEN _from = 'site_preparation' THEN _to = 'under_construction'
    WHEN _from = 'under_construction' THEN _to = 'practical_completion'
    WHEN _from = 'practical_completion' THEN _to IN ('handover','under_construction')
    WHEN _from = 'handover' THEN _to IN ('completed','practical_completion')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.builder_transition_construction_case(
  _construction_case_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.builder_construction_cases; v_history_id uuid; v_org uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  IF NOT public.builder_is_construction_transition_allowed(_from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION';
  END IF;

  SELECT * INTO c FROM public.builder_construction_cases
  WHERE id = _construction_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
  END IF;
  IF c.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION';
  END IF;
  IF c.status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS';
  END IF;

  UPDATE public.builder_construction_cases SET
    status = _to,
    practical_completion_date = CASE WHEN _to = 'practical_completion'
      THEN COALESCE(practical_completion_date, CURRENT_DATE) ELSE practical_completion_date END,
    actual_completion_date = CASE WHEN _to = 'completed'
      THEN COALESCE(actual_completion_date, CURRENT_DATE) ELSE actual_completion_date END,
    percent_complete = CASE WHEN _to = 'completed' THEN 100 ELSE percent_complete END
  WHERE id = _construction_case_id RETURNING * INTO c;

  INSERT INTO public.builder_construction_status_history(construction_case_id, entity_kind,
    entity_id, from_status, to_status, changed_by_type, changed_by_builder_user_id,
    changed_by_user_id, reason, metadata)
  VALUES (_construction_case_id, 'case', _construction_case_id, _from, _to, _actor_type,
    _actor_builder_user_id, _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', c.row_version))
  RETURNING id INTO v_history_id;

  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = c.transaction_id;
  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_construction_status_changed',
    'construction_case', c.id, v_org, _actor_builder_user_id,
    jsonb_build_object('status', _from),
    jsonb_build_object('status', _to, 'row_version', c.row_version),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_construction_stage(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _stage_id uuid, _construction_case_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_construction_stages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_construction_stages; v_row public.builder_construction_stages;
        v_org uuid; v_case uuid;
BEGIN
  IF _stage_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_construction_stages
    WHERE id = _stage_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.builder_upsert_milestone(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _milestone_id uuid, _construction_case_id uuid, _construction_stage_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_construction_milestones
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_construction_milestones;
        v_row public.builder_construction_milestones; v_org uuid; v_txn uuid;
BEGIN
  IF _milestone_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_construction_milestones
    WHERE id = _milestone_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.builder_is_milestone_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    WHEN _from = 'achieved' THEN false
    WHEN _to IN ('achieved','missed','waived') THEN _from IN ('pending','in_progress')
    WHEN _from = 'pending' THEN _to = 'in_progress'
    WHEN _from = 'in_progress' THEN _to = 'pending'
    WHEN _from IN ('missed','waived') THEN _to IN ('pending','in_progress')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.builder_transition_milestone(
  _milestone_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.builder_construction_milestones; v_history_id uuid; v_org uuid; v_txn uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  IF NOT public.builder_is_milestone_transition_allowed(_from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION';
  END IF;

  SELECT * INTO m FROM public.builder_construction_milestones
  WHERE id = _milestone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_MILESTONE_NOT_FOUND';
  END IF;
  IF m.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION';
  END IF;
  IF m.status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS';
  END IF;

  UPDATE public.builder_construction_milestones SET
    status = _to,
    achieved_date = CASE WHEN _to = 'achieved' THEN COALESCE(achieved_date, CURRENT_DATE)
                         ELSE achieved_date END
  WHERE id = _milestone_id RETURNING * INTO m;

  INSERT INTO public.builder_construction_status_history(construction_case_id, entity_kind,
    entity_id, from_status, to_status, changed_by_type, changed_by_builder_user_id,
    changed_by_user_id, reason, metadata)
  VALUES (m.construction_case_id, 'milestone', m.id, _from, _to, _actor_type,
    _actor_builder_user_id, _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', m.row_version))
  RETURNING id INTO v_history_id;

  SELECT transaction_id INTO v_txn FROM public.builder_construction_cases
  WHERE id = m.construction_case_id;
  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_txn;
  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_milestone_status_changed',
    'milestone', m.id, v_org, _actor_builder_user_id,
    jsonb_build_object('status', _from),
    jsonb_build_object('status', _to, 'row_version', m.row_version),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN to_jsonb(m);
END $$;

CREATE OR REPLACE FUNCTION public.builder_add_progress_update(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _construction_case_id uuid, _construction_stage_id uuid, _payload jsonb,
  _reason text DEFAULT NULL)
RETURNS public.builder_construction_progress_updates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.builder_construction_progress_updates; v_org uuid; v_txn uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_payload->>'title','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROGRESS_TITLE_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
  END IF;

  INSERT INTO public.builder_construction_progress_updates(construction_case_id,
    construction_stage_id, title, body, percent_complete, update_date, is_customer_visible,
    created_by_type, created_by_builder_user_id, created_by_user_id)
  VALUES (_construction_case_id, _construction_stage_id, _payload->>'title', _payload->>'body',
    (_payload->>'percent_complete')::numeric,
    COALESCE((_payload->>'update_date')::date, CURRENT_DATE),
    COALESCE((_payload->>'is_customer_visible')::boolean, true),
    _actor_type, _actor_builder_user_id, _actor_user_id)
  RETURNING * INTO v_row;

  -- The case's headline percentage follows the latest update that carries one.
  IF v_row.percent_complete IS NOT NULL THEN
    UPDATE public.builder_construction_cases SET percent_complete = v_row.percent_complete
    WHERE id = _construction_case_id;
  END IF;

  SELECT transaction_id INTO v_txn FROM public.builder_construction_cases
  WHERE id = _construction_case_id;
  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_txn;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_progress_update_added',
    'progress_update', v_row.id, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('title', v_row.title, 'percent_complete', v_row.percent_complete),
    _reason, jsonb_build_object('construction_case_id', _construction_case_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_add_construction_photograph(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _construction_case_id uuid, _payload jsonb, _reason text DEFAULT NULL)
RETURNS public.builder_construction_photographs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.builder_construction_photographs; v_org uuid; v_txn uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_payload->>'storage_path','')), '') IS NULL
     OR NULLIF(btrim(COALESCE(_payload->>'file_name','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PHOTOGRAPH_PATH_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
  END IF;

  INSERT INTO public.builder_construction_photographs(construction_case_id, progress_update_id,
    construction_stage_id, storage_path, file_name, content_type, byte_size, caption, taken_at,
    is_customer_visible, uploaded_by_type, uploaded_by_builder_user_id, uploaded_by_user_id)
  VALUES (_construction_case_id,
    NULLIF(_payload->>'progress_update_id','')::uuid,
    NULLIF(_payload->>'construction_stage_id','')::uuid,
    _payload->>'storage_path', _payload->>'file_name',
    COALESCE(_payload->>'content_type','image/jpeg'),
    NULLIF(_payload->>'byte_size','')::bigint, _payload->>'caption',
    NULLIF(_payload->>'taken_at','')::timestamptz,
    COALESCE((_payload->>'is_customer_visible')::boolean, true),
    _actor_type, _actor_builder_user_id, _actor_user_id)
  RETURNING * INTO v_row;

  SELECT transaction_id INTO v_txn FROM public.builder_construction_cases
  WHERE id = _construction_case_id;
  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_txn;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_construction_photograph_added',
    'photograph', v_row.id, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('file_name', v_row.file_name),
    _reason, jsonb_build_object('construction_case_id', _construction_case_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_delete_construction_photograph(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _construction_case_id uuid, _photograph_id uuid, _reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_construction_photographs; v_org uuid; v_txn uuid;
BEGIN
  SELECT * INTO v_existing FROM public.builder_construction_photographs
  WHERE id = _photograph_id AND construction_case_id = _construction_case_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PHOTOGRAPH_NOT_FOUND';
  END IF;

  DELETE FROM public.builder_construction_photographs WHERE id = v_existing.id;

  SELECT transaction_id INTO v_txn FROM public.builder_construction_cases
  WHERE id = _construction_case_id;
  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = v_txn;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_construction_photograph_removed',
    'photograph', v_existing.id, v_org, _actor_builder_user_id,
    jsonb_build_object('file_name', v_existing.file_name,
                       'storage_path', v_existing.storage_path), NULL,
    _reason, jsonb_build_object('construction_case_id', _construction_case_id));
  RETURN true;
END $$;

-- ===========================================================================
-- 7. Touch triggers
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_construction_cases','builder_construction_stages',
                           'builder_construction_milestones',
                           'builder_construction_progress_updates',
                           'builder_construction_photographs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 8. Role baseline
-- ===========================================================================
INSERT INTO public.builder_role_default_permissions
  (membership_role, permission_key, can_view, can_edit, can_delete) VALUES
  ('owner',         'construction', true,  true,  true),
  ('administrator', 'construction', true,  true,  true),
  ('manager',       'construction', true,  true,  false),
  ('member',        'construction', true,  true,  false),
  ('read_only',     'construction', true,  false, false)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 9. RLS and grants — deny by default
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_construction_cases','builder_construction_stages',
                           'builder_construction_milestones',
                           'builder_construction_progress_updates',
                           'builder_construction_photographs',
                           'builder_construction_status_history',
                           'builder_construction_date_history'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_service ON public.%I
      AS PERMISSIVE FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')$p$, t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

DO $$
DECLARE f text; a text;
BEGIN
  FOR f, a IN SELECT * FROM (VALUES
    ('builder_resolve_construction_permission','uuid, uuid, text, text'),
    ('builder_accessible_construction_cases','uuid, uuid, text'),
    ('builder_upsert_construction_case','uuid, text, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_set_construction_date','uuid, text, uuid, uuid, text, date, bigint, text'),
    ('builder_is_construction_transition_allowed','text, text'),
    ('builder_transition_construction_case','uuid, bigint, text, text, text, text, uuid, uuid'),
    ('builder_upsert_construction_stage','uuid, text, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_milestone','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_is_milestone_transition_allowed','text, text'),
    ('builder_transition_milestone','uuid, bigint, text, text, text, text, uuid, uuid'),
    ('builder_add_progress_update','uuid, text, uuid, uuid, uuid, jsonb, text'),
    ('builder_add_construction_photograph','uuid, text, uuid, uuid, jsonb, text'),
    ('builder_delete_construction_photograph','uuid, text, uuid, uuid, uuid, text')
  ) AS t(f, a) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f, a);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, a);
  END LOOP;
END $$;

-- ===========================================================================
-- 10. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_resolve_construction_permission','builder_accessible_construction_cases',
    'builder_upsert_construction_case','builder_set_construction_date',
    'builder_transition_construction_case','builder_upsert_construction_stage',
    'builder_upsert_milestone','builder_transition_milestone',
    'builder_add_progress_update','builder_add_construction_photograph',
    'builder_delete_construction_photograph','builder_enforce_construction_parentage',
    'builder_enforce_milestone_parentage','builder_enforce_photograph_parentage']) AS f
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: construction function(s) missing: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('builder_construction_cases','builder_construction_stages',
                      'builder_construction_milestones','builder_construction_progress_updates',
                      'builder_construction_photographs','builder_construction_status_history',
                      'builder_construction_date_history')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_construction_cases','builder_construction_stages',
                    'builder_construction_milestones','builder_construction_progress_updates',
                    'builder_construction_photographs']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='row_version');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: touch-triggered table(s) without row_version: %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.builder_role_default_permissions
                 WHERE permission_key='construction' AND membership_role='manager' AND can_view) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: permission key(s) without a role baseline: construction';
  END IF;

  -- A milestone must carry no amount and no payment flag: Finance owns
  -- build_progress_payments and every commission trigger on it.
  SELECT string_agg(column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='builder_construction_milestones'
    AND (column_name LIKE '%amount%' OR column_name LIKE '%payment%'
         OR column_name LIKE '%claim%' OR column_name LIKE '%invoice%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a milestone carries payment information: %', v_missing;
  END IF;

  SELECT string_agg(table_name||'.'||column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name LIKE 'builder_%'
    AND table_name <> 'builder_invoices'
    AND (column_name LIKE '%cost%' OR column_name LIKE '%margin%'
         OR column_name LIKE '%supplier%' OR column_name LIKE '%contractor_price%'
         OR column_name LIKE '%commission%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: internal commercial column(s) present: %', v_missing;
  END IF;

  RAISE NOTICE 'builder construction: cases, stages, milestones, progress updates, dates and photographs installed';
END $$;
