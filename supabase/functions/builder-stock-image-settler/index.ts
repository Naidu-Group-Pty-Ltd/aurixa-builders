/**
 * Builder stock — bringing stock that is ALREADY imported up to the current
 * image rules, with nobody watching.
 *
 * WHY THIS EXISTS. Changing what counts as a property's primary image makes
 * every previously stored image row out of date by definition: it proves where
 * its bytes came from and says nothing about what the source presented them as.
 * The repair that fixes that has existed for a while and was only ever reachable
 * through a "Source images" button in the Builder Portal, one stock list at a
 * time. Asking a builder to press a button on every source they have ever
 * uploaded is not a deployment step; it is a defect with instructions.
 *
 * So this drives the SAME repair from pg_cron. It is a sweep, not a service:
 * every upload carries a settled-version marker, this brings the ones below
 * the current version up to it, and when none are left the migration's cron
 * job unschedules itself. Nothing here is on a read path and nothing runs when
 * there is no work.
 *
 * IT NOW CARRIES THREE KINDS OF WORK, UNDER THREE MARKERS. Provenance
 * (`source_images_settled_version`) is where a row's bytes came from and what
 * the source designated them as. Marketplace display eligibility
 * (`marketplace_eligibility_settled_version`) is whether the picture itself may
 * go on a card — a facade under a status ribbon answers every provenance
 * question correctly and is still not a card image. They are versioned apart on
 * purpose: improving the classifier must not re-fetch every Notion page, and
 * re-reading a source must not re-run a classifier that has not changed. An
 * upload behind on either is outstanding, and every upload written before the
 * fourth question existed is behind on the second one — which is what makes
 * this the thing that repairs production, with nobody pressing anything.
 *
 * AND A THIRD: THE OVERLAY REPAIR (`image_sanitization_settled_version`). Where
 * the display gate refused a picture for carrying a promotional graphic laid
 * over it, the graphic is taken off the builder's OWN file and the result is
 * stored once, beside the original, as a versioned derivative. It is on its own
 * marker for the same reason the other two are: a better repair must not
 * re-fetch every source, and a better classifier must not re-run every repair.
 * It is by far the most expensive of the three and is capped hardest.
 *
 * WHAT IT MAY WRITE. `builder_stock_item_images` rows, the display verdict and
 * the derivative record inside their `source_detail`, sanitized derivative
 * objects in the image bucket, the `primary_image_id` those rows earn, and the
 * three settlement markers. NO STORED IMAGE IS EVER REWRITTEN: eligibility
 * re-READS each object to measure it, and the overlay repair writes a NEW
 * object and leaves the builder's file, its hashes and its provenance exactly
 * as they are. No picture is replaced by another picture — not a map, not a
 * street view, not a search result, not stock imagery, not another property. No stock item is created or
 * deleted; no price, availability, configuration, status, selection, builder or
 * project/unit linkage is touched. Those guarantees are `repairSourceImages.ts`'s
 * and are not restated here — this only decides WHICH uploads it runs for.
 *
 * AND ONE THING THAT IS NOT A SWEEP AT ALL: `preview_sanitization`, which
 * produces a repair candidate for one image and hands back the PNG without
 * writing anything anywhere. It lives here because this is the function that
 * already holds the worker credential and already refuses every caller that is
 * not internally signed; it exists because the generative route's model is
 * behind a deployment secret, so before it the only way to SEE a candidate was
 * to let production write one over a picture a client was already being shown.
 * See `previewSanitization.ts`.
 *
 * SECURITY. Internal callers only, through the signed envelope
 * (`verifyInternal`). It holds a service-role client and crosses organisations,
 * which is exactly why it must not be reachable by a portal session. The
 * preview is behind that same gate and adds no other way in.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { choosePhase } from '../_shared/builderStock/settlementPhase.pure.ts';
import { createCorsHeaders } from '../_shared/auth.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { internalErrorResponse } from '../_shared/errorResponse.ts';
import {
  readEligibilityTarget, readOutstandingUploads, readSanitizationTarget,
  readSettlementReadiness, runSettlementTick, settleUploadSourceImages,
  ELIGIBILITY_SETTLED_VERSION_COLUMN, SANITIZATION_SETTLED_VERSION_COLUMN,
  SETTLED_VERSION_COLUMN,
  type SettlementCandidate,
} from '../_shared/builderStock/settleSourceImages.ts';
import { newRepairBudget } from '../_shared/builderStock/settleImageSanitization.ts';
import {
  settleFallbackImages, MAX_FALLBACK_ITEMS_PER_TICK,
} from '../_shared/builderStock/settleFallbackImages.ts';
import { previewSanitization } from '../_shared/builderStock/previewSanitization.ts';
import { RECOVERY_DEADLINE_MS } from '../_shared/builderStock/packageImages.ts';
import { readStage } from '../_shared/builderStock/settleItemImages.ts';
import { PROVENANCE_VERSION } from '../_shared/builderStock/sourceImages.ts';
import { enforceStrictPrimaryImages } from '../_shared/builderStock/primaryImage.ts';
import { storeVerifiedWebImages } from '../_shared/builderStock/webImageStore.ts';
import { settleCompletedUploads } from '../_shared/builderStock/uploadCompletion.ts';
import {
  claimOneImageWorkItem, completeItemWork, isMissingCapability, publishUploadIfReady,
  readItemWorkPending,
} from '../_shared/builderStock/itemWorkClaim.ts';
import { settleClaimedItem } from '../_shared/builderStock/settleItemImages.ts';

/*
 * The canonical headers, not a hand-rolled copy.
 *
 * The copy this replaces was a snapshot of the allowlist on the day it was
 * written: it was already missing `x-correlation-id` and `x-step-up-token`,
 * and it declared no `Access-Control-Expose-Headers` at all — so any custom
 * response header would have read back as `null`. A hand-rolled list can only
 * ever go stale, which is why `check-cors-contract.mjs` refuses one.
 *
 * `createCorsHeaders()` with no origin also drops the wildcard ACAO the copy
 * carried. This function holds a service-role client and crosses
 * organisations; `*` on it was wrong independently of the preflight.
 */
const corsHeaders = createCorsHeaders();

/**
 * THE WEB-IMAGE PASS, callable from EVERY normal tick exit.
 *
 * It enumerates its own work — verified, ready, storage-less web images —
 * because the steady state is exactly when it matters, and a retirement hands
 * the organisation to the caller's enforcement so the card is re-decided
 * before the tick returns. One function, two exits: it first lived only after
 * the settlement work, and a deployment whose every tick ended on the
 * fallback path (withheld fallbacks keep `remaining` above zero for ever)
 * measurably never ran it again. It never throws: the drip must not fail the
 * tick it rides in.
 */
