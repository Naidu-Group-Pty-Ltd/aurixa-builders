/**
 * THE MARKETPLACE HERO SWEEP — plans how each card frames its property.
 *
 * PRESENTATION, AND NOTHING ELSE. This writes exactly two keys of an image's
 * `source_detail` — `marketplace_hero` (a plan) and `marketplace_hero_attempt`
 * (why the last try did not make one) — through one guarded database call
 * (`builder_stock_record_hero_presentation`) that merges that key alone and
 * refuses if the picture's fingerprint moved while it worked. It never reads
 * or writes eligibility, identity, roles, the primary pointer, an item's image
 * stage, an upload or a publication; it runs in its own function on its own
 * clock, so nothing in the stock pipeline waits on it or can be failed by it.
 *
 * A FAILURE CHANGES NOTHING A CUSTOMER SEES. A card with no current plan is
 * drawn exactly as it was before this standard existed, so an unreadable
 * picture, a worker that did not answer or a write that lost a race costs one
 * attempt record and a retry after `HERO_RETRY_AFTER_MS` — at most
 * `HERO_MAX_ATTEMPTS` times for the same bytes, after which it waits for the
 * bytes (or the planner's version) to change.
 *
 * WHICH PICTURES. Every image the card rule could draw (`isDisplayableSourceImage`)
 * of every property that is not archived, in every organisation — the
 * primary first, because that is the one on the card now. Archived stock is
 * planned only when asked (`includeArchived`), because no surface draws it.
 */
import { isDisplayableSourceImage, servedObjectOf, heroPlanOfImage, chooseDisplayableImage } from './primaryImage.ts';
import {
  HERO_ATTEMPT_KEY, HERO_PLAN_VERSION, heroOriginalFingerprint,
  type HeroMode, type HeroPlan, type HeroServedObject,
} from './marketplaceHero.pure.ts';
import { planHeroWithCapacity } from './heavyWorkClient.ts';
import { sha256Hex } from './rasterPng.ts';
import { servableDerivativeFor } from './sanitizedDerivative.pure.ts';

export const HERO_RETRY_AFTER_MS = 30 * 60 * 1000;
export const HERO_MAX_ATTEMPTS = 6;
export const DEFAULT_HERO_BUCKET = 'builder-stock-images';

export interface HeroImageRow {
  id: string;
  organisation_id: string;
  stock_item_id: string;
  source_stage: string;
  verification_status: string | null;
  processing_status: string | null;
  position: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  external_url: string | null;
  source_detail: Record<string, unknown> | null;
}

export interface HeroAttempt {
  version: number;
  object: HeroServedObject;
  sha256: string;
  at: string;
  count: number;
  reason: string;
  operational: boolean;
}

export type HeroStanding =
  | 'planned' | 'owed' | 'cooling_down' | 'exhausted' | 'no_fingerprint';

/** Where one picture stands, from its row alone. Pure. */
export function heroStanding(image: HeroImageRow, now: number): HeroStanding {
  if (heroPlanOfImage(image)) return 'planned';
  const served = servedObjectOf(image);
  if (!served.sha256) return 'no_fingerprint';
  const attempt = readAttempt(image.source_detail, served.object, served.sha256);
  if (!attempt) return 'owed';
  if (attempt.count >= HERO_MAX_ATTEMPTS) return 'exhausted';
  return now - Date.parse(attempt.at) < HERO_RETRY_AFTER_MS ? 'cooling_down' : 'owed';
}

/** The attempt record, only where it is about these bytes at this version. */
export function readAttempt(
  detail: Record<string, unknown> | null | undefined, object: HeroServedObject, sha256: string,
): HeroAttempt | null {
  const raw = (detail ?? {})[HERO_ATTEMPT_KEY] as HeroAttempt | undefined;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== HERO_PLAN_VERSION || raw.object !== object || raw.sha256 !== sha256) return null;
  if (!Number.isFinite(Date.parse(String(raw.at)))) return null;
  return { ...raw, count: Number.isFinite(raw.count) ? Number(raw.count) : 1 };
}

