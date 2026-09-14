-- Builder / Developer Portal — release-control plane.
--
-- Phase 1 (20260801000400) generalised the cross-portal rollout tables so a
-- Builder organisation could own a rollout row, and added the READ path
-- (resolve_cross_portal_feature_mode_for). It did not add a WRITE path: the
-- only mutation command, set_cross_portal_firm_rollout(_firm_id, ...), takes a
-- solicitor firm id and writes portal='solicitor' rows. A Builder rollout could
-- therefore only be changed by direct SQL against the table, which the delivery
-- rules forbid, and there was no Builder readiness evaluation at all
-- (get_cross_portal_cutover_readiness hardcodes solicitor-only evidence:
-- matter-access exceptions, plaintext solicitor session columns, legal document
-- versions).
--
-- This migration completes the plane. It is purely additive: no merged
-- migration is edited, no existing column is dropped, no existing function
-- signature changes. The Solicitor commands and their behaviour are untouched
-- and are preserved as compatibility adapters.
--
-- Design decisions recorded here because they are enforced here:
--
--   * ONE organisation-level flag. builder_portal_identity_v1 is already read
--     by builder-portal-login, builder-portal-verify and
--     builder-portal-accept-invite via _shared/builderPortalAuth.isRolloutEnabled,
--     so it genuinely gates the entire external portal. No second full-portal
--     key and no module-level flags are introduced; a flag that nothing reads
--     is not a control.
--
--   * builder_portal_admin_v1 has NO runtime consumer. Rather than invent one,
--     it is marked runtime_consumed = false so the Command Centre renders it as
--     descriptive rather than protective. Claiming it gates the admin surface
--     would be false.
--
--   * Builder is greenfield. dual_read and dual_write compare a new path
--     against a legacy path; no legacy Builder path exists, so those two states
--     are marked not applicable rather than being faked with meaningless
--     comparison hashes or backfill rows. Approvals, the observation window,
--     monitoring and rollback discipline are all preserved.
--
--   * Builder state meanings (see docs/builder-portal/rollout-state-definitions.md):
--       off      external portal blocked for this organisation
--       shadow   provisioned and internally verifiable; external portal STILL
--                blocked. This is the pre-live observation stage.
--       cutover  organisation live for its external users
--       rollback blocked again, immediately, with all domain data preserved

-- ===========================================================================
-- 0. Pre-migration reconciliation
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  FOREACH v_missing IN ARRAY ARRAY[
    'cross_portal_feature_definitions','cross_portal_firm_rollouts',
    'cross_portal_rollout_history','cross_portal_cutover_approvals',
    'builder_organisations','builder_portal_activity_log']
  LOOP
    IF to_regclass('public.' || v_missing) IS NULL THEN
      RAISE EXCEPTION 'PRE-MIGRATION FAILURE: required table public.% is absent', v_missing;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cross_portal_firm_rollouts' AND column_name='portal')
  THEN
    RAISE EXCEPTION 'PRE-MIGRATION FAILURE: cross_portal_firm_rollouts.portal is absent — 20260801000400 must be applied first';
  END IF;
END $$;

CREATE TEMP TABLE _builder_release_premigration AS
SELECT
  (SELECT count(*) FROM public.cross_portal_firm_rollouts)                        AS rollouts,
  (SELECT count(*) FROM public.cross_portal_firm_rollouts WHERE portal='solicitor') AS solicitor_rollouts,
  (SELECT count(*) FROM public.cross_portal_rollout_history)                      AS history,
  (SELECT count(*) FROM public.cross_portal_cutover_approvals)                    AS approvals;

-- ===========================================================================
-- 1. Feature-definition metadata
--
-- Two honesty markers, so the Command Centre can distinguish a check that is
-- genuinely not applicable from one that was skipped, and a flag that controls
-- runtime from one that merely documents intent.
-- ===========================================================================
ALTER TABLE public.cross_portal_feature_definitions
  ADD COLUMN IF NOT EXISTS legacy_comparison_applicable boolean NOT NULL DEFAULT true;
ALTER TABLE public.cross_portal_feature_definitions
  ADD COLUMN IF NOT EXISTS runtime_consumed boolean NOT NULL DEFAULT true;
ALTER TABLE public.cross_portal_feature_definitions
  ADD COLUMN IF NOT EXISTS not_applicable_reason text;

COMMENT ON COLUMN public.cross_portal_feature_definitions.legacy_comparison_applicable IS
  'False when the feature has no legacy counterpart, so dual_read/dual_write comparison evidence cannot exist and must be reported not_applicable rather than failing or being fabricated.';
COMMENT ON COLUMN public.cross_portal_feature_definitions.runtime_consumed IS
  'False when no runtime path reads this feature key. A flag nothing reads protects nothing and must never be presented as a control.';

