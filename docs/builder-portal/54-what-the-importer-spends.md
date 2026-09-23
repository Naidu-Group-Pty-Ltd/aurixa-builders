# What the importer spends, measured

`builder-portal-stock` was still killing itself on a real customer document
after the image settler had been made CPU-aware. This is the measurement that
says where the CPU actually goes, taken before anything was split — because
the instruction that produced it was *measure before splitting*, and because
the previous round's ceiling in `importBudget.pure.ts` says of itself, in
writing, that it is "a proxy and is named as one".

## 1. The kill this is about

`LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`, 8,530,307 bytes, 22 September
2026, production:

```
10:05:56.792  processing started
10:06:01.915  deterministic reading complete — 11 fields read
10:06:04.895  POST builder-portal-stock -> 546  CPU Time exceeded
```

What the row was left holding: `status: imported`, `records_detected: 0`,
`processing_completed_at: null`, `stage_timings: null`, and **one** stored
image. A property existed and the upload said none did. The minute tick's
publication sweep published it 55 seconds later; the 15-minute
`recoverAbandonedFinalisations` would have repaired the counts at ~10:20:57.

Two facts from the ordering fix the class of the failure. `image_discovery`
runs *before* the deterministic reader in `extract.ts`, and the reader had
already finished at 10:06:01.915 — so the three seconds that killed it were
spent after the document had been read, storing pictures. It died in the
**raster** class, not the document class.

And `stage_timings: null` is the second fact: the run that dies is the only
run worth measuring, and it was the one telling us nothing. That is why the
ledger is committed at every stage boundary now rather than at the end.

## 2. The instrument

`importStageLedger.pure.ts` names thirteen stages and files each under one of
three resource classes (a fourteenth, `document_handover`, was added by §11):

| class | stages |
|---|---|
| `document` | `document_open`, `native_text`, `positioned_layout`, `ocr`, `normalisation`, `segmentation`, `property_reader`, `image_discovery` |
| `raster` | `image_decode`, `image_store` |
| `metadata` | `document_handover`, `db_write`, `initial_image_work`, `finalisation` |

It is written forward — each stage `recordStage`s its cost and the row is
UPDATEd before the next stage begins — so a worker killed anywhere leaves a
row naming the last stage that finished. **The stage after the last entry is
the stage that killed the run.** `importTermination.ts` adds the runtime's own
word for the resource it reclaimed (`cpu`, `wall_clock`, `memory`,
`early_drop`), because `546` names no resource.

## 3. The stress corpus

Eight documents, built by `scripts/stock-acceptance/make-stress-corpus.py`,
each shaped to load one thing hard. None of them encodes the customer's
document: no lot number, no design name, no filename from production.

Run through the real `runStockImport` over the real acceptance stack
(`scripts/stock-acceptance/cpu-profile.ts`), median of the runs, timings read
back out of `builder_stock_uploads.stage_timings` rather than from the process
that produced them:

| document | size | props | ledger total | the stage that dominates |
|---|---|---|---|---|
| `stress-many-lines` | 0.25 MB | 1 | 0.15 s | nothing — 29/28/27 ms |
| `stress-one-huge-image` | 0.74 MB | 1 | 0.07 s | nothing — all ≤ 10 ms |
| `stress-heavy-brochure` | 5.63 MB | 1 | 0.35 s | nothing — 62/55 ms |
| `stress-positioned-grid` | 0.23 MB | 1 | 1.66 s | **`image_store` 1,509** |
| `stress-many-pages` | 0.25 MB | 1 | 1.75 s | **`image_store` 1,486** |
| `stress-many-images` | 5.15 MB | 1 | 4.62 s | **`ocr` 4,408** (7 rasters, 0 pages read) |
| `stress-multi-property` | 1.39 MB | 8 | 9.57 s | **`image_store` 9,388** |
| `stress-scanned-pages` | 1.25 MB | 1 | 10.76 s | **`ocr` 9,223** + `image_store` 1,474 |

