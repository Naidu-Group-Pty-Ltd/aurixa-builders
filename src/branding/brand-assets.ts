import type { BrandConfig } from './brand-types';

export type BrandAssetSlot =
  | 'auth'
  | 'sidebar'
  | 'sidebar-icon'
  | 'favicon'
  | 'report'
  | 'report-mono';

/**
 * The report slots resolve the same way here as in the render layer.
 *
 * `reportDesign/assets.pure.ts` owns the authoritative chain, because that is
 * the copy the Edge Function uses and it additionally enforces the inline
 * policy (format, size). This function is the in-app preview of the same
 * decision, and `brandAssetSlots.spec.ts` asserts the two agree — if they
 * diverge, the logo the admin previews is not the logo the client receives.
 */
export function getBrandAssetSrc(
  settings: Pick<
    BrandConfig,
    'authLogo' | 'sidebarLogo' | 'sidebarIcon' | 'favicon' | 'reportLogo' | 'reportMonoLogo'
  >,
  slot: BrandAssetSlot
) {
  switch (slot) {
    case 'auth':
      return settings.authLogo || settings.sidebarLogo || settings.sidebarIcon || null;
    case 'sidebar':
      return settings.sidebarLogo || settings.authLogo || settings.sidebarIcon || null;
    case 'sidebar-icon':
      return settings.sidebarIcon || settings.sidebarLogo || settings.authLogo || null;
    case 'favicon':
      return settings.favicon || settings.sidebarIcon || settings.sidebarLogo || settings.authLogo || null;
    case 'report':
      return settings.reportLogo || settings.sidebarLogo || settings.authLogo || settings.sidebarIcon || null;
    case 'report-mono':
      return settings.reportMonoLogo || settings.reportLogo || settings.sidebarLogo
        || settings.authLogo || settings.sidebarIcon || null;
    default:
      return null;
  }
}