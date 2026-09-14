-- Builder / Developer Portal — Delivery: variations and their approvals,
-- progress claims, inspections and their outcomes, defects and their history,
-- practical completion, handover and warranty.
--
-- Additive only. Every earlier Builder object is reused unchanged.
--
-- Blueprint:
--   builder_construction_cases is the parent aggregate for every table here,
--   exactly as builder_transactions is the parent of the construction case.
--   Every one is reached through `builder_resolve_construction_permission`,
--   which already walks project -> transaction -> membership -> case override.
--   There is no new access table and no new resolver.
--
-- DATA BOUNDARY, stated once and enforced by assertion:
--   * A VARIATION carries the customer-facing variation price only. No cost, no
--     margin, no supplier or contractor price.
--   * A PROGRESS CLAIM records what the Builder CLAIMED and when — the claim's
--     own lifecycle. It deliberately does NOT own payment: `paid`, `paid_at`,
--     `payment_reference`, receipt and reconciliation stay with Finance on
--     `build_progress_payments`. The claim carries a nullable
--     `finance_payment_id` POINTER so Finance can be reached, never copied.
--   * A DEFECT, INSPECTION, PRACTICAL COMPLETION, HANDOVER or WARRANTY record
--     carries no money at all.

-- ===========================================================================
-- 0. Prerequisites
-- ===========================================================================
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
     'progress_update', 'photograph',
     'variation', 'variation_approval', 'progress_claim',
     'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim'));

-- ===========================================================================
-- 1. Variations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  variation_number text,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  origin text NOT NULL DEFAULT 'purchaser'
    CHECK (origin IN ('purchaser','builder','consultant','authority','site_condition','other')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','withdrawn','superseded')),
  -- The customer-facing variation price. No cost, no margin: those are internal
  -- Builder commercial information and are outside every audience projection.
  variation_price numeric(14,2) CHECK (variation_price IS NULL OR variation_price >= 0),
  time_impact_days integer NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  decided_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (construction_case_id, variation_number)
);
CREATE INDEX IF NOT EXISTS builder_variations_case_idx
  ON public.builder_variations(construction_case_id, status);

COMMENT ON TABLE public.builder_variations IS
  'A change to the build. Carries the customer-facing variation price only: no cost, margin, supplier price or contractor price.';

CREATE TABLE IF NOT EXISTS public.builder_variation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variation_id uuid NOT NULL REFERENCES public.builder_variations(id) ON DELETE CASCADE,
  approver_role text NOT NULL DEFAULT 'purchaser'
    CHECK (approver_role IN ('purchaser','builder','developer','consultant','authority')),
  approver_name text NOT NULL CHECK (length(btrim(approver_name)) > 0),
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending','approved','rejected')),
  decided_at timestamptz,
  comments text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_variation_approvals_variation_idx
  ON public.builder_variation_approvals(variation_id, decision);

-- ===========================================================================
-- 2. Progress claims
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_progress_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES public.builder_construction_milestones(id) ON DELETE SET NULL,
  claim_number text,
  claimed_amount numeric(14,2) NOT NULL CHECK (claimed_amount >= 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','certified','disputed','withdrawn','closed')),
  claimed_at timestamptz,
  certified_at timestamptz,
  certified_amount numeric(14,2) CHECK (certified_amount IS NULL OR certified_amount >= 0),
  dispute_reason text,
  notes text,
  -- A POINTER into Finance, never a copy. The Builder claims; Finance receipts,
  -- reconciles and triggers commission. Nothing about payment is stored here.
  finance_payment_id uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (construction_case_id, claim_number)
);
CREATE INDEX IF NOT EXISTS builder_progress_claims_case_idx
  ON public.builder_progress_claims(construction_case_id, status);

COMMENT ON TABLE public.builder_progress_claims IS
  'What the Builder claimed and when. Finance owns receipt, reconciliation and commission on build_progress_payments; finance_payment_id is a pointer, never a copy.';

-- The claim's milestone must belong to the claim's construction case.
CREATE OR REPLACE FUNCTION public.builder_enforce_delivery_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.milestone_id IS NULL THEN RETURN NEW; END IF;
  SELECT construction_case_id INTO v_parent
  FROM public.builder_construction_milestones WHERE id = NEW.milestone_id;
  IF v_parent IS DISTINCT FROM NEW.construction_case_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DELIVERY_PARENT_MISMATCH',
      DETAIL='the milestone belongs to a different construction case';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_claim_parentage ON public.builder_progress_claims;
CREATE TRIGGER trg_builder_claim_parentage
  BEFORE INSERT OR UPDATE OF construction_case_id, milestone_id
  ON public.builder_progress_claims FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_delivery_parentage();

-- ===========================================================================
-- 3. Inspections
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  construction_stage_id uuid
    REFERENCES public.builder_construction_stages(id) ON DELETE SET NULL,
  inspection_type text NOT NULL DEFAULT 'quality'
    CHECK (inspection_type IN ('quality','frame','waterproofing','pre_plaster',
                               'practical_completion','handover','warranty','authority','other')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','rescheduled','in_progress','passed','failed',
                      'passed_with_defects','cancelled')),
  inspector_name text,
  inspector_organisation text,
  scheduled_for timestamptz,
  performed_at timestamptz,
  outcome_notes text,
  defect_count integer NOT NULL DEFAULT 0 CHECK (defect_count >= 0),
  is_customer_visible boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builder_inspections_case_idx
  ON public.builder_inspections(construction_case_id, status);
