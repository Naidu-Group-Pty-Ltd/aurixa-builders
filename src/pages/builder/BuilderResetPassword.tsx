import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { OtpInput } from '@/components/finance-portal/OtpInput';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { builderResetPassword, builderVerifyResetCode } from '@/lib/builderPortal';

/**
 * Complete a Builder Portal password reset.
 *
 * Mirrors the `verify` and `reset` steps of `SolicitorLogin`, on their own
 * route. Both steps are re-checked server-side: passing the code step here does
 * not authorise the reset, because the reset call re-consumes and re-validates
 * the code against the stored hash.
 */
type Step = 'verify' | 'reset';

export default function BuilderResetPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefilledEmail = (location.state as { email?: string } | null)?.email ?? '';

  const [step, setStep] = useState<Step>('verify');
  const [email, setEmail] = useState(prefilledEmail);
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleVerify = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!email) return setError('Enter the email address for your account.');
    if (otp.length !== 6) return setError('Enter the six-digit code from your email.');

    setSubmitting(true);
    const { data, error: verifyError } = await builderVerifyResetCode(email, otp);
    setSubmitting(false);

    if (verifyError || !data?.success) {
      setError((data as any)?.error || verifyError?.message || 'Invalid or expired code');
      return;
    }
    setStep('reset');
  };

  const handleReset = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) return setError('Passwords do not match.');

    setSubmitting(true);
    const { data, error: resetError } = await builderResetPassword(email, otp, newPassword);
    setSubmitting(false);

    if (resetError || !data?.success) {
      setError((data as any)?.error || resetError?.message || 'Could not reset your password');
      return;
    }
    // A reset does not sign the user in — every session was revoked with the old
    // password, so they return to the sign-in page.
    navigate('/builder/login', {
      replace: true,
      state: { notice: 'Your password has been reset. Please sign in.' },
    });
  };

  return (
    <BuilderAuthShell
      title={step === 'verify' ? 'Verify your identity' : 'Choose a new password'}
      description={
        step === 'verify'
          ? 'Enter the six-digit code we emailed you.'
          : 'Signing in on your other devices will require the new password.'
      }
      footer={
        <Link to="/builder/login" className="text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {step === 'verify' ? (
        <form onSubmit={handleVerify} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="builder-otp-email">Email</Label>
            <Input
              id="builder-otp-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="space-y-3">
            <Label className="block text-center">Verification code</Label>
            <OtpInput value={otp} onChange={setOtp} length={6} disabled={submitting} />
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || otp.length < 6}
            aria-busy={submitting}
          >
            {submitting
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              : <KeyRound className="mr-2 h-4 w-4" aria-hidden />}
            Verify code
          </Button>
        </form>
      ) : (
        <form onSubmit={handleReset} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="builder-new-password">New password</Label>
            <PasswordInput
              id="builder-new-password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              aria-describedby="builder-password-hint"
            />
            <p id="builder-password-hint" className="text-xs text-muted-foreground">
              At least 8 characters, using two or more of: lowercase, uppercase, numbers, symbols.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="builder-confirm-password">Confirm new password</Label>
            <PasswordInput
              id="builder-confirm-password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>

          <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            Set password
          </Button>
        </form>
      )}
    </BuilderAuthShell>
  );
}
