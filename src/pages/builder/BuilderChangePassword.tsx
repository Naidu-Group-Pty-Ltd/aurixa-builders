import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';

/**
 * Builder / Developer Portal password rotation.
 *
 * Mirrors `SolicitorChangePassword`. This is the destination of the gate's
 * `must_change_password` stage, so the route sits inside the protected tree and
 * the gate lets it render rather than redirecting to it again.
 */
export default function BuilderChangePassword() {
  const { user, changePassword, signOut } = useBuilderPortalAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password === currentPassword) {
      setError('Your new password must be different from your current password.');
      return;
    }

    setSubmitting(true);
    const result = await changePassword(currentPassword, password);
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    // The provider re-read the session, so `must_change_password` is now clear
    // and the gate will move on to whatever the next outstanding stage is.
    navigate('/builder', { replace: true });
  };

  return (
    <BuilderAuthShell
      title="Change your password"
      description={
        user?.must_change_password
          ? 'Your account is using a temporary password. Choose a new one to continue.'
          : 'Choose a new password for your Builder Portal account.'
      }
      footer={
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-primary underline-offset-4 hover:underline"
        >
          Sign out
        </button>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>Changing your password signs you out of every other device.</span>
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-current-password">Current password</Label>
          <PasswordInput
            id="builder-current-password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-next-password">New password</Label>
          <PasswordInput
            id="builder-next-password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="builder-next-password-hint"
          />
          <p id="builder-next-password-hint" className="text-xs text-muted-foreground">
            At least 8 characters, using two or more of: lowercase, uppercase, numbers, symbols.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-next-confirm">Confirm new password</Label>
          <PasswordInput
            id="builder-next-confirm"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
          Update password
        </Button>
      </form>
    </BuilderAuthShell>
  );
}