async function runWebImageStorePass(
  supabase: any,
  enforceAfterRetirement: (organisationId: string) => Promise<void>,
): Promise<void> {
  try {
    const { data: webRows } = await supabase
      .from('builder_stock_item_images')
      .select('organisation_id')
      .eq('source_stage', 'internet_search')
      .eq('verification_status', 'property_identity_verified')
      .eq('processing_status', 'ready')
      .is('storage_path', null)
      .limit(200);
    const webOrganisations = [...new Set(
      ((webRows ?? []) as Array<{ organisation_id: string }>)
        .map((row) => String(row.organisation_id)),
    )];
    for (const organisationId of webOrganisations) {
      const webOutcome = await storeVerifiedWebImages(supabase, organisationId);
      if (webOutcome.retired > 0) await enforceAfterRetirement(organisationId);
    }
  } catch (storeError) {
    console.warn('[builder-stock-image-settler] web images not stored', {
      phase: 'web_image_store',
      message: String((storeError as { message?: string })?.message ?? storeError)
        .slice(0, 200),
    });
  }
}

/**
 * EVERY HOUSEKEEPING PASS THE TICK OWES, ON EVERY NORMAL EXIT.
 *
 * The tick has TWO normal exits — the fallback phase returns when the
 * settlement queue is empty, and the settlement path returns after its work —
 * and a pass wired to only one of them does not run at all on a deployment
 * that always leaves by the other. That has now happened twice: the
 * web-image store was first wired inside per-candidate enforcement (dead once
 * the marketplace settled), then after the settlement work alone (dead
 * because withheld fallbacks keep that queue non-empty for ever).
 *
 * So the exits call ONE function and the passes are listed here. A pass added
 * to this body reaches both exits by construction rather than by remembering,
 * which is the only version of this that stops being re-learned.
 *
 * Order is deliberate: imagery first, because retiring a picture changes what
 * a card draws, and an upload's status is a record ABOUT work already done.
 */
async function runTickHousekeeping(
  supabase: any,
  enforceAfterRetirement: (organisationId: string) => Promise<void>,
): Promise<void> {
  await runWebImageStorePass(supabase, enforceAfterRetirement);
  // An import that finished with nobody watching still has to be recorded as
  // finished. See `uploadCompletion.ts`.
  await settleCompletedUploads(supabase);
}

/** Wall clock for one tick, well inside the edge ceiling. */
const BUDGET_MS = 100_000;
/** Sources one tick may read. Resumable, so small is safe and slow is not. */
const MAX_UPLOADS_PER_TICK = 6;
/**
 * Outstanding uploads one tick asks the database for.
 *
 * Comfortably more than it can settle, so the tick always has the oldest work
 * in front of it, and bounded so a very large backlog drains over several ticks
 * rather than arriving in one response.
 */
const MAX_QUEUE_ROWS = 100;
const MAX_BODY_BYTES = 8 * 1024;

/**
 * How often the phase rotation advances.
 *
 * The cron interval, so one tick is one phase and the next tick is the next
 * one. Reading the clock rather than a counter keeps this function stateless;
 * the only property required is that consecutive ticks land on consecutive
 * indices, which any period at or below the cron's gives.
 */
