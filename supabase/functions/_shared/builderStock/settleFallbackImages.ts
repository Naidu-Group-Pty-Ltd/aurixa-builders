/**
 * Builder stock — the FALLBACK ladder, driven by the background sweep rather
 * than by somebody's browser.
 *
 * WHAT WAS WRONG. The fallback ladder already existed and was already correct:
 * `enrichStockItem` runs stage B (a web photograph verified against the exact
 * property) and then stage C (Street View bound to the address), and
 * `nextImageStage` decides which. It had exactly ONE caller in production —
 * `builder-portal-stock`'s `enrich_images` loop, which only runs while a
 * builder has the page open. The autonomous settler drove provenance,
 * eligibility, sanitization and primary enforcement, and never once called it.
 *
 * So an import finished its builder-source recovery, the settler's queue went
 * empty, the tick answered `complete: true`, pg_cron unscheduled itself — and
 * a property whose builder supplied no usable photograph sat blank for ever,
 * because the only thing that would have looked elsewhere was a browser that
 * had been closed hours earlier. Production, 28 August 2026: three properties
 * with a terminal `no_deterministic_image`, zero image rows of any kind, all
 * 23 items still `enrichment_status = 'pending'` with `enriched_at` null. The
 * ladder had never run for a single one of them.
 *
 * THIS MODULE IS ORCHESTRATION AND NOTHING ELSE. It does not decide which
 * stage a property is owed, does not verify a web result's identity, does not
 * call Street View, does not rank an image and does not pick a primary. Every
 * one of those is `enrichStockItem`'s, imported rather than restated — a
 * second copy of the ladder is how the two would come to disagree about which
 * house is on somebody's card.
 */
// TYPE-ONLY, and the implementation is imported lazily below. `images.ts`
// reaches for the edge runtime through its provider modules, so importing it
// eagerly would make this module — and the settler's whole completion rule —
// unloadable anywhere but Deno. The same reason `repairSourceImages.ts`
// defers `fetchSource.ts`.
import type { enrichStockItem, EnrichableStockItem } from './images.ts';
import { RUNTIME_VERSION } from './runtimeVersion.pure.ts';
import { PROCESSED_LIFECYCLE } from './stockLifecycle.pure.ts';
import {
  describeSuppliedEvidence, fallbackMayRun, readStoredRowEvidence,
} from './suppliedEvidence.pure.ts';
import { PROVENANCE_VERSION } from './provenanceVersion.pure.ts';

/**
 * How many properties one tick may put through the paid ladder.
 *
 * ONE. The settler's whole history is of being killed by the edge runtime for
 * doing too much in a tick — an import path that stored images inline, a
 * provenance re-read on the tick's clock, a package recovery begun with no
 * headroom — and each of those returned no body, no CORS header and no marker.
 * A fallback item is a Perplexity search, a geocode, a Street View metadata
 * call and a Street View still, each on a forwarded vendor credential.
 *
 * Correctness does not depend on speed here, because the cron is resumable and
 * every item's outcome is durable: one per tick drains any queue eventually,
 * and a queue that drains slowly is strictly better than a worker that dies
 * holding the whole batch.
 */
export const MAX_FALLBACK_ITEMS_PER_TICK = 1;

/**
 * How many ladder rungs one property may climb in one tick.
 *
 * TWO, because the ladder is two rungs and `enrichStockItem` climbs exactly
 * one per call. That is not a defect in it — one stage per call is what makes
 * the browser's loop cheap — but it means a property whose web result FAILS
 * its identity check writes a terminal `failed` and leaves the
 * pending/enriching queue having never been offered Street View. Stage C would
 * be unreachable for precisely the properties that need it most.
 *
 * So the driver offers the second rung itself, and only when the first one
 * left the property with no picture. A verified web photograph ends the tick
 * with no Street View call at all.
 */
const MAX_STAGES_PER_ITEM = 2;

/**
 * The columns `enrichStockItem` reads, PLUS the two the supplied-evidence gate
 * needs.
 *
 * `source_row` carries the builder's own link columns (including the ones only
 * hyperlink recovery could see) and `source_provenance_result` carries what
 * each of those links has answered. Both are read here rather than in a second
 * query per row, because the gate has to be asked for every candidate and an
 * N+1 against the fallback queue is how a cheap guard becomes an expensive
 * one.
 */
