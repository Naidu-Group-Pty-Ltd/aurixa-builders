/**
 * A SHORT-LIVED CLOUDFLARE WORKER THAT LENDS A PROOF CLOUDFLARE'S OWN BROWSER.
 *
 * Browser Run's REST API needs a token permission this repository's Cloudflare
 * token does not carry ("10000 Authentication error", measured 1 October 2026),
 * while a Worker's Browser Run BINDING draws on the Worker's own account and
 * needs nothing beyond what deploying a Worker already needs. So a proof that
 * must see a Command Centre page — which both of its origins refuse to a
 * GitHub runner's Chromium with a bot challenge — deploys one of these under a
 * run-specific name, calls it with a one-off secret, and deletes it in the same
 * run. Its requests are Browser Run's: signed with Web Bot Auth, declared as
 * an automated agent. Nothing about either origin's protection is changed.
 *
 * The Worker does one thing: open the URL with the cookies it is handed, run
 * the reader script it is handed inside the page, and return what that script
 * wrote, with the navigation's status. The secret, the cookies and the account
 * are never printed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const WORKER_SOURCE = `import puppeteer from '@cloudflare/puppeteer';
export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer ' + env.PROOF_SECRET) {
      return new Response('refused', { status: 401 });
    }
    const { url, cookies, viewport, script } = await request.json();
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      if (cookies?.length) await page.setCookie(...cookies);
      // On EVERY document, not just the first: a bot challenge that passes
      // navigates to the real page, and a script added after load would be lost.
      await page.evaluateOnNewDocument(script);
      const answer = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
      const first = { status: answer ? answer.status() : null,
        mitigated: answer ? (answer.headers()['cf-mitigated'] || null) : null };
      try {
        await page.waitForSelector('#__cc_proof', { timeout: 75000 });
      } catch (error) {
        return Response.json({ error: 'the reader did not answer: ' + String(error && error.message || error).slice(0, 120),
          title: await page.title().catch(() => null), path: new URL(page.url()).pathname, ...first }, { status: 502 });
      }
      const text = await page.$eval('#__cc_proof', (el) => el.textContent);
      return Response.json({ ...first, finalPath: new URL(page.url()).pathname, read: JSON.parse(text) });
    } catch (error) {
      return Response.json({ error: String(error && error.message || error).slice(0, 300) }, { status: 502 });
    } finally {
      await browser.close().catch(() => {});
    }
  },
};
`;

function wrangler(dir, args, input) {
  return execFileSync('npx', ['--yes', 'wrangler@4', ...args], {
    cwd: dir, input, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 240_000,
  });
}

/** Deploys the Worker; returns { url, secret, name, dir } or { error }. */
export function deployBrowserRunWorker(run) {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    return { error: 'Cloudflare credentials are not configured for this run' };
  }
  const name = `cc-page-proof-${String(run).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}`;
  const dir = mkdtempSync(join(tmpdir(), 'cc-page-proof-'));
  const secret = randomBytes(24).toString('hex');
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module',
      dependencies: { '@cloudflare/puppeteer': '^1.0.0' } }));
    writeFileSync(join(dir, 'index.js'), WORKER_SOURCE);
    writeFileSync(join(dir, 'wrangler.toml'), [
      `name = "${name}"`, 'main = "index.js"', 'compatibility_date = "2025-09-01"',
      'compatibility_flags = ["nodejs_compat"]', 'workers_dev = true', '', '[browser]', 'binding = "BROWSER"', '',
    ].join('\n'));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir, stdio: 'pipe', timeout: 240_000 });
    const out = wrangler(dir, ['deploy']);
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0] ?? null;
    if (!url) return { error: 'the proof Worker deployed without a workers.dev URL', name, dir };
    wrangler(dir, ['secret', 'put', 'PROOF_SECRET'], secret);
    return { url, secret, name, dir };
  } catch (error) {
    const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`;
    return { error: text.replace(/[0-9a-f]{32,}/gi, '…').slice(-400), name, dir };
  }
}

/** Deletes the Worker; returns true only once Cloudflare's API answers 404 for it. */
export async function deleteBrowserRunWorker(deployed) {
  if (!deployed?.name) return true;
  if (deployed.dir) {
    try { wrangler(deployed.dir, ['delete', '--name', deployed.name, '--force']); } catch { /* checked below */ }
  }
  const status = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${deployed.name}`,
    { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }).then((r) => r.status).catch(() => 0);
  if (deployed.dir) { try { rmSync(deployed.dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
  return status === 404;
}

/** Opens `url` in Cloudflare's browser through the Worker and runs `script` there. */
export async function readThroughWorker(deployed, { url, cookies, viewport, script }) {
  const response = await fetch(deployed.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deployed.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, cookies, viewport, script }),
  }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: String(error?.message ?? error) }) }));
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  return response.ok ? body : {
    error: [body?.error ?? `HTTP ${response.status}`, body?.title ? `title "${body.title}"` : null,
      body?.path ? `at ${body.path}` : null, body?.status ? `first answer HTTP ${body.status}` : null,
      body?.mitigated ? `cf-mitigated ${body.mitigated}` : null].filter(Boolean).join('; '),
  };
}
