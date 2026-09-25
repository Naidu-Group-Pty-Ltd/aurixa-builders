-- ===========================================================================
-- A PROPERTY'S OWN BROCHURE FILLS WHAT ITS STOCK LIST LEFT OUT.
--
-- MEASURED 25 SEPTEMBER 2026 (`stock-field-coverage`): the one live stock
-- list, a Google Sheet of seventy properties, has no floor-area column, so 69
-- of them hold no building size, and its twenty dual-key rows leave the car
-- count blank. Every one of those rows links its own brochure, which the image
-- ladder already opens for a photograph and which prints the figures the sheet
-- does not. Nothing carried a figure from it onto the row.
--
-- This adds the place a brochure's figures are kept, and the machinery that
-- reads them, apart from the image ladder so nothing about which picture a
-- card draws moves:
--
--   1. `document_figures` — what the property's own brochure stated, kept
--      whole, so a re-read of a silent stock list puts it back rather than
--      blanking it (`importStock.ts`), and its lease.
--   2. The claim and the record. The record FILLS ONLY AN EMPTY COLUMN, in the
--      same statement that reads it, so a stock list that states the figure
--      between the read and the write still wins. A column the document itself
--      filled may be corrected by a later reading of the same kind; a column
--      the stock list wrote never is.
--   3. A self-unscheduling minute tick that dispatches
--      `builder-stock-figure-reader` while anything is owed or image work is
--      still outstanding, armed when a property's image work settles.
--
-- WHAT IS OWED: a live property missing any of the five figures a card draws,
-- whose provenance holds a link that delivered its photograph — the one
-- document the product has already held to this property's identity — and
-- which has not been read at this version under that link.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The record, and its lease
-- ---------------------------------------------------------------------------
ALTER TABLE public.builder_stock_items
  ADD COLUMN IF NOT EXISTS document_figures jsonb,
  ADD COLUMN IF NOT EXISTS document_figures_claim_token uuid,
  ADD COLUMN IF NOT EXISTS document_figures_claim_until timestamptz;

-- A CHECK constraint cannot hold a subquery, so the per-value test is here.
CREATE OR REPLACE FUNCTION public.builder_stock_jsonb_values_are_numbers(p_object jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_object) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_object) AS v(key, value)
                      WHERE jsonb_typeof(v.value) <> 'number')
$$;

-- PRESENCE BEFORE TYPE. A CHECK passes on NULL, and `->` on an absent key is
-- NULL, so every key is asserted present (strictly true or false) above the
-- first dereference of it — the `manual_stats` lesson.
ALTER TABLE public.builder_stock_items
  DROP CONSTRAINT IF EXISTS builder_stock_items_document_figures_shape;
ALTER TABLE public.builder_stock_items
  ADD CONSTRAINT builder_stock_items_document_figures_shape CHECK (
    document_figures IS NULL OR (
      jsonb_typeof(document_figures) = 'object'
      AND document_figures ? 'v'
      AND document_figures ? 'document'
      AND document_figures ? 'state'
      AND jsonb_typeof(document_figures -> 'v') = 'number'
      AND jsonb_typeof(document_figures -> 'document') = 'string'
      AND (document_figures ->> 'state') IN ('read', 'retry')
      AND (
        NOT (document_figures ? 'values')
        OR (
          jsonb_typeof(document_figures -> 'values') = 'object'
          AND ((document_figures -> 'values')
               - ARRAY['bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm', 'land_size_sqm'])
              = '{}'::jsonb
          AND public.builder_stock_jsonb_values_are_numbers(document_figures -> 'values')
        )
      )
    )
  );

COMMENT ON COLUMN public.builder_stock_items.document_figures IS
  'What this property''s own brochure (the link its photograph came from) stated about the figures its stock list left out: {v, document, state read|retry, standing, values, read_by, read_at, attempts, next_attempt_at}. Written only by record_builder_stock_document_figures. See brochureFigures.pure.ts.';

-- ---------------------------------------------------------------------------
-- 2. The version, the document, and what is owed
-- ---------------------------------------------------------------------------

-- Held equal to DOCUMENT_FIGURES_VERSION by a spec.
CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_version()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;

-- The link to read: one that delivered this property's photograph, and a
-- single document rather than a folder.
CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_document(p_provenance jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT min(b.key)
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_provenance -> 'branches') = 'object'
                         THEN p_provenance -> 'branches' ELSE '{}'::jsonb END) AS b(key, value)
   WHERE jsonb_typeof(b.value) = 'object'
     AND b.value ->> 'result' = 'image_recovered'
     AND b.key ~* '^https?://'
     AND b.key !~* '/folders?/'
$$;

CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_owed(
  p_item public.builder_stock_items, p_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_item.lifecycle_status IN ('active', 'staged')
     AND (p_item.bedrooms IS NULL OR p_item.bathrooms IS NULL OR p_item.car_spaces IS NULL
          OR p_item.building_size_sqm IS NULL OR p_item.land_size_sqm IS NULL)
     AND public.builder_stock_document_figures_document(p_item.source_provenance_result) IS NOT NULL
     AND (
       p_item.document_figures IS NULL
       OR (p_item.document_figures ->> 'v')::integer < p_version
       OR p_item.document_figures ->> 'document'
          IS DISTINCT FROM public.builder_stock_document_figures_document(p_item.source_provenance_result)
       OR (p_item.document_figures ->> 'state' = 'retry'
           AND coalesce((p_item.document_figures ->> 'attempts')::integer, 0) < 6
           AND coalesce((p_item.document_figures ->> 'next_attempt_at')::timestamptz, '-infinity'::timestamptz) <= now())
     )
     AND (p_item.document_figures_claim_until IS NULL OR p_item.document_figures_claim_until < now())
$$;

CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_pending()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*) FROM public.builder_stock_items i
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND public.builder_stock_document_figures_owed(i, public.builder_stock_document_figures_version())
$$;

-- ---------------------------------------------------------------------------
-- 3. The claim and the record
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_builder_stock_document_figures(
  p_version integer,
  p_lease_seconds integer DEFAULT 120,
  p_upload_id uuid DEFAULT NULL,
  p_organisation_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, organisation_id uuid, lot_number text, house_design text,
  document text, claim_token uuid, confirmed_lots text[], previous jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_id uuid;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT i.id INTO v_id
    FROM public.builder_stock_items i
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND (p_upload_id IS NULL OR i.upload_id = p_upload_id OR i.pending_upload_id = p_upload_id)
     AND (p_organisation_id IS NULL OR i.organisation_id = p_organisation_id)
     AND public.builder_stock_document_figures_owed(i, p_version)
   ORDER BY i.document_figures IS NOT NULL, i.updated_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN RETURN; END IF;

  UPDATE public.builder_stock_items i
     SET document_figures_claim_token = v_token,
         document_figures_claim_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600)))
   WHERE i.id = v_id;

  RETURN QUERY
  SELECT i.id, i.organisation_id, i.lot_number, i.source_row ->> 'house_design',
         public.builder_stock_document_figures_document(i.source_provenance_result),
         v_token,
         coalesce((SELECT array_agg(DISTINCT c.confirmed_lot)
                     FROM public.builder_stock_identity_confirmations c
                    WHERE c.stock_item_id = i.id AND c.withdrawn_at IS NULL), ARRAY[]::text[]),
         i.document_figures
    FROM public.builder_stock_items i WHERE i.id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_builder_stock_document_figures(
  p_item_id uuid, p_claim_token uuid, p_record jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_row public.builder_stock_items;
  v_after public.builder_stock_items;
  v_read boolean := (p_record ->> 'state') = 'read';
  v_vals jsonb := CASE WHEN jsonb_typeof(p_record -> 'values') = 'object'
                       THEN p_record -> 'values' ELSE '{}'::jsonb END;
  v_prev jsonb;
  v_filled text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_row FROM public.builder_stock_items
   WHERE id = p_item_id AND document_figures_claim_token = p_claim_token
   FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'claim_lost');
  END IF;
  v_prev := CASE WHEN v_row.document_figures ->> 'state' = 'read'
                  AND jsonb_typeof(v_row.document_figures -> 'values') = 'object'
                 THEN v_row.document_figures -> 'values' ELSE '{}'::jsonb END;
  v_read := v_read AND v_row.lifecycle_status IN ('active', 'staged');

  -- An empty column is filled. A column this document filled before may take
  -- the new reading of it. A column the stock list wrote is never touched.
  UPDATE public.builder_stock_items SET
    bedrooms = CASE WHEN v_read AND v_vals ? 'bedrooms'
      AND (bedrooms IS NULL OR bedrooms = (v_prev ->> 'bedrooms')::numeric)
      THEN (v_vals ->> 'bedrooms')::numeric ELSE bedrooms END,
    bathrooms = CASE WHEN v_read AND v_vals ? 'bathrooms'
      AND (bathrooms IS NULL OR bathrooms = (v_prev ->> 'bathrooms')::numeric)
      THEN (v_vals ->> 'bathrooms')::numeric ELSE bathrooms END,
    car_spaces = CASE WHEN v_read AND v_vals ? 'car_spaces'
      AND (car_spaces IS NULL OR car_spaces = (v_prev ->> 'car_spaces')::numeric)
      THEN (v_vals ->> 'car_spaces')::numeric ELSE car_spaces END,
    building_size_sqm = CASE WHEN v_read AND v_vals ? 'building_size_sqm'
      AND (building_size_sqm IS NULL OR building_size_sqm = (v_prev ->> 'building_size_sqm')::numeric)
      THEN (v_vals ->> 'building_size_sqm')::numeric ELSE building_size_sqm END,
    land_size_sqm = CASE WHEN v_read AND v_vals ? 'land_size_sqm'
      AND (land_size_sqm IS NULL OR land_size_sqm = (v_prev ->> 'land_size_sqm')::numeric)
      THEN (v_vals ->> 'land_size_sqm')::numeric ELSE land_size_sqm END,
    document_figures = p_record,
    document_figures_claim_token = NULL,
    document_figures_claim_until = NULL
  WHERE id = p_item_id
  RETURNING * INTO v_after;

  IF v_after.bedrooms IS DISTINCT FROM v_row.bedrooms THEN v_filled := array_append(v_filled, 'bedrooms'); END IF;
  IF v_after.bathrooms IS DISTINCT FROM v_row.bathrooms THEN v_filled := array_append(v_filled, 'bathrooms'); END IF;
  IF v_after.car_spaces IS DISTINCT FROM v_row.car_spaces THEN v_filled := array_append(v_filled, 'car_spaces'); END IF;
  IF v_after.building_size_sqm IS DISTINCT FROM v_row.building_size_sqm THEN v_filled := array_append(v_filled, 'building_size_sqm'); END IF;
  IF v_after.land_size_sqm IS DISTINCT FROM v_row.land_size_sqm THEN v_filled := array_append(v_filled, 'land_size_sqm'); END IF;
  RETURN jsonb_build_object('recorded', true, 'filled', to_jsonb(v_filled));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The tick, its schedule, and what arms it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_stock_document_figures_tick()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
