import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENCIES → MESSAGES, ON THE PARTICIPANT MODEL (docs/builder-portal/62).
 *
 * Data is mocked at the query hook; the server decides every fact. What is
 * asserted is what the page does with it: the list is the conversations the
 * server listed (the viewer's own), a selected conversation shows its thread
 * with both sides' participants, Add user and Leave chat, a reply box only
 * where it can be written to, and a refused read shows nothing of it.
 */

const state: Record<string, any> = {};
const invited: string[] = [];
const left: string[] = [];

vi.mock('@/lib/builderStockQueries', () => ({
  useBuilderActivatedProperties: () => ({ data: { records: [], pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 } },
    error: null, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useRefreshEveryBuilderActivatedProperty: () => async () => undefined,
  useRefreshMyAgencyConversations: () => async () => undefined,
  useEveryBuilderActivatedProperty: () => ({ data: { records: [], truncated: false }, error: null, isLoading: false, refetch: vi.fn() }),
  builderStockImageUrl: vi.fn(async () => null),
  useMyAgencyConversations: () => ({ data: state.inbox, error: null, isLoading: false, refetch: vi.fn() }),
  useAgencyConversation: () => ({ data: state.conversation, error: state.conversationError ?? null, isLoading: false, isFetching: false }),
  useSendAgencyMessage: () => ({ isPending: false, mutateAsync: vi.fn(async () => ({ message: null })) }),
  useRetryAgencyMessage: () => ({ isPending: false, mutateAsync: vi.fn(async () => ({ message: null })) }),
  useAgencyConversationInvitees: () => ({ data: state.invitees ?? [], error: null, isLoading: false }),
  useInviteAgencyParticipant: () => ({ isPending: false, mutateAsync: vi.fn(async (id: string) => { invited.push(id); return { result: 'joined' }; }) }),
  useLeaveAgencyConversation: () => ({ isPending: false, mutateAsync: vi.fn(async () => { left.push('left'); return { result: 'left' }; }) }),
}));
vi.mock('@/lib/builderAgency', async (original) => ({
  ...(await original<typeof import('@/lib/builderAgency')>()),
  scrollLogToEnd: () => undefined,
  scrollMessageIntoView: () => undefined,
}));

import BuilderAgencies from '../BuilderAgencies';

const CONVERSATION = (overrides: Record<string, unknown> = {}) => ({
  conversation_id: 'conv-1', open: true, can_send: true, can_invite: true, can_leave: true,
  participants: [
    { participant_ref: 'r1', side: 'builder', display_name: 'Avery Builder', is_me: true },
    { participant_ref: 'r2', side: 'command_centre', display_name: 'Olive Owner', is_me: false },
  ],
  messages: [{ id: 'm1', side: 'command_centre', sender_display_name: 'Olive Owner', body: 'Is it available?',
    sent_at: '2026-09-25T10:00:00Z', delivery_state: null, delivered_at: null, failure_reason: null, mine: false, can_retry: false }],
  ...overrides,
});

beforeEach(() => {
  for (const key of Object.keys(state)) delete state[key];
  state.inbox = { conversations: [
    { conversation_id: 'conv-1', stock_item_id: 'item-1', address: '1 Private Street', lot_number: '101',
      agency_name: 'Example Agency', open: true, last_message_at: '2026-09-25T10:00:00Z' },
  ] };
  state.conversation = CONVERSATION();
  invited.length = 0; left.length = 0;
});

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/builder/agencies/:tab" element={<BuilderAgencies />} />
    </Routes>
  </MemoryRouter>,
);

describe('Agencies → Messages', () => {
  it('lists the viewer\'s own conversations, one per activation', () => {
    state.inbox.conversations.push({ ...state.inbox.conversations[0], conversation_id: 'conv-2', agency_name: 'Example Agency' });
    renderAt('/builder/agencies/messages');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('a selected conversation shows its thread and both sides\' participants', () => {
    renderAt('/builder/agencies/messages?thread=conv-1');
    const people = screen.getByRole('list', { name: /participants/i });
    expect(within(people).getByText('Avery Builder')).toBeInTheDocument();
    expect(within(people).getByText('Olive Owner')).toBeInTheDocument();
    expect(within(screen.getByRole('log')).getByText('Is it available?')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message/i })).not.toBeDisabled();
  });

  it('a participant adds a colleague from their own organisation, and leaves', async () => {
    state.invitees = [{ user_id: 'u-alex', display_name: 'Alex Builder' }];
    renderAt('/builder/agencies/messages?thread=conv-1');
    fireEvent.click(screen.getByRole('button', { name: /add user/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add alex builder/i }));
    await vi.waitFor(() => expect(invited).toEqual(['u-alex']));
    fireEvent.click(screen.getByRole('button', { name: /leave chat/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^leave$/i }));
    await vi.waitFor(() => expect(left).toEqual(['left']));
  });

  it('the last builder participant is told to add a colleague before leaving', () => {
    state.conversation = CONVERSATION({ can_leave: false });
    renderAt('/builder/agencies/messages?thread=conv-1');
    expect(screen.getByRole('button', { name: /leave chat/i })).toBeDisabled();
    expect(screen.getByText(/add a colleague before you leave/i)).toBeInTheDocument();
  });

  it('a withdrawn activation\'s conversation keeps its history and takes no reply and no new user', () => {
    state.conversation = CONVERSATION({ open: false, can_send: false, can_invite: false });
    renderAt('/builder/agencies/messages?thread=conv-1');
    expect(screen.getByText('Is it available?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add user/i })).toBeNull();
    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();
  });

  it('a conversation the viewer is not in shows nothing of it', () => {
    state.conversation = undefined;
    state.conversationError = Object.assign(new Error('You are not in this conversation.'), { status: 403, code: 'not_a_participant' });
    renderAt('/builder/agencies/messages?thread=conv-9');
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.queryByRole('list', { name: /participants/i })).toBeNull();
  });

  it('with no conversations, says how one starts', () => {
    state.inbox = { conversations: [] };
    renderAt('/builder/agencies/messages');
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
  });
});