Class totals across the corpus:

```
document   total  14,412 ms   worst single document   9,241
raster     total  14,031 ms   worst single document   9,388
metadata   total     485 ms   worst single document     133
```

## 4. What that says, and it is narrower than expected

**Exactly two stages are expensive.** `ocr` and `image_store`. Everything else
in the pipeline — opening the document, reading its text layer, the positioned
layout, normalisation, segmentation, the property reader, image discovery —
is tens of milliseconds on every document in the corpus, including the 5.63 MB
one. The deterministic reader that this programme spent weeks on costs 2–43 ms.

**Metadata is free.** 485 ms across eight documents, worst case 133 ms for an
eight-property write. There is no case for giving database writes an isolate
of their own, and doing so would be splitting cheap work for architectural
beauty.

**An image costs about 1.5 seconds to store.** 1,486 for one, 1,509 for one,
1,474 for one, 9,388 for eight — 1.17 to 1.51 s each, decode, classify,
assess, upload. So the existing `IMAGE_BUDGET_MS = 8_000` admits roughly five
images inline, *after* the document class has already spent whatever it spent.
Five images is 7.5 seconds of solid CPU. That is the LOT 550 kill, arithmetic
rather than hypothesis.

**An OCR page costs about 3 seconds**, and rasterising the pages to recognise
costs more than the pages that end up being read: `stress-many-images` spent
4,408 ms rasterising seven pages and recognised none of them, because the plan
wanted pages the rasteriser had to reach past. `extractPdfPhotosByPage` takes a
page count, not a page list, so it decompresses pages 1..n and the caller
throws away what it did not want.

**Wall clock is still not the instrument.** `stress-heavy-brochure` is 5.63 MB
and spends 0.35 s; `stress-positioned-grid` is 0.23 MB and spends 1.66 s. Size
does not predict cost either, which is the honest limit of the byte ceiling
the previous round installed.

## 5. What follows for the architecture

The split is therefore not three functions. It is two rules, and both come
from the two stages above:

1. **The raster class leaves the importer early.** It already has somewhere to
   go — the image settler is CPU-class-aware, checkpointed per item, and
   dispatched immediately by `builder_stock_kick_image_work`. What was wrong
   was the size of the inline allowance, not its existence: eight seconds
   measured from the moment the image phase starts bounds that phase and
   nothing in front of it.
2. **The document class needs a continuation, and only for OCR.** It is the
   one document-class stage that can exceed any sane budget on its own, it is
   already page-wise interruptible, and the pages it has recognised are the
   one piece of state worth persisting — a few kilobytes that stand for
   3 seconds of CPU each.

Everything else stays in one invocation, because everything else is measured
in tens of milliseconds and a document that fits must not pay for a document
that does not.

---

## 6. What was built from that measurement

Two rules, both taken from §4, and nothing else. No new edge function, no
second queue, and no split of work that was measured in tens of milliseconds.

### 6.1 The raster class leaves early, and the loop that was unbounded is bounded

`attachDocumentMedia` had **no budget inside it at all**. `importStockRecords`
asked `room()` once, before the call, and the loop then decoded, classified
and uploaded every picture in the document with nothing checking anything.
That is the LOT 550 kill in one sentence: `room()` said yes at 46 ms and
twelve pictures at ~1.5 s each followed it.

Now:

* `room()` also asks `mayStoreImage(ledger)`, so the wall-clock deadline and
  the picture count are joined by the resource that actually kills the worker.
* Each picture is asked for BEFORE it is stored, and charged whether it stored
  or threw — a ceiling that only counts successes is one a run of failures
  walks straight through.
* What is left behind is reported (`onImageryDeferred` → `imageryOutstanding`),
  which is a state the page already renders as *"Images are still being found
  — you can close this page."*
* `documentVisualKinds` is charged as `image_decode` and run **whole or not at
  all**: truncating it would settle roles on partial evidence, which is the
  thing `importStockRecords`' own whole-set deferral exists to prevent.

