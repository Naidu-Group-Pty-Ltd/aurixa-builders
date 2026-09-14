/**
 * Builder stock — bringing an upload's imagery up to the CURRENT rules, once.
 *
 * WHY THIS EXISTS. `repairSourceImagesForUpload` has always been able to read a
 * source again and attach exactly the right picture. What it never had was
 * anything that ran it. It sat behind a "Source images" button in the Builder
 * Portal, so a stock list whose images were written under older rules kept
 * showing an empty frame until a person went and pressed it — and a person who
 * has just uploaded a stock list has no reason to think they should.
 *
 * So the repair becomes a STEP with a terminal marker rather than a command:
 *
 *   An upload is SETTLED at provenance version N when its imagery has been
 *   re-derived under the rules of version N. `source_images_settled_version`
 *   records it. An upload below the current version has work outstanding; an
 *   upload at it has none, however few images it ended up with.
 *
 * THE MARKER IS WHAT MAKES IT SAFE TO RUN AUTOMATICALLY. Without it the only
 * available test is "does this upload have properties with no picture", which is
 * true for ever of a spreadsheet that carries no imagery — so every pass would
 * re-read every source, and a loop driving it would never converge. With it,
 * each upload is re-read once per rules change and then left alone.
 *
 * NOTHING HERE IS AN IMPORT. No stock item is created, no property field is
 * written, no price, availability, selection or linkage is touched. The only
 * writes are `builder_stock_item_images` rows, the `primary_image_id` those
 * rows earn, and this marker.
 */
import { repairSourceImagesForUpload, type RepairOutcome } from './repairSourceImages.ts';
import { PROVENANCE_VERSION, type SourceImageFetcher } from './sourceImages.ts';
import type { PackageFetcher } from './packageImages.ts';
import {
  eligibilitySweepCompleted, settleMarketplaceEligibility, type EligibilitySettlement,
} from './settleMarketplaceEligibility.ts';
import { MARKETPLACE_ELIGIBILITY_VERSION } from './marketplaceEligibility.pure.ts';
import {
  sanitizationSweepCompleted, settleImageSanitization,
  type RepairBudget, type SanitizationSettlement,
} from './settleImageSanitization.ts';
import { SANITIZATION_VERSION } from './sanitizedDerivative.pure.ts';

/** The column that records how far an upload's imagery has been brought. */
export const SETTLED_VERSION_COLUMN = 'source_images_settled_version';

/**
 * And the column that records how far its DISPLAY ELIGIBILITY has been brought.
 *
 * A SECOND MARKER, DELIBERATELY. Provenance and display eligibility are
 * different questions with different algorithms that change at different
 * times: improving the marketing-tile classifier must not re-fetch every
 * Notion page and every Drive package, and re-reading a source must not
 * re-run a classifier that has not changed. One marker each is what keeps the
 * two from dragging each other around.
 */
export const ELIGIBILITY_SETTLED_VERSION_COLUMN = 'marketplace_eligibility_settled_version';

/**
 * And the column that records how far its OVERLAY REPAIR has been brought.
 *
 * A THIRD MARKER, for the reason there is a second. Where a builder laid a
 * promotional graphic over their own photograph, the display gate refuses it
 * and the repair takes the graphic off — and how well that can be done is a
 * third algorithm improving on a third schedule. Sharing a marker with
 * eligibility would mean every classifier bump re-running a repair that costs a
 * full-resolution decode and, on the hard ones, a model call; sharing one with
 * provenance would mean every repair improvement re-fetching every source.
 */
export const SANITIZATION_SETTLED_VERSION_COLUMN = 'image_sanitization_settled_version';

/**
 * How long ONE upload's source re-read may take before it stops itself.
 *
 * Fitted to the two production kills of 27 Aug 2026 rather than chosen: the
 * import died at ~16s and this path at ~20s, both on the edge worker's
 * resource limit. Twelve seconds leaves the invocation room to write its
 * marker and answer, which is the difference between a sweep that converges
 * and one that repeats itself for ever.
 */
const PROVENANCE_BUDGET_MS = 12_000;

