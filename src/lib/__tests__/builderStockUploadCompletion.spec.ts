/**
 * AN IMPORT THAT FINISHED IS RECORDED AS FINISHED — pinned.
 *
 * PRODUCTION, 19 SEPTEMBER 2026. Upload `c2b7faa1` (`export.csv`, 13
 * properties) imported at 10:38:59, published all thirteen at 10:46:02 and
 * then sat at `status = 'enriching'` indefinitely. The builder's Stock List
 * read `Properties listed 13 · No imagery outstanding` beside `Stock lists
 * uploaded 1 · 1 still being read`, under a spinner saying `Bringing in your
 * stock list`. Both sentences were true — `countWorkingImages` short-circuits
 * on `hasImage` and all thirteen carried one, while `countArrivingUploads`
 * reads the upload's status and the status really was `enriching` — and the
 * page contradicted itself for ever.
 *
 * `settleUploadCompletion` would have completed it on the first call. Nothing
 * called it. That half is fixed where the calls are (the settler's exits and
 * the tick's dispatch); what is pinned HERE is the decision itself, because
 * the two live and die together: a call site that cannot decide is as useless
 * as a decision nothing calls.
 *
 * THE DOUBLE APPLIES THE FILTERS RATHER THAN ANSWERING THEM.
 *
 * A double that returns canned rows passes against a mutant that changes the
 * predicate — code and test agreeing while only the server disagrees, which
 * this repository has already paid for twice (the AML `.or()` regex, the
 * invented PostgREST error codes). So the fake builder below records `eq`,
 * `neq`, `in` and `is` and evaluates them over fixture rows. Change which
 * columns the module asks about and these tests move.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETABLE_UPLOAD_STATUSES,
  SETTLED_ITEM_WORK_STAGE,
  UNFINISHED_ENRICHMENT_STATUSES,
  settleCompletedUploads,
  settleUploadCompletion,
} from '../../../supabase/functions/_shared/builderStock/uploadCompletion';

const ORG = '44444444-4444-4444-8444-444444444444';
const UPLOAD = 'c2b7faa1-040d-45ab-8f4c-813f1f9b6849';
const OTHER_UPLOAD = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'neq' | 'in' | 'is'; column: string; value: unknown };

interface Fixture {
  builder_stock_uploads: Row[];
  builder_stock_items: Row[];
  builder_stock_item_images: Row[];
}

interface Recorded { table: string; patch: Row; filters: Filter[] }

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.column] ?? null;
    if (filter.op === 'eq' || filter.op === 'is') return value === filter.value;
    if (filter.op === 'neq') return value !== filter.value;
    return (filter.value as unknown[]).includes(value);
  });
}

/**
 * Which read a database FAULT lands on.
 *
 * Per-READ rather than per-table, deliberately. Failing a whole table cannot
 * tell whether a refusal came from the read that was supposed to produce it:
 * a mutant that discards the item COUNT's error still answers `read_failed`
 * from the item read further down, and the test passes against it. It did —
 * that mutant survived the first version of this file.
 */
type FailWhen = (context: { table: string; counting: boolean }) => boolean;

/**
 * A PostgREST-shaped double over in-memory rows.
 *
 * A fault is a different thing from a table with no matching rows and must
 * produce a different outcome — that distinction is the whole of
 * `read_failed`.
 */
function makeDb(fixture: Fixture, failWhen?: FailWhen) {
  const writes: Recorded[] = [];

  const from = (table: string) => {
    const filters: Filter[] = [];
    let counting = false;
    let head = false;
    let writing: Row | null = null;
    let limit = Number.POSITIVE_INFINITY;
    let orderBy: string | null = null;

    const all = () => ((fixture as unknown as Record<string, Row[]>)[table] ?? []);
    const faulty = () => !!failWhen?.({ table, counting });

    const read = () => {
      if (faulty()) {
        return { data: null, error: { message: `${table} unavailable` }, count: null };
      }
      let rows = all().filter((row) => matches(row, filters));
      if (orderBy) {
        rows = [...rows].sort(
          (a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])));
      }
      if (counting) return { data: head ? null : rows, error: null, count: rows.length };
      return { data: rows.slice(0, limit), error: null, count: null };
    };

    const settle = () => {
      if (!writing) return read();
      if (faulty()) return { data: null, error: { message: 'write refused' } };
      writes.push({ table, patch: writing, filters: [...filters] });
      for (const row of all().filter((r) => matches(r, filters))) Object.assign(row, writing);
      return { data: null, error: null };
    };

    const builder: Record<string, unknown> = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        if (options?.count) counting = true;
        if (options?.head) head = true;
        return builder;
      },
      update(patch: Row) { writing = patch; return builder; },
      eq(column: string, value: unknown) {
        filters.push({ op: 'eq', column, value }); return builder;
      },
      neq(column: string, value: unknown) {
        filters.push({ op: 'neq', column, value }); return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push({ op: 'in', column, value }); return builder;
      },
      is(column: string, value: unknown) {
        filters.push({ op: 'is', column, value }); return builder;
      },
      order(column: string) { orderBy = column; return builder; },
      limit(n: number) { limit = n; return builder; },
      range(fromRow: number, toRow: number) {
        const page = read();
        if (page.error) return Promise.resolve(page);
        return Promise.resolve({
          ...page, data: (page.data ?? []).slice(fromRow, toRow + 1),
        });
      },
      maybeSingle() {
        const page = read();
        if (page.error) return Promise.resolve({ data: null, error: page.error });
        return Promise.resolve({ data: (page.data ?? [])[0] ?? null, error: null });
      },
      then(resolve: (value: unknown) => unknown) { return resolve(settle()); },
    };
    return builder;
  };

  return { db: { from } as unknown as Record<string, unknown>, writes };
}

