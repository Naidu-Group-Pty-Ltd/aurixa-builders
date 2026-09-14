import { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Boxes, FileText, HardHat, ShieldCheck } from 'lucide-react';
import { BrandLockup, BrandLogo } from '@/components/branding/BrandAssets';
import { useBrand } from '@/branding/useTokens';

/**
 * Shared chrome for the unauthenticated Builder Portal surfaces — sign in,
 * invite acceptance, password reset and rotation, and organisation selection.
 *
 * The composition mirrors `SolicitorLogin`: a branded panel from `lg` up, the
 * form beside it. Because every Builder authentication page routes through here,
 * they all inherit the same layout, spacing, typography and responsive collapse
 * from one place, and none of them needed a logic change to get it.
 *
 * BRANDING. Identity comes from the Command Centre white-label settings through
 * `BrandLockup` and `BrandLogo` on the `auth` slot — there is no Builder logo,
 * no hard-coded company name and no cached asset here. The hard hat is Builder
 * *domain* iconography in the value points; when no logo is configured the
 * shared `BrandLogo` fallback renders, not a hard hat and not a blank space.
 *
 * The three value points are portal-level copy, identical on every
 * authentication surface, so the product reads the same whichever door a user
 * arrives at.
 */
const VALUE_POINTS = [
  {
    icon: HardHat,
    title: 'Projects and delivery',
    desc: 'Developments, stages and construction programmes tracked in one place.',
  },
  {
    icon: Boxes,
    title: 'Inventory and transactions',
    desc: 'Lot and unit availability beside the sales moving against them.',
  },
  {
    icon: FileText,
    title: 'Documents, messages and tasks',
    desc: 'Plans, certificates and conversations against the records you can reach.',
  },
];

export function BuilderAuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { settings } = useBrand();
  const reduceMotion = useReducedMotion();

  const companyName = settings.companyName || 'Builder / Developer Portal';

  return (
    <div className="builder-portal-theme bd-auth-grid flex min-h-screen">
      {/* ── Branded panel (from lg up) ── */}
      <aside
        className="builder-portal-sidebar relative z-10 hidden shrink-0 flex-col border-r lg:flex lg:w-[480px] xl:w-[520px]"
        aria-hidden="true"
      >
        <div
          className="pointer-events-none absolute right-0 top-0 h-full w-px bg-gradient-to-b from-transparent via-primary/30 to-transparent"
        />

        <div className="relative flex flex-1 flex-col justify-between gap-10 p-10">
          <BrandLockup
            slot="auth"
            meta="Builder / Developer Portal"
            logoClassName="h-12 max-w-[220px] object-contain"
            fallbackClassName="h-11 w-11 border border-primary/20"
            companyClassName="text-lg font-bold tracking-tight truncate"
            metaClassName="tracking-[0.2em] truncate"
          />

          <div className="space-y-8">
            <div>
              <h2 className="text-[2rem] font-semibold leading-[1.06] tracking-[-0.045em] text-foreground">
                Deliver every project<br />
                with <span className="text-primary">control</span>.
              </h2>
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                A secure workspace for projects, inventory, transactions, construction programmes,
                documents and collaboration.
              </p>
            </div>

            <ul className="space-y-4">
              {VALUE_POINTS.map((point, index) => (
                <motion.li
                  key={point.title}
                  className="flex items-start gap-3"
                  initial={reduceMotion ? false : { opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.4,
                    delay: reduceMotion ? 0 : 0.3 + index * 0.12,
                  }}
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-primary/25 bg-primary/10 text-primary">
                    <point.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="bd-annot block text-foreground">{point.title}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">
                      {point.desc}
                    </span>
                  </span>
                </motion.li>
              ))}
            </ul>
          </div>

          <p className="bd-annot flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 shrink-0" />
            <span>Secured portal · Access resolved per request · Audit logged</span>
          </p>
        </div>
      </aside>

      {/* ── Form panel ── */}
      <main className="relative z-10 flex min-w-0 flex-1 items-center justify-center p-6 md:p-10">
        <motion.div
          className="w-full max-w-md"
          initial={reduceMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.4 }}
        >
          {/* The branded panel is hidden below lg, so identity moves inline. */}
          <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
            <BrandLogo
              slot="auth"
              alt={companyName}
              className="h-14 max-w-[220px] object-contain"
              fallbackClassName="h-14 w-14 rounded-sm border border-primary/20"
            />
            <div className="text-center">
              <p className="text-lg font-bold tracking-tight text-foreground">{companyName}</p>
              <p className="bd-annot">Builder / Developer Portal</p>
            </div>
          </div>

          <div className="mb-6">
            <p className="bd-annot bd-annot-strong mb-2.5">Secure access</p>
            <h1 className="text-[1.75rem] font-semibold leading-[1.05] tracking-[-0.045em] text-foreground">
              {title}
            </h1>
            {description ? (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </div>

          <div className="glass-raised rounded-md border-[hsl(var(--border)/0.9)] p-6 sm:p-7">
            {children}
          </div>

          {footer ? (
            <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
          ) : null}

          <p className="bd-annot mt-8 flex items-center justify-center gap-1.5 lg:hidden">
            <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
            <span>Secured portal · Access resolved per request</span>
          </p>
        </motion.div>
      </main>
    </div>
  );
}
