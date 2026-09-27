-- ============================================================================
-- A permission matrix in one round trip.
--
-- WHY. The portal's audit (26 Sep 2026, portal-access-proof) measured every
-- project-scoped request at ~10 s and every session restore at ~9 s: the edge
-- functions asked the database about each of 21 permission keys, three levels
-- each, one request at a time. Asking them concurrently (#127) halved it; the
-- remainder is the round trips themselves.
--
-- WHAT. Two read-only functions that answer the WHOLE matrix in one call by
-- calling the existing resolvers — `builder_resolve_permission` and
-- `builder_resolve_project_permission` — once per (key, level). They decide
-- nothing themselves, so their answers are those resolvers' answers by
-- construction; no policy moves. Keys are passed in by the caller, exactly as
-- the caller asked them before.
--
-- COMPATIBILITY. Additive: nothing is altered or dropped. The edge code falls
-- back to the per-key path if these functions are absent or fail, so either
-- deploy order is safe.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.builder_resolve_permission_matrix(
  _user_id uuid, _org_id uuid, _keys text[])
RETURNS TABLE(permission_key text, can_view boolean, can_edit boolean, can_delete boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT k,
         COALESCE(public.builder_resolve_permission(_user_id, _org_id, k, 'view'), false),
         COALESCE(public.builder_resolve_permission(_user_id, _org_id, k, 'edit'), false),
         COALESCE(public.builder_resolve_permission(_user_id, _org_id, k, 'delete'), false)
    FROM unnest(_keys) AS k;
$$;

COMMENT ON FUNCTION public.builder_resolve_permission_matrix(uuid, uuid, text[]) IS
  'The organisation permission matrix in one call: builder_resolve_permission for every requested key at view, edit and delete. Decides nothing itself.';

CREATE OR REPLACE FUNCTION public.builder_resolve_project_permission_matrix(
  _user_id uuid, _project_id uuid, _keys text[])
RETURNS TABLE(permission_key text, can_view boolean, can_edit boolean, can_delete boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT k,
         COALESCE(public.builder_resolve_project_permission(_user_id, _project_id, k, 'view'), false),
         COALESCE(public.builder_resolve_project_permission(_user_id, _project_id, k, 'edit'), false),
         COALESCE(public.builder_resolve_project_permission(_user_id, _project_id, k, 'delete'), false)
    FROM unnest(_keys) AS k;
$$;

COMMENT ON FUNCTION public.builder_resolve_project_permission_matrix(uuid, uuid, text[]) IS
  'The project permission matrix in one call: builder_resolve_project_permission for every requested key at view, edit and delete. Decides nothing itself.';

REVOKE ALL ON FUNCTION public.builder_resolve_permission_matrix(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_resolve_permission_matrix(uuid, uuid, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.builder_resolve_project_permission_matrix(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_resolve_project_permission_matrix(uuid, uuid, text[]) TO service_role;
