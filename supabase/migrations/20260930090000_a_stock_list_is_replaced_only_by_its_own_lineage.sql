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
 * THE RULE, THEN. An upload is superseded by a later, non-deleted upload of
 * its organisation that is
 *   * still being read (`processing_completed_at IS NULL`) — what it will take
 *     over is not known yet, so the old answer stands, exactly as before; or
 *   * one that existed before this migration — their meetings were never
 *     recorded, so every pre-existing upload keeps the old rule and no stored
 *     list changes state because of this file; or
 *   * in the same lineage.
 * Two lists that have never met on a property do not supersede each other,
 * and both publish.
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
REVOKE ALL ON TABLE public.builder_stock_upload_contacts FROM PUBLIC, anon, authenticated;
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
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE this AS (
    SELECT u.id, u.organisation_id, u.created_at
      FROM public.builder_stock_uploads u
     WHERE u.id = p_upload_id
  ),
  newer AS (
    SELECT n.id, n.processing_completed_at, n.lineage_recorded
      FROM public.builder_stock_uploads n
      JOIN this ON n.organisation_id = this.organisation_id
     WHERE n.id <> this.id
       AND n.deleted_at IS NULL
       AND n.created_at > this.created_at
  ),
  org_uploads AS (
    SELECT u.id, u.organisation_id, u.lineage_recorded, u.replaces_upload_ids
      FROM public.builder_stock_uploads u
      JOIN this ON u.organisation_id = this.organisation_id
  ),
  edges (a, b) AS (
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
     WHERE newer.processing_completed_at IS NULL
        OR NOT newer.lineage_recorded
        OR newer.id IN (SELECT id FROM lineage)
  );
$function$;

REVOKE ALL ON FUNCTION public.builder_stock_upload_superseded(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_upload_superseded(uuid) TO service_role;

-- ── A superseded draft corrects only the rows it supplies ───────────────────
/*
 * `20260921110000`'s body, unchanged but for `v_own_rows_only` and the last
 * line of the WHERE clause. Every column is still named and still answers to
 * key presence (see that migration's header).
 */
CREATE OR REPLACE FUNCTION public.apply_builder_stock_pending_patch(p_upload_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_patched integer := 0;
  v_own_rows_only boolean := public.builder_stock_upload_superseded(p_upload_id);
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
     AND (NOT v_own_rows_only OR i.upload_id = p_upload_id);
  GET DIAGNOSTICS v_patched = ROW_COUNT;
  RETURN v_patched;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_builder_stock_pending_patch(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_builder_stock_pending_patch(uuid) TO service_role;
