/*
 * A STOCK LIST IS REPLACED BY A NEWER VERSION OF ITSELF, AND BY NOTHING ELSE.
 *
 * MEASURED IN PRODUCTION, 28 SEPTEMBER 2026, by the Tier-0 edge-case proof
 * (`scripts/ops/stock-tier0-edges.mjs`, organisation "twolists"): a builder
 * uploaded Estate A and then Estate B — two different estates, no property in
 * common. B published. A never did. Every one of A's properties was settled
 * on a ready builder-source photograph and its readiness answered `ready`,
 * yet `publish_builder_stock_upload` answered `superseded` for the fifteen
 * minutes the proof waited and would have for ever, while the upload row went
 * on saying "awaiting source photographs … 1 still reading their source" — a
 * reason stamped before B existed and never revisited. A builder onboarding
 * several estates in one sitting gets exactly one of them on the Marketplace.
 *
 * THE CAUSE is `builder_stock_upload_superseded`, which answered TRUE when ANY
 * later non-deleted upload existed in the organisation. It was written
 * (docs/provenance/corpus/20261025000000) when the newest upload WAS the stock
 * list, and what it protects is real: an abandoned draft of the SAME list must
 * not publish — its held-back values would re-point properties the current
 * list dropped, taking them out of the current list's archive step, and they
 * would stay on the Marketplace for ever. Measured then, and asserted again by
 * `scripts/db/stock-list-lineage-check.mjs`. But the replacement model has
 * since become "replace what you matched" (`replaces_upload_ids`), the importer
 * itself speaks of "a stock list the builder keeps beside this one", and the
 * rule was never narrowed to match. `20260922070000` saw the breadth and moved
 * only the patch; the promotion stayed blocked.
 *
 * WHY NOT SIMPLY READ `replaces_upload_ids`. It is the obvious narrowing and
 * it is not safe on its own, for two measured reasons in this code:
 *   * it is written once, at the END of an import, so for the whole of a
 *     newer list's read nothing records what it is taking over;
 *   * a re-read REWRITES it, and a re-read of a published list writes it
 *     empty (every row it supplies is its own by then). After that nothing
 *     links the current list to the draft it replaced — and the draft's own
 *     new properties, which the current list dropped, would promote.
 *
 * SO THE RELATION IS RECORDED WHEN IT HAPPENS AND NEVER FORGOTTEN. Two uploads
 * touch the same property at exactly one moment: when a row's supplier
 * (`upload_id`) or the upload holding values back on it (`pending_upload_id`)
 * changes. A trigger records every pair of uploads that has ever met on one
 * property, together with the upload that first created it. That is append
 * only — a re-read cannot erase it and a cut-over cannot either — and a list's
 * LINEAGE is everything connected to it through those meetings (and through
 * `replaces_upload_ids`, read as well, never instead).
 *
 * THE RULE, THEN. An upload is superseded by a later upload of its
 * organisation that is
 *   * not deleted and still being read — its STATUS is `uploaded`, `parsing`
 *     or `imported` (rows being written). What it will take over is not known
 *     yet, so the old answer stands, exactly as before. The status, never
 *     `processing_completed_at`: a failed read stamps that, and a retry sets
 *     `parsing` again without clearing it, so a list being read a second time
 *     looked finished; or
 *   * not deleted and one that existed before this migration — their
 *     meetings were never recorded, so every pre-existing upload keeps the old
 *     rule and no stored list changes state because of this file; or
 *   * in the same lineage and either not deleted or PUBLISHED. A version that
 *     cut over replaced the draft for good: deleting it later and adding the
 *     list again (new rows, no meeting with the draft) must not bring the
 *     abandoned draft back. A version that never published and was deleted
 *     supersedes nothing, as before.
 * Two lists that have never met on a property do not supersede each other,
 * and both publish.
 *
 * DECIDED ONCE, BY PUBLISH. `publish_builder_stock_upload` asks the rule at
 * the top and hands its answer to the patch (`p_own_rows_only`). The first
 * version of this file asked it again inside the patch, after readiness: a
 * list created in between made a cut-over patch only the rows the upload
 * already supplied, and the archive step then took every property it had
 * matched (found by the independent review, reproduced in a scratch database:
 * patched 0, archived 4, published). The rule is also declared expensive
 * (`COST`), because it walks the organisation's lineage and the sweep must
 * test every cheaper condition first.
 *
 * AND A SUPERSEDED DRAFT MAY CORRECT ONLY THE ROWS IT SUPPLIES.
 * `20260922070000` applies a superseded upload's held-back patch so a re-read
 * of an older list can still correct its own rows. Written against the broad
 * rule, it applied EVERY patch that upload holds — including values it holds
 * back on properties its predecessor supplies. For a draft of the same list
 * those are exactly the rows the provenance note above is about: the check in
 * this change measures an abandoned draft re-pointing two properties the
 * current list had dropped, and the current list's cut-over then archiving
 * neither. `apply_builder_stock_pending_patch` now keeps, for a superseded
 * upload, to rows whose supplier is that upload itself — its own corrections
 * still land, and nothing it does not supply moves. For an upload that is not
 * superseded (every cut-over and every re-read of a current list) it is
 * byte-for-byte what it was.
 *
 * Nothing here changes readiness, promotion, archiving or the cut-over, and
 * no row is rewritten.
 */

