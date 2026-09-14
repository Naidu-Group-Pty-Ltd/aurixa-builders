-- Builder / Developer Portal — Phase 3: developments, projects, parties and
-- project-level access.
--
-- Additive only. Every Phase 1 and Phase 2 object is reused unchanged.
--
-- Solicitor blueprint, table for table:
--   legal_matters                     -> builder_projects
--   legal_matter_parties              -> builder_project_parties
--   legal_matter_status_history       -> builder_project_status_history
--   solicitor_matter_access           -> builder_project_access
--   enforce_solicitor_matter_access_firm()      -> builder_enforce_project_access_org()
--   prevent_solicitor_matter_access_firm_drift()-> builder_prevent_project_access_org_drift()
--   is_legal_matter_transition_allowed()        -> builder_is_project_transition_allowed()
--   transition_legal_matter()                   -> builder_transition_project()
--
-- Builder-domain additions with no Solicitor equivalent (permitted):
--   * builder_developments — a project belongs to a development. A legal matter
--     has no parent grouping because a conveyancing file stands alone.
--   * A project carries TWO organisations. A legal matter has exactly one
--     `firm_id`; a project is delivered by a builder ON BEHALF OF a developer,
--     and either side may be the party a portal user belongs to. Everywhere the
--     Solicitor template says "the matter's exact non-null firm", Builder says
--     "one of the project's two exact non-null organisations".
--
-- Deliberate, documented divergences from the Solicitor template:
--   * Status is `text` + CHECK, not a Postgres enum. Every Builder table created
--     in Phases 1 and 2 uses text + CHECK; introducing an enum here would
--     diverge from the Builder schema rather than mirror it.
--   * Project-scope permission overrides reuse the Phase 1
--     `builder_membership_permissions.scope_type = 'project'` seam, which Phase 1
--     created for exactly this purpose. No parallel permissions table is added.
--   * Audit writes for access changes are PERFORMed inside the guarded command,
--     so a failed audit rolls the change back (Phase 0 NOCOPY-04). The Solicitor
--     equivalent logs and continues.

-- ===========================================================================
-- 0. Prerequisites this phase adds to Phase 1 objects
-- ===========================================================================

-- Tri-state matrix validator. Mirrors solicitor_tri_state_permissions_valid().
-- Phase 1 stored decisions in typed columns and so never needed one; the
-- project grant stores the same tri-state vocabulary as jsonb, exactly as
-- solicitor_matter_access.permissions does.
CREATE OR REPLACE FUNCTION public.builder_tri_state_permissions_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_typeof(value) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(value) area
      WHERE jsonb_typeof(area.value) <> 'object'
         OR EXISTS (
           SELECT 1 FROM jsonb_each_text(area.value) decision
           WHERE decision.key NOT IN ('view','edit','delete')
              OR decision.value NOT IN ('inherit','allow','deny')
         )
    );
$$;
REVOKE ALL ON FUNCTION public.builder_tri_state_permissions_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_tri_state_permissions_valid(jsonb) TO service_role;

-- The Phase 1 activity log restricts entity_type to the identity entities that
-- existed then. Widen it so project events can be logged; widening a CHECK is
-- additive and rejects nothing that was previously accepted.
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session',
     'development', 'project', 'project_party', 'project_access'));

-- ===========================================================================
-- 1. Developments
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_developments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  development_reference text,
  description text,
  address_line text,
  suburb text,
  state text CHECK (state IS NULL OR state IN ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')),
  postcode text CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','active','on_hold','completed','cancelled')),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (developer_organisation_id, development_reference)
);

CREATE INDEX IF NOT EXISTS builder_developments_org_idx
  ON public.builder_developments(developer_organisation_id);

COMMENT ON TABLE public.builder_developments IS
  'A development groups Builder projects under one developer organisation. No Solicitor equivalent — a legal matter has no parent grouping.';

-- ===========================================================================
-- 2. Projects
--
-- Mirrors legal_matters. The one structural difference is the pair of
-- organisations: `developer_organisation_id` and `builder_organisation_id`.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  development_id uuid REFERENCES public.builder_developments(id) ON DELETE SET NULL,

  -- Both are nullable at the column level so a project can be created before the
  -- counterparty is appointed; the access rules below require the relevant one
  -- to be non-null before anyone can reach the project through it.
  developer_organisation_id uuid REFERENCES public.builder_organisations(id) ON DELETE RESTRICT,
  builder_organisation_id uuid REFERENCES public.builder_organisations(id) ON DELETE RESTRICT,

  project_reference text,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  project_type text NOT NULL DEFAULT 'house_and_land'
    CHECK (project_type IN ('house_and_land','townhouse','apartment','duplex',
                            'land_only','knockdown_rebuild','commercial','other')),
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','pre_sales','approved','under_construction',
                      'practical_completion','handover','completed','on_hold','cancelled')),

  address_line text,
  suburb text,
  state text CHECK (state IS NULL OR state IN ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')),
  postcode text CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  lot_number text,
  plan_number text,

  estimated_start_date date,
  estimated_completion_date date,
  actual_start_date date,
  actual_completion_date date,

  -- Audience-private notes, mirroring legal_matters.internal_notes /
  -- npc_internal_notes. Each audience can read only its own.
  builder_notes text,
  npc_internal_notes text,
  shared_summary text,

  risk_flag boolean NOT NULL DEFAULT false,
  risk_notes text,

  row_version bigint NOT NULL DEFAULT 1,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A project must be reachable through at least one organisation, or nobody
  -- could ever be granted access to it.
  CONSTRAINT builder_projects_has_an_organisation CHECK (
    developer_organisation_id IS NOT NULL OR builder_organisation_id IS NOT NULL),
  -- The two sides are distinct roles. One organisation acting as both would
  -- silently collapse the two access paths into one.
  CONSTRAINT builder_projects_organisations_distinct CHECK (
    developer_organisation_id IS NULL OR builder_organisation_id IS NULL
    OR developer_organisation_id <> builder_organisation_id),
  UNIQUE (developer_organisation_id, project_reference)
);

