import { Globe, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBrand } from '@/branding/useTokens';
import { getBrandAssetSrc, type BrandAssetSlot } from '@/branding/brand-assets';
import type { WhiteLabelSettings } from '@/branding/brand-types';

interface BrandLogoProps {
  slot: BrandAssetSlot;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  settings?: WhiteLabelSettings;
}

/**
 * A mark with no size is a mark at its natural size, which for an uploaded
 * asset means whatever pixels the tenant happened to export.
 *
 * Every layout in the product passes its own `logoClassName`. The three pages
 * that did not are the three an OUTSIDER sees — the public passport, the
 * referral consent and (until it was fixed) the compliance agreement — and on
 * each of them the brand rendered several times the height of the heading
 * beside it, making the logo the subject of the page and the document its
 * footnote.
 *
 * The floor is here rather than at each call site because the call sites are
 * exactly what was forgotten. `cn` is tailwind-merge, so a caller's own
 * height, width or max-width still wins: nothing that already sizes its mark
 * changes, and nothing new can be unbounded.
 */
const LOGO_DEFAULT = 'h-10 w-auto max-w-[220px] object-contain';

export function BrandLogo({ slot, alt, className, fallbackClassName, settings: settingsOverride }: BrandLogoProps) {
  const { settings: brandSettings } = useBrand();
  const settings = settingsOverride ?? brandSettings;
  const src = getBrandAssetSrc(settings, slot);

  if (src) {
    return <img src={src} alt={alt || settings.companyName} className={cn(LOGO_DEFAULT, className)} />;
  }

  const fallbackIcon = slot === 'favicon' ? Globe : Building2;
  const FallbackIcon = fallbackIcon;

  return (
    <div className={cn('flex items-center justify-center rounded-xl bg-primary/10 text-primary', fallbackClassName)}>
      <FallbackIcon className="h-5 w-5" />
    </div>
  );
}

interface BrandMarkProps {
  slot?: Extract<BrandAssetSlot, 'sidebar-icon' | 'favicon'>;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  settings?: WhiteLabelSettings;
}

export function BrandMark({
  slot = 'sidebar-icon',
  alt,
  className = 'h-10 w-10 object-contain',
  fallbackClassName = 'h-10 w-10',
  settings,
}: BrandMarkProps) {
  return <BrandLogo slot={slot} alt={alt} className={className} fallbackClassName={fallbackClassName} settings={settings} />;
}

interface BrandFaviconProps {
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  settings?: WhiteLabelSettings;
}

export function BrandFavicon({
  alt,
  className = 'h-8 w-8 rounded-lg object-contain',
  fallbackClassName = 'h-8 w-8 rounded-lg',
  settings,
}: BrandFaviconProps) {
  return <BrandLogo slot="favicon" alt={alt} className={className} fallbackClassName={fallbackClassName} settings={settings} />;
}

interface BrandLockupProps {
  slot?: Extract<BrandAssetSlot, 'auth' | 'sidebar' | 'sidebar-icon'>;
  meta?: string;
  className?: string;
  logoClassName?: string;
  fallbackClassName?: string;
  companyClassName?: string;
  metaClassName?: string;
  settings?: WhiteLabelSettings;
}

export function BrandLockup({
  slot = 'sidebar',
  meta,
  className,
  logoClassName,
  fallbackClassName,
  companyClassName,
  metaClassName,
  settings: settingsOverride,
}: BrandLockupProps) {
  const { settings: brandSettings } = useBrand();
  const settings = settingsOverride ?? brandSettings;

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <BrandLogo
        slot={slot}
        alt={settings.companyName}
        className={logoClassName}
        fallbackClassName={fallbackClassName}
        settings={settings}
      />
      <div className="min-w-0">
        <p className={cn('break-words font-semibold leading-tight text-foreground', companyClassName)}>{settings.companyName}</p>
        {meta ? <p className={cn('mt-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground', metaClassName)}>{meta}</p> : null}
      </div>

    </div>
  );
}