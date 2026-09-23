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
 * Pure: no IO, no clock beyond what a caller hands it. Its one import is
 * pure too — the sweep's own attempt record, `readerSweepAttempt.pure.ts`.
 */
import { sweepHandedOnThisParse } from './readerSweepAttempt.pure.ts';

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
/*
 * VERSION 5 — BECAUSE EVERY ROW STAMPED 4 CARRIES A DIAGNOSIS FROM AN
 * EARLIER READER.
 *
 * This one is not a change to the reader. Version 4's re-reads happened and
 * were correct; what was wrong is the RECORD of them. `supersedeOurFailure`
 * rewrote a refusal's reason only where the previous reason was one of ours,
 * so a source whose row already carried a verdict kept the evidence of the
 * read BEFORE it — measured on `Lot 37 - Miami 190 - Property Package.pdf`,
 * whose row read `reader_settled_version: 4` beside
 * `development_name = ·`, evidence produced by the version-3 reader that
 * still claimed a bullet glyph as an estate. The stamp said one thing and
 * the diagnosis said another, and the diagnosis is the only part an operator
 * can act on.
 *
 * Every row stamped 4 is in that position, so the honest repair is a pass
 * that records what the current reader actually answers — which is what
 * raising this does, for every source at once and without touching a single
 * row by hand.
 */
/*
 * VERSION 6 — TWO ESTATES ARE NOT TWO PROPERTIES, AND A TRACKED-OUT HEADING
 * IS NOT A NAME.
 *
 * A change to the READER this time, and both halves come off the same
 * document. `Lot 37 - Miami 190 - Property Package.pdf` names no estate: its
 * two candidates are `PROPLAUNCH`, a marketing platform's brand mark, and
 * `M A S T E R P L A N`, a page heading a designer tracked out. Letter-spaced
 * type is now refused as a value, and `development_name` has left
 * `MATERIAL_FIELDS` — an estate is a place containing many properties, the
 * lot identifies one, and `lot_number` still refuses.
 */
/*
 * VERSION 7 — THE STALE CODE ON A ROW THAT SUCCEEDED AT VERSION 6.
 *
 * Not a change to the reader, and the second time this has been needed for
 * the same reason: a fix to how an outcome is RECORDED cannot reach a row
 * that is already stamped, because the stamp is what stops it being asked
 * again.
 *
 * Version 6 read `Lot 37 - Miami 190 - Property Package.pdf` successfully —
 * one property, 563 m², the builder's own photograph — while the row went on
 * carrying `error_code: no_properties_found` from the read before it, because
 * a stale error was cleared only where the STATUS said `failed` and this row
 * said `complete`. That is fixed, and the fix runs on the next re-read;
 * without this there is no next re-read.
 *
 * Every row that succeeded at version 6 while carrying an older error is in
 * the same position, so this is the repair for all of them rather than for
 * one, and it is a re-read of bytes that have not changed — cheap, bounded
 * by the same one-per-version rule as every other.
 */
/*
 * VERSION 8 — THE DOCUMENT WAS DOT-DELIMITED ALL ALONG.
 *
 * `Lot 37`'s own row recorded 176 lines attributed to nothing, and every
 * field it was thought not to state was in them, either side of a middle
 * dot. A separator read as a word is why. See `splitOnFieldSeparators`.
 */
/*
 * VERSION 9 — AN ADDRESS LINE WITH NO POSTCODE, AND THE ESTATE INSIDE IT.
 *
 * `Lot 37, Sandpiper Estate, Tweed Heads NSW` stood a document down for want
 * of four digits, while naming its lot, its estate, its suburb and its state.
 * Version 8 also DROPPED that document's provisional row by disputing the
 * estate; this restores it and corrects it. See `readComposedLocality`.
 */
