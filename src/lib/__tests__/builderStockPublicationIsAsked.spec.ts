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

/*
 * WHERE IT ASKS MOVED ON 1 OCTOBER 2026. The ask used to sit inside
 * `runImport`, before the final status was written — mid-read, while the
 * upload was still `imported`. Publication now refuses an import that has not
 * finished (`import_not_finished`), because asked there a replacement archived
 * every live property the read had not reached yet. So the ask follows every
 * write of the final status, and the settler's sweep asks every tick besides.
 */
const sweep = read('supabase/functions/_shared/builderStock/publicationSweep.ts');
const finishers = [
  'supabase/functions/builder-portal-stock/index.ts',
  'supabase/functions/_shared/builderStock/continueImport.ts',
  'supabase/functions/_shared/builderStock/settleReaderVersion.ts',
].map((path) => [path, read(path)] as const);

describe('every import asks whether its upload can be published', () => {
  it('asks at the end of a successful import — after every write of its final status', () => {
    for (const [path, src] of finishers) {
      const writeAt = src.search(/importOutcomeColumns\(|status: result\.uploadStatus/);
      const askAt = src.indexOf('askToPublishFinishedImport(');
      expect(writeAt, path).toBeGreaterThan(-1);
      expect(askAt, path).toBeGreaterThan(writeAt);
    }
  });

  it('never asks mid-read, before the outcome is written', () => {
    expect(runImport).not.toMatch(/rpc\('publish_builder_stock_upload'/);
  });

  it('can never fail the import', () => {
    const block = sweep.slice(sweep.indexOf('export async function askToPublishFinishedImport'));
    expect(block.slice(0, 400)).toMatch(/\}\s*catch\s*\(error\)\s*\{/);
  });

  it('a finished list with nothing left to settle is still asked, every tick', () => {
    expect(settler).toContain('healAndPublishSettledUploads(supabase)');
  });

  it('leaves the settler asking too — two askers, not a replacement', () => {
    // The settler's ask is what publishes a first upload as its photographs
    // settle, and removing it would trade one stranding for another.
    expect(settler).toContain('publishUploadIfReady(supabase, waitingUpload)');
  });
});
