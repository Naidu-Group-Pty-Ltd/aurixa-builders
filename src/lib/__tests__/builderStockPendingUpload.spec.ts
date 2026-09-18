/**
 * WHICH UPLOAD'S SOURCE THE IMAGE WORK INSPECTS — pinned.
 *
 * `itemWorkClaim.ts` states the contract in its own header: a MATCHED row's
 * `upload_id` is still the OLD one, because re-pointing it is step 1 of the
 * atomic cutover itself, so until publication the id of the upload actually
 * waiting on this property lives in `pending_upload_id` and nowhere else.
 * "Asking to publish `upload_id` on such a row asks about the dataset already
 * on screen."
 *
 * The source stage asked `item.upload_id` anyway, while the telemetry beside
 * it already read `pending_upload_id ?? upload_id`. On a first import the two
 * agree — `pending_upload_id` is null — which is why the 18 September incident
 * did not expose it: all 47 rows had a null. On a REPLACEMENT they disagree,
 * and the disagreement is not cosmetic: the stage would re-read the OLD
 * builder source, derive the OLD row's branches, and settle the replacement's
 * imagery against a document the builder has already superseded.
 *
 * These pin the one rule that resolves it, and they pin the boundary it must
 * not cross: which upload is SERVED to the marketplace is untouched, and the
 * cutover stays atomic.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  settleClaimedItem,
} from '../../../supabase/functions/_shared/builderStock/settleItemImages';
import {
  sourceWorkUploadId,
} from '../../../supabase/functions/_shared/builderStock/stockLifecycle.pure';

const SHARED = 'supabase/functions/_shared/builderStock';
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const OLD_UPLOAD = '11111111-1111-4111-8111-111111111111';
const NEW_UPLOAD = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';

/**
 * A PostgREST-shaped double that answers everything with nothing.
 *
 * The stage under test is decided before any of these reads matter — what is
 * being asserted is the ARGUMENT the source repair is called with — so the
 * double's job is only to let the function reach that call.
 */
function db() {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of [
    'select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'update',
    'insert', 'upsert', 'delete', 'neq', 'gte', 'lte', 'filter', 'contains',
  ]) builder[method] = chain;
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.single = async () => ({ data: null, error: null });
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return {
    from: () => builder,
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'none' } }) }) },
  };
}

const claimed = (overrides: Record<string, unknown> = {}) => ({
  id: ITEM,
  organisation_id: ORG,
  upload_id: OLD_UPLOAD,
  pending_upload_id: null,
  image_work_stage: 'source',
  image_work_attempts: 0,
  lifecycle_status: 'active',
  ...overrides,
} as never);

/** Run the source stage and report the upload the repair was handed. */
async function uploadPassedToRepair(item: ReturnType<typeof claimed>) {
  const repairSource = vi.fn(async () => ({
    imagesStored: 0, matched: 0, demoted: 0, primaryUpdated: 0,
    rowsRead: 0, rowsWithImagery: 0, packageAlreadyAnswered: 0,
    packageUnreachable: 0, problems: [], incomplete: false,
  }));
  await settleClaimedItem(db(), item, {}, {
    repairSource: repairSource as never,
    settleEligibility: (async () => ({})) as never,
    settleSanitization: (async () => ({})) as never,
    choosePrimary: (async () => null) as never,
  });
  expect(repairSource).toHaveBeenCalledTimes(1);
  return (repairSource.mock.calls[0] as unknown as [unknown, { uploadId: string }])[1].uploadId;
}

