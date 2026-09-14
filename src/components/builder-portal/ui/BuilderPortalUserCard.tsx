import type { ReactNode } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The compact identity card in the Builder sidebar and mobile drawer: who is
 * signed in, which organisation they are acting for, and with what access role.
 *
 * Display only. It renders values the layout already holds from
 * `useBuilderPortalAuth()` — it makes no request, resolves no permission and
 * owns no organisation-switching logic. The switcher itself is passed in as a
 * child so this component never learns how selection works.
 *
 * Deliberately separate from the operator brand lockup above it: the configured
 * white-label company is the product's identity, and the active organisation is
 * the user's context. Conflating the two would let an organisation name
 * masquerade as the operator.
 */
export interface BuilderPortalUserCardProps {
  name: string;
  /** Shown under the name — the active organisation, or the email as fallback. */
  secondary?: string | null;
  /** The user-facing access-role label. */
  roleLabel?: string | null;
  isPrimaryOrganisation?: boolean;
  /** The organisation switcher, rendered by the caller. */
  switcher?: ReactNode;
  className?: string;
}

/** Initials from data the session already carries — nothing is fetched. */
function initialsFor(name: string): string {
  return name
    .split(/[\s@.]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'B';
}

export function BuilderPortalUserCard({
  name, secondary, roleLabel, isPrimaryOrganisation, switcher, className,
}: BuilderPortalUserCardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-primary/15 bg-gradient-to-r from-primary/10 via-primary/5 to-card/90 p-3 shadow-lg shadow-primary/5',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10 shrink-0 border-2 border-primary/20">
          <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">
            {initialsFor(name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          {secondary ? (
            <p className="truncate text-xs text-muted-foreground">{secondary}</p>
          ) : null}
        </div>
      </div>

      {roleLabel || isPrimaryOrganisation ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {roleLabel ? (
            <Badge variant="outline" className="max-w-full font-normal">
              <span className="truncate">{roleLabel}</span>
            </Badge>
          ) : null}
          {isPrimaryOrganisation ? (
            <Badge variant="outline" className="font-normal">Primary</Badge>
          ) : null}
        </div>
      ) : null}

      {switcher ? (
        <div className="mt-2.5 [&_button]:w-full [&_button]:max-w-none">{switcher}</div>
      ) : null}
    </div>
  );
}
