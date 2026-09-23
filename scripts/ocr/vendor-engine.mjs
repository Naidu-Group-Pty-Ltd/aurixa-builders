/**
 * Vendor the OCR ENGINE — Tesseract compiled to WebAssembly — from the
 * published npm package, so that it runs INSIDE the isolate that asks.
 *
 * GENERATED, NEVER HAND-EDITED. Run:
 *
 *     npm run ocr:vendor-engine
 *
 * It writes these from `tesseract.js-core@5.1.1`, the package `tesseract.js`
 * itself loads its engine from:
 *
 *   assets/ocr/tesseract-core-simd-lstm.wasm
 *       the engine, byte for byte. An ASSET, shipped to the project's own
 *       storage by `scripts/ops/upload-ocr-language.mjs` on every deploy, for
 *       the reason the language model is one: a function's module graph
 *       answered 413 at 6.59 MB (`ocr/languageSource.pure.ts`).
 *
 *   supabase/functions/_shared/builderStock/ocr/tesseractCore.generated.js
 *       the engine's loader (124 KB of Emscripten output), with two changes,
 *       and its `.d.ts` for the app's typechecker.
 *
 * WHY THIS EXISTS. Measured in production on 23 September 2026, the figure
 * read answered `recognition_unavailable` on the stored `Lot 101` brochure —
 * the same brochure the same code read as `124.50` in CI. `tesseract.js`
 * never runs its engine where it is called: its Node build spawns a
 * `worker_threads` Worker from a file path inside the npm package, and the
 * browser build a Web Worker. The Deno CLI the gate and the trace ran under
 * starts one; the hosted edge runtime did not, and the error was swallowed.
 * The engine itself needs none of that: it is one WebAssembly module and the
 * loader that drives it, which is what the worker runs. `ocr/engineDriver.ts`
 * runs it in the isolate instead.
 *
 * TWO CHANGES, AND WHY EACH IS SAFE. Both make the loader behave the same
 * whatever host runs it, which is the property whose absence this file exists
 * to repair — and each substitution is asserted to occur EXACTLY ONCE.
 *
 *   The loader decides at call time which host it is in — a browser
 *   (`window`), a web worker (`importScripts`) or Node
 *   (`process.versions.node`) — and Deno 2 defines `process`, so it chose
 *   Node and reached for `require('fs')`, which an ES module does not have.
 *   The three tests are replaced by `false`, so it takes none of those
 *   branches and uses only what every runtime here has: `WebAssembly`,
 *   `crypto` and `performance`. Each branch only locates and reads the
 *   `.wasm` file, and the engine is handed its bytes (`wasmBinary`) instead,
 *   so nothing it would have done is lost.
 *
 *   Its last six lines export the factory to CommonJS or AMD, chosen by
 *   whether the host defines `module`, `exports` or `define`. They are
 *   replaced by one ES export. Deno defines none of them; the unit suite's
 *   runner defines two, and there the CommonJS branch ran and tried to
 *   overwrite the module's own default export.
 *
 * Tesseract and tesseract.js-core are Apache-2.0; the licence text is written
 * beside the engine as `assets/ocr/tesseract.js-core.LICENSE`, and the
 * generated module's header states both changes, as the licence requires.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PACKAGE = 'tesseract.js-core@5.1.1';
const MEMBERS = {
  loader: 'package/tesseract-core-simd-lstm.js',
  wasm: 'package/tesseract-core-simd-lstm.wasm',
  licence: 'package/LICENSE',
};
const OUT = {
  loader: 'supabase/functions/_shared/builderStock/ocr/tesseractCore.generated.js',
  types: 'supabase/functions/_shared/builderStock/ocr/tesseractCore.generated.d.ts',
  wasm: 'assets/ocr/tesseract-core-simd-lstm.wasm',
  licence: 'assets/ocr/tesseract.js-core.LICENSE',
};

/*
 * PINNED, AND CHECKED HERE RATHER THAN TRUSTED — the SIMD + LSTM build, which
 * is the one `tesseract.js` itself chose on every host that measured the
 * figure reader (`getCore`: SIMD available, OEM 1). A registry that
 * re-published the tag with different bytes would change how this product
 * reads a figure with nothing reporting it.
 */
const EXPECT = {
  loader: { bytes: 124_396, sha256: '4135a3f6f1cccf3bc92058c1273c49bb4cff6356e1ba15d1b8b4e76e9890526b' },
  wasm: { bytes: 2_859_709, sha256: '66b601224a0c4a8977bc9d92dd39841189f9ca22cc4122fcd7208cdb0961eeef' },
};

