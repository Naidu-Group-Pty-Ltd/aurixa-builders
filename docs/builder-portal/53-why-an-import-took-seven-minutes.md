# Why an import took seven minutes

**Measured 22 September 2026 on the production project (`htfluofznhxeumblwbww`).**
One ordinary single-property PDF — `Lot 52 - Bishop 258 - Property Package.pdf`,
upload `c5f139b9-8f8c-4a8f-9a90-ca885324ef0f`, item
`6e070603-7020-4ff4-8faf-547880b3500c`, one photograph — took **370 seconds**
from the upload being accepted to the property being published.

**About 28 seconds of that was work.**

Everything here is read from `builder_stock_uploads`, `builder_stock_items`,
`builder_stock_item_images`, `function_logs`, `cron.job` and the deployed
function bodies in `pg_proc`. Nothing in it is inferred from a stack trace or
from how long something "usually" takes.

---

## 1. The timeline

| at | event | Δ | what it was |
|---|---|---|---|
| 08:24:56.189 | upload row created | — | |
| 08:25:05.171 | `processing_started_at` | +8.98 s | handover |
| 08:25:16.867 | `processing_completed_at` (`processing_secs` 11.696) | +11.70 s | **import compute** |
| 08:25:17.898 | settler booted, kicked by `builder_stock_kick_image_work` | +1.03 s | |
| 08:25:19.325 | image row written | +1.43 s | **compute** |
| 08:25:19.958 | `source` → `eligibility`, *"stored 3, matched 1"* | +0.63 s | **compute** |
| 08:25:20.499 | `eligibility` → `sanitization`, *"assessed 0 of 1"* | +0.54 s | **compute** |
| **08:25:21.498** | **`CPU Time exceeded`** + `shutdown` | +1.00 s | **the whole of the rest** |
| 08:27:20.5 | the dead worker's lease expires | +120.0 s | wait |
| 08:27:50.5 | the watchdog's 30-second grace elapses | +30.0 s | wait |
| 08:28:01.6 | the `* * * * *` tick runs the watchdog; reclaim, failures 0→1, backoff 30 s | +11.1 s | wait |
| 08:28:31.6 | backoff expires | +30.0 s | wait |
| 08:29:01.1 | the next tick dispatches a worker | +29.5 s | wait |
| 08:29:02.069 | `sanitization` → `fallback`, *"repaired 0, cleared 0, refused 0"* | +1.0 s | **compute, wasted** |
| 08:29:03.300 | `fallback` → `settled`, evidence `held`, **no primary image** | +1.23 s | **compute, wasted** |
| 08:30:11.698 | an upload-level sweep re-reads the whole document, stores 3 images again, reopens `image_sanitization_settled_version` | +68.4 s | wait + **a second parse** |
| 08:31:04.108 | `eligibility` → `sanitization`, *"assessed 0 of 1"* | +52.4 s | wait |
| 08:31:05.426 | `sanitization` → `fallback`, *"cleared 1"*, primary set | +1.32 s | **compute** |
| 08:31:06.166 | `fallback` → `settled`, evidence `found` | +0.74 s | **compute** |
| 08:31:06.281 | **published** | +0.12 s | |

**Compute ≈ 28.5 s. Waiting ≈ 341.6 s.**

## 2. One event caused all of it

`CPU Time exceeded` at 08:25:21.498.

The settler had completed a stage one second earlier and had just claimed the
same property for the next one. A killed isolate runs no `finally`, so the
claim stood for its full 120-second lease, then the watchdog's grace, then a
tick, then a failure backoff, then another tick — 221 seconds before the third
stage of a four-stage ladder was even attempted.

And the killed worker had already stamped that image's `sanitization_attempt`.
That stamp is written **before** the work by design (a repair that kills the
worker must not be retried immediately) and carries a ten-minute cooldown, so
the pass that finally ran at 08:29:02 skipped the one image that mattered and
settled the property **with no photograph**. Only the unrelated upload sweep at
08:30:11 — which re-read the whole PDF and replaced `source_detail` wholesale,
taking the cooldown with it — let the real work happen, 121 seconds later
still.

### Why the existing allowance could not see it