const CANDIDATE_COLUMNS = 'id, organisation_id, address_line, suburb, state, '
  + 'postcode, development_name, project_name, lot_number, unit_number, primary_image_id, '
  + 'source_row, source_provenance_result';

export interface FallbackOutcome {
  /** Properties this tick took off the queue and put through the ladder. */
  attempted: number;
  /** Of those, the ones that ended holding a displayable picture. */
  resolved: number;
  /**
   * Of those, the ones where a paid stage ACTUALLY RAN.
   *
   * `attempted` counts properties put through the ladder, which is not the
   * same as work done: a pass whose `nextImageStage` answers `none` or `wait`
   * runs nothing, and both were being reported to the caller as an attempt.
   * `settleClaimedItem` turns that into `progressed: true`, which clears the
   * backoff and makes the row claimable in the same millisecond — so a
   * property the ladder could never move was re-claimed 126 times inside one
   * invocation. A rung climbed is the honest unit of progress here.
   */
  laddered: number;
  /** Properties still owed the ladder AFTER this tick. */
  remaining: number;
  /** True when the queue could not be read — never confused with an empty one. */
  unavailable?: boolean;
  /**
   * Properties the gate refused because the builder's own sources are not
   * finished with. Reported separately from `attempted` because it is not a
   * failure and not a spend: it is the ladder correctly declining to run.
   */
  withheld: number;
  problems: Array<{ item: string; reason: string }>;
}


/**
 * Has a builder-supplied picture been accepted for this property?
 *
 * One indexed read. A read that FAILS answers false, which is the withholding
 * direction: the gate then treats the property by its branch records alone,
 * and the worst outcome is a tick's delay — never a spend and never a wrong
 * image.
 */
async function hasBuilderSuppliedImage(db: any, itemId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('builder_stock_item_images')
      .select('id')
      .eq('stock_item_id', itemId)
      .eq('source_stage', 'uploaded_document')
      .eq('processing_status', 'ready')
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}


/**
 * The properties still owed the fallback ladder.
 *
 * THE SAME SEMANTIC QUEUE THE PORTAL USES — `lifecycle_status = 'active'` and
 * `enrichment_status IN ('pending','enriching')` — read from the existing
 * columns. No new status table, no new column, no migration. `complete`,
 * `partial` and `failed` are terminal here exactly as they are terminal there,
 * which is what stops a property that genuinely has no available picture from
 * being bought again on every tick for ever.
 */
export async function readFallbackQueue(
  db: any,
  input: { limit: number; stockItemId?: string | null },
): Promise<{ rows: Array<Record<string, unknown>>; unavailable?: boolean }> {
  const limit = Math.max(1, Math.min(input.limit, 200));
  try {
    let query = db
      .from('builder_stock_items')
      .select(CANDIDATE_COLUMNS)
      .in('lifecycle_status', PROCESSED_LIFECYCLE)
      .in('enrichment_status', ['pending', 'enriching'])
      .order('created_at', { ascending: true })
      .limit(limit);
    /*
     * ONE CLAIMED PROPERTY'S LADDER, INDEPENDENT OF EVERY OTHER.
     *
     * Requirement 8 of the item-independent settler: a property whose source
     * reached a terminal answer may climb its own ladder now, and must not
     * wait on another property whose source is still unfinished. The queue is
     * otherwise `created_at` ascending across the deployment.
     */
    if (input.stockItemId) query = query.eq('id', input.stockItemId);
    const { data, error } = await query;
    if (error) return { rows: [], unavailable: true };
    return { rows: (data ?? []) as Array<Record<string, unknown>> };
  } catch {
    return { rows: [], unavailable: true };
  }
}

/**
 * The builder's own trading name, for the identity check on a web result.
 *
 * READ FROM THE ROW'S OWN ORGANISATION, never from a request. This function
 * holds a service-role client and crosses organisations, so the tenant a call
 * is billed to and the name a result is verified against both have to come
 * from the candidate itself — an organisation id supplied from outside would
 * bill one builder for another's search.
 */
