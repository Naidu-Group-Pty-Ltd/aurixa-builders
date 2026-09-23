/**
 * Builder stock — WHAT AN IMPORT SPENT, RECORDED WHILE IT IS STILL SPENDING IT.
 *
 * ===========================================================================
 * WHY THIS IS NOT THE `stage_timings` WRITE THAT ALREADY EXISTED.
 * ===========================================================================
 *
 * MEASURED 22 September 2026, production, a real customer upload:
 * `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`, 8,530,307 bytes.
 *
 *     10:05:56.792  processing started
 *     10:06:01.915  deterministic reading complete — 11 fields read
 *     10:06:04.895  POST builder-portal-stock -> 546  CPU Time exceeded
 *
 * and the row it left behind read `stage_timings: null`.
 *
 * That is the whole problem with a ledger written at the END of a run. The
 * import that survives tells you what it spent; the import that DIES tells
 * you nothing, and the import that dies is the only one you needed to
 * measure. Eight seconds of a customer's CPU went somewhere and the only
 * evidence was a 546 and a log line about the reader finishing.
 *
 * So the ledger is written FORWARD. Every stage boundary commits what has
 * been spent so far, which costs one small UPDATE per stage and means a
 * worker killed anywhere leaves a row saying exactly how far it got and what
 * each completed stage cost. The last entry before the gap is the stage that
 * killed it.
 *
 * ===========================================================================
 * IT IS ALSO THE RESUME POINT, WHICH IS WHY IT LIVES IN ITS OWN MODULE.
 * ===========================================================================
 *
 * The same row answers "what did this cost" and "where had it got to". A
 * successor reads `stage` to know what is already done. Keeping the two in one
 * structure is deliberate: a progress marker that disagrees with the timing
 * ledger would be two accounts of one run, and this repository has paid for
 * that shape more than once.
 *
 * DIAGNOSTICS AND PROGRESS ONLY. Milliseconds, counts and stage names — never
 * a byte of a customer's document, never a field value, never a filename.
 *
 * Pure: no IO and no clock. The caller stamps and persists.
 */

/**
 * The stages of an import, in the order they run.
 *
 * NAMED FOR WHAT THEY DO, and split at the granularity the 22 September
 * incident asked for — `document_extract_ms` was one number covering the text
 * layer AND the positioned layout, which is two different costs over the same
 * bytes and no way to tell which one is expensive.
 */
export const IMPORT_STAGES = [
  'document_open',       // bytes hashed, classified, duplicate-checked
  'native_text',         // the PDF's own text layer
  'positioned_layout',   // the positioned runs the segmenter needs
  'ocr',                 // recognition, only where a page carries no text
  'normalisation',       // page text normalised for the readers
  'segmentation',        // property regions, where a page carries several
  'property_reader',     // the deterministic reading
  'image_discovery',     // finding the rasters in the document
  'image_decode',        // decoding and classifying them
  'image_store',         // persisting them
  'db_write',            // the property rows
  'initial_image_work',  // the first rungs of the image ladder
  'finalisation',        // counts, status, publication bookkeeping
] as const;

export type ImportStage = typeof IMPORT_STAGES[number];

/** Which resource class a stage spends. Mirrors `workAllowance.pure.ts`. */
export type ImportWorkClass = 'document' | 'raster' | 'metadata';

/**
 * WHAT EACH STAGE COSTS, AND IN WHICH CURRENCY.
 *
 * The settler learned that an isolate dies of ONE resource and that wall
 * clock cannot see it. The same three classes are used here so the two
 * engines cannot come to describe the same work differently:
 *
 *   `document`  opens and walks the PDF — the page tree, the text layer, the
 *               positioned runs, recognition.
 *   `raster`    decodes, classifies and re-encodes pictures.
 *   `metadata`  reads and writes rows. Decodes nothing, opens nothing.
 */
export function importWorkClassOf(stage: ImportStage): ImportWorkClass {
  switch (stage) {
    case 'document_open':
    case 'native_text':
    case 'positioned_layout':
    case 'ocr':
    case 'normalisation':
    case 'segmentation':
    case 'property_reader':
    case 'image_discovery':
      return 'document';
    case 'image_decode':
    case 'image_store':
      return 'raster';
    default:
      return 'metadata';
  }
}

