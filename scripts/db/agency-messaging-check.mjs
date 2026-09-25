#!/usr/bin/env node
/**
 * AGENCY MESSAGING — THE NETWORK'S HALF, PROVED ON A REAL SCHEMA.
 *
 * Rebuilds the database from the baseline and every follow-on migration (the
 * same way `baseline-check.mjs` and `media-contract-check.ts` do) and drives
 * `20260925180000_an_agency_and_a_builder_talk_over_the_network.sql` the way
 * the edge function and the network door do: posting, retrying, landing the
 * Command Centre's messages and receipts as the door would, and running the
 * sweeps. It asserts the ROWS each step leaves behind.
 *
 * Fixtures are invented. Nothing here reaches a network.
 *
 * Same env contract: LOCAL_PG_HOST / LOCAL_PG_PORT / LOCAL_PG_USER.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.AGENCY_MESSAGING_DB || 'aurixa_builders_agency_messaging_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});
const sql = (statement) => psql(['-d', DB, '-qAt', '-c', statement]).trim();
/** The same, in its own session without blocking this one — for races. */
const sqlAsync = (statement) => new Promise((resolve, reject) => {
  execFile('psql', [...conn, '-v', 'ON_ERROR_STOP=1', '-d', DB, '-qAt', '-c', statement], { encoding: 'utf8' },
    (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
});
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const json = (v) => `${lit(JSON.stringify(v))}::jsonb`;
function refusal(statement) {
  try { sql(statement); return null; } catch (error) { return String(error.stderr ?? error.message); }
}

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- The database -------------------------------------------------------------
console.log(`Rebuilding on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
for (const file of readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort()) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}

// --- Invented fixtures --------------------------------------------------------
const ORG_A = randomUUID(); const ORG_B = randomUUID();
const USER_A = randomUUID(); const USER_A2 = randomUUID(); const USER_B = randomUUID();
const ITEM_A1 = randomUUID(); const ITEM_A2 = randomUUID(); const ITEM_B1 = randomUUID();
const WS = randomUUID();
let CONN_A; let CONN_B;

sql(`
  INSERT INTO public.builder_organisations(id, legal_name, org_type, status, is_active, activated_at)
  VALUES (${lit(ORG_A)}, 'Messaging Check A', 'builder', 'active', true, now()),
         (${lit(ORG_B)}, 'Messaging Check B', 'builder', 'active', true, now());
  -- Detached, exactly as the proofs do, then connected to one invented workspace.
  DELETE FROM public.builder_network_outbox;
  DELETE FROM public.workspace_connection_events;
  DELETE FROM public.workspace_connections;
  INSERT INTO public.builder_portal_users(id, email, name, status, is_active, email_verified_at, must_change_password)
  VALUES (${lit(USER_A)}, 'a@builder.example', 'Avery Builder', 'active', true, now(), false),
         (${lit(USER_A2)}, 'a2@builder.example', 'Alex Builder', 'active', true, now(), false),
         (${lit(USER_B)}, 'b@builder.example', 'Blair Builder', 'active', true, now(), false);
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (${lit(USER_A)}, ${lit(ORG_A)}, 'owner', true, 'active'),
         (${lit(USER_A2)}, ${lit(ORG_A)}, 'owner', false, 'active'),
         (${lit(USER_B)}, ${lit(ORG_B)}, 'owner', true, 'active');
  INSERT INTO public.builder_stock_items(id, organisation_id, lot_number, address_line, lifecycle_status)
  VALUES (${lit(ITEM_A1)}, ${lit(ORG_A)}, '101', '1 Check Street', 'active'),
         (${lit(ITEM_A2)}, ${lit(ORG_A)}, '102', '2 Check Street', 'active'),
         (${lit(ITEM_B1)}, ${lit(ORG_B)}, '9', '9 Other Road', 'active');
  INSERT INTO public.workspace_registry(id, mc_clone_id, slug, display_name)
  VALUES (${lit(WS)}, gen_random_uuid(), 'messaging-check', 'Messaging Check Workspace');`);
[CONN_A, CONN_B] = sql(`
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  VALUES (${lit(WS)}, ${lit(ORG_A)}, 'active', 'workspace', now(), 'secret-a'),
         (${lit(WS)}, ${lit(ORG_B)}, 'active', 'workspace', now(), 'secret-b')
  RETURNING id`).split('\n');
sql(`DELETE FROM public.builder_network_outbox;`);
sql(`
  INSERT INTO public.builder_stock_selection_announcements(
    connection_id, stock_item_id, organisation_id, remote_selection_ref, status, source_version)
  VALUES (${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(ORG_A)}, gen_random_uuid(), 'selected', 1),
         (${lit(CONN_B)}, ${lit(ITEM_B1)}, ${lit(ORG_B)}, gen_random_uuid(), 'selected', 1);`);

const conversationId = (connection, item) => {
  const hex = createHash('md5').update(`agency.conversation:${connection}:${item}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const post = (org, connection, item, user, clientId, body) => sql(`
  SELECT id FROM public.builder_agency_post_message(${lit(org)}, ${lit(connection)}, ${lit(item)},
    ${lit(user)}, ${lit(clientId)}, ${lit(body)})`);
const outbox = (where = 'true') => sql(`SELECT count(*) FROM public.builder_network_outbox WHERE ${where}`);
/** Land an envelope exactly as the network door does, then sweep. */
function land(connection, eventType, dedupe, payload) {
  sql(`INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
       VALUES (${lit(connection)}, ${lit(eventType)}, ${lit(dedupe)}, ${json(payload)}, 1)`);
}
const sweep = () => sql('SELECT applied || \',\' || refused || \',\' || deferred FROM public.builder_agency_apply_message_events(50)');
const mainSweep = () => sql('SELECT applied || \',\' || refused FROM public.builder_network_apply_inbound_events(50)');
const agencyMessage = (overrides = {}) => ({
  schema_version: 1,
  conversation_id: conversationId(CONN_A, ITEM_A1),
  message_id: randomUUID(),
  stock_item_id: ITEM_A1,
  body: 'Is lot 101 still available for a June settlement?',
  sender_display_name: 'Casey Agent',
  sent_at: '2026-09-25T10:00:00.000000Z',
  generation: 1,
  ...overrides,
});

console.log('\nWriting a message');
const client1 = randomUUID();
const m1 = post(ORG_A, CONN_A, ITEM_A1, USER_A, client1, '  We can hold it until Friday.  ');
const row1 = sql(`SELECT conversation_id || '|' || side || '|' || delivery_state || '|' || body || '|' || sender_display_name
                  FROM public.builder_agency_messages WHERE id = ${lit(m1)}`);
check('a builder posts on an activated property; the message is queued, trimmed and named',
  row1 === `${conversationId(CONN_A, ITEM_A1)}|builder|queued|We can hold it until Friday.|Avery Builder`, row1);
const payload = JSON.parse(sql(`SELECT payload FROM public.builder_network_outbox WHERE dedupe_key = 'agency.message:${m1}:1'`));
check('exactly one signed-network event carries it, with nothing but the contract\'s keys',
  JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(
    ['body', 'conversation_id', 'generation', 'message_id', 'schema_version', 'sender_display_name', 'sent_at', 'stock_item_id']),
  Object.keys(payload).sort().join(','));
check('the conversation id is the shared derivation, not a random one',
  payload.conversation_id === conversationId(CONN_A, ITEM_A1));
check('no user id, client or email crosses', !/[0-9a-f-]{36}/.test(payload.sender_display_name)
  && !JSON.stringify(payload).includes(USER_A) && !JSON.stringify(payload).includes('builder.example'));

const again = post(ORG_A, CONN_A, ITEM_A1, USER_A, client1, 'We can hold it until Friday.');
check('the same send again (a lost response) is the same message and no second event',
  again === m1 && outbox(`event_type = 'agency.message.posted'`) === '1');
check('the same key with different text is refused, never answered with the original',
  /AGENCY_MESSAGE_ID_REUSED/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, ${lit(client1)}, 'We can hold it until Monday.')`) ?? '')
    && outbox(`event_type = 'agency.message.posted'`) === '1');
{
  // Two real sessions send one message at once: the first holds its row
  // uncommitted, the second misses it at the lookup and waits on the unique
  // index until the first commits — a double click or a retried request.
  const key = randomUUID();
  const send = `SELECT id FROM public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)},
    ${lit(USER_A)}, ${lit(key)}, 'Raced send.')`;
  const first = sqlAsync(`BEGIN; ${send}; SELECT pg_sleep(1.5); COMMIT;`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = sqlAsync(send).catch((error) => `refused: ${String(error.message).slice(0, 120)}`);
  const [a, b] = await Promise.all([first, second]);
  check('two overlapping sends of one message: the one that loses the race returns the winner\'s message',
    b === a.split('\n')[0] && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE client_message_id = ${lit(key)}`) === '1',
    b);
  check('…and exactly one generation-1 event crosses for it',
    outbox(`dedupe_key = 'agency.message:${a.split('\n')[0]}:1'`) === '1'
      && outbox(`dedupe_key LIKE 'agency.message:${a.split('\n')[0]}:%'`) === '1');
}
check('the same key against another conversation is refused, never answered with the first',
  /AGENCY_MESSAGE_ID_REUSED/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A2)}, ${lit(USER_A)}, ${lit(client1)}, 'We can hold it until Friday.')`) ?? ''));
const second = post(ORG_A, CONN_A, ITEM_A1, USER_A2, randomUUID(), 'Adding the brochure link tomorrow.');
check('a colleague writes into the SAME conversation, as themselves',
  sql(`SELECT count(DISTINCT conversation_id) || '|' || string_agg(sender_display_name, ',' ORDER BY sent_at)
       FROM public.builder_agency_messages WHERE id IN (${lit(m1)}, ${lit(second)})`)
    === '1|Avery Builder,Alex Builder');
check('one conversation for the pair, however many times it is written to',
  sql(`SELECT count(*) FROM public.builder_agency_conversations WHERE connection_id = ${lit(CONN_A)}`) === '1');

console.log('\nWho may write where');
check('another organisation\'s builder cannot write to this conversation',
  /AGENCY_CONVERSATION_NOT_FOUND/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_B)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_B)}, gen_random_uuid(), 'x')`) ?? ''));
