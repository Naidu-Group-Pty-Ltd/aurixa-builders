/**
 * "NEW MESSAGE FROM <AGENCY>" — WHAT THE POPUP IS TOLD, AND WHO IS TOLD IT.
 *
 * The builder-side counterpart of the Command Centre's popup. The read behind
 * it is pinned to the conversations the reader is in NOW, in the organisation
 * the session acts for, to the agency's side only, and to what arrived after
 * the reader's cursor on this database's clock. It carries who wrote, about
 * which property and when it landed — never the body and never a user id —
 * and the edge operation that serves it writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newAgencyMessages } from '../../../supabase/functions/_shared/builderStock/agencyMessages';
import {
  AGENCY_MESSAGE_POPUP_POLL_MS, agencyConversationHref, agencyMessagePollingRefused, agencyMessagePopup,
  isViewingAgencyConversation, type NewAgencyMessage,
} from '../agencyMessagePopups.pure';
import { AGENCY_CONVERSATION_POLL_MS } from '../builderAgency';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const readCode = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

type Row = Record<string, any>;
type Filter = [string, string, unknown];

/** A PostgREST stand-in that records every filter it was asked for. */
function standIn(tables: Record<string, Row[]>) {
  const log: Array<{ table: string; filters: Filter[] }> = [];
  const from = (table: string) => {
    const entry = { table, filters: [] as Filter[] };
    log.push(entry);
    let orders: Array<[string, boolean]> = [];
    let cap = Infinity;
    let offset = 0;
    const builder: any = {
      select() { return builder; },
      eq(col: string, v: unknown) { entry.filters.push(['eq', col, v]); return builder; },
      in(col: string, v: unknown[]) { entry.filters.push(['in', col, v]); return builder; },
      gt(col: string, v: unknown) { entry.filters.push(['gt', col, v]); return builder; },
      order(col: string, o?: { ascending?: boolean }) { orders = [...orders, [col, o?.ascending !== false]]; return builder; },
      limit(n: number) { cap = n; return builder; },
      range(a: number, b: number) { offset = a; cap = b - a + 1; return builder; },
      then(resolve: (v: unknown) => unknown) {
        let rows = (tables[table] ?? []).filter((row) => entry.filters.every(([op, col, v]) =>
          op === 'eq' ? row[col] === v
            : op === 'gt' ? String(row[col]) > String(v)
            : (v as unknown[]).includes(row[col])));
        for (const [col, asc] of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        return Promise.resolve({ data: rows.slice(offset, offset + cap), error: null }).then(resolve);
      },
    };
    return builder;
  };
  return { client: { from }, log };
}

const ORG = 'org-a';
const ME = 'user-me';
const COLLEAGUE = 'user-colleague';
const OUTSIDER = 'user-outsider';

const message = (id: string, conversation: string, side: string, createdAt: string, extra: Row = {}): Row => ({
  id, conversation_id: conversation, side, sender_display_name: side === 'builder' ? 'Avery Builder' : 'Casey Agent',
  body: `Private body of ${id}`, sent_at: createdAt, created_at: createdAt,
  sender_builder_user_id: side === 'builder' ? ME : null, client_message_id: side === 'builder' ? `client-${id}` : null,
  delivery_state: side === 'builder' ? 'delivered' : null, ...extra,
});

function world(): Record<string, Row[]> {
  return {
    builder_agency_conversation_participants: [
      { conversation_id: 'conv-a', participant_ref: 'ref-me', side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'joined' },
      { conversation_id: 'conv-a', participant_ref: 'ref-col', side: 'builder', builder_user_id: COLLEAGUE, display_name: 'Alex Builder', state: 'joined' },
      // In another organisation's conversation: this session acts for org-a.
      { conversation_id: 'conv-other-org', participant_ref: 'ref-me-2', side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'joined' },
      // Left: no longer told anything about it.
      { conversation_id: 'conv-left', participant_ref: 'ref-me-3', side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'left' },
      // The agency's participant is a display record and grants nothing.
      { conversation_id: 'conv-a', participant_ref: 'ref-agent', side: 'command_centre', builder_user_id: null, display_name: 'Casey Agent', state: 'joined' },
    ],
    builder_agency_conversations: [
      { id: 'conv-a', organisation_id: ORG, connection_id: 'conn-a', stock_item_id: 'item-a1', selection_ref: 'ref-1', last_message_at: '2026-09-27T12:00:00.000001+00:00' },
      { id: 'conv-left', organisation_id: ORG, connection_id: 'conn-a', stock_item_id: 'item-a1', selection_ref: 'ref-2', last_message_at: null },
      { id: 'conv-other-org', organisation_id: 'org-b', connection_id: 'conn-b', stock_item_id: 'item-b1', selection_ref: 'ref-9', last_message_at: null },
    ],
    builder_agency_messages: [
      message('m-ours', 'conv-a', 'builder', '2026-09-27T10:00:00.000001+00:00'),
      message('m-agency-1', 'conv-a', 'command_centre', '2026-09-27T11:00:00.000001+00:00'),
      message('m-agency-2', 'conv-a', 'command_centre', '2026-09-27T12:00:00.000001+00:00'),
      message('m-ours-later', 'conv-a', 'builder', '2026-09-27T12:30:00.000001+00:00'),
      message('m-left', 'conv-left', 'command_centre', '2026-09-27T12:40:00.000001+00:00'),
      message('m-other-org', 'conv-other-org', 'command_centre', '2026-09-27T12:50:00.000001+00:00'),
    ],
    builder_stock_items: [
      { id: 'item-a1', organisation_id: ORG, address_line: '1 Private Street', lot_number: '101' },
    ],
    builder_stock_selection_announcements: [
      { connection_id: 'conn-a', remote_selection_ref: 'ref-1', organisation_id: ORG, status: 'builder_acknowledged',
        acknowledged_at: '2026-09-25T09:00:00Z', agency_name: 'Check Agency Pty Ltd' },
    ],
    workspace_connections: [
      { id: 'conn-a', builder_organisation_id: ORG, state: 'active', workspace_id: 'ws-1' },
    ],
    workspace_registry: [{ id: 'ws-1', display_name: 'Workspace One' }],
  };
}

const read = (viewerUserId: string, since: string | null, tables = world()) =>
  newAgencyMessages(standIn(tables).client, { organisationId: ORG, viewerUserId, since });

describe('the new-message read behind the popup', () => {
  it('a first read takes the cursor and names nothing, so opening the portal replays no message', async () => {
    const answer = await read(ME, null);
    if (!answer.ok) throw new Error('failed');
    expect(answer.messages).toEqual([]);
    // The newest AGENCY arrival in the reader's own conversations of this
    // organisation: not what this side wrote, not another organisation's.
    expect(answer.cursor).toBe('2026-09-27T12:00:00.000001+00:00');
  });

  it('names each agency message that arrived after the cursor, with the agency and the property', async () => {
    const answer = await read(ME, '2026-09-27T10:30:00+00:00');
    if (!answer.ok) throw new Error('failed');
    expect(answer.messages).toEqual([
      { message_id: 'm-agency-1', conversation_id: 'conv-a', agency_name: 'Check Agency Pty Ltd',
        sender_display_name: 'Casey Agent', lot_number: '101', address: '1 Private Street',
        received_at: '2026-09-27T11:00:00.000001+00:00' },
      { message_id: 'm-agency-2', conversation_id: 'conv-a', agency_name: 'Check Agency Pty Ltd',
        sender_display_name: 'Casey Agent', lot_number: '101', address: '1 Private Street',
        received_at: '2026-09-27T12:00:00.000001+00:00' },
    ]);
    expect(answer.cursor).toBe('2026-09-27T12:00:00.000001+00:00');
    const after = await read(ME, answer.cursor);
    if (!after.ok) throw new Error('failed');
    expect(after.messages).toEqual([]);
    expect(after.cursor).toBe(answer.cursor);
  });

  it('never names what this side wrote, a conversation the reader left, or another organisation\'s', async () => {
    const answer = await read(ME, '1970-01-01T00:00:00Z');
    if (!answer.ok) throw new Error('failed');
    expect(answer.messages.map((m) => m.message_id)).toEqual(['m-agency-1', 'm-agency-2']);
  });

  it('tells a colleague in the same conversation, and nobody who is not in it', async () => {
    const colleague = await read(COLLEAGUE, '1970-01-01T00:00:00Z');
    if (!colleague.ok) throw new Error('failed');
    expect(colleague.messages.map((m) => m.message_id)).toEqual(['m-agency-1', 'm-agency-2']);
    const outsider = await read(OUTSIDER, '1970-01-01T00:00:00Z');
    if (!outsider.ok) throw new Error('failed');
    expect(outsider.messages).toEqual([]);
  });

  it('asks for the agency\'s side, within the session\'s organisation, after the cursor', async () => {
    const db = standIn(world());
    await newAgencyMessages(db.client, { organisationId: ORG, viewerUserId: ME, since: '2026-09-27T10:30:00+00:00' });
    const messages = db.log.find((q) => q.table === 'builder_agency_messages')!;
    expect(messages.filters).toContainEqual(['eq', 'side', 'command_centre']);
    expect(messages.filters).toContainEqual(['gt', 'created_at', '2026-09-27T10:30:00+00:00']);
    const conversations = db.log.find((q) => q.table === 'builder_agency_conversations')!;
    expect(conversations.filters).toContainEqual(['eq', 'organisation_id', ORG]);
  });

  it('carries no message body and no user id to the browser', async () => {
    const answer = await read(ME, '1970-01-01T00:00:00Z');
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(/Private body|user-me|user-colleague|sender_builder_user_id|client_message_id|client-m/);
  });

  it('says it could not read rather than answering "nothing new"', async () => {
    const failing = { from: () => {
      const builder: any = {
        select: () => builder, eq: () => builder, in: () => builder, gt: () => builder,
        order: () => builder, limit: () => builder, range: () => builder,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve),
      };
      return builder;
    } };
    expect(await newAgencyMessages(failing, { organisationId: ORG, viewerUserId: ME, since: null })).toEqual({ ok: false });
  });
});

