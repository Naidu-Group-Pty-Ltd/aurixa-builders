/**
 * Fetch the OCR language model from the published npm package.
 *
 * GENERATED, NEVER HAND-EDITED — the same rule `canonicalRegistry.generated.ts`
 * and the template catalogue answer to. Run:
 *
 *     npm run ocr:vendor-language
 *
 * It writes `assets/ocr/eng.traineddata.gz` from `@tesseract.js-data/eng`,
 * which is where `tesseract.js` itself gets the model — so what ships is the
 * published artefact and not something this repository produced.
 *
 * IT USED TO WRITE A TYPESCRIPT MODULE, and that is why this file changed.
 * The model was emitted as base64 into the edge functions' module graph so it
 * would travel with `--use-api`, which uploads modules and not the files
 * beside them. Measured 22 September 2026, that graph then answered
 *
 *     unexpected deploy status 413: {"message":"request entity too large"}
 *
 * for `builder-portal-stock` and `builder-stock-image-settler` — 6.59 MB of
 * modules, 3.94 MB of it this file's output — and those two stayed on the
 * previous build while 25 shipped. So the model is an ASSET now, uploaded to
 * the project's own storage by `scripts/ops/upload-ocr-language.mjs` as part
 * of the deploy. See `ocr/languageSource.pure.ts`.
 *
 * A RAW `.gz` IN THE REPOSITORY IS SMALLER THAN THE MODULE WAS: 2.95 MB
 * against 3.94 MB, because base64 costs a third.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PACKAGE = '@tesseract.js-data/eng@1.0.0';
// The integerised "best" model: 2.95 MB against 10.9 MB for the float one, at
// accuracy this product does not need to tell apart — a builder's brochure is
// set in ordinary type at ordinary sizes.
const MEMBER = 'package/4.0.0_best_int/eng.traineddata.gz';
const OUT = 'assets/ocr/eng.traineddata.gz';

/*
 * PINNED, AND CHECKED HERE RATHER THAN TRUSTED. The thresholds in
 * `recogniseScan.ts` were measured against THIS model; a registry that
 * re-published the tag with different bytes would change how this product
 * reads a scan with nothing reporting it.
 */
const EXPECT_BYTES = 2_952_873;
const EXPECT_SHA256 =
  '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';

const work = mkdtempSync(join(tmpdir(), 'ocr-lang-'));
try {
  const tgz = execFileSync('npm', ['pack', PACKAGE, '--silent'], { cwd: work })
    .toString().trim().split('\n').pop();
  execFileSync('tar', ['xzf', tgz, MEMBER], { cwd: work });
  const bytes = readFileSync(join(work, MEMBER));
  const sha = createHash('sha256').update(bytes).digest('hex');

  if (bytes.length !== EXPECT_BYTES || sha !== EXPECT_SHA256) {
    console.error(
      `::error::ocr:vendor-language: ${PACKAGE} :: ${MEMBER} is not the model this product was measured against.\n`
      + `  expected ${EXPECT_BYTES} bytes, sha256 ${EXPECT_SHA256}\n`
      + `  received ${bytes.length} bytes, sha256 ${sha}\n`
      + '  Nothing was written. Re-measure the OCR thresholds before changing the pin.',
    );
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT}: ${bytes.length} bytes, sha256 ${sha}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