check('a property of another organisation is refused on this connection',
  /AGENCY_CONVERSATION_NOT_FOUND/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_B1)}, ${lit(USER_A)}, gen_random_uuid(), 'x')`) ?? ''));
check('a property nobody activated has no conversation to write to',
  /AGENCY_CONVERSATION_NOT_OPEN/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A2)}, ${lit(USER_A)}, gen_random_uuid(), 'x')`) ?? ''));
check('a non-member cannot write as this organisation',
  /AGENCY_SENDER_NOT_A_MEMBER/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_B)}, gen_random_uuid(), 'x')`) ?? ''));
check('an empty or oversized body is refused',
  /AGENCY_MESSAGE_INVALID/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, gen_random_uuid(), '   ')`) ?? '')
  && /AGENCY_MESSAGE_INVALID/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, gen_random_uuid(), repeat('x', 4001))`) ?? ''));

console.log('\nThe agency\'s messages arriving');
const incoming = agencyMessage();
land(CONN_A, 'agency.message.posted', `agency.message:${incoming.message_id}:1`, incoming);
check('a message event is out of the main sweep\'s lane the moment it lands',
  sql(`SELECT (processed_at IS NOT NULL) || '|' || (message_applied_at IS NULL) FROM public.builder_network_inbound_events
       WHERE dedupe_key = 'agency.message:${incoming.message_id}:1'`) === 'true|true');
mainSweep();
check('the main sweep never refuses it',
  sql(`SELECT COALESCE(apply_error, 'none') FROM public.builder_network_inbound_events
       WHERE dedupe_key = 'agency.message:${incoming.message_id}:1'`) === 'none');
sweep();
check('it arrives exactly once, as the agency\'s, with the sender\'s own name',
  sql(`SELECT count(*) || '|' || max(side) || '|' || max(sender_display_name) || '|' || bool_and(delivery_state IS NULL)
       FROM public.builder_agency_messages WHERE id = ${lit(incoming.message_id)}`) === '1|command_centre|Casey Agent|true');
check('and is answered with an accepted receipt',
  outbox(`dedupe_key = 'agency.receipt:${incoming.message_id}:1' AND payload->>'outcome' = 'accepted'`) === '1');

land(CONN_A, 'agency.message.posted', `agency.message:${incoming.message_id}:1:redelivered`, incoming);
land(CONN_A, 'agency.message.posted', `agency.message:${incoming.message_id}:2`, { ...incoming, generation: 2 });
sweep();
check('a replay and a retry of it converge on one message',
  sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(incoming.message_id)}`) === '1');
