#!/usr/bin/env node
/**
 * ===========================================================================
 * ONE ACTIVATION, ONE PRIVATE CONVERSATION — THE CONVERSATIONS THAT EXISTED.
 * ===========================================================================
 *
 * The step's two migrations make a conversation private to one activation's
 * participants and bind nothing that already existed: which activation a
 * conversation belongs to, and who its first participants are, is decided
 * HERE, and only where both projects agree (docs/builder-portal/52, 62 §5).
 *
 * For every live, acknowledged Command Centre activation it reads:
 *   - on the Command Centre: the activation, its builder's connection, whether
 *     its activating user is still active, and the conversation of that
 *     property on that connection that Step 5 created (if any);
 *   - on the network: the announcement with the same reference on the same
 *     connection and property, whether it was acknowledged, whether the
 *     acknowledging member is still active, and Step 5's conversation there.
 *
 * It seeds an activation only where every one of these holds:
 *   - both sides hold the activation, acknowledged, for the same property;
 *   - the activator and the acknowledger are both still active;
 *   - Step 5's conversation, where one exists, exists on BOTH sides under the
 *     same id and is claimed by exactly one live activation of its property;
 *   - neither side has already bound it to a different activation.
 * The conversation is then the existing one (kept whole: same id, same
 * messages) or, where none exists, the activation's derived id, created
 * empty. Anything else is reported by id and left alone.
 *
 * DRY RUN unless APPLY is true. With APPLY it seeds each agreed activation on
 * both projects through the step's own seed functions and reads back what
 * they left: the binding, one participant on each side, and every message
 * count unchanged. Nothing it does notifies or emails anyone.
 *
 * It prints ids (8 characters), states and counts — never a message body, a
 * person's name, an email address or anything about a client.
 *
 * Runs from the production-rollout workflow (phase `agency-chat-backfill`).
 */
import { createHash } from 'node:crypto';

const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const APPLY = String(process.env.APPLY || '').toLowerCase() === 'true';

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

