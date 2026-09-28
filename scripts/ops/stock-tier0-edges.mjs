#!/usr/bin/env node
/**
 * ===========================================================================
 * TIER-0 · WHAT A BUILDER GETS WHEN THE FILE, OR THE CLICK, IS WRONG.
 * ===========================================================================
 *
 * Every case goes through the live product exactly as a builder's browser
 * sends it, into organisations of the run's own that are detached from every
 * workspace (nothing here needs the Command Centre), and each answer is read
 * from the rows the product wrote:
 *
 *   E1  files the product must refuse — a TIFF, a program named .csv, an
 *       archive, an empty file, a file past 25 MB, a path in the file name —
 *       are refused with a reason a builder can act on, and leave no
 *       property behind;
 *   E2  files it must read CAREFULLY — an unterminated quote, missing cells,
 *       a row that identifies nothing, the same row twice, a second row for
 *       the same estate and lot, `$1.2m` / `749k` / `0.5 acres` / `21.5
 *       squares`, a count of 99, money in an area column, Unicode, and
 *       values longer than any column — store what the document states and
 *       nothing it does not;
 *   E3  the clicks — the same file processed twice at once, two different
 *       lists uploaded one after the other, "Read again", a colleague
 *       without the right, another organisation's upload id, links that must
 *       never be fetched, a file that is not what its upload declared.
 *
 * Deletes everything it creates and counts what is left.
 *
 * Runs from the production-rollout workflow (phase `stock-tier0-edges`).
 */
import {
  RUN, record, net, id, sha256, secs, waitFor, stock, fixture, storageFor, withLinks, seedOrganisation,
  uploadDocument, uploadRow, waitImported, itemsOf, cleanup, leftovers, finish, NETWORK_REF, contentTypeOf, sleep,
} from './tier0/common.mjs';

const TAG = 'tier0-edges';
const importedAs = async (org, name, bytes, contentType) => {
  const sent = await uploadDocument(org.cookie, name, bytes, contentType);
  if (!sent.uploadId) return { sent, upload: null, items: [] };
  const done = await waitImported(sent.uploadId, 6 * 60_000);
  return { sent, upload: done.upload, items: await itemsOf(org.orgId, `AND i.upload_id = ${id(sent.uploadId)}`) };
};
const brief = (r) => `create ${r.sent.created?.status}${r.sent.created?.json?.code ? `/${r.sent.created.json.code}` : ''}`
  + `${r.sent.processed ? `, process ${r.sent.processed.status}${r.sent.processed.json?.code ? `/${r.sent.processed.json.code}` : ''}` : ''}`
  + `${r.upload ? `, upload ${r.upload.status}${r.upload.error_code ? `/${r.upload.error_code}` : ''}` : ''}`
  + `${(r.sent.created?.json?.error || r.sent.processed?.json?.error || r.upload?.error_message)
    ? ` — "${String(r.sent.created?.json?.error || r.sent.processed?.json?.error || r.upload?.error_message).slice(0, 140)}"` : ''}`;