/*
 * VERSION 10 — TYPOGRAPHY IS NORMALISED ONCE, AND A VALUE IS TYPED ONCE.
 *
 * Two layers, one seam. `documentNormalisation.pure.ts` turns raw glyph and
 * layout evidence into canonical units before any reader is asked a question —
 * the field separator, the letter-spaced heading, the word gap inside it, and
 * the tracked run that reaches the layout reader as ONE CELL PER GLYPH. And
 * `fieldTypes.pure.ts` is the one gate every claim passes through, so money
 * cannot become an area, an area cannot become an identifier and a room
 * dimension cannot become a bedroom count — six rules that were written in
 * four places in the reader and in three readers besides.
 *
 * Every document already imported is read again, because a document whose
 * headings were unreadable was read without them.
 */
export const DETERMINISTIC_READER_VERSION = 17;

/*
 * VERSION 11 — A PHRASE'S OWN WORDS ARE HEADINGS TOO.
 *
 * Version 10 wrote `development_name = MASTERPLAN` onto a builder's card,
 * measured on the deployed reader minutes after it shipped. The page sets
 * `E S T A T E` and `M A S T E R P L A N` side by side; the phrase rule joined
 * them, `readLeadingFieldName` split the phrase into a label and a value, and
 * the guard held only the joined phrase. One join and one split, each correct,
 * and the display type came out the other side as a value.
 *
 * Re-read, because a row carrying a page heading as its estate is worse than a
 * row carrying no estate at all.
 */
/*
 * VERSION 12 — THREE THINGS THE READER NOW SEES THAT IT COULD NOT.
 *
 * A QUANTIFIER TURNS A THING INTO A MEASURE OF IT. `TOTAL HOME AREA` is the
 * building size and `TOTAL LAND` is the land size, read at the label layer
 * for every measured field rather than as vocabulary entries — so a heading
 * no alias table lists is still understood, and `TOTAL HOUSE` does not become
 * the design.
 *
 * A PAGE WITH NO TEXT LAYER IS READ. `pdf_no_text_layer` was a refusal and is
 * now a seam: the page is recognised and the SAME deterministic layers are
 * asked the same questions. A document that was reported unreadable may now
 * carry every field it always stated.
 *
 * AND A URL'S DISPLAY LABEL IS NO LONGER EVIDENCE. The reader corroborates an
 * unplaced page line against the document's NAME, and a linked source was
 * handing it `host/…/segment` — so a hostname could settle a house design,
 * and a link with no filename lost a corroboration the same bytes had as an
 * upload. See `documentName.pure.ts`.
 *
 * Every stored document is read again, and the first two are why: this
 * version is the difference between a field the page states and a field the
 * record holds. MEASURED on the production row for
 * `Lot 37 - Miami 190 - Property Package.pdf`, settled at version 11 and
 * carrying no building size, no price and no design while the page sets all
 * three in tracked-out display type.
 */
/*
 * VERSION 13 — A PAGE CAN HOLD MORE THAN ONE PROPERTY, AND A PROPERTY CAN
 * HOLD MORE THAN ONE PICTURE.
 *
 * TWO CHANGES, AND EACH ONE ON ITS OWN MEETS THE BAR THIS VERSION EXISTS
 * FOR: a different row, or a different picture, from bytes that have not
 * changed.
 *
 * A PAGE CARRYING SEVERAL PROPERTY CARDS IS READ AS SEVERAL DOCUMENTS.
 * Every reader before this one read a document as a stream of lines, and a
 * stream of lines has no columns in it — so a sheet of three cards was read
 * as ONE property, and where the cards state different fields that did not
 * refuse: it COMPLETED, as one property wearing three properties' facts. A
 * stored document of that shape produces a different row now, and the
 * difference is between a wrong import and a right one.
 *
 * AND THE ROLE ELECTION SURVIVES THE FIRST SETTLER TICK. The ordinary repair
 * branch settled a PDF's image roles with the CONTAINER helper, which
 * designates a primary only where a property has exactly one attributed
 * picture — so a property holding a facade and a floor plan lost the hero its
 * own import had elected, on the first tick, along with the eligibility
 * verdict beside it. A stored document of that shape keeps a different
 * picture now, and re-reading is the only thing that asks a settled source
 * again.
 *
 * A single-property document read under 12 produces a byte-identical row
 * under 13 — `segmentPropertyRegions` answers null for every page that does
 * not carry property-level evidence in more than one band — so this costs a
 * re-read and changes nothing for the documents that were already right.
 * That is what makes it safe to raise for all of them at once.
 */

