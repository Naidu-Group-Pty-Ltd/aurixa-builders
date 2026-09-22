-- ============================================================================
-- AN IMPORT TOO BIG FOR ONE ISOLATE HANDS OFF RATHER THAN DYING
-- ============================================================================
--
-- MEASURED 22 September 2026, production, a real customer upload:
-- `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`, 8,530,307 bytes.
--
--     10:05:56.792  processing started
--     10:06:01.915  deterministic reading complete — 11 fields read
--     10:06:04.895  POST builder-portal-stock -> 546  CPU Time exceeded
--
-- The row it left behind: `status: imported`, `records_detected: 0`,
-- `processing_completed_at: null`, one stored image, and a property that
-- existed while the upload said none did. The 15-minute recovery would have
-- repaired the counts at ~10:20:57. Fifteen minutes is not a customer
-- experience; it is a backstop that had become the plan.
--
-- The profiling behind this
-- (`docs/builder-portal/54-what-the-importer-spends.md`) says the importer has
-- exactly TWO expensive stages: recognising a scanned page (~3,100 ms each)
-- and storing a picture (~1,500 ms each). Everything else is tens of
-- milliseconds. So the split is not three functions; it is two rules:
--
--   • The RASTER class leaves the importer early. It already has somewhere to
--     go — the image settler, CPU-class-aware, claimed per item, dispatched
--     six wide by `builder_stock_kick_image_work`. Nothing in this migration
--     is needed for that half; it is a budget change in the edge function.
--
--   • The DOCUMENT class needs a continuation, and only for recognition. This
--     migration is that half: somewhere durable to put the pages already read,
--     an atomic claim so two workers can never read the same document at once,
--     and an immediate dispatch so the successor starts NOW.
--
-- ----------------------------------------------------------------------------
-- WHY THE MINUTE TICK IS NOT THE TRANSPORT
-- ----------------------------------------------------------------------------
--
-- `builder_stock_recover_stalled_imports()` below is called from the tick, and
-- that is RECOVERY, not stage transport. The normal path never reaches it: an
-- invocation that runs out of allowance dispatches its own successor before it
-- returns, the same way `builder_stock_kick_image_work` dispatches settlers.
-- The tick exists for the invocation that died without being able to say so —
-- an out-of-memory abort, a host that vanished — and it turns a fifteen-minute
-- gap into a sixty-second one for that case alone.
--
-- ----------------------------------------------------------------------------
-- WHY A RELEASE CAN NEVER REWIND
-- ----------------------------------------------------------------------------
--
-- The settler paid for this one: a release that named the stage it THOUGHT it
-- held walked a property back down its ladder when the stage had already
-- advanced. So `builder_stock_release_import` takes a TOKEN and writes nothing
-- but the claim, and only where the token is still the one on the row. A stale
-- worker's release is a no-op by construction rather than by timing, and the
-- checkpoint — which is progress — is never touched by a release at all.
-- ============================================================================

ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS import_checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS import_claim_token text,
  ADD COLUMN IF NOT EXISTS import_claim_until timestamptz,
  ADD COLUMN IF NOT EXISTS import_recovery_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.builder_stock_uploads.import_checkpoint IS
  'The minimum durable state that stops a resumed import paying twice: recognised page text, keyed on the digest of the document it came from. See supabase/functions/_shared/builderStock/importCheckpoint.pure.ts. A checkpoint whose digest does not match the bytes in hand is discarded whole, which is what makes re-reading a CHANGED linked source indistinguishable from a first read.';
COMMENT ON COLUMN public.builder_stock_uploads.import_claim_token IS
  'Which invocation currently holds this import. Opaque, minted per invocation. A release names it, so a stale worker cannot release a successor''s claim.';
COMMENT ON COLUMN public.builder_stock_uploads.import_recovery_attempts IS
  'How many times the recovery sweep has restarted this import. Bounded, because an import that dies three times is not one more dispatch away from working, and a minute-tick that keeps re-dispatching it is a loop nobody is watching. Reset when a person starts the import again.';
COMMENT ON COLUMN public.builder_stock_uploads.import_claim_until IS
  'When the current import claim expires. Invocation-sized, never generous: a lease is how long a DEAD worker blocks the work, and lengthening it is the opposite of a fix.';