CREATE INDEX IF NOT EXISTS builder_projects_developer_idx
  ON public.builder_projects(developer_organisation_id) WHERE developer_organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_projects_builder_idx
  ON public.builder_projects(builder_organisation_id) WHERE builder_organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_projects_development_idx
  ON public.builder_projects(development_id);
CREATE INDEX IF NOT EXISTS builder_projects_status_idx
  ON public.builder_projects(status);

COMMENT ON TABLE public.builder_projects IS
  'Builder Portal projects. Mirrors legal_matters. Carries TWO organisations: the developer and the builder. Organisation membership is never on its own an authorization boundary — an explicit builder_project_access grant is always required.';
COMMENT ON COLUMN public.builder_projects.builder_notes IS
  'Builder-audience private notes. Never returned to the Command Centre contract.';
COMMENT ON COLUMN public.builder_projects.npc_internal_notes IS
  'Command Centre private notes. Never returned to the Builder Portal contract.';

-- A development and its projects must belong to the same developer.
CREATE OR REPLACE FUNCTION public.builder_enforce_project_development_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_dev_org uuid;
BEGIN
  IF NEW.development_id IS NULL THEN RETURN NEW; END IF;
  SELECT developer_organisation_id INTO v_dev_org
  FROM public.builder_developments WHERE id = NEW.development_id;
  IF v_dev_org IS NULL OR NEW.developer_organisation_id IS DISTINCT FROM v_dev_org THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_PROJECT_DEVELOPMENT_ORG_MISMATCH',
      DETAIL='a project must share its development''s developer organisation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_project_development_org ON public.builder_projects;
CREATE TRIGGER trg_builder_project_development_org
  BEFORE INSERT OR UPDATE OF development_id, developer_organisation_id
  ON public.builder_projects FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_project_development_org();

-- ===========================================================================
-- 3. Project parties — mirrors legal_matter_parties
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_project_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'other'
    CHECK (role IN ('developer','builder','site_supervisor','project_manager',
                    'sales_agent','architect','engineer','certifier','surveyor',
                    'contractor','purchaser','other')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  organisation text,
  email text,
  phone text,
  address text,
  reference text,
  is_primary_contact boolean NOT NULL DEFAULT false,
  notes text,
  -- Present because the shared Phase 1 touch trigger sets it on every UPDATE.
  -- Without it, `builder_touch_row` raises "record new has no field row_version"
  -- and every party edit fails.
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent for a database that already has the table from an earlier apply.
ALTER TABLE public.builder_project_parties
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS builder_project_parties_project_idx
  ON public.builder_project_parties(project_id);

-- ===========================================================================
-- 4. Status history — mirrors legal_matter_status_history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_project_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS builder_project_status_history_project_idx
  ON public.builder_project_status_history(project_id, created_at DESC);

-- Status history is evidence: it is append-only, like the Phase 1 activity log.
CREATE OR REPLACE FUNCTION public.builder_project_status_history_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001',
    MESSAGE='BUILDER_PROJECT_STATUS_HISTORY_APPEND_ONLY',
    DETAIL='builder_project_status_history rows cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_project_status_history_append_only
  ON public.builder_project_status_history;
CREATE TRIGGER trg_builder_project_status_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_project_status_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_project_status_history_append_only();

-- ===========================================================================
-- 5. Project access — mirrors solicitor_matter_access
--
-- This is the authorization boundary. Belonging to a project's developer or
-- builder organisation does NOT grant project access; an explicit, unrevoked,
-- in-window grant does.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_project_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  -- The organisation THROUGH WHICH this access is held. Must be one of the
  -- project's two organisations and must be one the user actually belongs to.
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  organisation_side text NOT NULL CHECK (organisation_side IN ('developer','builder')),

  access_role text NOT NULL DEFAULT 'team_member'
    CHECK (access_role IN ('responsible','team_member','supervisor','read_only')),
  -- Tri-state overrides, same shape as solicitor_matter_access.permissions and
  -- the same vocabulary as builder_membership_permissions.
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,

  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revocation_reason text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT builder_project_access_window_valid
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT builder_project_access_permissions_valid
    CHECK (public.builder_tri_state_permissions_valid(permissions)),
  UNIQUE (builder_user_id, project_id)
);

CREATE INDEX IF NOT EXISTS builder_project_access_user_project_idx
  ON public.builder_project_access(builder_user_id, project_id);
CREATE INDEX IF NOT EXISTS builder_project_access_project_revoked_idx
  ON public.builder_project_access(project_id, revoked_at);
CREATE INDEX IF NOT EXISTS builder_project_access_org_project_idx
  ON public.builder_project_access(organisation_id, project_id);

COMMENT ON TABLE public.builder_project_access IS
  'Explicit Builder Portal project access grants. Mirrors solicitor_matter_access. Organisation membership is never on its own an authorization boundary.';

