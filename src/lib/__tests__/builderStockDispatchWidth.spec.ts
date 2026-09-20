/**
 * HOW MANY SETTLERS A MINUTE THE TICK MAY START — pinned in source.
 *
 * MEASURED IN PRODUCTION, 20 SEPTEMBER 2026, upload `aac89d49`. Thirteen
 * properties, thirteen linked brochures, published in 2 m 05.6 s. The import
 * kick started six settlers at 04:17:37.4 and they ran eleven of the thirteen
 * PDF elections. The 04:18 minute tick then found `claimable = 8`, dispatched
 * TWO on `p_max = 2`, and the fleet ran dry: 30.474 s with no settler process
 * alive anywhere and four properties still claimable, inside a 43.912 s
 * stretch with no election running at all. Across the 96.479 s from the first
 * election's start to the last one's finish, 56.912 s — 59.0% — had nothing
 * in flight. Ten invocations were granted 1,000 s of budget and used 277.1 s.
 * Every one answered HTTP 200; there was no 546 and no resource-limit kill.
 *
 * The fleet was absent, not full, and this is the number that decides it.
 *
 * WHY FOUR AND NOT SIX. The dispatcher sizes itself with
 * `least(greatest(coalesce(p_max, 0), 0), 6, ceil(v_claimable / 2.0))`, so at
 * the measured `claimable = 8` the third term binds at four and a cap of four
 * and a cap of six dispatch the SAME four workers. Four is the whole remedy
 * for the measured fault. Six would only differ on a larger backlog, and the
 * minute tick overlaps the kick — all six of the 04:17:37 wave were still
 * alive when the 04:18 tick fired — so four already takes the transient live
 * count to about ten isolates. That counterfactual is asserted below rather
 * than asserted about, because it is the whole reason for the number.
 *
 * SOURCE-LEVEL, AND AGAINST THE LAST WRITER. These are SQL functions in
 * applied migrations; a spec cannot execute them without a Postgres. What it
 * can do is refuse to read a SUPERSEDED file, which is the trap this suite
 * already walked into once: `builderStockSettlerHousekeeping.spec.ts` pinned
 * the width against the migration it was written for, and that file keeps
 * saying `(2)` for ever however production is set. So the tick is resolved by
 * scanning every migration and taking the greatest version that defines it —
 * the same rule the database applies. The migration carries its own proof
 * against `pg_get_functiondef`, which is the only place the DEPLOYED text can
 * be judged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'supabase/migrations';
const TICK = 'settle_builder_stock_marketplace_eligibility_tick';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** Every migration, in the order the database applies them. */
function migrations(): { file: string; sql: string }[] {
  return readdirSync(join(process.cwd(), MIGRATIONS))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: read(`${MIGRATIONS}/${file}`) }));
}

/**
 * The whole `CREATE OR REPLACE FUNCTION` body, not the line the name sits on.
 *
 * A line-scoped read is how a pin comes to agree with a file that no longer
 * decides anything: the assertion matches a comment mentioning the call while
 * the statement below it says something else.
 */
function definitionOf(sql: string, name: string): string | null {
  const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (at === -1) return null;
  const close = sql.indexOf('END;\n$$;', at);
  if (close === -1) return null;
  return sql.slice(at, close + 'END;\n$$;'.length);
}

/** The last migration that defines `name` — what production actually runs. */
function lastWriter(name: string): { file: string; definition: string } {
  const found = migrations()
    .map(({ file, sql }) => ({ file, definition: definitionOf(sql, name) }))
    .filter((entry): entry is { file: string; definition: string } => entry.definition !== null);
  expect(found.length, `nothing defines ${name}`).toBeGreaterThan(0);
  return found[found.length - 1];
}

/** The integer a call site passes to the dispatcher. */
function capPassedBy(definition: string, prefix: RegExp): number {
  const match = definition.match(prefix);
  expect(match, 'the dispatcher is no longer called here').not.toBeNull();
  return Number(match![1]);
}

