import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Bell, Boxes, Building2, ClipboardList, FileText, Hammer, HardHat, History,
  KanbanSquare, LayoutDashboard, ListChecks, LogOut, Menu, MessageSquare, Receipt,
  Settings as SettingsIcon, Shield, ShieldCheck, X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BrandLockup, BrandLogo } from '@/components/branding/BrandAssets';
import { useWhiteLabel } from '@/contexts/WhiteLabelContext';
import { cn } from '@/lib/utils';
import { accessRoleLabel } from '@/lib/builderAccessTerms';
import { isWithdrawnBuilderPath } from '@/lib/builderHiddenSections.pure';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { BuilderNotificationBell } from './BuilderNotificationBell';
import { BuilderPortalUserCard } from './ui/BuilderPortalUserCard';
import { BuilderOrganisationSwitcher } from './BuilderOrganisationSwitcher';
import { BuilderOnboardingTour } from './BuilderOnboardingTour';
import { BUILDER_TOUR_EVENT } from './BuilderOnboardingTour';
import { usePartnerWorkspaceEnabled } from '@/lib/aml/usePartnerWorkspaceFlags';

/**
 * One authenticated layout owns the Builder Portal chrome: a branded sidebar,
 * a compact sticky top bar, and a drawer on mobile.
 *
 * The structure mirrors `SolicitorPortalLayout` so the two portals read as one
 * product — same sidebar width, same lockup position, same flat navigation list,
 * same item height and active treatment, same top-bar height, same profile-menu
 * hierarchy, same drawer behaviour. What differs is Builder's routes, icons and
 * organisation context.
 *
 * BRANDING. Identity is the configured white-label operator, resolved through
 * `BrandLockup`/`BrandLogo` on the `sidebar` and `sidebar-icon` slots. The hard
 * hat is Builder *domain* iconography only, and appears nowhere the operator
 * logo belongs. The active organisation sits in the identity card below the
 * lockup — context, never a replacement for the operator's identity.
 *
 * Items whose module is not yet built are rendered disabled with an explicit
 * "available in a later phase" tooltip rather than linking to a placeholder —
 * there are no fake business records or stub APIs behind them.
 */

interface BuilderNavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  available: boolean;
  /** Present only on the flag-gated AML compliance entry. */
  complianceGated?: boolean;
}

const NAV: BuilderNavItem[] = [
  { to: '/builder', label: 'Dashboard', icon: LayoutDashboard, exact: true, available: true },
  // Second, directly under the Dashboard — see FinancePortalLayout for why.
  //
  // Feature-flagged (aml_partner_compliance_workspace + builder surface
  // flag); filtered out of the nav until enabled. Presentation gating only —
  // the server enforces the same flags on every workspace operation.
  { to: '/builder/compliance', label: 'AML/CTF Compliance', icon: ShieldCheck, available: true, complianceGated: true },
  { to: '/builder/projects', label: 'Projects', icon: Building2, available: true },
  { to: '/builder/inventory', label: 'Inventory', icon: Boxes, available: true },
  { to: '/builder/stock', label: 'Stock List', icon: ClipboardList, available: true },
  { to: '/builder/transactions', label: 'Transactions', icon: Receipt, available: true },
  { to: '/builder/pipeline', label: 'Pipeline', icon: KanbanSquare, available: true },
  { to: '/builder/construction', label: 'Construction', icon: Hammer, available: true },
  { to: '/builder/documents', label: 'Documents', icon: FileText, available: true },
  { to: '/builder/messages', label: 'Messages', icon: MessageSquare, available: true },
  { to: '/builder/tasks', label: 'Tasks', icon: ListChecks, available: true },
  { to: '/builder/notifications', label: 'Notifications', icon: Bell, available: true },
  { to: '/builder/activity', label: 'Activity', icon: History, available: true },
  { to: '/builder/settings', label: 'Settings', icon: SettingsIcon, available: true },
];

/**
 * Anchor the guided onboarding tour points at, derived from the route so it can
 * never drift from the destination it labels. `/builder` is the dashboard;
 * every other destination uses its path segment.
 *
 * Deliberately derived rather than stored on BuilderNavItem: NAV entries are
 * asserted verbatim by the per-domain contract tests, and an extra field would
 * make those assertions about the tour rather than about the navigation.
 */
function tourAnchor(to: string): string {
  return to === '/builder' ? 'dashboard' : to.slice('/builder/'.length);
}