-- The exact-organisation rule. Mirrors enforce_solicitor_matter_access_firm(),
-- widened to the project''s two sides.
CREATE OR REPLACE FUNCTION public.builder_enforce_project_access_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_dev uuid; v_builder uuid; v_side_org uuid;
BEGIN
  SELECT developer_organisation_id, builder_organisation_id INTO v_dev, v_builder
  FROM public.builder_projects WHERE id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
  END IF;

  v_side_org := CASE NEW.organisation_side WHEN 'developer' THEN v_dev ELSE v_builder END;

  -- Exact and non-null, exactly as the Solicitor rule requires of firm_id.
  IF v_side_org IS NULL OR NEW.organisation_id <> v_side_org THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_PROJECT_ACCESS_ORG_MISMATCH',
      DETAIL='project access requires one exact non-null organisation on the named side';
  END IF;

  -- The grantee must actually belong to that organisation. Without this a grant
  -- could hand a user access through an organisation they are not a member of.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_active_membership(NEW.builder_user_id, NEW.organisation_id)
    WHERE membership_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_PROJECT_ACCESS_NO_MEMBERSHIP',
      DETAIL='the grantee holds no active membership of the granting organisation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_enforce_project_access_org ON public.builder_project_access;
CREATE TRIGGER trg_builder_enforce_project_access_org
  BEFORE INSERT OR UPDATE OF builder_user_id, project_id, organisation_id, organisation_side
  ON public.builder_project_access FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_project_access_org();

-- Mirrors prevent_solicitor_matter_access_firm_drift(): an organisation cannot
-- be moved out from under live grants.
CREATE OR REPLACE FUNCTION public.builder_prevent_project_access_org_drift()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.developer_organisation_id IS NOT DISTINCT FROM OLD.developer_organisation_id
     AND NEW.builder_organisation_id IS NOT DISTINCT FROM OLD.builder_organisation_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.builder_project_access
    WHERE project_id = OLD.id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_PROJECT_ACCESS_ORG_DRIFT',
      DETAIL='revoke active project access before changing a project organisation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_prevent_project_access_org_drift ON public.builder_projects;
CREATE TRIGGER trg_builder_prevent_project_access_org_drift
  BEFORE UPDATE OF developer_organisation_id, builder_organisation_id
  ON public.builder_projects FOR EACH ROW
  EXECUTE FUNCTION public.builder_prevent_project_access_org_drift();

-- Shared touch trigger, reused from Phase 1.
DROP TRIGGER IF EXISTS trg_builder_projects_touch ON public.builder_projects;
CREATE TRIGGER trg_builder_projects_touch
  BEFORE UPDATE ON public.builder_projects
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();
DROP TRIGGER IF EXISTS trg_builder_developments_touch ON public.builder_developments;
CREATE TRIGGER trg_builder_developments_touch
  BEFORE UPDATE ON public.builder_developments
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();
DROP TRIGGER IF EXISTS trg_builder_project_parties_touch ON public.builder_project_parties;
CREATE TRIGGER trg_builder_project_parties_touch
  BEFORE UPDATE ON public.builder_project_parties
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();
DROP TRIGGER IF EXISTS trg_builder_project_access_touch ON public.builder_project_access;
CREATE TRIGGER trg_builder_project_access_touch
  BEFORE UPDATE ON public.builder_project_access
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();

