/**
 * EVERY NORMAL SETTLER EXIT RUNS THE HOUSEKEEPING — pinned in source.
 *
 * THIS IS THE THIRD TIME. `runTickHousekeeping`'s own header records the first
 * two: the web-image store was wired inside per-candidate enforcement (dead
 * once the marketplace settled), then after the settlement work alone (dead
 * because withheld fallbacks keep that queue non-empty for ever). Both were
 * fixed by adding the call to the exit that was missing it, and both fixes
 * carried the same instruction — remember to add it to the next exit.
 *
 * On 19 September 2026 that instruction failed again, on a THIRD exit. The
 * per-item path — the one a healthy import actually leaves by — returned
 * straight past the housekeeping. Twelve invocations between 10:39:44 and
 * 10:46:02 took it; the last settled the thirteenth property of upload
 * `c2b7faa1`, published all thirteen, read `claimable: 0, outstanding: 0` and
 * returned without recording the import as finished. Nothing else could: the
 * cron tick starts a settler only for claimable IMAGE work, which was by then
 * zero, so the upload sat at `enriching` and the builder's page said
 * `Bringing in your stock list` beside `No imagery outstanding` indefinitely.
 *
 * An instruction that has failed three times is not the control. This is.
 *
 * SOURCE-LEVEL ON PURPOSE. The settler is a Deno edge function with a
 * service-role client, an HMAC gate, a global lease and a worker credential;
 * executing its handler here would mean doubling all of that, and the property
 * at stake is not what one exit returns but that NO exit is missing the call.
 * That is a statement about the file, so the file is what is read — the same
 * shape as `builderPortalUiMounted.spec.ts` and `builderDraftingMounted.spec.ts`,
 * which exist because an unused export typechecks, lints and builds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETTLER = 'supabase/functions/builder-stock-image-settler/index.ts';
const MIGRATION = 'supabase/migrations/'
  + '20260919110000_work_the_tick_found_can_start_a_worker.sql';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * The whole `return json(...)` expression, not the line `return json(` sits on.
 *
 * A line-scoped match is how the first version of this repository's
 * "never logs the URL" assertion passed against a mutant that put the offending
 * key on the NEXT line. Balanced parentheses, so a multi-line object literal is
 * read whole.
 */
