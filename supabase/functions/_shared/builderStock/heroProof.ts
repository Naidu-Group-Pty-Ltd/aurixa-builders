/**
 * THE HERO STANDARD'S PRIVATE PROOF — before and after, drawn inside the
 * platform and kept there.
 *
 * A representative set of real, planned card pictures is re-planned with a
 * proof tile (`heroPlanning.ts`): the picture as cards drew it before this
 * standard (whole, contained) beside the frame the plan draws, with the
 * photograph outlined blue, the building orange and the frame green. The
 * tiles are composed into PNG sheets and written to the image bucket's
 * private `_hero-proof/` prefix, which only the service role can read.
 *
 * NOTHING ABOUT A PICTURE LEAVES THE PLATFORM HERE. The answer is counts and
 * storage paths; the sheet itself is opened by an operator from the project's
 * own storage. Re-planning is also the determinism check: the plan drawn for
 * the proof must equal the plan stored, or the row says so.
 */
import { encodePng } from './rasterPng.ts';
import { blit, rect } from './heroPlanning.ts';
import { drawLabel } from './heroProofLabel.pure.ts';
import { heroPlanOfImage, servedObjectOf } from './primaryImage.ts';
import { planHeroWithCapacity } from './heavyWorkClient.ts';
import { readHeroCandidates, readServedBytes } from './settleMarketplaceHero.ts';
import type { HeroPlan, PixelRect } from './marketplaceHero.pure.ts';

export type ProofCategory =
  | 'huge_sky' | 'tiny_house' | 'canvas_trimmed' | 'already_good' | 'repaired' | 'shown_whole' | 'framed';

export const PROOF_CATEGORY_COLOUR: Record<ProofCategory, [number, number, number]> = {
  huge_sky: [70, 140, 230], tiny_house: [230, 120, 30], canvas_trimmed: [150, 90, 200],
  already_good: [40, 170, 90], repaired: [210, 60, 60], shown_whole: [90, 90, 90], framed: [200, 180, 40],
};

export function proofCategory(plan: HeroPlan, object: 'original' | 'derivative'): ProofCategory {
  if (object === 'derivative') return 'repaired';
  if (plan.mode === 'original') return 'already_good';
  if (plan.mode === 'fit') return 'shown_whole';
  if (plan.reasons.includes('canvas_trimmed')) return 'canvas_trimmed';
  if (plan.reasons.includes('subject_enlarged')) return 'tiny_house';
  if (plan.crop.y / plan.source.height >= 0.2) return 'huge_sky';
  return 'framed';
}

export interface ProofOutcome {
  sheets: string[];
  rows: number;
  byCategory: Partial<Record<ProofCategory, number>>;
  deterministic: number;
  nonDeterministic: number;
  failed: number;
  stoppedForTime: boolean;
}

const BAND = 14;
const GAP = 6;

