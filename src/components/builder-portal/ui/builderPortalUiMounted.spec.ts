import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'tinyglobby';

/**
 * A COMPONENT IS NOT SHIPPED UNTIL SOMETHING RENDERS IT.
 *
 * The Builder portal's drawing set shipped once with `DimensionRail`,
 * `TitleBlock` and `bd-chip` at **zero call sites**: written, documented,
 * reviewed, merged and deployed without anything ever rendering them. 19
 * pages mounted `BuilderPortalShell` and none passed an `aside`, so what
 * reached production was only the half that re-skins existing markup — and
 * every page changed just enough to look finished.
 *
 * Nothing in the gate could see it. An unused export typechecks, lints, has
 * tests of its own and builds. This is the check that can.
 *
 * It asserts reachability, not quality: a component named by a real call site
 * passes. What it makes impossible is the silent version, where a whole
 * visual language exists in the repository and not on screen.
 */

const UI_DIR = join(process.cwd(), 'src/components/builder-portal/ui');

/** Every component this directory exports, by file. */
function exportedComponents(): { file: string; names: string[] }[] {
  return readdirSync(UI_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((file) => {
      const source = readFileSync(join(UI_DIR, file), 'utf8');
      const names = [...source.matchAll(/export function ([A-Z]\w+)/g)].map((m) => m[1]);
      return { file, names };
    })
    .filter((entry) => entry.names.length > 0);
}

/** Every source file in `src/` that is not the component's own file or a test. */
const SOURCES = globSync(['src/**/*.ts', 'src/**/*.tsx'], { cwd: process.cwd() })
  .filter((p) => !p.includes('/ui/') || !p.includes('builder-portal'))
  .filter((p) => !/\.(test|spec)\.tsx?$/.test(p));

const SOURCE_TEXT = SOURCES.map((p) => readFileSync(join(process.cwd(), p), 'utf8')).join('\n');

describe('builder portal ui — every component is mounted somewhere', () => {
  const components = exportedComponents();

  it('finds components to check', () => {
    // A guard on the guard: if the glob or the directory moves, this test must
    // fail loudly rather than pass by checking nothing.
    expect(components.length).toBeGreaterThan(0);
  });

  it.each(exportedComponents().flatMap((e) => e.names.map((n) => [e.file, n] as const)))(
    '%s exports %s — and something renders it',
    (_file, name) => {
      // `<Name` catches a JSX mount; `Name(` catches a direct call. Either is
      // a real use. An import alone would NOT be enough, but in practice an
      // import that is never used fails lint, so a matched import is a
      // rendered component.
      //
      // This directory is deliberately EXCLUDED from the sources searched, so
      // one unmounted component cannot vouch for another. A genuinely private
      // sub-component should simply not be exported — a local `function` is
      // the right shape for it, and drops out of this check by itself.
      const mounted =
        SOURCE_TEXT.includes(`<${name}`)
        || SOURCE_TEXT.includes(`${name}(`);

      expect(
        mounted,
        `${name} is exported from src/components/builder-portal/ui but nothing `
        + `in src/ renders it. See docs/builder-portal/VISUAL_SYSTEM.md §1 — the `
        + `drawing set shipped once with three components at zero call sites.`,
      ).toBe(true);
    },
  );
});

describe('builder portal ui — the shell’s drawing slot is used', () => {
  it('at least one page passes an `aside`', () => {
    // The `aside` is where a page puts the thing worth looking at. It existed
    // for a whole release with no caller, which is exactly how the portal came
    // to read as a competent dark admin panel rather than as a drawing.
    const pages = globSync(['src/pages/builder/**/*.tsx'], { cwd: process.cwd() })
      .filter((p) => !/\.(test|spec)\.tsx$/.test(p));
    const withAside = pages.filter((p) =>
      /\baside=\{/.test(readFileSync(join(process.cwd(), p), 'utf8')),
    );
    expect(withAside.length).toBeGreaterThan(0);
  });
});
