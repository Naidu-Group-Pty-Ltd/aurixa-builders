-- ===========================================================================
-- THE ACTIVITY FEED NAMES WHO ACTED, AND LEADS WITH WHAT CHANGED.
-- ===========================================================================
--
-- `builder_visible_activity` selected `l.actor_type` and never joined the
-- person, so every row the portal drew said the literal "Portal user". The
-- name was never missing from the DATA — measured 2 October 2026,
-- `builder_user_id` is set on every `builder_user` row in the log (639
-- onboarding, 639 terms, 474 views, 304 uploads, 287 invites …) — it was
-- missing from the READ. One column, dropped in one function.
--
-- AND THE FEED WAS MOSTLY NOT A CHANGE. Per user, the visible feed is 25 rows
-- of `builder_project_viewed` and one row of anything else, so a page headed
-- "What has changed on the records you can reach" was a list of the times the
-- reader had looked. The caller passes which actions to leave out
-- (`builderActivitySignificance.pure.ts`), because a second copy of that list
-- living here is how the page and the feed come to disagree about what the
-- page is showing.
--
-- NOTHING IS DELETED and nothing is newly disclosed. The log keeps every row,
-- the Command Centre's forensic record is untouched, and the permission gate
-- is the same `builder_can_see_activity` call it always was — a reader who
-- could not see a row still cannot.
--
-- DROP AND CREATE, not CREATE OR REPLACE: the return type gains a column, and
-- Postgres refuses to replace a function whose OUT columns changed. The grants
-- are therefore restated exactly as the baseline left them.
--
-- DEPLOY ORDER. `_exclude_actions` is DEFAULTED, so a deployment still running
-- the previous edge function calls this with five named arguments and gets the
-- behaviour it had, plus the actor's name. The edge function may ship before
-- or after this migration: it asks for the filter and falls back to the five
-- argument call if the database has not been given it yet.

DROP FUNCTION IF EXISTS public.builder_visible_activity(uuid, uuid, text, uuid, integer);

CREATE FUNCTION public.builder_visible_activity(
  _user_id uuid,
  _organisation_id uuid,
  _entity_type text DEFAULT NULL::text,
  _entity_id uuid DEFAULT NULL::uuid,
  _limit integer DEFAULT 100,
  _exclude_actions text[] DEFAULT NULL::text[]
) RETURNS TABLE(
  id uuid, action text, entity_type text, entity_id uuid,
  actor_type text, actor_name text, reason text,
  created_at timestamp with time zone
)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT l.id, l.action, l.entity_type, l.entity_id, l.actor_type,
         -- The person, where the row records one. A row written by the
         -- platform joins to nothing and stays NULL, which is the honest
         -- answer and is what the reader renders as System.
         NULLIF(btrim(COALESCE(u.name, '')), '') AS actor_name,
         l.reason, l.created_at
  FROM public.builder_portal_activity_log l
  LEFT JOIN public.builder_portal_users u ON u.id = l.builder_user_id
  WHERE l.organisation_id = _organisation_id
    AND (_entity_type IS NULL OR l.entity_type = _entity_type)
    AND (_entity_id IS NULL OR l.entity_id = _entity_id)
    -- The filter narrows; it can never widen what the gate below permits.
    AND (_exclude_actions IS NULL OR NOT (l.action = ANY (_exclude_actions)))
    AND public.builder_can_see_activity(_user_id, l.entity_type, l.entity_id)
  ORDER BY l.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 100), 1), 200);
$$;

REVOKE ALL ON FUNCTION public.builder_visible_activity(
  uuid, uuid, text, uuid, integer, text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.builder_visible_activity(
  uuid, uuid, text, uuid, integer, text[]) TO service_role;