const TICK_ROTATION_MS = 5 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.error;
  const gate = await verifyInternal(supabase, req, bounded.raw);
  if (!gate.ok) {
    console.warn('[builder-stock-image-settler] verifyInternal denied', {
      errorCode: (gate as { errorCode?: string }).errorCode,
    });
    return json({ error: 'Forbidden' }, 403);
  }

  /**
   * LOOK AT A CANDIDATE WITHOUT LETTING IT BECOME A PICTURE.
   *
   * The generative route is the only one that can clean some facades, its model
   * lives behind the private worker, and the worker's token is a deployment
   * secret — so before this existed the only way to SEE a candidate was to let
   * production write one over the picture a client is already being shown.
   *
   * It is here rather than anywhere else because this is the function that
   * already holds the worker credential, already refuses everything that is not
   * an internally-signed caller, and already imports the repair. Nothing about
   * it reaches a portal session or the marketplace, and it writes nothing at
   * all — see `previewSanitization.ts`, where that is the enforced property.
   *
   * Placed AFTER `verifyInternal` and before any settlement work, so an
   * unsigned caller is refused exactly as it always was and a tick with no
   * `operation` behaves precisely as it did before this block existed.
   */
  let body: Record<string, unknown> = {};
  try {
    body = bounded.raw ? JSON.parse(bounded.raw) as Record<string, unknown> : {};
  } catch {
    body = {};
  }

  if (String(body.operation ?? '') === 'preview_sanitization') {
    const preview = await previewSanitization(supabase, {
      organisationId: String(body.organisation_id ?? ''),
      imageId: String(body.image_id ?? ''),
      originalSha256: String(body.original_sha256 ?? ''),
      boxes: (Array.isArray(body.boxes) ? body.boxes : []) as never,
    });

    if (preview.ok === false) {
      console.warn('[builder-stock-image-settler] preview refused', {
        phase: 'preview_sanitization',
        image_id: String(body.image_id ?? '').slice(0, 64),
        reason: preview.reason,
      });
      return json({ success: false, error: preview.reason, detail: preview.detail },
        preview.status);
    }

    /*
     * The candidate itself, and facts about how it was made. No path, no
     * bucket, no credential and no worker address: an operator needs to see
     * the picture and know what it cost, not where the secrets are.
     */
    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'x-builder-stock-preview': 'true',
      'x-repaired-share': preview.repairedShare.toFixed(5),
      'x-repair-route': preview.transformation,
      'x-regions-removed': String(preview.regionsRemoved),
    };
    // Reported only when the metering ledger could actually be read. A count
    // nobody measured is worse than no count at all.
    if (preview.modelCalls !== null) headers['x-model-calls'] = String(preview.modelCalls);
    if (preview.model) headers['x-inpaint-model'] = preview.model;

    return new Response(preview.bytes as unknown as BodyInit, { status: 200, headers });
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + BUDGET_MS;

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * THE PER-ITEM PATH. ONE INVOCATION, ONE PROPERTY, NO GLOBAL LEASE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * WHY IT COMES FIRST AND TAKES NO LEASE. The lease below is a single boolean
   * row for the whole deployment. It was the queue lock, and a killed worker
   * runs no `finally`, so it held that row for its full term while the queue
   * stayed shut for every property — not just the one that died. Production,
   * 29 August, seventeen minutes: six `CPU Time exceeded`, ten `lease_held`,
   * not one completed tick, no work at all.
   *
   * The item claim replaces it. `FOR UPDATE SKIP LOCKED` means a property
   * somebody else holds is stepped over rather than waited for, so two
   * invocations can never own the same property and may freely own different
   * ones. Taking the global lease here as well would put the old bottleneck
   * straight back in front of the fix, so this path does not touch it.
   *
   * EXACTLY ONE PROPERTY PER INVOCATION. Claiming a batch and working through
   * it inside one invocation rebuilds the very thing this replaces: claim A,
   * B, C, D — A kills the worker — and B, C and D are leased by a process that
   * no longer exists, having never been looked at. Throughput comes from
   * invoking more often, never from widening this number.
   */
  const itemClaim = await claimOneImageWorkItem(supabase, {
    leaseSeconds: Math.ceil(BUDGET_MS / 1000) + 20,
  });

  /*
   * Set when the per-item queue is deployed AND completely empty, so the tick
   * continues to the upload-level sweep below rather than falling into it as
   * deployment skew. See the fall-through comment where it is read.
   */
  let itemQueueDrained = false;

  if (itemClaim.available) {
    if (!itemClaim.item) {
      /*
       * Nothing due. That is NOT the same as nothing left — a property may be
       * leased by a live invocation or backing off after a kill — so the
       * scheduler is told both numbers and retires the job only on the second.
       */
      const pending = await readItemWorkPending(supabase);
      console.log('[builder-stock-image-settler] item tick', {
        phase: 'item_work', claimed: 0,
        claimable: pending.claimable, outstanding: pending.outstanding,
      });
      /*
       * AN EMPTY ITEM QUEUE IS WHEN THE UPLOAD-LEVEL SWEEP IS OWED, NOT WHEN
       * IT IS SKIPPED.
       *
       * The per-item queue replaced the upload walk for finding and judging
       * PICTURES, and it does that job completely. What it never took over is
       * stamping the three UPLOAD markers — `source_images_settled_version`,
       * `marketplace_eligibility_settled_version`,
       * `image_sanitization_settled_version` — which only
       * `settleUploadSourceImages` writes, and which reach it only through the
       * sweep below. Returning here left that sweep behind the deployment-skew
       * branch, so on a healthy deployment it never ran at all.
       *
       * PRODUCTION, 30 AUGUST - 1 SEPTEMBER 2026. Upload `a0f8dfe4`
       * (`export.csv`, 26 properties) finished every item and then sat at
       * `status = 'enriching'` for thirty-six hours with all three markers
       * NULL. 4,438 settler invocations over the preceding twenty-four hours
       * were item ticks; NOT ONE was a settlement tick and not one reported
       * deployment skew. Because `builder_stock_uploads` still counted as
       * outstanding, `settle_builder_stock_marketplace_eligibility_tick` could
       * never satisfy its own retirement condition, so the cron went on firing
       * once a minute for ever against a queue with nothing in it.
       *
       * Continuing here is safe and self-limiting: it happens only when NO
       * property is claimable, the sweep takes the same lease it always did so
       * two ticks cannot overlap, an upload whose branches are all answered
       * costs a marker read rather than a re-fetch, and the markers are
       * terminal — so once they are stamped the queue empties and the cron
       * retires itself, which is what stops this path running at all.
       */
      if (pending.outstanding > 0) {
        return json({
          success: true, path: 'item_work', settled: 0,
          claimable: pending.claimable, outstanding: pending.outstanding,
          complete: false, deploymentReady: true,
        });
      }
      itemQueueDrained = true;
    } else {

    /*
     * ONE PROPERTY AT A TIME, AND AS MANY AS THE CLOCK ALLOWS.
     *
     * The rule this preserves is the one the old single-item shape existed
     * for: a worker must never hold a lease on a property it has not started.
     * Claiming A, B, C, D up front and dying on A leaves B, C and D leased by
     * a process that no longer exists, unlooked at until their leases expire.
     * So nothing here is pre-claimed — the next property is claimed only
     * after the previous one has been settled AND recorded, so exactly one
     * lease is held at any instant and a kill still costs exactly one
     * property. Identical blast radius, without the throughput ceiling.
     *
     * WHY THE CEILING HAD TO GO. Throughput used to be bought only by
     * invoking more often, and concurrent invocations of one function share
     * an isolate and its memory. Measured 7 September 2026 on upload
     * `bd7a0ef5`: the scheduler dispatched up to TEN invocations a minute
     * (`least(greatest(v_item_work, 1), 10)` — concurrency scaled off the
     * backlog, so the larger the import the harder it hit), five concurrent
     * 8 MB brochures peak at 429 MB against a 256 MB ceiling, and the isolate
     * died. Seventy-eight properties took 161 minutes — 0.48 a minute, an
     * order of magnitude under the design's own ceiling — because every kill
     * threw away all the work in flight. The same six documents run one at a
     * time elect in about a second each.
     *
     * So concurrency comes down to two and the work per invocation goes up:
     * fewer isolates, each doing more, each holding one document at a time.
     */
    /*
     * ENOUGH TIME TO FINISH, NOT MERELY SOME TIME LEFT.
     *
     * The first version of this reserved a flat 30 s, which proves nothing: a
     * source-stage claim can legitimately spend `RECOVERY_DEADLINE_MS`
     * (75 s) before it answers, and the recovery does not consult the item's
     * deadline — so an item claimed at the 70 s mark could still be running
     * at 145 s, past a 100 s budget, and be killed mid-flight. That is the
     * exact failure this whole change removes, reintroduced by the throughput
     * fix.
     *
     * So the reserve is DERIVED from the worst case rather than chosen, and
     * it is per-stage because the stages are not alike: only `source` runs a
     * package recovery. The write-back allowance matches the one the per-item
     * deadline already holds back.
     */
    const WRITE_BACK_RESERVE_MS = 10_000;
    const HEAVY_STAGE_RESERVE_MS = RECOVERY_DEADLINE_MS + WRITE_BACK_RESERVE_MS;
    const LIGHT_STAGE_RESERVE_MS = 20_000;
    const reserveFor = (stage: string): number =>
      stage === 'source' ? HEAVY_STAGE_RESERVE_MS : LIGHT_STAGE_RESERVE_MS;

    /*
     * HOW MANY DOCUMENTS ONE ISOLATE MAY OPEN, and why a clock is not enough.
     *
     * The serial loop above fixed throughput and introduced this: an isolate
     * that reads several PDFs never gives the memory back, so the invocation
     * dies of ACCUMULATION rather than of any one document. The property in
     * the chair when it happens takes the blame — a surviving attempt record
     * naming a document that was never the problem.
     *
     * MEASURED 7 SEPTEMBER 2026, Lot 608 Acclaim Estate (`1nMsonm9`), the one
     * property of seventy-eight that did not recover. Its brochure reads in
     * 0.84 s and its facade render is on page 1; run six times in one process,
     * resident memory went 50 → 173 → 236 → 247 → 254 → 287 → 318 MB. The
     * FIFTH document crosses an Edge Function's ~256 MB ceiling. Each one is
     * individually cheap and the isolate is dead by the fifth all the same,
     * which is exactly the shape of the four kills that document collected.
     *
     * Three, so the invocation stops two documents before the crossing rather
     * than at it. Only `source` is counted, because only `source` opens a
     * PACKAGE: a multi-megabyte PDF, its page tree, and every raster on the
     * pages it flattens.
     *
     * THE LIGHT STAGES ARE NOT FREE, and this comment used to say they were
     * ("eligibility, sanitization and fallback decode nothing"). They do:
     * eligibility downloads a stored photograph and decodes it to judge it,
     * and sanitization runs a full-resolution decode, a reconstruction and a
     * re-decode. They are cheap RELATIVE to a package — one photograph rather
     * than a document — which is why they are not counted against the
     * allowance, and why the invocation's walk past a spent allowance is
     * bounded rather than unlimited. See `LIGHT_ITEMS_AFTER_DOCUMENTS`.
     */
    const HEAVY_DOCUMENTS_PER_INVOCATION = 3;
    const isHeavy = (stage: string): boolean => stage === 'source';
    let heavyDocuments = 0;

    /*
     * HOW MUCH LIGHT WORK MAY RIDE ALONG BEHIND THE DOCUMENTS.
     *
     * The invocation used to END when it reached its document allowance, and
     * that is the largest measured waste in this engine: over a real
     * eighteen-property import the settler used 524 s of the 2,100 s its
     * twenty-one invocations were given, because
     *
     *   item tick { settled: 3, claimable: 17, ms: 19360 }
     *
     * happens every time — three documents opened, seventeen properties ready
     * to go, eighty seconds of budget in hand, worker exits. Each property is
     * claimed four times (source, eligibility, sanitization, fallback), so
     * three of every four claims are light, and ending the invocation made
     * every one of them wait for a fresh minute of its own.
     *
     * So the allowance now refuses the DOCUMENT rather than ending the walk.
     * The bound on what follows is the envelope production has already
     * demonstrated: mixed invocations of eleven items are ordinary in the
     * live log (`settled: 11 … stage: "source"`), and light-only invocations
     * reach thirty-six. Eight keeps documents-then-light at eleven — inside
     * what has run for months without a kill — rather than inventing a new
     * combination on the strength of an argument.
     */
    const LIGHT_ITEMS_AFTER_DOCUMENTS = 8;
    let lightItemsAfterDocuments = 0;

    /*
     * WHAT THIS INVOCATION HAS ALREADY DONE, AND WHAT IT GAVE BACK.
     *
     * MEASURED 11 SEPTEMBER 2026, one production invocation:
     *
     *   item tick { settled: 126, stage: "fallback", next_stage: "fallback",
     *               progressed: true, primary_set: false, ms: 80565 }
     *
     * One property, one stage, a hundred and twenty-six times, resolving
     * nothing — then 102 more on the next tick. The cause was a stage that
     * could never advance (see `sourceVerdictOutstanding`) and it is fixed at
     * the cause. This is the guard that makes the SHAPE impossible whatever a
     * future stage returns: a stage reports progress, the completion clears
     * the backoff, `retryAfterSeconds: 0` makes the row claimable in the same
     * millisecond, and the loop takes it straight back. Nothing in the claim
     * or the completion can see that the property is where it started.
     *
     * So the invocation remembers. One property at one stage is worked at most
     * ONCE per invocation; a second offer of the same pair is handed back with
     * a real delay and the loop moves on to somebody else. That turns an
     * unbounded spin into a single wasted claim, and — because the handback
     * does not reset the attempt counter — the claim's own exponential backoff
     * then walks a genuinely stuck property out of the way of the queue.
     */
    const workedThisInvocation = new Set<string>();
    const handedBack = new Set<string>();
    const STALLED_RETRY_SECONDS = 60;
    /*
     * How many unworkable offers to walk past before giving up on this
     * invocation. The claim orders by `image_work_next_attempt_at`, and a
     * handback moves a row to the BACK of that order, so probing cannot
     * revisit the same row until the whole claimable set has been offered —
     * which is what `handedBack` detects exactly. This is the cheap outer
     * bound for the case where the set is very large and uniformly
     * unworkable (every candidate a document, the document allowance spent):
     * a dozen index reads, not two hundred.
     */
    const MAX_HANDBACKS_PER_INVOCATION = 12;
    let handbacks = 0;

    let claimed = itemClaim.item;
    let settledCount = 0;
    let lastSettlement: Awaited<ReturnType<typeof settleClaimedItem>> | null = null;
    let publication: Awaited<ReturnType<typeof publishUploadIfReady>> | null = null;

    for (;;) {
    /*
     * The whole REMAINING wall clock goes to this one property, less a reserve
     * to write the outcome down. That is the other half of the fix: the upload
     * walk gave each property a 12-second slice of which the preceding ones had
     * already spent most, so a linked-package recovery — which declines the bet
     * unless ten seconds remain — could be starved indefinitely while the
     * counter that would have retired it never advanced.
     */
    if (isHeavy(claimed.image_work_stage)) heavyDocuments += 1;
    const settlement = await settleClaimedItem(supabase, claimed, {
      deadlineAt: startedAt + BUDGET_MS - 10_000,
      repairBudget: newRepairBudget(),
    });

    /*
     * A CLAIM THAT SUCCEEDS AND A COMPLETION THAT DOES NOT IS THE WORST HALF
     * OF A HALF-DEPLOYED MIGRATION, so it is named rather than swallowed.
     *
     * PostgREST resolves a function by the argument NAMES in the request body,
     * so a completion whose signature has moved on answers PGRST202 — the same
     * "not deployed" this file already handles for the claim. Reaching here
     * with `available: false` therefore means the two halves disagree: the
     * property was claimed, the work was done, and nothing recorded it. It
     * stays leased until expiry and is then re-done, for ever.
     */
    const completion = await completeItemWork(supabase, claimed.id, {
      nextStage: settlement.nextStage,
      result: settlement.result,
      error: settlement.error ?? null,
      retryAfterSeconds: 0,
      progressed: settlement.progressed,
    });
    if (!completion.available) {
      console.error('[builder-stock-image-settler] work was claimed but could not be recorded', {
        phase: 'deployment_skew',
        stock_item_id: claimed.id,
        missing: 'public.complete_builder_stock_image_work(uuid,text,text,text,integer,boolean)',
        remedy: 'apply supabase/migrations/'
          + '20261021000000_builder_stock_item_work_claim_amendments.sql',
      });
      return json({
        success: false, path: 'item_work', error: 'item_completion_unavailable',
        deploymentReady: false, stage: settlement.stage,
      }, 503);
    }

    settledCount += 1;
    lastSettlement = settlement;
    workedThisInvocation.add(`${claimed.id}:${settlement.stage}`);

    /*
     * AND ASK WHETHER THIS PROPERTY'S UPLOAD CAN NOW BE PUBLISHED.
     *
     * Asked after every completed item because the item that just finished may
     * be the last one its upload was waiting on, and there is nothing else
     * watching. Refusing is the normal answer and costs one cheap call; the
     * readiness rule lives inside the function, evaluated in the same statement
     * that flips the rows, so nothing can change between the check and the act.
     *
     * THE UPLOAD THAT IS WAITING, NOT THE ONE THAT IS SERVING. This used to
     * read `claimed.upload_id` behind `lifecycle_status === 'staged'`, and both
     * halves were wrong for a replacement whose rows all MATCHED.
     */
    const waitingUpload = claimed.pending_upload_id ?? (
      claimed.lifecycle_status === 'staged' ? claimed.upload_id : null);
    if (waitingUpload) {
      const published = await publishUploadIfReady(supabase, waitingUpload);
      publication = published.published ? published : (publication ?? published);
      if (published.published) {
        console.log('[builder-stock-image-settler] stock list published', {
          phase: 'publication',
          upload_id: waitingUpload,
          promoted: published.promoted,
          archived: published.archived,
        });
      }
    }

    /*
     * ANOTHER ONE, ONLY IF THERE IS REAL TIME FOR IT.
     *
     * The reserve is sized on the work rather than on the average: a linked
     * package may spend up to `RECOVERY_DEADLINE_MS` before it answers, so
     * starting one with less than this left would guarantee the very
     * mid-flight kill this whole change exists to remove. Below the reserve
     * the invocation stops cleanly and the next tick picks the queue up —
     * nothing is held, nothing is lost.
     */
    if (Date.now() > startedAt + BUDGET_MS - LIGHT_STAGE_RESERVE_MS) break;

    /*
     * LOOK FOR THE NEXT PROPERTY THIS INVOCATION MAY ACTUALLY WORK — rather
     * than ending because the first one offered was the wrong kind.
     *
     * MEASURED 11 SEPTEMBER 2026 over a real eighteen-property import: the
     * settler ran twenty-one invocations and used 524 s of the 2,100 s they
     * were given. The import took 12 min 30 s and contained about two minutes
     * of work. The single largest waste is here — an invocation that reached
     * its document allowance ended:
     *
     *   item tick { settled: 3, claimable: 17, ms: 19360 }
     *
     * Three documents opened, seventeen properties ready to go, EIGHTY
     * SECONDS of budget in hand, and the worker exits. The allowance exists
     * because decoding accumulates memory and the fifth document in one
     * isolate crosses the ceiling — that is measured and it stands. But it
     * bounds PACKAGES, and there are three light claims for every document
     * claim. Ending the invocation spent the allowance's cost on those too,
     * and they are precisely the ones that could have filled the rest of the
     * budget — bounded, because they are cheaper than a package rather than
     * free. See `LIGHT_ITEMS_AFTER_DOCUMENTS`.
     *
     * So a refusal skips the property instead of ending the loop. A handback
     * is recorded, and seeing the same property offered twice means the
     * claimable set has been all the way round — there is genuinely nothing
     * else — which is the exact moment to stop.
     */
    let nextItem: (typeof claimed) | null = null;
    for (;;) {
      if (Date.now() > startedAt + BUDGET_MS - LIGHT_STAGE_RESERVE_MS) break;
      const next = await claimOneImageWorkItem(supabase, {
        leaseSeconds: Math.ceil(BUDGET_MS / 1000) + 20,
      });
      if (!next.available || !next.item) break;
      const candidate = next.item;
      const stage = readStage(candidate.image_work_stage);

      /*
       * ALREADY DONE, THIS INVOCATION, AT THIS STAGE. The stage ran, reported
       * progress and left the property exactly where it was. Doing it again
       * inside the same invocation cannot produce a different answer — the
       * inputs have not changed — so it is handed back with a real delay and
       * WITHOUT clearing the attempt counter, which is what lets the claim's
       * own backoff carry a genuinely stuck property out of the queue's way.
       * This is a symptom worth seeing in the logs: it means a stage is
       * reporting progress it did not make.
       */
      if (workedThisInvocation.has(`${candidate.id}:${stage}`)) {
        console.warn('[builder-stock-image-settler] stage reported progress and did not move', {
          phase: 'item_work_stalled',
          stock_item_id: candidate.id,
          stage,
          retry_after_seconds: STALLED_RETRY_SECONDS,
        });
        await completeItemWork(supabase, candidate.id, {
          nextStage: stage,
          result: `stalled: ${stage} reported progress without leaving the stage`,
          error: null,
          retryAfterSeconds: STALLED_RETRY_SECONDS,
          progressed: false,
          resetAttempts: false,
        });
        continue;
      }

      /*
       * THE STAGE IS ONLY KNOWN ONCE CLAIMED, so a claim that turns out to be
       * too expensive for the time left is HANDED BACK rather than started.
       * Released at the same stage with no progress, so the next tick takes it
       * with a full budget; the recovery never begins, so no branch attempt is
       * spent and nothing is recorded about the document. Doing the work with
       * too little clock would either kill the worker or bank a timeout as if
       * it were an answer about the link.
       */
      const remaining = startedAt + BUDGET_MS - Date.now();
      const spentOnDocuments = isHeavy(stage)
        && heavyDocuments >= HEAVY_DOCUMENTS_PER_INVOCATION;
      if (spentOnDocuments || remaining < reserveFor(stage)) {
        const seenBefore = handedBack.has(candidate.id);
        await completeItemWork(supabase, candidate.id, {
          nextStage: stage,
          result: spentOnDocuments
            ? 'deferred: this invocation has opened its allowance of documents'
            : 'deferred: not enough of this invocation left to finish it',
          error: null,
          retryAfterSeconds: 0,
          // Nothing advanced — the stage was never entered.
          progressed: false,
          /*
           * But the CLAIM already incremented the backoff counter, and this
           * property did nothing to earn it: the invocation ran short, which is
           * our scheduling and not its document. Left standing, a handful of
           * these would push a perfectly healthy row to a 32-minute backoff and
           * slow the very queue this loop exists to speed up. So the row goes
           * back exactly as it was found.
           */
          resetAttempts: true,
        });
        handbacks += 1;
        // Round the whole claimable set with nothing workable in it.
        if (seenBefore || handbacks >= MAX_HANDBACKS_PER_INVOCATION) break;
        handedBack.add(candidate.id);
        continue;
      }
      /*
       * A light property behind a spent allowance rides along, up to the
       * bound above. Reaching it ends the invocation rather than deferring:
       * there is nothing wrong with the property, and a handback would cost
       * it a claim to say so.
       */
      if (heavyDocuments > 0 && !isHeavy(stage)) {
        if (lightItemsAfterDocuments >= LIGHT_ITEMS_AFTER_DOCUMENTS) {
          await completeItemWork(supabase, candidate.id, {
            nextStage: stage,
            result: 'deferred: this invocation has spent its allowance',
            error: null,
            retryAfterSeconds: 0,
            progressed: false,
            resetAttempts: true,
          });
          break;
        }
        lightItemsAfterDocuments += 1;
      }

      nextItem = candidate;
      break;
    }
    if (!nextItem) break;
    claimed = nextItem;
    }

    const pending = await readItemWorkPending(supabase);
    console.log('[builder-stock-image-settler] item tick', {
      phase: 'item_work',
      settled: settledCount,
      last_stock_item_id: claimed.id,
      stage: lastSettlement?.stage,
      next_stage: lastSettlement?.nextStage,
      progressed: lastSettlement?.progressed,
      primary_set: lastSettlement?.primarySet,
      claimable: pending.claimable,
      outstanding: pending.outstanding,
      ms: Date.now() - startedAt,
    });

    return json({
      success: true, path: 'item_work', settled: settledCount,
      stage: lastSettlement?.stage, nextStage: lastSettlement?.nextStage,
      progressed: lastSettlement?.progressed ?? false,
      primarySet: lastSettlement?.primarySet ?? false,
      error: lastSettlement?.error ?? undefined,
      published: publication?.published ?? false,
      promoted: publication?.promoted ?? 0,
      archivedOnCutover: publication?.archived ?? 0,
      claimable: pending.claimable, outstanding: pending.outstanding,
      complete: pending.outstanding === 0, deploymentReady: true,
    });
    }
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * DEPLOYMENT SKEW, OR AN EMPTY PER-ITEM QUEUE.
   *
   * Two ways to arrive: the claim function is not deployed (the original
   * reason, below), or it is deployed and has nothing left to hand out, which
   * is when the upload-level markers below are owed. Only the first is skew,
   * so only the first is warned about.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The original reason. The claim function is not there yet.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Edge functions ship automatically when `main` moves; migrations here are
   * dispatched by hand. So this build WILL run against a database without
   * `claim_builder_stock_image_work`, and that must not be an outage: on 29
   * August a settler requiring an unapplied lease function answered 503 on
   * every tick and the entire marketplace went blank until somebody noticed.
   *
   * Loud, and then the old path, unchanged. Slow is not an outage.
   */
  if (!itemQueueDrained) {
    console.warn('[builder-stock-image-settler] per-item claim not deployed — using the upload walk', {
      phase: 'deployment_skew',
      missing: 'public.claim_builder_stock_image_work',
      remedy: 'apply supabase/migrations/20261019000000_builder_stock_item_work_claim.sql',
    });
  }

  /*
   * ONE SETTLER AT A TIME.
   *
   * The cron offers this function a turn every minute while work is
   * outstanding, and `BUDGET_MS` permits a single tick to run for a hundred
   * seconds. Production has never come near that — 16.9s is the worst completed
   * tick across 101 of them — but two settlers reading the same queue would
   * start the same package twice, and "has not happened yet" is not a guard.
   *
   * The lease is a compare-and-set row rather than an advisory lock because
   * this function holds no persistent database session: it speaks PostgREST,
   * over HTTP, and a lock taken on one connection would not span the run. It
   * EXPIRES rather than being released, so a worker killed on a resource limit
   * — no `finally`, no response, as this repository has already paid to learn —
   * costs one skipped minute instead of wedging the queue shut.
   *
   * Declining is a normal outcome and not a failure: the previous turn is still
   * working, and the next minute will offer another.
   */
  const lease = await supabase.rpc('claim_builder_stock_settlement_lease', {
    p_seconds: Math.ceil(BUDGET_MS / 1000) + 20,
    p_holder: 'builder-stock-image-settler',
  });
  /*
   * A LEASE THAT IS NOT DEPLOYED IS NOT A REASON TO STOP EITHER.
   *
   * The fallback path must not reintroduce the failure the path above exists
   * to survive. A deployment with neither migration applied would otherwise
   * answer 503 here — an outage reached by falling back FROM an outage. A
   * missing lease means only that nothing is serialising ticks, which is
   * exactly the state this function ran in for its whole life before the lease
   * existed. A live lease FAULT is different and still refuses.
   */
  const leaseMissing = !!lease.error && isMissingCapability(lease.error);
  if (lease.error && !leaseMissing) {
    console.error('[builder-stock-image-settler] settlement lease unavailable', {
      phase: 'settlement_lease',
      reason: String(lease.error?.message ?? lease.error).slice(0, 200),
    });
    return json({ success: false, error: 'Settlement lease unavailable' }, 503);
  }
  if (leaseMissing) {
    console.warn('[builder-stock-image-settler] settlement lease not deployed — proceeding unserialised', {
      phase: 'deployment_skew', missing: 'public.claim_builder_stock_settlement_lease',
    });
  }
  if (!lease.error && lease.data !== true) {
    console.log('[builder-stock-image-settler] tick skipped — previous run still holds the lease');
    return json({ success: true, skipped: 'lease_held' });
  }

  const releaseLease = async () => {
    if (leaseMissing) return;
    try {
      await supabase.rpc('release_builder_stock_settlement_lease');
    } catch {
      // The lease expires on its own; failing to hand it back early is not
      // worth failing a tick that otherwise did its work.
    }
  };

  try {
    /**
     * The uploads with work outstanding, oldest source first.
     *
     * ASKED OF THE DATABASE, NOT FILTERED IN MEMORY. This used to read the
     * oldest 500 uploads and filter them here, which meant 500 settled uploads
     * were enough to hide every outstanding one behind them: the tick found
     * nothing, reported the queue empty, and the 501st was never reached.
     * `readOutstandingUploads` asks for the rows that are actually behind, so
     * the queue drains at 500 uploads and at 50,000.
     *
     * The eligibility version it selects against is the DATABASE's target, not
     * this build's constant — see `readEligibilityTarget`, which is what makes
     * a later classifier bump wake production rather than change nothing.
     */
    /*
     * THE SCHEMA THIS NEEDS, CHECKED BEFORE ANYTHING ELSE.
     *
     * Edge functions ship automatically when `main` moves; migrations here are
     * dispatched by hand, one file at a time. So the display gate can be live
     * for days before the columns that let this clear it exist — and when that
     * happened, every marketplace card went blank while this function reported
     * `success: true` with `skipped: 'marker_unavailable'`, because a missing
     * column and an empty queue looked identical to it.
     *
     * A missing schema is an operational failure with a name now. It answers
     * 503 and says which piece is absent, so the deployment is visibly
     * incomplete rather than quietly finished.
     */
    const readiness = await readSettlementReadiness(supabase);
    if (!readiness.ready) {
      console.error('[builder-stock-image-settler] settlement schema not deployed', {
        phase: 'deployment_readiness',
        missing: readiness.missing,
        remedy: 'apply supabase/migrations/*_builder_stock_*settlement*.sql, '
          + '*_builder_stock_eligibility_target_version.sql and '
          + '*_builder_stock_terminal_negative_provenance.sql and '
          + '*_builder_stock_image_sanitization_settlement.sql',
      });
      return json({
        success: false,
        error: 'settlement_schema_unavailable',
        deploymentReady: false,
        missing: readiness.missing,
      }, 503);
    }

    const eligibilityTarget = await readEligibilityTarget(supabase);
    const sanitizationTarget = await readSanitizationTarget(supabase);
    const queue = await readOutstandingUploads(supabase, {
      limit: MAX_QUEUE_ROWS, eligibilityTarget, sanitizationTarget,
    });

    if (queue.unavailable) {
      // Readiness passed a moment ago, so this is a live read fault rather than
      // a missing column. Either way it is not an empty queue.
      console.error('[builder-stock-image-settler] upload queue unreadable', {
        phase: 'settlement_scan',
      });
      return json({
        success: false, error: 'upload_queue_unreadable', deploymentReady: true,
      }, 503);
    }

    const outstanding = queue.rows;

    if (!outstanding.length) {
      /**
       * SETTLEMENT IS DONE. THE WORK IS NOT NECESSARILY DONE.
       *
       * This used to answer `complete: true` here, and the migration's job
       * unschedules itself on that — so the sweep went permanently quiet the
       * moment the last upload's provenance, eligibility and sanitization
       * markers were current. `readOutstandingUploads` reads
       * `builder_stock_uploads` and nothing else; it has never known that a
       * PROPERTY can still be owed the fallback ladder.
       *
       * That is how three properties came to sit blank for ever with a
       * terminal `no_deterministic_image` and not one image row: their builder
       * supplied no usable photograph, stage A said so honestly, and the only
       * thing that would have looked anywhere else was `enrich_images` in the
       * Builder Portal — a loop that runs while somebody has the page open.
       * Close the browser after an import and the ladder never ran.
       *
       * So the empty settlement queue is where the fallback phase belongs, and
       * it is also the one place it is unconditionally SAFE: no upload is
       * still being read, so no property is about to gain the builder's own
       * render, and stage B or C cannot be bought against a card that is about
       * to have the real picture. That is #2305's rule, kept rather than
       * traded for speed.
       */
      const fallback = await settleFallbackImages(supabase, {
        limit: MAX_FALLBACK_ITEMS_PER_TICK,
        deadlineAt,
      });

      if (fallback.problems.length) {
        console.warn('[builder-stock-image-settler] fallback problems', {
          phase: 'fallback_enrichment', problems: fallback.problems.slice(0, 3),
        });
      }

      /*
       * An unreadable queue is not an empty one. Answering `complete` on a
       * failed read would unschedule the cron on a database fault — the same
       * shape as the missing-column bug above, and just as silent.
       */
      if (fallback.unavailable) {
        console.error('[builder-stock-image-settler] fallback queue unreadable', {
          phase: 'fallback_enrichment',
        });
        return json({
          success: false, error: 'fallback_queue_unreadable', deploymentReady: true,
        }, 503);
      }

      console.log('[builder-stock-image-settler] fallback tick', {
        phase: 'fallback_enrichment',
        attempted: fallback.attempted,
        resolved: fallback.resolved,
        remaining: fallback.remaining,
      });

      /*
       * THE WEB-IMAGE PASS RUNS ON THIS EXIT TOO. It was placed only after
       * the settlement work below, and this path returns before reaching it —
       * so on a deployment whose ticks all ended here (fallback work withheld
       * by the evidence gate never resolves, so `remaining` never hits zero),
       * the pass measurably never ran again: three retired-pending hotlinks
       * sat as card primaries for hours while every tick answered
       * `phase: "fallback_enrichment"` around them. Both normal exits run the
       * pass now. Retirement enforcement is built here because the settlement
       * path's once-per-tick `enforce` closure does not exist on this one.
       */
      await runTickHousekeeping(supabase, async (organisationId) => {
        try {
          await enforceStrictPrimaryImages(supabase, organisationId);
        } catch (enforceError) {
          console.warn('[builder-stock-image-settler] primaries not enforced', {
            organisation_id: organisationId, phase: 'primary_enforcement',
            message: String((enforceError as { message?: string })?.message ?? enforceError)
              .slice(0, 200),
          });
        }
      });

      /*
       * THE COMPLETION RULE. Quiet requires BOTH queues empty. A settlement
       * queue at zero with fallback work outstanding keeps the cron alive.
       */
      return json({
        success: true,
        phase: 'fallback_enrichment',
        settled: 0,
        remaining: 0,
        fallbackAttempted: fallback.attempted,
        fallbackResolved: fallback.resolved,
        fallbackRemaining: fallback.remaining,
        complete: fallback.remaining === 0,
        deploymentReady: true, eligibilityTarget, sanitizationTarget,
      });
    }

    /**
     * The tick's own rule lives in the shared module, not here.
     *
     * It is the part with a defect worth pinning — the cap counts settlements
     * rather than attempts, so one upload that can never settle cannot starve
     * the queue behind it — and a rule inside a `Deno.serve` handler is a rule
     * nothing can test.
     */
    const candidates = outstanding.map((row): SettlementCandidate => ({
      id: String(row.id),
      organisation_id: String(row.organisation_id),
      needsProvenance:
        Number(row[SETTLED_VERSION_COLUMN] ?? 0) < PROVENANCE_VERSION,
      needsEligibility:
        Number(row[ELIGIBILITY_SETTLED_VERSION_COLUMN] ?? 0) < eligibilityTarget,
      needsSanitization:
        Number(row[SANITIZATION_SETTLED_VERSION_COLUMN] ?? 0) < sanitizationTarget,
    }));

    const enforced = new Set<string>();
    const enforce = async (organisationId: string) => {
      if (enforced.has(organisationId)) return;
      enforced.add(organisationId);
      try {
        await enforceStrictPrimaryImages(supabase, organisationId);
      } catch (enforceError) {
        console.warn('[builder-stock-image-settler] primaries not enforced', {
          organisation_id: organisationId,
          phase: 'primary_enforcement',
          message: String((enforceError as { message?: string })?.message ?? enforceError)
            .slice(0, 200),
        });
      }
    };

    /**
     * ENFORCE BEFORE SETTLING, for organisations whose verdicts are already in.
     *
     * Enforcement is a handful of queries and it is the step that decides what
     * a card may draw; settlement decodes images and re-fetches source
     * documents, and the edge worker kills the invocation on its RESOURCE
     * limit long before the wall-clock budget below is reached. Every
     * production tick returned 546, which meant the loop after the settlement
     * tick was never arrived at: upload f7e0d4d1 held a complete set of
     * verdicts and its organisation's stale pointers went on not being
     * rewritten, one per tick at best.
     *
     * An upload still in the queue for its PROVENANCE half has nothing
     * outstanding that enforcement reads, so running it first is not running it
     * early. The `needsEligibility === false` test is the same licence
     * `eligibilitySettled` gives below — a finished sweep, banked on an earlier
     * pass — and `enforceStrictPrimaryImages` still skips any item holding an
     * unjudged candidate.
     */
    for (const candidate of candidates) {
      if (!candidate.needsEligibility) await enforce(candidate.organisation_id);
    }

    /*
     * ONE overlay-repair allowance for the whole tick, not one per upload.
     *
     * A repair is a full-resolution decode plus a reconstruction or up to four
     * model calls; the worker's resource limit is what kills this function, and
     * it kills it long before the wall clock above expires. Six uploads each
     * spending their own allowance is twelve of them and a 546 with nothing
     * written — which is the failure this whole settlement programme exists
     * because of. The budget is shared, so the tick spends it once.
     */
    const repairBudget = newRepairBudget();

    /**
     * ONE PHASE PER INVOCATION, AND PRODUCTION IS WHY.
     *
     * The three phases are independent questions with independent markers, and
     * running all three in one invocation is what kills this function: a tick
     * that re-reads a builder's Drive package (a folder listing, a multi-megabyte
     * PDF download, a text extraction and a raster extraction), THEN sweeps
     * display eligibility, THEN spends the overlay-repair budget on
     * full-resolution decodes, exceeds the worker's CPU allowance and returns
     * 546 with NOTHING WRITTEN. Every tick then does the same work and dies the
     * same way, so a queue that looks busy makes no progress at all — which is
     * exactly what a provenance-version bump produced here: 26 reopened
     * packages, and 546 on every tick.
     *
     * So the tick picks the one phase with work and does only that. Nothing is
     * skipped and no cap is relaxed: the phases have their own markers, the
     * sweep is resumable, and a phase deferred by this tick is the phase the
     * next tick picks. It costs ticks and never coverage.
     *
     * PROVENANCE FIRST, because it is the phase that DISCOVERS images. The
     * other two judge and repair pictures that provenance has already found, so
     * running them first would be spending the expensive budget deciding about
     * a smaller set than the one we are about to have.
     */
    // One phase per tick, rotated so none starves. See `settlementPhase.pure.ts`.
    const phase = choosePhase(candidates, startedAt, TICK_ROTATION_MS);

    const { attempted, settled, organisations } = await runSettlementTick(
      candidates,
      { maxSettled: MAX_UPLOADS_PER_TICK, deadlineAt },
      (candidate) => settleUploadSourceImages(supabase, {
        organisationId: candidate.organisation_id,
        uploadId: candidate.id,
        deadlineAt,
        needsProvenance: phase === 'provenance' && candidate.needsProvenance,
        needsEligibility: phase === 'eligibility' && candidate.needsEligibility,
        needsSanitization: phase === 'sanitization' && candidate.needsSanitization,
        repairBudget,
      }),
    );

    /**
     * And every organisation whose eligibility sweep finished DURING this tick,
     * which the pass above could not have known about.
     *
     * A property whose source no longer designates a displayable image must END
     * this run with no primary rather than the one it had under the old rules,
     * and that is true of properties the sweep never re-read, which is why it
     * is applied per organisation rather than per upload. What it must NOT do
     * is decide on evidence that was never gathered: `runSettlementTick`
     * collects an organisation only where the eligibility sweep actually
     * completed, and `enforceStrictPrimaryImages` skips any item still holding
     * an unjudged candidate. Between them, an unfinished backfill cannot clear
     * the pointer of a property whose picture is about to be approved.
     */
    for (const organisationId of organisations) await enforce(organisationId);

    /*
     * THE WEB-IMAGE STORE RUNS ON ITS OWN ENUMERATION, because an empty queue
     * is the steady state this pass exists in: a hotlinked "Web sourced" card
     * needs no settlement work to be fragile, and the first wiring of this —
     * inside `enforce`, which only runs for organisations with candidates —
     * measurably never ran once the marketplace had settled. It sits after
     * the settlement work so the drip can never delay the queue, and the
     * fallback path above runs the same pass before ITS return, because a
     * tick has two normal exits and the second wiring covered only this one.
     * A retirement hands the organisation to `enforce` (idempotent within the
     * tick), so a card whose picture is GONE is re-decided before this tick
     * returns and the badge goes with the photograph. See `webImageStore.ts`.
     */
    await runTickHousekeeping(supabase, async (organisationId) => {
      // Even where enforcement already ran this tick: the evidence just
      // changed, so the once-per-tick guard steps aside for the re-read.
      enforced.delete(organisationId);
      await enforce(organisationId);
    });

    const remaining = Math.max(0, outstanding.length - settled);
    console.log('[builder-stock-image-settler] tick', {
      attempted, settled, remaining, ms: Date.now() - startedAt,
    });
    // `phase` is reported because a tick that did one phase and left the others
    // is indistinguishable from a tick that did nothing, and telling them apart
    // from the outside is the whole point of this response.
    return json({
      success: true, phase, settled, attempted, remaining, complete: remaining === 0,
    });
  } catch (error) {
    // `internalError` builds the BODY; the handler owes `Deno.serve` a
    // Response. Returning the body meant the sweep's only failure path
    // answered with something the runtime cannot serve — and the arguments
    // were transposed besides, so the headers were being logged as the
    // context and the context discarded as a correlation id.
    return internalErrorResponse(error, '[builder-stock-image-settler]', corsHeaders);
  } finally {
    /*
     * Hand the turn back as soon as the work is done, on every path this
     * function can return by. A tick that took seven seconds must not hold the
     * next two minutes; the expiry above is the backstop for the one path that
     * runs no code at all — a resource-limit kill.
     */
    await releaseLease();
  }
});
