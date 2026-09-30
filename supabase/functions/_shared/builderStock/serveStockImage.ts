/**
 * ===========================================================================
 * A POINTER IS NOT A PHOTOGRAPH.
 * ===========================================================================
 *
 * `builder_stock_items.primary_image_id` being set proves that a row names an
 * image. It does not prove that a customer opening the Builder Portal sees
 * one, and the two came apart in this product before: every builder's imagery
 * was discovered, de-duplicated, classified, ranked, stored and signed while
 * the Stock List rendered zero `<img>` elements, because `builderStockImageUrl`
 * had no caller anywhere.
 *
 * This is the step between the pointer and the picture, and it is extracted
 * for ONE reason: so the acceptance gate can prove it by CALLING it rather
 * than by imitating it. Six lines copied into a harness prove that the six
 * lines work; they prove nothing about the function a customer's browser
 * reaches. `builder-portal-stock`'s `image_url` operation and
 * `scripts/stock-acceptance` now run the same code, so "the portal can serve
 * this photograph" is a property of one implementation rather than of two
 * that agree today.
 *
 * THREE THINGS IT DOES, AND THE FIRST IS THE SECURITY ONE.
 *
 * The row is read scoped to the ORGANISATION. An image id is a uuid a caller
 * supplies, and without that filter one builder could mint a signed URL to
 * another builder's photograph by guessing — so a row that exists but belongs
 * elsewhere answers exactly as one that does not exist, and the gate asserts
 * that rather than trusting it.
 *
 * An EXTERNAL image is handed back as its own URL. There is nothing stored to
 * sign, the address is already public, and minting a signed URL for a path
 * that does not exist would answer 404 to a customer.
 *
 * Otherwise a SHORT-LIVED signed URL is minted. A signed storage URL is a
 * bearer credential with a lifetime — the same rule the Compliance Passport's
 * portrait answers to — so it is minted for the request that asked and expires
 * on its own.
 *
 * AND IT SIGNS THE SAME BYTES THE MARKETPLACE SHOWS. The network's image door
 * (`builder-network-stock-image`) serves a clean or cleared original, and the
 * repaired derivative where the original carries a laid-over graphic; this
 * used to sign the original every time. Measured 30 September 2026, Lot 208
 * Donnybrook showed its original — marketing overlay and all — on the
 * builder's own card, under alt text calling it "the picture shown on the
 * marketplace", while every Command Centre drew the repaired copy. One rule,
 * the door's, so the two can no longer show one property two ways. An image
 * with no derivative is served as it was, because the builder must still see
 * a picture the marketplace would not show.
 */
import { isMarketplaceEligible } from './marketplaceEligibility.pure.ts';
import { servableClearanceFor, servableDerivativeFor } from './sanitizedDerivative.pure.ts';

/** How long a minted URL lives. One place; two spellings is how two ends drift. */
export const STOCK_IMAGE_URL_TTL_SECONDS = 300;

/** The bucket a stored stock image lives in, where a row does not name one. */
export const DEFAULT_STOCK_IMAGE_BUCKET = 'builder-stock-images';

export type StockImageServed =
  | { ok: true; url: string; external: boolean; expiresIn: number | null }
  /** The image is not this organisation's, or is not there at all. */
  | { ok: false; reason: 'not_found' }
  /** It is ours and storage would not mint a URL for it. */
  | { ok: false; reason: 'not_prepared'; detail: string | null };

export async function serveStockImage(
  db: any,
  args: {
    imageId: string;
    organisationId: string;
    ttlSeconds?: number;
    bucket?: string;
  },
): Promise<StockImageServed> {
  const imageId = String(args.imageId ?? '').trim();
  const organisationId = String(args.organisationId ?? '').trim();
  if (!imageId || !organisationId) return { ok: false, reason: 'not_found' };

  const { data: image } = await db
    .from('builder_stock_item_images')
    .select('id, storage_bucket, storage_path, external_url, organisation_id, source_detail')
    .eq('id', imageId)
    /*
     * THE TENANT FILTER, and it is not a convenience. An image id is a uuid the
     * caller supplies; without this, one organisation could mint a signed URL
     * to another's photograph. A row belonging elsewhere must answer exactly
     * as a row that does not exist — no 403, which would confirm it is there.
     */
    .eq('organisation_id', organisationId)
    .maybeSingle();

  if (!image) return { ok: false, reason: 'not_found' };

  if (image.external_url && !image.storage_path) {
    return { ok: true, url: String(image.external_url), external: true, expiresIn: null };
  }
  if (!image.storage_path) {
    return { ok: false, reason: 'not_prepared', detail: 'no_stored_object' };
  }

  const ttl = Number.isFinite(args.ttlSeconds)
    ? Number(args.ttlSeconds) : STOCK_IMAGE_URL_TTL_SECONDS;
  const derivative = marketplaceDerivativeOf(image.source_detail);
  const { data: signed, error } = await db.storage
    .from(derivative?.storage_bucket || image.storage_bucket || args.bucket || DEFAULT_STOCK_IMAGE_BUCKET)
    .createSignedUrl(derivative?.storage_path || image.storage_path, ttl);

  if (error || !signed?.signedUrl) {
    return {
      ok: false, reason: 'not_prepared',
      detail: error?.message ? String(error.message) : null,
    };
  }
  return { ok: true, url: String(signed.signedUrl), external: false, expiresIn: ttl };
}

/**
 * The derivative the network's image door would serve in place of this
 * original, or null where it serves the original itself. The door's rule,
 * verbatim: a clean or cleared original wins, and a derivative is served only
 * where it is the provable picture.
 */
export function marketplaceDerivativeOf(
  sourceDetail: unknown,
): { storage_path: string; storage_bucket?: string | null } | null {
  const detail = (sourceDetail ?? null) as Record<string, unknown> | null;
  if (isMarketplaceEligible(detail) || servableClearanceFor(detail)) return null;
  const derivative = servableDerivativeFor(detail);
  return derivative?.storage_path ? derivative : null;
}
