-- Builder / Developer Portal — guided onboarding tour state.
--
-- The Solicitor, Client and Finance portal tours all cache their completion in
-- localStorage. The Builder Portal deliberately persists NOTHING in the browser
-- — `scripts/builder-portal/security-check.mjs` fails the build if any Builder
-- browser source touches localStorage, sessionStorage or document.cookie, and
-- `tests-e2e/builder-portal/*.e2e.ts` assert the same for every domain surface.
--
-- Rather than weaken that control for a cosmetic flag, tour completion lives
-- where the Builder Portal already keeps per-user UI state: builder_user_preferences,
-- alongside landing_page, timezone, date_format and the notification flags.
-- This is a deliberate improvement on the Solicitor construction, not a
-- divergence in the tour itself.
--
-- Purely additive: one nullable column and one new command.

ALTER TABLE public.builder_user_preferences
  ADD COLUMN IF NOT EXISTS tour_completed_at timestamptz;

COMMENT ON COLUMN public.builder_user_preferences.tour_completed_at IS
  'When this user finished or skipped the guided onboarding tour. NULL means the tour is still due. Server-stamped; never supplied by the browser.';

-- ===========================================================================
-- Completion command
--
-- Deliberately NOT routed through builder_upsert_user_preferences:
--
--   * That command requires expected_version. Finishing the tour must not 409
--     because the user happens to have the settings form open in another tab.
--   * The write is idempotent and monotonic — completion is stamped once and
--     never moves — so there is nothing for optimistic concurrency to protect.
--   * It writes exactly one field and cannot be used to change any other
--     preference, so it is a smaller authority than the general upsert.
--
-- The owner is always the caller's session user. No id is taken from the body,
-- so a request naming someone else reaches nothing.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_complete_onboarding_tour(
  _builder_user_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_completed timestamptz;
BEGIN
  IF _builder_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_PREFERENCE_OWNER_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_portal_users WHERE id = _builder_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_USER_NOT_FOUND';
  END IF;

  INSERT INTO public.builder_user_preferences(builder_user_id, tour_completed_at)
  VALUES (_builder_user_id, now())
  ON CONFLICT (builder_user_id) DO UPDATE
    -- Monotonic: a replay from settings clears the flag client-side and
    -- re-completing restamps it, but an already-completed tour is never
    -- silently backdated by a concurrent call.
    SET tour_completed_at = COALESCE(public.builder_user_preferences.tour_completed_at, now())
  RETURNING tour_completed_at INTO v_completed;

  RETURN v_completed;
END $$;

COMMENT ON FUNCTION public.builder_complete_onboarding_tour(uuid) IS
  'Stamps guided-tour completion for one Builder user. Idempotent, single-field and version-free, so it can never collide with the preferences form.';

REVOKE ALL ON FUNCTION public.builder_complete_onboarding_tour(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_complete_onboarding_tour(uuid) TO service_role;

-- ===========================================================================
-- Post-migration assertions
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='builder_user_preferences'
      AND column_name='tour_completed_at' AND is_nullable='YES')
  THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: tour_completed_at is absent or not nullable';
  END IF;

  -- The tour flag must never become a precondition for using the portal.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='builder_user_preferences'
      AND column_name='tour_completed_at' AND column_default IS NOT NULL)
  THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: tour_completed_at must default to NULL';
  END IF;

  RAISE NOTICE 'builder onboarding tour state installed';
END $$;
