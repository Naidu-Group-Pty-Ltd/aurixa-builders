/**
 * Builder stock — running the overlay repair over images already in the bucket.
 *
 * Ingestion sanitizes as it stores, so everything imported from now on arrives
 * with its derivative made. This is for everything already there: the same
 * repair, from the same bytes, through the same function.
 *
 * THE ORIGINAL IS NEVER REWRITTEN. The stored object is downloaded, read, and
 * left exactly as it was — its bytes, its hashes, its provenance and its
 * display verdict all stand. A repair produces a NEW object beside it and a
 * record naming the original it came from; a card that serves the derivative is
 * one query away from the file the builder actually supplied, which is the
 * whole point of keeping both.
 *
 * WHAT IT PICKS UP. Only a designated primary that the display gate REFUSED for
 * carrying a laid-over graphic. Not a pending one — "we could not read it" is
 * not "there is a badge on it", and repairing a picture nothing could measure
 * would be repairing an imagined defect. Not an eligible one — a clean
 * photograph is served as supplied and must never go through an encoder for no
 * reason. And not a non-primary: an interior or a floorplan cannot reach a card
 * whatever is drawn on it.
 *
 * AND ONE OTHER THING: A PRIMARY CARRYING A PERSISTED REPAIR REGION. That is a
 * rectangle established by other means and recorded against these exact bytes
 * (`repairRegion.pure.ts`), and it is outstanding repair work whatever the
 * detector currently says — INCLUDING `not_annotated`, which is precisely the
 * case it exists for. A plate whose lettering falls below the measuring
 * resolution leaves no mask and no conviction, so without this such a picture is
 * served with the plate on it for ever, and the only other remedy is moving a
 * global threshold that was measured against real clean production facades and
 * is not safe to move. Every other rule still applies: primary only, the
 * deterministic route first, and the result still checked by the same
 * classifier before it may be served.
 *
 * IT SEPARATES A DECISION FROM A FAILURE TO REACH ONE, exactly as the
 * eligibility sweep does and for the same reason:
 *
 *   the repair refused        the gates said the reconstruction would be a
 *                             guess, the validation gate rejected the result,
 *                             or the result still measures as annotated
 *                             → a FAILURE RECORD, WRITTEN. That is a completed
 *                               answer for this version: the card shows
 *                               nothing, and a version bump is what revisits it.
 *
 *   the operation failed      no `storage_path`, a download that errored, an
 *                             upload that was rejected, a row write that failed
 *                             — AND a model that could not be reached: no
 *                             credential, a network fault, a rate limit, a
 *                             vendor account out of credit
 *                             → NOTHING WRITTEN, counted as `unresolved`. The
 *                               upload's marker must not advance.
 *
 * The model being unreachable belongs in the second column and I had it in the
 * first until production proved it: one billing outage would have parked every
 * unrepaired picture on a "we tried" record until the next version bump.
 *
 * AND IT IS CAPPED HARD, because this is the most expensive thing in the whole
 * programme: a full-resolution decode, a reconstruction, up to four model
 * calls, an encode, and a second decode to check the answer. See
 * `MAX_REPAIRS_PER_RUN`.
 */
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import { sanitizeSourceImage } from './sanitizeImage.ts';
import { sha256Hex } from './rasterPng.ts';
import {
  clearanceDetail, derivativeDetail, failureDetail, sanitizationSettled, storedOriginalSha,
  CLEARANCE_KEY, SANITIZATION_VERSION, type SanitizationClearance, type SanitizationFailure,
  type SanitizedDerivative,
} from './sanitizedDerivative.pure.ts';
import {
  oversizedRepairRegionShare, readRepairRegion, MAX_REPAIRED_SHARE,
  type RepairRegionBox,
} from './repairRegion.pure.ts';
import { sanitizationSweepAdmits, sweepWillJudge } from './marketplaceEligibility.pure.ts';
import { SOURCE_SUPPLIED_STAGE, SOURCE_SUPPLIED_VERIFICATION } from './primaryImage.ts';
import { PROVENANCE_VERSION, readPrimaryImageStanding } from './sourceImages.ts';

export interface SanitizationSettlement {
  scanned: number;
  /** Refused primaries that had not been through the repair at this version. */
  outstanding: number;
  /** Of those, how many this run produced a servable derivative for. */
  repaired: number;
  /** Of those, how many the repair refused — recorded, terminal for now. */
  refused: number;
  /**
   * Of those, how many were found to carry nothing to remove.
   *
   * NOT a repair and not a refusal: the classifier was wrong about the picture,
   * the builder's ORIGINAL is what the card shows, and no second object was
   * made. See `overlayClearance.pure.ts`.
   */
  cleared: number;
  /** Rows that needed work and did not get an answer because an OPERATION failed. */
  unresolved: number;
  /** True when the budget, the page ceiling or the repair cap ran out. */
  incomplete: boolean;
}

