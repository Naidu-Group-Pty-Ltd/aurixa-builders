/**
 * A RE-READ CROSSES ISOLATES THE WAY AN IMPORT DOES — AND COUNTS THE TICKS
 * THAT DIE.
 *
 * The reader sweep used to re-read inline: the document parsed and its
 * pictures decoded in one isolate. `LOT 550 - ENZO 8.5 MODERN- BROCHURE
 * V002.pdf` killed the settler fifteen times there over 22 and 23 September
 * 2026, a kill wrote nothing, and the row stood at the head of the queue for
 * ever. The one live source on the production project on 23 September —
 * `LOT 4327 Jubilee Estate - ENZO 10.5 MODERN - BROCHURE V002 - Copy.pdf`,
 * 7.76 MB — is the same class and needed the reader version that was fenced
 * because of it.
 *
 * These pin what made it safe to move: the read is handed on where the import
 * hands it on, a successor resumes only its OWN checkpoint, a tick is written
 * down before it works, and a document that keeps killing the tick is asked a
 * bounded number of times.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_SWEEP_ATTEMPT_TICKS, MAX_UNFINISHED_SWEEP_TICKS, planSweepTick,
  readSweepAttempt, sameInstant, sweepHandedOn, sweepHandedOnThisParse,
  type ReaderSweepAttempt,
} from '../../../supabase/functions/_shared/builderStock/readerSweepAttempt.pure';
import {
  MAX_IMPORT_CONTINUATIONS, MAX_PICTURE_CROSSINGS,
} from '../../../supabase/functions/_shared/builderStock/importCheckpoint.pure';
import {
  ABANDONED_UPLOAD_MS, DETERMINISTIC_READER_VERSION, READER_SETTLED_VERSION_COLUMN,
  readerReReadRefusal,
} from '../../../supabase/functions/_shared/builderStock/readerVersion.pure';

const V = DETERMINISTIC_READER_VERSION;
const STARTED = '2026-09-23T08:20:14.591+00:00';
const SAME_INSTANT_WRITTEN_BY_JS = '2026-09-23T08:20:14.591Z';
const NOW = '2026-09-23T09:00:00.000Z';

const attempt = (patch: Partial<ReaderSweepAttempt> = {}): ReaderSweepAttempt => ({
  version: V,
  ticks: 1,
  unfinished: 0,
  handed_on: 1,
  fingerprint: SAME_INSTANT_WRITTEN_BY_JS,
  first_pass: false,
  started_at: NOW,
  last: 'handed_on',
  at: NOW,
  ...patch,
});

describe('the attempt record', () => {
  it('is read only at the version it was written for', () => {
    expect(readSweepAttempt(attempt(), V)).toMatchObject({ ticks: 1, handed_on: 1 });
    expect(readSweepAttempt(attempt({ version: V - 1 }), V)).toBeNull();
    expect(readSweepAttempt(null, V)).toBeNull();
    expect(readSweepAttempt([attempt()], V)).toBeNull();
  });

  it('treats a record it cannot trust as absent, which starts afresh', () => {
    expect(readSweepAttempt({ ...attempt(), ticks: -1 }, V)).toBeNull();
    expect(readSweepAttempt({ ...attempt(), unfinished: 1.5 }, V)).toBeNull();
    expect(readSweepAttempt({ ...attempt(), handed_on: '1' }, V)).toBeNull();
  });

  it('compares start stamps as instants, not as spellings', () => {
    expect(sameInstant(STARTED, SAME_INSTANT_WRITTEN_BY_JS)).toBe(true);
    expect(sameInstant(STARTED, '2026-09-23T08:20:15.000Z')).toBe(false);
    expect(sameInstant(null, undefined)).toBe(true);
    expect(sameInstant(null, STARTED)).toBe(false);
  });

  it('bounds an attempt by the crossings an import may itself spend', () => {
    expect(MAX_SWEEP_ATTEMPT_TICKS).toBe(
      1 + MAX_IMPORT_CONTINUATIONS + MAX_PICTURE_CROSSINGS + MAX_UNFINISHED_SWEEP_TICKS);
  });
});

describe('planning one tick', () => {
  const input = { version: V, processingStartedAt: STARTED, firstPass: false, now: NOW };

  it('starts afresh where there is no record', () => {
    const plan = planSweepTick(null, input);
    expect(plan).toMatchObject({ exhausted: false, resumes: false });
    expect(plan.next).toMatchObject({
      ticks: 1, unfinished: 0, handed_on: 0, fingerprint: STARTED, last: 'started',
    });
  });

  it('resumes a chain that handed on, from the same import attempt', () => {
    const plan = planSweepTick(attempt(), input);
    expect(plan.resumes).toBe(true);
    expect(plan.next).toMatchObject({ ticks: 2, unfinished: 0, handed_on: 1 });
  });

  it('starts again where another import attempt took the row in between', () => {
    // A builder pressed "Read again": a new start stamp, and a checkpoint that
    // is theirs. Nothing this chain handed on survives that.
    const plan = planSweepTick(attempt(),
      { ...input, processingStartedAt: '2026-09-23T08:55:00.000Z' });
    expect(plan.resumes).toBe(false);
    expect(plan.next.handed_on).toBe(0);
  });

  it('counts a tick that never reported, and one that reported a fault', () => {
    expect(planSweepTick(attempt({ last: 'started' }), input).next.unfinished).toBe(1);
    expect(planSweepTick(attempt({ last: 'fault' }), input).next.unfinished).toBe(1);
    expect(planSweepTick(attempt({ last: 'handed_on' }), input).next.unfinished).toBe(0);
  });

  it('still resumes after a successor died: the hand-off it was given survives', () => {
    const plan = planSweepTick(attempt({ last: 'started', ticks: 2 }), input);
    expect(plan).toMatchObject({ resumes: true, exhausted: false });
  });

  it('stops asking once two ticks have neither finished nor handed on', () => {
    const plan = planSweepTick(attempt({ unfinished: 1, last: 'started', ticks: 3 }), input);
    expect(plan.exhausted).toBe(true);
  });

  it('stops asking at the most ticks one attempt may take, whatever they did', () => {
    const plan = planSweepTick(attempt({ ticks: MAX_SWEEP_ATTEMPT_TICKS }), input);
    expect(plan.exhausted).toBe(true);
  });

  it('keeps what the attempt began as: a first pass stays a first pass', () => {
    const plan = planSweepTick(attempt({ first_pass: true }), { ...input, firstPass: false });
    expect(plan.next.first_pass).toBe(true);
  });
});

describe("the sweep's own hand-off is not somebody else's parse", () => {
  const parsing = (record: unknown, started = STARTED) => ({
    id: 'u1', status: 'parsing', source_type: 'file', storage_bucket: 'b',
    storage_path: 'stock-lists/org/u1/doc.pdf', processing_started_at: started,
    reader_sweep_attempt: record,
  });
  const now = Date.parse('2026-09-23T08:21:00Z');

  it('lets the sweep resume a read it handed on moments ago', () => {
    expect(sweepHandedOnThisParse(parsing(attempt()), V)).toBe(true);
    expect(readerReReadRefusal(parsing(attempt()), now)).toBeNull();
  });

  it('leaves a parse alone that is somebody else\'s', () => {
    // No record: an import the builder is watching.
    expect(readerReReadRefusal(parsing(null), now)).toBe('parse_in_flight');
    // A record from a different import attempt.
    expect(readerReReadRefusal(parsing(attempt(), '2026-09-23T08:20:59Z'), now))
      .toBe('parse_in_flight');
    // A tick of ours that is running right now, or died a moment ago: its
    // claim decides, and the import's own recovery is behind it.
    expect(readerReReadRefusal(parsing(attempt({ last: 'started' })), now))
      .toBe('parse_in_flight');
  });
});

// ---------------------------------------------------------------------------
// The sweep itself, against a database that records what it was asked.
// ---------------------------------------------------------------------------

type Event =
  | { kind: 'update'; patch: Record<string, unknown> }
  | { kind: 'rpc'; name: string; args: unknown }
  | { kind: 'download' }
  | { kind: 'read'; uploadId: string; input: Record<string, unknown> };

function fakeDb(rows: Array<Record<string, unknown>>, options: {
  claim?: boolean;
  refuseAttemptWrites?: boolean;
} = {}) {
  const events: Event[] = [];
  const chainOf = (data: Array<Record<string, unknown>>) => {
    let filtered = data;
    const chain: any = {
      select: () => chain, is: () => chain, lt: () => chain, order: () => chain,
      limit: () => chain,
      eq: (column: string, value: unknown) => {
        if (column === 'id') filtered = filtered.filter((row) => row.id === value);
        return chain;
      },
      then: (resolve: any) => resolve({ data: filtered, error: null }),
    };
    return chain;
  };
  const db: any = {
    from: (table: string) => {
      if (table === 'builder_organisations') {
        return { select: () => ({ eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null }),
        }) }) };
      }
      if (table !== 'builder_stock_uploads') return chainOf([]);
      return {
        select: () => chainOf(rows),
        update: (patch: Record<string, unknown>) => {
          events.push({ kind: 'update', patch });
          const onlyTheRecord = Object.keys(patch).length === 1 && 'reader_sweep_attempt' in patch;
          const error = options.refuseAttemptWrites && onlyTheRecord ? { message: 'refused' } : null;
          const tail: any = {
            eq: () => tail,
            select: () => Promise.resolve({ data: [{ id: 'claimed' }], error: null }),
            then: (resolve: any) => resolve({ error }),
          };
          return tail;
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      events.push({ kind: 'rpc', name, args });
      if (name === 'builder_stock_claim_import') {
        return Promise.resolve({ data: options.claim ?? true, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
    storage: {
      from: () => ({
        download: () => {
          events.push({ kind: 'download' });
          return Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) },
            error: null,
          });
        },
      }),
    },
  };
  return { db, events };
}

const SETTLED = {
  id: 'u1', organisation_id: 'org', status: 'complete', source_type: 'file',
  storage_bucket: 'stock-lists', storage_path: 'stock-lists/org/u1/lot-4327.pdf',
  original_filename: 'LOT 4327 Jubilee Estate - ENZO 10.5 MODERN - BROCHURE V002 - Copy.pdf',
  uploaded_by_builder_user_id: 'builder-1', deleted_at: null,
  processing_started_at: STARTED, created_at: '2026-09-23T08:20:14Z',
  import_checkpoint: { v: 1, sha256: 'abc' }, stage_timings: { document_parses: 1 },
};

const HANDED_ON = {
  ok: true, continued: true, reason: 'pictures_outstanding', outstanding: 4, continuations: 1,
};
const READ = {
  ok: true, strategy: 'pdf_deterministic_brochure', uploadStatus: 'enriching',
  summary: {
    detected: 1, imported: 0, updated: 1, failed: 0, failures: [],
    withSourceImage: 1, imageryOutstanding: false,
  },
};

async function tick(
  rows: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
  options: Parameters<typeof fakeDb>[1] = {},
) {
  const { settleReaderVersion } = await import(
    '../../../supabase/functions/_shared/builderStock/settleReaderVersion');
  // A copy per tick, as a database hands back: the sweep writes to the row
  // object it was given, and a fixture shared between tests must not remember.
  const { db, events } = fakeDb(rows.map((row) => structuredClone(row)), options);
  const queue = [...results];
  const runImport = vi.fn(async (input: Record<string, any>) => {
    events.push({ kind: 'read', uploadId: input.upload.id, input });
    return queue.shift() ?? READ;
  });
  const outcome = await settleReaderVersion(db, {}, { runImport: runImport as any });
  const updates = events.filter((e): e is Extract<Event, { kind: 'update' }> => e.kind === 'update')
    .map((e) => e.patch);
  const rpcs = events.filter((e): e is Extract<Event, { kind: 'rpc' }> => e.kind === 'rpc')
    .map((e) => e.name);
  const records = updates.filter((patch) => 'reader_sweep_attempt' in patch)
    .map((patch) => patch.reader_sweep_attempt as ReaderSweepAttempt);
  return { outcome, events, updates, rpcs, records, runImport };
}

describe('a settled list whose read hands its pictures on', () => {
  it('is read the way "Read again" reads it, as a fresh attempt', async () => {
    const { runImport } = await tick([SETTLED], [HANDED_ON]);
    const input = (runImport.mock.calls[0] as any[])[0];
    expect(input.resumableFromStoredBytes).toBe(true);
    expect(input.resumed).toBe(false);
    expect(input.storedCheckpoint).toEqual(SETTLED.import_checkpoint);
    // A fresh attempt opens its own account; it inherits nobody's ledger.
    expect(input.ledger).toBeNull();
  });

  it('continues on the sweep\'s own next tick, started now, and stays outstanding', async () => {
    const { outcome, updates, rpcs, records } = await tick([SETTLED], [HANDED_ON]);
    expect(outcome.handedOn).toEqual([{ uploadId: 'u1', via: 'reader_sweep' }]);
    expect(outcome.reread).toBe(0);
    expect(updates.some((patch) => READER_SETTLED_VERSION_COLUMN in patch)).toBe(false);
    // A settled list is never made to look busy.
    expect(updates.some((patch) => 'status' in patch)).toBe(false);
    expect(records.at(-1)).toMatchObject({ handed_on: 1, last: 'handed_on', fingerprint: STARTED });
    // Released, then the next settler is started — in that order.
    expect(rpcs).toEqual([
      'builder_stock_claim_import',
      'builder_stock_release_import',
      'builder_stock_dispatch_reader_sweep',
    ]);
  });

  it('records the hand-off before it lets the claim go', async () => {
    const { events } = await tick([SETTLED], [HANDED_ON]);
    const recorded = events.findIndex((e) => e.kind === 'update'
      && (e.patch.reader_sweep_attempt as ReaderSweepAttempt | undefined)?.last === 'handed_on');
    const released = events.findIndex((e) => e.kind === 'rpc' && e.name === 'builder_stock_release_import');
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThan(recorded);
  });
});

describe('the tick after it', () => {
  it('resumes that checkpoint as a successor and stamps the version when it finishes', async () => {
    const row = { ...SETTLED, reader_sweep_attempt: attempt() };
    const { runImport, updates, outcome } = await tick([row], [READ]);
    const input = (runImport.mock.calls[0] as any[])[0];
    expect(input.resumed).toBe(true);
    expect(input.ledger).toEqual(SETTLED.stage_timings);
    expect(outcome.reread).toBe(1);
    const stamp = updates.find((patch) => READER_SETTLED_VERSION_COLUMN in patch)!;
    expect(stamp[READER_SETTLED_VERSION_COLUMN]).toBe(V);
    expect(stamp.reader_sweep_attempt).toMatchObject({ ticks: 2, handed_on: 1, last: 'read' });
  });

  it('starts again where a builder\'s own read took the row in between', async () => {
    const row = {
      ...SETTLED, processing_started_at: '2026-09-23T08:55:00+00:00',
      reader_sweep_attempt: attempt(),
    };
    const { runImport } = await tick([row], [READ]);
    expect((runImport.mock.calls[0] as any[])[0].resumed).toBe(false);
  });

  it('is finished before another document is begun', async () => {
    const older = { ...SETTLED, id: 'u-old', created_at: '2026-01-01T00:00:00Z' };
    const chain = { ...SETTLED, id: 'u-chain', reader_sweep_attempt: attempt() };
    const { runImport } = await tick([older, chain], [READ]);
    expect(runImport).toHaveBeenCalledTimes(1);
    expect((runImport.mock.calls[0] as any[])[0].upload.id).toBe('u-chain');
  });
});

describe('a tick is counted before it works', () => {
  it('writes the record before the import runs', async () => {
    const { events } = await tick([SETTLED], [READ]);
    const started = events.findIndex((e) => e.kind === 'update'
      && (e.patch.reader_sweep_attempt as ReaderSweepAttempt | undefined)?.last === 'started');
    const read = events.findIndex((e) => e.kind === 'read');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(started);
  });

  it('does not start a read it could not count', async () => {
    const { runImport, outcome, events } = await tick([SETTLED], [READ], { refuseAttemptWrites: true });
    expect(runImport).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'download')).toBe(false);
    expect(outcome.failed).toEqual([{ uploadId: 'u1', reason: 'attempt_not_recorded' }]);
  });

  it('counts the tick a kill erased, on the next tick', async () => {
    const row = { ...SETTLED, reader_sweep_attempt: attempt({ ticks: 2, last: 'started' }) };
    const { records } = await tick([row], [READ]);
    expect(records[0]).toMatchObject({ ticks: 3, unfinished: 1, last: 'started' });
  });
});

describe('a document that keeps killing the tick', () => {
  it('is asked a bounded number of times, then left exactly as it is', async () => {
    const row = {
      ...SETTLED,
      reader_sweep_attempt: attempt({ ticks: 3, unfinished: 1, handed_on: 1, last: 'started' }),
    };
    const { runImport, outcome, updates, events } = await tick([row], [READ]);
    expect(runImport).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'download')).toBe(false);
    expect(outcome.refused).toEqual([{ uploadId: 'u1', reason: 'attempts_exhausted' }]);
    // The rows it already produced are live stock: no status, no error.
    expect(updates.some((patch) => 'status' in patch || 'error_code' in patch)).toBe(false);
    const stamp = updates.find((patch) => READER_SETTLED_VERSION_COLUMN in patch)!;
    expect(stamp.reader_sweep_attempt).toMatchObject({ last: 'gave_up' });
  });
});

describe('one reader per document, and one read per tick', () => {
  it('leaves a document somebody else is reading exactly alone', async () => {
    const { runImport, updates, outcome } = await tick([SETTLED], [READ], { claim: false });
    expect(runImport).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(outcome.refused).toEqual([{ uploadId: 'u1', reason: 'claimed_elsewhere' }]);
  });

  it('starts one read a tick, whatever that read ended in', async () => {
    const first = { ...SETTLED, id: 'u-a', created_at: '2026-01-01T00:00:00Z' };
    const second = { ...SETTLED, id: 'u-b', created_at: '2026-02-01T00:00:00Z' };
    const { runImport } = await tick([first, second],
      [{ ok: false, code: 'pdf_text_extraction_failed', message: 'x' }, READ]);
    expect(runImport).toHaveBeenCalledTimes(1);
  });
});

describe('a first pass the sweep adopts', () => {
  const abandoned = {
    ...SETTLED,
    status: 'uploaded',
    processing_started_at: null,
    created_at: new Date(Date.now() - ABANDONED_UPLOAD_MS - 60_000).toISOString(),
    import_checkpoint: null,
    stage_timings: null,
  };

  it('is handed to the import\'s own successor, which finishes it as an import', async () => {
    const { outcome, rpcs, updates, records } = await tick([abandoned], [HANDED_ON]);
    expect(updates.some((patch) => patch.status === 'parsing')).toBe(true);
    expect(outcome.handedOn).toEqual([{ uploadId: 'u1', via: 'import_continuation' }]);
    expect(rpcs).toEqual([
      'builder_stock_claim_import',
      'builder_stock_release_import',
      'builder_stock_dispatch_import_continuation',
    ]);
    expect(records.at(-1)).toMatchObject({ first_pass: true, last: 'handed_on' });
  });

  it('carries the adoption\'s own start stamp as its fingerprint', async () => {
    const { updates, records } = await tick([abandoned], [HANDED_ON]);
    const claimed = updates.find((patch) => patch.status === 'parsing')!;
    expect(sameInstant(records[0].fingerprint, claimed.processing_started_at)).toBe(true);
  });

  it('writes the import\'s status when a later tick of the same attempt finishes it', async () => {
    // The adopting tick handed on through a path the successor could not
    // read; the sweep finished it itself, and a first pass must still end in
    // the import's own status rather than at `parsing`.
    const row = {
      ...abandoned,
      status: 'parsing',
      processing_started_at: STARTED,
      storage_path: 'legacy/org/u1/lot.pdf',
      reader_sweep_attempt: attempt({ first_pass: true }),
    };
    const { updates } = await tick([row], [READ]);
    const outcomeWrite = updates.find((patch) => 'records_detected' in patch)!;
    expect(outcomeWrite.status).toBe('enriching');
  });
});

describe('the handed-on record composes', () => {
  it('adds one hand-off and says so', () => {
    expect(sweepHandedOn(attempt({ handed_on: 2, last: 'started' }), NOW))
      .toMatchObject({ handed_on: 3, last: 'handed_on' });
  });
});