-- ── Which uploads have their meetings recorded ─────────────────────────────
-- Every upload that exists when this runs gets FALSE (its history is
-- unknown); every upload created afterwards gets TRUE. Adding the column with
-- a constant default is a catalogue change, not a table rewrite.
ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS lineage_recorded boolean NOT NULL DEFAULT false;
ALTER TABLE public.builder_stock_uploads
  ALTER COLUMN lineage_recorded SET DEFAULT true;

COMMENT ON COLUMN public.builder_stock_uploads.lineage_recorded IS
  'TRUE for an upload created after 20260930090000, whose every meeting with another upload on a property is in builder_stock_upload_contacts. FALSE for an upload that existed before: its meetings were never recorded, so builder_stock_upload_superseded treats every such upload of an organisation as one lineage (the rule they were always under).';

-- ── The record ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.builder_stock_upload_contacts (
  upload_a    uuid NOT NULL REFERENCES public.builder_stock_uploads(id) ON DELETE CASCADE,
  upload_b    uuid NOT NULL REFERENCES public.builder_stock_uploads(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_a, upload_b),
  CONSTRAINT builder_stock_upload_contacts_ordered CHECK (upload_a < upload_b)
);

COMMENT ON TABLE public.builder_stock_upload_contacts IS
  'Two uploads of one organisation that have met on the same property: one supplied it, held values back on it, or created it while the other did. Written by trg_builder_stock_record_upload_contacts and nothing else, append only. A stock list''s lineage is everything connected to it here; see builder_stock_upload_superseded.';

CREATE INDEX IF NOT EXISTS builder_stock_upload_contacts_b_idx
  ON public.builder_stock_upload_contacts (upload_b);

ALTER TABLE public.builder_stock_upload_contacts ENABLE ROW LEVEL SECURITY;
-- Append only, ENFORCED: Supabase grants every new table to service_role in
-- full by default, so SELECT is granted back after everything is revoked.
REVOKE ALL ON TABLE public.builder_stock_upload_contacts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.builder_stock_upload_contacts TO service_role;