CREATE INDEX IF NOT EXISTS builder_inspections_schedule_idx
  ON public.builder_inspections(scheduled_for) WHERE scheduled_for IS NOT NULL;

-- ===========================================================================
-- 4. Defects
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  inspection_id uuid REFERENCES public.builder_inspections(id) ON DELETE SET NULL,
  defect_number text,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  location text,
  severity text NOT NULL DEFAULT 'minor'
    CHECK (severity IN ('cosmetic','minor','major','critical')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','in_rectification','rectified','verified',
                      'rejected','closed')),
  raised_by_type text NOT NULL DEFAULT 'builder'
    CHECK (raised_by_type IN ('builder','purchaser','inspector','developer','authority')),
  raised_at timestamptz NOT NULL DEFAULT now(),
  due_date date,
  rectified_at timestamptz,
  verified_at timestamptz,
  -- A defect is a quality record. It carries no rectification cost: that is
  -- internal Builder commercial information.
  is_customer_visible boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (construction_case_id, defect_number)
);
CREATE INDEX IF NOT EXISTS builder_defects_case_idx
  ON public.builder_defects(construction_case_id, status);
CREATE INDEX IF NOT EXISTS builder_defects_inspection_idx ON public.builder_defects(inspection_id);

-- A defect's inspection must belong to the same construction case.
CREATE OR REPLACE FUNCTION public.builder_enforce_defect_parentage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF NEW.inspection_id IS NULL THEN RETURN NEW; END IF;
  SELECT construction_case_id INTO v_parent
  FROM public.builder_inspections WHERE id = NEW.inspection_id;
  IF v_parent IS DISTINCT FROM NEW.construction_case_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DELIVERY_PARENT_MISMATCH',
      DETAIL='the inspection belongs to a different construction case';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_defect_parentage ON public.builder_defects;
CREATE TRIGGER trg_builder_defect_parentage
  BEFORE INSERT OR UPDATE OF construction_case_id, inspection_id
  ON public.builder_defects FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_defect_parentage();

-- Inspections must belong to their stage's case.
DROP TRIGGER IF EXISTS trg_builder_inspection_parentage ON public.builder_inspections;
CREATE TRIGGER trg_builder_inspection_parentage
  BEFORE INSERT OR UPDATE OF construction_case_id, construction_stage_id
  ON public.builder_inspections FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_milestone_parentage();

-- ===========================================================================
-- 5. Practical completion, handover and warranty
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_practical_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_reached'
    CHECK (status IN ('not_reached','notified','inspected','disputed','achieved')),
  notified_at timestamptz,
  inspected_at timestamptz,
  achieved_at timestamptz,
  certificate_reference text,
  outstanding_defect_count integer NOT NULL DEFAULT 0 CHECK (outstanding_defect_count >= 0),
  dispute_reason text,
  notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.builder_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_scheduled'
    CHECK (status IN ('not_scheduled','scheduled','walkthrough_complete','keys_released','completed')),
  scheduled_for timestamptz,
  walkthrough_at timestamptz,
  keys_released_at timestamptz,
  completed_at timestamptz,
  attendee_names text,
  key_set_count integer CHECK (key_set_count IS NULL OR key_set_count >= 0),
  manual_provided boolean NOT NULL DEFAULT false,
  notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.builder_warranties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  warranty_type text NOT NULL DEFAULT 'structural'
    CHECK (warranty_type IN ('structural','non_structural','statutory','manufacturer','other')),
  provider_name text,
  policy_reference text,
  starts_on date,
  expires_on date,
  notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_warranties_window_valid
    CHECK (expires_on IS NULL OR starts_on IS NULL OR expires_on > starts_on)
);

CREATE TABLE IF NOT EXISTS public.builder_warranty_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  warranty_id uuid REFERENCES public.builder_warranties(id) ON DELETE SET NULL,
  claim_number text,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  status text NOT NULL DEFAULT 'lodged'
    CHECK (status IN ('lodged','under_review','accepted','rejected','rectified','closed')),
  lodged_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  rectified_at timestamptz,
  decision_notes text,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (construction_case_id, claim_number)
);
CREATE INDEX IF NOT EXISTS builder_warranty_claims_case_idx
  ON public.builder_warranty_claims(construction_case_id, status);

