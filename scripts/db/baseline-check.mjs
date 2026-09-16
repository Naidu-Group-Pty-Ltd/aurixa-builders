#!/usr/bin/env node
/**
 * Prove the consolidated baseline stands alone.
 *
 * build-baseline.mjs derives the baseline from the prime's corpus and writes
 * the catalog fingerprint of the database it built. THIS script needs no
 * prime at all: a fresh database gets the Supabase-compatible bootstrap and
 * then the baseline file, alone — and must land on the very same
 * fingerprint. That equality is the extraction plan's acceptance for the
 * squash ("applying it against Part 1 alone must succeed"), made stricter:
 * the baseline carries Part 1 itself, so it applies against NOTHING but the
 * platform bootstrap, and not just "succeeds" but reproduces the corpus
 * end-state to the constraint definition and the function body.
 *
 * It then re-asserts the reshape's guarantees against the rebuilt database,
 * because a fingerprint match proves equality with what was built, and the
 * assertions prove what was built is what the plan requires — two different
 * claims, both worth holding:
 *
 *   - no clone object under any name, in relations OR function sources;
 *   - every foreign key lands inside the network;
 *   - RLS enabled on every public table;
 *   - the corpus seeds arrived (a permission catalogue of zero rows denies
 *     everything while looking healthy);
 *   - the scope vocabulary holds exactly the seven planned keys.
 *
 * Runs in CI on every push. Same env contract as the prime's harness:
 * LOCAL_PG_HOST (default /tmp), LOCAL_PG_PORT (55432), LOCAL_PG_USER
 * (postgres).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogFingerprint } from './catalog-fingerprint.mjs';

const here = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(here, '../..');

const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.BASELINE_CHECK_DB || 'aurixa_builders_baseline_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PGPASSWORD: '' },
});
const query = (sql) => psql(['-d', DB, '-At', '-c', sql]).trim();

const failures = [];

console.log(`Rebuilding from the baseline alone on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(here, '00-supabase-bootstrap.sql')]);
// public belongs to the migrations, exactly as on a hosted project. The
// bootstrap's public-schema stand-ins exist only so the PRIME's harness can
// replay a raw corpus; the baseline carries everything the network's public
// schema holds, so the check hands it a public schema with nothing in it —
// and a baseline that needed anything else would fail right here.
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
console.log('baseline applied against the bootstrap alone.');

// --- 1. The fingerprint ------------------------------------------------------
const recorded = readFileSync(
  join(repoRoot, 'supabase/migrations/.baseline-fingerprint'), 'utf8',
).trim().split(/\s+/)[0];
const rebuilt = catalogFingerprint([...conn, '-d', DB]);
if (rebuilt.hash !== recorded) {
  failures.push(
    `catalog fingerprint diverged: baseline rebuild ${rebuilt.hash.slice(0, 16)}… `
    + `vs recorded ${recorded.slice(0, 16)}… — the baseline file and the build `
    + 'that produced it no longer describe one schema. Rebuild with '
    + 'build-baseline.mjs rather than editing either by hand.',
  );
} else {
  console.log(`fingerprint matches the build: ${rebuilt.hash.slice(0, 16)}… (${rebuilt.lines} catalog lines)`);
}

// --- 1b. Follow-on migrations ------------------------------------------------
// The repository may carry migrations AFTER the baseline (the baseline is the
// squash of the prime's corpus; network-native changes land as ordinary
// files). The fingerprint above is asserted BEFORE they apply — it pins the
// squash — and every later assertion runs AFTER, so the boundary, RLS and
// seed proofs hold over the schema a fresh deployment would actually get.
const followOn = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f !== '00000000000000_network_baseline.sql')
  .sort();
for (const file of followOn) {
  psql(['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(repoRoot, 'supabase/migrations', file)]);
  console.log(`follow-on migration applied: ${file}`);
}

// --- 2. The reshape's guarantees, re-proven on the rebuilt database ----------
const badRelations = query(`
  SELECT coalesce(string_agg(relname, ', '), '')
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'v')
    AND (c.relname IN (
      'clients','client_deals','legal_matters','purchase_files',
      'transaction_cases','transaction_case_links','transaction_case_link_history',
      'dashboard_modules','custom_users','user_permissions',
      'document_records','document_versions',
      'portal_terms_versions','portal_terms_acceptances',
      'builder_stock_selections')
      OR c.relname LIKE 'cross\\_portal\\_%')`);
if (badRelations) failures.push(`clone relations present: ${badRelations}`);

const badFunctions = query(`
  SELECT coalesce(string_agg(p.proname, ', '), '')
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosrc ~* '\\m(clients|client_deals|legal_matters|purchase_files|transaction_cases|transaction_case_links|transaction_case_link_history|dashboard_modules|custom_users|user_permissions|document_records|document_versions|portal_terms_versions|portal_terms_acceptances|builder_stock_selections|cross_portal_[a-z_]+)\\M'`);
if (badFunctions) failures.push(`functions naming clone objects: ${badFunctions}`);

const escapedFks = query(`
  SELECT coalesce(string_agg(DISTINCT c.confrelid::regclass::text, ', '), '')
  FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_namespace ns ON ns.oid = cl.relnamespace
  WHERE c.contype = 'f' AND ns.nspname = 'public'
    AND c.confrelid::regclass::text !~ '^(public\\.)?(builder_|workspace_|connection_|feature_flags|portal_operational_|integration_|document_processing_jobs)'
    AND c.confrelid <> 'storage.buckets'::regclass`);
if (escapedFks) failures.push(`foreign keys leaving the network: ${escapedFks}`);

const noRls = query(`
  SELECT coalesce(string_agg(relname, ', '), '')
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
if (noRls) failures.push(`tables without RLS: ${noRls}`);

// --- 3. Seeds and vocabulary --------------------------------------------------
const seedChecks = [
  ['builder_permission_keys', 1],
  ['builder_role_default_permissions', 1],
  ['builder_transaction_pipeline_stages', 1],
  ['connection_scope_keys', 7],
];
for (const [table, atLeast] of seedChecks) {
  const n = Number(query(`SELECT count(*) FROM public.${table}`));
  if (!(n >= atLeast)) {
    failures.push(`${table}: expected at least ${atLeast} seeded row(s), found ${n}`);
  }
}
const scopeCount = Number(query('SELECT count(*) FROM public.connection_scope_keys'));
if (scopeCount !== 7) failures.push(`scope vocabulary must be exactly 7 keys, found ${scopeCount}`);

const buckets = query(`SELECT string_agg(id, ',' ORDER BY id) FROM storage.buckets`);
if (buckets !== 'builder-documents,builder-stock-images,builder-stock-lists') {
  failures.push(`storage buckets are ${buckets || '(none)'} — expected the network's three`);
}

const tableCount = Number(query(`
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'builder\\_%'`));
console.log(`builder_* tables: ${tableCount}; buckets: ${buckets}`);

// --- 4. Runtime contracts ------------------------------------------------
// The extraction's own failure class: CI was green while the Edge runtime
// named objects the squash had renamed (portal_terms_*) or withdrawn
// (builder_stock_selections), because nothing ever held the runtime's SQL
// against the standalone schema. This section does, two ways.
//
// 4a. LITERAL EXISTENCE. Every `.from('…')` table and `.rpc('…')` function
// named by the ACTIVE runtime must exist in the rebuilt schema. The scan
// covers the active function entrypoints and the data-plane shared modules
// they use. Deliberately excluded, with the reason on record:
//   * auth.ts / auth_v2.ts / authz.ts — carried from the prime for their
//     helpers (CORS, cookies, verifyInternal); their staff-JWT paths name
//     Command Centre tables no active function calls. The three-name ban in
//     scripts/security/check-runtime-schema-refs.mjs still covers them.
//   * the withdrawn modules' functions and shared files (inventory,
//     transactions, construction, delivery, documents) — deliberately
//     withdrawn surfaces are not the ACTIVE runtime.
const ACTIVE_FUNCTION_DIRS = [
  'builder-portal-login', 'builder-portal-logout', 'builder-portal-verify',
  'builder-portal-register', 'builder-portal-verify-email', 'builder-portal-accept-invite',
  'builder-portal-forgot-password', 'builder-portal-reset-password', 'builder-portal-change-password',
  'builder-portal-invite', 'builder-portal-workspace', 'builder-portal-stock',
  'builder-portal-projects', 'builder-portal-collaboration',
  'builder-network-admin', 'builder-network-connections', 'builder-network-inbound',
  'builder-network-outbox-worker', 'builder-stock-image-settler', 'builder-stock-link-callback',
];
const ACTIVE_SHARED = [
  'builderPortalAuth.ts', 'builderSessions.ts', 'authRateLimit.ts',
  'publicAbuseControls.ts', 'brand-config.ts', 'googleMapsDailyCaps.ts',
  'logApiUsage.ts', 'llmRouter.ts', 'anthropicCredential.ts', 'meteredFetch.ts',
  'builderWorkspace.ts', 'builderProjects.ts', 'builderCollaboration.ts',
];
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  // Storage buckets share the .from() spelling but live in another namespace.
  .replace(/\.storage\s*\.\s*from\([^)]*\)/g, ' ');
const activeFiles = [
  ...ACTIVE_FUNCTION_DIRS.map((fn) => join(repoRoot, 'supabase/functions', fn, 'index.ts')),
  ...ACTIVE_SHARED.map((f) => join(repoRoot, 'supabase/functions/_shared', f)),
  ...readdirSync(join(repoRoot, 'supabase/functions/_shared/builderStock'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(repoRoot, 'supabase/functions/_shared/builderStock', f)),
];
const referencedTables = new Map();
const referencedRpcs = new Map();
for (const file of activeFiles) {
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/\.from\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
    referencedTables.set(match[1], file);
  }
  for (const match of source.matchAll(/\.rpc\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
    referencedRpcs.set(match[1], file);
  }
}
for (const [table, file] of [...referencedTables.entries()].sort()) {
  const exists = query(`SELECT to_regclass('public.${table}') IS NOT NULL`);
  if (exists !== 't') {
    failures.push(`active runtime reads table "${table}" which the schema does not carry (${file.replace(repoRoot + '/', '')})`);
  }
}
for (const [fn, file] of [...referencedRpcs.entries()].sort()) {
  const exists = query(`
    SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '${fn}')`);
  if (exists !== 't') {
    failures.push(`active runtime calls rpc "${fn}" which the schema does not carry (${file.replace(repoRoot + '/', '')})`);
  }
}
console.log(`runtime literals proven: ${referencedTables.size} tables, ${referencedRpcs.size} rpcs across ${activeFiles.length} active files`);

// 4b. FLOW PROOFS. Representative runtime DB contracts exercised end to end
// against the rebuilt schema, each self-contained. A RAISE inside a proof
// fails the check with the proof's own message.
const proof = (name, sql) => {
  try {
    psql(['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    console.log(`flow proven: ${name}`);
  } catch (error) {
    const stderr = String(error.stderr || error.message || error);
    failures.push(`${name}: ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
  }
};

proof('terms acceptance records the acknowledgment history, once', `
DO $proof$
DECLARE v_org uuid; v_user uuid; v_session uuid; v_result record; v_ack jsonb;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Terms Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_portal_users(email, name, status, is_active, email_verified_at)
  VALUES ('terms-proof@example.test', 'Terms Proof', 'active', true, now()) RETURNING id INTO v_user;
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (v_user, v_org, 'owner', true, 'active');
  INSERT INTO public.builder_portal_sessions(builder_user_id, token_hash, absolute_expires_at, idle_expires_at)
  VALUES (v_user, repeat('a', 64), now() + interval '1 hour', now() + interval '1 hour')
  RETURNING id INTO v_session;

  SELECT * INTO v_result FROM public.builder_accept_current_terms(
    v_user, v_session, NULL, NULL,
    '["global_confidentiality_privacy","authority_binding_acceptance","portal_access","binding_amlctf_arrangement"]'::jsonb);
  IF v_result.version IS DISTINCT FROM '2026-08-07' THEN
    RAISE EXCEPTION 'accepted version % rather than the seeded agreement', v_result.version;
  END IF;
  SELECT acknowledgements INTO v_ack FROM public.builder_terms_acceptances
  WHERE builder_user_id = v_user AND terms_version_id = v_result.terms_version_id;
  IF v_ack IS NULL OR jsonb_array_length(v_ack) <> 4 THEN
    RAISE EXCEPTION 'acknowledgment history not stored: %', v_ack;
  END IF;
  PERFORM public.builder_accept_current_terms(v_user, v_session, NULL, NULL, '["portal_access"]'::jsonb);
  IF (SELECT count(*) FROM public.builder_terms_acceptances WHERE builder_user_id = v_user) <> 1 THEN
    RAISE EXCEPTION 'a second acceptance row was stored for one user and version';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_terms_acceptances a
    JOIN public.builder_terms_versions v ON v.id = a.terms_version_id AND v.retired_at IS NULL
    WHERE a.builder_user_id = v_user
  ) THEN
    RAISE EXCEPTION 'the derived session-restore read does not see the acceptance';
  END IF;
  IF (SELECT count(*) FROM (
        SELECT id, version, title, content_markdown, document_hash, effective_at
        FROM public.builder_terms_versions
        WHERE portal = 'builder' AND retired_at IS NULL) shape) <> 1 THEN
    RAISE EXCEPTION 'the get_governance projection does not read';
  END IF;
END $proof$;`);

proof('onboarding steps exist and complete for every door', `
DO $proof$
DECLARE v_user uuid; v_session uuid;
BEGIN
  INSERT INTO public.builder_portal_users(email, name, status, is_active, email_verified_at)
  VALUES ('onboarding-proof@example.test', 'Onboarding Proof', 'active', true, now()) RETURNING id INTO v_user;
  PERFORM public.builder_ensure_onboarding_steps(v_user);
  IF (SELECT count(*) FROM public.builder_onboarding_steps WHERE builder_user_id = v_user AND mandatory) <> 4 THEN
    RAISE EXCEPTION 'ensure did not seed the four mandatory steps';
  END IF;
  INSERT INTO public.builder_portal_sessions(builder_user_id, token_hash, absolute_expires_at, idle_expires_at)
  VALUES (v_user, repeat('b', 64), now() + interval '1 hour', now() + interval '1 hour')
  RETURNING id INTO v_session;
  PERFORM public.builder_complete_onboarding(v_user, v_session, NULL);
  IF EXISTS (SELECT 1 FROM public.builder_onboarding_steps
             WHERE builder_user_id = v_user AND mandatory AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'complete-all left a mandatory step open';
  END IF;
  -- The zero-rows-for-anyone claim is asserted at migration time by
  -- 20260915110000 (other proofs here legitimately mint bare fixture users).
END $proof$;`);

proof('join requests: owner decides, duplicates refuse, cross-org probes miss', `
DO $proof$
DECLARE
  v_org uuid; v_other_org uuid; v_owner uuid; v_member uuid;
  v_applicant uuid; v_applicant2 uuid; v_applicant3 uuid;
  v_request uuid; v_request2 uuid; v_request3 uuid;
  v_decided record; v_caught boolean;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Join Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Join Proof Other Org', 'builder', 'active', true, now()) RETURNING id INTO v_other_org;
  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('join-owner@example.test', 'Join Owner', 'active', true) RETURNING id INTO v_owner;
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (v_owner, v_org, 'owner', true, 'active');
  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('join-member@example.test', 'Join Member', 'active', true) RETURNING id INTO v_member;
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (v_member, v_org, 'member', true, 'active');

  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('join-applicant@example.test', 'Join Applicant', 'active', true) RETURNING id INTO v_applicant;
  INSERT INTO public.builder_org_join_requests(organisation_id, builder_user_id)
  VALUES (v_org, v_applicant) RETURNING id INTO v_request;

  -- Approve: membership arrives WITH the stamp, primary because it is their first.
  SELECT * INTO v_decided FROM public.builder_decide_org_join_request(v_request, v_org, v_owner, true);
  IF v_decided.request_status <> 'approved' OR NOT v_decided.membership_created THEN
    RAISE EXCEPTION 'approval did not stamp and grant (%; created %)', v_decided.request_status, v_decided.membership_created;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_organisation_memberships
    WHERE builder_user_id = v_applicant AND organisation_id = v_org
      AND membership_role = 'member' AND is_primary AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'approved membership missing or mis-shaped';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_org_join_requests
    WHERE id = v_request AND status = 'approved' AND decided_by = v_owner AND decided_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'decision stamp missing';
  END IF;

  -- Duplicate/concurrent decision: the second decider is told, not obeyed.
  v_caught := false;
  BEGIN
    PERFORM public.builder_decide_org_join_request(v_request, v_org, v_owner, false);
  EXCEPTION WHEN others THEN
    v_caught := SQLERRM LIKE '%BUILDER_JOIN_REQUEST_ALREADY_DECIDED%';
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'duplicate decision was not refused'; END IF;

  -- Cross-organisation probing reads as not-found.
  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('join-applicant2@example.test', 'Join Applicant Two', 'active', true) RETURNING id INTO v_applicant2;
  INSERT INTO public.builder_org_join_requests(organisation_id, builder_user_id)
  VALUES (v_other_org, v_applicant2) RETURNING id INTO v_request2;
  v_caught := false;
  BEGIN
    PERFORM public.builder_decide_org_join_request(v_request2, v_org, v_owner, true);
  EXCEPTION WHEN others THEN
    v_caught := SQLERRM LIKE '%BUILDER_JOIN_REQUEST_NOT_FOUND%';
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'a foreign organisation''s request was reachable'; END IF;

  -- A plain member may not decide.
  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('join-applicant3@example.test', 'Join Applicant Three', 'active', true) RETURNING id INTO v_applicant3;
  INSERT INTO public.builder_org_join_requests(organisation_id, builder_user_id)
  VALUES (v_org, v_applicant3) RETURNING id INTO v_request3;
  v_caught := false;
  BEGIN
    PERFORM public.builder_decide_org_join_request(v_request3, v_org, v_member, true);
  EXCEPTION WHEN others THEN
    v_caught := SQLERRM LIKE '%BUILDER_NOT_ORG_ADMIN%';
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'a member decided a join request'; END IF;

  -- Decline stamps and grants nothing.
  SELECT * INTO v_decided FROM public.builder_decide_org_join_request(v_request3, v_org, v_owner, false);
  IF v_decided.request_status <> 'declined' OR v_decided.membership_created THEN
    RAISE EXCEPTION 'decline mis-stamped (%; created %)', v_decided.request_status, v_decided.membership_created;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.builder_organisation_memberships
    WHERE builder_user_id = v_applicant3 AND organisation_id = v_org AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'decline granted a membership';
  END IF;
END $proof$;`);

proof('stock announcements: land, converge, refuse foreign stock, never regress', `
DO $proof$
DECLARE
  v_org uuid; v_other_org uuid; v_workspace uuid; v_connection uuid;
  v_item uuid; v_foreign_item uuid; v_ref uuid := gen_random_uuid();
  v_row record;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Announce Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Announce Foreign Org', 'builder', 'active', true, now()) RETURNING id INTO v_other_org;
  INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
  VALUES (gen_random_uuid(), 'announce-proof', 'Announce Proof Workspace') RETURNING id INTO v_workspace;
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  VALUES (v_workspace, v_org, 'active', 'workspace', now(), repeat('c', 64)) RETURNING id INTO v_connection;
  INSERT INTO public.builder_stock_items(organisation_id, address_line, suburb)
  VALUES (v_org, '1 Proof Street', 'Truganina') RETURNING id INTO v_item;
  INSERT INTO public.builder_stock_items(organisation_id, address_line, suburb)
  VALUES (v_other_org, '2 Foreign Street', 'Tarneit') RETURNING id INTO v_foreign_item;

  -- Announce lands in the ledger and the sweep converges it.
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.announced', 'proof:announce:1',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item,
                             'status', 'selected', 'remote_client_label', 'Buyer via Announce Proof'),
          1);
  PERFORM public.builder_network_apply_inbound_events(50);
  SELECT * INTO v_row FROM public.builder_stock_selection_announcements
  WHERE connection_id = v_connection AND remote_selection_ref = v_ref;
  IF v_row.id IS NULL OR v_row.status <> 'selected' OR v_row.organisation_id <> v_org THEN
    RAISE EXCEPTION 'announcement did not converge (status %, org %)', v_row.status, v_row.organisation_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.builder_network_inbound_events
             WHERE dedupe_key = 'proof:announce:1' AND processed_at IS NULL) THEN
    RAISE EXCEPTION 'applied event left unprocessed';
  END IF;

  -- Re-running the sweep changes nothing (replayable ledger).
  PERFORM public.builder_network_apply_inbound_events(50);
  IF (SELECT count(*) FROM public.builder_stock_selection_announcements
      WHERE connection_id = v_connection) <> 1 THEN
    RAISE EXCEPTION 'replay duplicated the announcement';
  END IF;

  -- A later version moves the status forward…
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.updated', 'proof:announce:2',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item, 'status', 'progressed'), 2);
  PERFORM public.builder_network_apply_inbound_events(50);
  -- …and an out-of-order replay of an older version cannot wind it back.
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.updated', 'proof:announce:3',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item, 'status', 'withdrawn'), 1);
  PERFORM public.builder_network_apply_inbound_events(50);
  SELECT * INTO v_row FROM public.builder_stock_selection_announcements
  WHERE connection_id = v_connection AND remote_selection_ref = v_ref;
  IF v_row.status <> 'progressed' OR v_row.source_version <> 2 THEN
    RAISE EXCEPTION 'stale replay regressed the announcement to % (v%)', v_row.status, v_row.source_version;
  END IF;

  -- Another organisation''s property is refused by name.
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.announced', 'proof:announce:4',
          jsonb_build_object('remote_selection_ref', gen_random_uuid(), 'stock_item_id', v_foreign_item, 'status', 'selected'), 1);
  PERFORM public.builder_network_apply_inbound_events(50);
  IF NOT EXISTS (SELECT 1 FROM public.builder_network_inbound_events
                 WHERE dedupe_key = 'proof:announce:4'
                   AND processed_at IS NOT NULL AND apply_error = 'stock_item_not_ours') THEN
    RAISE EXCEPTION 'a foreign property crossed the organisation boundary';
  END IF;
  IF (SELECT count(*) FROM public.builder_stock_selection_announcements
      WHERE stock_item_id = v_foreign_item) <> 0 THEN
    RAISE EXCEPTION 'a foreign property gained an announcement';
  END IF;

  -- Unknown vocabulary is terminal, visible and replayable — never a wedge.
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.mystery', 'proof:announce:5', '{}'::jsonb, 1);
  PERFORM public.builder_network_apply_inbound_events(50);
  IF NOT EXISTS (SELECT 1 FROM public.builder_network_inbound_events
                 WHERE dedupe_key = 'proof:announce:5'
                   AND processed_at IS NOT NULL AND apply_error LIKE 'unhandled_event_type:%') THEN
    RAISE EXCEPTION 'an unknown event type did not mark itself';
  END IF;
END $proof$;`);

proof('activation fans out: project opened+granted, task assigned, member notified, idempotent, withdrawal cancels', `
DO $proof$
DECLARE
  v_org uuid; v_workspace uuid; v_connection uuid; v_item uuid;
  v_user uuid; v_second uuid; v_ref uuid := gen_random_uuid();
  v_a record; v_task record; v_n record; v_res record; v_project record;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Fanout Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_portal_users(email, name, phone, status, is_active)
  VALUES ('fanout-owner@example.test', 'Fanout Owner', '0400 111 222', 'active', true) RETURNING id INTO v_user;
  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('fanout-second@example.test', 'Fanout Second', 'active', true) RETURNING id INTO v_second;
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, status)
  VALUES (v_user, v_org, 'owner', 'active'), (v_second, v_org, 'member', 'active');
  INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
  VALUES (gen_random_uuid(), 'fanout-proof', 'Fanout Realty') RETURNING id INTO v_workspace;
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  VALUES (v_workspace, v_org, 'active', 'workspace', now(), repeat('e', 64)) RETURNING id INTO v_connection;
  INSERT INTO public.builder_stock_items(organisation_id, address_line, suburb, state)
  VALUES (v_org, 'Lot 9 Fanout Rise', 'Berwick', 'VIC') RETURNING id INTO v_item;

  -- The announcement arrives carrying the agency's authorised disclosure.
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.announced', 'proof:fanout:1',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item,
                             'status', 'selected', 'remote_client_label', 'Buyer F1',
                             'agency', jsonb_build_object('contact_name', 'Ava Adviser',
                               'contact_email', 'ava@fanout.example', 'contact_phone', '03 9000 0000')),
          1);
  PERFORM public.builder_network_apply_inbound_events(50);

  SELECT * INTO v_a FROM public.builder_stock_selection_announcements
  WHERE connection_id = v_connection AND remote_selection_ref = v_ref;
  IF v_a.id IS NULL OR v_a.activation_task_id IS NULL THEN
    RAISE EXCEPTION 'the activation did not fan out (announcement %, task %)', v_a.id, v_a.activation_task_id;
  END IF;
  IF v_a.agency_contact->>'contact_email' <> 'ava@fanout.example' THEN
    RAISE EXCEPTION 'the agency contact did not land (%)', v_a.agency_contact;
  END IF;
  -- The agency name resolves from the directory when the event carries none.
  SELECT * INTO v_task FROM public.builder_tasks WHERE id = v_a.activation_task_id;
  IF v_task.scope_type <> 'stock_item' OR v_task.scope_id <> v_item
     OR v_task.status <> 'open' OR v_task.priority <> 'high' THEN
    RAISE EXCEPTION 'the task is mis-shaped (%/% % %)', v_task.scope_type, v_task.scope_id, v_task.status, v_task.priority;
  END IF;
  IF position('Fanout Realty' IN v_task.description) = 0
     OR position('ava@fanout.example' IN v_task.description) = 0 THEN
    RAISE EXCEPTION 'the task does not name the agency and its contact: %', v_task.description;
  END IF;
  IF (SELECT count(*) FROM public.builder_task_assignments
      WHERE task_id = v_task.id AND unassigned_at IS NULL) <> 2 THEN
    RAISE EXCEPTION 'the task was not assigned to every active member';
  END IF;
  IF (SELECT count(*) FROM public.builder_notifications
      WHERE source_announcement_id = v_a.id AND notification_type = 'stock_selection'
        AND entity_kind = 'stock_selection') <> 2 THEN
    RAISE EXCEPTION 'the members were not notified';
  END IF;
  SELECT * INTO v_n FROM public.builder_notifications
  WHERE source_announcement_id = v_a.id AND builder_user_id = v_user;
  IF position('Fanout Realty' IN v_n.title) = 0 OR position('ava@fanout.example' IN v_n.body) = 0 THEN
    RAISE EXCEPTION 'the notification does not say who activated (% / %)', v_n.title, v_n.body;
  END IF;

  -- THE PROJECT: the activation opened a working record — named from the
  -- property, planning, summarised with the agency, linked both ways.
  IF v_a.activation_project_id IS NULL THEN
    RAISE EXCEPTION 'the activation did not open a project';
  END IF;
  SELECT * INTO v_project FROM public.builder_projects WHERE id = v_a.activation_project_id;
  IF v_project.status <> 'planning' OR v_project.builder_organisation_id <> v_org
     OR position('Lot 9 Fanout Rise' IN v_project.name) = 0 OR v_project.suburb <> 'Berwick'
     OR v_project.state <> 'VIC' THEN
    RAISE EXCEPTION 'the project is mis-shaped (% / % / %)', v_project.name, v_project.status, v_project.suburb;
  END IF;
  IF position('Fanout Realty' IN COALESCE(v_project.shared_summary, '')) = 0 THEN
    RAISE EXCEPTION 'the project summary does not say who opened it: %', v_project.shared_summary;
  END IF;
  IF (SELECT builder_project_id FROM public.builder_stock_items WHERE id = v_item) IS DISTINCT FROM v_project.id THEN
    RAISE EXCEPTION 'the stock item is not linked to the project';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_project_status_history
                 WHERE project_id = v_project.id AND to_status = 'planning'
                   AND from_status IS NULL AND changed_by_type = 'system') THEN
    RAISE EXCEPTION 'the project opening was not recorded in its history';
  END IF;
  -- Granted to every active member, with roles that follow their standing —
  -- resolved through the SAME dispatcher the portal lists projects with.
  IF (SELECT count(*) FROM public.builder_project_access
      WHERE project_id = v_project.id AND revoked_at IS NULL) <> 2 THEN
    RAISE EXCEPTION 'project access was not granted to every active member';
  END IF;
  IF (SELECT access_role FROM public.builder_project_access
      WHERE project_id = v_project.id AND builder_user_id = v_user) <> 'responsible'
     OR (SELECT access_role FROM public.builder_project_access
         WHERE project_id = v_project.id AND builder_user_id = v_second) <> 'team_member' THEN
    RAISE EXCEPTION 'access roles do not follow membership roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_accessible_projects(v_user, v_org, 'projects') p
                 WHERE p.project_id = v_project.id)
     OR NOT EXISTS (SELECT 1 FROM public.builder_accessible_projects(v_second, v_org, 'projects') p
                    WHERE p.project_id = v_project.id) THEN
    RAISE EXCEPTION 'a member cannot see the project their activation opened';
  END IF;
  IF EXISTS (SELECT 1 FROM public.builder_accessible_projects(gen_random_uuid(), v_org, 'projects') p
             WHERE p.project_id = v_project.id) THEN
    RAISE EXCEPTION 'a stranger can see the activation project';
  END IF;

  -- The member reaches the task through the same dispatchers the portal uses.
  IF NOT public.builder_resolve_scope_permission(v_user, 'stock_item', v_item, 'tasks', 'view') THEN
    RAISE EXCEPTION 'an active member cannot view the stock task scope';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_accessible_tasks(v_user, NULL, NULL) t
                 WHERE t.task_id = v_task.id) THEN
    RAISE EXCEPTION 'builder_accessible_tasks does not surface the activation task';
  END IF;
  -- And nobody outside the organisation does.
  IF public.builder_resolve_scope_permission(gen_random_uuid(), 'stock_item', v_item, 'tasks', 'view') THEN
    RAISE EXCEPTION 'a stranger resolved the stock task scope';
  END IF;
  -- Tasks only: the scope answers nothing for documents or messages.
  IF public.builder_resolve_scope_permission(v_user, 'stock_item', v_item, 'documents', 'view') THEN
    RAISE EXCEPTION 'the stock scope opened documents';
  END IF;

  -- Replay and a racing second fan-out create nothing new.
  PERFORM public.builder_network_apply_inbound_events(50);
  PERFORM public.builder_stock_activation_fanout(v_a.id);
  IF (SELECT count(*) FROM public.builder_tasks WHERE scope_type = 'stock_item' AND scope_id = v_item) <> 1
     OR (SELECT count(*) FROM public.builder_notifications WHERE source_announcement_id = v_a.id) <> 2
     OR (SELECT count(*) FROM public.builder_projects WHERE builder_organisation_id = v_org) <> 1 THEN
    RAISE EXCEPTION 'a replay duplicated the fan-out';
  END IF;

  -- Acknowledging is the act the task asked for, so it completes the task —
  -- and a later withdrawal keeps that answer rather than "cancelling" work
  -- that was done.
  PERFORM public.builder_stock_acknowledge_announcement(v_a.id, v_org, v_user);
  SELECT * INTO v_task FROM public.builder_tasks WHERE id = v_a.activation_task_id;
  IF v_task.status <> 'done' OR v_task.completed_at IS NULL THEN
    RAISE EXCEPTION 'acknowledging left its task % (completed %)', v_task.status, v_task.completed_at;
  END IF;
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.updated', 'proof:fanout:2',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item, 'status', 'withdrawn'), 2);
  PERFORM public.builder_network_apply_inbound_events(50);
  SELECT * INTO v_task FROM public.builder_tasks WHERE id = v_a.activation_task_id;
  IF v_task.status <> 'done' THEN
    RAISE EXCEPTION 'the withdrawal overwrote a completed task to %', v_task.status;
  END IF;
  -- The project was never edited or transitioned, so the withdrawal closes
  -- it — through the governed transition, with the reason on record.
  SELECT * INTO v_project FROM public.builder_projects WHERE id = v_a.activation_project_id;
  IF v_project.status <> 'cancelled' THEN
    RAISE EXCEPTION 'withdrawal left an untouched project %', v_project.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_project_status_history
                 WHERE project_id = v_project.id AND to_status = 'cancelled'
                   AND changed_by_type = 'system'
                   AND reason LIKE 'Activation withdrawn by %') THEN
    RAISE EXCEPTION 'the cancellation was not recorded with its reason';
  END IF;

  -- And on an activation nobody acknowledged, the withdrawal cancels the
  -- pending task it opened.
  v_ref := gen_random_uuid();
  INSERT INTO public.builder_stock_items(organisation_id, address_line, suburb, state)
  VALUES (v_org, 'Lot 10 Fanout Rise', 'Berwick', 'VIC') RETURNING id INTO v_item;
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.announced', 'proof:fanout:3',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item, 'status', 'selected'), 3);
  PERFORM public.builder_network_apply_inbound_events(50);
  SELECT a.* INTO v_a FROM public.builder_stock_selection_announcements a
  WHERE a.remote_selection_ref = v_ref;
  IF v_a.activation_project_id IS NULL THEN
    RAISE EXCEPTION 'the second activation did not open a project';
  END IF;
  -- The team starts working in the record before the agency withdraws: one
  -- write is enough to make the project theirs.
  UPDATE public.builder_projects
     SET builder_notes = 'site walk booked', row_version = row_version + 1
   WHERE id = v_a.activation_project_id;
  INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
  VALUES (v_connection, 'stock.selection.updated', 'proof:fanout:4',
          jsonb_build_object('remote_selection_ref', v_ref, 'stock_item_id', v_item, 'status', 'withdrawn'), 4);
  PERFORM public.builder_network_apply_inbound_events(50);
  SELECT t.* INTO v_task FROM public.builder_tasks t
  JOIN public.builder_stock_selection_announcements a ON a.activation_task_id = t.id
  WHERE a.remote_selection_ref = v_ref;
  IF v_task.status <> 'cancelled' THEN
    RAISE EXCEPTION 'the withdrawal left the unacknowledged task %', v_task.status;
  END IF;
  SELECT * INTO v_project FROM public.builder_projects WHERE id = v_a.activation_project_id;
  IF v_project.status <> 'planning' THEN
    RAISE EXCEPTION 'withdrawal cancelled a project the team had touched (%)', v_project.status;
  END IF;

  -- An activation that reached acknowledged before projects existed still
  -- gains its record when the fan-out visits it (the backfill path) — and
  -- the visit sends no new alerts.
  v_ref := gen_random_uuid();
  INSERT INTO public.builder_stock_items(organisation_id, address_line, suburb, state)
  VALUES (v_org, 'Lot 11 Fanout Rise', 'Berwick', 'VIC') RETURNING id INTO v_item;
  INSERT INTO public.builder_stock_selection_announcements(
    connection_id, stock_item_id, organisation_id, remote_selection_ref,
    status, source_version, acknowledged_at)
  VALUES (v_connection, v_item, v_org, v_ref, 'builder_acknowledged', 5, now())
  RETURNING id INTO v_a;
  PERFORM public.builder_stock_activation_fanout(v_a.id);
  SELECT a.* INTO v_a FROM public.builder_stock_selection_announcements a WHERE a.id = v_a.id;
  IF v_a.activation_project_id IS NULL THEN
    RAISE EXCEPTION 'the acknowledged activation did not gain its project';
  END IF;
  IF v_a.activation_task_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.builder_notifications WHERE source_announcement_id = v_a.id) THEN
    RAISE EXCEPTION 'ensuring the project re-alerted an acknowledged activation';
  END IF;
END $proof$;`);

proof('stock sync: projection events queue, raw row never crosses, reconcile is authoritative', `
DO $proof$
DECLARE
  v_org uuid; v_workspace uuid; v_connection uuid; v_item uuid;
  v_event record; v_payload jsonb; v_count integer;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, trading_name, org_type, status, is_active, activated_at)
  VALUES ('Sync Proof Org Pty Ltd', 'Sync Proof Homes', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
  VALUES (gen_random_uuid(), 'sync-proof', 'Sync Proof Workspace') RETURNING id INTO v_workspace;
  -- Invited first: activation is what backfills, and that transition is the
  -- next agency's whole onboarding.
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, outbound_hmac_secret)
  VALUES (v_workspace, v_org, 'invited', 'workspace', repeat('f', 64)) RETURNING id INTO v_connection;

  INSERT INTO public.builder_stock_items(
    organisation_id, address_line, suburb, state, lifecycle_status, price,
    source_row)
  VALUES (v_org, 'Lot 1 Sync Parade', 'Clyde', 'VIC', 'active', 650000,
          jsonb_build_object('house_design', 'NEX 18', 'Margin', 'NEVER-CROSSES'))
  RETURNING id INTO v_item;

  -- Nothing queued yet: the connection is not active.
  IF EXISTS (SELECT 1 FROM public.builder_network_outbox WHERE connection_id = v_connection) THEN
    RAISE EXCEPTION 'an invited connection received sync events';
  END IF;

  -- Activation backfills the catalogue and the reconcile, automatically.
  UPDATE public.workspace_connections SET state = 'active', accepted_at = now(), inbound_url = 'https://clone.example/functions/v1/builder-network-inbound'
  WHERE id = v_connection;
  SELECT count(*) INTO v_count FROM public.builder_network_outbox
  WHERE connection_id = v_connection AND event_type = 'stock.item.upserted';
  IF v_count < 1 THEN RAISE EXCEPTION 'activation did not backfill the catalogue'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_network_outbox
                 WHERE connection_id = v_connection AND event_type = 'stock.catalog.reconciled') THEN
    RAISE EXCEPTION 'activation did not queue the reconcile';
  END IF;

  -- The payload is the projection: the lifted key crosses, the raw row and
  -- its spreadsheet column names do not.
  SELECT payload INTO v_payload FROM public.builder_network_outbox
  WHERE connection_id = v_connection AND event_type = 'stock.item.upserted'
  ORDER BY created_at DESC LIMIT 1;
  IF v_payload->>'house_design' <> 'NEX 18' THEN
    RAISE EXCEPTION 'the lifted key did not cross (%)', v_payload->>'house_design';
  END IF;
  IF position('NEVER-CROSSES' IN v_payload::text) > 0 OR v_payload ? 'source_row' THEN
    RAISE EXCEPTION 'the builder''s raw row crossed the boundary';
  END IF;
  IF v_payload#>>'{organisation,trading_name}' <> 'Sync Proof Homes' THEN
    RAISE EXCEPTION 'the builder identity did not ride the event';
  END IF;
  IF v_payload ? 'primary_image' THEN
    RAISE EXCEPTION 'an item with no ready builder image claimed one';
  END IF;

  -- A projection change queues an incremental event; lease churn does not.
  SELECT count(*) INTO v_count FROM public.builder_network_outbox WHERE connection_id = v_connection;
  UPDATE public.builder_stock_items SET image_work_claim_until = now() WHERE id = v_item;
  IF (SELECT count(*) FROM public.builder_network_outbox WHERE connection_id = v_connection) <> v_count THEN
    RAISE EXCEPTION 'image-work lease churn crossed the wire';
  END IF;
  UPDATE public.builder_stock_items SET price = 660000 WHERE id = v_item;
  IF (SELECT count(*) FROM public.builder_network_outbox WHERE connection_id = v_connection) <> v_count + 1 THEN
    RAISE EXCEPTION 'a price change did not sync';
  END IF;

  -- The reconcile names exactly the active catalogue.
  PERFORM public.builder_network_enqueue_stock_reconcile(v_connection);
  SELECT payload INTO v_payload FROM public.builder_network_outbox
  WHERE connection_id = v_connection AND event_type = 'stock.catalog.reconciled'
  ORDER BY created_at DESC LIMIT 1;
  IF NOT (v_payload->'active_item_ids') @> to_jsonb(ARRAY[v_item]) THEN
    RAISE EXCEPTION 'the reconcile does not list the active item';
  END IF;
END $proof$;`);

proof('acknowledgement stamps the row and queues the outbound event atomically', `
DO $proof$
DECLARE
  v_org uuid; v_workspace uuid; v_connection uuid; v_item uuid;
  v_user uuid; v_ref uuid := gen_random_uuid(); v_announcement uuid;
  v_row record; v_caught boolean;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Ack Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.workspace_registry(mc_clone_id, slug)
  VALUES (gen_random_uuid(), 'ack-proof') RETURNING id INTO v_workspace;
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  VALUES (v_workspace, v_org, 'active', 'workspace', now(), repeat('d', 64)) RETURNING id INTO v_connection;
  INSERT INTO public.builder_stock_items(organisation_id, address_line)
  VALUES (v_org, '3 Ack Street') RETURNING id INTO v_item;
  INSERT INTO public.builder_portal_users(email, name, status, is_active)
  VALUES ('ack-proof@example.test', 'Ack Proof', 'active', true) RETURNING id INTO v_user;
  INSERT INTO public.builder_stock_selection_announcements(
    connection_id, stock_item_id, organisation_id, remote_selection_ref, status, source_version)
  VALUES (v_connection, v_item, v_org, v_ref, 'selected', 1) RETURNING id INTO v_announcement;

  SELECT * INTO v_row FROM public.builder_stock_acknowledge_announcement(v_announcement, v_org, v_user);
  IF v_row.status <> 'builder_acknowledged' OR v_row.acknowledged_by_builder_user_id <> v_user THEN
    RAISE EXCEPTION 'acknowledgement did not stamp (% by %)', v_row.status, v_row.acknowledged_by_builder_user_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_network_outbox
    WHERE connection_id = v_connection
      AND event_type = 'stock.selection.acknowledged'
      AND dedupe_key = 'stock.selection.acknowledged:' || v_connection || ':' || v_ref
      AND payload->>'remote_selection_ref' = v_ref::text
      AND payload->>'status' = 'builder_acknowledged'
  ) THEN
    RAISE EXCEPTION 'the outbound event did not commit with the stamp';
  END IF;
  IF (SELECT source_version FROM public.builder_network_stamps
      WHERE connection_id = v_connection AND side = 'outbound') < 1 THEN
    RAISE EXCEPTION 'the outbound stamp version did not advance';
  END IF;

  -- A second acknowledgement is refused, and no second event appears.
  v_caught := false;
  BEGIN
    PERFORM public.builder_stock_acknowledge_announcement(v_announcement, v_org, v_user);
  EXCEPTION WHEN others THEN
    v_caught := SQLERRM LIKE '%BUILDER_ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE%';
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'a second acknowledgement was accepted'; END IF;
  IF (SELECT count(*) FROM public.builder_network_outbox
      WHERE dedupe_key = 'stock.selection.acknowledged:' || v_connection || ':' || v_ref) <> 1 THEN
    RAISE EXCEPTION 'the acknowledgement queued twice';
  END IF;

  -- A forged organisation id reads as not-found.
  v_caught := false;
  BEGIN
    PERFORM public.builder_stock_acknowledge_announcement(v_announcement, gen_random_uuid(), v_user);
  EXCEPTION WHEN others THEN
    v_caught := SQLERRM LIKE '%BUILDER_ANNOUNCEMENT_NOT_FOUND%';
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'another organisation''s id reached the announcement'; END IF;
END $proof$;`);

proof('stock image invariant: blanks never publish, externals never qualify, failures never vanish', `
DO $proof$
DECLARE
  v_org uuid; v_upload uuid; v_item uuid; v_active uuid; v_blank uuid; v_strand uuid;
  v_web uuid; v_src uuid; v_workspace uuid; v_connection uuid;
  v_ready record; v_res jsonb; v_row record; v_caught boolean := false;
BEGIN
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Invariant Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status)
  VALUES (v_org, 'invariant.csv', 'proof/invariant.csv', 'enriching') RETURNING id INTO v_upload;
  IF (SELECT image_invariant FROM public.builder_stock_uploads WHERE id = v_upload) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'a new upload did not default onto the invariant';
  END IF;

  -- A staged property with no photograph blocks publication BY NAME.
  INSERT INTO public.builder_stock_items(organisation_id, upload_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, v_upload, 'staged', '9 Invariant Rise', 'Truganina') RETURNING id INTO v_item;
  SELECT * INTO v_ready FROM public.builder_stock_publication_readiness(v_upload);
  IF v_ready.ready OR v_ready.missing_primary <> 1 THEN
    RAISE EXCEPTION 'readiness passed a blank property (ready %, missing %)', v_ready.ready, v_ready.missing_primary;
  END IF;
  v_res := public.publish_builder_stock_upload(v_upload);
  IF (v_res->>'published')::boolean OR v_res->>'reason' <> 'not_ready' THEN
    RAISE EXCEPTION 'a blank stock list published (%)', v_res;
  END IF;
  IF (SELECT publication_blocked_reason FROM public.builder_stock_uploads WHERE id = v_upload) IS NULL THEN
    RAISE EXCEPTION 'the refusal left no reason on the upload';
  END IF;

  -- The retired legacy flag reopens nothing. A settled blank under
  -- image_invariant=false is EXACTLY the shape the pre-invariant branch
  -- published ("no staged item still reading its source"); it must refuse.
  UPDATE public.builder_stock_uploads SET image_invariant = false WHERE id = v_upload;
  UPDATE public.builder_stock_items SET image_work_stage = 'settled' WHERE id = v_item;
  SELECT * INTO v_ready FROM public.builder_stock_publication_readiness(v_upload);
  IF v_ready.ready THEN
    RAISE EXCEPTION 'image_invariant=false reopened the legacy publication branch';
  END IF;
  UPDATE public.builder_stock_uploads SET image_invariant = true WHERE id = v_upload;
  UPDATE public.builder_stock_items SET image_work_stage = 'source' WHERE id = v_item;

  -- The claim carries a lease and NOTHING punitive; a failed completion buys
  -- bounded backoff and one counted failure.
  UPDATE public.builder_stock_items SET image_work_next_attempt_at = now() WHERE id = v_item;
  PERFORM * FROM public.claim_builder_stock_image_work(1, 60, v_org);
  SELECT * INTO v_row FROM public.builder_stock_items WHERE id = v_item;
  IF v_row.image_work_claim_until IS NULL OR v_row.image_work_next_attempt_at > now() + interval '2 seconds' THEN
    RAISE EXCEPTION 'the claim wrote punitive backoff (next %)', v_row.image_work_next_attempt_at;
  END IF;
  PERFORM public.complete_builder_stock_image_work(v_item, NULL, 'proof failure', 'x', 0, false, true);
  SELECT * INTO v_row FROM public.builder_stock_items WHERE id = v_item;
  IF v_row.image_work_failures <> 1
     OR v_row.image_work_next_attempt_at NOT BETWEEN now() + interval '20 seconds' AND now() + interval '40 seconds' THEN
    RAISE EXCEPTION 'a failed completion did not buy the bounded backoff (failures %, next %)',
      v_row.image_work_failures, v_row.image_work_next_attempt_at;
  END IF;

  -- A verified WEB photograph is not client visibility and is not readiness.
  INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, address_line, suburb)
  VALUES (v_org, 'active', '11 Invariant Rise', 'Truganina') RETURNING id INTO v_active;
  INSERT INTO public.builder_stock_item_images(organisation_id, stock_item_id, source_stage,
    source_reference, verification_status, processing_status, external_url)
  VALUES (v_org, v_active, 'internet_search', 'proof-web', 'property_identity_verified', 'ready',
    'https://example.com/not-this-house.jpg') RETURNING id INTO v_web;
  UPDATE public.builder_stock_items SET primary_image_id = v_web WHERE id = v_active;
  IF public.builder_stock_item_client_visible(v_active) THEN
    RAISE EXCEPTION 'a web photograph satisfied client visibility';
  END IF;

  -- The publications boundary refuses what the predicate refuses.
  INSERT INTO public.workspace_registry(mc_clone_id, slug, display_name)
  VALUES (gen_random_uuid(), 'invariant-proof', 'Invariant Proof Workspace') RETURNING id INTO v_workspace;
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  VALUES (v_workspace, v_org, 'active', 'workspace', now(), repeat('d', 64)) RETURNING id INTO v_connection;
  BEGIN
    INSERT INTO public.builder_stock_publications(stock_item_id, connection_id, organisation_id)
    VALUES (v_active, v_connection, v_org);
  EXCEPTION WHEN others THEN
    v_caught := SQLERRM LIKE '%STOCK_ITEM_NOT_CLIENT_VISIBLE%';
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'a web-primary item was offered to a connection'; END IF;

  -- The builder's own READY photograph is the whole of the requirement.
  INSERT INTO public.builder_stock_item_images(organisation_id, stock_item_id, source_stage,
    source_reference, verification_status, processing_status, storage_path)
  VALUES (v_org, v_active, 'uploaded_document', 'proof-src', 'source_supplied', 'ready',
    'proof/facade.jpg') RETURNING id INTO v_src;
  UPDATE public.builder_stock_items SET primary_image_id = v_src WHERE id = v_active;
  IF NOT public.builder_stock_item_client_visible(v_active) THEN
    RAISE EXCEPTION 'a ready builder-source photograph did not satisfy visibility';
  END IF;
  INSERT INTO public.builder_stock_publications(stock_item_id, connection_id, organisation_id)
  VALUES (v_active, v_connection, v_org);

  -- The watchdog: a served blank that settled is re-opened; an archived
  -- strand is closed; nothing is deleted.
  INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, address_line,
    image_work_stage, image_work_updated_at)
  VALUES (v_org, 'active', '13 Invariant Rise', 'settled', now() - interval '11 minutes')
  RETURNING id INTO v_blank;
  INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, address_line, image_work_stage)
  VALUES (v_org, 'archived', '15 Invariant Rise', 'eligibility') RETURNING id INTO v_strand;
  PERFORM public.builder_stock_image_watchdog();
  IF (SELECT image_work_stage FROM public.builder_stock_items WHERE id = v_blank) <> 'source' THEN
    RAISE EXCEPTION 'a served blank stayed settled past the watchdog';
  END IF;
  IF (SELECT image_work_stage FROM public.builder_stock_items WHERE id = v_strand) <> 'settled' THEN
    RAISE EXCEPTION 'an archived strand stayed in the queue';
  END IF;

  -- 100%% coverage publishes; below it never did. The staged property earns
  -- its photograph, settles, and the cutover promotes it.
  INSERT INTO public.builder_stock_item_images(organisation_id, stock_item_id, upload_id, source_stage,
    source_reference, verification_status, processing_status, storage_path)
  VALUES (v_org, v_item, v_upload, 'uploaded_document', 'proof-staged-src', 'source_supplied', 'ready',
    'proof/staged.jpg') RETURNING id INTO v_src;
  UPDATE public.builder_stock_items
     SET primary_image_id = v_src, image_work_stage = 'settled'
   WHERE id = v_item;
  SELECT * INTO v_ready FROM public.builder_stock_publication_readiness(v_upload);
  IF NOT v_ready.ready THEN
    RAISE EXCEPTION 'full coverage did not read ready (missing %, failed %)', v_ready.missing_primary, v_ready.failed_items;
  END IF;
  v_res := public.publish_builder_stock_upload(v_upload);
  IF NOT (v_res->>'published')::boolean THEN
    RAISE EXCEPTION 'a fully covered stock list did not publish (%)', v_res;
  END IF;
  IF (SELECT lifecycle_status FROM public.builder_stock_items WHERE id = v_item) <> 'active'
     OR NOT public.builder_stock_item_client_visible(v_item) THEN
    RAISE EXCEPTION 'the published property is not a client-visible builder photograph';
  END IF;
  IF (SELECT publication_blocked_reason FROM public.builder_stock_uploads WHERE id = v_upload) IS NOT NULL THEN
    RAISE EXCEPTION 'publication left its refusal standing';
  END IF;
END $proof$;`);

// 4c. SECURITY PROOFS. The remediation of 17 Sep 2026 has exactly two claims a
// catalog cannot make on its own: that the privileged surface answers only to
// service_role, and that a child write cannot escape the parent the caller was
// authorised for. Both are proven here by EXECUTION, against the schema a
// fresh deployment would get, so a later migration that reopens either one
// fails this check rather than production.

proof('privileged functions answer to service_role and to nobody else', `
DO $proof$
DECLARE
  v_open text; v_missing text;
  v_denied boolean := false;
  v_org uuid; v_project uuid; v_stage uuid;
BEGIN
  -- 1. Not one schema-owned function is executable by anon or authenticated.
  --    Extension-owned functions are excluded: they are pgcrypto's and
  --    PostgREST needs them, exactly as the migration excludes them.
  SELECT coalesce(string_agg(sig, ', ' ORDER BY sig), '') INTO v_open
  FROM (
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid
                       AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) q;
  IF v_open <> '' THEN
    RAISE EXCEPTION 'anon or authenticated can execute %: %',
      (SELECT count(*) FROM regexp_split_to_table(v_open, ', ')), left(v_open, 500);
  END IF;

  -- 2. ...and every one of them is still reachable by the service role the
  --    Edge Functions actually use. A fix that locked the product out of its
  --    own database would pass (1) and fail here.
  SELECT coalesce(string_agg(sig, ', ' ORDER BY sig), '') INTO v_missing
  FROM (
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid
                       AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')
      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) q;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on: %', left(v_missing, 500);
  END IF;

  -- 3. The SECURITY DEFINER view: closed to the browser roles, open to the
  --    service role. It reads every organisation's scan outcomes.
  IF has_table_privilege('anon', 'public.builder_document_scan_health', 'SELECT')
     OR has_table_privilege('authenticated', 'public.builder_document_scan_health', 'SELECT') THEN
    RAISE EXCEPTION 'the cross-organisation scan-health view is still readable by anon/authenticated';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.builder_document_scan_health', 'SELECT') THEN
    RAISE EXCEPTION 'service_role can no longer read the scan-health view';
  END IF;

  -- 4. Behaviour, not just catalog. One tenant, one governed write, attempted
  --    as anon: refused, and the row untouched.
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Security Proof Org', 'builder', 'active', true, now()) RETURNING id INTO v_org;
  INSERT INTO public.builder_projects(name, builder_organisation_id)
  VALUES ('Security Proof Project', v_org) RETURNING id INTO v_project;
  INSERT INTO public.builder_stages(project_id, name)
  VALUES (v_project, 'Original') RETURNING id INTO v_stage;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.builder_upsert_stage(NULL, 'builder_user', NULL, v_stage, v_project,
      jsonb_build_object('name', 'anon was here'), 1, 'security proof');
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  RESET ROLE;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'anon executed a privileged governed command';
  END IF;
  IF (SELECT name FROM public.builder_stages WHERE id = v_stage) <> 'Original' THEN
    RAISE EXCEPTION 'the refused anon call still changed the row';
  END IF;

  -- 5. ...and the legitimate caller is unaffected. This is the half that makes
  --    the refusal above a fix rather than an outage.
  SET LOCAL ROLE service_role;
  PERFORM public.builder_upsert_stage(NULL, 'builder_user', NULL, v_stage, v_project,
    jsonb_build_object('name', 'Renamed by service_role'), 1, 'security proof');
  RESET ROLE;
  IF (SELECT name FROM public.builder_stages WHERE id = v_stage) <> 'Renamed by service_role' THEN
    RAISE EXCEPTION 'service_role could not perform the governed write';
  END IF;

  -- 6. A stored password is a bcrypt hash — re-checked after every migration
  --    has applied, not only at the moment the constraint was added.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.builder_portal_users'::regclass
       AND conname = 'builder_portal_users_password_hash_is_bcrypt'
       AND convalidated) THEN
    RAISE EXCEPTION 'the password_hash bcrypt constraint is missing or unvalidated';
  END IF;
END $proof$;`);

proof('a child write never escapes the parent the caller was authorised for', `
DO $proof$
DECLARE
  v_org_a uuid; v_org_b uuid;
  v_proj_a uuid; v_proj_b uuid;
  v_stage_a uuid; v_building_a uuid; v_lot_a uuid;
  v_txn_a uuid; v_txn_b uuid; v_case_a uuid; v_case_b uuid;
  v_cstage_a uuid; v_milestone_a uuid;
  v_var_a uuid; v_var_b uuid; v_approval_a uuid;
  v_caught text;
BEGIN
  -- Two tenants that share nothing. Organisation B plays the attacker: it
  -- holds a project, a construction case and a variation of its own, and
  -- supplies them as the PARENT for a child id belonging to organisation A.
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Isolation Org A', 'builder', 'active', true, now()) RETURNING id INTO v_org_a;
  INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
  VALUES ('Isolation Org B', 'builder', 'active', true, now()) RETURNING id INTO v_org_b;

  INSERT INTO public.builder_projects(name, builder_organisation_id)
  VALUES ('Isolation Project A', v_org_a) RETURNING id INTO v_proj_a;
  INSERT INTO public.builder_projects(name, builder_organisation_id)
  VALUES ('Isolation Project B', v_org_b) RETURNING id INTO v_proj_b;

  INSERT INTO public.builder_stages(project_id, name)
  VALUES (v_proj_a, 'A stage') RETURNING id INTO v_stage_a;
  INSERT INTO public.builder_buildings(project_id, name)
  VALUES (v_proj_a, 'A building') RETURNING id INTO v_building_a;
  INSERT INTO public.builder_lots(project_id, lot_number)
  VALUES (v_proj_a, 'A-1') RETURNING id INTO v_lot_a;

  INSERT INTO public.builder_transactions(project_id, organisation_id)
  VALUES (v_proj_a, v_org_a) RETURNING id INTO v_txn_a;
  INSERT INTO public.builder_transactions(project_id, organisation_id)
  VALUES (v_proj_b, v_org_b) RETURNING id INTO v_txn_b;
  INSERT INTO public.builder_construction_cases(transaction_id, project_id)
  VALUES (v_txn_a, v_proj_a) RETURNING id INTO v_case_a;
  INSERT INTO public.builder_construction_cases(transaction_id, project_id)
  VALUES (v_txn_b, v_proj_b) RETURNING id INTO v_case_b;

  INSERT INTO public.builder_construction_stages(construction_case_id, name, stage_key)
  VALUES (v_case_a, 'A construction stage', 'base') RETURNING id INTO v_cstage_a;
  INSERT INTO public.builder_construction_milestones(construction_case_id, name)
  VALUES (v_case_a, 'A milestone') RETURNING id INTO v_milestone_a;

  INSERT INTO public.builder_variations(construction_case_id, title)
  VALUES (v_case_a, 'A variation') RETURNING id INTO v_var_a;
  INSERT INTO public.builder_variations(construction_case_id, title)
  VALUES (v_case_b, 'B variation') RETURNING id INTO v_var_b;
  INSERT INTO public.builder_variation_approvals(variation_id, approver_name)
  VALUES (v_var_a, 'A approver') RETURNING id INTO v_approval_a;

  -- 1. stage under a foreign project
  v_caught := NULL;
  BEGIN
    PERFORM public.builder_upsert_stage(NULL, 'builder_user', NULL, v_stage_a, v_proj_b,
      jsonb_build_object('name', 'taken'), 1, 'isolation proof');
  EXCEPTION WHEN others THEN v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE '%BUILDER_STAGE_NOT_FOUND%' THEN
    RAISE EXCEPTION 'a foreign project could reach another organisation''s stage (%)', coalesce(v_caught, 'no error at all');
  END IF;
  IF (SELECT name FROM public.builder_stages WHERE id = v_stage_a) <> 'A stage' THEN
    RAISE EXCEPTION 'the refused cross-tenant stage write still landed';
  END IF;

  -- 2. building under a foreign project
  v_caught := NULL;
  BEGIN
    PERFORM public.builder_upsert_building(NULL, 'builder_user', NULL, v_building_a, v_proj_b,
      NULL, jsonb_build_object('name', 'taken'), 1, 'isolation proof');
  EXCEPTION WHEN others THEN v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE '%BUILDER_BUILDING_NOT_FOUND%' THEN
    RAISE EXCEPTION 'a foreign project could reach another organisation''s building (%)', coalesce(v_caught, 'no error at all');
  END IF;
  IF (SELECT name FROM public.builder_buildings WHERE id = v_building_a) <> 'A building' THEN
    RAISE EXCEPTION 'the refused cross-tenant building write still landed';
  END IF;

  -- 3. lot under a foreign project
  v_caught := NULL;
  BEGIN
    PERFORM public.builder_upsert_lot(NULL, 'builder_user', NULL, v_lot_a, v_proj_b,
      NULL, jsonb_build_object('lot_number', 'taken'), 1, 'isolation proof');
  EXCEPTION WHEN others THEN v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE '%BUILDER_LOT_NOT_FOUND%' THEN
    RAISE EXCEPTION 'a foreign project could reach another organisation''s lot (%)', coalesce(v_caught, 'no error at all');
  END IF;
  IF (SELECT lot_number FROM public.builder_lots WHERE id = v_lot_a) <> 'A-1' THEN
    RAISE EXCEPTION 'the refused cross-tenant lot write still landed';
  END IF;

  -- 4. construction stage under a foreign case
  v_caught := NULL;
  BEGIN
    PERFORM public.builder_upsert_construction_stage(NULL, 'builder_user', NULL, v_cstage_a, v_case_b,
      jsonb_build_object('name', 'taken'), 1, 'isolation proof');
  EXCEPTION WHEN others THEN v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE '%BUILDER_CONSTRUCTION_STAGE_NOT_FOUND%' THEN
    RAISE EXCEPTION 'a foreign case could reach another organisation''s construction stage (%)', coalesce(v_caught, 'no error at all');
  END IF;
  IF (SELECT name FROM public.builder_construction_stages WHERE id = v_cstage_a) <> 'A construction stage' THEN
    RAISE EXCEPTION 'the refused cross-tenant construction stage write still landed';
  END IF;

  -- 5. milestone under a foreign case
  v_caught := NULL;
  BEGIN
    PERFORM public.builder_upsert_milestone(NULL, 'builder_user', NULL, v_milestone_a, v_case_b,
      NULL, jsonb_build_object('name', 'taken'), 1, 'isolation proof');
  EXCEPTION WHEN others THEN v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE '%BUILDER_MILESTONE_NOT_FOUND%' THEN
    RAISE EXCEPTION 'a foreign case could reach another organisation''s milestone (%)', coalesce(v_caught, 'no error at all');
  END IF;
  IF (SELECT name FROM public.builder_construction_milestones WHERE id = v_milestone_a) <> 'A milestone' THEN
    RAISE EXCEPTION 'the refused cross-tenant milestone write still landed';
  END IF;

  -- 6. variation approval under a foreign variation
  v_caught := NULL;
  BEGIN
    PERFORM public.builder_upsert_variation_approval(NULL, 'builder_user', NULL, v_approval_a, v_var_b,
      jsonb_build_object('approver_name', 'taken'), 1, 'isolation proof');
  EXCEPTION WHEN others THEN v_caught := SQLERRM;
  END;
  IF v_caught IS NULL OR v_caught NOT LIKE '%BUILDER_APPROVAL_NOT_FOUND%' THEN
    RAISE EXCEPTION 'a foreign variation could reach another organisation''s approval (%)', coalesce(v_caught, 'no error at all');
  END IF;
  IF (SELECT approver_name FROM public.builder_variation_approvals WHERE id = v_approval_a) <> 'A approver' THEN
    RAISE EXCEPTION 'the refused cross-tenant approval write still landed';
  END IF;

  -- 7. AND THE HONEST CALLER IS UNTOUCHED. Every one of the six, with the
  --    parent it really belongs to, still writes. A predicate that refused
  --    everything would pass 1-6 and break the product.
  PERFORM public.builder_upsert_stage(NULL, 'builder_user', NULL, v_stage_a, v_proj_a,
    jsonb_build_object('name', 'A stage renamed'), 1, 'isolation proof');
  PERFORM public.builder_upsert_building(NULL, 'builder_user', NULL, v_building_a, v_proj_a,
    NULL, jsonb_build_object('name', 'A building renamed'), 1, 'isolation proof');
  PERFORM public.builder_upsert_lot(NULL, 'builder_user', NULL, v_lot_a, v_proj_a,
    NULL, jsonb_build_object('lot_number', 'A-2'), 1, 'isolation proof');
  PERFORM public.builder_upsert_construction_stage(NULL, 'builder_user', NULL, v_cstage_a, v_case_a,
    jsonb_build_object('name', 'A construction stage renamed'), 1, 'isolation proof');
  PERFORM public.builder_upsert_milestone(NULL, 'builder_user', NULL, v_milestone_a, v_case_a,
    NULL, jsonb_build_object('name', 'A milestone renamed'), 1, 'isolation proof');
  PERFORM public.builder_upsert_variation_approval(NULL, 'builder_user', NULL, v_approval_a, v_var_a,
    jsonb_build_object('approver_name', 'A approver renamed'), 1, 'isolation proof');

  IF (SELECT name FROM public.builder_stages WHERE id = v_stage_a) <> 'A stage renamed'
     OR (SELECT name FROM public.builder_buildings WHERE id = v_building_a) <> 'A building renamed'
     OR (SELECT lot_number FROM public.builder_lots WHERE id = v_lot_a) <> 'A-2'
     OR (SELECT name FROM public.builder_construction_stages WHERE id = v_cstage_a) <> 'A construction stage renamed'
     OR (SELECT name FROM public.builder_construction_milestones WHERE id = v_milestone_a) <> 'A milestone renamed'
     OR (SELECT approver_name FROM public.builder_variation_approvals WHERE id = v_approval_a) <> 'A approver renamed' THEN
    RAISE EXCEPTION 'the parent predicate refused a write the caller was authorised to make';
  END IF;
END $proof$;`);

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('\nBaseline check passed: the squash stands alone and equals the corpus end-state.');
