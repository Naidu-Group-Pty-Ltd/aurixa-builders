/**
 * BUILDER STOCK — ONE RE-READ, SPREAD ACROSS ISOLATES THE WAY AN IMPORT IS,
 * AND BOUNDED WHERE A KILL WOULD OTHERWISE MAKE IT ENDLESS.
 *
 * ===========================================================================
 * WHY THE SWEEP NEEDS A RECORD OF ITS OWN
 * ===========================================================================
 *
 * The reader sweep re-reads a stored document through `runStockImport`. Until
 * this module it did so INLINE — parse and decode in one isolate — because it
 * never declared `resumableFromStoredBytes`, and that is the one shape the
 * import was rebuilt to avoid: `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`
 * (8,530,307 bytes) killed the image settler twelve times on 22 September 2026
 * and three more on 23 September, every time inside that re-read, and a kill
 * writes nothing — so the row stayed outstanding with no attempt bound, the
 * sweep took it first on every quiet tick, and no row behind it was ever read.
 * The version was FENCED at 13 for that reason
 * (`builderStockReaderSweep.spec.ts`), with the document that needed version
 * 14 — `LOT 4327 Jubilee Estate - ENZO 10.5 MODERN - BROCHURE V002 - Copy.pdf`,
 * 7,762,286 bytes, the only live source on the production project — being
 * exactly that class.
 *
 * So the sweep now reads the way an import reads: the isolate that parses the
 * document hands its pictures on and a later isolate attaches them. What the
 * import carries in its checkpoint, the sweep also has to carry between ITS
 * ticks, and that is what this record is:
 *
 *   • WHICH ATTEMPT the stored checkpoint belongs to. A successor may only
 *     resume a checkpoint its own attempt wrote. The product's checkpoint on a
 *     settled row is another attempt's — its crossings spent, its hand-off
 *     already discarded — and resuming it would find no hand-off, read the
 *     document inline, and be unable to cross: LOT 550 again, reached by a
 *     different route. Every product attempt stamps `processing_started_at`
 *     when it begins and no continuation refreshes it, so that stamp is the
 *     fingerprint.
 *
 *   • HOW MANY TICKS STARTED AND DID NOT FINISH. A tick is counted BEFORE it
 *     does any work, because the tick the runtime kills is the one that can
 *     write nothing afterwards. A tick that ended by handing the read on is
 *     progress; one that was killed, or faulted, is not — and after
 *     `MAX_UNFINISHED_SWEEP_TICKS` of those the sweep stops asking this
 *     document at this version and moves on, instead of dying on it for ever.
 *
 * Pure: no IO, no clock beyond what a caller hands it.
 */
import {
  MAX_IMPORT_CONTINUATIONS, MAX_PICTURE_CROSSINGS,
} from './importCheckpoint.pure.ts';

/** Where the record lives. Named once; two spellings is how two ends drift. */
export const READER_SWEEP_ATTEMPT_COLUMN = 'reader_sweep_attempt';

/**
 * How many ticks may start work on one document at one version and neither
 * finish nor hand on, before the sweep stops asking.
 *
 * Two, and the reason is what those ticks are. A kill on the same bytes by the
 * same code is deterministic: the second one confirms the first, and a third
 * buys another dead isolate and nothing else. A transient fault — storage
 * unreachable for a moment — gets its one retry. What the sweep gives up on is
 * a RE-READ; the rows the document already produced stay exactly as they are,
 * and a builder's own "Read again" is untouched by any of this.
 */
export const MAX_UNFINISHED_SWEEP_TICKS = 2;

/**
 * The most ticks one attempt may take, whatever they did.
 *
 * DERIVED, NOT CHOSEN: the fresh read, every crossing the import itself may
 * spend (recognition and pictures, each bounded by the checkpoint), and the
 * unfinished allowance above. An attempt that reaches it is one whose
 * checkpoint keeps being replaced under it, and a record that cannot stop is
 * the defect this module exists to end.
 */
