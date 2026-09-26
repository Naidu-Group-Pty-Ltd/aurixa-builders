#!/usr/bin/env node
/**
 * ONE ACTIVATION, ONE PRIVATE CONVERSATION — THE NETWORK'S HALF, ON A REAL
 * SCHEMA (docs/builder-portal/62).
 *
 * Rebuilds the database from the baseline and every migration BEFORE
 * `20260926120000_one_activation_one_private_conversation.sql`, writes a
 * conversation the way Step 5 wrote it (its property-derived id, three
 * messages), then applies this step's migration and everything after it.
 * It drives the functions the edge function calls and lands the Command
 * Centre's envelopes as the door does, and asserts the ROWS left behind:
 *
 * - acknowledging an activation opens exactly one conversation for it, with
 *   the acknowledger as its builder participant, and names the acknowledger
 *   (by display name only) to the agency;
 * - membership, not `inventory` access, decides who may read, write, retry,
 *   invite and leave;
 * - an invitation is decided by this organisation's own rows;
 * - leaving cannot strand a live conversation, and cannot erase history;
 * - the agency's participant events are display records, settle on their
 *   latest version and never grant anything;
 * - the conversation that existed before keeps its id and messages when it is
 *   bound to its activation;
 * - the builder company's own public contact details travel with a property,
 *   and nobody's personal ones do.
 *
 * Fixtures are invented. Nothing here reaches a network.
 * Same env contract: LOCAL_PG_HOST / LOCAL_PG_PORT / LOCAL_PG_USER.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.AGENCY_PRIVATE_CHAT_DB || 'aurixa_builders_agency_private_chat_check';
const PRIVATE_MIGRATION = '20260926120000_one_activation_one_private_conversation.sql';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});
const sql = (statement) => psql(['-d', DB, '-qAt', '-c', statement]).trim();
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const json = (v) => `${lit(JSON.stringify(v))}::jsonb`;
function refusal(statement) {
  try { sql(statement); return null; } catch (error) { return String(error.stderr ?? error.message); }
}
const uuidOf = (text) => {
  const hex = createHash('md5').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
/** Step 5's property derivation: the id the conversation that already existed was given. */
const propertyConversationId = (connection, item) => uuidOf(`agency.conversation:${connection}:${item}`);
/** This step's derivation: one conversation per activation. */
const activationConversationId = (connection, ref) => uuidOf(`agency.activation:${connection}:${ref}`);

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- The database, up to (not including) this step -------------------------
console.log(`Rebuilding on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
const migrations = readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort();
if (!migrations.includes(PRIVATE_MIGRATION)) {
  console.error(`FAIL  ${PRIVATE_MIGRATION} does not exist`);
  process.exit(1);
}
for (const file of migrations.filter((f) => f < PRIVATE_MIGRATION)) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}

// --- Invented fixtures --------------------------------------------------------
const ORG_A = randomUUID(); const ORG_B = randomUUID();
const ACK = randomUUID(); const COLLEAGUE = randomUUID(); const NO_INVENTORY = randomUUID();
const INACTIVE = randomUUID(); const OTHER_BUILDER = randomUUID();
const ITEM = randomUUID(); const LEGACY_ITEM = randomUUID(); const QUIET_ITEM = randomUUID(); const ITEM_B = randomUUID();
const WS = randomUUID();
const REF_1 = randomUUID(); const REF_2 = randomUUID(); const REF_LEGACY = randomUUID(); const REF_QUIET = randomUUID();

sql(`
  INSERT INTO public.builder_organisations(id, legal_name, org_type, status, is_active, activated_at,
    contact_email, contact_phone, website)
  VALUES (${lit(ORG_A)}, 'Check Homes Pty Ltd', 'builder', 'active', true, now(),
          'sales@checkhomes.example', '02 9000 0000', 'https://checkhomes.example'),
         (${lit(ORG_B)}, 'Other Homes Pty Ltd', 'builder', 'active', true, now(), NULL, NULL, NULL);
  DELETE FROM public.builder_network_outbox;
  DELETE FROM public.workspace_connection_events;
  DELETE FROM public.workspace_connections;
  INSERT INTO public.builder_portal_users(id, email, name, status, is_active, email_verified_at, must_change_password)
  VALUES (${lit(ACK)}, 'avery@checkhomes.example', 'Avery Builder', 'active', true, now(), false),
         (${lit(COLLEAGUE)}, 'alex@checkhomes.example', 'Alex Builder', 'active', true, now(), false),
         (${lit(NO_INVENTORY)}, 'nina@checkhomes.example', 'Nina Noinventory', 'active', true, now(), false),
         (${lit(INACTIVE)}, 'gone@checkhomes.example', 'Gone Builder', 'active', true, now(), false),
         (${lit(OTHER_BUILDER)}, 'blair@otherhomes.example', 'Blair Builder', 'active', true, now(), false);
  INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
  VALUES (${lit(ACK)}, ${lit(ORG_A)}, 'owner', true, 'active'),
         (${lit(COLLEAGUE)}, ${lit(ORG_A)}, 'member', false, 'active'),
         (${lit(NO_INVENTORY)}, ${lit(ORG_A)}, 'member', false, 'active'),
         (${lit(INACTIVE)}, ${lit(ORG_A)}, 'member', false, 'suspended'),
         (${lit(OTHER_BUILDER)}, ${lit(ORG_B)}, 'owner', true, 'active');
  INSERT INTO public.builder_membership_permissions(membership_id, permission_key, scope_type, view_decision, edit_decision, delete_decision)
  SELECT m.id, 'inventory', 'organisation', 'deny', 'deny', 'deny'
    FROM public.builder_organisation_memberships m WHERE m.builder_user_id = ${lit(NO_INVENTORY)};
  INSERT INTO public.builder_stock_items(id, organisation_id, lot_number, address_line, lifecycle_status)
  VALUES (${lit(ITEM)}, ${lit(ORG_A)}, '101', '1 Private Street', 'active'),
         (${lit(LEGACY_ITEM)}, ${lit(ORG_A)}, '102', '2 History Street', 'active'),
         (${lit(QUIET_ITEM)}, ${lit(ORG_A)}, '103', '3 Quiet Street', 'active'),
         (${lit(ITEM_B)}, ${lit(ORG_B)}, '9', '9 Other Road', 'active');
  INSERT INTO public.workspace_registry(id, mc_clone_id, slug, display_name)
  VALUES (${lit(WS)}, gen_random_uuid(), 'private-chat-check', 'Private Chat Check Workspace');`);
const [CONN_A, CONN_B] = sql(`
  INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, state, initiated_by, accepted_at, outbound_hmac_secret)
  VALUES (${lit(WS)}, ${lit(ORG_A)}, 'active', 'workspace', now(), 'secret-a'),
         (${lit(WS)}, ${lit(ORG_B)}, 'active', 'workspace', now(), 'secret-b')
  RETURNING id`).split('\n');
sql(`
  INSERT INTO public.builder_stock_selection_announcements(
    connection_id, stock_item_id, organisation_id, remote_selection_ref, status, source_version,
    acknowledged_at, acknowledged_by_builder_user_id)
  VALUES (${lit(CONN_A)}, ${lit(ITEM)}, ${lit(ORG_A)}, ${lit(REF_1)}, 'selected', 1, NULL, NULL),
         (${lit(CONN_A)}, ${lit(ITEM)}, ${lit(ORG_A)}, ${lit(REF_2)}, 'selected', 1, NULL, NULL),
         (${lit(CONN_A)}, ${lit(LEGACY_ITEM)}, ${lit(ORG_A)}, ${lit(REF_LEGACY)}, 'builder_acknowledged', 1, now(), ${lit(ACK)}),
         (${lit(CONN_A)}, ${lit(QUIET_ITEM)}, ${lit(ORG_A)}, ${lit(REF_QUIET)}, 'builder_acknowledged', 1, now(), ${lit(COLLEAGUE)});`);
const announcement = (ref) => sql(`SELECT id FROM public.builder_stock_selection_announcements WHERE remote_selection_ref = ${lit(ref)}`);

// Before this step: Step 5's conversation for the legacy property, holding three messages.
const LEGACY = propertyConversationId(CONN_A, LEGACY_ITEM);
const LEGACY_MESSAGES = [randomUUID(), randomUUID(), randomUUID()];
sql(`
  INSERT INTO public.builder_agency_conversations(id, connection_id, stock_item_id, organisation_id)
  VALUES (${lit(LEGACY)}, ${lit(CONN_A)}, ${lit(LEGACY_ITEM)}, ${lit(ORG_A)});
  INSERT INTO public.builder_agency_messages(id, conversation_id, side, sender_builder_user_id, client_message_id,
    sender_display_name, body, sent_at, received_at, delivery_state, delivered_at)
  VALUES (${lit(LEGACY_MESSAGES[0])}, ${lit(LEGACY)}, 'command_centre', NULL, NULL, 'Olive Owner',
          'Is lot 102 still available?', '2026-09-25T01:00:00Z', now(), NULL, NULL),
         (${lit(LEGACY_MESSAGES[1])}, ${lit(LEGACY)}, 'builder', ${lit(ACK)}, gen_random_uuid(), 'Avery Builder',
          'Yes, it is.', '2026-09-25T02:00:00Z', NULL, 'delivered', now()),
         (${lit(LEGACY_MESSAGES[2])}, ${lit(LEGACY)}, 'command_centre', NULL, NULL, 'Olive Owner',
          'Thank you.', '2026-09-25T03:00:00Z', now(), NULL, NULL);`);

// --- This step, and everything after it ---------------------------------------
for (const file of migrations.filter((f) => f >= PRIVATE_MIGRATION)) {
  psql(['-d', DB, '-q', '-f', join(repoRoot, 'supabase/migrations', file)]);
}
sql('DELETE FROM public.builder_network_outbox');

const C1 = activationConversationId(CONN_A, REF_1);
const C2 = activationConversationId(CONN_A, REF_2);
const acknowledge = (ref, user) => sql(`SELECT id FROM public.builder_stock_acknowledge_announcement(
  ${lit(announcement(ref))}, ${lit(ORG_A)}, ${lit(user)})`);
const post = (org, conversation, user, body, key = randomUUID()) => sql(`
  SELECT id FROM public.builder_agency_post_message(${lit(org)}, ${lit(conversation)}, ${lit(user)}, ${lit(key)}, ${lit(body)})`);
const postRefusal = (org, conversation, user) => refusal(`
  SELECT public.builder_agency_post_message(${lit(org)}, ${lit(conversation)}, ${lit(user)}, gen_random_uuid(), 'x')`) ?? '';
const invite = (conversation, actor, invitee, org = ORG_A) => sql(`
  SELECT public.builder_agency_invite_participant(${lit(org)}, ${lit(conversation)}, ${lit(actor)}, ${lit(invitee)})`);
const inviteRefusal = (conversation, actor, invitee, org = ORG_A) => refusal(`
  SELECT public.builder_agency_invite_participant(${lit(org)}, ${lit(conversation)}, ${lit(actor)}, ${lit(invitee)})`) ?? '';
const leave = (conversation, actor) => sql(`
  SELECT public.builder_agency_leave_conversation(${lit(ORG_A)}, ${lit(conversation)}, ${lit(actor)})`);
const leaveRefusal = (conversation, actor) => refusal(`
  SELECT public.builder_agency_leave_conversation(${lit(ORG_A)}, ${lit(conversation)}, ${lit(actor)})`) ?? '';
const isParticipant = (conversation, user) => sql(`SELECT public.builder_agency_is_participant(${lit(conversation)}, ${lit(user)})`);
const members = (conversation) => sql(`
  SELECT COALESCE(string_agg(side || ':' || display_name || ':' || state, ',' ORDER BY side, display_name, state), '')
    FROM public.builder_agency_conversation_participants WHERE conversation_id = ${lit(conversation)}`);
const outbox = (where = 'true') => sql(`SELECT count(*) FROM public.builder_network_outbox WHERE ${where}`);
const participantEvents = (conversation) => outbox(`event_type = 'agency.message.participant'
  AND payload->>'conversation_id' = ${lit(conversation)}`);
function land(connection, eventType, dedupe, payload) {
  sql(`INSERT INTO public.builder_network_inbound_events(connection_id, event_type, dedupe_key, payload, source_version)
       VALUES (${lit(connection)}, ${lit(eventType)}, ${lit(dedupe)}, ${json(payload)}, 1)`);
}
const sweep = () => sql('SELECT applied || \',\' || refused || \',\' || deferred FROM public.builder_agency_apply_message_events(50)');
const mainSweep = () => sql('SELECT applied || \',\' || refused FROM public.builder_network_apply_inbound_events(50)');
const agencyParticipant = (overrides = {}) => {
  const payload = {
    schema_version: 1, conversation_id: C1, stock_item_id: ITEM, participant_ref: randomUUID(),
    display_name: 'Olive Owner', side: 'command_centre', state: 'joined', version: 1, ...overrides,
  };
  land(overrides.connection ?? CONN_A, 'agency.message.participant',
    `agency.participant:${payload.conversation_id}:${payload.participant_ref}:${payload.version}:${randomUUID()}`,
    Object.fromEntries(Object.entries(payload).filter(([k]) => k !== 'connection')));
  sweep();
  return payload;
};
const agencyMessage = (overrides = {}) => ({
  schema_version: 1, conversation_id: C1, message_id: randomUUID(), stock_item_id: ITEM,
  body: 'Is lot 101 still available?', sender_display_name: 'Olive Owner',
  sent_at: '2026-09-26T01:00:00.000000Z', generation: 1, ...overrides,
});

console.log('\nThe acknowledgement opens the conversation');
acknowledge(REF_1, ACK);
check('N1. acknowledging an activation opens exactly one conversation, for that activation',
  sql(`SELECT count(*) FROM public.builder_agency_conversations WHERE id = ${lit(C1)}
       AND selection_ref = ${lit(REF_1)} AND connection_id = ${lit(CONN_A)} AND stock_item_id = ${lit(ITEM)}`) === '1'
    && sql(`SELECT count(*) FROM public.builder_agency_conversations WHERE stock_item_id = ${lit(ITEM)}`) === '1');
check('N2. its builder participant is the person who acknowledged it',
  members(C1) === 'builder:Avery Builder:joined' && isParticipant(C1, ACK) === 't', members(C1));
{
  const ack = JSON.parse(sql(`SELECT payload FROM public.builder_network_outbox WHERE event_type = 'stock.selection.acknowledged'
                              AND payload->>'remote_selection_ref' = ${lit(REF_1)}`));
  check('N3. the acknowledgement names the acknowledger to the agency by display name, and by nothing else',
    ack.acknowledged_by_display_name === 'Avery Builder'
      && JSON.stringify(Object.keys(ack).sort()) === JSON.stringify(
        ['acknowledged_at', 'acknowledged_by_display_name', 'remote_selection_ref', 'status', 'stock_item_id'])
      && !JSON.stringify(ack).includes(ACK) && !JSON.stringify(ack).includes('checkhomes.example'),
    Object.keys(ack).sort().join(','));
  const joined = JSON.parse(sql(`SELECT payload FROM public.builder_network_outbox WHERE event_type = 'agency.message.participant'
                                 AND payload->>'conversation_id' = ${lit(C1)}`));
  check('N2b. the acknowledger is announced once, under a reference that is not their id',
    participantEvents(C1) === '1'
      && JSON.stringify(Object.keys(joined).sort()) === JSON.stringify(
        ['conversation_id', 'display_name', 'participant_ref', 'schema_version', 'side', 'state', 'stock_item_id', 'version'])
      && joined.side === 'builder' && joined.state === 'joined' && joined.version === 1
      && joined.participant_ref !== ACK && !JSON.stringify(joined).includes(ACK)
      && !JSON.stringify(joined).includes('avery@'));
}
check('N4. acknowledging again is refused and adds no conversation, participant or event',
  /BUILDER_ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE/.test(refusal(`SELECT public.builder_stock_acknowledge_announcement(
    ${lit(announcement(REF_1))}, ${lit(ORG_A)}, ${lit(COLLEAGUE)})`) ?? '')
    && sql(`SELECT count(*) FROM public.builder_agency_conversations WHERE stock_item_id = ${lit(ITEM)}`) === '1'
    && members(C1) === 'builder:Avery Builder:joined' && participantEvents(C1) === '1');

console.log('\nEach activation is its own conversation');
acknowledge(REF_2, COLLEAGUE);
check('N7. a second activation of the same property has a different conversation',
  C2 !== C1 && sql(`SELECT count(*) FROM public.builder_agency_conversations WHERE stock_item_id = ${lit(ITEM)}`) === '2'
    && members(C2) === 'builder:Alex Builder:joined');
check('N8. the acknowledger of one cannot write into the other',
  /AGENCY_NOT_A_PARTICIPANT/.test(postRefusal(ORG_A, C2, ACK)) && isParticipant(C2, ACK) === 'f');
check('N10. a colleague with inventory access who is not a participant cannot write, invite or leave',
  /AGENCY_NOT_A_PARTICIPANT/.test(postRefusal(ORG_A, C1, COLLEAGUE))
    && /AGENCY_NOT_A_PARTICIPANT/.test(inviteRefusal(C1, COLLEAGUE, COLLEAGUE))
    && /AGENCY_NOT_A_PARTICIPANT/.test(leaveRefusal(C1, COLLEAGUE)));
check('N11. another builder reaches nothing, as themselves or naming this organisation',
  /AGENCY_CONVERSATION_NOT_FOUND/.test(postRefusal(ORG_B, C1, OTHER_BUILDER))
    && /AGENCY_NOT_A_PARTICIPANT/.test(postRefusal(ORG_A, C1, OTHER_BUILDER))
    && isParticipant(C1, OTHER_BUILDER) === 'f');
check('N12. a conversation id from another connection\'s derivation reaches nothing',
  /AGENCY_CONVERSATION_NOT_FOUND/.test(postRefusal(ORG_A, activationConversationId(CONN_B, REF_1), ACK)));

console.log('\nWriting');
const first = post(ORG_A, C1, ACK, 'We can hold it until Friday.');
{
  const payload = JSON.parse(sql(`SELECT payload FROM public.builder_network_outbox WHERE dedupe_key = 'agency.message:${first}:1'`));
  check('N13. a participant writes; Step 5\'s event, unchanged, names the activation\'s conversation',
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(
      ['body', 'conversation_id', 'generation', 'message_id', 'schema_version', 'sender_display_name', 'sent_at', 'stock_item_id'])
      && payload.conversation_id === C1 && payload.stock_item_id === ITEM);
}
{
  const key = randomUUID();
  const a = post(ORG_A, C1, ACK, 'Only once.', key);
  const b = post(ORG_A, C1, ACK, 'Only once.', key);
  check('N39. Step 5\'s idempotency holds: the same send again is one message and one event',
    a === b && outbox(`dedupe_key = 'agency.message:${a}:1'`) === '1'
      && /AGENCY_MESSAGE_ID_REUSED/.test(refusal(`SELECT public.builder_agency_post_message(${lit(ORG_A)}, ${lit(C1)}, ${lit(ACK)}, ${lit(key)}, 'Other')`) ?? ''));
}
sql(`UPDATE public.builder_agency_messages SET delivery_state = 'failed', failure_reason = 'not_delivered' WHERE id = ${lit(first)}`);
check('N15. a participant sends their own failed message again',
  sql(`SELECT delivery_generation FROM public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(first)}, ${lit(ACK)})`) === '2');
{
  const incoming = agencyMessage({ conversation_id: C2, body: 'For the second activation.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${incoming.message_id}:1`, incoming);
  sweep();
  check('an agency message for one activation lands in that activation\'s conversation only',
    sql(`SELECT conversation_id FROM public.builder_agency_messages WHERE id = ${lit(incoming.message_id)}`) === C2);
  const stray = agencyMessage({ conversation_id: activationConversationId(CONN_A, randomUUID()) });
  land(CONN_A, 'agency.message.posted', `agency.message:${stray.message_id}:1`, stray);
  sweep();
  check('an agency message naming a conversation that is no activation of the property is refused',
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events
         WHERE dedupe_key = 'agency.message:${stray.message_id}:1'`) === 'refused:conversation_mismatch');
}

console.log('\nInviting a colleague');
check('N17. a participant invites an active colleague with inventory access',
  invite(C1, ACK, COLLEAGUE) === 'joined' && isParticipant(C1, COLLEAGUE) === 't'
    && members(C1) === 'builder:Alex Builder:joined,builder:Avery Builder:joined', members(C1));
{
  const event = JSON.parse(sql(`SELECT payload FROM public.builder_network_outbox WHERE event_type = 'agency.message.participant'
    AND payload->>'conversation_id' = ${lit(C1)} AND payload->>'display_name' = 'Alex Builder'`));
  check('…and is announced once, as the builder\'s, with no id and no email',
    event.side === 'builder' && event.state === 'joined' && event.version === 1
      && !JSON.stringify(event).includes(COLLEAGUE) && !JSON.stringify(event).includes('alex@'));
}
const reply = post(ORG_A, C1, COLLEAGUE, 'Adding the brochure link tomorrow.');
check('N18. the invited colleague writes into the whole conversation, as themselves',
  sql(`SELECT sender_display_name FROM public.builder_agency_messages WHERE id = ${lit(reply)}`) === 'Alex Builder');
{
  const before = participantEvents(C1);
  check('N19. inviting someone already in it changes nothing',
    invite(C1, ACK, COLLEAGUE) === 'already_participant' && participantEvents(C1) === before);
}
check('N20. nobody outside this organisation, inactive, or without inventory access can be invited',
  [OTHER_BUILDER, INACTIVE, NO_INVENTORY, randomUUID()].every((who) => /AGENCY_INVITEE_NOT_ELIGIBLE/.test(inviteRefusal(C1, ACK, who))));
check('N20b. an organisation that is not the conversation\'s cannot invite into it',
  /AGENCY_CONVERSATION_NOT_FOUND/.test(inviteRefusal(C1, OTHER_BUILDER, OTHER_BUILDER, ORG_B)));
check('N20c. every eligible colleague is offered, however many there are',
  sql(`BEGIN;
    INSERT INTO public.builder_portal_users(id, email, name, status, is_active, email_verified_at, must_change_password)
    SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'bulk' || g || '@checkhomes.example',
           'Bulk Member ' || lpad(g::text, 4, '0'), 'active', true, now(), false FROM generate_series(1, 501) g;
    INSERT INTO public.builder_organisation_memberships(builder_user_id, organisation_id, membership_role, is_primary, status)
    SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, ${lit(ORG_A)}, 'member', false, 'active'
      FROM generate_series(1, 501) g;
    SELECT count(*) FROM public.builder_agency_invite_candidates(${lit(ORG_A)}, ${lit(C1)}, ${lit(ACK)})
     WHERE display_name LIKE 'Bulk Member %';
    ROLLBACK;`) === '501');
check('N21. there is no way to remove somebody else',
  sql(`SELECT count(*) FROM pg_proc WHERE proname ~ 'builder_agency_.*(remove|kick|evict)_?(participant|user|member)'`) === '0');

console.log('\nLeaving');
check('N23. the last builder participant of a live conversation cannot leave',
  /AGENCY_LAST_PARTICIPANT/.test(leaveRefusal(C2, COLLEAGUE)) && isParticipant(C2, COLLEAGUE) === 't');
check('N22/N24. once a colleague has joined, the acknowledger can leave, and is announced as left',
  leave(C1, ACK) === 'left'
    && members(C1) === 'builder:Alex Builder:joined,builder:Avery Builder:left'
    && sql(`SELECT payload->>'state' || '|' || (payload->>'version') FROM public.builder_network_outbox
            WHERE event_type = 'agency.message.participant' AND payload->>'display_name' = 'Avery Builder'
              AND payload->>'conversation_id' = ${lit(C1)}
            ORDER BY (payload->>'version')::int DESC LIMIT 1`) === 'left|2');
check('N25. a departed participant loses write, retry, invite and leave at once',
  isParticipant(C1, ACK) === 'f'
    && /AGENCY_NOT_A_PARTICIPANT/.test(postRefusal(ORG_A, C1, ACK))
    && /AGENCY_NOT_A_PARTICIPANT/.test(inviteRefusal(C1, ACK, ACK))
    && /AGENCY_NOT_A_PARTICIPANT/.test(leaveRefusal(C1, ACK)));
check('N25b. a departed participant repeating an earlier send is refused, not handed the stored message',
  /AGENCY_NOT_A_PARTICIPANT/.test(refusal(`SELECT m2.id FROM public.builder_agency_messages m,
    LATERAL public.builder_agency_post_message(${lit(ORG_A)}, ${lit(C1)}, ${lit(ACK)}, m.client_message_id, m.body) m2
    WHERE m.id = ${lit(first)}`) ?? ''));
sql(`UPDATE public.builder_agency_messages SET delivery_state = 'failed', failure_reason = 'not_delivered' WHERE id = ${lit(first)}`);
check('N16. a non-participant cannot send again even a message they wrote',
  /AGENCY_NOT_A_PARTICIPANT/.test(refusal(`SELECT public.builder_agency_retry_message(${lit(ORG_A)}, ${lit(first)}, ${lit(ACK)})`) ?? ''));
check('someone invited again after leaving rejoins under the same reference',
  (() => {
    const ref = sql(`SELECT participant_ref FROM public.builder_agency_conversation_participants
                     WHERE conversation_id = ${lit(C1)} AND builder_user_id = ${lit(ACK)}`);
    return invite(C1, COLLEAGUE, ACK) === 'joined'
      && sql(`SELECT participant_ref || '|' || state || '|' || version FROM public.builder_agency_conversation_participants
              WHERE conversation_id = ${lit(C1)} AND builder_user_id = ${lit(ACK)}`) === `${ref}|joined|3`;
  })());

console.log('\nThe agency\'s participants, as announced');
agencyParticipant({ display_name: 'Olive Owner' });
check('the activator arrives as a display record that grants nothing',
  sql(`SELECT count(*) FROM public.builder_agency_conversation_participants WHERE conversation_id = ${lit(C1)}
       AND side = 'command_centre' AND builder_user_id IS NULL AND state = 'joined'`) === '1');
{
  const a = randomUUID(); const b = randomUUID();
  agencyParticipant({ participant_ref: a, display_name: 'Sam Agent' });
  agencyParticipant({ participant_ref: b, display_name: 'Sam Agent' });
  agencyParticipant({ participant_ref: a, display_name: 'Sam Agent', state: 'left', version: 2 });
  check('N26. two agency participants with one name are two people',
    sql(`SELECT string_agg(state, ',' ORDER BY state) FROM public.builder_agency_conversation_participants
         WHERE conversation_id = ${lit(C1)} AND display_name = 'Sam Agent'`) === 'joined,left');
}
{
  const ref = randomUUID();
  agencyParticipant({ participant_ref: ref, display_name: 'Riley Replay' });
  agencyParticipant({ participant_ref: ref, display_name: 'Riley Replay' });
  const once = sql(`SELECT count(*) FROM public.builder_agency_conversation_participants WHERE participant_ref = ${lit(ref)}`);
  agencyParticipant({ participant_ref: ref, display_name: 'Riley Replay', state: 'left', version: 2 });
  agencyParticipant({ participant_ref: ref, display_name: 'Riley Replay', state: 'left', version: 2 });
  check('N27/N28. a replayed join or leave changes nothing',
    once === '1' && sql(`SELECT state || '|' || version FROM public.builder_agency_conversation_participants
                         WHERE participant_ref = ${lit(ref)}`) === 'left|2');
}
{
  const ref = randomUUID();
  agencyParticipant({ participant_ref: ref, display_name: 'Olly Order', state: 'left', version: 2 });
  agencyParticipant({ participant_ref: ref, display_name: 'Olly Order', state: 'joined', version: 1 });
  check('N29. events out of order settle on the latest version',
    sql(`SELECT state || '|' || version FROM public.builder_agency_conversation_participants
         WHERE participant_ref = ${lit(ref)}`) === 'left|2');
}
{
  const own = randomUUID(); const foreign = randomUUID(); const extra = randomUUID(); const otherConn = randomUUID();
  agencyParticipant({ participant_ref: own, side: 'builder', display_name: 'Avery Builder' });
  agencyParticipant({ participant_ref: foreign, conversation_id: activationConversationId(CONN_A, randomUUID()) });
  agencyParticipant({ participant_ref: extra, email: 'x@example.test' });
  agencyParticipant({ participant_ref: otherConn, connection: CONN_B });
  check('an event claiming this side, naming no activation of the property, carrying extra keys or from another connection is refused',
    sql(`SELECT count(*) FROM public.builder_agency_conversation_participants
         WHERE participant_ref IN (${[own, foreign, extra, otherConn].map(lit).join(', ')})`) === '0');
  check('N10b. a remote participant never becomes access for a local user of the same name',
    isParticipant(C1, NO_INVENTORY) === 'f');
}

console.log('\nWithdrawal');
sql(`UPDATE public.builder_stock_selection_announcements SET status = 'withdrawn' WHERE remote_selection_ref = ${lit(REF_1)}`);
check('N30. a withdrawn activation closes the conversation to writing and inviting, and keeps it for its participants',
  /AGENCY_CONVERSATION_NOT_OPEN/.test(postRefusal(ORG_A, C1, COLLEAGUE))
    && /AGENCY_CONVERSATION_NOT_OPEN/.test(inviteRefusal(C1, COLLEAGUE, NO_INVENTORY))
    && isParticipant(C1, COLLEAGUE) === 't'
    && sql(`SELECT count(*) > 0 FROM public.builder_agency_messages WHERE conversation_id = ${lit(C1)}`) === 't');
{
  const before = sql(`SELECT count(*) FROM public.builder_agency_messages WHERE conversation_id = ${lit(C1)}`);
  check('…and can be left by its last participants without erasing anything',
    leave(C1, ACK) === 'left' && leave(C1, COLLEAGUE) === 'left'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE conversation_id = ${lit(C1)}`) === before);
}

