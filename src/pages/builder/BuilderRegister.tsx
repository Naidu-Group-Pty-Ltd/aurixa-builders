import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';
import { TurnstileWidget } from '@/components/auth/TurnstileWidget';
import { builderRegister, type BuilderRegistrationInput } from '@/lib/builderPortal';

const ORG_TYPES: { value: BuilderRegistrationInput['organisation']['org_type']; label: string }[] = [
  { value: 'builder', label: 'Builder' },
  { value: 'developer', label: 'Developer' },
  { value: 'builder_developer', label: 'Builder & developer' },
  { value: 'sales_representative', label: 'Sales representative' },
];

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

/**
 * Self-registration (network edition) — the portal's second door.
 *
 * The confirmation is the SAME whatever the server found: an address that
 * already holds an account gets the identical "check your inbox" screen,
 * because the difference is delivered to the mailbox and this page must not
 * undo the endpoint's enumeration safety by phrasing outcomes apart.
 *
 * An ABN is optional and honest: providing one that matches an existing
 * organisation creates a join REQUEST its owners decide — the form says so
 * up front rather than letting "register" read as "join".
 */
export default function BuilderRegister() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [legalName, setLegalName] = useState('');
  const [orgType, setOrgType] = useState<string>('');
  const [abn, setAbn] = useState('');
  const [state, setState] = useState<string>('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Enter your name.');
    if (!email.trim()) return setError('Enter your email address.');
    if (!password) return setError('Choose a password.');
    if (!legalName.trim()) return setError("Enter your organisation's legal name.");
    if (!orgType) return setError('Choose what kind of organisation you are.');

    setSubmitting(true);
    const { data, error: requestError } = await builderRegister({
      name: name.trim(),
      email: email.trim(),
      password,
      organisation: {
        legal_name: legalName.trim(),
        org_type: orgType as BuilderRegistrationInput['organisation']['org_type'],
        ...(abn.trim() ? { abn: abn.trim() } : {}),
        ...(state ? { state } : {}),
      },
      ...(turnstileToken ? { turnstileToken } : {}),
    });
    setSubmitting(false);

    if (requestError && !data?.success) {
      setError(requestError.message || 'Registration could not be completed. Try again shortly.');
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <BuilderAuthShell
        title="Check your inbox"
        description="One more step."
        footer={
          <p className="text-sm text-muted-foreground">
            Already verified?{' '}
            <Link to="/builder/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        }
      >
        <div className="flex items-start gap-3 rounded-md border border-border bg-card p-4">
          <MailCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            If this address can register, a verification email is on its way.
            Open the link in it to confirm your address — then sign in to
            finish setting up your organisation.
          </p>
        </div>
      </BuilderAuthShell>
    );
  }

  return (
    <BuilderAuthShell
      title="Register for the Builder Portal"
      description="Create your account and your organisation's workspace."
      footer={
        <p className="text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/builder/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      {/* noValidate: the server's own messages must stay reachable — a browser
          silently blocking submit is how a refusal becomes invisible. */}
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="builder-register-name">Your name</Label>
          <Input
            id="builder-register-name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-register-email">Work email</Label>
          <Input
            id="builder-register-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-register-password">Password</Label>
          <PasswordInput
            id="builder-register-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-register-legal-name">Organisation legal name</Label>
          <Input
            id="builder-register-legal-name"
            autoComplete="organization"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="builder-register-org-type">Organisation type</Label>
            <Select value={orgType} onValueChange={setOrgType}>
              <SelectTrigger id="builder-register-org-type">
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                {ORG_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="builder-register-state">State</Label>
            <Select value={state} onValueChange={setState}>
              <SelectTrigger id="builder-register-state">
                <SelectValue placeholder="Optional" />
              </SelectTrigger>
              <SelectContent>
                {STATES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="builder-register-abn">ABN (optional)</Label>
          <Input
            id="builder-register-abn"
            inputMode="numeric"
            autoComplete="off"
            value={abn}
            onChange={(e) => setAbn(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            If your ABN matches an organisation already on the network, we send
            its owners a join request instead of creating a duplicate — they
            decide membership.
          </p>
        </div>

        <TurnstileWidget
          onVerify={(token) => setTurnstileToken(token)}
          onExpire={() => setTurnstileToken(null)}
          onError={() => setTurnstileToken(null)}
        />

        <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
          {submitting
            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Registering…</>
            : 'Create account'}
        </Button>
      </form>
    </BuilderAuthShell>
  );
}