The settler budgets **wall clock** (`BUDGET_MS = 100_000`) and counts
**documents** (`HEAVY_DOCUMENTS_PER_INVOCATION = 3`, chosen against a measured
memory ceiling on 7 September 2026). Both are real and neither is the
constraint that fired.

The invocation that died had been alive **3.6 seconds** and had used a third of
one document of its allowance. Wall clock does not separate it from the
invocation at 08:30:12 that ran **6,877 ms** and finished cleanly. What
separates them is what they spent CPU on:

| invocation | ran | outcome |
|---|---|---|
| 08:25:17.9 | a document, a photograph decode, the start of a second decode | **killed** |
| 08:29:03 | two metadata stages | ok, 3,038 ms |
| 08:30:12 | a document | ok, 6,877 ms |
| 08:31:06 | one decode and one metadata stage | ok, 3,499 ms |

Every survivor spent its CPU on one *kind* of heavy work. The only one that
mixed a document with a decode is the only one the runtime killed.

## 3. The delay audit

Every wait in the stock-image path, classified: **A** required by a real
external dependency · **B** rate limiting · **C** the consequence of an actual
failure · **D** merely advancing ordinary successful work.

| delay | value | class | disposition |
|---|---|---|---|
| `settle-builder-stock-marketplace-eligibility` cron | `* * * * *` | **D**, and the biggest one | **Kept as the recovery clock; removed from the success path.** A settler that advanced something and leaves work claimable now dispatches its own successor (`shouldRearm`). The tick still runs the watchdog, the publication sweep and the reopens. |
| item lease, every claim | `ceil(BUDGET_MS/1000)+20` = 120 s | **C**, oversized | **Derived from the invocation's remaining clock.** A lease only has to outlive the invocation holding it. |
| watchdog grace before reclaim | `claim_until < now() - '30 seconds'` | **C** | Kept. It stops a worker finishing at the lease edge being robbed. |
| watchdog failure backoff, **first** expiry | 30 s | **D wearing C's clothes** | **Removed.** A lease that expires once says nothing about the property — the claim's own body already argues this, in these words: *"a worker killed by the runtime — through no fault of the property"*. The failure is still counted. |
| watchdog failure backoff, later expiries | 30·2^(n−1), capped 300 s | **C** | Untouched. The second expiry is the first evidence that this property is what kills workers. |
| terminal ceiling | 12 failures → `failed` | **C** | Untouched. |
| `STALLED_RETRY_SECONDS` | 60 s | **C** | Untouched. A stage reporting progress it did not make is a real fault. |
| handback after a refused claim | `retryAfterSeconds: 0`, `resetAttempts: true` | — | Already correct: no delay, no backoff charged. |
| `OPERATIONAL_RETRY_AFTER_MS` (sanitization cooldown) | 10 min | **C** | Untouched, and **deliberately**. It is the poison-pill guard for a repair that kills workers, and it only stranded this import because the worker was killed at all. Weakening it would trade a rare 10-minute wait for an unbounded repeat of the most expensive operation here. |
| `builder-stock-reader-sweep-15min` | `*/15 * * * *` | **D** for re-read work | Untouched. Re-read work is created by a *deploy*, which has nothing to re-arm with; §`20260922020000` records why a heartbeat rather than an eighth term in the tick's sum. |
| `builder_stock_kick_image_work` after import | none — fires immediately | — | Already correct, and what the re-arm continues. |
| `RECOVERY_DEADLINE_MS` (75 s), `IMPORT_RUN_BUDGET_MS` (30 s), `IMAGE_BUDGET_MS` (8 s), `OCR_MAX_MS` (45 s), the fetch timeouts | various | **A** | Untouched. Every one bounds a real external dependency. |

There is no `sleep`, no poll and no queue visibility delay anywhere in the path.

## 4. What changed

**An isolate commits to one class of expensive work**
(`_shared/builderStock/workAllowance.pure.ts`). `source` opens a document,
`eligibility` and `sanitization` decode a photograph, everything else is
metadata. A document invocation does not then decode and a decode invocation
does not then open a document; metadata rides along with either. The document
ceiling is unchanged at the figure the memory measurement chose.

