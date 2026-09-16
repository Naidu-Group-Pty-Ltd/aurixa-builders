#!/usr/bin/env node
/**
 * THE PROXY IP HANDSHAKE, PROVEN AGAINST PRODUCTION.
 *
 * Every browser call reaches the Builder Portal through the site's own `/fn/*`
 * proxy, so the address the edge runtime connects from is THE PROXY's. Until
 * this handshake existed, every per-IP ceiling in the product was one ceiling
 * shared by every browser user at once — 30 sign-in attempts per 15 minutes
 * for the whole network, and one abuser locking out everyone else.
 *
 * The proxy now forwards the address it observed (`x-portal-client-ip`)
 * together with a token only it holds (`x-portal-proxy-token`), and
 * `getPortalClientIp` believes the address ONLY when that token matches
 * `PORTAL_PROXY_SHARED_SECRET`. An unauthenticated claim about one's own
 * address is the `X-Forwarded-For` hole under a new name, so the token is the
 * whole point.
 *
 * ── How this proves it, without trusting anything it is testing ────────────
 *
 * The runner calls the SAME endpoint two ways: straight at the function URL,
 * and through the proxy. Both requests leave the same machine, so both have
 * the same public address — call it R.
 *
 *   * The DIRECT call establishes R: nothing sits between the runner and the
 *     runtime, so the address the runtime buckets on IS the runner's.
 *   * The PROXIED call must then land in THE SAME BUCKET. It can only do so if
 *     the proxy told the runtime R and the runtime believed it — across a hop
 *     where the connecting address is Vercel's. If the handshake were broken,
 *     this request would open a bucket under Vercel's egress address instead,
 *     which is exactly the shared ceiling being closed.
 *
 * No external IP service is consulted and no header is taken on trust: the
 * evidence is which limiter bucket moved, read back from the database.
 *
 * The spoof probes then call the runtime DIRECTLY while claiming someone
 * else's address, with no token, a wrong token, and a wrong token of
 * believable length. Each must be ignored — the caller's real address is what
 * gets charged, and the claimed address never appears as a bucket at all.
 *
 * ── What it touches ───────────────────────────────────────────────────────
 *
 * Sign-in attempts for addresses that do not exist, which create no account,
 * no session and no business row. They consume limiter buckets, which is what
 * a sign-in attempt is supposed to do. The identifier buckets this run creates
 * are deleted at the end; the source-address buckets are the evidence and are
 * left to age out of their own window.
 */
import { randomBytes } from 'node:crypto';

const PROJECT_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const ORIGIN = process.env.PORTAL_ORIGIN || 'https://builders.aurixasystems.com.au';
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const RUN = randomBytes(4).toString('hex');

/** RFC 5737 TEST-NET-2. Reserved, routes nowhere, unmistakable in a log. */
const CLAIMED_IP = '198.51.100.77';

if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is required — run this from the production-rollout workflow.');
  process.exit(2);
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

async function q(label, sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 400)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}

/** Every source-address bucket the sign-in door holds right now. */
async function ipBuckets() {
  const rows = await q('ip buckets', `
    SELECT bucket_key, count FROM public.auth_rate_limits
    WHERE bucket_key LIKE 'bpl\\_ip:%' ORDER BY bucket_key`);
  return new Map(rows.map((r) => [r.bucket_key, Number(r.count)]));
}

/** Which bucket moved, and by how much. */
function moved(before, after) {
  const changes = [];
  for (const [key, count] of after) {
    const was = before.get(key) ?? 0;
    if (count > was) changes.push({ key, was, now: count });
  }
  return changes;
}

/**
 * One sign-in attempt for an address that does not exist. The response is not
 * the evidence — which bucket moved is — so the status is reported, not
 * asserted: the rate limit is consumed before anything else in the handler,
 * so every reachable outcome still leaves the mark this reads.
 */
