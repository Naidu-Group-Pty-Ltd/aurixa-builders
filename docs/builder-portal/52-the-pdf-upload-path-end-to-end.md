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
v564), reader 14 on 23 September (§13), and reader 15 the same day (§14). It is not frozen because it is finished — §12 lists what is still open —
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
| No label says "build size"; the house schedule ends `Total: 129.5m²`. | **The total of the house's one area schedule is its building size where nothing labelled competes** (`areaSchedule.pure.ts`). The schedule needs two or more dwelling parts, a total that is at least its largest part and within 25% of their sum, and exactly one such schedule on the document. It never speaks over a figure its own page labels, which is why its first version was deleted (Lot 315); since reader 15 it does speak over a label on a siting plan (§14). |

`builderStockLot4327Geometry.spec.ts` asserts all five against the production
page's own runs, printed by the trace. The acceptance gate read 33 documents
with 0 failures and 0 generative-model calls. The three new fixtures import
every expected field through the multi-isolate hand-off, the negative fixture
leaves its counts empty, and no other document's expectation moved.

Reader 14 is what reaches the stored document. The reader sweep that re-reads
it had to change first, because this document is `LOT 550`'s class. See
`54-what-the-importer-spends.md` §11.5.


## 14 · A siting plan's figures stood beside the property's own

**The defect (case 1 of §0), 23 September 2026.** `LOT 927 - ENZO 10.5 -
BROCHURE V002.pdf` is the same builder template as Lot 4327, with one more
page. It imported with `LAND —` and `HOME 132 m²`. Its property page prints
`Lot Size 294m²` and a house schedule totalling `129.5m²`. The trace
(`stock-reading-trace`, read-only) showed that page 2 was the cause. Page 2 is
a siting consultant's *Proposed Siting*. It prints `Site Area: 309.45 m2` and
`Build Area: 131.6 m2`, the two operands of the `Site Coverage: 42.5%` it
states (131.6 ÷ 309.45 = 42.53%). They are real measurements, taken for a
different purpose: the surveyed boundary and the outside of the walls.

The reader gave them the same standing as the property's own page:

| field | what happened | why |
|---|---|---|
| land size | 294 and 309.45 were read as one statement made twice that disagreed, so the field was **disputed and dropped**. | Every page's figure competed on equal terms. `Site Area` became a land-size alias in doc 50 item 6, which is what put this page in the contest. |
| build size | The siting's labelled `Build Area` was **taken** and the house's own `Total:` never asked. | The area schedule was a fallback for a document stating no build size at all (§13). |
| estate | `(Banyan Place Estate)` on page 1 and `Estate: Banyan Place` on page 2 were **disputed and dropped**. | The same place, spelled with and without the word. |

Two held-out fixtures of the class went into the corpus before any code (case
2). `heldout-siting-plan-own-areas` has a property page stating both sizes and
a siting that disagrees with both. `heldout-siting-plan-fills-land` has a
property page with no lot size, so the siting's site area is the only
statement and must still be read. Run through the unfixed reader, both
reproduced production exactly.

**The rule: the page that prices the property is the page that measures it**
(`measurementAuthority.pure.ts`). A lot size or a build size is settled once
every page has been read, in two tiers:

1. **The property's own page** is every page that stated the price. Its
   figure stands. If it states two figures that disagree, the field is still
   disputed. No other page can settle a page that disagrees with itself.
2. **Every other page** may *refine* that figure, when it states the same
   measurement to more decimals (`402` → `401.86`, `321` → `320.72`, the
   rule `sameMeasurement` has always applied). It may also *fill* a figure the
   property page never states. It may never overrule one.

For the house, the property page's own area schedule sits between the two
tiers. It ranks below a build size the property page *labels*, as it always
has, and above a label on any other page. A document that states no price has
no property page and reads as it always did, with one correction: a third
statement no longer revives a size that two others disputed. The loop's commit
used to re-claim a field it had just dropped, which chose by page order. That
defect is still present for other non-material fields, where it is out of this
change's reach and has not been measured on any document. What was outranked
is named in `outrankedFields` (field names only) and reaches the import log as
`deterministic_outranked`.

The estate rule is narrower: **a trailing `Estate` is not part of the
comparison** (`placeWords`), and the spelling that carries the word is kept
whichever page comes first. `Banyan Place` and `Banyan Rise` still disagree.
The importer already corrects its own row when a re-read gives a development a
name (`byOwnAnchor`, `builderStockRereadCorrectsItsOwnRow.spec.ts`), so the
property keeps its id and its photographs.

What this does not change, measured rather than assumed. Every PDF the corpus
generator writes (the 35 fixtures, plus the second file of the replacement
fixture) was read by the reader at `HEAD` and by this one, and the rows were
compared with key order ignored. 34 of 36 read identically; the two that differ
are the new fixtures. `builderStockLot927Geometry.spec.ts` asserts the reading against
the production pages' own runs: 294, 129.5, `Banyan Place Estate`, and
everything else as it was. It also asserts the same row with the siting plan
first, and the siting plan's own figures where it is the only page. The
consultant's contact details are replaced by same-shape placeholders, which
leave the reading byte-identical.

The acceptance gate read 35 documents with 0 failures, the same seven named
limits as before, and 0 generative-model calls. Both new fixtures import every
expected field on both routes, through the multi-isolate hand-off, and their
pictures settle. The CPU profile is flat within noise: the document class
totals 29,080 ms against 28,508, and no invocation both parsed and decoded.

**What it does not claim.** A brochure that prints its sizes on a page that
does not state the price, beside a siting plan, reads as it did before: two
pages on equal terms, where a disagreement disputes the field. No document of
that shape has been seen. If one arrives, the rule to reach for is the siting
plan's own arithmetic, since its two areas reproduce the coverage it prints.
Under §0 case 2, it comes to the corpus as a held-out fixture first.

Reader 15 is what reaches the stored document. The reader sweep re-reads it,
and `LOT 4327`, on its fifteen-minute heartbeat.


## 15 · The builder's second template: four facts in arrangements the reader did not know

**The defect (case 1 of §0), 23 September 2026.** `Lot 101 - PICO - BROCHURE
v002.pdf` was uploaded to the production project that afternoon and its card
read `Lot 101`, with the icon row's `3 2 1`, and nothing else. The builder is
the same one as §13 and §14, and this is their other template. The trace
(`stock-reading-trace`, read-only) shows its property page prints:

    PICO 8
    Land - $238,500
    Build - $366,000
    TOTAL - $604,500
    Lot 101 Watsons Reach Estate
    Titles December 2026

Every one of those is a spelling the vocabulary already had. What the reader
did not know was the arrangement:

| as the page prints it | why nothing read it | the rule now |
|---|---|---|
| `TOTAL - $604,500` | `total $` has always been a price heading. The `$` rides on the value, and only the reader that takes a label and a value with **no** separator retried a bare label with its value's marker. Split on the spaced hyphen, the pair went to the two readers that did not. | **A bare label is retried with its value's marker wherever a label meets its value** (`readLabelledValue`, `readVerticalPair`). The retry adds no spelling: `Land - $238,500` and `Build - $366,000` still resolve to nothing, and `TOTAL - 124.50m²` stays unread because `total m²` is not in the vocabulary. |
| `Lot 101 Watsons Reach Estate` | `readLotHeading` reads a lot line's tail only to refuse it, because a tail may be a street. | **A lot line's tail that names itself an estate is the estate** (`estateAfterLot`). It is `readInlineFieldName`'s own reading of those words, with all its guards, and it claims `development_name` only. `Lot 315 Central Boulevard` still claims nothing but its lot. |
| `PICO 8`, in a file named `… - PICO - …` | Filename corroboration needed every word of the line in the filename, and the filename carries only the design's family. | **The filename may name a design's family and the page its size** (`corroborateDesignFromFilename`). The family must be a *whole* segment of the filename and the last word a size (`8`, `10.5`, `20B`). Every other guard stands: an identity settled on the page, and exactly one candidate. `PICO 8` beside `PICO 10` reads neither. `PICO 2026` is not a size. `PICO SERIES` in the filename does not name the family `PICO`. |
| `Titles December 2026` | The other template writes `Titles - Titled Land`. This one drops the separator. | **A completion after its label is read only in the shape of a completion** (`readLeadingCompletion`): a month and a year, a quarter, early, mid or late in a year, or the titled state. `Titles are expected soon` claims nothing. |

