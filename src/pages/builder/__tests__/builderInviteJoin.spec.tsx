import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN ACCOUNT THAT ALREADY SIGNS IN ACCEPTS WITH ONE CLICK (doc 68).
 *
 * Every organisation invitation now waits for the invitee, established
 * accounts included. For them the emailed link asks one question — join this
 * organisation? — and nothing else: there is no password to set, the one they
 * have is not touched, and the link signs nobody in. The page must say so, and
 * must not show a password form an established account has no use for.
 */

const acceptInvite = vi.fn();
vi.mock('@/hooks/useBuilderPortalAuth', () => ({
  useBuilderPortalAuth: () => ({ acceptInvite }),
}));

const validateInvite = vi.fn();
vi.mock('@/lib/builderPortal', () => ({
  builderValidateInvite: (token: string) => validateInvite(token),
}));

import { BrandProvider } from '@/branding/BrandProvider';
import BuilderAcceptInvite from '@/pages/builder/BuilderAcceptInvite';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const code = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function draw() {
  return render(
    <BrandProvider>
      <MemoryRouter initialEntries={['/builder/accept-invite?token=tok']}>
        <Routes>
          <Route path="/builder/accept-invite" element={<BuilderAcceptInvite />} />
          <Route path="/builder" element={<div>builder workspace</div>} />
        </Routes>
      </MemoryRouter>
    </BrandProvider>,
  );
}

const validated = (requiresPassword: boolean | undefined) => ({
  data: {
    valid: true,
    email: 'eddie@acme.example',
    name: 'Eddie',
    job_title: null,
    ...(requiresPassword === undefined ? {} : { requires_password: requiresPassword }),
    organisations: [{ organisation_id: 'org-2', legal_name: 'Second Builders', membership_role: 'member' }],
  },
  error: null,
});

beforeEach(() => {
  acceptInvite.mockReset();
  validateInvite.mockReset();
});

describe('an invitation to an account that already signs in', () => {
  it('asks only whether to join, and shows no password form', async () => {
    validateInvite.mockResolvedValue(validated(false));
    draw();
    await screen.findByRole('button', { name: /accept invitation/i });
    expect(screen.getByText(/Second Builders/)).toBeTruthy();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
    expect(screen.getByText(/no password to set/i)).toBeTruthy();
  });

  it('accepts on the click, without a password, and says what happened', async () => {
    validateInvite.mockResolvedValue(validated(false));
    acceptInvite.mockResolvedValue({ accepted: { legal_name: 'Second Builders' } });
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/invitation accepted/i);
    expect(acceptInvite).toHaveBeenCalledWith('tok');
    // The link signed nobody in, so the page sends them to the portal rather
    // than pretending a session exists.
    const open = screen.getByRole('link', { name: /open the builder portal/i });
    expect(open.getAttribute('href')).toBe('/builder');
    expect(screen.queryByText(/builder workspace/i)).toBeNull();
  });

  it('still shows a refusal as one', async () => {
    validateInvite.mockResolvedValue(validated(false));
    acceptInvite.mockResolvedValue({ error: 'Invalid or expired invite link' });
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/invalid or expired invite link/i);
    expect(screen.queryByText(/invitation accepted/i)).toBeNull();
  });

  it('a first invitation, or a server that does not say, still asks for a password', async () => {
    for (const requires of [true, undefined]) {
      validateInvite.mockReset().mockResolvedValue(validated(requires));
      const view = draw();
      await screen.findByLabelText(/^password$/i);
      expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
      view.unmount();
    }
  });
});

describe('the auth hook', () => {
  const hook = code('src/hooks/useBuilderPortalAuth.tsx');
  const accept = hook.slice(hook.indexOf('const acceptInvite ='), hook.indexOf('const changePassword ='));

  it('sends no password when none was asked for', () => {
    expect(accept).toMatch(/async \(token: string, password\?: string\)/);
  });

  it('reports a join as accepted without reading a session nobody issued', () => {
    const joined = accept.indexOf('accepted === true');
    const check = accept.indexOf('await checkSession()');
    expect(joined).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(joined);
    expect(accept.slice(joined, check)).toMatch(/return \{ accepted/);
  });
});