-- ===========================================================================
-- 6. Project-scoped permission resolution
--
-- Extends builder_resolve_permission with the project scope Phase 1 reserved
-- (`builder_membership_permissions.scope_type = 'project'`). The resolution
-- order is the Phase 1 order with the project grant layered on top, which is the
-- Solicitor `resolveTriStatePermissions(baseline, matter)` contract.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_resolve_project_permission(
  _user_id uuid, _project_id uuid, _permission_key text, _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_access public.builder_project_access;
  v_baseline boolean;
  v_override text;
  v_membership_id uuid;
  v_scoped text;
BEGIN
  IF _level NOT IN ('view','edit','delete') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_PERMISSION_LEVEL';
  END IF;

  -- 1. An explicit, live, in-window grant is required. No grant, no access —
  --    this is the whole boundary, and it is checked before anything else.
  SELECT * INTO v_access FROM public.builder_project_access
  WHERE builder_user_id = _user_id AND project_id = _project_id
    AND revoked_at IS NULL
    AND valid_from <= now()
    AND (valid_until IS NULL OR valid_until > now());
  IF v_access.id IS NULL THEN
    RETURN false;
  END IF;

  -- 2. HARD GATE: an active membership of the granting organisation is
  --    required, and it is resolved BEFORE any override can run.
  --
  --    builder_resolve_permission already returns false without one, but that is
  --    only a baseline: steps 3 and 4 below can raise a false baseline back to
  --    true with an explicit 'allow'. A revoked membership would then still
  --    reach the project through a stored override. Returning here means no
  --    override of any kind can restore access to a user whose membership is
  --    inactive, revoked or absent.
  SELECT membership_id INTO v_membership_id
  FROM public.builder_active_membership(_user_id, v_access.organisation_id);
  IF v_membership_id IS NULL THEN
    RETURN false;
  END IF;

  -- 3. The organisation baseline, resolved by the Phase 1 function. It denies
  --    forbidden keys, re-checks the membership and clamps read_only.
  v_baseline := public.builder_resolve_permission(
    _user_id, v_access.organisation_id, _permission_key, _level);

  -- 4. Project-scoped membership override from the Phase 1 seam. Reachable only
  --    because step 2 has already proven the membership is active.
  SELECT CASE _level WHEN 'view' THEN view_decision
                    WHEN 'edit' THEN edit_decision
                    ELSE delete_decision END
  INTO v_scoped
  FROM public.builder_membership_permissions
  WHERE membership_id = v_membership_id
    AND permission_key = _permission_key
    AND scope_type = 'project'
    AND scope_id = _project_id;
  IF v_scoped = 'deny' THEN
    RETURN false;
  ELSIF v_scoped = 'allow' THEN
    v_baseline := true;
  END IF;

  -- 5. The grant's own tri-state override. Explicit deny wins; explicit allow
  --    can raise a false baseline; inherit falls through.
  v_override := v_access.permissions #>> ARRAY[_permission_key, _level];
  IF v_override = 'deny' THEN
    RETURN false;
  ELSIF v_override = 'allow' THEN
    v_baseline := true;
  END IF;

  -- 6. A forbidden key can never be raised by a project grant. Re-asserted here
  --    because steps 4 and 5 can set the baseline true.
  IF EXISTS (
    SELECT 1 FROM public.builder_permission_keys
    WHERE permission_key = _permission_key AND is_forbidden
  ) OR NOT EXISTS (
    SELECT 1 FROM public.builder_permission_keys WHERE permission_key = _permission_key
  ) THEN
    RETURN false;
  END IF;

  -- 7. read_only on the grant clamps writes last, mirroring
  --    resolveMatterPermissions()'s read_only clamp.
  IF v_access.access_role = 'read_only' AND _level <> 'view' THEN
    RETURN false;
  END IF;

  RETURN COALESCE(v_baseline, false);
END $$;

-- Every project this user may see, with the organisation the access runs
-- through. Mirrors listAccessibleMatterIds().
CREATE OR REPLACE FUNCTION public.builder_accessible_projects(
  _user_id uuid, _organisation_id uuid DEFAULT NULL, _permission_key text DEFAULT 'projects')
RETURNS TABLE (project_id uuid, organisation_id uuid, organisation_side text, access_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.project_id, a.organisation_id, a.organisation_side, a.access_role
  FROM public.builder_project_access a
  WHERE a.builder_user_id = _user_id
    AND a.revoked_at IS NULL
    AND a.valid_from <= now()
    AND (a.valid_until IS NULL OR a.valid_until > now())
    AND (_organisation_id IS NULL OR a.organisation_id = _organisation_id)
    AND public.builder_resolve_project_permission(_user_id, a.project_id, _permission_key, 'view');
$$;

-- ===========================================================================
-- 7. Status transitions — mirrors is_legal_matter_transition_allowed /
--    transition_legal_matter
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_is_project_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    -- Cancelled and completed are terminal from the portal's point of view.
    WHEN _from IN ('completed','cancelled') THEN false
    WHEN _to = 'cancelled' THEN true
    WHEN _from = 'on_hold' THEN _to IN ('planning','pre_sales','approved','under_construction')
    WHEN _to = 'on_hold' THEN true
    WHEN _from = 'planning' THEN _to IN ('pre_sales','approved')
    WHEN _from = 'pre_sales' THEN _to IN ('approved','planning')
    WHEN _from = 'approved' THEN _to IN ('under_construction','pre_sales')
    WHEN _from = 'under_construction' THEN _to IN ('practical_completion')
    WHEN _from = 'practical_completion' THEN _to IN ('handover','under_construction')
    WHEN _from = 'handover' THEN _to IN ('completed','practical_completion')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.builder_transition_project(
  _project_id uuid,
  _expected_version bigint,
  _from text,
  _to text,
  _reason text,
  _actor_type text,
  _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.builder_projects; v_history_id uuid;
BEGIN
  IF NULLIF(btrim(_reason), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;

  SELECT * INTO p FROM public.builder_projects WHERE id = _project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
  END IF;
  IF p.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION';
  END IF;
  IF p.status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS';
  END IF;
  IF NOT public.builder_is_project_transition_allowed(_from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION';
  END IF;

  UPDATE public.builder_projects
  SET status = _to,
      row_version = row_version + 1,
      actual_completion_date = CASE WHEN _to = 'completed'
        THEN COALESCE(actual_completion_date, current_date) ELSE actual_completion_date END,
      actual_start_date = CASE WHEN _to = 'under_construction'
        THEN COALESCE(actual_start_date, current_date) ELSE actual_start_date END,
      closed_at = CASE WHEN _to IN ('completed','cancelled') THEN now() ELSE closed_at END,
      updated_at = now()
  WHERE id = _project_id
  RETURNING * INTO p;

  INSERT INTO public.builder_project_status_history(
    project_id, from_status, to_status, changed_by_type,
    changed_by_builder_user_id, changed_by_user_id, reason, metadata)
  VALUES (_project_id, _from, _to, _actor_type,
          _actor_builder_user_id, _actor_staff_user_id,
          left(btrim(_reason), 1000), jsonb_build_object('row_version', p.row_version))
  RETURNING id INTO v_history_id;

  -- A status change is a governed event: the trusted audit write happens in
  -- this transaction, so a failure rolls the transition back.
  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_project_status_changed',
    'project', p.id,
    COALESCE(p.developer_organisation_id, p.builder_organisation_id),
    _actor_builder_user_id,
    jsonb_build_object('status', _from),
    jsonb_build_object('status', _to, 'row_version', p.row_version),
    left(btrim(_reason), 1000),
    jsonb_build_object('history_id', v_history_id));

  RETURN to_jsonb(p);
END $$;

-- ===========================================================================
-- 8. Guarded access commands — fail closed on audit failure
--
-- Mirrors solicitor-portal-admin's upsert_matter_access / revoke_matter_access,
-- moved into the database so the audit write shares the transaction (Phase 0
-- NOCOPY-04). Same shape as Phase 1's builder_admin_upsert_membership.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_admin_upsert_project_access(
  _actor_user_id uuid,
  _actor_type text,
  _builder_user_id uuid,
  _project_id uuid,
  _organisation_side text,
  _access_role text,
  _permissions jsonb DEFAULT '{}'::jsonb,
  _valid_until timestamptz DEFAULT NULL,
  _expected_version bigint DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_project_access
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.builder_project_access;
  v_row public.builder_project_access;
  v_dev uuid; v_builder uuid; v_org uuid;
BEGIN
  IF _organisation_side NOT IN ('developer','builder') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_ORGANISATION_SIDE';
  END IF;
  IF _access_role NOT IN ('responsible','team_member','supervisor','read_only') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_ACCESS_ROLE';
  END IF;
  IF _valid_until IS NOT NULL AND _valid_until <= now() THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ACCESS_WINDOW_INVALID';
  END IF;

  SELECT developer_organisation_id, builder_organisation_id INTO v_dev, v_builder
  FROM public.builder_projects WHERE id = _project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
  END IF;
  v_org := CASE _organisation_side WHEN 'developer' THEN v_dev ELSE v_builder END;
  IF v_org IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_SIDE_UNASSIGNED';
  END IF;

  SELECT * INTO v_existing FROM public.builder_project_access
  WHERE builder_user_id = _builder_user_id AND project_id = _project_id
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;

    UPDATE public.builder_project_access
    SET organisation_id = v_org,
        organisation_side = _organisation_side,
        access_role = _access_role,
        permissions = COALESCE(_permissions, '{}'::jsonb),
        valid_until = _valid_until,
        revoked_at = NULL, revoked_by = NULL, revocation_reason = NULL,
        row_version = row_version + 1
    WHERE id = v_existing.id
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_project_access_updated',
      'project_access', v_row.id, v_org, _builder_user_id,
      jsonb_build_object('access_role', v_existing.access_role,
                         'organisation_side', v_existing.organisation_side,
                         'valid_until', v_existing.valid_until,
                         'revoked_at', v_existing.revoked_at),
      jsonb_build_object('access_role', v_row.access_role,
                         'organisation_side', v_row.organisation_side,
                         'valid_until', v_row.valid_until),
      _reason, jsonb_build_object('project_id', _project_id));
  ELSE
    INSERT INTO public.builder_project_access(
      builder_user_id, project_id, organisation_id, organisation_side,
      access_role, permissions, valid_until, granted_by)
    VALUES (_builder_user_id, _project_id, v_org, _organisation_side,
            _access_role, COALESCE(_permissions, '{}'::jsonb), _valid_until, _actor_user_id)
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_project_access_granted',
      'project_access', v_row.id, v_org, _builder_user_id,
      NULL,
      jsonb_build_object('access_role', v_row.access_role,
                         'organisation_side', v_row.organisation_side,
                         'valid_until', v_row.valid_until),
      _reason, jsonb_build_object('project_id', _project_id));
  END IF;

  -- Access changed, so every live session is re-evaluated from scratch.
  PERFORM public.builder_revoke_user_sessions(
    _builder_user_id, 'project_access_changed', NULL);

  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_admin_revoke_project_access(
  _actor_user_id uuid,
  _actor_type text,
  _access_id uuid,
  _expected_version bigint DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_project_access
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_project_access; v_row public.builder_project_access;
BEGIN
  SELECT * INTO v_existing FROM public.builder_project_access
  WHERE id = _access_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_ACCESS_NOT_FOUND';
  END IF;
  IF v_existing.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_ACCESS_ALREADY_REVOKED';
  END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version);
  END IF;

  UPDATE public.builder_project_access
  SET revoked_at = now(), revoked_by = _actor_user_id,
      revocation_reason = COALESCE(NULLIF(btrim(_reason), ''), 'Revoked by Command Centre'),
      row_version = row_version + 1
  WHERE id = v_existing.id
  RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_project_access_revoked',
    'project_access', v_row.id, v_row.organisation_id, v_row.builder_user_id,
    jsonb_build_object('revoked_at', NULL, 'access_role', v_existing.access_role),
    jsonb_build_object('revoked_at', v_row.revoked_at),
    _reason, jsonb_build_object('project_id', v_row.project_id));

  PERFORM public.builder_revoke_user_sessions(
    v_row.builder_user_id, 'project_access_revoked', NULL);

  RETURN v_row;
END $$;

-- ===========================================================================
-- 8c. Guarded write commands for the remaining Phase 3 mutations
--
-- Phase 3 originally wrote developments, projects and parties directly from the
-- Edge Functions and called logBuilderProjectActivity afterwards. That leaves
-- the state change committed when the audit write fails, which is exactly the
-- Solicitor defect Phase 0 recorded as NOCOPY-04.
--
-- Every mutation now runs here instead: the write and the trusted audit row
-- share one transaction, so a failed audit rolls the mutation back. Same shape
-- as builder_admin_upsert_project_access and builder_transition_project.
--
-- The Edge Functions keep their sanitisation and pass an already-cleaned jsonb
-- payload; these commands apply only whitelisted columns, and a key that is
-- absent from the payload leaves its column untouched.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_admin_upsert_development(
  _actor_user_id uuid,
  _actor_type text,
  _development_id uuid,
  _developer_organisation_id uuid,
  _payload jsonb DEFAULT '{}'::jsonb,
  _status text DEFAULT NULL,
  _expected_version bigint DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_developments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_developments; v_row public.builder_developments; v_org_status text;
BEGIN
  IF _status IS NOT NULL AND _status NOT IN ('planning','active','on_hold','completed','cancelled') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_DEVELOPMENT_STATUS';
  END IF;

  IF _development_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_developments
    WHERE id = _development_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DEVELOPMENT_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;

    UPDATE public.builder_developments SET
      name                  = CASE WHEN _payload ? 'name' THEN _payload->>'name' ELSE name END,
      development_reference = CASE WHEN _payload ? 'development_reference' THEN _payload->>'development_reference' ELSE development_reference END,
      description           = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      address_line          = CASE WHEN _payload ? 'address_line' THEN _payload->>'address_line' ELSE address_line END,
      suburb                = CASE WHEN _payload ? 'suburb' THEN _payload->>'suburb' ELSE suburb END,
      state                 = CASE WHEN _payload ? 'state' THEN _payload->>'state' ELSE state END,
      postcode              = CASE WHEN _payload ? 'postcode' THEN _payload->>'postcode' ELSE postcode END,
      status                = COALESCE(_status, status),
      row_version           = row_version + 1,
      updated_at            = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_development_updated',
      'development', v_row.id, v_row.developer_organisation_id, NULL,
      jsonb_build_object('name', v_existing.name, 'status', v_existing.status),
      jsonb_build_object('name', v_row.name, 'status', v_row.status,
                         'row_version', v_row.row_version),
      _reason, '{}'::jsonb);
    RETURN v_row;
  END IF;

  IF _developer_organisation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORGANISATION_REQUIRED';
  END IF;
  SELECT status INTO v_org_status FROM public.builder_organisations
  WHERE id = _developer_organisation_id;
  IF v_org_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;
  IF v_org_status = 'closed' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_CLOSED';
  END IF;

  INSERT INTO public.builder_developments(
    developer_organisation_id, name, development_reference, description,
    address_line, suburb, state, postcode, status)
  VALUES (_developer_organisation_id, _payload->>'name', _payload->>'development_reference',
          _payload->>'description', _payload->>'address_line', _payload->>'suburb',
          _payload->>'state', _payload->>'postcode', COALESCE(_status, 'planning'))
  RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_development_created',
    'development', v_row.id, v_row.developer_organisation_id, NULL,
    NULL, jsonb_build_object('name', v_row.name, 'status', v_row.status),
    _reason, '{}'::jsonb);
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_project(
  _actor_user_id uuid,
  _actor_type text,
  _actor_builder_user_id uuid,
  _project_id uuid,
  _payload jsonb DEFAULT '{}'::jsonb,
  _developer_organisation_id uuid DEFAULT NULL,
  _builder_organisation_id uuid DEFAULT NULL,
  _development_id uuid DEFAULT NULL,
  _expected_version bigint DEFAULT NULL,
  _reason text DEFAULT NULL)