**What the brochure does not state, and what the card therefore does not
show.** The page names no street and no suburb. `Lot 101, Watsons Reach Estate`
is the whole of where this brochure says the property is, and the card now
reads `Lot 101, Watsons Reach Estate · PICO 8`. Its text states no lot size
and no build size. The build size is printed only inside a *picture* of the
house's area schedule (`TOTAL: 124.50m² | 13.40sq` in a 231 × 166 raster),
which the text reader cannot see. The lot size is printed nowhere in the
document: a 300 dpi render of all six pages, read by Tesseract, finds no land
size. `Allotment up to 500m2` on page 3 is a condition in the foundation
specification, not this lot's size. Nothing here invents either figure. A
builder can state a figure their document does not (`manualStats.pure.ts`).
Reading the picture is §16.

A held-out fixture of the class went into the corpus before any code (case 2):
`heldout-picture-area-schedule`, which prints its area schedule as a picture.
Run through the unfixed reader, it read exactly what production read: the lot
and the counts. `builderStockLot101Geometry.spec.ts` asserts the reading against
the production page's own runs, each rule beside the twin it must refuse. One
existing assertion was renegotiated: `builderStockContinuedAddress.spec.ts` said
`Lot 4327 Jubilee Estate` without its comma names no estate. The comma only
ever decided the *next* line. The estate is the lot line's own statement, and
the suburb is still refused.

What this does not change, measured rather than assumed. Every PDF the corpus
generator writes (the 36 fixtures, plus the second file of the replacement fixture) was read by the reader at `HEAD` and by this
one, and the rows were compared with key order ignored. 36 of 37 read
identically; the one that differs is the new fixture.

The acceptance gate read 36 documents with 0 failures and 0 generative-model
calls. It reported 8 named limits: the seven from before, plus this fixture's
build size, which is the picture. On both routes the new fixture imports its
lot, estate, design, counts and price through the multi-isolate hand-off. The
isolate that parsed it decoded nothing, three successors decoded 175 to 205 ms
each, and its pictures settle. The CPU profile is flat within noise. The
document class totals 28,737 ms against 29,080. The worst single invocation is
5,007 ms against 5,093. No invocation both parsed and decoded.

Reader 16 is what reaches the stored document. The reader sweep re-reads it on
its fifteen-minute heartbeat, and the importer corrects its own row, so the
property keeps its id and its photographs.


## 16 · A build size the page prints only as a picture

**The defect (case 1 of §0), 23 September 2026.** After reader 16 (§15),
`Lot 101 - PICO - BROCHURE v002.pdf` reads its lot, estate, design, price and
titles, and its card still reads `HOME —`. The house's size is printed once, in
a 231 × 166 raster of its area schedule drawn across 3.3% of the property page:

    AREA SCHEDULE
    DWELLING:    90.11m²    9.70sq
    GARAGE:      22.59m²    2.43sq
    COURT:        4.69m²    0.50sq
    PORCH:        7.11m²    0.77sq
    TOTAL:      124.50m²   13.40sq

No text reader can see a picture, and the photograph rules refuse this one on
sight, correctly: it is below their pixel floor and their page-share floor
because it is not a photograph.

**Where it is read, and where it is not.** Reading a picture means decoding it,
and an isolate that parsed a PDF decodes none of its pictures
(`documentRead.pure.ts`; doc 54 §11). So the work is split:

1. **The isolate that parses the document** notes the *insets* on each page
   while it already walks the drawing instructions (`figureCandidatesFrom`).
   An inset is a DCT or raw-sample raster of 120 × 60 pixels to a megapixel,
   drawn across at most 8% of the page, of a table's proportions, drawn once on
   one page. Nothing is decoded. Once the rows are decided, it chooses which
   insets are worth reading (`figuresToRead`), and every condition is a
   refusal. There must be one property. Its row must state no building size,
   and the reader must not have disputed one. The inset must sit on a page that
   states the price. At most three are chosen, in reading order. The chosen
   insets travel in the hand-off as byte offsets into the document, with the
   SHA-256 of those bytes.
2. **A successor that never parsed the document** slices each inset out of the
   same bytes its hand-off is bound to and proves the digest. It wraps raw
   samples losslessly with the same `pictureFromStream` the photographs use,
   then decodes the picture and makes it readable (`figureRaster.pure.ts`). It
   recognises the picture with the same Tesseract and language model the scans
   use (`recogniseFigures`, one block of text at 300 dpi). This happens once
   per hand-off, in a crossing of its own before the kinds. The verdict (read,
   refused with a reason per inset, or recognition unavailable) is written to
   the import's checkpoint whatever it is. `MAX_PICTURE_CROSSINGS` is derived
   one higher for it.
3. **Whichever isolate finishes the import** applies the verdict. It can only
   *fill* the one property's building size, and only where the text left it
   empty (`withFigureApplied`).

**A linked brochure reads the same figure, in the one isolate it has.** The
acceptance gate's transport check caught this on the first full run. A
brochure linked by URL is re-fetched rather than stored, so no successor can
reproduce its run, and its pictures have always been decoded in the isolate
that read it. Route A (upload) read `129.59`; route B (the same bytes, linked)
left the building size empty. So a linked source reads its figures inline,
with the same `readFigures`. It does so only where they fit inside the ceiling
that invocation's other picture work already answers to (`mayReadFigures`:
the engine and each figure priced at about twice what was measured). A stored
document never reads one there, and one whose hand-off could not be written
finishes without its figures rather than decode beside its parse.

**Recognition is not believed; the picture's arithmetic is**
(`areaSchedulePicture.pure.ts`). Text a PDF states is exact, but recognition
misreads characters. So a total is taken only when the picture proves it with
statements it makes independently of that total:

- **Squares.** Australian builders print each area in square metres *and* in
  squares (one square is 9.290304 m²). The printed squares must *exactly*
  equal the total divided by 9.290304, rounded or cut off to the hundredth.
  There is no band either side.
- **Parts.** Every part must be legible, and the parts must sum to the total
  within what two printed decimals allow.

The schedule must also name a part of a dwelling, using the same vocabulary as
the text reader, imported rather than restated. A picture with two different
totals states none.

**What production said, read-only, from the stored document.** The product's
first preparation followed the synthetic fixture: enlarge to 300 dpi at the
printed size, then paint out the table's rules, which are what defeat
recognition on a small table. On the real picture it read
`TOTAL: 12450m* 13.40sq`: the total's decimal point, the smallest mark the
picture prints, was lost. The prover refused the result as implausible, so
nothing would have been written. The trace then read the real picture under 24
preparations. Almost all of them lost or spaced that point (`12450`,
`124 50`), and every one read the squares as `13.40`.

That measurement is the rule's last clause. **The squares place a decimal point
that recognition lost** (`areaProvedBySquares`). Placements of the same digits
differ by powers of ten, so at most one can equal the printed squares, and it is
taken only when it is the only one. The digits are never changed, a misread
digit still breaks the identity, and a figure with no point and no squares
proves nothing. Parts whose points were lost can never prove a total, because
they can agree at the wrong size (`901 + 225 + 47 + 72 = 1245`).