/** The host tests, verbatim, and what replaces them. */
const HOST_TESTS = 'fa="object"==typeof window,ha="function"==typeof importScripts,'
  + 'ia="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node';
const NO_HOST = 'fa=!1,ha=!1,ia=!1';

/** The CommonJS / AMD export, verbatim, and what replaces it. */
const HOST_EXPORT = [
  "if (typeof exports === 'object' && typeof module === 'object')",
  '  module.exports = TesseractCore;',
  "else if (typeof define === 'function' && define['amd'])",
  '  define([], function() { return TesseractCore; });',
  "else if (typeof exports === 'object')",
  '  exports["TesseractCore"] = TesseractCore;',
  '',
].join('\n');
const ES_EXPORT = 'export default TesseractCore;\n';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function refuse(message) {
  console.error(`::error::ocr:vendor-engine: ${message}\n  Nothing was written.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'ocr-engine-'));
try {
  const tgz = execFileSync('npm', ['pack', PACKAGE, '--silent'], { cwd: work })
    .toString().trim().split('\n').pop();
  execFileSync('tar', ['xzf', tgz, ...Object.values(MEMBERS)], { cwd: work });

  const loader = readFileSync(join(work, MEMBERS.loader));
  const wasm = readFileSync(join(work, MEMBERS.wasm));
  const licence = readFileSync(join(work, MEMBERS.licence));
  for (const [name, bytes] of [['loader', loader], ['wasm', wasm]]) {
    const expected = EXPECT[name];
    const actual = sha256(bytes);
    if (bytes.length !== expected.bytes || actual !== expected.sha256) {
      refuse(`${PACKAGE} :: ${MEMBERS[name]} is not the engine this product was measured against.\n`
        + `  expected ${expected.bytes} bytes, sha256 ${expected.sha256}\n`
        + `  received ${bytes.length} bytes, sha256 ${actual}`);
    }
  }

  const source = loader.toString('utf8');
  for (const [name, text] of [['host tests', HOST_TESTS], ['CommonJS / AMD export', HOST_EXPORT]]) {
    const occurrences = source.split(text).length - 1;
    if (occurrences !== 1) refuse(`expected the loader's ${name} exactly once, found ${occurrences}.`);
  }
  if (!source.endsWith(HOST_EXPORT)) refuse('expected the loader to end with its CommonJS / AMD export.');

  const header = [
    '// GENERATED by scripts/ocr/vendor-engine.mjs — NEVER HAND-EDITED.',
    `// ${PACKAGE} :: ${MEMBERS.loader.replace('package/', '')}`,
    `// sha256 ${EXPECT.loader.sha256} before the change below.`,
    '//',
    '// Copyright the tesseract.js authors. Licensed under the Apache License,',
    '// Version 2.0; the text is in assets/ocr/tesseract.js-core.LICENSE.',
    '//',
    '// CHANGED, in two places and nowhere else: the loader\'s three host tests',
    '// (window, importScripts, process.versions.node) are replaced by `false`,',
    '// so it takes no host branch and is handed the engine\'s bytes',
    '// (`wasmBinary`) by ocr/engineDriver.ts instead of reading a file; and its',
    '// CommonJS / AMD export is replaced by one ES export. See',
    '// scripts/ocr/vendor-engine.mjs for why.',
    '',
  ].join('\n');
  const generated = `${header}${source.replace(HOST_TESTS, NO_HOST).replace(HOST_EXPORT, ES_EXPORT)}`;

  /*
   * Its type, for the app's typechecker, which follows the unit suite's
   * imports into this module and does not read JavaScript. As loose as
   * `src/types/edgeRuntimeModules.d.ts` asks: `engineDriver.ts` states the
   * shape it calls, and a second opinion here would only disagree with it.
   */
  const types = [
    '// GENERATED by scripts/ocr/vendor-engine.mjs — NEVER HAND-EDITED.',
    '// The type of tesseractCore.generated.js; engineDriver.ts states the shape it calls.',
    'declare const TesseractCore: (config?: Record<string, unknown>) => Promise<unknown>;',
    'export default TesseractCore;',
    '',
  ].join('\n');

  for (const path of Object.values(OUT)) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(OUT.loader, generated);
  writeFileSync(OUT.types, types);
  writeFileSync(OUT.wasm, wasm);
  writeFileSync(OUT.licence, licence);
  console.log(`wrote ${OUT.loader}: ${Buffer.byteLength(generated)} bytes, sha256 ${sha256(Buffer.from(generated))}`);
  console.log(`wrote ${OUT.wasm}: ${wasm.length} bytes, sha256 ${sha256(wasm)}`);
  console.log(`wrote ${OUT.licence}: ${licence.length} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
