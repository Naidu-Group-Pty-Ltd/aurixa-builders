import type { ReactNode } from 'react';
import { HardHat } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Page-level heading/content used inside the single BuilderPortalLayout.
 *
 * Keeps the `builder-portal-page-header` treatment — the Builder copy of the
 * formula the Client, Finance and Solicitor portals share — so the portal
 * still opens with the family's hero pane, and re-cuts what sits inside it.
 *
 * ## What changed, and why
 *
 * The header used to be an eyebrow, a `text-2xl` title and a paragraph. It was
 * competent and it was the same opening every admin panel has. Two changes:
 *
 * **The eyebrow is annotation type.** Monospace, uppercase, widely tracked —
 * the way a drawing notes a sheet. Set against a title tracked at −0.045em it
 * is the widest typographic contrast in the portal, and it is the thing that
 * makes a page read as a drawing rather than a form. It is the `--font-mono`
 * token, so no component here declares a family and the White-Label admin
 * still retunes it.
 *
 * **The hero can carry a drawing.** `aside` is where a page puts the thing
 * worth looking at — a site plan, a dimension rail — beside the title instead
 * of in a card below it. Optional, so the twenty-odd pages that have nothing
 * to draw are unchanged.
 *
 * Both additions are additive: `title`, `description`, `eyebrow`, `actions`
 * and `children` behave exactly as before, which matters because every page in
 * the portal mounts this.
 *
 * The eyebrow icon is a hard hat because that is Builder *domain* iconography,
 * not brand identity: the configured operator logo is rendered by the layout's
 * `BrandLockup`, never here.
 */
interface BuilderPortalShellProps {
  title: string;
  description?: string;
  /** Small annotation above the title. Defaults to the portal name. */
  eyebrow?: string;
  actions?: ReactNode;
  /**
   * A drawing for the hero — a site plan, a dimension rail, a figure worth the
   * space. Sits beside the title on wide screens and under it when narrow.
   */
  aside?: ReactNode;
  /** A title block, or any strip that identifies the record, under the hero. */
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function BuilderPortalShell({
  title,
  description,
  eyebrow = 'Builder / Developer Portal',
  actions,
  aside,
  meta,
  className,
  children,
}: BuilderPortalShellProps) {
  return (
    <div className={cn('space-y-6 md:space-y-8', className)}>
      <header className="builder-portal-page-header">
        <div
          className={cn(
            'relative gap-6',
            aside ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center' : 'flex flex-col sm:flex-row sm:items-end sm:justify-between sm:gap-4',
          )}
        >
          <div className="min-w-0">
            {eyebrow ? (
              <div className="mb-2.5 flex items-center gap-2">
                <HardHat className="h-3.5 w-3.5 text-primary" aria-hidden />
                <span className="bd-annot bd-annot-strong">{eyebrow}</span>
              </div>
            ) : null}
            <h1 className="text-[1.75rem] font-semibold leading-[1.05] tracking-[-0.045em] text-foreground md:text-[2.25rem]">
              {title}
            </h1>
            {description ? (
              <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            ) : null}
            {/*
              NAMED, NOT ADDRESSED BY POSITION.

              A page that wants to frame this cluster must be able to reach it
              by class. The Stock List used to do it positionally —
              `.builder-portal-page-header > div > div:last-child` — which was
              true only while `actions` was the header row's second child.
              Moving it under the title made that selector match the whole
              title/description/actions block, so the frame meant for two
              buttons wrapped the heading as well.

              The class is the contract. The layout inside this header is the
              shell's to change; what a page is entitled to target is a name.
            */}
            {actions ? (
              <div className="builder-portal-page-actions mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center [&>*]:w-full sm:[&>*]:w-auto">
                {actions}
              </div>
            ) : null}
          </div>
          {aside ? <div className="min-w-0">{aside}</div> : null}
        </div>
      </header>
      {meta ?? null}
      {children}
    </div>
  );
}