-- Only rows that are actually claimed. The table is small; this exists so the
-- recovery scan below never reads the whole table on a quiet deployment.
CREATE INDEX IF NOT EXISTS builder_stock_uploads_import_claim_idx
  ON public.builder_stock_uploads (import_claim_until)
  WHERE import_claim_until IS NOT NULL AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- THE CLAIM
-- ----------------------------------------------------------------------------
-- One conditional UPDATE. Under READ COMMITTED a second writer blocks on the
-- row lock, then re-evaluates its WHERE against the version the first writer
-- committed — so it matches zero rows and returns false. Two workers can never
-- hold the same import, and no advisory lock, queue or lock table is needed to
-- say so.
CREATE OR REPLACE FUNCTION public.builder_stock_claim_import(
  p_upload_id     uuid,
  p_token         text,
  p_lease_seconds integer DEFAULT 90)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  IF p_upload_id IS NULL OR coalesce(p_token, '') = '' THEN
    RETURN false;
  END IF;

  UPDATE public.builder_stock_uploads
     SET import_claim_token = p_token,
         import_claim_until = now()
           + make_interval(secs => greatest(least(coalesce(p_lease_seconds, 90), 300), 10))
   WHERE id = p_upload_id
     AND deleted_at IS NULL
     -- Free, or held by a lease that has run out. NEVER "held by me": a
     -- worker re-claiming its own token would hide a double dispatch.
     AND (import_claim_until IS NULL OR import_claim_until < now());

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_claim_import(uuid, text, integer) IS
  'Atomically take the import claim on one upload, or answer false. The whole mutual exclusion between a primary import run, its successor, and the recovery sweep.';

-- ----------------------------------------------------------------------------
-- THE RELEASE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_stock_release_import(
  p_upload_id uuid,
  p_token     text)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_released boolean := false;
BEGIN
  IF p_upload_id IS NULL OR coalesce(p_token, '') = '' THEN
    RETURN false;
  END IF;

  UPDATE public.builder_stock_uploads
     SET import_claim_token = NULL,
         import_claim_until = NULL
   WHERE id = p_upload_id
     -- THE WHOLE SAFETY PROPERTY. A worker whose lease already expired, and
     -- whose work a successor has already taken over, names a token the row no
     -- longer carries — so its release changes nothing. Nothing else is
     -- written here: a release hands back a lease and never states progress.
     AND import_claim_token = p_token;

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_release_import(uuid, text) IS
  'Hand back an import claim, but only where the caller still holds it. Writes nothing but the claim, so a stale worker can never rewind work that has already advanced.';

-- ----------------------------------------------------------------------------
-- THE IMMEDIATE SUCCESSOR
-- ----------------------------------------------------------------------------
-- The existing trusted dispatcher, the same one the settler fan-out uses. No
-- second queue: `continue_import` is an operation on the function that already
-- owns importing, so there is exactly one implementation of reading a document.
CREATE OR REPLACE FUNCTION public.builder_stock_dispatch_import_continuation(
  p_upload_id uuid)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  IF p_upload_id IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    PERFORM public.cron_invoke_signed_function(
      'builder-portal-stock',
      jsonb_build_object('operation', 'continue_import', 'upload_id', p_upload_id),
      'import_continuation');
  EXCEPTION WHEN OTHERS THEN
    -- The ACCELERATOR, never the guarantee — the same contract
    -- `builder_stock_dispatch_image_workers` states. A missing vault entry or
    -- a pg_net hiccup costs one recovery cycle, never the import.
    RETURN false;
  END;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_dispatch_import_continuation(uuid) IS
  'Start the successor invocation of one import NOW, through the signed internal dispatcher. Best-effort: the recovery sweep reaches the same upload.';

-- ----------------------------------------------------------------------------
-- RECOVERY, WHICH IS NOT TRANSPORT
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_stock_stalled_imports()
RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
  SELECT count(*)
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status = 'parsing'
     -- IT WAS CLAIMED AND THE CLAIM IS GONE. That is what "a worker died"
     -- looks like, definitively, and it is a far better signal than the
     -- fifteen-minute clock `parseIsAbandoned` has to use — a clock cannot
     -- tell a running import from a dead one, and a lease can.
     AND u.import_claim_token IS NOT NULL
     AND (u.import_claim_until IS NULL OR u.import_claim_until < now())
     AND u.import_recovery_attempts < 3;
