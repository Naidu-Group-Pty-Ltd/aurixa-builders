/**
 * WHY A BUILDER'S OWN STOCK LIST IS EMPTY WHILE THE MARKETPLACE IS FULL.
 * Read-only.
 *
 * WHAT IT IS FOR. On 19 September 2026 the Command Centre published 46
 * Mairandi Developers properties while that builder's own Stock List page
 * read "Properties listed 0 · Stock lists uploaded 0". Both numbers are
 * served by `builder-portal-stock`, and every read in it is scoped by exactly
 * one value:
 *
 *   session.active_organisation.organisation_id
 *
 * — resolved server-side from the portal cookie, never from the browser. So
 * an empty page and a full marketplace can BOTH be correct answers at once,
 * about two different organisations. Which one it is cannot be guessed from
 * the screen: a builder signed into an organisation that holds no stock and a
 * catalogue filed under the wrong organisation draw the identical page, and
 * they have opposite remedies. One is a membership to repair; the other is 46
 * rows attributed to somebody else.
 *
 * So this asks, in the order `builder-portal-stock` asks them:
 *
 *   1. what each organisation actually holds (items by lifecycle, uploads);
 *   2. who the portal users are and which organisations they can reach —
 *      through `builder_accessible_organisations`, the function the session
 *      resolver itself calls, not a hand-written join that could disagree
 *      with it;
 *   3. which organisation each live session is ACTING as, which is the value
 *      every read is scoped by;
 *   4. the two page reads replayed verbatim per user, so the printed number
 *      is the number the page would draw rather than an inference about it;
 *   5. whether `inventory:view` resolves — a permission refusal answers 403
 *      and draws an error, not a zero, so ruling it out is what makes a zero
 *      mean what it says;
 *   6. who UPLOADED the stock, beside who OWNS it. A builder whose own upload
 *      landed under an organisation they cannot reach is the attribution
 *      fault; the same user reachable but signed in elsewhere is the routing
 *      one.
 *
 * WRITES NOTHING, AND CANNOT. `sql()` refuses any statement that does not
 * begin with `select` or `with`, which is a property of this file rather than
 * a promise about how it is called.
 *
 * NOTHING SENSITIVE IS PRINTED. Session tokens are hashed at rest and are
 * never selected; an email is reduced to its local-part initial and domain.
 *
 * Usage:  deno run -A --config supabase/functions/deno.json \
 *           scripts/ops/builder-portal-scope-state.ts
 * Needs:  SUPABASE_ACCESS_TOKEN, optionally PROJECT_REF.
 */
const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

/** SELECT only. The label is logged; the statement never is. */
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

/**
 * A SECTION THAT CANNOT BE READ SAYS SO AND THE TRACE CONTINUES — and it is
 * reported at the end, because a question that was never answered must not be
 * mistaken for one answered "nothing". This platform has paid for that
 * distinction repeatedly.
 */
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

console.log(`Builder Portal stock scope — project ${PROJECT_REF} — ${new Date().toISOString()}`);
console.log('READ-ONLY. Nothing below writes, grants, re-points or repairs.');

// ---------------------------------------------------------------------------
// 1. WHAT EACH ORGANISATION HOLDS. The marketplace's 46 belong to exactly one
//    of these rows; the page the builder opens reads exactly one of them too.
// ---------------------------------------------------------------------------
await section('1. every organisation — what it holds and who can reach it', `
  select o.id as organisation_id,
         left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 34) as builder,
         o.status, o.is_active,
         o.created_at,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = o.id and i.lifecycle_status = 'active')   as items_active,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = o.id and i.lifecycle_status = 'staged')   as items_staged,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = o.id and i.lifecycle_status = 'archived') as items_archived,
         (select count(*) from public.builder_stock_uploads u
           where u.organisation_id = o.id and u.deleted_at is null)            as uploads_listed,
         (select count(*) from public.builder_stock_uploads u
           where u.organisation_id = o.id and u.deleted_at is not null)        as uploads_deleted,
         (select count(*) from public.builder_organisation_memberships m
           where m.organisation_id = o.id and m.status = 'active'
             and m.revoked_at is null)                                         as active_memberships
  from public.builder_organisations o
  order by items_active desc, o.created_at
`);

