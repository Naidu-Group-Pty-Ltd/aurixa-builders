/**
 * THE TICK STAYS AWAKE FOR A STRANDED FINALISATION — pinned in source.
 *
 * `recoverAbandonedFinalisations` rides inside the settler's shared
 * housekeeping body, which reaches every settler exit by construction. It
 * does not make an exit HAPPEN, and on 21 SEPTEMBER 2026 nothing did:
 * twenty minutes after the deploy, upload `5511d2e2` still read
 * `status: imported` with `records_detected: 0` beside its live property,
 * `builder-stock-image-settler` had not been invoked once, and `cron.job`
 * held four rows with `settle-builder-stock-marketplace-eligibility` not
 * among them. The tick had retired itself, correctly, because every term of
 * its keep-alive sum was zero and a stranded finalisation was not a term.
 *
 * This is `20260919110000`'s defect one level up — that one fixed a tick that
 * was awake and started nobody; this is a tick that is not awake at all.
 *
 * SOURCE-LEVEL, for the reason `builderStockSettlerHousekeeping.spec.ts` is:
 * the property at stake is not what one call returns but that the SQL and the
 * TypeScript ask the same question. Executing either needs a database or a
 * Deno runtime with a service-role client.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ABANDONED_PARSE_MS,
  RECOVERABLE_UPLOAD_STATUSES,
} from '../../../supabase/functions/_shared/builderStock/uploadCompletion.ts';

const MIGRATION = 'supabase/migrations/'
  + '20260921080000_a_stranded_finalisation_keeps_the_tick_alive.sql';

const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8');

describe('the keep-alive sum counts a stranded finalisation', () => {
  it('declares the term', () => {
    expect(sql).toMatch(/v_stranded\s+integer;/);
    expect(sql).toMatch(/SELECT count\(\*\) INTO v_stranded/);
  });

  it('adds it to the retirement condition', () => {
    // Reaching the housekeeping dispatch is only safe because the sum being
    // non-zero proves work exists. A term that is counted and not summed is
    // a term that does nothing.
    expect(sql).toMatch(
      /v_outstanding \+ v_fallback \+ v_item_work \+ v_publications\s*\+ v_upload_completion \+ v_stranded \+ v_blocked = 0/,
    );
  });

  it('keeps the tick able to retire', () => {
    // A term nothing discharges is a cron job that runs for ever. This one is
    // discharged by the pass it keeps alive: the recovery moves the row to
    // `enriching`, where `v_upload_completion` owns it.
    expect(sql).toContain("cron.unschedule('settle-builder-stock-marketplace-eligibility')");
  });
});

describe('the SQL and the TypeScript ask the same question', () => {
  /*
   * A WINDOW THAT DISAGREES WITH ITSELF is a tick that wakes for work the
   * recovery will refuse, or sleeps through work it would do. The value is
   * spelled twice because SQL cannot import a TypeScript constant, so the
   * agreement is asserted rather than assumed.
   */
  it('uses ABANDONED_PARSE_MS as the abandonment window', () => {
    const minutes = ABANDONED_PARSE_MS / 60_000;
    expect(Number.isInteger(minutes)).toBe(true);
    expect(sql).toContain(`interval '${minutes} minutes'`);
  });

  it('counts exactly the statuses the recovery will act on', () => {
    // Counting a row the recovery refuses is a tick that never retires.
    expect(RECOVERABLE_UPLOAD_STATUSES).toEqual(['imported']);
    for (const status of RECOVERABLE_UPLOAD_STATUSES) {
      expect(sql).toContain(`u.status = '${status}'`);
    }
  });

  it('treats an unreadable start stamp as abandoned, as the predicate does', () => {
    // Every path that sets this status stamps the start in the same write, so
    // a row without one is not an import in flight. Same rule, same direction.
    expect(sql).toMatch(/u\.processing_started_at IS NULL\s*\n?\s*OR u\.processing_started_at </);
  });

  it('excludes a deleted source, as every other term does', () => {
    const term = sql.slice(sql.indexOf('INTO v_stranded'), sql.indexOf("interval '15 minutes'"));
    expect(term).toContain('u.deleted_at IS NULL');
  });
});

describe('the rows already stranded get the tick back', () => {
  /*
   * The term keeps a tick alive; it cannot wake one that has already retired,
   * and on this deployment it had. A future kill needs no such block, because
   * the import preceding it arms the tick.
   */
  it('arms the tick once, and only where there is work', () => {
    const arming = sql.slice(sql.lastIndexOf('DO $$'));
    expect(arming).toContain('ensure_builder_stock_settlement_scheduled()');
    expect(
      arming,
      'the tick is armed unconditionally, which states there is work to do on '
      + 'a deployment that has none',
    ).toMatch(/IF v_stranded > 0 THEN/);
  });
});