check('the retry is answered again; the replay is not answered twice',
  outbox(`dedupe_key LIKE 'agency.receipt:${incoming.message_id}:%'`) === '2');

{
  const original = agencyMessage({ body: 'The original words.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${original.message_id}:1`, original);
  sweep();
  for (const [n, change] of [[2, { body: 'Different words.' }], [3, { sender_display_name: 'Someone Else' }],
    [4, { sent_at: '2026-09-26T09:00:00.000000Z' }]]) {
    land(CONN_A, 'agency.message.posted', `agency.message:${original.message_id}:${n}`, { ...original, ...change, generation: n });
    sweep();
    check(`a stored message id arriving with a changed ${Object.keys(change)[0]} is refused and answered as refused`,
      sql(`SELECT message_apply_error FROM public.builder_network_inbound_events
           WHERE dedupe_key = 'agency.message:${original.message_id}:${n}'`) === 'refused:message_conflict'
        && outbox(`dedupe_key = 'agency.receipt:${original.message_id}:${n}' AND payload->>'outcome' = 'refused'`) === '1');
  }
  check('the stored message is untouched',
    sql(`SELECT body || '|' || sender_display_name FROM public.builder_agency_messages WHERE id = ${lit(original.message_id)}`)
      === 'The original words.|Casey Agent');
}

{
  // Two sweeps apply two envelopes naming one message id, with different
  // content, at the same moment: the loser must not acknowledge what it could
  // not store.
  const racer = agencyMessage({ body: 'Racer A.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${racer.message_id}:1`, racer);
  land(CONN_A, 'agency.message.posted', `agency.message:${racer.message_id}:2`, { ...racer, body: 'Racer B.', generation: 2 });
  const eventOf = (n) => sql(`SELECT id FROM public.builder_network_inbound_events WHERE dedupe_key = 'agency.message:${racer.message_id}:${n}'`);
  const [e1, e2] = [eventOf(1), eventOf(2)];
  const first = sqlAsync(`BEGIN; SELECT public.builder_agency_apply_message_event('${e1}'); SELECT pg_sleep(1.5); COMMIT;`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = sqlAsync(`SELECT public.builder_agency_apply_message_event('${e2}')`);
  const [a, b] = await Promise.all([first, second]);
  sql(`UPDATE public.builder_network_inbound_events SET message_applied_at = now() WHERE id IN ('${e1}', '${e2}')`);
  check('two concurrent envelopes for one message id: the loser with different content is refused, not acknowledged',
    a.split('\n')[0] === 'applied' && b === 'refused:message_conflict'
      && sql(`SELECT body FROM public.builder_agency_messages WHERE id = ${lit(racer.message_id)}`) === 'Racer A.'
      && outbox(`dedupe_key = 'agency.receipt:${racer.message_id}:2' AND payload->>'outcome' = 'refused'`) === '1',
    `${a.split('\n')[0]} / ${b}`);
}

{
  // A stored message whose receipt was lost is retried after the activation
  // is withdrawn: it is acknowledged again; a new message is still refused.
  const stored = agencyMessage({ body: 'Stored before the withdrawal.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${stored.message_id}:1`, stored);
  sweep();
  sql(`UPDATE public.builder_stock_selection_announcements SET status = 'withdrawn'
        WHERE connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM_A1)}`);
  land(CONN_A, 'agency.message.posted', `agency.message:${stored.message_id}:2`, { ...stored, generation: 2 });
  const fresh = agencyMessage({ body: 'Written after the withdrawal.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${fresh.message_id}:1`, fresh);
  sweep();
  check('after withdrawal, a stored message\'s retry is still acknowledged, and a new message is still refused',
    outbox(`dedupe_key = 'agency.receipt:${stored.message_id}:2' AND payload->>'outcome' = 'accepted'`) === '1'
      && sql(`SELECT message_apply_error FROM public.builder_network_inbound_events
              WHERE dedupe_key = 'agency.message:${fresh.message_id}:1'`) === 'refused:conversation_not_open'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(fresh.message_id)}`) === '0');
  sql(`UPDATE public.builder_stock_selection_announcements SET status = 'selected'
        WHERE connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM_A1)}`);
}

console.log('\nWhat is refused, and said to be');
const refusedCases = [
  ['a conversation computed for another workspace connection', agencyMessage({ conversation_id: conversationId(CONN_B, ITEM_A1) }), 'conversation_mismatch'],
  ['another builder\'s property', agencyMessage({ stock_item_id: ITEM_B1, conversation_id: conversationId(CONN_A, ITEM_B1) }), 'stock_item_not_ours'],
  ['a property that was never activated', agencyMessage({ stock_item_id: ITEM_A2, conversation_id: conversationId(CONN_A, ITEM_A2) }), 'conversation_not_open'],
  ['a malformed message', agencyMessage({ body: '' }), 'invalid_message'],
  ['an id already used by another message', agencyMessage({ message_id: m1 }), 'message_conflict'],
];
for (const [index, [label, message, reason]] of refusedCases.entries()) {
  land(CONN_A, 'agency.message.posted', `agency.message:${message.message_id}:case${index}`, message);
  sweep();
  const stamp = sql(`SELECT message_apply_error FROM public.builder_network_inbound_events
                     WHERE dedupe_key = 'agency.message:${message.message_id}:case${index}'`);
  check(`${label} is refused (${reason}) and nothing is stored`,
    stamp === `refused:${reason}`
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE body = ${lit(message.body)} AND side = 'command_centre' AND id = ${lit(message.message_id)}`) === '0',
    stamp);
}
check('a refusal is answered, so the agency\'s message shows as failed there',
  outbox(`event_type = 'agency.message.receipt' AND payload->>'outcome' = 'refused' AND payload->>'reason' = 'conversation_mismatch'`) === '1');
land(CONN_A, 'agency.message.posted', `garbage:${randomUUID()}`, { schema_version: 1, body: 'no ids' });
sweep();
check('a payload with no ids is refused and answered with nothing',
  sql(`SELECT count(*) FROM public.builder_network_inbound_events WHERE message_apply_error = 'refused:invalid_payload'`) === '1');

console.log('\nDelivery states');
sql(`UPDATE public.builder_network_outbox SET status = 'delivered', delivered_at = now() WHERE dedupe_key = 'agency.message:${m1}:1'`);
check('the door\'s 200 alone does not make a message delivered',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(m1)}`) === 'queued');
const receipt = (message, generation, outcome, reason) => land(CONN_A, 'agency.message.receipt',
  `agency.receipt:${message}:${generation}:${randomUUID()}`,
  { schema_version: 1, message_id: message, conversation_id: conversationId(CONN_A, ITEM_A1), generation, outcome, ...(reason ? { reason } : {}) });
receipt(m1, 1, 'accepted');
sweep();
check('the agency\'s accepted receipt makes it delivered',
  sql(`SELECT delivery_state || '|' || (delivered_at IS NOT NULL) FROM public.builder_agency_messages WHERE id = ${lit(m1)}`) === 'delivered|true');

const m3 = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'Please confirm the deposit amount.');
sql(`UPDATE public.builder_network_outbox SET status = 'dead', last_error = 'http_503' WHERE dedupe_key = 'agency.message:${m3}:1'`);
check('an outbox row that dead-letters leaves the message failed, and visible',
  sql(`SELECT delivery_state || '|' || failure_reason FROM public.builder_agency_messages WHERE id = ${lit(m3)}`) === 'failed|not_delivered');
check('only its writer may retry it',
  /AGENCY_MESSAGE_NOT_RETRYABLE/.test(refusal(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(m3)}, ${lit(USER_A2)})`) ?? ''));
sql(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(m3)}, ${lit(USER_A)})`);
check('a retry queues it again under a new generation, with no new message',
  sql(`SELECT delivery_state || '|' || delivery_generation FROM public.builder_agency_messages WHERE id = ${lit(m3)}`) === 'queued|2'
    && outbox(`dedupe_key = 'agency.message:${m3}:2'`) === '1'
    && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE body = 'Please confirm the deposit amount.'`) === '1');
