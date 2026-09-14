/**
 * Colour conversion and contrast — the canonical implementation.
 *
 * This is the ONE place the product converts between the app's bare HSL triplet
 * form (`43 74% 49%`), hex (`#D9A521`) and the 0–1 float triplets pdf-lib wants.
 * `src/branding/color-utils.ts` re-exports it, so the app and the Edge Functions
 * cannot disagree about what a colour is.
 *
 * Lives in `_shared` rather than `src/` because Edge Functions cannot import
 * from `src/` — but `src/` can import from here. See
 * `docs/reports/DESIGN_SYSTEM.md` §3.2.
 *
 * ## Why contrast helpers belong in a colour module
 *
 * The report layer has a hard contrast floor that varies by type size (see
 * `tokens.pure.ts`), and the brand gold fails it at the size the brand's own
 * eyebrow signature is set. Every previous attempt to solve that produced
 * another hardcoded gold — the codebase carries eight. `ensureContrast()` makes
 * the darker variant a *derivation* instead of a nineteenth literal.
 *
 * Pure TypeScript: no imports, no Deno APIs, no DOM. Consumable by Deno, Vite
 * and Vitest alike.
 */
/* eslint-disable no-restricted-syntax --
 * The few hexes below are FALLBACKS inside the conversion primitives — what a
 * malformed input degrades to. They are not design decisions; the palette lives
 * in tokens.pure.ts.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ─── HSL triplet form ────────────────────────────────────────────────────────

export function normalizeHslString(hsl: unknown, fallback: string): string {
  if (typeof hsl !== 'string' || !hsl) return fallback;

  const parts = hsl.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (!parts) return fallback;

  const h = ((Number(parts[1]) % 360) + 360) % 360;
  const s = clamp(Number(parts[2]), 0, 100);
  const l = clamp(Number(parts[3]), 0, 100);
  return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`;
}

export function parseHsl(hsl: string): { h: number; s: number; l: number } {
  const normalized = normalizeHslString(hsl, hsl);
  const parts = normalized.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);

  if (!parts) {
    return { h: 43, s: 74, l: 49 };
  }

  return {
    h: Number(parts[1]),
    s: Number(parts[2]),
    l: Number(parts[3]),
  };
}

export function formatHsl({ h, s, l }: { h: number; s: number; l: number }): string {
  return `${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 0, 100))}%`;
}

export function shiftLightness(hsl: string, delta: number): string {
  const { h, s, l } = parseHsl(hsl);
  return formatHsl({ h, s, l: clamp(l + delta, 0, 100) });
}

export function shiftSaturation(hsl: string, delta: number): string {
  const { h, s, l } = parseHsl(hsl);
  return formatHsl({ h, s: clamp(s + delta, 0, 100), l });
}

export function rotateHue(hsl: string, delta: number): string {
  const { h, s, l } = parseHsl(hsl);
  return formatHsl({ h: h + delta, s, l });
}

// ─── Conversion ──────────────────────────────────────────────────────────────

function hue2rgb(p: number, q: number, t: number): number {
  let adjusted = t;
  if (adjusted < 0) adjusted += 1;
  if (adjusted > 1) adjusted -= 1;
  if (adjusted < 1 / 6) return p + (q - p) * 6 * adjusted;
  if (adjusted < 1 / 2) return q;
  if (adjusted < 2 / 3) return p + (q - p) * (2 / 3 - adjusted) * 6;
  return p;
}

/** HSL components (h 0–360, s/l 0–100) to 0–1 RGB. */
function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
  const hue = h / 360;
  const sat = s / 100;
  const lig = l / 100;
  if (sat === 0) return [lig, lig, lig];
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  return [hue2rgb(p, q, hue + 1 / 3), hue2rgb(p, q, hue), hue2rgb(p, q, hue - 1 / 3)];
}

