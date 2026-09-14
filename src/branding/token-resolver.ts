import {
  defaultDarkTokenMap,
  defaultLightTokenMap,
  DEFAULT_ACCENT,
  DEFAULT_BRAND,
  DEFAULT_PRIMARY,
  LIGHT_DEFAULT_ACCENT,
  LIGHT_DEFAULT_PRIMARY,
} from './brand-defaults';
import type { BrandConfig, BrandTokenMap, ResolvedBrandTokens } from './brand-types';
import { resolveFontStack, resolveFontScale } from './brand-fonts';
import {
  formatHsl,
  getReadableForeground,
  normalizeHslString,
  parseHsl,
  rotateHue,
  shiftLightness,
  shiftSaturation,
} from './color-utils';


/**
 * Brand colour ramp (brand-50 … brand-950), derived from the brand hue at a
 * fixed lightness ladder (modelled on Tailwind's amber ramp). This lets
 * art-directed "gold" components migrate off amber-* / yellow-* while KEEPING
 * their shade structure (and contrast) — and the whole ramp now cascades from
 * the White-Label brand colour. Theme-agnostic: same absolute colours in light
 * and dark; the component picks the shade.
 */
const BRAND_RAMP_LIGHTNESS: Record<string, number> = {
  '--brand-50': 96,
  '--brand-100': 90,
  '--brand-200': 82,
  '--brand-300': 72,
  '--brand-400': 62,
  '--brand-500': 52,
  '--brand-600': 45,
  '--brand-700': 38,
  '--brand-800': 32,
  '--brand-900': 28,
  '--brand-950': 17,
};

function createBrandRamp(brand: string): BrandTokenMap {
  const { h, s } = parseHsl(brand);
  const sat = Math.min(96, Math.max(55, s));
  const ramp: Record<string, string> = {};
  for (const [token, l] of Object.entries(BRAND_RAMP_LIGHTNESS)) {
    ramp[token] = formatHsl({ h, s: sat, l });
  }
  return ramp as BrandTokenMap;
}

function createLightBrandWash(brandHsl: string) {
  const { h, s } = parseHsl(brandHsl);

  return formatHsl({
    h,
    s: Math.min(34, Math.max(18, Math.round(s * 0.32))),
    l: 90,
  });
}

function createChartPalette(primary: string, accent: string, isDark: boolean) {
  return {
    '--chart-1': primary,
    '--chart-2': accent,
    '--chart-3': rotateHue(primary, 120),
    '--chart-4': rotateHue(primary, -34),
    '--chart-5': rotateHue(accent, 54),
    '--chart-6': rotateHue(primary, 176),
    '--chart-7': shiftSaturation(rotateHue(accent, -90), isDark ? 10 : -2),
    '--chart-8': rotateHue(primary, 214),
    '--chart-9': shiftLightness(primary, isDark ? 12 : -12),
    '--chart-10': shiftLightness(accent, isDark ? 10 : -10),
  } satisfies BrandTokenMap;
}

/**
 * Category A brand-accent tokens (the "gold"). Derived from the White-Label
 * brand colour so the accent cascades in both themes. The wash differs per
 * theme: a soft tint in light, a deep tint in dark.
 */
function createBrandTokens(brand: string, isDark: boolean): BrandTokenMap {
  return {
    '--brand': brand,
    '--brand-foreground': getReadableForeground(brand),
    '--brand-light': isDark ? shiftLightness(brand, -35) : createLightBrandWash(brand),
    ...createBrandRamp(brand),
  };
}

