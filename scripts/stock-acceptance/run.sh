#!/usr/bin/env bash
# One command, from nothing: a production-equivalent database, a real
# PostgREST over it, the corpus, and the gate. A run must start from an empty
# database or "repeat processing is safe" is a claim about leftovers.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH=/usr/lib/postgresql/16/bin:$PATH
CORPUS=${CORPUS:-/var/tmp/corpus}

"$(dirname "$0")/stack-up.sh"
node scripts/stock-acceptance/build-database.mjs
python3 scripts/stock-acceptance/make-corpus.py "$CORPUS"
# The fault matrix's hand-off case needs a scan long enough to cross isolates
# on any machine, and the stress corpus is where that document is built.
export STRESS_CORPUS=${STRESS_CORPUS:-/var/tmp/stress-corpus}
python3 scripts/stock-acceptance/make-stress-corpus.py "$STRESS_CORPUS" > /dev/null
rm -rf /var/tmp/acceptance-storage
# THE OCR MODEL IS AN ASSET NOW, NOT A MODULE — it answered 413 inside the
# functions' deploy request and moved to the project's own storage, where
# `languageData.ts` GETs it. The deploy workflow ships it to production; this
# is the same act against the acceptance stack's object store, so the gate
# proves OCR through the path production uses rather than around it. Placed
# after the wipe, because the wipe is what makes a run start from nothing.
OCR_OBJ=/var/tmp/acceptance-storage/builder-stock-lists/system/ocr/4.0.0_best_int
mkdir -p "$OCR_OBJ"
cp assets/ocr/eng.traineddata.gz "$OCR_OBJ/eng.traineddata.gz"
# AND THE ENGINE, the same way and for the same reason: a figure is recognised
# in the isolate that asks (`ocr/engine.ts`), which fetches Tesseract's
# WebAssembly from this store and checks its digest. The import map below maps
# `tesseract.js` to its npm build, whose worker the Deno CLI can start and the
# hosted runtime could not — so the figure path deliberately imports neither,
# and what the gate runs is what production runs.
ENGINE_OBJ=/var/tmp/acceptance-storage/builder-stock-lists/system/ocr/tesseract.js-core-5.1.1
mkdir -p "$ENGINE_OBJ"
cp assets/ocr/tesseract-core-simd-lstm.wasm "$ENGINE_OBJ/tesseract-core-simd-lstm.wasm"
curl -s -X POST "http://localhost:54998/rpc/nonexistent" >/dev/null 2>&1 || true
# PostgREST caches the catalogue; a rebuilt database needs it reloaded.
psql -h localhost -p 54999 -U postgres -d stock_acceptance -c "NOTIFY pgrst, 'reload schema'" >/dev/null
sleep 2
# THE WATCHDOG'S BACKOFF BRANCH, PROVED BY EFFECT AGAINST THIS DATABASE.
# A killed worker must not bill the property for the first expiry of its lease,
# and every expiry after it must keep the bounded ladder. Reading the function
# back would prove only that the text applied — the class of mistake the
# retention purge, the `manual_stats` CHECK and the AML `.or()` each shipped
# once. This puts rows in both states, runs the real function and reads the
# real column back. See `scripts/ops/probe-watchdog-backoff.mjs`.
PGPASSWORD=acceptance node scripts/ops/probe-watchdog-backoff.mjs \
  "postgres://postgres:acceptance@127.0.0.1:54999/stock_acceptance"

# AND DOES A FIGURE A BUILDER STATES REACH THE MARKETPLACE? Same rule. The
# sync composer read `manual_stats` keys the column never holds, so a land size
# typed into "Complete the schedule" travelled to every clone as nothing. This
# stores one on a real row, asks the real composer, and rolls everything back.
# See `scripts/ops/probe-stated-figures-payload.mjs`.
PGPASSWORD=acceptance node scripts/ops/probe-stated-figures-payload.mjs \
  "postgres://postgres:acceptance@127.0.0.1:54999/stock_acceptance"

# AND AN ADDRESS? A brochure that names only its lot and estate can be placed
# on a marketplace only by its builder. This stores a stated address on real
# rows, asks the real composer, and puts eleven malformed statements to the
# real constraint — all rolled back. See
# `scripts/ops/probe-stated-location-payload.mjs`.
PGPASSWORD=acceptance node scripts/ops/probe-stated-location-payload.mjs \
  "postgres://postgres:acceptance@127.0.0.1:54999/stock_acceptance"

# AND CAN TWO WORKERS IMPORT THE SAME STOCK LIST? Same rule, same reason. An
# import is resumable now, which makes a double dispatch, a successor racing
# its predecessor and a killed worker's lease all reachable — and every one of
# them writes a builder's stock list twice. Eight properties, run against the
# real functions and read back off the real columns. See
# `scripts/ops/probe-import-claim.mjs`.
PGPASSWORD=acceptance node scripts/ops/probe-import-claim.mjs \
  "postgres://postgres:acceptance@127.0.0.1:54999/stock_acceptance" --may-dispatch
exec deno run --allow-all --node-modules-dir=none \
  --import-map scripts/stock-acceptance/import-map.json \
  scripts/stock-acceptance/harness.ts "$CORPUS"
