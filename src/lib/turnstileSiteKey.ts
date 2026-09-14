/**
 * NETWORK EDITION — the one place that decides which Turnstile widget this
 * build renders.
 *
 * A Turnstile widget IS a (site key, secret) pair: the site key is public and
 * drawn by the browser, `TURNSTILE_SECRET_KEY` is its twin in the backend, and
 * `siteverify` reports the hostname a token was solved on — which no login
 * handler reads. A shared widget therefore means a token farmed from ANY
 * deployment's login page satisfies the CAPTCHA on every other one. The prime
 * repo learned this when its mirror inherited the site-key literal verbatim.
 *
 * The prime's edition carries a BUILT-IN pair guarded by the backend-pairing
 * rule (the built-in key is used only while the build talks to the Supabase
 * project its secret lives in). This edition carries NO built-in at all:
 * the network is a different product with its own widget, and the only place
 * its site key may come from is this deployment's own environment. An unset
 * key resolves to no key and says so — the login page renders "not
 * configured" rather than another tenant's widget.
 *
 * Aurixa Mission Control provisions the network's widget and publishes
 * `VITE_TURNSTILE_SITE_KEY` to its hosting project (plan §5); the secret's
 * twin, `TURNSTILE_SECRET_KEY`, lives in the network's Supabase project.
 */

/** The environment variable that carries this deployment's own site key. */
export const TURNSTILE_SITE_KEY_ENV = 'VITE_TURNSTILE_SITE_KEY';

export type TurnstileSiteKeyResolution = {
  /** The site key to render, or null when this build has none. */
  siteKey: string | null;
  source: 'env' | 'unset';
  /** Operator-facing reason, present whenever `siteKey` is null. */
  warning: string | null;
};

/**
 * Resolve the site key. Exported and pure so the rule is testable without
 * stubbing `import.meta`. There is deliberately no built-in branch: the
 * network edition's whole rule is "the environment or nothing".
 */
export function resolveTurnstileSiteKey(input: {
  configured?: string | null;
}): TurnstileSiteKeyResolution {
  const configured = typeof input.configured === 'string' ? input.configured.trim() : '';
  if (configured.length > 0) {
    return { siteKey: configured, source: 'env', warning: null };
  }
  return {
    siteKey: null,
    source: 'unset',
    warning: `${TURNSTILE_SITE_KEY_ENV} is not set. This deployment has no Turnstile widget of its own, and it must never render another tenant's.`,
  };
}

/**
 * Read the configured site key.
 *
 * STATIC on purpose. Vite replaces the exact expression
 * `import.meta.env.VITE_TURNSTILE_SITE_KEY` with the value at BUILD time. A
 * dynamic lookup — `import.meta.env[name]` — is not an expression the bundler
 * can see through, so it is never replaced and reads `undefined` in a
 * production bundle however the environment is set. That silent shape cost
 * the prime's mirror a byte-identical rebuild after the variable was
 * published. Do not refactor this into a helper that takes the name as an
 * argument: `TURNSTILE_SITE_KEY_ENV` above is the name for MESSAGES; this is
 * the read.
 */
function readConfiguredSiteKey(): string | undefined {
  try {
    const value = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

let resolved: TurnstileSiteKeyResolution | null = null;

/** Resolved once per module load, so the console says it once. */
export function turnstileSiteKey(): TurnstileSiteKeyResolution {
  if (!resolved) {
    resolved = resolveTurnstileSiteKey({ configured: readConfiguredSiteKey() });
    if (resolved.warning) {
      console.error(`[turnstile] ${resolved.warning}`);
    }
  }
  return resolved;
}
