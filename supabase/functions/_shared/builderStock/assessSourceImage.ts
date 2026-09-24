/**
 * Builder stock — running the marketplace display test over real bytes.
 *
 * The glue between the decoder and the decision, and the ONE place ingestion
 * calls. Every format reaches it: a Notion cover, a spreadsheet's embedded
 * media, a PDF's page raster, a DOCX hero, an HTML card's image, a linked
 * Drive package, a direct upload. They differ in how the bytes are found and
 * in nothing after that, which is why this takes bytes and knows nothing about
 * where they came from.
 *
 * IT IS ONLY EVER ASKED ABOUT A PRIMARY. An image the source did not designate
 * cannot be drawn on a card whatever it looks like, so measuring one would be
 * spending an inverse DCT to answer a question nobody asked.
 */
import { decodeThumbnailResult, imageHeaderPixels } from './sourceImageRaster.ts';
import { sha256Hex } from './rasterPng.ts';
import { readMarketingOverlay } from './marketingOverlay.pure.ts';
import {
  decideMarketplaceEligibility, marketplaceEligibilityDetail, unmeasured,
  type MarketplaceEligibility,
} from './marketplaceEligibility.pure.ts';
import { isPrimaryRole } from './sourceImageRole.pure.ts';
import { classifyThumbnail, type VisualKind } from './sourceImageVision.pure.ts';
import { MAX_KIND_CANDIDATES } from './documentRead.pure.ts';

/**
 * How many pictures of one document are worth looking at. Named once, in
 * `documentRead.pure.ts`, because the import's crossing bound counts the same
 * set — see `MAX_KIND_CANDIDATES`.
 */
const MAX_VISION_DECODES = MAX_KIND_CANDIDATES;

/**
 * The largest picture this module will decode INSIDE the invocation that is
 * walking a document, stated by its header before a byte of it is decoded.
 *
 * The invocation that reads a brochure has already paid for the fetch, the
 * page texts and the asset walk; the decode budget it has left is what the
 * two known survivors and the one known casualty bound. Measured on the live
 * library, 6 September 2026: Lot 516's 2000×1250 hero (2.5 MP, ~1 s of
 * decode beside a 10.6 MB document walk) settled in production; the Lumina
 * lots' 3556×2000 hero (7.1 MP, 3.1 s measured) killed the worker on every
 * attempt, five for five, and the rows never elected at all.
 *
 * WHAT SKIPPING COSTS, AND WHY IT IS THE RIGHT SIDE OF THE TRADE. A skipped
 * classification means the kind stays null — "nothing is known", the state
 * every reader already handles — so `mayLeadCard` passes the candidate and
 * the election's own dominance rules decide. The hazard is an oversized
 * floor plan leading a card unclassified; the measurement is that it does
 * not exist: across 269 rasters in 14 production brochures, all 28 above
 * four megapixels are photography (renders, banners, one 34.7 MP estate
 * poster), and every measured floor plan sits at or under about 1.2 MP
 * (538×556, 480×733, 1096×1128 class). Against that, the alternative is
 * what the Lumina lots lived: the worker dies, the whole row stays blank,
 * and the attempts budget burns down to a permanent refusal.
 *
 * The eligibility verdict for such a picture is NOT skipped — it is settled
 * by `settleMarketplaceEligibility`, which runs in an invocation of its own
 * with nothing else to pay for, through the coarse decode the raster module
 * provides. See `eligibilityDetailFor`.
 */
const MAX_INLINE_DECODE_PIXELS = 4_000_000;

/** Shared by both inline gates: is this picture too large to judge here? */
function oversizedForInlineDecode(bytes: Uint8Array): boolean {
  const pixels = imageHeaderPixels(bytes);
  return pixels !== null && pixels > MAX_INLINE_DECODE_PIXELS;
}

/**
 * Judge bytes the pipeline is about to store.
 *
 * NEVER THROWS AND NEVER FAILS OPEN. A decoder that cannot read a builder's
 * file must not fail their import — the bytes are stored, the provenance is
 * recorded and the role is unchanged — but it must not wave the picture
 * through either. An image that could not be measured comes back `pending`,
 * which the display rule treats as "not yet", and the eligibility version
 * brings it back for another look when the decoders grow.
 */