RETURNS public.builder_projects
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_projects; v_row public.builder_projects; v_org_status text;
BEGIN
  IF _project_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_projects WHERE id = _project_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;

    -- Organisation columns are deliberately absent: they are set at creation and
    -- are protected afterwards by the org-drift trigger.
    UPDATE public.builder_projects SET
      project_reference           = CASE WHEN _payload ? 'project_reference' THEN _payload->>'project_reference' ELSE project_reference END,
      name                        = CASE WHEN _payload ? 'name' THEN _payload->>'name' ELSE name END,
      project_type                = CASE WHEN _payload ? 'project_type' THEN _payload->>'project_type' ELSE project_type END,
      address_line                = CASE WHEN _payload ? 'address_line' THEN _payload->>'address_line' ELSE address_line END,
      suburb                      = CASE WHEN _payload ? 'suburb' THEN _payload->>'suburb' ELSE suburb END,
      state                       = CASE WHEN _payload ? 'state' THEN _payload->>'state' ELSE state END,
      postcode                    = CASE WHEN _payload ? 'postcode' THEN _payload->>'postcode' ELSE postcode END,
      lot_number                  = CASE WHEN _payload ? 'lot_number' THEN _payload->>'lot_number' ELSE lot_number END,
      plan_number                 = CASE WHEN _payload ? 'plan_number' THEN _payload->>'plan_number' ELSE plan_number END,
      estimated_start_date        = CASE WHEN _payload ? 'estimated_start_date' THEN (_payload->>'estimated_start_date')::date ELSE estimated_start_date END,
      estimated_completion_date   = CASE WHEN _payload ? 'estimated_completion_date' THEN (_payload->>'estimated_completion_date')::date ELSE estimated_completion_date END,
      actual_start_date           = CASE WHEN _payload ? 'actual_start_date' THEN (_payload->>'actual_start_date')::date ELSE actual_start_date END,
      actual_completion_date      = CASE WHEN _payload ? 'actual_completion_date' THEN (_payload->>'actual_completion_date')::date ELSE actual_completion_date END,
      shared_summary              = CASE WHEN _payload ? 'shared_summary' THEN _payload->>'shared_summary' ELSE shared_summary END,
      risk_notes                  = CASE WHEN _payload ? 'risk_notes' THEN _payload->>'risk_notes' ELSE risk_notes END,
      risk_flag                   = CASE WHEN _payload ? 'risk_flag' THEN (_payload->>'risk_flag')::boolean ELSE risk_flag END,
      builder_notes               = CASE WHEN _payload ? 'builder_notes' THEN _payload->>'builder_notes' ELSE builder_notes END,
      npc_internal_notes          = CASE WHEN _payload ? 'npc_internal_notes' THEN _payload->>'npc_internal_notes' ELSE npc_internal_notes END,
      row_version                 = row_version + 1,
      updated_at                  = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_project_updated',
      'project', v_row.id,
      COALESCE(v_row.developer_organisation_id, v_row.builder_organisation_id),
      _actor_builder_user_id,
      jsonb_build_object('name', v_existing.name, 'row_version', v_existing.row_version),
      jsonb_build_object('name', v_row.name, 'row_version', v_row.row_version,
                         'fields', (SELECT jsonb_agg(k) FROM jsonb_object_keys(_payload) k)),
      _reason, '{}'::jsonb);
    RETURN v_row;
  END IF;

  IF _developer_organisation_id IS NULL AND _builder_organisation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORGANISATION_REQUIRED';
  END IF;
  FOR v_org_status IN
    SELECT o.status FROM public.builder_organisations o
    WHERE o.id IN (_developer_organisation_id, _builder_organisation_id)
  LOOP
    IF v_org_status = 'closed' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_CLOSED';
    END IF;
  END LOOP;

  INSERT INTO public.builder_projects(
    development_id, developer_organisation_id, builder_organisation_id,
    project_reference, name, project_type, address_line, suburb, state, postcode,
    lot_number, plan_number, estimated_start_date, estimated_completion_date,
    shared_summary, risk_notes, risk_flag, npc_internal_notes)
  VALUES (
    _development_id, _developer_organisation_id, _builder_organisation_id,
    _payload->>'project_reference', _payload->>'name',
    COALESCE(_payload->>'project_type', 'house_and_land'),
    _payload->>'address_line', _payload->>'suburb', _payload->>'state', _payload->>'postcode',
    _payload->>'lot_number', _payload->>'plan_number',
    (_payload->>'estimated_start_date')::date, (_payload->>'estimated_completion_date')::date,
    _payload->>'shared_summary', _payload->>'risk_notes',
    COALESCE((_payload->>'risk_flag')::boolean, false), _payload->>'npc_internal_notes')
  RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_project_created',
    'project', v_row.id,
    COALESCE(v_row.developer_organisation_id, v_row.builder_organisation_id),
    _actor_builder_user_id,
    NULL,
    jsonb_build_object('name', v_row.name, 'status', v_row.status,
                       'developer_organisation_id', v_row.developer_organisation_id,
                       'builder_organisation_id', v_row.builder_organisation_id),
    _reason, '{}'::jsonb);
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_project_party(
  _actor_user_id uuid,
  _actor_type text,
  _actor_builder_user_id uuid,
  _project_id uuid,
  _party_id uuid,
  _payload jsonb,
  _reason text DEFAULT NULL)
