/**
 * BUILDER STOCK — THE VERSION OF THE READER THAT PRODUCED A ROW.
 *
 * WHY THIS EXISTS, AND WHAT IT COST NOT TO HAVE IT.
 *
 * The three image concerns each carry a settled-version marker
 * (`source_images_settled_version`, `marketplace_eligibility_settled_version`,
 * `image_sanitization_settled_version`) and `builder-stock-image-settler`
 * brings every upload below the current one up to it, from pg_cron, with
 * nobody watching. Its own header states the principle: "Asking a builder to
 * press a button on every source they have ever uploaded is not a deployment
 * step; it is a defect with instructions."
 *
 * THE TEXT READER HAD NO SUCH MARKER. `pdfDeterministicRows.pure.ts` runs
 * exactly once, at import, and everything downstream is frozen with it — the
 * property's title, its configuration, its address, and, because the role
 * election reads the row's own label, WHICH PICTURE LEADS ITS CARD. So a
 * correction to the reader reached every future upload and not one row that
 * already existed, and the only route to an existing row was the builder
 * pressing "Read again" by hand, per stock list, for ever.
 *
 * MEASURED, 21 SEPTEMBER 2026. `LOT 48 - EMBER - FLYER.pdf` imported at 12:02
 * and the fix for the defect it had hit deployed at 12:22. The row kept a
 * `unit_number` of `115.30m 12.41sq` — a floor-plan area schedule read as a
 * designation — so its card was titled "Unit 115.30m 12.41sq", and
 * `stockRecordLabel` composes the label the cover election identifies pages
 * by, so `findPropertyCoverPages` could name no page and the flyer's own
 * facade render sat in storage, `ready` and `source_supplied`, with the role
 * `unknown` and the card blank. ONE defect, both symptoms, and twenty minutes
 * of timing between a row that healed and a row that could not.
 *
 * WHAT A RE-READ IS, AND WHAT IT IS NOT.
 *
 * For an UPLOADED FILE the stored bytes are the builder's own file and have
 * not changed, so re-reading them is how a parser correction reaches rows that
 * already exist — that is `reprocess_upload`'s own stated purpose, and this
 * runs the SAME `runStockImport` over the SAME object. Rows are matched by the
 * identity rule the import already uses and corrected in place, so a property
 * keeps its id, its history and anything a client has done with it.
 *
 * For a LINKED source it is a different act entirely, and this refuses it.
 * A builder links a sheet BECAUSE they keep editing it, so reaching the link
 * again imports edits they have not asked anyone to import — a decision that
 * belongs to them and is offered to them, in the portal, under a label that
 * says which act it is (`rereadNaming`). Re-reading the day-old SNAPSHOT
 * instead is the defect `49-re-importing-a-linked-stock-list.md` records.
 * Either way a cron tick is the wrong actor, so a linked source is stamped at
 * the current version WITHOUT being read: it is settled, not skipped, and it
 * never comes back.
 *
 * Pure: no imports, no IO, no clock beyond what a caller hands it.
 */

/**
 * THE READER'S OWN VERSION. Raise it when a change to the deterministic
 * readers, the claim funnel, the normalisers or the role election can produce
 * a DIFFERENT row from bytes that have not changed — which is the only
 * condition under which re-reading a source buys anything.
 *
 * 1 — the first marker. Everything imported before it was read by some earlier
 *     reader nobody recorded, so every existing upload is outstanding, which
 *     is what makes this the thing that repairs production.
 * 2 — a cover refusal now NAMES the test that refused it
 *     (`coverIdentityRefusal`). The role a picture is given is decided during
 *     the import and written with its reason, so the reason a card has no
 *     photograph is only re-derived by reading the source again — which is
 *     what this marker is for. On `LOT 48 - EMBER - FLYER.pdf` the stored
 *     refusal was identical before and after the reader was corrected, across
 *     two entirely different labels, and narrowing it by hand cost a deploy
 *     cycle and did not settle it.
 * 3 — the document became the import. One reader's refusal no longer
 *     discards another's evidence (`moreEvidencedRefusal`), the deterministic
 *     reading is taken before any model is considered, and the assisted
 *     reader is off unless a deployment names it. Every source read under 1
 *     or 2 was read by a pipeline that deferred to a paid vendor, so every
 *     one of them can produce a different row from bytes that have not
 *     changed — which is the only condition under which re-reading buys
 *     anything, and here it buys the imports that vendor's billing state
 *     refused.
 */
