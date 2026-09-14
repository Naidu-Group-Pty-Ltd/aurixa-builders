-- Builder stock — the THIRD settlement concern: taking the marketing sticker
-- off a builder's own photograph.
--
-- WHAT WAS BROKEN. A builder supplies the exact photograph of the exact
-- property and lays a promotional graphic over it — "Completed", "SMSF",
-- "$25,000 Rebate", a suburb banner. Provenance is perfect, ownership is
-- perfect, the source designated it as the listing image, and the display gate
-- correctly refuses it, so the card shows nothing. The client is shown no house
-- because the builder put a sticker on the picture of it.
--
-- WHAT FIXES IT. The graphic is removed from the builder's own file and the
-- result is stored ONCE as a versioned derivative. Nothing else is ever an
-- input: not a map, not a street view, not a search result, not stock imagery,
-- not another property, not a generated house. The two routes and their gates
-- are in `_shared/builderStock/sanitizeImage.ts`; what this migration adds is
-- only the machinery that gets the work DONE for stock already imported.
--
-- WHY A THIRD MARKER RATHER THAN REUSING ONE. There are now three questions
-- about a stored image and they improve on three different days:
--
--   source_images_settled_version            where did these bytes come from,
--                                            and what did the source present
--                                            them as
--   marketplace_eligibility_settled_version  may the picture be drawn
--   image_sanitization_settled_version       and where it may not, can the
--                                            thing stopping it be removed
--
-- Overloading either of the first two would mean a better overlay repair
-- re-fetching every Notion page, or a better classifier re-running every
-- repair — and a repair costs a full-resolution decode and, on the hard ones, a
-- model call. They are versioned apart for the same reason the first two are.
--
-- WHAT THIS DOES NOT DO. It rewrites no stored image: a derivative is a NEW
-- object beside the original, and the original's bytes, hashes, provenance and
-- display verdict are left exactly as they are. It creates and deletes no stock
-- item and touches no price, availability, configuration, status, selection,
-- builder or project linkage.

BEGIN;

-- ── The marker ──────────────────────────────────────────────────────────────

ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS image_sanitization_settled_version integer;

COMMENT ON COLUMN public.builder_stock_uploads.image_sanitization_settled_version IS
  'The overlay-removal version this upload''s images have been through. Below '
  'builder_stock_settlement_target.image_sanitization_version means a sweep is '
  'outstanding. Independent of the provenance and display-eligibility markers: '
  'a better repair must not re-fetch sources, and a better classifier must not '
  're-run repairs.';

CREATE INDEX IF NOT EXISTS builder_stock_uploads_sanitization_marker_idx
  ON public.builder_stock_uploads (image_sanitization_settled_version)
  WHERE deleted_at IS NULL;

-- ── The target ──────────────────────────────────────────────────────────────

ALTER TABLE public.builder_stock_settlement_target
  ADD COLUMN IF NOT EXISTS image_sanitization_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.builder_stock_settlement_target.image_sanitization_version IS
  'The Builder Stock overlay-removal version production is being brought to. '
  'Raised by set_builder_stock_sanitization_target() in the same deployment as '
  'a SANITIZATION_VERSION bump.';

/**
 * Raise the overlay-removal target and make sure something is driving it.
 *
 * Monotonic by construction, for the reason
 * `set_builder_stock_eligibility_target` records: migrations run in an
 * unpredictable order against a restored snapshot, and a target that can go
 * DOWN silently marks an outstanding sweep as finished.
 *
 * And it reschedules the job, because the sweep removes itself when the queue
 * empties. A target nobody is acting on is a number in a table.
 */
CREATE OR REPLACE FUNCTION public.set_builder_stock_sanitization_target(p_version integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_version integer;
BEGIN
  INSERT INTO public.builder_stock_settlement_target (id, image_sanitization_version)
  VALUES (true, p_version)
  ON CONFLICT (id) DO UPDATE
    SET image_sanitization_version =
          GREATEST(public.builder_stock_settlement_target.image_sanitization_version,
                   EXCLUDED.image_sanitization_version),
        updated_at = now()
  RETURNING image_sanitization_version INTO v_version;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.schedule(
        'settle-builder-stock-marketplace-eligibility',
        '*/5 * * * *',
        $job$SELECT public.settle_builder_stock_marketplace_eligibility_tick();$job$
      );
    END IF;
  END IF;

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.set_builder_stock_sanitization_target(integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_builder_stock_sanitization_target(integer)
  TO postgres, service_role;

COMMENT ON FUNCTION public.set_builder_stock_sanitization_target(integer) IS
  'Raise the Builder Stock overlay-removal target (never lowers it) and '
  'reschedule the settlement sweep if it had unscheduled itself. Call this from '
  'the same migration that ships a SANITIZATION_VERSION bump.';

-- ── The tick counts the third concern too ───────────────────────────────────

/**
 * One tick of the deployment repair, now over three markers.
 *
 * The sweep is ONE job driving one edge function; what changes is what counts
 * as outstanding. An upload behind on any of the three has work, and the job
 * unschedules itself only when none of the three has any — otherwise shipping
 * an overlay repair would raise a target that nothing was scheduled to act on,
 * which is the exact failure the eligibility target was introduced to fix.
 */
CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_outstanding integer;
  v_target integer;
  v_sanitization integer;
BEGIN
  SELECT marketplace_eligibility_version, image_sanitization_version
    INTO v_target, v_sanitization
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);
  v_sanitization := coalesce(v_sanitization, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
          OR coalesce(image_sanitization_settled_version, -1) < v_sanitization
          OR source_images_settled_version IS NULL);

  IF v_outstanding = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  PERFORM public.cron_invoke_signed_function(
    'builder-stock-image-settler', '{}'::jsonb, 'pg_cron');
END;
$$;

/*
 * AND IT IS ACTUALLY RESTRICTED, WHICH IT WAS NOT.
 *
 * The migration that introduced this tick declared it SECURITY DEFINER and said
 * in its comment that it was "restricted to postgres/service_role" — and never
 * revoked anything. `CREATE` grants EXECUTE to PUBLIC by default, so the live
 * ACL read `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`:
 * PUBLIC and `anon` both held it. Anyone with the publishable key in the browser
 * bundle could call a definer-rights function that fires an internal edge
 * function through `cron_invoke_signed_function`.
 *
 * `CREATE OR REPLACE` preserves existing grants, so re-creating it here would
 * have carried that forward silently. Revoking from `anon` alone is a no-op
 * while PUBLIC holds it, which is why this names PUBLIC first.
 */
REVOKE ALL ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
  TO postgres, service_role;

COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'One tick of the Builder Stock image deployment repair. Invokes '
  'builder-stock-image-settler while any upload is behind on provenance, '
  'display eligibility or overlay removal, then unschedules its own cron job. '
  'Restricted to postgres/service_role.';

-- ── This deployment's target ────────────────────────────────────────────────
--
-- MUST EQUAL `SANITIZATION_VERSION` in
-- `_shared/builderStock/sanitizedDerivative.pure.ts`. A bump ships both halves
-- in one deployment; a test reads this file and fails when they disagree.
SELECT public.set_builder_stock_sanitization_target(1);

COMMIT;
