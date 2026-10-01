-- ===========================================================================
-- THE MARKETPLACE HERO STANDARD (1 October 2026)
-- ===========================================================================
--
-- Every marketplace card is 16:9 and frames the property as the obvious
-- subject, from a PLAN stored beside the picture: the photographic region,
-- the building's bounds and a crop in the served image's own pixels
-- (`_shared/builderStock/marketplaceHero.pure.ts`). The builder's file is
-- never altered or re-encoded; both portals draw the stored plan over the
-- bytes they already serve.
--
-- THREE THINGS, AND NONE OF THEM TOUCHES THE STOCK PIPELINE.
--
--   1  `builder_network_compose_stock_item_payload` carries one more key of
--      the card image's `source_detail` — `marketplace_hero` — so the Command
--      Centre's mirror (which already stores `source_detail` as sent) holds
--      the SAME plan the network made. The body is otherwise byte-identical
--      to `20260926120000`'s, which production was verified to run before
--      this was written (md5 of prosrc compared, 1 Oct 2026). A mirror that
--      has not received the key draws its cards exactly as before.
--
--   2  `builder_stock_record_hero_presentation` writes ONE key of ONE row —
--      a plan, or the record of a failed attempt — as an atomic JSONB merge,
--      and only while the picture's fingerprints are still the ones the plan
--      was made over. It cannot reach any other key, row, table or status.
--
--   3  `builder-stock-hero-planner-10min` wakes the planner on its own clock.
--      Nothing in the pipeline waits on it, and it unschedules nothing.
--
-- ROLLBACK is `SELECT public.builder_stock_clear_hero_presentation(NULL);`,
-- which removes the two keys everywhere; every card then draws exactly as it
-- did before this migration, because a card with no plan is drawn the old way.
-- ===========================================================================

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

  SELECT legal_name, trading_name, contact_email, contact_phone, website INTO v_org
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
          'sanitization_clearance',        v_img.source_detail->'sanitization_clearance',
          -- The Marketplace Hero Standard's plan: how a card frames THIS
          -- picture. Presentation metadata, keyed to the served bytes'
          -- SHA-256, so the Command Centre draws the frame the network
          -- planned rather than guessing one of its own.
          'marketplace_hero',              v_img.source_detail->'marketplace_hero')));
    END IF;
  END IF;

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
    'organisation', jsonb_strip_nulls(jsonb_build_object(
      'id', v_i.organisation_id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name,
      'contact_email', nullif(btrim(v_org.contact_email), ''),
      'contact_phone', nullif(btrim(v_org.contact_phone), ''),
      'website', nullif(btrim(v_org.website), ''))),
    'primary_image', v_image,
    'media', jsonb_build_object(
      'schema_version', 1,
      'photos', v_photos,
      'documents', public.builder_network_property_documents(v_i.source_row))));
END $function$;

REVOKE ALL ON FUNCTION public.builder_network_compose_stock_item_payload(uuid) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.builder_stock_record_hero_presentation(
  p_image_id uuid,
  p_organisation_id uuid,
  p_plan jsonb,
  p_attempt jsonb,
  p_expected_original text,
  p_expected_derivative text)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_rows integer;
BEGIN
  -- Exactly one of the two, each of the shape the reader accepts.
  IF (p_plan IS NULL) = (p_attempt IS NULL) THEN RETURN false; END IF;
  IF p_plan IS NOT NULL AND (
       jsonb_typeof(p_plan) <> 'object'
       OR NOT (p_plan ? 'plan') OR jsonb_typeof(p_plan->'plan') <> 'object'
       OR NOT (p_plan ? 'sha256') OR NOT (p_plan ? 'object')
       OR (p_plan->>'object') NOT IN ('original', 'derivative')) THEN
    RETURN false;
  END IF;
  IF p_attempt IS NOT NULL AND (
       jsonb_typeof(p_attempt) <> 'object' OR NOT (p_attempt ? 'sha256')) THEN
    RETURN false;
  END IF;
  IF p_expected_original IS NULL THEN RETURN false; END IF;

  UPDATE public.builder_stock_item_images img
     SET source_detail = CASE
           WHEN p_plan IS NOT NULL
             THEN (COALESCE(img.source_detail, '{}'::jsonb) - 'marketplace_hero_attempt')
                  || jsonb_build_object('marketplace_hero', p_plan)
           ELSE COALESCE(img.source_detail, '{}'::jsonb)
                  || jsonb_build_object('marketplace_hero_attempt', p_attempt)
         END
   WHERE img.id = p_image_id
     AND img.organisation_id = p_organisation_id
     -- The fingerprints the plan was made over must still stand: a builder
     -- who replaced the file, or a repair written meanwhile, voids the write.
     AND lower(COALESCE(img.source_detail->>'stored_sha256',
                        img.source_detail->>'source_sha256',
                        img.source_detail->>'marketplace_measured_sha256', ''))
         = lower(p_expected_original)
     AND COALESCE(img.source_detail->'sanitized_derivative'->>'derivative_sha256', '')
         = COALESCE(p_expected_derivative, '');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_record_hero_presentation(uuid, uuid, jsonb, jsonb, text, text) IS
  'Marketplace Hero Standard: merge ONE presentation key (a plan, or a failed attempt) into ONE image row, only while its fingerprints are unchanged. Touches nothing else.';

REVOKE ALL ON FUNCTION public.builder_stock_record_hero_presentation(uuid, uuid, jsonb, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_record_hero_presentation(uuid, uuid, jsonb, jsonb, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.builder_stock_clear_hero_presentation(p_organisation_id uuid)
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.builder_stock_item_images
     SET source_detail = source_detail - 'marketplace_hero' - 'marketplace_hero_attempt'
   WHERE (source_detail ? 'marketplace_hero' OR source_detail ? 'marketplace_hero_attempt')
     AND (p_organisation_id IS NULL OR organisation_id = p_organisation_id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_clear_hero_presentation(uuid) IS
  'Rollback for the Marketplace Hero Standard: removes the two presentation keys (NULL = every organisation). Cards then draw exactly as before.';

REVOKE ALL ON FUNCTION public.builder_stock_clear_hero_presentation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_clear_hero_presentation(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_stock_hero_planner_heartbeat()
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  -- Best-effort, as every heartbeat here is: a missing vault entry or a
  -- pg_net hiccup must never fail a cron tick, and a missed tick costs only
  -- latency on presentation.
  BEGIN
    PERFORM public.cron_invoke_signed_function(
      'builder-stock-hero-planner', '{}'::jsonb, 'hero_planner_heartbeat');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_stock_hero_planner_heartbeat() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_hero_planner_heartbeat() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-stock-hero-planner-10min') THEN
      PERFORM cron.schedule(
        'builder-stock-hero-planner-10min',
        '*/10 * * * *',
        $job$SELECT public.builder_stock_hero_planner_heartbeat();$job$);
    END IF;
  END IF;
END $$;
