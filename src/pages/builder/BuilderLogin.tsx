import { FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { TurnstileWidget } from '@/components/auth/TurnstileWidget';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { safeReturnTo } from '@/lib/aml/partnerPortalHandoff';

/**
 * Builder / Developer Portal sign-in.
 *
 * The chrome — split layout, branded panel, operator identity, value points and
 * responsive collapse — now belongs to `BuilderAuthShell`, which every Builder
 * authentication surface shares. Sign-in therefore cannot drift from invite
 * acceptance, password reset, rotation or organisation selection, and the panel
 * is written once rather than six times.
 *
 * Branding is the configured white-label identity on the `auth` slot; nothing
 * about the operator is decided in this file.
 *
 * The reset journey stays on its own routes (`/builder/forgot-password`,
 * `/builder/reset-password`) rather than being mode-switched inside this
 * component, which is why the link below is a `Link` and not a mode toggle.
 *
 * Nothing about the session is stored in the browser: the server sets an
 * HttpOnly cookie and the provider re-reads the session from it.
 */
export default function BuilderLogin() {
  const { user, loading, signIn } = useBuilderPortalAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        role="status"
        aria-label="Checking your session"
      >
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
        <span className="sr-only">Checking your session</span>
      </div>
    );
  }

  /* Where the visitor was going before the gate stopped them.
     This login used to discard it and land everyone on the dashboard, so a
     deep link into the AML/CTF Compliance page became "you are now signed
     in, somewhere else" — indistinguishable from a broken link. Validated
     as an internal path: an open redirect on a login page is a phishing
     primitive, and the person who has just typed their password is exactly
     the person you can send anywhere. */
  const destination = safeReturnTo(
    (location.state as { from?: unknown } | null)?.from, '/builder');

  // An already-authenticated visitor is handed back to the gate, which decides
  // whether they owe a password rotation, terms or onboarding.
  if (user) return <Navigate to={destination} replace />;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!email || !password) {
      setError('Enter your email address and password.');
      return;
    }

    setSubmitting(true);
    const result = await signIn(email, password, turnstileToken || undefined);
    setSubmitting(false);

    if (result.error) {
      // The server returns one generic string for every credential failure, so
      // this surface cannot be used to discover which accounts exist.
      setError(result.error);
      setTurnstileToken(null);
      return;
    }
    navigate(destination, { replace: true });
  };

  return (
    <BuilderAuthShell
      title="Welcome back"
      description="Sign in to your builder or developer workspace."
      footer={
        <Link
          to="/builder/forgot-password"
          className="rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Forgot your password?
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="builder-email" className="text-xs font-medium">Email</Label>
          <Input
            id="builder-email"
            type="email"
            autoComplete="email"
            required
            aria-required="true"
            className="h-11"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@yourcompany.com.au"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="builder-password" className="text-xs font-medium">Password</Label>
          <div className="relative">
            <Input
              id="builder-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              aria-required="true"
              className="h-11 pr-10"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>

        <TurnstileWidget
          onVerify={(token) => setTurnstileToken(token)}
          onExpire={() => setTurnstileToken(null)}
          onError={() => setTurnstileToken(null)}
        />

        <Button
          type="submit"
          className="h-11 w-full gap-2 font-semibold"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Sign in
        </Button>
      </form>
    </BuilderAuthShell>
  );
}