// ---------------------------------------------------------------------------
// 2. WHO THE PORTAL USERS ARE, AND WHAT THEY CAN REACH. Asked through
//    `builder_accessible_organisations` — the function the session resolver
//    itself calls — so this cannot disagree with what the portal would do.
//    A membership row that exists but is suspended, revoked or outside its
//    validity window reaches NOTHING, and looks fine in the table.
// ---------------------------------------------------------------------------
await section('2. portal users and the organisations each can actually reach', `
  select left(u.name, 28)                                    as name,
         left(u.email, 1) || '***@' || split_part(u.email, '@', 2) as email,
         u.id as builder_user_id,
         u.status, u.is_active, u.revoked_at is not null      as revoked,
         u.created_at,
         (select count(*) from public.builder_organisation_memberships m
           where m.builder_user_id = u.id)                    as membership_rows,
         (select count(*) from public.builder_accessible_organisations(u.id)) as reachable_orgs,
         (select string_agg(
                   left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 22)
                   || ' [' || a.membership_role || ']', ', ' order by o.created_at)
            from public.builder_accessible_organisations(u.id) a
            join public.builder_organisations o on o.id = a.organisation_id) as reachable
  from public.builder_portal_users u
  order by u.created_at
`);

// ---------------------------------------------------------------------------
// 3. EVERY MEMBERSHIP ROW AS STORED, including the ones that reach nothing —
//    because a revoked or not-yet-valid membership is invisible in §2 and is
//    exactly the shape that makes a correct page look broken.
// ---------------------------------------------------------------------------
await section('3. membership rows as stored, reachable or not', `
  select left(u.name, 24)                                        as member,
         left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 26) as organisation,
         m.membership_role, m.is_primary, m.status,
         m.revoked_at is not null                                as revoked,
         m.valid_from <= now()                                   as valid_from_reached,
         (m.valid_until is null or m.valid_until > now())         as within_validity,
         (m.status = 'active' and m.revoked_at is null
            and m.valid_from <= now()
            and (m.valid_until is null or m.valid_until > now())
            and u.is_active and u.status = 'active' and u.revoked_at is null
            and o.is_active and o.status = 'active')              as reaches_the_portal,
         m.created_at
  from public.builder_organisation_memberships m
  join public.builder_portal_users u on u.id = m.builder_user_id
  join public.builder_organisations o on o.id = m.organisation_id
  order by m.created_at
`);

// ---------------------------------------------------------------------------
// 4. WHICH ORGANISATION EACH LIVE SESSION IS ACTING AS. This is the value
//    every read in `builder-portal-stock` is scoped by. A null one is not
//    nothing: the resolver then picks the primary membership, or the sole
//    accessible organisation, and otherwise refuses with
//    `organisation_selection_required` — which is a 403, not an empty page.
// ---------------------------------------------------------------------------
await section('4. live sessions and the organisation each is acting as', `
  select left(u.name, 24)                                        as member,
         s.active_organisation_id,
         left(coalesce(o.trading_name, o.legal_name, '(none selected)'), 26) as acting_as,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = s.active_organisation_id
             and i.lifecycle_status = 'active')                   as page_would_draw_items,
         s.created_at, s.last_used_at,
         s.idle_expires_at, s.absolute_expires_at,
         (s.revoked_at is null and s.idle_expires_at > now()
            and s.absolute_expires_at > now())                     as live,
         s.revoked_at is not null                                 as revoked
  from public.builder_portal_sessions s
  join public.builder_portal_users u on u.id = s.builder_user_id
  left join public.builder_organisations o on o.id = s.active_organisation_id
  order by s.last_used_at desc nulls last
  limit 40
`);

