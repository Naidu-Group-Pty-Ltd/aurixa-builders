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

## 0 · THIS SUBSYSTEM IS FROZEN

**The PDF ingestion architecture is the supported baseline as of 22 September
2026** (reader 13, `builder-portal-stock` v562, `builder-stock-image-settler`
v564), and reader 14 on 23 September (§13). It is not frozen because it is finished — §12 lists what is still open —
but because it has been measured, and the measurement is what a change has to
beat.

What that means in practice: **a new builder, a new filename, a new estate, a
new design name or a new brochure colour is not a reason to touch anything
here.** A document is covered because its SHAPE is covered, and the shapes are
the acceptance corpus. The commonest way this subsystem got worse in the past
was a parser patch written for one document that nobody could later distinguish
from a rule.

A change to this subsystem needs one of exactly four things, and the first of
them is the bar the other three are measured against:

1. **A reproducible production defect** — a row, a log line or a stored
   document that shows the pipeline doing something wrong, not a report that
   it might.
2. **A genuinely new unsupported document CLASS** — a shape the corpus does
   not contain, added to the corpus as a held-out fixture BEFORE the code
   that reads it.
3. **A security or compliance issue.**
4. **A clearly specified new product capability**, asked for as a capability
   rather than as a fix.

Anything that is not one of those four is already answered by §11, §12 or the
corpus. If a document fails and its shape is in the corpus, the corpus is the
place to reproduce it; if its shape is not, that is case 2 and the fixture
comes first.

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

*Re-measured 22 September 2026 on the frozen baseline. The 18-document run
this table replaces is in the history of this file.*

| | |
|---|---|
| PDFs tested | **29** |
| Held out (written after the rules, never consulted while designing them) | **15** |
| Document classes | 3 — single-property, multi-property, refused |
| Properties expected | 46 |
| Properties created | 44 |
| Properties review-required | 2 (the two named image limits) |
| Fields expected | 296 |
| Fields delivered | 274 |
| Fields missing, unaccounted for | **0** |
| Fields missing under a named limit | 22 |
| Genuine failures | **0** |
| Wrong properties | **0** |
| Wrong organisations | **0** |
| Duplicate properties / forks | **0** |
| Wrong fields | **0** |
| Wrong images | **0** |
| Properties on a document that states a photograph | 17 |
| — photograph served, fetched and decoded end to end | 15 |
| — absent | 2, both named limits |
| Image-serving failures | **0** |
| Stranded jobs | **0** |
| Stranded patches | **0** |
| Orphan duplicate image rows | **0** (64 orphan rows over 64 distinct keys) |
| AI calls attempted | **0** |

Route A (a direct upload) and route B (the same bytes fetched over HTTP)
produce the same properties on all 29: **44 and 44**, compared property by
property over the whole document shape rather than over a list of columns.

The two properties short of 46 are one fixture, `Estate Release - Two
Homes.pdf`, and the reason MOVED with this work — segmentation divides that
page correctly into two regions and what refuses it is now a vocabulary gap in
a shared heading. See §12.

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

### 9a · And again, for the segmentation deploy (22 September 2026, 07:58 UTC)

**What shipped, read three ways.** Every one of the 27 functions moved its
`version` and its `updated_at`, and exactly **two** moved their
`ezbr_sha256` — which is the containment guarantee observed on the wire
rather than asserted:

| function | version | `ezbr_sha256` |
|---|---|---|
| `builder-portal-stock` | 557 → **562** | `58a415e3…` → **`824f48e3…`** |
| `builder-stock-image-settler` | 559 → **564** | `eee257ba…` → **`6408c093…`** |
| `builder-stock-link-callback` | 559 → **564** | `0e8df63b…` *unchanged* |
| `builder-network-stock-image` | 499 → **504** | `8a0f35a5…` *unchanged* |
| `builder-document-processor` | 562 → **567** | `62a3ce4a…` *unchanged* |

A version that moves with an identical bundle hash is the deploy doing its
job over code that did not change. Only the import path and the settler
carry a new bundle, which is where the change is.

**The heartbeat re-read the stored document with nobody asking.** Reader 13
shipped at 07:58:16; at **07:59:10**, on the ordinary minute tick, the one
non-deleted upload in this project re-read and settled:

| | before | after |
|---|---|---|
| `reader_settled_version` | 12 | **13** |
| `parse_strategy` | `pdf_deterministic_brochure` | `pdf_deterministic_brochure` |
| row id | `0fd93346…` | `0fd93346…` |
| `source_anchor` | `pdf:page1` | `pdf:page1` |
| `building_size_sqm` | 190.00 | 190.00 |
| `land_size_sqm` | 563.00 | 563.00 |
| `development_name` | Sandpiper Estate | Sandpiper Estate |
| `lifecycle_status` | active | active |
| primary image | set, `primary_property`, `eligible` | set, `primary_property`, `eligible` |
| `pending_patch` | none | none |