console.log('\nThe conversations that existed before this step');
check('N31/N32. the existing conversation keeps its id and its three messages, and is bound to its activation',
  sql(`SELECT public.builder_agency_seed_activation_conversation(${lit(announcement(REF_LEGACY))}, ${lit(LEGACY)})`) === 'seeded'
    && sql(`SELECT selection_ref FROM public.builder_agency_conversations WHERE id = ${lit(LEGACY)}`) === REF_LEGACY
    && sql(`SELECT string_agg(id::text || ':' || body, ',' ORDER BY sent_at) FROM public.builder_agency_messages
            WHERE conversation_id = ${lit(LEGACY)}`)
      === `${LEGACY_MESSAGES[0]}:Is lot 102 still available?,${LEGACY_MESSAGES[1]}:Yes, it is.,${LEGACY_MESSAGES[2]}:Thank you.`
    && members(LEGACY) === 'builder:Avery Builder:joined');
check('N33. another acknowledged activation is seeded empty, with its own acknowledger',
  sql(`SELECT public.builder_agency_seed_activation_conversation(${lit(announcement(REF_QUIET))},
         ${lit(activationConversationId(CONN_A, REF_QUIET))})`) === 'seeded'
    && members(activationConversationId(CONN_A, REF_QUIET)) === 'builder:Alex Builder:joined');
