-- Builder / Developer Portal — Workspace: dashboard summaries, activity history,
-- organisation settings and user settings.
--
-- Additive only. Every earlier Builder object is reused unchanged.
--
-- Blueprint:
--   This is the last module. It adds no new business aggregate — it reads across
--   the ones already built and adds the two settings records the portal needs.
--
--     firm_settings / solicitor preferences -> builder_organisation_settings
--                                              builder_user_preferences
--     solicitor activity feed               -> builder_visible_activity
--
-- THE ACTIVITY BOUNDARY is the security-critical part of this module. The
-- trusted audit log records EVERY Builder mutation, including internal
-- administration of memberships, permissions and sessions. A portal user must
-- never read those. So `builder_visible_activity` does two things, in order:
--
--   1. Refuses any entity type that belongs to identity or administration. That
--      is a closed allow-list, not a deny-list — an entity type nobody has
--      classified is invisible.
--   2. Resolves every remaining row back to the aggregate that governs it and
--      asks the SAME resolver the record itself uses. A user who cannot open a
--      defect cannot read that the defect changed.
--
-- DATA BOUNDARY: settings carry contact and display preferences. No money, no
-- client financial position, no AML determination, no privileged legal field.
-- The activity projection deliberately omits `previous_state`, `new_state`,
-- `ip_address` and `user_agent`: those are forensic fields for the Command
-- Centre, and a Builder user is shown what changed, not the internal record of
-- who was where.

-- ===========================================================================
-- 1. Organisation settings
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_organisation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  display_name text,
  primary_contact_name text,
  primary_contact_email text
    CHECK (primary_contact_email IS NULL OR primary_contact_email LIKE '%@%'),
  primary_contact_phone text,
  timezone text NOT NULL DEFAULT 'Australia/Sydney',
  default_landing_page text NOT NULL DEFAULT 'dashboard'
    CHECK (default_landing_page IN ('dashboard','projects','inventory','transactions',
                                    'construction','documents','messages','tasks')),
  -- What the organisation lets its own people be notified about. These do not
  -- widen access: a notification is only ever raised for a record its recipient
  -- can already reach.
  notify_on_defect boolean NOT NULL DEFAULT true,
  notify_on_inspection boolean NOT NULL DEFAULT true,
  notify_on_variation boolean NOT NULL DEFAULT true,
  notify_on_message boolean NOT NULL DEFAULT true,
  notify_on_task boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.builder_organisation_settings IS
  'Display and notification preferences for one Builder organisation. Carries no access-control decision: membership and the permission matrix remain the only authority.';

