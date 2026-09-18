#!/usr/bin/env node
/**
 * DID THE SCHEMA ACTUALLY SHIP?
 *
 * The sibling of `verify-functions-deployed.mjs`, for the half of the deploy
 * that had no lane at all.
 *
 * `deploy-supabase-functions.yml` ships every edge function on every push to
 * main and verifies by effect. Migrations shipped by nobody. There is no
 * workflow in this repository that applies one, and CI does not notice that a
 * branch added a table which production has never seen — so a migration
 * merged, went green, deployed its functions, and left the database behind.
 *
 * Measured on 18 Sep 2026: `20260918100500_builder_access_requests.sql` merged
 * with a full green check and was never applied. Its function shipped, ran
 * against a table that did not exist, and answered every public applicant
 *
 *   PGRST205  Could not find the table 'public.builder_access_requests'
 *             in the schema cache
 *
 * as an unattributed 500. The form was live and could not accept anybody. The
 * first person to find out was a user filling it in.
 *
 * That is the same lesson the functions lane already carries in its own
 * header — *a green merge is not a deploy, and the gap is silent by
 * construction* — and it was only ever half closed.
 *
 * ## How this applies them
 *
 * Through the Management API's query endpoint, with the access token this
 * repository already holds, rather than `supabase db push`. The CLI wants a
 * database password, which is a SECOND credential nobody has configured and
 * which would have to be added before anything could ship. The token is
 * already here and already used against this API by the verifier beside this
 * file, so the migration lane needs no new secret to exist. A lane that
 * cannot run until somebody adds a secret is a lane that stays unrun.
 *
 * ## The rules it answers to
 *
 *  * **Only what is missing runs, in version order.** The applied set is read
 *    from `supabase_migrations.schema_migrations`, which is the table the
 *    Supabase CLI itself keeps, so this and `supabase db push` agree about
 *    what has happened and neither re-runs the other's work.
 *
 *  * **A version is recorded only after its SQL succeeded.** Recording first
 *    would mark a failed migration as applied and hide it for ever, which is
 *    strictly worse than the gap this closes.
 *
 *  * **It stops at the first failure.** Migrations are ordered because they
 *    depend on each other; carrying on past a broken one applies later
 *    statements to a schema that does not exist yet.
 *
 *  * **It never invents a repair.** No IF NOT EXISTS is added, nothing is
 *    skipped on error, and a migration that fails leaves the run red with the
 *    database's own message. The repository's `check:migration-order` gate is
 *    what keeps them applicable in the first place.
 *
 *  * **Nothing is logged that a migration might carry.** The SQL is not
 *    echoed — a migration can contain a seeded credential or a piece of
 *    personal data, and a workflow log is readable by everyone with repository
 *    access. Versions and filenames are named; bodies are not.
 *
 * Usage:  node scripts/ops/apply-migrations.mjs [--dry-run]
 * Needs:  SUPABASE_ACCESS_TOKEN, PROJECT_REF
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.PROJECT_REF;
const dryRun = process.argv.includes('--dry-run');

if (!token || !projectRef) {
  console.error(
    '::error::apply-migrations: SUPABASE_ACCESS_TOKEN and PROJECT_REF are required — nothing was applied.',
  );
  process.exit(1);
}

/** One statement (or a whole migration) against the project's database. */
async function query(sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    // The API returns the database's own message, which is the useful half.
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message ?? parsed.error ?? text;
    } catch {
      /* not JSON — the raw body is what there is */
    }
    return { ok: false, status: response.status, detail };
  }
  try {
    return { ok: true, rows: JSON.parse(text) };
  } catch {
    return { ok: true, rows: [] };
  }
}

/** `20260918100500_builder_access_requests.sql` → `20260918100500`. */
const versionOf = (file) => file.slice(0, file.indexOf('_'));

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`::error::apply-migrations: no .sql files in ${DIR} — refusing to report success.`);
  process.exit(1);
}

// The CLI's own ledger. Absent on a project that has never had a migration
// applied through it, which is not an error — there is simply nothing applied.
const applied = await query(
  "select version from supabase_migrations.schema_migrations order by version",
);
if (!applied.ok && !/does not exist/i.test(String(applied.detail))) {
  console.error(
    `::error::apply-migrations: could not read the applied migrations (${applied.status}): ${applied.detail}`,
  );
  process.exit(1);
}
const appliedVersions = new Set(
  (applied.ok ? applied.rows : []).map((row) => String(row.version)),
);

const pending = files.filter((file) => !appliedVersions.has(versionOf(file)));

console.log(
  `apply-migrations: ${files.length} in the repository, ${appliedVersions.size} already applied, ${pending.length} pending.`,
);

if (pending.length === 0) {
  console.log('apply-migrations: the database is up to date.');
  process.exit(0);
}

for (const file of pending) console.log(`  pending  ${file}`);

if (dryRun) {
  console.log('apply-migrations: --dry-run, nothing was applied.');
  process.exit(0);
}

await query(`
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    statements text[],
    name text
  );
`);

for (const file of pending) {
  const version = versionOf(file);
  const sql = readFileSync(join(DIR, file), 'utf8');
  console.log(`::group::apply ${file}`);
  const result = await query(sql);
  if (!result.ok) {
    console.log('::endgroup::');
    // The message is the database's, not ours. Naming the file and the
    // failure is the whole value of this line.
    console.error(`::error::apply-migrations: ${file} failed (${result.status}): ${result.detail}`);
    console.error(
      '::error::apply-migrations: stopped at the first failure — later migrations were NOT applied.',
    );
    process.exit(1);
  }
  // Recorded only now. Recording before the SQL ran would mark a failed
  // migration as applied and hide it for ever.
  const record = await query(
    `insert into supabase_migrations.schema_migrations (version, name)
       values ('${version}', '${file.replace(/'/g, "''")}')
     on conflict (version) do nothing`,
  );
  if (!record.ok) {
    console.log('::endgroup::');
    console.error(
      `::error::apply-migrations: ${file} APPLIED but its version could not be recorded (${record.detail}). ` +
        'The next run will try to apply it again — check the ledger before re-running.',
    );
    process.exit(1);
  }
  console.log('::endgroup::');
  console.log(`  applied  ${file}`);
}

console.log(`apply-migrations: ${pending.length} applied.`);
