/**
 * THE SECURITY REMEDIATION OF 17 SEPTEMBER 2026, PINNED.
 *
 * Every fix in this file answers a finding from the Builder Portal forensic
 * audit. Where a rule can be exercised, it is exercised; where the rule lives
 * in a handler that cannot be imported into a Node test (an Edge function is a
 * `Deno.serve` with esm.sh imports), it is pinned at the source, because a fix
 * that is silently deleted later is the same as no fix.
 *
 * The database half of the remediation — anon holding EXECUTE on 124
 * privileged functions, and six governed commands that would update a child
 * row belonging to another organisation — is proven by EXECUTION in
 * `scripts/db/baseline-check.mjs` ("privileged functions answer to
 * service_role and to nobody else" and "a child write never escapes the parent
 * the caller was authorised for"), because only a real database can answer it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localDevOrigins,
  LOCAL_DEV_ORIGIN_LIST,
} from '../../../supabase/functions/_shared/localDevOrigins';
import { validateBuilderPortalHeaders } from '../../../supabase/functions/_shared/builderSessionToken';
import { enforceCsrf } from '../../../supabase/functions/_shared/csrfGuard';
import { isAcceptableStoragePath } from '../../../supabase/functions/_shared/builderCollaboration';
import { checkLeakedPassword } from '../../../supabase/functions/_shared/leakedPasswordCheck';
import { trustedClientIpFromPlatform } from '../../../api/_shared/fnProxyPolicy.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
/** Source with comments removed — a rule must be in the CODE, not in prose. */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const FN = (name: string) => `supabase/functions/${name}/index.ts`;
const PRODUCTION_ORIGIN = 'https://builders.aurixasystems.com.au';

/** Stand in for the Deno environment the Edge runtime provides. */
function setDenoEnv(vars: Record<string, string>) {
  (globalThis as unknown as { Deno?: unknown }).Deno = {
    env: { get: (key: string) => vars[key] },
  };
}

describe('local development origins are opt-in, not standing production trust', () => {
  const savedDeno = (globalThis as unknown as { Deno?: unknown }).Deno;
  afterEach(() => {
    (globalThis as unknown as { Deno?: unknown }).Deno = savedDeno;
  });

  it('no Deno environment at all yields no local origins', () => {
    delete (globalThis as unknown as { Deno?: unknown }).Deno;
    expect(localDevOrigins()).toEqual([]);
  });

  it('the flag unset — every deployed project — yields no local origins', () => {
    setDenoEnv({});
    expect(localDevOrigins()).toEqual([]);
  });

  it('only the exact opt-in returns them, and it is case- and space-tolerant', () => {
    setDenoEnv({ ALLOW_LOCAL_DEV_ORIGINS: 'true' });
    expect(localDevOrigins()).toEqual([...LOCAL_DEV_ORIGIN_LIST]);
    setDenoEnv({ ALLOW_LOCAL_DEV_ORIGINS: '  TRUE ' });
    expect(localDevOrigins()).toEqual([...LOCAL_DEV_ORIGIN_LIST]);
  });

  it('anything else is off — a truthy-looking value is not an opt-in', () => {
    for (const value of ['false', '1', 'yes', 'TRUE!', '']) {
      setDenoEnv({ ALLOW_LOCAL_DEV_ORIGINS: value });
      expect(localDevOrigins(), `value ${JSON.stringify(value)}`).toEqual([]);
    }
  });

  it('the portal request guard refuses a localhost origin in production', () => {
    setDenoEnv({});
    const headers = new Headers({
      'x-portal-request': 'builder-portal',
      origin: 'http://localhost:5173',
    });
    expect(validateBuilderPortalHeaders(headers)).toBe(false);
  });

  it('...and accepts it in a development environment that asked for it', () => {
    setDenoEnv({ ALLOW_LOCAL_DEV_ORIGINS: 'true' });
    const headers = new Headers({
      'x-portal-request': 'builder-portal',
      origin: 'http://localhost:5173',
    });
    expect(validateBuilderPortalHeaders(headers)).toBe(true);
  });

  it('the production origin is unaffected either way', () => {
    const headers = new Headers({
      'x-portal-request': 'builder-portal',
      origin: PRODUCTION_ORIGIN,
    });
    setDenoEnv({});
    expect(validateBuilderPortalHeaders(headers)).toBe(true);
    setDenoEnv({ ALLOW_LOCAL_DEV_ORIGINS: 'true' });
    expect(validateBuilderPortalHeaders(headers)).toBe(true);
  });

  it('the CSRF guard follows the same rule for a cookie-carried mutation', () => {
    const request = () => new Request('https://builders.aurixasystems.com.au/fn/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:8080', cookie: '__Host-builder_session_token=t' },
    });
    setDenoEnv({});
    expect(enforceCsrf(request())).toEqual({
      ok: false, reason: 'origin_not_allowed', origin: 'http://localhost:8080',
    });
    setDenoEnv({ ALLOW_LOCAL_DEV_ORIGINS: 'true' });
    expect(enforceCsrf(request()).ok).toBe(true);
  });

  it('not one of the three allowlists carries a hardcoded localhost any more', () => {
    for (const file of [
      'supabase/functions/_shared/auth.ts',
      'supabase/functions/_shared/csrfGuard.ts',
      'supabase/functions/_shared/builderSessionToken.ts',
    ]) {
      expect(readCode(file), file).not.toContain('localhost:5173');
      expect(readCode(file), file).not.toContain('localhost:8080');
      expect(readCode(file), file).toContain('localDevOrigins()');
    }
  });
});