async function builderNameFor(
  db: any,
  organisationId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(organisationId)) return cache.get(organisationId) ?? null;
  let name: string | null = null;
  try {
    const { data } = await db
      .from('builder_organisations')
      .select('trading_name, legal_name')
      .eq('id', organisationId)
      .maybeSingle();
    const row = (data ?? {}) as { trading_name?: string | null; legal_name?: string | null };
    name = row.trading_name || row.legal_name || null;
  } catch {
    // A name we could not read is a name the identity check does without; it
    // must never stop the ladder, and it must never become another org's name.
    name = null;
  }
  cache.set(organisationId, name);
  return name;
}

/** Has this property got a displayable picture now? Read, never assumed. */
async function primaryOf(db: any, itemId: string): Promise<string | null> {
  const { data } = await db
    .from('builder_stock_items')
    .select('primary_image_id')
    .eq('id', itemId)
    .maybeSingle();
  return ((data ?? {}) as { primary_image_id?: string | null }).primary_image_id ?? null;
}

/**
 * Put a bounded batch of properties through the existing fallback ladder.
 *
 * CALLED ONLY WHERE STAGE A IS FINISHED. The caller runs this on the settler's
 * empty-queue path, which is the conservative reading of the rule that matters
 * most here: never spend stage B or C while the same property's builder source
 * might still produce a picture. A globally empty settlement queue means no
 * upload is still being read, so no property is about to gain the builder's
 * own render. `sourceSettlementComplete: true` is therefore a fact rather than
 * an assumption — and it is the caller's job to keep it one.
 */
