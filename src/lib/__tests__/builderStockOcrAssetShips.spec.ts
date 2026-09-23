/**
 * ===========================================================================
 * THE OCR MODEL IS ONE OBJECT, NAMED IN FOUR LANGUAGES.
 * ===========================================================================
 *
 * `ocr/languageSource.pure.ts` is the source of truth for where the trained
 * model lives, how big it is and what it hashes to. Three other places state
 * the same facts as literals, because none of them can import a Deno module:
 *
 *   scripts/ocr/vendor-language.mjs      Node — takes it out of the npm tarball
 *   scripts/ops/upload-ocr-language.mjs  Node — ships it on every deploy
 *   scripts/stock-acceptance/run.sh      bash — places it for the gate
 *
 * FOUR COPIES OF ONE FACT IS HOW TWO OF THEM DRIFT, and the drift here is the
 * quiet kind: change the byte count in the pure module alone and the runtime
 * refuses an object the deploy is still shipping, so OCR goes dark on every
 * deployment with nothing reporting it beyond a warning line. Change it in
 * the uploader alone and production is shipped a model the runtime will not
 * read.
 *
 * The object cannot travel as one constant, so it travels as four and this
 * asserts they are the same four. The review that produced this file found no
 * other gap in the design and deliberately changed nothing else: the asset
 * ships on the deploy lane, idempotently, needs no new secret, is validated
 * by byte count and digest before it is sent and read back and judged by both
 * after, and its absence is a named refusal rather than a crash.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

const SOURCE = 'supabase/functions/_shared/builderStock/ocr/languageSource.pure.ts';
const UPLOADER = 'scripts/ops/upload-ocr-language.mjs';
const VENDOR = 'scripts/ocr/vendor-language.mjs';
const RUNNER = 'scripts/stock-acceptance/run.sh';
const ASSET = 'assets/ocr/eng.traineddata.gz';

/** Every `2_952_873`-shaped literal in a file, as a number. */
const byteCounts = (text: string): number[] =>
  [...text.matchAll(/\b(\d[\d_]{5,})\b/g)]
    .map((m) => Number(m[1].replace(/_/g, '')))
    .filter((n) => Number.isFinite(n));

const digests = (text: string): string[] =>
  [...text.matchAll(/\b([0-9a-f]{64})\b/g)].map((m) => m[1]);

describe('the model the runtime expects is the model the deploy ships', () => {
  const source = read(SOURCE);

  const expectedBytes = Number(
    /OCR_LANGUAGE_BYTES\s*=\s*([\d_]+)/.exec(source)![1].replace(/_/g, ''));
  const expectedSha = /OCR_LANGUAGE_SHA256\s*=\s*\n?\s*'([0-9a-f]{64})'/.exec(source)![1];
  const expectedKey = /OCR_LANGUAGE_KEY\s*=\s*'([^']+)'/.exec(source)![1];
  const expectedBucket = /OCR_ASSET_BUCKET\s*=\s*'([^']+)'/.exec(source)![1];

  it('states a byte count and a digest at all', () => {
    expect(expectedBytes).toBeGreaterThan(1_000_000);
    expect(expectedSha).toHaveLength(64);
    expect(expectedKey).toMatch(/^system\/ocr\/.+\/eng\.traineddata\.gz$/);
    expect(expectedBucket).toBe('builder-stock-lists');
  });

  it('is the file actually committed to this repository', () => {
    /*
     * THE ONE ASSERTION THAT IS ABOUT BYTES RATHER THAN ABOUT TEXT. Every
     * other check here compares one statement of a number against another;
     * this compares the statement against the thing. A repository whose
     * constants agree with each other and disagree with the file ships a
     * model the runtime refuses.
     */
    expect(statSync(join(REPO_ROOT, ASSET)).size).toBe(expectedBytes);
  });

  it('is the same model the uploader validates and sends', () => {
    const uploader = read(UPLOADER);
    expect(byteCounts(uploader)).toContain(expectedBytes);
    expect(digests(uploader)).toContain(expectedSha);
    expect(uploader).toContain(`'${expectedKey}'`);
    expect(uploader).toContain(`'${expectedBucket}'`);
  });

  it('is the same model the vendoring script will write', () => {
    const vendor = read(VENDOR);
    expect(byteCounts(vendor)).toContain(expectedBytes);
    expect(digests(vendor)).toContain(expectedSha);
    // The npm member and the storage key share the model's own version, so a
    // new model cannot be shipped under the key the thresholds were measured
    // against. See `OCR_LANGUAGE_KEY`.
    const version = expectedKey.split('/')[2];
    expect(vendor).toContain(`package/${version}/eng.traineddata.gz`);
  });

  it('is placed at the same key for the acceptance gate', () => {
    /*
     * The gate must prove OCR through the path production uses. A runner that
     * placed the object anywhere else would prove recognition against a path
     * this product never reads — the class of infidelity the harness keeps
     * finding in itself.
     */
    const runner = read(RUNNER);
    expect(runner).toContain(`${expectedBucket}/${expectedKey.replace('/eng.traineddata.gz', '')}`);
    expect(runner).toContain(ASSET);
  });
});

