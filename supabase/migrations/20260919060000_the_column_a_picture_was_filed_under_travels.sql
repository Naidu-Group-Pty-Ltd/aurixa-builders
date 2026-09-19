-- ===========================================================================
-- THE COLUMN A PICTURE WAS FILED UNDER TRAVELS TO A CLONE.
--
-- `builder_network_compose_stock_item_payload` composes `source_detail` KEY BY
-- KEY rather than spreading it — deliberately, so the marketplace eligibility
-- verdicts cross while nothing else in that JSON can. `source_column` was not
-- on the list, because nothing read it when the composer was written.
--
-- `columnDeclaration.pure.ts` reads it now: a picture filed under a heading
-- the builder's own stock list calls `Siting / Masterplan`, `Estate Brochure /
-- Location Map` or `Stage Plan / PlanOfSub` may not lead a card. A clone
-- receiving a payload with no `source_column` resolves that rule to `absent`,
-- which is PERMITTED — correctly, because an image that never came from a
-- column is an embedded asset or one a builder uploaded by hand. So the rule
-- would silently never apply on a mirrored marketplace, and the same estate
-- pictures this closes on the network would keep drawing there.
--
-- THIS IS THE `manual_stats` CLASS AGAIN. That composer reads
-- `manual_stats->'bedrooms'` where the column's own constraint puts the
-- figures under `manual_stats->'values'`, so every lookup is NULL and it looks
-- exactly like a builder who stated nothing. A key-by-key projection is only
-- as complete as the last person to read it remembered; the failure is always
-- silent and always looks like absent data.
--
-- ONE KEY, AND NOTHING ELSE CHANGES. The function is otherwise byte-identical
-- to the captured producer, including the four conditions that decide whether
-- an image travels at all. It is a projection widening, so it needs no
-- reprocess: the next sync of any property carries it, and a payload already
-- delivered without it reads exactly as it did.
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

DO $assert$
BEGIN
  -- ASSERTED BY EFFECT. `pg_get_functiondef` is the deployed text, so this
  -- reads what the database will actually run rather than what this file says.
  IF position('source_column' IN pg_get_functiondef(
       'public.builder_network_compose_stock_item_payload(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the stock payload composer still does not carry source_column';
  END IF;
  -- And the four conditions that decide whether an image travels at all are
  -- untouched: a widening must not become a loosening.
  IF position('verification_status = ''source_supplied''' IN pg_get_functiondef(
       'public.builder_network_compose_stock_item_payload(uuid)'::regprocedure)) = 0
     OR position('processing_status = ''ready''' IN pg_get_functiondef(
       'public.builder_network_compose_stock_item_payload(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the stock payload composer lost a condition that gates whether an image travels';
  END IF;
END;
$assert$;

COMMIT;