/** The 19 September shape, at `count` properties. */
function finishedImport(count: number, overrides: Row = {}): Fixture {
  const items: Row[] = [];
  const images: Row[] = [];
  for (let n = 0; n < count; n += 1) {
    const id = `item-${String(n).padStart(2, '0')}`;
    items.push({
      id,
      organisation_id: ORG,
      upload_id: UPLOAD,
      lifecycle_status: 'active',
      /*
       * THE LEGACY LATCH, and the reason this fixture is not a happy path.
       * A property whose picture came out of the builder's own document never
       * runs the fallback ladder, so nothing ever writes this column and it
       * keeps the `pending` its import gave it. 83 of 91 live properties read
       * this way on 7 September 2026.
       */
      enrichment_status: 'pending',
      image_work_stage: SETTLED_ITEM_WORK_STAGE,
    });
    images.push({
      id: `image-${n}`, stock_item_id: id,
      source_stage: 'uploaded_document', processing_status: 'ready',
    });
  }
  return {
    builder_stock_uploads: [{
      id: UPLOAD,
      organisation_id: ORG,
      status: 'enriching',
      records_failed: 0,
      deleted_at: null,
      image_stage_summary: null,
      created_at: '2026-09-19T10:38:59.080712Z',
      ...overrides,
    }],
    builder_stock_items: items,
    builder_stock_item_images: images,
  };
}

describe('an upload whose properties are finished is recorded as complete', () => {
  it('moves the 19 September upload from enriching to complete', async () => {
    const fixture = finishedImport(13);
    const { db, writes } = makeDb(fixture);

    const outcome = await settleUploadCompletion(db, {
      uploadId: UPLOAD, organisationId: ORG,
    });

    expect(outcome).toEqual({ status: 'complete' });
    expect(fixture.builder_stock_uploads[0].status).toBe('complete');
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('builder_stock_uploads');
    expect(writes[0].patch.status).toBe('complete');
  });

  it('records the images it found, as a stage summary the builder reads', async () => {
    const { db } = makeDb(finishedImport(13));
    await settleUploadCompletion(db, { uploadId: UPLOAD, organisationId: ORG });
    const { db: db2, writes } = makeDb(finishedImport(13));
    await settleUploadCompletion(db2, { uploadId: UPLOAD, organisationId: ORG });
    expect(writes[0].patch.image_stage_summary)
      .toEqual({ uploaded_document: { ready: 13 } });
  });

  it('keeps another tenant\'s key in the summary document', async () => {
    const fixture = finishedImport(13, {
      image_stage_summary: { notion_row_assets_version: 23, street_view: { ready: 1 } },
    });
    const { db, writes } = makeDb(fixture);
    await settleUploadCompletion(db, { uploadId: UPLOAD, organisationId: ORG });
    expect(writes[0].patch.image_stage_summary).toEqual({
      notion_row_assets_version: 23,
      uploaded_document: { ready: 13 },
    });
  });

  it('settles it headlessly through the pass the settler runs', async () => {
    const fixture = finishedImport(13);
    const { db, writes } = makeDb(fixture);

    const pass = await settleCompletedUploads(db);

    expect(pass).toEqual({ inspected: 1, settled: 1 });
    expect(fixture.builder_stock_uploads[0].status).toBe('complete');
    expect(writes.filter((w) => w.patch.status === 'complete')).toHaveLength(1);
  });

  it('a partial import settles as partially_complete, not complete', async () => {
    const fixture = finishedImport(13, { records_failed: 2 });
    const { db } = makeDb(fixture);
    await settleCompletedUploads(db);
    expect(fixture.builder_stock_uploads[0].status).toBe('partially_complete');
  });
});