-- ===========================================================================
-- 2. User settings
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  -- A PREFERENCE, not a grant. The session still resolves the active
  -- organisation from live membership; this only says which one to offer first.
  default_organisation_id uuid REFERENCES public.builder_organisations(id) ON DELETE SET NULL,
  landing_page text NOT NULL DEFAULT 'dashboard'
    CHECK (landing_page IN ('dashboard','projects','inventory','transactions',
                            'construction','documents','messages','tasks')),
  timezone text NOT NULL DEFAULT 'Australia/Sydney',
  date_format text NOT NULL DEFAULT 'DD/MM/YYYY'
    CHECK (date_format IN ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD')),
  email_digest text NOT NULL DEFAULT 'daily'
    CHECK (email_digest IN ('off','daily','weekly')),
  notify_task_assigned boolean NOT NULL DEFAULT true,
  notify_message_posted boolean NOT NULL DEFAULT true,
  notify_status_change boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.builder_user_preferences IS
  'One Builder user''s own display and notification preferences. default_organisation_id is a preference, never a grant — the session still resolves membership.';

-- ===========================================================================
-- 3. The activity boundary
-- ===========================================================================

-- Entity types a portal user may EVER be shown. Identity and administration —
-- organisation, portal_user, membership, membership_permissions, session,
-- project_access, development — are deliberately absent, so a row of that kind
-- is invisible no matter who asks.
CREATE OR REPLACE FUNCTION public.builder_activity_entity_is_portal_visible(_entity_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT _entity_type IN (
    'project', 'project_party',
    'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
    'reservation', 'allocation',
    'transaction', 'transaction_party',
    'construction_case', 'construction_stage', 'milestone',
    'progress_update', 'photograph',
    'variation', 'variation_approval', 'progress_claim',
    'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim',
    'document', 'document_version', 'conversation', 'message',
    'task', 'task_assignment');
$$;

/**
 * Can this user see that something happened to this record?
 *
 * Every branch resolves the row back to the aggregate that GOVERNS it and asks
 * the resolver that already decides the record itself. There is no shortcut on
 * organisation: a user in the organisation who cannot open a project cannot
 * read that the project changed.
 *
 * An entity type outside the visible list, or an id that no longer resolves to
 * a live parent, returns false.
 */
CREATE OR REPLACE FUNCTION public.builder_can_see_activity(
  _user_id uuid, _entity_type text, _entity_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF _entity_type IS NULL OR _entity_id IS NULL THEN RETURN false; END IF;
  IF NOT public.builder_activity_entity_is_portal_visible(_entity_type) THEN
    RETURN false;
  END IF;

  -- ── Project scope ────────────────────────────────────────────────────────
  IF _entity_type = 'project' THEN
    RETURN public.builder_resolve_project_permission(_user_id, _entity_id, 'projects', 'view');
  ELSIF _entity_type = 'project_party' THEN
    SELECT project_id INTO v_parent FROM public.builder_project_parties WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_project_permission(_user_id, v_parent, 'projects', 'view');
  ELSIF _entity_type = 'stage' THEN
    SELECT project_id INTO v_parent FROM public.builder_stages WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_project_permission(_user_id, v_parent, 'inventory', 'view');
  ELSIF _entity_type = 'building' THEN
    SELECT project_id INTO v_parent FROM public.builder_buildings WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_project_permission(_user_id, v_parent, 'inventory', 'view');
  ELSIF _entity_type = 'lot' THEN
    SELECT project_id INTO v_parent FROM public.builder_lots WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_project_permission(_user_id, v_parent, 'inventory', 'view');

  -- ── Unit scope ───────────────────────────────────────────────────────────
  ELSIF _entity_type = 'unit' THEN
    RETURN public.builder_resolve_unit_permission(_user_id, _entity_id, 'inventory', 'view');
  ELSIF _entity_type = 'unit_price' THEN
    SELECT unit_id INTO v_parent FROM public.builder_unit_pricing WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_unit_permission(_user_id, v_parent, 'pricing', 'view');
  ELSIF _entity_type = 'unit_hold' THEN
    SELECT unit_id INTO v_parent FROM public.builder_unit_holds WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_unit_permission(_user_id, v_parent, 'inventory', 'view');
  ELSIF _entity_type = 'reservation' THEN
    SELECT unit_id INTO v_parent FROM public.builder_reservations WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_unit_permission(_user_id, v_parent, 'reservations', 'view');
  ELSIF _entity_type = 'allocation' THEN
    SELECT unit_id INTO v_parent FROM public.builder_allocations WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_unit_permission(_user_id, v_parent, 'inventory', 'view');

  -- ── Transaction scope ────────────────────────────────────────────────────
  ELSIF _entity_type = 'transaction' THEN
    RETURN public.builder_resolve_transaction_permission(
             _user_id, _entity_id, 'transactions', 'view');
  ELSIF _entity_type = 'transaction_party' THEN
    SELECT transaction_id INTO v_parent
    FROM public.builder_transaction_parties WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_resolve_transaction_permission(
             _user_id, v_parent, 'transactions', 'view');

  -- ── Construction scope ───────────────────────────────────────────────────
  ELSIF _entity_type = 'construction_case' THEN
    RETURN public.builder_resolve_construction_permission(
             _user_id, _entity_id, 'construction', 'view');
  ELSIF _entity_type = 'construction_stage' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_construction_stages WHERE id = _entity_id;
  ELSIF _entity_type = 'milestone' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_construction_milestones WHERE id = _entity_id;
  ELSIF _entity_type = 'progress_update' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_construction_progress_updates WHERE id = _entity_id;
  ELSIF _entity_type = 'photograph' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_construction_photographs WHERE id = _entity_id;
  ELSIF _entity_type = 'variation' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_variations WHERE id = _entity_id;
  ELSIF _entity_type = 'variation_approval' THEN
    SELECT v.construction_case_id INTO v_parent
    FROM public.builder_variation_approvals a
    JOIN public.builder_variations v ON v.id = a.variation_id WHERE a.id = _entity_id;
  ELSIF _entity_type = 'progress_claim' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_progress_claims WHERE id = _entity_id;
  ELSIF _entity_type = 'inspection' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_inspections WHERE id = _entity_id;
  ELSIF _entity_type = 'defect' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_defects WHERE id = _entity_id;
  ELSIF _entity_type = 'practical_completion' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_practical_completions WHERE id = _entity_id;
  ELSIF _entity_type = 'handover' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_handovers WHERE id = _entity_id;
  ELSIF _entity_type = 'warranty_claim' THEN
    SELECT construction_case_id INTO v_parent
    FROM public.builder_warranty_claims WHERE id = _entity_id;

  -- ── Collaboration scope ──────────────────────────────────────────────────
  ELSIF _entity_type = 'document' THEN
    RETURN public.builder_can_see_document(_user_id, _entity_id, 'view');
  ELSIF _entity_type = 'document_version' THEN
    SELECT document_id INTO v_parent
    FROM public.builder_document_versions WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_can_see_document(_user_id, v_parent, 'view');
  ELSIF _entity_type = 'conversation' THEN
    RETURN public.builder_can_see_conversation(_user_id, _entity_id, 'view');
  ELSIF _entity_type = 'message' THEN
    SELECT conversation_id INTO v_parent FROM public.builder_messages WHERE id = _entity_id;
    RETURN v_parent IS NOT NULL
       AND public.builder_can_see_conversation(_user_id, v_parent, 'view');
  ELSIF _entity_type = 'task' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.builder_tasks t WHERE t.id = _entity_id
        AND public.builder_resolve_scope_permission(
              _user_id, t.scope_type, t.scope_id, 'tasks', 'view'));
  ELSIF _entity_type = 'task_assignment' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.builder_task_assignments a
      JOIN public.builder_tasks t ON t.id = a.task_id
      WHERE a.id = _entity_id
        AND public.builder_resolve_scope_permission(
              _user_id, t.scope_type, t.scope_id, 'tasks', 'view'));
  ELSE
    RETURN false;
  END IF;

  -- Every construction child falls through to here with its case in v_parent.
  RETURN v_parent IS NOT NULL
     AND public.builder_resolve_construction_permission(
           _user_id, v_parent, 'construction', 'view');
END $$;

/**
 * The portal activity feed.
 *
 * Narrowed to the caller's active organisation, then to entity types the portal
 * may show, then row by row through `builder_can_see_activity`. The projection
 * omits previous_state, new_state, ip_address and user_agent: a Builder user is
 * shown what changed, not the Command Centre's forensic record.
 */
CREATE OR REPLACE FUNCTION public.builder_visible_activity(
  _user_id uuid, _organisation_id uuid,
  _entity_type text DEFAULT NULL, _entity_id uuid DEFAULT NULL, _limit integer DEFAULT 100)
RETURNS TABLE (
  id uuid, action text, entity_type text, entity_id uuid,
  actor_type text, reason text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.action, l.entity_type, l.entity_id, l.actor_type, l.reason, l.created_at
  FROM public.builder_portal_activity_log l
  WHERE l.organisation_id = _organisation_id
    AND (_entity_type IS NULL OR l.entity_type = _entity_type)
    AND (_entity_id IS NULL OR l.entity_id = _entity_id)
    AND public.builder_can_see_activity(_user_id, l.entity_type, l.entity_id)
  ORDER BY l.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 100), 1), 200);
