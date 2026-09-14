import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';

/**
 * Choose which organisation this session operates as.
 *
 * The Solicitor Portal has no counterpart: a solicitor belongs to exactly one
 * firm, so its session never needs an organisation context. Phase 1 allows a
 * Builder user to hold memberships in several organisations, so the session
 * carries an explicit active organisation and the gate stops here until one is
 * chosen.
 *
 * The list is entirely server-resolved. Selecting an entry sends a request that
 * the server re-verifies against live membership before writing it to the
 * session row, so this page cannot widen anyone's access.
 */
export default function BuilderSelectOrganisation() {
  const { organisations, activeOrganisation, selectOrganisation, signOut } = useBuilderPortalAuth();
  const navigate = useNavigate();

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectable = organisations;

  const handleSelect = async (organisationId: string) => {
    setError(null);
    setPendingId(organisationId);
    const result = await selectOrganisation(organisationId);
    setPendingId(null);

    if (result.error) {
      setError(result.error);
      return;
    }
    navigate('/builder', { replace: true });
  };

  return (
    <BuilderAuthShell
      title="Choose an organisation"
      description="Your session operates as one organisation at a time. You can switch later from the portal header."
      footer={
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-primary underline-offset-4 hover:underline"
        >
          Sign out
        </button>
      }
    >
      <div className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {selectable.length === 0 ? (
          <Alert>
            <AlertDescription>
              None of your organisations are available yet. Contact your administrator if you
              believe this is a mistake.
            </AlertDescription>
          </Alert>
        ) : null}

        <ul className="space-y-3">
          {selectable.map((organisation) => {
            const isActive = organisation.organisation_id === activeOrganisation?.organisation_id;
            const isPending = pendingId === organisation.organisation_id;

            return (
              <li key={organisation.organisation_id}>
                <button
                  type="button"
                  onClick={() => void handleSelect(organisation.organisation_id)}
                  disabled={pendingId !== null}
                  aria-current={isActive ? 'true' : undefined}
                  className="flex w-full items-start gap-3 rounded-xl border border-border/60 bg-card/60 p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
                    {isPending
                      ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
                      : <Building2 className="h-4 w-4 text-primary" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {organisation.trading_name || organisation.legal_name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {organisation.membership_role.replace(/_/g, ' ')}
                      {' · '}
                      {organisation.org_type.replace(/_/g, ' ')}
                    </span>
                  </span>
                  {organisation.is_primary ? (
                    <Badge variant="outline" className="shrink-0">Primary</Badge>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        {selectable.length === 0 ? (
          <Button variant="outline" className="w-full" onClick={() => void signOut()}>
            Sign out
          </Button>
        ) : null}
      </div>
    </BuilderAuthShell>
  );
}