describe('the edge operation', () => {
  const fn = readCode('supabase/functions/builder-portal-stock/index.ts');
  const at = fn.indexOf("operation === 'list_new_agency_messages'");
  const block = fn.slice(at, fn.indexOf('if (operation ===', at + 10));

  it('reads with the session\'s own organisation and user, and writes nothing', () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain('newAgencyMessages(supabase, { organisationId: activeOrganisationId, viewerUserId: me.id, since })');
    expect(block).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it('sits behind the session and the inventory gate every stock operation passes', () => {
    expect(fn.indexOf("if (!await can('view'))")).toBeGreaterThan(-1);
    expect(fn.indexOf("if (!await can('view'))")).toBeLessThan(at);
  });
});

describe('what the popup says, and where it leads', () => {
  const base: NewAgencyMessage = {
    message_id: 'm1', conversation_id: 'conv-1', agency_name: 'Naidu Property Consulting Services',
    sender_display_name: 'Casey Agent', lot_number: '1629', address: '12 Example Street',
    received_at: '2026-09-27T12:00:00Z',
  };

  it('names the agency, then who wrote it and the property', () => {
    expect(agencyMessagePopup(base)).toEqual({
      id: 'm1',
      title: 'New message from Naidu Property Consulting Services',
      description: 'Casey Agent · Lot 1629, 12 Example Street',
      href: '/builder/messages?view=agencies&thread=conv-1',
    });
  });

  it('says something true when a part is missing', () => {
    expect(agencyMessagePopup({ ...base, agency_name: null }).title).toBe('New message from an agency');
    expect(agencyMessagePopup({ ...base, address: null }).description).toBe('Casey Agent · Lot 1629');
    expect(agencyMessagePopup({ ...base, sender_display_name: '', lot_number: null, address: null }).description)
      .toBe('Open the conversation to read it.');
  });

  it('opens the exact conversation on the Messages page, encoded', () => {
    expect(agencyConversationHref('a/b')).toBe('/builder/messages?view=agencies&thread=a%2Fb');
  });

  it('knows when the reader is already looking at that conversation', () => {
    const at = (search: string, pathname = '/builder/messages') => ({ pathname, search });
    expect(isViewingAgencyConversation(at('?view=agencies&thread=conv-1'), 'conv-1')).toBe(true);
    expect(isViewingAgencyConversation(at('?thread=conv-1'), 'conv-1')).toBe(true);
    expect(isViewingAgencyConversation(at('?view=agencies&thread=conv-2'), 'conv-1')).toBe(false);
    /*
     * RENEGOTIATED 2 OCTOBER 2026. `view=projects` used to mean the reader was
     * on the OTHER tab, so they were not looking at this conversation. That
     * tab is withdrawn and the URL now resolves to the agency conversations,
     * so a reader at this address IS looking at it — and popping a toast about
     * a conversation already on screen is the thing this predicate exists to
     * stop. The guarantee is unchanged; the address means something new.
     */
    expect(isViewingAgencyConversation(at('?view=projects&thread=conv-1'), 'conv-1')).toBe(true);
    expect(isViewingAgencyConversation(at('?view=agencies&thread=conv-1', '/builder/activations'), 'conv-1')).toBe(false);
  });

  it('stops asking once refused, and keeps asking through anything transient', () => {
    for (const status of [401, 403, 409]) expect(agencyMessagePollingRefused(status)).toBe(true);
    for (const status of [undefined, 500, 502, 503, 546]) expect(agencyMessagePollingRefused(status)).toBe(false);
  });

  it('asks more often than an open conversation re-reads itself, and it is still polling', () => {
    expect(AGENCY_MESSAGE_POPUP_POLL_MS).toBeGreaterThanOrEqual(3_000);
    expect(AGENCY_MESSAGE_POPUP_POLL_MS).toBeLessThan(AGENCY_CONVERSATION_POLL_MS);
  });

  it('is mounted once, in the portal layout every signed-in page shares', () => {
    const layout = readFileSync(join(REPO_ROOT, 'src/components/builder-portal/BuilderPortalLayout.tsx'), 'utf8');
    expect(layout.match(/<AgencyMessagePopups \/>/g)?.length).toBe(1);
  });
});
