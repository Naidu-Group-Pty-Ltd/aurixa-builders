# The stock-import acceptance corpus

What it is, and what makes it evidence rather than another green suite.

## The stack is real, except for one thing that cannot lie

| layer | what runs |
|---|---|
| database | PostgreSQL 16, built by **this repository's own migrations** (`build-database.mjs` replays the Supabase bootstrap, the consolidated baseline and every follow-on migration, exactly as `baseline-check.mjs` does) |
| API | **real PostgREST 12.2.3** — the version Supabase runs — over that catalogue |
| client | **real `@supabase/supabase-js`**, constructed the way an edge function constructs it |
| PDF reading | **real unpdf 0.12.1**, the same version and the same code path `pdfText.ts` loads at the edge (aliased by `import-map.json` from the `esm.sh` URL to the npm package, which is exactly what the PDF worker's own `build.mjs` does, with the same pin) |
| runtime | **real Deno**, the runtime the edge functions run on |
| pipeline | **the shared modules themselves**, unmodified: `runStockImport`, `extractStockFile`, `readPdfPageTexts`, `readPdfTextLayout`, `readPdfDeterministicRows`, `importStockRecords`, and the real `publish_builder_stock_upload` |
| storage | a local object store (`supabase-gateway.mjs`) |

Only storage is stubbed, and it is the one layer where a stub cannot be
subtly wrong: a blob store has no query language to disagree about — it takes
bytes under a key and hands the same bytes back.

The filters matter more than that. Two defects in this product's history
survived their own tests because a **test double** agreed with the code while
only the server disagreed: the AML screening claim's `.or()` string, and the
builder-stock ranking fallback's error code. Emulating PostgREST here would be
that mistake a third time, so nothing in this harness answers a query.

## Models are blocked, not merely unconfigured

`harness.ts` replaces `globalThis.fetch` with one that **throws** on any
request to a generative-model host and counts it. A run reports the count, and
a non-zero count fails the run. "No key was set" would only prove the call was
not *completed*; this proves it was not *attempted*.

## Running it

```
node scripts/stock-acceptance/build-database.mjs      # production-equivalent schema
node scripts/stock-acceptance/supabase-gateway.mjs &  # one origin: PostgREST + objects
python3 scripts/stock-acceptance/make-corpus.py /var/tmp/corpus
deno run --allow-all --import-map scripts/stock-acceptance/import-map.json \
  scripts/stock-acceptance/harness.ts /var/tmp/corpus
```