RETURNS public.builder_project_parties
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.builder_project_parties;
  v_row public.builder_project_parties;
  v_project public.builder_projects;
BEGIN
  SELECT * INTO v_project FROM public.builder_projects WHERE id = _project_id;
  IF v_project.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
  END IF;
  IF NULLIF(btrim(COALESCE(_payload->>'name','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PARTY_NAME_REQUIRED';
  END IF;

  IF _party_id IS NOT NULL THEN
    -- Scoped to the project: a party id belonging to another project matches
    -- no row and cannot be edited through this project's grant.
    SELECT * INTO v_existing FROM public.builder_project_parties
    WHERE id = _party_id AND project_id = _project_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PARTY_NOT_FOUND';
    END IF;

    UPDATE public.builder_project_parties SET
      role               = COALESCE(_payload->>'role', role),
      name               = _payload->>'name',
      organisation       = _payload->>'organisation',
      email              = _payload->>'email',
      phone              = _payload->>'phone',
      address            = _payload->>'address',
      reference          = _payload->>'reference',
      is_primary_contact = COALESCE((_payload->>'is_primary_contact')::boolean, false),
      notes              = _payload->>'notes',
      updated_at         = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_row;

    PERFORM public.builder_log_activity(
      _actor_user_id, _actor_type, 'builder_project_party_updated',
      'project_party', v_row.id,
      COALESCE(v_project.developer_organisation_id, v_project.builder_organisation_id),
      _actor_builder_user_id,
      jsonb_build_object('name', v_existing.name, 'role', v_existing.role),
      jsonb_build_object('name', v_row.name, 'role', v_row.role),
      _reason, jsonb_build_object('project_id', _project_id));
    RETURN v_row;
  END IF;

  INSERT INTO public.builder_project_parties(
    project_id, role, name, organisation, email, phone, address, reference,
    is_primary_contact, notes)
  VALUES (_project_id, COALESCE(_payload->>'role', 'other'), _payload->>'name',
          _payload->>'organisation', _payload->>'email', _payload->>'phone',
          _payload->>'address', _payload->>'reference',
          COALESCE((_payload->>'is_primary_contact')::boolean, false), _payload->>'notes')
  RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_project_party_added',
    'project_party', v_row.id,
    COALESCE(v_project.developer_organisation_id, v_project.builder_organisation_id),
    _actor_builder_user_id,
    NULL, jsonb_build_object('name', v_row.name, 'role', v_row.role),
    _reason, jsonb_build_object('project_id', _project_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_delete_project_party(
  _actor_user_id uuid,
  _actor_type text,
  _actor_builder_user_id uuid,
  _project_id uuid,
  _party_id uuid,
  _reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_project_parties; v_project public.builder_projects;
BEGIN
  SELECT * INTO v_project FROM public.builder_projects WHERE id = _project_id;
  IF v_project.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
  END IF;

  SELECT * INTO v_existing FROM public.builder_project_parties
  WHERE id = _party_id AND project_id = _project_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PARTY_NOT_FOUND';
  END IF;

  DELETE FROM public.builder_project_parties WHERE id = v_existing.id;

  -- Removing a party is destructive, so the audit row carries the whole record.
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_project_party_removed',
    'project_party', v_existing.id,
    COALESCE(v_project.developer_organisation_id, v_project.builder_organisation_id),
    _actor_builder_user_id,
    jsonb_build_object('name', v_existing.name, 'role', v_existing.role,
                       'organisation', v_existing.organisation),
    NULL,
    _reason, jsonb_build_object('project_id', _project_id));
  RETURN true;
END $$;

-- ===========================================================================
-- 8a. Enable the `project` permission scope
--
-- Phase 1's builder_guard_permission_scope() rejects every non-organisation
-- scope with "Project-level scopes are enabled when their tables are created".
-- Phase 3 creates them, so the guard is widened here — and only to `project`.
-- development / stage / unit stay blocked because their tables still do not
-- exist, and a scope pointing at nothing would be unresolvable.
--
-- Without this, builder_resolve_project_permission reads a project-scoped
-- override that could never have been stored.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_guard_permission_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.scope_type NOT IN ('organisation', 'project') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_SCOPE_NOT_AVAILABLE',
      DETAIL='Only organisation and project scopes exist. Stage and unit scopes are enabled when their tables are created.';
  END IF;

  -- A project scope must point at a project that actually exists, or the
  -- override is unresolvable and would sit in the table for ever.
  IF NEW.scope_type = 'project' THEN
    IF NEW.scope_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.builder_projects WHERE id = NEW.scope_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='BUILDER_SCOPE_TARGET_NOT_FOUND',
        DETAIL='a project-scoped permission must reference an existing project';
    END IF;
  END IF;

  -- View is the floor: denying view denies everything; allowing edit or delete
  -- implies view. Normalised on write so the resolver never has to repair it.
  -- Unchanged from Phase 1.
  IF NEW.view_decision = 'deny' THEN
    NEW.edit_decision := 'deny';
    NEW.delete_decision := 'deny';
  ELSIF NEW.edit_decision = 'allow' OR NEW.delete_decision = 'allow' THEN
    NEW.view_decision := 'allow';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ===========================================================================
-- 8b. Role defaults for the `projects` permission key
--
-- Phase 1 seeded role defaults only for the keys that existed then; `projects`
-- was catalogued but deliberately left unseeded, so it resolves false for every
-- role. Without this block the module ships unusable — the Phase 3 verification
-- caught exactly that. Seeded here, additively and idempotently, so the key
-- behaves like every other Phase 1 key.
--
-- Deny by default still holds: a role not listed here gets nothing, and the
-- project grant is still required on top of the organisation baseline.
-- ===========================================================================
INSERT INTO public.builder_role_default_permissions(
  membership_role, permission_key, can_view, can_edit, can_delete) VALUES
  -- owner and administrator may remove project parties, hence delete.
  ('owner',         'projects', true,  true,  true),
  ('administrator', 'projects', true,  true,  true),
  ('manager',       'projects', true,  true,  false),
  ('member',        'projects', true,  false, false),
  ('read_only',     'projects', true,  false, false)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 9. RLS and grants — deny by default, matching every other Builder object
-- ===========================================================================
ALTER TABLE public.builder_developments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_project_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_project_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_project_access ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_developments','builder_projects',
                           'builder_project_parties','builder_project_status_history',
                           'builder_project_access'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON public.%I', t, t);
    -- Scoped to auth.role() rather than USING (true): the Builder programme
    -- does not ship unrestricted policies (Phase 1 SEC rule).
    EXECUTE format($p$CREATE POLICY %I_service ON public.%I
      AS PERMISSIVE FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')$p$, t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.builder_resolve_project_permission(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_accessible_projects(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_is_project_transition_allowed(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_transition_project(uuid, bigint, text, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_upsert_project_access(uuid, text, uuid, uuid, text, text, jsonb, timestamptz, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_revoke_project_access(uuid, text, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_admin_upsert_development(uuid, text, uuid, uuid, jsonb, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_upsert_project(uuid, text, uuid, uuid, jsonb, uuid, uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_upsert_project_party(uuid, text, uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_delete_project_party(uuid, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.builder_resolve_project_permission(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_accessible_projects(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_is_project_transition_allowed(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_transition_project(uuid, bigint, text, text, text, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_upsert_project_access(uuid, text, uuid, uuid, text, text, jsonb, timestamptz, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_revoke_project_access(uuid, text, uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_admin_upsert_development(uuid, text, uuid, uuid, jsonb, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_upsert_project(uuid, text, uuid, uuid, jsonb, uuid, uuid, uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_upsert_project_party(uuid, text, uuid, uuid, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_delete_project_party(uuid, text, uuid, uuid, uuid, text) TO service_role;

-- ===========================================================================
-- 10. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_resolve_project_permission','builder_accessible_projects',
    'builder_is_project_transition_allowed','builder_transition_project',
    'builder_admin_upsert_project_access','builder_admin_revoke_project_access',
    'builder_admin_upsert_development','builder_upsert_project',
    'builder_upsert_project_party','builder_delete_project_party',
    'builder_enforce_project_access_org','builder_prevent_project_access_org_drift']) AS f
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: Phase 3 function(s) missing: %', v_missing;
  END IF;

  -- Every Phase 3 table must be RLS-protected.
  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('builder_developments','builder_projects','builder_project_parties',
                      'builder_project_status_history','builder_project_access')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  -- Phase 3 must not have introduced a later-phase table.
  SELECT string_agg(table_name, ', ') INTO v_missing
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('builder_stages','builder_lots','builder_units',
                       'builder_inventory','builder_reservations','builder_transactions',
                       'builder_variations','builder_progress_claims','builder_inspections',
                       'builder_defects','builder_handovers');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: later-phase table(s) present: %', v_missing;
  END IF;

  -- The projects key must carry a role baseline, or every grant resolves false.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_role_default_permissions
    WHERE permission_key = 'projects' AND membership_role = 'manager' AND can_view
  ) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the projects permission key has no role baseline';
  END IF;

  RAISE NOTICE 'builder phase 3: developments, projects, parties, status history and project access installed';
END $$;
