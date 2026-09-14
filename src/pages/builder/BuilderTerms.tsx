import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HardHat } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBrand } from '@/branding/useBrand';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { PortalAgreementConsent } from '@/components/portal/PortalAgreementConsent';
import type { PortalAcknowledgementKey } from '@/lib/portalAgreement';
import { builderLoadGovernance, type BuilderTermsVersion } from '@/lib/builderPortal';

/**
 * Builder / Developer Portal terms and project-data consent.
 *
 * The agreement is the Portal Access, Confidentiality, Privacy and AML/CTF
 * Compliance Passport Agreement — the same document the Solicitor and Finance
 * portals present, published as this portal's own version row so it carries its
 * own hash and its own acceptance history. The wall itself is
 * `PortalAgreementConsent`, shared with those portals; this page keeps only the
 * Builder chrome and where the acceptance goes.
 *
 * Acceptance is recorded server-side against the exact terms version that was
 * served, for the authenticated user: this page cannot nominate whose
 * acceptance is being recorded, nor which version it is against.
 *
 * The four acknowledgments are not a second contract, but they are not
 * decoration either — the server refuses an acceptance that does not assert all
 * four, and stores the ones asserted. `acceptTerms()` remains the single
 * authoritative acceptance call, made once, and the page only leaves for the
 * portal when it succeeds. Where it goes next is unchanged: `/builder`, which
 * the governance guard sends on to onboarding when onboarding is outstanding —
 * this page never bypasses that.
 *
 * BRANDING. The company name is the configured white-label operator. The active
 * organisation is shown beside it as context, never in place of it.
 */
export default function BuilderTerms() {
  const { acceptTerms, activeOrganisation } = useBuilderPortalAuth();
  const { settings: brandSettings } = useBrand();
  const navigate = useNavigate();

  const [terms, setTerms] = useState<BuilderTermsVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const companyName = (brandSettings.companyName || '').trim() || 'the Operator';
  const organisationName = activeOrganisation
    ? activeOrganisation.trading_name || activeOrganisation.legal_name
    : null;

  useEffect(() => {
    let cancelled = false;

    void builderLoadGovernance().then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) setError(loadError.message);
      setTerms(data?.terms ?? null);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  const handleAccept = async (acknowledgements: PortalAcknowledgementKey[]) => {
    setError(null);
    setSubmitting(true);
    const result = await acceptTerms(acknowledgements);
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    navigate('/builder', { replace: true });
  };

  return (
    <main className="builder-portal-theme flex min-h-screen items-center justify-center p-4">
      <div className="relative z-10 w-full max-w-3xl animate-in overflow-hidden rounded-2xl border border-border bg-card shadow-2xl duration-300 fade-in zoom-in-95 motion-reduce:animate-none">
        {/* Header */}
        <div className="border-b border-border bg-primary/5 px-6 py-6 md:px-8 md:py-8">
          <div className="mb-3 flex items-center gap-3">
            <div className="rounded-xl bg-primary/10 p-2.5">
              <HardHat className="h-6 w-6 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-foreground md:text-2xl">
                Terms &amp; Privileged Data Consent
              </h1>
              <p className="truncate text-sm text-muted-foreground">
                {companyName} · Builder / Developer Portal
                {organisationName ? ` · ${organisationName}` : ''}
              </p>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Before accessing projects, inventory, transactions, construction records and shared
            documents, review and accept the current portal terms. Your acceptance is recorded
            against this exact version.
          </p>
        </div>

        <div className="space-y-6 px-6 py-5 md:px-8 md:py-6">
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <PortalAgreementConsent
            terms={terms}
            loading={loading}
            busy={submitting}
            onAccept={(acknowledgements) => void handleAccept(acknowledgements)}
          />
        </div>
      </div>
    </main>
  );
}
