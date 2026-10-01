/**
 * THE FIT RESCUE (planner v3) — the permanent regression matrix for wide,
 * panoramic and brochure-style property pictures.
 *
 * The class: a picture whose property COULD stand in a 16:9 frame, but which
 * the first pass (v2) showed whole because something else in it — a brochure
 * page with text, a frame line, a banner, trees, a pole, a fence, the next
 * house along — made the "building" it measured too wide. Every scene here is
 * SYNTHETIC (`fixtures/heroScenes.ts`, `fixtures/heroFuzz.ts`), carries its own
 * ground truth, and is held to the two promises that never bend:
 *
 *   the property is never cut, and
 *   a `fit` is only ever a fit for a reason that can be named.
 *
 * Nothing here is keyed to any real lot, property, builder, file or picture.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  HERO_ASPECT_H, HERO_ASPECT_W, HERO_FIT_REASONS, HERO_PLAN_KEY, HERO_RESCUE_VERSION,
  findPhotoRegion, findUsableRegion, heroPlanForServed, planHero, validateHeroPlan, type HeroPlan, type PixelRect,
} from '../../../supabase/functions/_shared/builderStock/marketplaceHero.pure';
import { chooseDisplayableImage } from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { planHeroWithCapacity } from '../../../supabase/functions/_shared/builderStock/heavyWorkClient';
import { encodeWorkDocument, WORK_OUTCOME_HEADER } from '../../../supabase/functions/_shared/builderStock/heavyWorkWire.pure';
import { drawScene, type Rect, type SceneOptions } from './fixtures/heroScenes';
import { impossibleScene, plainScene, rescuableScene } from './fixtures/heroFuzz';
import { HERO_PROOF_CASES } from './fixtures/heroProofCases';
import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import { planHeroFromBytes } from '../../../supabase/functions/_shared/builderStock/heroPlanning';

const inside = (inner: Rect, outer: PixelRect) =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const visible = (house: Rect, photo: Rect): Rect => {
  const x = Math.max(house.x, photo.x), y = Math.max(house.y, photo.y);
  return { x, y, w: Math.min(house.x + house.w, photo.x + photo.w) - x, h: Math.min(house.y + house.h, photo.y + photo.h) - y };
};

function both(options: SceneOptions) {
  const scene = drawScene(options);
  const v2 = planHero(scene.thumbnail, undefined, { rescue: false });
  const v3 = planHero(scene.thumbnail, undefined, { rescue: true });
  if (!v2 || !v3) throw new Error('no plan');
  return { scene, v2, v3 };
}

/** What every v3 plan obeys, in every scene. */
function expectSafe(scene: ReturnType<typeof drawScene>, p: HeroPlan, opts: { insidePhoto?: boolean } = {}) {
  expect(validateHeroPlan(p)).toBe(true);
  expect(p.version).toBe(HERO_RESCUE_VERSION);
  expect(inside(visible(scene.subject, scene.photo), p.crop)).toBe(true);
  if (p.mode === 'crop') {
    expect(Math.abs(p.crop.w * HERO_ASPECT_H - p.crop.h * HERO_ASPECT_W)).toBeLessThanOrEqual(HERO_ASPECT_W);
    if (opts.insidePhoto !== false) expect(inside(p.crop, scene.photo)).toBe(true);
  }
  if (p.mode === 'fit') expect(HERO_FIT_REASONS).toContain(p.fitReason);
  else expect(p.fitReason).toBeUndefined();
}

// A panorama: 400 × 110 thumbnail, house of 120–130 px, horizon at 80.
const PANORAMA = { width: 400, height: 110, horizon: 80, seed: 3 };