export interface HeroSweepOutcome {
  examined: number;
  planned: number;
  byMode: Record<HeroMode, number>;
  failed: number;
  operationalFailures: number;
  lostRace: number;
  standing: Record<HeroStanding, number>;
  /** Properties where the tie-break would choose another picture than the card shows. */
  tieBreakWouldChange: number;
  stoppedForTime: boolean;
}

export interface HeroSweepOptions {
  limit?: number;
  deadlineAt?: number;
  includeArchived?: boolean;
  organisationId?: string | null;
  now?: number;
}

/** Read every candidate picture, grouped by property, primaries first. */
export async function readHeroCandidates(
  db: any, options: { includeArchived?: boolean; organisationId?: string | null } = {},
): Promise<Array<{ item: { id: string; organisation_id: string; lifecycle_status: string; primary_image_id: string | null }; images: HeroImageRow[] }>> {
  const items: any[] = [];
  for (let from = 0; ; from += 1000) {
    let query = db.from('builder_stock_items')
      .select('id, organisation_id, lifecycle_status, primary_image_id')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (!options.includeArchived) query = query.neq('lifecycle_status', 'archived');
    if (options.organisationId) query = query.eq('organisation_id', options.organisationId);
    const { data, error } = await query;
    if (error) throw new Error(`stock items could not be read: ${String(error.message ?? error).slice(0, 120)}`);
    items.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const byItem = new Map<string, HeroImageRow[]>();
  for (let i = 0; i < items.length; i += 100) {
    const ids = items.slice(i, i + 100).map((item) => item.id);
    const { data, error } = await db.from('builder_stock_item_images')
      .select('id, organisation_id, stock_item_id, source_stage, verification_status, processing_status, '
        + 'position, storage_bucket, storage_path, external_url, source_detail')
      .in('stock_item_id', ids)
      .eq('source_stage', 'uploaded_document');
    if (error) throw new Error(`stock images could not be read: ${String(error.message ?? error).slice(0, 120)}`);
    for (const row of (data ?? []) as HeroImageRow[]) {
      if (!isDisplayableSourceImage(row as never)) continue;
      const list = byItem.get(row.stock_item_id) ?? [];
      list.push(row);
      byItem.set(row.stock_item_id, list);
    }
  }
  const rank = (status: string) => (status === 'active' ? 0 : status === 'archived' ? 2 : 1);
  return items
    .filter((item) => byItem.has(item.id))
    .sort((a, b) => rank(a.lifecycle_status) - rank(b.lifecycle_status))
    .map((item) => ({
      item,
      images: [...byItem.get(item.id)!].sort((a, b) =>
        (a.id === item.primary_image_id ? 0 : 1) - (b.id === item.primary_image_id ? 0 : 1)),
    }));
}

/** The bucket and path a door signs for this picture. */
function servedLocation(image: HeroImageRow): { bucket: string; path: string } | null {
  const served = servedObjectOf(image as never);
  if (served.object === 'derivative') {
    const derivative = servableDerivativeFor(image.source_detail);
    if (!derivative?.storage_path) return null;
    return { bucket: derivative.storage_bucket || DEFAULT_HERO_BUCKET, path: derivative.storage_path };
  }
  if (!image.storage_path) return null;
  return { bucket: image.storage_bucket || DEFAULT_HERO_BUCKET, path: image.storage_path };
}

/** The guard the database applies: the fingerprints this plan was made over. */
function expectations(image: HeroImageRow) {
  const derivative = servableDerivativeFor(image.source_detail);
  return {
    p_expected_original: heroOriginalFingerprint(image.source_detail),
    p_expected_derivative: derivative?.derivative_sha256 ?? null,
  };
}

/** Download the served bytes and prove they are the bytes the row names. */
export async function readServedBytes(
  db: any, image: HeroImageRow,
): Promise<{ ok: true; bytes: Uint8Array; object: HeroServedObject; sha256: string } | { ok: false; reason: string; operational: boolean }> {
  const served = servedObjectOf(image as never);
  const location = servedLocation(image);
  if (!served.sha256 || !location) return { ok: false, reason: 'no_fingerprint', operational: false };
  try {
    const { data, error } = await db.storage.from(location.bucket).download(location.path);
    if (error || !data) return { ok: false, reason: 'storage_unreadable', operational: true };
    const bytes = new Uint8Array(await data.arrayBuffer());
    const sha256 = (await sha256Hex(bytes)).toLowerCase();
    if (sha256 !== served.sha256.toLowerCase()) {
      return { ok: false, reason: 'fingerprint_mismatch', operational: false };
    }
    return { ok: true, bytes, object: served.object, sha256: served.sha256 };
  } catch {
    return { ok: false, reason: 'storage_unreadable', operational: true };
  }
}

async function record(
  db: any, image: HeroImageRow, value: { plan?: unknown; attempt?: unknown },
): Promise<boolean> {
  const { data, error } = await db.rpc('builder_stock_record_hero_presentation', {
    p_image_id: image.id,
    p_organisation_id: image.organisation_id,
    p_plan: value.plan ?? null,
    p_attempt: value.attempt ?? null,
    ...expectations(image),
  });
  return !error && data === true;
}

export async function settleMarketplaceHero(db: any, options: HeroSweepOptions = {}): Promise<HeroSweepOutcome> {
  const now = options.now ?? Date.now();
  const limit = Math.max(0, Math.min(40, options.limit ?? 8));
  const outcome: HeroSweepOutcome = {
    examined: 0, planned: 0, byMode: { original: 0, crop: 0, fit: 0 },
    failed: 0, operationalFailures: 0, lostRace: 0,
    standing: { planned: 0, owed: 0, cooling_down: 0, exhausted: 0, no_fingerprint: 0 },
    tieBreakWouldChange: 0, stoppedForTime: false,
  };
  const groups = await readHeroCandidates(db, options);
  const owed: HeroImageRow[] = [];
  for (const { item, images } of groups) {
    for (const image of images) {
      const standing = heroStanding(image, now);
      outcome.standing[standing] += 1;
      if (standing === 'owed') owed.push(image);
    }
    const chosen = chooseDisplayableImage(images as never[]) as HeroImageRow | null;
    if (chosen && item.primary_image_id && chosen.id !== item.primary_image_id) outcome.tieBreakWouldChange += 1;
  }

  for (const image of owed.slice(0, limit)) {
    if (options.deadlineAt && Date.now() > options.deadlineAt) { outcome.stoppedForTime = true; break; }
    outcome.examined += 1;
    const served = await readServedBytes(db, image);
    const fail = async (reason: string, operational: boolean) => {
      outcome.failed += 1;
      if (operational) outcome.operationalFailures += 1;
      const object = servedObjectOf(image as never);
      if (!object.sha256) return;
      const previous = readAttempt(image.source_detail, object.object, object.sha256);
      const attempt: HeroAttempt = {
        version: HERO_PLAN_VERSION, object: object.object, sha256: object.sha256,
        at: new Date().toISOString(), count: (previous?.count ?? 0) + 1,
        reason: reason.slice(0, 120), operational,
      };
      if (!await record(db, image, { attempt })) outcome.lostRace += 1;
    };
    if (served.ok === false) { await fail(served.reason, served.operational); continue; }

    const answer = await planHeroWithCapacity(served.bytes);
    if (answer.ok === false) {
      await fail(answer.reason === 'worker' ? `worker: ${(answer as { detail?: string }).detail ?? ''}` : answer.reason,
        answer.reason === 'worker');
      continue;
    }
    const stored = { plan: answer.plan as HeroPlan, object: served.object, sha256: served.sha256, planned_at: new Date().toISOString() };
    if (await record(db, image, { plan: stored })) {
      outcome.planned += 1;
      outcome.byMode[answer.plan.mode] += 1;
    } else {
      outcome.lostRace += 1;
    }
  }
  return outcome;
}
