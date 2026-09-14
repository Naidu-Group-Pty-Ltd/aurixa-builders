/**
 * Builder stock — which image the marketplace card shows.
 *
 * ONE RULE, AND IT IS NOT A RANKING.
 *
 *   A Builder Stock property may display the image the BUILDER SUPPLIED, or no
 *   image at all.
 *
 * Nothing else qualifies. Not a Street View of the street, not a satellite
 * still of the lot, not a search result that might be the development — none
 * of them is a photograph of the property, and a card that shows one is
 * telling a client something untrue about a house they are being asked to buy.
 * The honest alternative to a builder's photograph is an empty frame, so an
 * empty frame is what the card gets.
 *
 * WHAT THIS REPLACES. The earlier rule was a priority list: source-supplied
 * first, then `google_maps`, then `internet_search`. It meant every property
 * whose builder gave us nothing still showed a picture — badged "Location
 * imagery", which reads as a photograph of the property to everyone who is not
 * reading the badge.
 *
 * The other two stages are still WRITTEN. They are provenance, they are how a
 * support question about a missing image gets answered, and the three-stage
 * schema is unchanged. They are simply never chosen.
 *
 * It lives apart from `images.ts` so it can be exercised directly: `images.ts`
 * reaches for Google and Perplexity and cannot be loaded outside the edge
 * runtime, and a rule nothing can test is a rule that drifts.
 */
import {
  comparePrimaryEvidence, isPrimaryRole, readStoredEvidenceLevel, readStoredRole,
} from './sourceImageRole.pure.ts';
import {
  isMarketplaceEligible, needsEligibilityAssessment, readMarketplaceState, sweepWillJudge,
} from './marketplaceEligibility.pure.ts';
import {
  servableClearanceFor, servableDerivativeFor, type SanitizedDerivative,
} from './sanitizedDerivative.pure.ts';
import { PROCESSED_LIFECYCLE } from './stockLifecycle.pure.ts';
import { readAllRows } from './pagedRead.ts';

/** The stage whose provenance is the builder's own document. */
export const SOURCE_SUPPLIED_STAGE = 'uploaded_document';
/** And the only verification that means "the builder gave us this". */
export const SOURCE_SUPPLIED_VERIFICATION = 'source_supplied';

/** The shape the rule needs. Anything else about an image is irrelevant here. */
export interface DisplayableImage {
  id: string;
  source_stage: string;
  verification_status?: string | null;
  processing_status?: string | null;
  position?: number | null;
  storage_path?: string | null;
  external_url?: string | null;
  /** Carries `role`: what the SOURCE presented this image as. */
  source_detail?: Record<string, unknown> | null;
}

/**
 * May this image be shown on a Builder Stock card?
 *
 * FIVE conditions, every time: the builder's own stage, the verification that
 * says so, a stage that actually completed, bytes to serve — and the role the
 * source gave it.
 *
 * THE ROLE IS THE ONE THAT WAS MISSING, and its absence is the whole defect.
 * The first four say "these exact bytes came out of the builder's source",
 * which was true of the bedroom render that Lot 537 Kirramingly Avenue showed
 * on its card. Only the fifth says "and the source presented this image as THIS
 * property's listing image", which was not true of it and is the only thing
 * that makes the badge "Builder supplied" mean what a client reads it to mean.
 *
 * An image with no recorded role is `unknown`, and `unknown` is never
 * displayable — including every row written before roles existed. Those are
 * demoted and re-derived by `reprocess_source_images` rather than trusted.
 */