describe('the rule itself', () => {
  it('is the pending upload where one is waiting, and the serving one otherwise', () => {
    expect(sourceWorkUploadId({ upload_id: OLD_UPLOAD, pending_upload_id: NEW_UPLOAD }))
      .toBe(NEW_UPLOAD);
    expect(sourceWorkUploadId({ upload_id: OLD_UPLOAD, pending_upload_id: null }))
      .toBe(OLD_UPLOAD);
    expect(sourceWorkUploadId({ upload_id: NEW_UPLOAD, pending_upload_id: null }))
      .toBe(NEW_UPLOAD);
  });

  it('is null only where the property has no upload at all', () => {
    expect(sourceWorkUploadId({ upload_id: null, pending_upload_id: null })).toBeNull();
    // A pending upload with no serving one is a first import mid-flight.
    expect(sourceWorkUploadId({ upload_id: null, pending_upload_id: NEW_UPLOAD }))
      .toBe(NEW_UPLOAD);
  });
});

describe('the source stage inspects the upload that is waiting', () => {
  it('FIRST IMPORT — current upload, no pending → the current upload is processed', async () => {
    expect(await uploadPassedToRepair(claimed({
      upload_id: OLD_UPLOAD, pending_upload_id: null,
    }))).toBe(OLD_UPLOAD);
  });

  /*
   * THE CASE THAT FAILED BEFORE THE FIX. `upload_id` still names the dataset
   * on screen; the replacement waiting on this property is `pending_upload_id`.
   * Reading the old one re-derives the OLD row's branches and settles the
   * replacement's imagery against a superseded document.
   */
  it('REPLACEMENT — old serving, new pending → the NEW upload is processed', async () => {
    expect(await uploadPassedToRepair(claimed({
      upload_id: OLD_UPLOAD, pending_upload_id: NEW_UPLOAD,
    }))).toBe(NEW_UPLOAD);
  });

  it('AFTER CUTOVER — new serving, no pending → the new upload is processed', async () => {
    expect(await uploadPassedToRepair(claimed({
      upload_id: NEW_UPLOAD, pending_upload_id: null,
    }))).toBe(NEW_UPLOAD);
  });

  it('never reads the old source while a replacement is waiting', async () => {
    const used = await uploadPassedToRepair(claimed({
      upload_id: OLD_UPLOAD, pending_upload_id: NEW_UPLOAD,
    }));
    expect(used).not.toBe(OLD_UPLOAD);
  });

  it('a property with no upload at all still moves on rather than being retried', async () => {
    const repairSource = vi.fn();
    const settlement = await settleClaimedItem(
      db(), claimed({ upload_id: null, pending_upload_id: null }), {},
      { repairSource: repairSource as never, choosePrimary: (async () => null) as never },
    );
    expect(repairSource).not.toHaveBeenCalled();
    expect(settlement.result).toBe('no source document');
  });
});

describe('what this must not change', () => {
  const settle = read(`${SHARED}/settleItemImages.ts`);
  const claim = read(`${SHARED}/itemWorkClaim.ts`);

  it('the source stage and its telemetry agree on one value', () => {
    expect(settle).toContain('sourceWorkUploadId');
    // The telemetry used to spell the rule inline; two spellings is how the
    // two came to disagree in the first place.
    expect(settle).not.toContain('item.pending_upload_id ?? item.upload_id');
  });

  it('which upload is SERVED is untouched — publication still asks by its own id', () => {
    expect(claim).toContain('publish_builder_stock_upload');
    expect(claim).toContain('p_upload_id: uploadId');
    // Nothing in the claim module decides the served set from the pending id.
    expect(claim).not.toContain('sourceWorkUploadId');
  });

  it('publication readiness is still evaluated inside the statement that flips the rows', () => {
    const fn = claim.slice(claim.indexOf('export async function publishUploadIfReady'));
    expect(fn).toContain("db.rpc('publish_builder_stock_upload'");
    // One RPC: the check and the act cannot be separated by a caller.
    expect(fn.slice(0, 600)).not.toContain('.from(');
  });

  it('the lifecycle rule lives in the lifecycle module, named once', () => {
    const lifecycle = read(`${SHARED}/stockLifecycle.pure.ts`);
    expect(lifecycle).toContain('export function sourceWorkUploadId');
  });
});