describe('THE FAILURE CLASS — a house set in a wide brochure page', () => {
  /*
   * The case this version exists for: a property photograph laid on a wide
   * brochure page, with text in the margins either side. v2 measured the
   * page's lettering as structure, found a "building" wider than any 16:9
   * frame and showed the whole page; v3 proves the margins are canvas,
   * finds the facade inside the photograph, and frames it.
   */
  const scene: SceneOptions = {
    width: 400, height: 170, horizon: 125, seed: 3,
    canvas: { left: 70, right: 70, top: 6, bottom: 6, colour: [238, 238, 236] }, canvasText: true,
    houses: [{ x: 140, w: 120, roofTop: 60, base: 131, garage: true }],
  };

  it('v2 shows it whole — the defect, reproduced', () => {
    const { v2 } = both(scene);
    expect(v2.mode).toBe('fit');
    expect(v2.reasons).toContain('subject_wider_than_frame');
  });

  it('v3 isolates the facade inside the photograph and frames it 16:9, house whole', () => {
    const { scene: s, v3 } = both(scene);
    expect(v3.mode).toBe('crop');
    expect(v3.rescue?.outcome).toBe('promoted');
    expect(v3.rescue?.photoRegionChanged).toBe(true);
    expect(v3.rescue?.firstPass.mode).toBe('fit');
    expect(v3.reasons).toContain('fit_rescued');
    expectSafe(s, v3);
  });

  it('the same failure, panoramic: trees and a pole beside a centred house', () => {
    const { scene: s, v2, v3 } = both({ ...PANORAMA, pole: 30,
      trees: [{ x: 20, w: 40, top: 20 }, { x: 330, w: 45, top: 18 }],
      houses: [{ x: 140, w: 120, roofTop: 30, base: 86, garage: true }] });
    expect(v2.mode).toBe('fit');
    expect(v3.mode).toBe('crop');
    expect(v3.rescue?.excludedGroups).toBeGreaterThan(0);
    expectSafe(s, v3);
  });
});

describe('panorama cases', () => {
  it('a centred house among wide side scenery is framed around the house', () => {
    const { scene, v3 } = both({ ...PANORAMA, trees: [{ x: 10, w: 50, top: 22 }, { x: 70, w: 30, top: 30 }],
      fences: [{ x: 300, w: 90, h: 10 }], houses: [{ x: 150, w: 110, roofTop: 30, base: 86, garage: true }] });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });

  it('trees on both sides are left out', () => {
    const { scene, v3 } = both({ ...PANORAMA, trees: [{ x: 20, w: 40, top: 20 }, { x: 330, w: 45, top: 18 }],
      houses: [{ x: 140, w: 120, roofTop: 30, base: 86, garage: true }] });
    expect(v3.mode).toBe('crop');
    expect(v3.rescue?.excludedGroups).toBeGreaterThanOrEqual(1);
    expectSafe(scene, v3);
  });

  it('a fence beside the facade does not widen the building', () => {
    const { scene, v3 } = both({ ...PANORAMA, fences: [{ x: 270, w: 110, h: 14 }],
      houses: [{ x: 120, w: 130, roofTop: 30, base: 86, garage: true }] });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });

  it('a utility pole standing in the sky is not part of the house', () => {
    const { scene, v3 } = both({ ...PANORAMA, pole: 40, houses: [{ x: 150, w: 130, roofTop: 30, base: 86, garage: true }] });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });

  it('the next house along, cut by the frame edge, is background', () => {
    const { scene, v3 } = both({ ...PANORAMA,
      houses: [{ x: 150, w: 120, roofTop: 30, base: 86, garage: true }, { x: 330, w: 110, roofTop: 45, base: 86 }] });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });
});

