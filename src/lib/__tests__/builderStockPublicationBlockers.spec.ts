/**
 * EVERY GATE THAT CAN HOLD A STOCK LIST OFF THE MARKETPLACE HAS A NAME.
 *
 * 30 Sep 2026: 41 settled properties with ready photographs were held by a
 * list-level gate the page never named, and nothing ever asked publication
 * again. The readiness function is the authority; these specs pin that every
 * term of its `ready` conjunction maps to a blocker a builder can read, that
 * the settler re-asks finished lists every tick, and that a manifest OUR write
 * failed to record is `pending` (retryable) rather than `failed` (terminal).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describePublicationBlocker, publicationBlockers, READINESS_GATES,
  type PublicationBlocker, type PublicationReading,
} from '../../../supabase/functions/_shared/builderStock/publicationBlockers.pure';

const ROOT = join(__dirname, '../../..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function latestDefinition(name: string): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const re = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`);
  const hit = files.filter((f) => re.test(readFileSync(join(MIGRATIONS, f), 'utf8'))).pop();
  if (!hit) throw new Error(`no definition of ${name}`);
  return readFileSync(join(MIGRATIONS, hit), 'utf8');
}

function readyTerms(sql: string): string[] {
  const body = sql.slice(sql.search(/FUNCTION public\.builder_stock_publication_readiness\(/));
  const m = body.match(/c\.failed_items,\s*([\s\S]*?)\s+AS ready,/);
  if (!m) throw new Error('could not find the ready expression');
  return m[1].split(/\s+AND\s+/).map((t) => t.replace(/\s+/g, ' ').trim());
}

const base: PublicationReading = {
  total: 41, photosReady: 41, failed: 0, working: 0,
  manifestState: 'complete', pendingAssets: 0, published: false,
};

describe('the readiness rule and the page name the same gates', () => {
  it('every term of the latest ready expression has a blocker', () => {
    const terms = readyTerms(latestDefinition('builder_stock_publication_readiness'));
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) expect(READINESS_GATES[term], term).toBeDefined();
    expect(Object.keys(READINESS_GATES).sort()).toEqual([...terms].sort());
  });

  it('a gate that fires names itself, and only itself', () => {
    const cases: Array<[Partial<PublicationReading>, PublicationBlocker]> = [
      [{ total: 0, photosReady: 0 }, 'no_properties'],
      [{ working: 3, photosReady: 38 }, 'photos_in_progress'],
      [{ failed: 2, photosReady: 39 }, 'properties_failed'],
      [{ photosReady: 40 }, 'photos_missing'],
      [{ pendingAssets: 4 }, 'source_files_pending'],
      [{ manifestState: 'failed' }, 'source_listing_failed'],
    ];
    for (const [patch, expected] of cases) {
      expect(publicationBlockers({ ...base, ...patch })).toEqual([expected]);
    }
  });

  it('a ready or live list has no blockers', () => {
    expect(publicationBlockers(base)).toEqual([]);
    expect(publicationBlockers({ ...base, published: true, total: 0 })).toEqual([]);
  });

  it('every blocker has a sentence, and ours never blames the builder', () => {
    const all = new Set(Object.values(READINESS_GATES));
    for (const blocker of all) {
      expect(describePublicationBlocker(blocker, base).length).toBeGreaterThan(10);
    }
    const ours = describePublicationBlocker('source_listing_failed', base);
    expect(ours).toMatch(/on our side/);
    expect(ours).not.toMatch(/photo from you/);
  });
});

describe('a finished list is asked to publish again', () => {
  it('the settler sweeps finished lists every tick', () => {
    const settler = read('supabase/functions/builder-stock-image-settler/index.ts');
    expect(settler).toMatch(/healAndPublishSettledUploads\(supabase\)/);
  });

  it('the sweep asks the one publish function and re-records a pending manifest', () => {
    const sweep = read('supabase/functions/_shared/builderStock/publicationSweep.ts');
    expect(sweep).toMatch(/builder_stock_uploads_awaiting_publication/);
    expect(sweep).toMatch(/publishUploadIfReady\(/);
    expect(sweep).toMatch(/manifest_state === 'pending'/);
    // A failed manifest is the SOURCE's truncation; the sweep never clears it.
    expect(sweep).not.toMatch(/source_manifest_state', 'failed'/);
  });

  it('a manifest our write failed to record is pending, never failed', () => {
    const importer = read('supabase/functions/_shared/builderStock/importStock.ts');
    expect(importer).toMatch(/truncated \? 'failed' : manifest\.error \? 'pending' : 'complete'/);
  });

  it('the candidate function exists and offers only finished lists', () => {
    const sql = latestDefinition('builder_stock_uploads_awaiting_publication');
    expect(sql).toMatch(/image_work_stage NOT IN \('settled', 'failed'\)/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.builder_stock_uploads_awaiting_publication\(integer\) TO service_role/);
  });

  it('image progress publishes pending source files', () => {
    expect(latestDefinition('builder_stock_image_progress')).toMatch(/AS pending_assets/);
  });
});

describe('a list still being read cannot replace a live one', () => {
  const publish = () => {
    const sql = latestDefinition('publish_builder_stock_upload');
    return sql.slice(sql.search(/FUNCTION public\.publish_builder_stock_upload\(/));
  };

  it('publication refuses until the import has finished, before anything moves', () => {
    const body = publish();
    const gate = body.indexOf("NOT IN ('enriching', 'complete', 'partially_complete')");
    expect(gate).toBeGreaterThan(0);
    expect(body).toMatch(/'import_not_finished'/);
    for (const step of ['apply_builder_stock_pending_patch', "SET lifecycle_status = 'active'",
      "SET lifecycle_status = 'archived'"]) {
      expect(body.indexOf(step), step).toBeGreaterThan(gate);
    }
  });

  it('a partially imported list archives nothing', () => {
    expect(publish()).toMatch(/array_length\(v_replaces, 1\) IS NOT NULL AND v_status <> 'partially_complete'/);
  });

  it('the sweep offers finished imports only', () => {
    expect(latestDefinition('builder_stock_uploads_awaiting_publication'))
      .toMatch(/u\.status IN \('enriching', 'complete', 'partially_complete'\)/);
  });

  it('every writer of the final status asks to publish after it, and nothing asks mid-read', () => {
    for (const file of [
      'supabase/functions/builder-portal-stock/index.ts',
      'supabase/functions/_shared/builderStock/continueImport.ts',
      'supabase/functions/_shared/builderStock/settleReaderVersion.ts',
    ]) {
      const src = read(file);
      const write = src.search(/importOutcomeColumns\(|status: result\.uploadStatus/);
      const ask = src.indexOf('askToPublishFinishedImport(');
      expect(write, file).toBeGreaterThan(0);
      expect(ask, file).toBeGreaterThan(write);
    }
    expect(read('supabase/functions/_shared/builderStock/runImport.ts'))
      .not.toMatch(/rpc\('publish_builder_stock_upload'/);
  });
});