/*
 * VERSION 14 — A PACKAGE BROCHURE'S OWN LAYOUT, AND THE RE-READ THAT CAN
 * FINALLY CARRY IT.
 *
 * MEASURED 23 SEPTEMBER 2026 on the only live source on the production
 * project, `LOT 4327 Jubilee Estate - ENZO 10.5 MODERN - BROCHURE V002 -
 * Copy.pdf`: it imported its price and its land size and nothing else — no
 * address, no bedrooms, bathrooms or car spaces, no build size, no design —
 * while the page prints every one of them. Read back out of the stored
 * document, five separate defects each cost one field, and every one is a
 * rule about the document CLASS:
 *
 *   • a raised `2` (`91.91m²`) sat on a heading's baseline and was grouped
 *     with the heading (`liftedSuperscripts`);
 *   • `Total:` was set 2.9 points above its own value
 *     (`joinDriftedLabelValues`);
 *   • `House Specifications` was taken for the house design and blocked the
 *     filename's `Enzo 10.5` (`a_section_heading_is_not_a_name`);
 *   • `Lot 4327 Jubilee Estate,` over `Wyndham Vale` — the comma is the
 *     document saying the address continues (`readContinuedAddress`);
 *   • the icon row `3 2 2` had nothing to key it, and is now read in its
 *     printed order under guards that each refuse rather than guess
 *     (`readOrderedIconRow`), with the build size taken from the house's one
 *     area schedule where nothing labels it (`readAreaScheduleTotal`).
 *
 * A different row from bytes that have not changed, which is the bar.
 *
 * AND IT WAS FENCED UNTIL THE SWEEP COULD RE-READ WITHOUT DYING. Raising this
 * makes every stored source outstanding, and the sweep re-read each one
 * inline — parse and decode in one isolate, which is where LOT 550 killed the
 * settler fifteen times over two days. That source is 7.76 MB of the same
 * class. The sweep now reads the way the import does, handing a paginated
 * document's pictures to a later isolate and continuing across its own
 * ticks, and a document that kills a tick is asked a bounded number of times
 * rather than for ever. See `readerSweepAttempt.pure.ts`.
 */

/*
 * VERSION 15 — THE PAGE THAT PRICES THE PROPERTY IS THE PAGE THAT MEASURES IT.
 *
 * MEASURED 23 SEPTEMBER 2026 on `LOT 927 - ENZO 10.5 - BROCHURE V002.pdf`,
 * uploaded to the production project that morning: the card read `LAND —`
 * and `HOME 132 m²` over a property page printing `Lot Size 294m²` and a
 * house schedule totalling `129.5m²`. Page 2 is a siting consultant's
 * drawing whose `Site Area: 309.45 m2` and `Build Area: 131.6 m2` are the
 * operands of the site coverage it prints, and the reader gave them the same
 * standing as the property's own page — so the lot size was disputed and
 * dropped and the siting's labelled build area outranked the house's own
 * total. The estate went the same way: `(Banyan Place Estate)` on one page,
 * `Estate: Banyan Place` on the other.
 *
 * A lot size or build size is now settled once every page has been read: the
 * pages that state the price state the property's measurements, and any
 * other page may refine one of those figures to more decimals or fill one the
 * property's page never states — never overrule it. See
 * `measurementAuthority.pure.ts`. A document that states no price reads as it
 * always did, and a document whose pages already agreed reads byte-identically.
 *
 * Every stored document is read again, because the brochure class this
 * changes is the one builders on this platform upload — `LOT 214`, `LOT 315`,
 * `LOT 717`, `LOT 4327` and `LOT 927` are one template — and a row carrying
 * no land size or the siting's building area is corrected only by a re-read.
 */

