/**
 * Builder stock — judging images that were stored before there was a judgement.
 *
 * Ingestion decides display eligibility as it writes each image, so everything
 * imported from now on arrives judged. This is for everything already in the
 * bucket: the same decision, from the same bytes, reached by the same
 * function.
 *
 * THE BYTES ARE RE-READ, NEVER RE-FETCHED AND NEVER REWRITTEN. The stored
 * object is downloaded, measured and left exactly as it was — the object, its
 * hashes and its provenance are untouched. The only write is the verdict,
 * merged into `source_detail` beside the role rather than over it.
 *
 * IT SCANS BY KEYSET, WHICH IS THE PART THAT HAS TO BE RIGHT. An earlier
 * version read the first 5,000 rows and filtered them in memory. Past 5,000
 * images an organisation would have re-read the same already-settled page on
 * every pass and never reached the rest — a sweep that cannot finish is worse
 * than no sweep, because it looks like one. Every pass here starts after the
 * last id it saw, so the scan advances whether or not a row needed work.
 *
 * AND IT SEPARATES A DECISION FROM A FAILURE TO REACH ONE. Two things can stop
 * a row being settled and they are not the same thing:
 *
 *   the classifier could not decide     a container no decoder here reads, a
 *                                       picture past the resource ceiling, an
 *                                       image this classifier cannot call
 *                                       clean with enough confidence
 *                                       → a `pending` verdict, WRITTEN. That is
 *                                         a completed decision for this
 *                                         algorithm version: the card shows
 *                                         nothing, and the next version bump is
 *                                         what revisits it.
 *
 *   the operation failed                no `storage_path`, a download that
 *                                       errored, bytes that could not be read,
 *                                       a verdict write that was rejected, a
 *                                       page query that errored
 *                                       → NOTHING WRITTEN, counted as
 *                                         `unresolved`. The upload's marker must
 *                                         not advance, because the work has not
 *                                         been done.
 *
 * Collapsing the two is how a storage outage would have looked like a finished
 * sweep: every image skipped, `incomplete` false, marker advanced, cron
 * unscheduled, and every card empty for ever with nothing left to retry it.
 */
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import { sha256Hex } from './rasterPng.ts';
import { assessMarketplaceEligibility } from './assessSourceImage.ts';
import {
  marketplaceEligibilityDetail, needsEligibilityAssessment,
  sweepWillJudge,
} from './marketplaceEligibility.pure.ts';
import { SOURCE_SUPPLIED_STAGE, SOURCE_SUPPLIED_VERIFICATION } from './primaryImage.ts';

export interface EligibilitySettlement {
  /** Rows the scan walked past. */
  scanned: number;
  /** Primary images that still needed a verdict. */
  outstanding: number;
  /** Of those, how many this run measured and WROTE. */
  assessed: number;
  /** Of those, how many may not be drawn on a card. */
  rejected: number;
  /** Of those, how many the classifier could not decide. Not displayable. */
  unmeasured: number;
  /**
   * Rows that needed a verdict and did not get one because an OPERATION
   * failed. Any at all means this pass did not finish its work.
   */
  unresolved: number;
  /** True when the budget or the page ceiling ran out before the scan finished. */
  incomplete: boolean;
}

/**
 * May the caller record this upload as settled at the current version?
 *
 * The one place the rule lives, so the sweep and its tests cannot disagree
 * about it. A written `pending` verdict does not block settlement; a failed
 * download or a rejected write does.
 */
export function eligibilitySweepCompleted(outcome: EligibilitySettlement): boolean {
  return !outcome.incomplete && outcome.unresolved === 0;
}

/** Rows read per keyset page. Small enough to stay inside any budget. */
const PAGE = 200;
/** A ceiling on pages per call, so one organisation cannot hold the worker. */
const MAX_PAGES = 200;

interface ImageRow {
  id: string;
  storage_bucket: string | null;
  storage_path: string | null;
  source_detail: Record<string, unknown> | null;
}