async function query(ref, label, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 300)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}
const net = (label, sql) => query(NETWORK_REF, `network ${label}`, sql);
const cc = (label, sql) => query(CC_REF, `cc ${label}`, sql);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lit = (value) => {
  if (!UUID.test(String(value))) throw new Error('refusing a value that is not a uuid');
  return `'${value}'::uuid`;
};
const short = (value) => (value ? String(value).slice(0, 8) : '—');
const uuidOf = (text) => {
  const hex = createHash('md5').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const propertyConversationId = (connection, item) => uuidOf(`agency.conversation:${connection}:${item}`);
const activationConversationId = (connection, ref) => uuidOf(`agency.activation:${connection}:${ref}`);

async function main() {
  console.log(`agency chat backfill (${APPLY ? 'APPLY' : 'dry run — nothing is written'})`);

  // Before the step's migrations the new column and tables do not exist: the
  // dry run then reads Step 5's shape (nothing is bound, nobody is seeded),
  // which is exactly the question to ask before migrating. Seeding needs both.
  const [ccSchema] = await cc('schema', `SELECT to_regclass('public.builder_network_conversation_participants') IS NOT NULL AS ready`);
  const [netSchema] = await net('schema', `SELECT to_regclass('public.builder_agency_conversation_participants') IS NOT NULL AS ready`);
  const ccReady = ccSchema?.ready === true;
  const netReady = netSchema?.ready === true;
  console.log(`schema: Command Centre ${ccReady ? 'migrated' : 'not yet migrated'}, network ${netReady ? 'migrated' : 'not yet migrated'}`);
  if (APPLY && !(ccReady && netReady)) {
    console.error('FAILED: both projects must be migrated before anything is seeded');
    process.exit(1);
  }

  const ccRows = await cc('activations', `
    SELECT s.id AS selection_id, s.stock_item_id, s.organisation_id, s.status,
           s.acknowledged_at IS NOT NULL AS acknowledged,
           EXISTS (SELECT 1 FROM public.custom_users u
                    WHERE u.id = s.selected_by_user_id AND u.is_active AND u.deleted_at IS NULL) AS activator_active,
           (SELECT jsonb_agg(jsonb_build_object('id', c.id, 'network_connection_id', c.network_connection_id,
                                                'state', c.state))
              FROM public.builder_network_connections c
             WHERE c.builder_organisation_id = s.organisation_id) AS connections,
           (SELECT jsonb_agg(jsonb_build_object('id', v.id, 'connection_id', v.connection_id,
                                                'selection_ref', ${ccReady ? 'v.selection_ref' : 'NULL'},
                                                'messages', (SELECT count(*) FROM public.builder_network_messages m
                                                              WHERE m.conversation_id = v.id)))
              FROM public.builder_network_conversations v
             WHERE v.stock_item_id = s.stock_item_id AND v.builder_organisation_id = s.organisation_id) AS conversations,
           (SELECT count(*) FROM public.builder_stock_selections o
             WHERE o.stock_item_id = s.stock_item_id AND o.organisation_id = s.organisation_id
               AND o.status <> 'withdrawn' AND o.acknowledged_at IS NOT NULL)::int AS live_activations_of_property,
           ${ccReady ? `EXISTS (SELECT 1 FROM public.builder_network_conversation_participants p
                    JOIN public.builder_network_conversations v ON v.id = p.conversation_id
                   WHERE v.selection_ref = s.id AND p.local_user_id = s.selected_by_user_id)` : 'false'} AS already_seeded
      FROM public.builder_stock_selections s
     WHERE s.status <> 'withdrawn' AND s.acknowledged_at IS NOT NULL
     ORDER BY s.selected_at`);

  const netAnnouncements = await net('announcements', `
    SELECT a.id AS announcement_id, a.connection_id, a.stock_item_id, a.organisation_id, a.remote_selection_ref,
           a.status, a.acknowledged_at IS NOT NULL AS acknowledged,
           EXISTS (SELECT 1 FROM public.builder_active_membership(a.acknowledged_by_builder_user_id, a.organisation_id)) AS acknowledger_active,
           (SELECT jsonb_agg(jsonb_build_object('id', v.id, 'selection_ref', ${netReady ? 'v.selection_ref' : 'NULL'},
                                                'messages', (SELECT count(*) FROM public.builder_agency_messages m
                                                              WHERE m.conversation_id = v.id)))
              FROM public.builder_agency_conversations v
             WHERE v.connection_id = a.connection_id AND v.stock_item_id = a.stock_item_id) AS conversations,
           ${netReady ? `EXISTS (SELECT 1 FROM public.builder_agency_conversation_participants p
                    JOIN public.builder_agency_conversations v ON v.id = p.conversation_id
                   WHERE v.connection_id = a.connection_id AND v.selection_ref = a.remote_selection_ref
                     AND p.builder_user_id = a.acknowledged_by_builder_user_id)` : 'false'} AS already_seeded
      FROM public.builder_stock_selection_announcements a`);

  const plan = [];
  console.log(`\nCommand Centre: ${ccRows.length} live acknowledged activation(s)`);
  for (const row of ccRows) {
    const reasons = [];
    const connections = (row.connections ?? []).filter((c) => c.state === 'active');
    const announcement = netAnnouncements.find((a) => a.remote_selection_ref === row.selection_id
      && connections.some((c) => c.network_connection_id === a.connection_id));
    const connection = announcement
      ? connections.find((c) => c.network_connection_id === announcement.connection_id) : null;
    if (!connection) reasons.push('no active connection of its builder holds this activation on the network');
    if (announcement && announcement.stock_item_id !== row.stock_item_id) reasons.push('the network names another property');
    if (announcement && announcement.status === 'withdrawn') reasons.push('withdrawn on the network');
    if (announcement && !announcement.acknowledged) reasons.push('not acknowledged on the network');
    if (announcement && !announcement.acknowledger_active) reasons.push('the acknowledger is not an active member');
    if (!row.activator_active) reasons.push('the activator is not an active user');

    let conversationId = null;
    let messages = null;
    if (connection && announcement) {
      const legacyId = propertyConversationId(connection.network_connection_id, row.stock_item_id);
      const ccLegacy = (row.conversations ?? []).find((c) => c.id === legacyId);
      const netLegacy = (announcement.conversations ?? []).find((c) => c.id === legacyId);
      const ccBound = (row.conversations ?? []).find((c) => c.selection_ref === row.selection_id);
      const netBound = (announcement.conversations ?? []).find((c) => c.selection_ref === row.selection_id);
      if (ccBound || netBound) {
        conversationId = (ccBound ?? netBound).id;
        if (ccBound && netBound && ccBound.id !== netBound.id) reasons.push('the two sides bound it to different conversations');
      } else if (ccLegacy || netLegacy) {
        if (!ccLegacy || !netLegacy) reasons.push("Step 5's conversation exists on one side only");
        if (row.live_activations_of_property !== 1) {
          reasons.push(`${row.live_activations_of_property} live activations share Step 5's conversation of this property`);
        }
        if ((ccLegacy?.selection_ref && ccLegacy.selection_ref !== row.selection_id)
            || (netLegacy?.selection_ref && netLegacy.selection_ref !== row.selection_id)) {
          reasons.push("Step 5's conversation is already bound to another activation");
        }
        conversationId = legacyId;
        messages = { cc: Number(ccLegacy?.messages ?? 0), net: Number(netLegacy?.messages ?? 0) };
      } else {
        conversationId = activationConversationId(connection.network_connection_id, row.selection_id);
        messages = { cc: 0, net: 0 };
      }
    }

    const seeded = row.already_seeded && announcement?.already_seeded;
    const verdict = reasons.length ? `NOT SEEDABLE — ${reasons.join('; ')}` : seeded ? 'ALREADY SEEDED' : 'SEEDABLE';
    console.log(`  activation ${short(row.selection_id)} item ${short(row.stock_item_id)} → conversation ${short(conversationId)}`
      + `${messages ? ` messages cc=${messages.cc} network=${messages.net}` : ''}`);
    console.log(`    ${verdict}`);
    if (!reasons.length && !seeded) {
      plan.push({ selection: row.selection_id, announcement: announcement.announcement_id, conversation: conversationId, messages });
    }
  }

  const orphans = netAnnouncements.filter((a) => a.status !== 'withdrawn' && a.acknowledged
    && !ccRows.some((row) => row.selection_id === a.remote_selection_ref));
  if (orphans.length) {
    console.log(`\nNetwork announcements with no live acknowledged Command Centre activation: ${orphans.length}`);
    for (const a of orphans) console.log(`  announcement ${short(a.announcement_id)} — left alone`);
  }

  console.log(`\n${plan.length} activation(s) agreed and not yet seeded`);
  if (!APPLY) { console.log('dry run: nothing was written'); return; }

  let failures = 0;
  for (const step of plan) {
    const [ccResult] = await cc('seed', `SELECT public.builder_network_seed_activation_conversation(
      ${lit(step.selection)}, ${lit(step.conversation)}) AS result`);
    const [netResult] = await net('seed', `SELECT public.builder_agency_seed_activation_conversation(
      ${lit(step.announcement)}, ${lit(step.conversation)}) AS result`);
    const [ccAfter] = await cc('read back', `
      SELECT (SELECT selection_ref FROM public.builder_network_conversations WHERE id = ${lit(step.conversation)}) AS bound,
             (SELECT count(*) FROM public.builder_network_conversation_participants
               WHERE conversation_id = ${lit(step.conversation)} AND side = 'command_centre' AND state = 'joined')::int AS participants,
             (SELECT count(*) FROM public.builder_network_messages WHERE conversation_id = ${lit(step.conversation)})::int AS messages,
             (SELECT count(*) FROM public.notifications WHERE type = 'builder_activation_acknowledged'
               AND metadata->>'conversation_id' = ${lit(step.conversation)}::text)::int AS notified,
             (SELECT count(*) FROM public.integration_outbox
               WHERE idempotency_key = 'builder_activation_acknowledged:' || ${lit(step.selection)}::text)::int AS emails`);
    const [netAfter] = await net('read back', `
      SELECT (SELECT count(*) FROM public.builder_agency_conversation_participants
               WHERE conversation_id = ${lit(step.conversation)} AND side = 'builder' AND state = 'joined')::int AS participants,
             (SELECT count(*) FROM public.builder_agency_messages WHERE conversation_id = ${lit(step.conversation)})::int AS messages`);
    const ok = ['seeded', 'already_seeded'].includes(ccResult?.result) && ['seeded', 'already_seeded'].includes(netResult?.result)
      && ccAfter?.bound === step.selection && ccAfter?.participants >= 1 && netAfter?.participants >= 1
      && ccAfter?.notified === 0 && ccAfter?.emails === 0
      && ccAfter?.messages === step.messages.cc && netAfter?.messages === step.messages.net;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'SEEDED' : 'FAILED'} activation ${short(step.selection)} conversation ${short(step.conversation)}`
      + ` — cc=${ccResult?.result} network=${netResult?.result} messages cc=${ccAfter?.messages} network=${netAfter?.messages}`
      + ` notifications=${ccAfter?.notified} emails=${ccAfter?.emails}`);
  }
  if (failures) { console.error(`FAILED: ${failures} activation(s) did not read back as seeded`); process.exit(1); }
  console.log('every agreed activation seeded and read back');
}

main().catch((error) => { console.error(`FAILED: ${error.message}`); process.exit(1); });