**The strategy is the assertion.** `pdf_deterministic_brochure`, not
`pdf_deterministic_regions`, and a page anchor rather than a region anchor —
a single-property document is untouched by segmentation in production, which
is the regression that mattered most and the one a corpus alone cannot prove.

**And nothing spent anything.** `ai_spend_reservations` and `api_usage_log`
are both empty for the last six hours; the most recent reservation of any
kind is 21 September 13:55, before the assisted reader was switched off. The
flag `BUILDER_STOCK_ASSISTED_READER` is set nowhere in this repository.

### 9b · After the settlement window, which is a separate reading

A correct row for thirty seconds is not a correct row. Read again at
**08:13:53**, fourteen minutes and fourteen heartbeat ticks after the
re-read, with nothing poked in between:

| what the checklist asks | reading |
|---|---|
| the property is still correct | `building_size_sqm` 190.00, `lifecycle_status` active |
| no duplicate row appeared | **1** live property, same id `0fd93346…` |
| no valid image disappeared | same image row `15bb88b2…`, created 21 Sep 18:19, still `primary_property` / `eligible` |
| no `pending_patch` appeared | none |
| no orphan image duplication reappeared | 64 orphan rows over **64 distinct keys** |
| no upload became stranded | 0 at `uploaded` or `parsing`, 0 `parsing` with an error |
| no stale worker overwrote the result | `item.updated_at` still **07:59:09.958701** — untouched for fourteen minutes |
| queues quiescent | claimed 0, unsettled 0 |
| nothing spent | 0 AI reservations in the hour |

**Six stranded patches exist and they are named rather than zeroed.** All six
are on uploads a builder deliberately DELETED — each row's last write is
within 130 ms of its upload's `deleted_at`, on 21 September, a day before
this work — so the deletion is what stranded them, and the migration that
fixed the cause (`20260922070000`) applies on an upload's next publication,
which these will never have. Touching them would be altering deliberately
deleted customer data. Against live uploads the count is **0**.

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

## 11 · One page, several properties

The limit this section replaces read: *"a page that sets two properties in
columns reads as one. Brochure mode is single-property by construction; a
column-aware mode is a different reader, not a patch to this one."* The second
sentence was right and the reader is now written.

### Why it mattered more than it looked

Reading a two-card page as one property is not a missing import. Where the two
cards state DIFFERENT fields it does not refuse — it **completes**, as one
property wearing both properties' facts: one lot, the other's price, either
land size. That is the only shape in this subsystem that can put one builder's
price on another builder's house, and no gate below the reader can see it,
because the row it produces is perfectly well formed.

### Geometry proposes, evidence disposes

`propertyRegions.pure.ts` answers one question — how many independent property
regions does this page carry — and answers `null` for every page that carries
one, which is every document this reader has ever handled. A caller that gets
`null` behaves exactly as it did.

**The gutters are sought beneath the page's furniture.** A run that spans most
of the content, or that is several times the page's own median run, is a
heading or a footer rather than a cell and is kept out of the search. It is
put back immediately: **what a run is worth and where it BELONGS are two
different decisions**, and the second is purely geometric — a run overlapping
exactly one band is that band's, one overlapping two or none is the page's. So
a long address line inside one card stays that card's, and a heading crossing
the gutter becomes shared.

**A band is a property only on property-level evidence.** Two property-local
fields, at least one identity (`lot_number`, `unit_number`, `price`,
`house_design`), and no identity kind stated more than twice — which is what
tells a property CARD from a schedule COLUMN without knowing anything about
tables, since a column of eight prices states one kind eight times. Two bands
naming the same property are one property drawn twice. Fewer than two
qualifying bands and the page is left whole, which is the guard that protects
every brochure in the corpus: text on the left and a render on the right
splits into two bands of which exactly one states a lot.

**The same question is asked on the other axis**, so a grid of six cards is six
regions — but only where the horizontal pass already found more than one band,
because splitting a single-column page by its own paragraph gaps would cut one
property into its sections.

**A band that did not qualify is SHARED, never discarded and never given to a
neighbour.** Shared is the only safe home for evidence that belongs to no one
region.

### The reading, and the bar it has to clear

Each region is read by the ORDINARY brochure reader over a synthetic document
of the page's shared runs followed by that region's own — so the estate, the
stage, the builder's name and the footer disclaimer are read into every
candidate, and every candidate has to account for them. There is no second
vocabulary, no second gate and no second set of typed validators.