describe('canvas cases — nothing outside the photograph is drawn', () => {
  const house = { x: 140, w: 120, roofTop: 60, base: 131, garage: true };
  const page = (canvas: NonNullable<SceneOptions['canvas']>, extra: Partial<SceneOptions> = {}): SceneOptions =>
    ({ width: 400, height: 170, horizon: 125, seed: 5, canvas, houses: [house], ...extra });

  it.each([
    ['a brochure in a grey canvas', page({ left: 70, right: 70, top: 8, bottom: 8, colour: [200, 200, 200] }, { canvasText: true })],
    ['a white page margin', page({ left: 70, right: 70, top: 6, bottom: 6, colour: [247, 247, 247] })],
    ['neutral padding', page({ left: 64, right: 64, top: 10, bottom: 10, colour: [128, 128, 130] })],
    ['embedded brochure text', page({ left: 70, right: 70, top: 6, bottom: 6, colour: [238, 238, 236] }, { canvasText: true })],
    ['a frame line around the photograph', page({ left: 60, right: 60, top: 10, bottom: 10, colour: [200, 200, 200] }, { canvasText: true, frameLine: [30, 30, 30] })],
    ['a disconnected graphic in the margin', page({ left: 70, right: 70, top: 6, bottom: 6, colour: [238, 238, 236] },
      { canvasText: true, logo: { x: 12, y: 20, w: 40, h: 26, colour: [180, 40, 40] } })],
  ])('%s', (_name, options) => {
    const { scene, v3 } = both(options);
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });

  it('a black letterbox above and below', () => {
    const { scene, v3 } = both({ width: 320, height: 240, horizon: 160, seed: 5,
      canvas: { top: 36, bottom: 36, colour: [8, 8, 8] }, houses: [{ x: 60, w: 200, roofTop: 90, base: 166, garage: true }] });
    expect(v3.mode).not.toBe('fit');
    expectSafe(scene, v3);
  });

  it.each([
    ['a marketing strip beneath', { height: 50, colour: [20, 60, 140] as [number, number, number], text: true }],
    ['a disclaimer banner below', { height: 34, colour: [240, 240, 240] as [number, number, number], text: true }],
  ])('%s is framed out', (_name, banner) => {
    const { scene, v3 } = both({ width: 320, height: 240, horizon: 150, seed: 5, banner,
      houses: [{ x: 60, w: 200, roofTop: 70, base: 156, garage: true }] });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });
});

describe('never trimmed — real sky and real shadow are photograph', () => {
  it('an overcast sky is held to the first pass\'s strict rule, never a relaxed one', () => {
    const { v2, v3 } = both({ width: 400, height: 160, horizon: 120, seed: 3, flatSky: [214, 214, 216],
      houses: [{ x: 20, w: 360, roofTop: 50, base: 126 }] });
    expect(v3.usable.y).toBe(v2.usable.y);
    expect(v3.rescue?.photoRegionChanged ?? false).toBe(false);
  });

  it('a real dark area at the foot is not a letterbox', () => {
    const { v2, v3 } = both({ width: 400, height: 160, horizon: 100, seed: 3, darkGround: 30,
      houses: [{ x: 20, w: 360, roofTop: 40, base: 106 }] });
    expect(v3.usable).toEqual(v2.usable);
    expect(v3.rescue?.photoRegionChanged ?? false).toBe(false);
  });
});

describe('framing — v3 keeps what v2 got right', () => {
  it.each([
    ['excessive sky', { width: 320, height: 400, horizon: 330, houses: [{ x: 70, w: 180, roofTop: 250, base: 340, garage: true }] }],
    ['excessive ground', { width: 320, height: 400, horizon: 140, houses: [{ x: 60, w: 200, roofTop: 60, base: 146, garage: true }] }],
    ['touching the left edge', { ...PANORAMA, houses: [{ x: 0, w: 130, roofTop: 30, base: 86, garage: true }] }],
    ['touching the right edge', { ...PANORAMA, houses: [{ x: 270, w: 130, roofTop: 30, base: 86, garage: true }] }],
    ['centred', { width: 320, height: 240, horizon: 170, houses: [{ x: 70, w: 180, roofTop: 90, base: 176, garage: true }] }],
  ] as Array<[string, SceneOptions]>)('%s: framed, never cut', (_name, options) => {
    const { scene, v3 } = both({ seed: 7, ...options });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });
});