export interface SettlementOutcome {
  uploadId: string;
  /** True when this upload is now at BOTH current versions. */
  settled: boolean;
  /**
   * True when the DISPLAY-ELIGIBILITY half finished, whether or not the
   * provenance half did.
   *
   * Primary-image enforcement reads eligibility verdicts and nothing else, so
   * this — not `settled` — is what licenses it. Requiring both halves made the
   * pointer bookkeeping hostage to a source repair that re-fetches remote
   * documents and can be retried for hours: in production upload
   * f7e0d4d1 reached a complete set of verdicts while its provenance marker was
   * still null, and enforcement would not have run until that unrelated work
   * finished.
   */
  eligibilitySettled: boolean;
  /** The repair's own report, when one ran. */
  repair?: RepairOutcome;
  /** The eligibility sweep's report, when one ran. */
  eligibility?: EligibilitySettlement;
  /** The overlay-repair sweep's report, when one ran. */
  sanitization?: SanitizationSettlement;
  /** Safe to surface: why settlement could not complete. */
  error?: string;
}

/**
 * Which of an organisation's uploads still have imagery outstanding.
 *
 * Ordered oldest first so a budgeted sweep makes deterministic progress rather
 * than revisiting whichever upload happened to sort first this time.
 *
 * The column is PROBED rather than required: a deployment whose migration has
 * not run yet must keep importing stock, so an unreadable marker means "treat
 * every upload as settled" and the manual repair remains available. Silently
 * re-reading every source on every pass would be worse than doing nothing.
 */
export async function uploadsNeedingSettlement(
  db: any,
  input: { organisationId: string; uploadId?: string | null; limit?: number },
): Promise<string[]> {
  let query = db
    .from('builder_stock_uploads')
    .select(QUEUE_COLUMNS)
    .eq('organisation_id', input.organisationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(input.limit ?? 25, 200)));
  if (input.uploadId) query = query.eq('id', input.uploadId);

  const { data, error } = await query;
  if (error) return [];

  return (data ?? [])
    .filter((row: Record<string, unknown>) => uploadHasWorkOutstanding(row))
    .map((row: { id: string }) => row.id);
}

/**
 * Does this upload row still owe either kind of work?
 *
 * Shared by the portal's own read and the autonomous sweep so the two cannot
 * disagree about what "outstanding" means. `eligibilityTarget` defaults to this
 * build's own constant; the sweep passes the DATABASE's target instead, for the
 * reason `readEligibilityTarget` explains.
 */
export function uploadHasWorkOutstanding(
  row: Record<string, unknown>,
  eligibilityTarget: number = MARKETPLACE_ELIGIBILITY_VERSION,
  sanitizationTarget: number = SANITIZATION_VERSION,
): boolean {
  return Number(row[SETTLED_VERSION_COLUMN] ?? 0) < PROVENANCE_VERSION
    || Number(row[ELIGIBILITY_SETTLED_VERSION_COLUMN] ?? 0) < eligibilityTarget
    || Number(row[SANITIZATION_SETTLED_VERSION_COLUMN] ?? 0) < sanitizationTarget;
}

/** The single-row table that carries the deployment's eligibility target. */
export const SETTLEMENT_TARGET_TABLE = 'builder_stock_settlement_target';

/**
 * The eligibility version PRODUCTION is being brought to, as the database
 * states it.
 *
 * WHY THIS IS NOT SIMPLY THE TYPESCRIPT CONSTANT. The cron job that drives the
 * sweep unschedules itself once nothing is outstanding, and it decides that in
 * SQL. SQL cannot see `MARKETPLACE_ELIGIBILITY_VERSION`, so with the constant as
 * the only authority a later bump changed the classifier and woke nothing: every
 * upload still carried marker 1, the job that would have noticed had already
 * removed itself, and the re-audit simply never happened. A version bump ships
 * the constant and a migration that raises this row in the same deployment, and
 * raising it is what re-schedules the job.
 *
 * THE EFFECTIVE TARGET IS THE LOWER OF THE TWO, because the migration and the
 * functions do not deploy at the same instant. Target ahead of code means the
 * sweep does nothing until the new classifier is actually running — rather than
 * re-measuring every image with the old one and writing a marker that can never
 * reach the target, which is a hot loop over the whole bucket. Code ahead of
 * target means the work waits for the migration, which is the same answer from
 * the other side.
 *
 * A missing table is not an error: a deployment whose migration has not run
 * behaves exactly as it did before this existed.
 */
export async function readEligibilityTarget(db: any): Promise<number> {
  let stated = MARKETPLACE_ELIGIBILITY_VERSION;
  try {
    const { data, error } = await db
      .from(SETTLEMENT_TARGET_TABLE)
      .select('marketplace_eligibility_version')
      .limit(1);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    const value = row?.marketplace_eligibility_version;
    if (!error && typeof value === 'number' && Number.isFinite(value)) stated = value;
  } catch {
    // Table absent or unreadable. The constant stands on its own.
  }
  return Math.min(stated, MARKETPLACE_ELIGIBILITY_VERSION);
}

