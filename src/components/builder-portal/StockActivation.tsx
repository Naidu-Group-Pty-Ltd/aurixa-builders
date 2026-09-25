import { ArrowRight, Mail, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  ACTIVATION_STATUS_CLASSES, ACTIVATION_STATUS_LABELS,
  type BuilderStockActivation,
} from '@/lib/builderCollaboration';

/**
 * The one way a stock activation is presented, wherever it appears.
 *
 * The Notifications page, the Tasks table and the bell dropdown all show the
 * same fact — an agency activated one of this organisation's properties — and
 * a fact that renders three different ways stops reading as one fact. So the
 * pieces live here once: the LIVE status chip (the record's current state,
 * resolved server-side at list time, never a stored string), the agency
 * contact as actions rather than prose (mail and phone are links — the whole
 * point of disclosing a contact is that somebody presses it), and the road to
 * the record itself.
 */

export function ActivationStatusBadge({
  status, className,
}: {
  status: BuilderStockActivation['status'];
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn('font-medium', ACTIVATION_STATUS_CLASSES[status], className)}>
      {ACTIVATION_STATUS_LABELS[status]}
    </Badge>
  );
}

/** "Activated for a client by {agency} · client ref {…}" — the who-line. */
export function ActivationAgencyLine({
  activation, className,
}: {
  activation: BuilderStockActivation;
  className?: string;
}) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      Activated for a client by{' '}
      <span className="font-medium text-foreground">
        {activation.agency_name || 'a connected agency'}
      </span>
      {activation.client_reference ? (
        <>
          {' · client ref '}
          <span className="text-foreground/90">{activation.client_reference}</span>
        </>
      ) : null}
    </p>
  );
}

/** The agency's contact, as things to press — never a run-on sentence. */
export function ActivationContact({
  activation, dense, className,
}: {
  activation: Pick<BuilderStockActivation, 'contact_name' | 'contact_email' | 'contact_phone'>;
  dense?: boolean;
  className?: string;
}) {
  const { contact_name: name, contact_email: email, contact_phone: phone } = activation;
  if (!name && !email && !phone) return null;
  const link = 'inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline';
  return (
    <p className={cn(
      'flex flex-wrap items-center gap-x-3 gap-y-1',
      dense ? 'text-xs' : 'text-sm',
      className,
    )}>
      <span className="text-muted-foreground">Contact</span>
      {name ? <span className="font-medium text-foreground">{name}</span> : null}
      {email ? (
        <a className={link} href={`mailto:${email}`}>
          <Mail className={dense ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden />
          {email}
        </a>
      ) : null}
      {phone ? (
        <a className={link} href={`tel:${phone.replace(/\s+/g, '')}`}>
          <Phone className={dense ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden />
          {phone}
        </a>
      ) : null}
    </p>
  );
}

/** The secondary road — the property as a line of stock. */
export function ActivationStockLink({ className }: { className?: string }) {
  return (
    <Link
      to="/builder/stock"
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline',
        className,
      )}
    >
      Open in Stock List
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Link>
  );
}

/**
 * The primary road — the project the activation opened. An activation is an
 * entry point into a working record, not just an alert, so every surface that
 * shows one offers the record first. Renders nothing for an activation from
 * before projects existed (its `project_id` is null until the backfill runs).
 */
export function ActivationProjectLink({
  projectId, className,
}: {
  projectId: string | null | undefined;
  className?: string;
}) {
  if (!projectId) return null;
  return (
    <Link
      to={`/builder/projects/${projectId}`}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-semibold text-primary underline-offset-4 hover:underline',
        className,
      )}
    >
      View project
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Link>
  );
}
