import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One figure, its label and an optional line of context.
 *
 * Display only. It renders the number it is handed and nothing else — it does
 * not fetch, count, derive or interpret. A caller that passes zero gets zero;
 * what a zero means is the caller's copy to write.
 *
 * With `to`, the whole card becomes a link to an existing route and picks up a
 * focus ring and a hover lift; without one it is a plain card. Cards stretch to
 * a common height so a grid of them stays even.
 */
export interface BuilderPortalMetricCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  /** Short supporting line under the number. */
  hint?: string;
  /** An existing route. Omit for a non-navigating tile. */
  to?: string;
  className?: string;
}

export function BuilderPortalMetricCard({
  icon: Icon, label, value, hint, to, className,
}: BuilderPortalMetricCardProps) {
  const body = (
    <CardContent className="flex h-full items-start gap-3 p-4">
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10"
        aria-hidden
      >
        <Icon className="h-5 w-5 text-primary" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-muted-foreground">{label}</span>
        <span className="mt-0.5 block text-2xl font-semibold tabular-nums leading-tight text-foreground">
          {value}
        </span>
        {hint ? (
          <span className="mt-1 block text-xs leading-snug text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </CardContent>
  );

  if (!to) {
    return <Card className={cn('h-full', className)}>{body}</Card>;
  }

  return (
    <Card
      className={cn(
        'h-full transition-colors hover:border-primary/30 hover:bg-muted/40',
        'focus-within:ring-2 focus-within:ring-ring',
        className,
      )}
    >
      <Link to={to} className="block h-full rounded-lg focus:outline-none">
        {body}
      </Link>
    </Card>
  );
}
