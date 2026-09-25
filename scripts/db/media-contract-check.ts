#!/usr/bin/env -S node --experimental-strip-types
/**
 * THE MEDIA BLOCK A PROPERTY CARRIES ACROSS THE NETWORK, CHECKED BY EFFECT.
 *
 * A property's `stock.item.upserted` payload carries a versioned `media` block
 * — its photographs and the documents its row links to — composed in SQL,
 * because the outbox is composed by triggers. Two things about it can only be
 * established by running it:
 *
 *   1. THE DOCUMENT LINKS ARE THE SAME LINKS THE PORTAL SHOWS. The Builder
 *      Portal's project page lists them with `propertyDocumentLinks` (TS); the
 *      network composes them with `builder_network_property_documents` (SQL).
 *      Two implementations of one rule are two rules unless something holds
 *      them together, so every fixture below is put to both and the answers
 *      must be identical.
 *
 *   2. THE PHOTOGRAPHS ARE THE ONES THE PORTAL ALREADY ELECTED, AND NO OTHERS.
 *      The gallery is the item's primary image under exactly the composer's
 *      long-standing rule. A second ready builder image is NOT added — which
 *      images are a property's photographs is the image pipeline's decision,
 *      and this step changes nothing about it.
 *
 * It rebuilds the database the way `baseline-check.mjs` does (bootstrap,
 * baseline, every follow-on migration), then runs the scenarios. Invented
 * fixtures only. Same env contract: LOCAL_PG_HOST / LOCAL_PG_PORT /
 * LOCAL_PG_USER.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { propertyDocumentLinks } from '../../supabase/functions/_shared/builderStock/propertyDocuments.pure.ts';
import { forbiddenPathsIn } from '../../supabase/functions/_shared/builderNetworkPrivacy.pure.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '../..');
const HOST = process.env.LOCAL_PG_HOST || '/tmp';
const PORT = process.env.LOCAL_PG_PORT || '55432';
const USER = process.env.LOCAL_PG_USER || 'postgres';
const DB = process.env.MEDIA_CONTRACT_DB || 'aurixa_builders_media_contract_check';
const conn = ['-h', HOST, '-p', PORT, '-U', USER];

const psql = (args: string[]) => execFileSync('psql', [...conn, '-v', 'ON_ERROR_STOP=1', ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PGPASSWORD: '' },
});
const sql = (statement: string) => psql(['-d', DB, '-qAt', '-c', statement]).trim();
const literal = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

// --- The database ------------------------------------------------------------
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

// --- 1. Document parity --------------------------------------------------------
const fixtures: Array<[string, Record<string, unknown> | null]> = [
  ['a stock list\'s usual columns', { unmapped: {
    'Brochure URL': 'https://drive.google.com/file/d/brochure-id/view',
    'Floor Plan': 'https://example.com/plans/lot-12.pdf',
    'Siting / Masterplan URL': 'https://example.com/siting.pdf',
    'Estate Brochure / Location Map': 'https://example.com/estate.pdf',
    'Rental Appraisal': 'https://example.com/rent.pdf',
    'Build Price': '$477,440',
  } }],
  ['a link only the recovery could see', {
    recovered_link_columns: ['Brochure'],
    unmapped: { Brochure: 'https://drive.google.com/file/d/recovered/view', 'Build Price': '$1' },
  }],
  ['one document pasted twice, and schemes a browser would execute', { unmapped: {
    'Brochure URL': 'https://example.com/a.pdf',
    Brochure: 'https://example.com/a.pdf',
    Other: 'javascript:alert(1) ftp://example.com/x.pdf',
  } }],
  ['several links in one cell, trailing punctuation, a plain word', { unmapped: {
    Downloads: 'See https://example.com/one.pdf, and https://example.com/two.pdf).',
    Package: 'Package',
    'Plan of Subdivision Link': 'http://example.com/pos.pdf',
  } }],
  ['more than twelve', { unmapped: Object.fromEntries(Array.from({ length: 20 }, (_, i) =>
    [`Doc ${String(i).padStart(2, '0')}`, `https://example.com/${i}.pdf`])) }],
  ['a heading that is only "URL"', { unmapped: { URL: 'https://example.com/only.pdf' } }],
  // Links a parser refuses: a port that is not a number, a port out of range,
  // a host holding a character no host may hold, an empty host after userinfo.
  ['links the portal\'s URL parser refuses', { unmapped: {
    'Bad Port': 'https://example.com:bad/file.pdf',
    'Big Port': 'https://example.com:99999/file.pdf',
    'Odd Host': 'https://exa<mple.com/file.pdf',
    'Pipe Host': 'https://exa|mple.com/file.pdf',
    'Empty Host': 'https://user@/file.pdf',
    'Good Port': 'https://example.com:8443/file.pdf',
    'Good Userinfo': 'https://user:pass@example.com/file.pdf',
    'Bracket Host': 'https://[::1]/file.pdf',
    'Query Only': 'https://example.com?x=1',
    'Empty Port': 'https://example.com:/file.pdf',
    'Escaped Host': 'https://ex%41mple.com/file.pdf',
    'Broken Escape': 'https://ex%zzmple.com/file.pdf',
    'Caret Host': 'https://exa^mple.com/file.pdf',
    'Backslash': 'https://exa\\mple.com/file.pdf',
    'Bad Bracket': 'https://[bad]/file.pdf',
    'Underscore Host': 'https://ex_ample.com/file.pdf',
  } }],
  ['no row at all', null],
  ['an empty row', {}],
];

for (const [name, row] of fixtures) {
  const expected = propertyDocumentLinks(row as Record<string, unknown> | null).map((link) => ({
    id: createHash('md5').update(link.url).digest('hex'),
    kind: link.kind,
    label: link.label,
    url: link.url,
  }));
  // jsonb orders an object's keys by length, so both sides are re-keyed alike.
  const actual = (JSON.parse(sql(
    `SELECT public.builder_network_property_documents(${row === null ? 'NULL' : literal(row)})::text`) || '[]') as
    Array<Record<string, string>>).map(({ id, kind, label, url }) => ({ id, kind, label, url }));
  check(`documents parity: ${name}`, JSON.stringify(actual) === JSON.stringify(expected),
    `sql ${JSON.stringify(actual)} vs ts ${JSON.stringify(expected)}`);
}

// --- 2. The composer -----------------------------------------------------------
const org = randomUUID();
sql(`INSERT INTO public.builder_organisations(id, legal_name, org_type) VALUES ('${org}', 'Media Proof Homes Pty Ltd', 'builder')`);

function stockItem(sourceRow: Record<string, unknown>): string {
  return sql(`INSERT INTO public.builder_stock_items(organisation_id, lifecycle_status, address_line, source_row)
    VALUES ('${org}', 'active', '12 Proof Street', ${literal(sourceRow)}) RETURNING id`);
}
function image(itemId: string, over: Record<string, string> = {}): string {
  const values = {
    source_stage: 'uploaded_document', verification_status: 'source_supplied',
    processing_status: 'ready', storage_path: `proof/${randomUUID()}.jpg`, ...over,
  };
  return sql(`INSERT INTO public.builder_stock_item_images(
      stock_item_id, organisation_id, source_stage, verification_status, processing_status,
      storage_path, content_type, source_detail)
    VALUES ('${itemId}', '${org}', '${values.source_stage}', '${values.verification_status}',
      '${values.processing_status}', '${values.storage_path}', 'image/jpeg',
      '{"role":"primary_property"}'::jsonb) RETURNING id`);
}
const payloadOf = (itemId: string) =>
  JSON.parse(sql(`SELECT public.builder_network_compose_stock_item_payload('${itemId}')::text`));

{
  const row = { unmapped: { 'Brochure URL': 'https://example.com/brochure.pdf', 'Build Price': '$1' } };
  const item = stockItem(row);
  const primary = image(item);
  const second = image(item); // ready, source-supplied, but NOT the property's elected photograph
  sql(`UPDATE public.builder_stock_items SET primary_image_id = '${primary}' WHERE id = '${item}'`);
  const payload = payloadOf(item);

  check('the payload carries a versioned media block', payload.media?.schema_version === 1);
  check('one elected photograph travels, at the head of the gallery',
    JSON.stringify(payload.media.photos.map((p: { id: string }) => p.id)) === JSON.stringify([primary]),
    JSON.stringify(payload.media.photos));
  check('an image the portal did not elect does not travel', !JSON.stringify(payload.media).includes(second));
  check('the legacy primary_image is unchanged', payload.primary_image?.id === primary
    && payload.primary_image?.position === 0 && payload.primary_image?.source_stage === 'uploaded_document');
  const documents = (payload.media.documents as Array<Record<string, string>>)
    .map(({ id, kind, label, url }) => ({ id, kind, label, url }));
  check('the documents travel, typed and keyed', JSON.stringify(documents) === JSON.stringify([{
    id: createHash('md5').update('https://example.com/brochure.pdf').digest('hex'),
    kind: 'brochure', label: 'Brochure', url: 'https://example.com/brochure.pdf',
  }]), JSON.stringify(documents));
  check('no storage path crosses', !JSON.stringify(payload.media).includes('proof/'));
  check('the payload passes the privacy contract', forbiddenPathsIn(payload).length === 0,
    forbiddenPathsIn(payload).join(', '));
  check('the gallery function answers the same photograph',
    sql(`SELECT array_to_string(public.builder_network_stock_item_gallery('${item}'), ',')`) === primary);

  // A primary that is not ready is not a photograph yet.
  sql(`UPDATE public.builder_stock_item_images SET processing_status = 'pending' WHERE id = '${primary}'`);
  check('an unready primary sends 0 photographs, explicitly', JSON.stringify(payloadOf(item).media.photos) === '[]');

  // No primary at all.
  const bare = stockItem({});
  const bareMedia = payloadOf(bare).media;
  check('no photograph and no documents is an explicit empty block',
    bareMedia?.schema_version === 1 && JSON.stringify(bareMedia.photos) === '[]'
      && JSON.stringify(bareMedia.documents) === '[]',
    JSON.stringify(bareMedia));
}

// --- 3. The trigger: a changed document is an event; a changed price cell is not a new one ---
{
  const workspace = sql(`INSERT INTO public.workspace_registry(mc_clone_id, slug)
    VALUES ('${randomUUID()}', 'media-contract-${Date.now()}') RETURNING id`);
  sql(`INSERT INTO public.workspace_connections(workspace_id, builder_organisation_id, initiated_by, state, accepted_at)
    VALUES ('${workspace}', '${org}', 'builder', 'active', now())`);
  const item = stockItem({ unmapped: { Brochure: 'https://example.com/v1.pdf', 'Build Price': '$1' } });
  const count = () => Number(sql(`SELECT count(*) FROM public.builder_network_outbox
    WHERE event_type = 'stock.item.upserted' AND payload->>'id' = '${item}'`));
  const before = count();
  sql(`UPDATE public.builder_stock_items
       SET source_row = jsonb_set(source_row, '{unmapped,Brochure}', '"https://example.com/v2.pdf"')
     WHERE id = '${item}'`);
  const afterLink = count();
  check('a changed document link enqueues the property', afterLink === before + 1, `${before} -> ${afterLink}`);
  sql(`UPDATE public.builder_stock_items
       SET source_row = jsonb_set(source_row, '{unmapped,Build Price}', '"$2"')
     WHERE id = '${item}'`);
  check('a changed non-link cell does not', count() === afterLink);
}

psql(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);

if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nMedia contract check passed.');
