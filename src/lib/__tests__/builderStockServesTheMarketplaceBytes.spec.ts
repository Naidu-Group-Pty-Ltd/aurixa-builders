import { describe, expect, it } from 'vitest';
import {
  marketplaceDerivativeOf, serveStockImage,
} from '../../../supabase/functions/_shared/builderStock/serveStockImage';
import { DERIVATIVE_KEY } from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';

/**
 * MEASURED 30 SEPTEMBER 2026. Lot 208 Donnybrook (item 90e94f72, image
 * ceec8177) is served to every Command Centre as its REPAIRED derivative —
 * the network's image door serves a derivative wherever the original carries
 * a laid-over graphic — while the builder's own card signed the original,
 * overlay and all, under alt text calling it "the picture shown on the
 * marketplace". The owner: the Command Centre must show the same view.
 */
const ORIGINAL_SHA = 'a'.repeat(64);

const derivative = {
  transformation: 'deterministic_overlay_reconstruction',
  sanitization_version: 2,
  original_image_id: 'ceec8177',
  original_sha256: ORIGINAL_SHA,
  stock_item_id: '90e94f72',
  organisation_id: 'org-1',
  source_reference: null,
  storage_bucket: 'builder-stock-images',
  storage_path: 'org-1/sanitized/v2/ceec8177.png',
  derivative_sha256: 'b'.repeat(64),
  width: 1200,
  height: 600,
  repaired_share: 0.076,
  regions_removed: 1,
  model: null,
  generated_at: '2026-09-29T09:00:00Z',
  verdict: 'eligible',
};

function fakeDb(row: Record<string, unknown> | null) {
  const signedPaths: Array<{ bucket: string; path: string }> = [];
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return {
    signedPaths,
    db: {
      from: () => query,
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: async (path: string) => {
            signedPaths.push({ bucket, path });
            return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
          },
        }),
      },
    },
  };
}

const imageRow = (sourceDetail: Record<string, unknown>) => ({
  id: 'ceec8177', storage_bucket: 'builder-stock-images',
  storage_path: 'org-1/original/ceec8177.png', external_url: null,
  organisation_id: 'org-1', source_detail: sourceDetail,
});

describe('the builder’s card signs the bytes the marketplace shows', () => {
  it('serves the repaired copy where the marketplace serves it', async () => {
    const { db, signedPaths } = fakeDb(imageRow({
      stored_sha256: ORIGINAL_SHA, [DERIVATIVE_KEY]: derivative,
    }));
    const served = await serveStockImage(db, { imageId: 'ceec8177', organisationId: 'org-1' });
    expect(served.ok).toBe(true);
    expect(signedPaths).toEqual([{ bucket: 'builder-stock-images', path: 'org-1/sanitized/v2/ceec8177.png' }]);
  });

  it('serves the original where the marketplace serves the original', async () => {
    // Measured clean: the door serves the builder's own bytes, and so does this.
    const eligible = {
      stored_sha256: ORIGINAL_SHA, marketplace_eligibility_state: 'eligible', [DERIVATIVE_KEY]: derivative,
    };
    expect(marketplaceDerivativeOf(eligible)).toBeNull();
    const { db, signedPaths } = fakeDb(imageRow(eligible));
    await serveStockImage(db, { imageId: 'ceec8177', organisationId: 'org-1' });
    expect(signedPaths).toEqual([{ bucket: 'builder-stock-images', path: 'org-1/original/ceec8177.png' }]);
  });

  it('serves the original where no provable derivative exists', async () => {
    for (const detail of [
      {},
      { stored_sha256: ORIGINAL_SHA },
      // A derivative of different bytes is not this picture's.
      { stored_sha256: 'c'.repeat(64), [DERIVATIVE_KEY]: derivative },
      // A derivative the repair itself did not pass.
      { stored_sha256: ORIGINAL_SHA, [DERIVATIVE_KEY]: { ...derivative, verdict: 'refused' } },
    ]) {
      const { db, signedPaths } = fakeDb(imageRow(detail));
      await serveStockImage(db, { imageId: 'ceec8177', organisationId: 'org-1' });
      expect(signedPaths).toEqual([{ bucket: 'builder-stock-images', path: 'org-1/original/ceec8177.png' }]);
    }
  });

  it('never reaches another organisation’s image', async () => {
    const { db, signedPaths } = fakeDb(null);
    expect(await serveStockImage(db, { imageId: 'ceec8177', organisationId: 'org-2' }))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(signedPaths).toEqual([]);
  });
});
