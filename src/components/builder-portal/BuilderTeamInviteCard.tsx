import { FormEvent, useMemo, useState } from 'react';
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
import { builderInviteTeamMember } from '@/lib/builderPortal';

/**
 * Invite a colleague into the ACTIVE organisation — the admin-plane lift's
 * portal surface (network edition, plan §5).
 *
 * Renders only for an owner or administrator; that gate is a journey aid,
 * and `builder-portal-invite` enforces the real one. The response never
 * says whether the address already held an account — the difference is
 * delivered to the mailbox — so this card doesn't either. When mail
 * delivery is unconfigured the server hands back the one-time link and it
 * is shown ONCE, to be passed on out of band.
 */
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

  const membershipRole = useMemo(
    () => organisations.find(
      (organisation) => organisation.organisation_id === activeOrganisation?.organisation_id,
    )?.membership_role ?? null,
    [activeOrganisation?.organisation_id, organisations],
  );

  if (membershipRole !== 'owner' && membershipRole !== 'administrator') return null;

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
    toast({
      title: 'Invitation recorded',
      description: data.email_sent
        ? `An email is on its way to ${email.trim()}.`
        : 'Email delivery is not configured — pass the link on directly.',
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
          Give someone at {activeOrganisation?.legal_name ?? 'your organisation'} their own
          sign-in. They set their password from the emailed link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