-- ===========================================================================
-- 6. Append-only delivery history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_delivery_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construction_case_id uuid NOT NULL
    REFERENCES public.builder_construction_cases(id) ON DELETE CASCADE,
  entity_kind text NOT NULL
    CHECK (entity_kind IN ('variation','variation_approval','progress_claim','inspection',
                           'defect','practical_completion','handover','warranty_claim')),
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
CREATE INDEX IF NOT EXISTS builder_delivery_status_history_idx
  ON public.builder_delivery_status_history(construction_case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_delivery_status_history_entity_idx
  ON public.builder_delivery_status_history(entity_kind, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.builder_delivery_history_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001',
    MESSAGE='BUILDER_DELIVERY_HISTORY_APPEND_ONLY',
    DETAIL='delivery history rows cannot be updated or deleted';
END $$;

DROP TRIGGER IF EXISTS trg_builder_delivery_history_append_only
  ON public.builder_delivery_status_history;
CREATE TRIGGER trg_builder_delivery_history_append_only
  BEFORE UPDATE OR DELETE ON public.builder_delivery_status_history
  FOR EACH ROW EXECUTE FUNCTION public.builder_delivery_history_append_only();

-- ===========================================================================
-- 7. Transition allow-lists
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_is_delivery_transition_allowed(
  _kind text, _from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = _to THEN false
    WHEN _kind = 'variation' THEN CASE
      WHEN _from IN ('approved','rejected','withdrawn','superseded') THEN false
      WHEN _from = 'draft' THEN _to IN ('submitted','withdrawn')
      WHEN _from = 'submitted' THEN _to IN ('approved','rejected','withdrawn','superseded')
      ELSE false END
    WHEN _kind = 'progress_claim' THEN CASE
      WHEN _from IN ('closed','withdrawn') THEN false
      WHEN _from = 'draft' THEN _to IN ('submitted','withdrawn')
      WHEN _from = 'submitted' THEN _to IN ('certified','disputed','withdrawn')
      WHEN _from = 'disputed' THEN _to IN ('certified','submitted','withdrawn')
      WHEN _from = 'certified' THEN _to = 'closed'
      ELSE false END
    WHEN _kind = 'inspection' THEN CASE
      WHEN _from IN ('cancelled','passed') THEN false
      WHEN _from IN ('scheduled','rescheduled') THEN
        _to IN ('in_progress','rescheduled','cancelled')
      WHEN _from = 'in_progress' THEN _to IN ('passed','failed','passed_with_defects','cancelled')
      WHEN _from IN ('failed','passed_with_defects') THEN _to IN ('rescheduled','passed','cancelled')
      ELSE false END
    WHEN _kind = 'defect' THEN CASE
      WHEN _from = 'closed' THEN false
      WHEN _from = 'open' THEN _to IN ('acknowledged','rejected','in_rectification')
      WHEN _from = 'acknowledged' THEN _to IN ('in_rectification','rejected')
      WHEN _from = 'in_rectification' THEN _to IN ('rectified','open')
      WHEN _from = 'rectified' THEN _to IN ('verified','in_rectification')
      WHEN _from = 'verified' THEN _to = 'closed'
      WHEN _from = 'rejected' THEN _to IN ('open','closed')
      ELSE false END
    WHEN _kind = 'practical_completion' THEN CASE
      WHEN _from = 'achieved' THEN false
      WHEN _from = 'not_reached' THEN _to = 'notified'
      WHEN _from = 'notified' THEN _to IN ('inspected','disputed')
      WHEN _from = 'inspected' THEN _to IN ('achieved','disputed')
      WHEN _from = 'disputed' THEN _to IN ('inspected','notified')
      ELSE false END
    WHEN _kind = 'handover' THEN CASE
      WHEN _from = 'completed' THEN false
      WHEN _from = 'not_scheduled' THEN _to = 'scheduled'
      WHEN _from = 'scheduled' THEN _to IN ('walkthrough_complete','not_scheduled')
      WHEN _from = 'walkthrough_complete' THEN _to = 'keys_released'
      WHEN _from = 'keys_released' THEN _to = 'completed'
      ELSE false END
    WHEN _kind = 'warranty_claim' THEN CASE
      WHEN _from = 'closed' THEN false
      WHEN _from = 'lodged' THEN _to IN ('under_review','rejected')
      WHEN _from = 'under_review' THEN _to IN ('accepted','rejected')
      WHEN _from = 'accepted' THEN _to = 'rectified'
      WHEN _from = 'rectified' THEN _to = 'closed'
      WHEN _from = 'rejected' THEN _to IN ('under_review','closed')
      ELSE false END
    ELSE false
  END;
$$;

-- ===========================================================================
-- 8. Guarded commands — write and trusted audit in ONE transaction
--
-- One upsert and one transition per aggregate, all sharing the same shape as
-- the construction module's. The organisation for the audit row is resolved
-- through case -> transaction, so it is never supplied by a caller.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_delivery_org(_construction_case_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.organisation_id
  FROM public.builder_construction_cases c
  JOIN public.builder_transactions t ON t.id = c.transaction_id
  WHERE c.id = _construction_case_id;
$$;

CREATE OR REPLACE FUNCTION public.builder_upsert_variation(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _variation_id uuid, _construction_case_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_variations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_variations; v_row public.builder_variations;
BEGIN
  IF _variation_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_variations WHERE id = _variation_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_VARIATION_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_variations SET
      variation_number = CASE WHEN _payload ? 'variation_number' THEN _payload->>'variation_number' ELSE variation_number END,
      title = CASE WHEN _payload ? 'title' THEN _payload->>'title' ELSE title END,
      description = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      origin = CASE WHEN _payload ? 'origin' THEN _payload->>'origin' ELSE origin END,
      variation_price = CASE WHEN _payload ? 'variation_price' THEN (_payload->>'variation_price')::numeric ELSE variation_price END,
      time_impact_days = CASE WHEN _payload ? 'time_impact_days' THEN (_payload->>'time_impact_days')::integer ELSE time_impact_days END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _construction_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_variations(construction_case_id, variation_number, title,
      description, origin, variation_price, time_impact_days)
    VALUES (_construction_case_id, _payload->>'variation_number', _payload->>'title',
      _payload->>'description', COALESCE(_payload->>'origin','purchaser'),
      (_payload->>'variation_price')::numeric,
      COALESCE((_payload->>'time_impact_days')::integer, 0))
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _variation_id IS NULL THEN 'builder_variation_created'
         ELSE 'builder_variation_updated' END,
    'variation', v_row.id, public.builder_delivery_org(v_row.construction_case_id),
    _actor_builder_user_id,
    CASE WHEN _variation_id IS NULL THEN NULL ELSE jsonb_build_object('title', v_existing.title) END,
    jsonb_build_object('title', v_row.title, 'status', v_row.status,
                       'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_variation_approval(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _approval_id uuid, _variation_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_variation_approvals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_variation_approvals;
        v_row public.builder_variation_approvals; v_case uuid;
BEGIN
  IF _approval_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_variation_approvals
    WHERE id = _approval_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.builder_upsert_progress_claim(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _claim_id uuid, _construction_case_id uuid, _milestone_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_progress_claims
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_progress_claims; v_row public.builder_progress_claims;
BEGIN
  IF _claim_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_progress_claims WHERE id = _claim_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CLAIM_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_progress_claims SET
      claim_number = CASE WHEN _payload ? 'claim_number' THEN _payload->>'claim_number' ELSE claim_number END,
      claimed_amount = CASE WHEN _payload ? 'claimed_amount' THEN (_payload->>'claimed_amount')::numeric ELSE claimed_amount END,
      certified_amount = CASE WHEN _payload ? 'certified_amount' THEN (_payload->>'certified_amount')::numeric ELSE certified_amount END,
      dispute_reason = CASE WHEN _payload ? 'dispute_reason' THEN _payload->>'dispute_reason' ELSE dispute_reason END,
      notes = CASE WHEN _payload ? 'notes' THEN _payload->>'notes' ELSE notes END,
      milestone_id = COALESCE(_milestone_id, milestone_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _construction_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    IF (_payload->>'claimed_amount') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CLAIM_AMOUNT_REQUIRED';
    END IF;
    INSERT INTO public.builder_progress_claims(construction_case_id, milestone_id, claim_number,
      claimed_amount, notes)
    VALUES (_construction_case_id, _milestone_id, _payload->>'claim_number',
      (_payload->>'claimed_amount')::numeric, _payload->>'notes')
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _claim_id IS NULL THEN 'builder_progress_claim_created'
         ELSE 'builder_progress_claim_updated' END,
    'progress_claim', v_row.id, public.builder_delivery_org(v_row.construction_case_id),
    _actor_builder_user_id,
    CASE WHEN _claim_id IS NULL THEN NULL
         ELSE jsonb_build_object('status', v_existing.status) END,
    jsonb_build_object('status', v_row.status, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_inspection(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _inspection_id uuid, _construction_case_id uuid, _construction_stage_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_inspections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_inspections; v_row public.builder_inspections;
BEGIN
  IF _inspection_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_inspections WHERE id = _inspection_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INSPECTION_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_inspections SET
      inspection_type = CASE WHEN _payload ? 'inspection_type' THEN _payload->>'inspection_type' ELSE inspection_type END,
      title = CASE WHEN _payload ? 'title' THEN _payload->>'title' ELSE title END,
      inspector_name = CASE WHEN _payload ? 'inspector_name' THEN _payload->>'inspector_name' ELSE inspector_name END,
      inspector_organisation = CASE WHEN _payload ? 'inspector_organisation' THEN _payload->>'inspector_organisation' ELSE inspector_organisation END,
      scheduled_for = CASE WHEN _payload ? 'scheduled_for' THEN (_payload->>'scheduled_for')::timestamptz ELSE scheduled_for END,
      outcome_notes = CASE WHEN _payload ? 'outcome_notes' THEN _payload->>'outcome_notes' ELSE outcome_notes END,
      is_customer_visible = CASE WHEN _payload ? 'is_customer_visible' THEN (_payload->>'is_customer_visible')::boolean ELSE is_customer_visible END,
      construction_stage_id = COALESCE(_construction_stage_id, construction_stage_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _construction_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_inspections(construction_case_id, construction_stage_id,
      inspection_type, title, inspector_name, inspector_organisation, scheduled_for,
      is_customer_visible)
    VALUES (_construction_case_id, _construction_stage_id,
      COALESCE(_payload->>'inspection_type','quality'), _payload->>'title',
      _payload->>'inspector_name', _payload->>'inspector_organisation',
      (_payload->>'scheduled_for')::timestamptz,
      COALESCE((_payload->>'is_customer_visible')::boolean, true))
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _inspection_id IS NULL THEN 'builder_inspection_scheduled'
         ELSE 'builder_inspection_updated' END,
    'inspection', v_row.id, public.builder_delivery_org(v_row.construction_case_id),
    _actor_builder_user_id,
    CASE WHEN _inspection_id IS NULL THEN NULL
         ELSE jsonb_build_object('scheduled_for', v_existing.scheduled_for) END,
    jsonb_build_object('title', v_row.title, 'status', v_row.status,
                       'scheduled_for', v_row.scheduled_for, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_defect(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _defect_id uuid, _construction_case_id uuid, _inspection_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_defects
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_defects; v_row public.builder_defects;
BEGIN
  IF _defect_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_defects WHERE id = _defect_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DEFECT_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_defects SET
      defect_number = CASE WHEN _payload ? 'defect_number' THEN _payload->>'defect_number' ELSE defect_number END,
      title = CASE WHEN _payload ? 'title' THEN _payload->>'title' ELSE title END,
      description = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      location = CASE WHEN _payload ? 'location' THEN _payload->>'location' ELSE location END,
      severity = CASE WHEN _payload ? 'severity' THEN _payload->>'severity' ELSE severity END,
      due_date = CASE WHEN _payload ? 'due_date' THEN (_payload->>'due_date')::date ELSE due_date END,
      is_customer_visible = CASE WHEN _payload ? 'is_customer_visible' THEN (_payload->>'is_customer_visible')::boolean ELSE is_customer_visible END,
      inspection_id = COALESCE(_inspection_id, inspection_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF _construction_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_REQUIRED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_defects(construction_case_id, inspection_id, defect_number, title,
      description, location, severity, raised_by_type, due_date, is_customer_visible)
    VALUES (_construction_case_id, _inspection_id, _payload->>'defect_number', _payload->>'title',
      _payload->>'description', _payload->>'location', COALESCE(_payload->>'severity','minor'),
      COALESCE(_payload->>'raised_by_type','builder'), (_payload->>'due_date')::date,
      COALESCE((_payload->>'is_customer_visible')::boolean, true))
    RETURNING * INTO v_row;
    -- The inspection's defect count follows the defects raised against it.
    IF _inspection_id IS NOT NULL THEN
      UPDATE public.builder_inspections
      SET defect_count = (SELECT count(*) FROM public.builder_defects
                          WHERE inspection_id = _inspection_id)
      WHERE id = _inspection_id;
    END IF;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _defect_id IS NULL THEN 'builder_defect_raised' ELSE 'builder_defect_updated' END,
    'defect', v_row.id, public.builder_delivery_org(v_row.construction_case_id),
    _actor_builder_user_id,
    CASE WHEN _defect_id IS NULL THEN NULL ELSE jsonb_build_object('title', v_existing.title) END,
    jsonb_build_object('title', v_row.title, 'status', v_row.status,
                       'severity', v_row.severity, 'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_delivery_record(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _kind text, _construction_case_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pc public.builder_practical_completions; v_ho public.builder_handovers;
        v_wr public.builder_warranties; v_current bigint; v_result jsonb;
BEGIN
  IF _kind NOT IN ('practical_completion','handover','warranty') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_DELIVERY_KIND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
  END IF;

  -- One row per case for each of these three. The row is created on first use;
  -- from then on an update requires the matching expected_version.
  IF _kind = 'practical_completion' THEN
    SELECT * INTO v_pc FROM public.builder_practical_completions
    WHERE construction_case_id = _construction_case_id FOR UPDATE;
    IF v_pc.id IS NULL THEN
      INSERT INTO public.builder_practical_completions(construction_case_id,
        certificate_reference, outstanding_defect_count, notes)
      VALUES (_construction_case_id, _payload->>'certificate_reference',
        COALESCE((_payload->>'outstanding_defect_count')::integer, 0), _payload->>'notes')
      RETURNING * INTO v_pc;
    ELSE
      IF _expected_version IS NULL OR v_pc.row_version <> _expected_version THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
          DETAIL = format('current_version=%s', v_pc.row_version);
      END IF;
      UPDATE public.builder_practical_completions SET
        certificate_reference = CASE WHEN _payload ? 'certificate_reference' THEN _payload->>'certificate_reference' ELSE certificate_reference END,
        outstanding_defect_count = CASE WHEN _payload ? 'outstanding_defect_count' THEN (_payload->>'outstanding_defect_count')::integer ELSE outstanding_defect_count END,
        dispute_reason = CASE WHEN _payload ? 'dispute_reason' THEN _payload->>'dispute_reason' ELSE dispute_reason END,
        notes = CASE WHEN _payload ? 'notes' THEN _payload->>'notes' ELSE notes END
      WHERE id = v_pc.id RETURNING * INTO v_pc;
    END IF;
    v_result := to_jsonb(v_pc);
  ELSIF _kind = 'handover' THEN
    SELECT * INTO v_ho FROM public.builder_handovers
    WHERE construction_case_id = _construction_case_id FOR UPDATE;
    IF v_ho.id IS NULL THEN
      INSERT INTO public.builder_handovers(construction_case_id, scheduled_for, attendee_names,
        key_set_count, manual_provided, notes)
      VALUES (_construction_case_id, (_payload->>'scheduled_for')::timestamptz,
        _payload->>'attendee_names', (_payload->>'key_set_count')::integer,
        COALESCE((_payload->>'manual_provided')::boolean, false), _payload->>'notes')
      RETURNING * INTO v_ho;
    ELSE
      IF _expected_version IS NULL OR v_ho.row_version <> _expected_version THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
          DETAIL = format('current_version=%s', v_ho.row_version);
      END IF;
      UPDATE public.builder_handovers SET
        scheduled_for = CASE WHEN _payload ? 'scheduled_for' THEN (_payload->>'scheduled_for')::timestamptz ELSE scheduled_for END,
        attendee_names = CASE WHEN _payload ? 'attendee_names' THEN _payload->>'attendee_names' ELSE attendee_names END,
        key_set_count = CASE WHEN _payload ? 'key_set_count' THEN (_payload->>'key_set_count')::integer ELSE key_set_count END,
        manual_provided = CASE WHEN _payload ? 'manual_provided' THEN (_payload->>'manual_provided')::boolean ELSE manual_provided END,
        notes = CASE WHEN _payload ? 'notes' THEN _payload->>'notes' ELSE notes END
      WHERE id = v_ho.id RETURNING * INTO v_ho;
    END IF;
    v_result := to_jsonb(v_ho);
  ELSE
    SELECT * INTO v_wr FROM public.builder_warranties
    WHERE construction_case_id = _construction_case_id FOR UPDATE;
    IF v_wr.id IS NULL THEN
      INSERT INTO public.builder_warranties(construction_case_id, warranty_type, provider_name,
        policy_reference, starts_on, expires_on, notes)
      VALUES (_construction_case_id, COALESCE(_payload->>'warranty_type','structural'),
        _payload->>'provider_name', _payload->>'policy_reference',
        (_payload->>'starts_on')::date, (_payload->>'expires_on')::date, _payload->>'notes')
      RETURNING * INTO v_wr;
    ELSE
      IF _expected_version IS NULL OR v_wr.row_version <> _expected_version THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
          DETAIL = format('current_version=%s', v_wr.row_version);
      END IF;
      UPDATE public.builder_warranties SET
        warranty_type = CASE WHEN _payload ? 'warranty_type' THEN _payload->>'warranty_type' ELSE warranty_type END,
        provider_name = CASE WHEN _payload ? 'provider_name' THEN _payload->>'provider_name' ELSE provider_name END,
        policy_reference = CASE WHEN _payload ? 'policy_reference' THEN _payload->>'policy_reference' ELSE policy_reference END,
        starts_on = CASE WHEN _payload ? 'starts_on' THEN (_payload->>'starts_on')::date ELSE starts_on END,
        expires_on = CASE WHEN _payload ? 'expires_on' THEN (_payload->>'expires_on')::date ELSE expires_on END,
        notes = CASE WHEN _payload ? 'notes' THEN _payload->>'notes' ELSE notes END
      WHERE id = v_wr.id RETURNING * INTO v_wr;
    END IF;
    v_result := to_jsonb(v_wr);
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_'||_kind||'_saved',
    CASE _kind WHEN 'practical_completion' THEN 'practical_completion'
               WHEN 'handover' THEN 'handover' ELSE 'warranty_claim' END,
    (v_result->>'id')::uuid, public.builder_delivery_org(_construction_case_id),
    _actor_builder_user_id, NULL,
    jsonb_build_object('row_version', v_result->>'row_version'),
    _reason, jsonb_build_object('construction_case_id', _construction_case_id));
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.builder_upsert_warranty_claim(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _claim_id uuid, _construction_case_id uuid, _warranty_id uuid DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_warranty_claims
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_warranty_claims; v_row public.builder_warranty_claims;
BEGIN
  IF _claim_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.builder_warranty_claims WHERE id = _claim_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_WARRANTY_CLAIM_NOT_FOUND';
    END IF;
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_warranty_claims SET
      claim_number = CASE WHEN _payload ? 'claim_number' THEN _payload->>'claim_number' ELSE claim_number END,
      title = CASE WHEN _payload ? 'title' THEN _payload->>'title' ELSE title END,
      description = CASE WHEN _payload ? 'description' THEN _payload->>'description' ELSE description END,
      decision_notes = CASE WHEN _payload ? 'decision_notes' THEN _payload->>'decision_notes' ELSE decision_notes END,
      warranty_id = COALESCE(_warranty_id, warranty_id)
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.builder_construction_cases WHERE id = _construction_case_id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_CONSTRUCTION_NOT_FOUND';
    END IF;
    INSERT INTO public.builder_warranty_claims(construction_case_id, warranty_id, claim_number,
      title, description)
    VALUES (_construction_case_id, _warranty_id, _payload->>'claim_number', _payload->>'title',
      _payload->>'description')
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type,
    CASE WHEN _claim_id IS NULL THEN 'builder_warranty_claim_lodged'
         ELSE 'builder_warranty_claim_updated' END,
    'warranty_claim', v_row.id, public.builder_delivery_org(v_row.construction_case_id),
    _actor_builder_user_id,
    CASE WHEN _claim_id IS NULL THEN NULL ELSE jsonb_build_object('title', v_existing.title) END,
    jsonb_build_object('title', v_row.title, 'status', v_row.status,
                       'row_version', v_row.row_version),
    _reason, jsonb_build_object('construction_case_id', v_row.construction_case_id));
  RETURN v_row;
END $$;

-- One transition command for every delivery aggregate. The kind selects the
-- table; the allow-list, the version check, the status check, the history row
-- and the trusted audit row are identical for all of them.
CREATE OR REPLACE FUNCTION public.builder_transition_delivery(
  _kind text, _entity_id uuid, _expected_version bigint, _from text, _to text, _reason text,
  _actor_type text, _actor_builder_user_id uuid DEFAULT NULL,
  _actor_staff_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_case uuid; v_version bigint; v_status text; v_result jsonb; v_history_id uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='REASON_REQUIRED';
  END IF;
  IF NOT public.builder_is_delivery_transition_allowed(_kind, _from, _to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_TRANSITION';
  END IF;

  -- Lock, read the current version and status, and confirm both match what the
  -- caller declared. The row is located by kind so no caller can aim an id at
  -- the wrong table.
  IF _kind = 'variation' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_variations WHERE id = _entity_id FOR UPDATE;
  ELSIF _kind = 'progress_claim' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_progress_claims WHERE id = _entity_id FOR UPDATE;
  ELSIF _kind = 'inspection' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_inspections WHERE id = _entity_id FOR UPDATE;
  ELSIF _kind = 'defect' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_defects WHERE id = _entity_id FOR UPDATE;
  ELSIF _kind = 'practical_completion' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_practical_completions WHERE id = _entity_id FOR UPDATE;
  ELSIF _kind = 'handover' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_handovers WHERE id = _entity_id FOR UPDATE;
  ELSIF _kind = 'warranty_claim' THEN
    SELECT construction_case_id, row_version, status INTO v_case, v_version, v_status
    FROM public.builder_warranty_claims WHERE id = _entity_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_INVALID_DELIVERY_KIND';
  END IF;

  IF v_case IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_DELIVERY_NOT_FOUND';
  END IF;
  IF v_version <> _expected_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_VERSION';
  END IF;
  IF v_status <> _from THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='STALE_STATUS';
  END IF;

  IF _kind = 'variation' THEN
    UPDATE public.builder_variations SET status = _to,
      submitted_at = CASE WHEN _to = 'submitted' THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
      decided_at = CASE WHEN _to IN ('approved','rejected') THEN COALESCE(decided_at, now()) ELSE decided_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_variations.*) INTO v_result;
  ELSIF _kind = 'progress_claim' THEN
    UPDATE public.builder_progress_claims SET status = _to,
      claimed_at = CASE WHEN _to = 'submitted' THEN COALESCE(claimed_at, now()) ELSE claimed_at END,
      certified_at = CASE WHEN _to = 'certified' THEN COALESCE(certified_at, now()) ELSE certified_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_progress_claims.*) INTO v_result;
  ELSIF _kind = 'inspection' THEN
    UPDATE public.builder_inspections SET status = _to,
      performed_at = CASE WHEN _to IN ('passed','failed','passed_with_defects')
                          THEN COALESCE(performed_at, now()) ELSE performed_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_inspections.*) INTO v_result;
  ELSIF _kind = 'defect' THEN
    UPDATE public.builder_defects SET status = _to,
      rectified_at = CASE WHEN _to = 'rectified' THEN COALESCE(rectified_at, now()) ELSE rectified_at END,
      verified_at = CASE WHEN _to = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_defects.*) INTO v_result;
  ELSIF _kind = 'practical_completion' THEN
    UPDATE public.builder_practical_completions SET status = _to,
      notified_at = CASE WHEN _to = 'notified' THEN COALESCE(notified_at, now()) ELSE notified_at END,
      inspected_at = CASE WHEN _to = 'inspected' THEN COALESCE(inspected_at, now()) ELSE inspected_at END,
      achieved_at = CASE WHEN _to = 'achieved' THEN COALESCE(achieved_at, now()) ELSE achieved_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_practical_completions.*) INTO v_result;
  ELSIF _kind = 'handover' THEN
    UPDATE public.builder_handovers SET status = _to,
      walkthrough_at = CASE WHEN _to = 'walkthrough_complete' THEN COALESCE(walkthrough_at, now()) ELSE walkthrough_at END,
      keys_released_at = CASE WHEN _to = 'keys_released' THEN COALESCE(keys_released_at, now()) ELSE keys_released_at END,
      completed_at = CASE WHEN _to = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_handovers.*) INTO v_result;
  ELSE
    UPDATE public.builder_warranty_claims SET status = _to,
      decided_at = CASE WHEN _to IN ('accepted','rejected') THEN COALESCE(decided_at, now()) ELSE decided_at END,
      rectified_at = CASE WHEN _to = 'rectified' THEN COALESCE(rectified_at, now()) ELSE rectified_at END
    WHERE id = _entity_id RETURNING to_jsonb(builder_warranty_claims.*) INTO v_result;
  END IF;

  INSERT INTO public.builder_delivery_status_history(construction_case_id, entity_kind, entity_id,
    from_status, to_status, changed_by_type, changed_by_builder_user_id, changed_by_user_id,
    reason, metadata)
  VALUES (v_case, _kind, _entity_id, _from, _to, _actor_type, _actor_builder_user_id,
    _actor_staff_user_id, left(btrim(_reason),1000),
    jsonb_build_object('row_version', v_result->>'row_version'))
  RETURNING id INTO v_history_id;

  PERFORM public.builder_log_activity(
    _actor_staff_user_id, _actor_type, 'builder_'||_kind||'_status_changed',
    CASE _kind WHEN 'variation' THEN 'variation'
               WHEN 'progress_claim' THEN 'progress_claim'
               WHEN 'inspection' THEN 'inspection'
               WHEN 'defect' THEN 'defect'
               WHEN 'practical_completion' THEN 'practical_completion'
               WHEN 'handover' THEN 'handover' ELSE 'warranty_claim' END,
    _entity_id, public.builder_delivery_org(v_case), _actor_builder_user_id,
    jsonb_build_object('status', _from),
    jsonb_build_object('status', _to, 'row_version', v_result->>'row_version'),
    left(btrim(_reason),1000), jsonb_build_object('history_id', v_history_id));
  RETURN v_result;
END $$;

-- ===========================================================================
-- 9. Touch triggers
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_variations','builder_variation_approvals',
                           'builder_progress_claims','builder_inspections','builder_defects',
                           'builder_practical_completions','builder_handovers',
                           'builder_warranties','builder_warranty_claims'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 10. Role baselines
-- ===========================================================================
INSERT INTO public.builder_role_default_permissions
  (membership_role, permission_key, can_view, can_edit, can_delete)
SELECT r.role, k.key, true,
       r.role <> 'read_only',
       r.role IN ('owner','administrator')
FROM (VALUES ('owner'),('administrator'),('manager'),('member'),('read_only')) AS r(role)
CROSS JOIN (VALUES ('variations'),('progress_claims'),('inspections'),('defects'),('handover'))
  AS k(key)
ON CONFLICT (membership_role, permission_key) DO NOTHING;

-- ===========================================================================
-- 11. RLS and grants — deny by default
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_variations','builder_variation_approvals',
                           'builder_progress_claims','builder_inspections','builder_defects',
                           'builder_practical_completions','builder_handovers',
                           'builder_warranties','builder_warranty_claims',
                           'builder_delivery_status_history'] LOOP
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
    ('builder_delivery_org','uuid'),
    ('builder_is_delivery_transition_allowed','text, text, text'),
    ('builder_upsert_variation','uuid, text, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_variation_approval','uuid, text, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_progress_claim','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_inspection','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_defect','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_delivery_record','uuid, text, uuid, text, uuid, jsonb, bigint, text'),
    ('builder_upsert_warranty_claim','uuid, text, uuid, uuid, uuid, uuid, jsonb, bigint, text'),
    ('builder_transition_delivery','text, uuid, bigint, text, text, text, text, uuid, uuid')
  ) AS t(f, a) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f, a);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, a);
  END LOOP;
END $$;

-- ===========================================================================
-- 12. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_delivery_org','builder_is_delivery_transition_allowed',
    'builder_upsert_variation','builder_upsert_variation_approval',
    'builder_upsert_progress_claim','builder_upsert_inspection','builder_upsert_defect',
    'builder_upsert_delivery_record','builder_upsert_warranty_claim',
    'builder_transition_delivery','builder_enforce_delivery_parentage',
    'builder_enforce_defect_parentage']) AS f
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: delivery function(s) missing: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('builder_variations','builder_variation_approvals',
                      'builder_progress_claims','builder_inspections','builder_defects',
                      'builder_practical_completions','builder_handovers','builder_warranties',
                      'builder_warranty_claims','builder_delivery_status_history')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_variations','builder_variation_approvals','builder_progress_claims',
                    'builder_inspections','builder_defects','builder_practical_completions',
                    'builder_handovers','builder_warranties','builder_warranty_claims']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='row_version');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: touch-triggered table(s) without row_version: %', v_missing;
  END IF;

  SELECT string_agg(k, ', ') INTO v_missing
  FROM unnest(ARRAY['variations','progress_claims','inspections','defects','handover']) AS k
  WHERE NOT EXISTS (SELECT 1 FROM public.builder_role_default_permissions
                    WHERE permission_key = k AND membership_role='manager' AND can_view);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: permission key(s) without a role baseline: %', v_missing;
  END IF;

  -- A progress claim must NOT take ownership of Finance payment information.
  -- `finance_payment_id` is the one permitted column: it is a pointer, and its
  -- name is excluded explicitly rather than by a loose pattern.
  SELECT string_agg(column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='builder_progress_claims'
    AND column_name <> 'finance_payment_id'
    AND (column_name LIKE '%paid%' OR column_name LIKE '%payment%'
         OR column_name LIKE '%receipt%' OR column_name LIKE '%remittance%'
         OR column_name LIKE '%invoice%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a progress claim owns Finance payment information: %', v_missing;
  END IF;

  -- No defect, inspection, handover or warranty record may carry money at all.
  SELECT string_agg(table_name||'.'||column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('builder_defects','builder_inspections','builder_practical_completions',
                       'builder_handovers','builder_warranties','builder_warranty_claims')
    AND (column_name LIKE '%amount%' OR column_name LIKE '%price%' OR column_name LIKE '%cost%'
         OR column_name LIKE '%fee%' OR column_name LIKE '%payment%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a quality record carries money: %', v_missing;
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

  RAISE NOTICE 'builder delivery: variations, approvals, progress claims, inspections, defects, practical completion, handover and warranty installed';
END $$;
