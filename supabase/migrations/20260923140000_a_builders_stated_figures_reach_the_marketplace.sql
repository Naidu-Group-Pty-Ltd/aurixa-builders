-- ===========================================================================
-- A BUILDER'S STATED FIGURES REACH THE MARKETPLACE.
--
-- `builder_network_compose_stock_item_payload` composed `manual_stats` from
-- `manual_stats->'bedrooms'` … `manual_stats->'land_size_sqm'`: top-level
-- keys the column never holds, because its own CHECK constraint
-- (`builder_stock_items_manual_stats_shape`) puts the figures under
-- `manual_stats->'values'`. Every lookup was NULL, so a builder who stated a
-- land size synced to a clone as `{}` and read there exactly like one who
-- stated nothing. It has been named twice and fixed nowhere:
-- `20260917095000_capture_stock_sync_producer.sql` captured the producer
-- verbatim, correctly declining to change it there, and
-- `20260919060000_the_column_a_picture_was_filed_under_travels.sql` called it
-- "the manual_stats class again" and changed one other key.
--
-- WHY NOW. A package brochure that does not print its lot size — the stored
-- `Lot 101 - PICO - BROCHURE v002.pdf` prints the land's PRICE and nowhere its
-- area — can only get one from its builder, through the card's "Complete the
-- schedule". Until this, that figure stopped at the network: the builder saw
-- it and every marketplace did not.
--
-- THE SHAPE A CLONE READS. A clone stores the payload's object verbatim
-- (`builder_network_stock_items.manual_stats`) and its marketplace overlays it
-- with `applyManualStats`, which reads `values` and `recorded_at` — the same
-- module, byte for byte, the network reads with. So the payload carries that
-- shape, composed key by key like everything else here: the five figures
-- under `values`, and `recorded_at`. `recorded_by` is a builder user's id and
-- stays on the network.
--
-- ONE BLOCK, AND NOTHING ELSE CHANGES. The function is otherwise identical to
-- the definition production runs, read back with `pg_get_functiondef` on
-- 23 September 2026. No row holds `manual_stats` today (0 of 1,198), so no
-- payload a clone already holds changes, and nothing needs replaying: the
-- sync trigger already watches `manual_stats`, so the next figure a builder
-- states is what carries it.
-- ===========================================================================

BEGIN;

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
    'primary_image', v_image));
END $function$;

COMMIT;