The exact identity has its own measurement. One preparation read `129.59` as
`129.50`, which is 13.94 squares against the printed 13.95. A hundredth's
tolerance would have taken it; the exact identity does not.

Replayed through the final prover, the 24 production readings gave 19 correct
readings of `124.50`, 5 refusals and 0 wrong values. The fixture's 24 gave 12
correct readings, 12 refusals and 0 wrong values. The product's own
preparation reads both pictures under both segmentation modes tried.

Run by the product's own `readFigures` over the stored production document
(read-only trace, 23 September 2026), the verdict is `read`, `124.50`, proved
by squares, in 453 ms. Recognition wrote `TOTAL: 12450m* 13.40sq`, and the
squares placed the point.

The acceptance gate read 36 documents with 0 failures, 7 named limits and 0
generative-model calls. The fixture's named limit is lifted: both routes now
import `129.59`, and the transport check holds. The isolate that parsed it
decoded nothing, the figure's own invocation spent 604 ms, and the kinds and
the attach followed in three more. The CPU profile is flat within noise on the
stress corpus: document class 28,765 ms against 28,737, and worst single
invocation 5,000 ms against 5,007. No invocation both parsed and decoded, and
the figure invocation costs 654 ms of the 3,000 ms ceiling.

**What it does not do.** It never speaks over a build size the text states. It
never settles a dispute, and never reads for a document with several
properties. It adds no generative model: recognition is Tesseract, and the only
judgement is arithmetic the picture itself prints. A schedule printed without
squares whose parts are not all legible is refused. So is an integer schedule
without squares, because a figure with no decimal point has no known size. Both
refusals are the safe direction.

Reader 17 is what reaches the stored document. The reader sweep re-reads it,
the successor reads its schedule, and the importer corrects its own row, so the
property keeps its id and its photographs. What production then showed about
the engine is §17.


## 17 · The engine that never started where it was asked

**The defect, measured the hour §16 shipped.** Reader 17 reached production at
12:59 on 23 September 2026. The reader sweep re-read the stored `Lot 101`
brochure at 13:00:14 and handed its one inset on, exactly as designed. The
successor that read the figure answered `recognition_unavailable` in 1,293 ms,
and nothing in the log said why. It was the same brochure the same code had
read as `124.50` under the Deno CLI in CI an hour earlier.

**Why every gate passed.** `tesseract.js` never runs its engine in the isolate
that calls it. Its Node build spawns a `worker_threads` Worker from a file
inside its npm package, and its browser build spawns a Web Worker. The
acceptance gate, the CPU profile and the reading trace all run under the Deno
CLI, which starts that worker. The hosted edge runtime did not, and
`openRecogniser` returned `null` without recording the error. The gate's
import map also resolved `tesseract.js` to its npm build, and nothing shows the
deploy honouring `supabase/functions/deno.json`, so production was probably
not even running the same build of the library. The check that fitted this
class was "the same bytes reach the engine the same way in the gate and in
production", and it was not being made.

**What replaced it.** The engine is one WebAssembly module and the loader
that drives it, which is what the worker runs. `ocr/engineDriver.ts` makes
the worker script's calls itself, in the isolate that asks:
- instantiate from bytes it is handed;
- write the model to `./eng.traineddata`;
- `Init(null, 'eng', 1)`;
- the worker's defaults, then the caller's parameters;
- `SetImageFile`, `Recognize`, `GetUTF8Text`.

The pieces are:

- **The engine** is `tesseract.js-core@5.1.1`'s SIMD + LSTM build, the one
  `tesseract.js` itself loads on every host that measured the figure reader.
  It is 2.86 MB, so it is an asset in the project's own storage, as the model
  is and for the model's measured reason: the module graph answered 413 at
  6.59 MB (`ocr/languageSource.pure.ts`). The deploy ships it
  (`scripts/ops/upload-ocr-language.mjs`). `ocr/engine.ts` fetches it and
  refuses it unless its SHA-256 is the pinned one (`ocr/engineSource.pure.ts`),
  because it is code the isolate will execute.
- **The loader** is vendored from the same package by
  `scripts/ocr/vendor-engine.mjs`, with two changes, each asserted to occur
  exactly once. Its host tests are replaced by `false`: Deno 2 defines
  `process`, so it chose Node and reached for `require('fs')`. Its
  CommonJS/AMD export is replaced by one ES export: the unit suite's runner
  defines `module`, and there that branch overwrote the module's own default
  export. Both changes make the loader behave the same whatever host runs it,
  which is the property whose absence this section is about.
- **Every refusal is logged with its step**, under phase `ocr_engine`:
  `engine_not_shipped`, `engine_unreachable`, `engine_not_measured`,
  `language_unreadable`, `engine_start_failed` or `engine_init_failed`. The
  scan pass's own opener now logs its error too. A capability that declines
  silently cannot be told apart from one that was never asked.

**Same engine, same text.** On the held-out picture, prepared as the product
prepares it, the in-process engine's text is byte-identical to
`tesseract.js`'s in both segmentation modes measured (psm 6 and psm 4). So
every §16 measurement stands, including the production picture's `124.50`.
Starting the engine takes 114–229 ms and recognition 316–360 ms. It adds about
90 MB of process memory against the runtime's ~256 MB ceiling. The engine's
own WebAssembly memory is 19 MB; most of the rest is compiled code.

**Proved where the old proof could not reach.**
`builderStockOcrEngineInProcess.spec.ts` runs the real engine in the ordinary
unit suite, under Node, with `Worker` replaced by a class that throws. It reads
the committed synthetic picture and the schedule reader proves `129.59` by its
squares. A deliberately wrong engine is refused by name with nothing thrown.
The digests are pinned everywhere they are named: the asset, the module, the
deploy script and the acceptance stack. The gate now fetches the engine from
the acceptance stack's storage by the production key, so the figure path it
runs is the one production runs.

**Measured.** The acceptance gate read 36 documents with 0 failures, 7 named
limits and 0 generative-model calls, the same as §16's run, with the engine
fetched from the acceptance stack's storage by the production key. Both routes
import `129.59`, and the isolate that parsed the fixture decoded nothing. The
figure's own invocation spent 489 ms, against 604 ms with the worker engine.
In the CPU profile the figure invocation costs 477 ms of the 3,000 ms ceiling,
against 654 ms before. The stress corpus, whose paths this change does not touch, measured 29,244 ms for the document class against 28,765, with a worst single invocation of 5,121 ms against 5,000 (the scanned-pages recognition, on the unchanged opener). Every document drifted by 2–8% in the same run, including decode-only ones, and one fell by 40%, so this is run-to-run variation on the machine. No invocation both parsed and decoded.

**What it deliberately does not change.** The scanned-page pass keeps its
worker-based opener. That is the opener that failed here, so on the hosted
runtime a scan must be declining for the same reason; that is inferred, not
observed, because no scan reached production in the logs that were read. It
now says so in the log when it does. Moving it to the in-process engine is
right.
It is not in this change because a scanned page costs about 3.1 s to
recognise, against the ~6.4 s shortest kill measured
(`importResumeBudget.pure.ts`). A figure costs about 0.35 s. That page cost
needs measuring on the hosted runtime before a builder's scan depends on it.

Reader 18 is what reaches the stored document. The sweep re-reads the one
upload version 17 could not finish, and every other document reads
byte-identically.

## 18 · The scanned page, recognised apart from the parse

**The defect, observed this time rather than inferred.** §17 inferred that a
scan was declining for the figure's reason. On 23 September 2026 an isolated
production proof asked (`scripts/ops/stock-scan-proof.mjs`, run 35877700148):
a fully scanned brochure uploaded through the portal's own path was refused
`pdf_no_text_layer` in 10,682 ms, and the one line the recogniser wrote was
`ocr engine unavailable { engine: "tesseract.js", detail: "Not implemented:
Worker.prototype.constructor" }`. The deployed functions resolve no import map
(`import_map: false` on all 27), so production loads `tesseract.js` from esm.sh
and the runtime refuses the worker it asks for. None of the 51 uploads in
production carried a recognised page: no scan had ever been read there.

