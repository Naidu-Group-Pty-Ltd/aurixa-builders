import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILDER_REMOVED_ACTION, builderRemovedIds,
} from '../../../supabase/functions/_shared/builderStock/builderRemoved.pure';

/**
 * MEASURED 30 SEPTEMBER 2026 (network audit). A property the builder removed
 * came back: Lot 1037 Wollert Rise, removed on 20 September, was revived by a
 * sheet imported on the 24th and sold on the marketplace until the 29th. And
 * Mairandi's 22 removals of 29 September would all have returned on the next
 * "Read again" of their Notion list — which is the only way that list's
 * corrected addresses reach its live rows.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('builderRemovedIds', () => {
  const rows = [
    { id: 'removed', lifecycle_status: 'archived', last_seen_at: '2026-09-29T08:03:49Z' },
    { id: 'revived-since', lifecycle_status: 'archived', last_seen_at: '2026-09-24T12:34:20Z' },
    { id: 'lineage', lifecycle_status: 'archived', last_seen_at: '2026-09-20T05:00:00Z' },
    { id: 'live', lifecycle_status: 'active', last_seen_at: '2026-09-29T08:03:49Z' },
    { id: 'never-seen', lifecycle_status: 'archived', last_seen_at: null },
  ];
  const log = [
    { entity_id: 'removed', created_at: '2026-09-29T08:13:54Z' },
    // Removed, then an import revived it, then something else archived it:
    // the builder's decision is no longer the standing one.
    { entity_id: 'revived-since', created_at: '2026-09-20T05:39:45Z' },
    { entity_id: 'live', created_at: '2026-09-29T08:20:00Z' },
    { entity_id: 'never-seen', created_at: '2026-09-29T08:20:00Z' },
    { entity_id: null, created_at: '2026-09-29T08:20:00Z' },
  ];

  it('is the archived rows the builder removed after the importer last saw them', () => {
    expect([...builderRemovedIds(rows, log)].sort()).toEqual(['never-seen', 'removed']);
  });

  it('never names a live row, a row nobody removed, or a removal an import has since undone', () => {
    const removed = builderRemovedIds(rows, log);
    expect(removed.has('live')).toBe(false);
    expect(removed.has('lineage')).toBe(false);
    expect(removed.has('revived-since')).toBe(false);
  });

  it('names the action the Stock List’s Remove writes', () => {
    const fn = read('supabase/functions/builder-portal-stock/index.ts');
    const archive = fn.slice(fn.indexOf("if (operation === 'archive_stock_item')"));
    expect(archive.slice(0, 1500)).toContain(`action: '${BUILDER_REMOVED_ACTION}'`);
  });
});

describe('an import leaves a removed property out', () => {
  const importer = read('supabase/functions/_shared/builderStock/importStock.ts');

  it('reads the removals and refuses to import where it could not', () => {
    expect(importer).toContain(".from('builder_portal_activity_log')");
    expect(importer).toContain(".eq('action', BUILDER_REMOVED_ACTION)");
    expect(importer).toMatch(/if \(removalLog\.failed\) \{\s*throw new Error/);
  });

  it('keeps a removed row out of every index, before any key is written', () => {
    const loop = importer.slice(importer.indexOf('for (const item of (existingRows ?? []) as ExistingItem[]) {'));
    const guard = loop.indexOf('if (builderRemoved.has(item.id)) {');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(loop.indexOf('byReference.set('));
    expect(guard).toBeLessThan(loop.indexOf('byDevelopmentUnit.set('));
    expect(guard).toBeLessThan(loop.indexOf('byAnchor.set('));
  });

  it('skips a record naming one only where nothing live matched, and counts it', () => {
    const skip = importer.slice(importer.indexOf('AND A ROW THAT NAMES A PROPERTY THE BUILDER REMOVED'));
    expect(skip).toMatch(/if \(!existingId\) \{/);
    expect(skip).toContain('!identityDifferences(removedAnchored.identity, identity).length');
    expect(skip).toMatch(/outcome\.keptRemoved \+= 1;\s*continue;/);
  });

  it('tells the builder why their count is short', () => {
    const run = read('supabase/functions/_shared/builderStock/runImport.ts');
    expect(run).toContain('if (outcome.keptRemoved > 0) {');
    expect(run).toContain('you removed');
  });
});

describe('a re-read finds each package on a lot by its design', () => {
  /*
   * MEASURED 30 SEPTEMBER 2026 (network audit): the live Wollert sheet sells
   * lot 1730 three ways, and a re-read found its row by the lot alone, so the
   * first design's record claimed the lot's row and wrote over another's.
   */
  const importer = read('supabase/functions/_shared/builderStock/importStock.ts');

  it('indexes this upload’s rows by lot and design, and asks that first', () => {
    expect(importer).toContain('byOwnLotDesign.set(designed, entry)');
    const lookup = importer.slice(importer.indexOf('const designedKey = lotKey && identity.design'));
    expect(lookup.indexOf('byOwnLotDesign.get(designedKey)')).toBeLessThan(lookup.indexOf('byOwnLot.get(lotKey)'));
  });

  it('never gives one package the row of another package on the same lot', () => {
    expect(importer).toMatch(/lotOnlyRow\.identity\.design !== identity\.design/);
    expect(importer).toContain('const ownLotRow = designedRow ?? (otherPackage ? undefined : lotOnlyRow);');
  });
});
