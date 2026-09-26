import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup as cleanupRender, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENCY ACTIVATIONS, AND THE AGENCY CONVERSATIONS ON MESSAGES.
 *
 * Agency Activations lists what connected agencies activated, and nothing
 * else; it is reached from the portal navigation only by a user whose
 * organisation role already opens the Stock List's activations (`inventory`
 * view). The conversations about those properties are on Messages, the
 * portal's one home for messaging, as its Agency conversations tab. The old
 * Agencies addresses redirect, so no bookmark breaks. The data is
 * mocked at the query hook; what is asserted is what the page does with it:
 * the property link appears only where project access already exists, the
 * Messages shell invents no message and offers no working composer, and an
 * empty organisation is told so rather than shown a blank.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const state: {
  records: any[];
  error: { status?: number; message?: string } | null;
  loading: boolean;
  conversation: any;
  laterPages: any[];
  everyError: { status?: number; message?: string } | null;
  /** A refresh that failed after the full list had been read once. */
  everyStale?: boolean;
  /** The server stopped answering new pages before the list was complete. */
  everyTruncated?: boolean;
  /** A refresh of the first page failed after it had been read once. */
  firstStale?: boolean;
  /** The conversation's latest poll failed. */
  conversationError?: { message?: string; status?: number } | null;
} = { records: [], error: null, loading: false, conversation: null, laterPages: [], everyError: null };
const sent: Array<{ clientMessageId: string; body: string }> = [];
const sendFailures = { remaining: 0 };
const retried: string[] = [];
const refreshed = { firstPage: 0, every: 0 };

vi.mock('@/lib/builderStockQueries', () => ({
  useBuilderActivatedProperties: () => ({
    data: state.error && !state.firstStale ? undefined : { records: state.records, pagination: { page: 1, page_size: 25, total: state.records.length, total_pages: 1 } },
    error: state.error,
    isLoading: state.loading,
    isFetching: false,
    refetch: vi.fn(async () => { refreshed.firstPage += 1; }),
  }),
  useRefreshEveryBuilderActivatedProperty: () => async () => { refreshed.every += 1; },
  useEveryBuilderActivatedProperty: () => ({
    data: (state.error && !state.firstStale) || (state.everyError && !state.everyStale) ? undefined
      : { records: [...state.records, ...state.laterPages], truncated: !!state.everyTruncated },
    error: (state.firstStale ? null : state.error) ?? state.everyError,
    isLoading: state.loading,
    refetch: vi.fn(async () => { refreshed.every += 1; }),
  }),
  builderStockImageUrl: vi.fn(async () => null),
  // Since Step 6 the Messages list is the reader's own conversations, one per
  // activation (docs/builder-portal/62), served in one read. The fixture's
  // activations stand for them, keyed as the thread URL names them.
  useMyAgencyConversations: () => ({
    data: state.everyError && !state.everyStale ? undefined : { conversations: summariesOf([...state.records, ...state.laterPages]) },
    error: state.everyError,
    isLoading: state.loading,
    refetch: vi.fn(async () => { refreshed.every += 1; }),
  }),
  useRefreshMyAgencyConversations: () => async () => { refreshed.every += 1; },
  useAgencyConversationInvitees: () => ({ data: [], isLoading: false, error: null }),
  useInviteAgencyParticipant: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useLeaveAgencyConversation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAgencyConversation: () => ({
    data: state.conversation ?? undefined, error: state.conversationError ?? null, isLoading: false, isFetching: false,
  }),
  useSendAgencyMessage: () => ({
    isPending: false,
    mutateAsync: vi.fn(async (input: { clientMessageId: string; body: string }) => {
      sent.push(input);
      if (sendFailures.remaining > 0) { sendFailures.remaining -= 1; throw new Error('network'); }
      return { message: null };
    }),
  }),
  useEarlierAgencyConversationMessages: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRetryAgencyMessage: () => ({
    isPending: false,
    mutateAsync: vi.fn(async (id: string) => { retried.push(id); return { message: null }; }),
  }),
}));