$$;

COMMENT ON FUNCTION public.builder_stock_stalled_imports() IS
  'Imports that were claimed, whose claim is gone, and whose status still says they are being read: a worker died without handing off. Counted so the minute tick stays armed while one exists, and bounded so a document that dies every time cannot loop.';

CREATE OR REPLACE FUNCTION public.builder_stock_recover_stalled_imports()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_row record;
  v_sent integer := 0;
BEGIN
  FOR v_row IN
    SELECT u.id
      FROM public.builder_stock_uploads u
     WHERE u.deleted_at IS NULL
       AND u.status = 'parsing'
       AND u.import_claim_token IS NOT NULL
       AND (u.import_claim_until IS NULL OR u.import_claim_until < now())
       -- BOUNDED. An import that has died three times is not one more
       -- dispatch away from working, and the fifteen-minute finalisation
       -- sweep remains behind this as it always was.
       AND u.import_recovery_attempts < 3
     ORDER BY u.updated_at
     -- Six, the same ceiling the settler fan-out uses and for the same
     -- reason: a backlog is a reason to work steadily, not to stampede.
     LIMIT 6
  LOOP
    -- COUNTED BEFORE THE DISPATCH, not after. A dispatch that succeeds and
    -- then dies leaves no trace of itself, so an attempt counted only on
    -- success is a counter that never moves on exactly the failure it bounds.
    UPDATE public.builder_stock_uploads
       SET import_recovery_attempts = import_recovery_attempts + 1
     WHERE id = v_row.id;
    IF public.builder_stock_dispatch_import_continuation(v_row.id) THEN
      v_sent := v_sent + 1;
    END IF;
  END LOOP;
  RETURN v_sent;
END;
$$;

COMMENT ON FUNCTION public.builder_stock_recover_stalled_imports() IS
  'Re-dispatch continuations for imports whose worker died without handing off. RECOVERY, not stage transport: the normal path dispatches its own successor before it returns, and never reaches this.';