check('a message that is not failed cannot be retried',
  /AGENCY_MESSAGE_NOT_RETRYABLE/.test(refusal(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(m3)}, ${lit(USER_A)})`) ?? ''));
receipt(m3, 1, 'accepted');
sweep();
check('a receipt for an earlier generation says nothing about the retry',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(m3)}`) === 'queued');
receipt(m3, 2, 'accepted');
sweep();
check('failed → delivered once the retry is accepted',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(m3)}`) === 'delivered');
const m4 = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'One more question.');
receipt(m4, 1, 'refused', 'conversation_not_open');
sweep();
check('a refused receipt fails the message with the agency\'s reason',
  sql(`SELECT delivery_state || '|' || failure_reason FROM public.builder_agency_messages WHERE id = ${lit(m4)}`) === 'failed|refused:conversation_not_open');
sql(`UPDATE public.builder_stock_selection_announcements SET status = 'withdrawn'
      WHERE connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM_A1)}`);
check('a failed message cannot be sent again once the activation is withdrawn',
  /AGENCY_CONVERSATION_NOT_OPEN/.test(refusal(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(m4)}, ${lit(USER_A)})`) ?? '')
    && sql(`SELECT delivery_state || '|' || delivery_generation FROM public.builder_agency_messages WHERE id = ${lit(m4)}`) === 'failed|1');