describe('legitimate fits stay fits — and say why', () => {
  it('a genuine long terrace', () => {
    const { scene, v3 } = both({ ...PANORAMA, houses: [{ x: 20, w: 360, roofTop: 30, base: 86, garage: true }] });
    expect(v3.mode).toBe('fit');
    expect(v3.fitReason).toBe('building_too_wide');
    expectSafe(scene, v3);
  });

  it('a house genuinely too wide for its photograph', () => {
    const { scene, v3 } = both({ width: 380, height: 120, horizon: 90, seed: 4,
      houses: [{ x: 20, w: 340, roofTop: 28, base: 96, garage: true }] });
    expect(v3.mode).toBe('fit');
    expect(v3.fitReason).toBe('building_too_wide');
    expectSafe(scene, v3);
  });

  it('a 4:3 house where any 16:9 frame would cut the building', () => {
    const { scene, v3 } = both({ width: 320, height: 240, horizon: 220, seed: 4,
      houses: [{ x: 40, w: 240, roofTop: 10, base: 226, garage: true }] });
    expect(v3.mode).toBe('fit');
    expect(v3.fitReason).toBe('building_too_tall');
    expectSafe(scene, v3);
  });

  it('two whole houses of equal weight: the rescue refuses rather than guess', () => {
    const { scene, v3 } = both({ ...PANORAMA, width: 420,
      houses: [{ x: 30, w: 140, roofTop: 30, base: 86, garage: true }, { x: 250, w: 140, roofTop: 30, base: 86, garage: true }] });
    expect(v3.mode).toBe('fit');
    expect(v3.fitReason).toBe('subject_confidence_low');
    expect(v3.rescue?.outcome).toBe('refused');
    expectSafe(scene, v3);
  });
});

describe('unchanged — an answer v2 got right is not disturbed', () => {
  it('an already-good 16:9 picture is still drawn as it is', () => {
    const { scene, v2, v3 } = both({ width: 320, height: 180, horizon: 140, seed: 2,
      houses: [{ x: 50, w: 220, roofTop: 60, base: 146, garage: true }] });
    expect(v2.mode).toBe('original');
    expect(v3.mode).toBe('original');
    expect(v3.crop).toEqual(v2.crop);
    expectSafe(scene, v3);
  });

  it('a portrait with a huge sky is framed on the house', () => {
    const { scene, v3 } = both({ width: 320, height: 420, horizon: 360, seed: 2,
      houses: [{ x: 60, w: 200, roofTop: 280, base: 366, garage: true }] });
    expect(v3.mode).toBe('crop');
    expect(v3.crop.y).toBeGreaterThan(0);
    expectSafe(scene, v3);
  });

  it('a tiny house is enlarged within the zoom and resolution limits', () => {
    const { scene, v3 } = both({ width: 400, height: 300, horizon: 220, seed: 2, scale: 8,
      houses: [{ x: 170, w: 60, roofTop: 190, base: 226 }] });
    expect(v3.mode).toBe('crop');
    expectSafe(scene, v3);
  });

  it('the first pass is v2, unchanged: the same box and the same frame wherever v2 cropped', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const scene = drawScene(plainScene(seed));
      const v2 = planHero(scene.thumbnail, undefined, { rescue: false })!;
      const v3 = planHero(scene.thumbnail, undefined, { rescue: true })!;
      if (v2.mode === 'fit') continue;
      expect.soft({ mode: v3.mode, crop: v3.crop, focal: v3.focal }, `seed ${seed}`)
        .toEqual({ mode: v2.mode, crop: v2.crop, focal: v2.focal });
    }
  });
});

