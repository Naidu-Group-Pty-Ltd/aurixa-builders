-- Builder / Developer Portal — Inventory: stages, buildings, lots, units,
-- pricing, availability, release status, holds, reservations and allocations.
--
-- Additive only. Every Phase 1, 2 and 3 object is reused unchanged.
--
-- Solicitor blueprint:
--   legal_matter_critical_dates / legal_matter_settlement_tasks are the closest
--   analogues — child collections of a parent aggregate, reached through the
--   parent's access grant, mutated through guarded commands, with append-only
--   status history. Inventory follows that shape exactly:
--
--     parent access grant           -> builder_project_access (Phase 3, reused)
--     child collection              -> builder_stages / _lots / _units / …
--     transition_legal_matter()     -> builder_transition_unit_availability()
--                                      builder_transition_reservation()
--     legal_matter_status_history   -> builder_unit_status_history
--                                      builder_reservation_status_history
--
-- Access: a unit is reached through its PROJECT. There is no second access
-- table — `builder_project_access` remains the only grant, exactly as a legal
-- matter's critical dates are reached through the matter's grant.
--
-- DATA BOUNDARY: this module records the CUSTOMER-FACING commercial position
-- only — list price, reservation deposit, allocation. It deliberately holds no
-- build cost, margin, supplier price or contractor price column. Those are
-- internal Builder commercial information and are outside every audience
-- projection in this programme.

-- ===========================================================================
-- 0. Prerequisites
-- ===========================================================================

-- The scope guard was widened to `project` in Phase 3. Inventory adds `stage`
-- and `unit`, whose tables this migration creates. `development` stays blocked
-- because nothing resolves a development-scoped override.
CREATE OR REPLACE FUNCTION public.builder_guard_permission_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.scope_type NOT IN ('organisation', 'project', 'stage', 'unit') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_SCOPE_NOT_AVAILABLE',
      DETAIL='Only organisation, project, stage and unit scopes exist.';
  END IF;

  -- A scoped override must point at a row that actually exists, or it is
  -- unresolvable and would sit in the table for ever.
  IF NEW.scope_type = 'project' THEN
    IF NEW.scope_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.builder_projects WHERE id = NEW.scope_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND',
        DETAIL='a project-scoped permission must reference an existing project';
    END IF;
  ELSIF NEW.scope_type = 'stage' THEN
    IF NEW.scope_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.builder_stages WHERE id = NEW.scope_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND',
        DETAIL='a stage-scoped permission must reference an existing stage';
    END IF;
  ELSIF NEW.scope_type = 'unit' THEN
    IF NEW.scope_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.builder_units WHERE id = NEW.scope_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND',
        DETAIL='a unit-scoped permission must reference an existing unit';
    END IF;
  END IF;

  -- View is the floor. Unchanged from Phase 1.
  IF NEW.view_decision = 'deny' THEN
    NEW.edit_decision := 'deny';
    NEW.delete_decision := 'deny';
  ELSIF NEW.edit_decision = 'allow' OR NEW.delete_decision = 'allow' THEN
    NEW.view_decision := 'allow';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Project entities the activity log must accept.
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session',
     'development', 'project', 'project_party', 'project_access',
     'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
     'reservation', 'allocation'));

-- ===========================================================================
-- 1. Stages
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  stage_number text,
  description text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','released','under_construction','completed','on_hold','cancelled')),
  estimated_completion_date date,
  actual_completion_date date,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, stage_number)
);
CREATE INDEX IF NOT EXISTS builder_stages_project_idx ON public.builder_stages(project_id);

COMMENT ON TABLE public.builder_stages IS
  'A project subdivides into stages. Reached through the parent project''s access grant — there is no separate stage access table.';

-- ===========================================================================
-- 2. Buildings — apartment and townhouse projects only
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_buildings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  stage_id uuid REFERENCES public.builder_stages(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  building_code text,
  level_count integer CHECK (level_count IS NULL OR level_count > 0),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','under_construction','completed','on_hold','cancelled')),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, building_code)
);
CREATE INDEX IF NOT EXISTS builder_buildings_project_idx ON public.builder_buildings(project_id);
CREATE INDEX IF NOT EXISTS builder_buildings_stage_idx ON public.builder_buildings(stage_id);

-- ===========================================================================
-- 3. Lots — land subdivision
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  stage_id uuid REFERENCES public.builder_stages(id) ON DELETE SET NULL,
  lot_number text NOT NULL CHECK (length(btrim(lot_number)) > 0),
  plan_number text,
  land_area_sqm numeric(10,2) CHECK (land_area_sqm IS NULL OR land_area_sqm > 0),
  frontage_m numeric(8,2) CHECK (frontage_m IS NULL OR frontage_m > 0),
  titled boolean NOT NULL DEFAULT false,
  titled_at date,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','registered','titled','settled','withdrawn')),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, lot_number)
);
CREATE INDEX IF NOT EXISTS builder_lots_project_idx ON public.builder_lots(project_id);
CREATE INDEX IF NOT EXISTS builder_lots_stage_idx ON public.builder_lots(stage_id);

