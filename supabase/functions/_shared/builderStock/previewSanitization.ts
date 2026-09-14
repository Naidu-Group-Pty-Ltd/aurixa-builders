/**
 * Builder stock — LOOK at a repair candidate before it can become a served
 * picture.
 *
 * WHY THIS EXISTS. The generative route is the only one that can take three
 * separated marks off a Cloverton facade — the deterministic route answers
 * `background_too_detailed` on that set — and the model it uses is Workers AI
 * behind the private worker, reachable only with a bearer token held as a
 * deployment secret. So the only place a candidate could be produced was
 * production, and the only way to see one was to let it replace the picture a
 * client is already being shown. "Generate it and look at it afterwards" is not
 * a review; it is a deployment with an apology attached.
 *
 * This closes exactly that gap and nothing else: the same bytes, the same
 * region rules, the same sanitizer, the same barriers, the same post-repair
 * validation — and the answer handed back as a PNG instead of written anywhere.
 *
 * IT WRITES NOTHING, AND THAT IS THE WHOLE PROPERTY. No derivative object, no
 * `source_detail`, no attempt stamp, no clearance, no failure, no settlement
 * marker, no `primary_image_id`, no `repair_region`. It holds a service-role
 * client because it must read a private object, and it uses it for `select`
 * and `download` only. `previewSanitization.test.ts` fails the build if any
 * mutating call is reached, because a preview that can write is not a preview.
 *
 * THE ONE SIDE EFFECT IT DOES HAVE is the model call itself, which is real
 * spend on a forwarded vendor credential — so it goes through the same
 * `meteredFetch` every other call to that worker goes through, and lands in
 * `api_usage_log` like any other. Metering is not a write this may skip: an
 * unmetered vendor call is billed to nobody, which this repository has already
 * paid for once. It is measured rather than assumed, and reported back as
 * `modelCalls`.
 *
 * IT PROVES THE PREMISE BEFORE IT SPENDS. A region is a rectangle somebody
 * measured on EXACT bytes; applied to any other bytes it rebuilds a piece of
 * somebody's house from a model's imagination. So the caller names the
 * SHA-256 it measured on, the row is read under its own organisation, the
 * object is downloaded and re-hashed, and all three must agree before the
 * sanitizer is called at all.
 */
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import { sanitizeSourceImage } from './sanitizeImage.ts';
import { sha256Hex } from './rasterPng.ts';
import { storedOriginalSha } from './sanitizedDerivative.pure.ts';
import {
  oversizedRepairRegionShare, readRepairRegion, combinedAreaShare,
  MAX_REPAIRED_SHARE, REPAIR_REGION_KEY, type RepairRegionBox,
} from './repairRegion.pure.ts';
import { isPrimaryRole, readStoredRole } from './sourceImageRole.pure.ts';

/** What the caller must name. Nothing here is optional and nothing is inferred. */
export interface PreviewRequest {
  organisationId: string;
  imageId: string;
  /** The bytes the rectangles were measured on. Compared against the object. */
  originalSha256: string;
  boxes: RepairRegionBox[];
}

export type PreviewOutcome =
  | {
    ok: true;
    bytes: Uint8Array;
    width: number;
    height: number;
    transformation: string;
    repairedShare: number;
    regionsRemoved: number;
    model: string | null;
    /** Measured from the metering ledger, not guessed. Null when unreadable. */
    modelCalls: number | null;
  }
  | { ok: false; status: number; reason: string; detail: string };

const refuse = (status: number, reason: string, detail: string): PreviewOutcome =>
  ({ ok: false, status, reason, detail });

/** The service the worker's spend is metered under. */
const WORKER_SERVICE = 'builderstockimageworker';

/**
 * How many worker calls landed since `since`.
 *
 * MEASURED, BECAUSE THE ALTERNATIVE IS A GUESS. The number of model calls a
 * repair makes is a property of how the mask fell into patches, which nothing
 * the sanitizer returns reports. Counting the metering rows it produced is the
 * one honest reading available, and it is the same ledger the bill comes from.
 *
 * It can over-count if a settlement tick spends on the same worker in the same
 * window; that is visible rather than hidden, and null is returned rather than
 * a zero if the ledger cannot be read.
 */