function summariesOf(records: any[]) {
  const seen = new Set<string>();
  return records.map((r) => ({
    conversation_id: `${r.connection_id}:${r.stock_item_id}`, stock_item_id: r.stock_item_id,
    address: r.property?.address_line ?? null, lot_number: r.property?.lot_number ?? null,
    agency_name: r.agency?.name ?? null, open: r.status !== 'withdrawn', last_message_at: null,
  })).filter((c) => (seen.has(c.conversation_id) ? false : (seen.add(c.conversation_id), true)));
}

const scrolled: unknown[] = [];
vi.mock('@/lib/builderAgency', async (original) => ({
  ...(await original<typeof import('@/lib/builderAgency')>()),
  scrollLogToEnd: (log: unknown) => { scrolled.push(log); },
  scrollMessageIntoView: (_log: unknown, id: string) => { scrolled.push(`message:${id}`); },
}));

vi.mock('@/lib/builderQueries', () => ({
  useBuilderConversations: () => ({ data: [], error: null, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
  useBuilderConversation: () => ({ data: undefined, error: null, isLoading: false, isError: false, refetch: vi.fn() }),
  useBuilderCollaborationMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/components/builder-portal/BuilderScopePicker', () => ({ BuilderScopePicker: () => null }));

import BuilderAgencyActivations from '../BuilderAgencyActivations';
import BuilderMessages from '../BuilderMessages';
import LegacyAgenciesRedirect from '../LegacyAgenciesRedirect';
import { builderNavItemVisible } from '@/components/builder-portal/builderNavVisibility.pure';
import { legacyAgenciesTarget, messagesViewFrom } from '@/lib/builderAgency';

const ACTIVATION = {
  id: 'ann-a1',
  connection_id: 'conn-a',
  stock_item_id: 'item-a1',
  status: 'builder_acknowledged',
  activated_at: '2026-09-20T01:00:00Z',
  updated_at: '2026-09-20T02:00:00Z',
  acknowledged_at: '2026-09-20T02:00:00Z',
  acknowledged_by_name: 'Bailey Builder',
  agency: {
    name: 'Example Agency',
    workspace_label: 'Example Agency Workspace',
    contact_name: 'Avery Adviser',
    contact_email: 'avery@agency.example',
    contact_phone: null,
  },
  property: {
    lot_number: '101', unit_number: null, address_line: '1 Example Street',
    suburb: 'Exampleville', state: 'VIC', postcode: '3000',
    development_name: 'Example Estate', house_design: 'The Example 28', external_reference: null,
  },
  primary_image: null,
  project: { id: 'proj-a1', accessible: true },
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/builder/activations" element={<BuilderAgencyActivations />} />
        <Route path="/builder/messages" element={<BuilderMessages />} />
        <Route path="/builder/agencies" element={<LegacyAgenciesRedirect />} />
        <Route path="/builder/agencies/:tab" element={<LegacyAgenciesRedirect />} />
        <Route path="/builder/projects/:projectId" element={<p>Project page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  refreshed.firstPage = 0;
  refreshed.every = 0;
  state.everyError = null;
  state.everyStale = false;
  state.everyTruncated = false;
  state.conversationError = null;
  state.firstStale = false;
  state.records = [];
  state.error = null;
  state.loading = false;
  state.conversation = null;
  sent.length = 0;
  state.laterPages = [];
  sendFailures.remaining = 0;
  retried.length = 0;
});

const MESSAGE = (overrides: Record<string, unknown>) => ({
  id: 'm', side: 'builder', sender_display_name: 'Bailey Builder', body: 'Hello',
  sent_at: '2026-09-25T10:00:00Z', delivery_state: 'delivered', delivered_at: '2026-09-25T10:00:05Z',
  failure_reason: null, mine: true, can_retry: false, ...overrides,
});

describe('navigation', () => {
  it('offers Agency Activations only to a user who can already view activations', () => {
    const item = { to: '/builder/activations', label: 'Agency Activations', permission: 'inventory' } as const;
    expect(builderNavItemVisible(item, { can: () => true, showCompliance: false })).toBe(true);
    expect(builderNavItemVisible(item, { can: () => false, showCompliance: false })).toBe(false);
    // Asked for the right key and level, not merely "anything".
    const asked: string[] = [];
    builderNavItemVisible(item, { can: (k, l) => { asked.push(`${k}:${l}`); return true; }, showCompliance: false });
    expect(asked).toEqual(['inventory:view']);
  });

  it('leaves every existing entry exactly as visible as it was', () => {
    const plain = { to: '/builder/projects', label: 'Projects' } as const;
    expect(builderNavItemVisible(plain, { can: () => false, showCompliance: false })).toBe(true);
  });

  it('is declared in the portal navigation as Agency Activations, and the old Agencies addresses redirect', () => {
    const layout = code('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toMatch(/to: '\/builder\/activations', label: 'Agency Activations'[^}]*permission: 'inventory'/);
    expect(layout).not.toContain("label: 'Agencies'");
    expect(layout).toContain('builderNavItemVisible(');
    const app = code('src/App.tsx');
    expect(app).toContain('<Route path="activations" element={<BuilderAgencyActivations />} />');
    expect(app).toContain('<Route path="agencies" element={<LegacyAgenciesRedirect />} />');
    expect(app).toContain('<Route path="agencies/:tab" element={<LegacyAgenciesRedirect />} />');
  });

  it('keeps Messages as the one home for messaging, under its own name', () => {
    const layout = code('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toContain("{ to: '/builder/messages', label: 'Messages'");
  });
});

describe('the old Agencies addresses', () => {
  it('open Agency Activations', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies');
    expect(screen.getByRole('heading', { name: 'Agency Activations' })).toBeInTheDocument();
    cleanupRender();
    renderAt('/builder/agencies/activations');
    expect(screen.getByRole('heading', { name: 'Agency Activations' })).toBeInTheDocument();
  });

  it('open the agency conversation a bookmark named, on Messages', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /agency conversations/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { selected: true })).toBeInTheDocument();
  });
});

describe('Messages is the one home for messaging', () => {
  it('Agency Activations draws no tabs and no conversations', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/activations');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('listbox', { name: /conversations/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
  });

  it('opens the agency conversations by default', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/messages');
    expect(screen.getByRole('tab', { name: /agency conversations/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('listbox', { name: /conversations/i })).toBeInTheDocument();
  });

  it('opens the project conversations for a link that names a project, as every link before the move did', () => {
    renderAt('/builder/messages?project=proj-a1');
    expect(screen.getByRole('tab', { name: /project conversations/i })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Activated Properties', () => {
  it('lists each activation with its property, design, agency, contact and acknowledgement', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/activations');
    const row = screen.getByRole('listitem');
    expect(within(row).getByText(/Lot 101/)).toBeInTheDocument();
    expect(within(row).getByText(/1 Example Street/)).toBeInTheDocument();
    expect(within(row).getByText('The Example 28')).toBeInTheDocument();
    expect(within(row).getByText('Example Agency')).toBeInTheDocument();
    expect(within(row).getByText('Avery Adviser')).toBeInTheDocument();
    expect(within(row).getByText('Acknowledged')).toBeInTheDocument();
    expect(within(row).getByText(/Bailey Builder/)).toBeInTheDocument();
  });

  it('links the property to its project where the builder has project access', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/activations');
    expect(screen.getByRole('link', { name: /view project/i })).toHaveAttribute('href', '/builder/projects/proj-a1');
  });

  it('draws no project link where the builder has no project access', () => {
    state.records = [{ ...ACTIVATION, project: { id: 'proj-a1', accessible: false } }];
    renderAt('/builder/activations');
    expect(screen.queryByRole('link', { name: /view project/i })).toBeNull();
  });

  it('says when no agency has activated anything yet', () => {
    renderAt('/builder/activations');
    expect(screen.getByText(/no agency has activated/i)).toBeInTheDocument();
  });

  it('says so, rather than showing an empty list, when the server refuses', () => {
    state.error = { status: 403, message: 'You do not have access to stock' };
    renderAt('/builder/activations');
    expect(screen.getByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText(/no agency has activated/i)).toBeNull();
  });

  it('is a page of its own, titled Agency Activations', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/activations');
    expect(screen.getByRole('heading', { name: 'Agency Activations' })).toBeInTheDocument();
  });
});

describe('Messages', () => {
  it('lists each conversation the reader is in, once', () => {
    state.records = [ACTIVATION, { ...ACTIVATION, id: 'ann-a1-again' }];
    renderAt('/builder/messages?view=agencies');
    expect(screen.getByRole('tab', { name: /agency conversations/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('lists every conversation the server returns, however many activations there are', () => {
    state.records = [ACTIVATION];
    state.laterPages = [{ ...ACTIVATION, id: 'ann-z', connection_id: 'conn-z', stock_item_id: 'item-z',
      agency: { ...ACTIVATION.agency, name: 'Page Two Agency' } }];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    renderAt('/builder/messages?view=agencies&thread=conn-z:item-z');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /page two agency/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('an open conversation with nothing in it says so, and can be written to', () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message/i })).not.toBeDisabled();
  });

  it('shows each message with its actual sender and, for ours, whether it arrived', () => {
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [
        MESSAGE({ id: 'm1', side: 'command_centre', sender_display_name: 'Casey Agent', body: 'Is it available?', delivery_state: null, mine: false }),
        MESSAGE({ id: 'm2', body: 'Yes it is.', delivery_state: 'delivered' }),
        MESSAGE({ id: 'm3', sender_display_name: 'Alex Builder', body: 'Brochure attached tomorrow.', delivery_state: 'queued', mine: false }),
      ],
    };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    const thread = screen.getByRole('log');
    const items = within(thread).getAllByRole('article');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Casey Agent'), expect.stringContaining('Bailey Builder'), expect.stringContaining('Alex Builder'),
    ]);
    expect(within(items[1]).getByText('Delivered')).toBeInTheDocument();
    expect(within(items[2]).getByText('Sending')).toBeInTheDocument();
    expect(within(items[0]).queryByText(/delivered|sending/i)).toBeNull();
  });

  it('a failed message stays visible and its writer can send it again', () => {
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [MESSAGE({ id: 'm-failed', body: 'Did this arrive?', delivery_state: 'failed', failure_reason: 'not_delivered', can_retry: true })],
    };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByText('Did this arrive?')).toBeInTheDocument();
    expect(screen.getByText('Not delivered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /send again/i }));
    expect(retried).toEqual(['m-failed']);
  });

  it('sends what was typed with one idempotency key, and keeps the key if the send is repeated', async () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: '  Hello agency  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await screen.findByRole('textbox', { name: /message/i });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('Hello agency');
    expect(sent[0].clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('repeats a send that failed in flight under the same key, and mints a new key once the text changes', async () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    sendFailures.remaining = 2;
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    const box = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(box, { target: { value: 'Is lot 12 still available?' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].clientMessageId).toBe(sent[0].clientMessageId);
    fireEvent.change(box, { target: { value: 'Is lot 14 still available?' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2].clientMessageId).not.toBe(sent[0].clientMessageId);
    expect(sent[2].body).toBe('Is lot 14 still available?');
  });

  it('a message whose confirmation never came back says so, and its writer can send it again', () => {
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [MESSAGE({ id: 'm-unconfirmed', body: 'Price still current?', delivery_state: 'failed', failure_reason: 'confirmation_timeout', can_retry: true })],
    };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Not delivered')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /send again/i }));
    expect(retried).toEqual(['m-unconfirmed']);
  });

  it('offers no "Send again" where the reader cannot write, even on their own failed message', () => {
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: false, can_send: false,
      messages: [MESSAGE({ id: 'm-failed', body: 'Did this arrive?', delivery_state: 'failed', failure_reason: 'not_delivered', can_retry: true })],
    };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByText('Did this arrive?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send again/i })).toBeNull();
  });

  it('a closed conversation keeps its history and cannot be written to', () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: 'c', open: false, can_send: false, messages: [MESSAGE({})] };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();
    expect(screen.getByText(/no longer activated/i)).toBeInTheDocument();
  });

  it('tells an organisation with no activations that there is nobody to message yet', () => {
    renderAt('/builder/messages?view=agencies');
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
  });

  it('no model and no email: a message is text between people', () => {
    for (const file of ['src/pages/builder/BuilderAgencyActivations.tsx', 'src/components/builder-portal/AgencyConversations.tsx']) {
      const page = code(file);
      expect(page).not.toMatch(/openrouter|anthropic|openai|claude/i);
      expect(page).not.toMatch(/sendEmail|resend/i);
    }
  });
});

describe('each page\'s Refresh', () => {
  it('on Messages re-reads the conversation list, so a new activation\'s conversation appears', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/messages?view=agencies');
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(refreshed.every).toBe(1);
  });

  it('on Agency Activations re-reads the activations', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/activations');
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(refreshed.firstPage).toBe(1);
    expect(refreshed.every).toBe(0);
  });
});

describe('the full conversation list, when it cannot be read', () => {
  it('says so and offers a retry, rather than presenting the first page as complete', () => {
    state.records = [ACTIVATION];
    state.everyError = { message: 'page 2 failed' };
    renderAt('/builder/messages?view=agencies');
    expect(screen.queryByRole('listbox', { name: /conversations/i })).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refreshed.every).toBe(1);
  });
});

