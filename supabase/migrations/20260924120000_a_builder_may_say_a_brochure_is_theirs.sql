/*
 * A BUILDER MAY SAY A BROCHURE IS THEIRS — AND UNSAY IT.
 *
 * "Brochure details don't match this property" refuses a brochure whose image
 * page states a lot other than the listing's. It is right to: a cover naming
 * another lot is how another house reaches a client's card. It is also,
 * sometimes, wrong about the builder's own brochure, and only the person
 * holding the sheet can tell which.
 *
 * MEASURED 24 SEPTEMBER 2026, one stock list, two properties that look the
 * same on screen and are opposite cases:
 *
 *   Lot 1037 · Vanta 20 links its OWN brochure. Page 2 states "Lot 1037" and
 *   "Vanta 20"; the cover mistypes the lot as "Lot 1307".
 *
 *   Lot 1447 · Nex 20 links the SAME FILE as Lot 1744 · Cura 20B, and Lot
 *   1744 already shows that brochure's photograph.
 *
 * So a builder may confirm the brochure is theirs, and the cover rule then
 * counts the lot the page states as this listing's while keeping every other
 * test it has (`pageStatesIdentity`). A confirmation is refused where another
 * live listing already uses that brochure's photograph for the lot it states
 * (`brochureConfirmation.pure.ts`, checked by the portal before this runs).
 *
 * WHAT THIS ADDS
 *
 *   `builder_stock_identity_confirmations` — one row per confirmation, kept
 *   after it is undone. A confirmation is about ONE link on ONE row: the key
 *   is the link exactly as the row carries it, which is the key its stored
 *   answer lives under in `source_provenance_result.branches`.
 *
 *   `builder_stock_confirm_brochure_image` and
 *   `builder_stock_undo_brochure_image` — each one statement's worth of
 *   locking, so the checks and the act cannot be separated by another writer.
 *
 * WHAT A CONFIRMATION DOES NOT WRITE
 *
 *   It never writes `source_provenance_result`. The refusal it answers is
 *   reopened by the settler's own reading (`identityConfirmationHolds`), so
 *   the record stays exactly what the document said, and an answer reached
 *   under a confirmation carries the confirmation's id — which is what lets an
 *   undo reopen precisely the answers the confirmation produced.
 *
 *   It writes no property data — no price, availability, configuration,
 *   address, status, builder or project linkage.
 *
 * A PROPERTY BEING WORKED ON IS REFUSED, NEVER RACED
 *
 *   `complete_builder_stock_image_work` writes the stage unconditionally, so a
 *   requeue written while a worker holds the claim would be overwritten when
 *   that worker hands the property back, and the confirmation would sit unread
 *   behind a terminal stage. Both acts lock the row and answer `busy` while a
 *   claim is live; the lease is minutes, and the builder is told to try again.
 *
 * UNDO TAKES THE PICTURE DOWN IN THE SAME TRANSACTION
 *
 *   Every image stored under the confirmation stops being displayable in the
 *   statement that withdraws it, and a card pointing at one stops pointing at
 *   it. The portal then re-chooses the card's picture, and the settler reads
 *   the brochure again under whatever holds. A picture a slower worker stores
 *   under a withdrawn confirmation is refused by `chooseAndStorePrimaryImage`
 *   and withdrawn by the settler's next run (`brochureConfirmation.ts`).
 */

BEGIN;

CREATE TABLE IF NOT EXISTS public.builder_stock_identity_confirmations (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL
                      REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  stock_item_id       uuid NOT NULL
                      REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  -- The link exactly as the row carries it: the key the stored answer for
  -- that link lives under. Never a normalised form — two spellings of one
  -- file are two different questions to the settler.
  document_reference  text NOT NULL,
  -- The digits of the lot the brochure's image page states. Digits only: it
  -- is compared, never interpreted, and it names nothing a worker can act on.
  confirmed_lot       text NOT NULL,
  -- What the builder was looking at when they confirmed, for the record.
  listing_identity    text,
  finding_quote       text,
  confirmed_by        uuid,
  confirmed_by_name   text NOT NULL,
  confirmed_at        timestamptz NOT NULL DEFAULT now(),
  withdrawn_at        timestamptz,
  withdrawn_by        uuid,
  withdrawn_by_name   text,
  CONSTRAINT builder_stock_identity_confirmations_pkey PRIMARY KEY (id),
  CONSTRAINT builder_stock_identity_confirmations_lot
    CHECK (confirmed_lot ~ '^[0-9]{1,5}$'),
  CONSTRAINT builder_stock_identity_confirmations_reference
    CHECK (char_length(document_reference) BETWEEN 1 AND 2048),
  CONSTRAINT builder_stock_identity_confirmations_names
    CHECK (char_length(confirmed_by_name) BETWEEN 1 AND 160
           AND (withdrawn_by_name IS NULL OR char_length(withdrawn_by_name) BETWEEN 1 AND 160)),
  CONSTRAINT builder_stock_identity_confirmations_record_bounds
    CHECK ((listing_identity IS NULL OR char_length(listing_identity) <= 200)
           AND (finding_quote IS NULL OR char_length(finding_quote) <= 400)),
  -- Withdrawn means withdrawn by somebody named, at a time.
  CONSTRAINT builder_stock_identity_confirmations_withdrawal
    CHECK ((withdrawn_at IS NULL AND withdrawn_by_name IS NULL AND withdrawn_by IS NULL)
           OR (withdrawn_at IS NOT NULL AND withdrawn_by_name IS NOT NULL))
);

