/**
 * Turnstile identity: one widget, one deployment — NETWORK EDITION.
 *
 * A widget is a (site key, secret) pair. The prime's site key was once a
 * literal in `components/auth/TurnstileWidget.tsx`, and every repository
 * mirrored from it inherited that literal verbatim — one credential, one
 * rotation and one domain allowlist spanning tenants that are supposed to be
 * separate. The prime's spec enforces "named in exactly one module" plus the
 * backend-pairing rule for its built-in.
 *
 * The network's rule is stricter and simpler: there is NO built-in at all.
 * The site key comes from this deployment's own environment or the login
 * page says "not configured". So this spec asserts three things:
 *
 *   1. No Turnstile site-key literal appears anywhere in `src/` — including
 *      the prime's own key, which is the literal a port would drag along.
 *   2. The static `import.meta.env` read of the site-key variable is
 *      spelled in exactly one module, the resolver — a mirror has one thing
 *      to change rather than a search to run.
 *   3. The resolver's behaviour: env wins, unset resolves to no key AND says
 *      which variable to set, and it never invents a key.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveTurnstileSiteKey, TURNSTILE_SITE_KEY_ENV } from '../turnstileSiteKey';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');

/** The one module allowed to read the environment variable. */
const RESOLVER = join('src', 'lib', 'turnstileSiteKey.ts');

/**
 * A Cloudflare Turnstile site key: `0x4` then base62ish. The prime's own key
 * matches this shape, so the assertion catches both "someone pasted a key"
 * and "the port carried the prime's literal across".
 */
const SITE_KEY_LITERAL = /0x4[A-Za-z0-9_-]{20,}/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no site-key literal exists in this repository', () => {
  it('nothing in src/ carries a Turnstile site key', () => {
    // This spec's own regex source does not match itself (character classes
    // are not a key), so nothing is exempted.
    const offenders = walk(SRC)
      .filter((f) => SITE_KEY_LITERAL.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe('the environment read is spelled in exactly one module', () => {
  it('only the resolver spells the static environment read', () => {
    // The needle is composed from the constant so this spec does not itself
    // become a second module spelling the read it is counting.
    const readers = walk(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes(`import.meta.env.${TURNSTILE_SITE_KEY_ENV}`))
      .map((f) => relative(REPO_ROOT, f));
    expect(readers).toEqual([RESOLVER]);
  });

  it('everything else names the variable through the exported constant', () => {
    // Composed, so this spec is not a second spelling of the read itself.
    expect(TURNSTILE_SITE_KEY_ENV).toBe(['VITE_TURNSTILE', 'SITE_KEY'].join('_'));
  });
});

describe('the resolver', () => {
  it('uses the configured key when one is set', () => {
    const r = resolveTurnstileSiteKey({ configured: ' 0xNETWORKKEY ' });
    expect(r).toEqual({ siteKey: '0xNETWORKKEY', source: 'env', warning: null });
  });

  it('resolves to no key — and says so — when nothing is configured', () => {
    for (const configured of [undefined, null, '', '   ']) {
      const r = resolveTurnstileSiteKey({ configured });
      expect(r.siteKey).toBeNull();
      expect(r.source).toBe('unset');
      // The warning must name the variable an operator has to set, and must
      // state the rule that stops the tempting fix.
      expect(r.warning).toContain(TURNSTILE_SITE_KEY_ENV);
      expect(r.warning).toContain("another tenant's");
    }
  });
});
