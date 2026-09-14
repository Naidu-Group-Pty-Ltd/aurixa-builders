-- Builder / Developer Portal — Phase 1: organisations, users and memberships.
--
-- ADR 018 (separate external portal) and ADR 019 (Builder domain records are
-- separate from transaction_cases). Identity foundation only: no development,
-- project, stage, lot, unit, reservation, sale, construction, variation, claim,
-- inspection, defect, handover or warranty object is created here.
--
-- Corrections applied to the Solicitor Portal reference:
--   * portal_role is text + CHECK, never a Postgres enum (Phase 0 MIG-09).
--   * No plaintext session-token column is ever created (Phase 0 NOCOPY-02).
--   * Access is membership-scoped and deny-by-default from the first row
--     (Phase 0 NOCOPY-01); there is no default-allow key set to roll back to.

-- ===========================================================================
-- 1. Builder / developer organisations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  legal_name text NOT NULL CHECK (btrim(legal_name) <> ''),
  trading_name text,

  -- An organisation may be a developer, a builder, both, or an authorised sales
  -- representative acting for one. 'party_role' on a project (Phase 2) records
  -- what an organisation does on a specific project; this records what it is.
  org_type text NOT NULL CHECK (org_type IN
    ('developer','builder','builder_developer','sales_representative')),

  -- Australian company identifiers. Stored digits-only; formatting is a display
  -- concern. ACN applies to companies, not to trusts or partnerships, so it is
  -- optional while ABN is validated when present.
  abn text CHECK (abn IS NULL OR abn ~ '^[0-9]{11}$'),
  acn text CHECK (acn IS NULL OR acn ~ '^[0-9]{9}$'),

  contact_email text CHECK (contact_email IS NULL OR contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  contact_phone text,
  website text,
  address_line1 text,
  address_line2 text,
  suburb text,
  state text CHECK (state IS NULL OR state IN ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')),
  postcode text CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),

  -- Lifecycle status is the administrative state machine; is_active is the fast
  -- access gate every authorization path reads. status='active' implies
  -- is_active, enforced below, so the two can never contradict each other.
  status text NOT NULL DEFAULT 'pending_activation' CHECK (status IN
    ('pending_activation','active','suspended','closed')),
  is_active boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  suspended_at timestamptz,
  suspension_reason text,

  notes text,

  -- Audit metadata and optimistic concurrency.
  created_by uuid,
  updated_by uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT builder_organisations_status_active_agree CHECK (
    (status = 'active' AND is_active) OR (status <> 'active' AND NOT is_active)),
  CONSTRAINT builder_organisations_activation_stamp CHECK (
    status <> 'active' OR activated_at IS NOT NULL),
  CONSTRAINT builder_organisations_suspension_stamp CHECK (
    status <> 'suspended' OR suspended_at IS NOT NULL)
);

-- An ABN identifies exactly one legal entity. Nulls are allowed (trusts and
-- pre-registration entities) but a populated ABN must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS builder_organisations_abn_key
  ON public.builder_organisations(abn) WHERE abn IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS builder_organisations_acn_key
  ON public.builder_organisations(acn) WHERE acn IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS builder_organisations_legal_name_key
  ON public.builder_organisations(lower(btrim(legal_name)));
CREATE INDEX IF NOT EXISTS builder_organisations_active_idx
  ON public.builder_organisations(is_active, org_type) WHERE is_active;

COMMENT ON TABLE public.builder_organisations IS
  'Builder and developer legal entities. Never auto-created from free-text builder names on client_deals or build_progress_payments; every row is created deliberately through the Command Centre administration plane.';

-- ===========================================================================
-- 2. Builder Portal users
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  email text NOT NULL CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  phone text,

  -- Free text, display only. Job titles such as "development manager" or "site
  -- supervisor" live here; they are NOT roles and grant nothing (Phase 0
  -- MIG-09: no large fixed enum of job titles).
  job_title text,

  password_hash text,
  must_change_password boolean NOT NULL DEFAULT true,
  password_changed_at timestamptz,

  -- Invitation and reset artefacts are stored hashed. There is deliberately no
  -- session_token column: Builder sessions live only in
  -- builder_portal_sessions and only as a hash.
  invite_token_hash text CHECK (invite_token_hash IS NULL OR invite_token_hash ~ '^[0-9a-f]{64}$'),
  invite_token_expires_at timestamptz,
  invite_accepted_at timestamptz,
  invited_by uuid,
  invited_at timestamptz,

  reset_token_hash text CHECK (reset_token_hash IS NULL OR reset_token_hash ~ '^[0-9a-f]{64}$'),
  reset_token_expires_at timestamptz,
  reset_attempts integer NOT NULL DEFAULT 0 CHECK (reset_attempts >= 0),

  status text NOT NULL DEFAULT 'invited' CHECK (status IN
    ('invited','active','suspended','revoked')),
  is_active boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  revoked_reason text,

  has_accepted_current_terms boolean NOT NULL DEFAULT false,
  has_completed_onboarding boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,

  created_by uuid,
  updated_by uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT builder_portal_users_status_active_agree CHECK (
    (status = 'active' AND is_active) OR (status <> 'active' AND NOT is_active)),
  CONSTRAINT builder_portal_users_revocation_stamp CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_portal_users_email_key
  ON public.builder_portal_users(lower(btrim(email)));