describe('what it refuses, and why each refusal is its own answer', () => {
  it('leaves an upload alone while one property is genuinely mid-ladder', async () => {
    const fixture = finishedImport(13);
    // Not settled AND not finished with enrichment: outstanding under both
    // columns, which is the only shape that still means "wait".
    fixture.builder_stock_items[4].image_work_stage = 'source';

    const { db, writes } = makeDb(fixture);
    const outcome = await settleUploadCompletion(db, {
      uploadId: UPLOAD, organisationId: ORG,
    });

    expect(outcome).toEqual({ status: null, refusal: 'items_outstanding' });
    expect(fixture.builder_stock_uploads[0].status).toBe('enriching');
    expect(writes).toHaveLength(0);
  });

  it('a settled property is finished whatever the legacy latch says', () => {
    // The rule the first test rests on, stated where a reader can see it: the
    // two columns are ANDed, so `pending` alone never holds an upload open.
    expect(UNFINISHED_ENRICHMENT_STATUSES).toContain('pending');
    expect(SETTLED_ITEM_WORK_STAGE).toBe('settled');
  });

  /*
   * A FAILED READ IS NOT A COUNT OF ZERO, at each read in turn.
   *
   * `aml.cases` paid for this rule: eighteen call sites named a column that
   * did not exist, the error was discarded, and twelve handlers reported
   * "Case not found" about a case the operator had open. Here the same
   * discard would report an import finished that nobody has checked.
   */
  it.each([
    ['the outstanding-item count',
      ({ table, counting }: { table: string; counting: boolean }) =>
        table === 'builder_stock_items' && counting],
    ['the property list the summary is built from',
      ({ table, counting }: { table: string; counting: boolean }) =>
        table === 'builder_stock_items' && !counting],
    ['the image rows behind the summary',
      ({ table }: { table: string }) => table === 'builder_stock_item_images'],
    ['the upload row itself',
      ({ table }: { table: string }) => table === 'builder_stock_uploads'],
  ])('never completes an upload when %s faults', async (_label, failWhen) => {
    const fixture = finishedImport(13);
    const { db, writes } = makeDb(fixture, failWhen as FailWhen);

    const outcome = await settleUploadCompletion(db, {
      uploadId: UPLOAD, organisationId: ORG,
    });

    expect(outcome).toEqual({ status: null, refusal: 'read_failed' });
    expect(fixture.builder_stock_uploads[0].status).toBe('enriching');
    expect(writes).toHaveLength(0);
  });

  it('refuses a deleted upload, and the pass never even inspects one', async () => {
    const fixture = finishedImport(13, { deleted_at: '2026-09-19T11:00:00Z' });
    const { db, writes } = makeDb(fixture);

    expect(await settleUploadCompletion(db, { uploadId: UPLOAD, organisationId: ORG }))
      .toEqual({ status: null, refusal: 'not_completable' });
    expect(await settleCompletedUploads(db)).toEqual({ inspected: 0, settled: 0 });
    expect(writes).toHaveLength(0);
  });

  it('refuses an upload that is already finished, so the pass cannot churn', async () => {
    const fixture = finishedImport(13, { status: 'complete' });
    const { db, writes } = makeDb(fixture);

    expect(await settleUploadCompletion(db, { uploadId: UPLOAD, organisationId: ORG }))
      .toEqual({ status: null, refusal: 'not_completable' });
    expect(await settleCompletedUploads(db)).toEqual({ inspected: 0, settled: 0 });
    expect(writes).toHaveLength(0);
    expect(COMPLETABLE_UPLOAD_STATUSES).not.toContain('complete');
  });

  it('refuses an upload nobody can find', async () => {
    const { db } = makeDb(finishedImport(13));
    expect(await settleUploadCompletion(db, { uploadId: OTHER_UPLOAD }))
      .toEqual({ status: null, refusal: 'not_found' });
    expect(await settleUploadCompletion(db, { uploadId: '' }))
      .toEqual({ status: null, refusal: 'not_found' });
  });

  it('counts only THIS upload\'s properties', async () => {
    const fixture = finishedImport(13);
    // Somebody else's import, still working. It must not hold this one open.
    fixture.builder_stock_items.push({
      id: 'foreign', organisation_id: ORG, upload_id: OTHER_UPLOAD,
      lifecycle_status: 'active', enrichment_status: 'pending',
      image_work_stage: 'source',
    });

    const { db } = makeDb(fixture);
    expect(await settleUploadCompletion(db, { uploadId: UPLOAD, organisationId: ORG }))
      .toEqual({ status: 'complete' });
  });
});