sql(`UPDATE public.builder_stock_selection_announcements SET status = 'selected'
      WHERE connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM_A1)}`);
{
  const pending = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'A receipt with no outcome must not fail me.');
  for (const [label, extra] of [['no outcome', {}], ['a null outcome', { outcome: null }]]) {
    land(CONN_A, 'agency.message.receipt', `agency.receipt:${pending}:1:${randomUUID()}`,
      { schema_version: 1, message_id: pending, conversation_id: conversationId(CONN_A, ITEM_A1), generation: 1, ...extra });
    sweep();
    check(`a receipt with ${label} is refused and changes nothing`,
      sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(pending)}`) === 'queued');
  }
}
land(CONN_B, 'agency.message.receipt', `agency.receipt:${m1}:1:${randomUUID()}`,
  { schema_version: 1, message_id: m1, conversation_id: conversationId(CONN_A, ITEM_A1), generation: 1, outcome: 'refused', reason: 'x' });
sweep();
check('a receipt over another connection cannot touch this conversation\'s message',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(m1)}`) === 'delivered');

console.log('\nA receipt that never gets back');
// As RECEIVER: the agency's message is stored, and the accepted receipt dies
// on the way back.
const lostIn = agencyMessage({ body: 'Did you get this one?' });
land(CONN_A, 'agency.message.posted', `agency.message:${lostIn.message_id}:1`, lostIn);
sweep();
check('lost receipt 1: the receiver stores the message',
  sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(lostIn.message_id)}`) === '1');
sql(`UPDATE public.builder_network_outbox SET status = 'dead', last_error = 'http_503'
      WHERE dedupe_key = 'agency.receipt:${lostIn.message_id}:1'`);
check('lost receipt 2: its accepted receipt never gets back (dead-lettered here)',
  outbox(`dedupe_key = 'agency.receipt:${lostIn.message_id}:1' AND status = 'dead'`) === '1');
land(CONN_A, 'agency.message.posted', `agency.message:${lostIn.message_id}:2`, { ...lostIn, generation: 2 });
sweep();
check('lost receipt 8: the sender\'s retry still leaves exactly one message here',
  sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(lostIn.message_id)}`) === '1');
check('lost receipt 9: the receiver answers the retry with a fresh accepted receipt',
  outbox(`dedupe_key = 'agency.receipt:${lostIn.message_id}:2' AND payload->>'outcome' = 'accepted' AND status = 'pending'`) === '1');

// As SENDER: the builder's message went out, and no receipt ever came.
const lost = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'Is the price still current?');
const pending = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'Still in the outbox.');
const fresh = post(ORG_A, CONN_A, ITEM_A1, USER_A2, randomUUID(), 'Delivered a moment ago.');
sql(`UPDATE public.builder_network_outbox SET status = 'delivered', delivered_at = now()
      WHERE dedupe_key IN ('agency.message:${lost}:1', 'agency.message:${fresh}:1')`);