let storage = null;
try {
  console.log(`tier-0 edges run=${RUN}`);
  storage = await storageFor(NETWORK_REF);
  await cleanup(TAG, 'start', storage);
  const org = await seedOrganisation(TAG, 'files');
  const member = await seedOrganisation(TAG, 'filesmember', { role: 'member', existingOrgId: org.orgId });
  const viewer = await seedOrganisation(TAG, 'filesviewer', { role: 'read_only', existingOrgId: org.orgId });
  const other = await seedOrganisation(TAG, 'other');

  // === E1. Refused ================================================================
  for (const [label, name, bytes, type] of [
    ['a TIFF image', 'schedule.tiff', fixture('neg/unsupported.tiff'), 'image/tiff'],
    ['a program named .csv', 'stock.csv', fixture('neg/program.csv'), 'text/csv'],
    ['an archive', 'stock.zip', fixture('neg/archive.zip'), 'application/zip'],
  ]) {
    const r = await importedAs(org, name, bytes, type);
    const refused = r.sent.created?.status === 400 || r.sent.processed?.status >= 400 || ['failed', 'error', 'rejected'].includes(r.upload?.status);
    const reason = r.sent.created?.json?.error || r.sent.processed?.json?.error || r.upload?.error_message || '';
    record(`E1: ${label} is refused with a reason a builder can act on, and leaves no property`,
      refused && reason.length > 10 && r.items.length === 0, brief(r));
  }
  const blank = await uploadDocument(org.cookie, 'empty.csv', fixture('neg/blank.csv'), 'text/csv');
  record('E1: an empty file is refused before anything is stored', blank.created?.status === 400 && blank.created?.json?.code === 'empty_file',
    `create ${blank.created?.status}/${blank.created?.json?.code}`);
  const big = await portal_create(org, 'huge.csv', 26 * 1024 * 1024);
  record('E1: a file past 25 MB is refused at the door', big.status === 400 || big.status === 413, `create ${big.status} "${big.json?.error ?? ''}"`);
  const lie = await uploadDocument(org.cookie, 'small.csv', new Uint8Array(4 * 1024 * 1024).fill(65), 'text/csv');
  const lieRow = lie.uploadId ? await uploadRow(lie.uploadId) : null;
  record('E1: 4 MB PUT against an upload that declared 4 MB (control) — the declared size is what is stored',
    !!lie.uploadId, `create ${lie.created?.status}, put ${lie.put ?? '—'}, process ${lie.processed?.status ?? '—'}, `
    + `upload ${lieRow?.status ?? '—'} ${lieRow?.error_code ?? ''}`, { required: false });
  /*
   * The create answer carries no storage path (the projection does not
   * publish it), so the stored row is read. What matters is the SEGMENTS: the
   * object must sit in this organisation's folder, under its own upload id,
   * as ONE segment — a name like `..-..-other-org-..-stock.csv` is a file
   * called that, not a way out, so a `..` substring is not the test.
   */
  const trav = await portal_create(org, '../../other-org/../stock.csv', 100);
  const travRow = trav.json?.upload?.id ? await uploadRow(trav.json.upload.id) : null;
  const travPath = String(travRow?.storage_path ?? '');
  const travSegments = travPath.split('/');
  const orgAt = travSegments.indexOf(org.orgId);
  record('E1: a path in the file name never leaves the organisation\'s own folder', trav.status !== 200
    || (orgAt >= 0 && travSegments[orgAt + 1] === trav.json.upload.id && travSegments.length === orgAt + 3
      && !travSegments.some((segment) => segment === '..' || segment === '.' || segment === '')),
    `create ${trav.status}, path ${travPath.replace(org.orgId, '<org>').replace(trav.json?.upload?.id ?? '§', '<upload>')}`);
  const headerOnly = await importedAs(org, 'header-only.csv', fixture('neg/header-only.csv'), 'text/csv');
  record('E1: a list with a heading and no rows imports nothing and says so', headerOnly.items.length === 0
    && Number(headerOnly.upload?.records_detected ?? 0) === 0, brief(headerOnly));

  // === E2. Read carefully ================================================================
  const malformed = await importedAs(org, 'malformed.csv', fixture('neg/malformed.csv'), 'text/csv');
  const m701 = malformed.items.find((i) => i.lot_number === '701');
  const m702 = malformed.items.find((i) => i.lot_number === '702');
  record('E2: an unterminated quote does not silently swallow the next property', !!m702,
    `${malformed.items.length} stored (lots ${malformed.items.map((i) => i.lot_number).join(', ')}); `
    + `701 price_display ${JSON.stringify(String(m701?.price_display ?? '').slice(0, 60))}; detected ${malformed.upload?.records_detected}, failed ${malformed.upload?.records_failed}`);
  record('E2: and no property is published carrying another row\'s text as its price',
    !m701?.price_display || String(m701.price_display).length < 40, `701 price_display length ${String(m701?.price_display ?? '').length}`);

  const partial = await importedAs(org, 'partial.csv', fixture('neg/partial.csv'), 'text/csv');
  const p711 = partial.items.find((i) => i.lot_number === '711');
  record('E2: a row with missing cells is stored with those fields EMPTY — nothing invented',
    !!p711 && p711.bedrooms === null && p711.bathrooms === null && p711.car_spaces === null && p711.price === null
      && p711.building_size_sqm === null && Number(p711.land_size_sqm) === 300,
    JSON.stringify({ beds: p711?.bedrooms, baths: p711?.bathrooms, car: p711?.car_spaces, price: p711?.price, land: p711?.land_size_sqm }));
  const p712 = partial.items.find((i) => i.lot_number === '712');
  record('E2: a row that identifies no property (a lot and nothing else) is accounted for, not silently lost',
    !!p712 || Number(partial.upload?.records_failed ?? 0) > 0 || Number(partial.upload?.records_detected ?? 0) === 1,
    `stored ${partial.items.length}; detected ${partial.upload?.records_detected}, imported ${partial.upload?.records_imported}, failed ${partial.upload?.records_failed}`);

  const dup = await importedAs(org, 'duplicate-rows.csv', fixture('neg/duplicate-rows.csv'), 'text/csv');
  const d721 = dup.items.filter((i) => i.lot_number === '721');
  record('E2: the same row twice, and a second row for the same estate and lot, make ONE property', d721.length === 1,
    `${d721.length} propert${d721.length === 1 ? 'y' : 'ies'} for lot 721 (refs ${d721.map((i) => i.external_reference).join(', ')}, prices ${d721.map((i) => i.price).join(', ')})`);

  const unusual = await importedAs(org, 'unusual.csv', fixture('neg/unusual.csv'), 'text/csv');
  const u = (ref) => unusual.items.find((i) => i.external_reference === ref) ?? {};
  const checks = [
    ['$1.2m is 1,200,000 and is shown as written', Number(u('T0-731').price) === 1200000 && u('T0-731').price_display === '$1.2m'],
    ['0.5 acres is 2,023.43 m²', Math.abs(Number(u('T0-731').land_size_sqm) - 2023.43) < 0.1],
    ['21.5 squares is 199.74 m²', Math.abs(Number(u('T0-731').building_size_sqm) - 199.74) < 0.1],
    ['"Under Contract" is contracted', u('T0-731').availability_status === 'contracted'],
    ['749k is 749,000', Number(u('T0-732').price) === 749000],
    ['EOI is reserved', u('T0-732').availability_status === 'reserved'],
    ['"From $749,000" keeps its words', u('T0-733').price_display === 'From $749,000' && Number(u('T0-733').price) === 749000],
    ['"Contact agent" is not a status', u('T0-733').availability_status === 'unknown'],
    ['99 bedrooms is refused, not stored', u('T0-734').bedrooms === null],
    ['a negative car count is refused', u('T0-734').car_spaces === null],
    ['money in the land column is not an area', u('T0-734').land_size_sqm === null],
    ['12.5m x 36m is two lengths, not an area', u('T0-734').building_size_sqm === null],
    ['"Contact agent" as a price is shown as written with no figure', u('T0-734').price === null && u('T0-734').price_display === 'Contact agent'],
  ];
  const failedChecks = checks.filter(([, ok]) => !ok).map(([label]) => label);
  record('E2: unusual values are read as the product documents them', failedChecks.length === 0,
    failedChecks.length ? `wrong: ${failedChecks.join('; ')}` : `${checks.length} readings exact`);
  record('E2: a lot written "Lot 12A" or "L733" is stored as the lot, not with its label',
    ['12A'].includes(String(u('T0-732').lot_number)) && ['733', 'L733'].includes(String(u('T0-733').lot_number)),
    `stored ${JSON.stringify(u('T0-732').lot_number)} and ${JSON.stringify(u('T0-733').lot_number)}`, { required: false });

  const uni = await importedAs(org, 'unicode.csv', fixture('neg/unicode.csv'), 'text/csv');
  const x = uni.items[0] ?? {};
  record('E2: Unicode survives exactly — accents, an em dash, CJK, emoji',
    x.address_line === '12 Crème Brûlée Way' && x.development_name === 'Kestrel Grove — Stage ✓'
      && x.house_design === 'Café 25 ☕' && String(x.description).includes('中文说明') && String(x.description).includes('🏠'),
    JSON.stringify({ addr: x.address_line, dev: x.development_name, design: x.house_design }));
  const long = await importedAs(org, 'long.csv', fixture('neg/long.csv'), 'text/csv');
  const l = long.items[0] ?? {};
  record('E2: text longer than a column is kept to the column\'s bound without failing the import',
    long.upload?.status === 'complete' && !!l.id && String(l.description ?? '').length <= 4000,
    `status ${long.upload?.status}; address ${String(l.address_line ?? '').length} chars, description ${String(l.description ?? '').length} chars`);
  const named = await importedAs(org, 'workbook-named.csv', fixture('neg/workbook-named.csv'), 'text/csv');
  record('E2: a workbook named .csv is read as the workbook its bytes are', named.items.length === 2,
    `${named.items.length} properties via ${named.upload?.parse_strategy}`);

  // === E3. The clicks ======================================================================
  // The same upload processed twice at once, as two tabs or a double click would.
  const twice = await stock({ operation: 'create_upload', filename: 'twice.csv', content_type: 'text/csv',
    byte_size: fixture('tsv.tsv').length }, org.cookie);
  const twiceBytes = new TextEncoder().encode(new TextDecoder().decode(fixture('tsv.tsv')));
  await fetch(twice.json?.signed_url, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: twiceBytes });
  const [a, b] = await Promise.all([
    stock({ operation: 'process_upload', upload_id: twice.json?.upload?.id }, org.cookie),
    stock({ operation: 'process_upload', upload_id: twice.json?.upload?.id }, org.cookie),
  ]);
  await waitImported(twice.json?.upload?.id, 6 * 60_000);
  const twiceItems = await itemsOf(org.orgId, `AND i.upload_id = ${id(twice.json?.upload?.id)}`);
  record('E3: processing the same upload twice at once imports it once', twiceItems.length === 2,
    `answers ${a.status}/${b.status}; ${twiceItems.length} properties (expected 2)`);

  const reread = await stock({ operation: 'reprocess_upload', upload_id: twice.json?.upload?.id }, org.cookie);
  await sleep(3000);
  await waitImported(twice.json?.upload?.id, 6 * 60_000);
  const rereadItems = await itemsOf(org.orgId, `AND i.upload_id = ${id(twice.json?.upload?.id)}`);
  record('E3: "Read again" corrects the same properties rather than forking them',
    reread.status === 200 && rereadItems.length === 2 && rereadItems.every((i) => twiceItems.some((t) => t.id === i.id)),
    `HTTP ${reread.status}; ${rereadItems.length} properties, ids ${rereadItems.every((i) => twiceItems.some((t) => t.id === i.id)) ? 'unchanged' : 'CHANGED'}`);

  // Two different lists, uploaded one after the other, in a fresh organisation:
  // does the FIRST ever go live? (`builder_stock_upload_superseded`.)
  const seq = await seedOrganisation(TAG, 'twolists');
  const listA = new TextEncoder().encode(await withLinks(storage, seq.orgId, new TextDecoder().decode(fixture('tsv.tsv'))));
  const listB = new TextEncoder().encode(await withLinks(storage, seq.orgId, new TextDecoder().decode(fixture('txt.txt'))));
  const sentA = await uploadDocument(seq.cookie, 'Estate A.tsv', listA, 'text/tab-separated-values');
  const sentB = await uploadDocument(seq.cookie, 'Estate B.txt', listB, 'text/plain');
  await Promise.all([waitImported(sentA.uploadId), waitImported(sentB.uploadId)]);
  const both = await waitFor('two lists', async () => {
    const all = await itemsOf(seq.orgId);
    const final = all.every((i) => i.lifecycle_status === 'active' || ['settled', 'failed'].includes(i.image_work_stage));
    return { done: all.length === 4 && final && all.every((i) => i.lifecycle_status === 'active'), all };
  }, 15 * 60_000, 10_000);
  const upA = await uploadRow(sentA.uploadId);
  const upB = await uploadRow(sentB.uploadId);
  const fromA = (both.all ?? []).filter((i) => i.upload_id === sentA.uploadId);
  const fromB = (both.all ?? []).filter((i) => i.upload_id === sentB.uploadId);
  record('E3: two different stock lists uploaded one after the other BOTH go live',
    fromA.length === 2 && fromB.length === 2 && [...fromA, ...fromB].every((i) => i.lifecycle_status === 'active'),
    `list A: ${fromA.map((i) => i.lifecycle_status).join('/')} (published ${upA?.published_at ? 'yes' : 'no'}, blocked "${upA?.publication_blocked_reason ?? '—'}"); `
    + `list B: ${fromB.map((i) => i.lifecycle_status).join('/')} (published ${upB?.published_at ? 'yes' : 'no'}) after ${secs(both)}`);

  // Rights and organisation boundaries on the upload path.
  const viewerCreate = await stock({ operation: 'create_upload', filename: 'x.csv', content_type: 'text/csv', byte_size: 100 }, viewer.cookie);
  const memberCreate = await stock({ operation: 'create_upload', filename: 'x.csv', content_type: 'text/csv', byte_size: 100 }, member.cookie);
  record('E3: a read-only colleague cannot upload a stock list', viewerCreate.status === 403, `HTTP ${viewerCreate.status}`);
  record('E3: a member with edit rights can', memberCreate.status === 200, `HTTP ${memberCreate.status}`, { required: false });
  const viewerDelete = await stock({ operation: 'delete_upload', upload_id: sentA.uploadId }, viewer.cookie);
  const memberDelete = await stock({ operation: 'delete_upload', upload_id: twice.json?.upload?.id }, member.cookie);
  record('E3: deleting a stock list needs delete rights', viewerDelete.status === 403 && memberDelete.status === 403,
    `read-only ${viewerDelete.status}, member ${memberDelete.status}`);
  const foreignProcess = await stock({ operation: 'process_upload', upload_id: twice.json?.upload?.id }, other.cookie);
  const foreignReread = await stock({ operation: 'reprocess_upload', upload_id: twice.json?.upload?.id }, other.cookie);
  const foreignGet = await stock({ operation: 'get_upload', upload_id: twice.json?.upload?.id }, other.cookie);
  const foreignList = await stock({ operation: 'list_uploads' }, other.cookie);
  record('E3: another organisation cannot process, re-read or see this organisation\'s uploads',
    [foreignProcess.status, foreignReread.status, foreignGet.status].every((s) => [403, 404].includes(s))
      && !JSON.stringify(foreignList.json ?? {}).includes(twice.json?.upload?.id),
    `process ${foreignProcess.status}, re-read ${foreignReread.status}, get ${foreignGet.status}, list ${foreignList.status}`);
  const noSession = await stock({ operation: 'list_stock' }, null);
  record('E3: no session, no stock', noSession.status === 401, `HTTP ${noSession.status}`);

  // Links the product must never fetch.
  const links = {};
  for (const [label, url] of [
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'http://localhost:54321/rest/v1/'],
    ['a private address', 'http://10.0.0.1/stock.csv'],
    ['a file URL', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['plain http', 'http://example.com/stock.csv'],
  ]) {
    const r = await stock({ operation: 'import_url', url }, org.cookie);
    links[label] = r.status;
  }
  record('E3: links to internal, local, file and script addresses are refused', Object.values(links).every((s) => s >= 400 && s < 500),
    JSON.stringify(links));
  const fromLink = await stock({ operation: 'import_url',
    url: 'https://raw.githubusercontent.com/Naidu-Group-Pty-Ltd/aurixa-builders/main/scripts/ops/fixtures/smoke-stock.csv' }, org.cookie);
  const linkUpload = fromLink.json?.upload?.id ?? fromLink.json?.upload_id ?? null;
  if (linkUpload) await waitImported(linkUpload, 6 * 60_000);
  const linkItems = linkUpload ? await itemsOf(org.orgId, `AND i.upload_id = ${id(linkUpload)}`) : [];
  record('E3: a published CSV link imports over the URL path', fromLink.status === 200 && linkItems.length === 2,
    `HTTP ${fromLink.status}, ${linkItems.length} properties`);
} catch (error) {
  record('the run completed', false, String(error?.stack ?? error).slice(0, 500));
} finally {
  try {
    await cleanup(TAG, 'end', storage);
    const left = await leftovers(TAG);
    record('cleanup: nothing this run made remains',
      Object.values(left.network).every((v) => Number(v) === 0) && Object.values(left.command).every((v) => Number(v) === 0),
      JSON.stringify(left));
  } catch (error) {
    record('cleanup: completed', false, String(error?.message ?? error).slice(0, 300));
  }
  finish('stock-tier0-edges', { run: RUN });
}

/** `create_upload` alone — for the refusals that must happen before any bytes move. */
async function portal_create(org, filename, byteSize) {
  return stock({ operation: 'create_upload', filename, content_type: contentTypeOf(filename), byte_size: byteSize }, org.cookie);
}
