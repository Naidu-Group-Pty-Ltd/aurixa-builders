/**
 * A FIGURE A BUILDER STATES REACHES THE MARKETPLACE — IN THE SHAPE THE
 * MARKETPLACE READS.
 *
 * `builder_network_compose_stock_item_payload` is the one place a property
 * becomes the payload a clone mirrors, and it composed `manual_stats` from
 * top-level keys the column never holds (the figures live under `values`,
 * by the column's own CHECK). Every lookup was NULL, so a land size a builder
 * typed into "Complete the schedule" synced as `{}` — and a clone reads that
 * with `readManualStats`, the same module this repository reads with, and
 * finds nothing.
 *
 * Three things are held here. The migration changes ONE block of the
 * function and nothing else, against the definition before it. The block
 * reads every figure under `values`, carries `recorded_at`, and leaves the
 * builder user's id behind. And the shape it composes is one the marketplace's
 * reader accepts, where the shape it used to compose is one it discards.
 * `scripts/ops/probe-stated-figures-payload.mjs` asks the real function the
 * same question in the acceptance database, by effect.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyManualStats, readManualStats, MANUAL_STAT_FIELDS,
} from '../../../supabase/functions/_shared/builderStock/manualStats.pure';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const BEFORE = 'supabase/migrations/20260919060000_the_column_a_picture_was_filed_under_travels.sql';
const AFTER = 'supabase/migrations/20260923140000_a_builders_stated_figures_reach_the_marketplace.sql';

/** The composer's definition in a migration, from its header to its closing tag. */
function composer(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.builder_network_compose_stock_item_payload');
  const body = sql.indexOf('AS $function$', start);
  const end = sql.indexOf('$function$', body + 'AS $function$'.length) + '$function$'.length;
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, end);
}

/** The `manual_stats` entry of the payload, and the function without it. */
function split(definition: string): { block: string; rest: string } {
  const from = definition.indexOf("    'manual_stats', CASE");
  const to = definition.indexOf("    'item_created_at'", from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return { block: definition.slice(from, to), rest: definition.slice(0, from) + definition.slice(to) };
}

describe('the composer changes in one block and nowhere else', () => {
  const before = split(composer(read(BEFORE)));
  const after = split(composer(read(AFTER)));

  it('is byte-identical outside the manual_stats entry', () => {
    expect(after.rest).toBe(before.rest);
  });

  it('reads every stated figure under values, where the column keeps it', () => {
    for (const field of MANUAL_STAT_FIELDS) {
      expect(after.block).toContain(`v_i.manual_stats->'values'->'${field}'`);
      expect(after.block).not.toContain(`v_i.manual_stats->'${field}'`);
    }
    expect(before.block).toContain("v_i.manual_stats->'land_size_sqm'");
  });

  it('carries when it was stated, and leaves who stated it on the network', () => {
    expect(after.block).toContain("'recorded_at', v_i.manual_stats->'recorded_at'");
    expect(after.block).not.toContain('recorded_by');
  });

  it('is proved against a real database in the acceptance run, not only read', () => {
    const run = read('scripts/stock-acceptance/run.sh');
    expect(run).toContain('node scripts/ops/probe-stated-figures-payload.mjs');
  });
});

describe('the marketplace reads what the network now sends', () => {
  // Exactly what the probe reads back from the real function.
  const composed = { values: { bedrooms: 4, land_size_sqm: 312 }, recorded_at: '2026-09-23T00:00:00.000Z' };
  // What the function composed before, from the same stored figures.
  const composedBefore = {};

  it('a stated land size overlays the card on the clone', () => {
    const row = { id: 'lot-101', land_size_sqm: null, bedrooms: 3, manual_stats: composed };
    const effective = applyManualStats(row);
    expect(effective.land_size_sqm).toBe(312);
    expect(effective.bedrooms).toBe(4);
    expect(readManualStats(composed)?.recorded_at).toBe('2026-09-23T00:00:00.000Z');
  });

  it('the old shape read as nothing stated, which is the defect', () => {
    expect(readManualStats(composedBefore)).toBeNull();
    expect(readManualStats({ land_size_sqm: 312, bedrooms: 4 })).toBeNull();
  });
});