export function isDisplayableSourceImage(image: DisplayableImage): boolean {
  return image.source_stage === SOURCE_SUPPLIED_STAGE
    && image.verification_status === SOURCE_SUPPLIED_VERIFICATION
    && image.processing_status === 'ready'
    && !!(image.storage_path || image.external_url)
    && isPrimaryRole(readStoredRole(image.source_detail))
    // And the sixth: the source designating it is not the same as it being a
    // picture to draw. A facade under a "$25,000 Rebate" ribbon passes all
    // five above. See `marketplaceEligibility.pure.ts`.
    //
    // OR THE SAME PHOTOGRAPH WITH THE RIBBON TAKEN OFF. A servable derivative
    // is that image's own pixels with the laid-over graphic removed and the
    // result re-measured by the same classifier that refused the original — so
    // it satisfies the display rule rather than bypassing it. It is NOT another
    // image: the record names the exact original by id and by SHA-256, and a
    // row whose object has since changed stops resolving one. See
    // `sanitizedDerivative.pure.ts`.
    //
    // OR THE SAME PHOTOGRAPH WITH NOTHING WRONG WITH IT. A clearance is the
    // precise inspection's finding that the coarse classifier convicted this
    // picture for a feature of the HOUSE — Lot 537 Kirramingly's white garage
    // door — and that there is no promotional treatment on it at all. It
    // serves the ORIGINAL, unaltered, because nothing needed changing. See
    // `overlayClearance.pure.ts`.
    && (isMarketplaceEligible(image.source_detail)
      || !!servableDerivativeFor(image.source_detail)
      || !!servableClearanceFor(image.source_detail));
}

/**
 * Does this image serve the builder's ORIGINAL bytes, untouched?
 *
 * True for a measured-clean picture and for one the precise inspection
 * CLEARED; false for one that reaches a card only through a sanitized
 * derivative — the same photograph with a promotional graphic rebuilt out of
 * it. The distinction matters to the ordering below and nowhere else: a
 * derivative is a legitimate card image, it is simply never a better one than
 * a clean file the builder actually supplied.
 */
export function servesCleanOriginal(image: DisplayableImage): boolean {
  return isMarketplaceEligible(image.source_detail)
    || !!servableClearanceFor(image.source_detail);
}

/**
 * The derivative whose object should be SIGNED for this image — or null,
 * meaning the original is the picture.
 *
 * One image row can carry both facts at once: a derivative made under an old
 * conviction, and an eligible verdict (or a clearance) reached since — a
 * better classifier re-judged the same bytes clean, or the precise inspection
 * cleared them. The signing endpoint used to prefer the derivative
 * unconditionally, which served a repaired copy of a photograph the platform
 * itself now judges clean; the builder's own file is always the better
 * picture where both stand. Ordering, never filtering: an image whose only
 * claim to a card IS its derivative still serves it, exactly as before.
 *
 * Lives beside `servesCleanOriginal` so the sort that prefers clean-original
 * ROWS and the signature that picks the clean-original OBJECT are one rule.
 */
export function derivativeToServe(image: DisplayableImage): SanitizedDerivative | null {
  return servesCleanOriginal(image) ? null : servableDerivativeFor(image.source_detail);
}

/**
 * The card's image, from a property's images. Null means "show no image".
 *
 * There is normally exactly one candidate, because at most one image per
 * property can carry `primary_property`. Where a source supplies MORE than
 * one, the strength of the source's own evidence decides first — see
 * `comparePrimaryEvidence`.
 *
 * THE CASE THAT ADDED THAT STEP. A builder keeps a marketing tile in the row's
 * page-cover slot: the property's own facade with "$25,000 Rebate", "VIC" and
 * "LARA" set over it in coloured pills, or "Completed" and "SMSF". It is exact
 * builder-supplied imagery of that exact property, so it is correctly
 * `primary_property` on LEVEL 3 — a structural container designating one
 * image. Where the same property ALSO carries the clean original in a field
 * the builder named for it, that is LEVEL 1, and the level is the only thing
 * that distinguishes them: same property, same provenance, same role. Ordering
 * by `position` picked whichever the reader enumerated first.
 *
 * ORDERING IS NOT WHAT REFUSES A MARKETING TILE — the display gate above is,
 * through `isMarketplaceEligible`. An earlier version of this rule kept the
 * tile whenever the source designated nothing better, and that was wrong: a
 * facade under a status ribbon is not a card image however impeccable its
 * provenance. Ordering only decides between candidates that have ALREADY
 * passed the gate.
 *
 * AND A CLEAN BUILDER ORIGINAL BEATS A CLEANED PROMOTIONAL DERIVATIVE. Both
 * pass the gate — that is settled above — but they are not the same kind of
 * picture: one is the exact file the builder supplied, the other is that file
 * with a graphic rebuilt out of it by this pipeline. Where the same property
 * holds both (a promotional page cover with its repair beside a clean render
 * recovered from the property's own package), the untouched original is the
 * one the card shows, and no repair should have been the deciding vote.
 * Ordering, never filtering: a property whose only displayable picture is a
 * derivative keeps it, exactly as before.
 *
 * `position` and then the id remain the tie-break, so re-running enrichment
 * cannot silently swap a card's picture.
 */