/**
 * The overlay-repair version production is being brought to, as the database
 * states it.
 *
 * The same two-halves rule as `readEligibilityTarget`, and the same reason: the
 * cron job decides in SQL whether work is left, and SQL cannot see
 * `SANITIZATION_VERSION`. The effective target is the LOWER of the two, so a
 * migration that lands before the functions do makes the sweep wait rather than
 * re-running every repair under the old code and writing a marker that can
 * never reach the target.
 */
export async function readSanitizationTarget(db: any): Promise<number> {
  let stated = SANITIZATION_VERSION;
  try {
    const { data, error } = await db
      .from(SETTLEMENT_TARGET_TABLE)
      .select('image_sanitization_version')
      .limit(1);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    const value = row?.image_sanitization_version;
    if (!error && typeof value === 'number' && Number.isFinite(value)) stated = value;
  } catch {
    // Column absent or unreadable. The constant stands on its own.
  }
  return Math.min(stated, SANITIZATION_VERSION);
}

/**
 * Is the settlement schema actually deployed?
 *
 * WHY THIS IS A FUNCTION RATHER THAN AN ASSUMPTION. Edge functions ship
 * automatically when `main` moves; migrations in this project do NOT — they are
 * applied one file at a time by a human dispatching a workflow. So the display
 * gate, which lives in the functions and the bundle, can go live hours or days
 * before the schema that lets the backfill clear it. That is not hypothetical:
 * it is exactly what happened here. Every marketplace card went blank, and the
 * settler that should have fixed it reported `success: true` with
 * `skipped: 'marker_unavailable'`, because a missing column looked the same to
 * it as an empty queue.
 *
 * A missing schema is now an operational failure with a name, not a quiet
 * success. It is checked by READING, not by catching: a probe that cannot
 * distinguish "column absent" from "table empty" is the bug being fixed.
 */
export interface SettlementReadiness {
  ready: boolean;
  /** What is missing, in the words an operator needs to act on. */
  missing: string[];
  /** The database's target, when it could be read. */
  target: number | null;
}

export async function readSettlementReadiness(db: any): Promise<SettlementReadiness> {
  const missing: string[] = [];

  const probe = async (column: string) => {
    try {
      const { error } = await db
        .from('builder_stock_uploads').select(column).limit(1);
      if (error) missing.push(`builder_stock_uploads.${column}`);
    } catch {
      missing.push(`builder_stock_uploads.${column}`);
    }
  };
  await probe(SETTLED_VERSION_COLUMN);
  await probe(ELIGIBILITY_SETTLED_VERSION_COLUMN);
  await probe(SANITIZATION_SETTLED_VERSION_COLUMN);

  /*
   * The terminal-negative-provenance column, probed for the same reason as the
   * markers and with a sharper edge.
   *
   * The repair reads it alongside every property row. Without the column that
   * whole read errors, the rows come back empty, the loop matches nothing —
   * and it would reach the end and report itself COMPLETE, so the caller would
   * write the settled marker for an upload it had not looked at. A missing
   * column has to be a refusal here, not a quiet no-op, which is the same
   * lesson the settled-version columns taught when an unreadable queue read as
   * an empty one.
   */
  try {
    const { error } = await db
      .from('builder_stock_items').select('source_provenance_result').limit(1);
    if (error) missing.push('builder_stock_items.source_provenance_result');
  } catch {
    missing.push('builder_stock_items.source_provenance_result');
  }

  let target: number | null = null;
  try {
    const { data, error } = await db
      .from(SETTLEMENT_TARGET_TABLE)
      .select('marketplace_eligibility_version')
      .limit(1);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (error || !row) missing.push(SETTLEMENT_TARGET_TABLE);
    else target = Number(row.marketplace_eligibility_version);
  } catch {
    missing.push(SETTLEMENT_TARGET_TABLE);
  }

  return { ready: missing.length === 0, missing, target };
}

/** The columns the queue reads. One list, so the two callers cannot drift. */
const QUEUE_COLUMNS = `id, organisation_id, created_at, `
  + `${SETTLED_VERSION_COLUMN}, ${ELIGIBILITY_SETTLED_VERSION_COLUMN}, `
  + `${SANITIZATION_SETTLED_VERSION_COLUMN}`;

