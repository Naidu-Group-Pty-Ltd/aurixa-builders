-- ============================================================================
-- CAPTURE: the stock-sync PRODUCER, which lives in production and in no file.
--
-- This migration adds no behaviour. Every object in it is already running on
-- the network database and has been since the stock mirror started converging;
-- what it does not have is a source. Measured 17 Sep 2026: six functions and
-- three triggers compose and enqueue `stock.item.upserted` /
-- `stock.catalog.reconciled`, 43 of which had landed in the prime's inbox, and
-- `grep -r upserted supabase/` over this repository returned nothing at all.
--
-- WHY THAT IS NOT A TIDYING EXERCISE. `scripts/db/baseline-check.mjs` rebuilds
-- the whole schema FROM THIS DIRECTORY and asserts it lands on production's
-- catalog fingerprint. A function applied straight to the database is invisible
-- to that check's inputs and fatal to its conclusion: a rebuilt environment —
-- a branch, a restore, a second region — comes up with the mirror wiring absent
-- and every clone's marketplace silently frozen at whatever it last received.
-- Nothing reports it, because an event that is never composed looks exactly
-- like a builder who changed nothing.
--
-- It is also load-bearing for the work that follows it. The ranking migration
-- REPLACES `builder_network_compose_stock_item_payload` to add the rank block.
-- Without this file the repository's only copy of that function would be the
-- replacement, and a rebuild would produce a composer that had never had the
-- twenty-six other keys a card is drawn from.
--
-- Transcribed verbatim from `pg_get_functiondef` / `pg_get_triggerdef` against
-- the live network project, not rewritten from memory. `CREATE OR REPLACE` and
-- `DROP TRIGGER IF EXISTS` make it a no-op where the objects already exist,
-- which is every environment that matters today.
--
-- One defect is recorded here and deliberately NOT fixed, because a capture
-- that silently repairs what it captures is no longer a capture and the fix
-- belongs in its own change with its own test:
--
--   `builder_network_compose_stock_item_payload` composes manual stats as
--   `manual_stats->'bedrooms'`, while the column's own CHECK constraint
--   (`builder_stock_items_manual_stats_shape`) requires the figures to live
--   under `manual_stats->'values'`. The top-level keys do not exist, every
--   lookup is SQL NULL, `jsonb_strip_nulls` removes them all, and a builder's
--   stated bedroom count has therefore never crossed to a single clone. It
--   fails exactly the way a builder who stated nothing looks.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The outbound version series, per connection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_next_outbound_version(_connection_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_version bigint;
BEGIN
  INSERT INTO public.builder_network_stamps(connection_id, side, stamp, source_version)
  VALUES (_connection_id, 'outbound',
          jsonb_build_object('count', 1, 'latest', to_jsonb(now()),
                             'pendingRequests', 0, 'attention', 0),
          1)
  ON CONFLICT (connection_id, side) DO UPDATE
    SET source_version = public.builder_network_stamps.source_version + 1,
        stamp = EXCLUDED.stamp,
        updated_at = now()
  RETURNING source_version INTO v_version;
  RETURN v_version;
END $function$;

-- ---------------------------------------------------------------------------
-- 2. The payload composer — the wire contract for one property
--
-- Note `primary_image`: only an image the builder themselves supplied and that
-- processing has settled travels at all, and the `source_detail` block is
-- composed key by key rather than spread, so the marketplace eligibility
-- verdicts cross while nothing else in that JSON can.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_compose_stock_item_payload(_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_i public.builder_stock_items;
  v_org record;
  v_img public.builder_stock_item_images;
  v_image jsonb := NULL;
BEGIN
  SELECT * INTO v_i FROM public.builder_stock_items WHERE id = _item_id;
  IF v_i.id IS NULL THEN RETURN NULL; END IF;

  SELECT legal_name, trading_name INTO v_org
  FROM public.builder_organisations WHERE id = v_i.organisation_id;

  IF v_i.primary_image_id IS NOT NULL THEN
    SELECT * INTO v_img FROM public.builder_stock_item_images WHERE id = v_i.primary_image_id;
    IF v_img.id IS NOT NULL
       AND v_img.source_stage = 'uploaded_document'
       AND v_img.verification_status = 'source_supplied'
       AND v_img.processing_status = 'ready'
    THEN
      v_image := jsonb_build_object(
        'id', v_img.id,
        'source_stage', v_img.source_stage,
        'verification_status', v_img.verification_status,
        'processing_status', v_img.processing_status,
        'content_type', v_img.content_type,
        'byte_size', v_img.byte_size,
        'position', 0,
        'source_detail', jsonb_strip_nulls(jsonb_build_object(
          'role',                          v_img.source_detail->'role',
          'role_evidence_level',           v_img.source_detail->'role_evidence_level',
          'stored_sha256',                 v_img.source_detail->'stored_sha256',
          'provenance_version',            v_img.source_detail->'provenance_version',
          'marketplace_measured',          v_img.source_detail->'marketplace_measured',
          'marketplace_measured_sha256',   v_img.source_detail->'marketplace_measured_sha256',
          'marketplace_display_eligible',  v_img.source_detail->'marketplace_display_eligible',
          'marketplace_eligibility_state', v_img.source_detail->'marketplace_eligibility_state',
          'marketplace_rejection_reason',  v_img.source_detail->'marketplace_rejection_reason',
          'marketplace_eligibility_version', v_img.source_detail->'marketplace_eligibility_version',
          'sanitized_derivative',          v_img.source_detail->'sanitized_derivative',
          'sanitization_clearance',        v_img.source_detail->'sanitization_clearance')));
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', v_i.id,
    'organisation_id', v_i.organisation_id,
    'upload_id', v_i.upload_id,
    'first_upload_id', v_i.first_upload_id,
    'created_by_builder_user_id', v_i.created_by_builder_user_id,
    'external_reference', v_i.external_reference,
    'development_name', v_i.development_name,
    'project_name', v_i.project_name,
    'address_line', v_i.address_line,
    'suburb', v_i.suburb,
    'state', v_i.state,
    'postcode', v_i.postcode,
    'lot_number', v_i.lot_number,
    'unit_number', v_i.unit_number,
    'bedrooms', v_i.bedrooms,
    'bathrooms', v_i.bathrooms,
    'car_spaces', v_i.car_spaces,
    'property_type', v_i.property_type,
    'land_size_sqm', v_i.land_size_sqm,
    'building_size_sqm', v_i.building_size_sqm,
    'price', v_i.price,
    'price_display', v_i.price_display,
    'availability_status', v_i.availability_status,
    'expected_completion', v_i.expected_completion,
    'description', v_i.description,
    'lifecycle_status', v_i.lifecycle_status,
    'enrichment_status', v_i.enrichment_status,
    'image_work_stage', v_i.image_work_stage,
    'house_design', v_i.source_row->>'house_design',
    'manual_stats', CASE WHEN v_i.manual_stats IS NULL THEN NULL ELSE
      jsonb_strip_nulls(jsonb_build_object(
        'bedrooms',          v_i.manual_stats->'bedrooms',
        'bathrooms',         v_i.manual_stats->'bathrooms',
        'car_spaces',        v_i.manual_stats->'car_spaces',
        'building_size_sqm', v_i.manual_stats->'building_size_sqm',
        'land_size_sqm',     v_i.manual_stats->'land_size_sqm')) END,
    'item_created_at', v_i.created_at,
    'item_updated_at', v_i.updated_at,
    'organisation', jsonb_build_object(
      'id', v_i.organisation_id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name),
    'primary_image', v_image));
