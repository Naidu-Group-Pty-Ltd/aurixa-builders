/**
 * Builder Stock — one claimed property, one stage, one invocation.
 *
 * WHAT THIS REPLACES. `settleUploadSourceImages` settles an UPLOAD: it re-reads
 * the source document, walks every active property `created_at` ascending under
 * per-run caps, and ends the whole run on the first cap it hits. The marker is
 * not written, so the next tick starts again from row 1. On 29 August that walk
 * had reached item 13 of 23 in twenty-six hours, and items 14 to 23 — Lot 13
 * Hummock Rise and Lot 1663 Ringer Street among them — had never been read once.
 *
 * Here the caller has CLAIMED exactly one property. Nobody else holds it and
 * nobody is queued behind it, so the four stages become a state machine on that
 * property alone:
 *
 *     source -> eligibility -> sanitization -> fallback -> settled
 *
 * SOURCE FIRST, because it is the stage that DISCOVERS images; the next two
 * judge and repair pictures it has already found. FALLBACK LAST, because
 * #2305's rule stands: the three-stage ladder may not be bought against a card
 * that is about to receive the builder's own photograph. That rule is now
 * enforced PER PROPERTY rather than per deployment, which is the point of
 * requirement 8 — this property's source is finished, so this property's ladder
 * may run, whatever some other property is still waiting on.
 *
 * A VERSION BUMP MUST RE-OPEN THE PROPERTIES IT AFFECTS, and nothing here can
 * do that for it. The upload markers this replaces went stale on their own when
 * a classifier version rose, and the sweep noticed; `image_work_stage` does
 * not — a property at `settled` is never claimed again. So a bump to
 * `MARKETPLACE_ELIGIBILITY_VERSION`, `SANITIZATION_VERSION` or
 * `PROVENANCE_VERSION` ships, as it already must, with a migration that raises
 * `builder_stock_settlement_target`, and that migration is now also the place
 * to send the affected properties back to the stage that has to re-run them.
 * The old path still exists and still reads the markers, so this is a
 * completeness rule rather than a cliff — but a bump that moves no stage will
 * simply not be re-applied by the per-item path.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT AN IMAGE. Source discovery, the Drive
 * rendition rule, web verification, the Street View distance guard, image
 * priority and the sanitizer are all called exactly as they were and are not
 * touched. This module is orchestration: which property, which stage, and what
 * to write down afterwards.
 */
import { repairSourceImagesForUpload } from './repairSourceImages.ts';
import { RUNTIME_VERSION } from './runtimeVersion.pure.ts';
import { settleMarketplaceEligibility } from './settleMarketplaceEligibility.ts';
import {
  settleImageSanitization, type RepairBudget,
} from './settleImageSanitization.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import { isMarketplaceEligible } from './marketplaceEligibility.pure.ts';
import {
  servableClearanceFor, servableDerivativeFor,
} from './sanitizedDerivative.pure.ts';
import { repairStoredIdentity } from './storedIdentityRepair.pure.ts';
import { reverifyStoredWebImages } from './reverifyWebImages.ts';
import {
  describeSuppliedEvidence, readStoredRowEvidence,
  type SuppliedEvidenceReading,
} from './suppliedEvidence.pure.ts';
import { TELEMETRY_PREFIX, itemTelemetry } from './importTelemetry.pure.ts';
import { sourceWorkUploadId } from './stockLifecycle.pure.ts';
import { PROVENANCE_VERSION } from './provenanceVersion.pure.ts';
import type { ClaimedItem, ItemWorkStage } from './itemWorkClaim.ts';

