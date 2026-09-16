/**
 * Builders Network portal security check.
 *
 * The prime's scripts/builder-portal/security-check.mjs, carried across the
 * extraction with three deliberate edits and nothing else: the function
 * inventory is the network's own (no Command Centre admin plane, no
 * clone-side marketplace reader), the schema assertions read the shipped
 * BASELINE plus reshape.sql instead of the prime's migration files, and the
 * admin function leaves the CSRF list because it is not deployed here. Every
 * property it guards is one the portal must not lose by moving house:
 * hash-only session storage, cookie-only presentation, CSRF on every
 * mutating surface, the login timing oracle, deny-by-default permissions and
 * the forbidden data domains, and the browser credential boundary.
 *
 * Run with: npm run security:portal
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve from the process cwd, NOT from `import.meta.url`. The negative-test
// harness (scripts/security/check-security-gate-negatives.mjs) runs each gate
// against a symlinked mirror of the tree with one file mutated; resolving
// relative to this script's own location read the REAL repository instead, so
// every assertion here passed on mutated source. Same convention as
// scripts/security/check-admin-authorization-server-side.mjs.
const root = pathToFileURL(`${resolve(process.cwd())}/`);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** Comments explain which defect each file corrects; strip them before searching. */
const stripJs = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripSql = (body) => body.replace(/--[^\n]*/g, '');

const portalAuth = stripJs(read('supabase/functions/_shared/builderPortalAuth.ts'));
const portalAuthRaw = read('supabase/functions/_shared/builderPortalAuth.ts');
const sessions = stripJs(read('supabase/functions/_shared/builderSessions.ts'));
const sessionToken = stripJs(read('supabase/functions/_shared/builderSessionToken.ts'));
const sharedAuth = stripJs(read('supabase/functions/_shared/auth.ts'));
const client = stripJs(read('src/lib/builderPortal.ts'));

// The network ships ONE generated baseline; the reviewable half of the
// squash is scripts/db/reshape.sql. Both are what deploys, so both are what
// this gate reads — scanning the provenance copies instead would pass while
// the shipped artifact regressed.
const migrationsDir = new URL('supabase/migrations/', root);
const builderMigrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => readFileSync(join(migrationsDir.pathname, name), 'utf8'))
  .concat(read('scripts/db/reshape.sql'))
  .join('\n');
const migrationCode = stripSql(builderMigrations);

