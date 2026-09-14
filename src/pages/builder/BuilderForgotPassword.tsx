import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { builderRequestPasswordReset } from '@/lib/builderPortal';

/**
 * Request a Builder Portal password reset code.
 *
 * Mirrors `SolicitorForgotPassword`. The confirmation wording is identical
 * whether or not the address matches an account — the server answers the same
 * way, and this page must not undo that by phrasing success and failure
 * differently.
 */
export default function BuilderForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!email) {
      setError('Enter the email address for your account.');
      return;
    }

    setSubmitting(true);
    const { data, error: requestError } = await builderRequestPasswordReset(email);
    setSubmitting(false);

    // Only a transport or throttling failure is surfaced. An unknown address
    // resolves to the same neutral confirmation as a known one.
    if (requestError && requestError.status !== 200) {
      setError((data as any)?.error || requestError.message);
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <BuilderAuthShell
        title="Check your email"
        description="If that address matches a Builder Portal account, a six-digit code is on its way. The code expires shortly."
        footer={
          <Link to="/builder/login" className="text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="space-y-4">
          <Button
            className="w-full"
            onClick={() => navigate('/builder/reset-password', { state: { email } })}
          >
            I have the code
          </Button>
          <Button variant="outline" className="w-full" onClick={() => setSent(false)}>
            Use a different email address
          </Button>
        </div>
      </BuilderAuthShell>
    );
  }

  return (
    <BuilderAuthShell
      title="Reset your password"
      description="We'll email you a code to confirm it's you."
      footer={
        <Link to="/builder/login" className="text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="builder-reset-email">Email</Label>
          <Input
            id="builder-reset-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@yourcompany.com.au"
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
          {submitting
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            : <Mail className="mr-2 h-4 w-4" aria-hidden />}
          Send reset code
        </Button>
      </form>
    </BuilderAuthShell>
  );
}