**An invocation that stops with work left starts its successor.** Through
`builder_stock_dispatch_image_workers(1)` — the same dispatcher the cron tick
already uses, the same signed invocation, the same ceiling, the same
best-effort contract. Two terms make it terminate and neither is a timer:
`settled > 0` (only an invocation that **advanced something** may re-arm, so an
unbounded chain would require unbounded real progress) and `claimable > 0` (so
the last invocation of an import starts nobody).

**A lease is what is left of the invocation**, not 120 seconds regardless.

**The runtime's own notice is used.** `releaseOnTermination.ts` registers
`beforeunload`, logs the resource the runtime names — which is the reading this
subsystem has never had — and asks for the claim back without awaiting it. It
is an optimisation and never the guarantee: the lease, the grace and the
watchdog still recover a worker that dies without notice.

**The first lease expiry costs no backoff**
(`20260922100000_a_worker_we_killed_must_not_bill_the_property.sql`), proved by
effect by `scripts/ops/probe-watchdog-backoff.mjs` rather than by reading the
function back.

**Both numbers are now recorded.** `builder_stock_items.image_work_timings`
carries `{stage, work_class, ms, scheduler_wait_ms}` per completed stage, and
`builder_stock_uploads.stage_timings` carries the import's own split plus the
counts. Diagnostics only — milliseconds, counts and stage names, never a byte
of a builder's document, and nothing branches on either.