**Every page must be accounted for.** A page that segmented contributes one
candidate per region; a page that did not contributes one, which is the whole
page; and if any candidate refuses, the WHOLE segmented reading is abandoned
and the document is read exactly as it is read today. That is harsher than it
needs to be and harsh in the only direction that is safe: the alternative is
completing around content nobody read, which is the rule this module's own
header opens with.

**The filename is not passed.** A document naming several properties has a name
that describes the document; letting it corroborate one region would make it
contradict all the others.

A fallback is never silent — `regionsFound` and `regionsAbandoned` reach the
import log, because a page that segmented and then fell back is otherwise
indistinguishable from one that never segmented.

### The pictures follow the cards, or they follow nobody

A raster's drawn rectangle travels beside its page number now, and **only where
the page's own `/MediaBox` starts at the origin and it carries no rotation** —
a content stream's user space and pdf.js's normalised space are the same space
only there, and comparing them anywhere else attaches a picture to whichever
property the arithmetic lands on.

A picture overlapping exactly one region's column is that region's. A page-wide
banner, a logo in the margin, a graphic straddling two cards and a whole-page
crop all overlap two regions or none, lose their anchor, and are kept against
the upload and shown against nobody. **A wrong image is worse than no image.**

Once a page has been divided, **the property's page IS its region** for every
question the imagery path asks about it — does the page state this property's
identity, does it state package facts, how many pictures does it draw. Asked of
the sheet, all three answers are about all three cards, and
`pageStatesIdentity`'s rule 2 refuses a page naming any lot but ours, which is
exactly right for a page read whole and exactly wrong for a card.

### Two things measurement found that no hand-written fixture would have

**A line of small print may not close a gutter.** On a three-card release sheet
the footer is 208.5 points wide against 425.8 of content — 49%, UNDER the 55%
share that keeps a heading out of the search — so its span merged with the
first column's and reached past the second column's origin. The first gutter
vanished, the page came back as one property, and that property wore three
lots. What separates that footer from a cell is not the page's width: it is
that it is five times any other run on the sheet. Measured over both shapes,
the widest CELL is 1.6× the page's median run and the narrowest FURNITURE is
5.1×, so three sits between them with room on both sides.

**A repair may not reach a different conclusion from the import.** On a page
with a facade and a floor plan in each card's own column the import elected
both heroes correctly and the first settler tick erased them:

```
after import   lot 19  primary=set   #4 role=primary_property eligible
first tick     lot 19  primary=null  #4 role=unknown  eligibility gone
→ ladder walks to `fallback` → "no source this pipeline can open" → `failed`
```

The ordinary repair branch called `attachDocumentMedia` with no page evidence,
so the roles were settled by `settleContainerMediaRoles` — right for a
spreadsheet or a Notion row, and it designates a primary only where a property
has EXACTLY ONE attributed picture, because a container that hands you two has
not said which is the listing image. A PAGE has said. And the upsert replaces
`source_detail` wholesale, so the wrong helper did not merely fail to elect: it
ERASED the election and the eligibility verdict beside it, on the first tick
after every import.

It was invisible while every PDF property had at most one attributed picture —
a second picture on the page belonged to the page, and a page anchor two
properties claim is attributed to neither. A floor plan beside a facade inside
one card's own column is all it takes. `repairPdfUpload` has passed the page
evidence since it was written, under a comment saying a repair must not reach
a different conclusion from the import; that rule was true of one of the two
repair paths and is true of both now.

### It stays inside the PDF

Segmentation operates on document evidence after a PDF has been obtained, and
nothing about it reaches a transport. `propertyRegions.pure.ts` is imported by
the deterministic reader and by `extract.ts` and by nothing else; a row that
arrived with its own anchor keeps it (`if (!record.source_anchor && …)` is
unchanged); a Notion row id, a sheet cell, a docx row and a slide are answered
`null` by every anchor reader here; and the Google Sheets CSV and HTML
readings are compared field by field against what they produced before.
`builderStockSegmentationStaysInThePdf.spec.ts` is that guard.

### What it does not claim

A page whose text was **recognised** is never divided. Its positioned runs
describe only whatever native fragment happened to share the sheet, so the
gutters they suggest are gutters in a fragment; such a page is read whole,
from the text recognition produced. A scanned multi-property page is therefore
outside this, and the corpus says so on the fixture rather than leaving it to
be discovered.

## 12 · What is still open, named rather than hidden

* **A scanned page carrying several cards** is read whole. Recognition returns
  a page of lines and the layout reader sees only the native fragment, so there
  is no geometry to divide. Named on the fixture and in the log.