sweep();
check('lost receipt 3: after the transport succeeds the message stays queued (no receipt yet)',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(lost)}`) === 'queued');
sql(`UPDATE public.builder_network_outbox SET delivered_at = now() - interval '16 minutes'
      WHERE dedupe_key = 'agency.message:${lost}:1';
     UPDATE public.builder_network_outbox SET created_at = now() - interval '2 hours'
      WHERE dedupe_key = 'agency.message:${pending}:1'`);
sweep();
check('lost receipt 4: past the confirmation window it fails, and says why truthfully',
  sql(`SELECT delivery_state || '|' || failure_reason FROM public.builder_agency_messages WHERE id = ${lit(lost)}`)
    === 'failed|confirmation_timeout');
check('lost receipt 12: another message is not affected — one still in transit, one just delivered',
  sql(`SELECT string_agg(delivery_state, ',' ORDER BY id = ${lit(pending)} DESC) FROM public.builder_agency_messages
       WHERE id IN (${lit(pending)}, ${lit(fresh)})`) === 'queued,queued');
check('lost receipt 6: a colleague may not send it again',
  /AGENCY_MESSAGE_NOT_RETRYABLE/.test(refusal(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(lost)}, ${lit(USER_A2)})`) ?? ''));
sql(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(lost)}, ${lit(USER_A)})`);
check('lost receipt 5 and 7: its writer sends it again, under generation 2, as the same message',
  sql(`SELECT delivery_state || '|' || delivery_generation || '|' || (failure_reason IS NULL)
       FROM public.builder_agency_messages WHERE id = ${lit(lost)}`) === 'queued|2|true'
    && outbox(`dedupe_key = 'agency.message:${lost}:2'`) === '1'
    && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE body = 'Is the price still current?'`) === '1');
receipt(lost, 1, 'accepted');
sweep();
check('lost receipt 11: a late generation-1 receipt does not touch the current generation',
  sql(`SELECT delivery_state || '|' || delivery_generation FROM public.builder_agency_messages WHERE id = ${lit(lost)}`) === 'queued|2');
receipt(lost, 2, 'accepted');
sweep();
check('lost receipt 10: the generation-2 receipt makes it Delivered',
  sql(`SELECT delivery_state || '|' || (delivered_at IS NOT NULL) FROM public.builder_agency_messages WHERE id = ${lit(lost)}`) === 'delivered|true');
receipt(lost, 1, 'refused', 'late');
sweep();
check('lost receipt 11: a late old receipt after delivery changes nothing',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(lost)}`) === 'delivered');
sql(`UPDATE public.builder_network_outbox SET delivered_at = now() - interval '16 minutes'
      WHERE dedupe_key = 'agency.message:${lost}:1'`);
sweep();
check('a delivered message never times out, and an old generation cannot time out the current one',
  sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(lost)}`) === 'delivered');

console.log('\nA lost response, retried after the connection is revoked');
{
  const key = randomUUID();
  const original = post(ORG_A, CONN_A, ITEM_A1, USER_A, key, 'Sent just before the revocation.');
  sql(`UPDATE public.workspace_connections SET state = 'revoked', revoked_at = now() WHERE id = ${lit(CONN_A)}`);
  let again = null; let edited = null; let fresh = null;
  try {
    again = refusal(`SELECT id FROM public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, ${lit(key)}, 'Sent just before the revocation.')`)
      ?? sql(`SELECT id FROM public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, ${lit(key)}, 'Sent just before the revocation.')`);
    edited = refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, ${lit(key)}, 'Edited after the revocation.')`);
    fresh = refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)}, ${lit(USER_A)}, gen_random_uuid(), 'New after the revocation.')`);
  } finally {
    sql(`UPDATE public.workspace_connections SET state = 'active', revoked_at = NULL WHERE id = ${lit(CONN_A)}`);
  }
  check('the same send repeated after a revocation is answered with the message it already made',
    again === original && outbox(`dedupe_key LIKE 'agency.message:${original}:%'`) === '1', String(again));
  check('…while an edited repeat and a new message are still refused',
    /AGENCY_MESSAGE_ID_REUSED/.test(edited ?? '') && /AGENCY_CONVERSATION_NOT_FOUND/.test(fresh ?? ''));
}

