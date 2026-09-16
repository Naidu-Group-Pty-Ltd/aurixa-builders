#!/usr/bin/env node
/**
 * ABUSE-003 — every door that accepts a credential is budgeted, through the
 * shared limiter, keyed on an address the caller cannot choose.
 *
 * `_shared/authRateLimit.ts` has named this gate in its header since it was
 * written. The gate did not exist. The security audit of 16 Sep 2026 found
 * four doors that had drifted: `builder-portal-accept-invite` and
 * `-verify-email` hand-rolled a limiter keyed on `X-Forwarded-For` — a header
 * the caller sets, so a fresh value per request was an unlimited allowance,
 * and both refused only on an explicit `false`, letting an RPC error through;
 * `-change-password` had no ceiling at all; the closed registration door wrote
 * an unbounded row per request. This file is what stops that happening again.
 *
 * Three rules, each a separate failure:
 *
 *   1. Every REQUIRED door consumes the shared limiter (`enforceAuthRateLimit`
 *      or `beginAuthRateLimit`). Nothing else counts as a ceiling.
 *   2. No auth door calls the rate-limit RPCs directly. The module exists so
 *      that the fallback posture, the untrusted-address multiplier and the
 *      IP-before-identifier ordering are decided in ONE place; a direct call
 *      is how each of those is quietly lost.
 *   3. No auth door reads `X-Forwarded-For` for any purpose. Bucketing on it
 *      enforces nothing, and RECORDING it fills the security log with
 *      addresses of the attacker's choosing.
 *
 * Rule 3 applies to EVERY TypeScript file the edge runtime carries — the
 * shared modules included, which is where the two worst instances hid — and
 * rule 2 to every door and shared module. Neither is limited to the
 * credential doors — which is how this gate paid for itself on its first run,
 * catching `-invite` writing a caller-set address into the activity log and
 * `-verify` hashing one into the record of a binding agreement acceptance.
 *
 * Every function must be classified: REQUIRED, SESSION_SURFACES, or EXEMPT
 * with a stated reason. A new one that is classified nowhere fails the gate,
 * so the author has to decide which it is rather than inherit a default.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const repoRoot = resolve(new URL('.', import.meta.url).pathname, '../..');
const functionsDir = join(repoRoot, 'supabase/functions');

/** Doors that accept a credential — a password, or a token from an e-mail. */
const REQUIRED = new Set([
  'builder-portal-login',
  'builder-portal-register',
  'builder-portal-accept-invite',
  'builder-portal-verify-email',
  'builder-portal-forgot-password',
  'builder-portal-reset-password',
  'builder-portal-change-password',
]);

/**
 * Doors that do not, with the reason each is not a guessing surface. Named
 * one by one rather than pattern-matched, because "this endpoint does not need
 * a ceiling" is a judgement that should be written down and re-read.
 */
const EXEMPT = new Map([
  ['builder-portal-logout', 'destroys the caller\'s own session; presents no credential to guess'],
  ['builder-portal-verify', 'session restore — the cookie is already the credential, and a ceiling here would log people out of a working session'],
  ['builder-portal-invite', 'session-authenticated and permission-gated to owner/admin; a ceiling would cap legitimate onboarding rather than an attacker'],
]);

/**
 * The business surfaces. Every one of them resolves a session cookie before it
 * does anything, and that cookie was issued by a door in REQUIRED — so the
 * guessing surface is already budgeted upstream and a second ceiling here
 * would only throttle people doing their jobs. They are still held to the
 * address rules below, which is how this gate caught two of them writing a
 * caller-set address into an audit record.
 */
const SESSION_SURFACES = new Set([
  'builder-portal-collaboration',
  'builder-portal-construction',
  'builder-portal-delivery',
  'builder-portal-inventory',
  'builder-portal-projects',
  'builder-portal-stock',
  'builder-portal-transactions',
  'builder-portal-workspace',
]);