-- One standing confirmation per link per property. A withdrawn one is history.
CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_identity_confirmations_standing
  ON public.builder_stock_identity_confirmations (stock_item_id, document_reference)
  WHERE withdrawn_at IS NULL;

-- The settler reads an organisation's standing confirmations once per run.
CREATE INDEX IF NOT EXISTS builder_stock_identity_confirmations_by_org
  ON public.builder_stock_identity_confirmations (organisation_id, stock_item_id)
  WHERE withdrawn_at IS NULL;

COMMENT ON TABLE public.builder_stock_identity_confirmations IS
  'A builder''s statement that the brochure linked on one of their properties is that property''s, although its image page states another lot. Read by the image settler (brochureConfirmation.ts) and by the builder''s own stock list. Kept after it is undone; withdrawn_at marks the undo.';

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.builder_stock_identity_confirmations ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS builder_stock_identity_confirmations_service '
    || 'ON public.builder_stock_identity_confirmations';
  EXECUTE 'CREATE POLICY builder_stock_identity_confirmations_service '
    || 'ON public.builder_stock_identity_confirmations '
    || 'AS PERMISSIVE FOR ALL TO service_role '
    || 'USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')';
  EXECUTE 'REVOKE ALL ON public.builder_stock_identity_confirmations FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT ALL ON public.builder_stock_identity_confirmations TO service_role';
END $$;

