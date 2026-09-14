/**
 * BUILDER STOCK — HOW RELIABLY WE PROCESS, WHICH IS NOT WHAT WE UNDERSTAND.
 *
 * TWO VERSIONS, BECAUSE THERE ARE TWO KINDS OF "NO IMAGE".
 *
 *   `PROVENANCE_VERSION`  what the extractor UNDERSTANDS about a brochure —
 *                         which page is a cover, which picture is the house.
 *                         Raising it reopens answers the DOCUMENT gave.
 *
 *   `RUNTIME_VERSION`     how reliably the worker can OPEN one at all — its
 *                         concurrency, its memory ceiling, what it holds while
 *                         it reads. Raising it reopens failures WE caused and
 *                         touches nothing the document actually answered.
 *
 * WHY THE SPLIT EXISTS. Before it there was one number, and
 * `negativeProvenanceStillStands` compared it without ever asking WHY a branch
 * stopped — so a document we read properly and a document that killed the
 * worker were the same record, gated the same way. Fixing the worker therefore
 * meant one of two bad choices: reopen every property including the seventy-two
 * that were answered correctly, or leave the six we crashed on retired for ever
 * as though their brochures were empty.
 *
 * MEASURED, 7 SEPTEMBER 2026, upload `bd7a0ef5`. Six of seventy-eight
 * properties carried a branch stuck at `attempts: 4` with no verdict — the kill
 * limit, reached without ever recording an answer. Their brochures are
 * unremarkable 8–12 MB documents: run one at a time through this same
 * extractor, all six elect their facade in about a second and 50–68 MB. Five at
 * once peak at 429 MB against a 256 MB ceiling, and the isolate dies. Nothing
 * was ever wrong with the documents; the concurrency was wrong, and the
 * property was told its brochure has no photograph.
 *
 * THE ASYMMETRY IS THE WHOLE POINT, and it is enforced by which writers stamp
 * this number rather than by a rule anybody has to remember:
 *
 *   a worker we destroyed        stamps it — reopened when the runtime improves
 *   a link that is not there     does NOT — a faster worker cannot reach a
 *                                deleted file, and re-chasing 404s for ever is
 *                                not a fix, it is a treadmill
 *   a document that answered     does NOT — it told us something true, and a
 *                                better worker does not change what it said
 *
 * So a record carrying no `runtime_version` is untouched by any bump here,
 * which also makes every record written before this existed correctly inert.
 *
 * RAISE THIS when the worker's capacity to open a document changes — its
 * concurrency, its isolation boundary, its memory discipline. NEVER raise it
 * for a change in what the extractor understands: that is the other number,
 * and using this one for it would silently reopen answers that are still true.
 */

/**
 * 1 — serial claiming, two workers, the whole heavy PDF path isolated.
 *
 * The invocation now claims ONE property, finishes it, releases it and only
 * then claims the next, so a worker never holds a second property's lease and
 * a kill still costs exactly one property — the safety rule the one-per-
 * invocation design was protecting, kept while its throughput ceiling goes.
 * Dispatch is a fixed 2 rather than a count scaled off the backlog, because
 * scaling concurrency with the queue is what turned a large upload into
 * maximum memory pressure. And the isolation boundary now encloses the text
 * read as well as the image election: text reading was measured at 400–1,029 ms
 * against the election's 670–1,215 ms, ran FIRST, and was never behind the
 * slot at all — so half the heavy work was unprotected, which is why a slot
 * that had already proved the principle did not save these six.
 */
/**
 * 2 — a bounded number of documents per invocation.
 *
 * Version 1 fixed the wrong half. Serial claiming and one slot over the whole
 * heavy path stopped five properties of six from being killed, and the sixth
 * — Lot 608 Acclaim Estate — collected four more kills under the new worker
 * against a brochure that reads in 0.84 s and carries its facade render on
 * page one. The document was never the problem, and neither was any single
 * document: what version 1 introduced is that ONE ISOLATE now reads several
 * PDFs and never gives the memory back.
 *
 * Measured, six reads of that brochure in one process: 50 -> 173 -> 236 ->
 * 247 -> 254 -> 287 -> 318 MB. The fifth crosses an Edge Function's ~256 MB
 * ceiling. Every read is under a second, so no clock could see it — the
 * allowance had to be counted in documents, and it is
 * `HEAVY_DOCUMENTS_PER_INVOCATION` in the settler.
 *
 * Raising this is what re-asks the one property version 1 wrongly retired.
 * Measured against production before the bump, exactly one row qualifies:
 * nothing that answered is touched, because only our own failures carry a
 * stamp at all.
 */
/**
 * 3 — the heavy election leaves the Edge Function entirely.
 *
 * Versions 1 and 2 both counted the same allowance in different units —
 * documents per invocation, memory per isolate — and both were the wrong
 * ceiling. Per-execution platform telemetry, 8 September 2026, on the upload
 * the operator had just made: THIRTEEN settler kills in one cold start, and
 * every one of them `reason: CPUTime`. Successes ended at 1,828 ms of CPU or
 * less; kills at 2,031 ms or more, against a 2,000 ms limit. Memory peaked at
 * 108 MB of 256 and was never close.
 *
 * So the thing that does not fit is CPU, and reading one heavy brochure and
 * electing its image is indivisible: about 2.4 s of it, in one uninterruptible
 * stretch. No scheduling rule, no per-invocation budget and no memory
 * discipline makes 2.4 s fit inside 2.0 s. Versions 1 and 2 were not wrong
 * about the pressure they measured; they were measuring the wrong wall.
 *
 * The election therefore moves to `builder-stock-pdf-worker` — a Cloudflare
 * Worker whose whole job is to run the SAME `readPdfPageTextResult` and
 * `electFromPdfBytes` this repository already had, inside a Durable Object
 * that has CPU for them. Nothing about which page is a cover, which picture is
 * the house, or what counts as evidence moves an inch: the shared modules are
 * imported and executed, not reimplemented. Measured on the two documents that
 * killed the settler: Lot 516 elects `l516.pdf#page2:Im0` in 3,149 ms and Lot
 * 6706 elects `l6706.pdf#page2:Im0` in 2,765 ms, byte-identical across
 * repeated and concurrent runs, with Cloudflare's own analytics recording
 * 3.34 s of Durable Object CPU on a request that was not killed.
 *
 * THIS IS A RUNTIME NUMBER AND NOT A PROVENANCE ONE, and the distinction has
 * never been sharper: the extractor understands exactly what it understood
 * yesterday. Only where it runs has changed.
 *
 * WHAT ELSE IT SWITCHES. `WORKER_RUNTIME_VERSION` in `pdfElectionRoute.pure.ts`
 * is 3, so this constant reaching 3 is also what routes the election off this
 * process. Below it every branch resolved to `in_process` and the worker could
 * not be reached even by accident. At it, the election runs on the worker or
 * it does not run at all — there is deliberately no in-process fallback,
 * because falling back would re-run the thing measured to die and re-create
 * the exact `CPUTime` failure this exists to end.
 *
 * WHAT IT REOPENS, measured against production immediately before the
 * migration: NOTHING, and that is the honest answer rather than a
 * disappointing one. The two properties the thirteen kills cost — Lots 516 and
 * 6706 of upload `4736c1c6` — sit on rows the operator deleted at 05:32 the
 * same morning, and the live upload `85f2b0bf` carries all thirteen with their
 * facades elected from the brochures. There is no backlog to re-ask. The value
 * of this number is entirely forward: the NEXT upload carrying a heavy
 * brochure is the one it saves, and every one after it.
 */
export const RUNTIME_VERSION = 3;
