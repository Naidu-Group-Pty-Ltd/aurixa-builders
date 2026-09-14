/**
 * Builder stock — bringing the builder's OWN image inside.
 *
 * Stage 1 of the three-stage enrichment, and the only stage that can say
 * "this is the photograph the builder supplied for this property". Everything
 * here exists to keep that sentence true after the source has moved on:
 *
 *   THE BYTES ARE COPIED, THE LINK IS NOT KEPT. A Notion attachment resolves
 *   to a signed URL that expires within the hour, and a builder's own site
 *   reorganises. A marketplace card that depends on either shows a broken
 *   image to a client weeks later, so the bytes are fetched once, at import,
 *   and stored in the private `builder-stock-images` bucket. What is recorded
 *   against the row is the SOURCE's own identity — `attachment:<id>:<name>`,
 *   the page URL — never the temporary URL we happened to fetch through.
 *
 *   THE BYTES ARE CHECKED, NOT THE PROMISE. A content type is a claim by
 *   whoever served the file. `validateSourceImageBytes` reads the signature,
 *   which is why an HTML login wall served as `image/jpeg` is refused rather
 *   than stored and shown to a client.
 *
 * SSRF: every retrieval goes through `fetchStockSource` — the existing guard,
 * applied to the original URL and to every redirect hop, with no cookie, no
 * Authorization header, no Supabase credential and no builder session
 * attached. Notion's public image endpoint redirects to its CDN, which is
 * exactly why the guard has to run per hop rather than once.
 */
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import {
  MAX_SOURCE_IMAGE_BYTES, sourceImageObjectPath, validateSourceImageBytes,
  type SourceImageAsset,
} from './sourceAssets.pure.ts';
import { eligibilityDetailFor } from './assessSourceImage.ts';
import { roleDetail } from './sourceImageRole.pure.ts';
import { sanitizationCarryForward } from './sanitizedDerivative.pure.ts';
import { sha256Hex } from './rasterPng.ts';
import {
  classifyPrimaryImageStanding, type DisplayableImage, type PrimaryImageStanding,
} from './primaryImage.ts';

