/**
 * The network's public stock-image door — what a connected workspace's
 * marketplace card actually draws.
 *
 * The stock mirror sync ships METADATA: an item's projection names its primary
 * image by id, and the consumer points its mirror row's `external_url` here.
 * No bytes ride in events (the outbox worker caps a delivery at kilobytes),
 * no second copy of a photograph exists to go stale, and rotating or
 * re-sanitising an image on this network changes what every connected
 * marketplace serves on its next render without another event crossing.
 *
 * PUBLIC BY DESIGN, AND EXACTLY AS NARROW AS THE PUBLICATION INVARIANT:
 *
 *  * the id must be the CURRENT PRIMARY image of an ACTIVE stock item, or a
 *    current member of that item's published gallery
 *    (`builder_network_stock_item_gallery`, the set the stock payload names) —
 *    not merely an image that exists. Secondary pages, demoted rows, and
 *    every fallback stage are unreachable whatever their id;
 *  * the item must pass `builder_stock_item_client_visible` — the same
 *    predicate that gates publication, so nothing is servable here that the
 *    builder's own marketplace would not stand behind;
 *  * the answer for everything else is one generic 404. An unguessable uuid
 *    is not the authorisation — the two predicates are — but there is no
 *    listing surface, no enumeration answer and no error oracle.
 *
 * WHICH BYTES: the same decision the Builder Portal's own card makes.
 * An image measured clean, or CLEARED by the precise inspection, serves the
 * builder's original; one that reaches a card only through a sanitized
 * derivative serves that derivative's object (the same photograph with the
 * laid-over graphic rebuilt out of it). Nothing is decoded, repaired or
 * generated at request time — this door reads records and signs one path.
 *
 * The response is a 302 to a short-lived signed URL. An <img> tag follows it
 * transparently; a crawler that stores the signed URL holds something that
 * expires within the hour.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { STOCK_IMAGE_BUCKET } from '../_shared/builderStock/fileTypes.pure.ts';
import { isMarketplaceEligible } from '../_shared/builderStock/marketplaceEligibility.pure.ts';
import {
  servableClearanceFor, servableDerivativeFor,
} from '../_shared/builderStock/sanitizedDerivative.pure.ts';
import { getTrustedClientIp } from '../_shared/requestSecurity.ts';
import { UNTRUSTED_IP_MULTIPLIER } from '../_shared/authRateLimit.ts';

const SIGNED_URL_TTL_SECONDS = 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A CEILING ON A DOOR THAT ASKS FOR NOTHING.
 *
 * Nothing here is authenticated — the two predicates decide what is servable,
 * not who asked — and every GET that clears the uuid check spends two
 * service-role selects, a predicate RPC and a signed-URL mint before a single
 * byte is served. On an unauthenticated endpoint that cost IS the exposure, so
 * it is bounded per source address.
 *
 * KEYED ON AN ADDRESS THE CALLER CANNOT SET. `getTrustedClientIp` reads only
 * the headers the edge writes and deliberately refuses `X-Forwarded-For`,
 * which a client appends to at will — a limiter keyed on that buckets an
 * attacker under a value they choose and enforces nothing at all. Where the
 * platform gave us no address we believe, every such caller shares one bucket,
 * so that bucket carries `UNTRUSTED_IP_MULTIPLIER` for the same reason the
 * portal logins do: one shared counter must not shut a whole deployment out of
 * its own pictures.
 *
 * 600 a minute is roughly ten a second from one source. A marketplace page of
 * cards asks for each picture once and the 302 it gets back is cacheable for
 * five minutes, so even an office behind one NAT address stays far under it,
 * while a host trying to farm signed URLs stops immediately.
 *
 * AND IT FAILS CLOSED, which is the opposite of `authRateLimit.ts` and
 * deliberate. That module degrades to a per-isolate bucket because a login
 * that cannot reach its limiter would lock real people out of the product.
 * Here the thing being protected is unauthenticated amplification and the cost
 * of a denial is a card drawing no picture until the limiter answers again, so
 * a limiter that cannot answer refuses rather than waving the request through.
 */
const IMAGE_RATE_LIMIT_WINDOW_SECONDS = 60;
const IMAGE_RATE_LIMIT_PER_IP = 600;