/** Comments are not code: a rule must hold in what actually runs. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const failures = [];
const checked = [];

const doors = readdirSync(functionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^builder-portal-/.test(e.name))
  .map((e) => e.name)
  .sort();

for (const door of doors) {
  const file = join(functionsDir, door, 'index.ts');
  if (!existsSync(file)) continue;
  const code = stripComments(readFileSync(file, 'utf8'));

  const required = REQUIRED.has(door);
  const exempt = EXEMPT.has(door);
  const surface = SESSION_SURFACES.has(door);
  if (!required && !exempt && !surface) {
    failures.push(
      `${door} is classified nowhere. Add it to REQUIRED if it accepts a credential, `
      + 'to SESSION_SURFACES if a session cookie is its only credential, or to EXEMPT '
      + 'with the reason it is not a guessing surface.',
    );
    continue;
  }

  const budgeted = /\b(enforceAuthRateLimit|beginAuthRateLimit)\s*\(/.test(code);
  if (required && !budgeted) {
    failures.push(`${door} accepts a credential but consumes no shared rate limit.`);
  }

  const rawRpc = /\.rpc\(\s*['"](check_and_bump_rate_limit|security_consume_rate_limit)['"]/.test(code);
  if (rawRpc) {
    failures.push(
      `${door} calls a rate-limit RPC directly. Go through _shared/authRateLimit.ts, `
      + 'which decides the fallback posture, the untrusted-address multiplier and the '
      + 'IP-before-identifier ordering in one place.',
    );
  }

  if (/x-forwarded-for/i.test(code)) {
    failures.push(
      `${door} reads X-Forwarded-For. The caller appends to it, so bucketing on it `
      + 'enforces nothing and recording it fills the log with addresses of their '
      + 'choosing. Use getTrustedClientIp / getPortalClientIp.',
    );
  }

  checked.push(`${door}: ${
    required ? (budgeted ? 'budgeted' : 'UNBUDGETED') : surface ? 'session surface' : 'exempt'
  }`);
}

for (const door of REQUIRED) {
  if (!doors.includes(door)) failures.push(`${door} is listed as required but no such function exists.`);
}
for (const door of EXEMPT.keys()) {
  if (!doors.includes(door)) failures.push(`${door} is listed as exempt but no such function exists.`);
}
for (const door of SESSION_SURFACES) {
  if (!doors.includes(door)) failures.push(`${door} is listed as a session surface but no such function exists.`);
}

/**
 * RULE 3 EVERYWHERE ELSE TOO.
 *
 * Scanning only the handlers was a blind spot, and it hid the two worst
 * instances: `_shared/builderSessions.ts` fingerprinted every ISSUED SESSION
 * with `X-Forwarded-For`, so the recorded origin of a session was whatever the
 * person signing in typed; `_shared/builderPortalAuth.ts` wrote the same value
 * onto EVERY project activity record, which is the shared path all eight
 * business surfaces log through. One helper each, reached from everywhere.
 *
 * So every TypeScript file the edge runtime carries is checked — the shared
 * modules and the network functions, not only the portal doors.
 *
 * `api/_shared/fnProxyPolicy.pure.ts` is deliberately out of scope: it runs on
 * the PROXY, where `x-forwarded-for` is written by the platform and is the
 * honest answer. The danger is believing it AFTER a hop, which is here.
 */
const runtimeFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (entry.isFile() && entry.name.endsWith('.ts')) runtimeFiles.push(full);
  }
})(functionsDir);

let scanned = 0;
for (const file of runtimeFiles) {
  const rel = relative(repoRoot, file);
  const code = stripComments(readFileSync(file, 'utf8'));
  scanned += 1;
  if (/x-forwarded-for/i.test(code)) {
    failures.push(
      `${rel} reads X-Forwarded-For. The caller appends to it, so bucketing on it `
      + 'enforces nothing and recording it fills the log with addresses of their '
      + 'choosing. Use getTrustedClientIp / getPortalClientIp.',
    );
  }
  // Rule 2 over the shared modules, with the limiter's own internals and the
  // two general-purpose primitives excepted — they ARE the one place.
  const isLimiterInternals = /_shared\/(authRateLimit|requestSecurity|publicAbuseControls)\.ts$/.test(rel);
  if (rel.includes('_shared/') && !isLimiterInternals
      && /\.rpc\(\s*['"](check_and_bump_rate_limit|security_consume_rate_limit)['"]/.test(code)) {
    failures.push(
      `${rel} calls a rate-limit RPC directly. Go through _shared/authRateLimit.ts.`,
    );
  }
}

if (failures.length) {
  console.error(`\nauth rate-limit coverage gate FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}

console.log(checked.map((line) => `  ${line}`).join('\n'));
console.log(
  `auth rate-limit coverage gate passed (${REQUIRED.size} credential door(s) budgeted, `
  + `${SESSION_SURFACES.size} session surface(s), ${EXEMPT.size} exempt with a stated reason; `
  + `${scanned} runtime file(s) scanned, 0 reading X-Forwarded-For).`,
);
