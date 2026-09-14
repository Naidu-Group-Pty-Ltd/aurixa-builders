-- Builder / Developer Portal — Phase 1: deny-by-default permission foundation.
--
-- This is the deliberate correction of Phase 0 finding NOCOPY-01. The Solicitor
-- Portal shipped `DEFAULT_ALLOW_KEYS` plus an OR-merge, so an unconfigured key
-- was allowed and a per-client override could not reduce a baseline allow.
-- Builder starts from the corrected model and never ships the broken one, so
-- there is no legacy resolution path to roll back to.
--
-- Resolution contract, enforced by builder_resolve_permission():
--   1. A forbidden key is denied first and can never be granted.
--   2. No active membership means no access.
--   3. An unconfigured key resolves to false (deny by default).
--   4. Role defaults supply the baseline; membership overrides refine it.
--   5. An explicit deny beats an allow at the same or broader scope.
--   6. read_only clamps edit and delete after resolution.

-- ===========================================================================
-- 1. Permission key catalogue
--
-- Data, not DDL. A future capability adds a row, never a migration to an enum.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_permission_keys (
  permission_key text PRIMARY KEY CHECK (permission_key ~ '^[a-z][a-z0-9_]*$'),
  description text NOT NULL,
  -- 'inbound_projection' keys are read-only views of another portal's data:
  -- their edit and delete levels can never resolve true.
  key_kind text NOT NULL DEFAULT 'builder_owned'
    CHECK (key_kind IN ('builder_owned','inbound_projection')),
  -- A forbidden key is hard-denied inside builder_resolve_permission() no matter
  -- what any role default or membership override says.
  is_forbidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.builder_permission_keys(permission_key, description, key_kind, is_forbidden) VALUES
  ('organisation',     'Organisation profile and settings',            'builder_owned',      false),
  ('org_admin',        'Manage organisation users, memberships, roles','builder_owned',      false),
  ('projects',         'Projects and developments (Phase 2)',          'builder_owned',      false),
  ('inventory',        'Property inventory and availability (Phase 2)','builder_owned',      false),
  ('pricing',          'Unit pricing and release state (Phase 2)',     'builder_owned',      false),
  ('reservations',     'Reservations, holds and allocations (Phase 2)','builder_owned',      false),
  ('transactions',     'Builder transactions (Phase 2)',               'builder_owned',      false),
  ('contracts',        'Contract issue and execution (Phase 2)',       'builder_owned',      false),
  ('construction',     'Construction cases and milestones (Phase 2)',  'builder_owned',      false),
  ('variations',       'Variations (Phase 2)',                         'builder_owned',      false),
  ('progress_claims',  'Progress claims (Phase 2)',                    'builder_owned',      false),
  ('inspections',      'Inspections (Phase 2)',                        'builder_owned',      false),
  ('defects',          'Defects and rectification (Phase 2)',          'builder_owned',      false),
  ('handover',         'Handover and warranty (Phase 2)',              'builder_owned',      false),
  ('documents',        'Builder documents',                            'builder_owned',      false),
  ('messages',         'Conversations',                                'builder_owned',      false),
  ('tasks',            'Tasks',                                        'builder_owned',      false),
  ('audit',            'Builder audit records',                        'builder_owned',      false),
  -- Read-only inbound projections. Never writable by a Builder user.
  ('finance_status',   'Sanitised finance status projection',          'inbound_projection', false),
  ('legal_status',     'Sanitised legal status projection',            'inbound_projection', false),
  ('settlement_status','Settlement readiness projection',              'inbound_projection', false),
  -- Permanently forbidden. Present so an attempt to grant one is a visible,
  -- auditable failure rather than a silent no-op.
  ('income',              'FORBIDDEN: client income',                  'builder_owned', true),
  ('expenses',            'FORBIDDEN: client expenses',                'builder_owned', true),
  ('assets',              'FORBIDDEN: client assets',                  'builder_owned', true),
  ('liabilities',         'FORBIDDEN: client liabilities',             'builder_owned', true),
  ('employment',          'FORBIDDEN: client employment',              'builder_owned', true),
  ('borrowing_capacity',  'FORBIDDEN: borrowing capacity',             'builder_owned', true),
  ('serviceability',      'FORBIDDEN: serviceability',                 'builder_owned', true),
  ('commissions',         'FORBIDDEN: commission ledgers',             'builder_owned', true),
  ('aml_restricted',      'FORBIDDEN: AML/CTF records',                'builder_owned', true),
  ('smr',                 'FORBIDDEN: suspicious matter reports',      'builder_owned', true),
  ('mlro',                'FORBIDDEN: MLRO notes',                     'builder_owned', true),
  ('legal_privileged',    'FORBIDDEN: privileged legal advice',        'builder_owned', true),
  ('conflict_checks',     'FORBIDDEN: conflict check results',         'builder_owned', true),
  ('finance_private',     'FORBIDDEN: finance-private notes',          'builder_owned', true),
  ('command_private',     'FORBIDDEN: Command Centre private notes',   'builder_owned', true),
  ('solicitor_private',   'FORBIDDEN: solicitor-private notes',        'builder_owned', true)
ON CONFLICT (permission_key) DO NOTHING;

-- ===========================================================================
-- 2. Role defaults
--
-- Five broad roles. Anything not listed here resolves to deny.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_role_default_permissions (
  membership_role text NOT NULL CHECK (membership_role IN
    ('owner','administrator','manager','member','read_only')),
  permission_key text NOT NULL REFERENCES public.builder_permission_keys(permission_key) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (membership_role, permission_key),
  -- edit or delete without view is incoherent and must not be storable.
  CONSTRAINT builder_role_defaults_view_implied CHECK (can_view OR (NOT can_edit AND NOT can_delete))
);

-- A forbidden key can never carry a default. Enforced, not merely conventional.
CREATE OR REPLACE FUNCTION public.builder_guard_permission_grant()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE forbidden boolean; kind text;
BEGIN
  SELECT is_forbidden, key_kind INTO forbidden, kind
  FROM public.builder_permission_keys WHERE permission_key = NEW.permission_key;

  IF forbidden IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_UNKNOWN_PERMISSION_KEY';
  END IF;
  IF forbidden THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_FORBIDDEN_PERMISSION_KEY';
  END IF;

  -- Inbound projections are read-only in every direction.
  IF kind = 'inbound_projection' THEN
    IF TG_TABLE_NAME = 'builder_role_default_permissions' THEN
      IF NEW.can_edit OR NEW.can_delete THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECTION_NOT_WRITABLE';
      END IF;
    ELSE
      IF NEW.edit_decision = 'allow' OR NEW.delete_decision = 'allow' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECTION_NOT_WRITABLE';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_role_defaults_guard ON public.builder_role_default_permissions;
CREATE TRIGGER trg_builder_role_defaults_guard
  BEFORE INSERT OR UPDATE ON public.builder_role_default_permissions
  FOR EACH ROW EXECUTE FUNCTION public.builder_guard_permission_grant();

INSERT INTO public.builder_role_default_permissions(membership_role, permission_key, can_view, can_edit, can_delete) VALUES
  -- owner: full control of the organisation surface that exists in Phase 1
  ('owner','organisation',true,true,false),
  ('owner','org_admin',true,true,true),
  ('owner','documents',true,true,false),
  ('owner','messages',true,true,false),
  ('owner','tasks',true,true,false),
  ('owner','audit',true,false,false),
  ('owner','finance_status',true,false,false),
  ('owner','legal_status',true,false,false),
  ('owner','settlement_status',true,false,false),
  -- administrator: manages people, not commercial settings
  ('administrator','organisation',true,true,false),
  ('administrator','org_admin',true,true,false),
  ('administrator','documents',true,true,false),
  ('administrator','messages',true,true,false),
  ('administrator','tasks',true,true,false),
  ('administrator','audit',true,false,false),
  -- manager: operational, no user administration
  ('manager','organisation',true,false,false),
  ('manager','documents',true,true,false),
  ('manager','messages',true,true,false),
  ('manager','tasks',true,true,false),
  ('manager','finance_status',true,false,false),
  ('manager','settlement_status',true,false,false),
  -- member: day-to-day participation
  ('member','organisation',true,false,false),
  ('member','documents',true,false,false),
  ('member','messages',true,true,false),
  ('member','tasks',true,true,false),
  -- read_only: observation only. The clamp in the resolver enforces this even
  -- if a future default were mis-seeded.
  ('read_only','organisation',true,false,false),
  ('read_only','documents',true,false,false),
  ('read_only','messages',true,false,false),
  ('read_only','tasks',true,false,false)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 3. Per-membership tri-state overrides
--
-- Values are inherit | allow | deny. There is no boolean matrix and no OR-merge,
-- so an override can always reduce a role default — the specific defect the
-- Solicitor Portal could not express.
--
-- scope_type is present so Phase 2 project-level access needs no schema change.
-- Only 'organisation' is usable in Phase 1; the guard below rejects the rest
-- because the scope tables do not exist yet. Deny-by-default for unimplemented
-- scopes, rather than a column that silently accepts unverifiable identifiers.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_membership_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES public.builder_organisation_memberships(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.builder_permission_keys(permission_key) ON DELETE CASCADE,

  scope_type text NOT NULL DEFAULT 'organisation'
    CHECK (scope_type IN ('organisation','development','project','stage','unit')),
  scope_id uuid,

  view_decision   text NOT NULL DEFAULT 'inherit' CHECK (view_decision   IN ('inherit','allow','deny')),
  edit_decision   text NOT NULL DEFAULT 'inherit' CHECK (edit_decision   IN ('inherit','allow','deny')),
  delete_decision text NOT NULL DEFAULT 'inherit' CHECK (delete_decision IN ('inherit','allow','deny')),

  reason text,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT builder_membership_permissions_scope_shape CHECK (
    (scope_type = 'organisation' AND scope_id IS NULL)
    OR (scope_type <> 'organisation' AND scope_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_membership_permissions_org_scope_key
  ON public.builder_membership_permissions(membership_id, permission_key)
  WHERE scope_type = 'organisation';
CREATE UNIQUE INDEX IF NOT EXISTS builder_membership_permissions_scoped_key
  ON public.builder_membership_permissions(membership_id, permission_key, scope_type, scope_id)
  WHERE scope_type <> 'organisation';

DROP TRIGGER IF EXISTS trg_builder_membership_permissions_guard ON public.builder_membership_permissions;
CREATE TRIGGER trg_builder_membership_permissions_guard
  BEFORE INSERT OR UPDATE ON public.builder_membership_permissions
  FOR EACH ROW EXECUTE FUNCTION public.builder_guard_permission_grant();

-- Phase 1 has no scope tables below the organisation. Accepting a project or
-- unit id now would mean storing an identifier nothing can verify.
CREATE OR REPLACE FUNCTION public.builder_guard_permission_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.scope_type <> 'organisation' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='BUILDER_SCOPE_NOT_AVAILABLE',
      DETAIL='Only organisation-scoped permissions exist in Phase 1. Project-level scopes are enabled when their tables are created.';
  END IF;
  -- View is the floor: denying view denies everything; allowing edit or delete
  -- implies view. Normalised on write so the resolver never has to repair it.
  IF NEW.view_decision = 'deny' THEN
    NEW.edit_decision := 'deny';
    NEW.delete_decision := 'deny';
  ELSIF NEW.edit_decision = 'allow' OR NEW.delete_decision = 'allow' THEN
    NEW.view_decision := 'allow';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_permission_scope ON public.builder_membership_permissions;
CREATE TRIGGER trg_builder_permission_scope
  BEFORE INSERT OR UPDATE ON public.builder_membership_permissions
  FOR EACH ROW EXECUTE FUNCTION public.builder_guard_permission_scope();

-- ===========================================================================
-- 4. Server-side resolution
--
-- These are the ONLY sanctioned way to answer "may this user do this?".
-- Every argument is a server-held value. Nothing here trusts a browser-supplied
-- organisation id, role or permission: the caller passes a user id and an
-- organisation id, and the function re-derives the membership itself.
-- ===========================================================================

-- Resolve the caller's live membership for one organisation, or NULL.
CREATE OR REPLACE FUNCTION public.builder_active_membership(_user_id uuid, _org_id uuid)
RETURNS TABLE (membership_id uuid, membership_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.membership_role
  FROM public.builder_organisation_memberships m
  JOIN public.builder_portal_users u ON u.id = m.builder_user_id
  JOIN public.builder_organisations o ON o.id = m.organisation_id
  WHERE m.builder_user_id = _user_id
    AND m.organisation_id = _org_id
    AND m.status = 'active'
    AND m.revoked_at IS NULL
    AND m.valid_from <= now()
    AND (m.valid_until IS NULL OR m.valid_until > now())
    AND u.is_active AND u.status = 'active' AND u.revoked_at IS NULL
    AND o.is_active AND o.status = 'active'
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.builder_active_membership(uuid, uuid) IS
  'Server-side membership resolution. Returns no row unless the user, the organisation and the membership are all active and the membership is inside its validity window.';

-- The organisations a user may reach at all. Used to scope every list query so
-- a request never widens beyond the caller''s verified set.
CREATE OR REPLACE FUNCTION public.builder_accessible_organisations(_user_id uuid)
RETURNS TABLE (organisation_id uuid, membership_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.organisation_id, m.membership_role
  FROM public.builder_organisation_memberships m
  JOIN public.builder_portal_users u ON u.id = m.builder_user_id
  JOIN public.builder_organisations o ON o.id = m.organisation_id
  WHERE m.builder_user_id = _user_id
    AND m.status = 'active' AND m.revoked_at IS NULL
    AND m.valid_from <= now()
    AND (m.valid_until IS NULL OR m.valid_until > now())
    AND u.is_active AND u.status = 'active' AND u.revoked_at IS NULL
    AND o.is_active AND o.status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.builder_resolve_permission(
  _user_id uuid, _org_id uuid, _permission_key text, _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_membership_id uuid;
  v_role text;
  v_forbidden boolean;
  v_kind text;
  v_baseline boolean := false;
  v_override text;
BEGIN
  IF _level NOT IN ('view','edit','delete') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_PERMISSION_LEVEL';
  END IF;

  -- 1. Forbidden keys are denied before anything else is consulted. An unknown
  --    key is also denied: deny by default extends to typos.
  SELECT is_forbidden, key_kind INTO v_forbidden, v_kind
  FROM public.builder_permission_keys WHERE permission_key = _permission_key;
  IF v_forbidden IS NULL OR v_forbidden THEN
    RETURN false;
  END IF;

  -- 2. Inbound projections are never writable.
  IF v_kind = 'inbound_projection' AND _level <> 'view' THEN
    RETURN false;
  END IF;

  -- 3. No active membership means no access. This is also the cross-organisation
  --    boundary: a user asking about an organisation they do not belong to
  --    resolves no membership and is denied.
  SELECT membership_id, membership_role INTO v_membership_id, v_role
  FROM public.builder_active_membership(_user_id, _org_id);
  IF v_membership_id IS NULL THEN
    RETURN false;
  END IF;

  -- 4. Role default supplies the baseline. Unconfigured resolves to false.
  SELECT CASE _level WHEN 'view' THEN can_view WHEN 'edit' THEN can_edit ELSE can_delete END
  INTO v_baseline
  FROM public.builder_role_default_permissions
  WHERE membership_role = v_role AND permission_key = _permission_key;
  v_baseline := COALESCE(v_baseline, false);

  -- 5. Membership override refines the baseline. An explicit deny always wins;
  --    an explicit allow can raise a false baseline. 'inherit' falls through.
  SELECT CASE _level WHEN 'view' THEN view_decision WHEN 'edit' THEN edit_decision ELSE delete_decision END
  INTO v_override
  FROM public.builder_membership_permissions
  WHERE membership_id = v_membership_id
    AND permission_key = _permission_key
    AND scope_type = 'organisation';

  IF v_override = 'deny' THEN
    RETURN false;
  ELSIF v_override = 'allow' THEN
    v_baseline := true;
  END IF;

  -- 6. read_only clamps write levels last, after every other decision.
  IF v_role = 'read_only' AND _level <> 'view' THEN
    RETURN false;
  END IF;

  RETURN v_baseline;
END $$;

COMMENT ON FUNCTION public.builder_resolve_permission(uuid, uuid, text, text) IS
  'Deny-by-default Builder permission resolution. Forbidden keys are denied first; an unknown key is denied; no active membership is denied; an unconfigured key is denied; an explicit membership deny overrides a role allow; read_only clamps edit and delete.';

-- ===========================================================================
-- 5. RLS — deny by default
-- ===========================================================================
ALTER TABLE public.builder_permission_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_role_default_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_membership_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_permission_keys_service ON public.builder_permission_keys;
CREATE POLICY builder_permission_keys_service ON public.builder_permission_keys
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS builder_role_defaults_service ON public.builder_role_default_permissions;
CREATE POLICY builder_role_defaults_service ON public.builder_role_default_permissions
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS builder_membership_permissions_service ON public.builder_membership_permissions;
CREATE POLICY builder_membership_permissions_service ON public.builder_membership_permissions
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.builder_permission_keys FROM anon, authenticated;
REVOKE ALL ON public.builder_role_default_permissions FROM anon, authenticated;
REVOKE ALL ON public.builder_membership_permissions FROM anon, authenticated;
GRANT ALL ON public.builder_permission_keys TO service_role;
GRANT ALL ON public.builder_role_default_permissions TO service_role;
GRANT ALL ON public.builder_membership_permissions TO service_role;

REVOKE ALL ON FUNCTION public.builder_active_membership(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_accessible_organisations(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_resolve_permission(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_active_membership(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_accessible_organisations(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_resolve_permission(uuid, uuid, text, text) TO service_role;
