import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, CheckCircle2, HardHat, Loader2, Lock, Mail, ShieldCheck, Sparkles, UserCheck,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useBrand } from '@/branding/useBrand';
import { cn } from '@/lib/utils';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { builderLoadGovernance, type BuilderOnboardingStep } from '@/lib/builderPortal';

/**
 * Builder / Developer Portal onboarding.
 *
 * The Solicitor onboarding wizard's composition — centred card, header with a
 * centred icon block, introductory slides, progress dots, acknowledgement cards
 * and a Back / Step / Next footer — with Builder's own slides and step copy.
 *
 * The introductory slides are display only. They create no server step, record
 * nothing and gate nothing: `steps` still comes from `builderLoadGovernance()`,
 * `ready` is still the same rule over the same mandatory filter, and
 * `completeOnboarding()` is still the only write. A step the server marks
 * complete is shown complete and cannot be unticked.
 *
 * BRANDING. The slides name the configured white-label operator, never the
 * active organisation — the organisation is the user's context, not the
 * product's identity.
 */
const STEP_COPY: Record<string, { label: string; hint: string; icon: React.ElementType }> = {
  profile_confirmed: {
    label: 'Confirm your name, job title and contact details are correct',
    hint: 'Your name and job title are shown to everyone you collaborate with on a project.',
    icon: UserCheck,
  },
  organisation_confirmed: {
    label: 'Confirm the organisation you are acting for',
    hint: 'Your access is scoped to this organisation. You can switch later if you hold access to more than one.',
    icon: Building2,
  },
  contact_confirmed: {
    label: 'Confirm the best contact address for portal notifications',
    hint: 'Defect, inspection, variation, message and task notifications are sent to this address.',
    icon: Mail,
  },
  security_reviewed: {
    label: 'Review device and session security, and how to report a lost device',
    hint: 'You can review and revoke signed-in devices at any time from Settings.',
    icon: ShieldCheck,
  },
};

const buildIntroSlides = (brand: string) => [
  {
    icon: HardHat,
    title: 'Welcome to the Builder / Developer Portal',
    body: `A project-delivery workspace for the developments ${brand} has shared with your organisation — projects, inventory, transactions, construction records, documents and collaboration in one place.`,
  },
  {
    icon: Lock,
    title: 'Organisation and project-scoped access',
    body: `You see only the organisations and projects explicitly granted to your account. Inventory, transactions, documents and conversations are scoped to those records, and ${brand} controls what is shared.`,
  },
  {
    icon: ShieldCheck,
    title: 'Secure and auditable collaboration',
    body: 'Logins, changes, document activity and collaboration may be recorded and audited against your account. Keep your credentials private and report anything unexpected immediately.',
  },
];

export default function BuilderOnboarding() {
  const { completeOnboarding } = useBuilderPortalAuth();
  const { settings: brandSettings } = useBrand();
  const navigate = useNavigate();

  const [steps, setSteps] = useState<BuilderOnboardingStep[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);

  const brandName = (brandSettings.companyName || '').trim() || 'the operator';
  const introSlides = useMemo(() => buildIntroSlides(brandName), [brandName]);
  const totalSteps = introSlides.length + 1; // intro slides + acknowledgements
  const isAcknowledgementStep = wizardStep === totalSteps - 1;

  useEffect(() => {
    let cancelled = false;

    void builderLoadGovernance().then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) setError(loadError.message);
      setSteps(data?.steps ?? []);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  const outstanding = steps.filter((step) => step.mandatory && !step.completed_at);
  const ready = steps.length > 0 && outstanding.every((step) => checked[step.step_key]);

  const handleComplete = async () => {
    setError(null);
    setSubmitting(true);
    const result = await completeOnboarding();
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    navigate('/builder', { replace: true });
  };

  const intro = isAcknowledgementStep ? null : introSlides[wizardStep];
  const IntroIcon = intro?.icon;

  return (
    <main className="builder-portal-theme flex min-h-screen items-center justify-center p-4">
      <div className="relative z-10 w-full max-w-2xl animate-in overflow-hidden rounded-2xl border border-border bg-card shadow-2xl duration-300 fade-in zoom-in-95 motion-reduce:animate-none">
        {/* Header */}
        <div className="border-b border-border bg-primary/5 px-6 py-6 text-center md:px-8 md:py-8">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            {isAcknowledgementStep
              ? <Sparkles className="h-7 w-7 text-primary" aria-hidden />
              : IntroIcon ? <IntroIcon className="h-7 w-7 text-primary" aria-hidden /> : null}
          </div>
          <h1 className="text-xl font-bold text-foreground md:text-2xl">
            {isAcknowledgementStep ? 'Prepare your Builder workspace' : intro?.title}
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {isAcknowledgementStep
              ? 'Confirm your organisation, profile, contact and security details before entering the project workspace.'
              : intro?.body}
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-6 md:px-8">
          {error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {isAcknowledgementStep ? (
            <div className="space-y-3">
              {loading ? (
                <div className="space-y-3" role="status" aria-label="Loading onboarding steps">
                  <span className="sr-only">Loading onboarding steps…</span>
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} className="h-20 w-full rounded-xl" aria-hidden />
                  ))}
                </div>
              ) : steps.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                  No onboarding steps are configured. Contact your administrator.
                </p>
              ) : steps.map((step) => {
                const copy = STEP_COPY[step.step_key];
                const StepIcon = copy?.icon ?? CheckCircle2;
                const done = Boolean(step.completed_at);
                return (
                  <label
                    key={step.step_key}
                    htmlFor={`ack-${step.step_key}`}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                      done
                        ? 'border-primary/25 bg-primary/5'
                        : 'border-border/70 bg-muted/20 hover:border-primary/25 hover:bg-primary/5',
                    )}
                  >
                    <Checkbox
                      id={`ack-${step.step_key}`}
                      className="mt-0.5"
                      checked={done || Boolean(checked[step.step_key])}
                      disabled={done}
                      onCheckedChange={(value) =>
                        setChecked((current) => ({ ...current, [step.step_key]: value === true }))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                        <StepIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                        {copy?.label || step.step_key.replace(/_/g, ' ')}
                        {step.mandatory ? (
                          <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                            Required
                          </span>
                        ) : null}
                        {/* State is spelled out, never signalled by tint alone. */}
                        {done ? (
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Confirmed
                          </span>
                        ) : null}
                      </span>
                      {copy?.hint ? (
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {copy.hint}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}

          {/* Progress dots */}
          <div className="flex items-center justify-center gap-2 pt-6" aria-hidden>
            {Array.from({ length: totalSteps }).map((_, index) => (
              <span
                key={index}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300',
                  index === wizardStep ? 'w-8 bg-primary'
                    : index < wizardStep ? 'w-2 bg-primary/40'
                      : 'w-2 bg-muted-foreground/20',
                )}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-6 py-4 md:px-8 md:py-5">
          <Button
            variant="ghost"
            onClick={() => setWizardStep((step) => Math.max(0, step - 1))}
            disabled={wizardStep === 0 || submitting}
          >
            Back
          </Button>
          <p className="hidden text-xs text-muted-foreground sm:block">
            Step {wizardStep + 1} of {totalSteps}
          </p>
          {isAcknowledgementStep ? (
            <Button onClick={() => void handleComplete()} disabled={!ready || submitting} className="gap-2">
              {submitting
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                : <Sparkles className="h-4 w-4" aria-hidden />}
              {submitting ? 'Completing…' : 'Complete onboarding'}
            </Button>
          ) : (
            <Button
              onClick={() => setWizardStep((step) => Math.min(totalSteps - 1, step + 1))}
              disabled={submitting}
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
