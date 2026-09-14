/**
 * NETWORK EDITION — the Builders Network brand provider.
 *
 * The prime's `BrandProvider` is a White-Label store: it loads a tenant's
 * settings from `whitelabel_settings` over the Supabase client, persists
 * edits, and publishes notification icons through the desktop messaging bus.
 * Every one of those edges is a per-clone credential path
 * (`integrations/supabase/client`, `useAuth`, `desktopMessageAlerts`), and the
 * network frontend holds NO Supabase credential at all — every backend call
 * travels through the same-origin `/fn/*` proxy (extraction plan §5).
 *
 * The network is also not white-labelled: builders.aurixasystems.com.au is one
 * product with one identity, not a clone wearing a tenant's brand. So this
 * edition keeps the CONTRACT (`BrandContextValue`, so ~140 ported modules
 * compile and behave identically) and fixes the CONTENT:
 *
 *   - `settings` is a constant — the Aurixa Builders Network identity.
 *   - `updateSettings` refuses, honestly: `{ ok: false, reason: 'error' }`
 *     with a message saying the network brand is fixed. Nothing in the ported
 *     builder tree calls it, but the surface must keep its meaning for
 *     anything that does.
 *   - `isLoading` is always false — nothing loads, so no consumer ever waits.
 *   - The THEME machinery is the prime's, kept in full: the guarded
 *     localStorage read/write (Safari private mode makes the property access
 *     itself throw, and this is read from a `useState` initialiser),
 *     the `prefers-color-scheme` listener while in `system` mode, the
 *     `documentElement` dark-class toggle, and the resolved token map applied
 *     through the same `applyBrandTokenMap` the prime uses. A builder's theme
 *     preference is real even where the brand is not editable.
 *
 * `resolvedTokens` is the declared palette itself — the two token maps in
 * `brand-defaults.ts`, which are the Aurixa brand transcribed from the
 * marketing site's own `@theme` block and are exactly what `tokens.css`
 * paints. It used to run the white-label RESOLVER over these fixed settings,
 * on the belief that null colour fields resolve to the platform defaults; that
 * held for the primary and for nothing else (see the note on `resolvedTokens`
 * below). `useTokens()` returns real values either way.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type {
  BrandContextValue,
  BrandSaveResult,
  BrandTokenMap,
  ThemeMode,
  WhiteLabelSettings,
} from './brand-types';
import {
  BRAND_THEME_STORAGE_KEY,
  defaultBrandConfig,
  defaultDarkTokenMap,
  defaultLightTokenMap,
} from './brand-defaults';
import { applyBrandTokenMap, resolveBrandFontVars } from './token-resolver';

/**
 * The Aurixa mark — the delta symbol, standing alone with its background
 * transparent.
 *
 * It is byte-identical to `aurixa-systems/public/brand/aurixa-symbol-192.webp`,
 * the same file the marketing site draws, because a builder crossing from
 * aurixasystems.com.au to this portal should meet one company rather than two
 * renderings of one.
 *
 * NOT `public/brand/aurixa-mark.svg`, which is already here and looks like the
 * obvious choice: that one is the app-icon build, a full-bleed navy field with
 * the delta on it, and on a navy panel it reads as a tile stuck to the page
 * rather than as the mark. NOT the lockup either — `BrandLockup` draws the
 * company name beside whatever it is given, and the lockup already contains the
 * AURIXA SYSTEMS wordmark, so the two together say the name twice.
 *
 * 192px against a 56px maximum draw: the mark stays sharp on a retina screen
 * and the file is 19 KB.
 */
const AURIXA_SYMBOL = '/brand/aurixa-symbol-192.webp';

/**
 * The one brand this deployment renders. Derived from the platform defaults
 * rather than restated, so a new `BrandConfig` field cannot silently go
 * missing here.
 *
 * THE LOGO SLOTS ARE FILLED HERE, and they were empty. `BrandLogo` resolves a
 * slot through `getBrandAssetSrc` and renders a `Building2` glyph in a tinted
 * square when it resolves to nothing — a sensible fallback for a white-label
 * tenant who has uploaded no mark, and simply wrong for a deployment whose
 * brand is fixed and whose mark has been sitting in `public/brand/` all along.
 * That placeholder was what the sign-in page and all three sidebar surfaces
 * drew. Filling the three slots is the whole fix: every one of those five
 * render sites already asks for `auth`, `sidebar` or `sidebar-icon`, so none
 * of them changes.
 *
 * `favicon` stays null deliberately. Nothing in this edition writes the tab
 * icon — `faviconFor` and `PLATFORM_FAVICON` have no callers here — so the
 * `<link>` in `index.html` is the only authority on it, and setting a slot
 * that `getBrandAssetSrc` would fall back through is how a tab comes to
 * flicker from one mark to another on every load.
 *
 * `darkModeDefault` is `dark`, which is a change from `system`:
 * aurixasystems.com.au is dark and only dark — `color-scheme: dark` on its
 * `:root`, no light block anywhere — so a builder arriving from the marketing
 * site on a machine set to light used to cross into a white application and
 * read it as a different product. Their own choice still wins and is still
 * remembered; this moves the default, not the control, and the light palette
 * is the same brand rather than a leftover.
 */
