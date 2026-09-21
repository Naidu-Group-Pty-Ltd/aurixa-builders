/**
 * A RE-READ OF A PUBLISHED STOCK LIST COULD NEVER CHANGE A SINGLE VALUE.
 *
 * MEASURED IN PRODUCTION, 21 SEPTEMBER 2026, and proved by CALLING the
 * function rather than by reading it. `LOT 266 Crowlea Estate` was re-read at
 * 10:49 and the reading was right — the import log records
 * `development_name:leading_field_name`, `land_size_sqm:below`,
 * `house_design:filename` — and the row's columns stayed empty. The corrected
 * values sat in `pending_patch`, and `publish_builder_stock_upload` answered
 * `already_published` and applied nothing. It would have answered that for
 * ever.
 *
 * Source-level assertions: the behaviour lives in a Postgres function, the
 * repository's suite has no database, and what must be guaranteed is the
 * SHAPE — that a patch is applied above every return in that branch, that
 * the two call sites share one implementation, and that nothing about
 * membership moved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const migration = read(
  'supabase/migrations/20260921110000_a_reread_of_a_published_list_must_be_able_to_correct_it.sql');

/** The already-published branch, up to the end of its late promotion. */
const alreadyPublished = migration.slice(
  migration.indexOf('IF v_already IS NOT NULL THEN'),
  migration.indexOf("IF coalesce(v_ready, false) THEN"));

describe('a held-back patch is applied before any return that could strand it', () => {
  it('applies it inside the already-published branch', () => {
    expect(alreadyPublished)
      .toContain('v_patched := public.apply_builder_stock_pending_patch(p_upload_id);');
  });

  it('applies it ABOVE every return in that branch', () => {
    const applyAt = alreadyPublished.indexOf('apply_builder_stock_pending_patch');
    const firstReturn = alreadyPublished.indexOf('RETURN jsonb_build_object');
    expect(applyAt).toBeGreaterThan(-1);
    expect(applyAt).toBeLessThan(firstReturn);
  });

  it('reports what it patched rather than a bare zero', () => {
    // `already_published` with a patch applied is not "nothing happened", and
    // an operator reading the answer should not have to infer that.
    const returns = alreadyPublished.match(/RETURN jsonb_build_object\([^;]*;/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const statement of returns) expect(statement).toContain("'patched', v_patched");
  });
});

describe('the two call sites share one implementation', () => {
  it('applies a patch through the same function in both places', () => {
    const calls = migration.match(
      /v_patched := public\.apply_builder_stock_pending_patch\(p_upload_id\);/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('leaves no second, inline copy of the patch UPDATE', () => {
    // Two copies is how the two ends came to disagree about a null once
    // already. The UPDATE lives in the helper and nowhere else.
    const publishFn = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.publish_builder_stock_upload'));
    expect(publishFn).not.toContain('UPDATE public.builder_stock_items AS i');
  });

  it('still applies every column by key presence', () => {
    for (const column of ['development_name', 'land_size_sqm', 'expected_completion',
      'lot_number', 'price', 'suburb', 'description']) {
      expect(migration).toContain(`i.pending_patch ? '${column}'`);
    }
  });

  it('is not callable by a client', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.apply_builder_stock_pending_patch\(uuid\) FROM PUBLIC;/);
  });
});

describe('nothing about membership moved', () => {
  it('promotes only a staged row that earned its photograph', () => {
    expect(migration).toContain("AND lifecycle_status = 'staged'");
    expect(migration).toContain(
      'AND public.builder_stock_photo_is_source_ready(primary_image_id)');
  });

  it('archives only what a SUPERSEDED upload still supplies', () => {
    expect(migration).toContain('AND upload_id = ANY(v_replaces)');
    expect(migration).toContain('AND upload_id <> p_upload_id');
  });

  it('repairs the stranded patches without touching membership', () => {
    /*
     * Every stranded patch is a corrected reading this pipeline produced and
     * could not deliver. The repair writes only what the reader wrote,
     * through the one function that applies a patch.
     */
    const repair = migration.slice(migration.indexOf('DO $repair$'));
    expect(repair).toContain('apply_builder_stock_pending_patch(v_upload)');
    expect(repair).not.toContain('lifecycle_status');
    expect(repair).not.toContain('DELETE');
  });
});
