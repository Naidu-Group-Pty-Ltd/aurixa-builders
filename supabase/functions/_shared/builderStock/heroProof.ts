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
import { heroPlanOfImage, servedObjectOf } from './primaryImage.ts';
import { planHeroWithCapacity } from './heavyWorkClient.ts';
import { readHeroCandidates, readServedBytes } from './settleMarketplaceHero.ts';
import type { HeroPlan } from './marketplaceHero.pure.ts';

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
