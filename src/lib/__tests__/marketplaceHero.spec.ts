/**
 * THE MARKETPLACE HERO STANDARD — the planner's regression matrix.
 *
 * Every picture here is SYNTHETIC (`fixtures/heroScenes.ts`); no customer
 * picture is ever used in a test. The scenes carry the textures that make the
 * problem hard — lawn grain, tile courses with no vertical edges, a plain
 * garage door, paving to the frame's edge, an overcast sky as flat as a page —
 * and every assertion is about the two things the standard promises: the
 * building is never cut, and nothing outside the photograph is ever drawn.
 */
import { describe, expect, it } from 'vitest';

import {
  HERO_ASPECT_H, HERO_ASPECT_W, HERO_MAX_ZOOM, HERO_PLAN_KEY, HERO_PLAN_VERSION,
  heroPlanForServed, heroSuitabilityRank, planHero, validateHeroPlan,
  type HeroPlan, type PixelRect,
} from '../../../supabase/functions/_shared/builderStock/marketplaceHero.pure';
import {
  chooseDisplayableImage, heroPlanOfImage, servedObjectOf,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { drawScene, type Rect, type SceneOptions } from './fixtures/heroScenes';

const inside = (inner: Rect, outer: PixelRect) =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** The house as it stands IN the photograph (an eave can overhang the edge). */
const visible = (house: Rect, photo: Rect): Rect => {
  const x = Math.max(house.x, photo.x), y = Math.max(house.y, photo.y);
  return {
    x, y,
    w: Math.min(house.x + house.w, photo.x + photo.w) - x,
    h: Math.min(house.y + house.h, photo.y + photo.h) - y,
  };
};

function plan(options: SceneOptions) {
  const scene = drawScene(options);
  const result = planHero(scene.thumbnail);
  if (!result) throw new Error('no plan');
  return { scene, plan: result };
}

/** The invariants every plan obeys, whatever the scene. */
function expectSafe({ scene, plan: p }: ReturnType<typeof plan>) {
  expect(validateHeroPlan(p)).toBe(true);
  expect(p.version).toBe(HERO_PLAN_VERSION);
  // Nothing outside the photograph is ever drawn.
  expect(inside(p.crop, { ...scene.photo })).toBe(true);
  // The building is never cut.
  for (const house of scene.houses) expect(inside(visible(house, scene.photo), p.crop)).toBe(true);
  if (p.mode !== 'fit') expect(p.crop.w * HERO_ASPECT_H).toBe(p.crop.h * HERO_ASPECT_W);
  expect(p.measures.zoom).toBeLessThanOrEqual(HERO_MAX_ZOOM + 0.001);
}

describe('framing — the property is the subject', () => {
  it('huge sky, house low in a tall frame: the sky goes, the house stays whole', () => {
    const r = plan({ width: 320, height: 400, horizon: 330,
      houses: [{ x: 70, w: 180, roofTop: 250, base: 340, garage: true }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('crop');
    // At least half the frame's height of sky is gone.
    expect(r.plan.crop.y).toBeGreaterThan(r.scene.thumbnail.sourceHeight * 0.5);
    // And the roof does not touch the frame's top: breathing room.
    expect(r.scene.houses[0].y - r.plan.crop.y).toBeGreaterThan(0);
  });

  it('excessive ground below the house: kept to a useful band, not the whole lawn', () => {
    const r = plan({ width: 400, height: 300, horizon: 90,
      houses: [{ x: 100, w: 200, roofTop: 20, base: 110 }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('crop');
    expect(r.plan.crop.y + r.plan.crop.h).toBeLessThan(r.scene.thumbnail.sourceHeight);
  });

  it('a centred house in a 4:3 photograph is centred in the frame', () => {
    const r = plan({ width: 400, height: 300, horizon: 200,
      houses: [{ x: 110, w: 180, roofTop: 110, base: 210, garage: true }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('crop');
    const house = r.scene.houses[0];
    const left = house.x - r.plan.crop.x;
    const right = r.plan.crop.x + r.plan.crop.w - (house.x + house.w);
    expect(Math.abs(left - right)).toBeLessThan(r.plan.crop.w * 0.25);
  });

  it.each([
    ['left', { x: 4, w: 170 }],
    ['right', { x: 226, w: 170 }],
  ])('a house near the %s edge is kept whole, the frame pinned to that edge', (side, at) => {
    const r = plan({ width: 400, height: 300, horizon: 200,
      houses: [{ ...at, roofTop: 110, base: 210 }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('crop');
    if (side === 'left') expect(r.plan.crop.x).toBe(0);
    else expect(r.plan.crop.x + r.plan.crop.w).toBe(r.scene.thumbnail.sourceWidth);
  });

  it('a very wide house fills the frame and is not cut', () => {
    const r = plan({ width: 400, height: 300, horizon: 200,
      houses: [{ x: 14, w: 372, roofTop: 120, base: 210, garage: true }] });
    expectSafe(r);
    expect(r.plan.crop.w).toBe(r.scene.thumbnail.sourceWidth);
  });

  it('a portrait source whose house is taller than any 16:9 frame is shown WHOLE', () => {
    const r = plan({ width: 240, height: 400, horizon: 330,
      houses: [{ x: 30, w: 180, roofTop: 60, base: 340 }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('fit');
    expect(r.plan.reasons).toContain('subject_taller_than_frame');
    expect(r.plan.crop).toEqual(r.plan.usable);
  });

  it('a panorama with a house in it is framed around the house at full height', () => {
    const r = plan({ width: 400, height: 133, horizon: 105,
      houses: [{ x: 150, w: 100, roofTop: 40, base: 110 }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('crop');
    expect(r.plan.crop.w).toBeLessThan(r.scene.thumbnail.sourceWidth * 0.7);
  });

  it('a panorama whose house is wider than any 16:9 frame is shown whole, never cut', () => {
    const r = plan({ width: 400, height: 133, horizon: 105,
      houses: [{ x: 20, w: 360, roofTop: 40, base: 110 }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('fit');
    expect(r.plan.reasons).toContain('subject_wider_than_frame');
  });

  it('an already-perfect 16:9 picture is left exactly as it is', () => {
    const r = plan({ width: 400, height: 225, horizon: 170,
      houses: [{ x: 70, w: 260, roofTop: 60, base: 180, garage: true }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('original');
    expect(r.plan.crop).toEqual({ x: 0, y: 0, w: 2400, h: 1350 });
    expect(r.plan.measures.zoom).toBe(1);
  });

  it('a tiny house in a large picture is enlarged — within the zoom and resolution limits', () => {
    const r = plan({ width: 400, height: 225, horizon: 160,
      houses: [{ x: 170, w: 70, roofTop: 120, base: 168 }] });
    expectSafe(r);
    expect(r.plan.mode).toBe('crop');
    expect(r.plan.reasons).toContain('subject_enlarged');
    expect(r.plan.crop.w).toBeGreaterThanOrEqual(960);
    expect(r.plan.crop.w).toBeLessThan(r.scene.thumbnail.sourceWidth);
  });

  it('an overcast sky as flat as a page is NOT mistaken for brochure canvas', () => {
    const r = plan({ width: 400, height: 300, horizon: 200, flatSky: [205, 205, 205],
      houses: [{ x: 120, w: 160, roofTop: 110, base: 210 }] });
    expectSafe(r);
    expect(r.plan.usable).toEqual({ x: 0, y: 0, w: 2400, h: 1800 });
    expect(r.plan.reasons).not.toContain('canvas_trimmed');
  });

  it('a clean render (little lawn grain) frames the same way as a photograph', () => {
    const render = plan({ width: 400, height: 300, horizon: 200, lawnGrain: 4,
      houses: [{ x: 110, w: 180, roofTop: 110, base: 210, garage: true }] });
    expectSafe(render);
    expect(render.plan.mode).toBe('crop');
  });
});

describe('canvas — what is not photograph is never drawn', () => {
  it.each([
    ['white brochure margin', { top: 40, bottom: 35, left: 30, right: 30, colour: [255, 255, 255] }],
    ['black letterbox', { top: 38, bottom: 38, colour: [0, 0, 0] }],
    ['neutral grey canvas', { top: 30, bottom: 30, left: 40, right: 40, colour: [128, 128, 128] }],
  ] as const)('%s is trimmed and the frame stays inside the photograph', (_name, canvas) => {
    const r = plan({ width: 400, height: 300, horizon: 210, canvas: { ...canvas, colour: [...canvas.colour] },
      houses: [{ x: 120, w: 160, roofTop: 120, base: 220 }] });
    expectSafe(r);
    expect(r.plan.reasons).toContain('canvas_trimmed');
    // The usable region IS the photograph, to within one thumbnail pixel.
    const tolerance = r.scene.scale + 1;
    expect(Math.abs(r.plan.usable.x - r.scene.photo.x)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(r.plan.usable.y - r.scene.photo.y)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(r.plan.usable.w - r.scene.photo.w)).toBeLessThanOrEqual(2 * tolerance);
    expect(Math.abs(r.plan.usable.h - r.scene.photo.h)).toBeLessThanOrEqual(2 * tolerance);
  });
});

describe('no subject — never cropped past the old allowance', () => {
  const blank = (width: number, height: number) => drawScene({
    width, height, horizon: Math.round(height * 0.7), houses: [], lawnGrain: 2,
  }).thumbnail;

  it('a picture with no building is shown whole when its shape is not 16:9', () => {
    const p = planHero(blank(400, 300))!;
    expect(p.mode).toBe('fit');
    expect(p.confidence).toBe('low');
  });

  it('one already near 16:9 loses at most the old 3%', () => {
    const p = planHero(blank(400, 230))!;
    expect(validateHeroPlan(p)).toBe(true);
    expect(p.measures.cropAreaShare).toBeGreaterThanOrEqual(0.97);
  });
});

describe('planner failure — no plan, never an exception', () => {
  it.each([
    ['no pixels', { width: 400, height: 300, pixels: new Uint8Array(0), sourceWidth: 2400, sourceHeight: 1800 }],
    ['no size', { width: 0, height: 0, pixels: new Uint8Array(0), sourceWidth: 0, sourceHeight: 0 }],
    ['short buffer', { width: 400, height: 300, pixels: new Uint8Array(30), sourceWidth: 2400, sourceHeight: 1800 }],
  ])('%s answers null', (_name, thumbnail) => {
    expect(planHero(thumbnail)).toBeNull();
  });
});

describe('a stored plan is a claim about exact bytes', () => {
  const base = plan({ width: 320, height: 400, horizon: 330,
    houses: [{ x: 70, w: 180, roofTop: 250, base: 340 }] }).plan;
  const stored = { plan: base, object: 'original' as const, sha256: 'aa'.repeat(32), planned_at: '2026-10-01T00:00:00Z' };

  it('is drawn for the object and bytes it measured', () => {
    expect(heroPlanForServed({ [HERO_PLAN_KEY]: stored }, { object: 'original', sha256: 'aa'.repeat(32) }))
      .toEqual(base);
  });

  it('is void the moment the source changes — new bytes, or a different object served', () => {
    expect(heroPlanForServed({ [HERO_PLAN_KEY]: stored }, { object: 'original', sha256: 'bb'.repeat(32) })).toBeNull();
    expect(heroPlanForServed({ [HERO_PLAN_KEY]: stored }, { object: 'derivative', sha256: 'aa'.repeat(32) })).toBeNull();
    expect(heroPlanForServed({ [HERO_PLAN_KEY]: stored }, { object: 'original', sha256: null })).toBeNull();
  });

  it('a stale or tampered plan is refused by the same rules the planner obeys', () => {
    const cuts: HeroPlan = { ...base, crop: { ...base.crop, y: base.focal!.y + 10 } };
    const skewed: HeroPlan = { ...base, crop: { ...base.crop, h: base.crop.h - 9 } };
    const old: HeroPlan = { ...base, version: HERO_PLAN_VERSION - 1 };
    const outside: HeroPlan = { ...base, crop: { ...base.crop, x: base.source.width } };
    for (const bad of [cuts, skewed, old, outside]) {
      expect(validateHeroPlan(bad)).toBe(false);
      expect(heroPlanForServed({ [HERO_PLAN_KEY]: { ...stored, plan: bad } },
        { object: stored.object, sha256: stored.sha256 })).toBeNull();
    }
  });
});

describe('several candidates — croppability breaks a tie, never evidence', () => {
  const cropPlan = plan({ width: 320, height: 400, horizon: 330,
    houses: [{ x: 70, w: 180, roofTop: 250, base: 340 }] }).plan;
  const fitPlan = plan({ width: 240, height: 400, horizon: 330,
    houses: [{ x: 30, w: 180, roofTop: 60, base: 340 }] }).plan;
  const candidate = (id: string, level: number, heroPlan: HeroPlan | null, position: number) => {
    const sha = id.repeat(64).slice(0, 64);
    return {
      id, position,
      source_stage: 'uploaded_document', verification_status: 'source_supplied', processing_status: 'ready',
      storage_path: `org/${id}.jpg`, storage_bucket: 'builder-stock-images', external_url: null,
      source_detail: {
        role: 'primary_property', role_evidence_level: level, provenance_version: 26,
        stored_sha256: sha,
        marketplace_display_eligible: true, marketplace_eligibility_state: 'eligible',
        ...(heroPlan ? { [HERO_PLAN_KEY]: {
          plan: heroPlan, object: 'original', sha256: sha, planned_at: '2026-10-01T00:00:00Z',
        } } : {}),
      },
    };
  };

  it('between equal evidence, the picture a 16:9 card can frame wins over earlier position', () => {
    const chosen = chooseDisplayableImage([candidate('a', 1, fitPlan, 0), candidate('b', 1, cropPlan, 1)]);
    expect(chosen?.id).toBe('b');
  });

  it('a weaker-evidence picture with a nicer crop NEVER wins', () => {
    const chosen = chooseDisplayableImage([candidate('a', 1, fitPlan, 1), candidate('b', 3, cropPlan, 0)]);
    expect(chosen?.id).toBe('a');
  });

  it('an unplanned candidate is not demoted below where it stood', () => {
    expect(heroSuitabilityRank(null)).toBe(heroSuitabilityRank(fitPlan));
    const chosen = chooseDisplayableImage([candidate('a', 1, null, 0), candidate('b', 1, fitPlan, 1)]);
    expect(chosen?.id).toBe('a');
  });

  it('the plan is read against the object the door SERVES', () => {
    const image = candidate('c', 1, cropPlan, 0);
    expect(servedObjectOf(image)).toEqual({ object: 'original', storage_path: 'org/c.jpg', sha256: 'c'.repeat(64) });
    expect(heroPlanOfImage(image)).toEqual(cropPlan);
    // The builder replaces the file: the old plan no longer describes it.
    const replaced = { ...image, source_detail: { ...image.source_detail, stored_sha256: 'd'.repeat(64) } };
    expect(heroPlanOfImage(replaced)).toBeNull();
  });
});
