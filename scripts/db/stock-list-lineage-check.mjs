#!/usr/bin/env node
/**
 * A stock list is superseded by a NEWER VERSION OF ITSELF, and by nothing else
 * — proved against a database rebuilt from this repository's migrations, the
 * same way the other checks here are.
 *
 * MEASURED IN PRODUCTION, 28 September 2026 (the Tier-0 edge-case proof,
 * organisation "twolists"): a builder uploaded Estate A, then Estate B — two
 * different estates, no property in common. B published. A never did: every
 * one of its properties was settled on a ready builder-source photograph, its
 * readiness answered `ready`, and `publish_builder_stock_upload` returned
 * `superseded` for fifteen minutes and would have for ever, while the upload
 * row went on saying "awaiting source photographs … 1 still reading their
 * source" — a reason stamped before B existed and never revisited.
 *
 * The cause is `builder_stock_upload_superseded`, which answers TRUE when ANY
 * later non-deleted upload exists in the organisation. That rule was written
 * (docs/provenance/corpus/20261025000000) when the newest upload WAS the stock
 * list, to stop an abandoned draft of the SAME list from publishing and
 * re-pointing rows the current list had already dropped. The replacement
 * model has since become "replace what you matched" (`replaces_upload_ids`),
 * builders keep several lists side by side, and the rule was never narrowed.
 *
 * What this check holds, in both directions:
 *
 *   FREED  — two lists that never touched the same property do not supersede
 *            each other: the earlier one publishes, its later properties
 *            promote late, and the sweep counts it as pending.
 *   KEPT   — the protection the rule was written for:
 *            * a newer list that took over one of this list's properties
 *              supersedes it (its other staged rows never promote);
 *            * two drafts replacing the same predecessor are one lineage, so
 *              the older draft stays superseded — including AFTER the current
 *              list has cut over and a re-read has rewritten its
 *              `replaces_upload_ids` to empty (the relation is recorded when
 *              it happens and never forgotten);
 *            * a newer list still being read supersedes everything older,
 *              exactly as before, because what it will take over is unknown;
 *            * every upload that existed before this migration keeps the old
 *              rule, so no stored list changes state because of it.
 *   SAFE   — the relation table is service_role-only with RLS on, the
 *            functions are not executable by PUBLIC, anon or authenticated,
 *            and hard-deleting an upload still works.
 *
 * Environment: LOCAL_PG_HOST (default /tmp), LOCAL_PG_PORT (55432),
 * LOCAL_PG_USER (postgres), STOCK_LINEAGE_DB.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.STOCK_LINEAGE_DB || 'aurixa_builders_stock_lineage_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

// `-q` matters: without it psql echoes the command tag after a RETURNING row.
const psql = (args) => execFileSync('psql', [...conn, '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: '' },
});
const q1 = (statement) => psql(['-d', DB, '-At', '-c', statement]).trim();
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
/** A one-value query that answers 'f' where the statement itself fails (a missing function, say). */
const q1OrFalse = (statement) => { try { return q1(statement); } catch { return 'f'; } };
function refusal(statement) {
  try { q1(statement); return null; } catch (error) { return String(error.stderr ?? error.message); }
}

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

