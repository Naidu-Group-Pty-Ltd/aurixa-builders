/**
 * AGENCY MESSAGING — THE BUILDER PORTAL'S READ AND WRITE.
 *
 * The rows, the network contract and the delivery states are proved against a
 * real schema by `scripts/db/agency-messaging-check.mjs`. This pins what sits
 * in front of them: the conversation read is pinned to the session's
 * organisation and to an activation it holds, it serves only what a builder
 * may see (never a user id or a client key), writing needs `inventory` edit,
 * and every identity the SQL relies on comes from the session — never from
 * the request.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agencyMessageRefusal,
  projectAgencyMessages,
} from '../../../supabase/functions/_shared/builderStock/agencyMessages.pure';
import { readAgencyConversation } from '../../../supabase/functions/_shared/builderStock/agencyMessages';
import { newClientMessageId, outboundStateLabel } from '../builderAgency';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const readCode = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

type Row = Record<string, any>;
function standIn(tables: Record<string, Row[]>) {
  const log: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
  const from = (table: string) => {
    const entry = { table, filters: [] as Array<[string, string, unknown]> };
    log.push(entry);
    let orders: Array<[string, boolean]> = [];
    const builder: any = {
      select() { return builder; },
      eq(col: string, v: unknown) { entry.filters.push(['eq', col, v]); return builder; },
      neq(col: string, v: unknown) { entry.filters.push(['neq', col, v]); return builder; },
      in(col: string, v: unknown[]) { entry.filters.push(['in', col, v]); return builder; },
      order(col: string, o?: { ascending?: boolean }) { orders = [...orders, [col, o?.ascending !== false]]; return builder; },
      limit() { return builder; },
      maybeSingle() { return builder.then((r: any) => ({ data: r.data[0] ?? null, error: null })); },
      then(resolve: (v: unknown) => unknown) {
        let rows = (tables[table] ?? []).filter((row) => entry.filters.every(([op, col, v]) =>
          op === 'eq' ? row[col] === v : op === 'neq' ? row[col] !== v : (v as unknown[]).includes(row[col])));
        for (const [col, asc] of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  };
  return { client: { from }, log };
}

const ORG = 'org-a';
const CONN = 'conn-a';
const ITEM = 'item-a1';
const ME = 'user-me';
const CONV = 'conv-a';

function fixture() {
  return {
    builder_stock_selection_announcements: [
      { id: 'ann-1', connection_id: CONN, stock_item_id: ITEM, organisation_id: ORG, status: 'selected' },
      { id: 'ann-x', connection_id: 'conn-b', stock_item_id: 'item-b1', organisation_id: 'org-b', status: 'selected' },
    ],
    builder_agency_conversations: [
      { id: CONV, connection_id: CONN, stock_item_id: ITEM, organisation_id: ORG },
      { id: 'conv-b', connection_id: 'conn-b', stock_item_id: 'item-b1', organisation_id: 'org-b' },
    ],
    builder_agency_messages: [
      { id: 'm2', conversation_id: CONV, side: 'command_centre', sender_display_name: 'Casey Agent', body: 'Second',
        sent_at: '2026-09-25T11:00:00Z', delivery_state: null, delivered_at: null, failure_reason: null,
        sender_builder_user_id: null, client_message_id: null, delivery_generation: 1 },
      { id: 'm1', conversation_id: CONV, side: 'builder', sender_display_name: 'Avery Builder', body: 'First',
        sent_at: '2026-09-25T10:00:00Z', delivery_state: 'failed', delivered_at: null, failure_reason: 'not_delivered',
        sender_builder_user_id: ME, client_message_id: 'client-1', delivery_generation: 1 },
      { id: 'm3', conversation_id: CONV, side: 'builder', sender_display_name: 'Alex Builder', body: 'Third',
        sent_at: '2026-09-25T12:00:00Z', delivery_state: 'delivered', delivered_at: '2026-09-25T12:00:05Z', failure_reason: null,
        sender_builder_user_id: 'user-colleague', client_message_id: 'client-2', delivery_generation: 1 },
      { id: 'mb', conversation_id: 'conv-b', side: 'command_centre', sender_display_name: 'Other', body: 'Not yours',
        sent_at: '2026-09-25T09:00:00Z', delivery_state: null, delivered_at: null, failure_reason: null,
        sender_builder_user_id: null, client_message_id: null, delivery_generation: 1 },
    ],
  };
}

describe('reading a conversation', () => {
  it('opens only a conversation this organisation\'s activation stands behind', async () => {
    const db = standIn(fixture());
    const theirs = await readAgencyConversation(db.client, {
      organisationId: ORG, connectionId: 'conn-b', stockItemId: 'item-b1', viewerUserId: ME,
    });
    expect(theirs).toEqual({ ok: false, reason: 'not_found' });
    const announcements = db.log.find((q) => q.table === 'builder_stock_selection_announcements')!;
    expect(announcements.filters).toContainEqual(['eq', 'organisation_id', ORG]);
  });

  it('returns the thread in the order it was written, whatever order it arrived in', async () => {
    const db = standIn(fixture());
    const read = await readAgencyConversation(db.client, {
      organisationId: ORG, connectionId: CONN, stockItemId: ITEM, viewerUserId: ME,
    });
    if (!read.ok) throw new Error('read failed');
    expect(read.messages.map((m) => m.body)).toEqual(['First', 'Second', 'Third']);
    expect(JSON.stringify(read)).not.toContain('Not yours');
  });

  it('a property with an activation and no messages yet is an empty, open conversation', async () => {
    const f = fixture();
    f.builder_agency_messages = [];
    f.builder_agency_conversations = [];
    const read = await readAgencyConversation(standIn(f).client, {
      organisationId: ORG, connectionId: CONN, stockItemId: ITEM, viewerUserId: ME,
    });
    expect(read).toMatchObject({ ok: true, messages: [], open: true });
  });

  it('a withdrawn activation is read-only', async () => {
    const f = fixture();
    f.builder_stock_selection_announcements[0].status = 'withdrawn';
    const read = await readAgencyConversation(standIn(f).client, {
      organisationId: ORG, connectionId: CONN, stockItemId: ITEM, viewerUserId: ME,
    });
    expect(read).toMatchObject({ ok: true, open: false });
  });
});

describe('what a message tells the reader', () => {
  const rows = fixture().builder_agency_messages.filter((m) => m.conversation_id === CONV);
  const projected = projectAgencyMessages(rows, ME);

  it('names the actual sender on every message, and which side they are on', () => {
    expect(projected.map((m) => [m.sender_display_name, m.side])).toEqual([
      ['Avery Builder', 'builder'], ['Casey Agent', 'command_centre'], ['Alex Builder', 'builder'],
    ]);
  });

  it('shows a delivery state only for what this side sent', () => {
    expect(projected.find((m) => m.id === 'm2')!.delivery_state).toBeNull();
    expect(projected.find((m) => m.id === 'm3')!.delivery_state).toBe('delivered');
  });

  it('offers a retry only to the writer of a failed message', () => {
    expect(projected.find((m) => m.id === 'm1')).toMatchObject({ mine: true, can_retry: true, delivery_state: 'failed' });
    expect(projected.find((m) => m.id === 'm3')).toMatchObject({ mine: false, can_retry: false });
  });

  it('never carries a user id or the client key', () => {
    const text = JSON.stringify(projected);
    expect(text).not.toContain(ME);
    expect(text).not.toContain('user-colleague');
    expect(text).not.toContain('client-1');
    for (const m of projected) {
      expect(m).not.toHaveProperty('sender_builder_user_id');
      expect(m).not.toHaveProperty('client_message_id');
    }
  });
});

describe('refusals read as what they are', () => {
  it.each([
    ['AGENCY_CONVERSATION_NOT_FOUND', 404, 'not_found'],
    ['AGENCY_CONVERSATION_NOT_OPEN', 409, 'conversation_not_open'],
    ['AGENCY_MESSAGE_INVALID', 400, 'invalid_message'],
    ['AGENCY_MESSAGE_NOT_RETRYABLE', 409, 'not_retryable'],
    ['AGENCY_SENDER_NOT_A_MEMBER', 403, 'not_a_member'],
    ['AGENCY_MESSAGE_ID_REUSED', 409, 'message_id_reused'],
  ])('%s → %i', (raw, status, code) => {
    expect(agencyMessageRefusal(`ERROR: ${raw}`)).toMatchObject({ status, code });
  });
  it('anything else is not the caller\'s fault', () => {
    expect(agencyMessageRefusal('connection reset')).toBeNull();
  });
});

describe('the edge operations', () => {
  const stock = readCode('supabase/functions/builder-portal-stock/index.ts');
  const op = (name: string) => {
    const start = stock.indexOf(`operation === '${name}'`);
    const next = stock.indexOf('operation ===', start + 20);
    return stock.slice(start, next > 0 ? next : undefined);
  };

  it('all three exist behind the inventory gate', () => {
    const gate = stock.indexOf("if (!await can('view'))");
    for (const name of ['get_agency_conversation', 'send_agency_message', 'retry_agency_message']) {
      expect(stock.indexOf(`operation === '${name}'`), name).toBeGreaterThan(gate);
    }
  });

  it('writing needs inventory edit; reading needs only the gate', () => {
    expect(op('send_agency_message')).toContain("await can('edit')");
    expect(op('retry_agency_message')).toContain("await can('edit')");
    expect(op('get_agency_conversation')).not.toContain("if (!await can('edit'))");
  });

  it('the organisation and the sender come from the session, never the body', () => {
    for (const name of ['get_agency_conversation', 'send_agency_message', 'retry_agency_message']) {
      const body = op(name);
      expect(body, name).not.toMatch(/body\.(organisation_id|organisationId|sender|user_id|builder_user_id)/);
    }
    expect(op('send_agency_message')).toContain('_organisation_id: activeOrganisationId');
    expect(op('send_agency_message')).toContain('_sender_builder_user_id: me.id');
    expect(op('retry_agency_message')).toContain('_sender_builder_user_id: me.id');
  });

  it('no model, no email: a message is text between people', () => {
    for (const name of ['send_agency_message', 'retry_agency_message']) {
      expect(op(name)).not.toMatch(/openrouter|anthropic|openai|resend|sendEmail/i);
    }
  });
});

describe('the browser\'s half', () => {
  it('mints a fresh idempotency key per message', () => {
    const a = newClientMessageId();
    const b = newClientMessageId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('names the three delivery states in words', () => {
    expect(outboundStateLabel('queued')).toBe('Sending');
    expect(outboundStateLabel('delivered')).toBe('Delivered');
    expect(outboundStateLabel('failed')).toBe('Not delivered');
  });
});