/*
 * VERSION 4 — THE ACCEPTANCE CORPUS'S EIGHT.
 *
 * Version 3 was "the model is no longer on this path". Version 4 is what
 * running the portal's own import over real bytes with no model then found,
 * and every one of them changes what the SAME bytes produce:
 *
 *   • a composed address line (`Lot 9 Perrin Street, Armstrong Creek VIC
 *     3217`) is read instead of standing the document down;
 *   • a disclaimer is no longer a fourth property;
 *   • a marketing slogan is no longer a design name;
 *   • a site plan's excluded neighbours no longer contradict its subject;
 *   • `Build 214m2` and `Package $845,000` are read;
 *   • `Site Area` is a land size;
 *   • the icon row is read beside a price instead of only alone;
 *   • a value made entirely of punctuation is not a value — which is the
 *     one that reaches `Lot 37 - Miami 190 - Property Package.pdf`, whose
 *     row settled at version 3 reading `development_name = ·` against
 *     `development_name = PROPLAUNCH`.
 *
 * Raising this is the ONLY thing that asks a settled source again, which is
 * why it is raised here rather than left for the next change: every row
 * stamped 3 is a row those eight cannot otherwise reach.
 */
export const DETERMINISTIC_READER_VERSION = 4;

/** Where the marker lives. Named once; two spellings is how two ends drift. */
export const READER_SETTLED_VERSION_COLUMN = 'reader_settled_version';

/** The upload row, as much of it as this decision needs. */
export interface ReaderSweepUpload {
  id?: unknown;
  status?: unknown;
  source_type?: unknown;
  source_url?: unknown;
  storage_bucket?: unknown;
  storage_path?: unknown;
  deleted_at?: unknown;
  processing_started_at?: unknown;
  /** Which failure, where the status is `failed`. See `OUR_FAILURE_CODES`. */
  error_code?: unknown;
}

/**
 * How long a `parsing` row may sit before the run that claimed it is taken to
 * be gone. Mirrors the portal's own `parseIsAbandoned` reasoning: a request
 * killed on its resource limit leaves the row at `parsing` for ever, and
 * refusing it for ever would make the one status a re-read most needs to
 * repair the one status it can never touch.
 */
export const ABANDONED_PARSE_MS = 15 * 60_000;

/**
 * Statuses a re-read may act on.
 *
 * `failed` and `uploaded` are excluded for the reason the portal excludes
 * them: nothing has been read, so there is nothing to correct and the act the
 * source needs is a first pass, not a second one. A first pass writes
 * properties, and a cron tick may not decide to start importing a file the
 * builder's own import refused or never ran.
 */
export const RE_READABLE_STATUSES: ReadonlySet<string> =
  new Set(['complete', 'imported', 'enriching', 'parsing']);

/**
 * ============================================================================
 * AND THE FAILURES THAT WERE OURS.
 * ============================================================================
 *
 * `failed` is excluded above because a cron tick may not decide to start
 * importing a file the builder's own import refused. That reasoning holds for
 * a document we could not read. It does not hold for a failure that was never
 * about the document.
 *
 * MEASURED 21 SEPTEMBER 2026. `Lot 37 - Miami 190 - Property Package.pdf`:
 * 7 pages, 3,962 characters of text extracted cleanly, written off `failed`
 * with `retryable: false` because a model provider answered HTTP 402 — an
 * account with no credit. Nothing anywhere would ever have looked at it
 * again, and the only way to collect the outcome was to ask the builder to
 * upload the same file a second time.
 *
 * Every code below is one this pipeline writes about ITSELF: a credential we
 * do not hold, an account somebody must pay, a provider that was down, an
 * allowance we set, an answer we could not parse, a run that threw. None is a
 * statement about the builder's file, so each has a real next action and a
 * bounded way back — which is what a non-terminal state owes.
 *
 * BOUNDED BY THE READER VERSION, like every other source here. A failure is
 * re-read once per version and then stamped, so a genuinely unreadable
 * document is attempted once rather than on a loop for ever; raising the
 * version is what asks again, and that happens only when the pipeline has
 * changed.
 *
 * NOT `duplicate_file`, `unsupported_file_type`, `file_missing`,
 * `snapshot_failed`, `empty_file` or `pdf_no_text_layer`: those are facts
 * about the file or about storage, and a re-read reaches the same answer at
 * the same cost.
 */
export const OUR_FAILURE_CODES: ReadonlySet<string> = new Set([
  'assisted_reader_unavailable',
  'assisted_reader_timeout',
  'assisted_reader_invalid_response',
  'assisted_reader_refused',
  'ai_budget_exhausted',
  'processing_failed',
]);