/** One flat navigation list, matching the Solicitor sidebar. */
function SidebarNav({ pathname, showCompliance, onNavigate }: { pathname: string; showCompliance?: boolean; onNavigate?: () => void }) {
  return (
    <TooltipProvider delayDuration={200}>
      <nav aria-label="Builder portal" className="space-y-1 px-3">
        {NAV.map(({ to, label, icon: Icon, exact, available, complianceGated }) => {
          /*
           * Withdrawn from this portal entirely — see
           * `builderHiddenSections.pure.ts`. The entry stays in NAV and is
           * filtered HERE rather than deleted from the array, so re-offering
           * a section is one line in that module and the array continues to
           * describe the portal's full shape.
           *
           * One filter serves the desktop sidebar and the mobile sheet,
           * because both mount this same component — the trap the AML module
           * fell into was two navigation surfaces built from two lists.
           */
          if (isWithdrawnBuilderPath(to)) return null;
          // Flag-gated entry: absent until the compliance surface is enabled.
          if (complianceGated && !showCompliance) return null;
          if (!available) {
            return (
              <Tooltip key={to}>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled
                      aria-disabled
                      className="w-full cursor-not-allowed justify-start opacity-50"
                    >
                      <Icon className="mr-3 h-[18px] w-[18px] shrink-0" aria-hidden />
                      <span>{label}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{label} becomes available in a later phase</TooltipContent>
              </Tooltip>
            );
          }

          // NavLink handles the styling; `aria-current` is derived from the
          // same rule so it can never drift from the path.
          const active = exact ? pathname === to : pathname.startsWith(to);

          return (
            <NavLink
              key={to}
              to={to}
              end={exact}
              onClick={onNavigate}
              data-tour={tourAnchor(to)}
              aria-current={active ? 'page' : undefined}
              /*
               * The active entry used to be a filled primary pill with a
               * shadow — the loudest thing in the portal, and the same
               * treatment every admin panel uses. A drawing marks the thing
               * in hand with a cut on its leading edge instead: a 2px rule
               * and a wash that falls away to the right, leaving the label
               * in the foreground ink rather than reversed out of a slab.
               * See `bd-nav-active` in builder-drafting.css.
               */
              className={cn(
                'flex items-center gap-3 rounded-sm px-4 py-3 text-sm transition-colors duration-200',
                'focus-visible:ring-ring/80',
                active
                  ? 'bd-nav-active font-semibold text-foreground'
                  : 'font-medium text-muted-foreground hover:bg-accent/30 hover:text-foreground',
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
            </NavLink>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}

export function BuilderPortalLayout() {
  const { user, activeOrganisation, signOut } = useBuilderPortalAuth();
  const { settings } = useWhiteLabel();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { enabled: complianceNavEnabled } = usePartnerWorkspaceEnabled('builder');
  const [mobileOpen, setMobileOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const displayName = user?.name || user?.email || 'Builder';
  const organisationName = activeOrganisation
    ? activeOrganisation.trading_name || activeOrganisation.legal_name
    : null;
  const currentPage = NAV.find((item) =>
    (item.exact ? pathname === item.to : pathname.startsWith(item.to)));

  /**
   * Portal-specific document title and meta, driven by the configured branding.
   * Mirrors the Solicitor pattern, including restoring the application title on
   * unmount so leaving the portal does not leave its title behind.
   */
  useEffect(() => {
    const company = (settings.companyName || '').trim() || 'Dashboard';
    const portalTitle = `${company} — Builder / Developer Portal`;
    const portalDesc = `Secure builder and developer portal for ${company} — manage projects, inventory, transactions, construction programmes and shared documents.`;

    document.title = portalTitle;

    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', portalDesc);

    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', portalTitle);

    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', portalDesc);

    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    if (twitterTitle) twitterTitle.setAttribute('content', portalTitle);

    return () => {
      if (settings.companyName) {
        document.title = `${settings.companyName} Dashboard`;
      }
    };
  }, [settings.companyName]);

  // Navigating closes the drawer, so a route change never leaves it open.
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  /**
   * Who is signed in and which organisation they act for. The switcher renders
   * itself only when there is more than one organisation to choose between, and
   * the selection is re-verified server-side — none of that logic lives here.
   */
  const userCard = (
    <BuilderPortalUserCard
      name={displayName}
      secondary={organisationName || user?.email}
      roleLabel={activeOrganisation ? accessRoleLabel(activeOrganisation.membership_role) : null}
      isPrimaryOrganisation={Boolean(activeOrganisation?.is_primary)}
      switcher={<BuilderOrganisationSwitcher />}
    />
  );

  const signOutFooter = (compact = false) => (
    <div className={compact ? 'p-3' : 'p-4'}>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start rounded-xl py-2.5 text-muted-foreground hover:bg-destructive/5 hover:text-destructive"
        onClick={() => void signOut()}
      >
        <LogOut className="mr-3 h-4 w-4" aria-hidden />
        Sign Out
      </Button>
      <div className={cn('flex items-center gap-1.5 px-3 text-[10px] text-muted-foreground/50', compact ? 'mt-2' : 'mt-3')}>
        <Shield className="h-3 w-3 shrink-0" aria-hidden />
        <span>Secured Portal • Access resolved per request</span>
      </div>
    </div>
  );

  return (
    <div className="builder-portal-theme flex min-h-screen flex-col">
      <BuilderOnboardingTour />

      <a
        href="#main-content"
        className="sr-only rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[70]"
      >
        Skip to main content
      </a>

      <div className="relative z-10 flex flex-1">
        {/* ── Desktop sidebar ── */}
        <aside className="builder-portal-sidebar hidden w-72 shrink-0 flex-col border-r md:flex">
          <div className="flex items-center justify-between gap-3 p-6 pb-4">
            <Link to="/builder" className="min-w-0 flex-1 rounded-xl focus-visible:outline-none">
              <BrandLockup
                slot="sidebar"
                meta="Builder / Developer Portal"
                logoClassName="h-10 max-w-[160px] object-contain"
                fallbackClassName="h-10 w-10"
                companyClassName="text-base font-bold tracking-tight truncate"
                metaClassName="tracking-widest truncate"
              />
            </Link>
            <div className="shrink-0">
              <BuilderNotificationBell />
            </div>
          </div>
          <Separator />

          <div className="px-4 py-4">{userCard}</div>

          <ScrollArea className="flex-1 py-2">
            <SidebarNav pathname={pathname} showCompliance={complianceNavEnabled} />
          </ScrollArea>

          <Separator />
          {signOutFooter()}
        </aside>

        {/* ── Main column ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="builder-portal-topbar sticky top-0 z-30 border-b">
            <div className="flex h-14 items-center gap-3 px-4 md:px-6">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 md:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation menu"
                aria-expanded={mobileOpen}
              >
                <Menu className="h-5 w-5" aria-hidden />
              </Button>

              <Link to="/builder" className="flex min-w-0 items-center gap-2 md:hidden">
                <BrandLogo
                  slot="sidebar-icon"
                  className="h-7 w-7 object-contain"
                  fallbackClassName="h-7 w-7"
                />
                <span className="truncate text-sm font-bold text-foreground">Builder Portal</span>
              </Link>

              {pathname !== '/builder' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 shrink-0 gap-1.5 rounded-full text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                  onClick={() => navigate('/builder')}
                  aria-label="Back to Builder Portal dashboard"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  <span className="hidden text-xs font-medium sm:inline">Back to dashboard</span>
                </Button>
              ) : null}

              <p className="hidden min-w-0 truncate text-sm font-semibold text-foreground md:block">
                {currentPage?.label ?? 'Builder Portal'}
              </p>

              <div className="ml-auto flex shrink-0 items-center gap-2">
                <div className="md:hidden">
                  <BuilderNotificationBell />
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-9 gap-2 px-2">
                      <Avatar className="h-8 w-8 border border-primary/20">
                        <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                          {displayName.split(/[\s@.]+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="hidden max-w-32 truncate text-sm font-medium sm:inline">
                        {displayName}
                      </span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>
                      <div className="flex flex-col">
                        <span className="truncate text-sm font-medium">{displayName}</span>
                        <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
                        {user?.job_title ? (
                          <Badge variant="outline" className="mt-2 w-fit font-normal">
                            {user.job_title}
                          </Badge>
                        ) : null}
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => navigate('/builder/settings')}>
                      <SettingsIcon className="mr-2 h-4 w-4" aria-hidden /> Settings
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => window.dispatchEvent(new CustomEvent(BUILDER_TOUR_EVENT))}
                    >
                      <HardHat className="mr-2 h-4 w-4" aria-hidden /> Replay portal tour
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void signOut()} className="text-destructive">
                      <LogOut className="mr-2 h-4 w-4" aria-hidden /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </header>

          <main id="main-content" className="builder-portal-main min-w-0 flex-1 overflow-auto">
            <div className="builder-portal-content">
              <AnimatePresence mode="wait">
                <motion.div
                  key={pathname}
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.2 }}
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>
      </div>

      {/* ── Mobile drawer ── */}
      <AnimatePresence>
        {mobileOpen ? (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Builder portal navigation"
              className="builder-portal-sidebar fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] touch-pan-y flex-col border-r md:hidden"
              initial={reduceMotion ? false : { x: '-100%' }}
              animate={{ x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { x: '-100%' }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', damping: 28, stiffness: 300 }}
              drag={reduceMotion ? false : 'x'}
              dragConstraints={{ left: -288, right: 0 }}
              dragElastic={0.1}
              onDragEnd={(_event, info) => {
                if (info.offset.x < -80 || info.velocity.x < -300) setMobileOpen(false);
              }}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/70 p-4">
                <BrandLockup
                  slot="sidebar-icon"
                  meta="Builder / Developer Portal"
                  logoClassName="h-9 w-9 object-contain"
                  fallbackClassName="h-9 w-9"
                  companyClassName="text-sm font-bold tracking-tight truncate"
                  metaClassName="tracking-widest truncate"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close navigation menu"
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>

              <div className="px-3 py-3">{userCard}</div>

              <ScrollArea className="flex-1 py-1">
                <SidebarNav pathname={pathname} showCompliance={complianceNavEnabled} onNavigate={() => setMobileOpen(false)} />
              </ScrollArea>

              <Separator />
              {signOutFooter(true)}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