/*
 * VERSION 16 — FOUR SPELLINGS THE READER KNEW, IN ARRANGEMENTS IT DID NOT.
 *
 * MEASURED 23 SEPTEMBER 2026 on `Lot 101 - PICO - BROCHURE v002.pdf`,
 * uploaded to the production project that afternoon: the card read `Lot 101`
 * and the icon row's `3 2 1` and nothing else, over a property page printing
 * `TOTAL - $604,500`, `Lot 101 Watsons Reach Estate`, `PICO 8` and `Titles
 * December 2026`. The builder's second template, and every fact on it a
 * spelling this vocabulary already had:
 *
 *   • `total $` is a price heading, and only the reader that takes a label
 *     and its value with NO separator retried a bare label with the marker
 *     its value carries — so a spaced hyphen between them hid the package
 *     price (`readLabelledValue`, `readVerticalPair`);
 *   • the lot line's tail was read only to be refused, never as the estate it
 *     names itself (`estateAfterLot`);
 *   • the filename names the design's FAMILY and the page prints the family
 *     and its size (`corroborateDesignFromFilename`);
 *   • `Titles December 2026` is a completion after its label with no
 *     separator, read only in the shape of a date (`readLeadingCompletion`).
 *
 * The page names no street and no suburb, and its text states no lot size and
 * no build size: the build size is printed only inside a picture of the
 * house's area schedule, and the lot size nowhere in the document. Nothing
 * here invents either.
 *
 * Every stored document is read again, because a row carrying the lot and
 * nothing else is corrected only by a re-read. The corpus reads
 * byte-identically but for the held-out fixture of this class.
 */

/*
 * VERSION 17 — A FIGURE THE PAGE PRINTS ONLY AS A PICTURE.
 *
 * MEASURED 23 SEPTEMBER 2026 on `Lot 101 - PICO - BROCHURE v002.pdf`: after
 * version 16 its card reads the lot, the estate, the design, the price and
 * the titles, and `HOME —`, because the house's size is printed once, inside a
 * 231 x 166 raster of its area schedule, and no text reader can see a picture.
 *
 * The importer now notes the small pictures on the property's own page when
 * the text states no building size (`pdfFigures.pure.ts`), and a successor
 * that never parsed the document reads them with the same Tesseract the scans
 * go through (`readFigures.ts`). A figure is believed only where the picture's
 * own arithmetic proves it (`areaSchedulePicture.pure.ts`): the squares column
 * must restate the total exactly, or every part must be legible and add up.
 * On the production picture recognition drops the total's decimal point
 * (`12450`) while reading its squares (`13.40`), and the squares place the
 * point, because only one placement restates them.
 *
 * A figure only ever FILLS a building size the text left empty: it never
 * speaks over one, never settles a dispute, and never reaches a document read
 * as several properties.
 *
 * Every stored document is read again, because a row carrying no building
 * size is corrected only by a re-read. A document whose text states its build
 * size, or whose page draws no such picture, reads byte-identically.
 */

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
  /** When the bytes landed. Decides whether an `uploaded` row is abandoned. */
  created_at?: unknown;
  /** Which failure, where the status is `failed`. See `OUR_FAILURE_CODES`. */
  error_code?: unknown;
  /**
   * The sweep's own record of a re-read in progress. Read here for one
   * question alone — is a `parsing` row the sweep's own hand-off — and see
   * `sweepHandedOnThisParse` for why that is not `parse_in_flight`.
   */
  reader_sweep_attempt?: unknown;
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
 * How long a row may sit at `uploaded` before the request that would have
 * imported it is taken to be gone.
 *
 * `add_upload` stores the bytes and answers; the browser then calls
 * `process_upload`. Between those two calls the customer's tab can close,
 * their connection can drop, or the phone they uploaded from can lock — and
 * the row is left holding a stock list nobody will ever ask about. Fifteen
 * minutes is `ABANDONED_PARSE_MS`, deliberately: the two are the same
 * judgement about the same kind of absence, and two numbers for one
 * judgement is how they drift.
 */