/** An upload row as the queue read returns it. */
export interface OutstandingUploadRow extends Record<string, unknown> {
  id: string;
  organisation_id: string;
}

export interface OutstandingUploads {
  rows: OutstandingUploadRow[];
  /** The eligibility version these rows were selected against. */
  eligibilityTarget: number;
  /** And the overlay-repair version. */
  sanitizationTarget: number;
  /** True when the markers could not be read at all (migration not applied). */
  unavailable: boolean;
}

/**
 * The uploads that ACTUALLY have work outstanding, oldest first.
 *
 * THE DEFECT THIS REPLACES. The sweep used to read the oldest 500 uploads and
 * filter them in JavaScript. With 500 settled uploads and outstanding work on
 * the 501st, every tick read the same settled 500, found nothing, and reported
 * the queue empty — for ever. Raising the limit only moves the number at which
 * it happens.
 *
 * So the DATABASE decides what is outstanding, over six narrow reads whose
 * union is exactly the set — two for each of the three concerns:
 *
 *   provenance marker  IS NULL         never settled
 *   provenance marker  < current       settled under older rules
 *   eligibility marker IS NULL         never judged
 *   eligibility marker < target        judged under an older algorithm
 *   sanitization marker IS NULL        never offered to the overlay repair
 *   sanitization marker < target       repaired by an older one
 *
 * Separate reads rather than one `.or()` string, deliberately: a filter
 * composed by string interpolation is the shape that cost this codebase a
 * predicate which had never once parsed, and `IS NULL` cannot be folded into a
 * `<` comparison anyway — PostgREST's `lt` excludes nulls, which is precisely
 * the rows that matter most here. Each read is a plain indexed predicate, each
 * is limited, and the union is merged and re-sorted in memory over at most
 * 6 × limit rows.
 */
export async function readOutstandingUploads(
  db: any,
  input: { limit: number; eligibilityTarget?: number; sanitizationTarget?: number },
): Promise<OutstandingUploads> {
  const eligibilityTarget = input.eligibilityTarget ?? MARKETPLACE_ELIGIBILITY_VERSION;
  const sanitizationTarget = input.sanitizationTarget ?? SANITIZATION_VERSION;
  const limit = Math.max(1, Math.min(input.limit, 500));

  const base = () => db
    .from('builder_stock_uploads')
    .select(QUEUE_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  const reads = [
    base().is(SETTLED_VERSION_COLUMN, null),
    base().lt(SETTLED_VERSION_COLUMN, PROVENANCE_VERSION),
    base().is(ELIGIBILITY_SETTLED_VERSION_COLUMN, null),
    base().lt(ELIGIBILITY_SETTLED_VERSION_COLUMN, eligibilityTarget),
    base().is(SANITIZATION_SETTLED_VERSION_COLUMN, null),
    base().lt(SANITIZATION_SETTLED_VERSION_COLUMN, sanitizationTarget),
  ];

  const results = await Promise.all(reads.map(async (read: any) => {
    try {
      return await read;
    } catch (error) {
      return { data: null, error };
    }
  }));

  // Every read failing the same way means the columns are not there yet.
  if (results.every((result: any) => result?.error)) {
    return { rows: [], eligibilityTarget, sanitizationTarget, unavailable: true };
  }

  const byId = new Map<string, OutstandingUploadRow>();
  for (const result of results as any[]) {
    if (result?.error) continue;
    for (const row of (result.data ?? []) as OutstandingUploadRow[]) {
      if (row?.id) byId.set(String(row.id), row);
    }
  }

  /*
   * Re-sorted after the union, because four separately-ordered pages are not
   * one ordered page. Oldest first so a budgeted tick makes deterministic
   * progress instead of revisiting whichever upload happened to sort first.
   */
  const rows = [...byId.values()].sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    || String(a.id).localeCompare(String(b.id)));

  return {
    rows: rows.slice(0, limit), eligibilityTarget, sanitizationTarget, unavailable: false,
  };
}

/** An upload the sweep may pick up, as the queue read returns it. */
export interface SettlementCandidate {
  id: string;
  organisation_id: string;
  /** What this upload owes, so a settled concern is not redone. */
  needsProvenance?: boolean;
  needsEligibility?: boolean;
  needsSanitization?: boolean;
}

