/**
 * ONE PALETTE, DECLARED TWICE — AND THEY MUST AGREE.
 *
 * The portal's colours exist in two places by design, not by accident:
 *
 *   1. `src/styles/tokens.css` paints the FIRST FRAME. It is in the bundle's
 *      stylesheet, so it applies before a line of React runs.
 *   2. `src/branding/brand-defaults.ts` is what `BrandProvider` resolves and
 *      writes onto `documentElement.style` through `applyBrandTokenMap` — as
 *      INLINE styles, which beat any stylesheet rule whatever its specificity.
 *
 * So a disagreement between them is not "a wrong colour somewhere". It is a
 * page that renders in one palette and changes to another the moment the app
 * hydrates, on every load, for every reader. The CSS in that file is generated
 * from these maps for exactly this reason; this spec is what stops the next
 * edit to one of them being made without the other.
 *
 * It compares VALUES, not formatting: the maps are the source, and every token
 * a map declares must be declared in the matching CSS block with the same
 * triplet. The CSS is allowed to declare MORE (the brand ramp, the fonts, the
 * signature tokens and the sizing vars live only there, because nothing in the
 * white-label store writes them).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultBrandConfig,
  defaultDarkTokenMap,
  defaultLightTokenMap,
} from '../../branding/brand-defaults';
import { resolveBrandTokens } from '../../branding/token-resolver';
import { getReadableForeground, relativeLuminanceFromHsl } from '../../branding/color-utils';

const CSS = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8');

/** The body of a top-level block in tokens.css, brace-matched. */
function block(header: string): string {
  const start = CSS.indexOf(header);
  expect(start, `${header} is missing from tokens.css`).toBeGreaterThan(-1);
  let i = CSS.indexOf('{', start) + 1;
  let depth = 1;
  while (depth > 0) {
    const ch = CSS[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return CSS.slice(start, i);
}

/** Every `--token: value;` declared directly in a block. */
function declared(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    // First declaration wins, which is also how a nested block that redeclares
    // a token would read — the outer value is the one this block promises.
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

const CASES = [
  { theme: 'light', header: '  :root {', map: defaultLightTokenMap },
  { theme: 'dark', header: '  .dark {', map: defaultDarkTokenMap },
] as const;

describe.each(CASES)('$theme — the stylesheet and the token map agree', ({ header, map }) => {
  const css = declared(block(header));

  it('declares every token the map writes', () => {
    const absent = Object.keys(map).filter((token) => !css.has(token));
    expect(
      absent,
      'these tokens would be painted by BrandProvider and by nothing before it',
    ).toEqual([]);
  });

  it('declares them with the same value', () => {
    const drifted = Object.entries(map)
      .filter(([token, value]) => css.has(token) && css.get(token) !== value)
      .map(([token, value]) => `${token}: css=${css.get(token)} map=${value}`);
    expect(drifted, 'the page would change colour on hydration').toEqual([]);
  });
});

/*
 * THE THIRD AUTHORITY, AND WHY IT IS NOT ONE HERE.
 *
 * `BrandProvider` writes the palette inline, and inline styles beat the
 * stylesheet — so whatever it writes is what a reader sees. It used to write
 * `resolveBrandTokens(settings)`, which is the WHITE-LABEL derivation: given
 * one tenant-chosen primary it invents an accent, a ring, a wash and a
 * ten-step chart ramp by rotating that primary's hue, because a tenant who
 * picked one colour supplied nothing else to use.
 *
 * Over a palette that is fully declared, that derivation is destructive, and
 * the damage below is measured rather than argued: it replaces the site's
 * #5EDDE8 focus ring with the teal, replaces the accent (the shadcn hover
 * fill) with the teal, and replaces the chart ramp with magenta, green and
 * indigo — none of them in the brand. So the provider writes the maps.
 *
 * These tests pin that decision from both ends: the provider must not be
 * putting the derivation on screen, and the derivation must still differ from
 * the declared palette — because the day it stops differing is the day this
 * whole guard is measuring nothing.
 */
describe('the declared palette is what gets written, not the white-label derivation', () => {
  const applied = [
    { theme: 'light', map: defaultLightTokenMap, derived: resolveBrandTokens(defaultBrandConfig).light },
    { theme: 'dark', map: defaultDarkTokenMap, derived: resolveBrandTokens(defaultBrandConfig).dark },
  ] as const;

  it('BrandProvider applies the token maps themselves', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'branding', 'BrandProvider.tsx'), 'utf8');
    expect(source).toContain('{ light: defaultLightTokenMap, dark: defaultDarkTokenMap }');
    expect(
      source,
      'the white-label derivation would overwrite the declared palette on hydration',
    ).not.toContain('resolveBrandTokens(');
  });

  it.each(applied)('$theme — the derivation really would change the palette', ({ map, derived }) => {
    const declared = map as Record<string, string>;
    const differs = Object.entries(derived).filter(
      ([token, value]) => token in declared && declared[token] !== value,
    );
    expect(differs.length, 'if these agree, this guard has stopped measuring anything').toBeGreaterThan(0);
  });

  it.each(applied)('$theme — every ink the palette pairs clears 4.5:1 on its own ground', ({ map }) => {
    const pairs = [
      ['--primary', '--primary-foreground'],
      ['--accent', '--accent-foreground'],
      ['--brand', '--brand-foreground'],
      ['--sidebar-primary', '--sidebar-primary-foreground'],
    ] as const;
    /*
     * `--destructive` is NOT here, and that is a disclosure rather than a
     * narrowing. It is a Category B semantic colour — fixed by design, the
     * same red this repository has always shipped, untouched by the brand
     * work — and it measures **3.78:1** with its white ink today. That is
     * below this floor and above the 3:1 that applies to the large bold text
     * a destructive button actually sets. Re-pointing a STATE colour is a
     * decision about what "danger" looks like, not part of adopting a brand,
     * so it is left standing and written down instead of being quietly
     * excluded or quietly changed.
     */
    const declared = map as Record<string, string>;
    // A renamed token must fail here rather than quietly measuring nothing.
    for (const [ground, ink] of pairs) {
      expect(declared[ground], `${ground} is not declared`).toBeTruthy();
      expect(declared[ink], `${ink} is not declared`).toBeTruthy();
    }
    const failures = pairs
      .map(([ground, ink]) => {
        const a = relativeLuminanceFromHsl(declared[ground]);
        const b = relativeLuminanceFromHsl(declared[ink]);
        return { ground, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      })
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ ground, ratio }) => `${ground}: ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });
});

describe('getReadableForeground measures rather than guessing', () => {
  // The regression itself, in the two colours that exposed it. Both sit in the
  // band the old 0.45 threshold got wrong.
  it('gives dark ink to a mid-luminance ground', () => {
    expect(getReadableForeground('184 100% 35%')).toBe('0 0% 5%'); // the teal
    expect(getReadableForeground('41 56% 51%')).toBe('0 0% 5%'); // the gold
  });

  it('still gives light ink to a genuinely dark ground', () => {
    expect(getReadableForeground('217 69% 5%')).toBe('0 0% 100%');
    expect(getReadableForeground('220 60% 11%')).toBe('0 0% 100%');
  });

  it('answers about the ink it was handed, not about black', () => {
    // A caller passing a brand navy gets a verdict on that navy.
    expect(getReadableForeground('184 100% 35%', '217 69% 5%')).toBe('217 69% 5%');
  });
});

describe('the palette is the Aurixa brand', () => {
  // Not a restatement of every value — those are checked above. These are the
  // four that identify the brand, so a future edit that quietly returns the
  // portal to the prime's cream-and-purple scheme fails here and says why.
  it('acts in the site teal and signs in the site gold', () => {
    expect(defaultDarkTokenMap['--primary']).toBe('184 100% 35%'); // #00A8B5
    expect(defaultDarkTokenMap['--brand']).toBe('41 56% 51%'); // #C89B3C
    expect(defaultLightTokenMap['--brand']).toBe('41 56% 51%');
  });

  it('grounds dark on the site background and rings focus in its outline colour', () => {
    expect(defaultDarkTokenMap['--background']).toBe('217 69% 5%'); // #040B16
    expect(defaultDarkTokenMap['--card']).toBe('220 60% 11%'); // #0B162C
    expect(defaultDarkTokenMap['--ring']).toBe('185 75% 64%'); // #5EDDE8
  });

  it('sets the site pair of typefaces, with a fallback behind each', () => {
    const root = block('  :root {');
    expect(root).toContain('--font-sans: "Inter",');
    expect(root).toContain('--font-heading: "Playfair Display", ui-serif,');
  });
});
