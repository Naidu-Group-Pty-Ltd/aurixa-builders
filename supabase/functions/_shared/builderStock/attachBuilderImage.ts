/**
 * BUILDER STOCK — WRITING A PICTURE THE BUILDER HANDED OVER.
 *
 * One module, two callers: a builder attaching a photograph to ONE property,
 * and the Command Centre doing it on their behalf. They must not be able to
 * disagree about what a builder-supplied image IS, which is the whole reason
 * this is not written twice.
 *
 * A PICTURE IS FOR ONE PROPERTY AND NEVER FOR A DESIGN. This module briefly
 * carried a second mode — one render uploaded against a house design and
 * fanned out to every lot stating it — and it is withdrawn. A design string
 * matching is not evidence that a photograph is of a particular house, so the
 * fan-out put one manually supplied picture on lots nobody had looked at, and
 * every future lot of that design inherited it. This route is the manual
 * override for ONE card and is never part of ordinary stock ingestion.
 *
 * WHAT IT WRITES, AND WHY THAT SHAPE. An ordinary `builder_stock_item_images`
 * row, `uploaded_document` / `source_supplied`, carrying a role assignment —
 * which means it travels every existing rule unchanged rather than around
 * them: `isDisplayableSourceImage` admits it, `rankImage` puts it in the
 * builder's own tier, `chooseCardImage` orders it by the evidence level the
 * role carries, and the marketplace eligibility sweep judges its pixels like
 * any other. A render with "$25,000 REBATE" set over it is refused here
 * exactly as it is inside a brochure.
 *
 * WHAT IT NEVER DOES. It does not set `primary_image_id`. Nothing here decides
 * which picture a card draws — `enforceStrictPrimaryImages` does, from the
 * roles and levels, on its own sweep. An attach that wrote the pointer itself
 * would be a second implementation of the one decision this subsystem has.
 */
import {
  SOURCE_SUPPLIED_STAGE, SOURCE_SUPPLIED_VERIFICATION,
} from './primaryImage.ts';
import {
  roleDetail, type SourceImageRoleAssignment,
} from './sourceImageRole.pure.ts';
import { carriedSanitizationFor } from './sourceImages.ts';

/** What a caller must give us, and nothing it can decide for itself. */
export interface AttachBuilderImageInput {
  organisationId: string;
  stockItemId: string;
  uploadId: string | null;
  storageBucket: string;
  storagePath: string;
  contentType: string;
  byteSize: number | null;
  sha256: string | null;
  /** The role this image carries FOR THIS PROPERTY. */
  role: SourceImageRoleAssignment;
}

/**
 * A stable identity for a builder-supplied row, so attaching twice replaces
 * rather than accumulates.
 *
 * The reference is the STORAGE PATH, which is the thing that — if it arrives
 * again — means "this same picture" rather than "another one". Without it a
 * builder who re-uploaded a corrected photograph would leave the old one in
 * the gallery, still eligible, still competing for the card.
 */
export function builderImageReference(input: { storagePath: string }): string {
  return `builder-supplied:${input.storagePath}`;
}

/**
 * Write (or replace) one builder-supplied image against one property.
 *
 * Returns the row id, or null when the write failed — which the caller reports
 * rather than swallowing, because an image the builder believes they supplied
 * and which is not stored is the worst outcome available here.
 */
export async function attachBuilderImage(
  // Typed loosely for the same reason every other writer in this package is:
  // the client's own generics describe a schema this repo generates by hand,
  // and a narrower signature here is a second opinion about it that goes stale.
   
  db: any,
  input: AttachBuilderImageInput,
): Promise<{ id: string } | { error: string }> {
  const reference = builderImageReference({ storagePath: input.storagePath });

  /*
   * The same rule every other store path follows: replacing a row must not
   * take the sanitization stage's record with it where the bytes are the ones
   * that record is about. Handing back the identical file is the case — an
   * operator re-attaching what is already there — and it is the only one,
   * because a corrected photograph hashes differently and carries nothing.
   */
  const carried = await carriedSanitizationFor(db, {
    stockItemId: input.stockItemId,
    sourceStage: SOURCE_SUPPLIED_STAGE,
    reference,
    storedSha256: input.sha256 ?? null,
  });

  const { data, error } = await db.from('builder_stock_item_images').upsert({
    stock_item_id: input.stockItemId,
    organisation_id: input.organisationId,
    upload_id: input.uploadId,
    source_stage: SOURCE_SUPPLIED_STAGE,
    verification_status: SOURCE_SUPPLIED_VERIFICATION,
    processing_status: 'ready',
    source_reference: reference,
    source_provider: 'builder_supplied',
    storage_bucket: input.storageBucket,
    storage_path: input.storagePath,
    content_type: input.contentType,
    byte_size: input.byteSize,
    /*
     * `position` 0 puts it first in the gallery, which is where a picture the
     * builder chose belongs. It is NOT how the card is decided — see the
     * header — but it is what a person scrolling the property's images
     * expects to see at the front.
     */
    position: 0,
    source_detail: {
      ...roleDetail(input.role),
      supplied_directly: true,
      ...(input.sha256 ? { stored_sha256: input.sha256 } : {}),
      // Last, so a replacement cannot lose what another stage established
      // about these exact bytes — and only ever the keys that stage owns.
      ...carried,
    },
    /*
     * The table's own uniqueness, `(stock_item_id, source_stage,
     * source_reference)`, is the conflict target — so a builder who uploads a
     * corrected photograph REPLACES the one before it instead of leaving it in the
     * gallery, still eligible, still competing for the card.
     */
  }, { onConflict: 'stock_item_id,source_stage,source_reference' }).select('id').maybeSingle();

  if (error || !data) {
    return { error: String((error as { message?: string })?.message ?? 'the image could not be stored') };
  }

  /*
   * AND THE PROPERTY GOES BACK IN FRONT OF THE LADDER, as part of the act
   * rather than as something each caller must remember.
   *
   * A property that has been through the ladder once is left `settled`, which
   * the settler reads as "nothing further to try" — so a picture supplied for
   * such a property would sit in the table, correct and eligible, and never be
   * promoted to the card. Every caller had to requeue it, and a caller that
   * forgot would fail silently in exactly the way that is hardest to notice:
   * the operator sees "saved" and the card stays blank.
   *
   * It also belongs here for a boundary reason. The Command Centre's function
   * SERVES the marketplace, and a standing contract test forbids it naming
   * `image_work_stage` at all — serving is decided by lifecycle alone, never
   * by how far image work got. Performing the requeue inside the shared act
   * keeps that true while still letting staff supply a picture.
   *
   * A failure here is not a failure of the attach: the image IS stored, and
   * the next sweep or the next supply will requeue it. Reported, never thrown.
   */
  const { error: requeueError } = await db.from('builder_stock_items').update({
    enrichment_status: 'pending',
    image_work_stage: 'source',
    image_work_claim_until: null,
    image_work_next_attempt_at: new Date().toISOString(),
    image_work_updated_at: new Date().toISOString(),
  }).eq('id', input.stockItemId).eq('organisation_id', input.organisationId);
  if (requeueError) {
    console.error('[builder-stock] supplied image stored but not requeued', {
      phase: 'builder_supplied_image',
      stock_item_id: input.stockItemId,
      message: String((requeueError as { message?: string })?.message ?? requeueError).slice(0, 200),
    });
  }

  return { id: String((data as { id: string }).id) };
}
