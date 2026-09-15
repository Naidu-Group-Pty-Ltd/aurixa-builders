#!/usr/bin/env node
/**
 * Production rollout for the Builders Network database — the repository's
 * established migration procedure from this change on.
 *
 * The live project was provisioned once by hand (the pinned-commit ritual the
 * README records); nothing in CI has ever applied a follow-on migration. This
 * script is the repeatable edition of that ritual, run from the
 * `production-rollout` workflow under the same SUPABASE_ACCESS_TOKEN the
 * function deploys use, against the Management API's SQL endpoint — no
 * database password exists anywhere in this repository.
 *
 * Phases (the workflow input picks one):
 *
 *   verify   READ-ONLY. Prints the live migration ledger, diffs it against
 *            the repository's migration files, and reports pending work,
 *            divergence, vault entry presence (names only), extensions and
 *            cron jobs. Mutates nothing; safe to run any time.
 *
 *   apply    The rollout. Refuses on divergence; applies each PENDING
 *            migration in version order (never the baseline — a live project
 *            without the recorded baseline is a halt, not an invitation);
 *            records each in supabase_migrations.schema_migrations exactly as
 *            the provisioning ritual did; then proves the objects this
 *            remediation ships, ensures pg_cron/pg_net, installs the two
 *            network drivers' schedules, and seeds the three Vault entries
 *            the signed cron invoker reads — creating only what is missing,
 *            never printing a value.
 *
 * Hard rules: no DROP DATABASE, no baseline re-application, no data
 * destruction, and no secret value in any log line (SQL text is never
 * logged; only labels are).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const INTERNAL_SECRET = process.env.NETWORK_INTERNAL_SECRET || '';
const BASELINE_VERSION = '00000000000000';
/** sha256 of the 2026-08-07 agreement text, pinned by the terms migration. */
const AGREEMENT_HASH = 'f5612fc2daef61ef645b43465005f411cd85979c8687cfb023f358c615e00af5';

const phase = process.argv[2];
if (!['verify', 'apply'].includes(phase || '')) {
  console.error('usage: production-rollout.mjs <verify|apply>');
  process.exit(2);
}
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — this must run in the production-rollout workflow.');
  process.exit(2);
}

const failures = [];
const fail = (message) => { failures.push(message); console.error(`  FAIL  ${message}`); };
const note = (message) => console.log(`  ${message}`);

/** Run SQL on the live project. Logs the LABEL only — never the SQL. */
async function q(label, sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`[${label}] management query failed ${response.status}: ${text.slice(0, 600)}`);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed?.result ?? parsed ?? []);
  } catch {
    return [];
  }
}

/** A dollar-quote tag that provably does not occur in the content. */
function dollarTag(content) {
  for (let i = 0; ; i += 1) {
    const tag = `ROLL${i}`;
    if (!content.includes(`$${tag}$`)) return tag;
  }
}

function repoMigrations() {
  return readdirSync(join(repoRoot, 'supabase/migrations'))
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      file,
      version: file.slice(0, 14),
      name: file.slice(15).replace(/\.sql$/, ''),
    }));
}

async function readLedger() {
  const shape = await q('ledger shape', `
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'`);
  if (!shape.length) {
    throw new Error('supabase_migrations.schema_migrations does not exist on the live project — this is not the provisioned database this repository expects. Halting.');
  }
  const columns = shape.map((row) => row.column_name);
  const rows = await q('ledger rows',
    'SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version');
  return { columns, rows };
}

