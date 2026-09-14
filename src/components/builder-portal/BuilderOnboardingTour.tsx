/**
 * Onboarding tour for Builder / Developer Portal users.
 *
 * Mirrors `SolicitorOnboardingTour` (which itself mirrors the Client Portal
 * `PortalOnboardingTour` and `FinanceOnboardingTour`) so every portal introduces
 * itself the same way: same welcome card, same step card, same progress dots,
 * same Escape-to-dismiss, same close control, same replay event, same mobile
 * centring fallback.
 *
 * Three deliberate divergences, none of them a redesign:
 *
 *   1. The Builder portal navigates from a horizontal top bar, not a sidebar,
 *      so the step card is positioned BELOW the highlighted destination rather
 *      than to its right, and the stacking-context fix targets the header
 *      rather than the sidebar.
 *
 *   2. Reduced motion is honoured. `motion-reduce:animate-none` and
 *      `motion-reduce:transition-none` mean a user with the OS preference set
 *      gets the same tour with no animation, rather than no tour.
 *
 *   3. Completion is SERVER state, on builder_user_preferences.tour_completed_at.
 *      The other three portal tours cache it in localStorage; the Builder Portal
 *      persists nothing in the browser, and `security:builder-portal` fails the
 *      build if any Builder browser source touches localStorage, sessionStorage
 *      or document.cookie. Rather than weaken that control for a cosmetic flag,
 *      tour state joins the user's other UI preferences.
 *
 * Destinations are Builder destinations. Terminology is Builder terminology.
 * No legal or matter language appears anywhere in this file.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Bell, Boxes, Building2, CheckCircle2, FileText, Hammer,
  LayoutDashboard, ListChecks, MessageSquare, Receipt, Settings as SettingsIcon,
  Sparkles, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { useBuilderMyPreferences, useBuilderWorkspaceMutation } from '@/lib/builderQueries';
import { cn } from '@/lib/utils';
import { WITHDRAWN_BUILDER_SECTION_KEYS } from '@/lib/builderHiddenSections.pure';

interface TourStep {
  selector: string;
  title: string;
  description: string;
  icon: React.ElementType;
}

const STEPS: TourStep[] = [
  {
    selector: '[data-tour="dashboard"]',
    title: 'Your dashboard',
    description: 'Your home base — the figures for everything shared with your account, what is waiting on you, and your recent activity.',
    icon: LayoutDashboard,
  },
  {
    selector: '[data-tour="projects"]',
    title: 'Projects',
    description: 'Every development and project your organisation has been given access to, with stages, parties and status history.',
    icon: Building2,
  },
  {
    selector: '[data-tour="inventory"]',
    title: 'Inventory',
    description: 'Buildings, lots and units with availability, pricing, holds, reservations and allocations.',
    icon: Boxes,
  },
  {
    selector: '[data-tour="transactions"]',
    title: 'Transactions',
    description: 'Sales moving through your pipeline, each linked to its unit and to the wider transaction case.',
    icon: Receipt,
  },
  {
    selector: '[data-tour="construction"]',
    title: 'Construction',
    description: 'Construction cases, stages, milestones, progress updates, estimated completion dates and site photographs.',
    icon: Hammer,
  },
  {
    selector: '[data-tour="documents"]',
    title: 'Documents',
    description: 'Project, unit and construction documents. Every version is kept, so superseded plans stay auditable.',
    icon: FileText,
  },
  {
    selector: '[data-tour="messages"]',
    title: 'Messages',
    description: 'Conversations scoped to a project, unit, transaction or construction case. You see a thread once you are a participant.',
    icon: MessageSquare,
  },
  {
    selector: '[data-tour="tasks"]',
    title: 'Tasks',
    description: 'Work assigned to you and your team — variations, defects, inspections and handover steps, with due dates.',
    icon: ListChecks,
  },
  {
    selector: '[data-tour="notifications"]',
    title: 'Notifications',
    description: 'Alerts for status changes, new documents, defects raised, inspections scheduled and variation decisions.',
    icon: Bell,
  },
  {
    selector: '[data-tour="settings"]',
    title: 'Settings & security',
    description: 'Manage your preferences and your organisation’s settings, review the devices signed into your account and revoke any you do not recognise.',
    icon: SettingsIcon,
  },
];

/*
 * A TOUR STEP IS A PROMISE THAT SOMETHING IS THERE TO POINT AT.
 *
 * Four of the steps above anchor to sidebar entries for sections withdrawn
 * from this portal (`builderHiddenSections.pure.ts`). Their `data-tour`
 * elements are no longer drawn, so `document.querySelector` returns null and
 * the step highlights nothing — a tour that stalls on an empty spotlight is
 * worse than a shorter tour.
 *
 * The key is read off the selector rather than added as a field, because the
 * selector IS the anchor name and a second copy of it is how the two drift.
 * The table above keeps every step, so re-offering a section restores its
 * step with no second edit — and `onboarding-tour.test.mjs` still reads the
 * complete table to check Builder's destinations and terminology.
 * Everything at RUNTIME reads `VISIBLE_STEPS`, so the progress dots, the
 * "3 of N" counter and the last-step test all count what is shown.
 */
