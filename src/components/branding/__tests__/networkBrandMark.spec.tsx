/**
 * THE PORTAL DRAWS THE AURIXA MARK, NOT A PLACEHOLDER.
 *
 * `BrandLogo` resolves a slot through `getBrandAssetSrc` and, when it resolves
 * to nothing, renders a `Building2` glyph in a tinted square. That fallback is
 * right for the prime, where a white-label tenant may genuinely have uploaded
 * no logo — and wrong here, where the brand is fixed and its mark ships in
 * `public/brand/`. The slots were empty, so the sign-in page and all three
 * sidebar surfaces drew the placeholder.
 *
 * Nothing in a typecheck, a lint or a build can see that: an unfilled optional
 * field is valid and the fallback renders happily. It is the same shape as the
 * defect `builderPortalUiMounted.spec.ts` exists for — something written,
 * shipped and never actually put on screen — so it is guarded the same way.
 *
 * The file check is not ceremony. A brand asset path that 404s draws a broken
 * image, which is worse than the placeholder it replaced, and only the
 * filesystem can answer whether the path is real.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLockup, BrandLogo } from '../BrandAssets';
import { BrandProvider } from '../../../branding/BrandProvider';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBrandAssetSrc, type BrandAssetSlot } from '../../../branding/brand-assets';
import type { WhiteLabelSettings } from '../../../branding/brand-types';

const ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * `NETWORK_BRAND` is module-private, so its values are read from the source
 * that declares them rather than from a copy this test would have to keep in
 * step — a copy is how a guard comes to pass against settings nobody ships.
 */
const PROVIDER = readFileSync(join(ROOT, 'src/branding/BrandProvider.tsx'), 'utf8');

/**
 * Parsed WITHOUT asserting, and asserted inside the tests below.
 *
 * An `expect()` at module scope throws during collection, and a file that
 * fails to collect reports as "no tests" — which names nothing, and which a
 * runner or a reader can mistake for a pass. The first version of this guard
 * did exactly that when the slots were emptied to check it could fail at all.
 */
function declaredMark(field: 'authLogo' | 'sidebarLogo' | 'sidebarIcon'): string | null {
  const symbol = PROVIDER.match(/const AURIXA_SYMBOL = '([^']+)';/);
  const assignment = new RegExp(`${field}:\\s*(AURIXA_SYMBOL|'[^']+')`).exec(PROVIDER);
  if (!assignment) return null;
  if (assignment[1] !== 'AURIXA_SYMBOL') return assignment[1].slice(1, -1);
  return symbol ? symbol[1] : null;
}

const SLOT_FIELDS = ['authLogo', 'sidebarLogo', 'sidebarIcon'] as const;
const MARK = declaredMark('authLogo') ?? '(NETWORK_BRAND declares no mark)';

const settings = {
  authLogo: declaredMark('authLogo'),
  sidebarLogo: declaredMark('sidebarLogo'),
  sidebarIcon: declaredMark('sidebarIcon'),
  favicon: null,
  reportLogo: null,
  reportMonoLogo: null,
} as unknown as WhiteLabelSettings;

