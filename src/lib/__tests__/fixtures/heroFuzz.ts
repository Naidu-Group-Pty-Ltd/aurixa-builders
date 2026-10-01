/**
 * GENERATED SCENES for the hero planner's property tests. Each generator is
 * seeded and deterministic, and each scene carries its own ground truth by
 * construction:
 *
 *   `rescuableScene`  ONE property whose walls, roof and eaves fit a 16:9
 *                     frame of the photograph with room to spare, set among
 *                     whatever makes a first pass give up — brochure canvas
 *                     with text, frame lines, a banner, trees, a pole, a
 *                     fence, a neighbour the frame's edge cuts through — each
 *                     separated from the property by open sky. A planner may
 *                     not answer `fit` here, and may never cut the property.
 *   `impossibleScene` a property WIDER or TALLER than any 16:9 frame of its
 *                     photograph. A planner must answer `fit` here.
 */
import type { SceneOptions } from './heroScenes';

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return (s % 100_000) / 100_000;
  };
}
const pick = <T,>(r: () => number, list: readonly T[]) => list[Math.floor(r() * list.length)];
const CANVAS: Array<[number, number, number]> = [[246, 246, 246], [236, 236, 234], [200, 200, 200], [128, 128, 130], [14, 14, 14]];

export function rescuableScene(seed: number, noisy = false): SceneOptions & { __why: string[] } {
  const r = rng(seed);
  const why: string[] = [];
  // The photograph: a panorama or a wide brochure picture.
  const pw = 300 + Math.floor(r() * 100);
  const ph = Math.floor(pw / (2.0 + r() * 1.6));
  const horizon = Math.floor(ph * (0.68 + r() * 0.12));
  // The property: comfortably inside a 16:9 frame at full height.
  const maxW = Math.floor((ph * 16) / 9);
  const hw = Math.floor(Math.min(maxW * (0.45 + r() * 0.3), pw * 0.6));
  const hx = Math.floor((pw - hw) / 2 + (r() - 0.5) * (pw - hw) * 0.3);
  const roofTop = Math.floor(horizon * (0.25 + r() * 0.25));
  const options: SceneOptions & { __why: string[] } = {
    width: pw, height: ph, horizon, seed, lawnGrain: pick(r, [4, 10, 16]),
    houses: [{ x: hx, w: hw, roofTop, base: horizon + 6, garage: r() > 0.4 }], __why: why,
  };
  const gap = Math.ceil(pw * 0.05) + 4;
  const leftRoom = hx - Math.round(hw * 0.04) - gap, rightStart = hx + hw + Math.round(hw * 0.04) + gap;
  const rightRoom = pw - rightStart;
  // Things beside it, each across open sky.
  const beside = (room: number, x0: number) => {
    if (room < 14) return;
    const kind = pick(r, ['tree', 'pole', 'fence', 'neighbour', 'none'] as const);
    why.push(kind);
    if (kind === 'tree') (options.trees ??= []).push({ x: x0 + Math.floor(r() * Math.max(1, room - 30)), w: Math.min(room, 20 + Math.floor(r() * 20)), top: Math.floor(roofTop * (0.6 + r() * 0.6)) });
    if (kind === 'pole') options.pole = x0 + Math.floor(r() * (room - 10)) + 2;
    if (kind === 'fence') (options.fences ??= []).push({ x: x0 + 2, w: Math.max(8, room - 4), h: 6 + Math.floor(r() * 8) });
    if (kind === 'neighbour' && room > 30) {
      // The next house along: the photograph's edge runs through it.
      const atLeft = x0 === 0;
      const nw = Math.floor(hw * (0.4 + r() * 0.2)) + room;
      const visible = room - 4;
      options.houses.push({ x: atLeft ? visible - nw : x0 + 4, w: nw, roofTop: roofTop + Math.floor(r() * 10), base: horizon + 6 });
    }
  };
  beside(leftRoom, 0);
  beside(rightRoom, rightStart);
  // The page around it.
  if (r() < 0.5) {
    const side = Math.floor(pw * (0.1 + r() * 0.15));
    const colour = pick(r, CANVAS);
    options.width = pw + 2 * side;
    options.height = ph + 12;
    options.canvas = { left: side, right: side, top: 6, bottom: 6, colour };
    options.canvasText = r() < 0.7;
    if (r() < 0.4) options.frameLine = colour[0] > 128 ? [40, 40, 40] : [220, 220, 220];
    for (const h of options.houses) h.x += side;
    for (const t of options.trees ?? []) t.x += side;
    for (const f of options.fences ?? []) f.x += side;
    if (options.pole !== undefined) options.pole += side;
    options.horizon += 6;
    for (const h of options.houses) { h.roofTop += 6; h.base += 6; }
    for (const t of options.trees ?? []) t.top += 6;
    why.push('brochure');
  } else if (r() < 0.3) {
    options.banner = { height: Math.floor(ph * 0.18), colour: pick(r, [[20, 60, 140], [240, 240, 240], [30, 30, 30], [180, 30, 40]] as Array<[number, number, number]>), text: true };
    options.height = ph + options.banner.height;
    why.push('banner');
  }
  // Cloud at roof height between a house and a tree is honestly ambiguous
  // (white cloud and white render are the same thing to a block), so only
  // the noisy variant draws it.
  if (noisy && r() < 0.5) options.clouds = true;
  return options;
}