check('seeding again changes nothing',
  sql(`SELECT public.builder_agency_seed_activation_conversation(${lit(announcement(REF_LEGACY))}, ${lit(LEGACY)})`) === 'already_seeded'
    && sql(`SELECT count(*) FROM public.builder_agency_conversation_participants WHERE conversation_id = ${lit(LEGACY)}`) === '1');
{
  const pendingRef = randomUUID();
  sql(`INSERT INTO public.builder_stock_selection_announcements(connection_id, stock_item_id, organisation_id,
         remote_selection_ref, status, source_version)
       VALUES (${lit(CONN_A)}, ${lit(QUIET_ITEM)}, ${lit(ORG_A)}, ${lit(pendingRef)}, 'selected', 1)`);
  check('nothing is seeded that cannot be established: another property\'s conversation, or an unacknowledged activation',
    /AGENCY_SEED_MISMATCH/.test(refusal(`SELECT public.builder_agency_seed_activation_conversation(${lit(announcement(REF_QUIET))}, ${lit(LEGACY)})`) ?? '')
      && /AGENCY_SEED_NOT_ACKNOWLEDGED/.test(refusal(`SELECT public.builder_agency_seed_activation_conversation(
           ${lit(announcement(pendingRef))}, ${lit(activationConversationId(CONN_A, pendingRef))})`) ?? ''));
}

