/**
 * ===========================================================================
 * WHICH ORGANISATION A STORED FILE BELONGS TO — WRITTEN ONCE.
 * ===========================================================================
 *
 * MEASURED IN PRODUCTION, 28 SEPTEMBER 2026, by the final Builder Portal
 * audit: the Builder's two stock buckets held 112 objects under organisations
 * that no longer exist, and every one was a proof's:
 *
 *   - 94 from `production-smoke.mjs`, whose cleanup deleted its rows and never
 *     its files: 39 `smoke-stock.csv` and 19 `smoke-stock-brochure.csv` in the
 *     list bucket, and in the image bucket 17 `facade.png` and 19 pictures
 *     read out of the smoke brochure;
 *   - 18 from the Tier-0 proofs, whose cleanup removed `<org>/` and
 *     `stock-lists/<org>/` but not `builder-supplied/<org>/`, where a
 *     builder's own "Add picture" lands, with the product's sanitised copy
 *     beside it.
 *
 * A row goes with its organisation, because its foreign keys cascade. An
 * object does not, because storage has no foreign key. So the rule for which
 * organisation owns an object lives here. Every proof's cleanup, the cleanup
 * audit (`step6-proof-audit.mjs`) and the residue sweep
 * (`storage-residue-sweep.mjs`) read it, and none of them restates it.
 */

/** The Builder's two stock buckets: the lists builders upload, and their pictures. */
export const STOCK_BUCKETS = ['builder-stock-lists', 'builder-stock-images'];

/**
 * Path families whose SECOND segment is the organisation. Everything else
 * this product writes into these buckets starts with the organisation id
 * itself (`<org>/<upload>/…`). `system/` belongs to no organisation, and a
 * path whose segment is not a uuid is never judged by the rule below.
 */
const NAMESPACED = ['builder-supplied', 'org', 'stock-lists'];

/** SQL text: the organisation segment of a stored object's path. */
export function objectOrganisationSql(nameColumn = 'name') {
  return `(CASE WHEN split_part(${nameColumn}, '/', 1) IN (${NAMESPACED.map((family) => `'${family}'`).join(', ')})
                THEN split_part(${nameColumn}, '/', 2) ELSE split_part(${nameColumn}, '/', 1) END)`;
}

/** The storage API, with the project's service key read through the Management API. */
export async function storageClient(ref, accessToken) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`api-keys ${ref.slice(0, 4)}…: HTTP ${response.status}`);
  const keys = await response.json();
  const key = (Array.isArray(keys) ? keys : []).find((k) => k?.name === 'service_role')?.api_key;
  if (!key) throw new Error('no service_role key');
  return { base: `https://${ref}.supabase.co/storage/v1`, headers: { Authorization: `Bearer ${key}`, apikey: key } };
}

/**
 * Delete these exact object names from one bucket, a hundred at a time.
 * Throws when storage refuses, so a cleanup that removed nothing never reads
 * as one that removed everything. Returns how many storage reported deleted.
 */
export async function removeObjects(storage, bucket, names) {
  let removed = 0;
  for (let i = 0; i < names.length; i += 100) {
    const response = await fetch(`${storage.base}/object/${bucket}`, {
      method: 'DELETE', headers: { ...storage.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: names.slice(i, i + 100) }),
    });
    if (!response.ok) throw new Error(`storage refused a delete in ${bucket}: HTTP ${response.status}`);
    const body = await response.json().catch(() => []);
    removed += Array.isArray(body) ? body.length : 0;
  }
  return removed;
}

/**
 * Every object an organisation holds in the stock buckets, read from the
 * database (`storage.objects`), not from the storage API's folder listing. A
 * listing that fails reads as an empty folder, and that is exactly how a
 * cleanup comes to believe it removed everything. `sql` is the caller's
 * Management API query function for the Builder project.
 */
export async function organisationObjects(sql, orgIds) {
  const ids = orgIds.filter((value) => /^[0-9a-f-]{36}$/i.test(String(value)));
  if (!ids.length) return [];
  return sql(`
    SELECT o.bucket_id AS bucket, o.name
      FROM storage.objects o
     WHERE o.bucket_id IN (${STOCK_BUCKETS.map((b) => `'${b}'`).join(', ')})
       AND ${objectOrganisationSql('o.name')} IN (${ids.map((value) => `'${value}'`).join(', ')})`);
}

/** Remove every object these organisations hold. Returns the count removed. */
export async function removeOrganisationObjects(storage, sql, orgIds) {
  const rows = await organisationObjects(sql, orgIds);
  let removed = 0;
  for (const bucket of STOCK_BUCKETS) {
    const names = rows.filter((row) => row.bucket === bucket).map((row) => row.name);
    if (names.length) removed += await removeObjects(storage, bucket, names);
  }
  return removed;
}