Deno.serve(async (req) => {
  const notFound = () => new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!UUID_RE.test(id)) return notFound();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Before any of the work below, and keyed on an address the caller does
    // not get to choose. See the constants above.
    const trustedIp = getTrustedClientIp(req.headers);
    const { data: withinLimit, error: limitError } = await supabase
      .rpc('check_and_bump_rate_limit', {
        p_key: `builder_network_stock_image:${trustedIp ?? 'untrusted'}`,
        p_max: trustedIp
          ? IMAGE_RATE_LIMIT_PER_IP
          : IMAGE_RATE_LIMIT_PER_IP * UNTRUSTED_IP_MULTIPLIER,
        p_window_seconds: IMAGE_RATE_LIMIT_WINDOW_SECONDS,
      });
    if (limitError || withinLimit !== true) {
      if (limitError) {
        console.error('[builder-network-stock-image] rate limiter unavailable', limitError.message);
      }
      return new Response('Too many requests', {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(IMAGE_RATE_LIMIT_WINDOW_SECONDS),
        },
      });
    }

    const { data: image } = await supabase
      .from('builder_stock_item_images')
      .select('id, stock_item_id, storage_bucket, storage_path, source_stage, verification_status, processing_status, source_detail, content_type')
      .eq('id', id)
      .maybeSingle();
    if (!image || !image.storage_path) return notFound();

    // The CURRENT primary of an ACTIVE item, not any image that exists.
    let { data: item } = await supabase
      .from('builder_stock_items')
      .select('id, lifecycle_status, primary_image_id')
      .eq('primary_image_id', image.id)
      .eq('lifecycle_status', 'active')
      .maybeSingle();

    /*
     * OR A CURRENT MEMBER OF ITS OWN ITEM'S PUBLISHED GALLERY. The stock
     * payload now carries a property's photographs (`media.photos`), read from
     * `builder_network_stock_item_gallery` — so this door serves exactly the
     * set the composer publishes, from the same function, and nothing wider.
     * Today that gallery IS the primary, so this admits nothing the primary
     * rule above did not; it is here so the two cannot drift when the gallery
     * is allowed to hold more.
     */
    if (!item && image.stock_item_id) {
      const { data: gallery, error: galleryError } = await supabase
        .rpc('builder_network_stock_item_gallery', { _item_id: image.stock_item_id });
      if (galleryError || !Array.isArray(gallery) || !gallery.includes(image.id)) return notFound();
      ({ data: item } = await supabase
        .from('builder_stock_items')
        .select('id, lifecycle_status, primary_image_id')
        .eq('id', image.stock_item_id)
        .eq('lifecycle_status', 'active')
        .maybeSingle());
    }
    if (!item) return notFound();

    // And the item must be one this network's own marketplace would publish.
    const { data: visible, error: visibleError } = await supabase
      .rpc('builder_stock_item_client_visible', { p_item_id: item.id });
    if (visibleError || visible !== true) return notFound();

    // The portal card's own serving order: a clean or CLEARED original wins;
    // a derivative serves only where it is the only provable picture.
    const detail = (image.source_detail ?? null) as Record<string, unknown> | null;
    const cleanOriginal = isMarketplaceEligible(detail) || !!servableClearanceFor(detail);
    const derivative = cleanOriginal ? null : servableDerivativeFor(detail);
    if (!cleanOriginal && !derivative) return notFound();

    const bucket = derivative
      ? (derivative.storage_bucket || image.storage_bucket || STOCK_IMAGE_BUCKET)
      : (image.storage_bucket || STOCK_IMAGE_BUCKET);
    const path = derivative ? derivative.storage_path : image.storage_path;

    const { data: signed, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) {
      // The record says servable and storage disagrees: an operational
      // failure, never "no image exists" — 503 tells the renderer to retry.
      console.error('[builder-network-stock-image] signing failed', error?.message);
      return new Response('Temporarily unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: signed.signedUrl,
        // The REDIRECT may be cached briefly; the signed URL it hands out
        // lives for an hour. A re-pointed primary is picked up within
        // minutes without another event crossing the wire.
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error) {
    console.error('[builder-network-stock-image] error', error);
    return new Response('Temporarily unavailable', { status: 503 });
  }
});