**Why the gate could not see it, and what it does now.** The Deno CLI starts
workers. `scripts/stock-acceptance/hostedRuntime.ts` refuses both kinds a
library can ask for, the web `Worker` and `node:worker_threads`, with the
runtime's own words. It is imported first by the gate, the CPU profile and the
latency script. The library is not replaced, so an old path run through the gate
fails in the library's own constructor, the way it fails in production. A
worker requested by anything fails the gate.

**The fixture came first.** `heldout-scanned-brochure` is three pages of pixels
with the facts spread across all three: identity and price on the cover,
counts and areas on the specification sheet, nothing on the third. Its bytes
are the production proof's (`scripts/ops/fixtures/`). On the old path under
the hosted refusal the gate failed with 10 failures and 18 refused workers:
- the brochure produced 0 properties;
- `mixed-scan-and-text` lost all five fields on its scanned page;
- the 8l hand-off failed;
- `scanned-no-text-layer` and `heldout-mixed-scan-multi` produced 0
  properties, hidden behind their named limits. A `known_limit` can hide a
  regression unrelated to the limit it names.

**What changed.**
1. **The engine.** `recogniseScannedPages` opens `openInProcessRecogniser`,
   the figure reader's engine and model, already pinned and deployed. It sets
   nothing over the library's own worker defaults, exactly as before.
   `openRecogniser` and the esm.sh import are deleted.
2. **Where it runs.** The engine's whole cost is now in the isolate that asks,
   so that isolate must never be the one that parsed the PDF.
   `extractPdfPagePhoto` is split into its two halves:
   - `locatePdfPagePhoto` reads the page and decides which raster it
     presents, decoding nothing;
   - `photoAtLocation` makes the picture from the stream alone.

   The parsing isolate locates every owed page and records each stream's
   offsets and SHA-256 in the checkpoint (`ocr.rasters`,
   `ocr/scanRaster.pure.ts`). Each owed page is then recognised by an isolate
   that parses nothing. The document is read by one that recognises nothing.
   A stored scan of N pages crosses N + 1 times before its pictures are
   handed on. Eight pages is 9 of the 10 allowed crossings. The one-page
   allowance and the crossing bound are unchanged.
3. **Never twice.** A recognition isolate marks its page `begun` before the
   engine is asked. A mark that is still there when the next isolate arrives
   means the worker died on the page. That page is settled as `lost` and not
   asked again, and recognition stops for the attempt. On the hosted runtime,
   asking again means dying again, and restarting a dead import is limited to
   three recoveries. A fresh attempt forgets what was true of an attempt:
   locations, marks, losses, availability. It keeps what is true of the page:
   the recognised text and page refusals.
4. **Linked sources.** They cannot be continued (`resumableFromStoredBytes`),
   so they still recognise where they parse, one page deep, as before. The
   gate declares this per document (`linked_limit`). It holds the linked
   read to "never a wrong value" and reports what it left unread on every
   run.
5. **The image settler** reads the pages the import recognised (from the
   checkpoint, bound to the same digest) and never recognises.

**Same text.** The two engines were compared on the same rasters: 14 pages
across 6 documents, 250–620 ms a sparse page and 4.1–4.7 s a dense one, all
byte-identical. `builderStockScanRecognisedApart.spec.ts` pins the old
library's exact text for the fixture's three pages and runs the in-process
engine against it with every worker refused. It also proves the two halves
make byte-identical pictures on a real scan and on a flattened page.

Over the whole corpus the gate was run twice more: once on the old engine
with workers allowed, once on the new code. All 37 documents produced
identical route-A readings (398 fields, the same verdicts and strategies).

**Measured.**
- **Gate:** 37 documents, 0 failures, 8 named limits (the linked read is the
  eighth), 0 generative-model calls, 0 workers requested.
- **The held-out brochure** takes 9 invocations:
  - 1 parses twice and recognises nothing;
  - 2–4 each recognise one page and parse nothing;
  - 5 reads it;
  - the rest decode pictures.

  All eleven fields are read.
- **8l, the stress scan:** 5 pages located by the parse and each recognised
  exactly once, in 12 crossings.
- **8n:** a worker killed on page 2 leaves page 2 unrecognised and settled.
  The import completes with page 1's property, and nothing is invented.
- **CPU profile, stress corpus (3 iterations, median):**
  - 0 invocations both parsed and recognised, and 0 parsed and decoded;
  - never more than one page an invocation;
  - worst single invocation 4,646 ms, against 5,121;
  - document class 24,163 ms, against 29,244;
  - `stress-scanned-pages`: 5 document parses, against 20;
  - `stress-many-images`: 5, against 28.

**In production, 23 September 2026.** The merge deployed `builder-portal-stock`
v646 and `builder-stock-image-settler` v648, and all 27 functions were
refreshed. The deploy read both OCR assets back at their pinned SHA-256.
`stock-scan-proof` in `read` mode then imported the fixture through the
portal's own path, into an organisation of its own that it deleted afterwards
(production-rollout run 35889548999, 18 of 18):
- The isolate that parsed the document recognised nothing. Each of the next
  three recognised one page, in 1,780, 776 and 1,246 ms of recognition.
- All three pages were recognised exactly once. The property was read field
  for field, with one image row.
- All ten invocations answered 200, and none was recovered. The longest took
  12.6 s of wall clock.
- The product completed the upload by itself 59.8 s after accepting it, and
  nothing moved in the 150 s after that.
- No model-budget reservation was made.

The first `read` run (35888580827) passed 16 of 17. Its step 7 took its
snapshot at `enriching`, and the settler then completed the upload 1.2 s
later, as designed. The proof now waits for the product's last word, a rule
`stock-import-proof.mjs` already carried.

**What remains.** A dense page costs 4.1–4.7 s of recognition on this machine,
and a page is the unit nothing can divide. On the hosted runtime the fixture's
sparse pages took 776–2,297 ms each, engine opening included, across both
runs. A dense page has not been measured there. A page whose recognition alone
exceeds what one hosted invocation may spend will be killed once. It is then
settled as lost, and the import finishes with every page read before it.

## 19 · Four brochures printed in large type what no reader took (reader 19)

**The defect (case 1 of §0), 24 September 2026.** `LOT 326 - NEX 20 -
BROCHURE.pdf` imported with its lot, its estate and its land size, and nothing
else a buyer looks for first. No price, no street, no suburb, no build size.
The report was "every new PDF", so the whole population was read before any
code was written. Only three stored brochures still have their bytes, but
every import keeps its own record of each line it set aside and where it was
drawn (`error_detail.deterministic_ignored` / `deterministic_placement`). That
record exists even for uploads whose files were deleted. Read across all
sixteen templates this builder has uploaded, it names four layouts that still
dropped a printed fact at reader 18:

| brochure | printed, and set aside | why no rule read it |
|---|---|---|
| `LOT 326`, `LOT 324` (NEX 20) | `$861,700` over `PACKAGE PRICE` | every pairing reads a label *over* its value |
| the same | `Lot 326 Dapple Avenue` / `Palomino Estate,` / `Armstrong Creek` | a street line with no locality directly under it read nothing |
| `LOT 324` | the same frame, with the price table's two rows between the estate and the suburb | `unitBelow` stops after two row bands, whatever column they are in |
| `LOT 4544 Riverwalk Estate` (ENZO 10.5) | `Wyndham Vale`, page 1, row 6 | its lot line has no trailing comma, and the comma was the only evidence `readContinuedAddress` accepted |
| `Lot 37 - Miami 190` (PROPLAUNCH) | `$1,327,407`, x 66, three rows under its tracked caption at x 43 | out of column, and other columns' rows between |

