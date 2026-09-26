import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import {
  ActivationContact, ActivationProjectLink, ActivationStatusBadge,
} from '@/components/builder-portal/StockActivation';
import { StockPicture } from '@/components/stock/StockPicture';
import { builderStockImageUrl, useBuilderActivatedProperties } from '@/lib/builderStockQueries';
import { isDisplayableSourceImage, type BuilderStockImage } from '@/lib/builderStock';
import {
  activatedPropertyLocality, activatedPropertyTitle, agencyLabel, accessRefused,
  type ActivatedProperty,
} from '@/lib/builderAgency';

/**
 * Builder Portal — Agency Activations.
 *
 * The properties connected agencies have activated from this organisation's
 * stock list, with the agency, its contact, the acknowledgement and — where
 * the builder already has project access — the project it opened. Nothing
 * else: the conversations about those properties live on the Messages page,
 * which is the portal's one home for messaging.
 *
 * Nothing here is a second record. The activations are the ones the network
 * sweep converged; the page reads them through `list_activated_properties`,
 * which pins every row to the session's organisation and withholds what the
 * builder was never told (who the agency's client is).
 */
export default function BuilderAgencyActivations() {
  const query = useBuilderActivatedProperties(1);
  const records = query.data?.records ?? [];
  const status = (query.error as { status?: number } | null)?.status;
  const denied = status === 403;
  // A refusal withdraws what was read; any other failure keeps it.
  const refused = accessRefused(query.error);

  return (
    <BuilderPortalShell
      title="Agency Activations"
      description="The properties connected agencies have activated from your stock list, with each agency's contact. Your conversations with them are in Messages."
      actions={(
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      )}
    >
      {/* A read that fails blocks the page only when nothing was read: a
          failed refresh keeps what was read, which is still true and may
          just be behind. */}
      {query.isLoading ? <Loading /> : query.error && (!query.data || refused) ? (
        <ReadFailure denied={denied} onRetry={() => void query.refetch()} />
      ) : (
        <div className="space-y-3">
          {query.error ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              <span>Your activations could not be refreshed. This is the list as last read.</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button>
            </div>
          ) : null}
          <ActivatedPropertiesList records={records} />
        </div>
      )}
    </BuilderPortalShell>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Loading your activations…
    </p>
  );
}

function ReadFailure({ denied, onRetry }: { denied: boolean; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 py-6">
        <ShieldAlert className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
        {denied ? (
          <p className="text-sm text-muted-foreground">
            You do not have access to your organisation&apos;s activations. An administrator of your
            organisation can grant it.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your activations could not be loaded just now. Nothing has changed — try again shortly.
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The property's photograph by the Stock List's own rule, or none. */
function activationImage(record: ActivatedProperty): BuilderStockImage | null {
  const image = record.primary_image as BuilderStockImage | null;
  return image && isDisplayableSourceImage(image) ? image : null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-AU') : '');

function ActivatedPropertiesList({ records }: { records: ActivatedProperty[] }) {
  if (!records.length) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          No agency has activated any of your properties yet. When a connected agency activates a
          property from your stock list, it appears here with the agency&apos;s contact.
        </CardContent>
      </Card>
    );
  }
  return (
    <ul className="space-y-4" aria-label="Activated properties">
      {records.map((record) => {
        const title = activatedPropertyTitle(record.property);
        const locality = activatedPropertyLocality(record.property);
        return (
          <li key={record.id} className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <StockPicture
              image={activationImage(record)}
              resolveUrl={builderStockImageUrl}
              className="rounded-md"
              alt={`${title} — the picture shown on the marketplace`}
              emptyLabel="No picture yet"
            />
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-foreground">{title}</h2>
                  {locality ? <p className="text-sm text-muted-foreground">{locality}</p> : null}
                </div>
                <ActivationStatusBadge status={record.status} />
              </div>
              {record.property?.house_design ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">Design </span>
                  <span className="font-medium text-foreground">{record.property.house_design}</span>
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Activated {when(record.activated_at)} by{' '}
                <span className="font-medium text-foreground">{agencyLabel(record.agency)}</span>
                {record.agency.name && record.agency.workspace_label ? (
                  <span> · via {record.agency.workspace_label}</span>
                ) : null}
              </p>
              <ActivationContact activation={record.agency} />
              {record.acknowledged_at ? (
                <p className="text-xs text-muted-foreground">
                  You acknowledged this {when(record.acknowledged_at)}
                  {record.acknowledged_by_name ? ` — ${record.acknowledged_by_name}` : ''}
                </p>
              ) : null}
              <ActivationProjectLink projectId={record.project?.accessible ? record.project.id : null} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

