/**
 * NETWORK EDITION — the application error boundary.
 *
 * The prime's boundary defaults its fallback to `DashboardErrorFallback`,
 * which drags the internal dashboard layout chain with it. The network keeps
 * the same contract (a class boundary with a `fallback` prop) over a compact
 * default drawn in semantic tokens.
 */
import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** What to render when a descendant throws. `null` renders nothing. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

const DefaultFallback = () => (
  <div className="flex min-h-[60vh] w-full items-center justify-center p-6">
    <div className="max-w-md text-center">
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The page hit an unexpected error. Reloading usually clears it; if it
        keeps happening, contact Aurixa support.
      </p>
      <button
        type="button"
        className="mt-4 inline-flex items-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  </div>
);

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback === undefined ? <DefaultFallback /> : this.props.fallback;
    }
    return this.props.children;
  }
}
