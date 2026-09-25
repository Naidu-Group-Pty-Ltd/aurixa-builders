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
import { agencyDedupeKeyFor, agencyPayloadContractViolation, sameAgencyEnvelope } from '../../../supabase/functions/_shared/builderStock/agencyMessages.pure';
import { readAgencyConversation } from '../../../supabase/functions/_shared/builderStock/agencyMessages';
import {
  AGENCY_CONVERSATION_CLOSED_POLL_MS, AGENCY_CONVERSATION_POLL_MS, agencyConversationPollInterval, arrivalScrollTarget, collectEveryPage, newClientMessageId, outboundStateLabel, scrollLogToEnd,
} from '../builderAgency';

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
    let cap = Infinity;
    const builder: any = {
      select() { return builder; },
      eq(col: string, v: unknown) { entry.filters.push(['eq', col, v]); return builder; },
      neq(col: string, v: unknown) { entry.filters.push(['neq', col, v]); return builder; },
      in(col: string, v: unknown[]) { entry.filters.push(['in', col, v]); return builder; },
      order(col: string, o?: { ascending?: boolean }) { orders = [...orders, [col, o?.ascending !== false]]; return builder; },
      limit(n: number) { cap = n; return builder; },
      maybeSingle() { return builder.then((r: any) => ({ data: r.data[0] ?? null, error: null })); },
      then(resolve: (v: unknown) => unknown) {
        let rows = (tables[table] ?? []).filter((row) => entry.filters.every(([op, col, v]) =>
          op === 'eq' ? row[col] === v : op === 'neq' ? row[col] !== v : (v as unknown[]).includes(row[col])));
        for (const [col, asc] of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        return Promise.resolve({ data: rows.slice(0, cap), error: null }).then(resolve);
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
    workspace_connections: [
      { id: CONN, builder_organisation_id: ORG, state: 'active' },
      { id: 'conn-b', builder_organisation_id: 'org-b', state: 'active' },
    ],
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

  it('past the cap, the thread shows the NEWEST messages, still in reading order', async () => {
    const f = fixture();
    f.builder_agency_messages = Array.from({ length: 501 }, (_, i) => ({
      id: `m${String(i).padStart(4, '0')}`, conversation_id: CONV, side: 'command_centre',
      sender_display_name: 'Casey Agent', body: `Message ${i}`,
      sent_at: new Date(Date.UTC(2026, 8, 25, 0, 0, i)).toISOString(), delivery_state: null,
      delivered_at: null, failure_reason: null, sender_builder_user_id: null, client_message_id: null, delivery_generation: 1,
    }));
    const read = await readAgencyConversation(standIn(f).client, {
      organisationId: ORG, connectionId: CONN, stockItemId: ITEM, viewerUserId: ME,
    });
    if (!read.ok) throw new Error('read failed');
    expect(read.messages).toHaveLength(500);
    expect(read.messages[0].body).toBe('Message 1');
    expect(read.messages[499].body).toBe('Message 500');
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

  it('18. polling refresh gets new messages: the next read carries what was written since the last', async () => {
    const f = fixture();
    const args = { organisationId: ORG, connectionId: CONN, stockItemId: ITEM, viewerUserId: ME };
    const first = await readAgencyConversation(standIn(f).client, args);
    if (!first.ok) throw new Error('read failed');
    expect(first.messages.map((m) => m.id)).not.toContain('m-new');
    f.builder_agency_messages.push({
      id: 'm-new', conversation_id: CONV, side: 'command_centre', sender_display_name: 'Casey Agent', body: 'Just arrived',
      sent_at: '2026-09-25T13:00:00Z', delivery_state: null, delivered_at: null, failure_reason: null,
      sender_builder_user_id: null, client_message_id: null, delivery_generation: 1,
    });
    const next = await readAgencyConversation(standIn(f).client, args);
    if (!next.ok) throw new Error('read failed');
    expect(next.messages.at(-1)?.body).toBe('Just arrived');
    expect(readCode('src/lib/builderStockQueries.ts')).toMatch(/refetchInterval:\s*\(query\)\s*=>\s*agencyConversationPollInterval/);
  });

  it('a revoked connection is read-only, even while its activation row stands', async () => {
    const f = fixture();
    f.workspace_connections[0].state = 'revoked';
    const read = await readAgencyConversation(standIn(f).client, {
      organisationId: ORG, connectionId: CONN, stockItemId: ITEM, viewerUserId: ME,
    });
    expect(read).toMatchObject({ ok: true, open: false });
    if (read.ok) expect(read.messages.length).toBeGreaterThan(0);
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
    expect(outboundStateLabel('failed', 'refused:conversation_not_open')).toBe('Not delivered');
    // Nobody refused it: the other side may have it, and we never heard back.
    expect(outboundStateLabel('failed', 'confirmation_timeout')).toBe('Not confirmed');
  });
});

describe('following what a poll brings in', () => {
  it('opens at the end, follows a new last message, brings a late one into view, and stays put otherwise', () => {
    expect(arrivalScrollTarget(null, ['a', 'b'])).toBe('end');
    expect(arrivalScrollTarget(['a', 'b'], ['a', 'b', 'c'])).toBe('end');
    expect(arrivalScrollTarget(['a', 'c'], ['a', 'b', 'c'])).toBe('b');
    expect(arrivalScrollTarget(['a', 'b'], ['a', 'b'])).toBeNull();
    expect(arrivalScrollTarget(['a', 'b'], ['b'])).toBeNull();
  });
});

describe('polling and paging', () => {
  it('polls an open conversation, and a closed one only slowly, so a re-activation still reopens it', () => {
    expect(agencyConversationPollInterval(undefined)).toBe(AGENCY_CONVERSATION_POLL_MS);
    expect(agencyConversationPollInterval({ open: true })).toBe(AGENCY_CONVERSATION_POLL_MS);
    expect(agencyConversationPollInterval({ open: false })).toBe(AGENCY_CONVERSATION_CLOSED_POLL_MS);
    expect(AGENCY_CONVERSATION_CLOSED_POLL_MS).toBeGreaterThanOrEqual(6 * AGENCY_CONVERSATION_POLL_MS);
    expect(readCode('src/lib/builderStockQueries.ts'))
      .toMatch(/refetchInterval:\s*\(query\)\s*=>\s*agencyConversationPollInterval\(query\.state\.data\)/);
  });

  it('collects every page, in order, and stops at the stated last page', async () => {
    const asked: number[] = [];
    const all = await collectEveryPage(async (page) => {
      asked.push(page);
      return { records: [`r${page}a`, `r${page}b`], pagination: { page, page_size: 2, total: 5, total_pages: 3 } };
    });
    expect(asked).toEqual([1, 2, 3]);
    expect(all).toEqual(['r1a', 'r1b', 'r2a', 'r2b', 'r3a', 'r3b']);
  });

  it('the refresh reaches the same cache the full list is read from', () => {
    const q = readCode('src/lib/builderStockQueries.ts');
    expect(q).toMatch(/queryKey:\s*EVERY_ACTIVATED_PROPERTIES_KEY/);
    expect(q).toMatch(/invalidateQueries\(\{\s*queryKey:\s*EVERY_ACTIVATED_PROPERTIES_KEY\s*\}\)/);
  });

  it('follows every page the server reports, past any fixed page count (an organisation with 4,000+ activations)', async () => {
    const asked: number[] = [];
    const all = await collectEveryPage(async (page) => {
      asked.push(page);
      return { records: [page], pagination: { page, page_size: 1, total: 60, total_pages: 60 } };
    });
    expect(asked.length).toBe(60);
    expect(all).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('stops at an empty page, whatever the server claims', async () => {
    let asked = 0;
    const all = await collectEveryPage(async (page) => {
      asked += 1;
      return { records: page <= 3 ? [page] : [], pagination: { page, page_size: 1, total: 1_000_000, total_pages: 1_000_000 } };
    });
    expect(asked).toBe(4);
    expect(all).toEqual([1, 2, 3]);
  });

  it('stops once it holds the count the server stated, whatever page count it claims', async () => {
    let asked = 0;
    await collectEveryPage(async (page) => {
      asked += 1;
      return { records: [page, page], pagination: { page, page_size: 2, total: 6, total_pages: 1_000_000 } };
    });
    expect(asked).toBe(3);
  });
});

describe('a reader who may not write', () => {
  it('is never offered "Send again": the read gates the retry on inventory edit', () => {
    const stock = readCode('supabase/functions/builder-portal-stock/index.ts');
    const start = stock.indexOf("operation === 'get_agency_conversation'");
    const op = stock.slice(start, stock.indexOf('operation ===', start + 20));
    expect(op).toMatch(/can_retry:\s*message\.can_retry\s*&&\s*mayEdit/);
  });
});

describe('the exact message contract, at the door', () => {
  const posted = {
    schema_version: 1, conversation_id: 'c', message_id: 'm', stock_item_id: 'i', body: 'Hello',
    sender_display_name: 'Avery', sent_at: '2026-09-25T00:00:00Z', generation: 1,
  };
  const receipt = { schema_version: 1, message_id: 'm', conversation_id: 'c', generation: 1, outcome: 'accepted' };

  it('accepts exactly the contract\'s keys, and a receipt\'s optional reason', () => {
    expect(agencyPayloadContractViolation('agency.message.posted', posted)).toBeNull();
    expect(agencyPayloadContractViolation('agency.message.receipt', receipt)).toBeNull();
    expect(agencyPayloadContractViolation('agency.message.receipt', { ...receipt, outcome: 'refused', reason: 'x' })).toBeNull();
  });

  it('refuses any key outside the contract, naming the key and never its value', () => {
    const extra = agencyPayloadContractViolation('agency.message.posted', { ...posted, customer_details: 'Jordan Buyer, 0400 000 000' });
    expect(extra).toMatchObject({ unexpected: ['customer_details'], missing: [] });
    expect(JSON.stringify(extra)).not.toContain('Jordan');
    expect(agencyPayloadContractViolation('agency.message.receipt', { ...receipt, client_id: 'x' }))
      .toMatchObject({ unexpected: ['client_id'] });
  });

  it('refuses a payload missing a contract key, and one that is not an object', () => {
    const { body: _omit, ...short } = posted;
    expect(agencyPayloadContractViolation('agency.message.posted', short)).toMatchObject({ missing: ['body'] });
    expect(agencyPayloadContractViolation('agency.message.posted', null)).not.toBeNull();
    expect(agencyPayloadContractViolation('agency.message.posted', ['x'])).not.toBeNull();
  });

  it('has no opinion on event types that are not messages', () => {
    expect(agencyPayloadContractViolation('stock.selection.announced', { anything: 1 })).toBeNull();
  });

  it('the door checks the contract before it stores anything', () => {
    const door = readCode('supabase/functions/builder-network-inbound/index.ts');
    const check = door.indexOf('agencyPayloadContractViolation(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(door.indexOf(".from('builder_network_inbound_events')"));
  });
});

describe('the exact message contract: each value\'s JSON type', () => {
  const posted = {
    schema_version: 1, conversation_id: 'c', message_id: 'm', stock_item_id: 'i', body: 'Hello',
    sender_display_name: 'Avery', sent_at: '2026-09-25T00:00:00Z', generation: 1,
  };
  it('refuses a body, a name or an id that is not a string, and a generation that is not a number', () => {
    expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, body: { text: 'hello' } }))
      .toMatchObject({ mistyped: ['body'] });
    expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, sender_display_name: ['A'] }))
      .toMatchObject({ mistyped: ['sender_display_name'] });
    expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, generation: '1' }))
      .toMatchObject({ mistyped: ['generation'] });
    expect(agencyPayloadContractViolation('agency.message.receipt',
      { schema_version: 1, message_id: 'm', conversation_id: 'c', generation: 1, outcome: 'refused', reason: 7 }))
      .toMatchObject({ mistyped: ['reason'] });
  });
  it('accepts a receipt whose reason is absent or null', () => {
    const receipt = { schema_version: 1, message_id: 'm', conversation_id: 'c', generation: 1, outcome: 'accepted' };
    expect(agencyPayloadContractViolation('agency.message.receipt', receipt)).toBeNull();
    expect(agencyPayloadContractViolation('agency.message.receipt', { ...receipt, reason: null })).toBeNull();
  });
});

