import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE POPUP, AS A READER MEETS IT.
 *
 * Driven through the real polling loop with fake timers: the first read only
 * takes the cursor, a later arrival raises "New message from <agency>" with an
 * Open button, the conversation it names re-reads itself at once, nothing is
 * raised over the thread the reader is already looking at, the reader's own
 * "tell me when a message is posted" turns the popup (and only the popup) off,
 * and a refusal ends the asking.
 */

const readNewAgencyMessages = vi.fn();
vi.mock('@/lib/builderStockQueries', () => ({
  readNewAgencyMessages: (since: string | null) => readNewAgencyMessages(since),
  builderStockKeys: {
    agencyConversation: (id: string) => ['builder', 'stock', 'agency-conversation', id],
    myAgencyConversations: () => ['builder', 'stock', 'my-agency-conversations'],
  },
}));

let preferences: { data?: { notify_message_posted: boolean } | null } = { data: { notify_message_posted: true } };
vi.mock('@/lib/builderQueries', () => ({ useBuilderMyPreferences: () => preferences }));

let auth: { user: { id: string } | null; activeOrganisation: { organisation_id: string } | null; can: (k: string, l?: string) => boolean };
vi.mock('@/hooks/useBuilderPortalAuth', () => ({ useBuilderPortalAuth: () => auth }));

const toast = vi.fn();
vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toast(...args) }));

import { AgencyMessagePopups } from '../AgencyMessagePopups';

const arrival = (id: string, conversationId = 'conv-1') => ({
  message_id: id, conversation_id: conversationId, agency_name: 'Check Agency Pty Ltd',
  sender_display_name: 'Casey Agent', lot_number: '101', address: '1 Private Street',
  received_at: '2026-09-27T12:00:00.000001+00:00',
});

function mount(path = '/builder') {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AgencyMessagePopups />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.useFakeTimers();
  readNewAgencyMessages.mockReset();
  toast.mockReset();
  preferences = { data: { notify_message_posted: true } };
  auth = { user: { id: 'user-me' }, activeOrganisation: { organisation_id: 'org-a' }, can: () => true };
});
afterEach(() => { vi.useRealTimers(); });

describe('"New message from <agency>"', () => {
  it('takes the cursor first, then names what arrives after it, with an Open button to the conversation', async () => {
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c2', messages: [arrival('m1')] });
    const { invalidate } = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readNewAgencyMessages).toHaveBeenNthCalledWith(1, null);
    expect(toast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNewAgencyMessages).toHaveBeenNthCalledWith(2, 'c1');
    expect(toast).toHaveBeenCalledTimes(1);
    const [title, options] = toast.mock.calls[0] as [string, { description: string; action: { label: string } }];
    expect(title).toBe('New message from Check Agency Pty Ltd');
    expect(options.description).toBe('Casey Agent · Lot 101, 1 Private Street');
    expect(options.action.label).toBe('Open');
    // The conversation it names, and the list, re-read themselves at once.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builder', 'stock', 'agency-conversation', 'conv-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builder', 'stock', 'my-agency-conversations'] });
  });

  it('raises nothing over the conversation the reader is looking at, and still refreshes it', async () => {
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c2', messages: [arrival('m1', 'conv-1'), arrival('m2', 'conv-2')] });
    const { invalidate } = mount('/builder/messages?view=agencies&thread=conv-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toast).toHaveBeenCalledTimes(1);
    expect((toast.mock.calls[0][1] as { id: string }).id).toBe('agency-message-m2');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builder', 'stock', 'agency-conversation', 'conv-1'] });
  });

  it('stays quiet for a reader who asked not to be told, while the thread still refreshes', async () => {
    preferences = { data: { notify_message_posted: false } };
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c2', messages: [arrival('m1')] });
    const { invalidate } = mount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toast).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['builder', 'stock', 'agency-conversation', 'conv-1'] });
  });

  it('names a message once, however often it is answered', async () => {
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c1', messages: [arrival('m1')] })
      .mockResolvedValueOnce({ cursor: 'c1', messages: [arrival('m1')] });
    mount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('stops asking once refused, and keeps asking through a transient failure', async () => {
    const refused = Object.assign(new Error('forbidden'), { status: 403 });
    readNewAgencyMessages.mockRejectedValueOnce(refused);
    mount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readNewAgencyMessages).toHaveBeenCalledTimes(1);

    readNewAgencyMessages.mockReset();
    const transient = Object.assign(new Error('unavailable'), { status: 503 });
    readNewAgencyMessages.mockRejectedValueOnce(transient).mockResolvedValue({ cursor: 'c1', messages: [] });
    mount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNewAgencyMessages).toHaveBeenCalledTimes(2);
    expect(readNewAgencyMessages).toHaveBeenNthCalledWith(2, null);
  });

  it('asks nothing of a reader without inventory access, or before an organisation is chosen', async () => {
    auth = { ...auth, can: () => false };
    mount();
    auth = { user: { id: 'user-me' }, activeOrganisation: null, can: () => true };
    mount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readNewAgencyMessages).not.toHaveBeenCalled();
  });

  it('asks nothing while the tab is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      readNewAgencyMessages.mockResolvedValue({ cursor: 'c1', messages: [] });
      mount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(readNewAgencyMessages).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });
});
