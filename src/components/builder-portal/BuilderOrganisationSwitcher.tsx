import { useState } from 'react';
import { Building2, Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { accessRoleLabel } from '@/lib/builderAccessTerms';

/**
 * Organisation switcher. Has no Solicitor counterpart because a solicitor
 * belongs to exactly one firm; Phase 1 permits a Builder user to hold
 * organisation access to several organisations.
 *
 * The list is whatever the server resolved — it is never assembled in the
 * browser. Selecting one sends a request that the server re-verifies against
 * live membership before it changes the session's active organisation, so this
 * control cannot widen access.
 *
 * Renders nothing when the user can reach only one organisation.
 */
export function BuilderOrganisationSwitcher() {
  const { organisations, activeOrganisation, selectOrganisation } = useBuilderPortalAuth();
  const [switching, setSwitching] = useState(false);

  const selectable = organisations;
  if (selectable.length <= 1) return null;

  const handleSelect = async (organisationId: string) => {
    if (organisationId === activeOrganisation?.organisation_id) return;
    setSwitching(true);
    const { error } = await selectOrganisation(organisationId);
    setSwitching(false);
    if (error) toast.error(error);
  };

  const label = activeOrganisation
    ? activeOrganisation.trading_name || activeOrganisation.legal_name
    : 'Select organisation';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-52" disabled={switching}>
          {switching
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            : <Building2 className="mr-2 h-4 w-4 shrink-0" aria-hidden />}
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Your organisations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {selectable.map((organisation) => {
          const isActive = organisation.organisation_id === activeOrganisation?.organisation_id;
          return (
            <DropdownMenuItem
              key={organisation.organisation_id}
              onSelect={() => void handleSelect(organisation.organisation_id)}
              className="flex items-start gap-2"
            >
              <Check
                className={`mt-0.5 h-4 w-4 shrink-0 ${isActive ? 'opacity-100' : 'opacity-0'}`}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate text-sm">
                  {organisation.trading_name || organisation.legal_name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {accessRoleLabel(organisation.membership_role)}
                  {organisation.is_primary ? ' · primary' : ''}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
