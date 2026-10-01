-- ===========================================================================
-- A property is sent to the Command Centre once, in its latest state.
--
-- MEASURED, 1 October 2026. One stock list of 44 properties put 308
-- `stock.item.upserted` events on the outbox, about seven per property: every
-- image row that changes re-enqueues the item, and every enqueue composes the
-- WHOLE current item. The worker sends 25 events a minute, so the Command
-- Centre was still being sent superseded copies of properties eight minutes
-- after the list had gone live in the Builder Portal.
--
-- Each event carries the item's complete state at the moment it was composed,
-- and the Command Centre applies an item only where its `source_version` is at
-- least the one it holds (`builder_network_apply_inbound_events`). So an older
-- event still waiting behind a newer one for the same item can only ever be
-- overwritten. This migration stops sending it.
--
-- WHAT CHANGES.
--   1. `superseded` is a status: an event that was never sent because a newer
--      event for the same connection and item was queued. It is not `dead`
--      (nothing failed, and no alert should fire) and it is not `delivered`
--      (it was not).
--   2. `builder_network_enqueue_stock_item` marks the older WAITING events
--      for that connection and item `superseded` before it inserts the new
--      one. An event already claimed by a worker (`locked_at` within the
--      claim window) is left alone: it may be on the wire, and the new event
--      follows it anyway.
--   3. The events already queued are settled the same way, once.
--
-- WHAT DOES NOT CHANGE. The composed payload, the privacy contract, the
-- version sequence, the dedupe key, the no-route alert, and every other
-- event type (catalog reconciliation, selections, agency messages): only
-- `stock.item.upserted` is ever superseded, and only by another
-- `stock.item.upserted` for the same item on the same connection.
--
-- ROLLBACK. Restore the previous `builder_network_enqueue_stock_item` body
-- (20260921060000). `superseded` rows are inert: nothing claims them.
-- ===========================================================================
BEGIN;

ALTER TABLE public.builder_network_outbox
  DROP CONSTRAINT IF EXISTS builder_network_outbox_status_check;
ALTER TABLE public.builder_network_outbox
  ADD CONSTRAINT builder_network_outbox_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'delivered'::text, 'dead'::text, 'superseded'::text]));

-- Finding the waiting events of one item is a lookup per enqueue.
CREATE INDEX IF NOT EXISTS builder_network_outbox_pending_item_idx
  ON public.builder_network_outbox (connection_id, ((payload->>'id')))
  WHERE status = 'pending' AND event_type = 'stock.item.upserted';

CREATE OR REPLACE FUNCTION public.builder_network_enqueue_stock_item(_item_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conn record;
  v_payload jsonb;
  v_version bigint;
  v_count integer := 0;
  v_item record;
BEGIN
  v_payload := public.builder_network_compose_stock_item_payload(_item_id);
  IF v_payload IS NULL THEN RETURN 0; END IF;
  FOR v_conn IN
    SELECT c.id
    FROM public.workspace_connections c
    JOIN public.builder_stock_items i ON i.organisation_id = c.builder_organisation_id
    WHERE i.id = _item_id AND c.state = 'active'
  LOOP
    -- The waiting copies of this item can only be overwritten by the one
    -- below, so they are not sent. A claimed one may be in flight: left.
    UPDATE public.builder_network_outbox o
       SET status = 'superseded',
           last_error = 'superseded_by_newer_state'
     WHERE o.connection_id = v_conn.id
       AND o.status = 'pending'
       AND o.event_type = 'stock.item.upserted'
       AND o.payload->>'id' = _item_id::text
       AND (o.locked_at IS NULL OR o.locked_at < now() - interval '10 minutes');

    v_version := public.builder_network_next_outbound_version(v_conn.id);
    INSERT INTO public.builder_network_outbox(
      connection_id, event_type, dedupe_key, payload, source_version)
    VALUES (v_conn.id, 'stock.item.upserted',
            'stock.item:' || v_conn.id || ':' || _item_id || ':' || v_version,
            v_payload, v_version)
    ON CONFLICT (dedupe_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    SELECT i.organisation_id, i.lifecycle_status INTO v_item
    FROM public.builder_stock_items i WHERE i.id = _item_id;
    IF v_item.lifecycle_status = 'active' AND NOT EXISTS (
      SELECT 1 FROM public.portal_operational_events e
      WHERE e.event_name = 'builder_network_stock_has_no_route'
        AND e.metadata->>'builder_organisation_id' = v_item.organisation_id::text
        AND e.occurred_at > now() - interval '1 hour')
    THEN
      INSERT INTO public.portal_operational_events(
        event_name, severity, request_id, actor_type, portal, success, metadata)
      VALUES ('builder_network_stock_has_no_route', 'critical',
              _item_id::text, 'system', 'builder', false,
              jsonb_build_object(
                'builder_organisation_id', v_item.organisation_id,
                'stock_item_id', _item_id,
                'active_stock_count', (
                  SELECT count(*) FROM public.builder_stock_items x
                  WHERE x.organisation_id = v_item.organisation_id
                    AND x.lifecycle_status = 'active'),
                'reason', 'no_authorised_connection'));
    END IF;
  END IF;

  RETURN v_count;
END $function$;

REVOKE ALL ON FUNCTION public.builder_network_enqueue_stock_item(uuid) FROM PUBLIC, anon, authenticated;

-- The events already queued: keep the newest waiting event per connection
-- and item, supersede the rest. Claimed events are left alone.
WITH ranked AS (
  SELECT o.id,
         row_number() OVER (
           PARTITION BY o.connection_id, o.payload->>'id'
           ORDER BY o.source_version DESC, o.created_at DESC) AS rn
  FROM public.builder_network_outbox o
  WHERE o.status = 'pending'
    AND o.event_type = 'stock.item.upserted'
    AND (o.locked_at IS NULL OR o.locked_at < now() - interval '10 minutes')
)
UPDATE public.builder_network_outbox o
   SET status = 'superseded', last_error = 'superseded_by_newer_state'
  FROM ranked r
 WHERE o.id = r.id AND r.rn > 1;

-- Asserted by effect: an item enqueued twice leaves one waiting event.
DO $$
DECLARE
  v_conn uuid;
  v_item uuid;
  v_after integer;
BEGIN
  SELECT c.id, i.id INTO v_conn, v_item
  FROM public.workspace_connections c
  JOIN public.builder_stock_items i ON i.organisation_id = c.builder_organisation_id
  WHERE c.state = 'active' AND i.lifecycle_status = 'active'
  LIMIT 1;
  IF v_item IS NULL THEN
    RAISE NOTICE 'no active connection with stock: the supersession probe has nothing to enqueue';
    RETURN;
  END IF;
  BEGIN
    PERFORM public.builder_network_enqueue_stock_item(v_item);
    PERFORM public.builder_network_enqueue_stock_item(v_item);
    SELECT count(*) INTO v_after FROM public.builder_network_outbox
     WHERE connection_id = v_conn AND status = 'pending'
       AND event_type = 'stock.item.upserted' AND payload->>'id' = v_item::text
       AND locked_at IS NULL;
    IF v_after <> 1 THEN
      RAISE EXCEPTION 'POST-MIGRATION FAILURE: % waiting events for one item after two enqueues', v_after;
    END IF;
    -- Undo the probe's own events and version bumps.
    RAISE EXCEPTION 'probe_ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'probe_ok' THEN RAISE; END IF;
  END;
END $$;

COMMIT;