async function preflight() {
  const migrations = repoMigrations();
  const { columns, rows } = await readLedger();
  const recorded = new Set(rows.map((row) => String(row.version)));

  console.log('\nLive migration ledger:');
  for (const row of rows) note(`${row.version}  ${row.name ?? ''}`);
  console.log(`ledger columns: ${columns.join(', ')}`);

  if (!recorded.has(BASELINE_VERSION)) {
    throw new Error('The baseline squash is NOT recorded on the live project. Applying anything on top would be guesswork — halting for human reconciliation.');
  }

  const repoVersions = new Set([BASELINE_VERSION, ...migrations.map((m) => m.version)]);
  const foreign = rows.filter((row) => !repoVersions.has(String(row.version)));
  if (foreign.length) {
    throw new Error(`The live ledger records versions this repository does not carry (${foreign.map((r) => r.version).join(', ')}) — divergence requiring human reconciliation. Halting.`);
  }

  const pending = migrations.filter((m) => !recorded.has(m.version));
  const applied = migrations.filter((m) => recorded.has(m.version));
  console.log('\nRepository migrations already recorded live:');
  for (const m of applied) note(m.file);
  console.log('\nPending (would apply, in this order):');
  for (const m of pending) note(m.file);
  if (!pending.length) console.log('  (none — live ledger matches the repository)');

  // Out-of-order safety: every pending version must sort AFTER every
  // recorded one, or the history needs human eyes.
  const maxRecorded = [...recorded].sort().at(-1);
  const outOfOrder = pending.filter((m) => m.version < maxRecorded);
  if (outOfOrder.length) {
    throw new Error(`Pending migrations sort before recorded ones (${outOfOrder.map((m) => m.file).join(', ')}) — halting.`);
  }

  return { pending, ledgerColumns: columns };
}

async function statusSnapshot() {
  const objects = await q('object presence', `
    SELECT
      to_regclass('public.builder_terms_versions') IS NOT NULL AS terms_versions,
      to_regclass('public.builder_terms_acceptances') IS NOT NULL AS terms_acceptances,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='builder_terms_versions' AND column_name='document_hash') AS document_hash,
      to_regclass('public.builder_stock_selection_announcements') IS NOT NULL AS announcements,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='builder_stock_selection_announcements' AND column_name='source_version') AS announcement_version,
      to_regclass('public.builder_network_outbox') IS NOT NULL AS network_outbox,
      to_regclass('public.builder_network_inbound_events') IS NOT NULL AS network_inbound,
      to_regclass('public.builder_network_stamps') IS NOT NULL AS network_stamps,
      to_regclass('public.auth_rate_limits') IS NOT NULL AS auth_rate_limits,
      to_regclass('public.provider_circuit_state') IS NOT NULL AS circuit_state,
      to_regclass('public.agent_model_assignments') IS NOT NULL AS model_assignments,
      to_regclass('public.api_usage_log') IS NOT NULL AS api_usage_log,
      to_regclass('public.global_report_settings') IS NOT NULL AS report_settings`);
  console.log('\nLive object presence:');
  console.log(JSON.stringify(objects[0] ?? {}, null, 2));

  const functions = await q('function presence', `
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'builder_accept_current_terms', 'builder_decide_org_join_request',
      'builder_stock_acknowledge_announcement', 'builder_network_apply_inbound_events',
      'builder_ensure_onboarding_steps', 'check_and_bump_rate_limit',
      'security_consume_rate_limit', 'provider_circuit_is_open',
      'provider_circuit_record_failure', 'provider_circuit_record_success',
      'record_portal_operational_event', 'cron_invoke_signed_function')
    ORDER BY p.proname`);
  console.log('\nLive function signatures:');
  for (const row of functions) note(`${row.proname}(${row.args})`);

  const vault = await q('vault entry names', `
    SELECT name FROM vault.secrets
    WHERE name IN ('supabase_url', 'internal_edge_secret', 'internal_edge_secret_v2',
                   'supabase_anon_key', 'supabase_service_role_key')
    ORDER BY name`);
  console.log('\nVault entries present (names only):');
  for (const row of vault) note(row.name);
  if (!vault.length) note('(none of the required entries exist)');

  const extensions = await q('extensions', `
    SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net') ORDER BY extname`);
  console.log(`\nExtensions: ${extensions.map((r) => r.extname).join(', ') || '(neither pg_cron nor pg_net)'}`);

  const jobs = await q('cron jobs', `
    SELECT jobname, schedule, active FROM cron.job
    WHERE to_regclass('cron.job') IS NOT NULL AND jobname LIKE 'builder-network-%'
    ORDER BY jobname`).catch(() => []);
  console.log('\nNetwork cron jobs:');
  for (const row of jobs) note(`${row.jobname}  [${row.schedule}]  active=${row.active}`);
  if (!jobs.length) note('(none scheduled)');

  return { vaultNames: new Set(vault.map((r) => r.name)) };
}