describe('what a deployment without the model does', () => {
  it('declines recognition and never fails the read', () => {
    /*
     * `languageDataDirectory()` answers null and the caller turns that into a
     * per-page `engine_unavailable` refusal with `available: false`. It is
     * the state every deployment was in before OCR existed.
     */
    const reader = read('supabase/functions/_shared/builderStock/ocr/recogniseScan.ts');
    expect(reader).toContain('const langPath = await languageDataDirectory();');
    expect(reader).toContain("reason: 'engine_unavailable'");
    expect(reader).toContain('available: false');

    const data = read('supabase/functions/_shared/builderStock/ocr/languageData.ts');
    // Anything that is not the measured object is null. A wrong model reads,
    // and a bad reading is the one outcome this subsystem must not produce.
    expect(data).toContain('if (!languageBytesAreExpected(bytes)) {');
    expect(data).toContain('resolved = null;');
  });

  it('never touches a PDF that states its own text', () => {
    /*
     * The whole recognition block sits behind `planOcr`, which is a statement
     * about the PAGES. A document whose pages carry text is `sufficient` and
     * the block is not entered — so a missing asset cannot reach an ordinary
     * import at all, which is the criterion this review had to satisfy.
     */
    const extract = read('supabase/functions/_shared/builderStock/extract.ts');
    const gate = extract.indexOf('const plan = planOcr(result.pageTexts ?? []);');
    expect(gate).toBeGreaterThan(-1);
    expect(extract.slice(gate, gate + 120)).toContain('if (!plan.sufficient) {');
  });
});

describe('how the model reaches a deployment', () => {
  const workflow = read('.github/workflows/deploy-supabase-functions.yml');

  it('ships on the deploy lane rather than being seeded or provisioned', () => {
    expect(workflow).toContain('node scripts/ops/upload-ocr-language.mjs');
    // And the lane re-runs when the asset itself changes, or a new model
    // would sit in the repository and never reach production.
    expect(workflow).toContain("- 'assets/ocr/**'");
    expect(workflow).toContain("- 'scripts/ops/upload-ocr-language.mjs'");
  });

  it('ships it AFTER the code, never before', () => {
    /*
     * The two orders fail differently and only one of them is safe. A
     * function deployed against a missing TABLE answers 500 — an outage, so
     * schema goes first. A function deployed without this ASSET declines OCR,
     * which is a supported state. Asset first, and a fault here ships nothing
     * at all; asset last, and a fault leaves the functions correctly shipped,
     * OCR honestly declining, and the run red so somebody looks.
     */
    const verify = workflow.indexOf('node scripts/ops/verify-functions-deployed.mjs');
    const ship = workflow.indexOf('node scripts/ops/upload-ocr-language.mjs');
    const migrate = workflow.indexOf('node scripts/ops/apply-migrations.mjs');
    expect(migrate).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(migrate);
    expect(ship).toBeGreaterThan(verify);
  });

  it('needs no credential the deploy did not already hold', () => {
    /*
     * A lane that cannot run until somebody adds a secret is a lane that
     * stays unrun — the rule the migration lane already answers to. The
     * service key is resolved from the Management API with the access token
     * this workflow has always had.
     */
    const uploader = read(UPLOADER);
    expect(uploader).toContain('SUPABASE_ACCESS_TOKEN');
    expect(uploader).toContain('/v1/projects/${projectRef}/api-keys?reveal=true');
    // No other environment variable is read, so there is nothing new to set.
    const env = new Set([...uploader.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]));
    expect([...env].sort()).toEqual(['PROJECT_REF', 'SUPABASE_ACCESS_TOKEN']);
  });

  it('confirms what is stored rather than trusting the write', () => {
    // The rule the retention purge and the verification self-test answer to:
    // asserted by effect, never by configuration. A 200 from a write is not
    // a statement about what is stored.
    // Every asset goes through the one `ship`, the model and the engine alike,
    // so the read-back is asserted once, against each entry's own pins.
    const uploader = read(UPLOADER);
    const put = uploader.indexOf("method: 'POST'");
    const confirm = uploader.indexOf('const stored = await storedObject(object, auth);', put);
    expect(put).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(put);
    expect(uploader.slice(confirm)).toContain('if (!isTheAsset(stored, entry))');
    expect(uploader).toMatch(/for \(const entry of payloads\) shipped = \(await ship\(entry, credentials\)\) && shipped;/);
    /*
     * AND BY WHAT ARRIVES, NEVER BY A HEADER. The deploy that first shipped the
     * engine read a HEAD's `content-length` back as 0 bytes for an object the
     * functions fetched, digest-checked and ran minutes later. What is judged
     * is the object's own size and SHA-256, and the code names no header.
     */
    expect(uploader).toMatch(/read\.ok && read\.bytes === entry\.bytes && read\.sha256 === entry\.sha256/);
    const code = uploader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/content-length|method: 'HEAD'/i);
  });

  it('cannot serve an older reader an incompatible model', () => {
    /*
     * The key carries the model's own version, so a reader measured against a
     * different model names a different object and is answered 404 — which is
     * the honest refusal, not a silent misread. Nothing deletes, so rolling
     * back to a reader whose object was ever shipped still finds it.
     */
    const source = read(SOURCE);
    expect(source).toMatch(/OCR_LANGUAGE_KEY\s*=\s*'system\/ocr\/[\d.]+_[a-z_]+\/eng\.traineddata\.gz'/);
    expect(read(UPLOADER)).not.toContain("method: 'DELETE'");
  });
});