describe('a document path names the organisation that may write it', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';

  it('accepts a path inside the acting organisation own prefix', () => {
    expect(isAcceptableStoragePath(`documents/${ORG_A}/plans/site.pdf`, ORG_A)).toBe(true);
  });

  it('refuses another organisation prefix — the finding itself', () => {
    expect(isAcceptableStoragePath(`documents/${ORG_B}/plans/site.pdf`, ORG_A)).toBe(false);
  });

  it('refuses the bare shared prefix that used to be enough', () => {
    expect(isAcceptableStoragePath('documents/site.pdf', ORG_A)).toBe(false);
  });

  it('a near-miss prefix does not pass on string containment', () => {
    expect(isAcceptableStoragePath(`documents/${ORG_A}-other/site.pdf`, ORG_A)).toBe(false);
  });

  it('still refuses traversal, absolute paths, emptiness and a missing organisation', () => {
    expect(isAcceptableStoragePath(`documents/${ORG_A}/../${ORG_B}/x.pdf`, ORG_A)).toBe(false);
    expect(isAcceptableStoragePath(`/documents/${ORG_A}/x.pdf`, ORG_A)).toBe(false);
    expect(isAcceptableStoragePath('', ORG_A)).toBe(false);
    expect(isAcceptableStoragePath(null, ORG_A)).toBe(false);
    expect(isAcceptableStoragePath(`documents/${ORG_A}/x.pdf`, null)).toBe(false);
    expect(isAcceptableStoragePath(`documents/${ORG_A}/x.pdf`, '')).toBe(false);
  });

  it('the handler passes the SERVER-held active organisation, never the body', () => {
    const source = readCode(FN('builder-portal-collaboration'));
    expect(source).toContain('isAcceptableStoragePath(payload.storage_path as string, activeOrganisationId)');
    expect(source).not.toMatch(/isAcceptableStoragePath\([^)]*body\./);
  });
});

describe('the password comparison fails closed', () => {
  const source = readCode('supabase/functions/_shared/password.ts');

  it('a non-bcrypt stored value can never match — the plaintext arm is gone', () => {
    expect(source).toContain('if (!isBcryptHash) return false;');
    expect(source).not.toContain('password === storedHash');
    expect(source).not.toContain('storedHash === password');
  });

  it('and the database refuses to store one at all', () => {
    const migration = read(
      'supabase/migrations/20260917190000_a_stored_password_is_a_bcrypt_hash.sql',
    );
    expect(migration).toContain('builder_portal_users_password_hash_is_bcrypt');
    // NULL must stay legal: that is a pending invitation, which the invite
    // flow reads to tell an unaccepted seat from a live colleague.
    expect(migration).toContain('password_hash IS NULL');
    expect(migration).toContain('VALIDATE CONSTRAINT');
  });
});

