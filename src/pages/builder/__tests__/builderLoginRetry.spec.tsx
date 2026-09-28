import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SECOND SIGN-IN ATTEMPT CARRIES A FRESH SECURITY CHECK.
 *
 * A Turnstile token is spent by the server's first siteverify, and a widget
 * issues no new one until it is reset. The page used to clear its copy of the
 * token after a failed sign-in without resetting the widget, so the next
 * attempt went out with NO token and the live server answered "Security
 * verification required" (measured 28 September 2026: HTTP 400 for a sign-in
 * carrying none). One mistyped password locked a builder out of the form
 * until they reloaded the page.
 */
const signIn = vi.fn();
vi.mock('@/hooks/useBuilderPortalAuth', () => ({
  useBuilderPortalAuth: () => ({ user: null, loading: false, signIn }),
}));
vi.mock('@/contexts/WhiteLabelContext', () => ({ useWhiteLabel: () => ({ currentTheme: 'light' }) }));
vi.mock('@/lib/turnstileSiteKey', () => ({
  TURNSTILE_SITE_KEY_ENV: 'VITE_TURNSTILE_SITE_KEY',
  turnstileSiteKey: () => ({ siteKey: 'site-key-under-test', source: 'env', warning: null }),
}));
vi.mock('@/components/builder-portal/BuilderAuthShell', () => ({
  BuilderAuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import BuilderLogin from '../BuilderLogin';

let issued = 0;
let options: { callback: (token: string) => void } | null = null;
const reset = vi.fn(() => { issued += 1; const n = issued; setTimeout(() => options?.callback(`token-${n}`), 0); });

beforeEach(() => {
  issued = 0;
  options = null;
  signIn.mockReset();
  reset.mockClear();
  document.head.querySelectorAll('script[src*="turnstile"]').forEach((s) => s.remove());
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  document.head.appendChild(script);
  window.turnstile = {
    render: (_el: HTMLElement, opts: Record<string, any>) => {
      options = opts as { callback: (token: string) => void };
      issued += 1;
      const n = issued;
      setTimeout(() => options?.callback(`token-${n}`), 0);
      return 'widget-1';
    },
    reset,
    remove: () => {},
  };
});

describe('signing in again after a failed attempt', () => {
  it('resets the security check and sends the fresh token with the next attempt', async () => {
    signIn.mockResolvedValue({ error: 'Invalid email or password' });
    render(<MemoryRouter><BuilderLogin /></MemoryRouter>);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'builder@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn.mock.calls[0][2]).toBe('token-1');
    await screen.findByText(/Invalid email or password/);

    await waitFor(() => expect(reset).toHaveBeenCalledWith('widget-1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));
    expect(signIn.mock.calls[1][2]).toBe('token-2');
  });
});