// ---------------------------------------------------------------------------
// 5. THE TWO PAGE READS, REPLAYED PER USER. Resolves the organisation the way
//    the session resolver does when no selection is stored — primary
//    membership, else the sole accessible one — and counts exactly what
//    `list_stock` and `list_uploads` would count.
// ---------------------------------------------------------------------------
await section('5. what the Stock List would draw for each user', `
  with resolved as (
    select u.id as builder_user_id,
           left(u.name, 24) as member,
           coalesce(
             (select m.organisation_id
                from public.builder_organisation_memberships m
                join public.builder_accessible_organisations(u.id) a
                  on a.organisation_id = m.organisation_id
               where m.builder_user_id = u.id and m.is_primary
                 and m.revoked_at is null
               limit 1),
             (select (array_agg(a.organisation_id))[1]
                from public.builder_accessible_organisations(u.id) a
               having count(*) = 1)
           ) as organisation_id
    from public.builder_portal_users u
  )
  select r.member,
         left(coalesce(o.trading_name, o.legal_name, '(cannot resolve one)'), 26) as would_act_as,
         r.organisation_id,
         (select count(*) from public.builder_stock_items i
           where i.organisation_id = r.organisation_id
             and i.lifecycle_status = 'active')  as properties_listed,
         (select count(*) from public.builder_stock_uploads up
           where up.organisation_id = r.organisation_id
             and up.deleted_at is null)          as stock_lists_uploaded,
         coalesce(public.builder_resolve_permission(
                    r.builder_user_id, r.organisation_id, 'inventory', 'view'), false)
                                                 as inventory_view
  from resolved r
  left join public.builder_organisations o on o.id = r.organisation_id
  order by properties_listed desc nulls last
`);

// ---------------------------------------------------------------------------
// 6. WHO UPLOADED THE STOCK, BESIDE WHO OWNS IT. This is the question that
//    separates the two faults: a builder whose own upload was filed under an
//    organisation they cannot reach is an ATTRIBUTION fault and the rows are
//    in the wrong place; the same builder reachable but acting elsewhere is a
//    ROUTING one and the rows are fine.
// ---------------------------------------------------------------------------
await section('6. uploads — who owns them, who created them, what they produced', `
  select up.id as upload_id,
         left(coalesce(o.trading_name, o.legal_name, '(unnamed)'), 26) as owned_by,
         left(coalesce(u.name, '(no user)'), 24)                       as created_by,
         case when u.id is null then null
              else exists (select 1 from public.builder_accessible_organisations(u.id) a
                            where a.organisation_id = up.organisation_id)
         end                                                            as creator_can_reach_owner,
         up.status, up.deleted_at is not null as deleted,
         left(coalesce(up.original_filename, up.source_url, '(none)'), 40) as source,
         (select count(*) from public.builder_stock_items i
           where i.upload_id = up.id and i.lifecycle_status = 'active')   as items_active,
         (select count(*) from public.builder_stock_items i
           where i.upload_id = up.id)                                     as items_all,
         up.created_at
  from public.builder_stock_uploads up
  left join public.builder_organisations o on o.id = up.organisation_id
  left join public.builder_portal_users u on u.id = up.uploaded_by_builder_user_id
  order by up.created_at desc
  limit 40
`);

// ---------------------------------------------------------------------------
// 7. THE ITEMS THEMSELVES against the upload that made them — an item whose
//    organisation differs from its own upload's is a fault no count reveals.
// ---------------------------------------------------------------------------
await section('7. items whose organisation differs from their upload’s', `
  select i.organisation_id as item_org, up.organisation_id as upload_org,
         count(*) as items
  from public.builder_stock_items i
  join public.builder_stock_uploads up on up.id = i.upload_id
  where i.organisation_id is distinct from up.organisation_id
  group by 1, 2
`);

console.log(`\n${'='.repeat(92)}`);
if (unanswered.length) {
  console.log(`QUESTIONS THAT COULD NOT BE READ (${unanswered.length}) — not answers of "none":`);
  for (const line of unanswered) console.log(`  · ${line}`);
} else {
  console.log('Every question above was answered by the database.');
}
console.log(`${'='.repeat(92)}\n`);