DECLARE
  v_owed bigint := public.builder_stock_document_figures_pending();
  v_images bigint := 0;
  v_sent integer := 0;
BEGIN
  BEGIN
    SELECT outstanding INTO v_images FROM public.builder_stock_image_work_pending();
  EXCEPTION WHEN OTHERS THEN v_images := 0;
  END;
  -- Nothing owed and nothing that could become owed: the job retires itself.
  IF v_owed = 0 AND coalesce(v_images, 0) = 0 THEN
    BEGIN
      PERFORM cron.unschedule('read-builder-stock-document-figures');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('owed', 0, 'retired', true);
  END IF;
  IF v_owed > 0 THEN
    BEGIN
      PERFORM public.cron_invoke_signed_function('builder-stock-figure-reader', '{}'::jsonb, 'pg_cron');
      v_sent := 1;
    EXCEPTION WHEN OTHERS THEN v_sent := 0;
    END;
  END IF;
  RETURN jsonb_build_object('owed', v_owed, 'images_outstanding', v_images, 'dispatched', v_sent);
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_builder_stock_document_figures_scheduled()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'read-builder-stock-document-figures') THEN
    RETURN false;
  END IF;
  PERFORM cron.schedule('read-builder-stock-document-figures', '* * * * *',
    $job$SELECT public.builder_stock_document_figures_tick();$job$);
  RETURN true;
END;
$$;

-- Armed where a property's image work finishes: that is when its brochure's
-- answer is recorded, and so when its figures can first be owed.
CREATE OR REPLACE FUNCTION public.builder_stock_arm_document_figures()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  BEGIN
    PERFORM public.ensure_builder_stock_document_figures_scheduled();
  EXCEPTION WHEN OTHERS THEN NULL;  -- arming is never worth failing a settlement
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_builder_stock_arm_document_figures ON public.builder_stock_items;
CREATE TRIGGER trg_builder_stock_arm_document_figures
  AFTER UPDATE OF image_work_stage ON public.builder_stock_items
  FOR EACH ROW
  WHEN (NEW.image_work_stage = 'settled' AND OLD.image_work_stage IS DISTINCT FROM 'settled')
  EXECUTE FUNCTION public.builder_stock_arm_document_figures();

REVOKE ALL ON FUNCTION public.builder_stock_document_figures_pending() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_pending() TO service_role;
REVOKE ALL ON FUNCTION public.claim_builder_stock_document_figures(integer, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_builder_stock_document_figures(integer, integer, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_builder_stock_document_figures(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_builder_stock_document_figures(uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_document_figures_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_tick() TO service_role;
REVOKE ALL ON FUNCTION public.ensure_builder_stock_document_figures_scheduled() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_builder_stock_document_figures_scheduled() TO service_role;

-- Every helper too: a new function is executable by PUBLIC by default.
REVOKE ALL ON FUNCTION public.builder_stock_jsonb_values_are_numbers(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_jsonb_values_are_numbers(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_document_figures_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_version() TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_document_figures_document(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_document(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_document_figures_owed(public.builder_stock_items, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_document_figures_owed(public.builder_stock_items, integer) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_arm_document_figures() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_arm_document_figures() TO service_role;

-- The properties already settled are owed now; arm the tick once for them.
SELECT public.ensure_builder_stock_document_figures_scheduled();

COMMIT;