* **A shared line no region can account for stands the document down.** On
  `Estate Release - Two Homes.pdf` segmentation divides the page correctly into
  two regions and the heading `RELEASE 6 - WOLLERT` parses as a label and its
  value; `WOLLERT` is corroborated by the suburb in both cards and `RELEASE 6`
  names no field this vocabulary knows. It carries a digit, so it can never be
  dismissed as prose. The document imports zero properties before and after the
  segmentation work — this is a vocabulary gap, and closing it by teaching the
  alias table that a "Release" is a stage is the per-document parser patch this
  subsystem is frozen against.
* **A bare design heading with no estate and no filename** is left absent. The
  corroborator requires the document to have established which property it is
  beyond its lot, and refusing is the conservative side.
* **Two synthetic facades** fail the overlay repair at their seed. Both are
  facts about the fixture generator rather than about the pipeline, and both are
  stated with the evidence that says so.

None of the four is a wrong value. Every one is a refusal or an absence, which
is the standard a named limit has to meet.

## 13 · A package brochure that printed everything and imported two fields

**The defect (case 1 of §0), 23 September 2026.** `LOT 4327 Jubilee Estate -
ENZO 10.5 MODERN - BROCHURE V002 - Copy.pdf` (7,762,286 bytes; the only live
source on the production project) imported its price and its land size. The
card read `Lot 4327, · Specifications`, with three dashes for bedrooms,
bathrooms and car spaces, and `HOME —`. The page prints the estate, the
suburb, the design, the three counts and the house's total area. The stored
document was read back with `scripts/ops/stock-reading-trace.ts`
(production-rollout phase `stock-reading-trace`, read-only). That showed five
separate causes, each of which cost one field. None of them is specific to
this builder. They are properties of a layout class: a package brochure with a
design in display type, an icon row, a two-line address and an area schedule.
Three held-out fixtures of that class were added to the corpus before any
code (case 2): `heldout-icon-row-estate-locality`,
`heldout-icon-row-street-locality`, and the negative
`heldout-icon-row-plan-disagrees`.

| cause, as the page drew it | the rule now |
|---|---|
| A raised `2` (`91.91m²`) was drawn 3.3 points above its figure, on the `Specifications` heading's baseline, and was grouped with the heading. | **A superscript belongs to the figure it abuts** (`liftedSuperscripts`). It must be smaller than the figure, raised by less than the figure's own height, and start where the figure ends. Without extractor heights, nothing moves. |
| `Total:` was set 2.9 points above its own `129.5m²`. | **A label ending in a colon owns a value drifted less than a third of a line** (`joinDriftedLabelValues`). The value must be beside it, at a similar size, and within reach. Directly under the label is still the pair reader's case. |
| `House` over `Specifications` was taken for the house design, which blocked the corroboration of the page's own `Enzo 10.5`. | **A section heading is never a name** (`a_section_heading_is_not_a_name` in `fieldTypes.pure.ts`). A value made only of section nouns and their qualifiers, with no digit, is declined as a design or an estate. |
| `Lot 4327 Jubilee Estate,` over `Wyndham Vale`. | **A trailing comma is the document saying the address continues** (`readContinuedAddress`). The suburb is read, and no state or postcode the page does not print is invented. Without the comma the old refusal stands (`builderStockAddressBlock.spec.ts` records the renegotiation). |
| The icon row `3 2 2` had nothing to key it: the floor plan is a picture and there is no siting page. | **An icon row is read in its printed order, bed · bath · car, only where nothing else keys it** (`readOrderedIconRow`). Each guard refuses rather than guesses, and each is the only thing standing between some row and a reading in `builderStockIconRowOrder.spec.ts`: implausible counts, gaps too narrow for a pictogram, anything drawn between the figures, zero-padding, widths nobody measured, a second different row, a row on a page that does not name the lot, and a plan that names more bedrooms than the row (the negative fixture). |
| No label says "build size"; the house schedule ends `Total: 129.5m²`. | **The total of the house's one area schedule is its building size where nothing labelled competes** (`areaSchedule.pure.ts`). The schedule needs two or more dwelling parts, a total that is at least its largest part and within 25% of their sum, and exactly one such schedule on the document. It never speaks over a labelled figure, which is why its first version was deleted (Lot 315). |

`builderStockLot4327Geometry.spec.ts` asserts all five against the production
page's own runs, printed by the trace. The acceptance gate read 33 documents
with 0 failures and 0 generative-model calls. The three new fixtures import
every expected field through the multi-isolate hand-off, the negative fixture
leaves its counts empty, and no other document's expectation moved.

Reader 14 is what reaches the stored document. The reader sweep that re-reads
it had to change first, because this document is `LOT 550`'s class. See
`54-what-the-importer-spends.md` §11.5.