export interface ImportStageLedger {
  /** The last stage that COMPLETED. Absent means none has. */
  stage?: ImportStage | null;
  /** Milliseconds per completed stage, keyed `<stage>_ms`. */
  [key: string]: unknown;
}

/** The key a stage's duration is written under. One spelling, named once. */
export const stageMsKey = (stage: ImportStage): string => `${stage}_ms`;

/**
 * Fold a completed stage into the ledger.
 *
 * ADDS rather than replaces, because a stage can legitimately run more than
 * once in a run — the OCR branch and the image discovery branch both parse,
 * and a resumed import re-enters a stage it had only partly finished. A
 * ledger that overwrote would hide exactly that.
 */
export function recordStage(
  ledger: ImportStageLedger,
  stage: ImportStage,
  ms: number,
): ImportStageLedger {
  const key = stageMsKey(stage);
  const before = typeof ledger[key] === 'number' ? ledger[key] as number : 0;
  ledger[key] = before + Math.max(0, Math.round(ms));
  ledger.stage = stage;
  return ledger;
}

/** Add to a counter (`document_parses`, `images_extracted`, …). */
export function countIn(
  ledger: ImportStageLedger, key: string, by = 1,
): ImportStageLedger {
  const before = typeof ledger[key] === 'number' ? ledger[key] as number : 0;
  ledger[key] = before + by;
  return ledger;
}

/** Total milliseconds this ledger accounts for, across every stage. */
export function ledgerTotalMs(ledger: ImportStageLedger): number {
  let total = 0;
  for (const stage of IMPORT_STAGES) {
    const value = ledger[stageMsKey(stage)];
    if (typeof value === 'number') total += value;
  }
  return total;
}

/** What a class has cost so far, in milliseconds. */
export function classSpendMs(
  ledger: ImportStageLedger, workClass: ImportWorkClass,
): number {
  let total = 0;
  for (const stage of IMPORT_STAGES) {
    if (importWorkClassOf(stage) !== workClass) continue;
    const value = ledger[stageMsKey(stage)];
    if (typeof value === 'number') total += value;
  }
  return total;
}

/**
 * The stage a run should ENTER next, given what the ledger says completed.
 *
 * A ledger naming no stage starts at the beginning. A ledger naming the last
 * stage is finished and answers null — which is what makes a duplicate
 * successor a no-op rather than a second import.
 */
export function nextStageAfter(ledger: ImportStageLedger | null | undefined): ImportStage | null {
  const done = ledger?.stage;
  if (!done) return IMPORT_STAGES[0];
  const at = IMPORT_STAGES.indexOf(done as ImportStage);
  if (at < 0) return IMPORT_STAGES[0];
  return IMPORT_STAGES[at + 1] ?? null;
}

/**
 * Fold one invocation's account into the import's running account.
 *
 * ===========================================================================
 * WHY AN IMPORT KEEPS TWO LEDGERS AND NOT ONE.
 * ===========================================================================
 *
 * They answer different questions and the same object cannot answer both.
 *
 * `stage_timings` on the row is the IMPORT'S account: what this document has
 * cost in total, across however many isolates it took. That is what a support
 * question needs and what the 22 September incident had none of.
 *
 * The budget is about THIS INVOCATION: how much of its own allowance a worker
 * has spent and whether it may begin another expensive step. A successor that
 * inherited its predecessor's spend would arrive with its allowance already
 * gone, decline every step, hand off again, and the import would spend all
 * ten of its crossings doing nothing — the exact failure a resumable importer
 * is supposed to prevent, produced by the mechanism meant to prevent it.
 *
 * So a run records into a FRESH ledger and this folds it onto the inherited
 * one at the moment of writing. `recordStage` adds, so the merged totals are
 * the sums; `stage` is the last stage of the run doing the writing, which is
 * what a termination diagnostic is asking about.
 */
export function mergeLedgers(
  base: ImportStageLedger | null | undefined,
  delta: ImportStageLedger,
): ImportStageLedger {
  const merged: ImportStageLedger = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'stage') continue;
    if (typeof value === 'number') {
      const existing = merged[key];
      merged[key] = (typeof existing === 'number' ? existing : 0) + value;
    } else {
      merged[key] = value;
    }
  }
  if (delta.stage) merged.stage = delta.stage;
  return merged;
}
