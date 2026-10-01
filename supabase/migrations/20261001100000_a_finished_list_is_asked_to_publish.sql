/*
 * A FINISHED LIST IS ASKED TO PUBLISH, AND ITS BLOCKERS ARE NAMED.
 *
 * MEASURED 30 SEPTEMBER 2026: 41 properties, every one settled with a ready
 * builder photograph, held off the marketplace by a list-level gate (a source
 * manifest our database refused to record). Two things made it invisible and
 * permanent:
 *
 *   - publication is asked only when a PROPERTY finishes, so a list held by a
 *     list-level gate after its last property settled is never asked again;
 *   - the page could not see the list-level gates, so it said "goes live once
 *     every property has a photo" over 41 photographs.
 *
 * 1. `builder_stock_uploads_awaiting_publication(limit)` names lists whose
 *    import has finished and whose every property has finished its photo work
 *    while something is still staged or held back for them. The settler's
 *    housekeeping asks `publish_builder_stock_upload` about each, every tick
 *    (`publicationSweep.ts`). It decides nothing: the readiness rule and the
 *    cutover stay inside the publish function, untouched.
 * 2. `builder_stock_image_progress` also returns `pending_assets` — source
 *    files no worker has answered — so the page can name the one list-level
 *    gate it could not see (`publicationBlockers.pure.ts`).
 *
 * Scoped by state, never by organisation; each function is rehearsed below.
 */

CREATE OR REPLACE FUNCTION public.builder_stock_uploads_awaiting_publication(p_limit integer DEFAULT 5)
RETURNS TABLE(upload_id uuid, organisation_id uuid, manifest_state text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT u.id, u.organisation_id, u.source_manifest_state
    FROM public.builder_stock_uploads AS u
   WHERE u.deleted_at IS NULL
     AND coalesce(u.status, '') NOT IN ('uploaded', 'parsing', 'failed')
     AND EXISTS (
       SELECT 1 FROM public.builder_stock_items AS i
        WHERE (i.upload_id = u.id AND i.lifecycle_status = 'staged')
           OR i.pending_upload_id = u.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.builder_stock_items AS i
        WHERE ((i.upload_id = u.id AND i.lifecycle_status = 'staged')
           OR i.pending_upload_id = u.id)
          AND i.image_work_stage NOT IN ('settled', 'failed'))
   ORDER BY random()
   LIMIT greatest(1, least(coalesce(p_limit, 5), 50));
$$;

COMMENT ON FUNCTION public.builder_stock_uploads_awaiting_publication(integer) IS
  'Lists whose import finished and whose every staged or held-back property finished its photo work. Asked to publish by the settler every tick; decides nothing itself.';
REVOKE ALL ON FUNCTION public.builder_stock_uploads_awaiting_publication(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_uploads_awaiting_publication(integer) TO service_role;

DROP FUNCTION IF EXISTS public.builder_stock_image_progress(uuid);
CREATE FUNCTION public.builder_stock_image_progress(p_organisation_id uuid)
RETURNS TABLE(
  upload_id uuid,
  total bigint,
  photos_ready bigint,
  failed bigint,
  working bigint,
  manifest_state text,
  failure_state text,
  blocked_reason text,
  published boolean,
  pending_assets bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT
    u.id AS upload_id,
    count(i.id) AS total,
    count(i.id) FILTER (
      WHERE public.builder_stock_photo_is_source_ready(i.primary_image_id)
    ) AS photos_ready,
    count(i.id) FILTER (WHERE i.image_work_stage = 'failed') AS failed,
    count(i.id) FILTER (
      WHERE i.image_work_stage NOT IN ('settled', 'failed')
    ) AS working,
    u.source_manifest_state AS manifest_state,
    u.image_failure_state AS failure_state,
    u.publication_blocked_reason AS blocked_reason,
    u.published_at IS NOT NULL AS published,
    (SELECT count(*) FROM public.builder_stock_source_assets AS a
      WHERE a.upload_id = u.id AND a.state = 'pending') AS pending_assets
  FROM public.builder_stock_uploads AS u
  LEFT JOIN public.builder_stock_items AS i
    ON (i.upload_id = u.id OR i.pending_upload_id = u.id)
   AND i.lifecycle_status IN ('active', 'staged')
  WHERE u.organisation_id = p_organisation_id
    AND u.deleted_at IS NULL
    AND (u.published_at IS NULL OR u.updated_at > now() - interval '2 days')
  GROUP BY u.id, u.source_manifest_state, u.image_failure_state,
           u.publication_blocked_reason, u.published_at, u.created_at
  ORDER BY u.created_at DESC;
$$;

COMMENT ON FUNCTION public.builder_stock_image_progress(uuid) IS
  'Per-upload photo progress for the builder portal banner, with the source files still pending so a list-level publish blocker can be named.';
REVOKE ALL ON FUNCTION public.builder_stock_image_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_progress(uuid) TO service_role;

-- THE REHEARSAL: both functions over a synthetic finished list, rolled back.
DO $$
DECLARE
  v_org uuid; v_upload uuid; v_item uuid; v_found integer; v_progress record;
BEGIN
  BEGIN
    INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
    VALUES ('Publication Sweep Rehearsal Org', 'builder', 'active', true, now())
    RETURNING id INTO v_org;
    INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
    VALUES (v_org, 'rehearsal.csv', 'rehearsal/rehearsal.csv', 'complete')
    RETURNING id INTO v_upload;
    INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb, image_work_stage)
    VALUES (v_org, v_upload, 'staged', '1 Rehearsal Road', 'Truganina', 'settled')
    RETURNING id INTO v_item;

    SELECT count(*) INTO v_found
      FROM public.builder_stock_uploads_awaiting_publication(50) AS w
     WHERE w.upload_id = v_upload;
    IF v_found <> 1 THEN
      RAISE EXCEPTION 'rehearsal: a finished staged list was not offered to the sweep (%)', v_found;
    END IF;

    UPDATE public.builder_stock_items SET image_work_stage = 'source' WHERE id = v_item;
    SELECT count(*) INTO v_found
      FROM public.builder_stock_uploads_awaiting_publication(50) AS w
     WHERE w.upload_id = v_upload;
    IF v_found <> 0 THEN
      RAISE EXCEPTION 'rehearsal: a list with a property still working was offered to the sweep';
    END IF;

    SELECT * INTO v_progress FROM public.builder_stock_image_progress(v_org) LIMIT 1;
    IF v_progress.total <> 1 OR v_progress.pending_assets IS NULL THEN
      RAISE EXCEPTION 'rehearsal: image progress did not read the list (% / %)',
        v_progress.total, v_progress.pending_assets;
    END IF;
    RAISE EXCEPTION 'rehearsal-complete';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rehearsal-complete' THEN RAISE; END IF;
  END;
END;
$$;
