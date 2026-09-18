/**
 * A collision with one of the table's three unique indexes, named.
 *
 * Measured in production 18 Sep 2026 — the log line this exists for:
 *   [builder-network-admin] organisation create failed {
 *     code: "23505",
 *     details: 'Key (abn)=(12345678901) already exists.',
 *     message: 'duplicate key value violates unique constraint
 *               "builder_organisations_abn_key"' }
 * which reached the operator as "The organisation could not be saved".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeOrganisationConflict,
  readOrganisationConflict,
} from '../../../supabase/functions/_shared/builderOrganisationConflict.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

/** The real shape PostgREST hands back, from the production log line. */
const duplicate = (index: string, key: string) => ({
  code: '23505',
  details: `Key (${key})=(12345678901) already exists.`,
  hint: null,
  message: `duplicate key value violates unique constraint "${index}"`,
});

describe('every unique index on the table is named', () => {
  const migration = read('supabase/migrations/00000000000000_network_baseline.sql');

  it('covers all three, read out of the migration rather than listed here', () => {
    // If the table gains a fourth unique index, this fails rather than
    // letting the new one reach an operator as an unattributed 500.
    const indexes = [
      ...migration.matchAll(
        /CREATE UNIQUE INDEX (builder_organisations_\w+) ON public\.builder_organisations/g,
      ),
    ].map((m) => m[1]);
    expect(indexes.sort()).toEqual([
      'builder_organisations_abn_key',
      'builder_organisations_acn_key',
      'builder_organisations_legal_name_key',
    ]);
    for (const index of indexes) {
      const reading = readOrganisationConflict(duplicate(index, 'x'));
      expect(reading, index).not.toBeNull();
      expect(describeOrganisationConflict(reading!.error), index).toBeTruthy();
    }
  });

  it('names the field for the exact production error', () => {
    const reading = readOrganisationConflict(
      duplicate('builder_organisations_abn_key', 'abn'),
    );
    expect(reading).toEqual({ field: 'abn', error: 'abn_already_registered' });
  });
});

describe('what it refuses to guess', () => {
  it('reads nothing from an error that is not a unique violation', () => {
    for (const other of [
      null,
      undefined,
      { code: '23502', message: 'null value in column "org_type"' },
      { code: '23514', message: 'violates check constraint "builder_organisations_abn_check"' },
      {},
    ]) {
      expect(readOrganisationConflict(other as never), JSON.stringify(other)).toBeNull();
    }
  });

  it('reads nothing from a unique violation on an index it does not know', () => {
    // A wrong field name sends an operator to edit something that was never
    // the problem, so an unrecognised index falls through to the old 500.
    expect(readOrganisationConflict(duplicate('some_other_table_pkey', 'id'))).toBeNull();
  });

  it('never repeats the colliding value back', () => {
    // `details` carries another organisation's registration number. This
    // console is not where somebody confirms who holds it.
    const reading = readOrganisationConflict(
      duplicate('builder_organisations_abn_key', 'abn'),
    );
    const sentence = describeOrganisationConflict(reading!.error)!;
    expect(sentence).not.toContain('12345678901');
    expect(JSON.stringify(reading)).not.toContain('12345678901');
  });
});

describe('the handler asks before it blames itself', () => {
  const code = read('supabase/functions/builder-network-admin/index.ts');

  it('reads the conflict on both write paths, above the 500', () => {
    for (const failure of ['create_failed', 'update_failed']) {
      const at = code.indexOf(`error: '${failure}'`);
      expect(at, failure).toBeGreaterThan(-1);
      // The conflict is read in the same branch, before the 500 is returned.
      const branch = code.slice(Math.max(0, at - 700), at);
      expect(branch, failure).toContain('readOrganisationConflict');
    }
  });

  it('answers 409 rather than 500, because nothing here is broken', () => {
    const uses = [...code.matchAll(/if \(conflict\) return json\(\{ error: conflict\.error, field: conflict\.field \}, 409\)/g)];
    expect(uses.length).toBe(2);
  });
});