describe('a stored plan is a claim about exact bytes — v2 and v3 alike', () => {
  const sha = 'a'.repeat(64), other = 'b'.repeat(64), derived = 'c'.repeat(64);
  const v3 = planHero(drawScene({ ...PANORAMA, trees: [{ x: 20, w: 40, top: 20 }],
    houses: [{ x: 140, w: 120, roofTop: 30, base: 86, garage: true }] }).thumbnail, undefined, { rescue: true })!;
  const detail = (plan: HeroPlan, object: 'original' | 'derivative' = 'original', bytes = sha) =>
    ({ stored_sha256: sha, [HERO_PLAN_KEY]: { plan, object, sha256: bytes, planned_at: '2026-10-01T00:00:00Z' } });

  it('is drawn for the bytes it measured', () => {
    expect(heroPlanForServed(detail(v3), { object: 'original', sha256: sha })).not.toBeNull();
  });

  it('a replaced source voids it', () => {
    expect(heroPlanForServed(detail(v3), { object: 'original', sha256: other })).toBeNull();
  });

  it('a repaired source becoming the served object voids it', () => {
    expect(heroPlanForServed(detail(v3), { object: 'derivative', sha256: derived })).toBeNull();
    expect(heroPlanForServed(detail(v3, 'derivative', derived), { object: 'derivative', sha256: derived })).not.toBeNull();
  });

  it('a stale v2 plan still draws until it is re-planned — no card blanks for a version bump', () => {
    const v2 = planHero(drawScene({ width: 320, height: 240, horizon: 170, seed: 7,
      houses: [{ x: 70, w: 180, roofTop: 90, base: 176, garage: true }] }).thumbnail, undefined, { rescue: false })!;
    expect(v2.version).toBe(2);
    expect(heroPlanForServed(detail(v2), { object: 'original', sha256: sha })).not.toBeNull();
  });
});

describe('malformed plans and worker answers change nothing', () => {
  const fitPlan = planHero(drawScene({ ...PANORAMA, houses: [{ x: 20, w: 360, roofTop: 30, base: 86 }] }).thumbnail,
    undefined, { rescue: true })!;
  const cropPlan = planHero(drawScene({ ...PANORAMA, pole: 40, houses: [{ x: 150, w: 130, roofTop: 30, base: 86 }] }).thumbnail,
    undefined, { rescue: true })!;

  it('a v3 fit without its reason, or with an unknown one, is refused', () => {
    expect(fitPlan.mode).toBe('fit');
    expect(validateHeroPlan(fitPlan)).toBe(true);
    expect(validateHeroPlan({ ...fitPlan, fitReason: undefined })).toBe(false);
    expect(validateHeroPlan({ ...fitPlan, fitReason: 'other' })).toBe(false);
  });

  it('a v3 crop carrying a fit reason is refused', () => {
    expect(cropPlan.mode).toBe('crop');
    expect(validateHeroPlan({ ...cropPlan, fitReason: 'building_too_wide' })).toBe(false);
  });

  it('a version the readers do not know is refused', () => {
    expect(validateHeroPlan({ ...cropPlan, version: 4 })).toBe(false);
    expect(validateHeroPlan({ ...cropPlan, version: 1 })).toBe(false);
  });

  describe('through the worker', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
    const route = () => {
      vi.stubEnv('BUILDER_STOCK_PDF_WORKER_URL', 'https://worker.invalid');
      vi.stubEnv('BUILDER_STOCK_PDF_WORKER_TOKEN', 'token');
    };
    const bytes = new Uint8Array([1, 2, 3, 4]);

    it('a plan that does not validate is a worker failure, never stored', async () => {
      route();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
        status: 200, headers: { [WORK_OUTCOME_HEADER]: encodeWorkDocument({ ok: true, plan: { ...fitPlan, fitReason: undefined } }) },
      })));
      const answer = await planHeroWithCapacity(bytes, { rescue: true });
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.reason).toBe('worker');
    });

    it('a worker that times out is an operational failure', async () => {
      route();
      vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }));
      const answer = await planHeroWithCapacity(bytes, { rescue: true });
      expect(answer).toMatchObject({ ok: false, reason: 'worker', operational: true });
    });

    it('a worker that fails is an operational failure', async () => {
      route();
      vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
      const answer = await planHeroWithCapacity(bytes, { rescue: true });
      expect(answer).toMatchObject({ ok: false, reason: 'worker', operational: true });
    });

    it('the rescue switch is sent to the worker, and a valid v3 plan comes back as one', async () => {
      route();
      const fetchMock = vi.fn(async () => new Response(null, {
        status: 200, headers: { [WORK_OUTCOME_HEADER]: encodeWorkDocument({ ok: true, plan: cropPlan, tile: null, thumbnail: null }) },
      }));
      vi.stubGlobal('fetch', fetchMock);
      const answer = await planHeroWithCapacity(bytes, { rescue: true });
      expect(answer.ok).toBe(true);
      const sent = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
      expect(JSON.stringify(sent)).toMatch(/x-work-context/i);
    });
  });
});