export async function assessMarketplaceEligibility(
  bytes: Uint8Array,
  /**
   * The role the SOURCE DOCUMENT gave this picture, where the caller holds
   * it. Spent on exactly one question — see `decideMarketplaceEligibility`'s
   * `coverDesignated` — and never on the strict pass, which is untouched by
   * what anything says a picture is.
   */
  storedRole?: unknown,
): Promise<MarketplaceEligibility> {
  try {
    const result = await decodeThumbnailResult(bytes);
    if (result.ok === false) {
      return unmeasured(
        result.reason === 'unsupported' ? 'decoder_unsupported' : 'decoder_failed');
    }
    return decideMarketplaceEligibility(
      readMarketingOverlay(result.thumbnail),
      storedRole === undefined ? false : isPrimaryRole(storedRole));
  } catch {
    return unmeasured('decoder_failed');
  }
}

/**
 * The `source_detail` keys to merge into a row being written, for an image
 * whose role is already known.
 *
 * A non-primary image is not measured and carries no decision: it was never a
 * candidate, and recording a display verdict for it would suggest it was.
 *
 * AN OVERSIZED PRIMARY IS NOT MEASURED HERE EITHER — and that is a deferral,
 * never a verdict. This runs inside the invocation that is already walking
 * the document (see `MAX_INLINE_DECODE_PIXELS`), so for a picture past that
 * bound it writes nothing: the row goes out with no eligibility keys, which
 * is exactly the state `needsEligibilityAssessment` exists to find, and the
 * sweep judges the same bytes in an invocation with nothing else on its
 * clock. The card shows nothing until that verdict lands, which is the
 * display rule's ordinary "not yet" — never a fail-open.
 */
export async function eligibilityDetailFor(
  bytes: Uint8Array,
  role: unknown,
): Promise<Record<string, unknown>> {
  if (!isPrimaryRole(role)) return {};
  if (oversizedForInlineDecode(bytes)) return {};
  // The verdict names the bytes it judged, so a later re-store of different
  // bytes cannot inherit it — see `marketplaceEligibilityDetail`.
  return marketplaceEligibilityDetail(
    await assessMarketplaceEligibility(bytes, role), await sha256Hex(bytes));
}

/**
 * Would `eligibilityDetailFor` DECODE these bytes to judge them?
 *
 * Exactly its own two tests, in its own order, so a caller that has to count
 * the decodes an invocation spends counts the ones that happen and no others:
 * a picture the source did not designate is never measured, and one too large
 * to measure inline is left to the sweep.
 */
export function eligibilityDecodes(bytes: Uint8Array, role: unknown): boolean {
  return isPrimaryRole(role) && !oversizedForInlineDecode(bytes);
}

/**
 * How many pixels `eligibilityDetailFor` would decode for these bytes, read
 * from the HEADER — nothing is decoded to answer it. Zero where it would not
 * decode at all, by `eligibilityDecodes`' own tests. A header that states no
 * size is priced as the largest picture that may be judged inline, because
 * that is the most the decode it stands for can cost here.
 */
export function eligibilityDecodePixels(bytes: Uint8Array, role: unknown): number {
  if (!eligibilityDecodes(bytes, role)) return 0;
  return imageHeaderPixels(bytes) ?? MAX_INLINE_DECODE_PIXELS;
}

type RoleDecodeCandidate = {
  bytes?: Uint8Array | null;
  placement?: { placementsOnPage?: number; pagesDrawnOn?: number } | null;
  /**
   * What an EARLIER isolate already found this picture to be, carried in with
   * it — see `documentRead.pure.ts`. `undefined` means nobody has decoded it
   * yet; `null` is a decoded answer of "nothing is known", which is a result
   * and must never be decoded again.
   */
  visualKind?: VisualKind | null;
};

/**
 * Would `documentVisualKinds` decode this picture? One predicate, so the
 * estimate below and the decode it estimates can never come to disagree about
 * which pictures they mean.
 */
function decodedForItsKind(entry: RoleDecodeCandidate): boolean {
  const placement = entry.placement;
  // The same elimination `selectCoverHero` applies. Anything it drops is a
  // decode nobody would have read.
  if (placement && ((placement.placementsOnPage ?? 1) > 1 || (placement.pagesDrawnOn ?? 1) > 1)) {
    return false;
  }
  const bytes = entry.bytes;
  if (!bytes?.length) return false;
  return !oversizedForInlineDecode(bytes);
}

/**
 * How many pixels `documentVisualKinds` would decode for these pictures,
 * read from their HEADERS — nothing is decoded to answer it.
 *
 * It exists because the decode is one step with no gate inside it: the whole
 * set is classified or none of it is, since roles decided on part of the set
 * are decided on partial evidence. A step that size has to be priced BEFORE it
 * begins, and measured 23 September 2026 it was not: `stress-multi-property`
 * spent 4,854 ms here in one unguarded pass, past the importer's whole
 * allowance, after the document had already been read. A header that cannot
 * be read is charged as the largest picture decoded inline, because an
 * estimate that errs low is the one that kills the worker.
 */
