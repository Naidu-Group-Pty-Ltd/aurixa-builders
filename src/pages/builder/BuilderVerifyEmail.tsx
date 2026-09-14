import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { builderResendVerificationEmail, builderVerifyEmail } from '@/lib/builderPortal';

/**
 * Email verification (network edition) — one page, two postures.
 *
 * With `?token=…` it consumes the emailed link, in whatever browser it was
 * opened in: no session is required, which is why this route lives OUTSIDE
 * the protected tree. Without a token it is the governance stage's landing —
 * the signed-in, still-unverified user the route guard sends here — offering
 * a resend and nothing else, because nothing else is open yet.
 *
 * The failure wording never distinguishes unknown, consumed and expired
 * beyond what the server volunteers: a token is a secret, and this page must
 * not become the oracle the endpoint refuses to be.
 */
export default function BuilderVerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [state, setState] = useState<'idle' | 'verifying' | 'verified' | 'failed'>(
    token ? 'verifying' : 'idle',
  );
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const consumedRef = useRef(false);

  useEffect(() => {
    if (!token || consumedRef.current) return;
    // A React 18 dev double-mount would consume the single-use token twice
    // and report the second attempt as a failure the user never caused.
    consumedRef.current = true;
    (async () => {
      const { data, error } = await builderVerifyEmail(token);
      if (data?.verified || data?.already_verified) {
        setState('verified');
        return;
      }
      setFailureMessage(error?.message || 'The verification link is invalid or has expired.');
      setState('failed');
    })();
  }, [token]);

  const handleResend = async (event: FormEvent) => {
    event.preventDefault();
    setResendError(null);
    setResending(true);
    const { data, error } = await builderResendVerificationEmail();
    setResending(false);
    if (data?.already_verified) {
      setState('verified');
      return;
    }
    if (data?.sent) {
      setResent(true);
      return;
    }
    // A resend needs a session; the emailed-link posture may not have one.
    setResendError(
      error?.message
      || 'A new link could not be sent. If you are not signed in, sign in first — the portal will bring you back here.',
    );
  };

  if (state === 'verifying') {
    return (
      <BuilderAuthShell title="Verifying your email" description="One moment…">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
        </div>
      </BuilderAuthShell>
    );
  }

  if (state === 'verified') {
    return (
      <BuilderAuthShell
        title="Email verified"
        description="Your address is confirmed."
      >
        <div className="space-y-5">
          <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
            <CheckCircle2 className="h-6 w-6 shrink-0 text-success" aria-hidden />
            <p className="text-sm text-muted-foreground">
              Thanks — your email address is verified. Sign in to continue setting
              up your organisation.
            </p>
          </div>
          <Button asChild className="w-full">
            <Link to="/builder/login">Continue to sign in</Link>
          </Button>
        </div>
      </BuilderAuthShell>
    );
  }

  return (
    <BuilderAuthShell
      title={state === 'failed' ? 'Verification did not complete' : 'Verify your email'}
      description={
        state === 'failed'
          ? undefined
          : 'Your account is waiting on one thing: proof of your email address.'
      }
      footer={
        <p className="text-sm text-muted-foreground">
          Wrong account?{' '}
          <Link to="/builder/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <div className="space-y-5">
        {state === 'failed' && failureMessage && (
          <Alert variant="destructive">
            <AlertDescription>{failureMessage}</AlertDescription>
          </Alert>
        )}
        {resent ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
            <MailCheck className="h-6 w-6 shrink-0 text-primary" aria-hidden />
            <p className="text-sm text-muted-foreground">
              A fresh verification email is on its way. The link in it replaces
              every earlier one.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              We sent a verification link to your email address when you
              registered. Open it on any device — or request a fresh one below.
            </p>
            {resendError && (
              <Alert variant="destructive">
                <AlertDescription>{resendError}</AlertDescription>
              </Alert>
            )}
            <form onSubmit={handleResend}>
              <Button type="submit" className="w-full" disabled={resending} aria-busy={resending}>
                {resending
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Sending…</>
                  : 'Send a new verification email'}
              </Button>
            </form>
          </>
        )}
      </div>
    </BuilderAuthShell>
  );
}