REVOKE ALL ON FUNCTION public.builder_stock_claim_import(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_claim_import(uuid, text, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_release_import(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_release_import(uuid, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_dispatch_import_continuation(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_dispatch_import_continuation(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_stalled_imports()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_stalled_imports() TO service_role;
REVOKE ALL ON FUNCTION public.builder_stock_recover_stalled_imports()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_recover_stalled_imports()
  TO service_role;

-- ----------------------------------------------------------------------------
-- THE TICK LEARNS THE ONE NEW KIND OF STALLED WORK
-- ----------------------------------------------------------------------------
-- Two lines: run the recovery beside the other watchdogs, and count a stalled
-- import into the keep-alive sum so the tick cannot unschedule itself while
-- one is waiting. Everything else in this function is byte-identical to
-- `20260921080000`.

CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_target integer;
  v_sanitization integer;
  v_provenance integer;
  v_outstanding integer;
  v_fallback integer;
  v_item_work integer;
  v_publications integer;
  v_upload_completion integer;
  v_stranded integer;
  v_blocked integer;
  v_stalled_imports integer;
  v_dispatched integer;
BEGIN
  PERFORM public.builder_stock_image_watchdog();
  PERFORM public.publish_ready_builder_stock_uploads();
  PERFORM public.reopen_builder_stock_stranded_items();
  -- And the properties a superseded worker failed on, which the sibling above
  -- cannot see: it reopens on a changed ladder, this on a changed runtime.
  PERFORM public.reopen_builder_stock_runtime_failures();

  /*
   * AND THE IMPORT WHOSE WORKER DIED WITHOUT BEING ABLE TO SAY SO.
   *
   * RECOVERY, NOT STAGE TRANSPORT. An import that runs out of its CPU
   * allowance dispatches its own successor before it returns, and never
   * reaches this line. This is for the invocation that vanished — an
   * out-of-memory abort, a host that went away — where the only evidence is a
   * durable checkpoint under an expired claim. It turns the fifteen-minute
   * finalisation sweep into a sixty-second gap for that case alone.
   */
  PERFORM public.builder_stock_recover_stalled_imports();

  SELECT marketplace_eligibility_version, image_sanitization_version,
         source_images_version
    INTO v_target, v_sanitization, v_provenance
    FROM public.builder_stock_settlement_target
   LIMIT 1;
  v_target := coalesce(v_target, 0);
  v_sanitization := coalesce(v_sanitization, 0);
  v_provenance := coalesce(v_provenance, 0);

  SELECT count(*) INTO v_outstanding
    FROM public.builder_stock_uploads
   WHERE deleted_at IS NULL
     AND (coalesce(marketplace_eligibility_settled_version, -1) < v_target
          OR coalesce(image_sanitization_settled_version, -1) < v_sanitization
          OR coalesce(source_images_settled_version, -1) < v_provenance);

  SELECT count(*) INTO v_fallback
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND enrichment_status IN ('pending', 'enriching');

  SELECT count(*) INTO v_item_work
    FROM public.builder_stock_items
   WHERE lifecycle_status IN ('active', 'staged')
     AND image_work_stage <> ALL (ARRAY['settled', 'failed']);

  v_publications := public.builder_stock_publications_pending();

  SELECT count(*) INTO v_upload_completion
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status IN ('enriching', 'partially_complete')
     AND NOT EXISTS (
       SELECT 1
         FROM public.builder_stock_items it
        WHERE it.upload_id = u.id
          AND it.lifecycle_status = 'active'
          AND it.enrichment_status IN ('pending', 'enriching')
     );

  /*
   * AND AN IMPORT WHOSE RUN WAS KILLED BEFORE IT WROTE ITS OWN OUTCOME.
   *
   * `imported` is stamped before the properties are written, so it is a LIVE
   * status for the seconds an import spends writing them — which is why the
   * age test is here and not merely implied. An edge invocation cannot
   * outlive its own ceiling of roughly 150 seconds, so fifteen minutes
   * cannot mistake a running import for an abandoned one.
   *
   * An unreadable start stamp counts: every path that sets this status
   * stamps the start in the same write, so a row without one is not an
   * import in flight. Same rule, same direction, as `finalisationIsAbandoned`.
   */
  SELECT count(*) INTO v_stranded
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.status = 'imported'
     AND (u.processing_started_at IS NULL
          OR u.processing_started_at < now() - interval '15 minutes');

  -- A blocked invariant upload keeps the tick alive so the watchdog keeps
  -- stamping and a fixed pipeline resumes work without anything re-arming it.
  SELECT count(*) INTO v_blocked
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.image_invariant
     AND NOT public.builder_stock_upload_superseded(u.id)
     AND (u.published_at IS NULL OR EXISTS (
       SELECT 1 FROM public.builder_stock_items i
        WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'));

  -- A stalled import keeps the tick alive, for the same reason a stranded
  -- finalisation does: unscheduling here would leave the one case this
  -- recovery exists for waiting on the fifteen-minute sweep after all.
  v_stalled_imports := public.builder_stock_stalled_imports()::integer;

  IF v_outstanding + v_fallback + v_item_work + v_publications
     + v_upload_completion + v_stranded + v_blocked + v_stalled_imports = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  -- Steady-state top-up, at most four workers a minute. See `20260920050000`
  -- for the measurement that chose four; unchanged here.
  v_dispatched := public.builder_stock_dispatch_image_workers(4);

  /*
   * AND THE WORK THAT IS NOT IMAGE WORK STILL NEEDS A WORKER.
   *
   * Reaching this line means the keep-alive sum is non-zero: every return
   * above is taken when it is zero. So `v_dispatched = 0` says exactly "this
   * tick found work and started nobody" — which is now also the state a
   * stranded finalisation produces, since it makes no image work claimable.
   * One settler, which claims nothing, finds the item queue drained, falls
   * through to the upload sweep and runs every housekeeping pass the tick
   * owes — `recoverAbandonedFinalisations` and `settleCompletedUploads`
   * among them.
   */
  IF coalesce(v_dispatched, 0) = 0 THEN
    BEGIN
      PERFORM public.cron_invoke_signed_function(
        'builder-stock-image-settler', '{}'::jsonb, 'housekeeping');
    EXCEPTION WHEN OTHERS THEN
      -- Never fails the tick. Same rule, and the same reason, as the
      -- dispatcher's own loop.
      NULL;
    END;
  END IF;
END;
$function$;