async function applyPending(pending, ledgerColumns) {
  for (const migration of pending) {
    const sql = readFileSync(join(repoRoot, 'supabase/migrations', migration.file), 'utf8');
    console.log(`\napplying ${migration.file} (${sql.length} bytes)…`);
    await q(`apply ${migration.version}`, sql);

    const tag = dollarTag(sql);
    const wantsName = ledgerColumns.includes('name');
    const wantsStatements = ledgerColumns.includes('statements');
    const insertColumns = ['version', wantsName ? 'name' : null, wantsStatements ? 'statements' : null]
      .filter(Boolean).join(', ');
    const insertValues = [
      `'${migration.version}'`,
      wantsName ? `'${migration.name.replace(/'/g, "''")}'` : null,
      wantsStatements ? `ARRAY[$${tag}$${sql}$${tag}$]` : null,
    ].filter(Boolean).join(', ');
    await q(`ledger ${migration.version}`, `
      INSERT INTO supabase_migrations.schema_migrations (${insertColumns})
      VALUES (${insertValues})
      ON CONFLICT (version) DO NOTHING`);
    console.log(`applied and recorded: ${migration.version}`);
  }
}

async function proveRemediationObjects() {
  console.log('\nProving the remediation objects on the live schema…');
  const proofs = await q('remediation proofs', `
    SELECT
      (SELECT pg_get_function_identity_arguments(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='builder_accept_current_terms'
       LIMIT 1) AS accept_args,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='builder_decide_org_join_request') AS decide_fn,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='builder_stock_acknowledge_announcement') AS ack_fn,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='builder_network_apply_inbound_events') AS sweep_fn,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='builder_terms_acceptances' AND column_name='acknowledgements') AS ack_column,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='workspace_connections' AND column_name='hmac_provisioned_at') AS provision_column,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
              AND table_name='builder_network_inbound_events' AND column_name='apply_error') AS apply_error_column,
      (SELECT count(*) FROM public.builder_portal_users u
       WHERE NOT EXISTS (SELECT 1 FROM public.builder_onboarding_steps s
                         WHERE s.builder_user_id = u.id)) AS users_without_onboarding`);
  const p = proofs[0] ?? {};
  const expectedArgs = '_builder_user_id uuid, _session_id uuid, _ip_hash text, _user_agent_hash text, _acknowledgements jsonb';
  if (p.accept_args !== expectedArgs) fail(`builder_accept_current_terms signature is "${p.accept_args}"`);
  for (const [key, label] of [
    ['decide_fn', 'builder_decide_org_join_request'],
    ['ack_fn', 'builder_stock_acknowledge_announcement'],
    ['sweep_fn', 'builder_network_apply_inbound_events'],
    ['ack_column', 'builder_terms_acceptances.acknowledgements'],
    ['provision_column', 'workspace_connections.hmac_provisioned_at'],
    ['apply_error_column', 'builder_network_inbound_events.apply_error'],
  ]) {
    if (p[key] !== true) fail(`${label} is missing on the live project`);
  }
  if (Number(p.users_without_onboarding) !== 0) {
    fail(`${p.users_without_onboarding} live user(s) still hold zero onboarding rows`);
  }

  const agreement = await q('agreement row', `
    SELECT version, document_hash, length(content_markdown) AS content_length
    FROM public.builder_terms_versions
    WHERE portal = 'builder' AND retired_at IS NULL`);
  if (agreement.length !== 1) {
    fail(`expected exactly one current builder agreement, found ${agreement.length}`);
  } else {
    const row = agreement[0];
    note(`current agreement: version=${row.version} hash=${row.document_hash} length=${row.content_length}`);
    if (row.version !== '2026-08-07') fail(`current agreement version is ${row.version}`);
    if (row.document_hash !== AGREEMENT_HASH) fail('current agreement hash differs from the pinned prime cascade hash');
  }
}

