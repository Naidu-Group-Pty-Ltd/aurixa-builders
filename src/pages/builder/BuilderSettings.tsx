import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MonitorSmartphone, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import {
  builderListSessions, builderRevokeOtherSessions, builderRevokeSession,
} from '@/lib/builderPortal';
import { BuilderPreferencesCard } from '@/components/builder-portal/BuilderPreferencesCard';
import {
  BuilderOrganisationSettingsCard,
} from '@/components/builder-portal/BuilderOrganisationSettingsCard';
import { BUILDER_TOUR_EVENT } from '@/components/builder-portal/BuilderOnboardingTour';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';

/**
 * Builder / Developer Portal account and session settings.
 *
 * Mirrors `SolicitorSecurity` and adds the read-only profile summary. Every
 * mutation is scoped server-side to the caller's own sessions, so a forged
 * session id belonging to another user matches no row.
 */
interface BuilderSessionRow {
  id: string;
  device_label: string | null;
  created_at: string;
  last_used_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export default function BuilderSettings() {
  const { user, activeOrganisation, organisations, refresh } = useBuilderPortalAuth();

  const [sessions, setSessions] = useState<BuilderSessionRow[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await builderListSessions();
    if (loadError) setError(loadError.message);
    else setError(null);
    setSessions((data as any)?.sessions ?? []);
    setCurrentSessionId((data as any)?.current_session_id ?? null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revokeOne = async (sessionId: string) => {
    setBusyId(sessionId);
    const { error: revokeError } = await builderRevokeSession(sessionId);
    setBusyId(null);
    if (revokeError) {
      setError(revokeError.message);
      await load();
      return;
    }
    // Revoking the session you are using clears the cookie server-side. Re-read
    // through the provider so the gate sends this tab to the sign-in page rather
    // than leaving a signed-out user on a stale screen.
    if (sessionId === currentSessionId) {
      await refresh();
      return;
    }
    await load();
  };

  const revokeOthers = async () => {
    setBusyId('others');
    const { error: revokeError } = await builderRevokeOtherSessions();
    setBusyId(null);
    if (revokeError) setError(revokeError.message);
    await load();
  };

  const active = sessions.filter((session) => !session.revoked_at);

  return (
    <BuilderPortalShell
      title="Settings"
      description="Your account, your preferences, your organisation's settings and the devices signed into the Builder Portal."
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <p className="text-sm text-muted-foreground">
            Your administrator maintains these details. Contact them to change anything here.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Name</p>
            <p className="text-sm text-foreground">{user?.name || '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Email</p>
            <p className="truncate text-sm text-foreground">{user?.email || '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Job title</p>
            <p className="text-sm text-foreground">{user?.job_title || '—'}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Phone</p>
            <p className="text-sm text-foreground">{user?.phone || '—'}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Organisations</p>
            <p className="text-sm text-foreground">
              {organisations.length === 0
                ? '—'
                : organisations
                    .map((organisation) => organisation.trading_name || organisation.legal_name)
                    .join(', ')}
            </p>
            {activeOrganisation ? (
              <p className="mt-1 text-xs text-muted-foreground">
                This session is acting as{' '}
                {activeOrganisation.trading_name || activeOrganisation.legal_name}.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <BuilderPreferencesCard />

      <BuilderOrganisationSettingsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Password</CardTitle>
          <p className="text-sm text-muted-foreground">
            Changing your password signs you out of every other device.
          </p>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/builder/change-password">Change password</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle className="h-4 w-4 text-primary" aria-hidden /> Portal help
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Replay the guided tour of the portal at any time.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => window.dispatchEvent(new CustomEvent(BUILDER_TOUR_EVENT))}
          >
            <PlayCircle className="h-4 w-4" aria-hidden /> Replay portal tour
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signed-in devices</CardTitle>
          <p className="text-sm text-muted-foreground">
            Revoke anything you do not recognise. Revoking ends that session immediately.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex justify-center py-6" role="status" aria-label="Loading devices">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
            </div>
          ) : null}

          {!loading && sessions.length === 0 ? (
            <p className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
              No session history is available.
            </p>
          ) : null}

          {sessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            return (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-4"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <MonitorSmartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    {/* A div, not a p: Badge renders a div, and a div inside a
                        p is invalid HTML that the browser silently reflows. */}
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      <span className="truncate">{session.device_label || 'Unknown device'}</span>
                      {isCurrent ? <Badge variant="outline">This device</Badge> : null}
                      {session.revoked_at ? <Badge variant="secondary">Revoked</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last used {new Date(session.last_used_at).toLocaleString('en-AU')}
                      {session.revoked_at ? ` · ${session.revoked_reason || 'revoked'}` : ''}
                    </p>
                  </div>
                </div>
                {session.revoked_at ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => void revokeOne(session.id)}
                  >
                    {busyId === session.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    ) : null}
                    {isCurrent ? 'Sign out this device' : 'Revoke'}
                  </Button>
                )}
              </div>
            );
          })}

          {active.length > 1 ? (
            <Button
              variant="outline"
              disabled={busyId !== null}
              onClick={() => void revokeOthers()}
            >
              {busyId === 'others' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              Revoke all other devices
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </BuilderPortalShell>
  );
}