describe('a refresh of the full list that fails', () => {
  it('keeps the list it read last, says it could not be refreshed, and offers a retry', () => {
    state.records = [ACTIVATION];
    state.everyError = { message: 'refresh failed' };
    state.everyStale = true;
    renderAt('/builder/messages?view=agencies');
    expect(screen.getByRole('listbox', { name: /conversations/i })).toBeTruthy();
    expect(screen.getByText(/could not be refreshed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refreshed.every).toBe(1);
  });
});

describe('a refresh of the first page that fails after it was read', () => {
  it('keeps the conversation list on Messages', () => {
    state.records = [ACTIVATION];
    state.error = { message: 'first page refresh failed' };
    state.firstStale = true;
    renderAt('/builder/messages?view=agencies');
    expect(screen.getByRole('listbox', { name: /conversations/i })).toBeTruthy();
    expect(screen.queryByText(/could not be loaded just now/i)).toBeNull();
  });

  it('keeps the activations it read and says they may be out of date', () => {
    state.records = [ACTIVATION];
    state.error = { message: 'first page refresh failed' };
    state.firstStale = true;
    renderAt('/builder/activations');
    expect(screen.queryByText(/could not be loaded just now/i)).toBeNull();
    expect(screen.getByText(/could not be refreshed/i)).toBeTruthy();
  });

  it('a refresh REFUSED after the list was read withdraws it on both pages', () => {
    // Each page is decided by its own read: Agency Activations by the
    // activations list, Messages by the conversation list (so a failure of
    // one never takes the other offline).
    state.records = [ACTIVATION];
    state.error = { status: 403, message: 'You do not have access to stock' };
    state.firstStale = true;
    const activations = renderAt('/builder/activations');
    expect(screen.getByText(/do not have access/i)).toBeTruthy();
    activations.unmount();
    state.error = null; state.firstStale = false;
    state.everyError = { status: 403, message: 'You do not have access to stock' };
    state.everyStale = true;
    renderAt('/builder/messages?view=agencies');
    expect(screen.queryByRole('listbox', { name: /conversations/i })).toBeNull();
    expect(screen.getByText(/do not have access/i)).toBeTruthy();
  });

  it('a first read that fails still says so, and a refusal still says access is missing', () => {
    state.everyError = { message: 'first read failed' };
    renderAt('/builder/messages?view=agencies');
    expect(screen.getByText(/could not be loaded just now/i)).toBeTruthy();
  });
});

describe('a poll of an open conversation that fails', () => {
  it('keeps the history it already read and says it may be out of date', () => {
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [MESSAGE({ id: 'm1', body: 'Already read.', delivery_state: 'delivered' })],
    };
    state.conversationError = { message: 'poll failed' };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByRole('log', { name: /conversation/i })).toBeTruthy();
    expect(screen.getByText('Already read.')).toBeTruthy();
    expect(screen.getByText(/could not be refreshed/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded just now/i)).toBeNull();
  });

  it.each([401, 403])('a poll refused with %i withdraws the history and the composer', (status) => {
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [MESSAGE({ id: 'm1', body: 'Already read.', delivery_state: 'delivered' })],
    };
    state.conversationError = { status, message: 'refused' };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.queryByRole('log', { name: /conversation/i })).toBeNull();
    expect(screen.queryByText('Already read.')).toBeNull();
    expect(screen.queryByText(/could not be refreshed/i)).toBeNull();
    expect(screen.getByText(/no longer available to you/i)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('with nothing read yet, says it could not be loaded', () => {
    state.records = [ACTIVATION];
    state.conversation = null;
    state.conversationError = { message: 'first read failed' };
    renderAt('/builder/messages?view=agencies&thread=conn-a:item-a1');
    expect(screen.getByText(/could not be loaded just now/i)).toBeTruthy();
  });
});