/** May the caller record this upload as sanitized at the current version? */
export function sanitizationSweepCompleted(outcome: SanitizationSettlement): boolean {
  return !outcome.incomplete && outcome.unresolved === 0;
}

/** Rows read per keyset page. */
const PAGE = 200;
/** A ceiling on pages per call, so one organisation cannot hold the worker. */
const MAX_PAGES = 200;

/**
 * How many pictures one INVOCATION may actually repair.
 *
 * DELIBERATELY VERY SMALL, and fitted the way the other caps in this programme
 * were: against the edge worker's RESOURCE limit rather than against the wall
 * clock. `MAX_ITEMS_RESTORED_PER_RUN` is 4 for work that fetches and parses a
 * document; this work decodes a full-resolution photograph, relaxes a diffusion
 * over it or makes up to four model calls, encodes a PNG and then decodes it
 * again to check. Two is what fits.
 *
 * AND IT IS AN INVOCATION BUDGET, NOT A PER-UPLOAD ONE, which is the mistake
 * every other cap in this area has already been through. A tick settles up to
 * six uploads; a per-upload cap of two is a per-tick cap of twelve, and twelve
 * of these is a `CPU Time exceeded` with nothing written and no marker moved —
 * the exact failure mode that cost this programme its first week. The caller
 * makes ONE budget and threads it through every upload in the tick.
 *
 * The sweep is resumable, so a small budget costs ticks and never coverage.
 */
const MAX_REPAIRS_PER_RUN = 2;

/**
 * How long a row that could not be looked at is passed over for.
 *
 * Long enough that a vendor outage stops consuming the allowance every minute,
 * short enough that the row is genuinely retried rather than parked: at the
 * five-minute sweep this is six attempts an hour, and at the one-minute sweep
 * used to drain a backlog it is still six. It is a COOLDOWN and never a
 * verdict — nothing reads it to decide whether a card may draw.
 */
const OPERATIONAL_RETRY_AFTER_MS = 10 * 60 * 1000;

/** Where the cooldown is recorded. Deliberately not one of the settling keys. */
const ATTEMPT_KEY = 'sanitization_attempt';

/**
 * When this row was last attempted, in epoch milliseconds — or 0 for never.
 *
 * ZERO IS THE POINT OF IT. A row nobody has looked at has waited longer than
 * any row somebody has, so it must sort ahead of every real timestamp; that is
 * what lets work which becomes outstanding today reach a queue whose earlier
 * rows are all blocked. An unparseable stamp reads as never for the same
 * reason: the safe direction is to look again.
 */
function attemptedAt(detail: Record<string, unknown>): number {
  const raw = detail[ATTEMPT_KEY];
  if (!raw || typeof raw !== 'object') return 0;
  const at = Date.parse(String((raw as { at?: unknown }).at ?? ''));
  return Number.isFinite(at) ? at : 0;
}

/** A repair allowance shared by every upload in one invocation. */
export interface RepairBudget {
  remaining: number;
}

/** One tick's allowance. Made by the caller, spent by every upload it settles. */
export function newRepairBudget(): RepairBudget {
  return { remaining: MAX_REPAIRS_PER_RUN };
}

interface ImageRow {
  id: string;
  stock_item_id: string | null;
  organisation_id: string;
  source_reference: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  source_detail: Record<string, unknown> | null;
}

/** Where a derivative lives: beside the original, under its version. */
function derivativePath(originalPath: string, imageId: string): string {
  const cut = originalPath.lastIndexOf('/');
  const directory = cut > 0 ? originalPath.slice(0, cut) : originalPath;
  return `${directory}/sanitized/v${SANITIZATION_VERSION}/${imageId}.png`;
}

/**
 * Repair every refused primary that has not been through this version.
 *
 * Keyset by `id` for the reason the eligibility sweep documents: a scan that
 * filters in memory re-reads the same settled page for ever once an
 * organisation is large enough, and a sweep that cannot finish is worse than no
 * sweep because it looks like one.
 */
