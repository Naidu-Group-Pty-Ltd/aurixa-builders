-- Register the internal Builder / Developer Portal administration module.
--
-- Phase 0 finding NOCOPY-03 / MIG-10: `solicitor_portal_admin` is used by
-- ModuleGuard, three navigation surfaces and three Edge Functions, but no
-- migration inserts it into dashboard_modules. Inspection of the production
-- database through the Supabase MCP connection confirmed the row exists there,
-- so this is migration-corpus drift rather than a missing permission: a fresh
-- environment rebuilt from migrations would not have it.
--
-- This migration registers builder_portal_admin correctly from the outset and
-- repairs the solicitor_portal_admin drift. Both inserts are idempotent, so on
-- production they are no-ops for solicitor_portal_admin and a single new row for
-- builder_portal_admin.

INSERT INTO public.dashboard_modules
  (module_key, module_name, description, category, icon, route, sort_order, is_active)
VALUES
  ('builder_portal_admin',
   'Builder / Developer Portal',
   'Administer builder and developer organisations, portal users and memberships',
   'admin', 'HardHat', '/admin/builder-portal', 122, true)
ON CONFLICT (module_key) DO NOTHING;

-- Drift repair. Safe and directly related: the key is already in active use by
-- ModuleGuard and by solicitor-portal-admin, solicitor-portal-invite and
-- legal-matters-admin. ON CONFLICT DO NOTHING means an environment that already
-- has the row keeps its existing description, ordering and grants untouched.
INSERT INTO public.dashboard_modules
  (module_key, module_name, description, category, icon, route, sort_order, is_active)
VALUES
  ('solicitor_portal_admin',
   'Solicitor Portal',
   'Administer legal practices, solicitor portal users and matter access',
   'admin', 'Scale', '/admin/solicitor-portal', 121, true)
ON CONFLICT (module_key) DO NOTHING;

-- Assert the two keys THIS migration is responsible for. A module key referenced
-- by a route guard but absent from this table denies every non-superadmin user,
-- silently, so the insert must be proven rather than assumed.
--
-- Deliberately scoped to builder_portal_admin and solicitor_portal_admin.
-- Asserting finance_portal_admin here would make this migration fail for a
-- condition it neither creates nor can repair, blocking a Builder deployment
-- for an unrelated gap.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(k, ', ') INTO v_missing
  FROM unnest(ARRAY['builder_portal_admin','solicitor_portal_admin']) AS k
  WHERE NOT EXISTS (SELECT 1 FROM public.dashboard_modules m WHERE m.module_key = k);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: portal administration module(s) not registered: %', v_missing;
  END IF;

  -- finance_portal_admin is registered by 20260417193830 and is reported, not
  -- asserted, so its absence is visible without being fatal here.
  IF NOT EXISTS (SELECT 1 FROM public.dashboard_modules WHERE module_key = 'finance_portal_admin') THEN
    RAISE WARNING 'finance_portal_admin is not registered in dashboard_modules (owned by 20260417193830)';
  END IF;

  RAISE NOTICE 'portal administration modules registered: builder, solicitor';
END $$;

COMMENT ON TABLE public.dashboard_modules IS
  'Internal Command Centre module registry. Every moduleKey referenced by a ModuleGuard route or by requireModulePermission must have a row here, or the guard denies every non-superadmin user.';
