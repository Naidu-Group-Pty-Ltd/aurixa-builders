# The PDF upload path, end to end, with the model switched off

*Written 22 September 2026. The measurements are from
`scripts/stock-acceptance/`, run against a real PostgreSQL 16, a real
PostgREST 12.2.3 and the product's own Edge Function modules — never
imitations of them — and from the production database of
`htfluofznhxeumblwbww`.*

Read this before concluding that a PDF upload defect is a parser defect. It
records what the pipeline was actually measured to do, which of its faults were
the product's and which were the gate's own, and the eight cases where a test
expectation was wrong rather than the code.

---

## 1 · What "working" means here

Not "the parser returned", not "CI passed", not "`primary_image_id` is
non-null". The workflow is one line and every step of it is asserted:

```
PDF → accepted → bytes persisted → document interpreted
    → property identified → factual fields extracted where provable
    → correct row identity established → builder image associated
    → eligibility and sanitisation completed → primary image servable
    → property published → the card shows the right property and photograph
```

with **no generative model anywhere in it**, and with no step requiring a
person: no database repair, no new parser, no "Read again", no manual queue
re-arm, no re-upload.

---

## 2 · The numbers

| | |
|---|---|
| PDFs tested | **18** |
| Document classes | 3 — single-property, multi-property, refused |
| Properties expected | 20 |
| Properties created | 18 |
| Fields expected | 165 |
| Fields delivered | 144 |
| Fields missing, unaccounted for | **0** |
| Fields missing under a named limit | 21 |
| Wrong properties | **0** |
| Wrong organisations | **0** |
| Duplicate properties / forks | **0** |
| Wrong fields | **0** |
| Wrong images | **0** |
| Missing expected images | 2, both named limits |
| Image-serving failures | **0** |
| Stranded jobs | **0** |
| Stranded patches | **0** |
| AI calls attempted | **0** |
| Published properties | 16 of the 18 documents' rows |
| Review-required properties | 2 (the two named image limits) |
| Genuine failures | **0** |

The two properties short of 20 are one fixture: a single page that sets two
homes in columns, which brochure mode reads as one. It is a **named limit** —
a refusal or an absent field, never a wrong value — and the corpus reports it
on every run rather than hiding it.

**21 of the 165 missing fields are three named limits**: 18 belong to that
two-column page, 2 are a bare design heading with no estate and no filename to
corroborate it, and 1 is the same on a scanned page.

---

## 3 · Completeness is measured against expectations, not against
`unaccounted_lines`

`unaccounted_lines: 0` counts lines of the document the reader could not
*place*. It is a statement about the reader's own bookkeeping. A brochure whose
price the reader correctly declined as unproven has `unaccounted_lines: 0` and a
missing price — and so does one that read every field perfectly.

The measure is instead the manifest's own expectations, which is the only thing
in this system that knows what a document *should* yield: a person read each
fixture and wrote down what it states.

**A field expected to be ABSENT is not a field.** `bedrooms: null` on the
package brochure is a prohibition — the icons are artwork, the extraction sees
three integers, and the reader must not invent counts. It is judged separately,
and counting refusals as extractions would inflate the number with the very
restraint the subsystem is built on.

---

## 4 · What was actually wrong

### The image never reached the card

`primary_image_id` was non-null and the fetch 404'd. Traced through the thirteen
named steps, it was **(C) the harness failing to emulate storage** — a doubled
`/storage/v1` prefix in the gate's own gateway — beside **one real product
defect**: Postgres `NULLS DISTINCT` meant an upsert keyed on
`(stock_item_id, source_stage, source_reference)` matched nothing while an image
was still unattached. 31 image rows for 2 pictures. A partial unique index on
`(upload_id, source_stage, source_reference) WHERE stock_item_id IS NULL`, and
one module deciding the conflict target for all nine call sites.

### A document with no text layer had no path at all

`pdf_no_text_layer` was a refusal. It is a seam now: the pages are recognised
and the *same* deterministic layers are asked the *same* questions. Tesseract's
WASM build is vendored into the module graph, because `supabase functions deploy
--use-api` uploads the module graph and a binary beside it does not travel.
Budgeted (~116 ms of CPU each against the allowance) rather than counted, and
the decoder import is lazy.

It is **not a model**: no prompt, no vendor, no credential, no spend, nothing
generative. A recogniser that read text off a raster is the opposite of one that
writes text that was not there.

### A hostname could name a house design

The reader treats the name it is handed as *evidence*:
`corroborateDesignFromFilename` settles which field an unplaced page line
belongs to when every word of that line also appears in the name. It was being
handed `upload.original_filename`, which the two transports mean different
things by — the document's own name for a file, a display label
(`host/…/segment`) for a URL.

Measured, by calling the corroborator with one unplaced page line and three
names for one document:

