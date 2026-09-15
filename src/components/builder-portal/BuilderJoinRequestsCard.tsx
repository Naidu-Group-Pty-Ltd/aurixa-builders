import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, UserCheck, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import {
  BuilderOrgJoinRequest, builderDecideJoinRequest, builderListJoinRequests,
} from '@/lib/builderPortal';

/**
 * Pending requests to join the ACTIVE organisation — the deciding half of
 * registration's never-auto-join rule. A registrant whose ABN matched this
 * organisation got a pending request, no membership and no data; this card
 * is where an owner or administrator decides it.
 *
 * Renders only for an owner or administrator, like the invite card beside
 * it; that gate is a journey aid and `builder-portal-invite` enforces the
 * real one. Renders nothing at all while the queue is empty — an empty
 * approvals inbox is not information worth a card.
 */
export function BuilderJoinRequestsCard() {
  const { activeOrganisation, organisations } = useBuilderPortalAuth();
  const { toast } = useToast();
  const [requests, setRequests] = useState<BuilderOrgJoinRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const membershipRole = organisations.find(
    (organisation) => organisation.organisation_id === activeOrganisation?.organisation_id,
  )?.membership_role ?? null;
  const canDecide = membershipRole === 'owner' || membershipRole === 'administrator';

  const refresh = useCallback(async () => {
    const { data, error: requestError } = await builderListJoinRequests();
    if (requestError || !data?.success) {
      setError(requestError?.message || 'Join requests could not be read.');
    } else {
      setError(null);
      setRequests(data.join_requests ?? []);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!canDecide || !activeOrganisation) return;
    setLoaded(false);
    void refresh();
  }, [canDecide, activeOrganisation, refresh]);

  if (!canDecide) return null;
  if (loaded && !error && requests.length === 0) return null;

  const decide = async (request: BuilderOrgJoinRequest, approve: boolean) => {
    setDecidingId(request.id);
    const { data, error: decideError } = await builderDecideJoinRequest(request.id, approve);
    setDecidingId(null);
    if (decideError || !data?.success) {
      toast({
        title: 'The decision could not be recorded',
        description: decideError?.message || 'Try again shortly.',
        variant: 'destructive',
      });
      // Someone else may have decided it moments ago — re-read either way.
      void refresh();
      return;
    }
    toast({
      title: approve ? 'Request approved' : 'Request declined',
      description: approve
        ? `${request.requester?.name ?? 'The requester'} is now a member. They have been emailed.`
        : 'No membership was granted. The requester has been emailed.',
    });
    void refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="h-4 w-4 text-primary" aria-hidden />
          Requests to join
        </CardTitle>
        <CardDescription>
          People who registered claiming {activeOrganisation?.legal_name ?? 'your organisation'}.
          Nobody joins on an ABN match alone — you decide.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!loaded && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </div>
        )}
        {requests.map((request) => (
          <div
            key={request.id}
            className="flex flex-col gap-3 rounded-lg border border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {request.requester?.name ?? 'Unknown registrant'}
                {request.requester && !request.requester.email_verified && (
                  <Badge variant="outline" className="ml-2 align-middle">
                    email unverified
                  </Badge>
                )}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {request.requester?.email ?? '—'} · asked{' '}
                {new Date(request.created_at).toLocaleDateString('en-AU')}
              </p>
              {request.message && (
                <p className="mt-1 text-xs text-muted-foreground">{request.message}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                disabled={decidingId === request.id}
                aria-busy={decidingId === request.id}
                onClick={() => void decide(request, true)}
              >
                {decidingId === request.id
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  : <Check className="mr-1 h-4 w-4" aria-hidden />}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decidingId === request.id}
                onClick={() => void decide(request, false)}
              >
                <X className="mr-1 h-4 w-4" aria-hidden />
                Decline
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