export function impossibleScene(seed: number): SceneOptions {
  const r = rng(seed + 10_000);
  const tall = r() < 0.4;
  if (tall) {
    const W = 260 + Math.floor(r() * 80), H = Math.floor(W * (0.75 + r() * 0.5));
    const horizon = H - 10 - Math.floor(r() * 8);
    return { width: W, height: H, horizon, seed, houses: [{ x: Math.floor(W * 0.12), w: Math.floor(W * 0.76), roofTop: 4 + Math.floor(r() * 6), base: horizon + 6, garage: r() > 0.5 }] };
  }
  const W = 360 + Math.floor(r() * 40), H = Math.floor(W / (2.6 + r()));
  const horizon = Math.floor(H * 0.72);
  const maxW = (H * 16) / 9;
  const hw = Math.min(W - 8, Math.ceil(maxW * (1.08 + r() * 0.25)));
  return { width: W, height: H, horizon, seed, houses: [{ x: Math.floor((W - hw) / 2), w: hw, roofTop: Math.floor(horizon * 0.3), base: horizon + 6, garage: r() > 0.5 }] };
}

/**
 * A plain photograph: one house, no canvas, anywhere in the frame, at any
 * size — clouds, a pole, flat overcast sky and a dark foreground included.
 * The test of every rule that could mistake photograph for page, and of the
 * first pass's own reading of roof and walls.
 */
export function plainScene(seed: number): SceneOptions {
  const r = rng(seed + 20_000);
  const W = 160 + Math.floor(r() * 240), H = 120 + Math.floor(r() * 280);
  const horizon = Math.floor(H * (0.3 + r() * 0.5));
  const hw = Math.max(20, Math.floor(W * (0.1 + r() * 0.8)));
  const hx = Math.floor(r() * Math.max(1, W - hw));
  const ht = Math.max(10, Math.floor(horizon * (0.2 + r() * 0.6)));
  const options: SceneOptions = {
    width: W, height: H, horizon, seed, lawnGrain: pick(r, [4, 10, 16]),
    houses: [{ x: hx, w: hw, roofTop: Math.max(2, horizon - ht), base: Math.min(H - 1, horizon + 6), garage: r() > 0.5 }],
  };
  if (r() > 0.7) options.clouds = true;
  if (r() > 0.8) options.pole = Math.floor(r() * W);
  if (r() > 0.8) options.flatSky = [200, 200, 204];
  if (r() > 0.7) options.darkGround = Math.floor(H * 0.1);
  return options;
}