END $function$;

-- ---------------------------------------------------------------------------
-- 3. Enqueue one item onto every active connection serving its organisation
-- ---------------------------------------------------------------------------
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
BEGIN
  v_payload := public.builder_network_compose_stock_item_payload(_item_id);
  IF v_payload IS NULL THEN RETURN 0; END IF;
  FOR v_conn IN
    SELECT c.id
    FROM public.workspace_connections c
    JOIN public.builder_stock_items i ON i.organisation_id = c.builder_organisation_id
    WHERE i.id = _item_id AND c.state = 'active'
  LOOP
    v_version := public.builder_network_next_outbound_version(v_conn.id);
    INSERT INTO public.builder_network_outbox(
      connection_id, event_type, dedupe_key, payload, source_version)
    VALUES (v_conn.id, 'stock.item.upserted',
            'stock.item:' || v_conn.id || ':' || _item_id || ':' || v_version,
            v_payload, v_version)
    ON CONFLICT (dedupe_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;

-- ---------------------------------------------------------------------------
-- 4. The catalogue reconciliation — the full id set, so a clone can retire
--    rows it holds that the network no longer has
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_enqueue_stock_reconcile(_connection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conn record;
  v_ids uuid[];
  v_payload jsonb;
  v_version bigint;
  v_count integer := 0;
BEGIN
  FOR v_conn IN
    SELECT c.id, c.builder_organisation_id
    FROM public.workspace_connections c
    WHERE c.state = 'active'
      AND (_connection_id IS NULL OR c.id = _connection_id)
      AND c.builder_organisation_id IS NOT NULL
  LOOP
    SELECT COALESCE(array_agg(i.id ORDER BY i.id), '{}') INTO v_ids
    FROM public.builder_stock_items i
    WHERE i.organisation_id = v_conn.builder_organisation_id
      AND i.lifecycle_status = 'active';

    v_payload := jsonb_build_object(
      'organisation_id', v_conn.builder_organisation_id,
      'active_item_ids', to_jsonb(v_ids));

    IF octet_length(v_payload::text) > 200000 THEN
      INSERT INTO public.portal_operational_events(
        event_name, severity, request_id, actor_type, portal, success, metadata)
      VALUES ('builder_network_stock_reconcile_oversized', 'critical',
              v_conn.id::text, 'system', 'builder', false,
              jsonb_build_object('connection_id', v_conn.id,
                                 'active_items', COALESCE(array_length(v_ids, 1), 0)));
      CONTINUE;
    END IF;

    v_version := public.builder_network_next_outbound_version(v_conn.id);
    INSERT INTO public.builder_network_outbox(
      connection_id, event_type, dedupe_key, payload, source_version)
    VALUES (v_conn.id, 'stock.catalog.reconciled',
            'stock.catalog:' || v_conn.id || ':' || v_version,
            v_payload, v_version)
    ON CONFLICT (dedupe_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;

-- ---------------------------------------------------------------------------
-- 5. Backfill — what a newly activated connection is sent so its mirror starts
--    whole rather than from the next edit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_backfill_stock_sync(_connection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conn record;
  v_item record;
  v_count integer := 0;
BEGIN
  FOR v_conn IN
    SELECT c.id, c.builder_organisation_id
    FROM public.workspace_connections c
    WHERE c.state = 'active'
      AND (_connection_id IS NULL OR c.id = _connection_id)
      AND c.builder_organisation_id IS NOT NULL
  LOOP
    FOR v_item IN
      SELECT i.id FROM public.builder_stock_items i
      WHERE i.organisation_id = v_conn.builder_organisation_id
        AND i.lifecycle_status = 'active'
      ORDER BY i.created_at
    LOOP
      v_count := v_count + public.builder_network_enqueue_stock_item(v_item.id);
    END LOOP;
  END LOOP;
  v_count := v_count + public.builder_network_enqueue_stock_reconcile(_connection_id);
  RETURN v_count;
END $function$;

-- ---------------------------------------------------------------------------
-- 6. The three triggers that drive all of it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_stock_item_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_status = 'active' THEN
      PERFORM public.builder_network_enqueue_stock_item(NEW.id);
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.lifecycle_status, NEW.availability_status, NEW.address_line, NEW.suburb,
         NEW.state, NEW.postcode, NEW.lot_number, NEW.unit_number, NEW.bedrooms,
         NEW.bathrooms, NEW.car_spaces, NEW.property_type, NEW.land_size_sqm,
         NEW.building_size_sqm, NEW.price, NEW.price_display, NEW.expected_completion,
         NEW.description, NEW.development_name, NEW.project_name, NEW.external_reference,
         NEW.primary_image_id, NEW.manual_stats, NEW.source_row->>'house_design',
         NEW.enrichment_status, NEW.image_work_stage)
     IS DISTINCT FROM
     ROW(OLD.lifecycle_status, OLD.availability_status, OLD.address_line, OLD.suburb,
         OLD.state, OLD.postcode, OLD.lot_number, OLD.unit_number, OLD.bedrooms,
         OLD.bathrooms, OLD.car_spaces, OLD.property_type, OLD.land_size_sqm,
         OLD.building_size_sqm, OLD.price, OLD.price_display, OLD.expected_completion,
         OLD.description, OLD.development_name, OLD.project_name, OLD.external_reference,
         OLD.primary_image_id, OLD.manual_stats, OLD.source_row->>'house_design',
         OLD.enrichment_status, OLD.image_work_stage)
  THEN
    PERFORM public.builder_network_enqueue_stock_item(NEW.id);
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.builder_network_stock_image_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_item uuid;
BEGIN
  FOR v_item IN
    SELECT i.id FROM public.builder_stock_items i WHERE i.primary_image_id = NEW.id
  LOOP
    PERFORM public.builder_network_enqueue_stock_item(v_item);
  END LOOP;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.builder_network_connection_activated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.state = 'active' AND OLD.state IS DISTINCT FROM 'active' THEN
    PERFORM public.builder_network_backfill_stock_sync(NEW.id);
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_builder_network_stock_item_sync ON public.builder_stock_items;
CREATE TRIGGER trg_builder_network_stock_item_sync
  AFTER INSERT OR UPDATE ON public.builder_stock_items
  FOR EACH ROW EXECUTE FUNCTION public.builder_network_stock_item_changed();

DROP TRIGGER IF EXISTS trg_builder_network_stock_image_sync ON public.builder_stock_item_images;
CREATE TRIGGER trg_builder_network_stock_image_sync
  AFTER UPDATE ON public.builder_stock_item_images
  FOR EACH ROW
  WHEN (old.source_detail IS DISTINCT FROM new.source_detail
     OR old.processing_status IS DISTINCT FROM new.processing_status
     OR old.storage_path IS DISTINCT FROM new.storage_path)
  EXECUTE FUNCTION public.builder_network_stock_image_changed();

DROP TRIGGER IF EXISTS trg_builder_network_connection_activated ON public.workspace_connections;
CREATE TRIGGER trg_builder_network_connection_activated
  AFTER UPDATE ON public.workspace_connections
  FOR EACH ROW EXECUTE FUNCTION public.builder_network_connection_activated();

-- Nothing on this path is ever called by a browser. Every one of these runs
-- either from a trigger or from the service role behind an edge function.
REVOKE ALL ON FUNCTION public.builder_network_next_outbound_version(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_compose_stock_item_payload(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_enqueue_stock_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_enqueue_stock_reconcile(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_backfill_stock_sync(uuid) FROM PUBLIC, anon, authenticated;
