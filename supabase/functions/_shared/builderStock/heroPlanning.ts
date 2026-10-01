/**
 * The Marketplace Hero Standard's one IO-free-but-not-pure step: bytes in,
 * plan out. It decodes the served picture with the SAME decoder every other
 * judgement of a builder's picture uses (`sourceImageRaster.ts`) and hands the
 * thumbnail to the pure planner. It runs on the heavy-work worker in
 * production — decoding is the one expensive thing here — and inline only
 * where no worker is configured.
 *
 * Optionally it also draws a PROOF TILE: the picture as a card shows it today
 * (whole, on a plain ground) beside the frame the plan would draw, with the
 * photograph (blue), the building (orange) and the frame (green) outlined.
 * The tile is raw RGB at thumbnail resolution and is only ever written into
 * the platform's own private storage — no picture leaves the platform for a
 * proof.
 *
 * Never throws: an unreadable picture is `{ ok: false }`, which the sweep
 * records as a presentation failure and nothing else.
 */
import { decodeThumbnailResult } from './sourceImageRaster.ts';
import { planHero, type HeroPlan, type PixelRect } from './marketplaceHero.pure.ts';

export const PROOF_TILE_W = 320;
export const PROOF_TILE_H = 180;
const GAP = 8;

export type HeroPlanningResult =
  | { ok: true; plan: HeroPlan; tile: { width: number; height: number; pixels: Uint8Array } | null }
  | { ok: false; reason: 'decoder_unsupported' | 'decoder_failed' | 'no_plan'; detail?: string };

export async function planHeroFromBytes(
  bytes: Uint8Array,
  options: { proof?: boolean } = {},
): Promise<HeroPlanningResult> {
  try {
    const decoded = await decodeThumbnailResult(bytes);
    if (decoded.ok === false) {
      return { ok: false, reason: decoded.reason === 'unsupported' ? 'decoder_unsupported' : 'decoder_failed' };
    }
    const plan = planHero(decoded.thumbnail);
    if (!plan) return { ok: false, reason: 'no_plan' };
    return { ok: true, plan, tile: options.proof ? drawProofTile(decoded.thumbnail, plan) : null };
  } catch (error) {
    return { ok: false, reason: 'decoder_failed', detail: String((error as Error)?.message ?? error).slice(0, 120) };
  }
}

interface Thumb { width: number; height: number; pixels: Uint8Array; sourceWidth: number; sourceHeight: number }

/** BEFORE (whole, contained) | AFTER (the plan's frame), one row of a grid. */
export function drawProofTile(t: Thumb, plan: HeroPlan): { width: number; height: number; pixels: Uint8Array } {
  const width = PROOF_TILE_W * 2 + GAP, height = PROOF_TILE_H;
  const out = new Uint8Array(width * height * 3).fill(236);
  const sx = t.width / t.sourceWidth, sy = t.height / t.sourceHeight;
  const toThumb = (r: PixelRect) => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });

  // BEFORE: the whole picture contained in the 16:9 frame, as cards draw today.
  const whole = { x: 0, y: 0, w: t.width, h: t.height };
  const before = blit(t, whole, out, width, { x: 0, y: 0, w: PROOF_TILE_W, h: PROOF_TILE_H }, 'contain');
  const outline = (r: PixelRect, colour: [number, number, number]) => {
    const m = toThumb(r);
    rect(out, width, {
      x: before.x + m.x * before.scale, y: before.y + m.y * before.scale,
      w: m.w * before.scale, h: m.h * before.scale,
    }, colour);
  };
  outline(plan.usable, [40, 110, 230]);
  if (plan.focal) outline(plan.focal, [240, 140, 20]);
  outline(plan.crop, [20, 170, 60]);

  // AFTER: what the plan draws.
  blit(t, toThumb(plan.crop), out, width, { x: PROOF_TILE_W + GAP, y: 0, w: PROOF_TILE_W, h: PROOF_TILE_H },
    plan.mode === 'fit' ? 'contain' : 'cover');
  return { width, height, pixels: out };
}

function blit(
  t: Thumb, src: PixelRect, out: Uint8Array, outW: number, dst: PixelRect, fit: 'contain' | 'cover',
): { x: number; y: number; scale: number } {
  const scale = fit === 'contain' ? Math.min(dst.w / src.w, dst.h / src.h) : Math.max(dst.w / src.w, dst.h / src.h);
  const w = src.w * scale, h = src.h * scale;
  const ox = dst.x + (dst.w - w) / 2, oy = dst.y + (dst.h - h) / 2;
  for (let y = Math.max(dst.y, Math.floor(oy)); y < Math.min(dst.y + dst.h, Math.ceil(oy + h)); y += 1) {
    for (let x = Math.max(dst.x, Math.floor(ox)); x < Math.min(dst.x + dst.w, Math.ceil(ox + w)); x += 1) {
      const tx = Math.min(t.width - 1, Math.max(0, Math.floor(src.x + (x - ox) / scale)));
      const ty = Math.min(t.height - 1, Math.max(0, Math.floor(src.y + (y - oy) / scale)));
      const i = (ty * t.width + tx) * 3, o = (y * outW + x) * 3;
      out[o] = t.pixels[i]; out[o + 1] = t.pixels[i + 1]; out[o + 2] = t.pixels[i + 2];
    }
  }
  return { x: ox, y: oy, scale };
}

function rect(out: Uint8Array, outW: number, r: PixelRect, [cr, cg, cb]: [number, number, number]) {
  const outH = out.length / 3 / outW;
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= outW || y >= outH) return;
    const o = (y * outW + x) * 3;
    out[o] = cr; out[o + 1] = cg; out[o + 2] = cb;
  };
  const x0 = Math.round(r.x), y0 = Math.round(r.y), x1 = Math.round(r.x + r.w) - 1, y1 = Math.round(r.y + r.h) - 1;
  for (let k = 0; k < 2; k += 1) {
    for (let x = x0; x <= x1; x += 1) { paint(x, y0 + k); paint(x, y1 - k); }
    for (let y = y0; y <= y1; y += 1) { paint(x0 + k, y); paint(x1 - k, y); }
  }
}