describe('the minute tick tops the fleet up by four', () => {
  const tick = lastWriter(TICK);

  it('is defined last by the migration that raised it', () => {
    expect(tick.file).toBe('20260920050000_the_minute_tick_tops_up_four.sql');
  });

  it('calls the dispatcher with 4', () => {
    expect(capPassedBy(
      tick.definition,
      /v_dispatched\s*:=\s*public\.builder_stock_dispatch_image_workers\(\s*(\d+)\s*\)/,
    )).toBe(4);
  });

  it('still reads what the dispatcher did, so the fallback can tell', () => {
    // The capture is half the point: a tick that called the dispatcher and
    // ignored its answer would start a second settler on every tick of a
    // healthy import.
    expect(tick.definition).toMatch(/v_dispatched\s*:=\s*public\./);
    expect(tick.definition).toContain('IF coalesce(v_dispatched, 0) = 0 THEN');
  });

  it('starts exactly one settler when it dispatched none, and cannot fail the tick', () => {
    const guard = tick.definition.indexOf('IF coalesce(v_dispatched, 0) = 0 THEN');
    expect(guard).toBeGreaterThan(0);
    const branch = tick.definition.slice(guard);
    expect(branch).toContain("'builder-stock-image-settler'");
    expect(branch).toContain("'housekeeping'");
    expect(branch).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(
      tick.definition.match(/cron_invoke_signed_function\(/g) ?? [],
      'a wider dispatch makes this branch rarer, not optional — and it must '
      + 'still start ONE settler, because a second finds the lease held',
    ).toHaveLength(1);
  });

  it('still retires itself when a deployment has nothing owed', () => {
    expect(tick.definition).toMatch(
      /v_outstanding \+ v_fallback \+ v_item_work \+ v_publications\s*\+ v_upload_completion \+ v_blocked = 0/);
    expect(tick.definition).toContain(
      "cron.unschedule('settle-builder-stock-marketplace-eligibility')");
  });

  /*
   * ONE INTEGER MOVES, and the rest is byte-identical.
   *
   * The risk in re-installing a function is not the line you meant to change;
   * it is the sweep, the term or the guard that silently does not come with
   * it. Both definitions are in the tree, so the comparison is available and
   * costs nothing: strip each one's dispatch block and the remainder must
   * match exactly.
   */
  it('changes nothing else about the tick', () => {
    const previous = definitionOf(
      read(`${MIGRATIONS}/20260919110000_work_the_tick_found_can_start_a_worker.sql`), TICK);
    expect(previous).not.toBeNull();

    const withoutDispatch = (definition: string) => {
      const at = definition.indexOf('v_dispatched := public.builder_stock_dispatch_image_workers');
      expect(at).toBeGreaterThan(0);
      const before = definition.slice(0, at);
      // Everything from the start of the comment that introduces the call.
      const head = before.slice(0, before.lastIndexOf('\n\n'));
      return head + definition.slice(definition.indexOf(';', at) + 1);
    };

    expect(withoutDispatch(tick.definition)).toBe(withoutDispatch(previous!));
  });

  it('proves itself against the deployed definition rather than this file', () => {
    const sql = read(`${MIGRATIONS}/20260920050000_the_minute_tick_tops_up_four.sql`);
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain("p.proname = 'builder_stock_dispatch_image_workers'");
    expect(sql).toContain("p.proname = 'builder_stock_kick_image_work'");
    // The width arithmetic is EXECUTED from the deployed expression, never
    // restated — a proof that restated it would agree with a mutant.
    expect(sql).toContain("EXECUTE 'SELECT (' || v_eval || ')::integer' INTO v_width");
  });
});

describe('what this change deliberately leaves alone', () => {
  const dispatcher = lastWriter('builder_stock_dispatch_image_workers');
  const kick = lastWriter('builder_stock_kick_image_work');

  it('keeps the import-time kick at 6', () => {
    // A fresh upload is a burst and is meant to start six-wide. Raising the
    // steady-state trickle must not have moved the burst.
    expect(capPassedBy(
      kick.definition,
      /RETURN\s+public\.builder_stock_dispatch_image_workers\(\s*(\d+)\s*\)/,
    )).toBe(6);
  });

  it("keeps the dispatcher's own ceiling at 6 and its ceil(claimable / 2) sizing", () => {
    expect(sizingExpression(dispatcher.definition))
      .toBe('least(greatest(coalesce(p_max, 0), 0), 6, ceil(v_claimable / 2.0)::integer)');
  });

  it('keeps the dispatcher returning 0 before it does anything when nothing is claimable', () => {
    expect(dispatcher.definition).toMatch(
      /SELECT claimable INTO v_claimable FROM public\.builder_stock_image_work_pending\(\);\s*IF coalesce\(v_claimable, 0\) = 0 THEN\s*RETURN 0;/);
  });
});

/**
 * The deployed sizing expression, lifted out rather than written down.
 *
 * `[^;]*` rather than a lazy quantifier: this mirrors the migration's own
 * extraction, where Postgres decides a whole regex's greediness from its first
 * quantifier and a lazy one later in the pattern is ignored. A class that
 * cannot contain `;` cannot leave the statement.
 */
function sizingExpression(definition: string): string {
  const match = definition.match(/v_n\s*:=\s*(least\([^;]*\))\s*;/);
  expect(match, "the dispatcher's sizing expression could not be read").not.toBeNull();
  return match![1].replace(/\s+/g, ' ');
}

/**
 * WHAT THOSE CAPS ACTUALLY DISPATCH — evaluated, not asserted.
 *
 * The expression is the one read out of the migration, with `least`,
 * `greatest`, `coalesce` and `ceil` supplied and the Postgres cast dropped.
 * Nothing here re-implements the rule; a table of expected widths beside a
 * hand-written copy of the formula would agree with a mutant that changed it.
 *
 * The authoritative version of this is in the migration, which evaluates the
 * same expression inside Postgres against `pg_get_functiondef`. This is the
 * cheap mirror that runs on every commit.
 */
describe('the widths those caps produce', () => {
  const dispatcher = lastWriter('builder_stock_dispatch_image_workers');
  const tick = lastWriter(TICK);
  const kick = lastWriter('builder_stock_kick_image_work');

  const tickCap = capPassedBy(
    tick.definition,
    /v_dispatched\s*:=\s*public\.builder_stock_dispatch_image_workers\(\s*(\d+)\s*\)/);
  const kickCap = capPassedBy(
    kick.definition,
    /RETURN\s+public\.builder_stock_dispatch_image_workers\(\s*(\d+)\s*\)/);

  const evaluate = (cap: number, claimable: number): number => {
    const expression = sizingExpression(dispatcher.definition).replace(/::integer/g, '');
    const fn = new Function(
      'p_max', 'v_claimable', 'least', 'greatest', 'coalesce', 'ceil',
      `return ${expression};`,
    ) as (
      pMax: number, claimable: number,
      least: (...n: number[]) => number, greatest: (...n: number[]) => number,
      coalesce: (...v: (number | null)[]) => number, ceil: (n: number) => number,
    ) => number;
    return fn(
      cap, claimable,
      (...n) => Math.min(...n), (...n) => Math.max(...n),
      (...v) => (v.find((value) => value !== null && value !== undefined) ?? 0) as number,
      (n) => Math.ceil(n),
    );
  };

  it('dispatches 4 at the backlog upload aac89d49 left standing', () => {
    expect(evaluate(tickCap, 8)).toBe(4);
  });

  it('would dispatch the same 4 at a cap of six, which is why the cap is four', () => {
    expect(evaluate(kickCap, 8)).toBe(4);
  });

  it('dispatches 2 at half that backlog', () => {
    expect(evaluate(tickCap, 4)).toBe(2);
  });

  it('dispatches 0 with nothing claimable', () => {
    expect(evaluate(tickCap, 0)).toBe(0);
  });

  it('is self-limiting: four workers need eight claimable properties', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((claimable) => evaluate(tickCap, claimable)))
      .toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('never exceeds the dispatcher ceiling, whatever the backlog', () => {
    for (const claimable of [13, 20, 100, 1000]) {
      expect(evaluate(tickCap, claimable)).toBeLessThanOrEqual(4);
      expect(evaluate(kickCap, claimable)).toBeLessThanOrEqual(6);
    }
    expect(evaluate(kickCap, 13)).toBe(6);
  });
});
