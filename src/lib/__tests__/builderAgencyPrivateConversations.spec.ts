/**
 * ONE ACTIVATION, ONE PRIVATE CONVERSATION — WHAT A BUILDER IS SERVED
 * (docs/builder-portal/62).
 *
 * The rows are proved by `scripts/db/agency-private-chat-check.mjs`. This
 * pins what stands in front of them on the server, because nothing here may
 * rely on a page hiding something:
 *
 * - a conversation is read only by one of its current participants in the
 *   session's organisation; `inventory` access alone reads nothing, and the
 *   messages are never even queried for anyone else;
 * - the Messages list is the viewer's own conversations and nobody else's;
 * - the participant list names both sides and never carries a user id;
 * - the operations take the organisation and the actor from the session, and
 *   there is no operation that removes anybody.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agencyDedupeKeyFor, agencyMessageRefusal, agencyPayloadContractViolation,
} from '../../../supabase/functions/_shared/builderStock/agencyMessages.pure';
import { listMyAgencyConversations, readAgencyConversation } from '../../../supabase/functions/_shared/builderStock/agencyMessages';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const readCode = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

type Row = Record<string, any>;
function standIn(tables: Record<string, Row[]>, options: { maxRows?: number } = {}) {
  const log: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
  const from = (table: string) => {
    const entry = { table, filters: [] as Array<[string, string, unknown]> };
    log.push(entry);
    let orders: Array<[string, boolean]> = [];
    // PostgREST's own ceiling on an unbounded read, where a test sets one.
    let cap = options.maxRows ?? Infinity;
    let offset = 0;
    const builder: any = {
      select() { return builder; },
      eq(col: string, v: unknown) { entry.filters.push(['eq', col, v]); return builder; },
      neq(col: string, v: unknown) { entry.filters.push(['neq', col, v]); return builder; },
      in(col: string, v: unknown[]) { entry.filters.push(['in', col, v]); return builder; },
      lt(col: string, v: unknown) { entry.filters.push(['lt', col, v]); return builder; },
      order(col: string, o?: { ascending?: boolean }) { orders = [...orders, [col, o?.ascending !== false]]; return builder; },
      limit(n: number) { cap = n; return builder; },
      range(a: number, b: number) { offset = a; cap = Math.min(b - a + 1, options.maxRows ?? Infinity); return builder; },
      maybeSingle() { return builder.then((r: any) => ({ data: r.data[0] ?? null, error: null })); },
      then(resolve: (v: unknown) => unknown) {
        let rows = (tables[table] ?? []).filter((row) => entry.filters.every(([op, col, v]) =>
          op === 'eq' ? row[col] === v : op === 'neq' ? row[col] !== v
            : op === 'lt' ? String(row[col]) < String(v) : (v as unknown[]).includes(row[col])));
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

function world() {
  return {
    workspace_connections: [
      { id: 'conn-a', builder_organisation_id: ORG, state: 'active', workspace_id: 'ws-1' },
    ],
    workspace_registry: [{ id: 'ws-1', display_name: 'Example Agency Workspace' }],
    builder_stock_selection_announcements: [
      { id: 'ann-1', connection_id: 'conn-a', stock_item_id: 'item-1', organisation_id: ORG, remote_selection_ref: 'ref-1',
        status: 'builder_acknowledged', acknowledged_at: '2026-09-25T02:00:00Z', agency_name: 'Example Agency' },
      { id: 'ann-2', connection_id: 'conn-a', stock_item_id: 'item-1', organisation_id: ORG, remote_selection_ref: 'ref-2',
        status: 'withdrawn', acknowledged_at: '2026-09-24T02:00:00Z', agency_name: 'Example Agency' },
    ],
    builder_stock_items: [{ id: 'item-1', organisation_id: ORG, address_line: '1 Private Street', lot_number: '101' }],
    builder_agency_conversations: [
      { id: 'conv-1', connection_id: 'conn-a', stock_item_id: 'item-1', organisation_id: ORG, selection_ref: 'ref-1', last_message_at: '2026-09-25T05:00:00Z' },
      { id: 'conv-2', connection_id: 'conn-a', stock_item_id: 'item-1', organisation_id: ORG, selection_ref: 'ref-2', last_message_at: '2026-09-24T05:00:00Z' },
      { id: 'conv-b', connection_id: 'conn-b', stock_item_id: 'item-b', organisation_id: 'org-b', selection_ref: 'ref-b', last_message_at: null },
    ],
    builder_agency_conversation_participants: [
      { conversation_id: 'conv-1', participant_ref: 'r-me', side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'joined', version: 1 },
      { conversation_id: 'conv-1', participant_ref: 'r-olive', side: 'command_centre', builder_user_id: null, display_name: 'Olive Owner', state: 'joined', version: 1 },
      { conversation_id: 'conv-2', participant_ref: 'r-col', side: 'builder', builder_user_id: COLLEAGUE, display_name: 'Alex Builder', state: 'joined', version: 1 },
      { conversation_id: 'conv-2', participant_ref: 'r-me-2', side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'left', version: 2 },
      { conversation_id: 'conv-b', participant_ref: 'r-x', side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'joined', version: 1 },
    ],
    builder_agency_messages: [
      { id: 'm1', conversation_id: 'conv-1', side: 'builder', sender_builder_user_id: ME, sender_display_name: 'Avery Builder',
        body: 'We can hold it.', sent_at: '2026-09-25T04:00:00Z', created_at: '2026-09-25T04:00:00Z',
        delivery_state: 'delivered', delivered_at: '2026-09-25T04:00:02Z', failure_reason: null },
      { id: 'm2', conversation_id: 'conv-2', side: 'command_centre', sender_builder_user_id: null, sender_display_name: 'Otto Other',
        body: 'Second activation.', sent_at: '2026-09-24T04:00:00Z', created_at: '2026-09-24T04:00:00Z',
        delivery_state: null, delivered_at: null, failure_reason: null },
    ],
  } as Record<string, Row[]>;
}

describe('reading a conversation is for its participants', () => {
  it('a participant past the server\'s row ceiling is still recognised, and the whole roster is read', async () => {
    const tables = world();
    for (let i = 0; i < 1201; i += 1) {
      tables.builder_agency_conversation_participants.unshift({ conversation_id: 'conv-1', participant_ref: `bulk-${String(i).padStart(4, '0')}`,
        side: 'command_centre', builder_user_id: null, display_name: `Agent ${i}`, state: 'joined', version: 1 });
    }
    const read = await readAgencyConversation(standIn(tables, { maxRows: 1000 }).client, { organisationId: ORG, conversationId: 'conv-1', viewerUserId: ME });
    if (!read.ok) throw new Error(`refused: ${read.reason}`);
    expect(read.participants.length).toBe(1203);
  });

  it('the whole history is reachable: the newest 500 first, then earlier pages by cursor, each message exactly once', async () => {
    const tables = world();
    for (let i = 0; i < 1203; i += 1) {
      const at = new Date(Date.UTC(2026, 8, 1) + Math.floor(i / 2) * 60_000).toISOString();
      tables.builder_agency_messages.push({ id: `h-${String(i).padStart(4, '0')}`, conversation_id: 'conv-1', side: 'command_centre',
        sender_builder_user_id: null, sender_display_name: 'Olive Owner', body: `History ${i}`, sent_at: at, created_at: at,
        delivery_state: null, delivered_at: null, failure_reason: null });
    }
    const client = standIn(tables, { maxRows: 1000 }).client;
    const first = await readAgencyConversation(client, { organisationId: ORG, conversationId: 'conv-1', viewerUserId: ME });
    if (!first.ok) throw new Error('refused');
    expect(first.messages).toHaveLength(500);
    expect(first.has_earlier).toBe(true);
    const seen = new Set(first.messages.map((m) => m.id));
    let cursor = first.earlier_cursor;
    let pages = 0;
    while (cursor) {
      const page = await readAgencyConversation(client, { organisationId: ORG, conversationId: 'conv-1', viewerUserId: ME, beforeMessageId: cursor });
      if (!page.ok) throw new Error('refused');
      for (const m of page.messages) {
        expect(seen.has(m.id)).toBe(false);
        seen.add(m.id);
      }
      cursor = page.has_earlier ? page.earlier_cursor : null;
      pages += 1;
      expect(pages).toBeLessThan(5);
    }
    expect(seen.size).toBe(1204);
  });

  it('a history cursor from another conversation reaches nothing, and a non-participant is refused with one', async () => {
    const page = await readAgencyConversation(standIn(world()).client,
      { organisationId: ORG, conversationId: 'conv-1', viewerUserId: ME, beforeMessageId: 'm2' });
    if (!page.ok) throw new Error('refused');
    expect(page.messages).toEqual([]);
    expect(page.has_earlier).toBe(false);
    const outsider = await readAgencyConversation(standIn(world()).client,
      { organisationId: ORG, conversationId: 'conv-1', viewerUserId: COLLEAGUE, beforeMessageId: 'm1' });
    expect(outsider).toEqual({ ok: false, reason: 'not_a_participant' });
  });

  it('N18/N38. a participant reads the thread and both sides\' current participants', async () => {
    const read = await readAgencyConversation(standIn(world()).client, { organisationId: ORG, conversationId: 'conv-1', viewerUserId: ME });
    if (!read.ok) throw new Error(`refused: ${read.reason}`);
    expect(read.messages.map((m) => m.body)).toEqual(['We can hold it.']);
    expect(read.participants.map((p) => `${p.side}:${p.display_name}`).sort()).toEqual(['builder:Avery Builder', 'command_centre:Olive Owner']);
    expect(read.open).toBe(true);
  });

  it('N10. a colleague with inventory access who is not in it is refused, and its messages are never read', async () => {
    const { client, log } = standIn(world());
    const read = await readAgencyConversation(client, { organisationId: ORG, conversationId: 'conv-1', viewerUserId: COLLEAGUE });
    expect(read).toEqual({ ok: false, reason: 'not_a_participant' });
    expect(log.some((entry) => entry.table === 'builder_agency_messages')).toBe(false);
  });

  it('N25. someone who left is refused like anyone else', async () => {
    const read = await readAgencyConversation(standIn(world()).client, { organisationId: ORG, conversationId: 'conv-2', viewerUserId: ME });
    expect(read).toEqual({ ok: false, reason: 'not_a_participant' });
  });

  it('N11. a conversation of another organisation is not found, whatever participant row exists', async () => {
    const read = await readAgencyConversation(standIn(world()).client, { organisationId: ORG, conversationId: 'conv-b', viewerUserId: ME });
    expect(read).toEqual({ ok: false, reason: 'not_found' });
  });

  it('N30. a withdrawn activation\'s conversation is read-only for its participants', async () => {
    const read = await readAgencyConversation(standIn(world()).client, { organisationId: ORG, conversationId: 'conv-2', viewerUserId: COLLEAGUE });
    if (!read.ok) throw new Error('refused');
    expect(read.open).toBe(false);
    expect(read.messages.map((m) => m.body)).toEqual(['Second activation.']);
  });

  it('never carries a user id', async () => {
    const read = await readAgencyConversation(standIn(world()).client, { organisationId: ORG, conversationId: 'conv-1', viewerUserId: ME });
    expect(JSON.stringify(read)).not.toContain(ME);
    expect(JSON.stringify(read)).not.toContain('builder_user_id');
  });
});

describe('Messages lists the viewer\'s own conversations', () => {
  it('N38. only those the viewer is in now, in this organisation', async () => {
    const mine = await listMyAgencyConversations(standIn(world()).client, { organisationId: ORG, viewerUserId: ME });
    expect(mine.ok && mine.conversations.map((c) => c.conversation_id)).toEqual(['conv-1']);
    const theirs = await listMyAgencyConversations(standIn(world()).client, { organisationId: ORG, viewerUserId: COLLEAGUE });
    expect(theirs.ok && theirs.conversations.map((c) => c.conversation_id)).toEqual(['conv-2']);
    const nobody = await listMyAgencyConversations(standIn(world()).client, { organisationId: ORG, viewerUserId: 'user-nobody' });
    expect(nobody.ok && nobody.conversations).toEqual([]);
  });

  it('lists every conversation the viewer is in, past the server\'s row ceiling', async () => {
    const tables = world();
    for (let i = 0; i < 1201; i += 1) {
      tables.builder_agency_conversations.push({ id: `bulk-${i}`, connection_id: 'conn-a', stock_item_id: 'item-1',
        organisation_id: ORG, selection_ref: 'ref-1', last_message_at: null });
      tables.builder_agency_conversation_participants.push({ conversation_id: `bulk-${i}`, participant_ref: `r-${i}`,
        side: 'builder', builder_user_id: ME, display_name: 'Avery Builder', state: 'joined', version: 1 });
    }
    const stand = standIn(tables, { maxRows: 1000 });
    const mine = await listMyAgencyConversations(stand.client, { organisationId: ORG, viewerUserId: ME });
    if (!mine.ok) throw new Error('failed');
    expect(mine.conversations).toHaveLength(1202);
    const inSizes = stand.log.flatMap((e) => e.filters.filter(([op]) => op === 'in').map(([, , v]) => (v as unknown[]).length));
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(200);
  });

  it('each names the property and the agency, and nothing about the agency\'s client', async () => {
    const mine = await listMyAgencyConversations(standIn(world()).client, { organisationId: ORG, viewerUserId: ME });
    if (!mine.ok) throw new Error('failed');
    expect(mine.conversations[0]).toMatchObject({ address: '1 Private Street', lot_number: '101', agency_name: 'Example Agency', open: true });
    expect(JSON.stringify(mine)).not.toMatch(/remote_client|ref-1/);
  });
});

describe('the participant event contract, at the door', () => {
  const good = {
    schema_version: 1, conversation_id: '00000000-0000-4000-8000-000000000001', stock_item_id: '00000000-0000-4000-8000-000000000003',
    participant_ref: '00000000-0000-4000-8000-000000000002', display_name: 'Olive Owner', side: 'command_centre', state: 'joined', version: 1,
  };
  it('accepts exactly its keys, and refuses anything else', () => {
    expect(agencyPayloadContractViolation('agency.message.participant', good)).toBeNull();
    expect(agencyPayloadContractViolation('agency.message.participant', { ...good, email: 'x' })?.unexpected).toEqual(['email']);
    for (const bad of [{ side: 'admin' }, { state: 'removed' }, { version: 0 }, { display_name: '' }, { participant_ref: 'x' }]) {
      expect(agencyPayloadContractViolation('agency.message.participant', { ...good, ...bad })).not.toBeNull();
    }
  });
  it('its dedupe key is bound to the conversation, the reference and the version', () => {
    expect(agencyDedupeKeyFor('agency.message.participant', good))
      .toBe(`agency.participant:${good.conversation_id}:${good.participant_ref}:1`);
  });
  it('the door knows it', () => {
    expect(readCode('supabase/functions/builder-network-inbound/index.ts')).toMatch(/'agency\.message\.participant'/);
  });
});

describe('refusals', () => {
  it('names a non-participant, the last participant and an ineligible invitee', () => {
    expect(agencyMessageRefusal('AGENCY_NOT_A_PARTICIPANT')).toMatchObject({ status: 403, code: 'not_a_participant' });
    expect(agencyMessageRefusal('AGENCY_LAST_PARTICIPANT')).toMatchObject({ status: 409, code: 'last_participant' });
    expect(agencyMessageRefusal('AGENCY_INVITEE_NOT_ELIGIBLE')).toMatchObject({ status: 422, code: 'invitee_not_eligible' });
  });
});

describe('the edge operations', () => {
  const source = () => readCode('supabase/functions/builder-portal-stock/index.ts');

  it('a conversation read takes a history cursor, and says whether there is more', () => {
    const code = source();
    expect(code).toMatch(/'get_agency_conversation'[\s\S]{0,500}beforeMessageId:\s*uuidOf\(body\.before_message_id\)/);
    expect(code).toMatch(/has_earlier:\s*read\.has_earlier/);
    expect(code).toMatch(/earlier_cursor:\s*read\.earlier_cursor/);
  });
  it('each is named', () => {
    for (const op of ['list_my_agency_conversations', 'get_agency_conversation', 'send_agency_message', 'retry_agency_message',
      'list_agency_conversation_invitees', 'invite_agency_conversation_participant', 'leave_agency_conversation']) {
      expect(source()).toContain(`'${op}'`);
    }
  });
  it('N21. there is no operation that removes somebody else', () => {
    expect(source()).not.toMatch(/'(remove|kick|evict)_agency/);
  });
  it('the organisation and the actor are the session\'s', () => {
    const code = source();
    expect(code).toMatch(/builder_agency_post_message[\s\S]{0,300}_sender_builder_user_id:\s*me\.id/);
    expect(code).toMatch(/builder_agency_invite_participant[\s\S]{0,300}_actor_builder_user_id:\s*me\.id/);
    expect(code).toMatch(/builder_agency_leave_conversation[\s\S]{0,300}_actor_builder_user_id:\s*me\.id/);
    expect(code).toMatch(/builder_agency_invite_participant[\s\S]{0,300}_organisation_id:\s*activeOrganisationId/);
  });
  it('the acknowledgement names the acknowledger by display name, composed in the database', () => {
    const migration = readCode('supabase/migrations/20260926120000_one_activation_one_private_conversation.sql');
    expect(migration).toMatch(/'acknowledged_by_display_name'/);
  });
});
