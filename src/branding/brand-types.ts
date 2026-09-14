import type { Dispatch, SetStateAction } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface EmailSignatureSettings {
  banner: string | null;
  name: string;
  title: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  disclaimer: string;
}

export interface BrandThemeConfig {
  primaryColor: string | null;
  accentColor: string | null;
  /** Category A brand accent (the "gold"). HSL token string. Cascades to --brand. */
  brandColor: string | null;
  /** Font allow-list key for body text (see brand-fonts.ts). */
  fontFamily: string | null;
  /** Font allow-list key for headings; null → inherits the body font. */
  headingFontFamily: string | null;
  /** Font scale key (compact | default | comfortable). */
  fontScale: string | null;
  darkModeDefault: ThemeMode;
  emailSignature: EmailSignatureSettings;
}

export interface BrandLogoConfig {
  auth: string | null;
  sidebar: string | null;
  sidebarIcon: string | null;
  favicon: string | null;
  /**
   * The mark generated reports carry, on paper grounds.
   *
   * Separate from `sidebar` because the constraints are different: a report
   * mark is inlined as a `data:` URI into the render, is printed at ~13mm on
   * a 300dpi sheet, and must be a raster format the WeasyPrint container will
   * accept. See `reportDesign/assets.pure.ts`.
   */
  report: string | null;
  /**
   * The knockout mark for the dark cover and closing grounds. Falls back to
   * `report`; a colour lockup on obsidian usually survives, a white one on
   * ivory never does.
   */
  reportMono: string | null;
}

export interface BrandConfig {
  id?: string;
  authLogo: string | null;
  sidebarLogo: string | null;
  sidebarIcon: string | null;
  favicon: string | null;
  /** The report mark. See `BrandLogoConfig.report`. */
  reportLogo: string | null;
  /** The knockout report mark. See `BrandLogoConfig.reportMono`. */
  reportMonoLogo: string | null;
  companyName: string;
  primaryColor: string | null;
  accentColor: string | null;
  brandColor: string | null;
  fontFamily: string | null;
  headingFontFamily: string | null;
  fontScale: string | null;
  darkModeDefault: ThemeMode;
  emailSignature: EmailSignatureSettings;
  themeConfig?: BrandThemeConfig;
  logoConfig?: BrandLogoConfig;
  themeVersion?: number;
}

export type WhiteLabelSettings = BrandConfig;

export type BrandTokenName = `--${string}`;

export type BrandTokenMap = Record<BrandTokenName, string>;

export interface ResolvedBrandTokens {
  light: BrandTokenMap;
  dark: BrandTokenMap;
}

/**
 * Outcome of persisting branding. A write is NOT reported as saved unless the
 * database confirms the row changed: `whitelabel_settings` is readable by
 * everyone but writable only by `authenticated`, so an unauthenticated client
 * gets a 200 with zero rows and no error — indistinguishable from success
 * unless it is checked for explicitly.
 */
export type BrandSaveFailureReason = 'unauthenticated' | 'not-persisted' | 'error';

/**
 * Declared as one shape rather than a discriminated union: this project
 * compiles with `strictNullChecks: false`, under which narrowing a union on a
 * boolean literal does not work, and callers would be unable to read `message`.
 */
export interface BrandSaveResult {
  ok: boolean;
  /**
   * `unauthenticated` — no RLS token, so the write would silently no-op.
   * `not-persisted`   — the write ran but changed no row (RLS denied it).
   * `error`           — the database or transport rejected it outright.
   */
  reason?: BrandSaveFailureReason;
  message?: string;
}

export interface BrandContextValue {
  settings: WhiteLabelSettings;
  updateSettings: (newSettings: Partial<WhiteLabelSettings>) => Promise<BrandSaveResult>;
  isLoading: boolean;
  currentTheme: 'light' | 'dark';
  themeMode: ThemeMode;
  theme: ThemeMode;
  isDark: boolean;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  setTheme: Dispatch<SetStateAction<ThemeMode>>;
  resolvedTokens: ResolvedBrandTokens;
}