describe('the conversation log', () => {
  it('is scrolled to its newest message', () => {
    const log = { scrollTop: 0, scrollHeight: 1840 };
    scrollLogToEnd(log);
    expect(log.scrollTop).toBe(1840);
    expect(() => scrollLogToEnd(null)).not.toThrow();
  });
});

describe('a message envelope\'s dedupe key is bound to its payload', () => {
  const posted = { schema_version: 1, conversation_id: 'c', message_id: 'm-1', stock_item_id: 'i', body: 'Hi',
    sender_display_name: 'A', sent_at: '2026-09-25T00:00:00Z', generation: 2 };
  it('names the key the payload implies, and nothing for other events', () => {
    expect(agencyDedupeKeyFor('agency.message.posted', posted)).toBe('agency.message:m-1:2');
    expect(agencyDedupeKeyFor('agency.message.receipt', { message_id: 'm-1', generation: 3 })).toBe('agency.receipt:m-1:3');
    expect(agencyDedupeKeyFor('stock.selection.announced', { message_id: 'm-1', generation: 1 })).toBeNull();
  });
  it('the door refuses a message envelope whose key is not that one, before it stores anything', () => {
    const door = readCode('supabase/functions/builder-network-inbound/index.ts');
    const check = door.indexOf('agencyDedupeKeyFor(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(door.indexOf(".from('builder_network_inbound_events')"));
    expect(door).toMatch(/message_dedupe_key_mismatch/);
  });
});

describe('a generation is a positive whole number', () => {
  const posted = { schema_version: 1, conversation_id: 'c', message_id: 'm', stock_item_id: 'i', body: 'Hi',
    sender_display_name: 'A', sent_at: '2026-09-25T00:00:00Z', generation: 1 };
  it('refuses a schema version it cannot apply, so a skewed peer keeps retrying instead of being marked delivered', () => {
    for (const schema_version of [2, 0, 1.5]) {
      expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, schema_version })).toMatchObject({ mistyped: ['schema_version'] });
      expect(agencyPayloadContractViolation('agency.message.receipt',
        { schema_version, message_id: 'm', conversation_id: 'c', generation: 1, outcome: 'accepted' })).toMatchObject({ mistyped: ['schema_version'] });
    }
    expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, schema_version: 1 })).toBeNull();
  });
  it('refuses a fractional, zero, negative or out-of-range generation', () => {
    for (const generation of [1.5, 0, -1, 2 ** 31]) {
      expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, generation })).toMatchObject({ mistyped: ['generation'] });
    }
    expect(agencyPayloadContractViolation('agency.message.posted', { ...posted, generation: 7 })).toBeNull();
  });
});

