/**
 * BUILDER STOCK — A CARD THAT SAYS "WEB SOURCED" MUST BE ABLE TO DRAW THE
 * PHOTOGRAPH IT IS TALKING ABOUT.
 *
 * WHAT HAPPENED. A verified web image was kept as a LINK: `external_url`
 * pointing at the publisher's own server, no bytes of ours. The stated reason
 * — "copying it into our bucket would make it look like ours" — confused
 * serving with provenance: where the bytes are served from says nothing, and
 * the record's own columns (`source_stage`, `source_page_url`,
 * `source_reference`, provider, the identity evidence) are what say where a
 * picture came from. What the link actually bought was a dependency on
 * somebody else's server, which is the exact dependency `sourceImages.ts`
 * refuses for every other image in this pipeline ("the BYTES are taken now
 * rather than the link being kept").
 *
 * MEASURED, 2 SEPTEMBER 2026, lot 310 Watsons Reach: its verified web image
 * pointed at a builder's WordPress upload that now answers HTTP 404. The
 * marketplace card kept the "Web sourced" badge and drew "Image unavailable"
 * under it — a claim with nothing behind it, which is worse than a blank.
 *
 * SO: the settler's per-organisation sweep now walks the VERIFIED, ready,
 * storage-less web images (nothing else is ever displayed, so nothing else is
 * fetched) and, a few per tick,
 *
 *   - STORES the bytes into our bucket when the address still serves them —
 *     `external_url` and `source_page_url` stay exactly as recorded, because
 *     they are the provenance; only the serving moves. The marketplace
 *     already prefers `storage_path` over `external_url`, so a stored image
 *     stops depending on the publisher from that moment on.
 *   - RETIRES the record (`processing_status: 'unavailable'`, with the
 *     reason) only when the address answers that the picture is GONE —
 *     `source_not_found`, HTTP 404/410. `isVerifiedWebImage` requires
 *     `ready`, so the same tick's `enforceStrictPrimaryImages` re-decides the
 *     card and the badge disappears with the picture, instead of outliving it.
 *   - HOLDS everything else, while the budget lasts. A 401/403 is the
 *     hotlink-protection shape — a browser with a referer may render what our
 *     server is refused — and a timeout or 5xx is somebody's bad minute.
 *     Neither is evidence the picture is gone, so neither may blank a card on
 *     its own: the attempt is counted and the row keeps serving.
 *
 * WHAT THE BUDGET'S END MEANS was corrected by measurement. The first
 * version left an exhausted row exactly as it found it (`store_exhausted`,
 * still `ready`, still hotlinked) — "stop trying, never stop showing" — on
 * the hope that a browser could draw what our server was refused. MEASURED,
 * 2 SEPTEMBER 2026, same day it shipped: all three rows that exhausted the
 * budget (lot 2030 Seventh Bend, lot 310 Watsons Reach, lot 318 Palomino)
 * were their card's PRIMARY, and every one drew "Web sourced" over "Image
 * unavailable" in the browser too — lot 310's host answers our egress 403
 * and a browser 404, so the hold was preserving a claim, not a picture.
 * Across the marketplace's entire hotlinked backlog (13 rows), the
 * browser-renders-what-we-cannot case occurred zero times.
 *
 * So exhaustion now RETIRES the serving, exactly as a 404 does, under its
 * own reason — `store_exhausted`, because "the source says it is gone" and
 * "we could never obtain it" are different facts and the record keeps the
 * distinction. A card may only claim a picture it can actually serve: the
 * same tick's enforcement takes the badge with it, and the card falls to the
 * next displayable image or to the honest blank. A row stamped exhausted by
 * the earlier rule while still `ready` is retired budget-free on the next
 * sweep, so the marketplace converges itself with nothing edited by hand.
 *
 * The sweep never touches `primary_image_id` — pointers belong to
 * `enforceStrictPrimaryImages` — and never fails the tick it runs inside.
 */
import { validateSourceImageBytes } from './sourceAssets.pure.ts';
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';

/** Fetches per organisation per sweep. A drip, not a crawl. */
const STORE_BUDGET_PER_SWEEP = 3;
/** Attempts a row gets before the sweep stops trying to store it. */
const MAX_STORE_ATTEMPTS = 6;
/** Where this sweep keeps its bookkeeping inside `source_detail`. */
export const WEB_STORE_DETAIL_KEY = 'web_store';