Nothing is lost. The image settler re-reads the same document through the same
`attachDocumentMedia`, in its own CPU-class-aware isolate, dispatched six wide
by `builder_stock_kick_image_work` the moment the import ends.

`repairSourceImages` passes no ledger and therefore declines nothing — it is
the component that exists to attach what this declines.

**And the first version of this left the larger half of the loop open.**
Before a single picture is stored, a paginated document's pictures are
decoded to settle what each one IS (`documentVisualKinds`, up to 24 of them,
one pass that cannot be divided — roles decided on part of the set are decided
on partial evidence). It was "charged rather than bounded", which meant it
always ran: re-profiled through the product's own file path,
`stress-multi-property` spent **4,854 ms** in it in one invocation, after the
document had been read — the unguarded loop the per-picture gate was written
to close, one call earlier, and the part of the old `image_store` figure that
was never storage at all. It is now priced before it begins, from the
pictures' HEADERS (`documentVisualKindsPixels`, sharing one predicate with the
decode so the two cannot mean different pictures), at the production-measured
~440 ms a megapixel, and `mayDecideRoles` lets it begin only if it fits INSIDE
the ceiling — an estimate is where the error is, and the margin to the
shortest measured kill absorbs it. Declined, the whole set is left to the
settler, which decides the same roles whole in an isolate of its own; the
acceptance gate's case 8m proves every property still receives its pictures,
once. The same profile found `db_write` counting that decode a second time
(5,009 ms for row writes that cost tens), because it subtracted `image_store`
alone; it now subtracts the whole raster class spent inside the call.

### 6.2 The document class gets a continuation, and only for recognition

Recognition is the one document-class stage that can exceed any sane budget on
its own and the only one with nowhere else to send its work. It was already
page-wise; what it lacked was somewhere to stop and somewhere to put what it
had read.

* `recogniseScannedPages` takes `mayRecognise` (asked before each page) and
  `onPage` (awaited after each one). A page it does not reach is **deferred**,
  a third state beside "read" and "refused", because a refusal is a statement
  about the page and a deferral is a statement about the invocation.
* `FINAL_OCR_REFUSAL_REASONS` names the refusals that are about the page —
  `no_raster`, `too_large`, `unreadable`. `out_of_time` and
  `engine_unavailable` are deliberately not in it: treating either as final
  would silently lose a readable page the moment a budget was tight.
* `extractPdfPhotosByPage` takes a page LIST. It took a page count, rasterised
  1..n and the caller threw away what the plan had not asked for — 4,408 ms on
  `stress-many-images` to recognise none of them.
* The checkpoint (`import_checkpoint`) holds recognised page text and nothing
  else, keyed on the document's own SHA-256. A checkpoint whose digest does
  not match the bytes in hand is discarded **whole**, which is what makes
  re-reading a changed linked source indistinguishable from a first read.

Pictures are deliberately **not** checkpointed: they already have somewhere
better to go, and persisting decoded rasters to resume them would be the
"giant blob stored to avoid computation" this design is told not to write.

**A page with nothing to recognise must be settled, and was not.** The
recogniser settles every page it is HANDED; a plan page the rasteriser yields
no image for was handed to nobody, so it was neither read nor refused and
stayed owed. `stress-heavy-brochure` — a native brochure that reads in 0.35 s
— crossed **eleven** isolates re-asking one such page until the crossing bound
stopped it, and because each crossing takes the first owed page, a page like
that also stands in front of every readable page behind it
(`stress-many-images` sat at six owed pages for five crossings without
attempting one). Such a page is now refused `no_raster` — final, because the
same bytes carry the same images every time — and a plan page beyond the
rasteriser's reach (`OCR_MAX_PAGES`, the reach the single pass always had) is
settled in the pass that knows it rather than costing an isolate apiece. The
floor of one page an invocation, which the code's own comment said "never
binds in practice", binds on every invocation: 3,000 ms of allowance against
3,100 ms a page is one page, so a scan of N pages crosses N isolates. And a
dense page measured **4.7–5.0 s** here, not 3.1 — `OCR_PAGE_MS` is an average
that includes the cheap first page — so one page is the whole of an
invocation's recognition, and a page is the unit nothing can divide.

