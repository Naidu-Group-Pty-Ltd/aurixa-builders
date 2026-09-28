import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SIX VERSIONS THE LIVE LEDGER RECORDS, AND WHY THEY ARE RECORDS AND NOT STEPS.
 *
 * On 20 Sep 2026 six migrations were applied to production directly, through
 * the Supabase `apply_migration` tool, which writes the ledger row WITH its SQL
 * and a wall-clock version. Four were then committed as repository files under
 * round-number versions, and two — `ai_budget_settle_qualifies_its_columns`
 * and `ai_budget_functions_are_revoked_from_public` — never were. The deploy
 * lane then EXECUTED the four repository files on top, so production's end
 * state for every object the six touched is what those files produce.
 *
 * `production-rollout verify` halts on any ledger version the repository does
 * not carry, and it has halted on these six since. The repository must carry
 * them without weakening that check — and without changing what a clean rebuild
 * produces, which is the part that decided the design:
 *
 *   * restored as EXECUTABLE migrations, a rebuild runs them in VERSION order,
 *     so the out-of-band `a_ceiling` (091154) runs AFTER the consolidated file
 *     (090000) where production ran it BEFORE — measured, four `ai_budget_*`
 *     function bodies then differ from production's, `reserve` among them with
 *     nothing later to correct it;
 *   * restored as RECORDS — the exact SQL production recorded, byte for byte,
 *     preserved but not executed — a rebuild is unchanged, and it is proven
 *     equal to production on every object those six touched (the fingerprint
 *     check in `scripts/db/ai-budget-rebuild-check.mjs`).
 *
 * So each file carries its body verbatim behind a `--|` prefix, and this spec
 * holds the three things that make that safe: the body recovers to the ledger's
 * own md5, nothing in the file executes, and the file that supersedes it exists.
 */

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');

/** Read from `supabase_migrations.schema_migrations` in production, 28 Sep 2026. */
const RECORDS = [
  { version: '20260920071612', name: 'the_assisted_reader_has_more_than_one_credential',
    md5: '2de55d7b1ba528adf5253ce03034ed82',
    supersededBy: '20260920070000_the_assisted_reader_has_more_than_one_credential.sql' },
  { version: '20260920075824', name: 'the_assisted_reader_is_gemini_on_the_gateway',
    md5: '1fb597ebe7533237989f477d927ea1a0',
    supersededBy: '20260920080000_the_assisted_reader_is_gemini_on_the_gateway.sql' },
  { version: '20260920091154', name: 'a_ceiling_that_concurrency_cannot_walk_through',
    md5: '19de3c5719b617e8dc7e43d4ceb9dff7',
    supersededBy: '20260920090000_a_ceiling_that_concurrency_cannot_walk_through.sql' },
  { version: '20260920091209', name: 'builder_stock_reads_through_openrouter',
    md5: 'd04780b40bdf6b03f60b5e701924cc0d',
    supersededBy: '20260920100000_builder_stock_reads_through_openrouter.sql' },
  { version: '20260920091331', name: 'ai_budget_settle_qualifies_its_columns',
    md5: 'c1c07fa701ba699cf26888aeb54321df',
    supersededBy: '20260920090000_a_ceiling_that_concurrency_cannot_walk_through.sql' },
  { version: '20260920091706', name: 'ai_budget_functions_are_revoked_from_public',
    md5: 'abcb3ccaa87930be32f35c9eb560be11',
    supersededBy: '20260920090000_a_ceiling_that_concurrency_cannot_walk_through.sql' },
] as const;

const BEGIN = '-- >>> BEGIN RECORDED BODY';
const END = '-- >>> END RECORDED BODY';

/** The body exactly as production recorded it: every line inside the markers, `--|` removed. */
function recoveredBody(source: string): string {
  const lines = source.split('\n');
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (start < 0 || end < start) throw new Error('no recorded body markers');
  return lines.slice(start + 1, end).map((line) => {
    if (!line.startsWith('--|')) throw new Error(`a recorded line lost its prefix: ${JSON.stringify(line)}`);
    return line.slice(3);
  }).join('\n');
}

describe('the six ledger versions applied out of band on 20 Sep 2026', () => {
  for (const record of RECORDS) {
    const file = `${record.version}_${record.name}.sql`;
    const path = join(MIGRATIONS, file);

    describe(file, () => {
      it('exists, so the repository carries every version the live ledger records', () => {
        expect(existsSync(path), `${file} is missing — production-rollout verify halts on it`).toBe(true);
      });

      it('preserves the SQL production recorded, byte for byte', () => {
        const body = recoveredBody(readFileSync(path, 'utf8'));
        expect(createHash('md5').update(body, 'utf8').digest('hex')).toBe(record.md5);
      });

      it('executes nothing — a rebuild runs the file that superseded it instead', () => {
        // Strip every comment line; a record-only migration leaves nothing behind.
        const executable = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*--/.test(line) && line.trim() !== '');
        expect(executable).toEqual([]);
      });

      it('names the file whose effect production actually has, and that file exists', () => {
        expect(readFileSync(path, 'utf8')).toContain(record.supersededBy);
        expect(existsSync(join(MIGRATIONS, record.supersededBy))).toBe(true);
      });
    });
  }
});
