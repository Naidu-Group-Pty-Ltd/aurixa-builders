/**
 * A FUNCTION NOBODY CALLS CANNOT APPLY ANYTHING.
 *
 * `publish_builder_stock_upload` is what applies a held-back patch, and it
 * had exactly ONE caller: the image settler, after an item's work completes,
 * under its own comment — "there is nothing else watching". That is true, and
 * it is the whole defect.
 *
 * MEASURED 21 SEPTEMBER 2026. `LOT 266 Crowlea Estate` was re-read at 10:49
 * with the right answer — the import log records
 * `development_name:leading_field_name` and `land_size_sqm:below` — and the
 * settler's next three ticks reported `claimed: 0, claimable: 0,
 * outstanding: 0`, because the photographs were already settled and a
 * re-read of the same file produced no image work. Nobody asked, so nothing
 * applied. Fixing the publication function to apply a patch on a second
 * publication was necessary and was not sufficient.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const runImport = read('supabase/functions/_shared/builderStock/runImport.ts');
const settler = read('supabase/functions/builder-stock-image-settler/index.ts');

describe('every import asks whether its upload can be published', () => {
  it('asks at the end of a successful import', () => {
    expect(runImport).toMatch(
      /rpc\('publish_builder_stock_upload', \{\s*\n?\s*p_upload_id: input\.upload\.id,/);
  });

  it('asks AFTER the outcome is written, never instead of it', () => {
    // The import's own result is the thing that must not be at risk. The ask
    // sits below the image-work kick and above the return, on the same
    // best-effort footing.
    const kickAt = runImport.indexOf('builder_stock_kick_image_work');
    const askAt = runImport.indexOf("rpc('publish_builder_stock_upload'");
    const returnAt = runImport.indexOf('  return {\n    ok: true,');
    expect(kickAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(kickAt);
    expect(askAt).toBeLessThan(returnAt);
  });

  it('can never fail the import', () => {
    // A publication that cannot be asked for costs latency, never work: the
    // settler asks after every completed item and the cron tick reaches the
    // same queue.
    const block = runImport.slice(runImport.indexOf("rpc('publish_builder_stock_upload'"));
    expect(block.slice(0, 260)).toMatch(/\}\s*catch\s*\{/);
  });

  it('leaves the settler asking too — two askers, not a replacement', () => {
    // The settler's ask is what publishes a first upload as its photographs
    // settle, and removing it would trade one stranding for another.
    expect(settler).toContain('publishUploadIfReady(supabase, waitingUpload)');
  });
});
