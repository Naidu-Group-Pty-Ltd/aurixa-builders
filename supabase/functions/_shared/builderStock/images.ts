/**
 * Builder stock — three-stage image enrichment.
 *
 * An imported property needs a picture, and there are exactly three places one
 * can come from. They are run in order, they are recorded SEPARATELY, and
 * their provenance is never merged:
 *
 *   1. uploaded_document  the builder's own render or photograph, taken out of
 *                         the file they uploaded. Written by `importStock.ts`
 *                         at import time, not here.
 *   2. google_maps        Street View or satellite imagery of the property's
 *                         actual address, fetched server-side so the API key
 *                         never reaches a browser.
 *   3. internet_search    a broader search for imagery of this development.
 *                         Kept as a URL plus where it was found, marked
 *                         `unverified` for ever, because nothing has confirmed
 *                         it depicts THIS property.
 *
 * THE STAGES MAY FAIL. A property whose address will not geocode, a
 * deployment with no Google key, a search that returns nothing — each records
 * its stage as unavailable and the import stands. Only a stage that produced
 * an image is allowed to change what the marketplace shows.
 */
import { meteredFetch } from '../meteredFetch.ts';
import { killSwitchActive } from '../publicAbuseControls.ts';
import {
  clientMessageFor,
  consumeGoogleDailyCap,
  type GoogleCapKind,
  type GoogleCapRefusal,
} from '../googleMapsDailyCaps.ts';
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import { geocodableAddress, hasPhotographableStreetAddress } from './normalise.pure.ts';
import { hasReadySourceImage } from './sourceImages.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import {
  MAX_BLOCKED_PASSES, STAGE_SKIPPED_MESSAGE, STAGE_SKIPPED_REFERENCE,
  blockedPassCount, nextImageStage, WEB_VERIFIED_VERIFICATION,
} from './imagePriority.pure.ts';
import { verifyWebImageIdentity } from './webImageIdentity.pure.ts';
import {
  assessGeocodePrecision, assessPanoramaUsefulness, headingToProperty, readLatLng,
} from './streetViewHeading.pure.ts';

/**
 * The SAME circuit scope `street-view` uses.
 *
 * Google imagery is one vendor account with one bill and one failure mode, so
 * it gets one circuit, one daily ceiling and one kill switch — shared with the
 * Listings page rather than duplicated for this feature. A second scope would
 * mean the breaker could be open for the dashboard and closed here, and the
 * daily limit would be spent twice over.
 */
const GOOGLE_CIRCUIT_SCOPE = 'google_street_view';

export interface EnrichableStockItem {
  id: string;
  organisation_id: string;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  development_name: string | null;
  project_name: string | null;
  lot_number: string | null;
  unit_number: string | null;
  /**
   * Has the builder's own source finished being read for this property?
   *
   * FALSE MEANS "DO NOT PAY YET". A property whose source settlement is still
   * outstanding may be about to gain the builder's own render, and buying a
   * search or a Street View against it spends money to be discarded — or
   * worse, puts a fallback on a card that is about to have the real picture.
   * Defaults to true so a caller that has not looked behaves as before.
   */
  sourceSettlementComplete?: boolean;
  /** The builder's trading name, for the identity check on a web result. */
  builder_name?: string | null;
}

export interface StageOutcome {
  stage: 'google_maps' | 'internet_search';
  /**
   * `skipped` is not a failure and not an absence: it is a stage that was not
   * WORTH running because the builder's own image is already in hand. It is
   * recorded on the row as `unavailable` — the schema's three statuses are not
   * being extended — with a message that says which of the two it was.
   */
  status: 'ready' | 'unavailable' | 'failed' | 'skipped';
  detail: string;
}

/**
 * A search is slower than a map tile, and it is the last thing that runs
 * before the batch's wall-clock budget matters.
 */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * `publicAbuseControls.fetchWithTimeout` is the shared primitive, but it calls
 * plain `fetch`, and a Perplexity call that skips `meteredFetch` is billed to
 * nobody. This is the same abort-on-deadline shape applied to the metered
 * wrapper instead of replacing it.
 */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many passes this stage has already been blocked on for this property.
 *
 * Read rather than assumed, because the row is UPSERTED: one `stage-status`
 * row per (property, stage) is overwritten on each pass, so the count has
 * nowhere else to live. A read that fails contributes the conservative answer
 * — the ceiling — because a counter we cannot read must never license an
 * unbounded retry loop against a provider.
 */