export interface SettlementTickOutcome {
  /** Uploads this tick called the repair for. */
  attempted: number;
  /** Uploads this tick brought to the current version. */
  settled: number;
  /**
   * The organisations in which an upload's DISPLAY-ELIGIBILITY work completed.
   *
   * Not the ones attempted, which is what this used to collect. Primary-image
   * enforcement rewrites pointers across a whole organisation, and it decides
   * by reading eligibility verdicts — so running it after a sweep that FAILED
   * means deciding on evidence that was never gathered, and clearing the
   * pointer of every property whose verdict has not been written yet. An
   * attempt is not evidence; a finished sweep is.
   */
  organisations: string[];
}

/**
 * One tick of the sweep: settle what fits, in the order given.
 *
 * THE CAP IS ON WORK FINISHED, NOT ON UPLOADS LOOKED AT, and that distinction
 * is the whole reason this is a function rather than three lines in a handler.
 * A tick always starts at the oldest outstanding upload, so capping ATTEMPTS
 * let a source that can never settle — bytes that no longer parse, a document
 * too large to finish inside one wall clock — hold one of the six places for
 * ever and starve every upload behind it. The sweep would then never reach the
 * rest, and never unschedule itself, which is the one thing a repair that
 * describes itself as a deployment step must not do.
 *
 * Capping settlements instead costs a stuck upload a single attempt per tick
 * and lets the queue behind it drain. The wall clock is what bounds the tick;
 * the cap only stops it doing more than a tick's worth of successful work.
 */
export async function runSettlementTick(
  outstanding: SettlementCandidate[],
  options: { maxSettled: number; deadlineAt: number; now?: () => number },
  settle: (candidate: SettlementCandidate) => Promise<SettlementOutcome>,
): Promise<SettlementTickOutcome> {
  const now = options.now ?? (() => Date.now());
  const organisations = new Set<string>();
  let attempted = 0;
  let settled = 0;

  for (const candidate of outstanding) {
    if (now() > options.deadlineAt) break;
    if (settled >= options.maxSettled) break;
    attempted += 1;
    const outcome = await settle(candidate);
    if (outcome.settled) settled += 1;
    /*
     * Collected on the ELIGIBILITY half completing, never on an attempt.
     *
     * A tick that stops on its wall clock used to enforce primaries for
     * organisations it never reached, and a tick whose settlement failed used
     * to enforce them on evidence it had not gathered — both clear the pointer
     * of every property whose verdict has not been written yet.
     *
     * The gate is `eligibilitySettled` rather than `settled` because
     * enforcement reads eligibility verdicts and nothing else. Gating on the
     * whole settlement would be safe but wrong in the other direction: it makes
     * the pointers wait on a provenance repair that re-fetches remote sources,
     * which in production had not finished for the very upload whose verdicts
     * were already complete.
     */
    if (outcome.eligibilitySettled) {
      organisations.add(String(candidate.organisation_id));
    }
  }

  return { attempted, settled, organisations: [...organisations] };
}

/**
 * Re-open a settled question because the thing it was an answer ABOUT changed.
 *
 * THE REPAIR MARKER IS AN ANSWER ABOUT A SET OF CONVICTIONS, and both the
 * things that can add a conviction happen after it may already have settled.
 * The overlay repair only ever picks up an image the display gate REFUSED, so
 * once its marker sits at the current version an image refused later is work
 * its marker says does not exist — no derivative is ever built, no clearance is
 * ever sought, and the card stays blank in front of a photograph the builder
 * supplied, with every marker reading "settled" and nothing outstanding
 * anywhere.
 *
 * Two routes add one. The eligibility sweep writes `ineligible` onto a picture
 * it has just measured; and the provenance repair STORES a picture, which
 * arrives already judged — `storeSourceImages` and `storeSourceImageBytes` both
 * embed the verdict at write time — and can therefore arrive refused.
 *
 * Neither could strand a repair while one tick did all three phases in order.
 * Both can now that they are separated one-per-tick, and rotation makes the
 * order arbitrary, so this cannot be left to the phases happening to fall the
 * right way round.
 *
 * Clearing rather than lowering, because null is what the schema already means
 * by "never answered", and it is the one value no target can be satisfied by.
 * A failure here is logged and not fatal: the work was done, and the worst case
 * is the state this replaces.
 */