console.log(`Rebuilding on ${HOST}:${PORT} ...`);
psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
psql(['-d', DB, '-f', join(repoRoot, 'scripts/db/00-supabase-bootstrap.sql')]);
psql(['-d', DB, '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
// Supabase grants every new table and function to anon, authenticated and
// service_role by default; a migration is only as tight as what it revokes
// from THAT, so the check starts where production does.
psql(['-d', DB, '-c', `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`]);
psql(['-d', DB, '-f', join(repoRoot, 'supabase/migrations/00000000000000_network_baseline.sql')]);
for (const file of readdirSync(join(repoRoot, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && !f.startsWith('00000000000000')).sort()) {
  psql(['-d', DB, '-f', join(repoRoot, 'supabase/migrations', file)]);
}
console.log('schema ready (baseline + every follow-on migration).\n');

const hasLineage = q1(`SELECT to_regclass('public.builder_stock_upload_contacts') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'builder_stock_uploads' AND column_name = 'lineage_recorded')`) === 't';

// --- Fixtures, the way the importer and the settler leave them ------------------
let seq = 0;
function organisation() {
  seq += 1;
  return q1(`INSERT INTO public.builder_organisations(legal_name, org_type, status, is_active, activated_at)
    VALUES (${lit(`Lineage Check ${seq}`)}, 'builder', 'active', true, now()) RETURNING id`);
}
/**
 * An upload as the portal leaves it once its import has finished (or, with
 * `reading: true`, while it is still being read). `legacy` is an upload that
 * existed before lineage was recorded; it is only expressible once the
 * column exists.
 */
function upload(org, { reading = false, replaces = [], legacy = false } = {}) {
  seq += 1;
  const replacesLiteral = replaces.length
    ? `ARRAY[${replaces.map((id) => `${lit(id)}::uuid`).join(', ')}]` : `'{}'::uuid[]`;
  const legacyColumn = legacy && hasLineage ? ', lineage_recorded' : '';
  const legacyValue = legacy && hasLineage ? ', false' : '';
  return q1(`INSERT INTO public.builder_stock_uploads(organisation_id, original_filename, storage_path, status,
        processing_started_at, processing_completed_at, replaces_upload_ids${legacyColumn})
      VALUES (${lit(org)}::uuid, ${lit(`list-${seq}.csv`)}, ${lit(`lineage/${seq}.csv`)},
        ${reading ? "'parsing'" : "'complete'"}, now(), ${reading ? 'NULL' : 'now()'}, ${replacesLiteral}${legacyValue})
      RETURNING id`);
}
/** N new properties, staged, created by this upload — what a first list inserts. */
function stage(org, uploadId, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    ids.push(q1(`INSERT INTO public.builder_stock_items
        (organisation_id, upload_id, first_upload_id, lifecycle_status, image_work_stage,
         image_work_next_attempt_at, address_line, suburb, lot_number)
      VALUES (${lit(org)}::uuid, ${lit(uploadId)}::uuid, ${lit(uploadId)}::uuid, 'staged', 'source', now(),
        ${lit(`${seq} Lineage Parade`)}, 'Truganina', ${lit(String(seq))}) RETURNING id`));
  }
  return ids;
}
/** A ready builder-source primary, settled through the real completion RPC. */
function settle(org, uploadId, itemId) {
  const img = q1(`INSERT INTO public.builder_stock_item_images
      (organisation_id, stock_item_id, upload_id, source_stage, source_reference,
       verification_status, processing_status, storage_path)
    VALUES (${lit(org)}::uuid, ${lit(itemId)}::uuid, ${lit(uploadId)}::uuid,
       'uploaded_document', 'brochure#page1', 'source_supplied', 'ready', ${lit(`lineage/${itemId}.jpg`)})
    RETURNING id`);
  q1(`UPDATE public.builder_stock_items SET primary_image_id = ${lit(img)}::uuid WHERE id = ${lit(itemId)}::uuid`);
  q1(`SELECT public.complete_builder_stock_image_work(${lit(itemId)}::uuid, 'settled', 'lineage settle', NULL, 0, true, false)`);
}
/** A newer list MATCHING a published property: the new values are held back. */
function holdBack(itemId, byUpload) {
  q1(`UPDATE public.builder_stock_items
         SET pending_upload_id = ${lit(byUpload)}::uuid, pending_patch = '{"price": 612000}'::jsonb
       WHERE id = ${lit(itemId)}::uuid`);
}
/** A newer list MATCHING a still-staged property: it is re-pointed at once. */
function takeOver(itemId, byUpload) {
  q1(`UPDATE public.builder_stock_items SET upload_id = ${lit(byUpload)}::uuid WHERE id = ${lit(itemId)}::uuid`);
}
const superseded = (id) => q1(`SELECT public.builder_stock_upload_superseded(${lit(id)}::uuid)`) === 't';
const publish = (id) => JSON.parse(q1(`SELECT public.publish_builder_stock_upload(${lit(id)}::uuid)`));
const lifecycle = (itemId) => q1(`SELECT lifecycle_status FROM public.builder_stock_items WHERE id = ${lit(itemId)}::uuid`);
const pendingCount = () => Number(q1('SELECT public.builder_stock_publications_pending()'));

check('the lineage record and the pre-existing marker exist', hasLineage);

// === FREED: two lists with no property in common =================================
{
  const org = organisation();
  const a = upload(org);
  const aItems = stage(org, a, 2);
  aItems.forEach((id) => settle(org, a, id));
  const b = upload(org);
  const bItems = stage(org, b, 2);
  bItems.forEach((id) => settle(org, b, id));

  check('an unrelated LATER list does not supersede an earlier one', !superseded(a));
  check('the publication sweep counts the earlier list as waiting to publish', pendingCount() >= 2,
    `pending ${pendingCount()}`);
  const pa = publish(a);
  check('the earlier list publishes, every ready property live',
    pa.published === true && aItems.every((id) => lifecycle(id) === 'active'),
    JSON.stringify(pa));
  const pb = publish(b);
  check('and the later list publishes beside it',
    pb.published === true && bItems.every((id) => lifecycle(id) === 'active'), JSON.stringify(pb));
  check('neither list is recorded as touching the other', hasLineage
    && Number(q1(`SELECT count(*) FROM public.builder_stock_upload_contacts
      WHERE ${lit(a)}::uuid IN (upload_a, upload_b) OR ${lit(b)}::uuid IN (upload_a, upload_b)`)) === 0);
}

// === FREED: an earlier list's late promotion is not blocked by an unrelated one ==
{
  const org = organisation();
  const a = upload(org);
  const [ready, late] = stage(org, a, 2);
  settle(org, a, ready);
  // No photograph could be found for the second property: it fails, and the
  // first publication puts the other one live and holds this one back.
  q1(`UPDATE public.builder_stock_items SET image_work_stage = 'failed' WHERE id = ${lit(late)}::uuid`);
  const first = publish(a);
  const b = upload(org);
  stage(org, b, 1);
  // The builder adds the photograph: the property is worked again and settles.
  q1(`UPDATE public.builder_stock_items SET image_work_stage = 'source' WHERE id = ${lit(late)}::uuid`);
  settle(org, a, late);
  const again = publish(a);
  check('a first list publishes what is ready, then an unrelated list arrives, then the rest promotes late',
    first.published === true && first.mode === 'first_publication' && again.published === true
      && again.mode === 'late' && lifecycle(late) === 'active',
    `first ${JSON.stringify(first)}, again ${JSON.stringify(again)}`);
}

// === KEPT: a newer list that took over one of this list's properties ============
{
  const org = organisation();
  const x = upload(org);
  const [shared, own] = stage(org, x, 2);
  const y = upload(org);
  takeOver(shared, y);
  settle(org, x, own);
  check('a newer list that took over one of this list\'s staged properties supersedes it', superseded(x));
  const px = publish(x);
  check('and the older list\'s remaining staged property never promotes',
    px.published === false && px.reason === 'superseded' && lifecycle(own) === 'staged', JSON.stringify(px));
}

// === KEPT: two drafts replacing the same predecessor are one lineage =============
{
  const org = organisation();
  const u1 = upload(org);
  const live = stage(org, u1, 4);
  live.forEach((id) => settle(org, u1, id));
  check('the predecessor list publishes', publish(u1).published === true);

  // U2: a replacement draft that never published. It holds values back on two
  // live properties and brought one property of its own.
  const u2 = upload(org, { replaces: [u1] });
  holdBack(live[0], u2);
  holdBack(live[1], u2);
  const [u2Own] = stage(org, u2, 1);

  // U3: the builder's current version. It matched the OTHER two properties —
  // no row in common with U2 — and dropped U2's new one.
  const u3 = upload(org, { replaces: [u1] });
  holdBack(live[2], u3);
  holdBack(live[3], u3);

  check('two drafts of the same list touching DIFFERENT rows are one lineage — the older is superseded',
    superseded(u2));
  settle(org, u2, u2Own);
  const p2 = publish(u2);
  check('so the abandoned draft\'s own new property never promotes',
    p2.published === false && p2.reason === 'superseded' && lifecycle(u2Own) === 'staged', JSON.stringify(p2));

  const p3 = publish(u3);
  check('the current list cuts over, and archives the two properties it dropped — the draft re-pointed neither',
    p3.published === true && p3.archived === 2
      && lifecycle(live[0]) === 'archived' && lifecycle(live[1]) === 'archived'
      && lifecycle(live[2]) === 'active' && lifecycle(live[3]) === 'active',
    JSON.stringify(p3));
  // What a re-read of a published list does: every row it supplies is its own
  // now, so it records that it replaced nothing.
  q1(`UPDATE public.builder_stock_uploads SET replaces_upload_ids = '{}' WHERE id = ${lit(u3)}::uuid`);
  q1(`UPDATE public.builder_stock_uploads SET replaces_upload_ids = '{}' WHERE id = ${lit(u2)}::uuid`);
  check('after the cut-over AND both lists\' record of what they replaced is rewritten to empty, the draft stays superseded',
    superseded(u2));
  const p2b = publish(u2);
  check('and still promotes nothing', p2b.published === false && lifecycle(u2Own) === 'staged', JSON.stringify(p2b));
}

// === KEPT: a newer list still being read supersedes everything older ===========
{
  const org = organisation();
  const x = upload(org);
  const xItems = stage(org, x, 1);
  settle(org, x, xItems[0]);
  const y = upload(org, { reading: true });
  check('a newer list still being read supersedes an older one (what it will take over is unknown)', superseded(x));
  q1(`UPDATE public.builder_stock_uploads SET processing_completed_at = now(), status = 'complete'
       WHERE id = ${lit(y)}::uuid`);
  check('and once it has finished reading, having touched nothing of it, it does not', !superseded(x));
}

// === KEPT: a deleted newer list supersedes nothing (unchanged) ===================
{
  const org = organisation();
  const x = upload(org);
  const [item] = stage(org, x, 1);
  const y = upload(org);
  takeOver(item, y);
  q1(`UPDATE public.builder_stock_uploads SET deleted_at = now() WHERE id = ${lit(y)}::uuid`);
  check('a deleted newer list supersedes nothing', !superseded(x));
}

// === KEPT: uploads that existed before lineage was recorded keep the old rule ====
if (hasLineage) {
  const org = organisation();
  const oldA = upload(org, { legacy: true });
  upload(org, { legacy: true });
  check('between two pre-existing uploads, any later one still supersedes the earlier (old rule)', superseded(oldA));
  const org2 = organisation();
  const legacyList = upload(org2, { legacy: true });
  const legacySibling = upload(org2, { legacy: true });
  const [siblingRow] = stage(org2, legacySibling, 1);
  const fresh = upload(org2);
  check('a new list that touched nothing of the old ones leaves the newest old one current',
    !superseded(legacySibling));
  holdBack(siblingRow, fresh);
  check('a new list that touched ANY pre-existing list supersedes every pre-existing list (their history is unknown)',
    superseded(legacyList) && superseded(legacySibling));
}

// === REVIEW (28 Sep 2026): "still being read" is a STATUS, not a stamp ==========
// A failed read stamps `processing_completed_at` and a retry never clears it,
// so a list being read AGAIN looked finished and an older draft published
// beside it — before the retry recorded what it takes over.
{
  const org = organisation();
  const x = upload(org);
  const [item] = stage(org, x, 1);
  settle(org, x, item);
  const y = upload(org);
  q1(`UPDATE public.builder_stock_uploads SET status = 'failed' WHERE id = ${lit(y)}::uuid`);
  check('a newer list whose read FAILED, having touched nothing of this one, does not supersede it', !superseded(x));
  q1(`UPDATE public.builder_stock_uploads SET status = 'parsing' WHERE id = ${lit(y)}::uuid`);
  check('while that list is read AGAIN it supersedes, though its completion stamp is from the failed read', superseded(x));
  q1(`UPDATE public.builder_stock_uploads SET status = 'imported' WHERE id = ${lit(y)}::uuid`);
  check('and still while its rows are being written (status imported)', superseded(x));
  q1(`UPDATE public.builder_stock_uploads SET status = 'uploaded', processing_completed_at = NULL WHERE id = ${lit(y)}::uuid`);
  check('and while it is uploaded and not yet read at all', superseded(x));
}

// === REVIEW: a newer version that PUBLISHED supersedes for good ================
// v3 replaced v1 and published; the builder deleted v3 and added the list
// again as v4, all new rows. v2 — the draft v3 abandoned — must not come back.
{
  const org = organisation();
  const v1 = upload(org);
  const live = stage(org, v1, 2);
  live.forEach((id) => settle(org, v1, id));
  publish(v1);
  const v2 = upload(org, { replaces: [v1] });
  holdBack(live[0], v2);
  const [v2Own] = stage(org, v2, 1);
  const v3 = upload(org, { replaces: [v1] });
  holdBack(live[0], v3);
  holdBack(live[1], v3);
  const p3 = publish(v3);
  q1(`UPDATE public.builder_stock_uploads SET deleted_at = now() WHERE id = ${lit(v3)}::uuid`);
  const v4 = upload(org);
  stage(org, v4, 1);
  settle(org, v2, v2Own);
  check('a newer version that published still supersedes the draft it replaced after it is deleted',
    p3.published === true && superseded(v2), JSON.stringify(p3));
  const p2 = publish(v2);
  check('so the abandoned draft\'s own property still never promotes',
    p2.published === false && lifecycle(v2Own) === 'staged', JSON.stringify(p2));
}

// === RE-REVIEW NEW-1: deleting the version that replaced a list gives it back ====
// v1 published; v2 matched every property, published and cut over (it REPLACED
// v1). The builder deletes v2, whose properties are archived, and reads v1
// again. v1 is the list v2 replaced, not a draft v2 abandoned, so reading it
// again publishes it — as uploading it again would. Measured by the independent
// re-review on the first version of this rule: v1 answered "superseded" and its
// properties stayed staged, with nothing telling the builder why.
{
  const org = organisation();
  const v1 = upload(org);
  const live = stage(org, v1, 2);
  live.forEach((id) => settle(org, v1, id));
  publish(v1);
  const v2 = upload(org, { replaces: [v1] });
  live.forEach((id) => holdBack(id, v2));
  const p2 = publish(v2);
  q1(`UPDATE public.builder_stock_uploads SET deleted_at = now() WHERE id = ${lit(v2)}::uuid`);
  q1(`UPDATE public.builder_stock_items SET lifecycle_status = 'archived'
       WHERE id IN (${live.map((id) => `${lit(id)}::uuid`).join(', ')})`);
  // What reading v1 again leaves: the properties it matched staged under it
  // again. Its own published stamp stays — nothing clears it — so the list
  // is published again by the late promotion, the path a re-read takes.
  q1(`UPDATE public.builder_stock_items SET upload_id = ${lit(v1)}::uuid, lifecycle_status = 'staged',
         pending_upload_id = NULL, pending_patch = NULL
       WHERE id IN (${live.map((id) => `${lit(id)}::uuid`).join(', ')})`);
  check('a list is not held down by the deleted version that replaced it',
    p2.published === true && !superseded(v1), JSON.stringify(p2));
  const again = publish(v1);
  check('so reading it again publishes it, and its properties are live',
    again.published === true && again.mode === 'late' && live.every((id) => lifecycle(id) === 'active'),
    JSON.stringify(again));
}

// === REVIEW: supersession is decided ONCE, by publish ===========================
// It was decided again inside the patch, after readiness: a list created in
// between made the cut-over patch only rows this upload already supplied, and
// the archive step then took every property it had matched.
{
  let publishDef = '';
  let applyDef = '';
  try { publishDef = q1(`SELECT pg_get_functiondef('public.publish_builder_stock_upload(uuid)'::regprocedure)`); } catch { /* reported below */ }
  try { applyDef = q1(`SELECT pg_get_functiondef('public.apply_builder_stock_pending_patch(uuid, boolean)'::regprocedure)`); } catch { /* reported below */ }
  const calls = [...publishDef.matchAll(/apply_builder_stock_pending_patch\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  check('publish hands the patch its own decision: the superseded branch patches own rows, every other call all rows',
    JSON.stringify(calls) === JSON.stringify(['p_upload_id, true', 'p_upload_id, false', 'p_upload_id, false']),
    JSON.stringify(calls));
  check('the patch does not decide supersession itself', !!applyDef && !/builder_stock_upload_superseded/.test(applyDef));
  check('no one-argument patch remains to be called by mistake',
    q1(`SELECT count(*) FROM pg_proc WHERE proname = 'apply_builder_stock_pending_patch'`) === '1');

  const org = organisation();
  const v1 = upload(org);
  const live = stage(org, v1, 2);
  live.forEach((id) => settle(org, v1, id));
  publish(v1);
  const v2 = upload(org, { replaces: [v1] });
  holdBack(live[0], v2);
  holdBack(live[1], v2);
  upload(org, { reading: true });   // arrives between publish's decision and its patch
  let patched = null;
  try { patched = Number(q1(`SELECT public.apply_builder_stock_pending_patch(${lit(v2)}::uuid, false)`)); } catch { /* reported below */ }
  const repointed = Number(q1(`SELECT count(*) FROM public.builder_stock_items
    WHERE id IN (${live.map((id) => `${lit(id)}::uuid`).join(', ')}) AND upload_id = ${lit(v2)}::uuid`));
  check('a cut-over decided "not superseded" re-points every row it matched, whatever arrives meanwhile',
    patched === 2 && repointed === 2, `patched ${patched}, re-pointed ${repointed}`);
}

// === REVIEW: the rule is priced as the walk it is ===============================
{
  check('the supersession rule is declared expensive, so every cheaper filter runs first',
    Number(q1(`SELECT procost FROM pg_proc WHERE oid = 'public.builder_stock_upload_superseded(uuid)'::regprocedure`)) >= 1000);
  // The shape the walk is slowest on: 150 versions, each meeting only the
  // one before it, so the lineage is a chain 150 long.
  const org = organisation();
  const ids = [];
  for (let i = 0; i < 150; i += 1) ids.push(upload(org));
  for (let k = 0; k + 1 < ids.length; k += 1) {
    const [row] = stage(org, ids[k], 1);
    takeOver(row, ids[k + 1]);
  }
  q1(`UPDATE public.builder_stock_items SET lifecycle_status = 'active' WHERE organisation_id = ${lit(org)}::uuid`);
  q1(`UPDATE public.builder_stock_uploads SET published_at = now() WHERE organisation_id = ${lit(org)}::uuid`);
  const started = Date.now();
  q1('SELECT public.publish_ready_builder_stock_uploads()');
  const ms = Date.now() - started;
  check('the publication sweep over an organisation whose 150 versions are all published takes under two seconds',
    ms < 2000, `${ms} ms`);
}

// === SAFE: posture ===============================================================
if (hasLineage) {
  check('RLS is on for the lineage record',
    q1(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.builder_stock_upload_contacts'::regclass`) === 't');
  for (const role of ['anon', 'authenticated']) {
    check(`${role} can neither read nor write the lineage record`,
      q1(`SELECT has_table_privilege('${role}', 'public.builder_stock_upload_contacts', 'SELECT')
            OR has_table_privilege('${role}', 'public.builder_stock_upload_contacts', 'INSERT')
            OR has_table_privilege('${role}', 'public.builder_stock_upload_contacts', 'DELETE')`) === 'f');
  }
  for (const fn of ['public.builder_stock_upload_superseded(uuid)', 'public.builder_stock_record_upload_contacts()']) {
    check(`${fn} is not executable by PUBLIC, anon or authenticated`,
      q1(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')
            OR has_function_privilege('authenticated', '${fn}', 'EXECUTE')
            OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        WHERE p.oid = '${fn}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')`) === 'f');
  }
  check('service_role may read the lineage record and nothing else — append only is enforced, not a convention',
    q1(`SELECT has_table_privilege('service_role', 'public.builder_stock_upload_contacts', 'SELECT')
          AND NOT has_table_privilege('service_role', 'public.builder_stock_upload_contacts', 'INSERT')
          AND NOT has_table_privilege('service_role', 'public.builder_stock_upload_contacts', 'UPDATE')
          AND NOT has_table_privilege('service_role', 'public.builder_stock_upload_contacts', 'DELETE')
          AND NOT has_table_privilege('service_role', 'public.builder_stock_upload_contacts', 'TRUNCATE')`) === 't');
  check('the patch is executable by service_role and by no one else',
    q1OrFalse(`SELECT has_function_privilege('service_role', 'public.apply_builder_stock_pending_patch(uuid, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.apply_builder_stock_pending_patch(uuid, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.apply_builder_stock_pending_patch(uuid, boolean)', 'EXECUTE')`) === 't');
  check('service_role may execute the supersession rule',
    q1(`SELECT has_function_privilege('service_role', 'public.builder_stock_upload_superseded(uuid)', 'EXECUTE')`) === 't');

  const org = organisation();
  const x = upload(org);
  const [row] = stage(org, x, 1);
  const y = upload(org);
  holdBack(row, y);
  const recorded = Number(q1(`SELECT count(*) FROM public.builder_stock_upload_contacts
    WHERE upload_a = least(${lit(x)}::uuid, ${lit(y)}::uuid) AND upload_b = greatest(${lit(x)}::uuid, ${lit(y)}::uuid)`));
  const deleteError = refusal(`DELETE FROM public.builder_stock_uploads WHERE id = ${lit(x)}::uuid`);
  check('hard-deleting an upload still works, and takes its lineage rows with it',
    recorded === 1 && deleteError === null
      && Number(q1(`SELECT count(*) FROM public.builder_stock_upload_contacts
          WHERE ${lit(x)}::uuid IN (upload_a, upload_b)`)) === 0,
    deleteError ? deleteError.slice(0, 160) : `recorded ${recorded}`);
}

console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures ? 1 : 0);
