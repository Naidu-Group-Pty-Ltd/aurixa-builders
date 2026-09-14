import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useBuilderPortalAuth } from '@/hooks/useBuilderPortalAuth';
import { returnToPath } from '@/lib/aml/partnerPortalHandoff';

/**
 * Builder / Developer Portal governance gate.
 *
 * Mirrors `SolicitorPortalProtectedRoute` and applies the deterministic gate
 * order. Each stage lets its own destination render, which is what prevents a
 * redirect loop: a user sitting on `/builder/terms` because terms are
 * outstanding is not redirected to `/builder/terms` again.
 *
 *   1. valid Builder session      -> /builder/login
 *   2. active user                -> handled server-side (session stops resolving)
 *   3. at least one membership    -> handled server-side (session stops resolving)
 *   4. active organisation chosen -> /builder/select-organisation
 *   5. rollout enabled            -> handled server-side (session stops resolving)
 *   6. current terms accepted     -> /builder/terms
 *   7. onboarding completed       -> /builder/onboarding
 *   8. protected Builder route
 *
 * Stages 2, 3 and 5 are deliberately absent from the browser: the server stops
 * resolving the session, so the user falls back to stage 1. This is a journey
 * aid, not the authorization control.
 */
export function BuilderPortalProtectedRoute() {
  const {
    user, loading, requiresOrganisationSelection, activeOrganisation,
  } = useBuilderPortalAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">Loading Builder Portal…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    /* The destination is `pathname + search`. It recorded the pathname alone,
       so a deep link into a matter — `/builder/compliance?matter=…` — lost
       the matter at the door even before the login ignored the record
       entirely. One rule, shared with the other two portals. */
    return (
      <Navigate
        to="/builder/login"
        replace
        state={{ from: returnToPath(location.pathname, location.search) }}
      />
    );
  }

  // Temp-password users must rotate their password before anything else.
  if (user.must_change_password) {
    return location.pathname === '/builder/change-password'
      ? <Outlet />
      : <Navigate to="/builder/change-password" replace />;
  }

  if (requiresOrganisationSelection || !activeOrganisation) {
    return location.pathname === '/builder/select-organisation'
      ? <Outlet />
      : <Navigate to="/builder/select-organisation" replace />;
  }

  if (!user.has_accepted_current_terms) {
    return location.pathname === '/builder/terms'
      ? <Outlet />
      : <Navigate to="/builder/terms" replace />;
  }

  if (!user.has_completed_mandatory_onboarding) {
    return location.pathname === '/builder/onboarding'
      ? <Outlet />
      : <Navigate to="/builder/onboarding" replace />;
  }

  return <Outlet />;
}
