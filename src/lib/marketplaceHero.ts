/**
 * THE MARKETPLACE HERO STANDARD — the drawing half. Byte-identical in the
 * Builder Portal and the Command Centre.
 *
 * It applies a plan; it never makes one. The plan is computed once, on the
 * network, from the served picture's own pixels
 * (`supabase/functions/_shared/builderStock/marketplaceHero.pure.ts`), handed
 * to the browser by the same door that signs the picture's URL, and drawn here
 * as percentages of the frame — so the SAME rectangle of the SAME picture
 * fills the card at every width, on a phone and on a desktop, in both portals.
 *
 * Nothing is re-encoded and nothing is stretched: an element sized to
 * `source / crop` of the frame and offset by `-crop.x / crop.w` shows exactly
 * the crop, at the picture's own aspect, because the crop is exactly 16:9 and
 * the frame is 16:9. `object-fit: cover` stays on the element as a guarantee
 * that rounding can never distort it.
 *
 * Whatever is not a well-formed plan — none, an older version, a shape that
 * does not match the picture that actually loaded — is IGNORED, and the card
 * draws exactly as it did before this standard. That is the rollback, and it
 * needs no deploy.
 */
export const HERO_FRAME_ASPECT = 16 / 9;
export const HERO_PLAN_VERSION = 1;

export interface HeroRect { x: number; y: number; w: number; h: number }
export interface HeroPlanView {
  version: number;
  mode: 'original' | 'crop' | 'fit';
  source: { width: number; height: number };
  usable: HeroRect;
  crop: HeroRect;
}

const isRect = (r: unknown): r is HeroRect => {
  const v = r as Record<string, unknown> | null;
  return !!v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))
    && (v.w as number) > 0 && (v.h as number) > 0 && (v.x as number) >= 0 && (v.y as number) >= 0;
};

/** A plan this browser may draw, or null — draw the card as before. */
export function readHeroPlan(value: unknown): HeroPlanView | null {
  const plan = value as HeroPlanView | null;
  if (!plan || typeof plan !== 'object' || plan.version !== HERO_PLAN_VERSION) return null;
  if (!['original', 'crop', 'fit'].includes(plan.mode)) return null;
  const W = plan.source?.width, H = plan.source?.height;
  if (!(Number(W) > 0) || !(Number(H) > 0) || !isRect(plan.crop) || !isRect(plan.usable)) return null;
  if (plan.crop.x + plan.crop.w > W || plan.crop.y + plan.crop.h > H) return null;
  if (plan.mode === 'crop' && plan.crop.w * 9 !== plan.crop.h * 16) return null;
  return plan;
}

/**
 * Does the picture that LOADED match the picture the plan was made over? A
 * plan is in the served image's own pixels; a different shape means different
 * bytes, and the plan is then not drawn.
 */
export function heroPlanFitsPicture(plan: HeroPlanView, naturalWidth: number, naturalHeight: number): boolean {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return false;
  const planned = plan.source.width / plan.source.height;
  return Math.abs(naturalWidth / naturalHeight - planned) / planned <= 0.01;
}

export interface HeroGeometry {
  /** The box the picture is drawn in, as a share of the 16:9 frame. */
  box: { left: number; top: number; width: number; height: number };
  /** The picture's element inside that box, in percent of the box. */
  image: { left: number; top: number; width: number; height: number };
}

/**
 * Where the picture goes, in percentages. `crop`/`original`: the box IS the
 * frame. `fit`: the box is the photographic region contained in the frame —
 * shown whole, on the card's plain ground, nothing invented around it.
 */
export function heroGeometry(plan: HeroPlanView): HeroGeometry {
  const { crop, source } = plan;
  let box = { left: 0, top: 0, width: 100, height: 100 };
  if (plan.mode === 'fit') {
    const aspect = crop.w / crop.h;
    if (aspect >= HERO_FRAME_ASPECT) {
      const height = (HERO_FRAME_ASPECT / aspect) * 100;
      box = { left: 0, top: (100 - height) / 2, width: 100, height };
    } else {
      const width = (aspect / HERO_FRAME_ASPECT) * 100;
      box = { left: (100 - width) / 2, top: 0, width, height: 100 };
    }
  }
  return {
    box,
    image: {
      width: (source.width / crop.w) * 100,
      height: (source.height / crop.h) * 100,
      left: -(crop.x / crop.w) * 100,
      top: -(crop.y / crop.h) * 100,
    },
  };
}

/**
 * The rectangle of the SOURCE picture a frame of any size shows under a plan
 * — what a test uses to prove a phone and a desktop see the same thing.
 */
export function visibleSourceRect(plan: HeroPlanView, frameWidth: number): HeroRect {
  const frameHeight = frameWidth / HERO_FRAME_ASPECT;
  const g = heroGeometry(plan);
  const boxW = (g.box.width / 100) * frameWidth, boxH = (g.box.height / 100) * frameHeight;
  const imgW = (g.image.width / 100) * boxW, imgH = (g.image.height / 100) * boxH;
  const scaleX = plan.source.width / imgW, scaleY = plan.source.height / imgH;
  const offX = (-g.image.left / 100) * boxW, offY = (-g.image.top / 100) * boxH;
  return { x: offX * scaleX, y: offY * scaleY, w: boxW * scaleX, h: boxH * scaleY };
}