describe('the breached-password check that was imported but never existed', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** SHA-1('correct horse battery staple'), the shape the range API is keyed on. */
  const hashOf = async (password: string) => {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  };

  it('sends five hex characters and nothing else, and asks for padding', async () => {
    const seen: { url: string; padding: string | null } = { url: '', padding: null };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.url = String(url);
      seen.padding = new Headers(init?.headers).get('add-padding');
      return new Response('0000000000000000000000000000000000A:5\n', { status: 200 });
    }) as typeof fetch;

    const password = 'correct horse battery staple';
    await checkLeakedPassword(password);

    const hash = await hashOf(password);
    expect(seen.url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(seen.padding).toBe('true');
    // The password, and the rest of its digest, never leave the process.
    expect(seen.url).not.toContain(password);
    expect(seen.url).not.toContain(hash.slice(5));
  });

  it('reports a breached password with its count when the suffix matches', async () => {
    const password = 'password123';
    const suffix = (await hashOf(password)).slice(5);
    globalThis.fetch = (async () => new Response(
      `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n${suffix}:2417\n`, { status: 200 },
    )) as typeof fetch;
    expect(await checkLeakedPassword(password)).toEqual({ isLeaked: true, count: 2417 });
  });

  it('a suffix that is absent is not leaked', async () => {
    globalThis.fetch = (async () => new Response(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n', { status: 200 },
    )) as typeof fetch;
    expect(await checkLeakedPassword('a password nobody has')).toEqual({ isLeaked: false, count: 0 });
  });

  it('a padding row — count zero — is not a breach', async () => {
    const password = 'padded-collision';
    const suffix = (await hashOf(password)).slice(5);
    globalThis.fetch = (async () => new Response(`${suffix}:0\n`, { status: 200 })) as typeof fetch;
    expect(await checkLeakedPassword(password)).toEqual({ isLeaked: false, count: 0 });
  });

  it('a failing service THROWS rather than answering "not leaked"', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(checkLeakedPassword('anything')).rejects.toThrow(/503/);
  });
});