async function reopenSettlement(
  db: any,
  input: { organisationId: string; uploadId: string },
  columns: string[],
  because: string,
): Promise<void> {
  if (!columns.length) return;
  const { error } = await db
    .from('builder_stock_uploads')
    .update(Object.fromEntries(columns.map((column) => [column, null])))
    .eq('id', input.uploadId)
    .eq('organisation_id', input.organisationId);
  if (error) {
    console.warn('[builderStock] settlement not re-opened', {
      upload_id: input.uploadId,
      phase: 'settlement_reopen',
      columns,
      because,
      message: String((error as { message?: string }).message ?? error).slice(0, 200),
    });
    return;
  }
  console.info('[builderStock] settlement re-opened', {
    upload_id: input.uploadId, phase: 'settlement_reopen', columns, because,
  });
}

/**
 * Bring ONE upload's imagery up to the current rules.
 *
 * Budgeted and resumable in exactly the way the repair already is: a run that
 * hits the wall clock reports `settled: false`, leaves the marker alone, and the
 * next pass continues where it stopped. Only a complete pass writes the marker,
 * so a half-finished run can never be mistaken for a finished one.
 */
export async function settleUploadSourceImages(
  db: any,
  input: {
    organisationId: string;
    uploadId: string;
    deadlineAt?: number;
    /**
     * What this upload actually owes, read from its markers.
     *
     * Both default to true so a caller that has not looked still does the
     * work — but a sweep that HAS looked can settle an upload whose imagery is
     * already current and whose display eligibility is not, without re-reading
     * its Notion page or its Drive package to discover nothing has changed.
     */
    needsProvenance?: boolean;
    needsEligibility?: boolean;
    needsSanitization?: boolean;
    /**
     * The tick's shared repair allowance, so six uploads cannot each spend a
     * per-upload one. See `newRepairBudget`.
     */
    repairBudget?: RepairBudget;
  },
  deps: {
    fetchPackage?: PackageFetcher;
    fetchImage?: SourceImageFetcher;
    readPageTexts?: (bytes: Uint8Array) => Promise<string[]>;
    sanitize?: NonNullable<Parameters<typeof settleImageSanitization>[2]>['sanitize'];
  } = {},
): Promise<SettlementOutcome> {
  const needsProvenance = input.needsProvenance !== false;
  const needsEligibility = input.needsEligibility !== false;
  const needsSanitization = input.needsSanitization !== false;

  /**
   * DISPLAY ELIGIBILITY FIRST, and on its own marker.
   *
   * It reads stored objects rather than sources, so it is cheap, and it is
   * what decides whether a card may draw anything at all. Running it before
   * the source repair means an upload whose imagery is already current still
   * gets its verdicts on this pass.
   */
  let eligibility: EligibilitySettlement | undefined;
  /*
   * Starts TRUE for an upload that owes no eligibility work: its verdicts
   * were written and its marker set on an earlier pass, so enforcement is
   * licensed by that pass rather than by this one. It is set to false the
   * moment we take on the work, and back to true only when the sweep
   * reports it finished.
   */
  let eligibilitySettled = !needsEligibility;
  if (needsEligibility) {
    eligibility = await settleMarketplaceEligibility(db, input.organisationId, {
      uploadId: input.uploadId,
      deadlineAt: input.deadlineAt,
    });
    /*
     * ONLY A PASS THAT ACTUALLY FINISHED ITS WORK MOVES THE MARKER.
     *
     * `eligibilitySweepCompleted` is false when the budget ran out AND when any
     * row needed a verdict and could not be given one because an operation
     * failed — a missing object, a download error, a rejected write. A written
     * `pending` verdict is NOT such a case: the classifier decided it could not
     * decide, which is a finished decision for this algorithm version.
     *
     * Advancing the marker after a storage outage would have looked exactly
     * like a completed sweep — every card empty, nothing outstanding, and the
     * cron job unscheduling itself with the work undone.
     */
    if (eligibilitySweepCompleted(eligibility)) {
      const { error: markError } = await db
        .from('builder_stock_uploads')
        .update({ [ELIGIBILITY_SETTLED_VERSION_COLUMN]: MARKETPLACE_ELIGIBILITY_VERSION })
        .eq('id', input.uploadId)
        .eq('organisation_id', input.organisationId);
      if (markError) {
        // The column is missing (migration not applied). The work was done; it
        // will simply be done again rather than being skipped.
        console.warn('[builderStock] eligibility marker not written', {
          upload_id: input.uploadId,
          phase: 'eligibility_marker',
          message: String(markError.message ?? markError).slice(0, 200),
        });
        return { uploadId: input.uploadId, settled: false, eligibilitySettled, eligibility };
      }
      eligibilitySettled = true;
      /*
       * A NEW CONVICTION IS NEW WORK FOR THE REPAIR. The overlay repair only
       * ever picks up an image the display gate refused, so a verdict written
       * after that repair last reported itself finished is work its marker
       * says does not exist. Rotation makes the order of the two phases within
       * a run arbitrary, so this cannot be left to them happening to fall the
       * right way round.
       */
      if (eligibility.rejected > 0) {
        await reopenSettlement(db, input, [SANITIZATION_SETTLED_VERSION_COLUMN],
          `${eligibility.rejected} image(s) newly refused for display`);
      }
    } else {
      if (eligibility.unresolved) {
        console.warn('[builderStock] eligibility work unresolved', {
          upload_id: input.uploadId,
          phase: 'eligibility_settlement',
          unresolved: eligibility.unresolved,
        });
      }
      return { uploadId: input.uploadId, settled: false, eligibilitySettled, eligibility };
    }
  }

  /**
   * THE OVERLAY REPAIR, AFTER THE VERDICTS AND BEFORE THE SOURCE RE-READ.
   *
   * After, because it only ever picks up an image the display gate CONVICTED,
   * and a row whose verdict has not been written yet has not been convicted of
   * anything. Before, because the source re-read is the expensive, remote,
   * retried-for-hours half and a repair that is ready to run should not wait on
   * it — the same reasoning that put eligibility first.
   *
   * Its marker moves on its own, so an upload whose repair finished keeps that
   * result even if the provenance half below fails and is retried for days.
   */
  let sanitization: SanitizationSettlement | undefined;
  if (needsSanitization) {
    sanitization = await settleImageSanitization(db, input.organisationId, {
      uploadId: input.uploadId,
      deadlineAt: input.deadlineAt,
      budget: input.repairBudget,
      sanitize: deps.sanitize,
    });
    if (sanitizationSweepCompleted(sanitization)) {
      const { error: markError } = await db
        .from('builder_stock_uploads')
        .update({ [SANITIZATION_SETTLED_VERSION_COLUMN]: SANITIZATION_VERSION })
        .eq('id', input.uploadId)
        .eq('organisation_id', input.organisationId);
      if (markError) {
        console.warn('[builderStock] sanitization marker not written', {
          upload_id: input.uploadId,
          phase: 'sanitization_marker',
          message: String(markError.message ?? markError).slice(0, 200),
        });
        return {
          uploadId: input.uploadId, settled: false, eligibilitySettled, eligibility, sanitization,
        };
      }
    } else {
      /*
       * The repair cap, the wall clock or an operational fault. Every one of
       * them means this upload is not at the current repair version, so the
       * marker stays where it is and the next tick continues from the same
       * keyset cursor. A REFUSED repair is not this: that is written down and
       * counts as finished work, exactly as a `pending` verdict does.
       */
      console.warn('[builderStock] overlay repair incomplete', {
        upload_id: input.uploadId,
        phase: 'image_sanitization',
        outstanding: sanitization.outstanding,
        repaired: sanitization.repaired,
        refused: sanitization.refused,
        cleared: sanitization.cleared,
        unresolved: sanitization.unresolved,
      });
      return {
        uploadId: input.uploadId, settled: false, eligibilitySettled, eligibility, sanitization,
      };
    }
  }

  if (!needsProvenance) {
    return {
      uploadId: input.uploadId, settled: true, eligibilitySettled, eligibility, sanitization,
    };
  }

  let repair: RepairOutcome;
  try {
    repair = await repairSourceImagesForUpload(db, {
      organisationId: input.organisationId,
      uploadId: input.uploadId,
      /*
       * ITS OWN BUDGET, NOT THE TICK'S WALL CLOCK.
       *
       * The tick allows itself 100 seconds, and this step never gets near
       * that: re-reading a source means fetching a page, recovering its
       * content, downloading pictures, hashing them and running the display
       * classifier over each one — and where a row links a package, parsing a
       * multi-megabyte PDF. That is CPU and memory, and the edge worker's
       * RESOURCE limit ends the invocation long before any wall clock does.
       *
       * MEASURED, TWICE, ON THE SAME DAY. The import path died exactly this
       * way at ~16s (POST | 546) and was fixed by budgeting its image phase.
       * This path then died the same way at ~20s on the same stock list, with
       * NOTHING stored and NOT ONE LINE LOGGED — a killed worker writes no
       * marker, so the sweep repeated the whole thing every tick and never
       * converged.
       *
       * `repairSourceImagesForUpload` already reports `incomplete` and is
       * resumable by design; it simply was never given a deadline it could
       * reach. Given one, the run ends of its own accord, banks the properties
       * it did reach, and the next tick continues.
       */
      deadlineAt: Math.min(
        input.deadlineAt ?? Number.MAX_SAFE_INTEGER,
        Date.now() + PROVENANCE_BUDGET_MS,
      ),
    }, deps);
  } catch (error) {
    const message = String((error as { safeMessage?: string; message?: string })?.safeMessage
      ?? (error as { message?: string })?.message ?? error).slice(0, 300);
    console.warn('[builderStock] source image settlement failed', {
      upload_id: input.uploadId,
      phase: 'source_image_settlement',
      message,
    });
    return {
      uploadId: input.uploadId, settled: false, eligibilitySettled, eligibility, sanitization,
      error: message,
    };
  }

  if (repair.problems.length) {
    // Server-side only: a problem line can name a source object path.
    console.warn('[builderStock] source image settlement problems', {
      upload_id: input.uploadId,
      phase: 'source_image_recovery',
      problems: repair.problems.slice(0, 10),
    });
  }

  /*
   * A STORED PICTURE ARRIVES WITH A VERDICT, AND THE VERDICT MAY BE A REFUSAL.
   * Done before the `incomplete` branch below, because a run that stopped at
   * its work cap still stored everything it reached, and a refusal among those
   * needs a repair whether or not the rest of the upload is finished.
   */
  if (repair.imagesStored > 0) {
    await reopenSettlement(db, input, [SANITIZATION_SETTLED_VERSION_COLUMN],
      `${repair.imagesStored} image(s) stored, any of which may have arrived refused`);
  }

  /**
   * A source that cannot be read again is SETTLED, not retried for ever.
   *
   * A deleted Notion page, a revoked Drive share and a snapshot we can no longer
   * decode all produce the same thing on every future pass, so leaving the
   * marker clear would make the sweep re-fetch them until somebody noticed. The
   * failure is logged and the manual repair still exists for when the source
   * comes back.
   */
  if (repair.incomplete) {
    /*
     * SAY SO. An unfinished run used to return silently, which made it
     * indistinguishable from a run that was killed — and the edge worker DOES
     * kill this one on its resource limit, returning no response at all. A
     * marker that never advances was the only evidence either way, and it
     * cannot tell an operator whether the repair is progressing, stuck, or
     * never running. It is progressing if `rowsRead` climbs and
     * `imagesStored` is non-zero; it is stuck if this line repeats with the
     * same numbers.
     */
    console.warn('[builderStock] source image settlement incomplete', {
      upload_id: input.uploadId,
      phase: 'source_image_settlement',
      reason: 'budget_or_work_cap_reached',
      rows_read: repair.rowsRead,
      matched: repair.matched,
      images_stored: repair.imagesStored,
      package_unreachable: repair.packageUnreachable,
      // The two that tell an operator whether this is converging: answers
      // banked this run, and answers banked by earlier ones. When the second
      // stops growing and the run still says incomplete, something else is
      // wrong.
      package_not_identified: repair.packageNotIdentified,
      package_already_answered: repair.packageAlreadyAnswered,
    });
    return {
      uploadId: input.uploadId, settled: false, eligibilitySettled, repair, eligibility,
      sanitization,
    };
  }
  if (repair.error) {
    console.warn('[builderStock] source could not be re-read for settlement', {
      upload_id: input.uploadId,
      phase: 'source_read',
      message: repair.error,
    });
  }

  const { error: markError } = await db
    .from('builder_stock_uploads')
    .update({ [SETTLED_VERSION_COLUMN]: PROVENANCE_VERSION })
    .eq('id', input.uploadId)
    .eq('organisation_id', input.organisationId);
  if (markError) {
    // The column is missing (migration not applied). The work was still done;
    // it will simply be done again next time rather than being skipped.
    console.warn('[builderStock] settlement marker not written', {
      upload_id: input.uploadId,
      phase: 'settlement_marker',
      message: String(markError.message ?? markError).slice(0, 200),
    });
    return {
      uploadId: input.uploadId, settled: false, eligibilitySettled, repair, eligibility,
      sanitization,
    };
  }

  return {
    uploadId: input.uploadId, settled: true, eligibilitySettled, repair, eligibility, sanitization,
  };
}
