-- ===========================================================================
-- A WORKER WE KILLED MUST NOT BILL THE PROPERTY FOR IT.
-- ===========================================================================
--
-- MEASURED 22 SEPTEMBER 2026 on the production project. `Lot 52 - Bishop 258 -
-- Property Package.pdf` (upload `c5f139b9`) took **370 seconds** from upload
-- accepted to property published. About 28 seconds of that was work. The
-- whole of the rest descends from one line in `function_logs`:
--
--     08:25:19.958  source       -> eligibility   "stored 3, matched 1"
--     08:25:20.499  eligibility  -> sanitization  "assessed 0 of 1"
--     08:25:21.498  *** CPU Time exceeded ***  + shutdown
--
-- The settler had just claimed the same property for its next stage and was
-- killed by the runtime. A killed isolate runs no `finally`, so the claim
-- stood, and the recovery this file is about cost:
--
--     +120 s  the lease's full term (the settler's own fix shortens this)
--      +30 s  this function's grace, `claim_until < now() - '30 seconds'`
--      +11 s  the next `* * * * *` tick, which is what runs this function
--      +30 s  THE FAILURE BACKOFF THIS FUNCTION WROTE  <-- what changes here
--      +30 s  the next tick, which is what dispatches a worker
--
-- ===========================================================================
-- WHY THE BACKOFF IS THE WRONG ANSWER TO THE FIRST EXPIRY.
-- ===========================================================================
--
-- `claim_builder_stock_image_work`'s own body already argues this case, in
-- these words: "The old claim also wrote image_work_next_attempt_at = now() +
-- 30·2^attempts here, which meant a worker killed by the runtime — through no
-- fault of the property — parked a healthy row for up to an hour." That rule
-- was moved out of the claim and into this watchdog, where the evidence is —
-- and it arrived carrying the same defect for the FIRST expiry, which is
-- precisely the one that is indistinguishable from our own runtime reclaiming
-- an isolate.
--
-- A lease that expires once says nothing about the property. It says a worker
-- did not come back, and the overwhelmingly common reason for that in this
-- deployment is a resource ceiling reached by work the property did not ask
-- for: on the measured run, three CPU-heavy operations in one isolate, two of
-- which belonged to other stages.
--
-- A lease that expires AGAIN is different. The second expiry is the first
-- piece of evidence that this particular property is what kills workers, and
-- from there the bounded ladder runs exactly as it always has — 30 s, 60 s,
-- 120 s, 240 s, then flat 300 s, and the terminal ceiling at twelve failures
-- is untouched. So BACKOFF SEMANTICS ARE NOT DESTROYED; they are started one
-- observation later, on the first observation that is actually about the
-- property.
--
-- The failure is still COUNTED on the first expiry. Nothing about the ledger,
-- the terminal ceiling, or what an operator sees changes: only the wait.
--
-- ===========================================================================
-- AND THE TIMINGS, WHICH ARE WHY THIS INVESTIGATION TOOK AS LONG AS IT DID.
-- ===========================================================================
--
-- Every reading above had to be reconstructed from log lines and inferred
-- arithmetic, because nothing durable recorded WHAT A STAGE SPENT as distinct
-- from WHAT IT WAITED FOR. Two columns close that, and they hold timing and
-- provenance only — never a byte of a customer's document:
--
--   `builder_stock_items.image_work_timings`   one entry per completed stage
--   `builder_stock_uploads.stage_timings`      the import's own stage split
--
-- They are diagnostics and nothing reads them to make a decision. A
-- deployment that has not applied this migration is not degraded: the writes
-- are best-effort at the call site and every reading above is still logged.
-- ===========================================================================

ALTER TABLE public.builder_stock_items
  ADD COLUMN IF NOT EXISTS image_work_timings jsonb;
COMMENT ON COLUMN public.builder_stock_items.image_work_timings IS
  'Diagnostics only: per-stage {stage, work_class, ms, scheduler_wait_ms} for the most recent invocations. Timing and provenance only — never document content. Nothing reads this to make a decision.';

ALTER TABLE public.builder_stock_uploads
  ADD COLUMN IF NOT EXISTS stage_timings jsonb;
COMMENT ON COLUMN public.builder_stock_uploads.stage_timings IS
  'Diagnostics only: the import run''s own stage split in milliseconds (document_extract_ms, ocr_ms, normalise_ms, segmentation_ms, reader_ms, db_write_ms, image_extract_ms, total_ms and the counts of repeated expensive work). Timing and provenance only — never document content.';

