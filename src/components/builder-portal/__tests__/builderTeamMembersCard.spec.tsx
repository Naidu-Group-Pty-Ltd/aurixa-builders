import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Team members card: shown only to an owner or administrator, members and
 * pending invitations apart, controls only where the server said the caller
 * may manage, a confirmation before anything destructive, and the server's
 * refusal shown as it was given. The server decides; this is the journey.
 */
let role = 'administrator';
vi.mock('@/hooks/useBuilderPortalAuth', () => ({
  useBuilderPortalAuth: () => ({
    activeOrganisation: { organisation_id: 'org-a' },
    organisations: [{ organisation_id: 'org-a', membership_role: role }],
  }),
}));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const list = vi.fn();
const manage = vi.fn();
const revoke = vi.fn();
vi.mock('@/lib/builderPortal', () => ({
  builderListOrgMembers: () => list(),
  builderManageOrgMember: (input: unknown) => manage(input),
  builderRevokeOrgInvite: (id: string) => revoke(id),
}));

import { BuilderTeamMembersCard } from '../BuilderTeamMembersCard';

const member = (over: Record<string, unknown>) => ({
  membership_id: 'm', builder_user_id: 'u', name: 'N', email: 'n@x.example', role: 'member',
  status: 'active', is_self: false, can_manage: true, ...over,
});

beforeEach(() => {
  role = 'administrator';
  list.mockReset(); manage.mockReset(); revoke.mockReset(); toast.mockReset();
  list.mockResolvedValue({ data: { success: true,
    members: [
      member({ membership_id: 'm1', builder_user_id: 'u1', name: 'Owen Owner', role: 'owner', can_manage: false }),
      member({ membership_id: 'm2', builder_user_id: 'u2', name: 'Ada Admin', role: 'administrator', is_self: true, can_manage: false }),
      member({ membership_id: 'm3', builder_user_id: 'u3', name: 'Max Member', role: 'member' }),
      member({ membership_id: 'm4', builder_user_id: 'u4', name: 'Sue Suspended', status: 'suspended' }),
    ],
    invitations: [member({ membership_id: 'm5', builder_user_id: 'u5', name: 'Ivy Invited', role: 'read_only' })],
  }, error: null });
});

describe('BuilderTeamMembersCard', () => {
  it('renders nothing for a manager, member or read-only user, and asks the server nothing', () => {
    for (const r of ['manager', 'member', 'read_only']) {
      role = r;
      const { container, unmount } = render(<BuilderTeamMembersCard />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('lists members and pending invitations apart, with controls only where the caller may manage', async () => {
    render(<BuilderTeamMembersCard />);
    const members = await screen.findByRole('list', { name: 'Members' });
    const rows = within(members).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).queryByRole('button')).toBeNull(); // the owner, for an administrator
    expect(within(rows[1]).getByText('(you)')).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button')).toBeNull();
    expect(within(rows[2]).getByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(within(rows[3]).getByText('Suspended')).toBeInTheDocument();
    expect(within(rows[3]).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    const invites = screen.getByRole('list', { name: 'Pending invitations' });
    expect(within(invites).getByText('Ivy Invited')).toBeInTheDocument();
    expect(within(invites).getByRole('button', { name: 'Cancel invitation' })).toBeInTheDocument();
  });

  it('asks before removing, then removes and reloads', async () => {
    manage.mockResolvedValue({ data: { success: true, member: { membership_id: 'm3', status: 'revoked' } }, error: null });
    render(<BuilderTeamMembersCard />);
    const rows = within(await screen.findByRole('list', { name: 'Members' })).getAllByRole('listitem');
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Remove' }));
    expect(manage).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ membership_id: 'm3', member_action: 'remove', role: undefined }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('shows the server\'s refusal as given', async () => {
    manage.mockResolvedValue({ data: null, error: { message: 'An organisation must keep at least one active owner' } });
    render(<BuilderTeamMembersCard />);
    const rows = within(await screen.findByRole('list', { name: 'Members' })).getAllByRole('listitem');
    fireEvent.click(within(rows[3]).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not changed', description: 'An organisation must keep at least one active owner',
    })));
  });
});
