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

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('\nBaseline check passed: the squash stands alone and equals the corpus end-state.');