describe('every surface that draws the brand resolves a real mark', () => {
  /*
   * The portal draws the brand in five places and they ask for exactly these
   * three slots: `BuilderAuthShell`'s branded panel and its below-lg block use
   * `auth`; the sidebar header uses `sidebar`; the mobile top bar and the
   * mobile drawer use `sidebar-icon`. A slot missing from this list is a
   * surface back on the placeholder.
   */
  const SLOTS: BrandAssetSlot[] = ['auth', 'sidebar', 'sidebar-icon'];

  it.each(SLOT_FIELDS)('NETWORK_BRAND declares a mark for %s', (field) => {
    expect(
      declaredMark(field),
      `NETWORK_BRAND leaves ${field} empty, so that surface draws the Building2 placeholder`,
    ).toBeTruthy();
  });

  it.each(SLOTS)('%s resolves to the Aurixa mark', (slot) => {
    expect(getBrandAssetSrc(settings, slot)).toBe(MARK);
  });

  it('the mark is a file this deployment actually serves', () => {
    // `public/` is served at the site root, so a leading-slash path names a
    // file under it.
    expect(MARK.startsWith('/')).toBe(true);
    expect(existsSync(join(ROOT, 'public', MARK.slice(1))), `${MARK} is not in public/`).toBe(true);
  });

  it('it is the mark the marketing site draws, byte for byte', () => {
    // One company, one mark. If the two diverge, a builder crossing from
    // aurixasystems.com.au meets a second rendering of the same brand, which
    // is the thing this whole pass was about. Skipped where the sibling
    // checkout is absent — this runs in CI from one repository.
    const site = join(ROOT, '..', 'aurixa-systems', 'public', 'brand', 'aurixa-symbol-192.webp');
    if (!existsSync(site)) return;
    const here = readFileSync(join(ROOT, 'public', MARK.slice(1)));
    expect(here.equals(readFileSync(site))).toBe(true);
  });
});

describe('the tab icon has exactly one authority', () => {
  /*
   * `getBrandAssetSrc(settings, 'favicon')` FALLS THROUGH to the sidebar icon
   * when `favicon` is null, so filling the slots did change what that call
   * would answer. It is harmless only because nothing in this edition makes
   * it: the network `BrandProvider` dropped the prime's favicon writer, so
   * `index.html`'s `<link>` is the only thing that sets the tab icon.
   *
   * If a favicon writer is ever added back, this fails — and it should, because
   * the pre-hydration `<link>` and the post-hydration write would then name
   * different files, which is a tab that flickers from one mark to another on
   * every load.
   */
  /**
   * Comments stripped before matching, which is the rule
   * `googleMapsDailyCaps.spec.ts` already established here: a claim may appear
   * in PROSE — including a comment naming the thing it forbids, as the
   * provider's own does — and may not appear in CODE.
   */
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('nothing writes the tab icon at runtime', () => {
    const provider = codeOnly(readFileSync(join(ROOT, 'src/branding/BrandProvider.tsx'), 'utf8'));
    expect(provider).not.toMatch(/rel=["']icon["']|faviconFor\s*\(|PLATFORM_FAVICON/);
  });

  it('and the brand leaves the favicon slot to it', () => {
    expect(PROVIDER).not.toMatch(/^\s*favicon:/m);
  });
});


/*
 * AND THE COMPONENTS ACTUALLY DRAW IT.
 *
 * The assertions above prove the resolver answers with the mark. They cannot
 * prove `BrandLogo` renders an <img> rather than its fallback, and that gap is
 * exactly where the defect lived: the resolution path was always correct, and
 * it resolved to nothing.
 *
 * The sign-in page was verified by rendering it into Chromium and reading the
 * DOM — two <img>, both the mark, zero `Building2` glyphs. The sidebar cannot
 * be reached that way without a builder session, so its three surfaces are
 * rendered here instead, through the real `BrandProvider` rather than a stub,
 * which is what makes this a test of what ships.
 */
describe('the sidebar surfaces render the mark rather than the fallback', () => {
  const inBrand = (ui: React.ReactElement) => render(<BrandProvider>{ui}</BrandProvider>);

  it('the sidebar header lockup draws an image', () => {
    inBrand(<BrandLockup slot="sidebar" meta="Builder / Developer Portal" />);
    const img = screen.getByRole('img', { name: 'Aurixa Builders Network' });
    expect(img.getAttribute('src')).toBe(MARK);
    expect(screen.getByText('Aurixa Builders Network')).toBeTruthy();
  });

  it('the mobile top bar draws an image', () => {
    inBrand(<BrandLogo slot="sidebar-icon" />);
    expect(screen.getByRole('img').getAttribute('src')).toBe(MARK);
  });

  it('the mobile drawer lockup draws an image', () => {
    inBrand(<BrandLockup slot="sidebar-icon" meta="Builder / Developer Portal" />);
    expect(screen.getByRole('img', { name: 'Aurixa Builders Network' }).getAttribute('src')).toBe(MARK);
  });
});