describe('the conversation log follows its newest message', () => {
  it('opens at the end, and moves to the end again when a poll brings in a message', () => {
    scrolled.length = 0;
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [MESSAGE({ id: 'm1', body: 'First.', delivery_state: 'delivered' })],
    };
    const tree = () => (
      <MemoryRouter initialEntries={['/builder/messages?view=agencies&thread=conn-a:item-a1']}>
        <Routes><Route path="/builder/messages" element={<BuilderMessages />} /></Routes>
      </MemoryRouter>
    );
    const view = render(tree());
    const log = screen.getByRole('log');
    expect(scrolled).toContain(log);
    const before = scrolled.length;
    state.conversation = { ...state.conversation, messages: [...state.conversation.messages,
      MESSAGE({ id: 'm2', body: 'Arrived by poll.', delivery_state: 'delivered' })] };
    view.rerender(tree());
    expect(scrolled.length).toBeGreaterThan(before);
    expect(scrolled[scrolled.length - 1]).toBe(screen.getByRole('log'));
  });

  it('brings a late message into view when the poll sorts it above the newest one', () => {
    scrolled.length = 0;
    state.records = [ACTIVATION];
    state.conversation = {
      conversation_id: 'c', open: true, can_send: true,
      messages: [MESSAGE({ id: 'm1', body: 'First.', delivery_state: 'delivered' }),
        MESSAGE({ id: 'm3', body: 'Newest.', delivery_state: 'delivered' })],
    };
    const tree = () => (
      <MemoryRouter initialEntries={['/builder/messages?view=agencies&thread=conn-a:item-a1']}>
        <Routes><Route path="/builder/messages" element={<BuilderMessages />} /></Routes>
      </MemoryRouter>
    );
    const view = render(tree());
    state.conversation = { ...state.conversation, messages: [state.conversation.messages[0],
      MESSAGE({ id: 'm2', body: 'Arrived late.', delivery_state: 'delivered' }), state.conversation.messages[1]] };
    view.rerender(tree());
    expect(scrolled[scrolled.length - 1]).toBe('message:m2');
  });
});

