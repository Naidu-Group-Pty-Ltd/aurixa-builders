/**
 * Aurixa Builders Network — application shell.
 *
 * The route tree under `/builder/*` is the prime's Builder Portal block,
 * carried verbatim: the ported pages and layout link to `/builder/...` paths,
 * so the paths travel with the code. The network adds only a root redirect —
 * this deployment IS the portal, so `/` goes straight to it.
 *
 * WITHDRAWN SECTIONS are declared, not deleted (the prime's rule): the set is
 * named once in `builderHiddenSections.pure.ts`, and the paths stay declared
 * so a bookmark or an old link resolves, inside the portal chrome, to a
 * notice — a route that stops existing falls through to the catch-all and
 * lands on the dashboard with no explanation, which reads as a broken link.
 */
import { Suspense } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BrandProvider } from '@/branding/BrandProvider';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { BuilderPortalAuthProvider } from '@/hooks/useBuilderPortalAuth';
import { BuilderPortalProtectedRoute } from '@/components/builder-portal/BuilderPortalProtectedRoute';
import { BuilderPortalLayout } from '@/components/builder-portal/BuilderPortalLayout';

const BuilderLogin = lazyWithRetry(() => import("@/pages/builder/BuilderLogin"));
const BuilderAcceptInvite = lazyWithRetry(() => import("@/pages/builder/BuilderAcceptInvite"));
const BuilderForgotPassword = lazyWithRetry(() => import("@/pages/builder/BuilderForgotPassword"));
const BuilderResetPassword = lazyWithRetry(() => import("@/pages/builder/BuilderResetPassword"));
const BuilderChangePassword = lazyWithRetry(() => import("@/pages/builder/BuilderChangePassword"));
const BuilderSelectOrganisation = lazyWithRetry(() => import("@/pages/builder/BuilderSelectOrganisation"));
const BuilderTerms = lazyWithRetry(() => import("@/pages/builder/BuilderTerms"));
const BuilderOnboarding = lazyWithRetry(() => import("@/pages/builder/BuilderOnboarding"));
const BuilderDashboard = lazyWithRetry(() => import("@/pages/builder/BuilderDashboard"));
const BuilderCompliance = lazyWithRetry(() => import("@/pages/builder/BuilderCompliance"));
const BuilderSettings = lazyWithRetry(() => import("@/pages/builder/BuilderSettings"));
const BuilderProjects = lazyWithRetry(() => import("@/pages/builder/BuilderProjects"));
const BuilderProjectDetail = lazyWithRetry(() => import("@/pages/builder/BuilderProjectDetail"));
const BuilderStockList = lazyWithRetry(() => import("@/pages/builder/BuilderStockList"));
const BuilderMessages = lazyWithRetry(() => import("@/pages/builder/BuilderMessages"));
const BuilderTasks = lazyWithRetry(() => import("@/pages/builder/BuilderTasks"));
const BuilderNotifications = lazyWithRetry(() => import("@/pages/builder/BuilderNotifications"));
const BuilderActivity = lazyWithRetry(() => import("@/pages/builder/BuilderActivity"));
const BuilderSectionWithdrawn = lazyWithRetry(() => import("@/pages/builder/BuilderSectionWithdrawn"));
const BuilderRegister = lazyWithRetry(() => import("@/pages/builder/BuilderRegister"));
const BuilderVerifyEmail = lazyWithRetry(() => import("@/pages/builder/BuilderVerifyEmail"));

/*
  Withdrawn-section pages: untouched and still imported (the prime's rule,
  pinned by builderHiddenSections.spec.ts) — swapping the element back on a
  route below is what re-offers a section.
*/
const BuilderInventory = lazyWithRetry(() => import("@/pages/builder/BuilderInventory"));
const BuilderUnitDetail = lazyWithRetry(() => import("@/pages/builder/BuilderUnitDetail"));
const BuilderTransactions = lazyWithRetry(() => import("@/pages/builder/BuilderTransactions"));
const BuilderTransactionDetail = lazyWithRetry(() => import("@/pages/builder/BuilderTransactionDetail"));
const BuilderPipeline = lazyWithRetry(() => import("@/pages/builder/BuilderPipeline"));
const BuilderConstruction = lazyWithRetry(() => import("@/pages/builder/BuilderConstruction"));
const BuilderConstructionDetail = lazyWithRetry(() => import("@/pages/builder/BuilderConstructionDetail"));
const BuilderDeliveryDetail = lazyWithRetry(() => import("@/pages/builder/BuilderDeliveryDetail"));
const BuilderDocuments = lazyWithRetry(() => import("@/pages/builder/BuilderDocuments"));

