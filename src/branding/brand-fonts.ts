/**
 * Global font configuration for the White-Label page.
 *
 * Fonts are a *global brand setting*: chosen once on the branding page and
 * cascaded to every text component via the --font-sans / --font-heading /
 * --base-font-size tokens (applied by BrandProvider). No component should ever
 * declare its own font-family.
 *
 * The options below are a curated allow-list of dependency-free system font
 * stacks that render distinctly across platforms without any network request.
 * To offer a bespoke web font (e.g. Inter, Poppins), self-host it via an
 * `@fontsource/*` package and add one entry here with its family name at the
 * front of the stack — nothing else in the pipeline needs to change.
 */

/** The platform's dependency-free fallback, and the tail of both brand stacks. */
export const SYSTEM_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

/**
 * The Aurixa brand faces — the network's own default, and the two families
 * aurixasystems.com.au sets.
 *
 * The site declares them as `--font-sans` / `--font-display` in its Tailwind
 * `@theme` and loads them from Google Fonts; this is the same pair, SELF-HOSTED
 * through `@fontsource` (imported in `main.tsx`), which is what keeps the rule
 * above true — the allow-list is stacks that need no third party to render.
 *
 * Both keep `SYSTEM_FONT_STACK` behind them, so a blocked or slow font file
 * degrades to the stack this portal shipped with rather than to a serif nobody
 * chose. The display stack's own fallbacks are serif, because a heading set in
 * Playfair that falls back to a sans changes the page's whole voice.
 */
export const AURIXA_SANS_STACK = `"Inter", ${SYSTEM_FONT_STACK}`;
export const AURIXA_DISPLAY_STACK =
  '"Playfair Display", ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';

export interface FontOption {
  /** Stable key persisted in whitelabel_settings.theme_config. */
  key: string;
  /** Human label shown in the picker. */
  label: string;
  /** The CSS font-family stack this option resolves to. */
  stack: string;
}

export const FONT_OPTIONS: FontOption[] = [
  { key: 'aurixa-sans', label: 'Aurixa — Inter', stack: AURIXA_SANS_STACK },
  { key: 'aurixa-display', label: 'Aurixa — Playfair Display', stack: AURIXA_DISPLAY_STACK },
  { key: 'system', label: 'System', stack: SYSTEM_FONT_STACK },
  {
    key: 'grotesk',
    label: 'Grotesk — Helvetica / Arial',
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    key: 'geometric',
    label: 'Geometric — Segoe / Roboto',
    stack: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  {
    key: 'humanist',
    label: 'Humanist — Trebuchet',
    stack: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif',
  },
  {
    key: 'serif',
    label: 'Serif — Georgia',
    stack: 'Georgia, "Times New Roman", Times, serif',
  },
  {
    key: 'slab',
    label: 'Slab serif — Rockwell',
    stack: 'Rockwell, "Roboto Slab", "Courier New", Georgia, serif',
  },
  {
    key: 'mono',
    label: 'Monospace',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
];

export interface FontScaleOption {
  key: string;
  label: string;
  /** Applied to --base-font-size (body font-size). */
  size: string;
}

export const FONT_SCALE_OPTIONS: FontScaleOption[] = [
  { key: 'compact', label: 'Compact', size: '0.9375rem' },
  { key: 'default', label: 'Default', size: '1rem' },
  { key: 'comfortable', label: 'Comfortable', size: '1.0625rem' },
];

const FONT_BY_KEY = new Map(FONT_OPTIONS.map((o) => [o.key, o]));
const SCALE_BY_KEY = new Map(FONT_SCALE_OPTIONS.map((o) => [o.key, o]));

/** Resolve a saved font key to its CSS stack (falls back to the system stack). */
export function resolveFontStack(key: string | null | undefined): string {
  if (!key) return SYSTEM_FONT_STACK;
  return FONT_BY_KEY.get(key)?.stack ?? SYSTEM_FONT_STACK;
}

/** Resolve a saved scale key to a CSS size (falls back to 1rem). */
export function resolveFontScale(key: string | null | undefined): string {
  if (!key) return '1rem';
  return SCALE_BY_KEY.get(key)?.size ?? '1rem';
}

export function isValidFontKey(key: string | null | undefined): boolean {
  return !!key && FONT_BY_KEY.has(key);
}