function createLightTokens(config: BrandConfig): BrandTokenMap {
  const primary = normalizeHslString(config.primaryColor, LIGHT_DEFAULT_PRIMARY);
  const accent = normalizeHslString(config.accentColor, defaultLightTokenMap['--accent'] || LIGHT_DEFAULT_ACCENT);
  const brand = normalizeHslString(config.brandColor, DEFAULT_BRAND);

  // Light mode keeps the luxury surface baseline while letting the saved brand
  // primary/accent drive dashboard accent semantics, the brand-gold token, and
  // the chart palette. Warm ivory, porcelain, champagne, body text, table and
  // *semantic* (success/warning/destructive/info) tokens stay protected from the
  // brand so a purple primary accents actions without washing out the UI and
  // without changing what a warning or error looks like.
  return {
    ...defaultLightTokenMap,
    '--primary': primary,
    '--primary-foreground': getReadableForeground(primary),
    '--primary-hover': shiftLightness(primary, -7),
    '--accent': accent,
    '--accent-foreground': getReadableForeground(accent),
    ...createBrandTokens(brand, false),
    // Category B — semantic tokens stay fixed (never follow the brand).
    '--info': defaultLightTokenMap['--info'],
    '--info-foreground': defaultLightTokenMap['--info-foreground'],
    '--info-light': defaultLightTokenMap['--info-light'],
    '--ring': primary,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': getReadableForeground(primary),
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': getReadableForeground(accent),
    '--sidebar-ring': primary,
    '--dashboard-primary-strong': primary,
    '--dashboard-primary-soft': createLightBrandWash(primary),
    '--topbar-background': defaultLightTokenMap['--dashboard-surface'],
    '--sidebar-surface': defaultLightTokenMap['--sidebar-background'],
    '--mobile-nav-background': defaultLightTokenMap['--dashboard-surface'],
    // NOTE: light-mode chart palette intentionally stays at the curated
    // default (not brand-derived) — see token-resolver.test.ts. Dark mode
    // derives charts from the brand.
  };
}

function createDarkTokens(config: BrandConfig): BrandTokenMap {
  const primary = normalizeHslString(config.primaryColor, DEFAULT_PRIMARY);
  const accent = normalizeHslString(config.accentColor, primary || DEFAULT_ACCENT);
  const brand = normalizeHslString(config.brandColor, DEFAULT_BRAND);

  return {
    ...defaultDarkTokenMap,
    '--primary': primary,
    '--primary-foreground': getReadableForeground(primary),
    '--primary-hover': shiftLightness(primary, -7),
    '--accent': accent,
    '--accent-foreground': getReadableForeground(accent),
    ...createBrandTokens(brand, true),
    // Category B — semantic tokens stay fixed (inherited from defaults):
    // --info / --warning / --success / --destructive are NOT derived from the
    // brand. They convey meaning, so blue stays blue, amber stays amber, etc.
    '--ring': primary,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': getReadableForeground(primary),
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': getReadableForeground(accent),
    '--sidebar-ring': primary,
    '--dashboard-primary-strong': primary,
    '--dashboard-primary-soft': shiftLightness(primary, -35),
    '--dashboard-border-strong': shiftLightness(primary, -20),
    '--topbar-background': defaultDarkTokenMap['--dashboard-surface'],
    '--sidebar-surface': defaultDarkTokenMap['--sidebar-background'],
    '--mobile-nav-background': defaultDarkTokenMap['--dashboard-surface'],
    ...createChartPalette(primary, accent, true),
  };
}

export function resolveBrandTokens(config: BrandConfig): ResolvedBrandTokens {
  return {
    light: createLightTokens(config),
    dark: createDarkTokens(config),
  };
}

/**
 * Theme-agnostic typography variables derived from the White-Label font
 * selection. Applied to :root by BrandProvider so every text component picks up
 * the brand font. Body and heading fonts + a global base size.
 */
export function resolveBrandFontVars(config: BrandConfig): BrandTokenMap {
  const body = resolveFontStack(config.fontFamily);
  const heading = config.headingFontFamily
    ? resolveFontStack(config.headingFontFamily)
    : body;
  return {
    '--font-sans': body,
    '--font-heading': heading,
    '--base-font-size': resolveFontScale(config.fontScale),
  };
}

export function applyBrandTokenMap(tokenMap: BrandTokenMap) {
  const root = document.documentElement;

  Object.entries(tokenMap).forEach(([token, value]) => {
    root.style.setProperty(token, value);
  });
}
