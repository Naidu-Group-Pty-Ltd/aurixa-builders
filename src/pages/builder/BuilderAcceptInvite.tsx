import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { builderValidateInvite } from '@/lib/builderPortal';

interface InviteDetails {
  email: string;
  name: string | null;
  job_title: string | null;
  organisations: { organisation_id: string; legal_name: string; membership_role: string }[];
}

/**
 * Builder / Developer Portal invite acceptance.
 *
 * Mirrors `SolicitorAcceptInvite`. The token is validated server-side before the
 * form appears, and validated again on submission — this page rendering a form
 * is never what authorises activation. Every rejection reason renders the same
 * message, matching the single generic error the server returns.
 */
export default function BuilderAcceptInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const { acceptInvite } = useBuilderPortalAuth();

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setChecking(false);
      setError('This invitation link is invalid or has expired.');
      return () => { cancelled = true; };
    }

    void builderValidateInvite(token).then(({ data, error: validateError }) => {
      if (cancelled) return;
      if (validateError || !data?.valid) {
        setError('This invitation link is invalid or has expired.');
      } else {
        setInvite(data as InviteDetails);
      }
      setChecking(false);
    });

    return () => { cancelled = true; };
  }, [token]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const result = await acceptInvite(token, password);
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    // Activation signs the user in, so the gate takes over from here and routes
    // them to terms or onboarding as required.
    navigate('/builder', { replace: true });
  };

  if (checking) {
    return (
      <BuilderAuthShell title="Checking your invitation">
        <div className="flex justify-center py-6" role="status" aria-label="Checking your invitation">
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderAuthShell>
    );
  }

  if (!invite) {
    return (
      <BuilderAuthShell
        title="Invitation unavailable"
        footer={
          <Link to="/builder/login" className="text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        }
      >
        <Alert variant="destructive">
          <AlertDescription>
            {error || 'This invitation link is invalid or has expired.'} Ask your administrator to
            send a new invitation.
          </AlertDescription>
        </Alert>
      </BuilderAuthShell>
    );
  }

  return (
    <BuilderAuthShell
      title="Set up your account"
      description={`Choose a password for ${invite.email}.`}
      footer={
        <Link to="/builder/login" className="text-primary underline-offset-4 hover:underline">
          Already have an account? Sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {invite.organisations.length > 0 ? (
          <div className="rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm">
            <p className="font-medium text-foreground">You will be joining</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {invite.organisations.map((organisation) => (
                <li key={organisation.organisation_id}>
                  {organisation.legal_name} · {organisation.membership_role.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>Use a password you do not use for any other system.</span>
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-invite-password">Password</Label>
          <PasswordInput
            id="builder-invite-password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="builder-invite-password-hint"
          />
          <p id="builder-invite-password-hint" className="text-xs text-muted-foreground">
            At least 8 characters, using two or more of: lowercase, uppercase, numbers, symbols.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-invite-confirm">Confirm password</Label>
          <PasswordInput
            id="builder-invite-confirm"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
          Activate account
        </Button>
      </form>
    </BuilderAuthShell>
  );
}
