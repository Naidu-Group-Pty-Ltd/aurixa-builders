import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'tinyglobby';

/**
 * A CLASS IS NOT SHIPPED UNTIL SOMETHING WEARS IT.
 *
 * `builderPortalUiMounted.spec.ts` exists because the Builder portal's
 * drawing set shipped once with three COMPONENTS at zero call sites. This is
 * the same rule one level down, and it was written because the same thing
 * happened again in the stylesheet: the plate sheet landed with **seventeen**
 * `.bd-*` rules nothing rendered — a recessive board, a four-cell masthead,
 * and a whole second implementation of the picture treatment
 * (`.bd-plate-img`, `-ground`, `-scrim`, `-empty*`) that `StockPicture` draws
 * with utilities instead. Every one was designed, commented and reviewed.
 *
 * Nothing else in the gate can see it. Dead CSS compiles, lints, passes
 * `audit:style` and ships — it is bytes in every builder's bundle describing
 * a page that does not exist, and a reader of the stylesheet cannot tell it
 * from the half that is live.
 *
 * It asserts REACHABILITY, not quality. A class named anywhere in `src/`
 * passes, including a class another rule composes onto. What it makes
 * impossible is the silent version, where a visual language exists in the
 * repository and not on screen.
 */

const SHEET = 'src/styles/builder-drafting.css';

/**
 * Every `.bd-…` class the sheet DECLARES.
 *
 * Declared, not merely mentioned: a class inside a selector is what the rule
 * applies to, so `.bd-plate .builder-stock-list-property` declares
 * `bd-plate`, and `[data-picture="empty"]` is an attribute rather than a
 * class and is not one. Only the `bd-` prefix is judged — the sheet also
 * re-skins shadcn markup by ITS classes (`builder-stock-list-*`,
 * `luxury-*`), which are somebody else's names and not this file's to own.
 */
function declaredClasses(css: string): string[] {
  // Strip comments first: this file's own prose names classes it is
  // explaining, including the ones it records as deleted.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set<string>();
  for (const [, name] of code.matchAll(/\.(bd-[a-z0-9-]+)/g)) found.add(name);
  return [...found].sort();
}

const SOURCES = globSync(['src/**/*.ts', 'src/**/*.tsx'], { cwd: process.cwd() })
  .filter((p) => !/\.(test|spec)\.tsx?$/.test(p));

const SOURCE_TEXT = SOURCES.map((p) => readFileSync(join(process.cwd(), p), 'utf8')).join('\n');

describe('builder drafting sheet — every class it declares is worn somewhere', () => {
  const declared = declaredClasses(readFileSync(join(process.cwd(), SHEET), 'utf8'));

  it('finds classes to check', () => {
    // A guard on the guard: if the sheet moves or the pattern stops
    // matching, this must fail loudly rather than pass by checking nothing.
    expect(declared.length).toBeGreaterThan(20);
  });

  it('names no class that nothing in src/ applies', () => {
    const orphans = declared.filter((name) => !SOURCE_TEXT.includes(name));
    // Reported as a list rather than one-at-a-time, because the failure
    // this catches arrives in groups — a whole device gets written at once.
    expect(orphans).toEqual([]);
  });
});