-- ── Recorded where it happens ───────────────────────────────────────────────
/*
 * EVERY PAIR among the uploads the row names before and after the change.
 * Joined to the uploads table so an id that is not an upload of this
 * organisation — or one being deleted in this very statement, which is what
 * the `upload_id … ON DELETE SET NULL` action looks like from here — is never
 * written: a lineage row must not be able to fail a delete.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_record_upload_contacts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.builder_stock_upload_contacts (upload_a, upload_b)
  SELECT DISTINCT least(x.id, y.id), greatest(x.id, y.id)
    FROM (SELECT u.id
            FROM (VALUES (OLD.upload_id), (NEW.upload_id), (OLD.pending_upload_id),
                         (NEW.pending_upload_id), (NEW.first_upload_id)) AS v(id)
            JOIN public.builder_stock_uploads u
              ON u.id = v.id AND u.organisation_id = NEW.organisation_id) AS x
    JOIN (SELECT u.id
            FROM (VALUES (OLD.upload_id), (NEW.upload_id), (OLD.pending_upload_id),
                         (NEW.pending_upload_id), (NEW.first_upload_id)) AS v(id)
            JOIN public.builder_stock_uploads u
              ON u.id = v.id AND u.organisation_id = NEW.organisation_id) AS y
      ON x.id < y.id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.builder_stock_record_upload_contacts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_builder_stock_record_upload_contacts ON public.builder_stock_items;
CREATE TRIGGER trg_builder_stock_record_upload_contacts
  AFTER UPDATE OF upload_id, pending_upload_id ON public.builder_stock_items
  FOR EACH ROW
  WHEN (OLD.upload_id IS DISTINCT FROM NEW.upload_id
     OR OLD.pending_upload_id IS DISTINCT FROM NEW.pending_upload_id)
  EXECUTE FUNCTION public.builder_stock_record_upload_contacts();

-- ── The rule ────────────────────────────────────────────────────────────────
/*
 * Same signature, same callers, same meaning for every upload that existed
 * before this file: the pre-existing uploads of an organisation are joined
 * into one lineage through a node that is the organisation's id — never an
 * upload's, so it can never itself be a newer upload — and a newer
 * pre-existing upload still supersedes an older one outright.
 */