describe('a rate limit is keyed on an address the caller cannot choose', () => {
  it('the proxy forwards the platform address and nothing the browser typed', () => {
    expect(trustedClientIpFromPlatform({ 'x-real-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(trustedClientIpFromPlatform({ 'x-forwarded-for': '203.0.113.8, 10.0.0.1' }))
      .toBe('203.0.113.8');
    expect(trustedClientIpFromPlatform({
      'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9',
    })).toBe('203.0.113.7');
    expect(trustedClientIpFromPlatform({ 'x-real-ip': ['203.0.113.7'] })).toBe('203.0.113.7');
    expect(trustedClientIpFromPlatform({})).toBeNull();
    expect(trustedClientIpFromPlatform({ 'x-real-ip': '   ' })).toBeNull();
  });

  it('the proxy sets it itself and never copies a client-supplied one', () => {
    const proxy = readCode('api/fn/[name].ts');
    const policy = readCode('api/_shared/fnProxyPolicy.pure.ts');
    expect(proxy).toContain("headers.set('x-portal-client-ip', clientIp)");
    // The forwarded allowlist must not carry any client-IP spelling: a
    // forwarded one is the caller's claim, which is what broke the limiter.
    const forwarded = policy.slice(policy.indexOf('FORWARDED_REQUEST_HEADERS'));
    const list = forwarded.slice(0, forwarded.indexOf(']'));
    for (const spelling of ['x-real-ip', 'x-forwarded-for', 'cf-connecting-ip', 'true-client-ip']) {
      expect(list, spelling).not.toContain(spelling);
    }
  });

  it('the forwarded address is sent ONLY with the shared secret that proves it', () => {
    const proxy = readCode('api/fn/[name].ts');
    // No secret configured means no header at all: an unauthenticated claim
    // about one's own address is the X-Forwarded-For hole under a new name.
    expect(proxy).toContain('if (clientIp && proxySecret)');
    expect(proxy).toContain("headers.set('x-portal-proxy-token', proxySecret)");
  });

  it('the runtime believes that address only when the token matches', () => {
    const source = readCode('supabase/functions/_shared/requestSecurity.ts');
    expect(source).toContain('export function getPortalClientIp');
    expect(source).toContain("Deno.env.get('PORTAL_PROXY_SHARED_SECRET')");
    expect(source).toContain('secretsMatch(presented, expected)');
    // With no secret configured it IS getTrustedClientIp — adding it cannot
    // make anything more permissive than it was.
    expect(source).toContain('return getTrustedClientIp(headers);');
    // The comparison must not short-circuit on the first differing character.
    const compare = source.slice(source.indexOf('function secretsMatch'));
    expect(compare.slice(0, 260)).toContain('diff |=');
    expect(compare.slice(0, 260)).not.toContain('return false;\n    }');
    // ...and the shared limiter is what consumes it.
    const limiter = readCode('supabase/functions/_shared/authRateLimit.ts');
    expect(limiter).toContain('getPortalClientIp(req.headers)');
    expect(limiter).not.toContain('getTrustedClientIp(req.headers)');
  });

  it('every unauthenticated auth door is budgeted through the shared limiter', () => {
    for (const fn of [
      'builder-portal-accept-invite',
      'builder-portal-verify-email',
      'builder-portal-change-password',
      'builder-portal-register',
    ]) {
      expect(readCode(FN(fn)), fn).toContain('enforceAuthRateLimit(');
    }
  });

  it('no builder portal function buckets or records a caller-set X-Forwarded-For', () => {
    // Every one of them, not just the credential doors. Two SESSION surfaces
    // were writing a caller-set address into an audit record: `-invite` into
    // the log of who invited whom, and `-verify` into the evidence of a
    // BINDING agreement acceptance.
    const dir = join(REPO_ROOT, 'supabase/functions');
    const doors = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('builder-portal-'))
      .map((e) => e.name);
    expect(doors.length).toBeGreaterThanOrEqual(18);
    for (const fn of doors) {
      expect(readCode(FN(fn)).toLowerCase(), fn).not.toContain('x-forwarded-for');
    }
  });

  it('the audit records now carry an address the platform vouched for', () => {
    expect(readCode(FN('builder-portal-invite')))
      .toContain('_ip_address: getPortalClientIp(req.headers)');
    expect(readCode(FN('builder-portal-verify')))
      .toContain('const ip = getPortalClientIp(req.headers);');
    // The two shared helpers are the ones that mattered most: one fingerprints
    // EVERY issued session, the other stamps EVERY project activity record.
    expect(readCode('supabase/functions/_shared/builderSessions.ts'))
      .toContain('return getPortalClientIp(req.headers);');
    expect(readCode('supabase/functions/_shared/builderPortalAuth.ts'))
      .toContain('_ip_address: getPortalClientIp(req.headers)');
  });

  it('nothing the edge runtime carries reads X-Forwarded-For', () => {
    // Handlers AND shared modules — scanning only the handlers is what hid the
    // session fingerprint and the activity-log stamp.
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
      }
    })(join(REPO_ROOT, 'supabase/functions'));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      expect(code.toLowerCase(), file.replace(`${REPO_ROOT}/`, '')).not.toContain('x-forwarded-for');
    }
  });

  it('a CI gate holds all of this, and it is actually wired in', () => {
    const gate = read('scripts/security/check-auth-rate-limit-coverage.mjs');
    expect(gate).toContain('x-forwarded-for');
    expect(gate).toContain('enforceAuthRateLimit|beginAuthRateLimit');
    expect(gate).toContain('check_and_bump_rate_limit|security_consume_rate_limit');
    // A gate nobody runs is a comment. It must be a script AND a CI step.
    expect(read('package.json')).toContain('check-auth-rate-limit-coverage.mjs');
    expect(read('.github/workflows/ci.yml')).toContain('npm run check:rate-limit-coverage');
    // ...and the edge typecheck must glob, not enumerate: the explicit list had
    // already drifted past `builder-network-stock-image`.
    expect(read('.github/workflows/ci.yml')).toContain('npm run typecheck:edge');
    expect(read('package.json')).toContain("deno check --config supabase/functions/deno.json supabase/functions/builder-*/index.ts");
  });

  it('the public image door is budgeted and denies when the limiter is down', () => {
    const source = readCode(FN('builder-network-stock-image'));
    expect(source).toContain('getTrustedClientIp(req.headers)');
    expect(source).toContain("rpc('check_and_bump_rate_limit'");
    // Fails CLOSED — the opposite of the login doors, and deliberate.
    expect(source).toContain('if (limitError || withinLimit !== true)');
    expect(source).toContain('status: 429');
    // ...and before any of the work it is protecting.
    expect(source.indexOf("rpc('check_and_bump_rate_limit'"))
      .toBeLessThan(source.indexOf("from('builder_stock_item_images')"));
  });
});

