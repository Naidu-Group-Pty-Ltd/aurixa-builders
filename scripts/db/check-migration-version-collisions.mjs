#!/usr/bin/env node
/**
 * A migration version must name exactly one file.
 *
 * ## Why this exists
 *
 * `supabase_migrations.schema_migrations` has `version` as its PRIMARY KEY. Two
 * files that share a 14-digit prefix therefore compete for one row: whichever is
 * recorded first wins the `name` column, and the other becomes invisible to
 * everything that reads the ledger to answer "has this been applied?".
 *
 * That is not hypothetical. Measured 2026-09-06 on the prime:
 *
 *     20261112000000_seed_template_library_v12_guarded_verdict_line.sql
 *     20261112000000_client_deals_agent_fee_receipt.sql
 *
 * The catalogue seed was applied and recorded. The second file had never run —
 * `client_deals.commission_received` and `commission_received_date` did not
 * exist — and its own header records that two consecutive audits had already
 * reported "there is currently no agent fee/commission tracking". Nothing was
 * broken enough to notice: the ledger said the version was applied, because for
 * one of its two files it was.
 *
 * The fleet makes it worse rather than better. Mission Control's migration lane
 * decides what a clone still owes BY VERSION, so a collision marks every file in
 * the group applied on every clone the moment one of them lands.
 *
 * ## What this checks
 *
 * Every `supabase/migrations/*.sql` must start with a 14-digit version and an
 * underscore, and no two may share that version — except for the groups already
 * frozen in MIGRATION_VERSION_COLLISIONS.json.
 *
 * The baseline is an inventory, not an exemption: it fails when a listed group's
 * file set CHANGES (a third file joining an existing collision is new debt), and
 * it fails when a listed group no longer collides, because a stale entry is the
 * same failure wearing a note. Shrinking that file to nothing is the goal.
 *
 * Renaming an existing colliding file is safe only when nothing has recorded it
 * under its own version — which, for every group in there, is exactly the
 * situation, since the version was already taken. It is still a fleet-wide file
 * move, so it is a deliberate act rather than something this gate demands.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Resolve from the process cwd, NOT from `import.meta.url`. The negative-test
// harness (check-security-gate-negatives.mjs) runs each gate against a symlinked
// mirror of the tree with one file mutated; a gate that resolves relative to its
// own location reads the REAL repository instead and passes on mutated source.
const root = resolve(process.cwd());
const MIGRATIONS = join(root, 'supabase', 'migrations');
const BASELINE = join(MIGRATIONS, 'MIGRATION_VERSION_COLLISIONS.json');

const VERSIONED = /^(\d{14})_.+\.sql$/;

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch (e) {
  console.error(`Migration version check FAILED: cannot read ${BASELINE}: ${e.message}`);
  process.exit(1);
}

const notAMigration = new Set(baseline.not_a_migration ?? []);
/** version -> sorted file list, as the baseline froze it. */
const frozen = new Map(
  (baseline.collisions ?? []).map((c) => [c.version, [...(c.files ?? [])].sort()]),
);

const files = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();

const errors = [];
const byVersion = new Map();

for (const name of files) {
  const m = VERSIONED.exec(name);
  if (!m) {
    // A file with no version is either a deliberate non-migration (a template)
    // or a real migration whose prefix is mistyped — and the second one is
    // silent, because the CLI simply does not see it.
    if (!notAMigration.has(name)) {
      errors.push(
        `${name}: does not start with a 14-digit version and an underscore, and is not `
        + `listed in "not_a_migration". A file the migration runner cannot see is not a migration.`);
    }
    continue;
  }
  const version = m[1];
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(name);
}

const live = new Map(
  [...byVersion.entries()].filter(([, group]) => group.length > 1).map(([v, g]) => [v, g.sort()]),
);

for (const [version, group] of live) {
  const known = frozen.get(version);
  if (!known) {
    errors.push(
      `${version} is carried by ${group.length} files and is not in the baseline:\n`
      + group.map((f) => `        ${f}`).join('\n')
      + `\n      One version records one ledger row, so the others can never be told apart from `
      + `applied. Give each file its own version.`);
    continue;
  }
  const added = group.filter((f) => !known.includes(f));
  const removed = known.filter((f) => !group.includes(f));
  if (added.length || removed.length) {
    errors.push(
      `${version}: the frozen collision has changed`
      + (added.length ? `\n      added:   ${added.join(', ')}` : '')
      + (removed.length ? `\n      removed: ${removed.join(', ')}` : '')
      + `\n      Joining an existing collision is new debt of exactly the same kind. `
      + `Give the new file its own version; update the baseline only when one leaves.`);
  }
}

for (const version of frozen.keys()) {
  if (!live.has(version)) {
    errors.push(
      `${version} is in the baseline but no longer collides. Remove the entry — `
      + `a stale exemption is the same failure wearing a note.`);
  }
}

if (errors.length) {
  console.error('Migration version check FAILED:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\nChecked ${files.length} migration file(s).`);
  process.exit(1);
}

const grandfathered = [...live.values()].reduce((n, g) => n + g.length, 0);
console.log(
  `Migration version check passed (${files.length} file(s); `
  + `${live.size} frozen collision(s) over ${grandfathered} files, 0 new).`,
);
