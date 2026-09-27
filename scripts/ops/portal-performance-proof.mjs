#!/usr/bin/env node
/**
 * ===========================================================================
 * HOW LONG A PROJECT REQUEST TAKES, AND WHERE THE TIME GOES — ON THE LIVE PORTAL.
 * ===========================================================================
 *
 * One detached proof organisation, a project granted to two of its members, a
 * project conversation. Then, for SAMPLES rounds, interleaved so network drift
 * lands on every operation alike:
 *
 *   * a comparable ordinary request (workspace_summary),
 *   * opening the project (get_project),
 *   * posting a project message (post_message),
 *   * reading the conversation (get_conversation),
 *
 * each measured end to end through the same-origin proxy a browser uses, and
 * again directly against the function so its Server-Timing stages can be read
 * (the proxy deliberately does not forward that header). Reports min / median /
 * max per operation and the median of every stage.
 *
 * It also re-proves that nothing about WHO may do WHAT moved: the member reads
 * and posts, a read-only member reads and is refused a post (403), another
 * organisation gets 404 for the project and the conversation.
 *
 * Runs from the production-rollout workflow (phase `portal-performance-proof`).
 * Everything it creates is deleted and counted. No secret is printed.
 */
import { createHmac, randomBytes } from 'node:crypto';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PEPPER = process.env.NETWORK_SESSION_PEPPER || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const DIRECT = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const SAMPLES = Number(process.env.PERF_SAMPLES || 12);
const RUN = randomBytes(4).toString('hex');
const MARK = 'smoke-rollout';
const TAG = 'perf';
const ORG_NAME = `Smoke Rollout ${TAG} ${RUN}`;
const ALL_ACKS = ['global_confidentiality_privacy', 'authority_binding_acceptance', 'portal_access', 'binding_amlctf_arrangement'];

if (!ACCESS_TOKEN || !PEPPER) { console.error('SUPABASE_ACCESS_TOKEN and NETWORK_SESSION_PEPPER are required'); process.exit(2); }

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function q(label, sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`[${label}] ${r.status}: ${text.slice(0, 300)}`);
  try { const p = JSON.parse(text); return Array.isArray(p) ? p : (p?.result ?? []); } catch { return []; }
}
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const id = (v) => `${sqlLit(v)}::uuid`;
const hmacHex = (k, m) => createHmac('sha256', k).update(m).digest('hex');