export async function drawHeroProof(
  db: any,
  options: {
    perCategory?: number; maxRows?: number; maxDecodes?: number; includeArchived?: boolean;
    deadlineAt?: number; bucket?: string;
  },
): Promise<ProofOutcome> {
  const perCategory = options.perCategory ?? 2;
  const maxRows = Math.min(16, options.maxRows ?? 12);
  const bucket = options.bucket ?? 'builder-stock-images';
  const groups = await readHeroCandidates(db, { includeArchived: options.includeArchived });
  const outcome: ProofOutcome = {
    sheets: [], rows: 0, byCategory: {}, deterministic: 0, nonDeterministic: 0, failed: 0, stoppedForTime: false,
  };
  const tiles: Array<{ width: number; height: number; pixels: Uint8Array; category: ProofCategory }> = [];
  const index: Array<Record<string, unknown>> = [];
  /*
   * A picture with a stored plan is drawn from it and checked against a fresh
   * plan (determinism). One without — archived stock, which is not backfilled
   * — is planned fresh for the proof and NOTHING is stored, so the proof can
   * never become a partial backfill.
   */
  const taken: Partial<Record<ProofCategory, number>> = {};
  let decodes = 0;
  const maxDecodes = options.maxDecodes ?? 40;
  for (const { images } of groups) {
    if (tiles.length >= maxRows || decodes >= maxDecodes) break;
    if (options.deadlineAt && Date.now() > options.deadlineAt) { outcome.stoppedForTime = true; break; }
    const image = images[0];
    const stored = heroPlanOfImage(image as never);
    const object = servedObjectOf(image as never).object;
    if (stored && (taken[proofCategory(stored, object)] ?? 0) >= perCategory) continue;
    const served = await readServedBytes(db, image);
    if (served.ok === false) { outcome.failed += 1; continue; }
    decodes += 1;
    const answer = await planHeroWithCapacity(served.bytes, { proof: true });
    if (answer.ok === false || !answer.tile) { outcome.failed += 1; continue; }
    const category = proofCategory(answer.plan, object);
    if ((taken[category] ?? 0) >= perCategory) continue;
    taken[category] = (taken[category] ?? 0) + 1;
    const same = stored ? sameValue(answer.plan, stored) : null;
    if (same === true) outcome.deterministic += 1;
    if (same === false) outcome.nonDeterministic += 1;
    tiles.push({ ...answer.tile, category });
    outcome.byCategory[category] = (outcome.byCategory[category] ?? 0) + 1;
    const plan = answer.plan;
    index.push({
      row: tiles.length, image_id: image.id, category, stored: Boolean(stored), mode: plan.mode,
      confidence: plan.confidence, focal_width_share: plan.measures.focalWidthShare,
      crop_area_share: plan.measures.cropAreaShare, reasons: plan.reasons, deterministic: same,
    });
  }
  outcome.rows = tiles.length;
  if (!tiles.length) return outcome;

  const width = BAND + tiles[0].width;
  const height = tiles.reduce((sum, tile) => sum + tile.height + GAP, 0);
  const sheet = new Uint8Array(width * height * 3).fill(255);
  let y = 0;
  for (const tile of tiles) {
    const colour = PROOF_CATEGORY_COLOUR[tile.category];
    for (let row = 0; row < tile.height; row += 1) {
      for (let x = 0; x < BAND - 3; x += 1) sheet.set(colour, ((y + row) * width + x) * 3);
      sheet.set(tile.pixels.subarray(row * tile.width * 3, (row + 1) * tile.width * 3), ((y + row) * width + BAND) * 3);
    }
    y += tile.height + GAP;
  }
  const png = await encodePng(sheet, { width, height, components: 3 });
  if (!png) { outcome.failed += 1; return outcome; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sheetPath = `_hero-proof/${stamp}/before-after.png`;
  const indexPath = `_hero-proof/${stamp}/index.json`;
  const up1 = await db.storage.from(bucket).upload(sheetPath, png, { contentType: 'image/png', upsert: true });
  const up2 = await db.storage.from(bucket).upload(indexPath,
    new TextEncoder().encode(JSON.stringify({ legend: PROOF_CATEGORY_COLOUR, rows: index }, null, 2)),
    { contentType: 'application/json', upsert: true });
  if (!up1.error) outcome.sheets.push(sheetPath);
  if (!up2.error) outcome.sheets.push(indexPath);
  return outcome;
}

/**
 * Structural equality, independent of key order. A stored plan has been
 * through Postgres `jsonb`, which keeps object keys in its own order, so a
 * string comparison would call two identical plans different.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => sameValue(value, other[i]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

/* ------------------------------------------------------------------------ */
/* v3 — the before/after of the fit rescue, row by row                       */
/* ------------------------------------------------------------------------ */

/** The geometry a row draws for one side of the comparison. */
interface SideGeometry {
  version: number; mode: HeroPlan['mode']; reason: string;
  source: { width: number; height: number };
  usable: PixelRect; focal: PixelRect | null; crop: PixelRect;
}

const PANEL_W = 240;
const PANEL_H = 135;
const PANEL_GAP = 6;
const LABEL_H = 20;
const ROW_GAP = 8;

/** What a stored record says the card drew BEFORE v3: `previous`, or the v2 plan itself. */
export function beforeGeometry(stored: Record<string, unknown> | null | undefined, fresh: HeroPlan): SideGeometry | null {
  const record = stored as { plan?: HeroPlan; previous?: SideGeometry } | null | undefined;
  if (record?.previous && typeof record.previous === 'object' && record.previous.crop) return record.previous;
  const plan = record?.plan;
  if (plan && typeof plan === 'object' && plan.version < 3 && plan.crop) {
    return { version: plan.version, mode: plan.mode, reason: plan.reasons?.[plan.reasons.length - 1] ?? '',
      source: plan.source, usable: plan.usable, focal: plan.focal ?? null, crop: plan.crop };
  }
  // A picture first planned at v3 has no earlier plan; its own first pass IS
  // the v2 answer for the same bytes.
  const first = fresh.rescue?.firstPass;
  return first ? { version: 2, ...first, source: fresh.source } : null;
}

export function afterGeometry(plan: HeroPlan): SideGeometry {
  return { version: plan.version, mode: plan.mode, reason: plan.fitReason ?? plan.reasons[plan.reasons.length - 1] ?? '',
    source: plan.source, usable: plan.usable, focal: plan.focal ?? null, crop: plan.crop };
}

/** A label for a row: identifier, both answers, and the two measures. ASCII only. */
export function comparisonLabel(row: number, itemId: string, before: SideGeometry, after: HeroPlan): string {
  const area = Math.round(after.measures.cropAreaShare * 100);
  const width = after.focal ? Math.round((after.focal.w / (after.mode === 'fit' ? after.usable.w : after.crop.w)) * 100) : null;
  const text = `#${row} ${itemId.slice(0, 8)} V${before.version} ${before.mode} ${before.mode === 'fit' ? before.reason : ''}`
    + ` > V${after.version} ${after.mode} ${after.fitReason ?? ''} A${area}% W${width ?? '-'}%`;
  return text.replace(/\s+/g, ' ').toUpperCase().replace(/[^A-Z0-9 :_\->.#%/=()]/g, ' ');
}

export interface ComparisonRow {
  row: number; item: string; object: 'original' | 'derivative';
  before: { version: number; mode: string; reason: string };
  after: {
    version: number; mode: string; fit_reason: string | null; canvas: boolean; region_changed: boolean;
    box_changed: boolean; excluded: number; trimmed_ends: number; crop_area_pct: number; property_width_pct: number | null;
  };
  deterministic: boolean | null;
}

export interface ComparisonOutcome {
  sheets: string[]; rows: ComparisonRow[]; candidates: number; failed: number; stoppedForTime: boolean;
}

/**
 * Every card whose BEFORE answer was `fit`, then `representatives` crop and
 * original cards, drawn before | after with the label written into the PNG.
 * Pixels stay in the private bucket; the answer is numbers and paths.
 */
export async function drawHeroComparisonProof(
  db: any,
  options: { maxRows?: number; offset?: number; representatives?: number; deadlineAt?: number; bucket?: string; stamp?: string },
): Promise<ComparisonOutcome> {
  const maxRows = Math.max(1, Math.min(14, options.maxRows ?? 10));
  const bucket = options.bucket ?? 'builder-stock-images';
  const outcome: ComparisonOutcome = { sheets: [], rows: [], candidates: 0, failed: 0, stoppedForTime: false };
  const groups = await readHeroCandidates(db, {});
  // Order: the cards that drew `fit`, then a few of each other answer.
  const storedOf = (image: { source_detail: Record<string, unknown> | null }) =>
    ((image.source_detail ?? {}) as Record<string, unknown>).marketplace_hero as Record<string, unknown> | undefined;
  const beforeMode = (image: { source_detail: Record<string, unknown> | null }) => {
    const s = storedOf(image) as { plan?: HeroPlan; previous?: { mode?: string } } | undefined;
    return s?.previous?.mode ?? s?.plan?.mode ?? null;
  };
  const fits = groups.filter(({ images }) => beforeMode(images[0]) === 'fit');
  const reps = (mode: string) => groups.filter(({ images }) => beforeMode(images[0]) === mode)
    .slice(0, options.representatives ?? 3);
  const ordered = [...fits, ...reps('crop'), ...reps('original')];
  outcome.candidates = ordered.length;
  const page = ordered.slice(options.offset ?? 0, (options.offset ?? 0) + maxRows);

  const rowH = LABEL_H + PANEL_H;
  const width = 4 * PANEL_W + 3 * PANEL_GAP;
  const sheet = new Uint8Array(width * page.length * (rowH + ROW_GAP) * 3).fill(250);
  let drawn = 0;
  for (const { item, images } of page) {
    if (options.deadlineAt && Date.now() > options.deadlineAt) { outcome.stoppedForTime = true; break; }
    const image = images[0];
    const served = await readServedBytes(db, image);
    if (served.ok === false) { outcome.failed += 1; continue; }
    const answer = await planHeroWithCapacity(served.bytes, { rescue: true, thumbnail: true });
    if (answer.ok === false || !answer.thumbnail) { outcome.failed += 1; continue; }
    const fresh = answer.plan;
    const stored = storedOf(image);
    const before = beforeGeometry(stored ?? null, fresh);
    if (!before) { outcome.failed += 1; continue; }
    const storedPlan = (stored as { plan?: HeroPlan } | undefined)?.plan;
    const deterministic = storedPlan && storedPlan.version === fresh.version ? sameValue(storedPlan, fresh) : null;

    const thumb = { ...answer.thumbnail, sourceWidth: fresh.source.width, sourceHeight: fresh.source.height };
    const y0 = drawn * (rowH + ROW_GAP);
    const index = (offsetIndex: number) => (options.offset ?? 0) + offsetIndex + 1;
    drawLabel(sheet, width, 2, y0 + 3, comparisonLabel(index(drawn), item.id, before, fresh), [20, 20, 24], 2);
    const panel = (k: number) => ({ x: k * (PANEL_W + PANEL_GAP), y: y0 + LABEL_H, w: PANEL_W, h: PANEL_H });
    const sx = thumb.width / fresh.source.width, sy = thumb.height / fresh.source.height;
    const toThumb = (r: PixelRect) => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
    const sides: SideGeometry[] = [before, afterGeometry(fresh)];
    sides.forEach((side, s) => {
      const boxes = panel(s * 2), result = panel(s * 2 + 1);
      const placed = blit(thumb, { x: 0, y: 0, w: thumb.width, h: thumb.height }, sheet, width, boxes, 'contain');
      const outline = (r: PixelRect, colour: [number, number, number]) => {
        const m = toThumb(r);
        rect(sheet, width, { x: placed.x + m.x * placed.scale, y: placed.y + m.y * placed.scale,
          w: m.w * placed.scale, h: m.h * placed.scale }, colour);
      };
      outline(side.usable, [40, 110, 230]);
      if (side.focal) outline(side.focal, [240, 140, 20]);
      outline(side.crop, side.mode === 'fit' ? [210, 40, 40] : [20, 170, 60]);
      blit(thumb, toThumb(side.mode === 'fit' ? side.usable : side.crop), sheet, width, result,
        side.mode === 'fit' ? 'contain' : 'cover');
    });
    const widthPct = fresh.focal
      ? Math.round((fresh.focal.w / (fresh.mode === 'fit' ? fresh.usable.w : fresh.crop.w)) * 100) : null;
    outcome.rows.push({
      row: index(drawn), item: String(item.id).slice(0, 8), object: served.object,
      before: { version: before.version, mode: before.mode, reason: before.reason },
      after: {
        version: fresh.version, mode: fresh.mode, fit_reason: fresh.fitReason ?? null,
        canvas: fresh.rescue?.canvasDetected ?? fresh.measures.trimmed,
        region_changed: fresh.rescue?.photoRegionChanged ?? false, box_changed: fresh.rescue?.boxChanged ?? false,
        excluded: fresh.rescue?.excludedGroups ?? 0, trimmed_ends: fresh.rescue?.trimmedEnds ?? 0,
        crop_area_pct: Math.round(fresh.measures.cropAreaShare * 100), property_width_pct: widthPct,
      },
      deterministic,
    });
    drawn += 1;
  }
  if (!drawn) return outcome;
  const height = drawn * (rowH + ROW_GAP);
  const png = await encodePng(sheet.subarray(0, width * height * 3), { width, height, components: 3 });
  if (!png) { outcome.failed += 1; return outcome; }
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const path = `_hero-proof/${stamp}/v3-before-after-${String((options.offset ?? 0) + 1).padStart(2, '0')}.png`;
  const up = await db.storage.from(bucket).upload(path, png, { contentType: 'image/png', upsert: true });
  if (!up.error) outcome.sheets.push(path);
  return outcome;
}