async function ensureDriversAndVault(vaultNames) {
  console.log('\nEnsuring extensions, schedules and vault entries…');
  await q('extensions', `
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;`);

  await q('schedules', `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-inbound-apply-1min') THEN
          PERFORM cron.schedule(
            'builder-network-inbound-apply-1min',
            '* * * * *',
            $job$SELECT public.builder_network_apply_inbound_events(50);$job$);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-network-outbox-worker-1min') THEN
          PERFORM cron.schedule(
            'builder-network-outbox-worker-1min',
            '* * * * *',
            $job$SELECT public.cron_invoke_signed_function('builder-network-outbox-worker', '{}'::jsonb, 'pg_cron');$job$);
        END IF;
      END IF;
    END $$;`);

  const createSecret = async (name, value) => {
    if (vaultNames.has(name)) { note(`vault: ${name} already present`); return; }
    if (!value) { fail(`vault: ${name} is missing and no source value is available to this run`); return; }
    const tag = dollarTag(value);
    await q(`vault create ${name}`, `SELECT vault.create_secret($${tag}$${value}$${tag}$, '${name}')`);
    note(`vault: ${name} created`);
  };

  await createSecret('supabase_url', `https://${PROJECT_REF}.supabase.co`);

  let anonKey = null;
  if (!vaultNames.has('supabase_anon_key')) {
    const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (response.ok) {
      const keys = await response.json();
      anonKey = (Array.isArray(keys) ? keys : []).find((k) => k.name === 'anon')?.api_key ?? null;
      if (!anonKey) note(`api-keys endpoint returned names: ${(Array.isArray(keys) ? keys : []).map((k) => k.name).join(', ')}`);
    } else {
      note(`api-keys endpoint answered ${response.status}; anon key not obtainable here`);
    }
  }
  await createSecret('supabase_anon_key', anonKey);
  // The same value the deploy workflow ships to the functions as
  // INTERNAL_EDGE_SECRET, so the SQL signer and verifyInternal agree.
  await createSecret('internal_edge_secret', INTERNAL_SECRET);

  const jobs = await q('cron jobs after', `
    SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'builder-network-%' ORDER BY jobname`);
  console.log('Network cron jobs now:');
  for (const row of jobs) note(`${row.jobname}  [${row.schedule}]  active=${row.active}`);
  if (jobs.length !== 2) fail(`expected 2 network cron jobs, found ${jobs.length}`);

  const health = await q('cron recent runs', `
    SELECT j.jobname, d.status, left(coalesce(d.return_message, ''), 120) AS message, d.start_time
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname LIKE 'builder-network-%'
    ORDER BY d.start_time DESC LIMIT 10`).catch(() => []);
  console.log('Recent network cron runs (may be empty right after scheduling):');
  for (const row of health) note(`${row.start_time}  ${row.jobname}  ${row.status}  ${row.message}`);
}

// ---------------------------------------------------------------------------
console.log(`production-rollout phase=${phase} project=${PROJECT_REF}`);
const { pending, ledgerColumns } = await preflight();
const { vaultNames } = await statusSnapshot();

if (phase === 'verify') {
  console.log('\nverify complete — nothing was changed.');
  process.exit(0);
}

if (!pending.length) {
  console.log('\nnothing pending — proceeding to proofs, drivers and vault.');
} else {
  await applyPending(pending, ledgerColumns);
}
await proveRemediationObjects();
await ensureDriversAndVault(vaultNames);

if (failures.length) {
  console.error(`\n${failures.length} failure(s) — the rollout is NOT complete.`);
  process.exit(1);
}
console.log('\nrollout apply complete: migrations recorded, objects proven, drivers scheduled.');