CREATE OR REPLACE FUNCTION public.builder_stock_upload_superseded(p_upload_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 COST 10000
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE this AS (
    SELECT u.id, u.organisation_id, u.created_at
      FROM public.builder_stock_uploads u
     WHERE u.id = p_upload_id
  ),
  newer AS (
    SELECT n.id, n.status, n.deleted_at, n.published_at, n.lineage_recorded
      FROM public.builder_stock_uploads n
      JOIN this ON n.organisation_id = this.organisation_id
     WHERE n.id <> this.id
       AND n.created_at > this.created_at
  ),
  org_uploads AS (
    SELECT u.id, u.organisation_id, u.lineage_recorded, u.replaces_upload_ids
      FROM public.builder_stock_uploads u
      JOIN this ON u.organisation_id = this.organisation_id
  ),
  edges (a, b) AS MATERIALIZED (
    SELECT c.upload_a, c.upload_b
      FROM public.builder_stock_upload_contacts c JOIN org_uploads o ON o.id = c.upload_a
    UNION ALL
    SELECT c.upload_b, c.upload_a
      FROM public.builder_stock_upload_contacts c JOIN org_uploads o ON o.id = c.upload_a
    UNION ALL
    SELECT r.replaced, o.id FROM org_uploads o CROSS JOIN LATERAL unnest(o.replaces_upload_ids) AS r(replaced)
    UNION ALL
    SELECT o.id, r.replaced FROM org_uploads o CROSS JOIN LATERAL unnest(o.replaces_upload_ids) AS r(replaced)
    UNION ALL
    SELECT o.id, o.organisation_id FROM org_uploads o WHERE NOT o.lineage_recorded
    UNION ALL
    SELECT o.organisation_id, o.id FROM org_uploads o WHERE NOT o.lineage_recorded
  ),
  lineage (id) AS (
    SELECT id FROM this
    UNION
    SELECT e.b FROM lineage l JOIN edges e ON e.a = l.id
  )
  SELECT EXISTS (
    SELECT 1
      FROM newer
     WHERE (newer.deleted_at IS NULL AND newer.status IN ('uploaded', 'parsing', 'imported'))
        OR (newer.deleted_at IS NULL AND NOT newer.lineage_recorded)
        OR ((newer.deleted_at IS NULL OR newer.published_at IS NOT NULL)
            AND newer.id IN (SELECT id FROM lineage))
  );
$function$;

REVOKE ALL ON FUNCTION public.builder_stock_upload_superseded(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_upload_superseded(uuid) TO service_role;

-- ── A superseded draft corrects only the rows it supplies ───────────────────
/*
 * `20260921110000`'s body, unchanged but for `p_own_rows_only` and the last
 * line of the WHERE clause. Every column is still named and still answers to
 * key presence (see that migration's header).
 *
 * THE CALLER DECIDES. `p_own_rows_only` is true only from publish's
 * superseded branch, which asked the rule once; the patch never asks it
 * again (see this file's header). The one-argument form is dropped so nothing
 * can call the patch without saying which it is.
 */
DROP FUNCTION IF EXISTS public.apply_builder_stock_pending_patch(uuid);

CREATE FUNCTION public.apply_builder_stock_pending_patch(p_upload_id uuid, p_own_rows_only boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_patched integer := 0;
BEGIN
  UPDATE public.builder_stock_items AS i
     SET external_reference = CASE WHEN i.pending_patch ? 'external_reference'
                                   THEN i.pending_patch->>'external_reference' ELSE i.external_reference END,
         development_name   = CASE WHEN i.pending_patch ? 'development_name'
                                   THEN i.pending_patch->>'development_name' ELSE i.development_name END,
         project_name       = CASE WHEN i.pending_patch ? 'project_name'
                                   THEN i.pending_patch->>'project_name' ELSE i.project_name END,
         address_line       = CASE WHEN i.pending_patch ? 'address_line'
                                   THEN i.pending_patch->>'address_line' ELSE i.address_line END,
         suburb             = CASE WHEN i.pending_patch ? 'suburb'
                                   THEN i.pending_patch->>'suburb' ELSE i.suburb END,
         state              = CASE WHEN i.pending_patch ? 'state'
                                   THEN i.pending_patch->>'state' ELSE i.state END,
         postcode           = CASE WHEN i.pending_patch ? 'postcode'
                                   THEN i.pending_patch->>'postcode' ELSE i.postcode END,
         lot_number         = CASE WHEN i.pending_patch ? 'lot_number'
                                   THEN i.pending_patch->>'lot_number' ELSE i.lot_number END,
         unit_number        = CASE WHEN i.pending_patch ? 'unit_number'
                                   THEN i.pending_patch->>'unit_number' ELSE i.unit_number END,
         bedrooms           = CASE WHEN i.pending_patch ? 'bedrooms'
                                   THEN (i.pending_patch->>'bedrooms')::numeric ELSE i.bedrooms END,
         bathrooms          = CASE WHEN i.pending_patch ? 'bathrooms'
                                   THEN (i.pending_patch->>'bathrooms')::numeric ELSE i.bathrooms END,
         car_spaces         = CASE WHEN i.pending_patch ? 'car_spaces'
                                   THEN (i.pending_patch->>'car_spaces')::numeric ELSE i.car_spaces END,
         property_type      = CASE WHEN i.pending_patch ? 'property_type'
                                   THEN i.pending_patch->>'property_type' ELSE i.property_type END,
         land_size_sqm      = CASE WHEN i.pending_patch ? 'land_size_sqm'
                                   THEN (i.pending_patch->>'land_size_sqm')::numeric ELSE i.land_size_sqm END,
         building_size_sqm  = CASE WHEN i.pending_patch ? 'building_size_sqm'
                                   THEN (i.pending_patch->>'building_size_sqm')::numeric ELSE i.building_size_sqm END,
         price              = CASE WHEN i.pending_patch ? 'price'
                                   THEN (i.pending_patch->>'price')::numeric ELSE i.price END,
         price_display      = CASE WHEN i.pending_patch ? 'price_display'
                                   THEN i.pending_patch->>'price_display' ELSE i.price_display END,
         expected_completion= CASE WHEN i.pending_patch ? 'expected_completion'
                                   THEN i.pending_patch->>'expected_completion' ELSE i.expected_completion END,
         description        = CASE WHEN i.pending_patch ? 'description'
                                   THEN i.pending_patch->>'description' ELSE i.description END,
         availability_status= CASE WHEN i.pending_patch ? 'availability_status'
                                   THEN i.pending_patch->>'availability_status' ELSE i.availability_status END,
         builder_project_id = CASE WHEN i.pending_patch ? 'builder_project_id'
                                   THEN (i.pending_patch->>'builder_project_id')::uuid ELSE i.builder_project_id END,
         builder_unit_id    = CASE WHEN i.pending_patch ? 'builder_unit_id'
                                   THEN (i.pending_patch->>'builder_unit_id')::uuid ELSE i.builder_unit_id END,
         source_row         = coalesce(i.pending_patch->'source_row', i.source_row),
         upload_id          = p_upload_id,
         last_seen_at       = now(),
         pending_patch      = NULL,
         pending_upload_id  = NULL,
         updated_at         = now()
   WHERE i.pending_upload_id = p_upload_id
     AND (NOT p_own_rows_only OR i.upload_id = p_upload_id);
  GET DIAGNOSTICS v_patched = ROW_COUNT;
  RETURN v_patched;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_builder_stock_pending_patch(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_builder_stock_pending_patch(uuid, boolean) TO service_role;

-- ── Publish decides supersession once and hands the answer to the patch ──────
/*
 * `20260922070000`'s body, reproduced whole because that is how this
 * repository replaces a function. The only difference is the second argument
 * of its three calls to `apply_builder_stock_pending_patch`: `true` in the
 * superseded branch, which is the one place the rule was asked, and `false`
 * in the two branches reached only because it answered no.
 */
CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload(p_upload_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ready boolean;
  v_partial boolean;
  v_first boolean;
  v_staged bigint;
  v_outstanding bigint;
  v_missing bigint;
  v_failed bigint;
  v_ready_items bigint;
  v_replaces uuid[];
  v_published integer := 0;
  v_archived integer := 0;
  v_patched integer := 0;
  v_withheld integer := 0;
  v_deleted timestamptz;
  v_already timestamptz;
  v_reason text;
  v_mode text;
BEGIN
  SELECT deleted_at, published_at INTO v_deleted, v_already
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  -- A deleted upload is not a stock list, and a superseded one is somebody's
  -- abandoned draft. Neither may move the Marketplace. Asked BEFORE the
  -- already-published branch, because a late promotion must answer to them too.
  IF v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('published', false, 'reason', 'deleted');
  END IF;

  IF public.builder_stock_upload_superseded(p_upload_id) THEN
    /*
     * AND THE HELD-BACK PATCH IS APPLIED HERE TOO, FOR THE SAME REASON AS
     * THE BRANCH BELOW.
     *
     * The previous migration moved the patch above `already_published` and
     * left it below this one, which is the other return a second publication
     * of the same upload can take — and the broader of the two, because
     * `builder_stock_upload_superseded` is satisfied by ANY later
     * non-deleted upload in the organisation, related or not. A builder who
     * uploads a second, unrelated stock list therefore makes every earlier
     * list permanently uncorrectable: a re-read writes the right values into
     * `pending_patch`, asks to publish, is told `superseded`, and nothing
     * anywhere will ever apply them.
     *
     * MEASURED 22 SEPTEMBER 2026 in the acceptance gate, which counts
     * stranded patches as one of its named zeroes: TWELVE rows carrying a
     * held-back patch whose upload answers `superseded`, across eleven
     * documents in three organisations. Calling the function by hand on one
     * of them returns `{"reason": "superseded", "published": false}` and
     * applies nothing, exactly as `already_published` did for Crowlea Estate.
     *
     * WHY IT IS SAFE, AND WHY THE RETURN STAYS. What this guard protects is
     * the MARKETPLACE: an abandoned draft must not promote its staged rows
     * or archive somebody else's. Applying a patch does neither. It is keyed
     * on `pending_upload_id = p_upload_id`, so it touches only rows THIS
     * upload is holding values for, and a row a newer list matched has
     * already had its `pending_patch` overwritten by that list's own import —
     * so a row still carrying this upload's patch is one this upload still
     * supplies. The promote and archive steps below are untouched and stay
     * behind the return.
     */
    v_patched := public.apply_builder_stock_pending_patch(p_upload_id, true);
    RETURN jsonb_build_object(
      'published', false, 'reason', 'superseded', 'patched', v_patched);
  END IF;

  SELECT staged, source_outstanding, missing_primary, failed_items,
         ready, ready_items, first_publication, partial_ready
    INTO v_staged, v_outstanding, v_missing, v_failed,
         v_ready, v_ready_items, v_first, v_partial
    FROM public.builder_stock_publication_readiness(p_upload_id);

  /*
   * ALREADY PUBLISHED IS NOT ALWAYS NOTHING LEFT TO DO.
   *
   * A first publication leaves the un-ready properties staged, so the case
   * this branch used to swallow is the one that matters most: the builder
   * goes and fixes the row the list told them about, it settles with their
   * own photograph, `publishUploadIfReady` is called on the next completed
   * item — and the answer was `already_published`, for ever. The property
   * they had just repaired would never reach the marketplace and nothing
   * anywhere would say why.
   *
   * Only for a FIRST publication. A published replacement has no staged rows
   * left (its cutover promoted all of them) and must never grow a second one.
   */
  IF v_already IS NOT NULL THEN
    /*
     * THE HELD-BACK PATCH IS APPLIED FIRST, AND BEFORE ANY RETURN.
     *
     * A second publication of the SAME upload is what a re-read produces, and
     * this branch used to return above the only step that applies a patch —
     * so a corrected reading was written to `pending_patch` and stranded
     * there permanently. Keyed on this upload's own held-back rows, so it can
     * move nothing that belongs to another list, and it changes no
     * membership: the promote below is untouched.
     */
    v_patched := public.apply_builder_stock_pending_patch(p_upload_id, false);

    IF NOT coalesce(v_first, false) THEN
      RETURN jsonb_build_object(
        'published', false, 'reason', 'already_published', 'patched', v_patched);
    END IF;

    UPDATE public.builder_stock_items
       SET lifecycle_status = 'active', updated_at = now()
     WHERE upload_id = p_upload_id
       AND lifecycle_status = 'staged'
       AND image_work_stage = 'settled'
       AND public.builder_stock_photo_is_source_ready(primary_image_id);
    GET DIAGNOSTICS v_published = ROW_COUNT;

    IF v_published = 0 THEN
      RETURN jsonb_build_object(
        'published', false, 'reason', 'already_published', 'patched', v_patched);
    END IF;

    SELECT count(*) INTO v_withheld
      FROM public.builder_stock_items
     WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';

    v_reason := CASE WHEN v_withheld > 0 THEN format(
      '%s of %s properties are live; %s still needs a photograph from you',
      coalesce(v_staged, 0) - v_withheld, coalesce(v_staged, 0), v_withheld) END;
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason,
           image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END,
           updated_at = now()
     WHERE id = p_upload_id;

    BEGIN
      PERFORM public.record_portal_operational_event(
        'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
        'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
        jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                           'withheld', v_withheld, 'mode', 'late'));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- telemetry must never fail a cutover
    END;

    RETURN jsonb_build_object(
      'published', true, 'mode', 'late', 'promoted', v_published,
      'patched', v_patched, 'archived', 0, 'withheld', v_withheld);
  END IF;

  IF coalesce(v_ready, false) THEN
    v_mode := 'atomic';
  ELSIF coalesce(v_partial, false) THEN
    v_mode := 'first_publication';
  ELSE
    /*
     * REFUSED, AND THE REASON SAYS WHICH KIND OF REFUSAL IT IS. A first list
     * with nothing ready yet is a different sentence from a replacement
     * holding back for one bad row, and an operator reading the upload row
     * should not have to infer which.
     */
    v_reason := CASE
      WHEN coalesce(v_first, false) AND coalesce(v_ready_items, 0) = 0 THEN format(
        'awaiting source photographs: no property of %s has a ready builder-source photo yet, %s failed, %s still reading their source',
        coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0))
      ELSE format(
        'awaiting source photographs: %s of %s properties without a ready builder-source photo, %s failed, %s still reading their source',
        coalesce(v_missing, 0), coalesce(v_staged, 0), coalesce(v_failed, 0), coalesce(v_outstanding, 0))
    END;
    UPDATE public.builder_stock_uploads
       SET publication_blocked_reason = v_reason, updated_at = now()
     WHERE id = p_upload_id
       AND publication_blocked_reason IS DISTINCT FROM v_reason;
    RETURN jsonb_build_object(
      'published', false, 'reason', 'not_ready',
      'staged', coalesce(v_staged, 0), 'source_outstanding', coalesce(v_outstanding, 0),
      'missing_primary', coalesce(v_missing, 0), 'failed_items', coalesce(v_failed, 0),
      'ready_items', coalesce(v_ready_items, 0),
      'first_publication', coalesce(v_first, false));
  END IF;

  SELECT coalesce(replaces_upload_ids, '{}') INTO v_replaces
    FROM public.builder_stock_uploads WHERE id = p_upload_id;

  /*
   * 1. APPLY EVERY HELD-BACK PATCH — FIRST, and the order is load-bearing.
   *
   * This is what re-points a matched row's `upload_id` to this upload, and step
   * 3 archives by `upload_id`. Do it after, and every kept property would look
   * like a removed one.
   *
   * EVERY COLUMN IS NAMED. A `jsonb_populate_record` over the whole row would
   * let whatever ended up in that column write any field of the table, which is
   * mass assignment through a jsonb door.
   *
   * AND EVERY COLUMN ANSWERS TO KEY PRESENCE. `?` is strictly true or false
   * and is the only thing that tells a patch which STATES NOTHING for a
   * column apart from a patch which does not mention it — see this
   * migration's header.
   */
  v_patched := public.apply_builder_stock_pending_patch(p_upload_id, false);

  /*
   * 2. Promote this upload's staged rows THAT EARNED THEIR PHOTOGRAPH.
   *
   * Under `atomic` this filter is satisfied by every staged row — that is
   * what `ready` means — so a replacement's cutover is byte-for-byte the
   * behaviour it has always had. Under `first_publication` it is the whole
   * point: 46 go live and the one whose documents name somebody else's
   * property stays staged, in Action Required, where the builder can see it.
   */
  UPDATE public.builder_stock_items
     SET lifecycle_status = 'active', updated_at = now()
   WHERE upload_id = p_upload_id
     AND lifecycle_status = 'staged'
     AND image_work_stage = 'settled'
     AND public.builder_stock_photo_is_source_ready(primary_image_id);
  GET DIAGNOSTICS v_published = ROW_COUNT;

  SELECT count(*) INTO v_withheld
    FROM public.builder_stock_items
   WHERE upload_id = p_upload_id AND lifecycle_status = 'staged';

  -- 3. Archive what the superseded uploads still supply. Anything still
  --    carrying one of their ids is a property the new list did not contain.
  IF array_length(v_replaces, 1) IS NOT NULL THEN
    UPDATE public.builder_stock_items
       SET lifecycle_status = 'archived', updated_at = now()
     WHERE lifecycle_status = 'active'
       AND upload_id = ANY(v_replaces)
       AND upload_id <> p_upload_id;
    GET DIAGNOSTICS v_archived = ROW_COUNT;
  END IF;

  /*
   * THE BLOCKED REASON STAYS HONEST, AND `image_failure_state` STAYS SET.
   *
   * A first publication that withheld rows is published AND still owes the
   * builder something. Clearing both — as the atomic path rightly does when
   * it publishes everything — would take away the only thing on the Stock
   * List telling them a property of theirs is not on the marketplace.
   */
  UPDATE public.builder_stock_uploads
     SET published_at = now(),
         publication_blocked_reason = CASE WHEN v_withheld > 0 THEN format(
           '%s of %s properties are live; %s still needs a photograph from you',
           v_published, coalesce(v_staged, 0), v_withheld) END,
         image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END,
         updated_at = now()
   WHERE id = p_upload_id AND published_at IS NULL;

  BEGIN
    PERFORM public.record_portal_operational_event(
      'builder_stock_upload_published', 'info', gen_random_uuid(), NULL,
      'system', NULL, 'builder', NULL, NULL, NULL, NULL, true,
      jsonb_build_object('upload_id', p_upload_id, 'promoted', v_published,
                         'patched', v_patched, 'archived', v_archived,
                         'withheld', v_withheld, 'mode', v_mode));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- telemetry must never fail a cutover
  END;

  RETURN jsonb_build_object(
    'published', true, 'mode', v_mode, 'promoted', v_published,
    'patched', v_patched, 'archived', v_archived, 'withheld', v_withheld);
END;
$function$;