async function priorBlockedPasses(
  db: any,
  item: EnrichableStockItem,
  stage: 'google_maps' | 'internet_search',
): Promise<number> {
  try {
    const { data, error } = await db
      .from('builder_stock_item_images')
      .select('source_detail, processing_status')
      .eq('stock_item_id', item.id)
      .eq('source_stage', stage)
      .eq('source_reference', 'stage-status')
      .maybeSingle();
    if (error) return MAX_BLOCKED_PASSES;
    const row = (data ?? null) as
      { source_detail?: unknown; processing_status?: unknown } | null;
    if (!row) return 0;
    const detail = (row.source_detail ?? {}) as Record<string, unknown>;
    // A row that recorded an ANSWER starts the count again: the property has
    // moved on since, and the next block is the first of a new run.
    const wasBlocked = detail.stage_ran === false || row.processing_status === 'failed';
    return wasBlocked ? blockedPassCount(row as never) : 0;
  } catch {
    return MAX_BLOCKED_PASSES;
  }
}

/**
 * Record a stage that produced nothing, so the UI can say why.
 *
 * `ran` IS NOT OPTIONAL, and that is deliberate. It says whether the provider
 * was asked and answered about this property, which is the only thing that
 * decides whether the ladder may move on — see `stageWasAttempted`. Making it
 * a required argument means a refusal cannot be added without someone deciding
 * which kind it is, and the two kinds read almost identically at the call site.
 */
async function recordStageUnavailable(
  db: any,
  item: EnrichableStockItem,
  stage: 'google_maps' | 'internet_search',
  status: 'unavailable' | 'failed',
  message: string,
  provider: string,
  ran: boolean,
): Promise<StageOutcome> {
  /*
   * A BLOCKED PASS IS COUNTED; AN ANSWER IS NOT.
   *
   * Storing the count here is what makes the retry BOUNDED: an outage, or a
   * provider nobody has configured, costs a property two passes rather than a
   * permanently retired stage or an unbounded paid loop.
   */
  const blocked = ran
    ? 0
    : Math.min(MAX_BLOCKED_PASSES, (await priorBlockedPasses(db, item, stage)) + 1);

  await db.from('builder_stock_item_images').upsert({
    stock_item_id: item.id,
    organisation_id: item.organisation_id,
    source_stage: stage,
    source_reference: 'stage-status',
    source_provider: provider,
    processing_status: status,
    verification_status: stage === 'google_maps' ? 'location_derived' : 'unverified',
    error_message: message,
    source_detail: ran ? { stage_ran: true } : { stage_ran: false, blocked_passes: blocked },
    position: 0,
  }, { onConflict: 'stock_item_id,source_stage,source_reference' });
  return { stage, status, detail: message };
}

/**
 * Record a stage that was not run because stage 1 already answered.
 *
 * A stage that PRODUCED something is left exactly as it is: on an existing
 * property being repaired, the Street View we already paid for stays on the
 * record. It simply stops being the picture the marketplace shows.
 */
async function recordStageSkipped(
  db: any,
  item: EnrichableStockItem,
  stage: 'google_maps' | 'internet_search',
): Promise<StageOutcome> {
  const message = STAGE_SKIPPED_MESSAGE;
  const { data: existing } = await db
    .from('builder_stock_item_images')
    .select('id')
    .eq('stock_item_id', item.id)
    .eq('source_stage', stage)
    .eq('processing_status', 'ready')
    .limit(1);

  if (!(existing ?? []).length) {
    await db.from('builder_stock_item_images').upsert({
      stock_item_id: item.id,
      organisation_id: item.organisation_id,
      source_stage: stage,
      /*
       * ITS OWN REFERENCE, BECAUSE IT IS NOT A FINDING ABOUT THE PROPERTY.
       * A skip records that stage 1 answered; a `stage-status` row records
       * that the stage RAN and found nothing. Written under one reference the
       * two were indistinguishable, so when stage 1's answer later changed —
       * a builder cover re-measured as a marketing tile — the ladder read its
       * own skips as an exhausted fallback and left the card blank with
       * neither paid stage ever asked.
       */
      source_reference: STAGE_SKIPPED_REFERENCE,
      source_provider: stage === 'google_maps' ? 'google' : 'perplexity',
      processing_status: 'unavailable',
      verification_status: stage === 'google_maps' ? 'location_derived' : 'unverified',
      error_message: message,
      position: 0,
    }, { onConflict: 'stock_item_id,source_stage,source_reference' });
  }
  return { stage, status: 'skipped', detail: message };
}

