import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectPartiesPanel } from '@/components/builder-portal/ProjectParties';
import type { BuilderProjectParty } from '@/lib/builderProjects';

/**
 * A PARTY IS A CONTACT, NEVER A KEY.
 *
 * The Parties tab listed the people on a job and offered no way to add one,
 * while the server has always accepted `upsert_party` and `delete_party`.
 * These pin the surface that now does, and the rule it must never break:
 * recording somebody against a project gives them no access to it.
 */

const mutateAsync = vi.fn();
vi.mock('@/lib/builderQueries', () => ({
  useBuilderProjectMutation: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const party = (over: Partial<BuilderProjectParty> = {}): BuilderProjectParty => ({
  id: 'party-1', project_id: 'project-1', role: 'certifier', name: 'Alex Surveyor',
  organisation: 'Northline Certifiers', email: 'alex@example.com', phone: '0400 000 000',
  address: null, reference: null, is_primary_contact: false, notes: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  ...over,
});

beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({ success: true }); });

describe('who may change the directory', () => {
  it('offers nothing to a reader', () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[party()]} canEdit={false} canDelete={false} />);
    expect(screen.queryByRole('button', { name: /add party/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.getByText('Alex Surveyor')).toBeTruthy();
  });

  it('lets an editor add and edit, and only a deleter remove', () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[party()]} canEdit canDelete={false} />);
    expect(screen.getByRole('button', { name: /add party/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /edit alex surveyor/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /remove alex surveyor/i })).toBeNull();
  });
});

describe('adding a party', () => {
  it('says, where it is done, that a party is not given access', () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[]} canEdit canDelete />);
    fireEvent.click(screen.getByRole('button', { name: /add party/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/does not give them access/i)).toBeTruthy();
  });

  it('sends the contact record and nothing that could grant anything', async () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[]} canEdit canDelete />);
    fireEvent.click(screen.getByRole('button', { name: /add party/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Sam Planner' } });
    fireEvent.change(within(dialog).getByLabelText(/email/i), { target: { value: 'sam@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save party/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload.operation).toBe('upsert_party');
    expect(payload.name).toBe('Sam Planner');
    expect(payload.email).toBe('sam@example.com');
    expect(payload.party_id).toBeUndefined();
    for (const key of Object.keys(payload)) {
      expect(key).not.toMatch(/access|permission|grant|role_access|builder_user/);
    }
  });

  it('will not save a party with no name', () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[]} canEdit canDelete />);
    fireEvent.click(screen.getByRole('button', { name: /add party/i }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('button', { name: /save party/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('changing one', () => {
  it('edits the party it was opened on, prefilled', async () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[party()]} canEdit canDelete />);
    fireEvent.click(screen.getByRole('button', { name: /edit alex surveyor/i }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Alex Surveyor');
    fireEvent.click(within(dialog).getByRole('button', { name: /save party/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ operation: 'upsert_party', party_id: 'party-1' });
  });

  it('removes only after it is confirmed, naming the party', async () => {
    render(<ProjectPartiesPanel projectId="project-1" parties={[party()]} canEdit canDelete />);
    fireEvent.click(screen.getByRole('button', { name: /remove alex surveyor/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(/Alex Surveyor/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ operation: 'delete_party', party_id: 'party-1' }));
  });
});
