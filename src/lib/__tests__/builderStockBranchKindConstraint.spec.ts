import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY SOURCE KIND THE READER KNOWS, THE MANIFEST MAY RECORD.
 *
 * 30 September 2026: `dropbox_folder` joined `BranchKind` and the manifest's
 * CHECK was not told, so every list linking a Dropbox folder had its manifest
 * refused, stamped failed, and could never publish. This reads both sides and
 * fails the moment they differ.
 */
const root = resolve(__dirname, '../../..');

function codeKinds(): string[] {
  const source = readFileSync(
    resolve(root, 'supabase/functions/_shared/builderStock/sourceBranches.pure.ts'), 'utf8');
  const union = source.slice(source.indexOf('export type BranchKind ='));
  const body = union.slice(0, union.indexOf(';'));
  return [...body.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

function databaseKinds(): string[] {
  const dir = resolve(root, 'supabase/migrations');
  const defining = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .filter((f) => /CHECK \(branch_kind IS NULL OR branch_kind IN/
      .test(readFileSync(resolve(dir, f), 'utf8')));
  const latest = readFileSync(resolve(dir, defining[defining.length - 1]), 'utf8');
  const check = latest.slice(latest.lastIndexOf('branch_kind IN'));
  const list = check.slice(check.indexOf('('), check.indexOf(')') + 1);
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('the manifest records every kind of builder source', () => {
  it('the latest CHECK on branch_kind names exactly the kinds the reader declares', () => {
    expect(codeKinds().length).toBeGreaterThan(4);
    expect(databaseKinds()).toEqual(codeKinds());
  });
});