export async function settleImageSanitization(
  db: any,
  organisationId: string,
  options: {
    deadlineAt?: number;
    uploadId?: string | null;
    /**
     * The invocation's shared repair allowance. Omitted, this upload gets one
     * of its own — which is right for a single call and wrong for a tick, so
     * the tick makes one and passes it to every upload.
     */
    budget?: RepairBudget;
    /** Injected in tests. Production passes nothing and the real repair runs. */
    sanitize?: typeof sanitizeSourceImage;
    /**
     * Repair ONE property's images and nobody else's.
     *
     * Used by the per-item settler, which has claimed exactly that property.
     * The scan is otherwise organisation-wide and restarts at the lowest id
     * every tick, which is how two Cloverton rows consumed the whole allowance
     * for hours while twelve rows behind them were never reached.
     */
    stockItemId?: string | null;
  } = {},
): Promise<SanitizationSettlement> {
  const outcome: SanitizationSettlement = {
    scanned: 0, outstanding: 0, repaired: 0, refused: 0, cleared: 0,
    unresolved: 0, incomplete: false,
  };
  const sanitize = options.sanitize ?? sanitizeSourceImage;
  const budget = options.budget ?? newRepairBudget();

  /**
   * An attempt that did no repair work, recorded so the NEXT tick spends its
   * allowance somewhere else.
   *
   * THE ALLOWANCE MAY NOT GROW. Two attempts is what a tick can afford — a
   * full-resolution decode, a relaxation over the mask or up to four model
   * calls, an encode and a re-decode to check — and letting a tick attempt a
   * third because the first two failed cheaply is how this function starts
   * returning 546 with nothing written. That was measured too: refunding the
   * allowance made every tick a worker kill.
   *
   * So the fix is not more attempts, it is attempting DIFFERENT ROWS. The scan
   * restarts at the lowest id every tick, so without this the same two rows are
   * attempted for ever.
   *
   * Measured in production. The image editor answered 429 "You have no credits
   * remaining" for two Cloverton rows. They hold the two lowest ids, the
   * allowance is two, and the log read `outstanding: 3, repaired: 0,
   * unresolved: 2` every minute for hours while twelve rows behind them were
   * never reached — most of which needed no vendor at all.
   *
   * WHAT IS WRITTEN IS NOT AN ANSWER ABOUT THE PICTURE. `sanitizationSettled`
   * reads the derivative, failure and clearance keys and nothing else, so this
   * key cannot settle a row, cannot blank a card and cannot survive a version
   * bump into meaning anything. It records only that we tried and could not
   * look, and it expires.
   *
   * AND IT IS NOW ALSO THE CLAIM. Nothing here ran under a lock, and nothing
   * needed to until there was more than one caller: the cron tick, the
   * portal's enrichment loop and a manual dispatch can all scan the same
   * organisation in the same minute, and each would have built the same
   * shortlist and spent its own allowance on the same rows — the expensive
   * work doubled (a full decode, up to four model calls billed to a real
   * vendor account) and two whole-column `source_detail` writes racing at the
   * end. So the stamp is written as a COMPARE-AND-SET: the update carries a
   * filter on the stamp this scan read (`->>at` equals what we saw, or is
   * absent), and `RETURNING id` says whether it applied. An invocation whose
   * filter matches nothing lost the row to another one — it does no download,
   * no decode, no model call, writes nothing and records nothing, because
   * "somebody else is repairing this" is not a fault and not an outcome: the
   * row stays outstanding, the loser's sweep stays incomplete, and the next
   * tick reads the answer the winner settled.
   *
   * The cooldown doubles as the lease: a claim whose holder died is a stamp
   * that ages past `OPERATIONAL_RETRY_AFTER_MS`, after which the next claim
   * compares against the stale stamp's own value and takes the row over. An
   * orphaned claim therefore costs one cooldown window — exactly what an
   * operational failure already cost.
   *
   * THE FILTER IS COMPOSED BY THE CLIENT, NEVER AS A STRING. The screening
   * consumer's claim is the precedent and the warning: an interpolated
   * `.or()` filter never parsed on the server while its test double accepted
   * it, so that claim had never once succeeded. This one is `.eq()`/`.is()`
   * on one JSON path, and the test doubles resolve that path against the row
   * the way the server resolves it against the column.
   */
  const claimAttempt = async (
    row: ImageRow, scanDetail: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    const stamp = { at: new Date().toISOString(), operational: true };
    try {
      const raw = scanDetail[ATTEMPT_KEY];
      const priorAt = raw && typeof raw === 'object'
        && typeof (raw as { at?: unknown }).at === 'string'
        ? (raw as { at: string }).at
        : null;
      let update = db.from('builder_stock_item_images')
        .update({
          source_detail: { ...scanDetail, [ATTEMPT_KEY]: stamp },
        })
        .eq('id', row.id);
      update = priorAt === null
        ? update.is(`source_detail->${ATTEMPT_KEY}->>at`, null)
        : update.eq(`source_detail->${ATTEMPT_KEY}->>at`, priorAt);
      const { data: won, error } = await update.select('id').maybeSingle();
      /*
       * A REFUSED STAMP IS NOT A NON-EVENT, and it used to be an invisible
       * one: the returned `error` was never read, so a policy change, a
       * constraint or a PostgREST fault took the cooldown away silently and
       * the settler went back to spending every tick on the same row with
       * nothing anywhere saying why. It says so — and now it also declines
       * the row: a repair that proceeded without the stamp would also be
       * proceeding without the claim, which is the race this exists to close.
       * The row stays outstanding and visible; the next tick tries again.
       */
      if (error) {
        console.warn('[builderStock] the repair attempt stamp was not recorded', {
          image_id: row.id,
          phase: 'image_sanitization',
          detail: String((error as { message?: unknown }).message ?? error).slice(0, 200),
        });
        return null;
      }
      // No row back and no error: the compare-and-set matched nothing, so
      // another invocation holds this row. Silent by design — a lost race is
      // ordinary operation, not something to warn about every tick.
      if (!won) return null;
      return stamp;
    } catch (error) {
      console.warn('[builderStock] the repair attempt stamp was not recorded', {
        image_id: row.id,
        phase: 'image_sanitization',
        detail: String(error).slice(0, 200),
      });
      return null;
    }
  };

  /**
   * Write the keys that settle a row, onto the row AS IT STANDS NOW.
   *
   * Every settling write used to rebuild the whole column from the snapshot
   * the scan read, which was taken before this repair stamped its attempt —
   * so settling put the pre-stamp column back and the cooldown died inside
   * the tick that created it. Harmless while the row then counted as settled;
   * the original starvation again the moment it could not, because a row that
   * cannot satisfy `sanitizationSettled` came back as the oldest waiter on the
   * very next tick, for ever, one model call each time.
   *
   * Re-reading first is what makes this safe against the other direction too:
   * an overlapping invocation that stamped the row while this repair was in
   * flight keeps its stamp, rather than being rewound to an older one. The
   * caller's own detail is the fallback for a read that fails, and it now
   * carries the stamp, so neither path can erase it.
   */
  const settleWrite = async (
    row: ImageRow,
    fallbackDetail: Record<string, unknown>,
    settlingKeys: Record<string, unknown>,
  ): Promise<{ error: unknown }> => {
    let base = fallbackDetail;
    try {
      const { data, error } = await db.from('builder_stock_item_images')
        .select('source_detail').eq('id', row.id).limit(1);
      const current = (data as Array<{ source_detail?: Record<string, unknown> | null }> | null)
        ?.[0]?.source_detail;
      if (!error && current && typeof current === 'object') base = current;
    } catch {
      /* The fallback already carries everything this repair knows. */
    }
    return await db.from('builder_stock_item_images')
      .update({ source_detail: { ...base, ...settlingKeys } })
      .eq('id', row.id);
  };

  /*
   * The attempt was stamped before the work began, so there is nothing to
   * record here. Finishing badly is not a second attempt: the stamp this used
   * to write bought no extra cooldown and widened the window in which a
   * concurrent write could be reverted.
   */
  const noteOperationalFailure = (): void => {
    outcome.unresolved += 1;
  };

  /** True while a recent operational attempt says to spend the tick elsewhere. */
  const attemptedRecently = (detail: Record<string, unknown>): boolean => {
    const at = attemptedAt(detail);
    return at > 0 && Date.now() - at < OPERATIONAL_RETRY_AFTER_MS;
  };

  /**
   * ONE PICTURE'S REPAIR, LIFTED OUT SO THE SCAN CAN CHOOSE BEFORE IT SPENDS.
   *
   * The work is identical to what the scan used to do inline. The only reason
   * it is a function is that WHICH rows the allowance goes to is now decided
   * across the whole scan rather than at the first row that qualifies — see
   * `consider`.
   */
  const repairOne = async (
    row: ImageRow & { storage_path: string },
    scanDetail: Record<string, unknown>,
    region: RepairRegionBox[] | null,
    /*
     * THE ATTEMPT WAS STAMPED — AS THE CLAIM — BEFORE THE WORK BEGAN, in the
     * spend loop, because the worst way a repair ends is one this function
     * never sees. A tick that exceeds its CPU allowance mid-repair is killed
     * by the runtime — no result, no catch, no write — and before the stamp
     * moved ahead of the work, the row it died on kept its old attempt stamp,
     * stayed the longest waiter, and was picked again by every subsequent
     * tick: the same 546 forever, one worker call spent each time, and every
     * row queued behind it starved. Production found the case the day the
     * generative route went live: Lot 914 Covella's persisted-region repair
     * is a five-megabyte PDF-page crop whose full-frame composite and
     * re-encode alone outrun the allowance, and three consecutive ticks died
     * on it before anything else was reached. Stamped first, a death
     * mid-repair leaves the cooldown — and the claim — behind it, so the next
     * tick spends the allowance on a DIFFERENT row and the oversized one is
     * retried at the cooldown's pace instead of every tick.
     *
     * ONE STAMP PER ATTEMPT, AND IT OUTLIVES THE OUTCOME. Every path that
     * finishes settles BESIDE this stamp rather than over it — see
     * `settleWrite`, which was the second half of this defect: a settling
     * write built from the scan's pre-stamp snapshot put the cooldown back to
     * absent, and a row that could not then count as settled was the oldest
     * waiter again on the very next tick. The stamp still cannot settle a
     * row, blank a card, or outlive its meaning.
     */
    attempt: Record<string, unknown>,
  ): Promise<void> => {
    /*
     * Everything below settles onto THIS object, which carries the stamp — so
     * a settling write can no longer put a pre-stamp column back on the row.
     * `settleWrite` re-reads the live column as well; this is the fallback for
     * a read that fails, and the two together are what make the cooldown
     * survive every outcome.
     */
    const detail = { ...scanDetail, [ATTEMPT_KEY]: attempt };

    const bucket = row.storage_bucket || STOCK_IMAGE_BUCKET;
    const { data: blob, error: downloadError } = await db.storage
      .from(bucket).download(row.storage_path);
    if (downloadError || !blob) {
      outcome.unresolved += 1;
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {
      outcome.unresolved += 1;
      return;
    }

    /*
     * THE HASH IS TAKEN OF THE BYTES THAT WERE JUST READ, not of the one
     * recorded in the row.
     *
     * The derivative's whole claim is "this came from those exact bytes", and
     * a claim keyed on a hash nobody re-computed is a claim about what the
     * row SAYS is in the bucket. Where the two disagree the stored hash is
     * the stale one, and keying on it would let a replaced object be served
     * through a derivative made from something else.
     */
    const actualSha = await sha256Hex(bytes);

    /*
     * The region is handed straight to the existing generic path and nothing
     * else about the call changes: the deterministic route is still tried
     * first, the result still goes back through the same classifier, and a
     * row without a region is called exactly as it was before.
     */
    const result = await sanitize(bytes, region ? { repairRegion: region } : {});

    if (result.ok === false) {
      /*
       * AN OPERATIONAL FAILURE IS NOT AN ANSWER ABOUT THE PICTURE, and I had
       * this wrong until production proved it. A model that could not be
       * reached — no credential, a network fault, a rate limit, a vendor
       * account with no credit left — tells us nothing about whether this
       * photograph can be repaired. Writing it down as a refusal parks the
       * picture on "we tried" until the next version bump, so one billing
       * outage would permanently blank every card it touched.
       *
       * It is exactly the distinction the eligibility sweep makes and the
       * same one the terminal-negative-provenance work was built on: "we
       * looked and there is nothing" is knowledge, "we could not look" is
       * not, and only the first may stop us looking again. Left unresolved,
       * so the marker does not advance and the next tick tries again.
       */
      if (result.reason === 'inpaint_unavailable' || result.reason === 'inpaint_failed') {
        console.warn('[builderStock] overlay repair could not reach the model', {
          image_id: row.id,
          phase: 'image_sanitization',
          detail: String(result.detail ?? '').slice(0, 200),
        });
        noteOperationalFailure();
        return;
      }

      /*
       * THE PICTURE WAS INSPECTED AND CARRIES NOTHING TO REMOVE.
       *
       * The classifier convicted it for something that is part of the house —
       * Lot 537 Kirramingly's white garage door is the case this was built
       * for — and the precise inspection found no type, no brand colour and
       * no plate. So the CLEARANCE is recorded and the builder's own file is
       * what the card draws.
       *
       * NOTHING IS WRITTEN TO STORAGE AND NO DERIVATIVE IS MADE. There is no
       * repair to store: the bytes that go on the card are the bytes already
       * in the row, unaltered, and a "cleaned copy" of a picture that was
       * never dirty would be a change to a photograph for no reason.
       *
       * It is checked BEFORE the operational test below on purpose. A
       * clearance is a finding, and a finding is never an operational fault.
       */
      if (result.clearance) {
        const clearance: SanitizationClearance = {
          sanitization_version: SANITIZATION_VERSION,
          original_image_id: row.id,
          original_sha256: actualSha,
          stock_item_id: String(row.stock_item_id ?? ''),
          organisation_id: String(row.organisation_id ?? organisationId),
          source_reference: row.source_reference ?? null,
          evidence: {
            text_run_count: result.clearance.textRunCount,
            strict_text_lines: result.clearance.strictTextLines,
            faint_text_lines: result.clearance.faintTextLines,
            flat_region_count: result.clearance.flatRegionCount,
            promotional_region_count: result.clearance.promotionalRegionCount,
            plate_count: result.clearance.plateCount,
          },
          cleared_at: new Date().toISOString(),
        };
        const { error: clearError } = await settleWrite(
          row, detail, clearanceDetail(clearance),
        );
        if (clearError) {
          outcome.unresolved += 1;
          return;
        }
        outcome.cleared += 1;
        return;
      }

      /*
       * AN OPERATION THAT FAILED IS NOT AN ANSWER EITHER. A decoder that fell
       * over, an encoder that did, a mask that could not be placed: the
       * picture is exactly as unexamined afterwards as before, and recording
       * a refusal would park it until the next version bump.
       */
      if (result.operational) {
        noteOperationalFailure();
        return;
      }

      if (result.reason === 'not_annotated') {
        /*
         * The stored verdict says annotated and a fresh reading of the same
         * bytes says otherwise. That is a disagreement between two versions
         * of the classifier, not a repair outcome, and writing a failure for
         * it would blame the repair for something it was never asked to do.
         * Left for the eligibility sweep, whose question it actually is.
         */
        outcome.outstanding -= 1;
        return;
      }
      /*
       * A REFUSED RENDER IS KEPT WHERE NOTHING SERVES IT.
       *
       * `rejected/` is not a derivative path and no reader looks in it: the
       * only thing that reaches a card is a record under `sanitized_derivative`
       * whose verdict is `eligible`, and a refusal writes no such record. What
       * this buys is the ability to LOOK at what the repair produced, which is
       * the difference between improving it and guessing at it. An upload that
       * fails here is not itself a failure — the refusal still gets written.
       */
      let rejectedPath: string | null = null;
      if (result.rejected && row.storage_path) {
        const path = `${derivativePath(row.storage_path, row.id)
          .replace(/\/[^/]+$/, '')}/rejected/${row.id}.png`;
        const { error: rejectedError } = await db.storage.from(bucket).upload(
          path,
          new Blob([result.rejected.bytes as unknown as BlobPart], { type: 'image/png' }),
          { contentType: 'image/png', upsert: true },
        );
        if (!rejectedError) rejectedPath = path;
      }

      const failure: SanitizationFailure = {
        transformation: result.transformation,
        sanitization_version: SANITIZATION_VERSION,
        original_image_id: row.id,
        original_sha256: actualSha,
        reason: result.reason,
        detail: String(result.detail ?? '').slice(0, 300),
        model: result.model,
        failed_at: new Date().toISOString(),
        rejected_path: rejectedPath,
      };
      const { error: writeError } = await settleWrite(
        row, detail, failureDetail(failure),
      );
      if (writeError) {
        outcome.unresolved += 1;
        return;
      }
      outcome.refused += 1;
      return;
    }

    const path = derivativePath(row.storage_path, row.id);
    const { error: uploadError } = await db.storage.from(bucket).upload(
      path,
      // A fresh view, so the storage client cannot retain the repair buffer.
      new Blob([result.bytes as unknown as BlobPart], { type: 'image/png' }),
      { contentType: 'image/png', upsert: true },
    );
    if (uploadError) {
      outcome.unresolved += 1;
      return;
    }

    const derivative: SanitizedDerivative = {
      transformation: result.transformation,
      sanitization_version: SANITIZATION_VERSION,
      original_image_id: row.id,
      original_sha256: actualSha,
      stock_item_id: String(row.stock_item_id ?? ''),
      organisation_id: String(row.organisation_id ?? organisationId),
      source_reference: row.source_reference ?? null,
      storage_bucket: bucket,
      storage_path: path,
      derivative_sha256: await sha256Hex(result.bytes),
      width: result.width,
      height: result.height,
      repaired_share: result.repairedShare,
      regions_removed: result.regionsRemoved,
      model: result.model,
      generated_at: new Date().toISOString(),
      verdict: result.verdict,
      classifier_state: result.classifierState,
    };

    const { error: recordError } = await settleWrite(
      row, detail, derivativeDetail(derivative),
    );
    if (recordError) {
      // The bytes are in the bucket and the record is not, so nothing will
      // serve them. Unresolved: the next pass remakes and re-records, and
      // `upsert` means the orphan is overwritten rather than accumulating.
      outcome.unresolved += 1;
      return;
    }

    outcome.repaired += 1;
  };

  /*
   * THE ALLOWANCE GOES TO THE ROWS THAT HAVE WAITED LONGEST, NOT THE LOWEST IDS.
   *
   * MEASURED IN PRODUCTION, AND IT IS THE COOLDOWN'S OWN FAILURE ONE STEP
   * FURTHER OUT. The cooldown stops a tick re-attempting the row it just
   * attempted; it does not stop every tick attempting the same small PREFIX of
   * the queue for ever. With nine rows outstanding, an allowance of two and a
   * ten-minute cooldown, four attempts fit in each cooldown window — so the
   * five lowest ids cycled among themselves and the four behind them were not
   * reached at all: one had last been looked at half an hour earlier, one an
   * hour and a half, and one had never been attempted once. The log read
   * `outstanding: 6` rather than 9, because the scan returned the moment the
   * allowance ran out and so did not even COUNT the rows it was starving.
   *
   * A row that has waited longest is the row we know least about, so that is
   * where the allowance goes. A row never attempted sorts ahead of every
   * attempted one, which is what makes newly outstanding work reachable on a
   * queue that is otherwise blocked — a fresh conviction, or a repair region
   * somebody has just recorded, would otherwise wait behind a prefix that never
   * clears, and no amount of waiting would help.
   *
   * IT SPENDS NOTHING EXTRA. The allowance is unchanged, the cooldown is
   * unchanged, and the scan reads what it always read; the shortlist holds at
   * most `budget.remaining` rows, so this is a bounded selection over a stream
   * and not a queue held in memory.
   */
  const slots = Math.max(0, budget.remaining);
  const shortlist: Array<{
    row: ImageRow & { storage_path: string };
    detail: Record<string, unknown>;
    region: RepairRegionBox[] | null;
    waitingSince: number;
  }> = [];
  /** Same truthiness test the loop always used, expressed so it narrows `row`. */
  const hasStoragePath = (r: ImageRow): r is ImageRow & { storage_path: string } =>
    Boolean(r.storage_path);
  const consider = (
    row: ImageRow & { storage_path: string },
    detail: Record<string, unknown>,
    region: RepairRegionBox[] | null,
  ): void => {
    if (slots <= 0) return;
    const waitingSince = attemptedAt(detail);
    let at = shortlist.length;
    while (at > 0 && shortlist[at - 1].waitingSince > waitingSince) at -= 1;
    shortlist.splice(at, 0, { row, detail, region, waitingSince });
    if (shortlist.length > slots) shortlist.length = slots;
  };

  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    if (options.deadlineAt && Date.now() > options.deadlineAt) {
      outcome.incomplete = true;
      break;
    }

    let query = db
      .from('builder_stock_item_images')
      .select('id, stock_item_id, organisation_id, source_reference, storage_bucket, '
        + 'storage_path, source_detail')
      .eq('organisation_id', organisationId)
      .eq('source_stage', SOURCE_SUPPLIED_STAGE)
      .eq('verification_status', SOURCE_SUPPLIED_VERIFICATION)
      .eq('processing_status', 'ready')
      .order('id', { ascending: true })
      .limit(PAGE);
    if (options.uploadId) query = query.eq('upload_id', options.uploadId);
    if (options.stockItemId) query = query.eq('stock_item_id', options.stockItemId);
    if (after) query = query.gt('id', after);

    const { data, error } = await query;
    if (error) {
      outcome.unresolved += 1;
      outcome.incomplete = true;
      return outcome;
    }
    const rows = (data ?? []) as ImageRow[];
    if (!rows.length) break;

    for (const row of rows) {
      outcome.scanned += 1;
      after = row.id;

      const detail = row.source_detail ?? {};
      if (!sweepWillJudge(detail)) continue;

      /*
       * A RECTANGLE SOMEBODY WROTE DOWN AGAINST THESE EXACT BYTES.
       *
       * This is the second way a picture reaches the repair, and it exists
       * because the first cannot see everything. The detector's mask builder
       * reads lines of TYPE; a plate whose lettering is below the measuring
       * resolution has no measurable extent, so a promotional plate can be
       * real, plainly visible to a person, and still leave the picture
       * measuring clean and being served with the plate on it.
       *
       * The region is read here rather than being a special case anywhere
       * further down: it is ordinary image metadata, any row may carry one, and
       * this code knows nothing about the picture beyond "this image has a
       * persisted explicit repair region". See `repairRegion.pure.ts` for the
       * origin test, which is the same one a derivative gets.
       */
      const region = readRepairRegion(detail, storedOriginalSha(detail));
      /*
       * A rectangle somebody recorded against these exact bytes and the area
       * ceiling refused. `readRepairRegion` fails closed, which makes it
       * indistinguishable from no rectangle at all — so say it once, because
       * whoever wrote it down is owed an answer other than silence.
       */
      const oversized = region ? null : oversizedRepairRegionShare(
        detail, storedOriginalSha(detail));
      if (oversized !== null) {
        console.warn('[builderStock] a recorded repair region asks for too much of the picture', {
          image_id: row.id,
          phase: 'image_sanitization',
          detail: `region covers ${(oversized * 100).toFixed(1)}% of the frame; the ceiling `
            + `is ${(MAX_REPAIRED_SHARE * 100).toFixed(0)}%`,
        });
      }

      /*
       * ONLY A PICTURE THE GATE CONVICTED — OR ONE CARRYING A REGION.
       *
       * `pending` is not a badge and `eligible` is not a defect; see the
       * header. That rule is untouched for every row without a region, which is
       * all but a handful of them. Where a region IS recorded the conviction has
       * already been reached by other means and recorded against these bytes,
       * so requiring the detector to agree would be requiring the instrument
       * that missed the plate to certify that it is there.
       */
      /*
       * THE ADMISSION IS NAMED ONCE AND IMPORTED, because the fallback
       * ladder's gate reads the same rule: `sourceVerdictOutstanding` waits
       * for a sanitization verdict exactly where this sweep will write one.
       * When this condition lived here as two inline tests, the ladder's
       * copy demanded a stamp from every primary — including the `pending`
       * ones these lines skip — and a property with an uncertain verdict
       * looped at `fallback` for ever. `readRepairRegion` inside the shared
       * predicate is the same fail-closed read as the one above, so a row
       * with an oversized or mis-attributed region still falls back to the
       * conviction test, exactly as before.
       */
      if (!sanitizationSweepAdmits(detail)) continue;

      /*
       * A CLEARANCE DOES NOT SETTLE A ROW THAT CARRIES A REGION.
       *
       * A clearance says "we looked and there is nothing on this picture"; a
       * region says "there is, and here it is". They cannot both be current,
       * and of the two the region is the one established by other means against
       * these exact bytes — so a standing clearance from before the region was
       * recorded is stale, and leaving it to settle the row would mean writing a
       * region down had no effect. A derivative and a failure still settle it:
       * the first is the work done, the second is a completed answer for this
       * version, and neither can be produced on the region path by accident.
       */
      const settled = region
        ? sanitizationSettled({ ...detail, [CLEARANCE_KEY]: null }, storedOriginalSha(detail))
        : sanitizationSettled(detail, storedOriginalSha(detail));
      if (settled) continue;

      /**
       * A CLEAN BUILDER ORIGINAL ALREADY SERVES THIS PROPERTY: NO REPAIR.
       *
       * The order of the whole stage is builder-supplied clean image first,
       * deterministic repair second, the worker third — and the first step is
       * decided HERE, because this is where a repair is about to be paid for.
       * Where the same property holds a proven clean primary (measured clean,
       * or cleared by the precise inspection, at the current provenance
       * standard), the card shows that untouched file and a repaired copy of
       * the convicted tile beside it would never be chosen — see
       * `chooseDisplayableImage`, where a clean original outranks a
       * derivative. Spending the tick's allowance, and a worker call, on a
       * picture the card will not draw is the exact spend this rule removes.
       *
       * ONLY the conviction path. A persisted repair region is an operator
       * saying "rebuild this exact rectangle", and an explicit request is a
       * legitimate reason to repair whatever else the property holds.
       *
       * And it is a SKIP, never a verdict: nothing is written, so the moment
       * the clean image is demoted or replaced the row is outstanding again on
       * the next scan.
       */
      if (!region && row.stock_item_id) {
        const standing = await readPrimaryImageStanding(
          db, String(row.stock_item_id), PROVENANCE_VERSION);
        if (standing.clean) continue;
      }

      outcome.outstanding += 1;

      // A type predicate rather than `if (!row.storage_path)`: the falsy check
      // narrows the PROPERTY and leaves `row` itself as ImageRow, so passing it
      // to `consider` — which needs `storage_path` to be a string — did not
      // compile. Same runtime test, same rows rejected; the difference is that
      // TypeScript can now carry the fact forward.
      if (!hasStoragePath(row)) {
        // A designated primary with nowhere to read its bytes from. Not an
        // answer about the picture: left unresolved so a later tick tries.
        outcome.unresolved += 1;
        continue;
      }
      /*
       * A row we could not look at a moment ago is passed over so this tick's
       * allowance reaches one we have not tried. It stays outstanding, so the
       * completeness test below keeps the sweep unsettled.
       */
      if (attemptedRecently(detail)) continue;

      consider(row, detail, region);
    }

    if (rows.length < PAGE) break;
    if (page === MAX_PAGES - 1) outcome.incomplete = true;
  }

  /*
   * AND ONLY NOW IS ANYTHING DECODED. Every row above cost a field read; the
   * work that kills this worker happens here, on the rows the scan chose.
   */
  for (const candidate of shortlist) {
    if (budget.remaining <= 0) break;
    if (options.deadlineAt && Date.now() > options.deadlineAt) break;
    /*
     * THE CLAIM COMES BEFORE THE SPEND. A lost claim is another invocation
     * already doing this exact work, so this one moves on with its allowance
     * intact — nothing expensive has happened, one filtered UPDATE is all a
     * lost race costs, and the shortlist bounds how many can be attempted.
     * The allowance still may not grow: `MAX_REPAIRS_PER_RUN` bounds the
     * repairs a tick performs exactly as before; what a lost claim frees is
     * spent on the tick's OTHER work, never on a third attempt here.
     */
    const attempt = await claimAttempt(candidate.row, candidate.detail);
    if (!attempt) continue;
    budget.remaining -= 1;
    await repairOne(candidate.row, candidate.detail, candidate.region, attempt);
  }

  /*
   * A SWEEP IS FINISHED WHEN EVERY OUTSTANDING ROW GOT AN ANSWER.
   *
   * The answers are the three that settle a row: repaired, refused, cleared. A
   * row skipped for its cooldown, one left over when the allowance ran out and
   * one whose operation failed are all rows with no answer, and the upload's
   * marker must not advance past any of them.
   */
  if (outcome.outstanding > outcome.repaired + outcome.refused + outcome.cleared) {
    outcome.incomplete = true;
  }
  return outcome;
}