const NETWORK_BRAND: WhiteLabelSettings = {
  ...defaultBrandConfig,
  companyName: 'Aurixa Builders Network',
  authLogo: AURIXA_SYMBOL,
  sidebarLogo: AURIXA_SYMBOL,
  sidebarIcon: AURIXA_SYMBOL,
  darkModeDefault: 'dark',
};

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * `localStorage` is not always readable: Safari's private mode, "block all
 * cookies", enterprise policy and some extensions make the *property access*
 * itself throw. This one is read from a `useState` initialiser (i.e. during
 * render), so an unguarded throw here would take down the entire application —
 * including the sign-in page. A remembered theme is a preference; losing it is
 * not worth a blank page. (Carried verbatim from the prime, which paid for it.)
 */
function readStoredTheme(): ThemeMode | null {
  try {
    return localStorage.getItem(BRAND_THEME_STORAGE_KEY) as ThemeMode | null;
  } catch {
    return null;
  }
}

function writeStoredTheme(themeMode: ThemeMode): void {
  try {
    localStorage.setItem(BRAND_THEME_STORAGE_KEY, themeMode);
  } catch { /* preference not persisted — not fatal */ }
}

function getInitialThemeMode(defaultTheme: ThemeMode): ThemeMode {
  if (typeof window === 'undefined') return defaultTheme;
  return readStoredTheme() || defaultTheme;
}

function applyResolvedTheme(
  themeMode: ThemeMode,
  resolvedTokens: { light: BrandTokenMap; dark: BrandTokenMap }
) {
  const resolvedTheme = themeMode === 'system' ? getSystemTheme() : themeMode;
  document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  applyBrandTokenMap(resolvedTheme === 'dark' ? resolvedTokens.dark : resolvedTokens.light);
  return resolvedTheme;
}

const BrandContext = createContext<BrandContextValue | undefined>(undefined);

export function BrandProvider({ children }: { children: React.ReactNode }) {
  const settings = NETWORK_BRAND;
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    getInitialThemeMode(NETWORK_BRAND.darkModeDefault)
  );
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(() =>
    themeMode === 'system' ? getSystemTheme() : themeMode
  );

  /*
   * THE NETWORK'S PALETTE IS DECLARED, NOT DERIVED.
   *
   * `resolveBrandTokens` exists for a white-label tenant who picks ONE colour:
   * it takes that primary and derives an accent, a ring, a brand wash and a
   * ten-step chart ramp by rotating its hue, because the tenant supplied
   * nothing else to use. This deployment is the opposite case — the brand is
   * fixed (`NETWORK_BRAND`) and the palette is specified token by token, from
   * aurixasystems.com.au's own `@theme` block, in `brand-defaults.ts`.
   *
   * Running the derivation over it does real damage, and the damage is
   * measured rather than assumed: in dark it replaced the focus ring with the
   * primary (losing the site's #5EDDE8 outline colour), replaced the accent
   * with the primary (turning every menu hover into a saturated teal fill),
   * and replaced the chart ramp with hue rotations of the teal — magenta,
   * green, indigo — none of which is in the brand. It also wrote its own
   * near-black over the ink the token maps declare. The file's own header used
   * to claim these tokens "resolve to the platform defaults, which is exactly
   * what index.css declares"; that was true of nothing but the primary.
   *
   * So the maps ARE the resolution here. `tokens.css` paints them, this writes
   * the same values inline, and `brandPaletteParity.spec.ts` fails if the two
   * stop agreeing. The resolver is untouched — a clone that does let somebody
   * choose a colour still needs it.
   */
  const resolvedTokens = useMemo(
    () => ({ light: defaultLightTokenMap, dark: defaultDarkTokenMap }),
    [],
  );
  const resolvedFontVars = useMemo(() => resolveBrandFontVars(settings), [settings]);

  // Font variables are theme-independent and cascade to every text component.
  useEffect(() => {
    applyBrandTokenMap(resolvedFontVars);
  }, [resolvedFontVars]);

  useEffect(() => {
    const applyTheme = (nextTheme: ThemeMode) => {
      const resolvedTheme = applyResolvedTheme(nextTheme, resolvedTokens);
      setCurrentTheme(resolvedTheme);
    };

    applyTheme(themeMode);
    writeStoredTheme(themeMode);

    if (themeMode !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [resolvedTokens, themeMode]);

  /**
   * The network brand is fixed. Refusing here (rather than resolving `ok`)
   * keeps the contract's meaning: a caller that believed it saved something
   * would be wrong, and `BrandSaveResult` exists precisely because a write
   * that silently changed nothing is the failure shape the prime shipped.
   */
  const updateSettings = useCallback(
    (_newSettings: Partial<WhiteLabelSettings>): Promise<BrandSaveResult> =>
      Promise.resolve({
        ok: false,
        reason: 'error',
        message:
          'The Builders Network brand is fixed. There is no per-tenant White-Label store on this deployment.',
      }),
    []
  );

  const value = useMemo<BrandContextValue>(
    () => ({
      settings,
      updateSettings,
      isLoading: false,
      currentTheme,
      themeMode,
      theme: themeMode,
      isDark: currentTheme === 'dark',
      setThemeMode,
      setTheme: setThemeMode,
      resolvedTokens,
    }),
    [currentTheme, resolvedTokens, settings, themeMode, updateSettings]
  );

  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export function useBrand() {
  const context = useContext(BrandContext);
  if (!context) {
    throw new Error('useBrand must be used within a BrandProvider');
  }
  return context;
}