// ---------------------------------------------------------------------------
// Stage 2 — Google Maps / location
// ---------------------------------------------------------------------------

/**
 * Street View of the address, falling back to a satellite still.
 *
 * THE CREDENTIAL AND THE CONTROLS AROUND IT ARE THE EXISTING ONES.
 * `GOOGLE_MAPS_API_KEY` is the same secret `street-view`, `google-places-autocomplete`
 * and `resolve-listing-coordinates` spend, read from the environment inside
 * this function and never returned to any caller: the bytes land in a private
 * bucket and the browser gets a short-lived signed URL. Around it sit the same
 * `publicAbuseControls` primitives the Listings page's Street View proxy uses —
 * one kill switch, one daily ceiling and one circuit breaker on the shared
 * `google_street_view` scope, so a bulk stock import cannot quietly spend the
 * dashboard's Google budget or hammer a provider that is already failing.
 *
 * `meteredFetch` still wraps every call: it resolves the credential from the
 * host and writes the `api_usage_log` row, so this spend is recharged to the
 * tenant that made it.
 */
export async function enrichFromGoogle(
  db: any,
  item: EnrichableStockItem,
): Promise<StageOutcome> {
  const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'Location imagery is not configured for this workspace.', 'google', false);
  }

  const address = geocodableAddress(item);
  if (!address) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'This property has no street address to look up.', 'google', false);
  }

  /*
   * AND THERE HAS TO BE SOMETHING BUILT THERE TO PHOTOGRAPH.
   *
   * `geocodableAddress` will compose a findable line from a lot number and an
   * estate, which is what lets stage 2 name the property. It does NOT mean a
   * camera pointed at that point sees the property: on a lot in a new estate
   * it sees dirt or the road, and that is worse than a blank card because it
   * is presented to a client as their house.
   *
   * This is an ANSWER, not a block — the lookup was asked and this property
   * cannot be photographed from the street until it exists, which no retry
   * changes. `ran: true`, so the ladder settles instead of buying it again.
   */
  if (!hasPhotographableStreetAddress(item)) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'This property is a lot in an estate with no street address yet, so a '
      + 'street-level photograph would show the land rather than the property.',
      'google', true);
  }

  // The operator's off switch, shared with `street-view`.
  if (killSwitchActive('GOOGLE_STREET_VIEW_KILL_SWITCH')) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'Location imagery is temporarily switched off.', 'google', false);
  }

  /**
   * The circuit reports whether GOOGLE is failing. Fail OPEN when our own
   * circuit store cannot be read — that says nothing about Google, and
   * `street-view` records what treating an unreadable store as "open" cost:
   * an unapplied migration turned a local database gap into a total outage of
   * the feature.
   */
  const { data: circuitOpen, error: circuitReadError } = await db
    .rpc('provider_circuit_is_open', { p_scope: GOOGLE_CIRCUIT_SCOPE });
  if (circuitReadError) {
    console.warn('[builderStock] google circuit state unreadable, proceeding:',
      circuitReadError.message);
  } else if (circuitOpen === true) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'Location imagery is temporarily unavailable.', 'google', false);
  }

  // One unit per billable request, against the allowance for the SKU that
  // request actually bills to.
  //
  // This used to spend every one of the four — a geocode, Street View
  // metadata, a Street View image and a static map — against the single
  // `google_street_view` bucket. The per-request accounting was already right;
  // the ROUTING was not. Its geocode is billed by Google alongside every other
  // geocode this deployment makes, so it belongs in the product-wide
  // `google_geocoding` budget, and a static map is a different SKU again. A
  // bucket that mixes SKUs makes each configured ceiling mean nothing on its
  // own.
  //
  // `GOOGLE_CIRCUIT_SCOPE` is untouched: it still names this caller's breaker,
  // which is about Google failing rather than about what we have spent.
  // The refusal REASON travels out, because the message built from it is
  // persisted on the row as `error_message` and outlives the incident. Saying
  // "the daily limit has been reached" about a provider somebody switched off,
  // or about a counter that could not be read, is a false record that whoever
  // reads it next will act on.
  let lastRefusal: GoogleCapRefusal | undefined;
  const spend = async (kind: GoogleCapKind): Promise<boolean> => {
    const verdict = await consumeGoogleDailyCap(db, kind);
    lastRefusal = verdict.reason;
    if (!verdict.ok) console.warn(`[builderStock] ${kind} not attempted (${verdict.reason})`);
    return verdict.ok;
  };

  try {
    if (!await spend('geocoding')) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        clientMessageFor(lastRefusal), 'google', false);
    }
    const geocoded = await meteredFetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=au&key=${apiKey}`,
      {},
      { feature: 'builder-stock/geocode' },
    );
    const geo = await geocoded.json().catch(() => null);
    const match = geo?.results?.[0];
    const location = match?.geometry?.location;
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        'That address could not be located.', 'google', true);
    }

    /*
     * AND IT HAS TO BE A GEOCODE OF A PROPERTY, NOT OF A SUBURB.
     *
     * The panorama guard below measures the panorama against THIS point, so it
     * cannot catch a point that is itself wrong: the nearest panorama to the
     * middle of a suburb is a street in that suburb, and every distance check
     * passes on a photograph of somewhere else. That became reachable when
     * `geocodableAddress` learned to compose a line from the lot and the
     * estate — Google answers a name it does not know by falling back to the
     * locality.
     */
    const precision = assessGeocodePrecision(match);
    if (!precision.usable) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable', precision.reason, 'google', true);
    }

    const point = `${location.lat},${location.lng}`;
    let bytes: Uint8Array | null = null;
    let product = 'streetview';

    if (!await spend('streetView')) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        clientMessageFor(lastRefusal), 'google', false);
    }
    const metadata = await meteredFetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(point)}&key=${apiKey}`,
      {},
      { feature: 'builder-stock/streetview-metadata' },
    );
    const meta = await metadata.json().catch(() => ({}));

    if (meta?.status !== 'OK' && meta?.status !== 'ZERO_RESULTS') {
      // A provider error, not an absence of coverage. Tell the shared breaker.
      await db.rpc('provider_circuit_record_failure',
        { p_scope: GOOGLE_CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
    }

    /*
     * A PANORAMA HUNDREDS OF METRES AWAY IS NOT A PICTURE OF THIS HOUSE.
     *
     * PRODUCTION, 28 AUGUST 2026: Lot 1663 Ringer Street showed a roundabout.
     * Google answers with the NEAREST panorama to a geocode and says nothing
     * about whether that is useful; on a new estate whose own street has never
     * been driven, the nearest is the arterial road it joins. Nothing here
     * asked, so whatever came back became the card.
     *
     * Refused rather than substituted: the satellite tile below is a roof and
     * `imagePriority` will not rank it either, so the honest answer is no
     * picture. Blank is better than a roundabout.
     */
    const panorama = readLatLng(meta?.location);
    /** Recorded on the row, so which way the camera looked is auditable. */
    let heading: number | null = null;
    const usefulness = assessPanoramaUsefulness(
      panorama, { lat: location.lat, lng: location.lng });
    if (meta?.status === 'OK' && !usefulness.usable) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable', usefulness.reason, 'google', true);
    }

    if (meta?.status === 'OK' && await spend('streetView')) {
      /*
       * AIM THE CAMERA AT THE HOUSE.
       *
       * Without `heading` Google serves the panorama's own stored orientation
       * — the way the capture vehicle was pointing — which on Lot 13 Hummock
       * Rise produced a correct exact-address photograph looking down the
       * street rather than at the property. The panorama's location comes back
       * on the metadata call already made and the property's on the geocode
       * already made, so the bearing between them costs no extra request.
       *
       * `null` means the inputs cannot support a bearing, and then no heading
       * is sent at all: Google's default is a real orientation of a real
       * panorama, which is better than one this code invented.
       */
      heading = headingToProperty(
        panorama, { lat: location.lat, lng: location.lng });
      const params = new URLSearchParams({
        size: '640x400', location: point, fov: '80', pitch: '0',
        return_error_code: 'true', key: apiKey,
      });
      if (heading !== null) params.set('heading', String(heading));
      const image = await meteredFetch(
        `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`,
        {}, { feature: 'builder-stock/streetview' },
      );
      if (image.ok) bytes = new Uint8Array(await image.arrayBuffer());
      else {
        await db.rpc('provider_circuit_record_failure',
          { p_scope: GOOGLE_CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
      }
    }

    /**
     * NO SATELLITE PROMOTION. The product requirement is STREET VIEW, and a
     * satellite tile is not a photograph of a house — it is a roof. It is
     * still fetched and kept, because it is honest location imagery and other
     * surfaces may show it, but `imagePriority.pure.ts` ranks only
     * `streetview`, so a tile can never become a marketplace card image.
     *
     * Where there is no Street View coverage — normal on a new estate whose
     * road has not been driven — the card shows nothing, which is what the
     * rule asks for.
     */
    if (!bytes && await spend('staticMaps')) {
      product = 'staticmap';
      const params = new URLSearchParams({
        center: point, zoom: '18', size: '640x400', maptype: 'satellite',
        markers: `color:red|${point}`, key: apiKey,
      });
      const image = await meteredFetch(
        `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`,
        {}, { feature: 'builder-stock/staticmap' },
      );
      if (image.ok) bytes = new Uint8Array(await image.arrayBuffer());
    }

    if (bytes) {
      await db.rpc('provider_circuit_record_success', { p_scope: GOOGLE_CIRCUIT_SCOPE });
    }

    if (!bytes || bytes.length < 1024) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        'No location imagery is available for this address.', 'google', true);
    }

    const path = `${item.organisation_id}/items/${item.id}/google-${product}.jpg`;
    const { error: uploadError } = await db.storage
      .from(STOCK_IMAGE_BUCKET)
      .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
    if (uploadError) throw uploadError;

    await db.from('builder_stock_item_images').upsert({
      stock_item_id: item.id,
      organisation_id: item.organisation_id,
      source_stage: 'google_maps',
      source_reference: product,
      source_provider: 'google',
      storage_bucket: STOCK_IMAGE_BUCKET,
      storage_path: path,
      content_type: 'image/jpeg',
      byte_size: bytes.length,
      // Derived from the address we hold, which is a weaker claim than the
      // builder's own render and a much stronger one than a search result.
      verification_status: 'location_derived',
      confidence: product === 'streetview' ? 0.8 : 0.6,
      processing_status: 'ready',
      error_message: null,
      position: 0,
      /*
       * WHERE THE CAMERA WAS AND WHICH WAY IT LOOKED.
       *
       * The row used to record the property's own coordinates and nothing about
       * the photograph, so "is this aimed at the house, and was the camera
       * anywhere near it" could not be answered from the record at all — which
       * is exactly what a roundabout on a live card needed somebody to ask.
       */
      source_detail: {
        address, latitude: location.lat, longitude: location.lng, product,
        heading,
        panorama_latitude: panorama?.lat ?? null,
        panorama_longitude: panorama?.lng ?? null,
        panorama_distance_metres: usefulness.distanceMetres,
      },
    }, { onConflict: 'stock_item_id,source_stage,source_reference' });

    return { stage: 'google_maps', status: 'ready', detail: product };
  } catch (error) {
    console.warn('[builderStock] google enrichment failed', {
      item: item.id, message: String((error as { message?: string })?.message ?? error),
    });
    return await recordStageUnavailable(
      db, item, 'google_maps', 'failed',
      'Location imagery could not be retrieved.', 'google', false);
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — broader internet search
// ---------------------------------------------------------------------------

/**
 * What the property is called out in the world, for a search engine.
 *
 * Deliberately more than the address: a new estate's lots are not indexed
 * individually, but the development and the builder are.
 */
export function stockSearchQuery(
  item: EnrichableStockItem,
  builderName: string | null,
): string | null {
  const parts: string[] = [];
  if (item.address_line) parts.push(item.address_line);
  const development = item.development_name ?? item.project_name;
  if (development) parts.push(development);
  if (item.suburb) parts.push(item.suburb);
  if (item.state) parts.push(item.state);
  if (builderName) parts.push(builderName);
  if (item.lot_number) parts.push(`Lot ${item.lot_number}`);
  else if (item.unit_number) parts.push(`Unit ${item.unit_number}`);
  // A search on a suburb alone returns pictures of somewhere else in it.
  if (!item.address_line && !development) return null;
  return parts.join(', ').slice(0, 300);
}

/**
 * The broader search.
 *
 * THE CREDENTIAL IS THE EXISTING ONE. `PERPLEXITY_API_KEY` is the same secret
 * `estimate-property-expenses`, `generate-investment-report`,
 * `format-comparison-report` and `generate-market-intelligence-report` already
 * spend, read server-side and never returned to a caller. The call goes through
 * `meteredFetch`, which resolves the credential from `perplexity.ai` and writes
 * the `api_usage_log` row — the repo's rule is that a vendor call which skips
 * it is billed to nobody.
 */
export async function enrichFromInternetSearch(
  db: any,
  item: EnrichableStockItem,
  builderName: string | null,
): Promise<StageOutcome> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!apiKey) {
    return await recordStageUnavailable(
      db, item, 'internet_search', 'unavailable',
      'Internet property search is not configured for this workspace.', 'perplexity', false);
  }

  const query = stockSearchQuery(item, builderName);
  if (!query) {
    return await recordStageUnavailable(
      db, item, 'internet_search', 'unavailable',
      'This property does not name enough to search for.', 'perplexity', false);
  }

  try {
    const response = await withTimeout((signal) => meteredFetch(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar',
          temperature: 0,
          max_tokens: 700,
          messages: [
            {
              role: 'system',
              content: 'You find publicly published photographs of Australian residential property. '
                + 'Reply with JSON only: {"images":[{"image_url":"...","source_page_url":"...","title":"..."}]}. '
                + 'Only include direct links to image files (.jpg, .jpeg, .png, .webp) that you found on the page you cite. '
                + 'Never guess a URL. If you find none, reply {"images":[]}.',
            },
            {
              role: 'user',
              content: `Find published photographs or renders of this property or its development: ${query}`,
            },
          ],
        }),
      },
      { feature: 'builder-stock/image-search', model: 'sonar' },
    ));

    if (!response.ok) {
      return await recordStageUnavailable(
        db, item, 'internet_search', 'failed',
        'The property search service did not respond.', 'perplexity', false);
    }

    const payload = await response.json().catch(() => null);
    const content = String(payload?.choices?.[0]?.message?.content ?? '');
    const candidates = parseSearchImages(content);

    if (!candidates.length) {
      return await recordStageUnavailable(
        db, item, 'internet_search', 'unavailable',
        'No published imagery was found for this property.', 'perplexity', true);
    }

    /**
     * EVERY CANDIDATE IS CHECKED AGAINST THE PROPERTY BEFORE IT MAY BE SHOWN.
     *
     * Finding a URL is not verifying a property. A candidate that passes
     * `verifyWebImageIdentity` is written with the positive verification state
     * and the evidence that earned it; one that does not is still recorded —
     * with its refusal reason — as `unverified`, which is the state every
     * historical row has and which nothing displays. So a rejection is
     * auditable and is never a card image.
     */
    let verified = 0;
    for (const [index, candidate] of candidates.entries()) {
      const verdict = verifyWebImageIdentity({
        imageUrl: candidate.imageUrl,
        pageUrl: candidate.pageUrl,
        title: candidate.title,
      }, {
        addressLine: item.address_line,
        lotNumber: item.lot_number,
        unitNumber: item.unit_number,
        developmentName: item.development_name,
        projectName: item.project_name,
        suburb: item.suburb,
        state: item.state,
        postcode: item.postcode,
        builderName,
      });
      if (verdict.ok) verified += 1;

      await db.from('builder_stock_item_images').upsert({
        stock_item_id: item.id,
        organisation_id: item.organisation_id,
        source_stage: 'internet_search',
        source_reference: candidate.imageUrl.slice(0, 400),
        source_provider: 'perplexity',
        source_page_url: candidate.pageUrl,
        // Recorded as a link HERE, and stored by the settler's own sweep once
        // it verifies. This used to say "copying it into our bucket would
        // make it look like ours", which confused serving with provenance:
        // origin is these columns, and what the link actually bought was a
        // dependency on the publisher's server — measured on lot 310 Watsons
        // Reach, whose card said "Web sourced" over an image the source site
        // had deleted (HTTP 404). `webImageStore.ts` takes the bytes for
        // every VERIFIED web image and retires one only when its address
        // answers that the picture is gone.
        external_url: candidate.imageUrl,
        verification_status: verdict.ok ? WEB_VERIFIED_VERIFICATION : 'unverified',
        confidence: verdict.ok ? 0.6 : 0.3,
        processing_status: 'ready',
        position: index,
        source_detail: {
          query, title: candidate.title,
          ...(verdict.ok
            ? {
              property_identity: {
                matched: verdict.matched,
                verified_at: new Date().toISOString(),
                stock_item_id: item.id,
                organisation_id: item.organisation_id,
                source_page_url: candidate.pageUrl ?? null,
                query_fingerprint: query,
              },
            }
            : { identity_refused: verdict.reason, identity_matched: verdict.matched }),
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' });
    }

    return {
      stage: 'internet_search',
      status: verified ? 'ready' : 'unavailable',
      detail: `${candidates.length} candidate(s), ${verified} verified`,
    };
  } catch (error) {
    console.warn('[builderStock] internet search failed', {
      item: item.id, message: String((error as { message?: string })?.message ?? error),
    });
    return await recordStageUnavailable(
      db, item, 'internet_search', 'failed',
      'The property search could not be completed.', 'perplexity', false);
  }
}

interface SearchCandidate { imageUrl: string; pageUrl: string | null; title: string | null }

/** Pull the candidates out of the model's reply, discarding anything unusable. */
export function parseSearchImages(content: string): SearchCandidate[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: { images?: unknown };
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed.images) ? parsed.images : [];
  const out: SearchCandidate[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const imageUrl = String((row as { image_url?: unknown }).image_url ?? '').trim();
    if (!/^https:\/\/[^\s"']+$/i.test(imageUrl)) continue;
    if (imageUrl.length > 1500) continue;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(imageUrl)) continue;
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const pageUrl = String((row as { source_page_url?: unknown }).source_page_url ?? '').trim();
    out.push({
      imageUrl,
      pageUrl: /^https?:\/\//i.test(pageUrl) ? pageUrl.slice(0, 1500) : null,
      title: String((row as { title?: unknown }).title ?? '').trim().slice(0, 200) || null,
    });
    if (out.length >= 4) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run stages 2 and 3 for one property and settle its enrichment status.
 *
 * Stage 1 already ran at import time. The primary image is then chosen by
 * priority — the builder's own image, then location imagery, then a search
 * result — and nothing is deleted when a better one appears.
 */
export async function enrichStockItem(
  db: any,
  item: EnrichableStockItem,
  builderName: string | null,
): Promise<{ outcomes: StageOutcome[]; enrichmentStatus: string }> {
  await db.from('builder_stock_items')
    .update({ enrichment_status: 'enriching' })
    .eq('id', item.id);

  const outcomes: StageOutcome[] = [];

  /**
   * STAGE 1 SETTLES IT.
   *
   * A property whose builder supplied a photograph has nothing to gain from a
   * Street View of the same lot or a search for a picture that might be it:
   * the priority below would discard both anyway, and each is a call billed to
   * somebody. The three-stage record is still written — stages 2 and 3 say
   * they were skipped and why — so the audit row reads as three stages, which
   * is what it is.
   */
  /**
   * ONE STAGE AT A TIME, IN PRIORITY ORDER — never all three ranked afterwards.
   *
   * What changed: this used to run BOTH paid stages whenever stage 1 produced
   * nothing, and the selector then discarded whatever they wrote, because the
   * old rule was builder-supplied-or-nothing. So every property without a
   * source picture bought a geocode, a Street View metadata call, a Street
   * View still (or a satellite tile) AND a Perplexity search, to display none
   * of them.
   *
   * `nextImageStage` decides instead, from the rows this property already
   * holds. Its `wait` answer is the one that matters most: a source image
   * whose display verdict has not been measured yet is evidence that has not
   * ARRIVED, and paying for a search against it is how a builder's own render
   * loses to a photograph of somebody else's estate.
   */
  const { data: rows } = await db
    .from('builder_stock_item_images')
    .select('id, source_stage, source_reference, error_message, verification_status, '
      + 'processing_status, position, storage_path, external_url, source_detail')
    .eq('stock_item_id', item.id);

  const stage = nextImageStage((rows ?? []) as never, {
    sourceSettlementComplete: item.sourceSettlementComplete !== false,
  });

  /*
   * ONLY A STAGE THAT WAS GENUINELY UNNECESSARY IS RECORDED AS SKIPPED.
   *
   * A skip row is byte-identical to a "ran and found nothing" row — same
   * `stage-status` reference, same `unavailable` status — so writing one for a
   * stage the ladder simply had not REACHED yet made an untried stage
   * indistinguishable from an exhausted one. Lot 1663 Ringer Street carried
   * `google_maps: "Skipped: the builder supplied an image for this property."`
   * while holding no builder image at all, and Street View was never attempted.
   *
   * So the skip is written only where stage 1 actually answered. A stage the
   * ladder has not reached gets NO row, and its absence is what says so.
   */
  if (stage === 'none') {
    for (const skipped of ['google_maps', 'internet_search'] as const) {
      outcomes.push(await recordStageSkipped(db, item, skipped));
    }
  } else if (stage === 'wait') {
    // Not a finding about the property. It writes nothing, as it says.
  } else if (stage === 'web_search') {
    outcomes.push(await enrichFromInternetSearch(db, item, builderName));
  } else {
    outcomes.push(await enrichFromGoogle(db, item));
  }

  const primaryImageId = await chooseAndStorePrimaryImage(db, item.id);
  const anyReady = !!primaryImageId;
  const anyProblem = outcomes.some(
    (outcome) => outcome.status !== 'ready' && outcome.status !== 'skipped');

  /*
   * `failed` IS TERMINAL, SO IT MUST NOT BE WRITTEN OVER AN UNTRIED STAGE.
   *
   * `readFallbackQueue` selects `pending`/`enriching` only, so a `failed` row
   * never comes back. One invocation runs ONE stage of the ladder, so writing
   * `failed` the moment that stage produced nothing retired the property with
   * the stages below it never attempted — which is how three cards reached the
   * live Marketplace blank while Street View had never been asked.
   *
   * Re-reading is what makes this honest: the answer must come from the rows
   * as they now stand, not from the plan made before the stage ran.
   */
  const { data: settledRows } = await db
    .from('builder_stock_item_images')
    .select('id, source_stage, source_reference, error_message, verification_status, '
      + 'processing_status, position, storage_path, external_url, source_detail')
    .eq('stock_item_id', item.id);
  const remainingStage = nextImageStage((settledRows ?? []) as never, {
    sourceSettlementComplete: item.sourceSettlementComplete !== false,
  });
  const ladderHasMore = remainingStage !== 'none';

  /*
   * THE LADDER DECIDES WHEN A PROPERTY IS FINISHED — NOT WHETHER BYTES LANDED.
   *
   * `ladderHasMore` used to be consulted ONLY on the `!anyReady` arm, and
   * `anyReady` means "a stage stored an image", which is not the same question
   * as "this property has a picture". A web result that stores cleanly and then
   * fails the identity check is a `ready` OUTCOME and a non-displayable IMAGE.
   *
   * So a property could be marked `partial` — terminal, and `readFallbackQueue`
   * selects `pending`/`enriching` only — while `nextImageStage` still owed it a
   * rung. The shape that reaches it: stage 2 stores an unverified image
   * (`ready`), stage 3 is BLOCKED in the same claim by an outage, an open
   * circuit or the daily ceiling (`stage_ran: false`, one bounded pass spent),
   * and the property settles blank with Street View never asked and a retry
   * unspent. Exactly the state `settled` may not mean.
   *
   * `ladderHasMore` is already computed from a fresh re-read of the rows as
   * they now stand, which is the honest source and the reason that re-read
   * exists. Asking it FIRST changes no vocabulary — `complete`, `partial` and
   * `failed` keep their meanings — it only stops any of them being written
   * while a stage is still owed. It terminates for the same reason it always
   * did: a blocked stage becomes attempted at `MAX_BLOCKED_PASSES`, and a
   * property holding a displayable picture answers `none` before anything else.
   */
  const enrichmentStatus = ladderHasMore
    ? 'pending'
    : (anyReady ? (anyProblem ? 'partial' : 'complete') : 'failed');

  await db.from('builder_stock_items')
    .update({ enrichment_status: enrichmentStatus, enriched_at: new Date().toISOString() })
    .eq('id', item.id);

  return { outcomes, enrichmentStatus };
}

export { chooseAndStorePrimaryImage, SOURCE_SUPPLIED_STAGE } from './primaryImage.ts';