export interface ItemSettlement {
  itemId: string;
  stage: ItemWorkStage;
  /** Where the property goes next. Same stage means "not finished". */
  nextStage: ItemWorkStage;
  /**
   * The step DID something, even if it did not finish. Clears the attempt
   * count so a healthy resumable property does not walk its own backoff up to
   * the hour cap. See `completeItemWork`.
   */
  progressed: boolean;
  /** Safe to log and to store on the row. Never a stack. */
  result: string;
  error?: string;
  /** True when this settlement wrote or corrected the card's picture. */
  primarySet: boolean;
  /**
   * A REAL failure happened — a source read that crashed or reported a fault,
   * a dependency that refused. Carried to `completeItemWork(p_failed)`, which
   * is the only writer of the bounded failure backoff and the counter the
   * watchdog escalates into the terminal 'failed' stage. Deferrals, clean
   * handbacks and stages with more to do never set it.
   */
  failed?: boolean;
}

/** The order the stages run in. Both terminals map to themselves. */
const NEXT_STAGE: Record<ItemWorkStage, ItemWorkStage> = {
  source: 'eligibility',
  eligibility: 'sanitization',
  sanitization: 'fallback',
  fallback: 'settled',
  settled: 'settled',
  failed: 'failed',
};

/**
 * The ladder rung a stored value names, or the first rung.
 *
 * Exported for the settler, which has to hand a claim BACK at the stage it
 * came from when there is not enough of the invocation left to finish it —
 * and `image_work_stage` arrives from the database as a plain string.
 */
export function readStage(value: unknown): ItemWorkStage {
  const stage = String(value ?? 'source');
  return (stage in NEXT_STAGE ? stage : 'source') as ItemWorkStage;
}

export interface ItemSettlementDeps {
  repairSource?: typeof repairSourceImagesForUpload;
  settleEligibility?: typeof settleMarketplaceEligibility;
  settleSanitization?: typeof settleImageSanitization;
  choosePrimary?: typeof chooseAndStorePrimaryImage;
}

/**
 * Do this property's current stage, and say where it goes next.
 *
 * THE PRIMARY POINTER IS SETTLED AFTER EVERY STAGE, not at the end of the
 * ladder and not at the end of the upload. `chooseAndStorePrimaryImage` is
 * already idempotent and already decides from that property's own rows alone —
 * a pure total order over clean-original, evidence level, position and id — so
 * running it here cannot make the card flicker and cannot depend on which
 * property was processed first. That is requirement 9, and it is the difference
 * between a builder photograph appearing on the card the minute it is approved
 * and waiting, as seven properties did on 29 August, for an unrelated walk over
 * twenty-three properties to finish. Those seven held a `ready`,
 * `primary_property`, `eligible` builder photograph and a NULL pointer.
 */