| name | reading |
|---|---|
| `LOT 37 - HAVENWOOD 21 - PACKAGE.pdf` | `house_design` = "Havenwood 21" |
| `alphahomes.com.au/…/LOT 37 - HAVENWOOD…` | `house_design` = "Havenwood 21" |
| `alphahomes.com.au/download` | nothing |
| `havenwood-homes.com.au/download`, page line `Havenwood` | `house_design` = "Havenwood" |

The same bytes were a different document depending on how they arrived. The
last row is the worse half: no document said that, a **hostname** did —
`nameTokens` splits on every non-alphanumeric, so `havenwood-homes.com.au`
contributes `havenwood` to the set the corroborator matches against. A brand
mark became a property field.

`documentName.pure.ts` separates the two. A URL names a document through
`Content-Disposition` or its own path segment, and otherwise names **nothing** —
which is the honest answer and leaves the reader exactly where a file called
`download.pdf` does. Three rules: a hostname is never a document name, absent is
never invented, a display label is never evidence.

### A stock list nobody came back for was stranded for ever

`RE_READABLE_STATUSES` excluded `uploaded` under one sentence covering two
different cases: *"a cron tick may not decide to start importing a file the
builder's own import refused OR NEVER RAN"*.

The first half is right and stands — a `failed` row is a decision a person was
*shown*, and a tick that quietly re-imports overrules them. The second half was
wrong. An `uploaded` row carries no decision at all: the bytes were stored, the
browser never called `process_upload`, and nothing has ever looked at the file.

Measured: bytes stored, eight sweep ticks, **zero properties**, status
unchanged, every screen reporting normal operation.

Two things make adopting it safe. A **fresh** `uploaded` row is refused as
`upload_not_started`, which `stampable` will not settle, so the sweep cannot
race a browser about to import. Past `ABANDONED_UPLOAD_MS` the sweep **claims**
it — `uploaded` → `parsing`, conditional on it still being `uploaded` — so
whichever of the two gets there first is the one that imports. Every exit from a
claimed row puts it down terminally: the object gone, the import refused, the
run threw. A claimed row left at `parsing` is re-readable, and the next tick
would read it as an ordinary re-read and never make it terminal — the stranded
state, reintroduced by the fix for it.

### A superseded list could never correct its own rows

`20260921110000` found that `publish_builder_stock_upload` returned
`already_published` above the only step that applies a held-back patch, so a
re-read of a published list could never change a value. It moved the patch above
that return and left the return beside it.

`superseded` is the other one, and it is the broader: `builder_stock_upload_superseded`
is satisfied by **any** later non-deleted upload in the organisation, related or
not. So a builder who uploads a second, unrelated stock list makes every earlier
list permanently uncorrectable.

Measured by the gate's stranded-patch count — 12 rows, eleven documents, three
organisations — and then by calling the function by hand:
`{"reason": "superseded", "published": false}`, nothing applied. With the patch
moved above that return: `{"reason": "superseded", "patched": 1, "published":
false}`.

**The return stays.** The guard protects the *marketplace* — an abandoned draft
must not promote its staged rows or archive somebody else's — and applying a
patch keyed on `pending_upload_id = p_upload_id` does neither.

---

## 5 · Identical bytes are the same document

`runImport.ts`'s own header promises that everything after transport is
identical for a file and a URL. The gate asserts the sentence rather than
illustrating it, over the **whole reading** rather than a list of columns —
because a list can only catch what somebody remembered to put in it.

Compared: the verdict and its code, the reader's status and reason, every field
read, every field declined *with the reason it declined for*, which reader
placed each field, the candidate count, every stored column, and what the
property published as. Excluded: row ids and clock readings, because the two
routes deliberately import into different organisations.

Building it found three things, and all three were the gate's own:

* `String(v)` on an object is `[object Object]`, so `source_row` — the reader's
  own record of what it read — was being compared to nothing at all.