### 6.3 The ceiling is derived, not chosen

The platform exposes no CPU meter — `546` names no resource and no amount — so
the ceiling is derived from the other end. The shortest production run
measured to be KILLED is **6,400 ms of wall clock**, and compute is a subset
of wall clock. The test is asked before a step, so the worst case is
`ceiling + largest single step`, and the largest step measured is an OCR page
at ~3,100 ms:

```
ceiling + 3,100  <  6,400      =>      ceiling  <  3,300
```

`EXPENSIVE_SPEND_CEILING_MS` is **3,000**. `metadata` is excluded from the
reckoning entirely, because it was measured at 485 ms across eight documents.

The asymmetry is the point: overshoot kills the invocation; undershoot costs
one dispatch. `builderStockImportHandsOffBeforeItDies.spec.ts` asserts the
inequality rather than the number, so if the step costs change the ceiling
must move with them.

## 7. One worker per import

Once an import is resumable, four things become possible that were not before,
and every one of them writes a builder's stock list twice: a continuation
dispatched twice (the hand-off AND the recovery sweep), a successor starting
while its predecessor is alive, a builder clicking through a second
`process_upload`, and a killed worker holding the row shut.

`builder_stock_claim_import` answers all four with one conditional UPDATE.
Under READ COMMITTED the second writer blocks on the row lock, re-evaluates
its `WHERE` against the version the first committed, matches zero rows and
answers false. No queue, no advisory lock, no second table.

Three rules carry it:

* **The lease is invocation-sized** (90 s). A lease is how long a DEAD worker
  blocks the work, and lengthening one is never the remedy for anything — the
  settler's seventeen-minute incident is what that costs.
* **A release names its token.** The settler shipped a release that named the
  stage it *thought* it held and walked a property back down its ladder. Here
  the statement clears the claim only `WHERE import_claim_token = p_token`, so
  a stale worker cannot release a successor's claim — not by timing, but
  because it cannot spell the token. A release writes nothing else except the
  moment it let go (`import_released_at`), which is lease bookkeeping rather
  than progress and is what §10's second recovery case reads.
* **`held` and `unavailable` lead opposite ways.** `held` means stop.
  `unavailable` means the migration has not reached this deployment, and the
  caller proceeds unclaimed, exactly as every import did before.

These properties, and §10's recovery, are asserted against a real PostgreSQL
by `scripts/ops/probe-import-claim.mjs`, which runs in the acceptance gate —
because reading the function back proves the text applied and nothing else,
which is the class of mistake the retention purge, the `manual_stats` CHECK
and the AML `.or()` each shipped once.

## 8. The successor starts now

`builder_stock_dispatch_import_continuation` calls
`cron_invoke_signed_function('builder-portal-stock', …)` — the same signed
internal dispatcher that fans out the image settler. `continue_import` is an
operation on the function that already owns importing, gated by
`verifyInternal` before the portal session is resolved, so there is exactly
one implementation of "read this document".

**The release comes before the dispatch.** A successor dispatched while its
predecessor still holds the claim would find the row claimed, correctly
decline, and the import would then wait for the minute tick — which is the
cron dependency this whole design removes. `releaseThenContinue` is the one
place that pairing is written down, and `finishImport` is the one place every
import path ends, so it is written once rather than at four call sites.

**Only a caller that can be reproduced is handed off.** A continuation
re-reads the stored bytes and nothing else. That reproduces a file import
faithfully and a LINKED one not at all: Sheets and Notion carry
`documentName`, `baseUrl`, `isNotionSource`, `rowAssets`, `linkDiscovery` and
`sheetTab` alongside the bytes, every one of them evidence the reader uses. So
`resumableFromStoredBytes` is declared by the file paths and by the
continuation itself, and a linked source degrades exactly as it does today —
which is now safe, because the CPU ceiling stops recognition on every path
whether or not a hand-off follows. (In practice they barely overlap: a Sheets
or Notion source is a spreadsheet or a page, never a scan.)