describe('a duplicate message key is a duplicate only if it is the same envelope', () => {
  const stored = { connection_id: 'conn', event_type: 'agency.message.posted',
    payload: { message_id: 'm', generation: 1, body: 'Hello', sent_at: '2026-09-25T00:00:00Z' } };
  it('matches the same envelope whatever the key order', () => {
    expect(sameAgencyEnvelope(stored, { ...stored, payload: { sent_at: '2026-09-25T00:00:00Z', body: 'Hello', generation: 1, message_id: 'm' } })).toBe(true);
  });
  it('does not match a changed body, another connection or another type', () => {
    expect(sameAgencyEnvelope(stored, { ...stored, payload: { ...stored.payload, body: 'Changed' } })).toBe(false);
    expect(sameAgencyEnvelope(stored, { ...stored, connection_id: 'other' })).toBe(false);
    expect(sameAgencyEnvelope(stored, { ...stored, event_type: 'agency.message.receipt' })).toBe(false);
  });
  it('the door compares a message duplicate before acknowledging it', () => {
    const door = readCode('supabase/functions/builder-network-inbound/index.ts');
    const dup = door.slice(door.indexOf("=== '23505'"));
    expect(dup.indexOf('sameAgencyEnvelope(')).toBeGreaterThan(-1);
    expect(dup.indexOf('sameAgencyEnvelope(')).toBeLessThan(dup.indexOf('duplicate: true'));
    expect(dup).toMatch(/error: 'message_conflict' \}, 409/);
  });
});