describe('a request body is bounded before anyone is authenticated', () => {
  const HANDLERS = [
    'builder-portal-stock', 'builder-portal-construction', 'builder-portal-delivery',
    'builder-portal-projects', 'builder-portal-inventory', 'builder-portal-transactions',
    'builder-portal-workspace', 'builder-portal-verify', 'builder-network-connections',
  ];

  /**
   * THE PROPERTY IS "BOUNDED BEFORE AUTHENTICATED", NOT "SPELLED THIS WAY".
   *
   * This asserted the literal `readBoundedJson(req, DEFAULT_MAX_BODY_BYTES)`,
   * which was the only bounded reader any of these handlers used. One of them
   * now needs the RAW text as well as the parsed object — `verifyInternal`
   * hashes the exact bytes the signer hashed, and a re-serialised object is a
   * different string — so it reads through `enforceRawBodyLimit`, which is
   * the SAME limiter: `readBoundedJson` delegates to `enforceJsonBodyLimit`,
   * which delegates to `enforceRawBodyLimit`. Same ceiling, same streaming
   * cancel, same point in the request.
   *
   * So the assertion names both readers and keeps the two things that
   * actually matter: the ceiling is `DEFAULT_MAX_BODY_BYTES`, and the bound
   * is taken before the session is resolved. Pinning a spelling here would
   * have forced the signature check to be done wrongly or not at all.
   */
  const BOUNDED_READERS = [
    'readBoundedJson(req, DEFAULT_MAX_BODY_BYTES)',
    'enforceRawBodyLimit(req, DEFAULT_MAX_BODY_BYTES)',
  ];

  it.each(HANDLERS)('%s reads a bounded body', (fn) => {
    const source = readCode(FN(fn));
    const used = BOUNDED_READERS.filter((reader) => source.includes(reader));
    expect(used.length).toBeGreaterThan(0);
    expect(source).not.toContain('await req.json()');
    // The bound is taken before the session is resolved, which is the point.
    const boundedAt = Math.min(...used.map((reader) => source.indexOf(reader)));
    expect(boundedAt).toBeLessThan(source.indexOf('resolveBuilderSession(supabase, req)'));
  });
});

describe('a hostile file cannot spend the whole isolate', () => {
  it('a workbook declared range is refused before anything walks it', () => {
    const sheets = readCode('supabase/functions/_shared/builderStock/workbookSheets.ts');
    expect(sheets).toContain('MAX_GRID_CELLS');
    expect(sheets).toContain('throw new GridTooLargeError()');
    expect(sheets.indexOf('MAX_GRID_CELLS')).toBeLessThan(sheets.indexOf('for (let r = range.s.r'));

    const extract = readCode('supabase/functions/_shared/builderStock/extract.ts');
    expect(extract).toContain("StockExtractionError(\n          'spreadsheet_too_large'");
    // Before sheet_to_json, which itself allocates a row per DECLARED row.
    expect(extract.indexOf('MAX_GRID_CELLS'))
      .toBeLessThan(extract.indexOf('XLSX.utils.sheet_to_json'));
  });

  it('a deflate stream cannot hand back more than the ceiling', () => {
    const raster = readCode('supabase/functions/_shared/builderStock/rasterPng.ts');
    expect(raster).toContain('MAX_PUMP_OUTPUT_BYTES = 64 * 1024 * 1024');
    expect(raster).toContain('collected > MAX_PUMP_OUTPUT_BYTES');
    // Cancelled mid-stream: the bytes are never held.
    expect(raster).toContain("reader.cancel('output_too_large')");
  });
});