/**
 * Bumped when what we record about an image's origin changes.
 *
 * A row written before provenance was recorded cannot prove where its picture
 * came from, so the repair re-derives it rather than trusting the label.
 *
 * 3 adds the IMAGE ROLE. Versions 1 and 2 proved where the bytes came from and
 * said nothing about what the source presented them as, which is how a bedroom
 * render came to be a property's card image. Every version-2 row is therefore
 * unproven for display purposes and is re-derived rather than trusted — which
 * is the behaviour this constant already had, applied to a second fact.
 *
 * 4 changes the REFERENCE, which is what a row is KEYED on. A page's resource
 * name is not unique across the forms that draw it, so `page3:Im0` could be two
 * different pictures and the second silently replaced the first; references now
 * carry the object number. A version-3 row keyed the old way can never match
 * the new one, and the re-audit is deliberately forbidden from demoting a row
 * already at the current version — so it would sit there ready and displayable
 * for ever beside its replacement. Bumping is what retires it.
 *
 * 5 changes what the package reader can IDENTIFY, and every negative version 4
 * banked is therefore stale by definition. Two capabilities changed. A page now
 * states a property's identity when it names the lot, contradicts no other lot
 * and names the design — rather than when it repeats every one of the label's
 * first eight tokens, which required the builder's document to word an address
 * exactly as the stock list does and refused twenty-five live properties whose
 * own package cover names them plainly. And a document whose pages carry no
 * extractable text is now operationally unreadable rather than a finished "this
 * names no image", because a reader that read nothing has learned nothing.
 *
 * 6 changes what the package reader can IDENTIFY again, in the one way that
 * mattered most. A property's cover page was resolved as "exactly one
 * qualifying page or no image", and a builder package is a cover page AND a
 * floor plan, both repeating the lot header and the price strip — so both
 * qualified and the whole document was refused. Measured on the live stock
 * list the morning this was found: 281 documents opened, 20 images taken, 94
 * properties holding 28 photographs. `resolvePropertyCover` now reads the page
 * stating the MOST of the package as the cover, which recovered five of ten
 * sampled brochures with every recovered image inspected and correct.
 *
 * Every negative banked at 5 was therefore decided by a reader that could not
 * see a two-page package at all, and is stale by definition.
 *
 * 7 changes which HOSTS the package reader can open at all. Every link that
 * was not Google Drive was refused at the front door — "That package is not
 * on a source we can read" — before anything was fetched, and the refusal was
 * banked as a finished `no_deterministic_image`. On the live stock list that
 * was every one of its thirteen brochures: Dropbox shared links, each serving
 * the actual PDF (measured: 5–8 MB, `%PDF-`) once asked for the FILE rather
 * than the viewer via the `dl=1` parameter Dropbox itself publishes. A direct
 * document link on an ordinary host now goes through the same guarded fetch
 * and the same cover-identification path a Drive direct link does. Every
 * negative banked at 6 for a non-Drive branch was therefore decided by a
 * reader that never fetched anything, and is stale by definition.
 *
 * 8 changes what a negative MEANS, and what the reader can get out of a heavy
 * document. Two capabilities moved at once.
 *
 * A negative now says WHY it is negative. `no_deterministic_image` was written
 * by three different things — a document we read that names nothing, a package
 * that destroyed the worker twice, and a link that answered six times with
 * nothing readable — and only the first is knowledge about the property. Every
 * record banked at 7 or below is unclassified, so it cannot be trusted to
 * admit or withhold the online fallback and is stale by definition. See
 * `EvidenceExhaustion` and `suppliedEvidence.pure.ts`.
 *
 * And a heavy document is no longer decoded page by page before anything is
 * decided. Rasters are materialised for the pages the TEXT already implicates
 * — see `discoverPdfSourceAssets` — which is what a 13.2 MB, 23-page brochure
 * of 5334x3334 JPEGs needs in order to be read inside an edge worker at all.
 * Both live examples sat at `attempts: 2`, one tick from being retired.
 *
 * 9 changes what the reader can SEE and what it can AFFORD. Two capabilities.
 *
 * A locked-export Google Sheet's links are now read at all: a document whose
 * owner disabled download answers 401 to every `export?format=…` while
 * serving its rows, and its link targets are recovered from the one public
 * representation that carries them (`htmlview/sheet` — see
 * `googleSheetsHtmlGrid.pure.ts`), merged by the same content-proven
 * alignment as ever. And a heavy document no longer costs a full-buffer scan
 * PER PAGE: the object index is memoised (see `scanPdfObjects`), which took
 * the live 13.9 MB Mandalay brochure from ~5.9 s of parser CPU — a worker
 * kill on every attempt, retired operationally at 8 — to ~0.5 s. Every
 * operational retirement banked at 8 was decided under that cost and is
 * stale by definition.
 *
 * 10 widens what a cover page may CORROBORATE ITSELF with. The cover rule's
 * fourth test accepted only tokens of the row's display label, and that label
 * shows the suburb and hides the estate whenever a lot is present — while a
 * builder's own cover identifies a lot the way the estate's marketing does.
 * Measured live, 2 September 2026: the Watsons Reach brochure for lot 102
 * states "Lot 102 Watsons Reach Estate" beside its package price and was
 * refused for not saying "Diggers Rest". The row's own identity names —
 * `development_name`, `project_name` — now travel as hints for that one test
 * (see `stockIdentityHints` and `pageStatesIdentity`), so every
 * `not_identified` banked at 9 was judged under the narrower rule and is
 * stale by definition.
 *
 * 11 reads a lot number the way the PAGE typesets it. The same list's lot 103
 * brochure extracts its identity line as "2 1 Lot 10 3 Watsons Reach Estate"
 * — the exporter split the digits into runs — so the strict token reading saw
 * "Lot 10", failed the our-lot test and counted a foreign lot, and the
 * builder's own document was refused. A run of digit tokens after Lot/Unit is
 * now read fused as well as strictly (see `lotDesignationReadings`), so a
 * `not_identified` banked at 10 was judged under the split-blind reading and
 * is stale by definition.
 *
 * 12 reads the LIVE generation of an incrementally updated document. The
 * compressed-object recovery kept the FIRST copy of each object number, and
 * an incremental update appends revisions after the ones they replace — so
 * on the same lot 102 brochure (five generations, twenty-one object streams)
 * the walker served the STALE page dictionary, whose image map pointed at
 * the template's sample artwork (another design's floor plan, labelled
 * LOT 414) while the newest generation mapped the builder's real 1920x1080
 * facade render. Recovery is last-generation-wins now, agreeing with the raw
 * byte scan (see `recoverCompressedObjects`), so every negative banked at 11
 * against such a document was judged on the wrong generation's pictures and
 * is stale by definition.
 *
 * 13 lets a COVER STATE ITS HERO BY SIZE. `selectCoverHero` refused every
 * page presenting more than one unrepeated photograph, on the reasoning that
 * a page presenting a choice has not said which picture is the property's.
 * That is right where ownership is the question, and wrong where the page has
 * already answered by how it drew them. Measured, 3 September 2026, on a
 * builder's own single-property brochure uploaded as a stock list (LOT 1731,
 * Austin Estate, Lara): both photographs on page 1 were found, attributed and
 * stored — the facade render covering 47.5% of the page and the only other
 * 14.2% — and the property was told its own brochure presents no cover image.
 * A photograph the cover draws at least twice the page of any other is now
 * taken as the hero, in the document's own terms and with the geometry named
 * in the reason; comparable sizes still answer no image. Every negative
 * banked at 12 against such a document was judged before the page's own
 * emphasis was read.
 *
 * 14 LOOKS AT THE PICTURE, not only at what the page did with it. Version 13
 * elected the raster a cover draws largest, which is the page's own statement
 * of emphasis and is exactly as emphatic when what it leads with is the floor
 * plan. Measured live, 4 September 2026: lots 109 and 115 Palomino both drew
 * a green line drawing on the marketplace badged "Builder supplied", from the
 * Vanta 23 brochure whose page 1 gives the plan far more room than the
 * render; lot 116, same builder and estate, drew the house from the Nex 20
 * brochure. `selectCoverHero` now excludes a candidate whose pixels say
 * floor plan or graphic, borrowing the measured judgement in
 * `listingImageVision.pure.ts` rather than inventing a second one. Every
 * negative banked at 13 was reached without any visual information at all,
 * and every POSITIVE banked at 13 could be a plan — which is why this bump
 * matters more than its predecessors: it is the first that can withdraw a
 * picture as well as find one.
 *
 * 15 IS 14, ACTUALLY APPLIED. The gate 14 was raised for was wired into the
 * import path alone, and a reopen runs through the REPAIR path — so the v14
 * pass re-derived all 65 live properties, took forty minutes, and re-elected
 * every picture it had elected before. Lots 109 and 115 Palomino came back
 * still leading with `page1:Im3`, the floor plan, and lot 116 changed from
 * the house TO the plan, which is the two paths openly disagreeing. Both
 * paths classify now (#2480), and a package banked at 14 is skipped as
 * current, so the answers reached without looking have to be invalidated
 * before they can be re-asked. Nothing else changed.
 *
 * 16 CAN TELL A COLOURED PLAN FROM A PHOTOGRAPH. The v15 pass ran the gate
 * exactly as designed and still elected the plan, because the classifier
 * called it a photograph: a plan whose rooms are filled with colour measured
 * 0.301 colourful through the pipeline's own decoder, and the floorplan
 * rule's colour bound was 0.30 — one thousandth the wrong side. Measured, 5
 * September 2026, on the Palomino brochures themselves: both the Vanta 23
 * and Nex 20 covers carry the SAME two rasters (one house render, one green
 * plan — which is why one identical plan led five different cards), the plan
 * is the larger by 2.4x so size dominance elected it, and under the widened
 * bound the election flips to the render on both documents while the old
 * bound reproduces the defect byte for byte. The bound is a population
 * statement, not a tuning: no photograph in the labelled corpus exceeds
 * white 0.118 against the rule's 0.45 floor, so the widening admits no
 * photograph. Every verdict banked at 15 was reached with the misreading
 * classifier, so those answers too have to be invalidated before they can
 * be re-asked.
 *
 * 17 RE-ASKS THE QUESTIONS A SHARED ISOLATE ANSWERED FOR THE DOCUMENTS. The
 * v16 requeue drained 76 of 81 properties and stalled on the five rows of
 * one CSV upload whose images come from per-row linked brochures: the
 * settler's designed fan-out put five one-property invocations in one
 * isolate, five concurrent brochure decodes exceeded its memory ceiling,
 * and the worker died 546 every minute with no error written. Each of those
 * documents elects in under three seconds alone — measured through this
 * pipeline's own election on the fetched files — so the four
 * `package_recovery_attempt`s their branches accumulated are a fact about
 * the isolate, not about the documents, and at four the next pass would
 * retire readable brochures as unprocessable. `pdfDecodeSlot.pure.ts` now
 * serialises the heavy decode per isolate; this bump is the mechanism
 * `packageAttempt.pure.ts` names for starting the count again ("a bumped
 * extractor asks again from zero"). The classifier, the election and the
 * gate are exactly v16's, so a property already settled at 16 re-derives to
 * the same answer when it is next asked — and nothing requeues the settled
 * ones for this bump alone.
 *
 * 24 STOPS A ONE-PROPERTY BROCHURE BEING DISQUALIFIED BY THE LOTS IT MENTIONS.
 * `pageStatesIdentity`'s fourth test refuses a page that reads another lot's
 * number, and that test is what makes a MULTI-property package safe: in a
 * twelve-lot price list the page naming lot 32 is lot 32's page, and letting
 * lot 27's row take it would put another house on this card. In a document
 * that describes exactly ONE property the same reading carries no information
 * at all — a single-lot flyer still prints the estate's other lots in its
 * availability table, its comparison strip and its "also available" footer —
 * so the veto fires on every page and the row is told its own brochure names
 * no image. Measured, 11 September 2026: `LOT 27 - ZIMI - FLYER.pdf`, one
 * item, one page, its 556x634 raster extracted, stored and READY, refused for
 * the recorded reason "no page states this property's identity together with
 * its package information — its first page reads 'Lot 27 — LOT 32, 33, 34,'".
 * The page states lot 27. It is the only property in the document. The waiver
 * is therefore narrow by construction: it applies only where the package
 * holds one property, it removes only the other-lot test, and every other
 * corroboration a cover must pass is untouched — a multi-property document
 * re-derives to the same answer byte for byte, which a control in
 * `builderStockUploadedPackageIdentity.test.ts` asserts. Every
 * `not_identified` banked at 23 on a one-property package was judged under
 * the wider veto and is stale by definition.
 *
 * 23 LETS THE DESIGN REACH THE ELECTION AT ALL. v22 shipped two design-cover
 * rules, deployed cleanly, and changed nothing in production: Lots 502 and
 * 1004 were told again that their own brochures name no image, one minute
 * before Lot 58 elected its cover correctly on the same build. The split was
 * the clue — every property-cover election worked, every design-cover
 * election refused — and the cause is older than all of it. The settler read
 * the design from `record.source_row.house_design`, while the value it is
 * handed is the normalised record ITSELF (`storedSourceRows` unwraps the
 * column before returning it), so the read answered undefined every time and
 * the design never reached `assignPdfMediaRoles`. The whole design-cover
 * path had therefore produced ZERO images since the day it was built: 438
 * primary images across the live database at evidence levels 1, 2 and 3, and
 * not one at level 4. Null is also the honest answer for a row that states no
 * design, which is why nothing ever reported it. The two shapes are now read
 * by one shared function (`designOfRecordOrRow`), the same lesson
 * `storedRowDevelopmentUnitKey` records in its own header, and this bump is
 * what re-asks the branches banked against v22 — a negative recorded at the
 * current version stands, so a fix without a bump would never be tried.
 *
 * 22 READS WHAT THE OLD READER COULD NOT AFFORD, AND WHAT IT WOULD NOT SEE.
 * Three changes, measured on the four rows the fleet still refused. The
 * Lumina brochures elect one 3556x2000 JPEG whose decode alone costs 3.1 s —
 * past the worker's ~3 s kill — so a picture whose header states more than
 * four megapixels is no longer decoded inside the invocation that walks the
 * document (its kind stays unknown; its eligibility is settled by the sweep
 * through the new block-resolution JPEG reading, ~0.9 s for the same
 * thumbnail), and lots 55 and 58 elect in about a second. Lot 1004 Five
 * Farms links a per-design brochure whose page 1 states every token of
 * "Enzo 10.5" with three package facts and designates Lot 1002 — the
 * builder's specimen lot — and the design-cover rule refused any page naming
 * a lot; the page names the design itself, so it now qualifies (its lot may
 * lend no token to the design's name, and a lot-less design page still
 * outranks it). And Lot 502 Mambourin's document designates the lot's own
 * photo-less floor-plan page as the property cover, which then vetoed the
 * design cover with the render standing beside it: the design page is now
 * consulted whenever the property's own paths ELECTED nothing, not merely
 * where they found nothing. Every election that succeeded at 21 re-derives
 * to the same answer — re-run on the live library's own documents — so the
 * bump reopens only what was refused.
 *
 * 21 STOPS PAYING FOR AN ELECTION ALREADY DECIDED. A document whose text
 * names no candidate page cannot elect a primary — `coverSearchPages` is a
 * superset of every page the role decision can designate — and the election
 * nevertheless sent it through the full-document walk: materialising,
 * flattening and classifying pictures whose only fate was the refusal
 * already decided. On Lot 709 Verve's 13-page brochure that waste was ~2.6 s
 * of a ~2.9 s recovery, the worker died inside it on every attempt — before
 * any wall-clock deadline could answer for it — and the v20 budget burned to
 * nothing exactly as 19's had. The same document now refuses honestly in
 * ~0.3 s, and the count starts again for attempts that can finally finish.
 *
 * 20 IS 19 WITH THE DEADLINE ACTUALLY IN FRONT OF THE QUESTION. Lot 709
 * Verve's branch spent its four v19 attempts in the minutes between the
 * recovery deadline merging and the fleet serving it — every one a
 * pre-deadline hang the reaper ended, none an answer about the document.
 * The deadline is live now, so the count starts again for a question that
 * can finally be answered for. Nothing else changes; only the affected row
 * is requeued.
 *
 * 19 ADMITS THE MODEST FACADE THE PIXEL FLOOR REFUSED. Measured, 6 September
 * 2026, on the Luxton Thornhill Gardens brochures: the designated cover page
 * draws the property's facade from a 480x339 JPEG at 17% of the page —
 * nearly three times the share floor, photographic detail — and the 600x400
 * pixel floor refused it, so lots 313 and 318 were told their own brochures
 * present no photograph while a person sees the house instantly. The floor
 * is 360x270 now; everything it was carrying is refused by the floors that
 * actually describe it (the icons and the logo lockup die on share, the
 * floor plan dies at the election on its own pixels), and every negative
 * banked at 18 against such a document was judged with the photograph
 * excluded before anything looked at it.
 *
 * 18 IS 17 FOR THE ATTEMPTS THE ORPHAN SPENT. The v17 budget did its job for
 * three of the five — 810 and 801 elected the house, 324 re-proved its own
 * picture — and was consumed whole on the two whose brochures carry one
 * truncated object stream each: `pump` left a rejected promise unhandled on
 * exactly that input, the isolate died with no catchable throw and no error
 * written, and four fresh attempts per branch were spent proving nothing
 * about the documents. The orphan is fixed in `rasterPng.ts` (the same
 * document elects its cover in under five seconds through the fixed path),
 * so the count starts again for a worker that can finally survive the
 * question. Nothing else changes and nothing requeues for this bump alone —
 * the two affected properties are requeued by hand after deploy.
 *
 * This is the bump doing precisely the job it exists for: `negativeProvenance`
 * compares the stored version against this one, so raising it reopens every
 * banked negative for a reader that can now find what the old one could not.
 */
