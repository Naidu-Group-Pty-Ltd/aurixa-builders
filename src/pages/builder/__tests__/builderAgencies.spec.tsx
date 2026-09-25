import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE AGENCIES AREA, AS A BUILDER MEETS IT.
 *
 * One section, two bookmarkable tabs — Activated Properties and Messages —
 * reached from the portal navigation only by a user whose organisation role
 * already opens the Stock List's activations (`inventory` view). The data is
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
} = { records: [], error: null, loading: false, conversation: null, laterPages: [] };
const sent: Array<{ clientMessageId: string; body: string }> = [];
const sendFailures = { remaining: 0 };
const retried: string[] = [];
const refreshed = { firstPage: 0, every: 0 };

vi.mock('@/lib/builderStockQueries', () => ({
  useBuilderActivatedProperties: () => ({
    data: state.error ? undefined : { records: state.records, pagination: { page: 1, page_size: 25, total: state.records.length, total_pages: 1 } },
    error: state.error,
    isLoading: state.loading,
    isFetching: false,
    refetch: vi.fn(async () => { refreshed.firstPage += 1; }),
  }),
  useRefreshEveryBuilderActivatedProperty: () => async () => { refreshed.every += 1; },
  useEveryBuilderActivatedProperty: () => ({
    data: state.error ? undefined : [...state.records, ...state.laterPages],
    error: state.error,
    isLoading: state.loading,
  }),
  builderStockImageUrl: vi.fn(async () => null),
  useAgencyConversation: () => ({
    data: state.conversation ?? undefined, error: null, isLoading: false, isFetching: false,
  }),
  useSendAgencyMessage: () => ({
    isPending: false,
    mutateAsync: vi.fn(async (input: { clientMessageId: string; body: string }) => {
      sent.push(input);
      if (sendFailures.remaining > 0) { sendFailures.remaining -= 1; throw new Error('network'); }
      return { message: null };
    }),
  }),
  useRetryAgencyMessage: () => ({
    isPending: false,
    mutateAsync: vi.fn(async (id: string) => { retried.push(id); return { message: null }; }),
  }),
}));

import BuilderAgencies from '../BuilderAgencies';
import { builderNavItemVisible } from '@/components/builder-portal/builderNavVisibility.pure';

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
        <Route path="/builder/agencies" element={<BuilderAgencies />} />
        <Route path="/builder/agencies/:tab" element={<BuilderAgencies />} />
        <Route path="/builder/projects/:projectId" element={<p>Project page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  refreshed.firstPage = 0;
  refreshed.every = 0;
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
  it('offers the Agencies area only to a user who can already view activations', () => {
    const item = { to: '/builder/agencies', label: 'Agencies', permission: 'inventory' } as const;
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

  it('is declared in the portal navigation and routed as one section with bookmarkable tabs', () => {
    const layout = code('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toMatch(/to: '\/builder\/agencies', label: 'Agencies'[^}]*permission: 'inventory'/);
    expect(layout).toContain('builderNavItemVisible(');
    const app = code('src/App.tsx');
    expect(app).toContain('path="agencies"');
    expect(app).toContain('path="agencies/:tab"');
  });

  it('does not replace or rename the builder team\'s own Messages section', () => {
    const layout = code('src/components/builder-portal/BuilderPortalLayout.tsx');
    expect(layout).toContain("{ to: '/builder/messages', label: 'Messages'");
  });
});

describe('Activated Properties', () => {
  it('lists each activation with its property, design, agency, contact and acknowledgement', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies/activations');
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
    renderAt('/builder/agencies/activations');
    expect(screen.getByRole('link', { name: /view project/i })).toHaveAttribute('href', '/builder/projects/proj-a1');
  });

  it('draws no project link where the builder has no project access', () => {
    state.records = [{ ...ACTIVATION, project: { id: 'proj-a1', accessible: false } }];
    renderAt('/builder/agencies/activations');
    expect(screen.queryByRole('link', { name: /view project/i })).toBeNull();
  });

  it('says when no agency has activated anything yet', () => {
    renderAt('/builder/agencies/activations');
    expect(screen.getByText(/no agency has activated/i)).toBeInTheDocument();
  });

  it('says so, rather than showing an empty list, when the server refuses', () => {
    state.error = { status: 403, message: 'You do not have access to stock' };
    renderAt('/builder/agencies/activations');
    expect(screen.getByText(/do not have access/i)).toBeInTheDocument();
    expect(screen.queryByText(/no agency has activated/i)).toBeNull();
  });

  it('is the section\'s default tab', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies');
    expect(screen.getByRole('tab', { name: /activated properties/i })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Messages', () => {
  it('lists one conversation per agency and property', () => {
    state.records = [ACTIVATION, { ...ACTIVATION, id: 'ann-a1-again' }];
    renderAt('/builder/agencies/messages');
    expect(screen.getByRole('tab', { name: /messages/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('offers a conversation from beyond the first page of activations', () => {
    state.records = [ACTIVATION];
    state.laterPages = [{ ...ACTIVATION, id: 'ann-z', connection_id: 'conn-z', stock_item_id: 'item-z',
      agency: { ...ACTIVATION.agency, name: 'Page Two Agency' } }];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    renderAt('/builder/agencies/messages?thread=conn-z:item-z');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /page two agency/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('an open conversation with nothing in it says so, and can be written to', () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
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
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
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
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
    expect(screen.getByText('Did this arrive?')).toBeInTheDocument();
    expect(screen.getByText('Not delivered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /send again/i }));
    expect(retried).toEqual(['m-failed']);
  });

  it('sends what was typed with one idempotency key, and keeps the key if the send is repeated', async () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: null, open: true, can_send: true, messages: [] };
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
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
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
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
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
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
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
    expect(screen.getByText('Did this arrive?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send again/i })).toBeNull();
  });

  it('a closed conversation keeps its history and cannot be written to', () => {
    state.records = [ACTIVATION];
    state.conversation = { conversation_id: 'c', open: false, can_send: false, messages: [MESSAGE({})] };
    renderAt('/builder/agencies/messages?thread=conn-a:item-a1');
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();
    expect(screen.getByText(/no longer activated/i)).toBeInTheDocument();
  });

  it('tells an organisation with no activations that there is nobody to message yet', () => {
    renderAt('/builder/agencies/messages');
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
  });

  it('no model and no email: a message is text between people', () => {
    const page = code('src/pages/builder/BuilderAgencies.tsx');
    expect(page).not.toMatch(/openrouter|anthropic|openai|claude/i);
    expect(page).not.toMatch(/sendEmail|resend/i);
  });
});

describe('the page\'s Refresh', () => {
  it('re-reads the full conversation list as well as the first page, so a new activation appears in Messages', () => {
    state.records = [ACTIVATION];
    renderAt('/builder/agencies/messages');
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(refreshed.firstPage).toBe(1);
    expect(refreshed.every).toBe(1);
  });
});
