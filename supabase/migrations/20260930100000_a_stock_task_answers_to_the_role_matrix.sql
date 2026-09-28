/*
 * A TASK ON A STOCK ITEM ANSWERS TO THE ROLE MATRIX, LIKE EVERY OTHER TASK.
 *
 * MEASURED IN PRODUCTION, 28 SEPTEMBER 2026, by the portal UI audit
 * (`scripts/ops/portal-ui-audit.mjs`): a READ-ONLY colleague created a task on
 * one of the organisation's stock items and was answered HTTP 200.
 *
 * `20260916150000` gave the stock-item scope a resolver of its own because a
 * stock item has no project to walk up to, and it answered the question it was
 * written for — is the caller an active member of the item's organisation —
 * without asking the one every other scope asks: what does their ROLE allow?
 * The project, unit, transaction and construction-case resolvers all reach
 * `builder_resolve_permission`, which denies forbidden and unknown keys,
 * requires an active membership, applies the role default and the membership's
 * own organisation-scope overrides, and clamps read_only to view. On a stock
 * item every member could view AND edit tasks: read_only's clamp and an
 * explicit per-member deny were both skipped.
 *
 * The resolver now asks `builder_resolve_permission` for the item's own
 * organisation. What it answers for is unchanged — tasks, view and edit, and
 * nothing else on a stock scope, and never a NULL level (which the old body
 * refused and the matrix would read as `delete`) — and so is its active-user
 * check. Production's
 * role defaults give tasks view and edit to owner, administrator, manager and
 * member, and view alone to read_only, so the only default that changes is
 * read_only's edit. Proved by `scripts/db/stock-task-permission-check.mjs`
 * (11 of 13 before, 14 of 14 after).
 *
 * The old resolver's own membership join stays in front of the matrix.
 * `builder_resolve_permission` asks for an active membership anyway, so it
 * decides nothing new. What it does is stop the matrix being consulted for
 * another organisation's task: `builder_accessible_tasks` asks about every
 * task in the network, and "My tasks" over 5,000 stock-item tasks in 20
 * organisations took 864 ms with the matrix asked first and 153 ms with the
 * membership asked first (found by the independent re-review).
 */
CREATE OR REPLACE FUNCTION public.builder_resolve_stock_item_permission(
  _user_id uuid, _item_id uuid, _permission_key text DEFAULT 'tasks', _level text DEFAULT 'view')
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  -- CASE, because it is the one construct that fixes evaluation order: in a
  -- WHERE clause the planner attaches the matrix call to the item scan and
  -- asks it before the membership join can rule the row out.
  SELECT CASE
    WHEN _permission_key IS DISTINCT FROM 'tasks' OR _level IS NULL OR _level NOT IN ('view', 'edit') THEN false
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.builder_stock_items i
      JOIN public.builder_organisation_memberships m
        ON m.organisation_id = i.organisation_id
       AND m.builder_user_id = _user_id
       AND m.status = 'active' AND m.revoked_at IS NULL
      JOIN public.builder_portal_users u ON u.id = _user_id
      WHERE i.id = _item_id
        AND u.is_active = true) THEN false
    ELSE coalesce(public.builder_resolve_permission(
      _user_id, (SELECT i.organisation_id FROM public.builder_stock_items i WHERE i.id = _item_id),
      'tasks', _level), false)
  END;
$fn$;

REVOKE ALL ON FUNCTION public.builder_resolve_stock_item_permission(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_resolve_stock_item_permission(uuid, uuid, text, text)
  TO service_role;
