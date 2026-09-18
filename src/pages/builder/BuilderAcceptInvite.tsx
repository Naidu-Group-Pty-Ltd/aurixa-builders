import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
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
 *
 * ## Activation and sign-in are two acts, and the second one may lawfully fail
 *
 * MEASURED 18 SEPTEMBER 2026. An invite is legitimately issued ahead of the
 * organisation going live — that is the whole point of the approval flow, and
 * `builder-portal-accept-invite` says so in its own header. The organisation
 * gate applies at LOGIN, not at activation. But the function then asked for a
 * session unconditionally, `builder_issue_session` refused
 * (`P0001 BUILDER_SESSION_NOT_PERMITTED`) because
 * `builder_accessible_organisations` returns nothing while the organisation is
 * `pending_activation`, and the whole request answered **500 Internal server
 * error** — AFTER the activation UPDATE had already committed.
 *
 * So the worst reading was the one the applicant got: the password WAS set,
 * the invite WAS spent, and the screen said the server had broken. Re-trying
 * the link then failed as a spent token, which reads as a second, unrelated
 * fault.
 *
 * Two rules follow, and this page carries the second.
 *
 *  * **Activation succeeding is not sign-in succeeding.** The server now
 *    returns `signed_in: false` with the reason rather than throwing, so the
 *    act that completed is reported as completed.
 *
 *  * **A completed act is never rendered as a failure.** `pending` is drawn as
 *    a SUCCESS state — the account is ready, and what remains is somebody
 *    else's approval, not anything the applicant can do or did wrong. Routing
 *    to `/builder` here would bounce off the same gate and land them on the
 *    login page with no explanation at all.
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
  const [pending, setPending] = useState<{ code: string; message: string } | null>(null);

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

    if (result.pending) {
      // The account is live and the password is set; the organisation is not
      // approved yet, so there is no session to route with. Say so here rather
      // than navigating into a gate that would answer with a login page.
      setPending(result.pending);
      return;
    }

    // Activation signed the user in, so the gate takes over from here and routes
    // them to terms or onboarding as required.
    navigate('/builder', { replace: true });
  };

  if (pending) {
    return (
      <BuilderAuthShell
        title="Your account is ready"
        footer={
          <Link to="/builder/login" className="text-primary underline-offset-4 hover:underline">
            Go to sign in
          </Link>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Your password is set and your invitation is complete.
              </p>
              <p className="text-muted-foreground">{pending.message}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            You do not need this invitation link again, and nothing further is needed from you.
            Sign in with {invite?.email ?? 'your email address'} once you hear that the registration
            has been approved.
          </p>
        </div>
      </BuilderAuthShell>
    );
  }

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