-- ===========================================================================
-- 4. Units — the sellable inventory item
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  stage_id uuid REFERENCES public.builder_stages(id) ON DELETE SET NULL,
  building_id uuid REFERENCES public.builder_buildings(id) ON DELETE SET NULL,
  lot_id uuid REFERENCES public.builder_lots(id) ON DELETE SET NULL,

  unit_number text NOT NULL CHECK (length(btrim(unit_number)) > 0),
  unit_type text NOT NULL DEFAULT 'house'
    CHECK (unit_type IN ('house','townhouse','apartment','duplex','land','terrace','other')),

  bedrooms smallint CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 20),
  bathrooms numeric(3,1) CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 20),
  car_spaces smallint CHECK (car_spaces IS NULL OR car_spaces BETWEEN 0 AND 20),
  internal_area_sqm numeric(10,2) CHECK (internal_area_sqm IS NULL OR internal_area_sqm > 0),
  external_area_sqm numeric(10,2) CHECK (external_area_sqm IS NULL OR external_area_sqm >= 0),
  level_number smallint,
  aspect text CHECK (aspect IS NULL OR aspect IN ('N','NE','E','SE','S','SW','W','NW')),

  -- Availability is the sales state; release is the marketing state. They move
  -- independently: a unit can be released but already reserved.
  availability_status text NOT NULL DEFAULT 'available'
    CHECK (availability_status IN ('available','on_hold','reserved','contracted','settled','withdrawn')),
  release_status text NOT NULL DEFAULT 'unreleased'
    CHECK (release_status IN ('unreleased','coming_soon','released','sold_out')),
  released_at timestamptz,

  estimated_completion_date date,
  description text,

  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, unit_number)
);
CREATE INDEX IF NOT EXISTS builder_units_project_idx ON public.builder_units(project_id);
CREATE INDEX IF NOT EXISTS builder_units_stage_idx ON public.builder_units(stage_id);
CREATE INDEX IF NOT EXISTS builder_units_availability_idx
  ON public.builder_units(project_id, availability_status);
CREATE INDEX IF NOT EXISTS builder_units_release_idx
  ON public.builder_units(project_id, release_status);

COMMENT ON TABLE public.builder_units IS
  'Sellable inventory. Holds the customer-facing position only: no build cost, margin, supplier price or contractor price column exists on this table or any of its children.';

-- Every child must belong to the SAME project as the unit. Without this a unit
-- could reference another project''s stage and leak across the access boundary.
CREATE OR REPLACE FUNCTION public.builder_enforce_unit_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.stage_id IS NOT NULL THEN
    SELECT project_id INTO v_parent FROM public.builder_stages WHERE id = NEW.stage_id;
    IF v_parent IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_PARENT_MISMATCH',
        DETAIL='the stage belongs to a different project';
    END IF;
  END IF;
  IF NEW.building_id IS NOT NULL THEN
    SELECT project_id INTO v_parent FROM public.builder_buildings WHERE id = NEW.building_id;
    IF v_parent IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_PARENT_MISMATCH',
        DETAIL='the building belongs to a different project';
    END IF;
  END IF;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT project_id INTO v_parent FROM public.builder_lots WHERE id = NEW.lot_id;
    IF v_parent IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_PARENT_MISMATCH',
        DETAIL='the lot belongs to a different project';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_enforce_unit_parentage ON public.builder_units;
CREATE TRIGGER trg_builder_enforce_unit_parentage
  BEFORE INSERT OR UPDATE OF project_id, stage_id, building_id, lot_id
  ON public.builder_units FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_unit_parentage();

-- The same rule for buildings and lots against their stage.
CREATE OR REPLACE FUNCTION public.builder_enforce_stage_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.stage_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id INTO v_parent FROM public.builder_stages WHERE id = NEW.stage_id;
  IF v_parent IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STAGE_PARENT_MISMATCH',
      DETAIL='the stage belongs to a different project';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_buildings_parentage ON public.builder_buildings;
CREATE TRIGGER trg_builder_buildings_parentage
  BEFORE INSERT OR UPDATE OF project_id, stage_id ON public.builder_buildings
  FOR EACH ROW EXECUTE FUNCTION public.builder_enforce_stage_parentage();
DROP TRIGGER IF EXISTS trg_builder_lots_parentage ON public.builder_lots;
CREATE TRIGGER trg_builder_lots_parentage
  BEFORE INSERT OR UPDATE OF project_id, stage_id ON public.builder_lots
  FOR EACH ROW EXECUTE FUNCTION public.builder_enforce_stage_parentage();