UPDATE public.cross_portal_feature_definitions
SET legacy_comparison_applicable = false,
    not_applicable_reason = 'Builder / Developer Portal is greenfield: there is no legacy Builder identity, inventory, transaction or construction path to compare against, so dual_read and dual_write have no meaning.'
WHERE feature_key = 'builder_portal_identity_v1';

UPDATE public.cross_portal_feature_definitions
SET legacy_comparison_applicable = false,
    runtime_consumed = false,
    not_applicable_reason = 'Descriptive only. No runtime path reads builder_portal_admin_v1; the Command Centre Builder surface is gated by the builder_portal_admin module permission, not by this key.'
WHERE feature_key = 'builder_portal_admin_v1';

-- ===========================================================================
-- 2. Optimistic concurrency on the mutable rollout record
--
-- cross_portal_firm_rollouts is the one mutable row in the plane; history and
-- approvals are append-only or state-flagged. A concurrent operator advancing
-- and another rolling back must not silently last-write-win.
-- ===========================================================================
ALTER TABLE public.cross_portal_firm_rollouts
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.bump_cross_portal_rollout_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.row_version := COALESCE(OLD.row_version, 0) + 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bump_cross_portal_rollout_version ON public.cross_portal_firm_rollouts;
CREATE TRIGGER trg_bump_cross_portal_rollout_version
  BEFORE UPDATE ON public.cross_portal_firm_rollouts
  FOR EACH ROW EXECUTE FUNCTION public.bump_cross_portal_rollout_version();

-- ===========================================================================
-- 3. Approval revocation evidence
--
-- The Solicitor plane can set revoked_at but records neither who revoked nor
-- why, and exposes no revocation command at all. Both are required Builder
-- release evidence.
-- ===========================================================================
ALTER TABLE public.cross_portal_cutover_approvals
  ADD COLUMN IF NOT EXISTS revoked_by uuid;
ALTER TABLE public.cross_portal_cutover_approvals
  ADD COLUMN IF NOT EXISTS revoke_reason text;

-- ===========================================================================
-- 4. Audit entity types
--
-- builder_portal_activity_log is the trusted Builder audit trail and its
-- entity_type CHECK predates the release-control plane.
-- ===========================================================================
-- The full list as of 20260809000000, PLUS the two release-control types. Each
-- domain migration restates the whole enumeration, so this one must carry every
-- earlier value forward — dropping the constraint and re-adding a short list
-- would silently break audit writes for every domain that came before.
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
     'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim',
     'document', 'document_version', 'document_grant',
     'conversation', 'message', 'task', 'task_assignment', 'notification',
     'organisation_settings', 'user_preferences',
     'rollout', 'rollout_approval'));