export async function settleClaimedItem(
  db: any,
  item: ClaimedItem,
  input: { deadlineAt?: number; repairBudget?: RepairBudget } = {},
  deps: ItemSettlementDeps = {},
): Promise<ItemSettlement> {
  const stage = readStage(item.image_work_stage);
  const repairSource = deps.repairSource ?? repairSourceImagesForUpload;
  const settleEligibility = deps.settleEligibility ?? settleMarketplaceEligibility;
  const settleSanitization = deps.settleSanitization ?? settleImageSanitization;
  const choosePrimary = deps.choosePrimary ?? chooseAndStorePrimaryImage;

  const settlement: ItemSettlement = {
    itemId: item.id, stage, nextStage: stage, progressed: false,
    result: 'nothing to do', primarySet: false,
  };
  /*
   * HOISTED SO THE ITEM'S OWN LINE CAN CARRY IT.
   *
   * The evidence reading is taken deep inside one branch, and it is the single
   * fact an operator needs about a property that is not progressing. Left
   * where it was taken, a support question about any other stage has no answer
   * at all — which is how five properties came to be explained days later from
   * database state rather than from what the run said at the time.
   */
  let evidenceSeen: SuppliedEvidenceReading | null = null;

  /*
   * NAME THE PROPERTY BEFORE ASKING ANYONE TO PHOTOGRAPH IT.
   *
   * Stage 2 identifies a property and stage 3 geocodes it, and both are
   * refused outright without an `address_line` — so a property that was
   * imported before its identity could be resolved reaches the bottom of the
   * ladder and finds it has no rungs. Measured: 89 properties claimed, every
   * stage advanced, 3 addresses between them and not one photograph.
   *
   * Fixing the normaliser fixes the NEXT import; this is what recovers the
   * ones already written down, from the raw row every source stores on the
   * property. It only ever fills an empty field, it is idempotent, and it runs
   * inside the claim so it needs no scheduler of its own.
   */
  await ensureCanonicalIdentity(db, item.id);

  /*
   * AND THEN ASK AGAIN ABOUT THE PICTURES ALREADY FOUND FOR IT.
   *
   * In that order, and the order is the whole point: the step above may have
   * just recovered the locality that a candidate was refused for lacking. A
   * search result's verdict was written once, when it was found, against
   * whatever the property knew about itself at that moment — so an identity
   * that improves reaches every future search and none of the results already
   * in the table. It spends nothing; the evidence was stored beside each
   * candidate for exactly this.
   */
  await reverifyWebImagesFor(db, item.id);

  try {
    if (stage === 'source') {
      /*
       * A property with no upload has no source to re-read — it cannot be the
       * source stage's business, so it moves on rather than being retried for
       * ever against a document that does not exist.
       */
      /*
       * THE UPLOAD WAITING ON THIS PROPERTY, WHICH IS NOT ALWAYS THE ONE IT
       * SERVES. See `sourceWorkUploadId`: a matched row keeps the OLD
       * `upload_id` until the atomic cutover, so a replacement's imagery must
       * be settled against `pending_upload_id` or the stage re-reads a
       * document the builder has already superseded.
       */
      const sourceUploadId = sourceWorkUploadId(item);
      if (!sourceUploadId) {
        settlement.nextStage = NEXT_STAGE.source;
        settlement.result = 'no source document';
        settlement.progressed = true;
      } else {
        const repair = await repairSource(db, {
          organisationId: item.organisation_id,
          uploadId: sourceUploadId,
          deadlineAt: input.deadlineAt,
          // The whole change. Identity is still resolved over every row of the
          // document; only the WORK belongs to this property.
          onlyItemId: item.id,
        });
        settlement.progressed = repair.imagesStored > 0
          || repair.matched > 0 || repair.demoted > 0 || repair.primaryUpdated > 0;
        settlement.result = `source: stored ${repair.imagesStored}, matched ${repair.matched}`;
        /*
         * A SOURCE THAT COULD NOT BE READ IS A FAILURE, NOT A FINISHED READ.
         * `repair.error` used to be console.warn'd and forgotten while the
         * item advanced out of `source` — production 2026-09-15: "That source
         * could not be read again", six blank active cards. It now counts
         * (bounded backoff, watchdog escalation) and the item stays put.
         */
        if (repair.error) {
          settlement.failed = true;
          settlement.progressed = false;
          settlement.error = String(repair.error).slice(0, 400);
          settlement.result = 'source read failed';
          settlement.nextStage = 'source';
        } else
        /*
         * `incomplete` means this property's source work has more to do — a
         * package it declined to open on the remaining budget, say. It stays
         * on `source`, and because a claim that RETURNED reports progress
         * rather than silence, it is claimable again immediately rather than
         * backing off.
         *
         * A package that has exhausted MAX_PACKAGE_ATTEMPTS does NOT come back
         * here: `repairSourceImages` writes it the terminal
         * `no_deterministic_image` verdict itself and the run reports complete,
         * so the property moves to the next stage and reaches its own fallback
         * ladder. That counter is the package's, is written before the
         * download begins, and is untouched by anything in this module.
         */
        settlement.nextStage = repair.incomplete ? 'source' : NEXT_STAGE.source;
      }
    } else if (stage === 'eligibility') {
      const eligibility = await settleEligibility(db, item.organisation_id, {
        deadlineAt: input.deadlineAt, stockItemId: item.id,
      });
      settlement.progressed = eligibility.assessed > 0 || eligibility.scanned > 0;
      settlement.result = `eligibility: assessed ${eligibility.assessed} of ${eligibility.scanned}`;
      settlement.nextStage = eligibility.incomplete ? 'eligibility' : NEXT_STAGE.eligibility;
    } else if (stage === 'sanitization') {
      const sanitization = await settleSanitization(db, item.organisation_id, {
        deadlineAt: input.deadlineAt, stockItemId: item.id, budget: input.repairBudget,
      });
      /*
       * An ANSWER is a repair, a clearance or a refusal — the three outcomes
       * that settle an image. A scan alone is not one: it re-reads the row and
       * decides nothing.
       */
      const answered = sanitization.repaired + sanitization.cleared + sanitization.refused;
      settlement.progressed = answered > 0;
      settlement.result = `sanitization: repaired ${sanitization.repaired}, `
        + `cleared ${sanitization.cleared}, refused ${sanitization.refused}`;
      /*
       * A SWEEP THAT ANSWERED NO IMAGE DOES NOT SPIN HERE — the stall this
       * fixes, measured live 2026-09-15.
       *
       * The overlay-inpaint worker is an OPTIONAL dependency
       * (`BUILDER_STOCK_IMAGE_WORKER_URL`), and a deployment without it cannot
       * repair an annotated tile: `sanitizeSourceImage` returns operationally,
       * `settleImageSanitization` records no answer, and the image stays
       * `outstanding` for ever — so `incomplete` was true every tick, the item
       * looped `nextStage=sanitization` and never reached `fallback`, where its
       * OTHER builder sources are judged. Four live properties spun that way
       * (`progressed=true` each tick, primary never set) while a row-linked
       * brochure whose facade IS recoverable sat one stage on.
       *
       * So `incomplete` keeps the item on `sanitization` only while the sweep
       * is actually ANSWERING images (more to do, and doing it); a sweep that
       * answered none advances to `fallback`. Fallback routes a property whose
       * builder facade is still recoverable back to `source` (where it is
       * elected and becomes the primary), and a genuinely exhausted one to the
       * terminal `failed` — a person paged, never a blank published card, never
       * a silent spin. A `SANITIZATION_VERSION` bump re-opens the deferred
       * images once a worker is configured. No optional worker is a
       * degradation, not a deadlock.
       */
      settlement.nextStage = (sanitization.incomplete && answered > 0)
        ? 'sanitization'
        : NEXT_STAGE.sanitization;
    } else if (stage === 'fallback') {
      /*
       * THE LAST RUNG IS NO LONGER A LADDER — the invariant of 2026-09-15.
       *
       * Builder Stock imagery is authoritative, so nothing external is bought
       * here any more. This stage is now purely the ACCOUNTING of what the
       * builder's own sources yielded, routed over the same
       * `readSuppliedEvidence` record as before so no second implementation
       * of the question can drift:
       *
       *   found — the builder's picture is on the card. The property settles
       *   and its enrichment is marked complete, which is what retires it
       *   from every queue.
       *
       *   pending / processing — sources are still owed a look; back to
       *   `source`.
       *
       *   retryable_failure — at least one source finished on a fault of
       *   OURS. The old code settled this with a blank card and
       *   `enrichment_status='failed'` — production 2026-09-15, six live
       *   properties whose own row said "this is a fault on our side". It is
       *   now a COUNTED failure that returns to `source`: bounded backoff,
       *   twelve failures and the watchdog moves it to the terminal 'failed'
       *   stage where a person is paged, and a PROVENANCE_VERSION bump
       *   re-opens the branches for a corrected extractor. Never blank, never
       *   silent, never external.
       *
       *   exhausted / no_evidence — every builder source was genuinely READ
       *   and none supplies a photograph, or the row names no source at all.
       *   Under the invariant that is terminal 'failed' too: the remedy is a
       *   person's (link a brochure, or "Add picture"), and the card must
       *   say so rather than publish blank or borrow the internet's imagery.
       */
      const evidence = await readItemSuppliedEvidence(db, item.id);
      if (!evidence) {
        settlement.failed = true;
        settlement.result = 'supplied evidence could not be read';
        settlement.nextStage = 'fallback';
      } else if (evidence.state === 'found') {
        settlement.progressed = true;
        settlement.result = describeSuppliedEvidence(evidence);
        settlement.nextStage = 'settled';
        try {
          await db.from('builder_stock_items')
            .update({
              enrichment_status: 'complete',
              enriched_at: new Date().toISOString(),
            })
            .eq('id', item.id)
            .eq('organisation_id', item.organisation_id);
        } catch {
          // Unwritten means the queue read keeps it; the next claim retries.
        }
      } else if (evidence.state === 'pending' || evidence.state === 'processing') {
        settlement.progressed = true;
        settlement.result = describeSuppliedEvidence(evidence);
        settlement.nextStage = 'source';
      } else if (evidence.state === 'retryable_failure') {
        settlement.failed = true;
        settlement.result = describeSuppliedEvidence(evidence);
        settlement.nextStage = 'source';
      } else {
        settlement.progressed = true;
        settlement.result = describeSuppliedEvidence(evidence);
        settlement.nextStage = 'failed';
        try {
          await db.from('builder_stock_items')
            .update({
              enrichment_status: 'failed',
              enriched_at: new Date().toISOString(),
            })
            .eq('id', item.id)
            .eq('organisation_id', item.organisation_id);
        } catch {
          // Unwritten means the queue read keeps it; the next claim retries.
        }
      }
      if (evidence) {
        evidenceSeen = evidence;
        console.info('[builderStock] supplied evidence routed', {
          phase: 'fallback_routing', stock_item_id: item.id,
          supplied_evidence: evidence.state, next_stage: settlement.nextStage,
          sources_total: evidence.total, sources_open: evidence.open,
          sources_inspected: evidence.inspected,
          sources_operational: evidence.operational,
        });
      }
    }
  } catch (error) {
    /*
     * A failed stage is reported and left where it is. The claim's own backoff
     * decides when it is tried again, and the message is stored on the row so
     * an operator can see WHY a property is not progressing — which is the
     * thing the upload-level markers could never say about a single card.
     */
    settlement.error = String((error as { message?: string })?.message ?? error).slice(0, 400);
    settlement.result = `${stage} failed`;
    settlement.nextStage = stage;
    settlement.progressed = false;
  }

  /*
   * AND THE CARD'S PICTURE, WHATEVER THE STAGE DID — including a stage that
   * failed. The pointer is decided from rows already in the table, so a
   * photograph approved by an earlier tick must not stay unpointed because a
   * later stage threw.
   */
  try {
    const primary = await choosePrimary(db, item.id);
    settlement.primarySet = !!primary;
  } catch {
    // Never fatal. The pointer is settled again on the next claim, and by the
    // organisation-wide enforcement the old path still runs.
  }

  /*
   * ONE LINE PER ITEM PER TICK, ON EVERY PATH INCLUDING THE QUIET ONES.
   *
   * `lifecycle_status` is here because a staged row doing exactly the right
   * thing and a lost row look identical from outside, and the incident this
   * release closes was 47 properties in `staged` with nothing anywhere saying
   * so. Best-effort; a line is never worth a settlement.
   */
  try {
    console.info(`${TELEMETRY_PREFIX} stock item settled`, itemTelemetry({
      itemId: item.id,
      uploadId: sourceWorkUploadId(item),
      lifecycle: item.lifecycle_status,
      workStage: settlement.nextStage,
      evidence: evidenceSeen?.state ?? null,
      /*
       * NAMED ONLY WHERE SOMETHING WAS ACTUALLY EXHAUSTED, and decided by the
       * counts rather than by the word: a reading with any source retired on a
       * fault of ours is `operational` however many others were read, because
       * the question this answers is whether the builder may be told anything
       * about their document at all.
       */
      exhaustion: evidenceSeen?.state === 'exhausted'
        ? (evidenceSeen.operational > 0 ? 'operational' : 'inspected')
        : null,
      sourcesTotal: evidenceSeen?.total ?? null,
      sourcesInspected: evidenceSeen?.inspected ?? null,
      sourcesOperational: evidenceSeen?.operational ?? null,
      sourcesOpen: evidenceSeen?.open ?? null,
      hasPrimaryImage: settlement.primarySet,
      attempts: item.image_work_attempts,
      nextStage: settlement.nextStage,
      detail: settlement.error ?? settlement.result,
    }));
  } catch { /* the settlement is the deliverable */ }

  return settlement;
}