console.log('\nThe builder company\'s contact details');
{
  const payload = JSON.parse(sql(`SELECT public.builder_network_compose_stock_item_payload(${lit(ITEM)})`));
  check('N34. a property carries its builder company\'s own public email, phone and website',
    payload.organisation?.contact_email === 'sales@checkhomes.example'
      && payload.organisation?.contact_phone === '02 9000 0000'
      && payload.organisation?.website === 'https://checkhomes.example', JSON.stringify(payload.organisation));
  check('N35. and no person\'s: no builder user\'s email or name travels with it',
    !JSON.stringify(payload).includes('avery@') && !JSON.stringify(payload).includes('Avery Builder'));
  const bare = JSON.parse(sql(`SELECT public.builder_network_compose_stock_item_payload(${lit(ITEM_B)})`));
  check('an organisation with no contact details sends none (the keys are omitted, not blank)',
    !('contact_email' in (bare.organisation ?? {})) && !('website' in (bare.organisation ?? {})));
  sql(`DELETE FROM public.builder_network_outbox WHERE event_type = 'stock.item.upserted'`);
  sql(`UPDATE public.builder_organisations SET contact_phone = '02 9111 1111' WHERE id = ${lit(ORG_A)}`);
  check('a changed company contact is sent to the agency with its properties',
    outbox(`event_type = 'stock.item.upserted' AND payload#>>'{organisation,contact_phone}' = '02 9111 1111'`) !== '0');
}