console.log('\nA message never overtakes the activation it depends on');
{
  const ITEM_A3 = randomUUID();
  sql(`INSERT INTO public.builder_stock_items(id, organisation_id, lot_number, address_line, lifecycle_status)
       VALUES (${lit(ITEM_A3)}, ${lit(ORG_A)}, '103', '3 Check Street', 'active')`);
  const ref = randomUUID();
  land(CONN_A, 'stock.selection.announced', `stock.selection:${ref}:1`,
    { remote_selection_ref: ref, stock_item_id: ITEM_A3, status: 'selected' });
  const early = agencyMessage({ stock_item_id: ITEM_A3, conversation_id: conversationId(CONN_A, ITEM_A3), body: 'Arrived right behind the activation.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${early.message_id}:1`, early);
  sweep();
  check('a message landed behind an unapplied activation waits, unconsumed, spending no attempt',
    sql(`SELECT (message_applied_at IS NULL) || '|' || message_apply_attempts FROM public.builder_network_inbound_events
         WHERE dedupe_key = 'agency.message:${early.message_id}:1'`) === 'true|0');
  mainSweep();
  sweep();
  check('…and is applied once the activation is',
    sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(early.message_id)}`) === '1');
}

console.log('\nA value of the wrong JSON type');
{
  const typed = { ...agencyMessage(), body: { text: 'hello there' } };
  land(CONN_A, 'agency.message.posted', `agency.message:${typed.message_id}:1`, typed);
  sweep();
  check('a message whose body is an object is refused and stored nowhere',
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events WHERE dedupe_key = 'agency.message:${typed.message_id}:1'`) === 'refused:invalid_payload'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(typed.message_id)}`) === '0');
}

console.log('\nA generation that is not a whole number');
{
  const fractional = agencyMessage({ body: 'Generation one and a half.', generation: 1.5 });
  land(CONN_A, 'agency.message.posted', `agency.message:${fractional.message_id}:1.5`, fractional);
  sweep();
  check('a message with a fractional generation is refused and stored nowhere',
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events WHERE dedupe_key = 'agency.message:${fractional.message_id}:1.5'`) === 'refused:invalid_payload'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(fractional.message_id)}`) === '0');
}

console.log('\nA time that is not a time');
for (const when of ['infinity', '-infinity', 'now', 'today', 'epoch', '2026-09-25']) {
  const odd = agencyMessage({ body: `Sent at ${when}.`, sent_at: when });
  land(CONN_A, 'agency.message.posted', `agency.message:${odd.message_id}:1`, odd);
  sweep();
  check(`a message sent at ${when} is refused as malformed and stored nowhere`,
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events WHERE dedupe_key = 'agency.message:${odd.message_id}:1'`) === 'refused:invalid_message'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(odd.message_id)}`) === '0');
}

console.log('\nThe exact contract, at the apply step too');
{
  const extra = { ...agencyMessage({ body: 'Carrying a field the contract does not have.' }), customer_details: 'Jordan Buyer' };
  land(CONN_A, 'agency.message.posted', `agency.message:${extra.message_id}:1`, extra);
  const waiting = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'Waiting on a clean receipt.');
  land(CONN_A, 'agency.message.receipt', `agency.receipt:${waiting}:1:${randomUUID()}`,
    { schema_version: 1, message_id: waiting, conversation_id: conversationId(CONN_A, ITEM_A1), generation: 1, outcome: 'accepted', client_id: 'x' });
  sweep();
  check('a message carrying a key outside the contract is refused and stored nowhere',
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events WHERE dedupe_key = 'agency.message:${extra.message_id}:1'`) === 'refused:invalid_payload'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(extra.message_id)}`) === '0');
  check('a receipt carrying a key outside the contract changes nothing',
    sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(waiting)}`) === 'queued');
}

console.log('\nA check and the change it guards against, at the same moment');
{
  const withdrawal = sqlAsync(`BEGIN; UPDATE public.builder_stock_selection_announcements SET status = 'withdrawn'
      WHERE connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM_A1)}; SELECT pg_sleep(1.5); COMMIT;`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const racingBody = `Racing the withdrawal ${randomUUID()}`;
  const write = sqlAsync(`SELECT id FROM public.builder_agency_post_message(${lit(ORG_A)}, ${lit(CONN_A)}, ${lit(ITEM_A1)},
      ${lit(USER_A)}, ${lit(randomUUID())}, ${lit(racingBody)})`).catch((error) => `refused: ${String(error.message)}`);
  const [, written] = await Promise.all([withdrawal, write]);
  check('a message written while the activation is being withdrawn waits for it, and is refused',
    /AGENCY_CONVERSATION_NOT_OPEN/.test(written)
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE body = ${lit(racingBody)}`) === '0', written);
  sql(`UPDATE public.builder_stock_selection_announcements SET status = 'selected'
        WHERE connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM_A1)}`);

  const racingIn = agencyMessage({ body: 'Applied while the connection is being revoked.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${racingIn.message_id}:1`, racingIn);
  const eventId = sql(`SELECT id FROM public.builder_network_inbound_events WHERE dedupe_key = 'agency.message:${racingIn.message_id}:1'`);
  const revocation = sqlAsync(`BEGIN; UPDATE public.workspace_connections SET state = 'revoked', revoked_at = now()
      WHERE id = ${lit(CONN_A)}; SELECT pg_sleep(1.5); COMMIT;`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const applied = await Promise.all([revocation, sqlAsync(`SELECT public.builder_agency_apply_message_event('${eventId}')`)]);
  sql(`UPDATE public.builder_network_inbound_events SET message_applied_at = now() WHERE id = '${eventId}'`);
  sql(`UPDATE public.workspace_connections SET state = 'active', revoked_at = NULL WHERE id = ${lit(CONN_A)}`);
  check('a message applied while the connection is being revoked waits for it, and is refused',
    applied[1] === 'refused:connection_not_active'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(racingIn.message_id)}`) === '0', applied[1]);
}

console.log('\nA receipt that landed before the connection was revoked');
const beforeRevoke = post(ORG_A, CONN_A, ITEM_A1, USER_A, randomUUID(), 'Sent just before the revocation.');
sql(`UPDATE public.builder_network_outbox SET status = 'delivered', delivered_at = now() WHERE dedupe_key = 'agency.message:${beforeRevoke}:1'`);
receipt(beforeRevoke, 1, 'accepted');
const landedBeforeRevoke = agencyMessage({ body: 'Landed just before the revocation.' });
land(CONN_A, 'agency.message.posted', `agency.message:${landedBeforeRevoke.message_id}:1`, landedBeforeRevoke);
sql(`UPDATE public.workspace_connections SET state = 'revoked', revoked_at = now() WHERE id = ${lit(CONN_A)}`);
try {
  sweep();
  check('an accepted receipt that landed before the revocation still marks the message delivered',
    sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(beforeRevoke)}`) === 'delivered');
  check('new content that landed before the revocation is still refused, and stored nowhere',
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events
         WHERE dedupe_key = 'agency.message:${landedBeforeRevoke.message_id}:1'`) === 'refused:connection_not_active'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(landedBeforeRevoke.message_id)}`) === '0');
} finally {
  sql(`UPDATE public.workspace_connections SET state = 'active', revoked_at = NULL WHERE id = ${lit(CONN_A)}`);
}