async function call(fn, body, token, { direct = false } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-portal-request': 'builder-portal', Origin: ORIGIN,
    Cookie: `__Host-builder_session_token=${token}` };
  const started = performance.now();
  const r = await fetch(direct ? `${DIRECT}/${fn}` : `${ORIGIN}/fn/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  const ms = performance.now() - started;
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  const stages = {};
  for (const part of (r.headers.get('server-timing') ?? '').split(',')) {
    const m = /^\s*([\w-]+);dur=([\d.]+)/.exec(part);
    if (m) stages[m[1]] = Number(m[2]);
  }
  return { status: r.status, json, ms, stages };
}

function detachFromNetwork(orgIdsSql) {
  const c = `SELECT c.id FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgIdsSql})`;
  return `
    DELETE FROM public.builder_network_outbox WHERE dedupe_key IN (SELECT 'connection.authorised:' || c.id::text
      FROM public.workspace_connections c WHERE c.builder_organisation_id IN (${orgIdsSql}));
    DELETE FROM public.workspace_connection_events WHERE connection_id IN (${c});
    DELETE FROM public.builder_stock_selection_announcements WHERE connection_id IN (${c});
    DELETE FROM public.builder_network_outbox WHERE connection_id IN (${c});
    DELETE FROM public.builder_network_inbound_events WHERE connection_id IN (${c});
    DELETE FROM public.builder_network_stamps WHERE connection_id IN (${c});
    DELETE FROM public.workspace_connections WHERE builder_organisation_id IN (${orgIdsSql});`;
}
const ORGS = `SELECT id FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}`;
async function cleanup(stage) {
  await q(`cleanup ${stage}`, `
    DO $$ BEGIN
      ${detachFromNetwork(ORGS)}
      ALTER TABLE public.builder_messages DISABLE TRIGGER trg_builder_messages_immutable;
      DELETE FROM public.builder_conversations WHERE organisation_id IN (${ORGS});
      ALTER TABLE public.builder_messages ENABLE TRIGGER trg_builder_messages_immutable;
      ALTER TABLE public.builder_project_status_history DISABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_projects WHERE builder_organisation_id IN (${ORGS});
      ALTER TABLE public.builder_project_status_history ENABLE TRIGGER trg_builder_project_status_history_append_only;
      DELETE FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)};
      DELETE FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)};
    END $$;`);
}

async function seedPerson(label, role, orgName, orgId = null) {
  const email = `${MARK}-${TAG}-${RUN}-${label}@example.com`;
  const orgSql = orgId ? `SELECT ${id(orgId)} AS id`
    : `INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
       VALUES (${sqlLit(orgName)}, 'builder', 'active', true, now()) RETURNING id`;
  const rows = await q(`seed ${label}`, `
    WITH org AS (${orgSql}), person AS (
      INSERT INTO public.builder_portal_users(email, name, status, is_active, email_verified_at, must_change_password, password_hash)
      VALUES (${sqlLit(email)}, ${sqlLit(`Perf ${label}`)}, 'active', true, now(), false,
              extensions.crypt(${sqlLit(randomBytes(12).toString('hex'))}, extensions.gen_salt('bf', 10))) RETURNING id)
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    SELECT person.id, org.id, ${sqlLit(role)}, true, 'active' FROM person, org;
    ${detachFromNetwork(`SELECT id FROM public.builder_organisations WHERE legal_name = ${sqlLit(orgName)}`)}
    SELECT u.id AS user_id, o.id AS org_id,
           (SELECT count(*) FROM public.workspace_connections c WHERE c.builder_organisation_id = o.id)::int AS connections
      FROM public.builder_portal_users u, public.builder_organisations o
     WHERE u.email = ${sqlLit(email)} AND o.legal_name = ${sqlLit(orgName)}`);
  const row = rows[0];
  if (Number(row.connections) !== 0) throw new Error('proof organisation is connected to a workspace; refusing');
  await q('onboarding', `SELECT public.builder_ensure_onboarding_steps(${id(row.user_id)})`);
  const token = randomBytes(32).toString('hex');
  await q('session', `SELECT public.builder_issue_session(${id(row.user_id)}, ${sqlLit(hmacHex(PEPPER, token))},
    now() + interval '2 hours', now() + interval '2 hours', NULL, NULL, 'smoke-rollout perf proof')`);
  await call('builder-portal-verify', { action: 'accept_current_terms', acknowledgements: ALL_ACKS }, token);
  await call('builder-portal-verify', { action: 'complete_onboarding' }, token);
  return { userId: row.user_id, orgId: row.org_id, token };
}

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};
const fmt = (x) => `${Math.round(x)}ms`;

console.log(`portal performance proof run=${RUN} samples=${SAMPLES}`);
await cleanup('start');
let crashed = null;
try {
  const owner = await seedPerson('owner', 'owner', ORG_NAME);
  const member = await seedPerson('member', 'member', ORG_NAME, owner.orgId);
  const reader = await seedPerson('reader', 'read_only', ORG_NAME, owner.orgId);
  const other = await seedPerson('other', 'owner', `${ORG_NAME} other`);
  const project = (await q('project', `SELECT (public.builder_upsert_project(NULL, 'system', NULL, NULL,
    ${sqlLit(JSON.stringify({ name: `${ORG_NAME} project`, suburb: 'Proofville', state: 'NSW', postcode: '2000' }))}::jsonb,
    NULL, ${id(owner.orgId)}, NULL, NULL, 'portal performance proof')).id AS id`))[0].id;
  await q('grant', `INSERT INTO public.builder_project_access(builder_user_id, project_id, organisation_id, organisation_side, access_role)
    VALUES (${id(owner.userId)}, ${id(project)}, ${id(owner.orgId)}, 'builder', 'responsible'),
           (${id(member.userId)}, ${id(project)}, ${id(owner.orgId)}, 'builder', 'team_member'),
           (${id(reader.userId)}, ${id(project)}, ${id(owner.orgId)}, 'builder', 'read_only')`);
  const conv = await call('builder-portal-collaboration', { operation: 'create_conversation', scope_type: 'project',
    scope_id: project, subject: 'Timing', participant_ids: [member.userId, reader.userId], reason: 'perf proof' }, owner.token);
  const conversationId = conv.json?.record?.id;
  record('0: a detached proof organisation with a project conversation', conv.status === 200 && !!conversationId, `status ${conv.status}`);

  // --- Who may do what has not moved -----------------------------------------------
  const mProject = await call('builder-portal-projects', { operation: 'get_project', project_id: project }, member.token);
  const mPost = await call('builder-portal-collaboration', { operation: 'post_message', conversation_id: conversationId, body: 'member post' }, member.token);
  const rRead = await call('builder-portal-collaboration', { operation: 'get_conversation', conversation_id: conversationId }, reader.token);
  const rPost = await call('builder-portal-collaboration', { operation: 'post_message', conversation_id: conversationId, body: 'reader post' }, reader.token);
  const oProject = await call('builder-portal-projects', { operation: 'get_project', project_id: project }, other.token);
  const oConv = await call('builder-portal-collaboration', { operation: 'get_conversation', conversation_id: conversationId }, other.token);
  const oPost = await call('builder-portal-collaboration', { operation: 'post_message', conversation_id: conversationId, body: 'intruder' }, other.token);
  record('1: outcomes unchanged — member reads and posts; read-only reads, post 403; another organisation 404',
    mProject.status === 200 && mPost.status === 200 && rRead.status === 200 && rPost.status === 403
      && oProject.status === 404 && oConv.status === 404 && oPost.status === 404,
    `member ${mProject.status}/${mPost.status} reader ${rRead.status}/${rPost.status} other ${oProject.status}/${oConv.status}/${oPost.status}`);
  const full = mProject.json ?? {};
  record('1: get_project still returns the whole record (project, permissions, parties, history, activation, stock)',
    !!full.project && !!full.permissions && Array.isArray(full.parties) && Array.isArray(full.status_history)
      && 'activation' in full && 'stock_item' in full && 'property_documents' in full,
    Object.keys(full).join(','));

  // --- Timing --------------------------------------------------------------------
  const ops = {
    normal: () => ['builder-portal-workspace', { operation: 'workspace_summary' }],
    get_project: () => ['builder-portal-projects', { operation: 'get_project', project_id: project }],
    post_message: (i) => ['builder-portal-collaboration', { operation: 'post_message', conversation_id: conversationId, body: `timing ${RUN} ${i}` }],
    get_conversation: () => ['builder-portal-collaboration', { operation: 'get_conversation', conversation_id: conversationId }],
  };
  const e2e = Object.fromEntries(Object.keys(ops).map((k) => [k, []]));
  const direct = Object.fromEntries(Object.keys(ops).map((k) => [k, []]));
  const stages = Object.fromEntries(Object.keys(ops).map((k) => [k, {}]));
  // One warm-up round, discarded, so no measurement includes a cold start.
  for (const [k, op] of Object.entries(ops)) { const [fn, b] = op('warm'); await call(fn, b, member.token); await call(fn, b, member.token, { direct: true }); void k; }
  let allOk = true;
  for (let i = 0; i < SAMPLES; i += 1) {
    for (const [k, op] of Object.entries(ops)) {
      const [fn, b] = op(i);
      const viaProxy = await call(fn, b, member.token);
      const viaDirect = await call(fn, b, member.token, { direct: true });
      if (viaProxy.status !== 200 || viaDirect.status !== 200) allOk = false;
      e2e[k].push(viaProxy.ms);
      direct[k].push(viaDirect.ms);
      for (const [stage, ms] of Object.entries(viaDirect.stages)) (stages[k][stage] ??= []).push(ms);
    }
  }
  record(`2: ${SAMPLES} samples of each operation all answered 200`, allOk);
  console.log('\n  END TO END through the proxy (min / median / max)');
  for (const k of Object.keys(ops)) { const s = stat(e2e[k]); console.log(`    ${k.padEnd(17)} ${fmt(s.min)} / ${fmt(s.median)} / ${fmt(s.max)}`); }
  console.log('\n  DIRECT to the function (min / median / max)');
  for (const k of Object.keys(ops)) { const s = stat(direct[k]); console.log(`    ${k.padEnd(17)} ${fmt(s.min)} / ${fmt(s.median)} / ${fmt(s.max)}`); }
  console.log('\n  SERVER STAGES (median ms, from Server-Timing)');
  for (const k of ['get_project', 'post_message', 'get_conversation']) {
    const line = Object.entries(stages[k]).map(([st, xs]) => `${st}=${Math.round(stat(xs).median)}`).join(' ');
    console.log(`    ${k.padEnd(17)} ${line || '(no Server-Timing header)'}`);
  }
  const med = (k) => stat(e2e[k]).median;
  console.log(`\n  RATIO to the normal request (median): get_project ${(med('get_project') / med('normal')).toFixed(2)}x, `
    + `post_message ${(med('post_message') / med('normal')).toFixed(2)}x, get_conversation ${(med('get_conversation') / med('normal')).toFixed(2)}x`);
  const threshold = Number(process.env.PERF_MAX_RATIO || 0);
  if (threshold > 0) {
    for (const k of ['get_project', 'post_message', 'get_conversation']) {
      record(`3: ${k} median within ${threshold}x of the normal request`, med(k) <= threshold * med('normal'),
        `${fmt(med(k))} vs ${fmt(med('normal'))}`);
    }
  }
} catch (error) {
  crashed = error;
  record('the proof ran to completion', false, String(error?.message ?? error).slice(0, 300));
}

await cleanup('end');
const left = (await q('residue', `SELECT
  (SELECT count(*) FROM public.builder_organisations WHERE legal_name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS orgs,
  (SELECT count(*) FROM public.builder_portal_users WHERE email LIKE ${sqlLit(`${MARK}-${TAG}-%@example.com`)}) AS users,
  (SELECT count(*) FROM public.builder_projects WHERE name LIKE ${sqlLit(`Smoke Rollout ${TAG} %`)}) AS projects`))[0];
record('cleanup: nothing of this run remains', Object.values(left ?? { x: 1 }).every((n) => Number(n) === 0), JSON.stringify(left));
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} of ${results.length} checks passed (run ${RUN})`);
console.log(passed === results.length && !crashed ? 'PORTAL PERFORMANCE PROOF PASSED' : 'PORTAL PERFORMANCE PROOF FAILED');
process.exit(passed === results.length && !crashed ? 0 : 1);
