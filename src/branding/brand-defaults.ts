import type { BrandConfig, BrandLogoConfig, BrandThemeConfig, BrandTokenMap, EmailSignatureSettings } from './brand-types';

export const BRAND_THEME_STORAGE_KEY = 'theme';

/*
 * THE AURIXA PALETTE, in the units this system stores.
 *
 * Every value below is a conversion of a token declared in
 * `aurixa-systems/src/index.css`'s Tailwind `@theme` block — the marketing
 * site's own source of brand — so the portal and the site are one identity
 * rather than two that resemble each other:
 *
 *   --color-prism-cyan     #00A8B5  ->  184 100% 35%   the action colour
 *   --color-prism-magenta  #C89B3C  ->  41 56% 51%     the brand accent (its
 *                                                      name is legacy; the
 *                                                      VALUE is gold)
 *   --color-base-950       #040B16  ->  217 69% 5%     the page ground
 *   --color-base-900       #0B162C  ->  220 60% 11%    panels and cards
 *   --color-prism-violet   #0A192F  ->  216 65% 11%    the deeper panel
 *   --color-text-secondary #9CA3AF  ->  218 11% 65%    muted ink
 *   --color-chrome-900     #111827  ->  221 39% 11%    ink, in light
 *   --color-chrome-300     #D1D5DB  ->  216 12% 84%    hairlines, in light
 *   (its focus outline)    #5EDDE8  ->  185 75% 64%    the focus ring
 *   (its scrollbar thumb)  #1C2B41  ->  216 40% 18%    hairlines, in dark
 *
 * The site has no light mode — it is `color-scheme: dark` and says so. Light
 * here is therefore a light RENDERING of the same brand (chrome ground, navy
 * ink, the same teal and gold), never the cream-and-purple palette this
 * repository inherited from the prime, which belongs to a different product.
 */

/** The action colour. Darker in light mode: #00A8B5 under white text is
 *  2.9:1, and the same hue at 25% lightness is 5.3:1. */
export const DEFAULT_PRIMARY = '184 100% 35%';
export const LIGHT_DEFAULT_PRIMARY = '184 100% 25%';
/** `--accent` is the shadcn HOVER FILL (`hover:bg-accent`), not a brand
 *  colour — which is why it is a surface in both themes. The site uses its
 *  gold as ink and edging and never as a fill under text; painting a menu
 *  row with it is how a hover state comes to read as a selection. */
export const LIGHT_DEFAULT_ACCENT = '216 16% 93%';
export const DEFAULT_ACCENT = '216 45% 16%';
/** Category A — the brand accent, and in Aurixa's identity that is the gold.
 *  Components reach for this instead of hardcoding an amber utility. */
export const DEFAULT_BRAND = '41 56% 51%';
export const DEFAULT_WARNING = '43 74% 49%';
export const DEFAULT_SUCCESS = '142 71% 45%';
export const DEFAULT_DESTRUCTIVE = '0 84% 60%';

export const defaultEmailSignature: EmailSignatureSettings = {
  banner: null,
  name: '',
  title: '',
  phone: '',
  email: '',
  website: '',
  address: '',
  disclaimer:
    'This email and any attachments are confidential and may be privileged. If you are not the intended recipient, please notify the sender immediately and delete this message.',
};

export const defaultBrandThemeConfig: BrandThemeConfig = {
  primaryColor: null,
  accentColor: null,
  brandColor: null,
  fontFamily: 'aurixa-sans',
  headingFontFamily: 'aurixa-display',
  fontScale: null,
  // The site is dark — `color-scheme: dark`, no light mode at all — so the
  // network opens the way the brand looks. A builder who prefers light still
  // gets one, in the same palette; this moves the default, not the control.
  darkModeDefault: 'dark',
  emailSignature: defaultEmailSignature,
};

export const defaultBrandLogoConfig: BrandLogoConfig = {
  auth: null,
  sidebar: null,
  sidebarIcon: null,
  favicon: null,
  report: null,
  reportMono: null,
};

