-- ===========================================================================
-- THE MINUTE TICK TOPS UP FOUR, BECAUSE TWO LEFT THE FLEET EMPTY FOR HALF A
-- MINUTE WITH WORK STANDING.
--
-- MEASURED IN PRODUCTION, 20 SEPTEMBER 2026. Upload
-- `aac89d49-c09f-400c-a484-51518ddc9e8a` — thirteen properties, a Google
-- Sheets list, thirteen linked brochures — was created at 04:17:16.836 and
-- published all thirteen at 04:19:22.462. Two minutes five point six seconds,
-- and the largest single item in it is nothing happening.
--
--   04:17:36.033  the import returns; `builder_stock_kick_image_work` fires
--   04:17:37.4    SIX settlers boot (the kick passes 6; claimable was 13, so
--                 `least(6, 6, ceil(13/2)) = 6`)
--   04:17:42.652  first PDF election starts
--   04:18:00.8    the minute tick dispatches TWO, on `p_max = 2`
--   04:18:26.314  the eleventh election finishes
--   04:18:30.377  the last settler of the wave shuts down, reporting
--                 `claimable: 4, outstanding: 4`
--   04:18:30.377  NOTHING IS RUNNING ANYWHERE, for 30.474 s
--   04:19:00.851  the next minute tick dispatches TWO
--   04:19:19.131  the thirteenth election finishes
--   04:19:22.462  published — promoted 13, archived 0
--
-- Between the first election start and the last election finish is 96.479 s,
-- and 56.912 s of it — 59.0% — had NO election in flight at all. The single
-- worst gap is 43.912 s (04:18:26.314 → 04:19:10.226), of which 30.474 s had
-- no settler process alive. Ten invocations were granted 1,000 s of budget
-- between them and used 277.1 s: 27.7%. Every one of the ten answered HTTP
-- 200. There was not a single 546, and no resource-limit kill of any kind.
--
-- So the fleet was not full, not throttled and not dying. It was ABSENT, and
-- the thing that decides whether it is absent is this line.
--
-- WHY FOUR AND NOT SIX. The dispatcher sizes itself:
--
--     v_n := least(greatest(coalesce(p_max, 0), 0), 6, ceil(v_claimable / 2.0)::integer);
--
-- At the 04:18 tick `claimable` was 8, so `ceil(8/2) = 4` and the third term
-- binds at four whatever `p_max` says above it: p_max 2 dispatches two, p_max
-- 4 dispatches four, p_max 6 dispatches four. FOUR IS THE WHOLE REMEDY FOR
-- THE MEASURED FAULT, and six buys nothing on this import.
--
-- What six would buy is a larger top-up on a bigger backlog, and that is
-- exactly the bet this change is not ready to make, because the tick OVERLAPS
-- the kick. At 04:18:00.85 all six of the 04:17:37 wave were still alive —
-- they ran until 04:18:05.36, 04:18:06.75, 04:18:10.70, 04:18:11.89,
-- 04:18:11.92 and 04:18:12.06 — so a four-wide tick already takes the
-- transient live count to about ten isolates. Ten is past anything this
-- deployment has measured. Four is the number the evidence supports; six is a
-- separate question with its own measurement, and it is not asked here.
--
-- WHAT THIS DOES NOT TOUCH, and each of these is load-bearing somewhere else:
--
--   * `builder_stock_kick_image_work` still passes 6. A fresh upload is a
--     burst and is meant to start six-wide; that is not the steady state.
--   * the dispatcher's global ceiling is still 6, and it is the ceiling this
--     change relies on — `p_max` cannot raise it.
--   * the `ceil(claimable / 2.0)` sizing rule is unchanged, and it is why
--     four is self-limiting: a four-wide cap dispatches four only when eight
--     or more properties are claimable, two at four, one at two.
--   * the settler's own 100 s `BUDGET_MS`, its 85 s `HEAVY_STAGE_RESERVE_MS`
--     and `HEAVY_DOCUMENTS_PER_INVOCATION` are untouched. Those decide how
--     much one invocation does; this decides how many there are.
--   * two Cloudflare PDF election lanes, unchanged. They were measured at
--     ~25% peak utilisation on this import and are not the constraint.
--   * the one-minute cron, unchanged.
--   * every image, publication, fallback and eligibility rule, unchanged.
--   * the two-attempt text-free cover budget, unchanged. This import made
--     thirteen elections and refused none, so it exercised none of it.
--
-- WHY THIS IS A NEW MIGRATION. `20260919110000_work_the_tick_found_can_start_
-- a_worker.sql` is the current last writer of this function and it stays
-- exactly as it is: it is applied history, its header records the
-- twenty-five-minute stall it fixed, and its own proof asserts the text it
-- installed. Editing it would make the repository disagree with what ran.
-- This file is the last writer now, in production and in a rebuild alike.
--
-- THE FUNCTION IS OTHERWISE BYTE-IDENTICAL to the definition that file
-- installed: the same watchdog and sweeps in the same order, the same six
-- keep-alive terms, the same unschedule, the same `v_dispatched = 0`
-- housekeeping fallback with the same exception wrapper. One integer moves.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_target integer;
  v_sanitization integer;
  v_provenance integer;
  v_outstanding integer;
  v_fallback integer;
  v_item_work integer;
  v_publications integer;
  v_upload_completion integer;
  v_blocked integer;
  v_dispatched integer;