export interface WebImageFetchOutcome {
  bytes: Uint8Array | null;
  /** `SourceFetchError.code` when the fetch refused; null on success. */
  code: string | null;
  detail: string;
}

export interface WebImageFetcher {
  (url: string): Promise<WebImageFetchOutcome>;
}

/** The production fetcher: the same guarded fetch every remote read uses. */
const guardedWebImageFetch: WebImageFetcher = async (url: string) => {
  const { fetchStockSource } = await import('./fetchSource.ts');
  try {
    const fetched = await fetchStockSource(url);
    return { bytes: fetched.bytes, code: null, detail: '' };
  } catch (error) {
    return {
      bytes: null,
      code: String((error as { code?: unknown })?.code ?? 'fetch_failed'),
      detail: String((error as { safeMessage?: unknown })?.safeMessage
        ?? (error as { message?: unknown })?.message ?? error).slice(0, 200),
    };
  }
};

interface StoredWebImageRow {
  id: string;
  stock_item_id: string;
  external_url: string | null;
  source_detail: Record<string, unknown> | null;
}

function storeState(row: StoredWebImageRow): Record<string, unknown> {
  const detail = (row.source_detail ?? {}) as Record<string, unknown>;
  const state = detail[WEB_STORE_DETAIL_KEY];
  return state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
}

function withStoreState(
  row: StoredWebImageRow,
  state: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(row.source_detail ?? {}), [WEB_STORE_DETAIL_KEY]: state };
}

export interface WebImageStoreOutcome {
  attempted: number;
  stored: number;
  retired: number;
  held: number;
}

/**
 * Store the organisation's displayed-but-hotlinked web images, a few per
 * sweep; retire the ones whose address says the picture is gone.
 *
 * Runs before `enforceStrictPrimaryImages` in the same tick, so a retirement
 * has its card re-decided immediately rather than a tick later.
 */
