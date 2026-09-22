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

## The held-out set is the point of the corpus

A fixture written to make a rule pass proves the rule was written. A fixture
written AFTER the rules, against a document shape nobody had coded for,
proves the rule generalises. **15 of the 29 documents are held out**, and the
eleven added for multi-property segmentation are the strongest of them
because four of them must come back as ONE property or as a table:

| fixture | must produce |
|---|---|
| `heldout-two-cards` | 2 properties, each with **its own** photograph |
| `heldout-three-cards` | 3 properties |
| `heldout-schedule-table` | 3 properties, **read by the table parser** |
| `heldout-one-home-two-columns` | **1** property — a visual column is not a property |
| `heldout-shared-estate-header` | 2 properties, both carrying an estate neither card states |
| `heldout-cards-with-plans` | 2 properties, each electing its facade over its plan |
| `heldout-shared-footer` | 2 properties, and nothing of the footer in either |
| `heldout-same-lots-other-org` | 2 properties in another organisation, colliding with nobody |
| `heldout-same-design-many-lots` | 2 properties sharing one design, told apart by everything else |
| `heldout-pages-of-cards` | 4 properties across 2 pages |
| `heldout-mixed-scan-multi` | 3 — two native cards and one recognised page |

### A correct pointer to the wrong photograph passes every other check

`primary_image_id` being set proves a row NAMES an image. The chain below it
proves a customer sees one. Neither can see a **swap**: on a page carrying two
cards, giving each property the other's render satisfies all of them.

So the fixtures that carry a picture per card draw them at **different pixel
dimensions**, the expectation names which, and the comparison is made against
the bytes `serveStockImage` actually returned and `decodeImage` actually read.
`heldout-two-cards` serves `1280x800` to lot 412 and `960x600` to lot 418;
`heldout-cards-with-plans` serves `1280x800` to lot 19 and `1440x900` to lot
24. Swap either pair and the gate fails.

### A facade the classifier rejects is a fixture problem, never a product one

Two synthetic facades in this corpus are refused by `marketplaceEligibility`
as `annotated_marketing_tile`, and both refusals are correct: multi-octave
value noise at some seeds produces a flat region covering 10-11% of the
picture, and a real photograph has almost none while a graphic tile is made of
them. Measured through the product's own assessor, seed 337 fails at
1120x700, 1280x800 and 1600x1000 alike — the size is not the variable, the
seed is.

**Tuning the classifier until a generated image passes would prove nothing
about photographs.** The fixture is fixed instead, with the measurement
recorded beside it, and the two that remain are named limits the gate reports
on every run.