/**
 * Fill a stored property's canonical identity from its own source row.
 *
 * Reads the record the import persisted, maps the columns it could not place
 * through the CURRENT alias table, and writes back only what is still empty.
 * A property whose identity is already complete costs one indexed read and
 * writes nothing.
 */
async function ensureCanonicalIdentity(db: any, itemId: string): Promise<void> {
  // BEST EFFORT, ALWAYS. This enriches the inputs a later stage uses; it is
  // never the work itself, so anything it cannot do leaves the stage running
  // exactly as it did before. A caller whose client cannot answer this read at
  // all — a narrower double, a deployment mid-migration — simply skips it.
  if (typeof db?.from !== 'function') return;
  try {
    await repairCanonicalIdentity(db, itemId);
  } catch (error) {
    console.warn('[builderStock] canonical identity could not be repaired', {
      phase: 'identity_repair', stock_item_id: itemId,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
}

async function repairCanonicalIdentity(db: any, itemId: string): Promise<void> {
  const { data: row } = await db
    .from('builder_stock_items')
    .select('id, address_line, suburb, state, postcode, lot_number, unit_number, '
      + 'development_name, project_name, source_row')
    .eq('id', itemId)
    .maybeSingle();
  /*
   * NO SHORT CIRCUIT ON `address_line`. A record that HAS a street address can
   * still be missing the locality beside it, and `geocodableAddress` needs two
   * parts — so an early return here would leave exactly the properties whose
   * address is real but unqualified unfindable. `repairStoredIdentity` already
   * refuses to write over any field the import resolved, which is the guard
   * that actually matters.
   */
  if (!row) return;

  const { patch, recovered } = repairStoredIdentity(
    row as never, row.source_row as never);
  if (!recovered.length) return;

  const { error } = await db.from('builder_stock_items').update(patch).eq('id', itemId);
  if (error) {
    // Not fatal: the stage below simply runs with what the property already
    // had, exactly as it did before. Saying so is what makes it findable.
    console.warn('[builderStock] canonical identity could not be written', {
      phase: 'identity_repair', stock_item_id: itemId, recovered,
      detail: (error as { message?: string }).message ?? 'unknown',
    });
  }
}


/**
 * Re-ask the identity question for this property's stored web candidates.
 *
 * Reads the property's identity as it now stands and hands it to the one
 * module that decides. Best effort throughout: this improves what a later step
 * may rank and is never the stage's own work.
 */
async function reverifyWebImagesFor(db: any, itemId: string): Promise<void> {
  if (typeof db?.from !== 'function') return;
  try {
    const { data: row } = await db
      .from('builder_stock_items')
      .select('id, organisation_id, address_line, suburb, state, postcode, '
        + 'lot_number, unit_number, development_name, project_name')
      .eq('id', itemId)
      .maybeSingle();
    if (!row) return;

    /*
     * The builder's trading name, read from the property's OWN organisation.
     * A name supplied from anywhere else would verify one builder's picture
     * against another's identity.
     */
    let builderName: string | null = null;
    try {
      const { data: org } = await db
        .from('builder_organisations')
        .select('trading_name, legal_name')
        .eq('id', row.organisation_id)
        .maybeSingle();
      const named = (org ?? {}) as { trading_name?: string; legal_name?: string };
      builderName = named.trading_name || named.legal_name || null;
    } catch {
      // A name we could not read is one the check does without.
    }

    await reverifyStoredWebImages(db, itemId, {
      addressLine: row.address_line,
      lotNumber: row.lot_number,
      unitNumber: row.unit_number,
      developmentName: row.development_name,
      projectName: row.project_name,
      suburb: row.suburb,
      state: row.state,
      postcode: row.postcode,
      builderName,
    });
  } catch (error) {
    console.warn('[builderStock] stored web candidates could not be re-judged', {
      phase: 'web_identity_reverify', stock_item_id: itemId,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
}


/**
 * This property's supplied-evidence reading, from its own stored row.
 *
 * READ RATHER THAN RE-DERIVED. The branches come from the row the import
 * persisted — which is the only place the targets recovered from a Google
 * Sheet's hyperlinks exist at all — and the answers come from the provenance
 * column beside it. Nothing here re-reads the builder's document.
 *
 * A READ THAT FAILED IS NOT A PROPERTY WITH NO EVIDENCE. It answers null, the
 * caller falls through to the ordinary path, and the gate inside
 * `settleFallbackImages` — which reads the same two columns as part of the
 * queue it was already selecting — still refuses. Failing open HERE is safe
 * precisely because the enforcement is not here.
 */
async function readItemSuppliedEvidence(
   
  db: any,
  itemId: string,
): Promise<SuppliedEvidenceReading | null> {
  if (typeof db?.from !== 'function') return null;
  try {
    const { data, error } = await db
      .from('builder_stock_items')
      .select('id, source_row, source_provenance_result, primary_image_id')
      .eq('id', itemId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    /*
     * A SUCCESS CLEARS ITS BRANCH RECORD, so the accepted picture — not the
     * provenance column — is what says this property is finished. Without
     * this read, a property whose brochure just yielded its image reads
     * `pending` and is routed back to `source` on every lap, for ever.
     */
    /*
     * ACCEPTED MEANS DISPLAYABLE — 2026-09-15, measured live within the hour
     * the invariant shipped. A ready row the classifier refused
     * (`overlay_uncertain` on a shared plan-like PNG) read as "the builder's
     * picture is on this card" and settled six properties with NULL
     * primaries while their brochures went unread. 'found' now means what
     * the card can actually serve: measured eligible, or a servable
     * derivative or clearance.
     */
    let builderImageAccepted = false;
    try {
      const { data: supplied, error: suppliedError } = await db
        .from('builder_stock_item_images')
        .select('id, storage_path, external_url, source_detail')
        .eq('stock_item_id', itemId)
        .eq('source_stage', 'uploaded_document')
        .eq('processing_status', 'ready')
        .limit(20);
      builderImageAccepted = !suppliedError && Array.isArray(supplied)
        && supplied.some((row: any) => {
          if (!(row.storage_path || row.external_url)) return false;
          const detail = (row.source_detail ?? {}) as Record<string, unknown>;
          return isMarketplaceEligible(detail)
            || !!servableDerivativeFor(detail)
            || !!servableClearanceFor(detail);
        });
    } catch {
      builderImageAccepted = false;
    }
    // The one shared row reader — enforcement in `settleFallbackImages` reads
    // the same function over the same stored row, so routing and enforcement
    // cannot disagree about a property.
    return readStoredRowEvidence({
      sourceRow: row.source_row,
      stored: row.source_provenance_result,
      provenanceVersion: PROVENANCE_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      builderImageAccepted,
    });
  } catch {
    return null;
  }
}