-- ===========================================================================
-- 5. Builder transition graph
--
-- Greenfield, so the Solicitor comparison states are not on the path. Rollback
-- is reachable from every active mode; recovery from rollback re-enters at
-- shadow so the organisation is re-verified before going live again.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_rollout_transition_allowed(_from text, _to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _to = 'rollback' THEN _from IN ('shadow','cutover')
    WHEN _from = 'off'      AND _to = 'shadow'  THEN true
    WHEN _from = 'shadow'   AND _to = 'cutover' THEN true
    WHEN _from = 'shadow'   AND _to = 'off'     THEN true
    WHEN _from = 'rollback' AND _to = 'shadow'  THEN true
    WHEN _from = 'rollback' AND _to = 'off'     THEN true
    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.builder_rollout_transition_allowed(text, text) IS
  'Builder rollout transition graph. dual_read and dual_write are deliberately unreachable: Builder is greenfield and has no legacy path to compare against.';

-- ===========================================================================
-- 6. Builder readiness
--
-- Portal-aware and Builder-specific. Every check is one of:
--   pass            evidence gathered and satisfied
--   fail            evidence gathered and not satisfied
--   not_applicable  cannot exist for a greenfield Builder rollout, with reason
--   unknown         evidence could not be gathered — treated as NOT ready
--
-- to_regclass guards mean a missing table yields 'unknown' rather than an
-- error, which is itself the "required tables present" evidence and keeps the
-- function fail-closed instead of unreadable.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_builder_cutover_readiness(
  _organisation_id uuid, _feature_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_def public.cross_portal_feature_definitions;
  v_checks jsonb := '[]'::jsonb;
  v_org record;
  v_mode text;
  v_stable_since timestamptz;
  v_approvals integer;
  v_n bigint;
  -- `required` marks release-blocking evidence. A required check that fails,
  -- or whose evidence could not be gathered, makes the whole evaluation
  -- not-ready.
  v_required_failures integer := 0;
  v_unknown integer := 0;
BEGIN
  SELECT * INTO v_def FROM public.cross_portal_feature_definitions WHERE feature_key = _feature_key;
  IF v_def.feature_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_FEATURE_NOT_FOUND';
  END IF;
  IF v_def.portal NOT IN ('builder','shared') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_FEATURE_PORTAL_MISMATCH',
      DETAIL = format('feature %s belongs to portal %s and cannot be evaluated for Builder',
                      _feature_key, v_def.portal);
  END IF;

  SELECT id, legal_name, status INTO v_org
  FROM public.builder_organisations WHERE id = _organisation_id;
  IF v_org.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;

  v_mode := public.resolve_cross_portal_feature_mode_for('builder', _organisation_id, _feature_key);

  -- ---- schema evidence -------------------------------------------------
  -- Required Builder tables. Absence is unknown-and-required, so a partially
  -- migrated environment can never read as ready.
  SELECT count(*) INTO v_n FROM unnest(ARRAY[
    'builder_organisations','builder_portal_users','builder_organisation_memberships',
    'builder_membership_permissions','builder_permission_keys','builder_portal_sessions',
    'builder_onboarding_steps','builder_portal_activity_log',
    'builder_developments','builder_projects','builder_project_access',
    'builder_units','builder_unit_pricing','builder_unit_holds','builder_reservations',
    'builder_transactions','builder_construction_cases','builder_construction_milestones',
    'builder_variations','builder_progress_claims','builder_inspections','builder_defects',
    'builder_handovers','builder_warranties','builder_documents','builder_document_versions',
    'builder_conversations','builder_messages','builder_tasks','builder_notifications',
    'builder_organisation_settings','builder_user_preferences']) AS t
  WHERE to_regclass('public.' || t) IS NULL;
  v_checks := v_checks || jsonb_build_object(
    'key','required_builder_tables_present','required',true,
    'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s of 32 required Builder tables absent', v_n));
  IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;

  -- Required Builder functions.
  SELECT count(*) INTO v_n FROM unnest(ARRAY[
    'builder_resolve_permission','builder_log_activity','builder_revoke_user_sessions',
    'builder_admin_upsert_membership','builder_admin_set_organisation_status',
    'resolve_cross_portal_feature_mode_for','builder_rollout_transition_allowed']) AS f
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname = f);
  v_checks := v_checks || jsonb_build_object(
    'key','required_builder_functions_present','required',true,
    'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s of 7 required Builder functions absent', v_n));
  IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;

  -- Every Builder table carries RLS. A Builder table without RLS is directly
  -- reachable with the anon key.
  SELECT count(*) INTO v_n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'builder\_%'
    AND c.relname NOT IN ('builder_invoices')   -- Finance-owned, out of scope
    AND c.relrowsecurity = false;
  v_checks := v_checks || jsonb_build_object(
    'key','builder_tables_rls_enabled','required',true,
    'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s Builder tables without row level security', v_n));
  IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;

  -- No Builder table may be directly readable or writable by anon/authenticated.
  SELECT count(*) INTO v_n
  FROM information_schema.role_table_grants g
  WHERE g.table_schema='public' AND g.table_name LIKE 'builder\_%'
    AND g.table_name NOT IN ('builder_invoices')
    AND g.grantee IN ('anon','authenticated');
  v_checks := v_checks || jsonb_build_object(
    'key','no_direct_anon_or_authenticated_grants','required',true,
    'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s direct anon/authenticated grants on Builder tables', v_n));
  IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;

  -- ---- governance evidence ---------------------------------------------
  -- A current Builder terms version must exist, or every user is stopped at the
  -- terms wall with nothing to accept.
  IF to_regclass('public.portal_terms_versions') IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'key','builder_terms_version_present','required',true,'status','unknown',
      'detail','portal_terms_versions is absent');
    v_unknown := v_unknown + 1;
  ELSE
    -- "Current" is expressed by the portal_terms_one_current_idx partial unique
    -- index: the live version for a portal is the one that has not been retired.
    EXECUTE $q$ SELECT count(*) FROM public.portal_terms_versions
                WHERE portal='builder' AND retired_at IS NULL $q$ INTO v_n;
    v_checks := v_checks || jsonb_build_object(
      'key','builder_terms_version_present','required',true,
      'status', CASE WHEN v_n >= 1 THEN 'pass' ELSE 'fail' END,
      'detail', format('%s current Builder terms version(s)', v_n));
    IF v_n < 1 THEN v_required_failures := v_required_failures + 1; END IF;
  END IF;

  -- Mandatory onboarding is per user, provisioned by
  -- builder_ensure_onboarding_steps(). Without that function no user is ever
  -- given a checklist, so the onboarding gate would pass vacuously.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname = 'builder_ensure_onboarding_steps';
  v_checks := v_checks || jsonb_build_object(
    'key','builder_mandatory_onboarding_configured','required',true,
    'status', CASE WHEN v_n >= 1 AND to_regclass('public.builder_onboarding_steps') IS NOT NULL
                   THEN 'pass' ELSE 'fail' END,
    'detail', CASE WHEN v_n >= 1 AND to_regclass('public.builder_onboarding_steps') IS NOT NULL
      THEN 'onboarding checklist provisioning is installed'
      ELSE 'builder_ensure_onboarding_steps or builder_onboarding_steps is absent' END);
  IF v_n < 1 OR to_regclass('public.builder_onboarding_steps') IS NULL THEN
    v_required_failures := v_required_failures + 1;
  END IF;

  -- The rollout must be organisation-scoped, and this organisation must own a
  -- row of its own rather than inheriting a global default.
  SELECT count(*) INTO v_n FROM public.cross_portal_firm_rollouts
  WHERE portal='builder' AND builder_organisation_id = _organisation_id AND feature_key = _feature_key;
  v_checks := v_checks || jsonb_build_object(
    'key','rollout_is_organisation_scoped','required',true,
    'status', CASE WHEN v_n = 1 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s organisation-scoped rollout row(s); current mode %s', v_n, v_mode));
  IF v_n <> 1 THEN v_required_failures := v_required_failures + 1; END IF;

  -- The organisation itself must be active.
  v_checks := v_checks || jsonb_build_object(
    'key','organisation_active','required',true,
    'status', CASE WHEN v_org.status = 'active' THEN 'pass' ELSE 'fail' END,
    'detail', format('organisation status %s', v_org.status));
  IF v_org.status <> 'active' THEN v_required_failures := v_required_failures + 1; END IF;

  -- ---- document safety -------------------------------------------------
  -- Builder document versions carry no malware scan state, no lifecycle state
  -- and no quarantine. Until the shared immutable-document service is
  -- generalised to Builder this is a required, permanently failing check: it is
  -- the release blocker, expressed as evidence rather than as prose.
  IF to_regclass('public.builder_document_versions') IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'key','builder_document_malware_scanning','required',true,'status','unknown',
      'detail','builder_document_versions is absent');
    v_unknown := v_unknown + 1;
  ELSE
    SELECT count(*) INTO v_n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='builder_document_versions'
      AND column_name IN ('malware_scan_status','lifecycle_status');
    v_checks := v_checks || jsonb_build_object(
      'key','builder_document_malware_scanning','required',true,
      'status', CASE WHEN v_n = 2 THEN 'pass' ELSE 'fail' END,
      'detail', CASE WHEN v_n = 2
        THEN 'builder_document_versions carries scan and lifecycle state'
        ELSE 'RELEASE BLOCKER: builder_document_versions has no malware_scan_status/lifecycle_status; uploads are neither quarantined nor scanned' END);
    IF v_n <> 2 THEN v_required_failures := v_required_failures + 1; END IF;
  END IF;

  -- Unsafe documents must not be downloadable. Only meaningful once scan state
  -- exists; until then the check above already blocks.
  IF to_regclass('public.builder_document_versions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='builder_document_versions'
                   AND column_name='malware_scan_status')
  THEN
    EXECUTE $q$ SELECT count(*) FROM public.builder_document_versions
                WHERE malware_scan_status <> 'clean' $q$ INTO v_n;
    v_checks := v_checks || jsonb_build_object(
      'key','no_unsafe_builder_documents','required',true,
      'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
      'detail', format('%s unscanned or infected document version(s)', v_n));
    IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;
  ELSE
    v_checks := v_checks || jsonb_build_object(
      'key','no_unsafe_builder_documents','required',true,'status','unknown',
      'detail','no scan state to evaluate');
    v_unknown := v_unknown + 1;
  END IF;

  -- ---- operational evidence --------------------------------------------
  IF to_regclass('public.portal_operational_alerts') IS NULL
     OR to_regclass('public.portal_operational_events') IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'key','no_critical_builder_alerts','required',true,'status','unknown',
      'detail','operational alert infrastructure is absent');
    v_unknown := v_unknown + 1;
  ELSE
    EXECUTE $q$ SELECT count(*) FROM public.portal_operational_alerts a
                JOIN public.portal_operational_events e ON e.id = a.event_id
                WHERE a.status='open' AND a.severity='critical' AND e.portal='builder' $q$ INTO v_n;
    v_checks := v_checks || jsonb_build_object(
      'key','no_critical_builder_alerts','required',true,
      'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
      'detail', format('%s open critical Builder alert(s)', v_n));
    IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;
  END IF;

  IF to_regclass('public.integration_dead_letters') IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'key','no_unreplayed_builder_dead_letters','required',false,'status','not_applicable',
      'detail','Builder has no outbox or dead-letter path of its own; nothing to replay');
  ELSE
    EXECUTE $q$ SELECT count(*) FROM public.integration_dead_letters WHERE replayed_at IS NULL $q$ INTO v_n;
    v_checks := v_checks || jsonb_build_object(
      'key','no_unreplayed_builder_dead_letters','required',true,
      'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
      'detail', format('%s unreplayed dead-letter event(s)', v_n));
    IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;
  END IF;

  -- Cross-organisation isolation: no membership may reach an organisation that
  -- does not exist, and no permission override may outlive its membership.
  SELECT count(*) INTO v_n
  FROM public.builder_organisation_memberships m
  LEFT JOIN public.builder_organisations o ON o.id = m.organisation_id
  WHERE o.id IS NULL;
  v_checks := v_checks || jsonb_build_object(
    'key','no_orphaned_builder_memberships','required',true,
    'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s membership(s) referencing a missing organisation', v_n));
  IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;

  -- ---- legacy comparison, explicitly not applicable ---------------------
  IF v_def.legacy_comparison_applicable THEN
    SELECT count(*) INTO v_n FROM public.cross_portal_dual_read_comparisons
    WHERE portal='builder' AND builder_organisation_id = _organisation_id
      AND feature_key = _feature_key AND matches = false
      AND compared_at >= now() - interval '7 days';
    v_checks := v_checks || jsonb_build_object(
      'key','no_dual_read_mismatches','required',true,
      'status', CASE WHEN v_n = 0 THEN 'pass' ELSE 'fail' END,
      'detail', format('%s dual-read mismatch(es) in the last 7 days', v_n));
    IF v_n > 0 THEN v_required_failures := v_required_failures + 1; END IF;
  ELSE
    v_checks := v_checks || jsonb_build_object(
      'key','no_dual_read_mismatches','required',false,'status','not_applicable',
      'detail', COALESCE(v_def.not_applicable_reason,
        'No legacy Builder path exists, so dual-read comparison cannot be produced.'));
    v_checks := v_checks || jsonb_build_object(
      'key','legacy_backfill_reconciled','required',false,'status','not_applicable',
      'detail','Greenfield: there is no legacy Builder data to backfill or reconcile.');
  END IF;

  -- ---- approvals --------------------------------------------------------
  SELECT count(DISTINCT approval_type) INTO v_approvals
  FROM public.cross_portal_cutover_approvals
  WHERE portal='builder' AND builder_organisation_id = _organisation_id
    AND feature_key = _feature_key AND revoked_at IS NULL;

  v_checks := v_checks || jsonb_build_object(
    'key','four_approvals_active','required',true,
    'status', CASE WHEN v_approvals = 4 THEN 'pass' ELSE 'fail' END,
    'detail', format('%s of 4 approval types active', v_approvals));
  IF v_approvals <> 4 THEN v_required_failures := v_required_failures + 1; END IF;

  -- ---- stable observation window ----------------------------------------
  SELECT max(changed_at) INTO v_stable_since
  FROM public.cross_portal_rollout_history
  WHERE portal='builder' AND builder_organisation_id = _organisation_id
    AND feature_key = _feature_key AND to_mode = 'shadow';

  IF v_stable_since IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'key','minimum_stable_window_complete','required',true,'status','fail',
      'detail','the organisation has never entered shadow, so no observation window has begun');
    v_required_failures := v_required_failures + 1;
  ELSE
    v_checks := v_checks || jsonb_build_object(
      'key','minimum_stable_window_complete','required',true,
      'status', CASE WHEN v_stable_since <= now() - make_interval(days => v_def.minimum_stable_days)
                     THEN 'pass' ELSE 'fail' END,
      'detail', format('in shadow since %s; %s day window required',
                       to_char(v_stable_since,'YYYY-MM-DD HH24:MI'), v_def.minimum_stable_days));
    IF v_stable_since > now() - make_interval(days => v_def.minimum_stable_days) THEN
      v_required_failures := v_required_failures + 1;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ready', (v_required_failures = 0 AND v_unknown = 0),
    'portal','builder',
    'organisation_id', _organisation_id,
    'organisation_name', v_org.legal_name,
    'feature_key', _feature_key,
    'runtime_consumed', v_def.runtime_consumed,
    'current_mode', v_mode,
    'minimum_stable_days', v_def.minimum_stable_days,
    'required_failures', v_required_failures,
    'unknown_required', v_unknown,
    'checks', v_checks,
    'evaluated_at', now());