const tourKeyOf = (selector: string) => selector.match(/data-tour="([^"]+)"/)?.[1] ?? '';

const VISIBLE_STEPS: TourStep[] = STEPS.filter(
  (step) => !WITHDRAWN_BUILDER_SECTION_KEYS.includes(tourKeyOf(step.selector)),
);

export const BUILDER_TOUR_EVENT = 'builder:start-tour';

export function BuilderOnboardingTour() {
  const { user } = useBuilderPortalAuth();
  // Tour state is SERVER state. The Builder Portal persists nothing in the
  // browser — no localStorage, no sessionStorage, no cookie — so completion
  // lives on builder_user_preferences.tour_completed_at alongside the user's
  // other UI preferences. `security:builder-portal` fails the build if this
  // file ever reaches for browser storage.
  const { data: preferences, isLoading } = useBuilderMyPreferences();
  const workspace = useBuilderWorkspaceMutation();

  const [active, setActive] = useState(false);
  const [step, setStep] = useState(-1); // -1 = welcome
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [centered, setCentered] = useState(false);
  // A completed tour must not re-open when the preferences query refetches
  // between finishing and the server round-trip landing.
  const dismissed = useRef(false);

  useEffect(() => {
    if (!user || isLoading) return;
    if (dismissed.current) return;
    // No preferences row yet means a brand-new user, so the tour is due.
    if (preferences?.tour_completed_at) return;
    const timer = setTimeout(() => setActive(true), 900);
    return () => clearTimeout(timer);
  }, [user, isLoading, preferences?.tour_completed_at]);

  useEffect(() => {
    const onReplay = () => { dismissed.current = false; setStep(-1); setActive(true); };
    window.addEventListener(BUILDER_TOUR_EVENT, onReplay);
    return () => window.removeEventListener(BUILDER_TOUR_EVENT, onReplay);
  }, []);

  const cleanup = useCallback(() => {
    VISIBLE_STEPS.forEach((s) => {
      const el = document.querySelector(s.selector) as HTMLElement | null;
      if (!el) return;
      el.style.position = ''; el.style.zIndex = ''; el.style.boxShadow = ''; el.style.borderRadius = '';
      // The sticky top bar owns a stacking context, so raising the nav item
      // alone would leave the highlight trapped underneath the overlay.
      const shell = el.closest('header') as HTMLElement | null;
      if (shell) { shell.style.zIndex = ''; shell.style.position = ''; }
    });
  }, []);

  const position = useCallback((index: number) => {
    if (index < 0 || index >= VISIBLE_STEPS.length) return;
    const el = document.querySelector(VISIBLE_STEPS[index].selector) as HTMLElement | null;
    if (!el) { setCentered(true); return; }
    const rect = el.getBoundingClientRect();
    // The nav scrolls horizontally on small screens and a destination may be
    // scrolled out of view entirely — nothing to point at, so centre the card.
    if (rect.width === 0 || rect.height === 0) { setCentered(true); return; }
    setCentered(false);

    const shell = el.closest('header') as HTMLElement | null;
    if (shell) { shell.style.position = 'relative'; shell.style.zIndex = '60'; }
    el.style.position = 'relative';
    el.style.zIndex = '61';
    el.style.borderRadius = '12px';
    el.style.boxShadow = '0 0 0 4px hsl(var(--primary) / 0.35)';

    // Below the top bar, and clamped so a destination near the right edge does
    // not push the card off-screen.
    setPos({
      top: rect.bottom + 16,
      left: Math.max(Math.min(rect.left, window.innerWidth - 400), 16),
    });
  }, []);

  useEffect(() => {
    if (step >= 0) { cleanup(); position(step); }
    return () => cleanup();
  }, [step, position, cleanup]);

  const finish = useCallback(() => {
    cleanup();
    dismissed.current = true;
    setActive(false);
    setStep(-1);
    // Fire-and-forget: the tour closes immediately either way. A failed stamp
    // means the tour offers itself again next visit, which is the safe failure.
    workspace.mutate({ operation: 'complete_onboarding_tour' });
  }, [cleanup, workspace]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, finish]);

  if (!active) return null;

  const isWelcome = step === -1;
  const current = step >= 0 ? VISIBLE_STEPS[step] : null;
  const Icon = current?.icon;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm dark:bg-black/60" />

      {isWelcome ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Builder portal tour"
        >
          <div className="w-full max-w-md animate-in rounded-2xl border border-border bg-card p-8 shadow-2xl duration-300 fade-in zoom-in-95 motion-reduce:animate-none">
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                <Sparkles className="h-8 w-8 text-primary" aria-hidden />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-foreground">Welcome to the Builder Portal</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  A quick tour of where everything lives. It takes about a minute, and you can
                  replay it anytime from your settings.
                </p>
              </div>
              <div className="flex flex-col gap-3 pt-2">
                <Button onClick={() => setStep(0)} size="lg" className="w-full gap-2">
                  Start tour <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
                <Button onClick={finish} variant="ghost" size="sm" className="text-muted-foreground">
                  Skip for now
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : current && Icon ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Tour step ${step + 1} of ${VISIBLE_STEPS.length}: ${current.title}`}
          className={cn(
            'fixed z-[62] w-[340px] animate-in duration-200 fade-in motion-reduce:animate-none md:w-[380px]',
            centered ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 zoom-in-95' : 'slide-in-from-top-3',
          )}
          style={centered
            ? { maxWidth: 'calc(100vw - 32px)' }
            : { top: `${pos.top}px`, left: `${pos.left}px`, maxWidth: 'calc(100vw - 32px)' }}
        >
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border bg-primary/5 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-primary/10 p-2">
                  <Icon className="h-5 w-5 text-primary" aria-hidden />
                </div>
                <h3 className="text-base font-semibold text-foreground">{current.title}</h3>
              </div>
              <button
                type="button"
                onClick={finish}
                aria-label="Close tour"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="px-5 py-4">
              <p className="text-sm leading-relaxed text-muted-foreground">{current.description}</p>
            </div>

            <div className="flex items-center justify-between border-t border-border bg-muted/30 px-5 py-3">
              <div className="flex items-center gap-1.5" aria-hidden>
                {VISIBLE_STEPS.map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      'h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none',
                      i === step ? 'w-6 bg-primary' : i < step ? 'w-1.5 bg-primary/40' : 'w-1.5 bg-muted-foreground/20',
                    )}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="mr-1 text-xs text-muted-foreground">{step + 1}/{VISIBLE_STEPS.length}</span>
                <Button
                  onClick={() => (step < VISIBLE_STEPS.length - 1 ? setStep(step + 1) : finish())}
                  size="sm"
                  className="h-8 gap-1.5"
                >
                  {step === VISIBLE_STEPS.length - 1
                    ? <>Finish <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /></>
                    : <>Next <ArrowRight className="h-3.5 w-3.5" aria-hidden /></>}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
