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

/**
 * The lane names the BUNDLE asked its namespace for, in call order.
 *
 * Exposed so the sharding can be asserted against the deployable artefact
 * rather than against the source it was built from. Over the wire there is
 * nothing to look at — Cloudflare does not tell a client which object served
 * it — so the lane checks below run in bundle mode only and say so.
 */
const laneNames = [];

async function viaBundle() {
  const mod = await loadBundle();
  const lanes = new Map();
  const env = {
    BUILDER_STOCK_PDF_WORKER_TOKEN: tokenArg,
    PDF_ELECTION: {
      idFromName: (n) => { laneNames.push(n); return n; },
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

// ---- 5. the two text-free shapes, and the code that tells them apart ------
/*
 * WHY A REAL DOCUMENT AND NOT A UNIT TEST. `TEXT_FREE_COVER_NOT_ELECTED`
 * shortens a retry budget from six attempts to two, so what earns it has to be
 * exercised by a real election over real bytes: the text read returning
 * nothing, the structural cover being licensed by `identifiedBy`, the page's
 * rasters actually being decoded, and the cover rule electing or refusing.
 * Stubbing any of that would test the stub.
 *
 * BOTH SHAPES, BECAUSE ONE WITHOUT THE OTHER PROVES NOTHING. A build that
 * attached the code to every text-free document would pass a refusal-only
 * check while silently putting successful elections on a two-attempt budget;
 * a build that never attached it would pass a success-only check while
 * leaving the Lot 208 case on six. So the hero must elect WITHOUT a code and
 * the blank must refuse WITH one, in the same run.
 *
 * The text-bearing brochure above is the third leg: it is the partially-and-
 * not-at-all text-free case, and it must stay uncoded too.
 */
if (args.includes('--heavy')) {
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pdftextfree-'));
  /** The same wire context with this fixture's own identity on it. */
  const headerForDoc = (identity) => Buffer.from(
    JSON.stringify({ ...CONTEXT, ...identity }), 'utf8').toString('base64');

  const elect = async (mode, identity) => {
    const file = join(dir, `${mode}.pdf`);
    execFileSync('python3', [resolve(here, 'make-fixture-pdf.py'), file, `--${mode}`],
      { stdio: 'ignore' });
    const res = await call('/v1/elect', {
      method: 'POST',
      body: new Uint8Array(readFileSync(file)),
      headers: {
        ...auth, 'content-type': 'application/pdf',
        'x-election-context': headerForDoc(identity),
      },
    });
    return await res.json().catch(() => ({}));
  };

  try {
    /*
     * THE LOT 208 SHAPE: no text anywhere, no raster on the cover. The folder
     * tie licenses page 1, the page is decoded, and the cover rule finds no
     * photograph it may take — which is the one deterministic refusal.
     */
    const blank = await elect('text-free-blank', {
      label: 'Lot 208, 46 Satinwood Crescent Donnybrook',
      documentName: 'Lot 208, 46 Satinwood Crescent Donnybrook VIC_Package.pdf',
      url: 'https://drive.google.com/uc?export=download&id=satinwood-208',
    });
    check('a text-free cover that elects nothing refuses',
      blank.status === 'unreachable', `status=${blank.status}`);
    check('and it carries the deterministic code, not just a sentence',
      blank.reason === 'text_free_cover_not_elected', `reason=${blank.reason}`);

    /*
     * THE SAME SHAPE WITH A PHOTOGRAPH ON IT. Text-free, folder-tied, and the
     * cover presents exactly one raster — so it must still elect, and must
     * NOT be marked deterministic.
     */
    const hero = await elect('text-free-hero', {
      label: 'Lot 717 — Enzo 10.5 Modern',
      documentName: 'LOT 717 TEXT FREE COVER.pdf',
      url: 'https://drive.google.com/uc?export=download&id=textfree-hero',
    });
    check('a text-free cover that DOES present a photograph still elects',
      hero.status === 'recovered', `status=${hero.status}${hero.detail ? ` — ${hero.detail}` : ''}`);
    check('a successful election carries no refusal code',
      hero.reason === undefined, `reason=${hero.reason}`);

    /*
     * AND THE DOCUMENT WHOSE TEXT WAS READ — the committed brochure, elected
     * again here rather than reaching for section 3's block-scoped answer.
     * It is the control that proves the code is about text-free documents
     * rather than about refusals in general, and it covers the
     * partially-text-free case by the same rule: `textFree` is every page
     * empty, so a document with text on any page can never reach the mint.
     */
    const readable = await call('/v1/elect', {
      method: 'POST',
      body: PDF,
      headers: {
        ...auth, 'content-type': 'application/pdf', 'x-election-context': contextHeader,
      },
    }).then((r) => r.json()).catch(() => ({}));
    check('the text-bearing brochure carries no refusal code either',
      readable.reason === undefined, `status=${readable.status} reason=${readable.reason}`);
  } catch (error) {
    check('the text-free fixtures could be built and elected', false,
      String(error).slice(0, 160));
  }
}

// ---- the election lanes, through the built bundle ---------------------------
/*
 * THE SHARDING IS A PROPERTY OF THE ARTEFACT, NOT OF THE SOURCE. The unit
 * tests drive `src/index.ts`; this drives `dist/index.js`, which is what
 * wrangler uploads — so a build that dropped the lane chooser fails here
 * before anything is deployed.
 */
if (!urlArg) {
  /*
   * THE COUNT IS READ OUT OF THE SOURCE, NOT RESTATED HERE.
   *
   * The same rule `build.mjs` applies to the unpdf pin: a number written in
   * two places is a number that drifts, and a canary that still expected four
   * lanes after the constant moved to two would pass while asserting the
   * wrong thing — or fail for no reason but its own staleness.
   */
  const LANE_COUNT = (() => {
    const src = readFileSync(resolve(here, '../src/electionLane.pure.ts'), 'utf8');
    const match = src.match(/export const ELECTION_LANE_COUNT = (\d+);/);
    if (!match) {
      throw new Error('[canary] electionLane.pure.ts no longer declares '
        + 'ELECTION_LANE_COUNT as a literal, so the lane checks below cannot be '
        + 'kept honest against it.');
    }
    return Number(match[1]);
  })();
  const LANE_PATTERN = new RegExp(`^builder-stock-pdf-election-[0-${LANE_COUNT - 1}]$`);
  /** The same wire context with a different document identity on it. */
  const headerFor = (identity) => Buffer.from(
    JSON.stringify({ ...CONTEXT, ...identity }), 'utf8').toString('base64');
  const before = laneNames.length;

  for (let n = 0; n < 24; n += 1) {
    await call('/v1/elect', {
      method: 'POST',
      headers: {
        ...auth,
        'x-election-context': headerFor({
          label: `Lot ${700 + n} — Enzo 10.5 Modern`,
          url: `https://drive.google.com/uc?export=download&id=file-${n}`,
        }),
      },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
  }

  const asked = laneNames.slice(before);
  check('every election asked for exactly one lane', asked.length === 24,
    `${asked.length} names for 24 elections`);
  check('every lane name is a number and nothing else',
    asked.every((n) => LANE_PATTERN.test(n)),
    [...new Set(asked)].sort().join(', '));
  check('no lane name carries a label or a URL',
    !asked.some((n) => n.includes('Lot ') || n.includes('drive.google.com')));
  check(`the built bundle spreads documents across all ${LANE_COUNT} lanes`,
    new Set(asked).size === LANE_COUNT,
    `${new Set(asked).size} of ${LANE_COUNT} distinct lanes: ${[...new Set(asked)].sort().join(', ')}`);

  // Same identity, same lane — asserted through the artefact as well.
  const repeat = () => {
    const at = laneNames.length;
    return call('/v1/elect', {
      method: 'POST',
      headers: {
        ...auth,
        'x-election-context': headerFor({
          label: 'Lot 717 — Enzo 10.5 Modern',
          url: 'https://drive.google.com/uc?export=download&id=stable',
        }),
      },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }).then(() => laneNames[at]);
  };
  const [a, b] = [await repeat(), await repeat()];
  check('the same election always reaches the same lane', a === b, `${a} vs ${b}`);
} else {
  console.log('\n(lane checks are bundle-mode only: the wire does not name the object that served)');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failed:'); for (const f of failed) console.log('  -', f.name, f.detail);
  process.exit(1);
}
