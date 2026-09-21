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
rm -rf /var/tmp/acceptance-storage
curl -s -X POST "http://localhost:54998/rpc/nonexistent" >/dev/null 2>&1 || true
# PostgREST caches the catalogue; a rebuilt database needs it reloaded.
psql -h localhost -p 54999 -U postgres -d stock_acceptance -c "NOTIFY pgrst, 'reload schema'" >/dev/null
sleep 2
exec deno run --allow-all --node-modules-dir=none \
  --import-map scripts/stock-acceptance/import-map.json \
  scripts/stock-acceptance/harness.ts "$CORPUS"