export const MAX_SWEEP_ATTEMPT_TICKS =
  1 + MAX_IMPORT_CONTINUATIONS + MAX_PICTURE_CROSSINGS + MAX_UNFINISHED_SWEEP_TICKS;

/** The last thing a tick recorded, which is also how the NEXT tick reads it. */
export type SweepTickWord =
  | 'started'         // a tick began and has not reported: it is running, or it was killed
  | 'handed_on'       // the read was handed to a successor; progress
  | 'fault'           // the read failed for a reason that was not the document's
  | 'read'            // finished: the document was read at this version
  | 'verdict'         // finished: the document answered, and the answer is final
  | 'object_missing'  // finished: there are no bytes left to read
  | 'gave_up';        // finished: the sweep stopped asking at this version

/** The record, exactly as it is stored. */
export interface ReaderSweepAttempt {
  /** The reader version this attempt reads at. Another version is another attempt. */
  version: number;
  /** Ticks that began work on this upload at this version. */
  ticks: number;
  /** Of those, the ones that neither finished nor handed on. */
  unfinished: number;
  /** Hand-offs made by THIS attempt's current chain. Zero after a fresh start. */
  handed_on: number;
  /** `processing_started_at` when the chain took the checkpoint. See the header. */
  fingerprint: string | null;
  /** The attempt began from `uploaded`: its finish writes the import's own status. */
  first_pass: boolean;
  started_at: string | null;
  last: SweepTickWord | null;
  at: string | null;
}

const count = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : null;

/**
 * The record this upload carries for `version`, or null where it carries none.
 *
 * Null for a record at another version, and for one that cannot be read: a
 * malformed record is treated as absent, which makes the next tick a FRESH
 * attempt — the conservative side, because a fresh attempt discards whatever
 * the stored checkpoint handed on and resumes nothing it cannot prove is its
 * own.
 */
export function readSweepAttempt(raw: unknown, version: number): ReaderSweepAttempt | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== version) return null;
  const ticks = count(record.ticks);
  const unfinished = count(record.unfinished);
  const handedOn = count(record.handed_on);
  if (ticks === null || unfinished === null || handedOn === null) return null;
  return {
    version,
    ticks,
    unfinished,
    handed_on: handedOn,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : null,
    first_pass: record.first_pass === true,
    started_at: typeof record.started_at === 'string' ? record.started_at : null,
    last: typeof record.last === 'string' ? record.last as SweepTickWord : null,
    at: typeof record.at === 'string' ? record.at : null,
  };
}

/**
 * Two readings of one `timestamptz` are the same instant.
 *
 * Compared as instants, never as strings: the sweep writes a claim's start as
 * `2026-09-23T08:20:14.591Z` and reads it back as
 * `2026-09-23T08:20:14.591+00:00`. Both absent is the same (no attempt ever
 * stamped one); one absent is not.
 */
export function sameInstant(a: unknown, b: unknown): boolean {
  const left = typeof a === 'string' ? Date.parse(a) : Number.NaN;
  const right = typeof b === 'string' ? Date.parse(b) : Number.NaN;
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  return left === right;
}

/** What one tick is about to do, decided before it does anything. */
export interface SweepTickPlan {
  /** Stop asking: the attempt is spent. Nothing is read. */
  exhausted: boolean;
  /**
   * Resume the checkpoint this attempt handed on, as a successor does, rather
   * than starting a fresh read. See the header for why it must be its OWN.
   */
  resumes: boolean;
  /** The record to write BEFORE the work, so a killed tick is still counted. */
  next: ReaderSweepAttempt;
}

/**
 * Plan one tick from the record the upload carries.
 *
 * `processingStartedAt` is the row's own stamp as this tick reads it, after
 * any claim this tick made. `firstPass` says whether THIS tick adopted an
 * `uploaded` row; an attempt already under way keeps what it began as.
 */