export function chooseDisplayableImage<T extends DisplayableImage>(images: T[]): T | null {
  const displayable = (images ?? []).filter(isDisplayableSourceImage);
  if (!displayable.length) return null;

  return [...displayable].sort((a, b) =>
    (servesCleanOriginal(a) ? 0 : 1) - (servesCleanOriginal(b) ? 0 : 1)
    || comparePrimaryEvidence(
      readStoredEvidenceLevel(a.source_detail), readStoredEvidenceLevel(b.source_detail))
    || (a.position ?? 0) - (b.position ?? 0)
    || String(a.id).localeCompare(String(b.id)))[0];
}

/**
 * What a property's stored stage-1 rows amount to, for the SOURCE repair.
 *
 * Three facts, and the third is the one the repair loop was missing:
 *
 *   `ready`          the property holds at least one usable source-supplied
 *                    image at the required provenance standard — the exact
 *                    test `hasReadySourceImage` has always made, unchanged.
 *   `clean`          at least one of its PRIMARY candidates serves the
 *                    builder's original untouched (measured clean, or cleared
 *                    by the precise inspection).
 *   `convictedOnly`  it has primary candidates and EVERY one of them was
 *                    measured and convicted as a promotional marketing tile.
 *                    Not "none is clean": a candidate still pending — an
 *                    unmeasured container, an uncertain faint pass — is
 *                    evidence that has not arrived, and nothing may be decided
 *                    on it.
 *
 * `convictedOnly` is what licenses the repair to keep reading the property's
 * OWN linked package after the row's cover has already been stored: a
 * promotional cover's mere existence must not end the search for the clean
 * render the same builder supplied for the same property. It licenses nothing
 * else — not another property's package, not a wider search, not a different
 * identity rule.
 */
export interface PrimaryImageStanding {
  ready: boolean;
  clean: boolean;
  convictedOnly: boolean;
}

export function classifyPrimaryImageStanding(
  images: DisplayableImage[],
  minimumProvenanceVersion = 0,
): PrimaryImageStanding {
  const standing: PrimaryImageStanding = { ready: false, clean: false, convictedOnly: false };

  let primaries = 0;
  let convicted = 0;
  for (const image of images ?? []) {
    const detail = image.source_detail ?? {};
    if (!(image.storage_path || image.external_url)) continue;
    if (Number((detail as { provenance_version?: unknown }).provenance_version ?? 0)
      < minimumProvenanceVersion) continue;
    standing.ready = true;

    if (image.verification_status !== SOURCE_SUPPLIED_VERIFICATION) continue;
    if (!isPrimaryRole(readStoredRole(detail))) continue;
    primaries += 1;
    if (servesCleanOriginal(image)) standing.clean = true;
    if (readMarketplaceState(detail) === 'ineligible'
      && (detail as { marketplace_rejection_reason?: unknown }).marketplace_rejection_reason
        === 'annotated_marketing_tile') {
      convicted += 1;
    }
  }

  standing.convictedOnly = primaries > 0 && convicted === primaries && !standing.clean;
  return standing;
}