BEGIN
  PERFORM public.builder_stock_image_watchdog();
  PERFORM public.publish_ready_builder_stock_uploads();
  PERFORM public.reopen_builder_stock_stranded_items();
  -- And the properties a superseded worker failed on, which the sibling above
  -- cannot see: it reopens on a changed ladder, this on a changed runtime.
  PERFORM public.reopen_builder_stock_runtime_failures();

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
          -- WAS `source_images_settled_version IS NULL`. An upload re-read
          -- under an older extractor is outstanding in exactly the way an
          -- upload never read is, and only the second was countable.
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

  -- A blocked invariant upload keeps the tick alive so the watchdog keeps
  -- stamping and a fixed pipeline resumes work without anything re-arming it.
  /*
   * AND A PUBLISHED LIST THAT STILL HOLDS PROPERTIES BACK COUNTS HERE TOO.
   *
   * This was `published_at IS NULL`, which was the same question as "is
   * anything still owed" right up until a first list could publish part of
   * itself. It is the counter that keeps the every-minute tick SCHEDULED:
   * with the held-back rows sitting at `failed` and the upload now stamped
   * published, every term in the sum could reach zero, the tick would
   * unschedule itself, and the builder's next supplied picture would sit in
   * the table with nothing running to look at it. That is the "picture
   * saved, card still blank" failure again, arriving by a different door.
   */
  SELECT count(*) INTO v_blocked
    FROM public.builder_stock_uploads u
   WHERE u.deleted_at IS NULL
     AND u.image_invariant
     AND NOT public.builder_stock_upload_superseded(u.id)
     AND (u.published_at IS NULL OR EXISTS (
       SELECT 1 FROM public.builder_stock_items i
        WHERE i.upload_id = u.id AND i.lifecycle_status = 'staged'));

  IF v_outstanding + v_fallback + v_item_work + v_publications
     + v_upload_completion + v_blocked = 0 THEN
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'settle-builder-stock-marketplace-eligibility'
    ) THEN
      PERFORM cron.unschedule('settle-builder-stock-marketplace-eligibility');
    END IF;
    RETURN;
  END IF;

  /*
   * STEADY-STATE TOP-UP, AT MOST FOUR WORKERS A MINUTE.
   *
   * WAS TWO. Measured on upload `aac89d49` (20 September 2026): the 04:18
   * tick found `claimable = 8`, dispatched two, and the fleet then ran dry
   * — 30.474 s with no settler alive anywhere and four properties still
   * claimable, inside a 43.912 s stretch with no PDF election running at
   * all. Ten invocations used 277.1 s of the 1,000 s they were granted and
   * not one of them was killed. The fleet was absent, not full.
   *
   * FOUR AND NOT SIX, because the dispatcher's own third term binds first:
   * at `claimable = 8` it sizes to `ceil(8/2) = 4`, so four and six
   * dispatch the same four workers and four is the whole remedy. Six would
   * only matter on a larger backlog, and this tick can overlap the kick's
   * six — all six were still alive when the 04:18 tick fired — so four is
   * already about ten live isolates at the crossover. Six is a separate
   * question with its own measurement.
   *
   * The import-time kick still starts a fresh upload six-wide; that is the
   * burst, and this is the trickle behind it.
   */
  v_dispatched := public.builder_stock_dispatch_image_workers(4);

  /*
   * AND THE WORK THAT IS NOT IMAGE WORK STILL NEEDS A WORKER.
   *
   * Reaching this line means the keep-alive sum is non-zero: every return
   * above is taken when it is zero. So `v_dispatched = 0` says exactly
   * "this tick found work and started nobody", which is the state upload
   * `c2b7faa1` sat in for twenty-five minutes with the cron firing every
   * one of them. One settler, which claims nothing, finds the item queue
   * drained, falls through to the upload sweep and runs every housekeeping
   * pass the tick owes — `settleCompletedUploads` among them.
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
$$;
COMMENT ON FUNCTION public.settle_builder_stock_marketplace_eligibility_tick() IS
  'Watchdog first, then publication and re-open sweeps, then a dispatch derived from the claimable backlog (≤4/min steady; the import-time kick handles bursts six-wide). A tick that finds work and dispatches no image worker starts ONE settler anyway, because upload completion and the blocked-upload recovery are done inside that function and only image work used to be able to start it. Terminal ''failed'' items are deliberately NOT counted as work — they are a person''s queue — but a blocked invariant upload keeps the tick alive so recovery needs no re-arming.';

-- ---------------------------------------------------------------------------
-- The proof.
--
-- ALL OF IT IS READ OFF THE DEPLOYED DEFINITIONS, and the width arithmetic is
-- EXECUTED rather than restated. `pg_get_functiondef` returns the text the
-- database will actually run, which is the only thing worth asserting: this
-- repository has twice had a file that said the right thing over a database
-- that ran something else.
--
-- The sizing expression is lifted OUT of the deployed dispatcher and
-- evaluated with the two `p_max` values that are themselves read out of the
-- deployed tick and the deployed kick. Nothing here re-implements
-- `least(greatest(coalesce(p_max, 0), 0), 6, ceil(v_claimable / 2.0))`; a
-- proof that restated it would agree with a mutant that changed it. That is
-- the same mistake `20260919110000`'s own proof header records.
--
-- NOTHING IS WRITTEN AND NOTHING IS DISPATCHED. The dispatcher is never
-- called — calling it would fire real signed invocations at the settler — so
-- the expression is evaluated on its own, read-only, and this block needs no
-- rollback.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_tick text;
  v_disp text;
  v_kick text;
  v_tick_max integer;
  v_kick_max integer;
  v_expr text;
  v_eval text;
  v_width integer;
  v_at integer;
  v_branch text;
  v_invokes integer;
  r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_tick
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'settle_builder_stock_marketplace_eligibility_tick';
  SELECT pg_get_functiondef(p.oid) INTO v_disp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'builder_stock_dispatch_image_workers';
  SELECT pg_get_functiondef(p.oid) INTO v_kick
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'builder_stock_kick_image_work';
  IF v_tick IS NULL OR v_disp IS NULL OR v_kick IS NULL THEN
    RAISE EXCEPTION 'the settlement tick, the dispatcher or the import kick is missing';
  END IF;

  -- === 1. THE TICK TOPS UP FOUR, and still READS what the dispatcher did. ===
  --
  -- The capture is half the assertion: a tick that called the dispatcher and
  -- ignored its answer would start a second worker on every tick of a healthy
  -- import, which is the fallback below firing when it must not.
  v_tick_max := (regexp_match(
    v_tick,
    'v_dispatched\s*:=\s*public\.builder_stock_dispatch_image_workers\(\s*(\d+)\s*\)'))[1]::integer;
  IF v_tick_max IS NULL THEN
    RAISE EXCEPTION 'the tick no longer captures what the image dispatcher did, so it cannot tell a tick that started workers from one that started none';
  END IF;
  IF v_tick_max <> 4 THEN
    RAISE EXCEPTION 'the minute tick dispatches % and not 4 — upload aac89d49 measured 30.474 s with no settler alive and four properties claimable behind a two-wide tick', v_tick_max;
  END IF;

  -- === 2. THE HOUSEKEEPING FALLBACK IS INTACT, and cannot fail the tick. ===
  --
  -- Unchanged by this migration and asserted anyway, because a wider dispatch
  -- makes `v_dispatched = 0` RARER and a silently lost fallback would take
  -- longer to notice. Zero claimable is still zero dispatched, and this is the
  -- branch that then starts the one settler upload completion needs.
  --
  -- Read as a SLICE from the guard onwards rather than as one bounded regex:
  -- Postgres caps a `{m,n}` repetition at 255 and the branch is longer than
  -- that, so a bounded pattern would either not compile or quietly stop
  -- looking before the end of what it is judging.
  v_at := position('coalesce(v_dispatched, 0) = 0' IN v_tick);
  IF v_at = 0 THEN
    RAISE EXCEPTION 'the tick no longer branches on having dispatched nothing';
  END IF;
  v_branch := substr(v_tick, v_at);
  IF position('cron_invoke_signed_function(' IN v_branch) = 0
     OR position('''builder-stock-image-settler''' IN v_branch) = 0
     OR position('''housekeeping''' IN v_branch) = 0 THEN
    RAISE EXCEPTION 'a tick that finds work and dispatches no image worker starts nobody — upload completion has no route to a worker';
  END IF;
  IF position('EXCEPTION WHEN OTHERS THEN' IN v_branch) = 0 THEN
    RAISE EXCEPTION 'the housekeeping dispatch can fail the tick it rides in — a vault hiccup would take the watchdog and the publication sweeps down with it';
  END IF;
  -- ONE settler, not two. The fallback exists to reach the work at all; a
  -- second isolate finds the lease held and returns.
  v_invokes := array_length(string_to_array(v_tick, 'cron_invoke_signed_function('), 1) - 1;
  IF v_invokes <> 1 THEN
    RAISE EXCEPTION 'the tick invokes the settler directly % times, expected exactly 1', v_invokes;
  END IF;

  -- === 3. AN IDLE TICK STILL RETIRES ITSELF. ==============================
  --
  -- The keep-alive sum and the unschedule that reads it. Dispatch width must
  -- never become a reason a deployment with nothing to do keeps running a job.
  IF v_tick !~ 'v_outstanding \+ v_fallback \+ v_item_work \+ v_publications\s*\+ v_upload_completion \+ v_blocked = 0' THEN
    RAISE EXCEPTION 'the tick''s retirement condition changed shape — the housekeeping dispatch is only safe because reaching it proves the sum is non-zero';
  END IF;
  IF position('cron.unschedule(''settle-builder-stock-marketplace-eligibility'')' IN v_tick) = 0 THEN
    RAISE EXCEPTION 'the tick can no longer unschedule itself, so an idle deployment would run this job for ever';
  END IF;
  IF position('i.lifecycle_status = ''staged''' IN v_tick) = 0 THEN
    RAISE EXCEPTION 'the tick no longer counts a published list that still holds properties back';
  END IF;

  -- === 4. THE IMPORT-TIME KICK IS UNTOUCHED, at six. ======================
  v_kick_max := (regexp_match(
    v_kick,
    'RETURN\s+public\.builder_stock_dispatch_image_workers\(\s*(\d+)\s*\)'))[1]::integer;
  IF v_kick_max IS NULL THEN
    RAISE EXCEPTION 'the import-time kick no longer dispatches image workers at all';
  END IF;
  IF v_kick_max <> 6 THEN
    RAISE EXCEPTION 'the import-time kick now passes % and not 6 — a fresh upload is a burst and is meant to start six-wide; this migration raised the steady-state trickle and must not have moved the burst', v_kick_max;
  END IF;

  -- === 5. THE DISPATCHER'S OWN CEILING AND SIZING RULE ARE UNTOUCHED. =====
  --
  -- `p_max` is a cap the caller asks for; the ceiling of six and the
  -- `ceil(claimable / 2)` sizing are what make asking for four safe — four
  -- workers are started only when eight or more properties are claimable.
  IF v_disp !~ 'SELECT claimable INTO v_claimable FROM public\.builder_stock_image_work_pending\(\);\s*IF coalesce\(v_claimable, 0\) = 0 THEN\s*RETURN 0;' THEN
    RAISE EXCEPTION 'the dispatcher no longer returns 0 before doing anything when no image work is claimable';
  END IF;
  -- `[^;]*` rather than a non-greedy `.*?`: Postgres decides a whole regex's
  -- greediness from its FIRST quantifier, which is the `\s*` above, so a
  -- lazy quantifier later in the pattern is ignored and the match runs on
  -- past the statement. A class that cannot contain `;` cannot leave it.
  v_expr := (regexp_match(v_disp, 'v_n\s*:=\s*(least\([^;]*\))\s*;'))[1];
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'the dispatcher''s sizing expression could not be read out of the deployed definition';
  END IF;
  IF regexp_replace(v_expr, '\s+', ' ', 'g')
     <> 'least(greatest(coalesce(p_max, 0), 0), 6, ceil(v_claimable / 2.0)::integer)' THEN
    RAISE EXCEPTION 'the dispatcher''s sizing rule changed to "%" — the ceiling of six and the ceil(claimable/2) term are what bound a four-wide tick', v_expr;
  END IF;

  -- === 6. WHAT THOSE CAPS ACTUALLY DISPATCH, evaluated, not asserted. =====
  --
  -- The deployed expression with the deployed caps. The 8 → 4 row is the
  -- measured bottleneck: `claimable` was 8 at upload aac89d49's 04:18 tick,
  -- and the next row is the whole reason this is four rather than six —
  -- SIX DISPATCHES THE SAME FOUR THERE, so six buys nothing and costs a
  -- larger top-up on backlogs nobody has measured.
  FOR r IN
    SELECT * FROM (VALUES
      (v_tick_max,  8, 4, 'the minute tick at the backlog aac89d49 left standing'),
      (v_kick_max,  8, 4, 'a six-wide tick at that same backlog — the same four workers'),
      (v_tick_max,  4, 2, 'the minute tick at half that backlog'),
      (v_tick_max,  2, 1, 'the minute tick with two properties claimable'),
      (v_tick_max,  0, 0, 'the minute tick with no claimable image work'),
      (v_kick_max, 13, 6, 'the import-time kick on aac89d49''s thirteen properties')
    ) AS t(cap, claimable, expected, what)
  LOOP
    v_eval := replace(replace(v_expr, 'p_max', r.cap::text), 'v_claimable', r.claimable::text);
    EXECUTE 'SELECT (' || v_eval || ')::integer' INTO v_width;
    IF v_width <> r.expected THEN
      RAISE EXCEPTION 'cap % with % claimable dispatches % workers, expected % (%)',
        r.cap, r.claimable, v_width, r.expected, r.what;
    END IF;
  END LOOP;
END;
$assert$;

COMMIT;