/**
 * Judge every unjudged primary, walking the whole table by id.
 *
 * Only `primary_property` images are measured: nothing else can reach a card,
 * so a verdict for one would answer a question nobody asked. The role filter
 * lives in JavaScript because the role is inside a JSON column, but the SCAN
 * does not — it is keyed on `id`, so a page full of non-primary rows still
 * advances the cursor.
 */
export async function settleMarketplaceEligibility(
  db: any,
  organisationId: string,
  options: {
    deadlineAt?: number;
    uploadId?: string | null;
    /**
     * Judge ONE property's images and nobody else's.
     *
     * Used by the per-item settler, which has claimed exactly that property.
     * The scan is otherwise organisation-wide and paged, so without this a
     * claimed property's verdict waits behind every other image the
     * organisation holds.
     */
    stockItemId?: string | null;
  } = {},
): Promise<EligibilitySettlement> {
  const outcome: EligibilitySettlement = {
    scanned: 0, outstanding: 0, assessed: 0, rejected: 0, unmeasured: 0,
    unresolved: 0, incomplete: false,
  };

  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    if (options.deadlineAt && Date.now() > options.deadlineAt) {
      outcome.incomplete = true;
      return outcome;
    }

    let query = db
      .from('builder_stock_item_images')
      .select('id, storage_bucket, storage_path, source_detail')
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
      // The scan itself failed. Nothing has been established about the rows
      // beyond the cursor, so this pass has not finished and must not be
      // mistaken for one that did.
      outcome.unresolved += 1;
      outcome.incomplete = true;
      return outcome;
    }
    const rows = (data ?? []) as ImageRow[];
    if (!rows.length) return outcome;

    for (const row of rows) {
      outcome.scanned += 1;
      // The cursor advances on EVERY row, settled or not. See the header.
      after = row.id;

      if (!sweepWillJudge(row.source_detail)) continue;
      if (!needsEligibilityAssessment(row.source_detail)) continue;
      outcome.outstanding += 1;

      /*
       * A designated primary with nowhere to read its bytes from.
       *
       * Not a verdict: the picture exists as far as the row is concerned and
       * nothing here has looked at it. Left unresolved so the next tick tries
       * again — an object that has genuinely gone will keep the upload in the
       * queue, which is visible, and that is better than recording a decision
       * nobody made.
       */
      if (!row.storage_path) {
        outcome.unresolved += 1;
        continue;
      }

      if (options.deadlineAt && Date.now() > options.deadlineAt) {
        outcome.incomplete = true;
        return outcome;
      }

      const { data: blob, error: downloadError } = await db.storage
        .from(row.storage_bucket || STOCK_IMAGE_BUCKET)
        .download(row.storage_path);
      if (downloadError || !blob) {
        outcome.unresolved += 1;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch {
        // The object was handed over and could not be read. An operational
        // fault, not a picture this classifier could not decide about.
        outcome.unresolved += 1;
        continue;
      }

      const eligibility = await assessMarketplaceEligibility(bytes);

      const { error: writeError } = await db.from('builder_stock_item_images')
        .update({
          source_detail: {
            ...(row.source_detail ?? {}),
            // Bound to the bytes that were just hashed and judged, so a later
            // re-store of different bytes cannot inherit this verdict.
            ...marketplaceEligibilityDetail(eligibility, await sha256Hex(bytes)),
          },
        })
        .eq('id', row.id);
      if (writeError) {
        // The decision was reached and NOT persisted, so as far as anything
        // that reads this row is concerned it was never made.
        outcome.unresolved += 1;
        continue;
      }

      outcome.assessed += 1;
      if (eligibility.state === 'ineligible') outcome.rejected += 1;
      if (!eligibility.measured) outcome.unmeasured += 1;
    }

    if (rows.length < PAGE) return outcome;
  }

  // The page ceiling, not the wall clock: there is more to do next time.
  outcome.incomplete = true;
  return outcome;
}