export { PROVENANCE_VERSION } from './provenanceVersion.pure.ts';
import { PROVENANCE_VERSION } from './provenanceVersion.pure.ts';

/** What a retrieval produced. Injected in tests; the default is the guard. */
export interface FetchedImage {
  bytes: Uint8Array;
  /** After redirects. Recorded for diagnosis, never as product data. */
  finalUrl: string;
}

export type SourceImageFetcher = (url: string) => Promise<FetchedImage>;

/**
 * The production fetcher, imported lazily.
 *
 * `fetchSource.ts` reaches for `Deno.resolveDns`, so a static import would
 * make this module unloadable outside the edge runtime — including by the
 * tests that pin the attribution rules. The guard is still the only thing
 * production ever uses.
 */
const guardedFetch: SourceImageFetcher = async (url: string) => {
  const { fetchStockSource } = await import('./fetchSource.ts');
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

export interface AttachOutcome {
  stored: number;
  failed: number;
  /** Server-side only: one line per asset we could not bring inside. */
  problems: Array<{ reference: string; reason: string }>;
}

/**
 * What a re-store of these exact bytes must put back on the row.
 *
 * THE IO HALF of `sanitizationCarryForward`, which holds the rule. Every store
 * path upserts a FRESH `source_detail` on
 * `(stock_item_id, source_stage, source_reference)`, so without this a
 * re-import destroys a repair that is still a repair of exactly the bytes
 * being written — see that function's header for what that cost.
 *
 * ONE ROW, READ BY THE CONFLICT KEY the upsert is about to use, so the record
 * carried forward is the one belonging to the row being replaced and never a
 * sibling's. A read that fails carries NOTHING, which is the same outcome the
 * defect already produced and is never worse than it: a lost repair costs a
 * blank card and another repair, while a wrongly carried one puts a stale
 * picture in front of a client.
 *
 * It is exported so every store path asks the same question. The alternative —
 * each site reading the row its own way — is how three of them came to disagree
 * about which keys they owned.
 */
export async function carriedSanitizationFor(
  db: any,
  input: {
    stockItemId: string;
    sourceStage: string;
    reference: string;
    storedSha256: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!input.storedSha256) return {};
  try {
    const { data, error } = await db.from('builder_stock_item_images')
      .select('source_detail')
      .eq('stock_item_id', input.stockItemId)
      .eq('source_stage', input.sourceStage)
      .eq('source_reference', input.reference)
      .limit(1);
    if (error) return {};
    const detail = (data as Array<{ source_detail?: Record<string, unknown> | null }> | null)
      ?.[0]?.source_detail;
    return sanitizationCarryForward(detail ?? null, input.storedSha256);
  } catch {
    return {};
  }
}

/**
 * Fetch, validate, store and record one property's source-supplied imagery.
 *
 * `stockItemId` is resolved by the caller from the source's own statement of
 * which row owns the asset. Nothing in here matches, guesses or reorders.
 */
export async function storeSourceImages(
  db: any,
  input: {
    organisationId: string;
    uploadId: string | null;
    stockItemId: string;
    assets: SourceImageAsset[];
  },
  deps: { fetchImage?: SourceImageFetcher } = {},
): Promise<AttachOutcome> {
  const fetchImage = deps.fetchImage ?? guardedFetch;
  const outcome: AttachOutcome = { stored: 0, failed: 0, problems: [] };

  for (const asset of input.assets) {
    const reference = asset.reference.slice(0, 400);
    try {
      const { bytes, finalUrl } = await fetchImage(asset.url);
      if (bytes.length > MAX_SOURCE_IMAGE_BYTES) {
        throw new Error('That image is larger than the 10 MB limit.');
      }
      const check = validateSourceImageBytes(bytes);
      if (check.ok !== true) throw new Error(check.reason);

      const path = sourceImageObjectPath(
        input.organisationId, input.stockItemId, reference, check.extension);
      const { error: uploadError } = await db.storage
        .from(STOCK_IMAGE_BUCKET)
        .upload(path, bytes, { contentType: check.contentType, upsert: true });
      if (uploadError) throw uploadError;

      const storedSha = await sha256Hex(bytes);
      // What the sanitization stage already established about these exact
      // bytes. Read BEFORE the upsert replaces the column. See
      // `carriedSanitizationFor`.
      const carried = await carriedSanitizationFor(db, {
        stockItemId: input.stockItemId,
        sourceStage: 'uploaded_document',
        reference,
        storedSha256: storedSha,
      });

      await db.from('builder_stock_item_images').upsert({
        stock_item_id: input.stockItemId,
        upload_id: input.uploadId,
        organisation_id: input.organisationId,
        source_stage: 'uploaded_document',
        source_reference: reference,
        source_provider: asset.provider,
        source_page_url: asset.pageUrl,
        storage_bucket: STOCK_IMAGE_BUCKET,
        storage_path: path,
        // The stored copy is what the marketplace serves. The URL we fetched
        // through is deliberately NOT kept as `external_url`: it expires, and
        // a card that falls back to it would break silently.
        external_url: null,
        content_type: check.contentType,
        byte_size: bytes.length,
        verification_status: 'source_supplied',
        confidence: 1,
        processing_status: 'ready',
        error_message: null,
        position: asset.position,
        source_detail: {
          origin: asset.origin,
          // What the SOURCE presented this image as, and on what evidence.
          // Without it "source_supplied" says only that the bytes are the
          // builder's, which was never the question a card asks.
          ...roleDetail(asset.role),
          fetched_from_host: hostOf(finalUrl),
          snapshotted: true,
          // The bytes are stored exactly as the source served them, so one
          // hash answers both "what did the builder supply" and "what are we
          // serving".
          source_sha256: storedSha,
          stored_sha256: storedSha,
          extraction_method: 'downloaded_asset',
          transformation: null,
          provenance_version: PROVENANCE_VERSION,
          // Whether the marketplace may DRAW it, which is a different
          // question from every other one recorded here. See
          // `marketplaceEligibility.pure.ts`.
          ...await eligibilityDetailFor(bytes, asset.role.role),
          // Last, so a re-store cannot lose what another stage established
          // about these exact bytes — and only ever the keys that stage owns.
          ...carried,
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' });

      outcome.stored += 1;
    } catch (error) {
      const reason = String((error as { safeMessage?: string; message?: string })?.safeMessage
        ?? (error as { message?: string })?.message ?? error).slice(0, 300);
      outcome.failed += 1;
      outcome.problems.push({ reference, reason });

      /**
       * Recorded rather than dropped, and NEVER as something displayable.
       *
       * A link we could not fetch is a picture whose bytes we do not hold and
       * cannot hash, so it cannot be shown as the builder's exact image — the
       * URL is kept for the audit trail and the stage stays `failed`, which
       * leaves the card in its no-image state rather than hot-linking
       * somebody else's server and calling it provenance.
       */
      await db.from('builder_stock_item_images').upsert({
        stock_item_id: input.stockItemId,
        upload_id: input.uploadId,
        organisation_id: input.organisationId,
        source_stage: 'uploaded_document',
        source_reference: reference,
        source_provider: asset.provider,
        source_page_url: asset.pageUrl,
        external_url: asset.url.slice(0, 1500),
        verification_status: 'source_supplied',
        confidence: null,
        processing_status: 'failed',
        error_message: reason,
        position: asset.position,
        source_detail: {
          origin: asset.origin,
          ...roleDetail(asset.role),
          snapshotted: false,
          provenance_version: PROVENANCE_VERSION,
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' }).then(
        () => undefined,
        () => undefined,
      );
    }
  }

  return outcome;
}

/**
 * Store bytes we already hold as this property's source-supplied image.
 *
 * The same row shape and the same bucket as a fetched asset — the difference
 * is only where the bytes came from. Used for an image taken out of the row's
 * own package document, which has no URL of its own to record.
 */
export async function storeSourceImageBytes(
  db: any,
  input: {
    organisationId: string;
    uploadId: string | null;
    stockItemId: string;
    bytes: Uint8Array;
    contentType: string;
    /** Names the document and page the image came out of. */
    reference: string;
    provider: string;
    origin: string;
    pageUrl: string | null;
    position: number;
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  const check = validateSourceImageBytes(input.bytes);
  if (check.ok !== true) return false;

  const reference = input.reference.slice(0, 400);
  const path = sourceImageObjectPath(
    input.organisationId, input.stockItemId, reference, check.extension);

  const { error: uploadError } = await db.storage
    .from(STOCK_IMAGE_BUCKET)
    .upload(path, input.bytes, { contentType: check.contentType, upsert: true });
  if (uploadError) return false;

  /*
   * The caller records the hash inside `detail`, so that is the one the
   * sanitization record has to match — read it from there rather than hashing
   * again, or a caller whose bytes and stated hash disagree would carry
   * forward a repair of something else.
   */
  const carried = await carriedSanitizationFor(db, {
    stockItemId: input.stockItemId,
    sourceStage: 'uploaded_document',
    reference,
    storedSha256: typeof (input.detail ?? {}).stored_sha256 === 'string'
      ? String((input.detail ?? {}).stored_sha256) : null,
  });

  await db.from('builder_stock_item_images').upsert({
    stock_item_id: input.stockItemId,
    upload_id: input.uploadId,
    organisation_id: input.organisationId,
    source_stage: 'uploaded_document',
    source_reference: reference,
    source_provider: input.provider,
    source_page_url: input.pageUrl,
    storage_bucket: STOCK_IMAGE_BUCKET,
    storage_path: path,
    external_url: null,
    content_type: check.contentType,
    byte_size: input.bytes.length,
    verification_status: 'source_supplied',
    confidence: 1,
    processing_status: 'ready',
    error_message: null,
    position: input.position,
    source_detail: {
      origin: input.origin,
      snapshotted: true,
      provenance_version: PROVENANCE_VERSION,
      ...(input.detail ?? {}),
      ...await eligibilityDetailFor(input.bytes, (input.detail ?? {}).role),
      // Last, so a re-store cannot lose what another stage established about
      // these exact bytes — and only ever the keys that stage owns.
      ...carried,
    },
  }, { onConflict: 'stock_item_id,source_stage,source_reference' });

  return true;
}

/**
 * Demote a stage-1 row that this run could NOT prove belongs to the property.
 *
 * The row is kept — audit history is never deleted — but it stops being
 * something the marketplace may show, because the only images allowed on a
 * Builder Stock card are ones whose source we can point at.
 */
export async function demoteUnprovenSourceImage(
  db: any,
  input: { stockItemId: string; imageId: string; reason: string },
): Promise<void> {
  await db.from('builder_stock_item_images')
    .update({
      processing_status: 'unavailable',
      error_message: input.reason,
    })
    .eq('id', input.imageId)
    .eq('stock_item_id', input.stockItemId);
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Does this property already hold a usable image the source supplied?
 *
 * Asked before stages 2 and 3 run. A property whose builder gave us a render
 * has nothing to gain from a Street View of the same lot, and every provider
 * call is billed to somebody.
 */
export async function hasReadySourceImage(
  db: any,
  stockItemId: string,
  /** Only count a row whose origin is recorded to at least this standard. */
  minimumProvenanceVersion = 0,
): Promise<boolean> {
  const { data } = await db
    .from('builder_stock_item_images')
    .select('id, storage_path, external_url, source_detail')
    .eq('stock_item_id', stockItemId)
    .eq('source_stage', 'uploaded_document')
    .eq('processing_status', 'ready')
    .limit(20);
  return (data ?? []).some((row: any) =>
    (row.storage_path || row.external_url)
    && Number((row.source_detail ?? {}).provenance_version ?? 0) >= minimumProvenanceVersion);
}

/**
 * The same reading, answering three questions instead of one.
 *
 * `ready` is exactly what `hasReadySourceImage` answers, from the same query;
 * `clean` and `convictedOnly` are what the source repair needs to know before
 * it lets a stored image END the search — a promotional page cover is a ready
 * image and is still not a reason to stop reading the property's own package.
 * See `classifyPrimaryImageStanding` for the rules; this only fetches the rows.
 */
export async function readPrimaryImageStanding(
  db: any,
  stockItemId: string,
  minimumProvenanceVersion = 0,
): Promise<PrimaryImageStanding> {
  const { data } = await db
    .from('builder_stock_item_images')
    .select('id, storage_path, external_url, verification_status, source_detail')
    .eq('stock_item_id', stockItemId)
    .eq('source_stage', 'uploaded_document')
    .eq('processing_status', 'ready')
    .limit(20);
  return classifyPrimaryImageStanding(
    (data ?? []) as DisplayableImage[], minimumProvenanceVersion);
}