export const defaultBrandConfig: BrandConfig = {
  authLogo: null,
  sidebarLogo: null,
  sidebarIcon: null,
  favicon: null,
  reportLogo: null,
  reportMonoLogo: null,
  companyName: 'Dashboard',
  primaryColor: null,
  accentColor: null,
  brandColor: null,
  fontFamily: 'aurixa-sans',
  headingFontFamily: 'aurixa-display',
  fontScale: null,
  darkModeDefault: 'dark',
  emailSignature: defaultEmailSignature,
  themeConfig: defaultBrandThemeConfig,
  logoConfig: defaultBrandLogoConfig,
  themeVersion: 1,
};

export const defaultLightTokenMap: BrandTokenMap = {
  '--background': '220 14% 96%',
  '--foreground': '221 39% 11%',
  '--card': '0 0% 100%',
  '--card-foreground': '221 39% 11%',
  '--popover': '0 0% 100%',
  '--popover-foreground': '221 39% 11%',
  '--primary': LIGHT_DEFAULT_PRIMARY,
  '--primary-foreground': '0 0% 100%',
  '--primary-hover': '184 100% 20%',
  '--secondary': '216 16% 93%',
  '--secondary-foreground': '221 39% 11%',
  '--secondary-hover': '216 16% 88%',
  '--muted': '216 16% 94%',
  '--muted-foreground': '220 9% 46%',
  '--accent': LIGHT_DEFAULT_ACCENT,
  '--accent-foreground': '221 39% 11%',
  '--brand': DEFAULT_BRAND,
  '--brand-foreground': '221 39% 11%',
  '--brand-light': '41 56% 93%',
  '--success': DEFAULT_SUCCESS,
  '--success-foreground': '0 0% 100%',
  '--success-light': '142 69% 95%',
  '--warning': DEFAULT_WARNING,
  '--warning-foreground': '0 0% 100%',
  '--warning-light': '43 74% 95%',
  '--destructive': DEFAULT_DESTRUCTIVE,
  '--destructive-foreground': '0 0% 100%',
  '--destructive-light': '0 93% 97%',
  '--info': '200 98% 39%',
  '--info-foreground': '0 0% 100%',
  '--info-light': '200 100% 96%',
  '--chart-1': LIGHT_DEFAULT_PRIMARY,
  '--chart-2': DEFAULT_BRAND,
  '--chart-3': '142 71% 45%',
  '--chart-4': '0 84% 60%',
  '--chart-5': '185 75% 44%',
  '--chart-6': '25 86% 55%',
  '--chart-7': '216 65% 35%',
  '--chart-8': '330 58% 48%',
  '--chart-9': '42 86% 52%',
  '--chart-10': '88 44% 43%',
  '--border': '216 12% 84%',
  '--input': '216 12% 84%',
  '--ring': LIGHT_DEFAULT_PRIMARY,
  '--sidebar-background': '220 20% 97%',
  '--sidebar-foreground': '221 30% 20%',
  '--sidebar-primary': LIGHT_DEFAULT_PRIMARY,
  '--sidebar-primary-foreground': '0 0% 100%',
  '--sidebar-accent': LIGHT_DEFAULT_ACCENT,
  '--sidebar-accent-foreground': '221 39% 11%',
  '--sidebar-border': '216 12% 86%',
  '--sidebar-ring': LIGHT_DEFAULT_PRIMARY,
  '--dashboard-surface': '0 0% 100%',
  '--dashboard-surface-elevated': '220 20% 98%',
  '--dashboard-surface-muted': '216 16% 94%',
  '--dashboard-border-soft': '216 12% 84%',
  '--dashboard-border-strong': '216 14% 74%',
  '--dashboard-primary-soft': '184 45% 92%',
  '--dashboard-primary-strong': LIGHT_DEFAULT_PRIMARY,
  '--surface-1': '0 0% 100%',
  '--surface-2': '220 20% 98%',
  '--surface-3': '216 16% 94%',
  '--surface-elevated': '0 0% 100%',
  '--surface-muted': '216 16% 94%',
  '--border-soft': '216 12% 84%',
  '--border-strong': '216 14% 74%',
  '--topbar-background': '0 0% 100%',
  '--sidebar-surface': '220 20% 97%',
  '--mobile-nav-background': '0 0% 100%',
};

