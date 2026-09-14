/**
 * Builder stock — a repair region somebody established, persisted on the image.
 *
 * WHAT THIS IS. `sanitizeImage.ts` already accepts a `repairRegion` — a
 * rectangle, in fractions of the picture's own width and height, that the
 * caller has identified by means other than the detector. This module is the
 * other half of that: where such a rectangle is WRITTEN DOWN, so the ordinary
 * five-minute sweep can find it and act on it without anybody running anything.
 *
 * WHY IT HAS TO BE PERSISTED AT ALL. The detector's mask builder reads lines of
 * TYPE. A promotional plate whose lettering falls below the measuring
 * resolution, or whose plate is too close to black to separate from a shadowed
 * eave, produces no mask and no conviction — the picture measures clean and is
 * served with the plate on it. The only alternatives are to move a global
 * threshold, which was measured against real clean production facades and is
 * not safe, or to record the rectangle once against those exact bytes. This is
 * the second.
 *
 * IT IS ORDINARY IMAGE METADATA AND NOTHING MORE. It is a key in the same
 * `source_detail` document the derivative, the failure and the clearance live
 * in; it names no property, no builder and no file; and any image row may carry
 * one. Nothing reads it to decide whether a card may DRAW — it decides only
 * which pixels a repair rebuilds, and the repaired result still goes back
 * through the same classifier before it may be served.
 *
 * THE ORIGIN TEST IS THE SAME ONE A DERIVATIVE GETS, and here it matters more
 * than anywhere else in this family. A derivative bound to the wrong bytes
 * shows a stale picture; a REGION applied to the wrong bytes rebuilds a
 * rectangle of somebody's house from a model's imagination. So a region names
 * the SHA-256 it was measured on, that hash is compared exactly against what
 * the row currently holds, and a region that cannot prove its origin is not a
 * region. A builder who replaces the file has replaced the premise.
 *
 * Pure: no imports, no IO, no clock.
 */

/** Where the record lives inside `source_detail`. */
export const REPAIR_REGION_KEY = 'repair_region';

/**
 * The most of a photograph any repair may ever rebuild.
 *
 * THE NUMBER IS FITTED TO PRODUCTION, NOT CHOSEN. Across all 17 derivatives
 * this programme has made, the repaired share runs 2.96% to 22.73% — median
 * 7.58%, p90 15.15% — and the largest, Lot 1663's two-region cover, is the
 * 22.73%. The only persisted rectangle anyone has recorded by hand, Lot 914
 * Covella's, is 2.34%. A banner run the full width of a frame at a third of
 * its height is 33%. So 35% clears every real promotional treatment this
 * marketplace has met, with the widest of them at two thirds of the ceiling,
 * and nothing in production is invalidated by it.
 *
 * WHAT IT IS ACTUALLY FOR is the other end. Past roughly a third of the frame
 * the words stop describing a badge on a photograph and start describing a
 * photograph with some corners kept: the model is no longer reconstructing
 * what a graphic covered, it is inventing a house. Worse, every guarantee in
 * this area is written in terms of the pixels OUTSIDE the repair —
 * `outsidePermittedRegionUnchanged` compares exactly those and nothing else —
 * so a mask that approaches the whole frame does not fail that gate, it
 * empties it. A rule stated as "the AI may only touch the graphic" has to be
 * enforced as a bound on how much it may touch, or it is not enforced at all.
 *
 * AND THAT IS ALL IT ENFORCES. The ceiling bounds HOW MUCH may be rebuilt,
 * never WHICH pixels: a wrong mask inside the ceiling spends its whole budget
 * on the wrong tenth of the house and passes every gate stated in terms of
 * the mask. A bounded mask does not restore the guarantee the unbounded one
 * emptied — it caps the blast radius. Whether the permitted set is the RIGHT
 * set is decided where the mask is derived (`overlayPlate.pure.ts`, which
 * holds every plate, flooded or fallen back to, to its own line of type).
 */
export const MAX_REPAIRED_SHARE = 0.35;

/** How much of the frame a rectangle covers, as a fraction of its area. */
export function regionAreaShare(box: RepairRegionBox): number {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (!(width > 0) || !(height > 0)) return 0;
  return width * height;
}

/** The most rectangles one record may carry — the generative route's own patch cap. */
export const MAX_REGION_BOXES = 4;

/**
 * The share of the frame a SET of rectangles covers — their union, exactly.
 *
 * Computed by coordinate compression rather than by summing areas (which
 * double-counts overlap and would refuse an honest pair of touching boxes)
 * and never by their common bounding box (which counts the house between two
 * corner marks as though it were being rebuilt). At most four boxes, so the
 * grid is at most 7x7 cells.
 */
export function combinedAreaShare(boxes: RepairRegionBox[]): number {
  const xs = Array.from(new Set(boxes.flatMap((box) => [box.left, box.right]))).sort((a, b) => a - b);
  const ys = Array.from(new Set(boxes.flatMap((box) => [box.top, box.bottom]))).sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (boxes.some((box) =>
        cx > box.left && cx < box.right && cy > box.top && cy < box.bottom)) {
        covered += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    }
  }
  return covered;
}