/**
 * Settle a property's `primary_image_id`.
 *
 * Returns the id chosen, or null when the builder supplied nothing — and in
 * that case the column is CLEARED rather than left pointing at whatever it
 * pointed at before. A stale pointer to a Street View is the defect; leaving
 * it in place because "nothing new was found" would preserve it.
 */
export async function chooseAndStorePrimaryImage(
  db: any,
  stockItemId: string,
): Promise<string | null> {
  const { data: images } = await db
    .from('builder_stock_item_images')
    .select('id, source_stage, source_reference, error_message, verification_status, '
      + 'processing_status, position, storage_path, external_url, source_detail')
    .eq('stock_item_id', stockItemId);

  /*
   * THE PRIORITY, NOT THE SOURCE-ONLY RULE. `chooseCardImage` returns the
   * builder's own picture wherever there is one and only then considers a
   * verified web photograph or a Street View still — see
   * `imagePriority.pure.ts`, which is the one place that ranking lives.
   *
   * Imported lazily so this module stays importable by everything that only
   * needs the source rules; the two would otherwise import each other.
   */
  const { chooseCardImage, nextImageStage } = await import('./imagePriority.pure.ts');
  const rows = (images ?? []) as DisplayableImage[];
  const primary = chooseCardImage(rows);

  const patch: Record<string, unknown> = { primary_image_id: primary?.image.id ?? null };

  /*
   * A SETTLED PROPERTY THAT HAS LOST ITS PICTURE IS NOT SETTLED ANY MORE.
   *
   * `settled` means the ladder was climbed to the end. It is written from the
   * ladder's answer at ONE moment, and stage 1's answer can change afterwards:
   * a builder cover measured clean today is re-measured as a marketing tile
   * tomorrow, and the property that legitimately stopped at stage 1 now has
   * nothing to show and no way to ask for anything else. Measured in
   * production on two properties whose covers were refused eighteen hours
   * after they settled — both blank, both holding fallback rows that said the
   * ladder had been tried, and neither paid stage ever asked.
   *
   * So the stage is re-opened from the same reading that cleared the pointer:
   * this function is called after EVERY stage and after every re-judgement, so
   * it is the one place that sees the change at the moment it happens. It
   * re-opens only where the ladder itself says there is somewhere left to go —
   * a property that is genuinely out of stages stays settled and does not
   * re-enter the queue — and it never touches a property that has a picture.
   *
   * `image_work_next_attempt_at` is cleared to now so the re-opened property
   * is claimable on the next tick rather than serving out a backoff earned by
   * a question that is no longer the one being asked.
   */
  if (!primary) {
    const { data: item } = await db.from('builder_stock_items')
      .select('image_work_stage').eq('id', stockItemId).maybeSingle();
    /*
     * ONLY A SETTLED ONE. A property mid-ladder already has its own stage and
     * its own backoff, and writing from here would move it back from wherever
     * the claim had reached — the claim's progression is the authority while
     * it is still running.
     */
    if (item?.image_work_stage === 'settled') {
      const remaining = nextImageStage(rows, { sourceSettlementComplete: true });
      if (remaining !== 'none') {
        // `wait` means a verdict is genuinely owed, so the property goes back
        // to the stage that writes one rather than to the paid ladder.
        patch.image_work_stage = remaining === 'wait' ? 'eligibility' : 'fallback';
        patch.image_work_next_attempt_at = new Date().toISOString();
        patch.image_work_claim_until = null;
      }
    }
  }

  await db.from('builder_stock_items')
    .update(patch)
    .eq('id', stockItemId);

  return primary?.image.id ?? null;
}

