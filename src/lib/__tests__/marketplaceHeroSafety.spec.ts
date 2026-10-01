/**
 * THE MARKETPLACE HERO STANDARD IS PRESENTATION — and this file is what holds
 * it to that.
 *
 * The sweep runs against a fake database that records every call, and the
 * assertions are about what it may NEVER do: write any table but through the
 * one guarded call, touch an item, a status, a role, eligibility or the
 * primary pointer, or turn a failure into anything but a retry record. Every
 * picture is synthetic and encoded here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import {
  HERO_MAX_ATTEMPTS, HERO_RETRY_AFTER_MS, heroStanding, settleMarketplaceHero,
} from '../../../supabase/functions/_shared/builderStock/settleMarketplaceHero';
import { planHeroFromBytes } from '../../../supabase/functions/_shared/builderStock/heroPlanning';
import {
  HERO_ATTEMPT_KEY, HERO_PLAN_KEY, HERO_PLAN_VERSION, validateHeroPlan,
} from '../../../supabase/functions/_shared/builderStock/marketplaceHero.pure';
import { readHeroWorkContext } from '../../../supabase/functions/_shared/builderStock/heavyWorkWire.pure';
import { drawScene } from './fixtures/heroScenes';

const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');
const SHARED = 'supabase/functions/_shared/builderStock';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function scenePng() {
  const scene = drawScene({ width: 320, height: 400, horizon: 330, scale: 1,
    houses: [{ x: 70, w: 180, roofTop: 250, base: 340, garage: true }] });
  const png = await encodePng(scene.thumbnail.pixels, { width: 320, height: 400, components: 3 });
  return png!;
}

/** A database that answers reads and records every write. */
function fakeDb(rows: { items: any[]; images: any[]; objects: Record<string, Uint8Array | 'fail'> }) {
  const writes: Array<{ kind: string; detail: unknown }> = [];
  const rpcCalls: any[] = [];
  const query = (table: string) => {
    const filters: Array<(row: any) => boolean> = [];
    const chain: any = {
      select: () => chain,
      order: () => chain,
      range: () => chain,
      neq: (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return chain; },
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return chain; },
      in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return chain; },
      update: (detail: unknown) => { writes.push({ kind: `update:${table}`, detail }); return chain; },
      insert: (detail: unknown) => { writes.push({ kind: `insert:${table}`, detail }); return chain; },
      upsert: (detail: unknown) => { writes.push({ kind: `upsert:${table}`, detail }); return chain; },
      delete: () => { writes.push({ kind: `delete:${table}`, detail: null }); return chain; },
      then: (resolveFn: (v: unknown) => unknown) => {
        const source = table === 'builder_stock_items' ? rows.items : rows.images;
        return Promise.resolve({ data: source.filter((r) => filters.every((f) => f(r))), error: null }).then(resolveFn);
      },
    };
    return chain;
  };
  return {
    writes, rpcCalls,
    db: {
      from: query,
      rpc: async (name: string, args: any) => {
        rpcCalls.push({ name, args });
        return { data: true, error: null };
      },
      storage: {
        from: () => ({
          download: async (path: string) => {
            const object = rows.objects[path];
            if (!object || object === 'fail') return { data: null, error: { message: 'unreadable' } };
            return { data: new Blob([object]), error: null };
          },
        }),
      },
    },
  };
}

const ORG = 'org-1';
function imageRow(id: string, path: string, digest: string, extra: Record<string, unknown> = {}) {
  return {
    id, organisation_id: ORG, stock_item_id: `item-${id}`, position: 0,
    source_stage: 'uploaded_document', verification_status: 'source_supplied', processing_status: 'ready',
    storage_bucket: 'builder-stock-images', storage_path: path, external_url: null,
    source_detail: {
      role: 'primary_property', role_evidence_level: 1, provenance_version: 30, stored_sha256: digest,
      marketplace_display_eligible: true, marketplace_eligibility_state: 'eligible', ...extra,
    },
  };
}
const itemRow = (id: string) => ({ id: `item-${id}`, organisation_id: ORG, lifecycle_status: 'active', primary_image_id: id });

beforeEach(() => {
  vi.stubEnv('BUILDER_STOCK_PDF_WORKER_URL', '');
  vi.stubEnv('BUILDER_STOCK_PDF_WORKER_TOKEN', '');
});