**The build size was never out of reach, and that is the finding worth
keeping.** The reading trace of `LOT 326` showed its area schedule as a
picture that "says, at its own pixels: AREA SCHEDULE", with its rows apparently
drawn beside it. The first plan was to render them. Traced with the product's
*own* decoder (`pictureFromStream` → `decodeFullRaster`), the same 690 × 440
picture reads all four rows. The total, `178.23`, is proved by its parts
(151.22 + 23.93 + 3.08). The figure reader (§16) was simply never asked: it
reads only on a page that states the price, and this page's price was the one
fact the reader missed. Reading the price is what makes the size readable. **A
trace of a picture through a decoder the product does not use is evidence
about that decoder.**

**What reads them now.** Each rule is a refusal unless every condition holds,
and each is asked only where the existing readers found nothing:

- **A figure over its caption** (`readCaptionedFigure`). A lone figure (a
  currency amount for the price, an area with its unit for a size) sits
  directly over a caption that resolves wholly to price, land or build.
  `standsAloneAsCaption` refuses a figure with a label before it on its own
  row, and a caption with a figure after it on its own row. That guard was
  added after the first version, run over the corpus before anything shipped,
  read `$389,500` as the package price on three ENZO-style pages. There,
  `Build - $389,500` over `Package Price - $801,500` splits at its separators
  into units that share their row's x.
- **The lot's own frame** (`readLotAddressBlock`). A line opening with a lot,
  then either a street (never one of the words an estate is also named with)
  or a development that names itself (`… Estate`). Directly under it comes the
  estate and then the locality, or the locality alone. The lot is what makes a
  bare suburb safe to read, because a sales office has a street number and
  never a lot. The place is refused where it repeats the estate, the settled
  design, or a filename segment other than the lot's (`LOT 48 - EMBER - FLYER`).
- **The frame's next line** (`unitBelowInColumn`). The next line *in the same
  column*, however many other columns' rows fall between, within twice the
  frame's own type size. It is asked only after `unitBelow` and only by the
  frame reader. Layout cells now carry their type size, and every laid-out
  page keeps its row baselines beside its units.
- **The page's one price** (`PACKAGE_PRICE_CAPTION`). A page whose words say it
  carries the price, and which prints exactly one sum of money that no label,
  caption or pairing accounted for, of at least $50,000. A second unaccounted
  figure on that page means the page names no price.
- **Type painted as shapes** (`pdfOutlineFigures.pure.ts`). An exporter's
  "convert text to curves" leaves a schedule's rows as filled paths. The parse
  isolate notes blocks of letter-sized filled shapes, set in at least two rows,
  on the first three pages. It carries them as quantised polygons in the
  hand-off; nothing is drawn there. The figure successor draws them black on
  white with a supersampled scanline fill, then recognises them with the same
  engine and the same schedule proofs as a picture. No production document is
  known to need this yet. It is here because the class exists, and it costs
  the parse about 0.3 ms a document on the corpus (182 → 197 ms of discovery
  across 51 documents; worst +8 ms, on the one page that has outlines). A
  crossing makes at most four recognitions, pictures and blocks together.

