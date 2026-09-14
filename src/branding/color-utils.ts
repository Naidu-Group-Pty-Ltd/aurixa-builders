/**
 * Colour conversion — frontend entry point.
 *
 * Re-exports the single CANONICAL implementation in
 * `supabase/functions/_shared/reportDesign/color.pure.ts` so the app, the Edge
 * Functions and Vitest all agree about what a colour is. The Edge Functions
 * cannot import from `src/`; `src/` can import from `_shared/`, which is why
 * the canonical copy lives there.
 *
 * This file used to hold its own implementation of the same ten functions. The
 * report layer needed them server-side, and duplicating them is exactly how the
 * codebase ended up with eight different brand golds — so they moved rather
 * than being copied.
 *
 * The public surface is unchanged: every function this module exported before
 * is still exported, with identical behaviour. It additionally gains
 * `contrastRatio`, `ensureContrast`, `hexToRgb01`, `hslComponentsToHex` and
 * `relativeLuminanceFromHex`.
 *
 * See docs/reports/DESIGN_SYSTEM.md §3.2.
 */
export * from '../../supabase/functions/_shared/reportDesign/color.pure.ts';