function jsonReturns(source: string): { at: number; text: string }[] {
  const found: { at: number; text: string }[] = [];
  const needle = 'return json(';
  let at = source.indexOf(needle);
  while (at !== -1) {
    let depth = 0;
    let end = at + needle.length - 1;
    for (let i = end; i < source.length; i += 1) {
      const char = source[i];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    found.push({ at, text: source.slice(at, end + 1) });
    at = source.indexOf(needle, end + 1);
  }
  return found;
}

/**
 * A return that reports a SETTLEMENT OUTCOME, which is what owes housekeeping.
 *
 * Deliberately not "every successful return". Two do not qualify and must not:
 * `{ success: true, skipped: 'lease_held' }` is a tick that did no work because
 * another one holds the lease and is doing it, and the sanitization PREVIEW
 * answers with raw bytes and writes nothing at all by design — running the
 * passes there would make a preview write.
 */
function reportsSettlementOutcome(text: string): boolean {
  if (!/success:\s*true/.test(text)) return false;
  return /\bpath:/.test(text) || /\bphase[,:]/.test(text) || /\bsettled\b/.test(text);
}

describe('the settler records a finished import on every exit that can', () => {
  const source = read(SETTLER);
  const handlerAt = source.indexOf('Deno.serve(');

  it('has a handler to read', () => {
    expect(handlerAt).toBeGreaterThan(0);
  });

  it('runs the housekeeping before every settlement-outcome return', () => {
    const outcomes = jsonReturns(source)
      .filter((entry) => entry.at > handlerAt && reportsSettlementOutcome(entry.text));

    // Four exits: two per-item, the fallback phase, the settlement path.
    expect(outcomes.length).toBeGreaterThanOrEqual(4);

    let from = handlerAt;
    const missing: string[] = [];
    for (const outcome of outcomes) {
      const between = source.slice(from, outcome.at);
      if (!between.includes('runTickHousekeeping(')) {
        missing.push(outcome.text.replace(/\s+/g, ' ').slice(0, 110));
      }
      from = outcome.at;
    }

    expect(
      missing,
      'a settler exit reports a settlement outcome without having run '
      + 'runTickHousekeeping — an import that finished on this path is never '
      + 'recorded as finished, and nothing else in production can record it',
    ).toEqual([]);
  });

  it('covers both per-item exits by name, because those are the ones that broke', () => {
    const itemWork = jsonReturns(source)
      .filter((entry) => entry.at > handlerAt && /path:\s*'item_work'/.test(entry.text))
      .filter((entry) => /success:\s*true/.test(entry.text));

    expect(itemWork).toHaveLength(2);
    let from = handlerAt;
    for (const exit of itemWork) {
      expect(source.slice(from, exit.at)).toContain('runTickHousekeeping(');
      from = exit.at;
    }
  });

  it('does not run the passes on a preview or a held lease', () => {
    // A preview writes nothing at all; a held lease means another invocation
    // is doing this work now. Neither is an exit that owes housekeeping, and
    // the rule above must keep saying so rather than growing an exception.
    expect(source).toContain("skipped: 'lease_held'");
    expect(reportsSettlementOutcome("return json({ success: true, skipped: 'lease_held' })"))
      .toBe(false);
  });

  it('keeps upload completion inside the one shared pass', () => {
    const calls = source.match(/settleCompletedUploads\s*\(/g) ?? [];
    expect(
      calls,
      'upload completion is called somewhere other than runTickHousekeeping, '
      + 'so the exits can disagree about whether an import gets recorded',
    ).toHaveLength(1);

    const body = source.slice(
      source.indexOf('async function runTickHousekeeping('),
      source.indexOf('/** Wall clock for one tick'),
    );
    expect(body).toContain('settleCompletedUploads(supabase)');
    expect(body).toContain('runWebImageStorePass(supabase');
  });

  /*
   * AND IT RUNS ON THE UNSERIALISED EXITS TOO.
   *
   * The per-item path holds no global lease — deliberately, because that lease
   * is one boolean row for the whole deployment and a killed worker runs no
   * `finally`. So the web-image store, which fetches bytes and uploads an
   * object, stays behind the lease it has always been behind, and only the
   * pass whose write is a pure function of rows it just read crosses to the
   * unserialised exits.
   *
   * Moving `settleCompletedUploads` inside that guard would leave every exit
   * calling `runTickHousekeeping` and re-break exactly the thing this file
   * exists for, silently, with every other test here still green.
   */
  it('records a finished import on the exits that hold no lease', () => {
    const body = source.slice(
      source.indexOf('async function runTickHousekeeping('),
      source.indexOf('/** Wall clock for one tick'),
    );
    const guard = body.indexOf('if (mode.serialised) {');
    expect(guard).toBeGreaterThan(0);

    const guarded = body.slice(guard, body.indexOf('}', body.indexOf('runWebImageStorePass')));
    expect(guarded).toContain('runWebImageStorePass');
    expect(
      guarded,
      'upload completion moved behind the lease guard, so the per-item exits '
      + 'call the housekeeping and it does nothing for them',
    ).not.toContain('settleCompletedUploads');

    expect(body.indexOf('settleCompletedUploads')).toBeGreaterThan(guard);
  });

  it('makes a new exit state whether it is serialised', () => {
    // A discriminated union with no default: a call site cannot be added
    // without answering the question, and cannot claim `false` and still pass
    // the retirement callback.
    expect(source).toContain('type HousekeepingMode =');
    expect(source).toMatch(/\{\s*serialised:\s*true;\s*enforceAfterRetirement:/);
    expect(source).toMatch(/\|\s*\{\s*serialised:\s*false\s*\}/);
    expect(source).not.toMatch(/serialised\s*[?]:/);
    expect(source).not.toMatch(/serialised\s*=\s*(true|false)/);
  });
});

/**
 * AND THE OTHER HALF, WHICH IS IN SQL.
 *
 * Fixing the exits alone would leave the standing hole: a settler that is
 * killed by the resource ceiling runs no housekeeping either — four of the 23
 * invocations on 19 September answered 546 — and once the last photograph
 * settles nothing starts another one, because
 * `builder_stock_dispatch_image_workers` gates every dispatch on claimable
 * IMAGE work while the tick's keep-alive asks six questions.
 *
 * The migration's own DO block proves this against the DEPLOYED function, which
 * is the only place it can be proved. What is asserted here is that the
 * migration is in the tree and says what it is for, so the two fixes cannot be
 * separated by a revert that keeps one of them.
 */
describe('a tick that finds work and starts no image worker starts a settler', () => {
  const sql = read(MIGRATION);

  it('reads what the image dispatcher actually did', () => {
    expect(sql).toMatch(
      /v_dispatched\s*:=\s*public\.builder_stock_dispatch_image_workers\(2\);/);
  });

  it('starts exactly one settler when it dispatched none', () => {
    const guard = sql.indexOf('IF coalesce(v_dispatched, 0) = 0 THEN');
    expect(guard).toBeGreaterThan(0);
    const branch = sql.slice(guard, sql.indexOf('END;\n$$;', guard));
    expect(branch).toContain("cron_invoke_signed_function(");
    expect(branch).toContain("'builder-stock-image-settler'");
    expect(branch.match(/cron_invoke_signed_function\(/g) ?? []).toHaveLength(1);
  });

  it('cannot fail the tick it rides in', () => {
    const guard = sql.indexOf('IF coalesce(v_dispatched, 0) = 0 THEN');
    const branch = sql.slice(guard, sql.indexOf('END;\n$$;', guard));
    expect(branch).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  it('proves itself against the deployed definition rather than this file', () => {
    // The migration must carry its own assertions: a SQL file that says the
    // right thing and a database that runs something else is the exact failure
    // that made the repository baseline and production disagree here.
    expect(sql).toContain('pg_get_functiondef');
    expect(sql).toContain('builder_stock_image_work_pending()');
    expect(sql).toMatch(/RAISE EXCEPTION 'proof complete — rolling back'/);
  });
});
