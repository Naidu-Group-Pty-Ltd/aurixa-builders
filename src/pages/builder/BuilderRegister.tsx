import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { BuilderAuthShell } from '@/components/builder-portal/BuilderAuthShell';

/**
 * Self-registration is CLOSED — the Builder Portal is invitation only.
 *
 * There is no public sign-up. An account exists only because an existing
 * organisation's owner or administrator invited the person, who then accepts
 * an emailed invitation. This route is kept (rather than removed) so an old
 * link or bookmark meets an explicit, honest explanation instead of a bare
 * redirect that reads as a broken link — the same reasoning the withdrawn
 * portal sections follow. It states a policy, not a permissions denial: the
 * reader has not been refused anything they were owed, the portal simply does
 * not offer a public door.
 *
 * The backend `builder-portal-register` endpoint refuses every request at the
 * source, so this page is the honest face of a door that is shut on both
 * sides — nothing here submits anything anywhere.
 */
export default function BuilderRegister() {
  return (
    <BuilderAuthShell
      title="Invitation only"
      description="The Builder Portal does not offer public sign-up."
      footer={
        <p className="text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/builder/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <div className="flex items-start gap-3 rounded-md border border-border bg-card p-4">
        <MailCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary" aria-hidden />
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Access to the Builder Portal is by invitation. To join, ask an owner
            or administrator at your organisation to invite you — they can do
            this from their <span className="font-medium text-foreground">Settings</span> page.
          </p>
          <p>
            Your invitation arrives by email with a link to set your password
            and sign in. If you were expecting one and it has not arrived, ask
            them to resend it.
          </p>
        </div>
      </div>
    </BuilderAuthShell>
  );
}
