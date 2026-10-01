/**
 * THE FUTURE-UPLOAD CASES — one set of synthetic pictures, used by the
 * decoder-path specs and by the production proof (`stock-hero-future-proof`),
 * so what CI proves and what production is shown are the same pictures.
 *
 * Each is drawn LARGER than the planner's thumbnail, because every real
 * picture is: the decoder downscales and stretches contrast, and a page's
 * type becomes grey blur over most of its margin. A rule tested only at
 * thumbnail size passed here and failed on the first real brochure.
 */
import type { SceneOptions } from './heroScenes';

const scaled = (o: SceneOptions, k: number): SceneOptions => JSON.parse(JSON.stringify(o),
  (key, value) => (typeof value === 'number' && key !== 'seed' && key !== 'lawnGrain' ? value * k : value));

export interface HeroProofCase {
  scene: SceneOptions;
  /** What the planner must answer for these bytes. */
  expect: { mode: 'crop' | 'fit' | 'original'; fitReason?: string; insidePhoto?: boolean };
  label: string;
}

export const HERO_PROOF_CASES: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F1' | 'F2', HeroProofCase> = {
  A: {
    label: 'a house in a wide brochure page, type in its margins',
    scene: scaled({ width: 400, height: 170, horizon: 125, seed: 3,
      canvas: { left: 70, right: 70, top: 6, bottom: 6, colour: [238, 238, 236] }, canvasText: true,
      houses: [{ x: 140, w: 120, roofTop: 60, base: 131, garage: true }] }, 4),
    expect: { mode: 'crop', insidePhoto: true },
  },
  B: {
    label: 'a panorama: trees, a pole and a fence around a centred house',
    scene: scaled({ width: 400, height: 110, horizon: 80, seed: 3, pole: 30,
      trees: [{ x: 20, w: 40, top: 20 }, { x: 330, w: 45, top: 18 }], fences: [{ x: 270, w: 50, h: 7 }],
      houses: [{ x: 140, w: 120, roofTop: 30, base: 86, garage: true }] }, 4),
    expect: { mode: 'crop', insidePhoto: true },
  },
  C: {
    label: 'a marketing strip with text beneath the photograph',
    scene: scaled({ width: 320, height: 240, horizon: 150, seed: 5,
      banner: { height: 50, colour: [20, 60, 140], text: true },
      houses: [{ x: 60, w: 200, roofTop: 70, base: 156, garage: true }] }, 2),
    expect: { mode: 'crop', insidePhoto: true },
  },
  D: {
    label: 'a house wider than any 16:9 frame of its photograph',
    scene: scaled({ width: 400, height: 110, horizon: 80, seed: 3,
      houses: [{ x: 20, w: 360, roofTop: 30, base: 86, garage: true }] }, 4),
    expect: { mode: 'fit', fitReason: 'building_too_wide' },
  },
  E: {
    label: 'an already-good 16:9 photograph',
    scene: scaled({ width: 320, height: 180, horizon: 140, seed: 2,
      houses: [{ x: 50, w: 220, roofTop: 60, base: 146, garage: true }] }, 2),
    expect: { mode: 'original' },
  },
  F1: {
    label: 'the picture a replacement replaces',
    scene: scaled({ width: 320, height: 240, horizon: 170, seed: 7,
      houses: [{ x: 70, w: 180, roofTop: 90, base: 176, garage: true }] }, 2),
    expect: { mode: 'crop', insidePhoto: true },
  },
  F2: {
    label: 'its replacement: different bytes, different dimensions',
    scene: scaled({ width: 400, height: 300, horizon: 210, seed: 9,
      houses: [{ x: 90, w: 220, roofTop: 110, base: 216, garage: false }] }, 2),
    expect: { mode: 'crop', insidePhoto: true },
  },
};
