#!/usr/bin/env node
/**
 * ===========================================================================
 * WHO A CONVERSATION BELONGS TO — READ-ONLY, BEFORE MEMBERSHIP IS INTRODUCED.
 * ===========================================================================
 *
 * Step 6 makes an agency ↔ builder conversation private to its participants:
 * the Command Centre user whose activation opened it and the builder staff
 * member who acknowledged it. Before that migration runs, every conversation
 * that already exists has to be accounted for — seeded only where both of
 * those people can be read from the authoritative record, and REPORTED where
 * they cannot, before anything changes.
 *
 * This reads, on both live projects:
 *   - every agency conversation, with its message counts by side;
 *   - on the Command Centre, the activation(s) of that property by that
 *     builder: status, whether it was acknowledged, and whether the activating
 *     user is still an active Command Centre user;
 *   - on the network, the announcement(s) on that connection: status,
 *     whether it was acknowledged, and whether the acknowledging builder user
 *     is still an active member of the builder organisation;
 *   - how many acknowledged activations have no conversation yet.
 *
 * It prints ids, states, counts and a verdict. It never prints a message body,
 * a person's name, an email address or any client data, and it writes
 * nothing.
 *
 * Runs from the production-rollout workflow (phase `agency-chat-state`).
 */
const NETWORK_REF = process.env.PROJECT_REF || 'htfluofznhxeumblwbww';
const CC_REF = process.env.CLONE_PROJECT_REF || 'dduzbchuswwbefdunfct';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';

if (!ACCESS_TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }

async function query(ref, label, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    // Every statement this script sends is a single SELECT.
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${label}] ${response.status}: ${text.slice(0, 300)}`);
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : (parsed?.result ?? []); }
  catch { return []; }
}
const net = (label, sql) => query(NETWORK_REF, `network ${label}`, sql);
const cc = (label, sql) => query(CC_REF, `cc ${label}`, sql);

const short = (value) => (value ? String(value).slice(0, 8) : '—');

async function main() {
  console.log('agency chat state (read-only)');

  const ccConversations = await cc('conversations', `
    SELECT c.id, c.connection_id, c.stock_item_id, c.builder_organisation_id,
           c.owner_user_id IS NOT NULL AS has_owner,
           (SELECT count(*) FROM public.builder_network_messages m
             WHERE m.conversation_id = c.id AND m.side = 'command_centre')::int AS cc_messages,
           (SELECT count(*) FROM public.builder_network_messages m
             WHERE m.conversation_id = c.id AND m.side = 'builder')::int AS builder_messages,
           (SELECT count(DISTINCT m.sender_user_id) FROM public.builder_network_messages m
             WHERE m.conversation_id = c.id AND m.side = 'command_centre')::int AS cc_writers,
           (SELECT jsonb_agg(jsonb_build_object(
                     'selection', s.id, 'status', s.status,
                     'acknowledged', s.acknowledged_at IS NOT NULL,
                     'activator_active', EXISTS (
                        SELECT 1 FROM public.custom_users u
                         WHERE u.id = s.selected_by_user_id AND u.is_active AND u.deleted_at IS NULL))
                   ORDER BY s.selected_at)
              FROM public.builder_stock_selections s
             WHERE s.stock_item_id = c.stock_item_id
               AND s.organisation_id = c.builder_organisation_id) AS selections
      FROM public.builder_network_conversations c
     ORDER BY c.created_at`);

  const netConversations = await net('conversations', `
    SELECT c.id, c.connection_id, c.stock_item_id, c.organisation_id,
           (SELECT count(*) FROM public.builder_agency_messages m
             WHERE m.conversation_id = c.id AND m.side = 'builder')::int AS builder_messages,
           (SELECT count(*) FROM public.builder_agency_messages m
             WHERE m.conversation_id = c.id AND m.side = 'command_centre')::int AS cc_messages,
           (SELECT count(DISTINCT m.sender_builder_user_id) FROM public.builder_agency_messages m
             WHERE m.conversation_id = c.id AND m.side = 'builder')::int AS builder_writers,
           (SELECT jsonb_agg(jsonb_build_object(
                     'announcement', a.id, 'status', a.status,
                     'acknowledged', a.acknowledged_at IS NOT NULL,
                     'acknowledger_active', EXISTS (
                        SELECT 1 FROM public.builder_organisation_memberships mm
                         WHERE mm.builder_user_id = a.acknowledged_by_builder_user_id
                           AND mm.organisation_id = c.organisation_id AND mm.status = 'active'))
                   ORDER BY a.created_at)
              FROM public.builder_stock_selection_announcements a
             WHERE a.connection_id = c.connection_id
               AND a.stock_item_id = c.stock_item_id) AS announcements
      FROM public.builder_agency_conversations c
     ORDER BY c.created_at`);

  console.log(`\nCommand Centre: ${ccConversations.length} conversation(s)`);
  for (const row of ccConversations) {
    const live = (row.selections ?? []).filter((s) => s.status !== 'withdrawn');
    const seedable = live.some((s) => s.acknowledged && s.activator_active);
    console.log(`  ${short(row.id)} item ${short(row.stock_item_id)} messages cc=${row.cc_messages} builder=${row.builder_messages} cc_writers=${row.cc_writers}`);
    for (const s of row.selections ?? []) {
      console.log(`    activation ${short(s.selection)} status=${s.status} acknowledged=${s.acknowledged} activator_active=${s.activator_active}`);
    }
    console.log(`    verdict: ${seedable ? 'SEEDABLE (activator known and active, acknowledged)' : 'NOT SEEDABLE — report before migrating'}`);
  }

  console.log(`\nNetwork: ${netConversations.length} conversation(s)`);
  for (const row of netConversations) {
    const live = (row.announcements ?? []).filter((a) => a.status !== 'withdrawn');
    const seedable = live.some((a) => a.acknowledged && a.acknowledger_active);
    console.log(`  ${short(row.id)} item ${short(row.stock_item_id)} messages builder=${row.builder_messages} cc=${row.cc_messages} builder_writers=${row.builder_writers}`);
    for (const a of row.announcements ?? []) {
      console.log(`    announcement ${short(a.announcement)} status=${a.status} acknowledged=${a.acknowledged} acknowledger_active=${a.acknowledger_active}`);
    }
    console.log(`    verdict: ${seedable ? 'SEEDABLE (acknowledger known and active)' : 'NOT SEEDABLE — report before migrating'}`);
  }

  const [ccUnopened] = await cc('acknowledged without conversation', `
    SELECT count(*)::int AS n FROM public.builder_stock_selections s
     WHERE s.acknowledged_at IS NOT NULL AND s.status <> 'withdrawn'
       AND NOT EXISTS (SELECT 1 FROM public.builder_network_conversations c
                        WHERE c.stock_item_id = s.stock_item_id
                          AND c.builder_organisation_id = s.organisation_id)`);
  const [ccTotals] = await cc('selection totals', `
    SELECT count(*)::int AS all_rows,
           count(*) FILTER (WHERE status <> 'withdrawn')::int AS live,
           count(*) FILTER (WHERE acknowledged_at IS NOT NULL AND status <> 'withdrawn')::int AS live_acknowledged
      FROM public.builder_stock_selections`);
  console.log(`\nCommand Centre activations: ${ccTotals?.all_rows ?? 0} total, ${ccTotals?.live ?? 0} live, ${ccTotals?.live_acknowledged ?? 0} live and acknowledged, ${ccUnopened?.n ?? 0} acknowledged with no conversation yet`);
  console.log('\nnothing was written');
}

main().catch((error) => { console.error(`FAILED: ${error.message}`); process.exit(1); });