/**
 * ============================================================================
 * A VERDICT ABOUT THE DOCUMENT, AS OPPOSED TO A FAULT OF OURS.
 * ============================================================================
 *
 * `OUR_FAILURE_CODES` above names the failures that are never statements
 * about the builder's file, so they earn a re-read. These are the other half,
 * and they are needed for the opposite reason: a re-read that ends in one of
 * them has FINISHED. The same bytes through the same reader version reach the
 * same answer, so asking again costs a download and an invocation and learns
 * nothing.
 *
 * MEASURED 21 SEPTEMBER 2026. `Lot 37 - Miami 190 - Property Package.pdf` was
 * re-read on tick after tick — 1.9 MB downloaded and parsed each time — because
 * the sweep treats every unsuccessful read as a transient fault and leaves the
 * source outstanding. That rule is right for a fault (storage unreachable, a
 * timeout, a crash) and wrong for a verdict, and nothing told the two apart.
 *
 * `no_properties_found` is deliberately here. It is the honest answer for a
 * document that names no property, and a reader that has changed is what asks
 * again — which is exactly what raising `DETERMINISTIC_READER_VERSION` does.
 *
 * `pdf_text_extraction_failed` is deliberately NOT here, and the distinction
 * is `pdfText.ts`'s own: `pdf_no_text_layer` is "this document has no text",
 * which is a finding about the file, while `pdf_text_extraction_failed` is
 * "we could not extract text from this document", which is an operational
 * fault — its header says outright that it "must be retried and must never be
 * written down as a verdict". Settling on it would abandon a source over a
 * decoder that failed once.
 */
export const DOCUMENT_VERDICT_CODES: ReadonlySet<string> = new Set([
  'no_properties_found',
  'pdf_no_text_layer',
  'unsupported_file_type',
  'empty_file',
  'duplicate_file',
  'file_too_large',
]);

/**
 * Has this re-read finished with this source at this reader version?
 *
 * Only a verdict settles. Anything else — including a code this build has
 * never heard of — stays outstanding, which is the conservative side: an
 * unknown code re-read is wasted work, and an unknown code SETTLED is a
 * source silently abandoned.
 */
export function reReadSettlesAt(code: string | null | undefined): boolean {
  return DOCUMENT_VERDICT_CODES.has(String(code ?? ''));
}

/**
 * Why this upload will not be read again — or `null`, meaning read it.
 *
 * A reason is not a failure. Every one of them is a FINISHED answer about this
 * upload at this version, so the caller stamps the marker and the upload stops
 * being outstanding; only `null` costs a download and a parse. That asymmetry
 * is the whole liveness property: a queue whose refusals stayed outstanding
 * would re-ask the same unanswerable question every tick for ever, which is
 * the exact fault `repairSourceImagesForUpload` was once held still by.
 *
 * The one exception is `parse_in_flight`, which is a statement about RIGHT NOW
 * rather than about the upload — it is returned as a reason to decline and the
 * caller must NOT stamp it. `stampable` says which is which, so no caller has
 * to remember.
 */
export function readerReReadRefusal(
  upload: ReaderSweepUpload,
  now: number = Date.now(),
): string | null {
  if (upload?.deleted_at) return 'deleted';

  const status = String(upload?.status ?? '');
  if (status === 'failed') {
    // A failure that was OURS is work; a failure about the document is not.
    const code = String(upload?.error_code ?? '');
    if (!OUR_FAILURE_CODES.has(code)) return `status:failed:${code || 'unknown'}`;
  } else if (!RE_READABLE_STATUSES.has(status)) {
    return `status:${status || 'unknown'}`;
  }

  if (status === 'parsing') {
    const startedAt = Date.parse(String(upload?.processing_started_at ?? ''));
    const abandoned = !Number.isFinite(startedAt)
      || (now - startedAt) > ABANDONED_PARSE_MS;
    if (!abandoned) return 'parse_in_flight';
  }

  // A linked source is the builder's to re-fetch. See the header.
  if (String(upload?.source_type ?? '') === 'url') return 'linked_source';

  if (!String(upload?.storage_bucket ?? '').trim()
    || !String(upload?.storage_path ?? '').trim()) return 'no_stored_object';

  return null;
}

/**
 * May this refusal be written down as settled?
 *
 * Everything except a parse that is genuinely running: that upload is about to
 * be written by somebody else, and stamping it would record a version against
 * a read this sweep did not perform.
 */
export function stampable(refusal: string | null): boolean {
  return refusal !== null && refusal !== 'parse_in_flight';
}
