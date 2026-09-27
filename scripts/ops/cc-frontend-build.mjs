#!/usr/bin/env node
/**
 * WHICH BUILD DOES THE COMMAND CENTRE'S PUBLISHED FRONTEND SERVE?
 *
 * docs/builder-portal/64 §4. The Command Centre's frontend reaches production
 * through Lovable's publish, and Lovable reports a publish as STARTED, never
 * as served: an earlier session could only record "confirmed as started, not
 * as served", because a sandbox's egress refuses both origins. A GitHub runner
 * reaches them, so this asks the live origins themselves.
 *
 * The build names its commit twice (the Command Centre's `vite.config.ts`):
 * `/version.json`, and a string literal compiled into the entry bundle. For
 * each origin it reads the manifest, then the index.html a browser gets and
 * the entry script that page loads, and requires the two to name the same
 * build — the manifest alone is a static file and proves nothing about the
 * JavaScript a browser runs. With CC_EXPECTED_BUILD (the workflow's
 * `cc_build`) it also requires that build to be that commit; without it, it
 * records what is served. The origins must agree with each other.
 *
 * Read-only: it fetches public pages and nothing else. No token, no database,
 * no write. Runs from the production-rollout workflow (phase
 * `cc-frontend-build`).
 */
import { describeRefusal, entryScriptOf, judgeServedBuild, readBuildManifest } from './ccFrontendBuild.pure.mjs';

const ORIGINS = (process.env.CC_FRONTEND_ORIGINS
  || 'https://command-centre.npcservices.com.au,https://npc-property-dashbord.lovable.app')
  .split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
const EXPECTED = String(process.env.CC_EXPECTED_BUILD || '').trim().toLowerCase();
const TIMEOUT_MS = 30_000;

if (EXPECTED && !/^[0-9a-f]{7,40}$/.test(EXPECTED)) {
  console.error('::error::cc-frontend-build: CC_EXPECTED_BUILD must be a commit id (7 to 40 hex characters)');
  process.exit(1);
}
for (const origin of ORIGINS) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
    console.error(`::error::cc-frontend-build: not an https origin: ${origin}`);
    process.exit(1);
  }
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** Fetched past every cache layer; the query string defeats intermediaries that ignore Cache-Control. */
async function get(url) {
  const bust = `${url.includes('?') ? '&' : '?'}proof=${Date.now().toString(36)}`;
  const response = await fetch(`${url}${bust}`, {
    cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'cache-control': 'no-cache' },
  });
  return {
    status: response.status, url: response.url, text: await response.text(),
    server: response.headers.get('server'), mitigated: response.headers.get('cf-mitigated'),
  };
}

/** What an answer that is not 200 says about who refused it. */
const refusal = (answer) => (answer.status === 200 ? null : describeRefusal({
  status: answer.status, server: answer.server, mitigated: answer.mitigated, body: answer.text,
}));

console.log(`Command Centre frontend build${EXPECTED ? ` (expected ${EXPECTED})` : ' (recording what is served)'}`);
const served = [];
for (const origin of ORIGINS) {
  try {
    const manifestAnswer = await get(`${origin}/version.json`);
    const manifest = manifestAnswer.status === 200 ? readBuildManifest(manifestAnswer.text) : null;
    const page = await get(`${origin}/`);
    const entry = page.status === 200 ? entryScriptOf(page.text) : null;
    let entryCarriesId = false;
    let entryStatus = 0;
    if (entry && manifest) {
      const script = await get(new URL(entry, page.url).toString());
      entryStatus = script.status;
      entryCarriesId = script.status === 200 && script.text.includes(JSON.stringify(manifest.buildId));
    }
    const verdict = judgeServedBuild({ manifest, entryCarriesId, expected: EXPECTED });
    const landed = new URL(page.url).origin;
    record(`${origin} serves ${manifest?.buildId ?? 'no build id'}${landed !== origin ? ` (answered by ${landed})` : ''}`,
      verdict.ok,
      [`version.json ${refusal(manifestAnswer) ?? 'HTTP 200'}`, `page ${refusal(page) ?? 'HTTP 200'}`,
        `entry ${entry ?? 'none'} HTTP ${entryStatus || '-'}`, ...verdict.reasons].join('; '));
    if (manifest) served.push(manifest.buildId);
  } catch (error) {
    record(`${origin} answered`, false, String(error?.message ?? error).slice(0, 200));
  }
}
if (served.length > 1) {
  record('every origin serves the same build', new Set(served).size === 1, [...new Set(served)].join(', '));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
console.log(failed.length ? 'COMMAND CENTRE FRONTEND BUILD NOT PROVED' : 'COMMAND CENTRE FRONTEND BUILD PROVED');
process.exit(failed.length ? 1 : 0);