* Route B set a `storage_path` and never put bytes at it, while the product
  snapshots before importing. Every image stage answered *"this row names no
  source this pipeline can open"* and the settler spun: `image_work_attempts:
  11` against route A's 0.
* Settling route A alone forced seven columns out of the comparison to make it
  pass. Both routes settle now, and the assertion can therefore see a transport
  that *publishes* differently — which is most of what "the same document" is
  for.

---

## 6 · The faults, and what each one must not cost

A fault may cost **time** and it may cost a **field**. It may never cost the
property, never publish something wrong, never leave a row in a state nothing
can move, and never be silent.

| fault | measured outcome |
|---|---|
| No provider, no credential, no budget | 16 documents imported, 0 model calls |
| The model refuses (402) or never answers | Unreachable by construction: the switch is off, no request is composed, and the interceptor would name any code path that composed one |
| The same job delivered twice | 1 property, 1 anchor |
| A re-read arrives mid-import | `parse_in_flight`, not stamped, left outstanding |
| A deploy lands mid-processing | 1 tick, re-read, the same row ids |
| Image work retried | 1 image row before, 1 after |
| A builder uploads a replacement | Card never blank, never forked, photograph kept, price one of two legal shapes |
| The browser closes on acceptance | 1 tick, 1 property, imagery settled, **photograph on the card** |
| A worker dies after committing | 1 tick, same rows, status `imported`, one row for the lot |
| Anything left mid-flight | 0 |

**"The model is unreachable" is a stronger claim than "the model was not
called."** `assistedReaderEnabled` is false on every deployment that has not
opted in by name, so no request is composed, no budget is reserved and no vendor
round trip is waited on. A 402 and a timeout are then the same event: one that
does not occur. Standing up a fake vendor to answer 402 to a call nobody makes
would have asserted nothing.

---

## 7 · Eight expectations were wrong, and each says why

The contract for changing a test expectation is: state the old one, why it was
wrong, the objective evidence, and the new one. Every one of these is recorded
at its call site.

1. **`readerReReadRefusal({status: 'uploaded'})` is `'status:uploaded'`.** Two
   different cases under one sentence; the second is a customer's list stranded
   for ever. *Now*: refused while fresh, adopted once abandoned, claimed
   atomically.
2. **`RE_READABLE_STATUSES` has neither `failed` nor `uploaded`.** `failed`
   stays out — it is the one a person was shown.
3. **The sweep writes no status literal at all.** It writes exactly one,
   `parsing`, in the claim. *Now*: the two that would overwrite a live list are
   still forbidden outright, and the claim's own predicate is pinned instead.
4. **A replacement's new price waits in `pending_patch`.** Measured: applied,
   and the revision upload published one second after its import. Deferral is
   the *first half* of a cutover, not the end state — the publication function
   applies the held patch in the same statement that promotes the staged rows,
   deliberately. *Now*: no blank card, no fork, no lost photograph, and the
   price is one of two legal shapes, never a third.
5. **The abandoned-upload case accepted `status === 'uploaded'`.** It passed
   while nothing worked. *Now*: the product is fixed and the case asserts the
   whole workflow.
6. **The fork count keyed on the lot number** and read 2. Both rows were
   correct: Alpha Homes holds a lot 18 in Tarneit and a lot 18 on Hollybank
   Crescent, Melton South. A lot number is a builder's numbering within an
   estate. *Now*: keyed on `stockPropertyIdentity`, the importer's own question.
7. **`falseNothingImported` read 11** — the gate wrote no counts, so every URL
   import left `records_detected: 0` on a row holding a correctly imported
   property. The incident's own symptom, produced by the gate that exists to
   detect it. *Now*: `recordImportOutcome.ts`, one write, both callers.
8. **Three Part 8 sweeps passed 15, 20 and 25 seconds** against a 40-second
   `READER_SWEEP_RESERVE_MS`, so every sweep broke out of the loop before
   touching a row and three cases exercised nothing. *Now*: derived from the
   product's own constant.

---

## 8 · The rules this leaves behind

* **A refusal closes the row.** `runStockImport` returns a refusal and writes
  none; every caller writes a terminal status through `closeRefusedUpload.ts`.
  A caller that *imitates* the product's write is one that can disagree with it.
* **An import that succeeded writes its counts**, through `recordImportOutcome.ts`
  — the same rule, the other half of the outcome. The status and the source
  notice stay per-caller, because those are *not* alike and must not be made
  alike.
* **A hostname is never a document name**, and a display label is never
  evidence.
* **`uploaded` is not `failed`.** One carries a decision a person was shown; the
  other carries none.
* **A corrected reading must reach the customer through every early return.**
  Twice now, on the same function.
* **A fixture shorter than the product turns a measurement into a statement
  about the fixture.** Three cases in Part 8 passed having exercised nothing,
  and the corpus still carries no document whose reading depends on its name —
  which is why the corroborator is pinned in a spec that drives it directly.

---

## 9 · What production says, after the deploy

The gate is a claim about the product. This is the same claim, read out of
`htfluofznhxeumblwbww` after the change shipped.

**The reader version did the work it exists for.** `Lot 37 - Miami 190 -
Property Package.pdf` was settled at reader 11 and carried **no building
size**. `DETERMINISTIC_READER_VERSION` moved to 12, the sweep re-read the row
50 seconds after the deploy with nobody asking, and:

| field | reader 11 | reader 12 |
|---|---|---|
| `building_size_sqm` | *null* | **190.00** |

which is the quantifier rule (`TOTAL HOME AREA` is the building size) firing on
the real document rather than on a reconstruction of it. The import log
confirms how: `deterministic_status: complete`, `building_size_sqm:below`.

**What is still absent is the reader declining, not failing.** `price`,
`postcode`, `address_line` and `house_design` are null on that row, and the
log's `deterministic_fields` names exactly what the page proved. This is the
distinction §3 is about: `deterministic_unaccounted_lines: 0` on the very same
run, beside four fields the record does not hold.

**The orphan-image defect is closed.** 64 unattached image rows across 18
uploads, **64 distinct** `(upload_id, source_stage, source_reference)` keys —
zero duplicates, against the 31-rows-for-2-pictures that the NULLS DISTINCT
bug produced.

**The OCR model is in storage** at `system/ocr/4.0.0_best_int/eng.traineddata.gz`,
2,952,873 bytes, `application/gzip` — the exact count `languageData.ts`
asserts before it will use it.

**Re-verified after background settlement**, which is a separate reading and
not a repeat of the first one. Seven minutes later the row is `complete`,
published, reader 12, `building_size_sqm` still 190.00, no `pending_patch`,
image work `settled` with the photograph attached, and the settler's ticks read
`claimed: 0, claimable: 0, outstanding: 0` — quiescent.

**One thing moved between the two reads and it is worth writing down.** The
upload's counts went from `imported: 0, updated: 1` to `imported: 1,
updated: 0`, and the status from `imported` to `complete`. Nothing re-imported:
the log names it — `finalisation recovered`, then `upload settled`. The two
counts answer different questions. The sweep's describe **that run**, which
updated a row that already existed; the recovery's describe the **upload's
standing state**, which is that it supplies one property. Reading either as the
other is the "two counters counting different things" mistake this codebase has
already paid for once, in `sectionCountForTier`.

---

## 10 · The deploy that reported success and shipped a mixture

This is the episode the report would be dishonest without, because it was
caused by the work above.

The first merge went green and its deploy **failed**:

```
unexpected deploy status 413: {"message":"request entity too large"}
deploy failed for: builder-portal-stock builder-stock-image-settler
```

Twenty-five functions shipped. The two that did not were the customer's upload
entry point and the sweep that settles every image. `verify-functions-deployed.mjs`
caught it and failed the run — the only reason it was not silent.

**The cause was the OCR model, vendored into the module graph by the change
that introduced OCR.** `--use-api` uploads a function's whole module graph in
one request:

| | bytes |
|---|---:|
| `builder-portal-stock` | 6,588,010 |
| — of which the model | 3,937,754 (60%) |
| — without it | **2,650,256** ← the size that last shipped |

Two cheaper repairs were **checked rather than assumed**: a dynamic import does
not remove a module from the graph (it was already dynamic and still there),
and splitting it across modules does not help, because the limit is on the
request. So the graph is not a viable home for the asset at any encoding.

`languageData.ts`'s own header had considered a bucket and rejected it, for a
sound reason — a capability depending on a seeded object is absent on every
clone while looking present. **What makes it safe is that it is not seeded:**
the deploy uploads it on every deploy, idempotently, so it travels the way code
travels. That is the remedy `CLONE_PROVISIONING_GAPS.md` itself names.

Three things worth keeping from it:

* **The listing's version number is not evidence of a deploy.** After the
  failure, `builder-portal-stock` read version 550 against a baseline of 548 —
  while `updated_at` and `ezbr_sha256` were **unchanged**. Two of the three
  signals said nothing shipped and they were right. Read the workflow's
  conclusion first; verify with the timestamp and the bundle hash, never the
  version alone.
* **The upload runs after the functions, not before.** A function deployed
  against a missing table answers 500; one deployed without this asset declines
  OCR, which is what every deployment did before OCR existed. Asset-first would
  ship nothing on a fault; asset-last ships the functions and goes red.
* **A commit can claim a change it does not contain.** A `git reset --hard`
  between writing and committing discarded every tracked edit, and `git add -A`
  then staged only the new files — so the commit saying the model had left the
  graph left it in place. CI passed, because a graph too large to *deploy* still
  typechecks and builds. The check that found it was reading the commit's own
  `--stat` against what it claimed.

---

## 11 · What is still open, named rather than hidden

* **A page that sets two properties in columns** reads as one. Brochure mode is
  single-property by construction; a column-aware mode is a different reader,
  not a patch to this one.
* **A bare design heading with no estate and no filename** is left absent. The
  corroborator requires the document to have established which property it is
  beyond its lot, and refusing is the conservative side.
* **Two synthetic facades** fail the overlay repair at their seed. Both are
  facts about the fixture generator rather than about the pipeline, and both are
  stated with the evidence that says so.

None of the three is a wrong value. Every one is a refusal or an absence, which
is the standard a named limit has to meet.
