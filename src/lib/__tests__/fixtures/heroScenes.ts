/**
 * SYNTHETIC PROPERTY PICTURES for the Marketplace Hero Standard's regression
 * suite. No customer picture is ever used in a test: these are drawn here,
 * deterministically, and made deliberately UNEASY — sky with grain, a lawn
 * with the edge-dense texture a real photograph's grass has, roof tiles that
 * carry no vertical edges, a plain garage door that breaks the house's
 * structure in two, paving that runs to the frame's edge — so a planner that
 * only works on a clean diagram fails here.
 *
 * The ground truth is returned with every scene: the house's bounds, roof to
 * slab, which is exactly what a hero frame must never cut.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export interface SceneHouse {
  /** Left edge and width of the walls, in thumbnail pixels. */
  x: number;
  w: number;
  /** Top of the roof and the slab line. */
  roofTop: number;
  base: number;
  /** Wall height share of the house (the rest is roof). */
  wallShare?: number;
  /** A garage beside the walls, as a share of the width. */
  garage?: boolean;
}
export interface SceneOptions {
  width: number;
  height: number;
  /** The source the thumbnail stands for, as a multiple of its size. */
  scale?: number;
  horizon: number;
  houses: SceneHouse[];
  /** Grain on the lawn: 16 for a photograph, 4 for a render. */
  lawnGrain?: number;
  /** Uniform flat sky colour instead of a gradient (an overcast day). */
  flatSky?: [number, number, number];
  /** Bands of canvas at the edges, in thumbnail pixels. */
  canvas?: { top?: number; bottom?: number; left?: number; right?: number; colour: [number, number, number] };
  seed?: number;
}
export interface Scene {
  thumbnail: { width: number; height: number; pixels: Uint8Array; sourceWidth: number; sourceHeight: number };
  /** Every house's bounds in SOURCE pixels, roof to slab, eaves included. */
  houses: Rect[];
  /** The photograph inside any canvas, in source pixels. */
  photo: Rect;
  scale: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

export function drawScene(options: SceneOptions): Scene {
  const { width: W, height: H } = options;
  const scale = options.scale ?? 6;
  const random = rng(options.seed ?? 7);
  const px = new Uint8Array(W * H * 3);
  const set = (x: number, y: number, c: readonly number[], grain = 0) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const n = grain ? (random() * 2 - 1) * grain : 0;
    const i = (y * W + x) * 3;
    px[i] = clamp(c[0] + n); px[i + 1] = clamp(c[1] + n); px[i + 2] = clamp(c[2] + n);
  };
  const c = options.canvas;
  const photo = {
    x: c?.left ?? 0, y: c?.top ?? 0,
    w: W - (c?.left ?? 0) - (c?.right ?? 0), h: H - (c?.top ?? 0) - (c?.bottom ?? 0),
  };
  const fill = (r: Rect, colour: readonly number[], grain = 0) => {
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y += 1) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x += 1) set(x, y, colour, grain);
    }
  };

  // Sky and lawn, inside the photograph only.
  for (let y = photo.y; y < photo.y + photo.h; y += 1) {
    for (let x = photo.x; x < photo.x + photo.w; x += 1) {
      if (y < options.horizon) {
        if (options.flatSky) set(x, y, options.flatSky, 0.6);
        else {
          const t = (y - photo.y) / Math.max(1, options.horizon - photo.y);
          set(x, y, [110 + 90 * t, 160 + 60 * t, 220 + 20 * t], 3);
        }
      } else {
        set(x, y, [72, 128, 62], options.lawnGrain ?? 16);
      }
    }
  }

  const houses: Rect[] = [];
  for (const house of options.houses) {
    const wallShare = house.wallShare ?? 0.6;
    const total = house.base - house.roofTop;
    const wallTop = Math.round(house.base - total * wallShare);
    const garageW = house.garage ? Math.round(house.w * 0.32) : 0;
    const bodyX = house.x + garageW;
    const bodyW = house.w - garageW;

    // Driveway: paving from the garage (or the door) to the frame's foot.
    const dx = house.garage ? house.x : bodyX + Math.round(bodyW * 0.4);
    const dw = house.garage ? garageW : Math.round(bodyW * 0.2);
    for (let y = house.base; y < photo.y + photo.h; y += 1) {
      const spread = Math.round((y - house.base) * 0.35);
      for (let x = dx - spread; x < dx + dw + spread; x += 1) {
        if (x >= photo.x && x < photo.x + photo.w) set(x, y, [150, 150, 148], 6);
      }
    }

    // Roof: a dark trapezoid with horizontal tile courses and an eave.
    const eave = Math.max(2, Math.round(house.w * 0.04));
    for (let y = house.roofTop; y < wallTop; y += 1) {
      const t = (y - house.roofTop) / Math.max(1, wallTop - house.roofTop);
      const inset = Math.round((1 - t) * house.w * 0.18);
      const tile = (y - house.roofTop) % 4 === 0 ? -22 : 0;
      for (let x = house.x - eave + inset; x < house.x + house.w + eave - inset; x += 1) {
        set(x, y, [82 + tile, 80 + tile, 86 + tile], 3);
      }
    }
    // Walls, a render colour with little grain.
    fill({ x: bodyX, y: wallTop, w: bodyW, h: house.base - wallTop }, [226, 216, 200], 3);
    // Windows: dark glass in light frames — the vertical edges of a house.
    const wallH = house.base - wallTop;
    const windows = Math.max(2, Math.round(bodyW / 40));
    for (let k = 0; k < windows; k += 1) {
      const wx = bodyX + Math.round(((k + 0.5) / windows) * bodyW) - Math.round(bodyW / windows / 4);
      const ww = Math.max(4, Math.round(bodyW / windows / 2));
      fill({ x: wx - 1, y: wallTop + Math.round(wallH * 0.18) - 1, w: ww + 2, h: Math.round(wallH * 0.5) + 2 }, [245, 245, 245]);
      fill({ x: wx, y: wallTop + Math.round(wallH * 0.18), w: ww, h: Math.round(wallH * 0.5) }, [48, 58, 70], 4);
      fill({ x: wx + Math.round(ww / 2), y: wallTop + Math.round(wallH * 0.18), w: 1, h: Math.round(wallH * 0.5) }, [240, 240, 240]);
    }
    // Wall corners: dark downpipes.
    fill({ x: bodyX, y: wallTop, w: 1, h: wallH }, [90, 90, 90]);
    fill({ x: bodyX + bodyW - 1, y: wallTop, w: 1, h: wallH }, [90, 90, 90]);
    // A garage: a PLAIN light door with faint horizontal panels.
    if (house.garage) {
      fill({ x: house.x, y: wallTop, w: garageW, h: house.base - wallTop }, [208, 200, 188], 2);
      for (let y = wallTop + Math.round(wallH * 0.15); y < house.base; y += 5) {
        fill({ x: house.x + 2, y, w: garageW - 4, h: 1 }, [180, 178, 172]);
      }
      fill({ x: house.x, y: wallTop, w: 1, h: wallH }, [90, 90, 90]);
    }
    houses.push({
      x: (house.x - eave) * scale, y: house.roofTop * scale,
      w: (house.w + 2 * eave) * scale, h: (house.base - house.roofTop) * scale,
    });
  }

  if (c) {
    fill({ x: 0, y: 0, w: W, h: c.top ?? 0 }, c.colour);
    fill({ x: 0, y: H - (c.bottom ?? 0), w: W, h: c.bottom ?? 0 }, c.colour);
    fill({ x: 0, y: 0, w: c.left ?? 0, h: H }, c.colour);
    fill({ x: W - (c.right ?? 0), y: 0, w: c.right ?? 0, h: H }, c.colour);
  }

  return {
    thumbnail: { width: W, height: H, pixels: px, sourceWidth: W * scale, sourceHeight: H * scale },
    houses,
    photo: { x: photo.x * scale, y: photo.y * scale, w: photo.w * scale, h: photo.h * scale },
    scale,
  };
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
