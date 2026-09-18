import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ACTIVATION SUCCEEDED. SIGN-IN DID NOT. THEY ARE DIFFERENT FACTS.
 *
 * MEASURED IN PRODUCTION, 18 SEPTEMBER 2026, on the first real builder to
 * accept an invitation into an organisation still awaiting approval. The
 * screen said **Internal server error**; the server log said
 *
 *   POST 500 .../builder-portal-accept-invite
 *   { code: "P0001", message: "BUILDER_SESSION_NOT_PERMITTED" }
 *
 * `builder-portal-accept-invite` states in its own header that a membership of
 * an organisation that is still `pending_activation` counts — the invite is
 * legitimately issued ahead of the organisation going live, and "the
 * organisation gate applies at login". It then asked for a session anyway, and
 * `builder_issue_session` applies exactly that gate.
 *
 * The damage was not the refusal, which is correct. It was the ORDER: the
 * activation UPDATE had already committed, so the applicant was told nothing
 * had happened when their password was set and their invite was spent — and
 * re-opening the link then failed as a spent token, which reads as a second,
 * unrelated fault.
 *
 * These assertions are about the rule, not the wording:
 *
 *  * an act that has already committed is never reported as a failure;
 *  * the refusal is explained by the SAME module the login route uses, so a
 *    builder cannot be told two different things about one organisation;
 *  * and the page draws it as a success, because nothing about it is the
 *    applicant's to fix.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
/** Comments state the rule; only code may satisfy an assertion about code. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ACCEPT = 'supabase/functions/builder-portal-accept-invite/index.ts';

describe('the accept-invite function', () => {
  const source = code(ACCEPT);

  it('asks for a session only when there is an organisation to scope it to', () => {
    // `builder_issue_session` raises when `builder_accessible_organisations`
    // is empty. Calling it unconditionally IS the outage.
    const guard = source.indexOf('if (!accessibleOrganisations.length)');
    const issue = source.indexOf('issueBuilderSession(supabase');
    expect(guard).toBeGreaterThan(-1);
    expect(issue).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(issue);
  });

  it('returns before it can reach the session call', () => {
    // A guard that logs and falls through is not a guard.
    const guard = source.indexOf('if (!accessibleOrganisations.length)');
    const issue = source.indexOf('issueBuilderSession(supabase');
    expect(source.slice(guard, issue)).toMatch(/return json\(/);
  });

  it('reports the act that DID complete rather than a failure', () => {
    const guard = source.slice(
      source.indexOf('if (!accessibleOrganisations.length)'),
      source.indexOf('issueBuilderSession(supabase'),
    );
    expect(guard).toContain('success: true');
    expect(guard).toContain('activated: true');
    expect(guard).toContain('signed_in: false');
  });

  it('names the two facts separately on the signed-in path too', () => {
    // A caller reading `activated` must get an answer on both branches, or
    // its absence becomes indistinguishable from `false`.
    expect(source).toContain('signed_in: true');
  });

  it('explains the refusal with the module the login route uses', () => {
    expect(source).toContain('explainNoAccessibleOrganisation(');
    // Not a second, local reading of the memberships. Scoped to the guard:
    // `listInvitedOrganisations` legitimately queries the same table earlier
    // — it is the only list that works BEFORE the account is active — so a
    // file-wide assertion here would be pinning the wrong thing.
    const guard = source.slice(
      source.indexOf('if (!accessibleOrganisations.length)'),
      source.indexOf('issueBuilderSession(supabase'),
    );
    expect(guard).not.toContain('readAccessDenial(');
    expect(guard).not.toContain('builder_organisation_memberships');
    expect(source).not.toMatch(/organisation_pending_activation/);
  });

  it('never renders an empty explanation', () => {
    // `readAccessDenial` answers an unclassifiable shape with an EMPTY
    // message on purpose — saying nothing new is safe, saying something
    // untrue is not. The login route falls back to its generic refusal;
    // this route has none, because nothing was refused.
    expect(source).toMatch(/denial\.message \|\| PENDING_FALLBACK/);
    expect(read(ACCEPT)).toMatch(/const PENDING_FALLBACK =/);
  });

  it('records the outcome in the identity audit either way', () => {
    // A sign-in that did not happen is a fact about an account, and the
    // audit is where an operator looks for it.
    const guard = source.slice(
      source.indexOf('if (!accessibleOrganisations.length)'),
      source.indexOf('issueBuilderSession(supabase'),
    );
    expect(guard).toContain('auditBuilderIdentity(');
    expect(guard).toContain('reason: denial.code');
  });
});

describe('the shared explainer', () => {
  const helper = code('supabase/functions/_shared/builderPortalAuth.ts');

  it('reads the memberships and applies the existing reading', () => {
    expect(helper).toContain('export async function explainNoAccessibleOrganisation');
    expect(helper).toContain('builder_organisation_memberships');
    expect(helper).toContain('readAccessDenial(');
  });

  it('decides no access of its own', () => {
    // `builder_accessible_organisations` stays the only authority; this runs
    // only once that has already said no.
    expect(helper).not.toMatch(/explainNoAccessibleOrganisation[\s\S]*?\ballowed\s*:/);
  });
});

/* ------------------------------------------------------------------ page */

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

