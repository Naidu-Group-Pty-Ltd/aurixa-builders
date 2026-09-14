-- Builder / Developer Portal — Transactions: the sale of a unit, its lifecycle,
-- the pipeline view over that lifecycle, the transaction-case link slot
-- (GEN-09 / MIG-02) and the client link.
--
-- Additive only. Every Phase 1, 2, 3 and Inventory object is reused unchanged.
--
-- Solicitor blueprint:
--   legal_matters is the closest analogue — the aggregate that carries a client,
--   a lifecycle and a link into transaction_cases. Transactions follow that
--   shape exactly:
--
--     legal_matters                 -> builder_transactions
--     legal_matter_status_history   -> builder_transaction_status_history
--     transition_legal_matter()     -> builder_transition_transaction()
--     transaction_case_links
--       .legal_matter_id            -> transaction_case_links
--                                        .builder_transaction_id  (the 4th slot)
--
-- Access: a transaction is reached through its PROJECT, exactly as a unit is.
-- There is no third access table — `builder_project_access` remains the only
-- grant in the programme.
--
-- DATA BOUNDARY: this module records the Builder's own view of the sale —
-- contract price, deposit, contract and settlement dates. It deliberately holds
-- no cost, margin, supplier price, commission, client financial position, AML
-- determination or Solicitor-private field. Finance owns receipt and
-- reconciliation; Legal owns the conveyancing matter; both are reached through
-- the shared case, never copied here.

-- ===========================================================================
-- 0. Prerequisites
-- ===========================================================================

-- The scope gains `transaction`. TWO things gate a scope value and BOTH must be
-- widened, or the override can never be stored and the resolver reads a row that
-- cannot exist: the column CHECK from Phase 1, and the trigger guard. Widening
-- only the trigger is the defect the local verification catches.
ALTER TABLE public.builder_membership_permissions
  DROP CONSTRAINT IF EXISTS builder_membership_permissions_scope_type_check;
ALTER TABLE public.builder_membership_permissions
  ADD CONSTRAINT builder_membership_permissions_scope_type_check
  CHECK (scope_type IN ('organisation','development','project','stage','unit','transaction'));

-- A transaction-scoped override can only ever DENY, exactly like the stage and
-- unit scopes added by Inventory.
CREATE OR REPLACE FUNCTION public.builder_guard_permission_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.scope_type NOT IN ('organisation', 'project', 'stage', 'unit', 'transaction') THEN
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

  -- Every narrower scope must name a row that exists, or the override is
  -- unreachable and silently does nothing.
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

  RETURN NEW;
END $$;

-- Transaction entities the activity log must accept.
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session',
     'development', 'project', 'project_party', 'project_access',
     'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
     'reservation', 'allocation',
     'transaction', 'transaction_party', 'transaction_case_link'));

-- ===========================================================================
-- 1. Transactions
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES public.builder_units(id) ON DELETE SET NULL,
  organisation_id uuid NOT NULL REFERENCES public.builder_organisations(id) ON DELETE CASCADE,

  -- The Client link. NULL until there is a client: unsold inventory is
  -- Builder-domain only and must never manufacture a transaction case.
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,

  transaction_reference text,
  transaction_type text NOT NULL DEFAULT 'off_the_plan'
    CHECK (transaction_type IN ('off_the_plan','house_and_land','established','land_only',
                                'build_only','knockdown_rebuild','other')),

  status text NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead','reserved','contract_issued','contract_signed','unconditional',
                      'construction','practical_completion','settled','cancelled','lapsed')),

  -- Purchaser identity as the Builder holds it. Contact details only: no
  -- income, expenses, assets, liabilities, employment or borrowing capacity.
  purchaser_name text,
  purchaser_email text,
  purchaser_phone text,

  -- The Builder's own commercial position on this sale. Finance owns receipt,
  -- reconciliation and any commission; none of that is held here.
  contract_price numeric(14,2) CHECK (contract_price IS NULL OR contract_price >= 0),
  deposit_amount numeric(14,2) CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
  deposit_received boolean NOT NULL DEFAULT false,

  contract_issued_date date,
  contract_signed_date date,
  unconditional_date date,
  sunset_date date,
  estimated_settlement_date date,
  actual_settlement_date date,

  shared_summary text,
  builder_notes text,
  risk_flag boolean NOT NULL DEFAULT false,
  risk_notes text,

  row_version bigint NOT NULL DEFAULT 1,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, transaction_reference)
);
CREATE INDEX IF NOT EXISTS builder_transactions_project_idx
  ON public.builder_transactions(project_id, status);