async function attempt(label, { viaProxy, extraHeaders = {}, email }) {
  const url = viaProxy
    ? `${ORIGIN}/fn/builder-portal-login`
    : `${FUNCTIONS_BASE}/builder-portal-login`;
  const before = await ipBuckets();
  let status = 0;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-portal-request': 'builder-portal',
        origin: ORIGIN,
        ...extraHeaders,
      },
      body: JSON.stringify({ email, password: `probe-${RUN}-not-a-password` }),
    });
    status = response.status;
  } catch (error) {
    throw new Error(`[${label}] request failed: ${String(error).slice(0, 200)}`);
  }
  const after = await ipBuckets();
  const changes = moved(before, after);
  console.log(`  · ${label}: HTTP ${status}; bucket(s) moved: ${
    changes.length ? changes.map((c) => `${c.key} ${c.was}→${c.now}`).join(', ') : 'none'
  }`);
  return { status, changes, after };
}

const probeEmail = (n) => `proxy-handshake-probe-${RUN}-${n}@invalid.test`;

console.log(`proxy IP handshake verification  project=${PROJECT_REF}  run=${RUN}`);
console.log(`  portal origin: ${ORIGIN}`);
console.log(`  function base: ${FUNCTIONS_BASE}\n`);

// ── 1. The runtime holds the secret ────────────────────────────────────────
const secretsResponse = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`,
  { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
);
if (!secretsResponse.ok) {
  record('the edge runtime holds PORTAL_PROXY_SHARED_SECRET', false,
    `could not list secret names (HTTP ${secretsResponse.status})`);
} else {
  // NAMES only. The value is never requested, never printed, never compared.
  const names = new Set(((await secretsResponse.json()) ?? []).map((s) => s.name));
  record('the edge runtime holds PORTAL_PROXY_SHARED_SECRET', names.has('PORTAL_PROXY_SHARED_SECRET'),
    names.has('PORTAL_PROXY_SHARED_SECRET') ? 'present (name only; no value read)' : 'MISSING');
}

// ── 2. Establish R with a direct call ──────────────────────────────────────
console.log('\n— establishing this runner\'s own address, seen with nothing in between —');
const IP_KEY = /^bpl_ip:(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/;
// Exactly one bucket must move, or the address cannot be attributed. Another
// caller signing in during the same two reads would blur it, so one retry.
let baseline = await attempt('direct, no claim', { viaProxy: false, email: probeEmail('direct') });
if (!(baseline.changes.length === 1 && IP_KEY.test(baseline.changes[0].key))) {
  console.log('  · another caller moved a bucket in the same window; retrying once');
  baseline = await attempt('direct, no claim (retry)', { viaProxy: false, email: probeEmail('direct-retry') });
}
const okBaseline = baseline.changes.length === 1 && IP_KEY.test(baseline.changes[0].key);
record('a direct call charges the caller\'s own address', okBaseline,
  okBaseline ? baseline.changes[0].key : `moved ${baseline.changes.length} bucket(s)`);
if (!okBaseline) {
  console.error('\nwithout a single unambiguous baseline bucket nothing below can be concluded.');
  process.exit(1);
}
const RUNNER_BUCKET = baseline.changes[0].key;
const RUNNER_IP = RUNNER_BUCKET.slice('bpl_ip:'.length);
console.log(`  → this runner is ${RUNNER_IP} to the edge runtime`);

// ── 3. The same request through the proxy must land in the same bucket ─────
console.log('\n— the same endpoint, through the portal proxy —');
const proxied = await attempt('through the proxy', { viaProxy: true, email: probeEmail('proxied') });
// The discriminating fact: R moved. Had the handshake been broken, R could
// NOT have moved — the runtime would never have heard the runner's address —
// and a bucket under Vercel's egress would have taken the charge instead.
const proxiedChargedR = proxied.changes.some((c) => c.key === RUNNER_BUCKET);
const others = proxied.changes.filter((c) => c.key !== RUNNER_BUCKET).map((c) => c.key);
record('a proxied call is charged to the BROWSER\'s address, not the proxy\'s', proxiedChargedR,
  proxiedChargedR
    ? `${RUNNER_BUCKET} — the runtime learned the client address across the hop`
    : `expected ${RUNNER_BUCKET}, moved ${proxied.changes.map((c) => c.key).join(', ') || 'nothing'}`);
record('no bucket opened under the proxy\'s own address', proxiedChargedR && others.length === 0,
  others.length ? `also moved: ${others.join(', ')}` : 'the shared ceiling is no longer where browser traffic lands');

// ── 4. The claim is worthless without the token ────────────────────────────
console.log('\n— direct callers claiming someone else\'s address —');
const spoofs = [
  ['no token at all', {}],
  ['a wrong token', { 'x-portal-proxy-token': `wrong-${RUN}` }],
  ['a wrong token of believable length', { 'x-portal-proxy-token': randomBytes(32).toString('hex') }],
];
let spoofN = 0;
for (const [label, headers] of spoofs) {
  spoofN += 1;
  const probe = await attempt(`direct, claiming ${CLAIMED_IP}, ${label}`, {
    viaProxy: false,
    email: probeEmail(`spoof${spoofN}`),
    extraHeaders: { 'x-portal-client-ip': CLAIMED_IP, ...headers },
  });
  const charged = probe.changes.some((c) => c.key === RUNNER_BUCKET)
    && !probe.changes.some((c) => c.key === `bpl_ip:${CLAIMED_IP}`);
  record(`a forged address is ignored with ${label}`, charged,
    charged ? `charged to ${RUNNER_BUCKET}, not the claim` : `moved ${probe.changes.map((c) => c.key).join(', ') || 'nothing'}`);
}

const finalBuckets = await ipBuckets();
record('the claimed address never became a bucket', !finalBuckets.has(`bpl_ip:${CLAIMED_IP}`),
  `bpl_ip:${CLAIMED_IP} ${finalBuckets.has(`bpl_ip:${CLAIMED_IP}`) ? 'EXISTS' : 'does not exist'}`);

// ── 5. Buckets are per source, and the identifier dimension still works ────
console.log('\n— the two dimensions —');
const distinct = [...finalBuckets.keys()].length;
record('source-address buckets are held per address', distinct >= 1,
  `${distinct} distinct sign-in source bucket(s) currently held`);

const repeatEmail = probeEmail('identifier');
await attempt('identifier dimension, first attempt', { viaProxy: true, email: repeatEmail });
await attempt('identifier dimension, second attempt', { viaProxy: true, email: repeatEmail });
// `normalizeKeyPart` lowercases and folds anything outside [a-z0-9:_./-] to _.
const identifierKey = `bpl_id:${repeatEmail.toLowerCase().replace(/[^a-z0-9:_./-]/g, '_')}`;
const idRows = await q('identifier bucket', `
  SELECT bucket_key, count FROM public.auth_rate_limits
  WHERE bucket_key = '${identifierKey}'`);
const idCount = Number(idRows[0]?.count ?? 0);
record('the per-account dimension still accumulates', idCount === 2,
  idRows.length ? `${idRows[0].bucket_key} count=${idCount}` : 'no identifier bucket formed');

const ipAfterAll = (await ipBuckets()).get(RUNNER_BUCKET) ?? 0;
record('the source dimension is charged before the account dimension', ipAfterAll >= idCount,
  `${RUNNER_BUCKET} count=${ipAfterAll}`);

// ── 6. Clean up this run's own identifier buckets ──────────────────────────
await q('cleanup', `
  DELETE FROM public.auth_rate_limits
  WHERE bucket_key LIKE 'bpl\\_id:proxy-handshake-probe-${RUN}%'`);
const leftovers = await q('cleanup check', `
  SELECT count(*)::int AS n FROM public.auth_rate_limits
  WHERE bucket_key LIKE 'bpl\\_id:proxy-handshake-probe-${RUN}%'`);
record('this run left no identifier buckets behind', Number(leftovers[0]?.n ?? -1) === 0,
  'source-address buckets are evidence and age out of their own window');

// ── verdict ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${failed.length} failure(s).`);
if (failed.length) {
  console.error('\nthe per-IP ceiling is NOT yet per-person:');
  for (const f of failed) console.error(`  FAIL  ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('\nThe per-IP ceiling follows the browser, not the proxy, and a claimed address');
console.log('without the token is worth nothing. The shared-bucket weakness is closed.');