describe('the sweep plans through one guarded call and touches nothing else', () => {
  it('a readable picture is planned, and the ONLY write is the guarded presentation call', async () => {
    const png = await scenePng();
    const { db, writes, rpcCalls } = fakeDb({
      items: [itemRow('a')], images: [imageRow('a', 'o/a.png', sha(png))], objects: { 'o/a.png': png },
    });
    const outcome = await settleMarketplaceHero(db);
    expect(outcome.planned).toBe(1);
    expect(writes).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('builder_stock_record_hero_presentation');
    expect(rpcCalls[0].args.p_attempt).toBeNull();
    expect(rpcCalls[0].args.p_expected_original).toBe(sha(png));
    expect(rpcCalls[0].args.p_plan.object).toBe('original');
    expect(rpcCalls[0].args.p_plan.sha256).toBe(sha(png));
    expect(validateHeroPlan(rpcCalls[0].args.p_plan.plan)).toBe(true);
  });

  it.each([
    ['storage cannot be read', 'fail', true],
    ['the bytes are not the bytes the row names', 'mismatch', false],
    ['the picture cannot be decoded', 'garbage', false],
  ])('%s: an attempt is recorded and NOTHING else happens', async (_name, kind, operational) => {
    const png = await scenePng();
    const garbage = new TextEncoder().encode('not a picture at all');
    const object = kind === 'fail' ? 'fail' : kind === 'garbage' ? garbage : png;
    const digest = kind === 'garbage' ? sha(garbage) : sha(kind === 'mismatch' ? garbage : png);
    const { db, writes, rpcCalls } = fakeDb({
      items: [itemRow('a')], images: [imageRow('a', 'o/a.png', digest)], objects: { 'o/a.png': object as never },
    });
    const outcome = await settleMarketplaceHero(db);
    expect(outcome.planned).toBe(0);
    expect(outcome.failed).toBe(1);
    expect(outcome.operationalFailures).toBe(operational ? 1 : 0);
    expect(writes).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_plan).toBeNull();
    expect(rpcCalls[0].args.p_attempt).toMatchObject({ version: HERO_PLAN_VERSION, count: 1, operational });
  });

  it('a failure waits, then retries, then stops for the same bytes — and never blanks a card', () => {
    const digest = 'a'.repeat(64);
    const at = (minutesAgo: number, count: number) => imageRow('a', 'o/a.png', digest, {
      [HERO_ATTEMPT_KEY]: { version: HERO_PLAN_VERSION, object: 'original', sha256: digest,
        at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), count, reason: 'x', operational: true },
    });
    expect(heroStanding(at(1, 1) as never, Date.now())).toBe('cooling_down');
    expect(heroStanding(at(HERO_RETRY_AFTER_MS / 60_000 + 1, 1) as never, Date.now())).toBe('owed');
    expect(heroStanding(at(999, HERO_MAX_ATTEMPTS) as never, Date.now())).toBe('exhausted');
    // New bytes are a new question: the old attempts do not count against them.
    const replaced = at(1, HERO_MAX_ATTEMPTS);
    (replaced.source_detail as any).stored_sha256 = 'b'.repeat(64);
    expect(heroStanding(replaced as never, Date.now())).toBe('owed');
  });

  it('a stale plan (older version, or other bytes) is owed again, never drawn', async () => {
    const png = await scenePng();
    const fresh = await planHeroFromBytes(png);
    if (!fresh.ok) throw new Error('no plan');
    const stale = imageRow('a', 'o/a.png', sha(png), {
      [HERO_PLAN_KEY]: { plan: { ...fresh.plan, version: HERO_PLAN_VERSION - 1 }, object: 'original', sha256: sha(png), planned_at: 'x' },
    });
    expect(heroStanding(stale as never, Date.now())).toBe('owed');
    const otherBytes = imageRow('a', 'o/a.png', 'c'.repeat(64), {
      [HERO_PLAN_KEY]: { plan: fresh.plan, object: 'original', sha256: sha(png), planned_at: 'x' },
    });
    expect(heroStanding(otherBytes as never, Date.now())).toBe('owed');
    const current = imageRow('a', 'o/a.png', sha(png), {
      [HERO_PLAN_KEY]: { plan: fresh.plan, object: 'original', sha256: sha(png), planned_at: 'x' },
    });
    expect(heroStanding(current as never, Date.now())).toBe('planned');
  });

  it('archived stock is not planned unless asked', async () => {
    const png = await scenePng();
    const { db, rpcCalls } = fakeDb({
      items: [{ ...itemRow('a'), lifecycle_status: 'archived' }],
      images: [imageRow('a', 'o/a.png', sha(png))], objects: { 'o/a.png': png },
    });
    expect((await settleMarketplaceHero(db)).examined).toBe(0);
    expect(rpcCalls).toHaveLength(0);
    expect((await settleMarketplaceHero(db, { includeArchived: true })).planned).toBe(1);
  });
});