const functionDirs = readdirSync(new URL('supabase/functions/', root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^builder-/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const EXPECTED_FUNCTIONS = [
    // The network's inventory is the PORTAL-FACING set plus the two workers
    // and the inbound callback. The prime's nine *-admin functions are the
    // Command Centre plane — an agency no longer administers a builder's
    // organisation, so they are deleted or lifted into the portal re-gated
    // on org-owner permissions (extraction plan §5), and
    // builder-stock-marketplace is the CLONE's marketplace reader and stays
    // there. A dir appearing here without a plan entry fails this gate.
    'builder-document-processor',
    'builder-network-admin',
    'builder-network-connections',
    'builder-network-inbound',
    'builder-network-outbox-worker',
    'builder-network-stock-image',
    'builder-portal-accept-invite',
    'builder-portal-change-password',
    'builder-portal-collaboration',
    'builder-portal-construction',
    'builder-portal-delivery',
    'builder-portal-forgot-password',
    'builder-portal-inventory',
    'builder-portal-invite',
    'builder-portal-login',
    'builder-portal-logout',
    'builder-portal-projects',
    'builder-portal-register',
    'builder-portal-reset-password',
    'builder-portal-stock',
    'builder-portal-transactions',
    'builder-portal-verify',
    'builder-portal-verify-email',
    'builder-portal-workspace',
    // Cron sweep behind verifyInternal; holds a service-role client and
    // crosses organisations, so it is deliberately not a portal-reachable
    // surface. Declared in config.toml and reviewed in SECURITY_REGISTRY.json,
    // both of which this list's own loop below re-checks.
    'builder-stock-image-settler',
    // Google Sheets hyperlink recovery callback. Authenticated by a per-request
    // one-time capability token presented as `Authorization: Bearer` rather
    // than by a portal session, because the caller is an external automation
    // with no Supabase identity. Each request mints its own token and stores
    // only its SHA-256, so there is no shared secret in two systems. It holds a
    // service-role client and crosses organisations, so like the settler above
    // it is deliberately NOT a portal-reachable surface — the authority for
    // every write comes from a stored request row this product wrote, never
    // from the payload. Declared in config.toml and reviewed in
    // SECURITY_REGISTRY.json, both of which this list's own loop re-checks.
    'builder-stock-link-callback',
];

const fnSource = Object.fromEntries(
  functionDirs.map((name) => [name, stripJs(read(`supabase/functions/${name}/index.ts`))]),
);

// ---------------------------------------------------------------------------
// 1. Session transport — hash-only storage, cookie-only presentation
// ---------------------------------------------------------------------------
check(sessions.includes('hashSessionToken'),
  'Builder sessions are not hashed with the peppered repository hash');
check(sessions.includes('isSessionHashConfigured()'),
  'Builder session issuance does not fail closed when the session pepper is unset');
check(!/createHash\(\s*['"]sha256['"]\s*\)/.test(sessions),
  'Builder sessions use a bare SHA-256, which drops the pepper');
check(sharedAuth.includes('__Host-builder_session_token'),
  'the Builder session cookie is not __Host- prefixed');
check(/createBuilderSessionCookie[\s\S]{0,600}HttpOnly/.test(sharedAuth),
  'the Builder session cookie is not HttpOnly');
check(/createBuilderSessionCookie[\s\S]{0,600}Secure/.test(sharedAuth),
  'the Builder session cookie is not Secure');
check(!/body\s*[.[]/.test(sessionToken),
  'the Builder session extractor reads a token from the request body');
check(sessionToken.includes('carriesForeignPortalSession'),
  'a session issued for another portal is not rejected');
check(/resolveBuilderSession\(\s*supabase: any,\s*req: Request,\s*\)/.test(portalAuth),
  'resolveBuilderSession accepts something other than the Request — a caller could supply a session');

for (const name of Object.keys(fnSource)) {
  check(!/session_token\s*:/.test(fnSource[name]),
    `${name} returns a session token in its JSON body`);
  check(!/token:\s*issued\.token/.test(fnSource[name]),
    `${name} returns the raw session token`);
}

// ---------------------------------------------------------------------------
// 2. Browser client — no Web Storage, no token parameters
// ---------------------------------------------------------------------------
check(client.includes("credentials: 'include'"),
  'the Builder browser client does not send the HttpOnly session cookie');
check(!client.includes('localStorage') && !client.includes('sessionStorage'),
  'the Builder browser client stores authentication state in Web Storage');
check(!client.includes('document.cookie'),
  'the Builder browser client reads the session cookie from JavaScript');
check(!client.includes('session_token') && !client.includes('sessionToken'),
  'the Builder browser client transmits a raw session token');
check(client.includes("'X-Portal-Request': 'builder-portal'"),
  'the Builder browser client does not identify itself as a Builder portal request');

// ---------------------------------------------------------------------------
// 3. CSRF on every mutating surface
// ---------------------------------------------------------------------------
for (const name of [
  'builder-network-connections',
  'builder-portal-logout',
  'builder-portal-verify',
  'builder-portal-verify-email',
  'builder-portal-change-password',
  'builder-portal-invite',
]) {
  const source = fnSource[name] ?? '';
  check(source.includes('enforceCsrf(req)'), `${name} does not enforce CSRF`);
  // The established signature is csrfDenied(corsHeaders, csrfResult). The CORS
  // variable is named `corsHeaders` in most functions and `cors` in
  // builder-portal-admin, so the check asserts what must NOT be first — the
  // csrf result — rather than pinning one variable name.
  check(/csrfDenied\(/.test(source) && !/csrfDenied\(\s*(csrf|__csrf|csrfResult)\b/.test(source),
    `${name} calls csrfDenied with the wrong argument order`);
}

// ---------------------------------------------------------------------------
// 4. Account enumeration
// ---------------------------------------------------------------------------
const login = fnSource['builder-portal-login'] ?? '';
check(login.includes('portalUser?.password_hash || DUMMY_PASSWORD_HASH'),
  'Builder login does not verify a dummy hash for a missing account — a timing oracle');
check(
  login.indexOf('await verifyPassword(password, candidateHash)') > 0
  && login.indexOf('await verifyPassword(password, candidateHash)')
     < login.indexOf('portalUser.locked_until'),
  'Builder login evaluates account state before proving the password');
check(login.includes('GENERIC_AUTH_ERROR'),
  'Builder login does not use a single generic credential error');
// The invariant is the ORDER — throttle, then look the account up — so that
// enumeration cannot outrun the limiter. This used to assert on the raw
// `check_and_bump_rate_limit` RPC name, which the function stopped calling
// directly when it moved onto the shared `enforceAuthRateLimit` helper
// (_shared/authRateLimit.ts, which calls `security_consume_rate_limit` and
// falls back to that RPC). Asserting the old literal made a security
// improvement read as a regression, so assert the helper instead — the same
// thing `scripts/security/check-auth-rate-limit-coverage.mjs` looks for.
check(
  login.indexOf('enforceAuthRateLimit(') > 0
  && login.indexOf('enforceAuthRateLimit(') < login.indexOf("from('builder_portal_users')"),
  'Builder login looks an account up before throttling');
check(
  migrationCode.includes('consume_builder_portal_reset_attempt')
  && /IS DISTINCT FROM p_token_hash[\s\S]{0,200}status := 'not_found'/.test(migrationCode),
  'a wrong reset code is distinguishable from an unknown account');

// ---------------------------------------------------------------------------
// 5. Deny by default, and the forbidden data domains
// ---------------------------------------------------------------------------
check(!/\?\?\s*true/.test(portalAuth) && !/\|\|\s*true\b/.test(portalAuth),
  'the Builder permission resolver has a default-allow fallback');
for (const key of [
  'income', 'expenses', 'assets', 'liabilities', 'employment',
  'borrowing_capacity', 'serviceability', 'commissions',
  'aml_restricted', 'smr', 'mlro', 'legal_privileged',
  'finance_private', 'command_private', 'solicitor_private',
  'builder_invoices', 'build_progress_payments',
]) {
  check(portalAuthRaw.includes(`'${key}'`),
    `forbidden Builder Portal key is not centrally denied: ${key}`);
}

// The Finance-owned tables must not be read by any Builder function, whatever
// their names suggest.
for (const [name, source] of Object.entries(fnSource)) {
  for (const table of ['builder_invoices', 'build_progress_payments']) {
    check(!new RegExp(`from\\(['"]${table}['"]\\)`).test(source),
      `${name} reads the Finance-owned ${table}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Schema posture
// ---------------------------------------------------------------------------
check(!/USING\s*\(\s*true\s*\)/i.test(migrationCode),
  'a Builder policy is written with an unrestricted USING (true)');
check(!/ADD COLUMN[^;]*\b(session_token|reset_token|invite_token)\b(?!_hash)/.test(migrationCode),
  'a plaintext credential column was added to a Builder table');
check(!/INSERT INTO\s+public\.cross_portal_firm_rollouts/i.test(migrationCode),
  'a Builder migration enables a rollout row — the external portal must stay off');

// ---------------------------------------------------------------------------
// 7. Registration and function inventory
// ---------------------------------------------------------------------------
check(
  JSON.stringify(functionDirs) === JSON.stringify(EXPECTED_FUNCTIONS),
  `unexpected Builder Edge Function set: ${functionDirs.join(', ')}`);

const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));
for (const name of EXPECTED_FUNCTIONS) {
  check(configToml.includes(`[functions.${name}]`), `${name} is not declared in supabase/config.toml`);
  check(Boolean(registry.functions[name]), `${name} is not listed in SECURITY_REGISTRY.json`);
}

// ---------------------------------------------------------------------------
// 8. Permanent browser boundary: service-role credentials must never enter src
// ---------------------------------------------------------------------------
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const builderSources = walk(new URL('src/', root).pathname)
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .filter((path) => /builder[Pp]ortal|builder-portal|pages\/builder\//.test(path));

check(builderSources.length > 0, 'no Builder frontend sources were found to check');
for (const path of builderSources) {
  const source = readFileSync(path, 'utf8');
  check(
    !/(?:VITE_[A-Z0-9_]*SERVICE_ROLE|import\.meta\.env\.[A-Z0-9_]*SERVICE_ROLE|process\.env\.[A-Z0-9_]*SERVICE_ROLE)/i.test(source),
    `Builder browser source reads a service-role credential: ${path}`);
  check(
    !/localStorage|sessionStorage|document\.cookie/.test(stripJs(source)),
    `Builder browser source persists authentication state in the browser: ${path}`);
}

if (failures.length) {
  console.error('Builder / Developer Portal security check failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(
  `Builder / Developer Portal security check passed (${functionDirs.length} Edge Functions, `
  + `${builderSources.length} browser sources; session transport, CSRF, enumeration, `
  + 'deny-by-default and credential boundary checked).');