export async function storeVerifiedWebImages(
  db: any,
  organisationId: string,
  deps: { fetchImage?: WebImageFetcher } = {},
): Promise<WebImageStoreOutcome> {
  const outcome: WebImageStoreOutcome = { attempted: 0, stored: 0, retired: 0, held: 0 };
  const fetchImage = deps.fetchImage ?? guardedWebImageFetch;

  /** Stop serving this row, with the reason on the record. */
  const retire = async (
    row: StoredWebImageRow,
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) => {
    await db
      .from('builder_stock_item_images')
      .update({
        processing_status: 'unavailable',
        error_message: message.slice(0, 300),
        source_detail: withStoreState(row, {
          ...storeState(row),
          ...extra,
          retired_at: new Date().toISOString(),
          reason,
        }),
      })
      .eq('id', row.id)
      .eq('organisation_id', organisationId);
    outcome.retired += 1;
    console.info('[builderStock] web image retired', {
      phase: 'web_image_store', image_id: row.id, stock_item_id: row.stock_item_id, reason,
    });
  };

  try {
    const { data: rows, error } = await db
      .from('builder_stock_item_images')
      .select('id, stock_item_id, external_url, source_detail')
      .eq('organisation_id', organisationId)
      .eq('source_stage', 'internet_search')
      .eq('verification_status', 'property_identity_verified')
      .eq('processing_status', 'ready')
      .is('storage_path', null)
      .order('id', { ascending: true })
      .limit(200);
    if (error || !rows?.length) return outcome;
    const rowList = rows as StoredWebImageRow[];

    /*
     * A row the earlier rule left exhausted-but-still-ready is retired here,
     * budget-free: its verdict was already paid for, and while it stays
     * `ready` it is some card's standing claim to a picture nobody can see.
     */
    for (const row of rowList) {
      const state = storeState(row);
      if (state.retired_at) continue;
      if (state.store_exhausted === true || Number(state.attempts ?? 0) >= MAX_STORE_ATTEMPTS) {
        await retire(row, 'store_exhausted',
          'This image could not be stored for display after repeated attempts.');
      }
    }

    const candidates = rowList.filter((row) => {
      if (!row.external_url) return false;
      const state = storeState(row);
      if (state.retired_at) return false;
      if (state.store_exhausted) return false;
      return Number(state.attempts ?? 0) < MAX_STORE_ATTEMPTS;
    });
    if (!candidates.length) return outcome;

    /*
     * THE PICTURE ON A CARD GOES FIRST. A row some property currently points
     * at is the one whose fragility a person can see, so the budget is spent
     * on primaries before spares.
     */
    const { data: pointerRows } = await db
      .from('builder_stock_items')
      .select('primary_image_id')
      .eq('organisation_id', organisationId)
      .not('primary_image_id', 'is', null)
      .limit(1000);
    const primaryIds = new Set(
      ((pointerRows ?? []) as Array<{ primary_image_id: string | null }>)
        .map((row) => String(row.primary_image_id)),
    );
    candidates.sort((a, b) =>
      Number(primaryIds.has(String(b.id))) - Number(primaryIds.has(String(a.id)))
      || String(a.id).localeCompare(String(b.id)));

    for (const row of candidates.slice(0, STORE_BUDGET_PER_SWEEP)) {
      outcome.attempted += 1;
      const fetched = await fetchImage(String(row.external_url));

      // GONE is one answer that takes the badge with it.
      if (!fetched.bytes && fetched.code === 'source_not_found') {
        await retire(row, 'source_not_found',
          `The source site no longer serves this image (${fetched.detail || 'not found'}).`);
        continue;
      }

      // A refusal or a bad minute is never, on its own, evidence the picture
      // is gone — the attempt is counted and the row keeps serving. But the
      // SIXTH failure is a verdict: a picture we could not obtain six times
      // over is not one a card may keep claiming, so the budget's end
      // retires the serving under its own reason.
      const check = fetched.bytes ? validateSourceImageBytes(fetched.bytes) : null;
      if (!fetched.bytes || !check?.ok) {
        const state = storeState(row);
        const attempts = Number(state.attempts ?? 0) + 1;
        const lastError = (fetched.code
          ? `${fetched.code}: ${fetched.detail}`
          : `not an image: ${(check as { reason?: string } | null)?.reason ?? 'unreadable'}`)
          .slice(0, 200);
        if (attempts >= MAX_STORE_ATTEMPTS) {
          await retire(row, 'store_exhausted',
            'This image could not be stored for display after repeated attempts.',
            { attempts, last_error: lastError });
          continue;
        }
        await db
          .from('builder_stock_item_images')
          .update({
            source_detail: withStoreState(row, { ...state, attempts, last_error: lastError }),
          })
          .eq('id', row.id)
          .eq('organisation_id', organisationId);
        outcome.held += 1;
        continue;
      }

      const path = `${organisationId}/web/${row.id}.${check.extension}`;
      const { error: uploadError } = await db.storage
        .from(STOCK_IMAGE_BUCKET)
        .upload(path, fetched.bytes, { contentType: check.contentType, upsert: true });
      if (uploadError) {
        const state = storeState(row);
        const attempts = Number(state.attempts ?? 0) + 1;
        const lastError = `store failed: ${String((uploadError as { message?: string })?.message ?? uploadError)}`
          .slice(0, 200);
        if (attempts >= MAX_STORE_ATTEMPTS) {
          await retire(row, 'store_exhausted',
            'This image could not be stored for display after repeated attempts.',
            { attempts, last_error: lastError });
          continue;
        }
        await db
          .from('builder_stock_item_images')
          .update({
            source_detail: withStoreState(row, { ...state, attempts, last_error: lastError }),
          })
          .eq('id', row.id)
          .eq('organisation_id', organisationId);
        outcome.held += 1;
        continue;
      }

      // The serving moves; the provenance stays exactly as recorded.
      await db
        .from('builder_stock_item_images')
        .update({
          storage_bucket: STOCK_IMAGE_BUCKET,
          storage_path: path,
          content_type: check.contentType,
          byte_size: fetched.bytes.length,
          source_detail: withStoreState(row, {
            ...storeState(row),
            stored_at: new Date().toISOString(),
          }),
        })
        .eq('id', row.id)
        .eq('organisation_id', organisationId);
      outcome.stored += 1;
      console.info('[builderStock] web image stored', {
        phase: 'web_image_store', image_id: row.id, stock_item_id: row.stock_item_id,
        bytes: fetched.bytes.length,
      });
    }
  } catch (error) {
    // The sweep must never fail the tick it runs inside.
    console.warn('[builderStock] web image store sweep failed', {
      phase: 'web_image_store', organisation_id: organisationId,
      message: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
  return outcome;
}
