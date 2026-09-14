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
 * `resolvedTokens` comes from the real resolver over the fixed settings — all
 * colour fields are null, so it resolves to the platform defaults, which is
 * exactly what `index.css` declares. `useTokens()` therefore returns real
 * values, not empty maps.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { BrandContextValue, BrandSaveResult, ThemeMode, WhiteLabelSettings } from './brand-types';
import { BRAND_THEME_STORAGE_KEY, defaultBrandConfig } from './brand-defaults';
import { applyBrandTokenMap, resolveBrandFontVars, resolveBrandTokens } from './token-resolver';

/**
 * The one brand this deployment renders. Derived from the platform defaults
 * rather than restated, so a new `BrandConfig` field cannot silently go
 * missing here; `darkModeDefault` is `system` because the network respects
 * the reader's machine until they choose.
 */
const NETWORK_BRAND: WhiteLabelSettings = {
  ...defaultBrandConfig,
  companyName: 'Aurixa Builders Network',
  darkModeDefault: 'system',
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
  resolvedTokens: ReturnType<typeof resolveBrandTokens>
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

  // The settings never change, so both resolutions are once-per-mount.
  const resolvedTokens = useMemo(() => resolveBrandTokens(settings), [settings]);
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
