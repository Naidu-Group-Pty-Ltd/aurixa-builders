import { useEffect, useRef, useState, useCallback } from 'react';
import { useWhiteLabel } from '@/contexts/WhiteLabelContext';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { TURNSTILE_SITE_KEY_ENV, turnstileSiteKey } from '@/lib/turnstileSiteKey';

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';

// How long to wait for challenges.cloudflare.com before telling the user.
// A blocked request often does not fail — it hangs — so `onerror` alone never
// fires and the widget silently never appears.
const TURNSTILE_LOAD_TIMEOUT_MS = 12000;

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, any>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}

interface TurnstileWidgetProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
}

export function TurnstileWidget({ onVerify, onExpire, onError }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const { currentTheme } = useWhiteLabel();

  // Which widget this deployment renders — never another tenant's. Resolved
  // once per module load; see `lib/turnstileSiteKey.ts` for why an unset
  // variable is an unavailable check rather than a borrowed site key.
  const siteKey = turnstileSiteKey().siteKey;

  // The Sign In button is disabled until this widget produces a token, and the
  // server refuses a login without one — so when the widget cannot load, the
  // page looks fine and simply cannot be used. Saying so (and offering a retry)
  // is the difference between "the login page is broken" and a network hiccup
  // the user can clear themselves. The requirement itself is never relaxed.
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Keep latest callbacks in refs so the widget never re-renders when parent
  // passes inline arrow functions (which change identity on every keystroke).
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);
  useEffect(() => { onVerifyRef.current = onVerify; }, [onVerify]);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile || !siteKey) return;
    // Remove existing widget if any
    if (widgetIdRef.current) {
      try { window.turnstile.remove(widgetIdRef.current); } catch {}
      widgetIdRef.current = null;
    }
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      callback: (token: string) => { setUnavailable(false); onVerifyRef.current?.(token); },
      'expired-callback': () => onExpireRef.current?.(),
      'error-callback': () => { setUnavailable(true); onErrorRef.current?.(); },
      theme: currentTheme === 'dark' ? 'dark' : 'light',
    });
  }, [currentTheme, siteKey]);

  useEffect(() => {
    // With no site key there is nothing to render and nothing a retry could
    // fix, so the script is never fetched.
    if (!siteKey) {
      setUnavailable(true);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[src*="turnstile"]');

    const loadScript = () => {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.onerror = () => setUnavailable(true);
      window.onTurnstileLoad = renderWidget;
      document.head.appendChild(script);
    };

    if (!existing) {
      loadScript();
    } else if (window.turnstile) {
      renderWidget();
    } else if (attempt > 0) {
      // A retry after the previous script tag never produced `window.turnstile`:
      // that tag will not fire again, so replace it rather than waiting on it.
      existing.remove();
      loadScript();
    } else {
      window.onTurnstileLoad = renderWidget;
    }

    // `onerror` does not fire for a request that is merely hanging, and a
    // proxy or extension that swallows the script produces no event at all.
    const timer = window.setTimeout(() => {
      if (!widgetIdRef.current) setUnavailable(true);
    }, TURNSTILE_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch {}
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget, attempt, siteKey]);

  const retry = () => {
    setUnavailable(false);
    onErrorRef.current?.();
    setAttempt(a => a + 1);
  };

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-1 shadow-sm ring-1 ring-primary/10"
      />
      {unavailable && (
        <div className="flex flex-col items-center gap-2 text-center" role="alert">
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            {siteKey ? (
              <span>
                The security check could not load, so sign-in is unavailable. Check your
                connection, or any ad/script blocker for <span className="font-medium">challenges.cloudflare.com</span>.
              </span>
            ) : (
              <span>
                This deployment has no security check configured, so sign-in is
                unavailable. An administrator needs to set{' '}
                <span className="font-mono font-medium">{TURNSTILE_SITE_KEY_ENV}</span> to this
                deployment's own Turnstile site key.
              </span>
            )}
          </p>
          {/*
            A retry re-fetches the script, which is the remedy for a blocked or
            hanging load and is no remedy at all for a key that was never
            configured — offering it there just fails again more slowly.
          */}
          {siteKey && (
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Retry security check
            </button>
          )}
        </div>
      )}
    </div>
  );
}
