import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The invite card tells an administrator whether email is leaving AT ALL —
 * one reading for the whole deployment (doc 68) — and never anything about a
 * particular invitation. It asks only when the caller may invite, and says
 * nothing when mail is working or the reading is not in yet.
 */
let role = 'administrator';
vi.mock('@/hooks/useBuilderPortalAuth', () => ({
  useBuilderPortalAuth: () => ({
    activeOrganisation: { organisation_id: 'org-a', legal_name: 'Acme Builders' },
    organisations: [{ organisation_id: 'org-a', membership_role: role }],
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const health = vi.fn();
const invite = vi.fn();
vi.mock('@/lib/builderPortal', () => ({
  builderInviteTeamMember: (...args: unknown[]) => invite(...args),
  builderInviteDeliveryHealth: () => health(),
}));

import { BuilderTeamInviteCard } from '../BuilderTeamInviteCard';

const reading = (state: string) => ({ data: { success: true, delivery: { state, checked_at: null } }, error: null });

beforeEach(() => {
  role = 'administrator';
  health.mockReset();
  invite.mockReset();
});

describe('the delivery reading on the invite card', () => {
  it('says so when email is not leaving, and how to recover', async () => {
    health.mockResolvedValue(reading('degraded'));
    render(<BuilderTeamInviteCard />);
    const alert = await screen.findByText(/email delivery is not working/i);
    expect(alert.textContent).toMatch(/invite the same address again/i);
  });

  it('says so when the queue is long', async () => {
    health.mockResolvedValue(reading('delayed'));
    render(<BuilderTeamInviteCard />);
    await screen.findByText(/may take a few minutes/i);
  });

  it('says so when this organisation\'s own invitation emails were held back, and how to recover', async () => {
    health.mockResolvedValue(reading('held_back'));
    render(<BuilderTeamInviteCard />);
    const alert = await screen.findByText(/held back/i);
    expect(alert.textContent).toMatch(/invite the same address again/i);
  });

  it('reads the delivery reading again once an invitation is recorded, so a burst shows what it caused', async () => {
    health.mockResolvedValue(reading('operational'));
    invite.mockResolvedValue({ data: { success: true }, error: null });
    render(<BuilderTeamInviteCard />);
    await waitFor(() => expect(health).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'sam@x.test' } });
    fireEvent.submit(screen.getByLabelText(/^name$/i).closest('form')!);
    await waitFor(() => expect(invite).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
  });

  it('says nothing when mail is working, or before the first reading', async () => {
    for (const state of ['operational', 'unknown']) {
      health.mockReset().mockResolvedValue(reading(state));
      const view = render(<BuilderTeamInviteCard />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByText(/email delivery|may take a few minutes|not configured/i)).toBeNull();
      view.unmount();
    }
  });

  it('is not asked for by somebody who cannot invite', () => {
    role = 'member';
    const { container } = render(<BuilderTeamInviteCard />);
    expect(container).toBeEmptyDOMElement();
    expect(health).not.toHaveBeenCalled();
  });

  it('caps the typed name at the server\'s own 200 characters', () => {
    health.mockResolvedValue(reading('operational'));
    render(<BuilderTeamInviteCard />);
    expect(screen.getByLabelText(/^name$/i).getAttribute('maxlength')).toBe('200');
  });
});
