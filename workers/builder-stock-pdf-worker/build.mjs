/**
 * Bundle the worker, WITHOUT editing a single shared module.
 *
 * `pdfText.ts` loads its reader with `import('https://esm.sh/unpdf@0.12.1')`.
 * That is correct for the Supabase edge runtime and it is the ONLY line in the
 * shared election that a Cloudflare Worker cannot execute: Workers resolve no
 * modules at runtime, remote or otherwise. The temptation is to "just" change
 * that import. It must not be changed — the shared modules are shared, and a
 * conditional import would be a second answer to "how is a PDF's text read"
 * living in the one file whose header exists to say there is only one.
 *
 * So the specifier is rewritten HERE, at build time, to the npm package the
 * URL names, pinned to the same version. The edge keeps the URL it can fetch,
 * the Worker gets the bytes inlined, and `pdfText.ts` is byte-identical on
 * both sides. A version drift between this alias and that URL is the one way
 * the two could diverge, so the pin is asserted below and the build fails
 * rather than quietly shipping a different reader.
 */
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const PDF_TEXT = resolve(repoRoot, 'supabase/functions/_shared/builderStock/pdfText.ts');

/** The exact specifier `pdfText.ts` asks for, read out of it rather than restated. */
const REMOTE_UNPDF = (() => {
  const src = readFileSync(PDF_TEXT, 'utf8');
  const match = src.match(/import\(\s*['"](https:\/\/esm\.sh\/unpdf@[^'"]+)['"]\s*\)/);
  if (!match) {
    throw new Error(
      `[build] ${PDF_TEXT} no longer loads unpdf from a pinned esm.sh URL. `
      + 'The alias below cannot be kept honest against a specifier it cannot find, '
      + 'so this build refuses rather than bundling an unrelated reader.');
  }
  return match[1];
})();

/** The version the URL pins, and the version package.json must install. */
const remoteVersion = REMOTE_UNPDF.split('@').pop();
const installed = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'))
  .dependencies.unpdf;
if (installed !== remoteVersion) {
  throw new Error(
    `[build] unpdf version drift: ${PDF_TEXT} loads ${remoteVersion} at the edge but this `
    + `worker bundles ${installed}. The two runtimes would read PDFs with different code. `
    + 'Align package.json with the specifier, or change both together.');
}

mkdirSync(resolve(here, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // Matches the build the running worker was produced by, so a rebuilt bundle
  // can be diffed against the live one rather than merely believed.
  keepNames: true,
  mainFields: ['module', 'main'],
  conditions: ['worker', 'browser', 'import', 'default'],
  external: ['cloudflare:workers'],
  plugins: [{
    name: 'alias-remote-unpdf',
    setup(b) {
      b.onResolve({ filter: /^https:\/\/esm\.sh\/unpdf@/ }, () => b.resolve('unpdf', {
        kind: 'import-statement',
        resolveDir: here,
      }));
    },
  }],
  logLevel: 'info',
  metafile: true,
});

const inputs = Object.keys(result.metafile.outputs[
  Object.keys(result.metafile.outputs).find((k) => k.endsWith('dist/index.js'))
].inputs);
const sharedCount = inputs.filter((p) => p.includes('supabase/functions/_shared/')).length;
if (!inputs.some((p) => p.endsWith('builderStock/pdfElection.ts'))
  || !inputs.some((p) => p.endsWith('builderStock/pdfText.ts'))) {
  throw new Error('[build] the bundle does not contain the shared election. Refusing to ship '
    + 'a worker that would have to have its own.');
}
console.log(`[build] bundled ${inputs.length} modules, ${sharedCount} of them shared with the `
  + 'Supabase edge path.');