describe('ties — croppability breaks a tie between equal evidence, never more', () => {
  const sha = (n: number) => String(n).repeat(64).slice(0, 64);
  const crop = planHero(drawScene({ ...PANORAMA, pole: 40, houses: [{ x: 150, w: 130, roofTop: 30, base: 86 }] }).thumbnail,
    undefined, { rescue: true })!;
  const fit = planHero(drawScene({ ...PANORAMA, houses: [{ x: 20, w: 360, roofTop: 30, base: 86 }] }).thumbnail,
    undefined, { rescue: true })!;
  const image = (id: string, level: number, plan: HeroPlan | null, position: number, n: number) => ({
    id, position, source_stage: 'uploaded_document', verification_status: 'source_supplied', processing_status: 'ready',
    storage_path: `${id}.png`, external_url: null,
    source_detail: {
      role: 'primary_property', role_evidence_level: level, provenance_version: 30, stored_sha256: sha(n),
      marketplace_display_eligible: true, marketplace_eligibility_state: 'eligible',
      ...(plan ? { [HERO_PLAN_KEY]: { plan, object: 'original', sha256: sha(n), planned_at: 'x' } } : {}),
    },
  });

  it('between equal evidence, the v3 crop wins over a v3 fit at an earlier position', () => {
    const chosen = chooseDisplayableImage([image('a', 1, fit, 0, 1), image('b', 1, crop, 1, 2)] as never[]);
    expect((chosen as unknown as { id: string }).id).toBe('b');
  });

  it('weaker evidence with a nicer crop never wins', () => {
    const chosen = chooseDisplayableImage([image('a', 1, fit, 1, 1), image('b', 3, crop, 0, 2)] as never[]);
    expect((chosen as unknown as { id: string }).id).toBe('a');
  });
});