console.log('\nN36. Nothing private crossed');
{
  const everything = sql(`SELECT COALESCE(string_agg(payload::text, ' '), '') FROM public.builder_network_outbox`);
  const leaked = [ACK, COLLEAGUE, NO_INVENTORY, 'avery@', 'alex@', 'nina@'].filter((s) => everything.includes(s));
  check('no builder user id or personal email is in anything this step sends', leaked.length === 0, leaked.join(','));
}

console.log('\nN39. Step 5\'s delivery, under the new model');
{
  const ITEM3 = randomUUID(); const REF_3 = randomUUID();
  sql(`INSERT INTO public.builder_stock_items(id, organisation_id, lot_number, address_line, lifecycle_status)
       VALUES (${lit(ITEM3)}, ${lit(ORG_A)}, '104', '4 Transport Street', 'active');
       INSERT INTO public.builder_stock_selection_announcements(connection_id, stock_item_id, organisation_id,
         remote_selection_ref, status, source_version)
       VALUES (${lit(CONN_A)}, ${lit(ITEM3)}, ${lit(ORG_A)}, ${lit(REF_3)}, 'selected', 1);`);
  acknowledge(REF_3, COLLEAGUE);
  const C3 = activationConversationId(CONN_A, REF_3);
  const receipt = (message, generation, outcome, reason) =>
    land(CONN_A, 'agency.message.receipt', `agency.receipt:${message}:${generation}:${randomUUID()}`, {
      schema_version: 1, message_id: message, conversation_id: C3, generation, outcome, ...(reason ? { reason } : {}),
    });
  const a = post(ORG_A, C3, COLLEAGUE, 'First.');
  const b = post(ORG_A, C3, COLLEAGUE, 'Second.');
  receipt(a, 1, 'accepted');
  receipt(b, 1, 'refused', 'conversation_not_open');
  sweep();
  check('an accepted receipt marks a message delivered; a refusal marks it failed, with the reason',
    sql(`SELECT delivery_state FROM public.builder_agency_messages WHERE id = ${lit(a)}`) === 'delivered'
      && sql(`SELECT delivery_state || '|' || failure_reason FROM public.builder_agency_messages WHERE id = ${lit(b)}`)
        === 'failed|refused:conversation_not_open');
  const m = agencyMessage({ conversation_id: C3, stock_item_id: ITEM3, body: 'Once.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${m.message_id}:1`, m);
  land(CONN_A, 'agency.message.posted', `agency.message:${m.message_id}:2`, { ...m, generation: 2 });
  land(CONN_A, 'agency.message.posted', `agency.message:${m.message_id}:3`, { ...m, body: 'Other words.', generation: 3 });
  sweep();
  check('an agency message is stored once however often it is delivered, and a changed one is refused',
    sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(m.message_id)}`) === '1'
      && sql(`SELECT string_agg(payload->>'outcome', ',' ORDER BY (payload->>'generation')::int) FROM public.builder_network_outbox
              WHERE event_type = 'agency.message.receipt' AND payload->>'message_id' = ${lit(m.message_id)}`) === 'accepted,accepted,refused');
  const behind = agencyMessage({ conversation_id: C3, stock_item_id: ITEM3, body: 'Behind an activation.' });
  const laterRef = randomUUID();
  land(CONN_A, 'stock.selection.announced', `stock.selection:${laterRef}:1`,
    { remote_selection_ref: laterRef, stock_item_id: ITEM3, status: 'selected' });
  land(CONN_A, 'agency.message.posted', `agency.message:${behind.message_id}:1`, behind);
  sweep();
  const waited = sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(behind.message_id)}`) === '0';
  mainSweep();
  sweep();
  check('a message waits behind an activation that landed before it and is not yet applied',
    waited && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(behind.message_id)}`) === '1');
  const kept = agencyMessage({ conversation_id: C3, stock_item_id: ITEM3, body: 'Kept before the withdrawal.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${kept.message_id}:1`, kept);
  sweep();
  sql(`UPDATE public.builder_stock_selection_announcements SET status = 'withdrawn' WHERE remote_selection_ref = ${lit(REF_3)}`);
  const fresh = agencyMessage({ conversation_id: C3, stock_item_id: ITEM3, body: 'After the withdrawal.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${fresh.message_id}:1`, fresh);
  land(CONN_A, 'agency.message.posted', `agency.message:${kept.message_id}:2`, { ...kept, generation: 2 });
  sweep();
  check('a withdrawn activation refuses the agency\'s new message, and still acknowledges a stored one sent again',
    sql(`SELECT message_apply_error FROM public.builder_network_inbound_events
         WHERE dedupe_key = 'agency.message:${fresh.message_id}:1'`) === 'refused:conversation_not_open'
      && sql(`SELECT COALESCE(message_apply_error, 'applied') FROM public.builder_network_inbound_events
              WHERE dedupe_key = 'agency.message:${kept.message_id}:2'`) === 'applied');
}

console.log('\nN41. Nothing arrives ahead of the acknowledgement');
{
  const ITEM4 = randomUUID(); const REF_4 = randomUUID();
  sql(`INSERT INTO public.builder_stock_items(id, organisation_id, lot_number, address_line, lifecycle_status)
       VALUES (${lit(ITEM4)}, ${lit(ORG_A)}, '105', '5 Early Street', 'active');
       INSERT INTO public.builder_stock_selection_announcements(connection_id, stock_item_id, organisation_id,
         remote_selection_ref, status, source_version)
       VALUES (${lit(CONN_A)}, ${lit(ITEM4)}, ${lit(ORG_A)}, ${lit(REF_4)}, 'selected', 1);`);
  const C4 = activationConversationId(CONN_A, REF_4);
  agencyParticipant({ conversation_id: C4, stock_item_id: ITEM4, display_name: 'Early Agent' });
  const early = agencyMessage({ conversation_id: C4, stock_item_id: ITEM4, body: 'Before anyone acknowledged.' });
  land(CONN_A, 'agency.message.posted', `agency.message:${early.message_id}:1`, early);
  sweep();
  check('a signed participant or message for an activation not yet acknowledged opens no conversation and stores nothing',
    sql(`SELECT count(*) FROM public.builder_agency_conversations WHERE id = ${lit(C4)}`) === '0'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE id = ${lit(early.message_id)}`) === '0');
  acknowledge(REF_4, ACK);
  check('acknowledging it then opens the conversation with exactly its acknowledger',
    members(C4) === 'builder:Avery Builder:joined'
      && sql(`SELECT count(*) FROM public.builder_agency_messages WHERE conversation_id = ${lit(C4)}`) === '0');
}

console.log('\nN42. A conversation closed for any reason can be left');
{
  // C2's only builder participant is the colleague. Its activation stands and
  // its connection is active; it is closed only because it no longer reads as
  // acknowledged, which is a closure the builder cannot undo from this side.
  sql(`UPDATE public.builder_stock_selection_announcements SET acknowledged_at = NULL WHERE remote_selection_ref = ${lit(REF_2)}`);
  check('the last builder participant may leave a conversation closed for a reason other than withdrawal',
    sql(`SELECT public.builder_agency_conversation_closed_reason(${lit(C2)})`) === 'not_acknowledged'
      && leave(C2, COLLEAGUE) === 'left');
}

console.log('\nN40. What did not change');
{
  const ref = randomUUID();
  land(CONN_A, 'stock.selection.announced', `stock.selection:${ref}:1`,
    { remote_selection_ref: ref, stock_item_id: QUIET_ITEM, status: 'selected' });
  mainSweep();
  check('an activation still arrives through the main sweep, untouched by the message lane',
    sql(`SELECT count(*) FROM public.builder_stock_selection_announcements
         WHERE remote_selection_ref = ${lit(ref)} AND status = 'selected'`) === '1');
}
for (const role of ['anon', 'authenticated']) {
  check(`${role} can reach neither the new table nor the new functions`,
    sql(`SELECT has_table_privilege('${role}', 'public.builder_agency_conversation_participants', 'SELECT')
            OR has_function_privilege('${role}', 'public.builder_agency_post_message(uuid,uuid,uuid,uuid,text)', 'EXECUTE')
            OR has_function_privilege('${role}', 'public.builder_agency_invite_participant(uuid,uuid,uuid,uuid)', 'EXECUTE')
            OR has_function_privilege('${role}', 'public.builder_agency_leave_conversation(uuid,uuid,uuid)', 'EXECUTE')
            OR has_function_privilege('${role}', 'public.builder_agency_seed_activation_conversation(uuid,uuid)', 'EXECUTE')`) === 'f');
}

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures ? 1 : 0);