export async function settleFallbackImages(
  db: any,
  input: { limit?: number; deadlineAt?: number; stockItemId?: string | null },
  deps: { enrich?: typeof enrichStockItem } = {},
): Promise<FallbackOutcome> {
  const outcome: FallbackOutcome = {
    attempted: 0, resolved: 0, laddered: 0, remaining: 0, withheld: 0, problems: [],
  };
  const batchLimit = Math.max(1, input.limit ?? MAX_FALLBACK_ITEMS_PER_TICK);

  // Read one more than the batch so `remaining` can be reported honestly
  // without a second round trip on the common case.
  const queue = await readFallbackQueue(db, {
    limit: batchLimit + 50, stockItemId: input.stockItemId ?? null,
  });
  if (queue.unavailable) {
    return { ...outcome, unavailable: true };
  }

  const names = new Map<string, string | null>();
  const batch = queue.rows.slice(0, batchLimit);

  /*
   * The ladder is loaded only once there is something to put through it, so a
   * tick with an empty fallback queue — which is every tick once the sweep has
   * converged — pays nothing for the provider modules it will not call.
   */
  const enrich = deps.enrich
    ?? (batch.length ? (await import('./images.ts')).enrichStockItem : null);
  if (!enrich) {
    outcome.remaining = queue.rows.length;
    return outcome;
  }

  for (const row of batch) {
    if (input.deadlineAt && Date.now() > input.deadlineAt) break;

    const itemId = String(row.id ?? '');
    const organisationId = String(row.organisation_id ?? '');
    if (!itemId || !organisationId) continue;

    /*
     * ==================================================================
     * THE GATE. NOTHING BELOW THIS RUNS UNTIL THE BUILDER'S OWN SOURCES
     * ARE FINISHED WITH.
     * ==================================================================
     *
     * The stock list is the source of truth, and the ladder below goes
     * looking on the open internet. It may only be bought once every
     * source the builder supplied for THIS property has actually been
     * opened and read — and `exhausted` is the only reading that means
     * that. `pending` and `processing` mean we have not finished;
     * `retryable_failure` means we FAILED, which is a fact about us and
     * never a fact about the property.
     *
     * WHY IT IS HERE AND NOT IN THE SETTLER. This is the one place in
     * the product where the external ladder is entered, so it is the one
     * place the guard can be complete. `settleClaimedItem` calls this
     * with a single `stockItemId`; the old organisation-wide path calls
     * it without one; a future caller will do something else again. A
     * gate at the stage machine would protect only the first.
     *
     * A REFUSAL IS NOT A FAILURE AND NOT AN ATTEMPT. Nothing is written,
     * nothing is spent, `attempted` does not rise, and the property is
     * simply not offered the ladder this tick. It becomes eligible the
     * moment its sources answer, and a provenance bump re-opens sources
     * that were retired operationally.
     */
    const evidence = readStoredRowEvidence({
      sourceRow: row.source_row,
      stored: row.source_provenance_result,
      provenanceVersion: PROVENANCE_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      /*
       * A SUCCESS CLEARS ITS BRANCH RECORD, so without this a property whose
       * brochure just yielded its picture reads `pending` — the branch looks
       * unopened — and is withheld from the very bookkeeping that would mark
       * it complete. The accepted picture is the fact that settles the
       * question, and it lives in the images table, not the provenance
       * column.
       */
      builderImageAccepted: await hasBuilderSuppliedImage(db, itemId),
    });
    if (!fallbackMayRun(evidence.state)) {
      outcome.withheld += 1;
      outcome.problems.push({
        item: itemId,
        reason: describeSuppliedEvidence(evidence),
      });
      console.info('[builderStock] fallback withheld', {
        phase: 'fallback_gate', stock_item_id: itemId,
        supplied_evidence: evidence.state,
        sources_total: evidence.total, sources_open: evidence.open,
        sources_inspected: evidence.inspected, sources_operational: evidence.operational,
      });
      continue;
    }

    const builderName = await builderNameFor(db, organisationId, names);
    const item = { ...row, sourceSettlementComplete: true } as unknown as EnrichableStockItem;

    outcome.attempted += 1;
    let climbed = false;
    try {
      for (let pass = 0; pass < MAX_STAGES_PER_ITEM; pass += 1) {
        const result = await enrich(db, item, builderName);

        /*
         * A pass that ran NO paid stage has nothing to follow. `nextImageStage`
         * answered `none` (this property already holds a picture) or `wait`
         * (evidence that has not arrived) — offering a second rung would spend
         * money on the same answer.
         */
        const ranAStage = (result?.outcomes ?? [])
          .some((stageOutcome) => stageOutcome?.status !== 'skipped');
        if (!ranAStage) break;
        climbed = true;

        // The rung is climbed only while the property still has no picture: a
        // verified web photograph ends the item here, with no Street View call.
        if (await primaryOf(db, itemId)) break;
      }
    } catch (error) {
      /*
       * An operational failure leaves the EXISTING policy standing. Nothing is
       * written here: `enrichStockItem` owns the terminal status, and a driver
       * that stamped `failed` on a provider outage would retire a property the
       * existing semantics would have retried.
       */
      outcome.problems.push({
        item: itemId,
        reason: String((error as { message?: string })?.message ?? error).slice(0, 200),
      });
    }

    if (climbed) outcome.laddered += 1;
    if (await primaryOf(db, itemId)) outcome.resolved += 1;
  }

  /*
   * MEASURED AFTER THE WORK, not derived from the queue read before it. The
   * cron's completion rule is built on this number, and an estimate that ran
   * one item behind would let the sweep go quiet with work outstanding — which
   * is the exact defect this module exists to fix.
   *
   * OVER THE SAME SCOPE THE WORK WAS DONE IN. This read used to be global
   * whatever the caller asked for, and `settleClaimedItem` decides ONE
   * property's next stage from it: `remaining > 0 ? 'fallback' : settled`. So
   * a property that had finished its own ladder was held at `fallback` while
   * ANY other property in the deployment was still owed one — re-claimed,
   * finding its own queue empty, doing nothing, and re-claimed again. On an
   * 89-property upload that is the whole cohort spinning until the last one
   * finishes: quadratic invocations against a per-item claim, and the comment
   * at the call site describing a per-property count that was never computed.
   */
  const after = await readFallbackQueue(db, {
    limit: 200, stockItemId: input.stockItemId ?? null,
  });
  outcome.remaining = after.unavailable ? Math.max(0, queue.rows.length - outcome.resolved)
    : after.rows.length;
  return outcome;
}