export const defaultDarkTokenMap: BrandTokenMap = {
  '--background': '217 69% 5%',
  '--foreground': '0 0% 100%',
  '--card': '220 60% 11%',
  '--card-foreground': '0 0% 100%',
  '--popover': '220 60% 11%',
  '--popover-foreground': '0 0% 100%',
  '--primary': DEFAULT_PRIMARY,
  '--primary-foreground': '217 69% 5%',
  '--primary-hover': '184 100% 29%',
  '--secondary': '216 45% 16%',
  '--secondary-foreground': '0 0% 100%',
  '--secondary-hover': '216 45% 21%',
  '--muted': '216 42% 14%',
  '--muted-foreground': '218 11% 65%',
  '--accent': DEFAULT_ACCENT,
  '--accent-foreground': '0 0% 100%',
  '--brand': DEFAULT_BRAND,
  '--brand-foreground': '217 69% 5%',
  '--brand-light': '41 45% 15%',
  '--success': DEFAULT_SUCCESS,
  '--success-foreground': '0 0% 100%',
  '--success-light': '142 69% 12%',
  '--warning': DEFAULT_WARNING,
  '--warning-foreground': '217 69% 5%',
  '--warning-light': '43 74% 12%',
  '--destructive': DEFAULT_DESTRUCTIVE,
  '--destructive-foreground': '0 0% 100%',
  '--destructive-light': '0 93% 12%',
  '--info': '200 98% 59%',
  '--info-foreground': '217 69% 5%',
  '--info-light': '200 80% 14%',
  '--chart-1': DEFAULT_PRIMARY,
  '--chart-2': DEFAULT_BRAND,
  '--chart-3': '185 75% 64%',
  '--chart-4': '42 86% 72%',
  '--chart-5': '142 71% 55%',
  '--chart-6': '0 84% 68%',
  '--chart-7': '216 45% 55%',
  '--chart-8': '330 70% 62%',
  '--chart-9': '25 95% 60%',
  '--chart-10': '88 50% 56%',
  '--border': '216 40% 18%',
  '--input': '216 40% 18%',
  '--ring': '185 75% 64%',
  '--sidebar-background': '216 65% 8%',
  '--sidebar-foreground': '218 14% 82%',
  '--sidebar-primary': DEFAULT_PRIMARY,
  '--sidebar-primary-foreground': '217 69% 5%',
  '--sidebar-accent': DEFAULT_ACCENT,
  '--sidebar-accent-foreground': '0 0% 100%',
  '--sidebar-border': '216 40% 15%',
  '--sidebar-ring': '185 75% 64%',
  '--dashboard-surface': '220 60% 11%',
  '--dashboard-surface-elevated': '216 50% 14%',
  '--dashboard-surface-muted': '216 42% 14%',
  '--dashboard-border-soft': '216 40% 18%',
  '--dashboard-border-strong': '216 40% 26%',
  '--dashboard-primary-soft': '186 55% 13%',
  '--dashboard-primary-strong': DEFAULT_PRIMARY,
  '--surface-1': '220 60% 11%',
  '--surface-2': '216 50% 14%',
  '--surface-3': '216 42% 17%',
  '--surface-elevated': '216 50% 14%',
  '--surface-muted': '216 42% 14%',
  '--border-soft': '216 40% 18%',
  '--border-strong': '216 40% 26%',
  '--topbar-background': '220 60% 11%',
  '--sidebar-surface': '216 65% 8%',
  '--mobile-nav-background': '220 60% 11%',
};
