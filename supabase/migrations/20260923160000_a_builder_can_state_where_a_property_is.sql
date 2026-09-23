-- ===========================================================================
-- A BUILDER CAN STATE WHERE A PROPERTY IS.
--
-- `Lot 101 - PICO - BROCHURE v002.pdf` names its lot and its estate and
-- nothing else: its whole location is the line `Lot 101 Watsons Reach
-- Estate`, and its own small print says it "is not the actual lot for sale …
-- refer to contract drawings and site plans". Every page was read and every
-- picture recognised. No reader can recover a street, suburb, state or
-- postcode the document does not carry, so the card could not be placed on
-- any marketplace. The builder knows where their lot is; until this, they had
-- no way to say so.
--
-- TWO CHANGES, BOTH IN WHAT ALREADY CARRIES A BUILDER'S STATEMENT.
--
-- 1. `builder_stock_items_manual_stats_shape` admits four more keys under
--    `values` — `address_line`, `suburb`, `state`, `postcode` — as strings,
--    with the rules the columns themselves already hold: the state is one of
--    the eight `builder_stock_items_state_check` admits, and the postcode is
--    four digits as `builder_stock_items_postcode_check` requires. The address
--    and suburb are bounded to what the edge function accepts
--    (`statedLocation.pure.ts`). Every existing rule stands, in the same
--    order: key PRESENCE is asserted before any dereference, because a CHECK
--    passes on NULL and `->` on an absent key is NULL — the defect this
--    constraint shipped with for a day.
--
--    The statement lives here and never in the address columns because
--    `importStock.ts` lists those columns in `UNSAYABLE_ON_REREAD`: a
--    same-source re-read that states nothing sets them to NULL, and the reader
--    sweep re-reads every upload whenever the reader's version moves. An
--    address typed into them would not outlive the next reader release.
--
-- 2. `builder_network_compose_stock_item_payload` sends the EFFECTIVE
--    address — the builder's part where they stated one, the document's where
--    they did not — in the ordinary `address_line`, `suburb`, `state` and
--    `postcode` keys. A clone copies those keys into its mirror verbatim
--    (`builder_network_stock_items`), and every surface there reads the
--    columns: the card, the locality line, the geocoder that places a pin,
--    the state filter and the search. So a stated address reaches all of them
--    with no change on any clone, and without widening the `manual_stats`
--    object a clone's reader accepts.
--
--    And `manual_stats` is sent only where a FIGURE is stated. A statement
--    holding only an address would otherwise travel as `{"values":{}}`, an
--    object with nothing in it — harmless to a clone's reader, and exactly
--    the shape the constraint above refuses on the network, so it is not
--    sent at all.
--
-- The function is otherwise byte-identical to
-- `20260923140000_a_builders_stated_figures_reach_the_marketplace.sql`, which
-- is the definition production runs. No row holds `manual_stats` today, so no
-- payload a clone holds changes and nothing needs replaying: the sync trigger
-- already watches `manual_stats`, so the next statement a builder saves is
-- what carries it.
-- ===========================================================================

BEGIN;

ALTER TABLE public.builder_stock_items
  DROP CONSTRAINT builder_stock_items_manual_stats_shape;

ALTER TABLE public.builder_stock_items
  ADD CONSTRAINT builder_stock_items_manual_stats_shape CHECK (
    manual_stats IS NULL OR (
      jsonb_typeof(manual_stats) = 'object'
      AND manual_stats ? 'values'
      AND jsonb_typeof(manual_stats -> 'values') = 'object'
      AND (manual_stats -> 'values') <> '{}'::jsonb
      AND ((manual_stats -> 'values') - ARRAY[
            'bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm',
            'address_line', 'suburb', 'state', 'postcode']) = '{}'::jsonb
      AND ((manual_stats -> 'values' -> 'bedrooms') IS NULL
           OR jsonb_typeof(manual_stats -> 'values' -> 'bedrooms') = 'number')
      AND ((manual_stats -> 'values' -> 'bathrooms') IS NULL
           OR jsonb_typeof(manual_stats -> 'values' -> 'bathrooms') = 'number')
      AND ((manual_stats -> 'values' -> 'car_spaces') IS NULL
           OR jsonb_typeof(manual_stats -> 'values' -> 'car_spaces') = 'number')
      AND ((manual_stats -> 'values' -> 'building_size_sqm') IS NULL
           OR jsonb_typeof(manual_stats -> 'values' -> 'building_size_sqm') = 'number')
      AND ((manual_stats -> 'values' -> 'land_size_sqm') IS NULL
           OR jsonb_typeof(manual_stats -> 'values' -> 'land_size_sqm') = 'number')
      AND ((manual_stats -> 'values' -> 'address_line') IS NULL
           OR (jsonb_typeof(manual_stats -> 'values' -> 'address_line') = 'string'
               AND char_length(manual_stats -> 'values' ->> 'address_line') BETWEEN 3 AND 120))
      AND ((manual_stats -> 'values' -> 'suburb') IS NULL
           OR (jsonb_typeof(manual_stats -> 'values' -> 'suburb') = 'string'
               AND char_length(manual_stats -> 'values' ->> 'suburb') BETWEEN 2 AND 60))
      AND ((manual_stats -> 'values' -> 'state') IS NULL
           OR (jsonb_typeof(manual_stats -> 'values' -> 'state') = 'string'
               AND (manual_stats -> 'values' ->> 'state')
                   = ANY (ARRAY['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])))
      AND ((manual_stats -> 'values' -> 'postcode') IS NULL
           OR (jsonb_typeof(manual_stats -> 'values' -> 'postcode') = 'string'
               AND (manual_stats -> 'values' ->> 'postcode') ~ '^[0-9]{4}$'))
    )
  );

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
    'primary_image', v_image));
END $function$;

COMMIT;