The organisation's name is READ on the continuation path rather than
inherited — `organisationName.ts`, shared with the reader sweep — because the
deterministic reader uses it as evidence. Leaving it null would make the
successor read the same brochure differently from its predecessor, and which
reading a customer got would depend on where the CPU ran out.

## 9. The status never lies

The hand-off writes **nothing**. The row stays `parsing`, no count is
recorded, `processing_completed_at` stays null. Writing a success there would
be the 22 September lie exactly — `records_detected: 0` on an upload whose
properties arrive a few seconds later; writing a failure would be worse,
sending a builder to re-upload a list that is mid-import.

`importOutcomeColumns` composes the whole outcome row in one place. The
comment above it used to say only the COUNTS are alike across callers, and
that was true while the callers were the portal and the reader sweep. It
stopped being true the moment an import could be finished by a continuation:
the browser's invocation and the dispatcher's are the same import split across
isolates, so a status that differed between them would make what an import
means depend on how big the document was.

The browser is told `still_importing: true` and says so — *"Still reading this
document … it will appear in your sources below when it finishes — you can
close this page."* `StockUploadStillReading` is a separate shape rather than a
zeroed summary, because `{ detected: 0, imported: 0 }` is what an empty stock
list looks like.

## 10. Recovery remains, and does not define latency

`builder_stock_recover_stalled_imports` runs from the minute tick. It is
**recovery, not stage transport**: the normal path dispatches its own
successor before returning and never reaches it. It exists for the invocation
that vanished without being able to say so — an out-of-memory abort, a host
that went away.

Its signal is better than the one the fifteen-minute sweep has to use. A clock
cannot tell a running import from a dead one; a lease can. `parsing` plus a
claim token plus an expired claim is a worker that died, definitively, and it
turns a fifteen-minute gap into a sixty-second one.

**There is a second way to be left with nobody reading, and the first version
could not see it.** A hand-off *releases* the claim and then dispatches, so a
dispatch that is lost — pg_net, the vault, a successor that fails to boot —
leaves a row reading `parsing` with no token at all. Put in exactly that state
against the real functions, the keep-alive counted 0, recovery dispatched 0,
and the row would have said "still reading" until a person pressed Read again
fifteen minutes later: `RECOVERABLE_UPLOAD_STATUSES` is `imported` alone, so
the fifteen-minute sweep never touches a `parsing` row. So a release stamps
`import_released_at`, and `builder_stock_imports_owed_recovery()` answers both
cases — died holding the claim, or let go and not taken within a minute (a
successor claims within seconds; a minute is also the tick's own period, so
one tick never races the successor it stands behind). A row no worker ever
held carries no stamp and is never recovered, because recovery beside an
import that never needed a claim is two readers.

**Only this attempt counts, and the first draft of the fix got that wrong.**
A row keeps its claim columns from every import it has ever had, and "Read
again" (`reprocess_upload`) deliberately takes no claim — so a re-read in
progress is `parsing`, carries no token, and still holds the PREVIOUS import's
release. The unscoped rule read that as a hand-off nobody took and would have
started a second reader beside the live one. Both arms are therefore scoped to
the attempt in hand: a claim or a release counts only if it is newer than
`processing_started_at`, which every path that sets `parsing` stamps in the
same write and which a continuation deliberately never refreshes. And because
that re-read hands off holding no claim, nothing would record its hand-off —
so the dispatch itself stamps `import_released_at` and arms the tick before it
sends, the send being the part that can fail.