$$;

-- ===========================================================================
-- 4. Dashboard summary
-- ===========================================================================
/**
 * One cross-module summary for the portal landing page.
 *
 * Every count is built from an accessible-set function, so a project, unit,
 * transaction, build, document, conversation or task the caller cannot reach is
 * not counted. A number here can never reveal a record the caller cannot open.
 */
CREATE OR REPLACE FUNCTION public.builder_workspace_summary(
  _user_id uuid, _organisation_id uuid)
RETURNS TABLE (
  projects bigint, units bigint, transactions bigint, construction_cases bigint,
  open_defects bigint, documents bigint, open_conversations bigint,
  open_tasks bigint, overdue_tasks bigint,
  unread_messages bigint, unread_notifications bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (SELECT project_id FROM public.builder_accessible_projects(
               _user_id, _organisation_id, 'projects')),
       u AS (SELECT unit_id FROM public.builder_accessible_units(
               _user_id, _organisation_id, 'inventory')),
       t AS (SELECT transaction_id FROM public.builder_accessible_transactions(
               _user_id, _organisation_id, 'transactions')),
       c AS (SELECT construction_case_id FROM public.builder_accessible_construction_cases(
               _user_id, _organisation_id, 'construction')),
       d AS (SELECT document_id FROM public.builder_accessible_documents(_user_id)),
       v AS (SELECT conversation_id FROM public.builder_accessible_conversations(_user_id)),
       k AS (SELECT task_id FROM public.builder_accessible_tasks(_user_id)),
       n AS (SELECT * FROM public.builder_unread_counts(_user_id))
  SELECT
    (SELECT count(*) FROM p),
    (SELECT count(*) FROM u),
    (SELECT count(*) FROM t),
    (SELECT count(*) FROM c),
    (SELECT count(*) FROM public.builder_defects x
     WHERE x.construction_case_id IN (SELECT construction_case_id FROM c)
       AND x.status NOT IN ('closed','rejected','verified')),
    (SELECT count(*) FROM d),
    (SELECT count(*) FROM public.builder_conversations x
     WHERE x.id IN (SELECT conversation_id FROM v) AND x.status = 'open'),
    (SELECT count(*) FROM public.builder_tasks x
     WHERE x.id IN (SELECT task_id FROM k) AND x.status NOT IN ('done','cancelled')),
    (SELECT count(*) FROM public.builder_tasks x
     WHERE x.id IN (SELECT task_id FROM k) AND x.status NOT IN ('done','cancelled')
       AND x.due_date IS NOT NULL AND x.due_date < CURRENT_DATE),
    (SELECT unread_messages FROM n),
    (SELECT unread_notifications FROM n);
$$;

-- ===========================================================================
-- 5. Guarded commands — write and trusted audit in ONE transaction
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.builder_upsert_organisation_settings(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _organisation_id uuid, _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_organisation_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_organisation_settings;
        v_row public.builder_organisation_settings;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.builder_organisations WHERE id = _organisation_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ORGANISATION_NOT_FOUND';
  END IF;

  SELECT * INTO v_existing FROM public.builder_organisation_settings
  WHERE organisation_id = _organisation_id FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_organisation_settings SET
      display_name = CASE WHEN _payload ? 'display_name'
        THEN _payload->>'display_name' ELSE display_name END,
      primary_contact_name = CASE WHEN _payload ? 'primary_contact_name'
        THEN _payload->>'primary_contact_name' ELSE primary_contact_name END,
      primary_contact_email = CASE WHEN _payload ? 'primary_contact_email'
        THEN NULLIF(_payload->>'primary_contact_email','') ELSE primary_contact_email END,
      primary_contact_phone = CASE WHEN _payload ? 'primary_contact_phone'
        THEN _payload->>'primary_contact_phone' ELSE primary_contact_phone END,
      timezone = CASE WHEN _payload ? 'timezone'
        THEN COALESCE(NULLIF(_payload->>'timezone',''), timezone) ELSE timezone END,
      default_landing_page = CASE WHEN _payload ? 'default_landing_page'
        THEN _payload->>'default_landing_page' ELSE default_landing_page END,
      notify_on_defect = CASE WHEN _payload ? 'notify_on_defect'
        THEN (_payload->>'notify_on_defect')::boolean ELSE notify_on_defect END,
      notify_on_inspection = CASE WHEN _payload ? 'notify_on_inspection'
        THEN (_payload->>'notify_on_inspection')::boolean ELSE notify_on_inspection END,
      notify_on_variation = CASE WHEN _payload ? 'notify_on_variation'
        THEN (_payload->>'notify_on_variation')::boolean ELSE notify_on_variation END,
      notify_on_message = CASE WHEN _payload ? 'notify_on_message'
        THEN (_payload->>'notify_on_message')::boolean ELSE notify_on_message END,
      notify_on_task = CASE WHEN _payload ? 'notify_on_task'
        THEN (_payload->>'notify_on_task')::boolean ELSE notify_on_task END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.builder_organisation_settings(organisation_id, display_name,
      primary_contact_name, primary_contact_email, primary_contact_phone, timezone,
      default_landing_page)
    VALUES (_organisation_id, _payload->>'display_name', _payload->>'primary_contact_name',
      NULLIF(_payload->>'primary_contact_email',''), _payload->>'primary_contact_phone',
      COALESCE(NULLIF(_payload->>'timezone',''), 'Australia/Sydney'),
      COALESCE(NULLIF(_payload->>'default_landing_page',''), 'dashboard'))
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_organisation_settings_saved',
    'organisation_settings', v_row.id, _organisation_id, _actor_builder_user_id,
    CASE WHEN v_existing.id IS NULL THEN NULL
         ELSE jsonb_build_object('timezone', v_existing.timezone,
                                 'default_landing_page', v_existing.default_landing_page) END,
    jsonb_build_object('timezone', v_row.timezone,
                       'default_landing_page', v_row.default_landing_page,
                       'row_version', v_row.row_version),
    _reason, '{}'::jsonb);
  RETURN v_row;
END $$;

/**
 * Save one user's own preferences.
 *
 * `default_organisation_id` is validated against a LIVE active membership. A
 * preference cannot name an organisation the user is not in, so it can never
 * become a back door into one.
 */
CREATE OR REPLACE FUNCTION public.builder_upsert_user_preferences(
  _actor_user_id uuid, _actor_type text, _actor_builder_user_id uuid,
  _payload jsonb DEFAULT '{}'::jsonb,
  _expected_version bigint DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.builder_user_preferences
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.builder_user_preferences; v_row public.builder_user_preferences;
        v_default_org uuid;
BEGIN
  IF _actor_builder_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PREFERENCE_OWNER_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_portal_users WHERE id = _actor_builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;

  IF _payload ? 'default_organisation_id' THEN
    v_default_org := NULLIF(_payload->>'default_organisation_id','')::uuid;
    IF v_default_org IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.builder_active_membership(
                         _actor_builder_user_id, v_default_org)) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_NOT_A_MEMBER';
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.builder_user_preferences
  WHERE builder_user_id = _actor_builder_user_id FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF _expected_version IS NULL OR v_existing.row_version <> _expected_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STALE_WRITE',
        DETAIL = format('current_version=%s', v_existing.row_version);
    END IF;
    UPDATE public.builder_user_preferences SET
      default_organisation_id = CASE WHEN _payload ? 'default_organisation_id'
        THEN v_default_org ELSE default_organisation_id END,
      landing_page = CASE WHEN _payload ? 'landing_page'
        THEN _payload->>'landing_page' ELSE landing_page END,
      timezone = CASE WHEN _payload ? 'timezone'
        THEN COALESCE(NULLIF(_payload->>'timezone',''), timezone) ELSE timezone END,
      date_format = CASE WHEN _payload ? 'date_format'
        THEN _payload->>'date_format' ELSE date_format END,
      email_digest = CASE WHEN _payload ? 'email_digest'
        THEN _payload->>'email_digest' ELSE email_digest END,
      notify_task_assigned = CASE WHEN _payload ? 'notify_task_assigned'
        THEN (_payload->>'notify_task_assigned')::boolean ELSE notify_task_assigned END,
      notify_message_posted = CASE WHEN _payload ? 'notify_message_posted'
        THEN (_payload->>'notify_message_posted')::boolean ELSE notify_message_posted END,
      notify_status_change = CASE WHEN _payload ? 'notify_status_change'
        THEN (_payload->>'notify_status_change')::boolean ELSE notify_status_change END
    WHERE id = v_existing.id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.builder_user_preferences(builder_user_id, default_organisation_id,
      landing_page, timezone, date_format, email_digest)
    VALUES (_actor_builder_user_id, v_default_org,
      COALESCE(NULLIF(_payload->>'landing_page',''), 'dashboard'),
      COALESCE(NULLIF(_payload->>'timezone',''), 'Australia/Sydney'),
      COALESCE(NULLIF(_payload->>'date_format',''), 'DD/MM/YYYY'),
      COALESCE(NULLIF(_payload->>'email_digest',''), 'daily'))
    RETURNING * INTO v_row;
  END IF;

  PERFORM public.builder_log_activity(
    _actor_user_id, _actor_type, 'builder_user_preferences_saved',
    'user_preferences', v_row.id, v_row.default_organisation_id, _actor_builder_user_id,
    CASE WHEN v_existing.id IS NULL THEN NULL
         ELSE jsonb_build_object('landing_page', v_existing.landing_page) END,
    jsonb_build_object('landing_page', v_row.landing_page,
                       'email_digest', v_row.email_digest,
                       'row_version', v_row.row_version),
    _reason, '{}'::jsonb);
  RETURN v_row;
END $$;

-- ===========================================================================
-- 6. Activity log entity types
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
     'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim',
     'document', 'document_version', 'document_grant',
     'conversation', 'message', 'task', 'task_assignment', 'notification',
     'organisation_settings', 'user_preferences'));