export function hexToHsl(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '43 74% 49%';

  const r = parseInt(result[1], 16) / 255;
  const g = parseInt(result[2], 16) / 255;
  const b = parseInt(result[3], 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function toHexPair(x: number): string {
  const hex = Math.round(clamp(x, 0, 1) * 255).toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
}

/**
 * HSL triplet to hex.
 *
 * Note the integer-only match: this is the historical behaviour every existing
 * consumer of `src/branding/color-utils.ts` depends on, and `tokens.css` only
 * ever contains integers. `hslComponentsToHex()` below is the precise path used
 * by the print token derivation, which does need fractional lightness.
 */
export function hslToHex(hsl: string): string {
  const parts = hsl.match(/(\d+)\s+(\d+)%?\s+(\d+)%?/);
  if (!parts) return '#D4A017';
  const [r, g, b] = hslToRgb01(
    parseInt(parts[1], 10),
    parseInt(parts[2], 10),
    parseInt(parts[3], 10),
  );
  return `#${toHexPair(r)}${toHexPair(g)}${toHexPair(b)}`;
}

/** Precise HSL→hex, fractional components honoured. */
export function hslComponentsToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb01(h, clamp(s, 0, 100), clamp(l, 0, 100));
  return `#${toHexPair(r)}${toHexPair(g)}${toHexPair(b)}`.toUpperCase();
}

/** Hex to the 0–1 float triplet pdf-lib's `rgb()` expects. */
export function hexToRgb01(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Blend two hex colours in sRGB. `t` is the weight of `b`; `0` returns `a`.
 *
 * This is how a tint is expressed on the vector PDF paths. HTML can say
 * `rgba(ink, 0.72)` and let the compositor do it, but pdf-lib and jsPDF have no
 * alpha channel for text — so a muted variant on a known ground has to be a
 * pre-mixed opaque colour. Mixing against the actual ground is exact, not an
 * approximation: the composite is what the alpha would have produced.
 */
export function mixHex(a: string, b: string, t: number): string {
  const w = Math.min(1, Math.max(0, t));
  const [ar, ag, ab] = hexToRgb01(a);
  const [br, bg, bb] = hexToRgb01(b);
  const ch = (x: number, y: number) => Math.round((x + (y - x) * w) * 255);
  const pair = (n: number) => n.toString(16).padStart(2, '0');
  return `#${pair(ch(ar, br))}${pair(ch(ag, bg))}${pair(ch(ab, bb))}`.toUpperCase();
}

// ─── Luminance and contrast ──────────────────────────────────────────────────

function toLinear(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminanceFromRgb01([r, g, b]: [number, number, number]): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function relativeLuminanceFromHsl(hsl: string): number {
  const { h, s, l } = parseHsl(hsl);
  return luminanceFromRgb01(hslToRgb01(h, s, l));
}

export function relativeLuminanceFromHex(hex: string): number {
  return luminanceFromRgb01(hexToRgb01(hex));
}

export function getReadableForeground(backgroundHsl: string, dark = '0 0% 5%', light = '0 0% 100%'): string {
  return relativeLuminanceFromHsl(backgroundHsl) > 0.45 ? dark : light;
}

/** WCAG 2.1 contrast ratio between two hex colours. Always ≥ 1. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminanceFromHex(hexA);
  const b = relativeLuminanceFromHex(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Walk a colour's lightness until it clears `min` contrast against `ground`,
 * preserving hue and saturation.
 *
 * Direction is chosen by the ground: on a light ground the colour darkens, on a
 * dark ground it lightens. Steps in 1% increments, which is fine enough that
 * the result is visually the same family and coarse enough to terminate fast.
 *
 * Returns the best colour found. If even pure black/white cannot reach `min`
 * the extreme is returned rather than throwing — a caller wanting to *enforce*
 * the floor should assert on `contrastRatio()` afterwards, which is what
 * `printContrast.spec.ts` does.
 */
export function ensureContrast(hex: string, ground: string, min: number): string {
  if (contrastRatio(hex, ground) >= min) return hex.toUpperCase();

  const { h, s, l } = parseHsl(hexToHsl(hex));
  const groundIsLight = relativeLuminanceFromHex(ground) > 0.5;
  const step = groundIsLight ? -1 : 1;

  let best = hslComponentsToHex(h, s, l);
  let bestRatio = contrastRatio(best, ground);

  for (let i = 1; i <= 100; i += 1) {
    const nextL = l + step * i;
    if (nextL < 0 || nextL > 100) break;
    const candidate = hslComponentsToHex(h, s, nextL);
    const ratio = contrastRatio(candidate, ground);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
    if (ratio >= min) return candidate;
  }

  return best;
}
