/**
 * DRIVE THE DEPLOYABLE ARTEFACT, NOT A REIMPLEMENTATION OF IT.
 *
 * This loads `dist/index.js` — the exact bytes wrangler uploads — stubs the
 * one runtime module Node cannot provide, and puts a real brochure through the
 * real front door: bearer auth, the context header, the raw PDF body, the
 * lane, `readPdfPageTextResult` and `electFromPdfBytes`. An election that
 * succeeds here has exercised unpdf loading from inside the bundle, the page
 * text read, the cover designation, the raster extraction and the provenance —
 * all of it the shared code, none of it stubbed.
 *
 * Run against a URL instead (`--url`) and it does the same thing over the
 * wire, which is what the deploy workflow uses as its canary before any
 * Supabase secret is pointed at a new deployment.
 *
 * Exit code is the whole contract: 0 means every check passed.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const urlArg = (() => {
  const i = args.indexOf('--url');
  return i >= 0 ? args[i + 1] : '';
})();
const tokenArg = process.env.BUILDER_STOCK_PDF_WORKER_TOKEN ?? 'canary-token';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const PDF = new Uint8Array(readFileSync(resolve(here, 'fixtures/lot-717-enzo-brochure.pdf')));
const CONTEXT = {
  protocol: 1,
  label: 'Lot 717 — Enzo 10.5 Modern',
  identifiedBy: 'folder_structure',
  design: 'Enzo 10.5',
  identityHints: ['Watsons Reach', 'Lot 717'],
  documentName: 'LOT 717 - ENZO 10.5 MODERN - BROCHURE V002.pdf',
  url: 'https://example.invalid/lot-717.pdf',
};
const contextHeader = Buffer.from(JSON.stringify(CONTEXT), 'utf8').toString('base64');

/** Load the built bundle with the one Workers-only module supplied. */
async function loadBundle() {
  const bundle = readFileSync(resolve(here, '../dist/index.js'), 'utf8');
  const stub = `class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}\n`;
  const patched = stub + bundle.replace(
    /import\s*\{([^}]*)\}\s*from\s*["']cloudflare:workers["'];?/,
    '/* cloudflare:workers supplied above */');
  const dir = mkdtempSync(join(tmpdir(), 'pdfworker-'));
  const file = join(dir, 'index.mjs');
  writeFileSync(file, patched);
  return await import(pathToFileURL(file).href);
}

async function viaBundle() {
  const mod = await loadBundle();
  const lanes = new Map();
  const env = {
    BUILDER_STOCK_PDF_WORKER_TOKEN: tokenArg,
    PDF_ELECTION: {
      idFromName: (n) => n,
      get: (id) => {
        if (!lanes.has(id)) lanes.set(id, new mod.PdfElection({}, env));
        return lanes.get(id);
      },
    },
  };
  return (path, init) => mod.default.fetch(
    new Request(`https://worker.local${path}`, init), env);
}

function viaNetwork(base) {
  const root = base.replace(/\/+$/, '');
  return (path, init) => fetch(`${root}${path}`, init);
}

const call = urlArg ? viaNetwork(urlArg) : await viaBundle();
const auth = { authorization: `Bearer ${tokenArg}` };

// ---- 1. health -----------------------------------------------------------
{
  const res = await call('/health', {});
  const body = await res.json().catch(() => ({}));
  check('health answers 200 with a token configured', res.status === 200, `status ${res.status}`);
  check('health names this service', body.service === 'builder-stock-pdf-worker', String(body.service));
  check('health states protocol 1', body.protocol === 1, String(body.protocol));
  check('health never states the token', !JSON.stringify(body).includes(tokenArg));
}

// ---- 2. the door ---------------------------------------------------------
{
  const anon = await call('/v1/elect', { method: 'POST', body: PDF });
  check('an unauthenticated election is refused 401', anon.status === 401, `status ${anon.status}`);

  const wrong = await call('/v1/elect', {
    method: 'POST', body: PDF, headers: { authorization: `Bearer ${tokenArg}x` },
  });
  check('a wrong token is refused 401', wrong.status === 401, `status ${wrong.status}`);

  const unknown = await call('/v1/nope', { method: 'POST', headers: auth });
  check('an authenticated unknown path is 404', unknown.status === 404, `status ${unknown.status}`);

  const badContext = await call('/v1/elect', {
    method: 'POST', body: PDF, headers: { ...auth, 'x-election-context': 'rubbish' },
  });
  check('an unvouchable context is refused 400 — never elected against a default',
    badContext.status === 400, `status ${badContext.status}`);

  const empty = await call('/v1/elect', {
    method: 'POST', body: new Uint8Array(0),
    headers: { ...auth, 'x-election-context': contextHeader },
  });
  check('an empty document is refused 413', empty.status === 413, `status ${empty.status}`);
}