console.log('\nOne bad message never blocks the next');
sql(`CREATE OR REPLACE FUNCTION public._check_poison() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF NEW.body = 'poison' THEN RAISE EXCEPTION 'simulated fault'; END IF; RETURN NEW; END $$;
     CREATE TRIGGER _check_poison BEFORE INSERT ON public.builder_agency_messages
       FOR EACH ROW EXECUTE FUNCTION public._check_poison();`);
const poison = agencyMessage({ body: 'poison' });
const after = agencyMessage({ body: 'The next one still arrives.' });
land(CONN_A, 'agency.message.posted', `agency.message:${poison.message_id}:1`, poison);
land(CONN_A, 'agency.message.posted', `agency.message:${after.message_id}:1`, after);
sweep();
check('the message after a poison one is applied in the same sweep',
  sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(after.message_id)}`) === '1');
for (let i = 0; i < 5; i += 1) sweep();
check('the poison message is retried, then dead-lettered with a critical event',
  sql(`SELECT message_apply_attempts || '|' || left(message_apply_error, 5) FROM public.builder_network_inbound_events
       WHERE dedupe_key = 'agency.message:${poison.message_id}:1'`) === '5|dead:'
    && sql(`SELECT count(*) FROM public.portal_operational_events WHERE event_name = 'builder_agency_message_apply_dead'`) === '1');
sql('DROP TRIGGER _check_poison ON public.builder_agency_messages; DROP FUNCTION public._check_poison();');

console.log('\nOrder');
const later = agencyMessage({ body: 'Second, sent later.', sent_at: '2026-09-25T12:00:00.000000Z' });
const earlier = agencyMessage({ body: 'First, sent earlier.', sent_at: '2026-09-25T11:00:00.000000Z' });
land(CONN_A, 'agency.message.posted', `agency.message:${later.message_id}:1`, later);
sweep();
land(CONN_A, 'agency.message.posted', `agency.message:${earlier.message_id}:1`, earlier);
sweep();
check('messages that arrive out of order settle into the order they were written',
  sql(`SELECT string_agg(body, ' / ' ORDER BY sent_at, id) FROM public.builder_agency_messages
       WHERE id IN (${lit(later.message_id)}, ${lit(earlier.message_id)})`) === 'First, sent earlier. / Second, sent later.');

console.log('\nWhat did not change');
land(CONN_A, 'stock.unknown.thing', `unknown:${randomUUID()}`, {});
mainSweep();
check('an event type nobody handles is still refused by the main sweep, visibly',
  sql(`SELECT count(*) FROM public.builder_network_inbound_events WHERE event_type = 'stock.unknown.thing' AND apply_error LIKE 'refused:unhandled_event_type%'`) === '1'
  || sql(`SELECT count(*) FROM public.builder_network_inbound_events WHERE event_type = 'stock.unknown.thing' AND processed_at IS NOT NULL`) === '1');
const announceRef = randomUUID();
land(CONN_A, 'stock.selection.announced', `stock.selection:${announceRef}:1`,
  { remote_selection_ref: announceRef, stock_item_id: ITEM_A2, status: 'selected' });
mainSweep();
check('an activation still arrives through the main sweep, untouched by the message lane',
  sql(`SELECT count(*) FROM public.builder_stock_selection_announcements
       WHERE remote_selection_ref = ${lit(announceRef)} AND stock_item_id = ${lit(ITEM_A2)} AND status = 'selected'`) === '1'
    && sql(`SELECT count(*) FROM public.builder_network_inbound_events
            WHERE dedupe_key = 'stock.selection:${announceRef}:1' AND processed_at IS NOT NULL AND message_applied_at IS NULL`) === '1');
for (const role of ['anon', 'authenticated']) {
  check(`${role} can reach neither the tables nor the functions`,
    sql(`SELECT has_table_privilege('${role}', 'public.builder_agency_messages', 'SELECT')
            OR has_table_privilege('${role}', 'public.builder_agency_conversations', 'SELECT')
            OR has_function_privilege('${role}', 'public.builder_agency_post_message(uuid,uuid,uuid,uuid,uuid,text)', 'EXECUTE')
            OR has_function_privilege('${role}', 'public.builder_agency_apply_message_events(integer)', 'EXECUTE')`) === 'f');
}

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures ? 1 : 0);