CREATE OR REPLACE FUNCTION public.builder_stock_image_watchdog() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_reclaimed integer := 0;
  v_archived_closed integer := 0;
  v_reopened integer := 0;
  v_terminal integer := 0;
  v_attention integer := 0;
  v_upload record;
  v_ready boolean;
  v_missing bigint;
  v_failed bigint;
  v_state text;
  v_reason text;
BEGIN
  /*
   * a) A lease that expired is a worker that DIED — the one case the old
   *    claim-time backoff was designed for, now handled where the evidence
   *    is. Real failure: counted, bounded backoff, claim cleared.
   */
  UPDATE public.builder_stock_items AS i
     SET image_work_claim_until = NULL,
         image_work_failures = i.image_work_failures + 1,
         image_work_next_attempt_at = CASE
           /*
            * THE FIRST EXPIRY IS OURS, NOT THE PROPERTY'S. See this file's
            * header: a worker that did not come back has told us nothing
            * about the row it was holding, and on the measured run the row
            * had done nothing but sit in a claim for one second. Claimable
            * immediately; counted all the same.
            */
           WHEN i.image_work_failures = 0 THEN now()
           ELSE now() + public.builder_stock_failure_backoff(i.image_work_failures + 1)
         END,
         image_work_last_error = left('worker lease expired without completion; reclaimed by watchdog', 500),
         image_work_updated_at = now()
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND i.image_work_stage <> ALL (ARRAY['settled', 'failed'])
     AND i.image_work_claim_until IS NOT NULL
     AND i.image_work_claim_until < now() - interval '30 seconds';
  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

  /*
   * b) An archived row owes no image work: archiving closed its ladder.
   *    511 archived rows were sitting in non-settled stages — never claimable
   *    (the claim requires active/staged) yet impossible to distinguish from
   *    a backlog. Close them.
   */
  UPDATE public.builder_stock_items
     SET image_work_stage = 'settled',
         image_work_claim_until = NULL,
         image_work_updated_at = now()
   WHERE lifecycle_status = 'archived'
     AND image_work_stage <> 'settled';
  GET DIAGNOSTICS v_archived_closed = ROW_COUNT;

  /*
   * c) A SERVED-OR-STAGED PROPERTY SETTLED BLANK IS NEVER FINISHED. Whatever
   *    wrote 'settled' with no primary image converted our failure into "no
   *    photograph", which the product forbids. Re-open it — bounded: each
   *    reopen is a counted failure, and at the twelfth the item moves to
   *    'failed' (d below) where a person can see it, instead of churning.
   */
  UPDATE public.builder_stock_items AS i
     SET image_work_stage = 'source',
         enrichment_status = 'pending',
         image_work_failures = i.image_work_failures + 1,
         image_work_next_attempt_at = now(),
         image_work_claim_until = NULL,
         image_work_updated_at = now()
   WHERE i.id IN (
     SELECT c.id FROM public.builder_stock_items AS c
      WHERE c.lifecycle_status IN ('active', 'staged')
        AND c.image_work_stage = 'settled'
        AND c.primary_image_id IS NULL
        AND c.image_work_failures < 12
        AND c.image_work_updated_at < now() - interval '10 minutes'
      ORDER BY c.image_work_updated_at
      LIMIT 500
   );
  GET DIAGNOSTICS v_reopened = ROW_COUNT;

  UPDATE public.builder_stock_items AS i
     SET image_work_stage = 'failed',
         image_work_claim_until = NULL,
         image_work_last_result = left('image processing exhausted after repeated failures; requires intervention', 200),
         image_work_updated_at = now()
   WHERE i.lifecycle_status IN ('active', 'staged')
     AND i.image_work_stage = 'settled'
     AND i.primary_image_id IS NULL
     AND i.image_work_failures >= 12;
  GET DIAGNOSTICS v_terminal = ROW_COUNT;

  /*
   * d) Upload-level surfacing: an invariant upload stuck unpublished gets an
   *    honest state a person and an alert can act on. Events fire only on a
   *    TRANSITION, never every minute.
   */
  FOR v_upload IN
    SELECT u.id, u.image_failure_state
      FROM public.builder_stock_uploads AS u
     WHERE u.deleted_at IS NULL
       AND u.image_invariant
       AND u.created_at < now() - interval '10 minutes'
       /*
        * PUBLISHED IS NO LONGER THE SAME AS FINISHED. A first publication
        * puts the ready properties on the marketplace and leaves the rest
        * staged, so `published_at IS NULL` would drop exactly the uploads
        * that still owe their builder something — and this loop is what
        * pages a person when one of them goes wrong later.
        */
       AND (u.published_at IS NULL OR EXISTS (
         SELECT 1 FROM public.builder_stock_items i
          WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'))
       AND NOT public.builder_stock_upload_superseded(u.id)
  LOOP
    SELECT ready, missing_primary, failed_items
      INTO v_ready, v_missing, v_failed
      FROM public.builder_stock_publication_readiness(v_upload.id);
    IF coalesce(v_ready, false) THEN
      CONTINUE;
    END IF;
    /*
     * A published-and-settled upload owes nothing even though `ready` is
     * false for it: once its ready rows went live they left the staged
     * scope, so readiness answers about what REMAINS. Without this, a
     * finished first publication would be flagged `attention` for ever.
     */
    IF NOT EXISTS (
      SELECT 1 FROM public.builder_stock_items i
       WHERE i.upload_id = v_upload.id AND i.lifecycle_status = 'staged') THEN
      CONTINUE;
    END IF;
    v_state := CASE WHEN coalesce(v_failed, 0) > 0 THEN 'failed' ELSE 'attention' END;
    IF v_state IS DISTINCT FROM v_upload.image_failure_state THEN
      v_attention := v_attention + 1;
      v_reason := format('%s properties without a ready builder-source photo, %s failed',
                         coalesce(v_missing, 0), coalesce(v_failed, 0));
      UPDATE public.builder_stock_uploads
         SET image_failure_state = v_state,
             publication_blocked_reason = coalesce(publication_blocked_reason, v_reason),
             updated_at = now()
       WHERE id = v_upload.id;
      BEGIN
        PERFORM public.record_portal_operational_event(
          'builder_stock_publication_blocked',
          CASE WHEN v_state = 'failed' THEN 'critical' ELSE 'high' END,
          gen_random_uuid(), NULL, 'system', NULL, 'builder', NULL, NULL, NULL,
          NULL, false,
          jsonb_build_object('upload_id', v_upload.id, 'state', v_state, 'reason', v_reason));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END LOOP;

  IF v_reclaimed > 0 OR v_terminal > 0 THEN
    BEGIN
      PERFORM public.record_portal_operational_event(
        'builder_stock_image_watchdog_intervened',
        CASE WHEN v_terminal > 0 THEN 'high' ELSE 'warning' END,
        gen_random_uuid(), NULL, 'system', NULL, 'builder', NULL, NULL, NULL,
        NULL, false,
        jsonb_build_object('reclaimed_leases', v_reclaimed, 'reopened_blank', v_reopened,
                           'terminal_failed', v_terminal, 'archived_closed', v_archived_closed));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'reclaimed_leases', v_reclaimed,
    'archived_closed', v_archived_closed,
    'reopened_blank', v_reopened,
    'terminal_failed', v_terminal,
    'uploads_flagged', v_attention);
END;
$$;

REVOKE ALL ON FUNCTION public.builder_stock_image_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_image_watchdog() TO service_role;

-- ===========================================================================
-- ASSERTED BY EFFECT, AND NOT FROM INSIDE THIS FILE.
--
-- The rule this repository applies to the retention purge, the verification
-- self-test and the `manual_stats` shape constraint is that a control is
-- proved by what it DOES, never by what it says. A `CASE` read back out of
-- `pg_get_functiondef` proves the text was applied and nothing else.
--
-- But the probe does not belong here. Exercising it needs two rows in
-- `builder_stock_items`, and inserting one in this project fires the trigger
-- that schedules the settlement cron job; running the watchdog itself touches
-- every other deployment-wide row it is responsible for. A migration is the
-- wrong place to do either, and "roll it back inside a subtransaction" is a
-- clever way to do both anyway.
--
-- So the probe is `scripts/ops/probe-watchdog-backoff.mjs`, which runs against
-- the acceptance stack's real database — built from these same migrations —
-- and against production after the deploy. It inserts one row at each failure
-- count, runs the real function, reads the real `image_work_next_attempt_at`
-- back, and removes what it made. `run.sh` runs it in the gate.
-- ===========================================================================
