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
three resource classes:

| class | stages |
|---|---|
| `document` | `document_open`, `native_text`, `positioned_layout`, `ocr`, `normalisation`, `segmentation`, `property_reader`, `image_discovery` |
| `raster` | `image_decode`, `image_store` |
| `metadata` | `db_write`, `initial_image_work`, `finalisation` |

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