**Held out first.** Each layout entered the corpus before its code, and each
fails against the reader in `main`. The fixtures are:
`heldout-dual-key-price-caption-schedule-picture`,
`heldout-dual-key-address-across-columns`,
`heldout-icon-row-estate-no-comma-locality`,
`heldout-package-price-apart-from-its-caption` and
`heldout-schedule-painted-as-outlines`. The package fixture is a
*reconstruction* from the import's placement record, and says so. Across the
whole corpus, 37 of 42 documents read identically to `main` (38 of 43 with
the copy the gate writes for its "read again" case), as do all 8 stress
documents. The five that change are those fixtures. One existing
expectation was replaced rather than kept: `builderStockContinuedAddress`'s
"no comma, no suburb". The `LOT 4544` record is the counter-example, and its
twins that still refuse (no lot, an estate's own word, the design) are
asserted in its place.

**On the real bytes, before shipping.** Traced from this branch over the stored
documents (production-rollout runs 35950895655 and 35951615593, read-only):

- `LOT 326` reads price `$861,700`, street `Dapple Avenue`, suburb
  `Armstrong Creek` and estate `Palomino Estate`. Its schedule reads `178.23`,
  proved by parts.
- `LOT 324` reads the same frame past the price table, price `$863,850`, and
  the same `178.23`.
- `LOT 717` reads byte-identically to reader 18.

**The gate found one more thing, and it was not this change.** The first two
acceptance runs of this branch failed one invariant: *the decode that settles
picture roles is priced before it begins*. The step that attaches
`stress-multi-property`'s eight pictures spent 3,001 ms, then 3,162 ms,
against a ceiling of 3,000. Unmodified `main`, on the same machine, failed the
same invariant at 3,034 ms. The day before, on a faster machine, the step had
cost 1,826-2,019 ms. Instrumented, the step stores each picture in about
10 ms, and its three display judgements cost 750-1,000 ms each. Those were
bounded by a count (`DECODES_PER_INVOCATION`) that does not know how long a
decode takes. Each judgement is now priced from the picture's header before it
begins and must fit inside the ceiling, the rule the role decode already
answers to (`mayJudgeEligibility`, doc 54 §11.6). No limit was raised. With
that, the gate reads **42 documents, 0 failures**, the same 8 named limits as
`main`, 0 generative-model calls attempted and 0 workers requested, and the
step's worst is 2,177 ms. The settler's outcomes match `main`'s run for run.
The CPU profile of the eight stress documents, on the same machine, three runs
each, matches `main` within noise: the document class 35.3 s against 35.1 s,
the raster class 16.4 s against 17.0 s, and the multi-property sheet's
attaching step 2,699 ms against 2,904 ms. No invocation parsed a document and
decoded or recognised anything, and none asked for a worker. The one
invocation past the ceiling is a scanned page's recognition, about 6.6 s on
this machine on both. That is the known step the ceiling allows one of, and
this change does not touch it.

**What it does not do.** The NEX 20 template prints no bedroom, bathroom or
car count anywhere: it is a dual-key home, and its plan's room names are not
counts. It prints no state and no postcode either. Those stay empty, and the
builder can state them on the card (§§ on stated figures and stated address).
Nothing here infers a state from a suburb: a place's name alone does not say
which state it is in, and a guess on a client's card is worse than a blank.

**In production.** Merged as #101 and deployed at 04:36 UTC on 24 September
2026 (`builder-portal-stock` v653, `builder-stock-image-settler` v655, both
with new bundle digests). The 04:45 sweep heartbeat re-read `LOT 326` by
itself in four ticks, each in its own isolate. The parse spent 1,046 ms and
handed on, the figure successor recognised the schedule picture in 1,839 ms,
the picture kinds were learned, and the attach updated the property. Every
invocation answered 200, and the upload settled `complete` at 04:46:07. The
card now reads `$861,700`, `Dapple Avenue`, `Armstrong Creek`, `Palomino
Estate`, 350 m² of land and a 178.23 m² house, and it is stamped reader 19.

## 20 · A size printed in another unit is that size, or it is absent (reader 20)

**Found by probing, not by a customer's document.** Once the four layouts above
were read, the question was what else a new brochure could print that this
reader would get wrong. The answer was the unit. `coerceNumber` takes the first
number in a cell and nothing else, so:

| printed | became | is |
|---|---|---|
| `House Size` over `21.5 squares` | a 21.5 m² house | 199.74 m² |
| `Land Size` over `1.2 acres` | a 1.2 m² block | 4,856.23 m² |
| `Land Size` over `0.5 acres` | nothing (refused as under 1 m²) | 2,023.43 m² |
| `House Size 28.6 squares`, on one line | nothing, with no record | 265.70 m² |
| `HOUSE` over `24.6 sq` | the house's DESIGN, then a design conflict that refused the whole brochure | 228.54 m² |

No stored size in production carries a unit (every one is a bare number), so
no existing card was wrong. The next brochure written in squares would have
been.

**One rule, asked in three places** (`areaUnits.pure.ts`):

- **Every conversion is a definition.** A square is 100 square feet, a square
  foot is 0.09290304 m², a hectare 10,000 m² and an acre 4,046.8564224 m².
- **Where the unit and the field cannot both be true, the size is absent.** A
  house in hectares or acres, a block in squares, or "squares" of 100 or more
  (929 m², not a dwelling) is refused by name
  (`area_unit_does_not_measure_this`), never guessed.
- **`sq` alone is squares on a house and square metres on land.** `21.5 sq` is
  the Australian building convention. Land is not sold in squares, and a
  trailing `sq` there is `sqm` cut short, which is how it was always read.

The normaliser converts with it, so every source (a brochure, a sheet, a
Notion page, a web page) stores square metres. The typed gate judges a
converting unit by what it measures, so half an acre is a block. Every other
value takes exactly the path it always did. The inline reader knows the unit
words, taking `ft`, `feet` and `metres` only after `sq` or `square`, because
`2000 feet` alone is a length and never an area. And a heading over a figure
in any area unit is composed as an area heading, so a measurement is never a
name.

**And the ways a brochure sets a specification line.** The same probing,
with the forms builders use, found four more lines that lost a printed fact.
In each case the reading still reported `complete`:

| printed | became | now |
|---|---|---|
| `Beds: 4 Baths: 2 Cars: 2` | one pair, a bedroom count of "4 Baths: 2 Cars: 2", declined, so all three were lost | 4, 2, 2 |
| `Land: 448m² \| Frontage: 14m` | the same, so the land was lost | 448 m² |
| `Land Size 512m²  Frontage 16m  Depth 32m` | refused whole, because a frontage is not stored | 512 m² |
| `Home 24.6 sq` | unread (the heading was the design) | 228.54 m² |
| `House: 220m²` | the DESIGN "220m²"; beside `Home Design: Aurora 25`, a conflict that refused the whole brochure | 220 m², and the design stands |

- **Several pairs on one line are each read** (`readLabelledPairs`). Every
  colon must end a label this vocabulary knows, found as the longest run of
  words before it, and the value between two labels is what is left, less a
  separator. A single pair stays `readLabelledValue`'s, and a line where a
  colon ends no label (a time, a web address, a ratio) is not read here at
  all.
- **A frontage is stated and not stored.** `Frontage`, `Depth`, `Width` and
  `Length` pairs are consumed and claim nothing, so the land beside them is
  read. A line of nothing else still reads as nothing.
- **A heading over a measurement is composed with its unit** in the labelled
  reader too, as the pairing readers always did. A figure in squares, square
  feet, hectares or acres composes it just as `m²` does. A bare `m` never
  does, because it is also a length.
- **A figure with its unit or its currency is never a name**
  (`a_measurement_is_not_a_name`), asked at the one gate every claim passes
  through, for a design, an estate, a suburb and a street.

Three phrasings stay unread on purpose, by rules other modules already made:
`from $799,000` (a from-price is not the package price), `Living 220m2`
(`living` is a room count on some sheets) and `Total Area` (the total area
of what?).

**Held out first.** Four fixtures describe these:
`heldout-sizes-in-squares-and-acres`, `heldout-house-heading-over-squares`,
`heldout-spec-pairs-on-one-line` and `heldout-frontage-beside-the-land`.
Each fails against reader 19. Two lost their sizes, and two were refused
whole as `conflicting_values:house_design`. Against reader 19's reader and
normaliser together, 51 of the 55 corpus and stress documents read
identically, and the four that change are these.

## 21 · The ways a brochure phrases a fact, found before a customer found them (reader 21)

**Probed, 24 September 2026.** Each earlier section began with a customer's
document that had lost something. This one began with 130 phrasings put through
the reader on purpose — the ways Australian brochures set an address, a price,
a count and a size — so the next document does not have to be the one that
finds the gap. Three kinds of failure came back, and the first is the one the
builder sees as "the PDF has no property information".

**Four address layouts imported nothing.** The line naming the property was the
line nobody read, so the reading had no identity and no property was found:

| printed | why nothing read it | now |
|---|---|---|
| `LOT 214 Kingfisher Road, Clyde North, VIC, 3978` | the last comma segment was asked to be the whole locality, and it was only the postcode | lot, street, suburb, state, postcode |
| `Lot 58 \| Wren Street \| Box Hill NSW 2765` | only a comma separated the parts of an address | the same |
| `Lot 903 Fairwater Drive Tarneit VIC 3029` | no comma, so one segment | the same |
| `Lot 7 (No. 15) Banksia Way` over `Baldivis Western Australia 6171` | a digit in the lot's tail, and only abbreviated states | the same, street `15 Banksia Way` |

- **A locality's commas are punctuation** (`localityTokens`,
  `foldLocalitySegments`): the postcode is folded back onto its state and the
  state onto the place before it, only while something is left in front to be
  the street or the lot.
- **A rule or a bullet separates the parts as a comma does.**
- **An address with no comma is split only where the page leaves one answer**
  (`readUnpunctuatedAddress`). The street ends at its last type word that is
  unambiguously a street type (`Road`, `Drive`, never `Grove`, `Glen` or `St`,
  which also begin suburbs), the street holds exactly one such word, and the
  suburb after it holds no street type at all. `Smith Street Glen Waverley`
  reads; `Smith Street Lane Cove` and `Smith St Albans` do not split, and read
  the lot, state and postcode alone: thinner, never wrong.
