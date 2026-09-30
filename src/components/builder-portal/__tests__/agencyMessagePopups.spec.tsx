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
 *
 * And, since 30 Sep 2026, when the reader is somewhere else: a hidden tab
 * still asks (more slowly), raises one desktop notification per person, puts
 * a count on the tab, and shows the popup when they come back — once, in
 * whichever tab they return to first.
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

const deliverDesktopAlert = vi.fn((..._args: unknown[]) => 'shown');
vi.mock('@/lib/builderPortalAlerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/builderPortalAlerts')>()),
  deliverDesktopAlert: (...args: unknown[]) => deliverDesktopAlert(...args),
}));
const offerDesktopAlerts = vi.fn();
vi.mock('../offerDesktopAlerts', () => ({ offerDesktopAlerts: () => offerDesktopAlerts() }));

import { AgencyMessagePopups } from '../AgencyMessagePopups';
import { resetAlertClaims } from '@/lib/builderPortalAlerts';

let clock = 0;
const arrival = (id: string, conversationId = 'conv-1') => ({
  message_id: id, conversation_id: conversationId, agency_name: 'Check Agency Pty Ltd',
  sender_display_name: 'Casey Agent', lot_number: '101', address: '1 Private Street',
  // Every arrival is later than the one before, as on the server.
  received_at: new Date(Date.UTC(2026, 8, 27, 12, 0, clock++)).toISOString(),
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

let visibility: 'visible' | 'hidden' = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  readNewAgencyMessages.mockReset();
  toast.mockReset();
  deliverDesktopAlert.mockClear();
  offerDesktopAlerts.mockReset();
  resetAlertClaims();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  document.title = 'Builder Portal';
  preferences = { data: { notify_message_posted: true } };
  auth = { user: { id: 'user-me' }, activeOrganisation: { organisation_id: 'org-a' }, can: () => true };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const setVisibility = (next: 'visible' | 'hidden') => {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
};

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
    expect((toast.mock.calls[0][1] as { id: string }).id).toBe('agency-conversation-conv-2');
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

  it('tells a conversation once, however many messages it received', async () => {
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c2', messages: [arrival('m1'), arrival('m2'), arrival('m3', 'conv-2')] });
    mount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls.map((call) => call[0])).toEqual([
      '2 new messages from Check Agency Pty Ltd', 'New message from Check Agency Pty Ltd',
    ]);
  });
});

describe('when the builder is somewhere else', () => {
  it('keeps asking while the tab is hidden, every thirty seconds rather than every five', async () => {
    visibility = 'hidden';
    readNewAgencyMessages.mockResolvedValue({ cursor: 'c1', messages: [] });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readNewAgencyMessages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(readNewAgencyMessages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNewAgencyMessages).toHaveBeenCalledTimes(2);
  });

  it('raises a desktop notification and a count on the tab, and the popup when they come back', async () => {
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c2', messages: [arrival('m1')] })
      .mockResolvedValue({ cursor: 'c2', messages: [] });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(30_000);

    expect(toast).not.toHaveBeenCalled();
    expect(deliverDesktopAlert).toHaveBeenCalledTimes(1);
    const [alert] = deliverDesktopAlert.mock.calls[0] as [{ heading: string; body: string; path: string }];
    expect(alert).toMatchObject({
      heading: 'New message from Check Agency Pty Ltd',
      body: 'Casey Agent · Lot 101, 1 Private Street',
      path: '/builder/messages?view=agencies&thread=conv-1',
    });
    expect(document.title).toBe('(1) Builder Portal');

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe('New message from Check Agency Pty Ltd');
    expect(document.title).toBe('Builder Portal');
  });

  it('notifies the desktop once and shows the popup once, across every open tab', async () => {
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValue({ cursor: 'c2', messages: [arrival('m1')] });
    // Two tabs of the same browser share the ledger.
    mount();
    mount();
    await vi.advanceTimersByTimeAsync(0);
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliverDesktopAlert).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('tells nobody who asked not to be told, not even the tab title', async () => {
    preferences = { data: { notify_message_posted: false } };
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValue({ cursor: 'c2', messages: [arrival('m1')] });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(deliverDesktopAlert).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(document.title).toBe('Builder Portal');
  });

  it('offers desktop alerts when a message arrives and the browser has not been asked', async () => {
    deliverDesktopAlert.mockReturnValueOnce('unsupported');
    readNewAgencyMessages
      .mockResolvedValueOnce({ cursor: 'c1', messages: [] })
      .mockResolvedValueOnce({ cursor: 'c2', messages: [arrival('m1')] });
    mount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(offerDesktopAlerts).toHaveBeenCalledTimes(1);
  });
});