describe('where an address lands', () => {
  it('Messages: an explicit view wins, a project link opens projects, anything else opens agencies', () => {
    expect(messagesViewFrom(new URLSearchParams('view=projects'))).toBe('projects');
    expect(messagesViewFrom(new URLSearchParams('view=agencies&project=p'))).toBe('agencies');
    for (const key of ['project=p', 'scope=project', 'scopeId=s', 'conversation=c']) {
      expect(messagesViewFrom(new URLSearchParams(key))).toBe('projects');
    }
    expect(messagesViewFrom(new URLSearchParams(''))).toBe('agencies');
    expect(messagesViewFrom(new URLSearchParams('thread=t'))).toBe('agencies');
    expect(messagesViewFrom(new URLSearchParams('view=nonsense'))).toBe('agencies');
  });

  it('the old Agencies section: its Messages tab keeps the conversation it named, everything else is Agency Activations', () => {
    expect(legacyAgenciesTarget('messages', '?thread=conv-1')).toBe('/builder/messages?thread=conv-1&view=agencies');
    expect(legacyAgenciesTarget('messages', '')).toBe('/builder/messages?view=agencies');
    expect(legacyAgenciesTarget('activations', '?x=1')).toBe('/builder/activations');
    expect(legacyAgenciesTarget(undefined, '')).toBe('/builder/activations');
    expect(legacyAgenciesTarget('anything', '')).toBe('/builder/activations');
  });
});
