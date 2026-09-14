#!/usr/bin/env node
/**
 * Every Edge Function declares `verify_jwt` explicitly.
 *
 * ## Why silence is not neutral
 *
 * An omitted `[functions.X]` block in `supabase/config.toml` reads, to the
 * Supabase CLI, as `verify_jwt = true` — the gateway checks a Supabase JWT in
 * front of the function. That is an assertion, not an absence of one, and on
 * 15 Aug 2026 it was wrong for **91 of 425 functions**: every one of them had no
 * block at all and every one is deployed with the check OFF.
 *
 * Two things came of that.
 *
 * `finance-portal-snoozes` has a `run_due` cron branch that returns before the
 * partner-session check. Its comment read "callable without partner session
 * (cron + service)" — the author took the gateway JWT to be standing in front
 * of it. Nothing was: an unauthenticated `{"operation":"run_due"}` from
 * anywhere on the internet reached the branch and ran it under the service
 * client. Probed against production, the request reached the *function*, where
 * a genuinely guarded function answers the gateway's
 * `UNAUTHORIZED_NO_AUTH_HEADER`.
 *
 * And the risk runs the other way too. `supabase/config.toml`'s own `[functions.mcp]`
 * block records it: that function had no entry either, and the first deploy to
 * apply the default "would otherwise have silently flipped a working endpoint to
 * true and broken every MCP client". An undeclared function is a working
 * endpoint waiting for a deploy to break it.
 *
 * ## What this checks
 *
 * Every directory under `supabase/functions/` with an `index.ts` must have a
 * `[functions.<name>]` section here containing an explicit
 * `verify_jwt = true|false`. The value is not judged — only its presence. What
 * the right value is depends on how the function authenticates, which this gate
 * cannot know; that silence is never the answer, it can.
 *
 * This does NOT check the deployed value. The deploy workflow does that, after
 * deploying, against the Management API — a gate in CI cannot see production and
 * would have to guess.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const functionsDir = join(root, 'supabase', 'functions');
const configPath = join(root, 'supabase', 'config.toml');

const functions = readdirSync(functionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== '_shared')
  .filter((e) => {
    try { return statSync(join(functionsDir, e.name, 'index.ts')).isFile(); } catch { return false; }
  })
  .map((e) => e.name)
  .sort();

/** `[functions.NAME]` … `verify_jwt = true|false` before the next `[section]`. */
function declaredVerifyJwt(toml) {
  const declared = new Map();
  let current = null;
  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    const section = /^\[functions\.([A-Za-z0-9_-]+)\]$/.exec(trimmed);
    if (section) { current = section[1]; continue; }
    if (trimmed.startsWith('[')) { current = null; continue; }
    if (!current) continue;
    const value = /^verify_jwt\s*=\s*(true|false)\b/.exec(trimmed);
    if (value) { declared.set(current, value[1] === 'true'); current = null; }
  }
  return declared;
}

const declared = declaredVerifyJwt(readFileSync(configPath, 'utf8'));
const undeclared = functions.filter((fn) => !declared.has(fn));

console.log(
  `verify_jwt declarations: ${functions.length} function(s), `
  + `${functions.length - undeclared.length} declared, ${undeclared.length} missing.`,
);

if (undeclared.length) {
  console.error(
    `\nverify_jwt gate FAILED — ${undeclared.length} function(s) with no explicit declaration:\n`,
  );
  for (const fn of undeclared) console.error(` - ${fn}`);
  console.error(
    '\nAdd a block to supabase/config.toml for each:\n'
    + '\n    [functions.<name>]\n    verify_jwt = false   # or true\n'
    + '\nOmitting it is not "no opinion" — the CLI reads it as `true`, which asserts that\n'
    + 'the gateway is checking a Supabase JWT in front of the function. Choose the value\n'
    + 'from how the function authenticates:\n'
    + '  false — it authenticates its own callers (session cookie, portal session token,\n'
    + '          or a signed-internal HMAC), or it is called from a browser at all: a\n'
    + '          CORS preflight carries no Authorization header, so the gateway refuses\n'
    + '          it before the function runs.\n'
    + '  true  — the Supabase JWT genuinely is the credential (service-to-service callers\n'
    + '          that present one), and no browser calls it directly.\n',
  );
  process.exit(1);
}

console.log('verify_jwt gate passed (every function declares one).');
process.exit(0);