CREATE INDEX IF NOT EXISTS builder_portal_users_active_idx
  ON public.builder_portal_users(is_active) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS builder_portal_users_invite_token_key
  ON public.builder_portal_users(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS builder_portal_users_reset_token_key
  ON public.builder_portal_users(reset_token_hash) WHERE reset_token_hash IS NOT NULL;

COMMENT ON COLUMN public.builder_portal_users.job_title IS
  'Display-only job title. Confers no access. Authorization comes from builder_organisation_memberships.membership_role plus permission grants.';

-- ===========================================================================
-- 3. Organisation memberships
--
-- A user has NO portal access without an active membership. Membership is the
-- only thing that binds a user to an organisation; there is no organisation_id
-- column on builder_portal_users, so a user cannot be silently reassigned and
-- cannot belong to an organisation without an auditable, revocable grant.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_organisation_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,

  -- Five broad, stable roles. Job titles are NOT roles (see job_title above).
  -- Widening this list is a cheap CHECK replacement, never an enum ALTER.
  membership_role text NOT NULL CHECK (membership_role IN
    ('owner','administrator','manager','member','read_only')),

  is_primary boolean NOT NULL DEFAULT false,

  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  revoked_at timestamptz,
  revoked_reason text,

  granted_by uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT builder_memberships_validity_order CHECK (
    valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT builder_memberships_revocation_stamp CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL)
);

-- One live membership per (user, organisation). A revoked membership is kept
-- for audit and does not block a later re-grant.
CREATE UNIQUE INDEX IF NOT EXISTS builder_memberships_live_key
  ON public.builder_organisation_memberships(builder_user_id, organisation_id)
  WHERE revoked_at IS NULL;

-- At most one primary organisation per user.
CREATE UNIQUE INDEX IF NOT EXISTS builder_memberships_one_primary_key
  ON public.builder_organisation_memberships(builder_user_id)
  WHERE is_primary AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS builder_memberships_org_idx
  ON public.builder_organisation_memberships(organisation_id, status)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS builder_memberships_user_idx
  ON public.builder_organisation_memberships(builder_user_id, status)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.builder_organisation_memberships IS
  'Binds a Builder Portal user to an organisation. No active membership means no portal access. A developer and a builder may be separate organisations; a user may hold memberships in more than one.';

-- ===========================================================================
-- 4. Shared triggers: updated_at and row_version
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_touch_row()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  -- row_version is server-owned. A client may send expected_version to a guarded
  -- command, but can never set the stored value directly.
  NEW.row_version := COALESCE(OLD.row_version, 0) + 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_organisations_touch ON public.builder_organisations;
CREATE TRIGGER trg_builder_organisations_touch
  BEFORE UPDATE ON public.builder_organisations
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();

DROP TRIGGER IF EXISTS trg_builder_portal_users_touch ON public.builder_portal_users;
CREATE TRIGGER trg_builder_portal_users_touch
  BEFORE UPDATE ON public.builder_portal_users
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();

DROP TRIGGER IF EXISTS trg_builder_memberships_touch ON public.builder_organisation_memberships;
CREATE TRIGGER trg_builder_memberships_touch
  BEFORE UPDATE ON public.builder_organisation_memberships
  FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row();

-- A membership may only reference an organisation that is not closed, and a
-- membership can never be created for a revoked user.
CREATE OR REPLACE FUNCTION public.builder_guard_membership()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE org_status text; user_status text;
BEGIN
  SELECT status INTO org_status FROM public.builder_organisations WHERE id = NEW.organisation_id;
  IF org_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;
  IF org_status = 'closed' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_CLOSED';
  END IF;

  SELECT status INTO user_status FROM public.builder_portal_users WHERE id = NEW.builder_user_id;
  IF user_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;
  IF user_status = 'revoked' AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_REVOKED';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_guard_membership ON public.builder_organisation_memberships;
CREATE TRIGGER trg_builder_guard_membership
  BEFORE INSERT OR UPDATE OF builder_user_id, organisation_id, status
  ON public.builder_organisation_memberships
  FOR EACH ROW EXECUTE FUNCTION public.builder_guard_membership();

-- ===========================================================================
-- 5. Row Level Security — deny by default
--
-- No policy exists for anon or authenticated, so RLS denies them outright.
-- The service_role policy carries a grounded predicate rather than a bare
-- USING (true): the Builder Portal and its administration plane both reach
-- these tables exclusively through service-role Edge Functions.
-- ===========================================================================
ALTER TABLE public.builder_organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_organisation_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS builder_organisations_service ON public.builder_organisations;
CREATE POLICY builder_organisations_service ON public.builder_organisations
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS builder_portal_users_service ON public.builder_portal_users;
CREATE POLICY builder_portal_users_service ON public.builder_portal_users
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS builder_memberships_service ON public.builder_organisation_memberships;
CREATE POLICY builder_memberships_service ON public.builder_organisation_memberships
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Defence in depth: even with a future permissive policy, the browser-facing
-- roles hold no table privileges on Builder identity.
REVOKE ALL ON public.builder_organisations FROM anon, authenticated;
REVOKE ALL ON public.builder_portal_users FROM anon, authenticated;
REVOKE ALL ON public.builder_organisation_memberships FROM anon, authenticated;
GRANT ALL ON public.builder_organisations TO service_role;
GRANT ALL ON public.builder_portal_users TO service_role;
GRANT ALL ON public.builder_organisation_memberships TO service_role;
