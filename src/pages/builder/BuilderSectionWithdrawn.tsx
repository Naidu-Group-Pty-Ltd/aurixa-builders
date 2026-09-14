import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { withdrawnSectionForPath } from '@/lib/builderHiddenSections.pure';

/**
 * WHAT A WITHDRAWN SECTION'S URL RESOLVES TO.
 *
 * Five sections are not offered in this portal (see
 * `builderHiddenSections.pure.ts`). Their routes stay declared and land
 * here, inside the portal's own chrome.
 *
 * ## Why a notice rather than a redirect
 *
 * A bookmark, a link in an old email and a typed URL all still arrive. Sent
 * silently to the dashboard, the reader concludes the link is broken and
 * asks somebody to fix it; told plainly that the section is not part of this
 * portal, they know the answer. That is the same rule the `notFoundHere`
 * work settled on: a dead end explains itself or it generates a support
 * request.
 *
 * ## What it must not do
 *
 * It states that the section is not part of the portal and says nothing
 * about permissions, because it is not an authorisation decision — the
 * reader has not been denied anything, the portal simply does not carry it.
 * Wording it as "you do not have access" would send somebody to an
 * administrator who has nothing to grant.
 */
export default function BuilderSectionWithdrawn() {
  const { pathname } = useLocation();
  const section = withdrawnSectionForPath(pathname);

  return (
    <BuilderPortalShell
      eyebrow="Not in this portal"
      title={section?.label ?? 'Not available here'}
      description={
        section
          ? `${section.label} is not part of the Builder / Developer Portal. `
            + 'Nothing has been removed from your account — this section is not '
            + 'one this portal offers.'
          : 'This section is not part of the Builder / Developer Portal.'
      }
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/builder">
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
            Back to your dashboard
          </Link>
        </Button>
      }
    >
      {/*
        Deliberately empty. A withdrawn section has nothing to show, and a
        placeholder panel here would read as a page that failed to load
        rather than one that is not offered — the header carries the whole
        answer.
      */}
      <></>
    </BuilderPortalShell>
  );
}