-- ===========================================================================
-- 7. Touch triggers
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_organisation_settings','builder_user_preferences'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.builder_touch_row()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 8. RLS and grants — deny by default
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_organisation_settings','builder_user_preferences'] LOOP
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
    ('builder_activity_entity_is_portal_visible','text'),
    ('builder_can_see_activity','uuid, text, uuid'),
    ('builder_visible_activity','uuid, uuid, text, uuid, integer'),
    ('builder_workspace_summary','uuid, uuid'),
    ('builder_upsert_organisation_settings','uuid, text, uuid, uuid, jsonb, bigint, text'),
    ('builder_upsert_user_preferences','uuid, text, uuid, jsonb, bigint, text')
  ) AS t(f, a) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', f, a);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', f, a);
  END LOOP;
END $$;

-- ===========================================================================
-- 9. Post-migration assertions
-- ===========================================================================
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY[
    'builder_activity_entity_is_portal_visible','builder_can_see_activity',
    'builder_visible_activity','builder_workspace_summary',
    'builder_upsert_organisation_settings','builder_upsert_user_preferences']) AS f
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname = f);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: workspace function(s) missing: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('builder_organisation_settings','builder_user_preferences')
    AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: RLS not enabled on: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_organisation_settings','builder_user_preferences']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='row_version');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: touch-triggered table(s) without row_version: %', v_missing;
  END IF;

  -- The activity feed must not carry the Command Centre's forensic fields.
  SELECT string_agg(a.attname, ', ') INTO v_missing
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a(attname, ord)
  WHERE n.nspname='public' AND p.proname='builder_visible_activity'
    AND a.attname IN ('previous_state','new_state','ip_address','user_agent');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: the portal activity feed exposes forensic field(s): %', v_missing;
  END IF;

  -- Identity and administration are outside the portal-visible entity list.
  SELECT string_agg(e, ', ') INTO v_missing
  FROM unnest(ARRAY['organisation','portal_user','membership','membership_permissions',
                    'session','project_access','development','document_grant',
                    'transaction_case_link','notification']) AS e
  WHERE public.builder_activity_entity_is_portal_visible(e);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: administrative entity type(s) are portal-visible: %', v_missing;
  END IF;

  -- No settings table may carry money, a client financial position, an AML
  -- determination or a privileged legal field.
  SELECT string_agg(table_name||'.'||column_name, ', ') INTO v_missing
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('builder_organisation_settings','builder_user_preferences')
    AND (column_name LIKE '%amount%' OR column_name LIKE '%price%' OR column_name LIKE '%cost%'
         OR column_name LIKE '%income%' OR column_name LIKE '%borrowing%'
         OR column_name LIKE '%aml%' OR column_name LIKE '%privileg%'
         OR column_name LIKE '%commission%' OR column_name LIKE '%password%'
         OR column_name LIKE '%secret%' OR column_name LIKE '%token%');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: a settings table carries restricted data: %', v_missing;
  END IF;

  RAISE NOTICE 'builder workspace: dashboard summary, activity feed, organisation settings and user preferences installed';
END $$;