END $$;

COMMENT ON FUNCTION public.get_builder_cutover_readiness(uuid, text) IS
  'Builder-specific readiness evidence. Fails closed: any required check that is failing OR whose evidence could not be gathered makes ready false. Not-applicable checks are explicit and carry a reason.';

-- ===========================================================================
-- 7. Builder operational health
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_builder_operational_health(_organisation_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_alerts jsonb := '[]'::jsonb; v_events jsonb := '{}'::jsonb;
BEGIN
  IF to_regclass('public.portal_operational_alerts') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_alerts
    FROM (
      SELECT a.id, a.alert_type, a.severity, a.status, a.summary, a.created_at, e.correlation_id
      FROM public.portal_operational_alerts a
      JOIN public.portal_operational_events e ON e.id = a.event_id
      WHERE a.status = 'open' AND e.portal = 'builder'
      ORDER BY a.created_at DESC LIMIT 100
    ) x;

    SELECT jsonb_build_object(
      'events_24h', count(*),
      'failures_24h', count(*) FILTER (WHERE success = false),
      'critical_24h', count(*) FILTER (WHERE severity = 'critical')) INTO v_events
    FROM public.portal_operational_events
    WHERE portal = 'builder' AND occurred_at >= now() - interval '24 hours';
  END IF;

  RETURN jsonb_build_object(
    'portal','builder',
    'organisation_id', _organisation_id,
    'open_alerts', v_alerts,
    'event_summary', v_events,
    -- A session is live only while it is unrevoked and inside BOTH its idle and
    -- absolute expiry, matching resolveBuilderSessionToken.
    'sessions_active', (SELECT count(*) FROM public.builder_portal_sessions
                        WHERE revoked_at IS NULL
                          AND idle_expires_at > now()
                          AND absolute_expires_at > now()),
    'evaluated_at', now());
END $$;

-- ===========================================================================
-- 8. Guarded transactional rollout command
--
-- Mirrors the builder_admin_* construction from 20260801000600: mutation and
-- trusted audit in ONE transaction, so a failed audit write rolls the
-- transition back. builder_log_activity raises rather than swallowing, which is
-- what makes that true.
--
-- This is deliberately NOT the Solicitor construction, which writes its audit
-- from the Edge Function after the RPC has already committed.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.set_cross_portal_rollout_for(
  _portal text,
  _owner_id uuid,
  _feature_key text,
  _to_mode text,
  _reason text,
  _actor_id uuid,
  _actor_type text DEFAULT 'command_user',
  _expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_def public.cross_portal_feature_definitions;
  v_existing public.cross_portal_firm_rollouts;
  v_row public.cross_portal_firm_rollouts;
  v_org record;
  v_from text;
  v_readiness jsonb;
  v_reason text;
BEGIN
  IF _portal <> 'builder' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_UNSUPPORTED_PORTAL',
      DETAIL='set_cross_portal_rollout_for serves Builder. Solicitor transitions keep using set_cross_portal_firm_rollout unchanged.';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(_reason,'')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_REASON_REQUIRED';
  END IF;

  IF _actor_id IS NULL AND COALESCE(_actor_type,'') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_ACTOR_REQUIRED';
  END IF;

  -- Feature must exist and belong to Builder or the shared set.
  SELECT * INTO v_def FROM public.cross_portal_feature_definitions WHERE feature_key = _feature_key;
  IF v_def.feature_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_FEATURE_NOT_FOUND';
  END IF;
  IF v_def.portal NOT IN ('builder','shared') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_FEATURE_PORTAL_MISMATCH';
  END IF;

  -- Owner must be a real Builder organisation.
  SELECT id, legal_name INTO v_org FROM public.builder_organisations WHERE id = _owner_id;
  IF v_org.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;

  SELECT * INTO v_existing FROM public.cross_portal_firm_rollouts
  WHERE portal='builder' AND builder_organisation_id = _owner_id AND feature_key = _feature_key
  FOR UPDATE;

  -- Optimistic concurrency applies only to an existing mutable row. Creating
  -- the first row for an organisation has nothing to be stale against.
  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_EXPECTED_VERSION_REQUIRED',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    IF v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
  END IF;

  v_from := COALESCE(v_existing.mode, v_def.default_mode, 'off');

  IF NOT public.builder_rollout_transition_allowed(v_from, _to_mode) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_CUTOVER_TRANSITION',
      DETAIL = format('Builder rollout cannot move from %s to %s', v_from, _to_mode);
  END IF;

  v_readiness := public.get_builder_cutover_readiness(_owner_id, _feature_key);

  -- Going live requires readiness. Every other transition, including rollback,
  -- must stay available even when the portal is unhealthy — that is the point
  -- of rollback.
  IF _to_mode = 'cutover' AND COALESCE((v_readiness->>'ready')::boolean, false) <> true THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_READINESS_FAILED',
      DETAIL = format('%s required check(s) failing, %s unknown',
                      v_readiness->>'required_failures', v_readiness->>'unknown_required');
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.cross_portal_firm_rollouts(
      portal, builder_organisation_id, firm_id, feature_key, mode, reason, changed_by, stable_since)
    VALUES ('builder', _owner_id, NULL, _feature_key, _to_mode, left(v_reason, 2000), _actor_id,
            CASE WHEN _to_mode IN ('shadow','cutover') THEN now() END)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.cross_portal_firm_rollouts
    SET mode = _to_mode,
        reason = left(v_reason, 2000),
        changed_by = _actor_id,
        changed_at = now(),
        -- The observation window survives shadow -> cutover but is cleared by a
        -- rollback or a return to off, so recovery must observe again.
        stable_since = CASE
          WHEN _to_mode IN ('shadow','cutover') THEN COALESCE(v_existing.stable_since, now())
          ELSE NULL END
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.cross_portal_rollout_history(
    portal, builder_organisation_id, firm_id, feature_key, from_mode, to_mode,
    reason, changed_by, readiness_snapshot)
  VALUES ('builder', _owner_id, NULL, _feature_key, v_from, _to_mode,
          left(v_reason, 2000), _actor_id, v_readiness);

  -- Trusted audit, same transaction. Raises on failure, rolling the transition
  -- back with it.
  PERFORM public.builder_log_activity(
    _actor_id, _actor_type, 'builder_rollout_' || _to_mode,
    'rollout', v_row.id, _owner_id, NULL,
    jsonb_build_object('mode', v_from, 'row_version', v_existing.row_version),
    jsonb_build_object('mode', v_row.mode, 'row_version', v_row.row_version),
    v_reason,
    jsonb_build_object('feature_key', _feature_key, 'ready', v_readiness->'ready'));

  RETURN jsonb_build_object(
    'portal','builder', 'organisation_id', _owner_id, 'feature_key', _feature_key,
    'from_mode', v_from, 'mode', v_row.mode, 'row_version', v_row.row_version,
    'stable_since', v_row.stable_since, 'readiness', v_readiness);
END $$;

COMMENT ON FUNCTION public.set_cross_portal_rollout_for IS
  'Guarded Builder rollout transition. Validates actor, organisation, feature portal, transition graph, reason and expected_version, then writes state, history and trusted audit in one transaction.';

-- ===========================================================================
-- 9. Guarded approval commands
--
-- The Solicitor plane upserts this table directly from the Edge Function. These
-- are commands, so approval and audit commit together.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.record_cross_portal_approval_for(
  _portal text, _owner_id uuid, _feature_key text, _approval_type text,
  _evidence_reference text, _actor_id uuid, _actor_type text DEFAULT 'command_user')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.cross_portal_cutover_approvals; v_def text; v_evidence text; v_org record;
BEGIN
  IF _portal <> 'builder' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_UNSUPPORTED_PORTAL';
  END IF;
  IF _approval_type NOT IN ('technical','security','operations','business_owner') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_UNKNOWN_APPROVAL_TYPE';
  END IF;

  v_evidence := NULLIF(btrim(COALESCE(_evidence_reference,'')), '');
  IF v_evidence IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_EVIDENCE_REQUIRED';
  END IF;
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_ACTOR_REQUIRED';
  END IF;

  SELECT portal INTO v_def FROM public.cross_portal_feature_definitions WHERE feature_key = _feature_key;
  IF v_def IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_FEATURE_NOT_FOUND';
  END IF;
  IF v_def NOT IN ('builder','shared') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_FEATURE_PORTAL_MISMATCH';
  END IF;

  SELECT id INTO v_org FROM public.builder_organisations WHERE id = _owner_id;
  IF v_org.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORG_NOT_FOUND';
  END IF;

  -- Re-approving an already-active approval is idempotent, not an error: it
  -- refreshes the evidence reference and the approver.
  INSERT INTO public.cross_portal_cutover_approvals(
    portal, builder_organisation_id, firm_id, feature_key, approved_by,
    approval_type, evidence_reference, approved_at, revoked_at, revoked_by, revoke_reason)
  VALUES ('builder', _owner_id, NULL, _feature_key, _actor_id,
          _approval_type, left(v_evidence, 1000), now(), NULL, NULL, NULL)
  ON CONFLICT (builder_organisation_id, feature_key, approval_type)
    WHERE builder_organisation_id IS NOT NULL
  DO UPDATE SET approved_by = excluded.approved_by,
                evidence_reference = excluded.evidence_reference,
                approved_at = now(),
                revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
  RETURNING * INTO v_row;

  PERFORM public.builder_log_activity(
    _actor_id, _actor_type, 'builder_rollout_approval_recorded',
    'rollout_approval', v_row.id, _owner_id, NULL, NULL,
    jsonb_build_object('approval_type', _approval_type, 'feature_key', _feature_key),
    v_evidence, jsonb_build_object('evidence_reference', left(v_evidence, 1000)));

  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.revoke_cross_portal_approval_for(
  _portal text, _owner_id uuid, _feature_key text, _approval_type text,
  _reason text, _actor_id uuid, _actor_type text DEFAULT 'command_user')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.cross_portal_cutover_approvals; v_reason text;
BEGIN
  IF _portal <> 'builder' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_PORTAL_UNSUPPORTED_PORTAL';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(_reason,'')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_REASON_REQUIRED';
  END IF;
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_ACTOR_REQUIRED';
  END IF;

  UPDATE public.cross_portal_cutover_approvals
  SET revoked_at = now(), revoked_by = _actor_id, revoke_reason = left(v_reason, 2000)
  WHERE portal='builder' AND builder_organisation_id = _owner_id
    AND feature_key = _feature_key AND approval_type = _approval_type AND revoked_at IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CUTOVER_APPROVAL_NOT_FOUND';
  END IF;

  PERFORM public.builder_log_activity(
    _actor_id, _actor_type, 'builder_rollout_approval_revoked',
    'rollout_approval', v_row.id, _owner_id, NULL,
    jsonb_build_object('approval_type', _approval_type, 'active', true),
    jsonb_build_object('approval_type', _approval_type, 'active', false),
    v_reason, jsonb_build_object('feature_key', _feature_key));

  RETURN to_jsonb(v_row);
END $$;

-- ===========================================================================
-- 10. Privileges — service-role server paths only
-- ===========================================================================
REVOKE ALL ON FUNCTION
  public.get_builder_cutover_readiness(uuid, text),
  public.get_builder_operational_health(uuid),
  public.builder_rollout_transition_allowed(text, text),
  public.set_cross_portal_rollout_for(text, uuid, text, text, text, uuid, text, bigint),
  public.record_cross_portal_approval_for(text, uuid, text, text, text, uuid, text),
  public.revoke_cross_portal_approval_for(text, uuid, text, text, text, uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.get_builder_cutover_readiness(uuid, text),
  public.get_builder_operational_health(uuid),
  public.builder_rollout_transition_allowed(text, text),
  public.set_cross_portal_rollout_for(text, uuid, text, text, text, uuid, text, bigint),
  public.record_cross_portal_approval_for(text, uuid, text, text, text, uuid, text),
  public.revoke_cross_portal_approval_for(text, uuid, text, text, text, uuid, text)
TO service_role;

-- ===========================================================================
-- 11. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_before record; v_n bigint;
BEGIN
  SELECT * INTO v_before FROM _builder_release_premigration;

  IF (SELECT count(*) FROM public.cross_portal_firm_rollouts) <> v_before.rollouts THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: rollout row count changed'; END IF;
  IF (SELECT count(*) FROM public.cross_portal_firm_rollouts WHERE portal='solicitor') <> v_before.solicitor_rollouts THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: solicitor rollout rows changed'; END IF;
  IF (SELECT count(*) FROM public.cross_portal_rollout_history) <> v_before.history THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: rollout history changed'; END IF;
  IF (SELECT count(*) FROM public.cross_portal_cutover_approvals) <> v_before.approvals THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: approval rows changed'; END IF;

  -- Where the Solicitor command exists it must still carry its original
  -- signature — this migration must never have redefined or overloaded it.
  -- A test harness that builds only the Builder half legitimately has no
  -- Solicitor command to preserve, so absence is not a failure; a CHANGED
  -- signature always is.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='set_cross_portal_firm_rollout')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='set_cross_portal_firm_rollout'
      AND pg_get_function_identity_arguments(p.oid) = '_firm_id uuid, _feature_key text, _to_mode text, _reason text, _actor_id uuid')
  THEN RAISE EXCEPTION 'POST-MIGRATION FAILURE: Solicitor rollout command signature changed'; END IF;

  -- Builder features must default to off.
  SELECT count(*) INTO v_n FROM public.cross_portal_feature_definitions
  WHERE portal='builder' AND default_mode <> 'off';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: % Builder feature(s) do not default to off', v_n; END IF;

  -- The greenfield markers must be set.
  SELECT count(*) INTO v_n FROM public.cross_portal_feature_definitions
  WHERE portal='builder' AND legacy_comparison_applicable;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: % Builder feature(s) still claim a legacy comparison', v_n; END IF;

  -- dual_read and dual_write must be unreachable for Builder.
  IF public.builder_rollout_transition_allowed('shadow','dual_read')
     OR public.builder_rollout_transition_allowed('shadow','dual_write')
     OR public.builder_rollout_transition_allowed('off','cutover') THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: Builder transition graph permits an unsupported move'; END IF;

  RAISE NOTICE 'Builder release-control plane installed; Solicitor plane unchanged';
END $$;

DROP TABLE IF EXISTS _builder_release_premigration;