describe('the rest of the remediation, pinned where it lives', () => {
  it('revoking an invitation revokes the membership it granted', () => {
    const source = readCode(FN('builder-portal-invite'));
    expect(source).toContain("from('builder_organisation_memberships')");
    expect(source).toContain("status: 'revoked'");
    expect(source).toContain('revoked_at:');
    // Only for a seat that was never accepted — an active colleague is not
    // silently removed by an invitation revocation.
    expect(source).toContain('if (!target.invite_accepted_at && !target.password_hash)');
  });

  it('the JWKS grace period has a ceiling and every fallback honours it', () => {
    const source = readCode('supabase/functions/_shared/mcFederation.ts');
    expect(source).toContain('JWKS_MAX_STALE_MS = JWKS_TTL_MS * 12');
    expect(source).toContain('function usableStaleKeys()');
    expect(source).not.toContain('jwksCache?.keys ?? null');
    expect(source.match(/usableStaleKeys\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('the Google credential is scrubbed out of every log line that could carry it', () => {
    const source = read('supabase/functions/_shared/builderStock/images.ts');
    expect(source).toContain('function withoutApiKey');
    // Deno puts the FULL request URL — `key=` and all — into the TypeError it
    // throws for a request that never completed. Every place this file turns
    // such an error into a log line must go through the scrubber, so the
    // wrapped count and the total count have to be the same number.
    const stringified = source.match(/String\(\(error as \{ message\?: string \}\)\?\.message \?\? error\)/g) ?? [];
    const scrubbed = source.match(/withoutApiKey\(String\(\(error as \{ message\?: string \}\)\?\.message \?\? error\)\)/g) ?? [];
    expect(stringified.length).toBeGreaterThan(0);
    expect(scrubbed.length).toBe(stringified.length);
    // ...and the scrubber keeps the diagnostic while losing only the value.
    const scrub = (m: string) => m.replace(/([?&])key=[^&#\s)\]"']*/gi, '$1key=REDACTED');
    expect(scrub('error sending request for url (https://maps.googleapis.com/x?address=1&key=AIzaSECRET): dns error'))
      .toBe('error sending request for url (https://maps.googleapis.com/x?address=1&key=REDACTED): dns error');
  });

  it('refreshing brochure links requires edit, like every other act on a list', () => {
    const source = readCode(FN('builder-portal-stock'));
    const at = source.indexOf("operation === 'refresh_brochure_links'");
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 400)).toContain("await can('edit')");
  });

  it('a password reset compares the code before it says anything about the account', () => {
    const migration = read(
      'supabase/migrations/20260917180000_reset_attempt_compares_the_hash_first.sql',
    );
    const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));
    const hashCheck = body.indexOf('reset_token_hash');
    expect(hashCheck).toBeGreaterThan(-1);
    // The hash comparison comes before either state branch can answer.
    expect(hashCheck).toBeLessThan(body.indexOf("'too_many'"));
    expect(hashCheck).toBeLessThan(body.indexOf("'expired'"));
  });
});

describe('how long a Builder Portal session lasts', () => {
  it('survives four hours without a request, and never more than twelve in all', () => {
    const code = readCode('supabase/functions/_shared/builderSessions.ts');
    expect(code).toMatch(/export const BUILDER_SESSION_IDLE_MINUTES = 240;/);
    expect(code).toMatch(/export const BUILDER_SESSION_ABSOLUTE_HOURS = 12;/);
    // The idle window is what the database slides on every request, so the
    // constant must be the one handed to it rather than a second copy.
    expect(code).toContain('_idle_minutes: BUILDER_SESSION_IDLE_MINUTES');
  });
});