CREATE INDEX IF NOT EXISTS builder_transactions_unit_idx ON public.builder_transactions(unit_id);
CREATE INDEX IF NOT EXISTS builder_transactions_client_idx
  ON public.builder_transactions(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_transactions_org_idx
  ON public.builder_transactions(organisation_id);
-- One live transaction per unit. A cancelled or lapsed one may be superseded.
CREATE UNIQUE INDEX IF NOT EXISTS builder_transactions_one_live_per_unit
  ON public.builder_transactions(unit_id)
  WHERE unit_id IS NOT NULL AND status NOT IN ('cancelled','lapsed');

COMMENT ON TABLE public.builder_transactions IS
  'The Builder''s view of one sale. Holds the customer-facing commercial position only: no cost, margin, commission, client financial position or AML determination.';

-- A transaction''s unit must belong to the same project, or the sale could
-- reference another project''s stock and cross the access boundary.
CREATE OR REPLACE FUNCTION public.builder_enforce_transaction_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.unit_id IS NOT NULL THEN
    SELECT project_id INTO v_parent FROM public.builder_units WHERE id = NEW.unit_id;
    IF v_parent IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_PARENT_MISMATCH',
        DETAIL='the unit belongs to a different project';
    END IF;
  END IF;
  -- The transacting organisation must be one of the project's two sides.
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_projects p
    WHERE p.id = NEW.project_id
      AND NEW.organisation_id IN (p.developer_organisation_id, p.builder_organisation_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_ORG_MISMATCH',
      DETAIL='the organisation is not a party to this project';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_enforce_transaction_parentage ON public.builder_transactions;
CREATE TRIGGER trg_builder_enforce_transaction_parentage
  BEFORE INSERT OR UPDATE OF project_id, unit_id, organisation_id
  ON public.builder_transactions FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_transaction_parentage();

-- ===========================================================================
-- 2. Transaction parties
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_transaction_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.builder_transactions(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'other'
    CHECK (role IN ('purchaser','purchaser_solicitor','vendor','vendor_solicitor',
                    'sales_agent','broker','guarantor','other')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  organisation text,
  email text,
  phone text,
  reference text,
  is_primary_contact boolean NOT NULL DEFAULT false,
  notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_transaction_parties_txn_idx
  ON public.builder_transaction_parties(transaction_id);

-- ===========================================================================
-- 3. Append-only status history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_transaction_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.builder_transactions(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS builder_transaction_status_history_idx
  ON public.builder_transaction_status_history(transaction_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.builder_transaction_history_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001',
    MESSAGE='BUILDER_TRANSACTION_HISTORY_APPEND_ONLY',
    DETAIL='transaction status history rows cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_transaction_history_append_only
  ON public.builder_transaction_status_history;
CREATE TRIGGER trg_builder_transaction_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_transaction_status_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_transaction_history_append_only();

-- ===========================================================================
-- 4. Pipeline
--
-- The pipeline is a projection of the lifecycle, not a second source of truth.
-- Statuses map to ordered stages here so the portal and the Command Centre
-- group them identically and a status can never appear in two columns.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_transaction_pipeline_stages (
  status text PRIMARY KEY,
  stage_key text NOT NULL,
  stage_label text NOT NULL,
  stage_order smallint NOT NULL,
  is_terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.builder_transaction_pipeline_stages
  (status, stage_key, stage_label, stage_order, is_terminal) VALUES
  ('lead',                 'enquiry',    'Enquiry',              1, false),
  ('reserved',             'reserved',   'Reserved',             2, false),
  ('contract_issued',      'contract',   'Contract',             3, false),
  ('contract_signed',      'contract',   'Contract',             3, false),
  ('unconditional',        'exchanged',  'Exchanged',            4, false),
  ('construction',         'building',   'Building',             5, false),
  ('practical_completion', 'completion', 'Practical completion', 6, false),
  ('settled',              'settled',    'Settled',              7, true),
  ('cancelled',            'closed',     'Closed',               8, true),
  ('lapsed',               'closed',     'Closed',               8, true)
ON CONFLICT (status) DO UPDATE SET
  stage_key = EXCLUDED.stage_key, stage_label = EXCLUDED.stage_label,
  stage_order = EXCLUDED.stage_order, is_terminal = EXCLUDED.is_terminal;

-- ===========================================================================
-- 5. Transaction-case relationship — GEN-09 / MIG-02
--
-- The column, the widened history CHECK, the widened link_source CHECK, the
-- replaced guard and the replaced trigger ship together. A column added without
-- all five is a defect: a transaction for a different client could be linked,
-- and an UPDATE touching only the new column would not fire the trigger.
-- ===========================================================================
ALTER TABLE public.transaction_case_links
  ADD COLUMN IF NOT EXISTS builder_transaction_id uuid
    REFERENCES public.builder_transactions(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                 AND indexname='transaction_case_links_builder_transaction_id_key') THEN
    EXECUTE 'ALTER TABLE public.transaction_case_links
             ADD CONSTRAINT transaction_case_links_builder_transaction_id_key
             UNIQUE (builder_transaction_id)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transaction_case_links_builder
  ON public.transaction_case_links(builder_transaction_id)
  WHERE builder_transaction_id IS NOT NULL;

ALTER TABLE public.transaction_case_links
  DROP CONSTRAINT IF EXISTS transaction_case_links_link_source_check;
ALTER TABLE public.transaction_case_links
  ADD CONSTRAINT transaction_case_links_link_source_check
  CHECK (link_source IN ('legacy_explicit','legacy_reverse','command_centre','system','builder_portal'));

ALTER TABLE public.transaction_case_link_history
  DROP CONSTRAINT IF EXISTS transaction_case_link_history_domain_type_check;
ALTER TABLE public.transaction_case_link_history
  ADD CONSTRAINT transaction_case_link_history_domain_type_check
  CHECK (domain_type IN ('legal_matter','purchase_file','client_deal','builder_transaction'));

-- The guard is replaced with the builder branch added. Every existing branch is
-- preserved byte-for-byte in behaviour.
CREATE OR REPLACE FUNCTION public.guard_transaction_case_links() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE case_client uuid; domain_client uuid;
BEGIN
  SELECT client_id INTO case_client FROM public.transaction_cases WHERE id = NEW.case_id;
  IF case_client IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CASE_NOT_FOUND';
  END IF;

  IF NEW.legal_matter_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client FROM public.legal_matters WHERE id = NEW.legal_matter_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK';
    END IF;
  END IF;

  IF NEW.purchase_file_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client FROM public.purchase_files WHERE id = NEW.purchase_file_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK';
    END IF;
  END IF;

  IF NEW.client_deal_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client FROM public.client_deals WHERE id = NEW.client_deal_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK';
    END IF;
  END IF;

  -- The fourth slot. A NULL client_id on the transaction is not "matches
  -- anything" — it is unsold inventory, which must never reach a case.
  IF NEW.builder_transaction_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client
    FROM public.builder_transactions WHERE id = NEW.builder_transaction_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_transaction_case_links ON public.transaction_case_links;
CREATE TRIGGER trg_guard_transaction_case_links
  BEFORE INSERT OR UPDATE OF case_id, legal_matter_id, purchase_file_id,
                             client_deal_id, builder_transaction_id
  ON public.transaction_case_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_transaction_case_links();

-- ===========================================================================
-- 6. Permission resolution
-- ===========================================================================

-- A transaction is reached through its PROJECT. The parent decision is
-- authoritative; a transaction-scoped override may only DENY.
CREATE OR REPLACE FUNCTION public.builder_resolve_transaction_permission(
  _user_id uuid, _transaction_id uuid, _permission_key text, _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_id uuid; v_unit_id uuid; v_org uuid;
  v_base boolean; v_membership_id uuid; v_scoped text;
BEGIN
  SELECT project_id, unit_id INTO v_project_id, v_unit_id
  FROM public.builder_transactions WHERE id = _transaction_id;
  IF v_project_id IS NULL THEN RETURN false; END IF;

  v_base := public.builder_resolve_project_permission(
    _user_id, v_project_id, _permission_key, _level);
  IF NOT v_base THEN RETURN false; END IF;

  SELECT a.organisation_id INTO v_org FROM public.builder_project_access a
  WHERE a.builder_user_id = _user_id AND a.project_id = v_project_id
    AND a.revoked_at IS NULL;
  IF v_org IS NULL THEN RETURN false; END IF;

  -- HARD GATE: an active membership of the granting organisation is required,
  -- and it is resolved BEFORE any override can run.
  SELECT membership_id INTO v_membership_id
  FROM public.builder_active_membership(_user_id, v_org);
  IF v_membership_id IS NULL THEN RETURN false; END IF;

  -- The unit-scoped override still applies: a transaction cannot be a way
  -- around a denial on the unit it sells.
  IF v_unit_id IS NOT NULL THEN
    SELECT CASE _level WHEN 'view' THEN view_decision
                      WHEN 'edit' THEN edit_decision ELSE delete_decision END
    INTO v_scoped FROM public.builder_membership_permissions
    WHERE membership_id = v_membership_id AND permission_key = _permission_key
      AND scope_type = 'unit' AND scope_id = v_unit_id;
    IF v_scoped = 'deny' THEN RETURN false; END IF;
  END IF;

  SELECT CASE _level WHEN 'view' THEN view_decision
                    WHEN 'edit' THEN edit_decision ELSE delete_decision END
  INTO v_scoped FROM public.builder_membership_permissions
  WHERE membership_id = v_membership_id AND permission_key = _permission_key
    AND scope_type = 'transaction' AND scope_id = _transaction_id;
  IF v_scoped = 'deny' THEN RETURN false; END IF;

  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.builder_accessible_transactions(
  _user_id uuid, _organisation_id uuid DEFAULT NULL, _permission_key text DEFAULT 'transactions')
RETURNS TABLE (transaction_id uuid, project_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.project_id
  FROM public.builder_transactions t
  JOIN public.builder_accessible_projects(_user_id, _organisation_id, _permission_key) p
    ON p.project_id = t.project_id
  WHERE public.builder_resolve_transaction_permission(_user_id, t.id, _permission_key, 'view');
$$;

-- ===========================================================================
-- 7. Guarded commands — write and trusted audit in ONE transaction
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_upsert_transaction(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _transaction_id uuid, _project_id uuid,
  _unit_id uuid DEFAULT NULL, _organisation_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_transactions; v_row public.builder_transactions;
BEGIN
  IF _transaction_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_transactions
    WHERE id = _transaction_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    -- Status is NOT writable here: it moves only through the transition
    -- command, which writes history.
    UPDATE public.builder_transactions SET
      transaction_reference = CASE WHEN _payload ? 'transaction_reference'
        THEN _payload->>'transaction_reference' ELSE transaction_reference END,
      transaction_type = CASE WHEN _payload ? 'transaction_type'
        THEN _payload->>'transaction_type' ELSE transaction_type END,
      purchaser_name  = CASE WHEN _payload ? 'purchaser_name' THEN _payload->>'purchaser_name' ELSE purchaser_name END,
      purchaser_email = CASE WHEN _payload ? 'purchaser_email' THEN _payload->>'purchaser_email' ELSE purchaser_email END,
      purchaser_phone = CASE WHEN _payload ? 'purchaser_phone' THEN _payload->>'purchaser_phone' ELSE purchaser_phone END,
      contract_price  = CASE WHEN _payload ? 'contract_price' THEN (_payload->>'contract_price')::numeric ELSE contract_price END,
      deposit_amount  = CASE WHEN _payload ? 'deposit_amount' THEN (_payload->>'deposit_amount')::numeric ELSE deposit_amount END,
      deposit_received = CASE WHEN _payload ? 'deposit_received' THEN (_payload->>'deposit_received')::boolean ELSE deposit_received END,
      contract_issued_date = CASE WHEN _payload ? 'contract_issued_date' THEN (_payload->>'contract_issued_date')::date ELSE contract_issued_date END,
      contract_signed_date = CASE WHEN _payload ? 'contract_signed_date' THEN (_payload->>'contract_signed_date')::date ELSE contract_signed_date END,
      unconditional_date = CASE WHEN _payload ? 'unconditional_date' THEN (_payload->>'unconditional_date')::date ELSE unconditional_date END,
      sunset_date = CASE WHEN _payload ? 'sunset_date' THEN (_payload->>'sunset_date')::date ELSE sunset_date END,
      estimated_settlement_date = CASE WHEN _payload ? 'estimated_settlement_date' THEN (_payload->>'estimated_settlement_date')::date ELSE estimated_settlement_date END,
      actual_settlement_date = CASE WHEN _payload ? 'actual_settlement_date' THEN (_payload->>'actual_settlement_date')::date ELSE actual_settlement_date END,
      shared_summary = CASE WHEN _payload ? 'shared_summary' THEN _payload->>'shared_summary' ELSE shared_summary END,
      builder_notes  = CASE WHEN _payload ? 'builder_notes' THEN _payload->>'builder_notes' ELSE builder_notes END,
      risk_flag = CASE WHEN _payload ? 'risk_flag' THEN (_payload->>'risk_flag')::boolean ELSE risk_flag END,
      risk_notes = CASE WHEN _payload ? 'risk_notes' THEN _payload->>'risk_notes' ELSE risk_notes END,
      unit_id = COALESCE(_unit_id, unit_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _project_id IS NULL OR _organisation_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_projects WHERE id = _project_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PROJECT_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_transactions(project_id, unit_id, organisation_id,
      transaction_reference, transaction_type, purchaser_name, purchaser_email, purchaser_phone,
      contract_price, deposit_amount, contract_issued_date, estimated_settlement_date,
      sunset_date, shared_summary, builder_notes)
    VALUES (_project_id, _unit_id, _organisation_id,
      _payload->>'transaction_reference', COALESCE(_payload->>'transaction_type','off_the_plan'),
      _payload->>'purchaser_name', _payload->>'purchaser_email', _payload->>'purchaser_phone',
      (_payload->>'contract_price')::numeric, (_payload->>'deposit_amount')::numeric,
      (_payload->>'contract_issued_date')::date, (_payload->>'estimated_settlement_date')::date,
      (_payload->>'sunset_date')::date, _payload->>'shared_summary', _payload->>'builder_notes')
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _transaction_id IS NULL THEN 'builder_transaction_created'
         ELSE 'builder_transaction_updated' END,
    'transaction', v_row.id, v_row.organisation_id, _actor_builder_user_id,
    CASE WHEN _transaction_id IS NULL THEN NULL
         ELSE jsonb_build_object('status', v_existing.status,
                                 'row_version', v_existing.row_version) END,
    jsonb_build_object('status', v_row.status, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('project_id', v_row.project_id, 'unit_id', v_row.unit_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_is_transaction_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    WHEN _from IN ('settled','cancelled','lapsed') THEN false
    WHEN _to IN ('cancelled','lapsed') THEN true
    WHEN _from = 'lead' THEN _to IN ('reserved','contract_issued')
    WHEN _from = 'reserved' THEN _to IN ('contract_issued','lead')
    WHEN _from = 'contract_issued' THEN _to IN ('contract_signed','reserved')
    WHEN _from = 'contract_signed' THEN _to IN ('unconditional','contract_issued')
    WHEN _from = 'unconditional' THEN _to IN ('construction','practical_completion','settled')
    WHEN _from = 'construction' THEN _to IN ('practical_completion','unconditional')
    WHEN _from = 'practical_completion' THEN _to IN ('settled','construction')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.builder_transition_transaction(
  _transaction_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t public.builder_transactions; v_history_id uuid;
BEGIN
  IF NULLIF(btrim(_reason), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  IF NOT public.builder_is_transaction_transition_allowed(_from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION';
  END IF;

  SELECT * INTO t FROM public.builder_transactions WHERE id = _transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
  END IF;
  IF t.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION';
  END IF;
  IF t.status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS';
  END IF;

  UPDATE public.builder_transactions SET
    status = _to,
    closed_at = CASE WHEN _to IN ('settled','cancelled','lapsed') THEN COALESCE(closed_at, now())
                     ELSE closed_at END,
    actual_settlement_date = CASE WHEN _to = 'settled'
      THEN COALESCE(actual_settlement_date, CURRENT_DATE) ELSE actual_settlement_date END
  WHERE id = _transaction_id RETURNING * INTO t;

  INSERT INTO public.builder_transaction_status_history(transaction_id, from_status, to_status,
    changed_by_type, changed_by_builder_user_id, changed_by_user_id, reason, metadata)
  VALUES (_transaction_id, _from, _to, _actor_type,
    _actor_builder_user_id, _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', t.row_version))
  RETURNING id INTO v_history_id;

  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_transaction_status_changed',
    'transaction', t.id, t.organisation_id, _actor_builder_user_id,
    jsonb_build_object('status', _from),
    jsonb_build_object('status', _to, 'row_version', t.row_version),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN to_jsonb(t);
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_transaction_party(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _transaction_id uuid, _party_id uuid, _payload jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_transaction_parties
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_transaction_parties;
        v_row public.builder_transaction_parties; v_org uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_payload->>'name','')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PARTY_NAME_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_transactions WHERE id = _transaction_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
  END IF;

  IF _party_id IS NOT NULL THEN
    -- Scoped to this transaction: an id belonging to another one matches no row.
    SELECT * INTO v_existing FROM public.builder_transaction_parties
    WHERE id = _party_id AND transaction_id = _transaction_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PARTY_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_transaction_parties SET
      role = COALESCE(_payload->>'role', role),
      name = _payload->>'name',
      organisation = _payload->>'organisation',
      email = _payload->>'email',
      phone = _payload->>'phone',
      reference = _payload->>'reference',
      is_primary_contact = COALESCE((_payload->>'is_primary_contact')::boolean, is_primary_contact),
      notes = _payload->>'notes'
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.builder_transaction_parties(transaction_id, role, name, organisation,
      email, phone, reference, is_primary_contact, notes)
    VALUES (_transaction_id, COALESCE(_payload->>'role','other'), _payload->>'name',
      _payload->>'organisation', _payload->>'email', _payload->>'phone', _payload->>'reference',
      COALESCE((_payload->>'is_primary_contact')::boolean, false), _payload->>'notes')
    RETURNING * INTO v_row;
  END IF;

  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = _transaction_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _party_id IS NULL THEN 'builder_transaction_party_added'
         ELSE 'builder_transaction_party_updated' END,
    'transaction_party', v_row.id, v_org, _actor_builder_user_id,
    CASE WHEN _party_id IS NULL THEN NULL ELSE jsonb_build_object('name', v_existing.name) END,
    jsonb_build_object('name', v_row.name, 'role', v_row.role, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('transaction_id', _transaction_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_delete_transaction_party(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _transaction_id uuid, _party_id uuid, _reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_transaction_parties; v_org uuid;
BEGIN
  SELECT * INTO v_existing FROM public.builder_transaction_parties
  WHERE id = _party_id AND transaction_id = _transaction_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PARTY_NOT_FOUND';
  END IF;

  DELETE FROM public.builder_transaction_parties WHERE id = v_existing.id;

  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = _transaction_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_transaction_party_removed',
    'transaction_party', v_existing.id, v_org, _actor_builder_user_id,
    jsonb_build_object('name', v_existing.name, 'role', v_existing.role), NULL,
    _reason, jsonb_build_object('transaction_id', _transaction_id));
  RETURN true;
END $$;

-- --- client link -----------------------------------------------------------
-- Setting the client is a separate command from editing the transaction: it is
-- the act that makes a transaction case possible, and it is audited as such.
CREATE OR REPLACE FUNCTION public.builder_set_transaction_client(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _transaction_id uuid, _client_id uuid, _expected_version bigint, _reason text DEFAULT NULL)
RETURNS public.builder_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_transactions; v_row public.builder_transactions;
        v_linked_case uuid;
BEGIN
  SELECT * INTO v_existing FROM public.builder_transactions
  WHERE id = _transaction_id FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
  END IF;
  IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
      DETAIL = format('current_version=%s', v_existing.row_version);
  END IF;
  IF _client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients WHERE id = _client_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CLIENT_NOT_FOUND';
  END IF;

  -- Changing the client under a live case link would silently break the
  -- same-client invariant the case guard exists to protect.
  SELECT case_id INTO v_linked_case FROM public.transaction_case_links
  WHERE builder_transaction_id = _transaction_id;
  IF v_linked_case IS NOT NULL AND _client_id IS DISTINCT FROM v_existing.client_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_CASE_LINKED',
      DETAIL='unlink the transaction from its case before changing the client';
  END IF;

  UPDATE public.builder_transactions SET client_id = _client_id
  WHERE id = v_existing.id RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_transaction_client_set',
    'transaction', v_row.id, v_row.organisation_id, _actor_builder_user_id,
    jsonb_build_object('client_id', v_existing.client_id),
    jsonb_build_object('client_id', v_row.client_id, 'row_version', v_row.row_version),
    _reason, '{}'::jsonb);
  RETURN v_row;
END $$;

-- --- transaction-case link -------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_link_transaction_to_case(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _transaction_id uuid, _case_id uuid, _reason text DEFAULT NULL)
RETURNS public.transaction_case_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t public.builder_transactions; v_link public.transaction_case_links;
        v_case_client uuid;
BEGIN
  SELECT * INTO t FROM public.builder_transactions WHERE id = _transaction_id FOR UPDATE;
  IF t.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_NOT_FOUND';
  END IF;
  -- Unsold inventory has no client and therefore no case. This is the
  -- unsold-inventory rule from the Phase 0 relationship model.
  IF t.client_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_TRANSACTION_HAS_NO_CLIENT',
      DETAIL='a transaction without a client cannot be linked to a case';
  END IF;

  SELECT client_id INTO v_case_client FROM public.transaction_cases WHERE id = _case_id;
  IF v_case_client IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CASE_NOT_FOUND';
  END IF;
  IF v_case_client IS DISTINCT FROM t.client_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK';
  END IF;

  SELECT * INTO v_link FROM public.transaction_case_links
  WHERE case_id = _case_id FOR UPDATE;
  IF v_link.id IS NULL THEN
    INSERT INTO public.transaction_case_links(case_id, builder_transaction_id,
      link_source, linked_by)
    VALUES (_case_id, _transaction_id, 'builder_portal', _actor_user_id)
    RETURNING * INTO v_link;
  ELSE
    IF v_link.builder_transaction_id IS NOT NULL
       AND v_link.builder_transaction_id <> _transaction_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CASE_SLOT_TAKEN',
        DETAIL='this case already has a builder transaction';
    END IF;
    UPDATE public.transaction_case_links
    SET builder_transaction_id = _transaction_id, updated_at = now()
    WHERE id = v_link.id RETURNING * INTO v_link;
  END IF;

  INSERT INTO public.transaction_case_link_history(case_id, domain_type, domain_record_id,
    action, link_source, actor_user_id, reason)
  VALUES (_case_id, 'builder_transaction', _transaction_id, 'linked', 'builder_portal',
    _actor_user_id, _reason);

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_transaction_case_linked',
    'transaction_case_link', v_link.id, t.organisation_id, _actor_builder_user_id,
    NULL, jsonb_build_object('case_id', _case_id, 'transaction_id', _transaction_id),
    _reason, '{}'::jsonb);
  RETURN v_link;
END $$;

CREATE OR REPLACE FUNCTION public.builder_unlink_transaction_from_case(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _transaction_id uuid, _reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_link public.transaction_case_links; v_org uuid;
BEGIN
  SELECT * INTO v_link FROM public.transaction_case_links
  WHERE builder_transaction_id = _transaction_id FOR UPDATE;
  IF v_link.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CASE_LINK_NOT_FOUND';
  END IF;

  UPDATE public.transaction_case_links
  SET builder_transaction_id = NULL, updated_at = now() WHERE id = v_link.id;

  INSERT INTO public.transaction_case_link_history(case_id, domain_type, domain_record_id,
    action, link_source, actor_user_id, reason)
  VALUES (v_link.case_id, 'builder_transaction', _transaction_id, 'unlinked', 'builder_portal',
    _actor_user_id, _reason);

  SELECT organisation_id INTO v_org FROM public.builder_transactions WHERE id = _transaction_id;
  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_transaction_case_unlinked',
    'transaction_case_link', v_link.id, v_org, _actor_builder_user_id,
    jsonb_build_object('case_id', v_link.case_id, 'transaction_id', _transaction_id), NULL,
    _reason, '{}'::jsonb);
  RETURN true;
END $$;

-- ===========================================================================
-- 8. Touch triggers
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_transactions','builder_transaction_parties'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 9. Role baseline
--
-- Phase 1 catalogued the `transactions` key but seeded NO role defaults, so
-- every valid grant would resolve false and the module would be unusable —
-- the exact defect Phase 3 hit with `projects`. The assertion below fails the
-- migration if the baseline is ever removed.
-- ===========================================================================
INSERT INTO public.builder_role_default_permissions
  (membership_role, permission_key, can_view, can_edit, can_delete) VALUES
  ('owner',         'transactions', true,  true,  true),
  ('administrator', 'transactions', true,  true,  true),
  ('manager',       'transactions', true,  true,  false),
  ('member',        'transactions', true,  true,  false),
  ('read_only',     'transactions', true,  false, false)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 10. RLS and grants — deny by default
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_transactions','builder_transaction_parties',
                           'builder_transaction_status_history',
                           'builder_transaction_pipeline_stages'] LOOP
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
    ('builder_resolve_transaction_permission','uuid, uuid, text, text'),
    ('builder_accessible_transactions','uuid, uuid, text'),
    ('builder_upsert_transaction','uuid, text, uuid, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_is_transaction_transition_allowed','text, text'),
    ('builder_transition_transaction','uuid, bigint, text, text, text, text, uuid, uuid'),
    ('builder_upsert_transaction_party','uuid, text, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_delete_transaction_party','uuid, text, uuid, uuid, uuid, text'),
    ('builder_set_transaction_client','uuid, text, uuid, uuid, uuid, bigint, text'),
    ('builder_link_transaction_to_case','uuid, text, uuid, uuid, uuid, text'),
    ('builder_unlink_transaction_from_case','uuid, text, uuid, uuid, text')
  ) AS t(f, a) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f, a);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, a);
  END LOOP;
END $$;

-- ===========================================================================
-- 11. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_resolve_transaction_permission','builder_accessible_transactions',
    'builder_upsert_transaction','builder_transition_transaction',
    'builder_upsert_transaction_party','builder_delete_transaction_party',
    'builder_set_transaction_client','builder_link_transaction_to_case',
    'builder_unlink_transaction_from_case','builder_enforce_transaction_parentage']) AS f
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: transaction function(s) missing: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('builder_transactions','builder_transaction_parties',
                      'builder_transaction_status_history','builder_transaction_pipeline_stages')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_transactions','builder_transaction_parties']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='row_version');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: touch-triggered table(s) without row_version: %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.builder_role_default_permissions
                 WHERE permission_key='transactions' AND membership_role='manager' AND can_view) THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: permission key(s) without a role baseline: transactions';
  END IF;

  -- MIG-02: the column, the widened history CHECK and the widened trigger must
  -- all be present. A column without the trigger is the defect this guards.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='transaction_case_links'
                   AND column_name='builder_transaction_id') THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the builder transaction-case slot is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    WHERE c.relname = 'transaction_case_links'
      AND tg.tgname = 'trg_guard_transaction_case_links'
      AND pg_get_triggerdef(tg.oid) LIKE '%builder_transaction_id%') THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the case-link guard does not fire on builder_transaction_id (MIG-02)';
  END IF;

  -- No cost, margin, supplier or commission column may exist in the Builder
  -- domain. Commission is Finance-owned and must never be copied here.
  --
  -- `builder_invoices` is excluded deliberately: despite the name it is a
  -- FINANCE table — it invoices a builder, it is not part of this programme,
  -- and it legitimately carries `commission_amount`. The Builder Portal never
  -- reads it, which the security check enforces separately.
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

  RAISE NOTICE 'builder transactions: transactions, parties, pipeline, case link and client link installed';
END $$;
