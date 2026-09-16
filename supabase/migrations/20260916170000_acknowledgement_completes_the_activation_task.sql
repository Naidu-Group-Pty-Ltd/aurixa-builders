-- ============================================================================
-- Acknowledging an activation completes the task that asked for it.
--
-- The fan-out's pending task says, in its own words, "acknowledge the
-- activation so the agency knows you have it". The first live activation
-- proved the loop and left that task OPEN after the acknowledgement — the
-- instruction satisfied, the checklist still red. Same transactional command,
-- one more effect: the acknowledgement stamps the announcement, queues the
-- outbound event, logs the activity AND closes its own task, so the Tasks
-- page tells the truth without anyone tidying after it. A task somebody
-- already finished or cancelled themselves is left exactly as they left it.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.builder_stock_acknowledge_announcement(
  _announcement_id uuid, _organisation_id uuid, _builder_user_id uuid)
RETURNS SETOF public.builder_stock_selection_announcements
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_row public.builder_stock_selection_announcements;
  v_version bigint;
BEGIN
  -- One winner, organisation-scoped: a forged id from another organisation
  -- matches no row and reads as not-found, never forbidden.
  UPDATE public.builder_stock_selection_announcements a
     SET status = 'builder_acknowledged',
         acknowledged_at = now(),
         acknowledged_by_builder_user_id = _builder_user_id
   WHERE a.id = _announcement_id
     AND a.organisation_id = _organisation_id
     AND a.status = 'selected'
  RETURNING a.* INTO v_row;

  IF v_row.id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.builder_stock_selection_announcements a
      WHERE a.id = _announcement_id AND a.organisation_id = _organisation_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE';
    END IF;
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_ANNOUNCEMENT_NOT_FOUND';
  END IF;

  -- The outbound version is the connection's outbound stamp counter — one
  -- monotonic series per connection, bumped with the write it describes.
  INSERT INTO public.builder_network_stamps(connection_id, side, stamp, source_version)
  VALUES (v_row.connection_id, 'outbound',
          jsonb_build_object('count', 1, 'latest', to_jsonb(now()),
                             'pendingRequests', 0, 'attention', 0),
          1)
  ON CONFLICT (connection_id, side) DO UPDATE
    SET source_version = public.builder_network_stamps.source_version + 1,
        stamp = EXCLUDED.stamp,
        updated_at = now()
  RETURNING source_version INTO v_version;

  -- Idempotent by construction: the acknowledgement of one selection ref is
  -- one fact, so its dedupe_key is derived, and a retry lands ON CONFLICT.
  -- Composed to the privacy contract's vocabulary — the worker re-gates
  -- before the wire.
  INSERT INTO public.builder_network_outbox(
    connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (
    v_row.connection_id,
    'stock.selection.acknowledged',
    'stock.selection.acknowledged:' || v_row.connection_id || ':' || v_row.remote_selection_ref,
    jsonb_build_object(
      'remote_selection_ref', v_row.remote_selection_ref,
      'stock_item_id', v_row.stock_item_id,
      'status', 'builder_acknowledged',
      'acknowledged_at', v_row.acknowledged_at),
    v_version)
  ON CONFLICT (dedupe_key) DO NOTHING;

  -- THE TASK THE FAN-OUT OPENED CLOSES WITH THE ACT IT ASKED FOR. Only a
  -- still-pending task moves: one somebody finished or cancelled themselves
  -- keeps their answer, and an announcement fanned out before this shipped
  -- (or with its task deleted) has nothing to close and nothing to invent.
  UPDATE public.builder_tasks t
     SET status = 'done',
         completed_at = COALESCE(t.completed_at, now())
   WHERE t.id = v_row.activation_task_id
     AND t.status IN ('open', 'in_progress', 'blocked');

  -- The activity entry rides the same transaction: an acknowledgement that
  -- rolled back logs nothing.
  PERFORM public.builder_log_activity(
    _builder_user_id, 'builder_user', 'builder_stock_selection_acknowledged',
    'stock_selection', v_row.id, _organisation_id, _builder_user_id,
    NULL,
    jsonb_build_object('remote_selection_ref', v_row.remote_selection_ref,
                       'connection_id', v_row.connection_id,
                       'activation_task_id', v_row.activation_task_id),
    NULL, '{}'::jsonb);

  RETURN NEXT v_row;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_acknowledge_announcement(uuid, uuid, uuid)
  TO service_role;

DO $$
BEGIN
  IF position('activation_task_id' IN
    pg_get_functiondef('public.builder_stock_acknowledge_announcement(uuid,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POST-MIGRATION FAILURE: acknowledging does not close its task';
  END IF;
  RAISE NOTICE 'acknowledgement completes the activation task';
END $$;