async function meteredCallsSince(db: any, since: string): Promise<number | null> {
  try {
    const { count, error } = await db
      .from('api_usage_log')
      .select('id', { count: 'exact', head: true })
      .eq('service_name', WORKER_SERVICE)
      .gte('created_at', since);
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

/**
 * Produce a candidate for one image and hand back its bytes.
 *
 * `deps.sanitize` exists for the same reason it exists on the settler: so a
 * test can drive every gate here without a model. Production passes nothing and
 * gets the real sanitizer, which reaches the real worker through the deployment
 * secret — the secret is never read here and never leaves the function.
 */
export async function previewSanitization(
  db: any,
  input: PreviewRequest,
  deps: { sanitize?: typeof sanitizeSourceImage } = {},
): Promise<PreviewOutcome> {
  const organisationId = String(input?.organisationId ?? '');
  const imageId = String(input?.imageId ?? '');
  const requestedSha = String(input?.originalSha256 ?? '');
  const boxes = Array.isArray(input?.boxes) ? input.boxes : null;

  if (!organisationId || !imageId) {
    return refuse(400, 'invalid_request', 'an organisation and an image must be named');
  }
  if (!/^[0-9a-f]{64}$/i.test(requestedSha)) {
    return refuse(400, 'invalid_request', 'the original sha-256 must be named in full');
  }
  if (!boxes || !boxes.length) {
    return refuse(400, 'invalid_request', 'at least one repair rectangle must be given');
  }

  /*
   * SCOPED BY ORGANISATION IN THE QUERY, not checked after it. This holds a
   * service-role client and crosses organisations, so an image belonging to
   * somebody else must be indistinguishable from one that does not exist —
   * both answer 404, and neither confirms the other tenant's row.
   */
  const { data: row, error } = await db
    .from('builder_stock_item_images')
    .select('id, stock_item_id, organisation_id, storage_bucket, storage_path, source_detail')
    .eq('id', imageId)
    .eq('organisation_id', organisationId)
    .maybeSingle();

  if (error) {
    /*
     * A READ THAT FAILED IS NOT A ROW THAT IS ABSENT. 503 says try again;
     * 404 would send an operator looking for an image that is sitting there.
     */
    return refuse(503, 'image_unreadable',
      String((error as { message?: string })?.message ?? error).slice(0, 200));
  }
  if (!row) return refuse(404, 'image_not_found', 'no such image for this organisation');

  const detail = (row.source_detail ?? {}) as Record<string, unknown>;

  if (!isPrimaryRole(readStoredRole(detail))) {
    /*
     * Only a designated primary can reach a card, so only a designated primary
     * is worth rebuilding. An interior or a floorplan carrying a badge is not a
     * repair candidate whatever is drawn on it.
     */
    return refuse(409, 'not_primary', 'this image is not the designated primary for its property');
  }

  const storedSha = storedOriginalSha(detail);
  if (!storedSha || storedSha !== requestedSha) {
    return refuse(409, 'sha_mismatch',
      'the row does not hold the bytes these rectangles were measured on');
  }

  /*
   * THE REGION RULES ARE PRODUCTION'S OWN, IMPORTED RATHER THAN RESTATED. The
   * request is shaped into the record a row would carry and read back through
   * `readRepairRegion`, so shape, the four-box cap, one-malformed-voids-the-set,
   * the origin test and BARRIER A over the exact union are all the same rule
   * the sweep will apply — a preview that judged by its own copy of the rules
   * would be a preview of a different repair.
   */
  const asRecord = {
    [REPAIR_REGION_KEY]: { boxes, original_sha256: requestedSha },
  } as Record<string, unknown>;
  const permitted = readRepairRegion(asRecord, storedSha);
  if (!permitted) {
    const oversized = oversizedRepairRegionShare(asRecord, storedSha);
    if (oversized !== null) {
      return refuse(422, 'region_too_large',
        `the rectangles cover ${(oversized * 100).toFixed(1)}% of the frame; the ceiling is `
        + `${(MAX_REPAIRED_SHARE * 100).toFixed(0)}%`);
    }
    return refuse(422, 'region_malformed',
      'a rectangle is inverted, empty, outside the frame, or there are more than the cap allows');
  }

  if (!row.storage_path) {
    return refuse(409, 'no_stored_object', 'this row has no stored object to read bytes from');
  }

  const bucket = row.storage_bucket || STOCK_IMAGE_BUCKET;
  const { data: blob, error: downloadError } = await db.storage
    .from(bucket).download(row.storage_path);
  if (downloadError || !blob) {
    return refuse(503, 'object_unreadable', 'the stored object could not be read');
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return refuse(503, 'object_unreadable', 'the stored object could not be read');
  }

  /*
   * HASHED FROM THE BYTES JUST READ, never from the hash the row records.
   * The row's hash says what is SUPPOSED to be in the bucket; a region applied
   * to whatever is actually there is the failure this check exists for.
   */
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== requestedSha) {
    return refuse(409, 'object_sha_mismatch',
      'the stored object is not the bytes these rectangles were measured on');
  }

  const startedAt = new Date().toISOString();
  const before = await meteredCallsSince(db, startedAt);

  /*
   * THE PRODUCTION PATH, UNMODIFIED. Barrier B is measured inside this call on
   * the final grown and feathered mask and refuses before the first model call;
   * the post-repair validation runs inside it too. Nothing about the repair is
   * special-cased for a preview — that is the point of a preview.
   */
  const sanitize = deps.sanitize ?? sanitizeSourceImage;
  const result = await sanitize(bytes, { repairRegion: permitted });

  const after = await meteredCallsSince(db, startedAt);
  const modelCalls = before === null || after === null ? null : Math.max(0, after - before);

  if (result.ok === false) {
    const operational = Boolean((result as { operational?: boolean }).operational)
      || result.reason === 'inpaint_unavailable' || result.reason === 'inpaint_failed';
    return refuse(
      operational ? 503 : 422,
      String(result.reason),
      String((result as { detail?: unknown }).detail ?? '').slice(0, 300)
        || 'the repair produced no candidate',
    );
  }

  return {
    ok: true,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    transformation: result.transformation,
    repairedShare: result.repairedShare,
    regionsRemoved: result.regionsRemoved,
    model: result.model ?? null,
    modelCalls,
  };
}

/** The union the caller asked for, for a refusal message. Exported for tests. */
export function requestedUnionShare(boxes: RepairRegionBox[]): number {
  return combinedAreaShare(boxes);
}