export const ABANDONED_UPLOAD_MS = ABANDONED_PARSE_MS;

/**
 * Statuses a re-read may act on.
 *
 * `failed` IS EXCLUDED AND `uploaded` IS NOT, AND THE DIFFERENCE IS WHO WAS
 * TOLD WHAT.
 *
 * This set read `complete, imported, enriching, parsing` and excluded both,
 * under one sentence: "a cron tick may not decide to start importing a file
 * the builder's own import refused or never ran." The first half of that is
 * right and stands — a `failed` row is a DECISION, the builder was shown it,
 * and a tick that quietly re-imports overrules something a person was told.
 *
 * The second half was wrong, and it is a gap of exactly the shape this
 * subsystem keeps finding: a state nothing can move, that reads as normal.
 * A row at `uploaded` carries no decision at all. The bytes are stored, the
 * builder was told the file was received, and NOTHING HAS EVER LOOKED AT IT.
 * Starting the first pass there is not overruling anybody; it is the pipeline
 * doing the job the upload was for. Refusing it means a customer whose tab
 * closed between `add_upload` and `process_upload` has a stock list that
 * never imports, for ever, with every screen in the product reporting normal
 * operation.
 *
 * MEASURED 22 SEPTEMBER 2026 in the acceptance gate's fault matrix: bytes
 * stored, row at `uploaded`, eight sweep ticks, zero properties, status
 * unchanged. Nobody was coming.
 *
 * TWO THINGS MAKE IT SAFE, and neither is in this set.
 *   • The row must be OLD ENOUGH that no request is still in flight —
 *     `ABANDONED_UPLOAD_MS`, checked in `readerReReadRefusal`, which answers
 *     `upload_not_started` for a fresh one and refuses to stamp it.
 *   • The sweep must CLAIM it, moving `uploaded` to `parsing` conditionally
 *     on it still being `uploaded`, so a browser that comes back at the same
 *     moment and this tick cannot both import. See `settleReaderVersion`.
 */
export const RE_READABLE_STATUSES: ReadonlySet<string> =
  new Set(['complete', 'imported', 'enriching', 'parsing', 'uploaded']);

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
    /*
     * EXCEPT THE SWEEP'S OWN READ, HANDED ON. A row the sweep claimed and
     * handed to a successor is `parsing` with a stamp the sweep wrote seconds
     * ago, and nobody else is its successor. The claim is still taken before
     * a byte is read, so a live import is never joined. See
     * `sweepHandedOnThisParse`.
     */
    if (!abandoned && !sweepHandedOnThisParse(upload, DETERMINISTIC_READER_VERSION)) {
      return 'parse_in_flight';
    }
  }

  /*
   * A ROW THE BROWSER MAY STILL BE ABOUT TO IMPORT.
   *
   * Like `parse_in_flight`, this is a statement about RIGHT NOW rather than
   * about the upload, so it is not stampable: stamping would settle the row
   * at this reader version having read nothing, and the first pass would
   * then never happen at all — which is the defect, moved rather than fixed.
   * An unparseable or absent `created_at` is treated as old, on the same side
   * as `parse_in_flight` treats an unparseable start: the alternative is a
   * row nothing will ever adopt.
   */
  if (status === 'uploaded') {
    const createdAt = Date.parse(String(upload?.created_at ?? ''));
    if (Number.isFinite(createdAt) && (now - createdAt) <= ABANDONED_UPLOAD_MS) {
      return 'upload_not_started';
    }
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
  return refusal !== null
    && refusal !== 'parse_in_flight'
    && refusal !== 'upload_not_started';
}