**And recovery must already be running.** The keep-alive used to count only
what had already stalled, so a quiet deployment could unschedule the tick
under a live successor and leave that successor's death with nothing to
recover it. `builder_stock_imports_in_flight()` counts every import a worker
has held and not finished, and a claim arms the tick — only an upload INSERT
did, and a re-read inserts nothing. The read-only question and the act are
separate functions so the probe can ask the question of any deployment
without dispatching a real invocation.

It is bounded at three restarts per attempt, because an import that has died
three times is not one more dispatch away from working, and a minute tick
re-dispatching it for ever is a loop nobody is watching. `markParsing` resets
the bound, because a person starting the import again is a new attempt — a
file that failed three times last week must not be permanently unreadable.
`recoverAbandonedFinalisations` sits behind all of it, unchanged.

## 11. What production said after this shipped, and the rule it left

§6.3 derived a ceiling from wall clock and said so. Production answered it on
23 September 2026, after all of the above was deployed: `LOT 550` was
imported again through the live portal and killed again, three times, on
three paths.

```
05:35:36  process_upload   546  after the reader, inside the role decode
05:40:08  recovery re-run  546  beforeunload "cpu": document stages 1,155 ms,
                                 image_decode 485 ms, then the hard kill
05:40:42  "Read again"     546  the same place
```

The ledger read 1,640 ms against a 3,000 ms ceiling. The platform charges CPU
the ledger cannot see — the isolate's start-up, the download, the engine's
cold passes — so a ceiling priced in the ledger's currency cannot promise
anything about the runtime's. What the evidence does support is the rule the
settler measured on 22 September (`workAllowance.pure.ts`): every invocation
that survived spent its CPU on ONE kind of heavy work. So the rule is
structural and needs no number: **an isolate that parses a PDF decodes none
of its pictures.**

### 11.1 The first answer was wrong, and the gate said so

The first cut handed a paginated document's pictures to the image settler and
attached none of them in the importer. The acceptance gate refused it on its
first run: ten single-property brochures with no photograph on the card. The
settler's source repair re-reads a stored brochure without the evidence the
importer reads it with — the organisation's own name, the document's own name
— so the property it reads is not the property the import wrote, and it
matched none of them: `stored 0, matched 0` on all 151 of its attempts. For a
brochure, the importer's own attach is the only one that attributes a
picture. §6.1's "nothing is lost, the settler re-reads the same document"
was true of a multi-property sheet and false of the document this is about.

### 11.2 So the import itself crosses

The isolate that reads the document decides it exactly as before — the rows,
the strategy, the provisional and completed readings, the diagnosis — then
writes the read (`builder_stock_document_reads`, purpose `import`: page texts,
regions, the page-order verdict and every picture's ENCODED bytes, exactly as
the document carries them) and the decision beside it, and hands on through
`continue_import`, the continuation it already was. No new transport and no
new queue.

* **A token binds the decision to the attempt.** It is minted when the read is
  written and recorded in the checkpoint; a successor takes only the read its
  checkpoint names, and a fresh attempt (`process_upload`, "Read again")
  drops it (`freshAttempt`) and puts away what an earlier attempt left.
* **The kinds are learned a budgeted batch per isolate.** Deciding what each
  picture IS is a decode per picture; a successor learns a batch
  (`KIND_DECODE_BUDGET_MS`, at least one picture) and hands on, so the
  isolate that attaches decides every role with every kind already known.
* **The attach decodes what a settler decode isolate may, no more.** What is
  left to decode there is each hero's display eligibility, and past the
  settler's own measured three (`DECODES_PER_INVOCATION`) a hero is stored —
  attributed, with its role — and judged by the settler's eligibility stage,
  the state an oversized hero already takes. The gate's eight-property sheet
  spent 3,737 ms judging eight heroes in one isolate before this bound.
* **The crossings are bounded by a proof.** One hand-off, then at most one
  crossing per picture the role decision can read (`MAX_KIND_CANDIDATES`,
  24, named once and imported by the decoder): `MAX_PICTURE_CROSSINGS` is 25,
  counted apart from recognition's ten, because a deployment with no
  recogniser is no reason to decode where a document was parsed.