// ---- 3. a real election --------------------------------------------------
{
  const started = Date.now();
  const res = await call('/v1/elect', {
    method: 'POST',
    body: PDF,
    headers: { ...auth, 'content-type': 'application/pdf', 'x-election-context': contextHeader },
  });
  const elapsed = Date.now() - started;
  const body = await res.json().catch(() => ({}));

  check('the election answers 200', res.status === 200, `status ${res.status}`);
  check('the answer speaks protocol 1', body.protocol === 1, String(body.protocol));
  check('the brochure elected an image', body.status === 'recovered',
    body.status === 'recovered' ? '' : `status=${body.status} detail=${String(body.detail).slice(0, 120)}`);

  if (body.status === 'recovered') {
    const bytes = Buffer.from(body.image.bytes, 'base64');
    check('the elected image has real bytes', bytes.length > 2000, `${bytes.length} bytes`);
    check('the reference names the document we sent',
      String(body.image.reference).startsWith(`${CONTEXT.documentName}#page`),
      String(body.image.reference));
    check('provenance states the page it came from',
      Number(body.image.provenance?.page) >= 1, `page ${body.image.provenance?.page}`);
    check('provenance states how it was taken',
      ['embedded_raster', 'page_crop'].includes(body.image.provenance?.method),
      String(body.image.provenance?.method));
    check('provenance carries the source hash',
      /^[0-9a-f]{64}$/.test(String(body.image.provenance?.sourceSha256 ?? '')),
      String(body.image.provenance?.sourceSha256).slice(0, 16) + '…');
    /*
     * THE IMAGE MUST BE THE BUILDER'S OWN BYTES. An embedded raster is copied
     * out untouched, so its stored hash equals its source hash; a page crop is
     * re-encoded and they differ. Either is honest — what would not be is an
     * image that hashes to neither, which is what a generated picture would do.
     */
    const storedSha = createHash('sha256').update(bytes).digest('hex');
    check('the bytes returned hash to the provenance they are filed under',
      storedSha === body.image.provenance?.storedSha256,
      `${storedSha.slice(0, 16)}… vs ${String(body.image.provenance?.storedSha256).slice(0, 16)}…`);
    check('a role was assigned from the document itself',
      Boolean(body.image.role?.role), JSON.stringify(body.image.role).slice(0, 120));
    /*
     * `primary_property` is the ONE role a Builder Stock card may draw. A
     * floorplan, a masterplan, a location map, a logo or an interior all have
     * their own names in `sourceImageRole.pure.ts` and none of them may lead a
     * listing, so this assertion is the difference between an election that
     * worked and one that merely returned something.
     */
    check('the elected role is the one a card may draw, not a plan or a map',
      String(body.image.role?.role) === 'primary_property', String(body.image.role?.role));
    check('the role states the evidence it was assigned on',
      String(body.image.role?.evidence ?? '').length > 20,
      String(body.image.role?.evidence ?? '').slice(0, 140));
  }
  console.log(`\nelection wall-clock: ${elapsed} ms`);
}

// ---- 4. a document the size of the ones the edge could not finish ---------
/*
 * WHY THIS IS OPTIONAL AND GENERATED. The whole reason this worker exists is a
 * 2,000 ms CPU ceiling that heavy brochures exceeded; a canary that only ever
 * elects a 220 KB fixture proves the wiring and says nothing about the reason.
 * So `--heavy` builds an 8 MB, twelve-page document at run time and elects it.
 * It is generated rather than committed because eight megabytes of synthetic
 * noise has no business in a git history, and it is optional because the check
 * needs python3 and the fixture script, which a bare `--url` run may not have.
 */
if (args.includes('--heavy')) {
  const { execFileSync } = await import('node:child_process');
  const heavy = join(mkdtempSync(join(tmpdir(), 'pdfheavy-')), 'heavy.pdf');
  try {
    execFileSync('python3', [resolve(here, 'make-fixture-pdf.py'), heavy, '--heavy'],
      { stdio: 'ignore' });
  } catch (error) {
    check('heavy document generated', false, String(error).slice(0, 120));
  }
  const bytes = new Uint8Array(readFileSync(heavy));
  check('heavy document is genuinely heavy', bytes.length > 6_000_000, `${bytes.length} bytes`);
  const started = Date.now();
  const res = await call('/v1/elect', {
    method: 'POST',
    body: bytes,
    headers: { ...auth, 'content-type': 'application/pdf', 'x-election-context': contextHeader },
  });
  const elapsed = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  check('the heavy document elects rather than being killed', body.status === 'recovered',
    body.status === 'recovered' ? `${elapsed} ms` : `status=${body.status}`);
  if (body.status === 'recovered') {
    check('the heavy document elected page 1, not one of its filler pages',
      Number(body.image.provenance?.page) === 1, `page ${body.image.provenance?.page}`);
  }
  console.log(`\nheavy election wall-clock: ${elapsed} ms over ${bytes.length} bytes`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failed:'); for (const f of failed) console.log('  -', f.name, f.detail);
  process.exit(1);
}