-- ===========================================================================
-- 5. Unit pricing — customer-facing list price only
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_unit_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.builder_units(id) ON DELETE CASCADE,
  list_price numeric(14,2) NOT NULL CHECK (list_price >= 0),
  price_basis text NOT NULL DEFAULT 'fixed'
    CHECK (price_basis IN ('fixed','from','indicative','on_application')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  is_current boolean NOT NULL DEFAULT true,
  reason text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_unit_pricing_window_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS builder_unit_pricing_unit_idx ON public.builder_unit_pricing(unit_id);
-- Exactly one current price per unit.
CREATE UNIQUE INDEX IF NOT EXISTS builder_unit_pricing_one_current
  ON public.builder_unit_pricing(unit_id) WHERE is_current;

COMMENT ON TABLE public.builder_unit_pricing IS
  'Customer-facing list price history. Deliberately holds NO cost, margin, supplier or contractor price — those are internal Builder commercial information.';

-- ===========================================================================
-- 6. Holds, reservations, allocations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_unit_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.builder_units(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  held_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  hold_reference text,
  reason text,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','released','expired','converted')),
  released_at timestamptz,
  released_reason text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_unit_holds_unit_idx ON public.builder_unit_holds(unit_id, status);
-- One active hold per unit.
CREATE UNIQUE INDEX IF NOT EXISTS builder_unit_holds_one_active
  ON public.builder_unit_holds(unit_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.builder_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.builder_units(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  reservation_reference text,
  -- The purchaser is recorded by name and contact here. A Client record is
  -- linked at TRANSACTION level, not here: a reservation must not reach into
  -- the Client aggregate or any of its financial position.
  purchaser_name text NOT NULL CHECK (length(btrim(purchaser_name)) > 0),
  purchaser_email text,
  purchaser_phone text,
  reserved_by_builder_user_id uuid REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  -- The customer-facing reservation fee. Not a Finance ledger entry: Finance
  -- owns receipt and reconciliation, this records only what was agreed.
  reservation_fee numeric(14,2) CHECK (reservation_fee IS NULL OR reservation_fee >= 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','contracted','cancelled','expired','lapsed')),
  cancelled_reason text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_reservations_window_valid
    CHECK (expires_at IS NULL OR expires_at > reserved_at)
);
CREATE INDEX IF NOT EXISTS builder_reservations_unit_idx ON public.builder_reservations(unit_id, status);
CREATE INDEX IF NOT EXISTS builder_reservations_org_idx ON public.builder_reservations(organisation_id);
-- One live reservation per unit.
CREATE UNIQUE INDEX IF NOT EXISTS builder_reservations_one_active
  ON public.builder_reservations(unit_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.builder_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.builder_units(id) ON DELETE CASCADE,
  allocated_to_organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  allocation_type text NOT NULL DEFAULT 'sales_channel'
    CHECK (allocation_type IN ('sales_channel','display','staff','investor','other')),
  reference text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','released','expired')),
  released_at timestamptz,
  released_reason text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_allocations_unit_idx ON public.builder_allocations(unit_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS builder_allocations_one_active
  ON public.builder_allocations(unit_id) WHERE status = 'active';

-- ===========================================================================
-- 7. Append-only status history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_unit_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES public.builder_units(id) ON DELETE CASCADE,
  status_kind text NOT NULL CHECK (status_kind IN ('availability','release')),
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
CREATE INDEX IF NOT EXISTS builder_unit_status_history_unit_idx
  ON public.builder_unit_status_history(unit_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.builder_reservation_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.builder_reservations(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS builder_reservation_status_history_idx
  ON public.builder_reservation_status_history(reservation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.builder_inventory_history_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001',
    MESSAGE='BUILDER_INVENTORY_HISTORY_APPEND_ONLY',
    DETAIL='inventory status history rows cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_unit_status_history_append_only ON public.builder_unit_status_history;
CREATE TRIGGER trg_builder_unit_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_unit_status_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_inventory_history_append_only();
DROP TRIGGER IF EXISTS trg_builder_reservation_status_history_append_only
  ON public.builder_reservation_status_history;
CREATE TRIGGER trg_builder_reservation_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_reservation_status_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_inventory_history_append_only();

-- ===========================================================================
-- 8. Touch triggers — every table carries row_version, which the shared
--    trigger sets. A table missing the column raises at runtime.
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_stages','builder_buildings','builder_lots',
                           'builder_units','builder_unit_pricing','builder_unit_holds',
                           'builder_reservations','builder_allocations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 9. Access resolution
--
-- A unit is reached through its PROJECT. `builder_resolve_project_permission`
-- already enforces the whole boundary: a live grant, a HARD active-membership
-- gate before any override, the organisation baseline, the scoped override, the
-- grant override, the forbidden-key re-assertion and the read_only clamp.
-- This function adds the unit-scoped override on top of that, and never
-- weakens it — it can only narrow.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_resolve_unit_permission(
  _user_id uuid, _unit_id uuid, _permission_key text, _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_id uuid; v_stage_id uuid; v_org uuid;
  v_base boolean; v_membership_id uuid; v_scoped text;
BEGIN
  SELECT project_id, stage_id INTO v_project_id, v_stage_id
  FROM public.builder_units WHERE id = _unit_id;
  IF v_project_id IS NULL THEN RETURN false; END IF;

  -- The parent decision is authoritative. If the project denies, the unit
  -- denies — a unit-scoped allow can never open a project the user cannot see.
  v_base := public.builder_resolve_project_permission(
    _user_id, v_project_id, _permission_key, _level);
  IF NOT v_base THEN RETURN false; END IF;

  -- The membership is already proven by the parent, but it is re-read here
  -- because the scoped override below is keyed on the membership id.
  SELECT a.organisation_id INTO v_org FROM public.builder_project_access a
  WHERE a.builder_user_id = _user_id AND a.project_id = v_project_id
    AND a.revoked_at IS NULL;
  IF v_org IS NULL THEN RETURN false; END IF;

  SELECT membership_id INTO v_membership_id
  FROM public.builder_active_membership(_user_id, v_org);
  IF v_membership_id IS NULL THEN RETURN false; END IF;

  -- Stage-scoped override, then unit-scoped. Each may only DENY: a narrower
  -- scope must not be able to grant what the parent withheld, and the parent
  -- has already returned true to reach this point.
  IF v_stage_id IS NOT NULL THEN
    SELECT CASE _level WHEN 'view' THEN view_decision
                      WHEN 'edit' THEN edit_decision ELSE delete_decision END
    INTO v_scoped FROM public.builder_membership_permissions
    WHERE membership_id = v_membership_id AND permission_key = _permission_key
      AND scope_type = 'stage' AND scope_id = v_stage_id;
    IF v_scoped = 'deny' THEN RETURN false; END IF;
  END IF;

  SELECT CASE _level WHEN 'view' THEN view_decision
                    WHEN 'edit' THEN edit_decision ELSE delete_decision END
  INTO v_scoped FROM public.builder_membership_permissions
  WHERE membership_id = v_membership_id AND permission_key = _permission_key
    AND scope_type = 'unit' AND scope_id = _unit_id;
  IF v_scoped = 'deny' THEN RETURN false; END IF;

  RETURN true;
END $$;

-- Every unit this user may see, narrowed to the session's organisation.
CREATE OR REPLACE FUNCTION public.builder_accessible_units(
  _user_id uuid, _organisation_id uuid DEFAULT NULL, _permission_key text DEFAULT 'inventory')
RETURNS TABLE (unit_id uuid, project_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.project_id
  FROM public.builder_units u
  JOIN public.builder_accessible_projects(_user_id, _organisation_id, _permission_key) p
    ON p.project_id = u.project_id
  WHERE public.builder_resolve_unit_permission(_user_id, u.id, _permission_key, 'view');
$$;

-- ===========================================================================
-- 10. Guarded commands — write and trusted audit in ONE transaction
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_upsert_stage(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _stage_id uuid, _project_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_stages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_stages; v_row public.builder_stages; v_org uuid;
BEGIN
  IF _stage_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_stages WHERE id = _stage_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.builder_upsert_building(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _building_id uuid, _project_id uuid, _stage_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_buildings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_buildings; v_row public.builder_buildings; v_org uuid;
BEGIN
  IF _building_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_buildings WHERE id = _building_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.builder_upsert_lot(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _lot_id uuid, _project_id uuid, _stage_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_lots
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_lots; v_row public.builder_lots; v_org uuid;
BEGIN
  IF _lot_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_lots WHERE id = _lot_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.builder_upsert_unit(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _unit_id uuid, _project_id uuid,
  _stage_id uuid DEFAULT NULL, _building_id uuid DEFAULT NULL, _lot_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_units
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_units; v_row public.builder_units; v_org uuid;
BEGIN
  IF _unit_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_units WHERE id = _unit_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    -- Availability and release are NOT writable here: they move only through
    -- their transition commands, which record history.
    UPDATE public.builder_units SET
      unit_number       = CASE WHEN _payload ? 'unit_number' THEN _payload->>'unit_number' ELSE unit_number END,
      unit_type         = CASE WHEN _payload ? 'unit_type' THEN _payload->>'unit_type' ELSE unit_type END,
      bedrooms          = CASE WHEN _payload ? 'bedrooms' THEN (_payload->>'bedrooms')::smallint ELSE bedrooms END,
      bathrooms         = CASE WHEN _payload ? 'bathrooms' THEN (_payload->>'bathrooms')::numeric ELSE bathrooms END,
      car_spaces        = CASE WHEN _payload ? 'car_spaces' THEN (_payload->>'car_spaces')::smallint ELSE car_spaces END,
      internal_area_sqm = CASE WHEN _payload ? 'internal_area_sqm' THEN (_payload->>'internal_area_sqm')::numeric ELSE internal_area_sqm END,
      external_area_sqm = CASE WHEN _payload ? 'external_area_sqm' THEN (_payload->>'external_area_sqm')::numeric ELSE external_area_sqm END,
      level_number      = CASE WHEN _payload ? 'level_number' THEN (_payload->>'level_number')::smallint ELSE level_number END,
      aspect            = CASE WHEN _payload ? 'aspect' THEN _payload->>'aspect' ELSE aspect END,
      estimated_completion_date = CASE WHEN _payload ? 'estimated_completion_date'
        THEN (_payload->>'estimated_completion_date')::date ELSE estimated_completion_date END,
      description       = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      stage_id          = COALESCE(_stage_id, stage_id),
      building_id       = COALESCE(_building_id, building_id),
      lot_id            = COALESCE(_lot_id, lot_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _project_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_projects WHERE id = _project_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_units(project_id, stage_id, building_id, lot_id,
      unit_number, unit_type, bedrooms, bathrooms, car_spaces,
      internal_area_sqm, external_area_sqm, level_number, aspect,
      estimated_completion_date, description)
    VALUES (_project_id, _stage_id, _building_id, _lot_id,
      _payload->>'unit_number', COALESCE(_payload->>'unit_type','house'),
      (_payload->>'bedrooms')::smallint, (_payload->>'bathrooms')::numeric,
      (_payload->>'car_spaces')::smallint, (_payload->>'internal_area_sqm')::numeric,
      (_payload->>'external_area_sqm')::numeric, (_payload->>'level_number')::smallint,
      _payload->>'aspect', (_payload->>'estimated_completion_date')::date,
      _payload->>'description')
    RETURNING * INTO v_row;
  END IF;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_row.project_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _unit_id IS NULL THEN 'builder_unit_created' ELSE 'builder_unit_updated' END,
    'unit', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _unit_id IS NULL THEN NULL
         ELSE jsonb_build_object('unit_number', v_existing.unit_number) END,
    jsonb_build_object('unit_number', v_row.unit_number, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('project_id', v_row.project_id));
  RETURN v_row;
END $$;

-- --- availability / release transitions ------------------------------------
CREATE OR REPLACE FUNCTION public.builder_is_unit_availability_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    WHEN _from = 'settled' THEN false
    WHEN _to = 'withdrawn' THEN _from IN ('available','on_hold','reserved')
    WHEN _from = 'withdrawn' THEN _to = 'available'
    WHEN _from = 'available' THEN _to IN ('on_hold','reserved')
    WHEN _from = 'on_hold' THEN _to IN ('available','reserved')
    WHEN _from = 'reserved' THEN _to IN ('available','contracted')
    WHEN _from = 'contracted' THEN _to IN ('settled','available')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.builder_transition_unit_availability(
  _unit_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.builder_units; v_history_id uuid; v_org uuid;
BEGIN
  IF NULLIF(btrim(_reason), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  SELECT * INTO u FROM public.builder_units WHERE id = _unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND'; END IF;
  IF u.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION'; END IF;
  IF u.availability_status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS'; END IF;
  IF NOT public.builder_is_unit_availability_transition_allowed(_from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION'; END IF;

  UPDATE public.builder_units SET availability_status = _to
  WHERE id = _unit_id RETURNING * INTO u;

  INSERT INTO public.builder_unit_status_history(unit_id, status_kind, from_status, to_status,
    changed_by_type, changed_by_builder_user_id, changed_by_user_id, reason, metadata)
  VALUES (_unit_id, 'availability', _from, _to, _actor_type,
    _actor_builder_user_id, _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', u.row_version))
  RETURNING id INTO v_history_id;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = u.project_id;
  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_unit_availability_changed',
    'unit', u.id, v_org, _actor_builder_user_id,
    jsonb_build_object('availability_status', _from),
    jsonb_build_object('availability_status', _to, 'row_version', u.row_version),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN to_jsonb(u);
END $$;

CREATE OR REPLACE FUNCTION public.builder_transition_unit_release(
  _unit_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u public.builder_units; v_history_id uuid; v_org uuid;
BEGIN
  IF NULLIF(btrim(_reason), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  IF _to NOT IN ('unreleased','coming_soon','released','sold_out') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION'; END IF;
  IF _from = _to THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION'; END IF;

  SELECT * INTO u FROM public.builder_units WHERE id = _unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND'; END IF;
  IF u.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION'; END IF;
  IF u.release_status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS'; END IF;

  -- A unit cannot be released without a current price: a released unit with no
  -- price is a customer-facing error, not a valid inventory state.
  IF _to = 'released' AND NOT EXISTS (
    SELECT 1 FROM public.builder_unit_pricing WHERE unit_id = _unit_id AND is_current) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_PRICE_REQUIRED',
      DETAIL='a unit cannot be released without a current price';
  END IF;

  UPDATE public.builder_units SET release_status = _to,
    released_at = CASE WHEN _to = 'released' THEN COALESCE(released_at, now()) ELSE released_at END
  WHERE id = _unit_id RETURNING * INTO u;

  INSERT INTO public.builder_unit_status_history(unit_id, status_kind, from_status, to_status,
    changed_by_type, changed_by_builder_user_id, changed_by_user_id, reason, metadata)
  VALUES (_unit_id, 'release', _from, _to, _actor_type,
    _actor_builder_user_id, _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', u.row_version))
  RETURNING id INTO v_history_id;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = u.project_id;
  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_unit_release_changed',
    'unit', u.id, v_org, _actor_builder_user_id,
    jsonb_build_object('release_status', _from),
    jsonb_build_object('release_status', _to, 'row_version', u.row_version),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN to_jsonb(u);
END $$;

-- --- pricing ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_set_unit_price(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _unit_id uuid, _list_price numeric, _price_basis text DEFAULT 'fixed',
  _reason text DEFAULT NULL)
RETURNS public.builder_unit_pricing
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_previous public.builder_unit_pricing; v_row public.builder_unit_pricing; v_org uuid; v_project uuid;
BEGIN
  SELECT project_id INTO v_project FROM public.builder_units WHERE id = _unit_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND';
  END IF;
  IF _list_price IS NULL OR _list_price < 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_PRICE';
  END IF;
  IF _price_basis NOT IN ('fixed','from','indicative','on_application') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_PRICE_BASIS';
  END IF;

  -- Close the current price rather than editing it: price history is evidence.
  SELECT * INTO v_previous FROM public.builder_unit_pricing
  WHERE unit_id = _unit_id AND is_current FOR UPDATE;
  IF v_previous.id IS NOT NULL THEN
    UPDATE public.builder_unit_pricing
    SET is_current = false, effective_to = now()
    WHERE id = v_previous.id;
  END IF;

  INSERT INTO public.builder_unit_pricing(unit_id, list_price, price_basis, reason)
  VALUES (_unit_id, _list_price, _price_basis, _reason)
  RETURNING * INTO v_row;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_project;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_unit_price_set',
    'unit_price', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN v_previous.id IS NULL THEN NULL
         ELSE jsonb_build_object('list_price', v_previous.list_price) END,
    jsonb_build_object('list_price', v_row.list_price, 'price_basis', v_row.price_basis),
    _reason, jsonb_build_object('unit_id', _unit_id));
  RETURN v_row;
END $$;

-- --- holds -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_create_unit_hold(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _unit_id uuid, _organisation_id uuid, _expires_at timestamptz,
  _hold_reference text DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_unit_holds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.builder_unit_holds; u public.builder_units; v_org uuid;
BEGIN
  SELECT * INTO u FROM public.builder_units WHERE id = _unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND'; END IF;
  IF _expires_at IS NULL OR _expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HOLD_EXPIRY_INVALID';
  END IF;
  IF u.availability_status <> 'available' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_AVAILABLE',
      DETAIL=format('unit is %s', u.availability_status);
  END IF;

  INSERT INTO public.builder_unit_holds(unit_id, organisation_id, held_by_builder_user_id,
    hold_reference, reason, expires_at)
  VALUES (_unit_id, _organisation_id, _actor_builder_user_id, _hold_reference, _reason, _expires_at)
  RETURNING * INTO v_row;

  -- The hold moves the unit, and the move records its own history.
  PERFORM public.builder_transition_unit_availability(
    _unit_id, u.row_version, 'available', 'on_hold',
    COALESCE(_reason, 'Unit placed on hold'), _actor_type, _actor_builder_user_id, _actor_user_id);

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = u.project_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_unit_hold_created',
    'unit_hold', v_row.id, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('expires_at', v_row.expires_at),
    _reason, jsonb_build_object('unit_id', _unit_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_release_unit_hold(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _hold_id uuid, _expected_version bigint, _reason text DEFAULT NULL)
RETURNS public.builder_unit_holds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_unit_holds; v_row public.builder_unit_holds;
        u public.builder_units; v_org uuid;
BEGIN
  SELECT * INTO v_existing FROM public.builder_unit_holds WHERE id = _hold_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HOLD_NOT_FOUND'; END IF;
  IF v_existing.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_HOLD_NOT_ACTIVE'; END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version); END IF;

  UPDATE public.builder_unit_holds
  SET status='released', released_at=now(), released_reason=_reason
  WHERE id = v_existing.id RETURNING * INTO v_row;

  SELECT * INTO u FROM public.builder_units WHERE id = v_row.unit_id FOR UPDATE;
  IF u.availability_status = 'on_hold' THEN
    PERFORM public.builder_transition_unit_availability(
      u.id, u.row_version, 'on_hold', 'available',
      COALESCE(_reason, 'Hold released'), _actor_type, _actor_builder_user_id, _actor_user_id);
  END IF;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = u.project_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_unit_hold_released',
    'unit_hold', v_row.id, v_org, _actor_builder_user_id,
    jsonb_build_object('status', v_existing.status),
    jsonb_build_object('status', v_row.status),
    _reason, jsonb_build_object('unit_id', v_row.unit_id));
  RETURN v_row;
END $$;

-- --- reservations ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_create_reservation(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _unit_id uuid, _organisation_id uuid, _payload jsonb,
  _reason text DEFAULT NULL)
RETURNS public.builder_reservations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.builder_reservations; u public.builder_units; v_org uuid; v_expires timestamptz;
BEGIN
  SELECT * INTO u FROM public.builder_units WHERE id = _unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND'; END IF;
  IF NULLIF(btrim(COALESCE(_payload->>'purchaser_name','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PURCHASER_REQUIRED'; END IF;
  IF u.availability_status NOT IN ('available','on_hold') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_RESERVABLE',
      DETAIL=format('unit is %s', u.availability_status); END IF;

  v_expires := (_payload->>'expires_at')::timestamptz;
  IF v_expires IS NOT NULL AND v_expires <= now() THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_RESERVATION_EXPIRY_INVALID'; END IF;

  INSERT INTO public.builder_reservations(unit_id, organisation_id, reservation_reference,
    purchaser_name, purchaser_email, purchaser_phone, reserved_by_builder_user_id,
    reservation_fee, expires_at)
  VALUES (_unit_id, _organisation_id, _payload->>'reservation_reference',
    _payload->>'purchaser_name', _payload->>'purchaser_email', _payload->>'purchaser_phone',
    _actor_builder_user_id, (_payload->>'reservation_fee')::numeric, v_expires)
  RETURNING * INTO v_row;

  INSERT INTO public.builder_reservation_status_history(reservation_id, from_status, to_status,
    changed_by_type, changed_by_builder_user_id, changed_by_user_id, reason)
  VALUES (v_row.id, NULL, 'active', _actor_type, _actor_builder_user_id, _actor_user_id,
    COALESCE(_reason, 'Reservation created'));

  PERFORM public.builder_transition_unit_availability(
    _unit_id, u.row_version, u.availability_status, 'reserved',
    COALESCE(_reason, 'Unit reserved'), _actor_type, _actor_builder_user_id, _actor_user_id);

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = u.project_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_reservation_created',
    'reservation', v_row.id, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('purchaser_name', v_row.purchaser_name, 'status', v_row.status),
    _reason, jsonb_build_object('unit_id', _unit_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_is_reservation_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    WHEN _from <> 'active' THEN false
    WHEN _to IN ('contracted','cancelled','expired','lapsed') THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.builder_transition_reservation(
  _reservation_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.builder_reservations; u public.builder_units; v_org uuid; v_history_id uuid;
BEGIN
  IF NULLIF(btrim(_reason), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED'; END IF;
  SELECT * INTO r FROM public.builder_reservations WHERE id = _reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_RESERVATION_NOT_FOUND'; END IF;
  IF r.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION'; END IF;
  IF r.status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS'; END IF;
  IF NOT public.builder_is_reservation_transition_allowed(_from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION'; END IF;

  UPDATE public.builder_reservations
  SET status = _to,
      cancelled_reason = CASE WHEN _to IN ('cancelled','lapsed','expired')
        THEN left(btrim(_reason),1000) ELSE cancelled_reason END
  WHERE id = _reservation_id RETURNING * INTO r;

  INSERT INTO public.builder_reservation_status_history(reservation_id, from_status, to_status,
    changed_by_type, changed_by_builder_user_id, changed_by_user_id, reason, metadata)
  VALUES (_reservation_id, _from, _to, _actor_type, _actor_builder_user_id,
    _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', r.row_version))
  RETURNING id INTO v_history_id;

  -- The unit follows the reservation.
  SELECT * INTO u FROM public.builder_units WHERE id = r.unit_id FOR UPDATE;
  IF _to = 'contracted' AND u.availability_status = 'reserved' THEN
    PERFORM public.builder_transition_unit_availability(u.id, u.row_version, 'reserved',
      'contracted', left(btrim(_reason),1000), _actor_type, _actor_builder_user_id, _actor_staff_user_id);
  ELSIF _to IN ('cancelled','expired','lapsed') AND u.availability_status = 'reserved' THEN
    PERFORM public.builder_transition_unit_availability(u.id, u.row_version, 'reserved',
      'available', left(btrim(_reason),1000), _actor_type, _actor_builder_user_id, _actor_staff_user_id);
  END IF;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = u.project_id;
  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_reservation_status_changed',
    'reservation', r.id, v_org, _actor_builder_user_id,
    jsonb_build_object('status', _from), jsonb_build_object('status', _to),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN to_jsonb(r);
END $$;

-- --- allocations -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_create_allocation(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _unit_id uuid, _allocated_to_organisation_id uuid,
  _allocation_type text DEFAULT 'sales_channel',
  _expires_at timestamptz DEFAULT NULL, _reference text DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_allocations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.builder_allocations; v_project uuid; v_org uuid;
BEGIN
  SELECT project_id INTO v_project FROM public.builder_units WHERE id = _unit_id;
  IF v_project IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNIT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_organisations
                 WHERE id = _allocated_to_organisation_id AND status <> 'closed') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND'; END IF;
  IF _allocation_type NOT IN ('sales_channel','display','staff','investor','other') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_ALLOCATION_TYPE'; END IF;
  IF _expires_at IS NOT NULL AND _expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ALLOCATION_EXPIRY_INVALID'; END IF;

  INSERT INTO public.builder_allocations(unit_id, allocated_to_organisation_id,
    allocation_type, reference, expires_at)
  VALUES (_unit_id, _allocated_to_organisation_id, _allocation_type, _reference, _expires_at)
  RETURNING * INTO v_row;

  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_project;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_allocation_created',
    'allocation', v_row.id, v_org, _actor_builder_user_id,
    NULL, jsonb_build_object('allocated_to', v_row.allocated_to_organisation_id,
                             'allocation_type', v_row.allocation_type),
    _reason, jsonb_build_object('unit_id', _unit_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_release_allocation(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _allocation_id uuid, _expected_version bigint, _reason text DEFAULT NULL)
RETURNS public.builder_allocations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_allocations; v_row public.builder_allocations;
        v_project uuid; v_org uuid;
BEGIN
  SELECT * INTO v_existing FROM public.builder_allocations WHERE id = _allocation_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ALLOCATION_NOT_FOUND'; END IF;
  IF v_existing.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ALLOCATION_NOT_ACTIVE'; END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version); END IF;

  UPDATE public.builder_allocations
  SET status='released', released_at=now(), released_reason=_reason
  WHERE id = v_existing.id RETURNING * INTO v_row;

  SELECT project_id INTO v_project FROM public.builder_units WHERE id = v_row.unit_id;
  SELECT COALESCE(developer_organisation_id, builder_organisation_id) INTO v_org
  FROM public.builder_projects WHERE id = v_project;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_allocation_released',
    'allocation', v_row.id, v_org, _actor_builder_user_id,
    jsonb_build_object('status', v_existing.status), jsonb_build_object('status', v_row.status),
    _reason, jsonb_build_object('unit_id', v_row.unit_id));
  RETURN v_row;
END $$;

-- ===========================================================================
-- 11. Role defaults for the inventory permission keys
--
-- Phase 1 catalogued `inventory`, `pricing` and `reservations` but seeded no
-- defaults, so every one resolves false for every role — the same gap Phase 3
-- found with `projects`. Seeded here, deny-by-default preserved: a role not
-- listed gets nothing, and a project grant is still required on top.
-- ===========================================================================
INSERT INTO public.builder_role_default_permissions(
  membership_role, permission_key, can_view, can_edit, can_delete) VALUES
  ('owner',         'inventory',    true,  true,  true),
  ('administrator', 'inventory',    true,  true,  true),
  ('manager',       'inventory',    true,  true,  false),
  ('member',        'inventory',    true,  false, false),
  ('read_only',     'inventory',    true,  false, false),
  -- Pricing is commercially sensitive: members and read-only see it, but only
  -- owners, administrators and managers may change it.
  ('owner',         'pricing',      true,  true,  false),
  ('administrator', 'pricing',      true,  true,  false),
  ('manager',       'pricing',      true,  true,  false),
  ('member',        'pricing',      true,  false, false),
  ('read_only',     'pricing',      true,  false, false),
  ('owner',         'reservations', true,  true,  true),
  ('administrator', 'reservations', true,  true,  true),
  ('manager',       'reservations', true,  true,  false),
  ('member',        'reservations', true,  true,  false),
  ('read_only',     'reservations', true,  false, false)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 12. RLS and grants — deny by default
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_stages','builder_buildings','builder_lots','builder_units',
                           'builder_unit_pricing','builder_unit_holds','builder_reservations',
                           'builder_allocations','builder_unit_status_history',
                           'builder_reservation_status_history'] LOOP
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
    ('builder_resolve_unit_permission','uuid, uuid, text, text'),
    ('builder_accessible_units','uuid, uuid, text'),
    ('builder_upsert_stage','uuid, text, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_building','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_lot','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_unit','uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_is_unit_availability_transition_allowed','text, text'),
    ('builder_transition_unit_availability','uuid, bigint, text, text, text, text, uuid, uuid'),
    ('builder_transition_unit_release','uuid, bigint, text, text, text, text, uuid, uuid'),
    ('builder_set_unit_price','uuid, text, uuid, uuid, numeric, text, text'),
    ('builder_create_unit_hold','uuid, text, uuid, uuid, uuid, timestamptz, text, text'),
    ('builder_release_unit_hold','uuid, text, uuid, uuid, bigint, text'),
    ('builder_create_reservation','uuid, text, uuid, uuid, uuid, jsonb, text'),
    ('builder_is_reservation_transition_allowed','text, text'),
    ('builder_transition_reservation','uuid, bigint, text, text, text, text, uuid, uuid'),
    ('builder_create_allocation','uuid, text, uuid, uuid, uuid, text, timestamptz, text, text'),
    ('builder_release_allocation','uuid, text, uuid, uuid, bigint, text')
  ) AS t(f, a) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f, a);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, a);
  END LOOP;
END $$;

-- ===========================================================================
-- 13. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_resolve_unit_permission','builder_accessible_units',
    'builder_upsert_stage','builder_upsert_building','builder_upsert_lot','builder_upsert_unit',
    'builder_transition_unit_availability','builder_transition_unit_release',
    'builder_set_unit_price','builder_create_unit_hold','builder_release_unit_hold',
    'builder_create_reservation','builder_transition_reservation',
    'builder_create_allocation','builder_release_allocation',
    'builder_enforce_unit_parentage','builder_enforce_stage_parentage']) AS f
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: inventory function(s) missing: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('builder_stages','builder_buildings','builder_lots','builder_units',
                      'builder_unit_pricing','builder_unit_holds','builder_reservations',
                      'builder_allocations','builder_unit_status_history',
                      'builder_reservation_status_history')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  -- Every table carrying the shared touch trigger must have row_version, or the
  -- trigger raises at runtime.
  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_stages','builder_buildings','builder_lots','builder_units',
                    'builder_unit_pricing','builder_unit_holds','builder_reservations',
                    'builder_allocations']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='row_version');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: touch-triggered table(s) without row_version: %', v_missing;
  END IF;

  -- The inventory keys must carry a role baseline or the module is unusable.
  SELECT string_agg(k, ', ') INTO v_missing
  FROM unnest(ARRAY['inventory','pricing','reservations']) AS k
  WHERE NOT EXISTS (SELECT 1 FROM public.builder_role_default_permissions
                    WHERE permission_key = k AND membership_role='manager' AND can_view);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: permission key(s) without a role baseline: %', v_missing;
  END IF;

  -- No cost, margin or supplier price column may exist anywhere in inventory.
  SELECT string_agg(table_name||'.'||column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name LIKE 'builder_%'
    AND (column_name LIKE '%cost%' OR column_name LIKE '%margin%'
         OR column_name LIKE '%supplier%' OR column_name LIKE '%contractor_price%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: internal commercial column(s) present: %', v_missing;
  END IF;

  RAISE NOTICE 'builder inventory: stages, buildings, lots, units, pricing, holds, reservations and allocations installed';
END $$;