describe('generated scenes — ground truth by construction', () => {
  /*
   * PROPERTY TESTS, seeded and deterministic. `rescuableScene` builds a
   * property that fits a 16:9 frame with room to spare among the things that
   * fool a first pass, each across open sky; `impossibleScene` builds one no
   * 16:9 frame can hold. The noisy variant adds cloud at roof height, where a
   * white cloud and a white wall are the same thing to a block, so a fit
   * there is allowed — but never a cut, and never without its reason.
   */
  const N = 120;

  it(`${N} rescuable scenes: never a fit, never a cut, never outside the photograph`, () => {
    for (let seed = 1; seed <= N; seed += 1) {
      const scene = drawScene(rescuableScene(seed));
      const p = planHero(scene.thumbnail, undefined, { rescue: true })!;
      expect.soft(p.mode, `seed ${seed}`).not.toBe('fit');
      expect.soft(inside(visible(scene.subject, scene.photo), p.crop), `seed ${seed} cut`).toBe(true);
      if (p.mode === 'crop') expect.soft(inside(p.crop, scene.photo), `seed ${seed} canvas`).toBe(true);
      expect.soft(validateHeroPlan(p), `seed ${seed} valid`).toBe(true);
    }
  }, 60_000);

  it(`${N} impossible scenes: always a fit, with the size reason`, () => {
    for (let seed = 1; seed <= N; seed += 1) {
      const p = planHero(drawScene(impossibleScene(seed)).thumbnail, undefined, { rescue: true })!;
      expect.soft(p.mode, `seed ${seed}`).toBe('fit');
      expect.soft(p.fitReason, `seed ${seed}`).toBe('building_too_wide');
    }
  }, 60_000);

  it(`${N} noisy scenes: never a cut, every fit named, nothing drawn v2 would not`, () => {
    for (let seed = 1; seed <= N; seed += 1) {
      const scene = drawScene(rescuableScene(seed, true));
      const v2 = planHero(scene.thumbnail, undefined, { rescue: false })!;
      const p = planHero(scene.thumbnail, undefined, { rescue: true })!;
      expect.soft(inside(visible(scene.subject, scene.photo), p.crop), `seed ${seed} cut`).toBe(true);
      expect.soft(inside(p.crop, v2.usable) || p.mode === 'original', `seed ${seed} canvas`).toBe(true);
      if (p.mode === 'fit') expect.soft(HERO_FIT_REASONS, `seed ${seed}`).toContain(p.fitReason);
    }
  }, 60_000);

  it(`${N * 2} plain photographs: no page is ever invented, and v3 cuts nothing v2 holds`, () => {
    for (let seed = 1; seed <= N * 2; seed += 1) {
      const scene = drawScene(plainScene(seed));
      const u = findUsableRegion(scene.thumbnail);
      expect.soft(findPhotoRegion(scene.thumbnail, u).changed, `seed ${seed} canvas`).toBe(false);
      const v2 = planHero(scene.thumbnail, undefined, { rescue: false })!;
      const p = planHero(scene.thumbnail, undefined, { rescue: true })!;
      const truth = visible(scene.subject, scene.photo);
      if (inside(truth, v2.crop)) expect.soft(inside(truth, p.crop), `seed ${seed} cut`).toBe(true);
    }
  }, 60_000);

  it('the rescue is deterministic: the same pixels plan the same', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const scene = drawScene(rescuableScene(seed));
      expect(planHero(scene.thumbnail, undefined, { rescue: true }))
        .toEqual(planHero(scene.thumbnail, undefined, { rescue: true }));
    }
  });
});

describe('through the real decoder — the pictures the production proof uploads', () => {
  /*
   * Encoded at full size and planned from the BYTES, as the sweep does: the
   * decoder downscales and stretches contrast. The first canvas rules were
   * tested only at thumbnail size and missed a brochure page and a banner
   * here — every real picture takes this path.
   */
  it.each(Object.entries(HERO_PROOF_CASES))('%s: %s', async (_key, c) => {
    const scene = drawScene({ ...c.scene, scale: 1 });
    const png = await encodePng(scene.thumbnail.pixels, { width: c.scene.width, height: c.scene.height, components: 3 });
    const answer = await planHeroFromBytes(png!);
    if (!answer.ok) throw new Error('no plan');
    const p = answer.plan;
    expect(p.mode).toBe(c.expect.mode);
    if (c.expect.fitReason) expect(p.fitReason).toBe(c.expect.fitReason);
    expect(validateHeroPlan(p)).toBe(true);
    // The house is never cut (one source pixel of downscale rounding allowed).
    const s = visible(scene.subject, scene.photo);
    const slack = { x: p.crop.x - 2, y: p.crop.y - 2, w: p.crop.w + 4, h: p.crop.h + 4 };
    expect(inside(s, slack)).toBe(true);
    if (c.expect.insidePhoto) {
      const photo = { x: scene.photo.x - 2, y: scene.photo.y - 2, w: scene.photo.w + 4, h: scene.photo.h + 4 };
      expect(inside(p.crop, photo)).toBe(true);
    }
  });
});