/*
  The withdrawn pages above are deliberately not routed; referencing them here
  keeps "unused" honest for tooling without re-offering anything.
*/
void [
  BuilderInventory, BuilderUnitDetail, BuilderTransactions,
  BuilderTransactionDetail, BuilderPipeline, BuilderConstruction,
  BuilderConstructionDetail, BuilderDeliveryDetail, BuilderDocuments,
];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** Shown while a route's chunk is in flight. Quiet, on semantic tokens. */
const RouteFallback = () => (
  <div className="flex min-h-[60vh] w-full items-center justify-center" aria-busy="true">
    <div className="flex flex-col items-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" />
      <span className="text-xs font-medium text-muted-foreground">Loading…</span>
    </div>
  </div>
);

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrandProvider>
          <BrowserRouter>
            <Toaster />
            <Sonner />
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Navigate to="/builder" replace />} />
                <Route path="/builder/*" element={
                  <BuilderPortalAuthProvider>
                    <Routes>
                      <Route path="login" element={<BuilderLogin />} />
                      <Route path="register" element={<BuilderRegister />} />
                      {/* Public on purpose: the emailed link must work in a
                          browser with no session; the guard sends signed-in
                          unverified users here too. */}
                      <Route path="verify-email" element={<BuilderVerifyEmail />} />
                      <Route path="accept-invite" element={<BuilderAcceptInvite />} />
                      <Route path="forgot-password" element={<BuilderForgotPassword />} />
                      <Route path="reset-password" element={<BuilderResetPassword />} />
                      <Route element={<BuilderPortalProtectedRoute />}>
                        {/* Gate destinations render outside the portal chrome. */}
                        <Route path="change-password" element={<BuilderChangePassword />} />
                        <Route path="select-organisation" element={<BuilderSelectOrganisation />} />
                        <Route path="terms" element={<BuilderTerms />} />
                        <Route path="onboarding" element={<BuilderOnboarding />} />
                        <Route element={<BuilderPortalLayout />}>
                          <Route index element={<BuilderDashboard />} />
                          <Route path="dashboard" element={<BuilderDashboard />} />
                          <Route path="projects" element={<BuilderProjects />} />
                          <Route path="projects/:projectId" element={<BuilderProjectDetail />} />
                          {/* Withdrawn sections — declared, not deleted (see module header). */}
                          <Route path="inventory" element={<BuilderSectionWithdrawn />} />
                          <Route path="inventory/:unitId" element={<BuilderSectionWithdrawn />} />
                          <Route path="stock" element={<BuilderStockList />} />
                          <Route path="transactions" element={<BuilderSectionWithdrawn />} />
                          <Route path="transactions/:transactionId" element={<BuilderSectionWithdrawn />} />
                          <Route path="pipeline" element={<BuilderSectionWithdrawn />} />
                          <Route path="construction" element={<BuilderSectionWithdrawn />} />
                          <Route path="construction/:constructionCaseId" element={<BuilderSectionWithdrawn />} />
                          <Route path="construction/:constructionCaseId/delivery" element={<BuilderSectionWithdrawn />} />
                          <Route path="documents" element={<BuilderSectionWithdrawn />} />
                          <Route path="messages" element={<BuilderMessages />} />
                          <Route path="tasks" element={<BuilderTasks />} />
                          <Route path="notifications" element={<BuilderNotifications />} />
                          <Route path="activity" element={<BuilderActivity />} />
                          <Route path="compliance" element={<BuilderCompliance />} />
                          <Route path="settings" element={<BuilderSettings />} />
                        </Route>
                      </Route>
                      {/* Anything else under /builder returns to the portal entry. */}
                      <Route path="*" element={<Navigate to="/builder" replace />} />
                    </Routes>
                  </BuilderPortalAuthProvider>
                } />
                {/* Anything else at all is the portal's. */}
                <Route path="*" element={<Navigate to="/builder" replace />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </BrandProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