/** A rectangle, as fractions of the picture's own width and height. */
export interface RepairRegionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface StoredRepairRegion extends Partial<RepairRegionBox> {
  /**
   * SEVERAL SEPARATED MARKS, WHERE ONE RECTANGLE WOULD LIE. A picture can
   * carry a pill in one corner, a plate in another and a strip along the
   * bottom; a single rectangle spanning all three is mostly house, and a
   * mask that is mostly house is exactly what the area ceiling exists to
   * refuse. So a record may carry up to `MAX_REGION_BOXES` rectangles, each
   * held to the same shape rules, with the CEILING applied to their combined
   * covered area — never to the bounding box of the set, which would refuse
   * honest regions for the space between them. A legacy record carrying only
   * the top-level rectangle reads exactly as it always did.
   */
  boxes?: RepairRegionBox[];
  /**
   * The bytes this rectangle was measured on. Required, never inferred.
   *
   * See the header: unlike every other record in this family, a region whose
   * origin cannot be proved does not merely mislead — it rebuilds pixels.
   */
  original_sha256: string;
  /**
   * How the rectangle came to be known, in prose, for whoever reads the row
   * next. Free text and never parsed: nothing branches on it.
   */
  established_by?: string;
  recorded_at?: string;
}

/** Within the frame, the right way round, not empty. Shape only — size is Barrier A's. */
function shapedLikeARegion(box: RepairRegionBox): boolean {
  for (const value of [box.left, box.top, box.right, box.bottom]) {
    if (!Number.isFinite(value)) return false;
    if (value < 0 || value > 1) return false;
  }
  return box.right > box.left && box.bottom > box.top;
}

/**
 * The rectangles a stored record asks for, shape-checked but not size-checked.
 *
 * A record carrying `boxes` is read from them alone; a legacy record carrying
 * only the top-level rectangle reads as one box, exactly as it always did.
 * ANY malformed rectangle voids the whole record — a set where three boxes
 * are honest and one is `{0,0,1,1}` is not three honest boxes.
 */
function storedBoxes(record: Partial<StoredRepairRegion>): RepairRegionBox[] | null {
  const raw: Array<Partial<RepairRegionBox> | undefined> =
    Array.isArray(record.boxes) && record.boxes.length
      ? record.boxes
      : [{ left: record.left, top: record.top, right: record.right, bottom: record.bottom }];
  if (raw.length > MAX_REGION_BOXES) return null;
  const boxes: RepairRegionBox[] = [];
  for (const entry of raw) {
    const box: RepairRegionBox = {
      left: Number(entry?.left),
      top: Number(entry?.top),
      right: Number(entry?.right),
      bottom: Number(entry?.bottom),
    };
    if (!shapedLikeARegion(box)) return null;
    boxes.push(box);
  }
  return boxes;
}

/**
 * Read a persisted region, if it is one this code may act on.
 *
 * Fails closed in every direction. A malformed, inverted, out-of-frame or
 * unattributable rectangle is treated exactly as no rectangle at all — the
 * picture goes on being judged by the detector alone, which is the behaviour
 * every image without a region already has.
 *
 * Returns the record's rectangles (one, for a legacy record) — the caller
 * rebuilds their union and nothing else.
 */
export function readRepairRegion(
  sourceDetail: Record<string, unknown> | null | undefined,
  originalSha256: string | null | undefined,
): RepairRegionBox[] | null {
  const raw = (sourceDetail ?? {})[REPAIR_REGION_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<StoredRepairRegion>;

  if (typeof record.original_sha256 !== 'string' || !record.original_sha256) return null;
  if (!originalSha256 || record.original_sha256 !== originalSha256) return null;

  const boxes = storedBoxes(record);
  if (!boxes) return null;

  /*
   * BARRIER A. Every other check here asks whether the rectangles are
   * rectangles; this one asks whether they are a BADGE. Without it
   * `{0,0,1,1}` is a perfectly well-formed region covering the entire
   * photograph, and it is the deterministic route's own size ceiling that
   * then hands it to the model: a region too big to rebuild arithmetically
   * refuses with `too_much_to_rebuild`, and that is one of exactly two
   * reasons `sanitizeSourceImage` escalates to the generative route. The
   * bigger the area somebody writes down, the more certainly it reached the
   * model. Applied to the COMBINED covered area of the set — the pixels that
   * would actually be writable — never to a bounding box.
   */
  if (combinedAreaShare(boxes) > MAX_REPAIRED_SHARE) return null;

  return boxes;
}

/**
 * A region this row genuinely records, refused ONLY for its size.
 *
 * `readRepairRegion` fails closed, which is right and which also makes an
 * oversized rectangle indistinguishable from no rectangle at all — and those
 * are very different things to whoever wrote one down. This says "there is a
 * region here, it is attributed to these exact bytes, and it asks for more of
 * the photograph than any repair may rebuild", so the caller can say so once
 * instead of silently doing nothing. Returns the share, or null.
 */
export function oversizedRepairRegionShare(
  sourceDetail: Record<string, unknown> | null | undefined,
  originalSha256: string | null | undefined,
): number | null {
  const raw = (sourceDetail ?? {})[REPAIR_REGION_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<StoredRepairRegion>;
  if (typeof record.original_sha256 !== 'string' || !record.original_sha256) return null;
  if (!originalSha256 || record.original_sha256 !== originalSha256) return null;

  const boxes = storedBoxes(record);
  if (!boxes) return null;

  const share = combinedAreaShare(boxes);
  return share > MAX_REPAIRED_SHARE ? share : null;
}