/**
 * Is this image still waiting for a display verdict?
 *
 * Only asked of images that could BE a card's picture. Anything else has no
 * verdict by design, and treating its absence as "unassessed" would freeze
 * every item that happens to hold a floorplan.
 *
 * THIS MODULE HAD IT RIGHT AND `nextImageStage` DID NOT, which is how one
 * property came to say "Finding a picture…" indefinitely — the same question,
 * answered two ways, thirty lines apart in the same package. The role half is
 * `sweepWillJudge` now, in the module that owns it, so a third copy of the
 * right answer cannot drift away from the other two either.
 */
function awaitingVerdict(image: DisplayableImage): boolean {
  if (image.source_stage !== SOURCE_SUPPLIED_STAGE) return false;
  if (image.verification_status !== SOURCE_SUPPLIED_VERIFICATION) return false;
  if (image.processing_status !== 'ready') return false;
  if (!sweepWillJudge(image.source_detail)) return false;
  return needsEligibilityAssessment(image.source_detail);
}

/**
 * Apply the rule to every property an organisation holds — EXCEPT the ones
 * whose evidence is not in yet.
 *
 * Run at the end of a repair so that properties the repair never touched are
 * settled too: an item whose builder supplied nothing must END the run with no
 * primary image, not with the one it had before the rule changed.
 *
 * AN ITEM WHOSE IMAGES HAVE NOT ALL BEEN JUDGED IS SKIPPED ENTIRELY, and that
 * is the part that had to be added. The display rule fails closed, so an image
 * with no verdict is not displayable — which means this function, run over an
 * organisation whose eligibility backfill has not finished, would look at a
 * perfectly clean builder photograph, see no verdict, conclude the property has
 * nothing to show, and CLEAR its pointer. The backfill would then write
 * `eligible` onto an image nothing points at any more.
 *
 * Deciding per ITEM rather than per upload is what the schema requires: one
 * property's images can come from several uploads, so "this upload settled" is
 * not the same statement as "this property's candidates have all been judged".
 * Only the second one licenses a write.
 *
 * `skipped` is reported rather than swallowed: a caller that keeps seeing a
 * non-zero count is being told its backfill has not converged.
 *
 * IT RANKS WITH `chooseCardImage`, THE SAME AUTHORITY EVERY OTHER WRITER USES,
 * AND THAT IS THE WHOLE OF THE FIX HERE.
 *
 * It used to rank with `chooseDisplayableImage` — the builder's own file or
 * nothing — because that WAS the rule when this was written, and the comment at
 * its live call site still says what it was for: "a property whose builder
 * supplied nothing must end the run with no primary image rather than the
 * Street View it had before the rule changed". The rule then changed back the
 * other way. `imagePriority.pure.ts` replaced "builder or nothing" with a
 * ranking that admits a web photograph VERIFIED to be this property (tier 3)
 * and Street View of this exact address (tier 4), and `chooseAndStorePrimaryImage`
 * thirty lines above moved onto it. This function did not, so it went on
 * enforcing the repealed rule — and the pointers it deletes are exactly the
 * ones the current rule creates.
 *
 * MEASURED IN PRODUCTION, 1 SEPTEMBER 2026, against the 430 live pointers:
 * 156 `google_maps` and 7 `internet_search` rows fail
 * `isDisplayableSourceImage` on its first condition (the stage), and 25
 * `uploaded_document` rows written before roles existed fail it on the role.
 * 188 of 430 cards — 44% of the marketplace — blanked by one pass, and NOT
 * caught by the skip guard: `awaitingVerdict` returns false at the same two
 * gates, so an item it can never rescue is an item it hands straight to the
 * clear. This is not theoretical: it ran once, and 45 pointers went.
 *
 * The guard below is deliberately kept. `chooseCardImage` would demote an item
 * whose builder image is still awaiting its verdict to a Street View and
 * promote it back when the verdict lands, which is churn on a card rather than
 * data loss — but skipping is the conservative answer and it is the one this
 * function already gave.
 */