describe('the end-to-end decode agrees with the planner', () => {
  it('a PNG of a synthetic scene plans to a valid, deterministic frame', async () => {
    const png = await scenePng();
    const a = await planHeroFromBytes(png, { proof: true });
    const b = await planHeroFromBytes(png);
    if (!a.ok || !b.ok) throw new Error('no plan');
    expect(a.plan).toEqual(b.plan);
    expect(a.plan.mode).toBe('crop');
    expect(a.tile?.width).toBe(648);
    expect(a.tile?.pixels.length).toBe(648 * 180 * 3);
  });

  it('an unreadable picture is an answer, never an exception', async () => {
    expect(await planHeroFromBytes(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false });
    expect(await planHeroFromBytes(new Uint8Array(0))).toMatchObject({ ok: false });
  });
});

describe('the boundaries that keep presentation presentation', () => {
  it('the sweep writes no table, status, role, eligibility or primary pointer directly', () => {
    const source = read(`${SHARED}/settleMarketplaceHero.ts`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(source).not.toMatch(/\.(update|insert|upsert|delete)\(/);
    expect(source).not.toMatch(/chooseAndStorePrimaryImage|enforceStrictPrimaryImages|image_work_stage/);
    expect(source).toMatch(/rpc\('builder_stock_record_hero_presentation'/);
  });

  it('the stock pipeline does not call the planner, and the planner holds no pipeline claim', () => {
    for (const file of ['settleItemImages.ts', 'settleSourceImages.ts', 'settleImageSanitization.ts', 'importStock.ts', 'publicationSweep.ts']) {
      expect(read(`${SHARED}/${file}`)).not.toMatch(/settleMarketplaceHero|planHeroWithCapacity|heroPlanning/);
    }
    const fn = read('supabase/functions/builder-stock-hero-planner/index.ts');
    expect(fn).not.toMatch(/claimOneImageWorkItem|completeItemWork|publish_builder_stock_upload/);
    expect(fn).toMatch(/verifyInternal/);
  });

  it('the guarded call merges ONE key, only while the fingerprints stand, and rollback removes it', () => {
    const sql = read('supabase/migrations/20261001140000_a_card_frames_the_property_from_a_stored_plan.sql');
    expect(sql).toMatch(/- 'marketplace_hero_attempt'\)\s*\|\| jsonb_build_object\('marketplace_hero', p_plan\)/);
    expect(sql).toMatch(/AND img\.organisation_id = p_organisation_id/);
    expect(sql).toMatch(/= lower\(p_expected_original\)/);
    expect(sql).toMatch(/source_detail - 'marketplace_hero' - 'marketplace_hero_attempt'/);
    expect(sql).toMatch(/TO service_role/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|authenticated)/);
  });

  it('the Command Centre receives the plan through the normal payload, beside the fingerprints it is keyed on', () => {
    const sql = read('supabase/migrations/20261001140000_a_card_frames_the_property_from_a_stored_plan.sql');
    expect(sql).toMatch(/'marketplace_hero',\s+v_img\.source_detail->'marketplace_hero'/);
    expect(sql).toMatch(/'stored_sha256',\s+v_img\.source_detail->'stored_sha256'/);
    expect(sql).toMatch(/'sanitized_derivative',\s+v_img\.source_detail->'sanitized_derivative'/);
  });

  it('the worker route accepts only a proof switch, and plans on the deterministic decoder', () => {
    expect(readHeroWorkContext({})).toEqual({});
    expect(readHeroWorkContext({ proof: true })).toEqual({ proof: true });
    expect(readHeroWorkContext({ proof: 'yes' })).toBeNull();
    expect(readHeroWorkContext([])).toBeNull();
    const worker = read('workers/builder-stock-pdf-worker/src/pdfElection.do.ts');
    expect(worker).toMatch(/if \(path === HERO_PATH\) return await this\.hero\(request\)/);
    expect(worker).toMatch(/planHeroFromBytes\(bytes/);
  });
});