/*
 * CONFIRM.
 *
 * Refuses, in this order, with a code the portal turns into a sentence:
 *
 *   not_found        the property is not this organisation's, or not live.
 *   busy             a worker holds the property's claim right now.
 *   finding_changed  the stored answer for that link is no longer the
 *                    mismatch the builder looked at, stating that lot — the
 *                    brochure was re-read, replaced, or already confirmed.
 *
 * A second click on a standing confirmation of the same link and lot answers
 * ok with the confirmation that stands: nothing is recorded twice.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_confirm_brochure_image(
  p_organisation_id    uuid,
  p_stock_item_id      uuid,
  p_document_reference text,
  p_confirmed_lot      text,
  p_confirmed_by       uuid,
  p_confirmed_by_name  text,
  p_listing_identity   text DEFAULT NULL,
  p_finding_quote      text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_item     public.builder_stock_items;
  v_record   jsonb;
  v_states   text;
  v_standing public.builder_stock_identity_confirmations;
  v_id       uuid;
BEGIN
  IF p_organisation_id IS NULL OR p_stock_item_id IS NULL
     OR coalesce(btrim(p_document_reference), '') = ''
     OR coalesce(p_confirmed_lot, '') !~ '^[0-9]{1,5}$'
     OR coalesce(btrim(p_confirmed_by_name), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;

  SELECT * INTO v_item
    FROM public.builder_stock_items
   WHERE id = p_stock_item_id AND organisation_id = p_organisation_id
   FOR UPDATE;
  IF v_item.id IS NULL OR v_item.lifecycle_status NOT IN ('active', 'staged') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_item.image_work_claim_until IS NOT NULL AND v_item.image_work_claim_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'busy');
  END IF;

  SELECT * INTO v_standing
    FROM public.builder_stock_identity_confirmations
   WHERE stock_item_id = v_item.id
     AND document_reference = p_document_reference
     AND withdrawn_at IS NULL;
  IF v_standing.id IS NOT NULL THEN
    IF v_standing.confirmed_lot = p_confirmed_lot THEN
      RETURN jsonb_build_object('ok', true, 'id', v_standing.id, 'already', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'finding_changed');
  END IF;

  -- The refusal the builder looked at, and nothing else: read, inspected, an
  -- identity mismatch, stating exactly this lot, and not itself an answer
  -- reached under a confirmation. `?` first — `->` on an absent key is NULL,
  -- and NULL would make every test below it vacuous.
  v_record := v_item.source_provenance_result -> 'branches' -> p_document_reference;
  v_states := btrim(coalesce(v_record -> 'finding_evidence' ->> 'states', ''));
  IF v_record IS NULL
     OR jsonb_typeof(v_record) <> 'object'
     OR v_record ? 'identity_confirmation'
     OR coalesce(v_record ->> 'result', '') <> 'no_deterministic_image'
     OR coalesce(v_record ->> 'exhaustion', '') <> 'inspected'
     OR coalesce(v_record ->> 'finding', '') <> 'identity_mismatch'
     OR coalesce(substring(v_states FROM '^[Ll][Oo][Tt][[:space:]]+([0-9]{1,5})$'), '')
        <> p_confirmed_lot THEN
    RETURN jsonb_build_object('ok', false, 'code', 'finding_changed');
  END IF;

  INSERT INTO public.builder_stock_identity_confirmations (
    organisation_id, stock_item_id, document_reference, confirmed_lot,
    listing_identity, finding_quote, confirmed_by, confirmed_by_name)
  VALUES (
    v_item.organisation_id, v_item.id, p_document_reference, p_confirmed_lot,
    nullif(left(btrim(coalesce(p_listing_identity, '')), 200), ''),
    nullif(left(btrim(coalesce(p_finding_quote, '')), 400), ''),
    p_confirmed_by, left(btrim(p_confirmed_by_name), 160))
  RETURNING id INTO v_id;

  -- Back in front of the ladder at once, with the bookkeeping of the question
  -- it replaces cleared: the watchdog escalates on those counters, and a
  -- property must not walk back to `failed` on the old question's account.
  UPDATE public.builder_stock_items
     SET enrichment_status          = 'pending',
         image_work_stage           = 'source',
         image_work_claim_until     = NULL,
         image_work_next_attempt_at = now(),
         image_work_failures        = 0,
         image_work_attempts        = 0,
         image_work_updated_at      = now()
   WHERE id = v_item.id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

/*
 * UNDO.
 *
 *   not_found  no standing confirmation with that id on that property.
 *   busy       a worker holds the property's claim right now.
 *
 * The confirmation is withdrawn, never deleted. Every image stored under it
 * stops being displayable, and a card pointing at one is cleared so the
 * portal's re-choice starts from what may be shown.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_undo_brochure_image(
  p_organisation_id   uuid,
  p_stock_item_id     uuid,
  p_confirmation_id   uuid,
  p_withdrawn_by      uuid,
  p_withdrawn_by_name text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_item      public.builder_stock_items;
  v_withdrawn uuid;
  v_images    uuid[];
BEGIN
  IF p_organisation_id IS NULL OR p_stock_item_id IS NULL OR p_confirmation_id IS NULL
     OR coalesce(btrim(p_withdrawn_by_name), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;

  SELECT * INTO v_item
    FROM public.builder_stock_items
   WHERE id = p_stock_item_id AND organisation_id = p_organisation_id
   FOR UPDATE;
  IF v_item.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_item.image_work_claim_until IS NOT NULL AND v_item.image_work_claim_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'busy');
  END IF;

  UPDATE public.builder_stock_identity_confirmations
     SET withdrawn_at      = now(),
         withdrawn_by      = p_withdrawn_by,
         withdrawn_by_name = left(btrim(p_withdrawn_by_name), 160)
   WHERE id = p_confirmation_id
     AND stock_item_id = v_item.id
     AND organisation_id = v_item.organisation_id
     AND withdrawn_at IS NULL
  RETURNING id INTO v_withdrawn;
  IF v_withdrawn IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  WITH taken_down AS (
    UPDATE public.builder_stock_item_images
       SET processing_status = 'unavailable',
           error_message = 'The builder undid their confirmation that this brochure is this '
             || 'property''s, so the image taken from it is not shown.'
     WHERE stock_item_id = v_item.id
       AND source_detail ? 'identity_confirmation'
       AND source_detail -> 'identity_confirmation' ->> 'id' = p_confirmation_id::text
       AND processing_status <> 'unavailable'
    RETURNING id
  )
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_images FROM taken_down;

  UPDATE public.builder_stock_items
     SET primary_image_id           = CASE
           WHEN primary_image_id = ANY (v_images) THEN NULL ELSE primary_image_id END,
         enrichment_status          = 'pending',
         image_work_stage           = 'source',
         image_work_claim_until     = NULL,
         image_work_next_attempt_at = now(),
         image_work_failures        = 0,
         image_work_attempts        = 0,
         image_work_updated_at      = now()
   WHERE id = v_item.id;

  RETURN jsonb_build_object('ok', true, 'id', v_withdrawn,
    'images_withdrawn', coalesce(array_length(v_images, 1), 0));
END;
$$;

REVOKE ALL ON FUNCTION public.builder_stock_confirm_brochure_image(
  uuid, uuid, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_confirm_brochure_image(
  uuid, uuid, text, text, uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_undo_brochure_image(
  uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_undo_brochure_image(
  uuid, uuid, uuid, uuid, text) TO service_role;

-- ============================================================================
-- Post-migration assertions — shapes, not hopes
-- ============================================================================

DO $$
DECLARE
  v_rls boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.builder_stock_identity_confirmations'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'builder_stock_identity_confirmations must have row level security';
  END IF;
  IF has_table_privilege('anon', 'public.builder_stock_identity_confirmations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.builder_stock_identity_confirmations', 'SELECT') THEN
    RAISE EXCEPTION 'builder_stock_identity_confirmations must not be readable by anon or authenticated';
  END IF;
  IF has_function_privilege('anon',
       'public.builder_stock_confirm_brochure_image(uuid, uuid, text, text, uuid, text, text, text)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.builder_stock_undo_brochure_image(uuid, uuid, uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the brochure confirmation functions must be service_role only';
  END IF;
END $$;

COMMIT;
