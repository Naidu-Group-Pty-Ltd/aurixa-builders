/**
 * WHY FIVE BUILDER / DEVELOPER PORTAL SURFACES READ THE WAY THEY DO. Read-only.
 *
 * Reported in production, 2 October 2026: Messages offers a Project
 * Conversations tab nobody uses; a card is headed "Project delivery attention";
 * a project shows a status and no way to change it; Tasks → By Record cannot
 * select the activated property that the Projects page lists; and Activity is
 * a wall of "Project viewed" by "Portal user".
 *
 * Four of the five are answerable only from the database, because each one can
 * be caused at either end and the screen cannot tell you which:
 *
 *  * a project the Projects page lists and the Tasks picker does not is either
 *    a missing `builder_project_access` grant, a permission the matrix
 *    withholds for the `tasks` key specifically, or a project whose row the
 *    LIST query orders past the page the picker reads — three different
 *    remedies, so the accessible-set functions are replayed per user here;
 *  * the attention card can only show what the workspace summary counts, so
 *    what it WOULD show is the summary itself, per user;
 *  * "Portal user" is `actor_type`, and whether the real actor is recoverable
 *    is a question about `actor_user_id` / `builder_user_id` being populated on
 *    the rows already written — a fact about history, not about the renderer;
 *  * which activity actions are noise is decided by what the log actually
 *    holds, so every action name is counted rather than guessed at.
 *
 * WRITES NOTHING, AND CANNOT. `sql()` refuses any statement that does not
 * begin with `select` or `with` — a property of this file rather than a promise
 * about how it is called.
 *
 * PRINTS NO CUSTOMER VALUE. This repository and its Actions logs are public, so
 * a record is the first eight characters of its id, a person is their id's
 * first eight characters and never their name or address, and a project is its
 * status and whether an activation opened it. Action names, statuses and counts
 * are the platform's own vocabulary and are printed in full.
 *
 * Usage: deno run -A --config supabase/functions/deno.json \
 *          scripts/ops/portal-functionality-state.ts
 * Needs: SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

async function sql(label: string, text: string): Promise<Record<string, unknown>[]> {
  if (!/^\s*(select|with)\b/i.test(text)) {
    throw new Error(`[${label}] refused: this script runs SELECT statements only.`);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
}

const unanswered: string[] = [];
async function section(title: string, text: string): Promise<Record<string, unknown>[] | null> {
  console.log(`\n${'='.repeat(92)}\n${title}\n${'='.repeat(92)}`);
  try {
    const rows = await sql(title, text);
    if (!rows.length) console.log('  (no rows)');
    else console.table(rows);
    return rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  COULD NOT BE READ: ${message}`);
    unanswered.push(`${title}: ${message}`);
    return null;
  }
}

console.log(`Builder Portal functionality state — project ${PROJECT_REF} — ${new Date().toISOString()}`);
console.log('READ-ONLY. Nothing below writes, grants, repairs or deletes.');

// ---------------------------------------------------------------------------
// 1. PROJECTS, AND HOW EACH ONE CAME TO EXIST. An activation-opened project is
//    the case the Tasks picker is reported to miss.
// ---------------------------------------------------------------------------
await section('1. builder_projects by organisation and status', `
  select p.builder_organisation_id::text as organisation,
         p.status,
         count(*) as projects,
         count(*) filter (where a.activation_project_id is not null) as opened_by_an_activation,
         count(*) filter (where s.builder_project_id is not null)    as linked_to_stock,
         min(p.created_at) as first_created,
         max(p.created_at) as last_created
    from public.builder_projects p
    left join public.builder_stock_selection_announcements a on a.activation_project_id = p.id
    left join public.builder_stock_items s on s.builder_project_id = p.id
   group by 1, 2
   order by 3 desc
`);

// ---------------------------------------------------------------------------
// 2. THE GRANTS. The activation fan-out grants every ACTIVE MEMBER AT THE TIME;
//    a member who joined afterwards is the shape of a project nobody can list.
// ---------------------------------------------------------------------------
await section('2. builder_project_access — grants per project', `
  select left(p.id::text, 8) as project,
         p.status,
         (a.activation_project_id is not null) as from_an_activation,
         count(g.builder_user_id) filter (where g.revoked_at is null) as live_grants,
         (select count(*) from public.builder_organisation_memberships m
           join public.builder_portal_users u on u.id = m.builder_user_id
          where m.organisation_id = p.builder_organisation_id
            and m.status = 'active' and m.revoked_at is null and u.is_active)
           as active_members_now,
         p.created_at
    from public.builder_projects p
    left join public.builder_project_access g on g.project_id = p.id
    left join public.builder_stock_selection_announcements a on a.activation_project_id = p.id
   group by p.id, p.status, p.created_at, p.builder_organisation_id, a.activation_project_id
   order by p.created_at desc
   limit 40
`);

// ---------------------------------------------------------------------------
// 3. WHAT EACH USER'S OWN SURFACES WOULD RETURN — the product's own functions,
//    replayed per user. This is the one question the screen cannot answer: the
//    Projects page asks for the `projects` key and the Tasks list asks for
//    `tasks` on the same scope, so the two can legitimately disagree.
// ---------------------------------------------------------------------------
await section('3. per user: what Projects lists, what the Tasks picker lists, what Tasks reads', `
  with people as (
    select u.id, m.organisation_id, m.membership_role
      from public.builder_portal_users u
      join public.builder_organisation_memberships m on m.builder_user_id = u.id
     where u.is_active and m.status = 'active' and m.revoked_at is null
  )
  select left(pe.id::text, 8) as portal_user,
         left(pe.organisation_id::text, 8) as organisation,
         pe.membership_role,
         (select count(*) from public.builder_accessible_projects(pe.id, pe.organisation_id, 'projects'))
           as projects_key_reaches,
         (select count(*) from public.builder_accessible_projects(pe.id, pe.organisation_id, 'tasks'))
           as tasks_key_reaches,
         (select count(*) from public.builder_project_access g
           where g.builder_user_id = pe.id and g.revoked_at is null) as raw_grants,
         (select count(*) from public.builder_accessible_tasks(pe.id)) as tasks_visible
    from people pe
   order by 4 desc, 1
   limit 40
`);

// ---------------------------------------------------------------------------
// 4. THE TASK ROWS THEMSELVES, by scope type: what a chosen record would hold.
// ---------------------------------------------------------------------------
await section('4. builder_tasks by scope type and status', `
  select t.scope_type, t.status, count(*) as tasks,
         count(*) filter (where t.due_date is not null and t.due_date < current_date
                            and t.status not in ('done','cancelled')) as overdue,
         count(*) filter (where t.scope_type = 'project'
           and exists (select 1 from public.builder_stock_selection_announcements a
                        where a.activation_project_id = t.scope_id)) as on_an_activation_project
    from public.builder_tasks t
   group by 1, 2
   order by 3 desc
`);

// ---------------------------------------------------------------------------
// 5. THE ATTENTION CARD'S OWN INPUTS, per user: the workspace summary is the
//    only thing it can draw, so this is what it would show today.
// ---------------------------------------------------------------------------
await section('5. per user: builder_workspace_summary (what the attention card can draw)', `
  with people as (
    select u.id, m.organisation_id
      from public.builder_portal_users u
      join public.builder_organisation_memberships m on m.builder_user_id = u.id
     where u.is_active and m.status = 'active' and m.revoked_at is null
  )
  select left(pe.id::text, 8) as portal_user,
         left(pe.organisation_id::text, 8) as organisation,
         s.projects, s.open_tasks, s.overdue_tasks, s.unread_messages,
         s.unread_notifications, s.open_conversations, s.open_defects
    from people pe
    cross join lateral public.builder_workspace_summary(pe.id, pe.organisation_id) s
   order by s.projects desc, 1
   limit 40
`);

// ---------------------------------------------------------------------------
// 5b. WHAT ELSE IS GENUINELY OUTSTANDING, from the states the product already
//     holds: an activation awaiting the builder's acknowledgement, and a
//     property the publication pipeline is holding back. Both are acts a
//     builder performs, which is what the card is supposed to list.
// ---------------------------------------------------------------------------
await section('5b. authoritative outstanding states beside the summary', `
  select 'activation_awaiting_acknowledgement' as state,
         a.status, count(*) as records
    from public.builder_stock_selection_announcements a
   where a.status = 'active'
   group by 1, 2
  union all
  select 'stock_item_held_back', i.lifecycle_status, count(*)
    from public.builder_stock_items i
   where i.lifecycle_status = 'staged'
   group by 1, 2
  union all
  select 'stock_upload_publication_blocked', coalesce(u.publication_blocked_reason, '(none)'), count(*)
    from public.builder_stock_uploads u
   where u.deleted_at is null and u.published_at is null
     and u.publication_blocked_reason is not null
   group by 1, 2
  union all
  select 'join_request_pending', r.status, count(*)
    from public.builder_org_join_requests r
   where r.status = 'pending'
   group by 1, 2
`);

// ---------------------------------------------------------------------------
// 6. THE ACTIVITY VOCABULARY. Which actions exist, how many of each, and —
//    the question the renderer cannot answer — whether the actor is RECOVERABLE
//    on rows already written.
// ---------------------------------------------------------------------------
await section('6. builder_portal_activity_log — every action, and whether its actor is recoverable', `
  select l.action, l.actor_type, count(*) as rows,
         count(l.actor_user_id)       as has_actor_user_id,
         count(l.builder_user_id)     as has_builder_user_id,
         count(*) filter (where l.actor_user_id is null and l.builder_user_id is null)
           as actor_not_recoverable,
         min(l.created_at) as first_seen, max(l.created_at) as last_seen
    from public.builder_portal_activity_log l
   group by 1, 2
   order by 3 desc
   limit 60
`);

await section('6b. the share of the log that is a passive view', `
  select count(*) as all_rows,
         count(*) filter (where l.action like '%_viewed') as viewed_rows,
         round(100.0 * count(*) filter (where l.action like '%_viewed') / greatest(count(*), 1), 1)
           as viewed_percent
    from public.builder_portal_activity_log l
`);

// ---------------------------------------------------------------------------
// 6c. WHAT A USER'S OWN FEED HOLDS TODAY — `builder_visible_activity` is what
//     both Activity surfaces read, so its own top rows are the noise reported.
// ---------------------------------------------------------------------------
await section('6c. per user: the visible feed, by action', `
  with people as (
    select u.id, m.organisation_id
      from public.builder_portal_users u
      join public.builder_organisation_memberships m on m.builder_user_id = u.id
     where u.is_active and m.status = 'active' and m.revoked_at is null
     limit 12
  )
  select left(pe.id::text, 8) as portal_user, v.action, v.actor_type, count(*) as rows
    from people pe
    cross join lateral public.builder_visible_activity(pe.id, pe.organisation_id, null, null, 200) v
   group by 1, 2, 3
   order by 4 desc
   limit 40
`);

// ---------------------------------------------------------------------------
// 7. CONVERSATIONS: what the Project Conversations tab would draw, against the
//    agency conversations beside it. Removing a tab must not hide live records.
// ---------------------------------------------------------------------------
await section('7. builder_conversations (the project tab) and the agency threads', `
  select 'project_conversation' as kind, c.scope_type as detail, c.status,
         count(*) as records, max(c.last_message_at) as last_message_at
    from public.builder_conversations c
   group by 1, 2, 3
  union all
  select 'project_conversation_message', '(any scope)', '(any status)',
         count(*), max(m.created_at)
    from public.builder_messages m
  union all
  select 'agency_conversation', '(per activation)', '(any status)',
         count(*), max(a.last_message_at)
    from public.builder_agency_conversations a
`);

// ---------------------------------------------------------------------------
// 8. THE STATUS HISTORY the project detail already draws, and who wrote it.
// ---------------------------------------------------------------------------
await section('8. builder_project_status_history — transitions recorded, and by whom', `
  select h.changed_by_type,
         coalesce(h.from_status, '(opened)') as from_status,
         h.to_status,
         count(*) as transitions,
         count(h.changed_by_builder_user_id) as by_a_named_portal_user,
         max(h.created_at) as last_recorded
    from public.builder_project_status_history h
   group by 1, 2, 3
   order by 4 desc
   limit 40
`);

if (unanswered.length) {
  console.log(`\n${'='.repeat(92)}\nQUESTIONS THIS DATABASE COULD NOT ANSWER\n${'='.repeat(92)}`);
  for (const f of unanswered) console.log(`  - ${f}`);
}
console.log('\nRead-only state complete. Nothing was changed.');