export function planSweepTick(
  previous: ReaderSweepAttempt | null,
  input: {
    version: number;
    processingStartedAt: string | null;
    firstPass: boolean;
    now: string;
  },
): SweepTickPlan {
  const base: ReaderSweepAttempt = previous ?? {
    version: input.version,
    ticks: 0,
    unfinished: 0,
    handed_on: 0,
    fingerprint: null,
    first_pass: false,
    started_at: null,
    last: null,
    at: null,
  };
  /*
   * A TICK THAT NEVER REPORTED IS COUNTED NOW. `started` with this tick
   * holding the claim means the tick that wrote it is gone — the runtime took
   * it, or its lease ran out — and `fault` is the one that reported failing.
   */
  const unfinished = base.unfinished
    + (base.last === 'started' || base.last === 'fault' ? 1 : 0);

  /*
   * THE SAME ATTEMPT, OR ANOTHER ONE THAT HAPPENS TO SHARE THE ROW. A builder
   * who pressed "Read again" between two ticks began a new import attempt —
   * a new `processing_started_at`, and a checkpoint that is theirs. Nothing
   * this attempt handed on survives that (`freshAttempt` discards it), so the
   * chain starts again rather than resuming somebody else's.
   */
  const sameAttempt = base.ticks > 0
    && sameInstant(base.fingerprint, input.processingStartedAt);
  const handedOn = sameAttempt ? base.handed_on : 0;

  const next: ReaderSweepAttempt = {
    version: input.version,
    ticks: base.ticks + 1,
    unfinished,
    handed_on: handedOn,
    fingerprint: input.processingStartedAt,
    first_pass: sameAttempt ? base.first_pass : input.firstPass,
    started_at: base.started_at ?? input.now,
    last: 'started',
    at: input.now,
  };

  return {
    exhausted: unfinished >= MAX_UNFINISHED_SWEEP_TICKS
      || base.ticks >= MAX_SWEEP_ATTEMPT_TICKS,
    // Only a chain that has handed on has a checkpoint of its own to resume.
    resumes: handedOn > 0,
    next,
  };
}

/** The record after the read was handed to a successor. */
export function sweepHandedOn(attempt: ReaderSweepAttempt, now: string): ReaderSweepAttempt {
  return { ...attempt, handed_on: attempt.handed_on + 1, last: 'handed_on', at: now };
}

/** The record after a tick that ended, one way or another. */
export function sweepTickEnded(
  attempt: ReaderSweepAttempt,
  word: Exclude<SweepTickWord, 'started' | 'handed_on'>,
  now: string,
): ReaderSweepAttempt {
  return { ...attempt, last: word, at: now };
}

/**
 * Is this `parsing` row the sweep's OWN read, handed on and waiting for its
 * successor — as opposed to an import somebody else is running?
 *
 * The reader sweep leaves a `parsing` row alone while it is fresh
 * (`parse_in_flight`), because a builder's import may be inside it. A row the
 * sweep itself claimed and handed on is `parsing` too, with a start stamp the
 * sweep wrote seconds ago — and left alone by that rule it would wait fifteen
 * minutes for a successor nobody else is going to be. This recognises it by
 * the same three facts the successor needs: this version, this attempt, and a
 * hand-off as the last thing that happened. The claim is still taken before
 * anything is read, so this can never put two readers on one document.
 */
export function sweepHandedOnThisParse(
  upload: { status?: unknown; processing_started_at?: unknown; reader_sweep_attempt?: unknown },
  version: number,
): boolean {
  if (String(upload?.status ?? '') !== 'parsing') return false;
  const attempt = readSweepAttempt(upload?.reader_sweep_attempt, version);
  return Boolean(attempt)
    && attempt!.last === 'handed_on'
    && attempt!.handed_on > 0
    && sameInstant(attempt!.fingerprint, upload?.processing_started_at);
}