export async function enforceStrictPrimaryImages(
  db: any,
  organisationId: string,
): Promise<{ inspected: number; cleared: number; corrected: number; skipped: number }> {
  const outcome = { inspected: 0, cleared: 0, corrected: 0, skipped: 0 };

  /*
   * BOTH READS ARE PAGED, AND A SHORT ANSWER STOPS THE SWEEP DEAD.
   *
   * `.limit(20000)` and `.limit(200000)` were never honoured: PostgREST caps a
   * response at `db-max-rows` — 1,000 on this deployment — and says so only in
   * a header nothing here reads. The organisation held 1,926 images, the sweep
   * saw 1,000, and every property whose photograph sat in the missing 926
   * reached `chooseCardImage([])` and had its pointer CLEARED as "nothing to
   * show". Eleven properties holding an eligible builder photograph, all of it
   * past the cut, all of them blank. See `pagedRead.ts`.
   *
   * And an incomplete read now RETURNS rather than proceeding. This function's
   * entire output is deletions and corrections computed from the images it can
   * see, so reading fewer than all of them is not a smaller sweep — it is a
   * sweep that blanks every card whose evidence it failed to load. The old code
   * discarded `error` outright, which made a database fault indistinguishable
   * from an organisation that owns no images at all.
   */
  const itemPage = await readAllRows<{ id: string; primary_image_id: string | null }>(
    () => db
      .from('builder_stock_items')
      .select('id, primary_image_id')
      .eq('organisation_id', organisationId)
      .in('lifecycle_status', PROCESSED_LIFECYCLE)
      .order('id', { ascending: true }));
  if (itemPage.failed) {
    console.error('[builderStock] primary-image sweep skipped: items could not be read', {
      phase: 'enforce_primary_images', organisation_id: organisationId,
      detail: String((itemPage.error as { message?: string })?.message ?? itemPage.error),
    });
    return outcome;
  }
  const items = itemPage.rows;
  if (!items.length) return outcome;

  const imagePage = await readAllRows<DisplayableImage & { stock_item_id: string }>(
    () => db
      .from('builder_stock_item_images')
      .select('id, stock_item_id, source_stage, verification_status, processing_status, position, storage_path, external_url, source_detail')
      .eq('organisation_id', organisationId)
      .order('id', { ascending: true }));
  if (imagePage.failed) {
    console.error('[builderStock] primary-image sweep skipped: images could not be read', {
      phase: 'enforce_primary_images', organisation_id: organisationId,
      detail: String((imagePage.error as { message?: string })?.message ?? imagePage.error),
    });
    return outcome;
  }
  const images = imagePage.rows;

  /*
   * Lazily, for the reason `chooseAndStorePrimaryImage` gives above: this
   * module and `imagePriority.pure.ts` would otherwise import each other.
   */
  const { chooseCardImage } = await import('./imagePriority.pure.ts');

  const byItem = new Map<string, DisplayableImage[]>();
  for (const image of images) {
    const bucket = byItem.get(image.stock_item_id) ?? [];
    bucket.push(image);
    byItem.set(image.stock_item_id, bucket);
  }

  for (const item of items) {
    outcome.inspected += 1;
    const candidates = byItem.get(item.id) ?? [];

    // The evidence is not all in. Leave the pointer exactly as it is — right or
    // wrong — because clearing it now would lose a picture the backfill is
    // about to approve, and there is no signal here to tell the two apart.
    if (candidates.some(awaitingVerdict)) {
      outcome.skipped += 1;
      continue;
    }

    const next = chooseCardImage(candidates)?.image.id ?? null;
    if (next === item.primary_image_id) continue;

    await db.from('builder_stock_items')
      .update({ primary_image_id: next })
      .eq('id', item.id);
    if (next === null) outcome.cleared += 1;
    else outcome.corrected += 1;
  }
  return outcome;
}
