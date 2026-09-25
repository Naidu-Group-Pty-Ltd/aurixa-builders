-- ===========================================================================
-- A property carries its photographs and documents across the network.
--
-- A connected workspace's property page needs what the builder published for
-- the property: its photographs and the documents its own stock row links to
-- (brochure, floor plan, siting, estate). The `stock.item.upserted` payload
-- carried one `primary_image` and no documents. It now also carries a
-- versioned `media` block:
--
--   media: {
--     schema_version: 1,
--     photos:    [{ id, position, content_type }],   -- 0..12, display order
--     documents: [{ id, kind, label, url }]          -- 0..12, typed links
--   }
--
-- The receiving workspace converges that block in a sweep of its own, beside
-- the property rather than inside it, so a media failure there can never touch
-- the property. `primary_image` is unchanged, byte for byte: every workspace
-- already running reads it, and nothing here asks them to stop.
--
-- WHAT THIS DOES NOT DO. It does not change which images are a property's
-- photographs. `builder_network_stock_item_gallery` is the item's primary
-- image under exactly the rule the composer has always applied — uploaded by
-- the builder, source supplied, ready — so today a property sends the one
-- photograph its card already shows, or none. The array can hold twelve; the
-- image pipeline decides what goes in it, and this step leaves that pipeline
-- (extraction, election, retention, OCR) untouched.
--
-- ONE RULE FOR A DOCUMENT LINK, IN TWO LANGUAGES. The Builder Portal's project
-- page lists a property's documents with `propertyDocumentLinks` (TypeScript);
-- the outbox is composed by triggers, in SQL. `builder_network_property_documents`
-- is that function's port, and `scripts/db/media-contract-check.ts` puts the
-- same fixtures to both on every build and fails on any difference. A
-- document's id is the md5 of its URL: stable across replays, so the receiver
-- converges rather than appends.
--
-- AND THE DOOR. `builder-network-stock-image` served only an item's current
-- primary. It now also serves a current member of the item's gallery — the
-- same set this composer publishes, read from the same function — which today
-- is the primary and nothing else, so what it serves does not change.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The documents a property's own row links to. A port of
--    `propertyDocumentLinks` (`_shared/builderStock/propertyDocuments.pure.ts`):
--    columns in code-unit order, whitespace-separated candidates, trailing
--    `),.` stripped, first occurrence of a URL wins, http(s) with a host only,
--    at most twelve; label = heading less a trailing URL/Link; kind read from
--    the heading, most specific first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_property_documents(_source_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_unmapped jsonb;
  v_column text;
  v_value text;
  v_candidate text;
  v_url text;
  v_label text;
  v_kind text;
  v_seen text[] := '{}';
  v_out jsonb := '[]'::jsonb;
BEGIN
  v_unmapped := CASE WHEN jsonb_typeof(_source_row->'unmapped') = 'object'
                     THEN _source_row->'unmapped' END;
  IF v_unmapped IS NULL THEN RETURN v_out; END IF;

  FOR v_column, v_value IN
    SELECT e.key, e.value #>> '{}'
      FROM jsonb_each(v_unmapped) e
     WHERE jsonb_typeof(e.value) = 'string'
     ORDER BY e.key COLLATE "C"
  LOOP
    FOR v_candidate IN
      SELECT t.c FROM regexp_split_to_table(v_value, '\s+') WITH ORDINALITY AS t(c, n) ORDER BY t.n
    LOOP
      CONTINUE WHEN v_candidate !~* '^https?://';
      v_url := regexp_replace(v_candidate, '[),.]+$', '');
      CONTINUE WHEN v_url = ANY (v_seen);
      v_seen := v_seen || v_url;
      -- A link a person opens: a scheme a browser will not execute, and a host.
      CONTINUE WHEN v_url !~* '^https?://[^/?#[:space:]]+';

      v_label := regexp_replace(
        regexp_replace(v_column, '\s*(url|link)\s*$', '', 'i'), '^\s+|\s+$', '', 'g');
      IF v_label = '' THEN
        v_label := COALESCE(nullif(regexp_replace(v_column, '^\s+|\s+$', '', 'g'), ''), 'Document');
      END IF;

      v_kind := CASE
        WHEN v_column ~* '\yestate\y|location\s*map' THEN 'estate'
        WHEN v_column ~* 'floor\s*-?\s*plans?\y' THEN 'floor_plan'
        WHEN v_column ~* '\ysiting\y|site\s*plan|master\s*-?\s*plan|stage\s*plan|plan\s*of\s*sub' THEN 'site_plan'
        WHEN v_column ~* 'brochure|package|flyer|info(rmation)?\s*pack' THEN 'brochure'
        ELSE 'other'
      END;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', md5(v_url), 'kind', v_kind, 'label', v_label, 'url', v_url));
      IF jsonb_array_length(v_out) >= 12 THEN RETURN v_out; END IF;
    END LOOP;
  END LOOP;
  RETURN v_out;
END $fn$;

-- ---------------------------------------------------------------------------
-- 2. The photographs a property publishes, in display order. Today: its
--    primary image, under the composer's own long-standing rule, or nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_stock_item_gallery(_item_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(array_agg(img.id), '{}'::uuid[])
    FROM public.builder_stock_items i
    JOIN public.builder_stock_item_images img ON img.id = i.primary_image_id
   WHERE i.id = _item_id
     AND img.source_stage = 'uploaded_document'
     AND img.verification_status = 'source_supplied'
     AND img.processing_status = 'ready';
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The composer: exactly the previous definition
--    (`20260923160000_a_builder_can_state_where_a_property_is.sql`), plus
--    `media`.
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
  v_photos jsonb;
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
          'source_column',                 v_img.source_detail->'source_column',
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

  -- The photographs, in gallery order: ids and a content type, never a path.
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', g.id, 'position', g.n - 1, 'content_type', img.content_type)) ORDER BY g.n),
         '[]'::jsonb)
    INTO v_photos
    FROM unnest(public.builder_network_stock_item_gallery(v_i.id)) WITH ORDINALITY AS g(id, n)
    JOIN public.builder_stock_item_images img ON img.id = g.id
   WHERE g.n <= 12;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', v_i.id,
    'organisation_id', v_i.organisation_id,
    'upload_id', v_i.upload_id,
    'first_upload_id', v_i.first_upload_id,
    'created_by_builder_user_id', v_i.created_by_builder_user_id,
    'external_reference', v_i.external_reference,
    'development_name', v_i.development_name,
    'project_name', v_i.project_name,
    'address_line', COALESCE(v_i.manual_stats->'values'->>'address_line', v_i.address_line),
    'suburb',       COALESCE(v_i.manual_stats->'values'->>'suburb',       v_i.suburb),
    'state',        COALESCE(v_i.manual_stats->'values'->>'state',        v_i.state),
    'postcode',     COALESCE(v_i.manual_stats->'values'->>'postcode',     v_i.postcode),
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
    'manual_stats', CASE WHEN NOT COALESCE(v_i.manual_stats->'values' ?| ARRAY[
        'bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm'], false)
      THEN NULL ELSE
      jsonb_strip_nulls(jsonb_build_object(
        'values', jsonb_strip_nulls(jsonb_build_object(
          'bedrooms',          v_i.manual_stats->'values'->'bedrooms',
          'bathrooms',         v_i.manual_stats->'values'->'bathrooms',
          'car_spaces',        v_i.manual_stats->'values'->'car_spaces',
          'building_size_sqm', v_i.manual_stats->'values'->'building_size_sqm',
          'land_size_sqm',     v_i.manual_stats->'values'->'land_size_sqm')),
        'recorded_at', v_i.manual_stats->'recorded_at')) END,
    'item_created_at', v_i.created_at,
    'item_updated_at', v_i.updated_at,
    'organisation', jsonb_build_object(
      'id', v_i.organisation_id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name),
    'primary_image', v_image,
    'media', jsonb_build_object(
      'schema_version', 1,
      'photos', v_photos,
      'documents', public.builder_network_property_documents(v_i.source_row))));
