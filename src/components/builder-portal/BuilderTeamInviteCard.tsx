import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import {
  type BuilderDeliveryState,
  builderInviteDeliveryHealth,
  builderInviteTeamMember,
} from '@/lib/builderPortal';

/**
 * Invite a colleague into the ACTIVE organisation — the admin-plane lift's
 * portal surface (network edition, plan §5).
 *
 * Renders only for an owner or administrator; that gate is a journey aid,
 * and `builder-portal-invite` enforces the real one. The response never
 * says whether the address already held an account — the difference is
 * delivered to the mailbox — so this card doesn't either. Nor whether an
 * email left: that answer differed for an account an operator had revoked,
 * which made it the tell, so the server no longer gives it. When mail
 * delivery is unconfigured the server hands back the one-time link and it
 * is shown ONCE, to be passed on out of band.
 *
 * What it CAN say is whether email is leaving at all (doc 68): one reading
 * for the whole deployment, from a check sent to a sink that belongs to
 * nobody — and whether THIS organisation's own invitation emails were held
 * back because too many were sent at once. It never names an invitation, an
 * address or a message. It is read again after each invitation is recorded,
 * so a burst shows what it caused.
 */

/** What an administrator is told, for the readings that need telling. */
const DELIVERY_NOTICE: Partial<Record<BuilderDeliveryState, { tone: 'default' | 'destructive'; text: string }>> = {
  degraded: {
    tone: 'destructive',
    text: 'Email delivery is not working across the portal right now. Invitations are still recorded — '
      + 'once it recovers, invite the same address again and the invitation is sent again.',
  },
  held_back: {
    tone: 'default',
    text: 'Some of your organisation\'s recent invitation emails were held back because too many were sent at once. '
      + 'If an invitation has not arrived, invite the same address again in a few minutes.',
  },
  delayed: {
    tone: 'default',
    text: 'Emails are queued across the portal at the moment, so an invitation may take a few minutes to arrive.',
  },
  not_configured: {
    tone: 'default',
    text: 'Email is not configured on this deployment, so each invitation link is shown to you to pass on.',
  },
};
const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'manager', label: 'Manager' },
  { value: 'administrator', label: 'Administrator' },
  { value: 'read_only', label: 'Read only' },
];

export function BuilderTeamInviteCard() {
  const { activeOrganisation, organisations } = useBuilderPortalAuth();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<BuilderDeliveryState | null>(null);

  const membershipRole = useMemo(
    () => organisations.find(
      (organisation) => organisation.organisation_id === activeOrganisation?.organisation_id,
    )?.membership_role ?? null,
    [activeOrganisation?.organisation_id, organisations],
  );

  const mayInvite = membershipRole === 'owner' || membershipRole === 'administrator';

  // Set on every mount, so a remount (StrictMode's included) reads again.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Only the latest read is shown: the held-back half is about the ACTIVE
  // organisation, so an answer overtaken by a switch must not land.
  const latestRead = useRef(0);
  const readDelivery = useCallback(() => {
    const ticket = ++latestRead.current;
    void builderInviteDeliveryHealth().then(({ data }) => {
      if (mounted.current && ticket === latestRead.current && data?.success && data.delivery) {
        setDelivery(data.delivery.state);
      }
    });
  }, []);

  const activeOrganisationId = activeOrganisation?.organisation_id;
  useEffect(() => {
    setDelivery(null);
    if (mayInvite && activeOrganisationId) readDelivery();
  }, [mayInvite, activeOrganisationId, readDelivery]);

  if (!mayInvite) return null;
  const deliveryNotice = delivery ? DELIVERY_NOTICE[delivery] : undefined;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFallbackUrl(null);
    if (!name.trim()) return setError("Enter your colleague's name.");
    if (!email.trim()) return setError('Enter their email address.');

    setSubmitting(true);
    const { data, error: requestError } = await builderInviteTeamMember({
      name: name.trim(),
      email: email.trim(),
      membership_role: role,
    });
    setSubmitting(false);

    if (requestError || !data?.success) {
      setError(requestError?.message || 'The invitation could not be sent.');
      return;
    }
    if (data.invite_url) setFallbackUrl(data.invite_url);
    // Read again, so an invitation that joined a burst says so here.
    readDelivery();
    // One sentence for every address that can reach this line: whether the
    // link came back depends on the deployment, never on the person.
    toast({
      title: 'Invitation recorded',
      description: data.invite_url
        ? 'Email delivery is not configured — pass the link on directly.'
        : `If ${email.trim()} can be invited to ${activeOrganisation?.legal_name ?? 'your organisation'}, they'll get an email asking them to accept.`,
    });
    setName('');
    setEmail('');
    setRole('member');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4 text-primary" aria-hidden />
          Invite a colleague
        </CardTitle>
        <CardDescription>
          Invite someone to {activeOrganisation?.legal_name ?? 'your organisation'}. They join
          when they accept the emailed invitation — a new colleague sets a password there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {deliveryNotice && (
            <Alert variant={deliveryNotice.tone}>
              <AlertDescription>{deliveryNotice.text}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {fallbackUrl && (
            <Alert>
              <AlertDescription className="break-all">
                Share this one-time link — it is shown only now:{' '}
                <span className="font-mono text-xs">{fallbackUrl}</span>
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="builder-invite-name">Name</Label>
              <Input
                id="builder-invite-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="builder-invite-email">Email</Label>
              <Input
                id="builder-invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="builder-invite-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="builder-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Ownership is not grantable here — transferring control is a
                different act with its own ceremony.
              </p>
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={submitting} aria-busy={submitting} className="w-full sm:w-auto">
                {submitting
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Sending…</>
                  : 'Send invitation'}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