export function documentVisualKindsPixels(
  media: ReadonlyArray<RoleDecodeCandidate>,
  limit = MAX_VISION_DECODES,
): number {
  return visualKindCandidates(media, limit)
    // A picture that arrives with its kind is not decoded (see
    // `documentVisualKinds`), so it costs nothing and is priced at nothing —
    // otherwise the isolate that attaches a read whose kinds were learned
    // elsewhere would be refused the very decode it no longer has to make.
    .filter((index) => media[index].visualKind === undefined)
    .reduce((pixels, index) => pixels + visualKindPixels(media[index]), 0);
}

/**
 * WHICH pictures `documentVisualKinds` decodes, in the order it decodes them.
 *
 * The cap counts CANDIDATES, not successful decodes, so the set is fixed by
 * the document alone — which is what lets the decoding be spread over several
 * isolates and still describe exactly the pictures one pass would have: every
 * isolate computes this same list from the same bytes.
 */
export function visualKindCandidates(
  media: ReadonlyArray<RoleDecodeCandidate>,
  limit = MAX_VISION_DECODES,
): number[] {
  const candidates: number[] = [];
  for (const [index, entry] of media.entries()) {
    if (candidates.length >= limit) break;
    if (!decodedForItsKind(entry)) continue;
    candidates.push(index);
  }
  return candidates;
}

/**
 * What deciding ONE picture's kind decodes, read from its header. An
 * unreadable header is charged as the largest picture decoded inline, because
 * an estimate that errs low is the one that kills the worker.
 */
export function visualKindPixels(entry: RoleDecodeCandidate): number {
  return imageHeaderPixels(entry.bytes as Uint8Array) ?? MAX_INLINE_DECODE_PIXELS;
}

/**
 * One picture's kind: the single decode `documentVisualKinds` is made of.
 *
 * Never throws. A picture that could not be read is null — "nothing is known"
 * — and that null is an ANSWER: a caller that stores it must never decode the
 * same bytes again to reach it a second time.
 */
export async function classifyVisualKind(bytes: Uint8Array): Promise<VisualKind | null> {
  try {
    const result = await decodeThumbnailResult(bytes);
    if (result.ok === false) return null;
    return classifyThumbnail(result.thumbnail)?.kind ?? null;
  } catch {
    // Nothing is known about this picture; that is not a finding about it.
    return null;
  }
}

/**
 * What each of a document's pictures IS, for the ones that could lead a card.
 *
 * BOUNDED ON PURPOSE, THREE TIMES OVER. Decoding is the most expensive thing
 * this pipeline does — a single redundant decode of one 1819×1223 JPEG killed
 * the settler on five consecutive attempts — so this never reads the whole
 * document. It reads only pictures that could actually be elected: a raster
 * the page repeats, or that another page also draws, is eliminated by
 * `selectCoverHero` before its pixels could matter; there is a hard cap
 * beyond that; and a picture whose own header states more pixels than the
 * inline budget affords is not decoded at all — see
 * `MAX_INLINE_DECODE_PIXELS` for the measurement and the trade.
 *
 * Never throws. A picture that could not be read comes back null, which every
 * reader treats as "nothing is known" — the state before this existed.
 *
 * AND A PICTURE THAT ARRIVES ALREADY CLASSIFIED IS NOT DECODED AGAIN. Its kind
 * was reached by this same function's own step, `classifyVisualKind`, over the
 * same bytes in an earlier isolate — see `documentRead.pure.ts` — so reusing
 * it changes nothing about the answer and everything about where the CPU is
 * spent. It still occupies its place among the candidates, so the cap cannot
 * reach a picture one uninterrupted pass would not have reached.
 */
export async function documentVisualKinds(
  media: ReadonlyArray<RoleDecodeCandidate>,
  limit = MAX_VISION_DECODES,
): Promise<Array<VisualKind | null>> {
  const kinds: Array<VisualKind | null> = media.map(() => null);
  for (const index of visualKindCandidates(media, limit)) {
    const entry = media[index];
    kinds[index] = entry.visualKind !== undefined
      ? entry.visualKind
      : await classifyVisualKind(entry.bytes as Uint8Array);
  }
  return kinds;
}
