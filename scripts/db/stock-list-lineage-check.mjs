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