* **A hand-off is made only once its checkpoint has landed**, and the read is
  put away when the import it served is over.

The settler's `source` stage keeps the same rule for its own read (purpose
`settle`): reading a PDF is one claim of the document class, learning its
kinds and attaching are claims of the decode class, so no settler isolate
parses and decodes either. The two reads are never served as each other's —
the purpose is in the table's key, every picture's path and the manifest.

### 11.3 What the gate now runs

Route A used to import the way a LINKED source does, which never hands off —
so the path every uploaded brochure takes in production was not the path the
gate ran. It now claims, marks the row, imports with `resumableFromStoredBytes`
and drives the successors through `continueStockImport` as the dispatcher
does, and "Read again" is run the way `reprocess_upload` runs it. Route B
stays the linked transport, so the transport equivalence now compares an
import finished by successors with one finished where it started. And every
route-A invocation is judged by effect: none may both parse the document
(`document_parses`) and decode or store one of its pictures.

### 11.4 The sweep read every import a second time, in one isolate

The first production proof of this design finished `LOT 550` through
successors with no kill, and then the image settler was killed twice on the
same document, at 05:40:08 and 05:43:07 on 23 September 2026 — last completed
stage `image_decode`. The kills came from the reader sweep (`settleReaderVersion`),
not the import. `reader_settled_version` was written by the sweep alone, so
every upload was outstanding the moment its import completed, and the sweep's
next quiet tick read it again with `runStockImport` inline, without
`resumableFromStoredBytes`: parse and decode in one isolate.

A completed import is a read at the current version, so
`importOutcomeColumns` now stamps it. Both completions spread those columns
(`process_upload` / `reprocess_upload` through `finishImport`, and a successor
through `continueStockImport`). A failed import stamps nothing, and the
sweep's own rules still decide whether a failure is worth asking again. The
gate asserts it: every route-A import a successor finished is stamped
(`a-finished-import-is-not-read-twice`), and check 7d now simulates a reader
deploy by moving the stamped rows one version behind, instead of relying on
imports leaving the column empty.

**What remains, and is fenced rather than fixed.** The sweep still re-reads
in one isolate wherever it does read: after `DETERMINISTIC_READER_VERSION` is
raised (every stored source), on a first pass of an `uploaded` row abandoned
for fifteen minutes, on an abandoned `parsing` row, and on a `failed` row
whose failure was ours. `LOT 550` is killed there. A kill writes nothing, so
the row stays outstanding with no attempt bound. The sweep takes the oldest
outstanding row first, one per quiet tick, and `readerSweepPending` holds the
cron open, so the settler would die on every quiet tick and nothing behind
that row would ever be re-read.

That loop is not a forecast. It already happened once, on 22 September 2026.
After the portal import was killed at 10:06:04, the upload was left unstamped.
The sweep re-read it inline, and the settler was killed thirteen times, every
two to three minutes from 10:09:06 to 10:35:07, each kill about 1.5 s after the
reader logged its reading of upload `7df6a47f`. It stopped only because one
attempt fitted, at 10:38:07 (`reader sweep re-read … reader_version: 13`).

The fix is the import's own rule applied to the sweep: its re-read must cross
isolates. There are two ways to do that, and each changes something the sweep
promises today:

- **Converge over the sweep's own ticks.** Import with
  `resumableFromStoredBytes`, leave the row outstanding on a hand-off, and
  resume it on the next tick. This needs a durable record that this sweep made
  the hand-off. Without it, a later tick can resume another attempt's crossing
  count, or restart its own hand-off for ever.
- **Hand the re-read to the product's continuation**, as "Read again" does.
  That moves a settled list through `parsing`, and a failed successor writes
  `failed` over live stock. Both are things the sweep promises not to do
  (`writeImportOutcome`).

Until one of them is built, `builderStockReaderSweep.spec.ts` fails any change
that raises the reader version while the sweep still re-reads inline. That
change is the one that would cause the outage, and the test names the reason.