const PENDING_SENTENCE =
  'Xenochrome Technologies has not been approved on the Builders Network yet. Your sign-in ' +
  'details are correct; the workspace opens once the registration is approved.';

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

async function activate() {
  const password = await screen.findByLabelText(/^password$/i);
  fireEvent.change(password, { target: { value: 'Correct-Horse-9' } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: 'Correct-Horse-9' },
  });
  fireEvent.click(screen.getByRole('button', { name: /activate account/i }));
}

beforeEach(() => {
  acceptInvite.mockReset();
  validateInvite.mockReset().mockResolvedValue({
    data: {
      valid: true,
      email: 'lead@xenochrome.example',
      name: 'A Lead',
      job_title: null,
      organisations: [
        {
          organisation_id: 'org-1',
          legal_name: 'Xenochrome Technologies',
          membership_role: 'organisation_admin',
        },
      ],
    },
    error: null,
  });
});

describe('the activation page', () => {
  it('tells an applicant their account is ready and why the door is not open', async () => {
    acceptInvite.mockResolvedValue({
      pending: { code: 'organisation_pending_activation', message: PENDING_SENTENCE },
    });
    draw();
    await activate();

    await screen.findByText(/your account is ready/i);
    expect(screen.getByText(PENDING_SENTENCE)).toBeTruthy();
    // The password IS set. Leaving that unsaid is what sent the reported
    // user back to a link that now answers `already_active`.
    expect(screen.getByText(/your password is set/i)).toBeTruthy();
    expect(screen.queryByText(/builder workspace/i)).toBeNull();
  });

  it('does not dress a completed activation as an error', async () => {
    acceptInvite.mockResolvedValue({
      pending: { code: 'organisation_pending_activation', message: PENDING_SENTENCE },
    });
    draw();
    await activate();

    await screen.findByText(/your account is ready/i);
    // No destructive alert, and nothing that reads as a fault on their side.
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(screen.queryByText(/internal server error/i)).toBeNull();
    expect(screen.queryByText(/try again/i)).toBeNull();
  });

  it('offers the one thing left to do', async () => {
    acceptInvite.mockResolvedValue({
      pending: { code: 'organisation_pending_activation', message: PENDING_SENTENCE },
    });
    draw();
    await activate();

    // Anchored on the pending screen first. `findByRole` retries, so a page
    // that navigated away can still satisfy a bare link lookup on its first
    // poll — which is how this assertion passed against a deliberately
    // broken page the first time it was run.
    await screen.findByText(/your account is ready/i);
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe('/builder/login');
    // And never a dead invite link to re-open: it is spent.
    expect(screen.queryByRole('button', { name: /activate account/i })).toBeNull();
  });

  it('still signs a permitted builder straight in', async () => {
    acceptInvite.mockResolvedValue({});
    draw();
    await activate();
    await screen.findByText(/builder workspace/i);
  });

  it('still shows a real failure as one', async () => {
    acceptInvite.mockResolvedValue({ error: 'Invalid or expired invite link' });
    draw();
    await activate();

    await screen.findByText(/invalid or expired invite link/i);
    expect(screen.queryByText(/your account is ready/i)).toBeNull();
    expect(screen.queryByText(/builder workspace/i)).toBeNull();
  });
});

describe('the auth hook', () => {
  const hook = code('src/hooks/useBuilderPortalAuth.tsx');

  it('never re-reads a session that was deliberately not issued', async () => {
    // `checkSession` would fail and present a successful activation as a
    // broken one, which is the shape of the defect this came from.
    const accept = hook.slice(hook.indexOf('const acceptInvite ='));
    const pending = accept.indexOf('signed_in === false');
    const check = accept.indexOf('await checkSession()');
    expect(pending).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(pending);
    expect(accept.slice(pending, check)).toMatch(/return \{ pending/);
  });

  it('reports the pending state rather than swallowing it', () => {
    expect(hook).toContain('pending?: { code: string; message: string }');
  });
});

/* A live check that the page's own guard is what does the work, rather than
 * the mock happening to line up. */
describe('the page, read as source', () => {
  const page = code('src/pages/builder/BuilderAcceptInvite.tsx');

  it('routes to the workspace only when there is nothing pending', () => {
    const pendingAt = page.indexOf('if (result.pending)');
    const navigateAt = page.indexOf("navigate('/builder'");
    expect(pendingAt).toBeGreaterThan(-1);
    expect(navigateAt).toBeGreaterThan(pendingAt);
    expect(page.slice(pendingAt, navigateAt)).toMatch(/return;/);
  });

  it('keeps the pending reading out of the error channel', async () => {
    await waitFor(() => expect(page).not.toMatch(/setError\(\s*result\.pending/));
  });
});
