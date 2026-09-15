-- ============================================================================
-- The operator plane's audit entries actually land.
--
-- builder-network-admin logs every organisation decision through
-- builder_log_activity with entity_type = 'network_admin' — a vocabulary
-- word the activity log's CHECK constraint never learned, because the
-- constraint travelled from the prime (which has no network operator plane)
-- and the admin function was written network-side. Every operator audit
-- write therefore failed the CHECK, the RPC raised, and the function logged
-- a console error while the act itself proceeded: a silently-failing audit
-- path on the surface that approves organisations.
--
-- The fix is one word in the vocabulary. The list below is the baseline's
-- CHECK verbatim plus 'network_admin'; the TypeScript union in
-- builderPortalAuth.ts gains the same word in the same change.
-- ============================================================================

ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK ((entity_type IS NULL) OR (entity_type = ANY (ARRAY[
    'organisation'::text, 'portal_user'::text, 'membership'::text,
    'membership_permissions'::text, 'session'::text,
    'development'::text, 'project'::text, 'project_party'::text, 'project_access'::text,
    'stage'::text, 'building'::text, 'lot'::text, 'unit'::text, 'unit_price'::text,
    'unit_hold'::text, 'reservation'::text, 'allocation'::text,
    'transaction'::text, 'transaction_party'::text, 'transaction_case_link'::text,
    'construction_case'::text, 'construction_stage'::text, 'milestone'::text,
    'progress_update'::text, 'photograph'::text,
    'variation'::text, 'variation_approval'::text, 'progress_claim'::text,
    'inspection'::text, 'defect'::text, 'practical_completion'::text,
    'handover'::text, 'warranty_claim'::text,
    'document'::text, 'document_version'::text, 'document_grant'::text,
    'conversation'::text, 'message'::text, 'task'::text, 'task_assignment'::text,
    'notification'::text, 'organisation_settings'::text, 'user_preferences'::text,
    'rollout'::text, 'rollout_approval'::text,
    'stock_upload'::text, 'stock_item'::text, 'stock_selection'::text,
    'network_admin'::text
  ])));

-- ===========================================================================
-- Post-migration assertion: the operator plane's word is accepted and the
-- rest of the vocabulary survived the restatement.
-- ===========================================================================
-- The probe rows are REAL audit entries and stay: the log is append-only by
-- trigger (BUILDER_ACTIVITY_LOG_APPEND_ONLY), which is exactly the property
-- being preserved — a migration that deleted its probes would fail on the
-- trigger, and rightly so. Two clearly-named entries per apply is the cost
-- of proving the vocabulary in place.
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := public.builder_log_activity(
    NULL, 'system', 'network_admin_audit_probe',
    'network_admin', NULL, NULL, NULL,
    NULL, NULL, NULL,
    jsonb_build_object('migration', '20260915140000', 'purpose', 'CHECK vocabulary probe'),
    NULL, 'migration-probe');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: network_admin audit probe wrote nothing';
  END IF;

  v_id := public.builder_log_activity(
    NULL, 'system', 'network_admin_audit_probe',
    'stock_selection', NULL, NULL, NULL,
    NULL, NULL, NULL,
    jsonb_build_object('migration', '20260915140000', 'purpose', 'CHECK vocabulary probe'),
    NULL, 'migration-probe');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the restated CHECK lost an existing entity type';
  END IF;

  RAISE NOTICE 'activity vocabulary: network_admin accepted; existing entries unaffected';
END $$;