`document_parses` is the one to watch, and the first production reading of it
corrected this paragraph before the ink was dry. It was written as "three for a
native document, four for a scan"; the first live run on `Lot 52 - Bishop 258 -
Property Package.pdf` reported **four with `rasterisations: 0` and
`ocr_pages: 0`** — a native document, recognising nothing.

That is correct and the sentence was not. `planOcr` is a statement about
PAGES: this package has a page that carries no text of its own, so the
recognition branch is entered, extracts that page's rasters — a parse — and
honestly recognises nothing from them. So the rule is **three where every page
states its own text, four where any page does not**, which is a distinction no
amount of reading the source produced and one run of the instrument did. On
top of that, the 22 September run paid a **fifth**, four minutes later, from
an upload-level sweep re-reading the same file; the only reason anybody
noticed is that it happened to log a line.

A duration says a stage was slow. A count says a stage ran that should not
have run at all — or that the shape of the document is not what the code's own
comments assumed.

## 5. What was deliberately not changed

- **No safety check was removed.** Image ownership, eligibility, overlay
  sanitisation, primary election, segmentation, re-read, replacement and
  multi-tenant isolation are untouched. The allowance decides *when* a stage
  runs, never *what it decides*.
- **No generative model was added.** OCR remains Tesseract.
- **Backoff semantics stand** for every failure after the first lease expiry,
  and the terminal ceiling is unchanged.
- **The Google Sheets, Notion, URL and direct-upload transports are untouched.**
  Nothing in this change is upstream of a PDF being in hand.
- **Publication rules are unchanged.** Nothing publishes earlier or with less
  evidence than it did; the same properties reach the same state, sooner.

## 6. The repeated-work census

What one import legitimately does more than once, what it was doing more than
once, and where each number is now readable.

| expensive thing | per import, by design | measured on the 22 Sep run | where it is counted now |
|---|---|---|---|
| PDF document parse | **3** where every page states its own text; **4** where any page does not, because the recognition branch rasterises from a parse of its own | **4** per run — and a fifth, four minutes later, from an upload-level sweep re-reading the same file at 08:30:12 | `stage_timings.document_parses` |
| page rasterisation | 0 for a native PDF; one per page needing recognition | 0 | `stage_timings.rasterisations` |
| OCR recognition | one pass over the pages that need it, never the document | 0 (native) | `stage_timings.ocr_pages`, `ocr_ms` |
| image extraction | once, inside the discovery parse | once, then again inside the duplicate parse | `stage_timings.images_extracted`, `image_extract_ms` |
| photograph decode (`eligibility`) | **once per stored primary** | **twice** — the ladder ran the whole way round and settled with no photograph, and the reopen ran it again | `image_work_timings` entries with `work_class: "decode"` |
| overlay classifier | once per decode, inside `eligibility` | as above | same |
| sanitisation (full-res decode, reconstruct, re-decode) | once per convicted image | twice; the first answered nothing, because the killed worker's cooldown stamp made it skip the one image | `image_work_timings` entries with `stage: "sanitization"` |
| publication attempt | asked after every settled item; refusing is the normal answer | 6, 5 of them correct refusals | one `stock publication` line each, already |
| signed URL | one per served image, 300 s TTL | as designed | — |

**Two things are deliberately not instrumented.** Database reads and writes are
not counted per import: PostgREST calls are spread across a dozen modules, a
counter would have to be threaded through every one of them, and the number
would be dominated by cheap single-row reads that are not what makes an import
slow. And nothing counts CPU directly, because the runtime does not expose it —
what it does expose is the `beforeunload` reason when it takes the worker, and
that is now logged.

**The duplicate parse is closed by the fix rather than by a guard.** The upload
sweep re-read the document because the ladder had settled the property without
a primary image, which happened because the worker was killed. With the kill
prevented, the first ladder pass clears the image and sets the primary, the
reopen does not fire, and the fourth parse does not happen. A guard that
suppressed the re-read would have suppressed the recovery as well.

## 7. The benchmark

`scripts/stock-acceptance/latency.ts`, against the same Postgres, PostgREST
and object store the acceptance gate uses, five iterations per class,
**upload accepted → published → the photograph fetched through the portal's
own serving step and decoded**.

It reports **compute** and **hops** separately, and says so on the page,
because it drives the ladder with no scheduler between the stages. Compute is
every millisecond of CPU and IO the pipeline spends; a hop is a crossing
between isolates, which is what the per-class work allowance makes the
document's own property — a scan that decodes twice needs a different number
from a native brochure. The production end-to-end is compute plus hops times
the dispatch latency, and the dispatch latency is measured in production
rather than guessed here: on 22 September, `builder_stock_kick_image_work` at
08:25:16.9 to a booted settler at 08:25:17.9 — **about one second**.

| class | fixture | compute median | p90 | p95 | max | hops | correct |
|---|---|---|---|---|---|---|---|
| native | `package-brochure` | 1.59 s | 1.96 s | 1.96 s | 1.96 s | 1 | 5/5 |
| scanned | `scanned-no-text-layer` | 3.89 s | 4.09 s | 4.09 s | 4.09 s | 1 | 5/5 |
| mixed | `mixed-scan-and-text` | 4.49 s | 4.56 s | 4.56 s | 4.56 s | 1 | 5/5 |
| two properties | `heldout-two-cards` | 2.29 s | 2.34 s | 2.34 s | 2.34 s | 2 | 5/5 |
| multi-property sheet | `heldout-pages-of-cards-with-photos` | 4.77 s | 5.15 s | 5.15 s | 5.15 s | 4 | 5/5 |

**Two classes publish nothing, and that is the pass.** `scanned-no-text-layer`
is a photograph of paper and has no facade in it; the image invariant is that
a property with no builder photograph does not reach the marketplace. The
first version of this benchmark scored every class on `published` and reported
those as failures — a benchmark asserting the opposite of the product's own
rule, which is worse than no benchmark. Each fixture is now judged against
what it says it holds.

**`heldout-pages-of-cards-with-photos` is new**, because the corpus had no
multi-property sheet carrying photographs: `heldout-pages-of-cards` is the
same document deliberately without them, and it is useless for the one
question a performance programme has to answer. Two cards a page and never
three — three columns on A4 leave each picture at 3% of the page against the
product's own 6% floor, which `heldout-three-cards` already records. Nothing
about the floor is relaxed for it.

## 8. What is deliberately still slow

Honest remaining limits, stated rather than rounded off.

**A hop costs about a second, and there is no lower bound below that.** A
signed dispatch through `pg_net` plus an Edge Function cold boot was 1.03 s on
the measured run (`builder_stock_kick_image_work` at 08:25:16.9, settler
booted 08:25:17.9). A four-property sheet crosses four isolates, so it pays
four of them. Removing that would mean doing more in one isolate, which is
exactly what the CPU ceiling forbids — so it is the price of not being killed,
and it is the right trade at one second a crossing.

**The upload-to-processing handover is ~9 s and is not touched here.** It is
the browser putting the file in storage and calling the processing endpoint,
and it is measured, not modelled: 08:24:56.189 to 08:25:05.171 on an 83 KB
document. It is a client and transport question rather than a pipeline one.

**OCR is the slowest legitimate work in the pipeline** and stays that way:
3.89 s median against 1.59 s for a native document of the same shape,
because recognition decodes page rasters. It remains ordinary Tesseract; no
model was added and none will be.

**The ten-minute sanitization cooldown stands.** It only stranded the measured
import because a worker was killed at all; weakening it would trade a rare
ten-minute wait for an unbounded repeat of the most expensive operation here.

**The minute tick is still the floor for recovery.** Anything the chain drops —
a worker that dies without raising `beforeunload`, a dispatch `pg_net` never
delivers — waits for the next tick and then for the watchdog's grace. That is
the recovery path working, and it is deliberately not on the success path.

**The benchmark measures compute, not the customer's clock.** It drives the
ladder with no scheduler between stages, so it cannot report a production
end-to-end and does not pretend to; it reports compute and hops separately and
leaves the dispatch latency to be measured where it actually happens.

## 9. The production A/B, on the same document

**Measured 22 September 2026 after the deploy**, on the same upload
(`c5f139b9`), the same organisation, the same property (`6e070603`, Lot 52) and
the same photograph (`fac3e85a`), by re-opening that property's image work —
the product's own "do this again" nudge, which `reopen_builder_stock_stranded_items`
and a provenance version bump both perform by themselves. Nothing was touched
after the nudge; every step below is the system's own.

`builder_stock_items.image_work_timings`, written by the settler:

| stage | work class | ms | scheduler_wait_ms |
|---|---|---|---|
| `source` | document | **3,460** | 56,395 (the nudge waiting for the minute tick) |
| `eligibility` | decode | **313** | **1,880** (the isolate hand-off) |
| `sanitization` | decode | **342** | **439** (same isolate) |
| `fallback` | metadata | **388** | **475** (same isolate) |

**Before — 22 Sep, 08:25:19.958 → 08:31:06.166 — 348 seconds** for those four
stages, of which 5.4 s was work.
**After — 09:48:04.3 → 09:48:10.75 — 6.4 seconds**, of which 4.5 s was work.

The shape is exactly the design. The document invocation logged
`rearmed: true, documents: 1, decodes: 0` and handed off; its successor logged
`decodes: 2` plus the metadata stage and `rearmed: false`, because by then
nothing was claimable. The one hop cost **1.88 s**; the two claims inside the
second isolate cost **0.44 s** and **0.48 s**.

### And the runtime named the resource

```
[builder-stock-image-settler] the runtime is terminating this worker {
  phase: "runtime_termination",  reason: "cpu",
  stock_item_id: "6e070603-…",   stage: "source",  holding_a_claim: true }
```

at 09:48:07.171 — **during a `source` stage that had run 3.46 seconds**. The
worker survived the notice and completed the stage 0.58 s later, so this was
the soft limit; but it is the first direct confirmation this subsystem has ever
had of *which* resource it is running out of, and it confirms the allowance is
the right shape: a single document is already close to the ceiling, so an
isolate that then decodes twice is exactly the combination that was being
killed.

It is also the first evidence for the fix made an hour earlier. The release now
passes `p_next_stage: null`, so it cannot disagree with the completion that was
running beside it: the item advanced to `eligibility` normally, `attempts` came
back to 0 and `image_work_failures` stayed 0. Had the release still named the
stage it was claimed at, it would have raced a completion that had already
moved on.

A second notice, `reason: "early_drop", holding_a_claim: false`, is the ordinary
end-of-request drop reporting honestly that it holds nothing.

### Correctness across the A/B

Same property, same `primary_image_id`, one image row, no duplicate, no pending
patch, `image_work_failures: 0`, `image_work_attempts: 0`, and
`has_primary_image: true` at **every** stage — the card was never blank, which
on 22 September it was for six minutes.