- **A state spelled out is the state only where the postcode agrees**
  (`stateAtEnd`, Australia Post's ranges). `Mount Victoria 2786` is in New South
  Wales, so it is never read as a suburb called `Mount` in Victoria.
- **A street number in brackets after the lot is the street's**
  (`LOT_WITH_STREET_NUMBER`).

Three more address layouts lost their street or locality with the reading still
complete: the lot, the street and the locality on three lines (`LOT 47` /
`Heron Court` / `Mount Barker SA 5251`), a whole address under a label
(`Address: Lot 33 Ridgeline Crescent, Ripley QLD 4306`, which was stored whole
as the street), and a place and postcode with no state (`Clyde North 3978`).
Each is read now, and a street called `The Promenade` (the article is its name)
and a stage designation beside the estate (`Seabreeze Estate - Stage 3`, which
stood the reading down as a project nobody took) are read as the page means
them.

**And a landscape page stored rotated read nothing at all.** A landscape
brochure is often stored as a portrait page with `/Rotate 90`, its text drawn
turned a quarter so the page reads upright in a viewer. The flattened text is
perfect. The positioned layout took each run's coordinates as drawn, so every
line landed on one row and merged into one cell with no spaces
(`LOT 64 Currawong StreetBox Hill NSW 2765…`), and the reading found no field.
A page whose text is mostly not upright now contributes no positioned runs
(`mostlyUpright` in `pdfTextLayout.ts`), so it is read as the flattened lines
it already has, as every page the layout could not read always was. An upright
page is byte-for-byte unchanged, and so is an upright page with one sideways
caption: the test counts characters.

**A townhouse was addressed by nothing.** `5/12 Kestrel Street, Box Hill NSW
2765` is how an Australian unit or townhouse is addressed, and a street number
had to be one figure, so the line naming the property imported nothing.
`Unit 5, 12 Kestrel Street`, `Townhouse 5/12 Kestrel Street` (on one line or
over its locality), a range of numbers (`12-14 Kestrel Street`) and a street
ending in a direction (`Lot 118 Main Road East`) were the same gap. Each is read
now, and the unit is read from the address itself (`unitOfStreet`,
`unitOfStreetLine`).

A flyer headed `TOWNHOUSE 3` over `18 Swift Street, Marsden Park NSW 2765` did
worse than lose the unit: the heading was stored as the house *design*, because
the filename names the same words. The unit is the one thing that says which
townhouse at number 18 this is. It is read as the unit now, on three terms:

- **only where the document names one unit** — a site plan labelling eight
  townhouses names none of them as this one, and reads exactly as before;
- **only beside a street** — a unit says which dwelling at an address, and a
  bare `Townhouse 28` on a page with no street is as likely a design's name;
- **never over a unit the document already holds** — `Unit: 5` labelled, or
  `5/12` in the address, stands, the heading is not taken, and nothing that
  imported stops importing.

`Villa` and `Residence` are not unit words here, because builders name designs
with them. Taken or not, a unit heading is never a candidate for a design.

**And reading a townhouse again made a second one.** The gate reads every
document a second time from its own upload, as "Read again" and the reader
sweep do, and both townhouse fixtures came back as two properties. A re-read
finds the row it is correcting by the document's own anchor, which a PDF
record gets only through a picture, or by the lot, scoped to the same upload.
A townhouse known by its unit and its street, with no picture, no estate and
no lot, had neither, so nothing could find the row it already was and the
re-read inserted a copy. The sweep re-reads every stored upload at every reader
version, so each upgrade would have added one more copy of every such
property. A row with no lot is now keyed, within its own upload, by its unit
at its street, or by its street alone (`ownRowKey`), and on that key alone two
stated suburbs that disagree are held apart, because two streets of one name
are ordinary. A row that states a lot is keyed exactly as before.

**And a block given as its frontage by its depth was stored as its frontage.**
`Land Size: 12.5m x 36m` read 12.5 m², on every source: the typed gate refused
the shape, but the page's units kept the value and the normaliser took its first
figure. Two lengths state a block's shape and no area, so no land size is stored
from them (`TWO_LENGTHS` in `areaUnits.pure.ts`), while `450m² (15m x 30m)` is
450, which the gate used to refuse as out of range. `Price $812,000 inc GST`,
`Price $812,000 fixed` and `Land Size 450 m2.` each set their figure aside over
the words after it, and are read.

**Two prices were wrong on every source.** `$829k` was stored as $829 and
`$1.15M` as $1.15: the digits were read and the multiplier dropped, in the
normaliser that every source goes through. `coerceMoney` reads `k`, `m` and
`million` by definition and only straight after the first figure, reads a space
set as the thousands separator (`$799 000`), and a price below $10,000 or above
$100 million is refused rather than printed. No stored price carries a
multiplier and none is outside those bounds (the lowest is $596,500), so no
card reads differently for this.

**And a design was wrong on six stress-corpus covers.** Each sets the locality
line directly over a `Home Design` row whose design is drawn beside the
heading. The caption reading took the locality upwards as the name over its
caption and spent the heading, so every one stored `Officer VIC 3809` or
similar as the design, and the design the row states was never read. The stress
corpus asserts lot numbers only, so nothing reported it. Two rules close it: a
caption with a value beside it on its own row is that value's label
(`labelsItsOwnRow`), and a locality with its state and postcode is never a
design or an estate (`a_locality_is_not_a_name`). No stored design or estate is
shaped like a locality.

**The rest lost one printed fact:**

| printed | now |
|---|---|
| `Fixed Price House & Land $829k`, `Turnkey Package $1.15M`, `Total Package Price $799,000` | the price (headings up to six words where the value carries its `$`) |
| `Land Price $415,000  House Price $402,900  Total $817,900` | $817,900 (a component is stated, never stored, and never costs the total) |
| `Land $350,000 + House $449,000 = $799,000` | $799,000, only because the parts add up to it |
| `4 Bed + Study \| 2 Bath \| 2 Living \| Double Garage` | 4, 2, 2 (rooms this product does not store are recognised, a double garage is two cars by definition) |
| `4 BR 2 BA 2 CAR`, `4 x Bedrooms`, `4 Bedroom Home` | the counts |
| `Allotment 512m² (approx)`, `Lot Area 450m2`, `450m² Lot`, `Land Size approx. 450m²` | the land |
| `Dwelling Size 231m²`, `231m² Home` | the house |

`parseBedBathCar` learned the same count words, so a Sheets or Notion
`Configuration` cell reads them too. A word it does not name (`2 Living`,
`1 Study`) is still not a count, and every shape it read before reads the same.

**What stays unread, on purpose.** `Double Garage` alone on a line (a floor plan
names its garage that way, and a dual-key home has two). A singular count label
(`Bed 3` is the third bedroom). An ensuite beside a bath count (the bathrooms
would be stated in two parts). An all-capitals suburb is stored as the page
prints it. `Floorplan:` and `House Type:` stay the vocabulary's other meanings
(a link to a drawing, and the kind of dwelling), and `Home:` is not a design
heading, because "Your Dream Home" would become one. A suburb with no state and
no postcode after an unpunctuated street stays unread, because nothing marks
where the street ends.

**The negative half is pinned as firmly as the positive.** 38 lines that must
still read nothing — a builder's head office, `12 Months Warranty Tarneit VIC
3029`, `Deposit $10,000`, a sum that does not add up, `From $699,000`, `Bed 3`,
`Double Storey`, `Spring 2026`, `The Hampton` and the rest — are appended to a
complete brochure in `builderStockPhrasingMatrix.spec.ts`, and each must leave
every field as it was and the reading complete.

**Held out first.** Seventeen fixtures describe these:
`heldout-address-locality-set-apart-by-commas`,
`heldout-address-set-apart-by-rules`, `heldout-address-with-no-comma`,
`heldout-address-lot-street-locality-on-three-lines`,
`heldout-address-state-spelled-out-and-number-bracketed`,
`heldout-address-under-its-own-label`,
`heldout-street-named-the-promenade-and-a-staged-estate`,
`heldout-price-in-thousands-under-a-fixed-price-heading`,
`heldout-component-prices-beside-the-total`,
`heldout-counts-beside-rooms-not-stored`,
`heldout-sizes-under-other-headings-and-a-price-in-millions`,
`heldout-design-beside-its-heading-under-the-locality`,
`heldout-landscape-page-stored-rotated`,
`heldout-land-given-as-frontage-by-depth`,
`heldout-townhouse-unit-over-street-number`,
`heldout-street-with-a-direction-and-a-price-with-its-gst` and
`heldout-townhouse-named-above-its-street`, each asserted to read
COMPLETELY, beside the three count and price fixtures written first. Each fails
against reader 20. Against reader 20's layout, reader and normaliser together,
48 of the 75 corpus and stress documents read identically. The 27 that change
are the twenty held-out fixtures, the two-column page, which now imports its
two properties where it imported none, and the six stress covers above.

**The two-column page's named limit moved.** It was refused over its shared
heading `RELEASE 6`. A release designation is now recognised, and both columns
read their lot, locality, land and price. What is left is its design and counts,
printed with no label and no icons, which are never read by rule.

## 22 · A lot, its street and its locality, however they are set out (reader 22)

**Found 24 September 2026, the day reader 21 shipped, by sweeping it against
reader 20.** Reader 21 made a locality's commas punctuation (`Clyde North, VIC,
3978` is one place), and under a lot set as a heading of its own that turned
the most ordinary flyer there is into a second address:

| printed | reader 20 | reader 21 | now |
|---|---|---|---|
| `LOT 572` over `Egret Street, Marsden Park NSW 2765` | lot, street, suburb, state, postcode | the lot only | the same as reader 20 |
| `LOT 745` over `Wren Street Riverstone NSW 2765` | the lot only | suburb `Wren Street Riverstone` | street `Wren Street`, suburb `Riverstone` |
| `Lot 318` over `Sandpiper Estate, Oran Park NSW 2570` | the estate, no locality | suburb `Sandpiper Estate Oran Park` | estate `Sandpiper Estate`, suburb `Oran Park` |

The heading paired itself with the line beneath it, the locality reader took
everything before the state as the suburb, and the result was either a suburb
no register has or, where the whole-document guard counted it as a second
address, no address at all. Swept against the values the page means, **528
lot-heading layouts read 45 wrong and lost 63 at reader 21, and 0 and 0 now.**

Two rules close it:

- **A locality under a lot is a place, never a street or an estate run into
  one** (`runsOnFromAStreet`). A comma between the place's own words, or a
  street type or `Estate` with a word on each side of it, says the line holds
  more than a place. A suburb that begins or ends in such a word is untouched
  (`Lane Cove`, `Glen Waverley`, `Wattle Grove`, `Marsden Park`), and so is
  one whose middle word merely looks like one (`Holland Park West`, `Box Hill
  North`, `Lane Cove West`).
- **The line under a bare lot is the rest of one address.** Set on one line,
  `LOT 572 Egret Street, Marsden Park NSW 2765` has always been read by the
  one-line reader, and set as a heading over the rest it is the same address,
  so it is read the same way. It is joined to the lot's *designation*, never its
  line, so a heading closed by a dash (`LOT 572 -`) lends the street no dash.

**And seven more shapes, four of them wrong or lost at every reader.** Sweeping
a lot or a street over every way a locality is set under it (1,116 more
layouts) found them:

| printed | reader 20 | reader 21 | now |
|---|---|---|---|
| `Lot 229 Currawong Drive` over `Kingfisher Estate Clyde North VIC 3978` | suburb `Kingfisher Estate Clyde North` | the same | estate and suburb |
| `Lot 814 Brolga Street` over `Jacana Estate, Wyndham Vale` | the estate only | the same | street, estate and suburb, no state invented |
| `LOT 537 \| Magpie Crescent` | street `\| Magpie Crescent` | the same | street `Magpie Crescent` |
| `Lot 906, 14 Heath Street` over `Riverstone NSW 2765` | **nothing imported** | **nothing imported** | lot, street, suburb, state, postcode |
| `LOT 692` / `Tern Street` / `Osprey Estate Point Cook VIC 3030` and a price | **nothing imported** | suburb `Osprey Estate Point Cook` | street, estate and suburb |
| `LOT 463 - Plover Avenue` over `Lorikeet Estate, Tarneit VIC 3029` | the estate only | suburb `Lorikeet Estate Tarneit` | street, estate and suburb |
| `18 Egret Street` over `NSW 2765` | **nothing imported** | suburb `NSW` | street, state and postcode |

- **An estate beside its suburb is the estate and the suburb**
  (`readEstateAndLocality`). The one-line reader already splits
  `Palomino Estate, Armstrong Creek VIC 3217` at its comma and is asked first.
  The shapes it does not read are split at the word **`Estate` and nowhere
  else**, however the line is punctuated around it (`Kingfisher Estate Clyde
  North, VIC 3978`, `Kingfisher Estate | Clyde North VIC 3978`): it is the one
  development word no Australian locality is named with, while `Park`,
  `Grove`, `Heights`, `Waters` and `Rise` all are. A place with no state after
  an estate is read only inside a lot's own block, as `Jacana Estate,` over
  `Wyndham Vale` on two lines always has been.
- **The mark between a lot and its street is neither** (`LOT_STREET_SEPARATOR`).
- **A street number after a lot is the street's.** The name after a lot had to
  be words alone, so `Lot 906, 14 Heath Street` was no street, the locality
  under it was a line nothing read, and the document stood down. It is read by
  the numbered street's own rule now, exactly as the one-line reader reads
  `Lot 906, 14 Heath Street, Riverstone NSW 2765`.
- **A dashed lot line keeps its street** (`streetBesideLot`). A spaced dash
  splits `LOT 463 - Plover Avenue` into the lot and the street. On a flattened
  page each becomes a line and the street is the line under the lot; with
  positions they share the lot's *row*, and the line under the lot was the line
  under the street, so the street was skipped. The rest of the lot's own line
  is its street now, only where it reads as one: `LOT 88 - HARLOW 21` is a lot
  and a design, exactly as before.
- **A state is never a suburb** (`namesOnlyAState`). `18 Egret Street` over
  `NSW 2765` stored the suburb `NSW`. It is the state and the postcode now,
  and no suburb (`readStateAndPostcode`); a state spelled out is taken only
  where the postcode agrees, so `Victoria 2029` reads neither.

**What is still not read, and why.** A street over a line that names no place
(`Harlow 21`, `Spring 2026`, a count line) is not claimed as an address, as
before, because a street alone could be anyone's. A suburb and a region after a
comma (`Armstrong Creek, Geelong VIC 3217`) reads no locality rather than the
suburb `Armstrong Creek Geelong`. And **an estate named with a word that also
names suburbs, run into its suburb with no comma** (`Palomino Park Armstrong
Creek VIC 3217`), is still stored whole as the suburb, as at every reader
before: `Holland Park West` is a real suburb of the same shape, and nothing on
the page tells the two apart. `Palomino Rise Armstrong Creek` reads no locality,
because `Rise` is also a street type. And **a suburb named with such a word,
then its city** (`Marsden Park, Sydney NSW 2765`) is read as the estate `Marsden
Park` in the suburb `Sydney`: that is how the one-line reader has read it since
it was written, because `Harbour Waters, Wyndham Vale VIC 3024` is an estate and
its suburb in the same shape. Every street form now reads that line the same
way, including the three that imported nothing before (`Lot 906, 14 Heath
Street` and its kin), so 28 layouts carrying it are counted apart below.

**Held out first.** Ten fixtures, committed before the code in three commits:
`heldout-lot-heading-over-a-street-and-its-locality`,
`heldout-lot-and-address-set-apart-by-a-dash` (a guard, read correctly by
both), `heldout-lot-heading-over-an-unpunctuated-address`,
`heldout-lot-heading-over-an-estate-and-its-locality`,
`heldout-lot-and-street-set-apart-by-a-dash-over-an-estate`,
`heldout-an-estate-run-into-its-suburb`,
`heldout-a-pipe-between-the-lot-and-its-street`,
`heldout-an-estate-and-its-suburb-with-no-state`,
`heldout-a-lot-heading-its-street-and-an-estate-run-into-its-suburb` and
`heldout-a-lot-and-its-street-number-over-the-locality`. The harness compares a
street as *contained*, because an address line may carry the number an
expectation omits, and that passes `| Magpie Crescent`, so a fixture whose
subject is the characters around a street states `street_line`, the whole line
exactly (`fieldHolds`).

**Measured.** Against reader 21, 76 of the 85 corpus and stress documents read
identically, and the 9 that change are the held-out fixtures (the tenth is the
guard). Swept against the values the page means (528 lot headings, 360
lot-and-street layouts, 756 street lines over every locality form) nothing reads
wrong, where reader 21 read 45, 78 and 110 wrong. The street lines read exactly
616 times in 756 (reader 21: 374), and in no sweep, nor in the 1,656-layout
comparison with reader 20, does anything reader 20 or reader 21 read exactly
read less. The 28 layouts of the named limit above read wrong at every reader
(reader 20: 14, reader 21: 22, now 28, because the street forms that imported
nothing now import).
`builderStockLotAddressFrame.spec.ts` pins each shape; 21 of its 31 cases fail
against reader 21, and the other 10 are the guards above, which both readers
must pass.