END $function$;

-- ---------------------------------------------------------------------------
-- 4. A changed document is a changed property. The sync trigger watched
--    `source_row->>'house_design'` and no link, so a builder who corrected a
--    brochure link sent nothing. It now compares the DOCUMENTS the row yields
--    — not the raw row, which every re-read rewrites.
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
         NEW.enrichment_status, NEW.image_work_stage,
         public.builder_network_property_documents(NEW.source_row))
     IS DISTINCT FROM
     ROW(OLD.lifecycle_status, OLD.availability_status, OLD.address_line, OLD.suburb,
         OLD.state, OLD.postcode, OLD.lot_number, OLD.unit_number, OLD.bedrooms,
         OLD.bathrooms, OLD.car_spaces, OLD.property_type, OLD.land_size_sqm,
         OLD.building_size_sqm, OLD.price, OLD.price_display, OLD.expected_completion,
         OLD.description, OLD.development_name, OLD.project_name, OLD.external_reference,
         OLD.primary_image_id, OLD.manual_stats, OLD.source_row->>'house_design',
         OLD.enrichment_status, OLD.image_work_stage,
         public.builder_network_property_documents(OLD.source_row))
  THEN
    PERFORM public.builder_network_enqueue_stock_item(NEW.id);
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.builder_network_property_documents(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_stock_item_gallery(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_compose_stock_item_payload(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.builder_network_stock_item_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_property_documents(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_network_stock_item_gallery(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Every connected workspace hears each live property once more, now with
--    its media — the same act as the operator's backfill, which is what it
--    calls. Idempotent at the receiver: a replay converges to the same rows.
-- ---------------------------------------------------------------------------
SELECT public.builder_network_backfill_stock_sync(NULL);

COMMIT;
