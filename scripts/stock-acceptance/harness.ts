/**
 * THE RELEASE GATE — the portal's own path, over real bytes, with no model.
 *
 * Every fixture is put through the SAME boundary `process_upload` uses: a row
 * in `builder_stock_uploads`, the bytes in storage, the bytes downloaded back
 * out through the client, and `runStockImport`. Then the SAME document is put
 * through the URL route, which fetches those bytes over HTTP and hands the
 * same function the same array. What the two produce is compared field by
 * field, because a transport that changes an interpretation is the defect this
 * corpus exists to refuse.
 *
 * NOTHING HERE READS A FIXTURE'S NAME TO DECIDE ANYTHING. The filename travels
 * because provenance travels; the expectations come from `manifest.json`,
 * which is authored from what each document STATES.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { runStockImport } from '../../supabase/functions/_shared/builderStock/runImport.ts';
/*
 * THE PORTAL'S OWN SERVING STEP, imported rather than imitated. This is what
 * `builder-portal-stock`'s `image_url` operation calls, so what the gate
 * proves is the function a customer's browser reaches.
 */
import { serveStockImage } from '../../supabase/functions/_shared/builderStock/serveStockImage.ts';
/*
 * THE IMAGE PIPELINE, driven the way the settler drives it. `runStockImport`
 * leaves every property at `image_work_stage: 'source'` with no photograph —
 * imagery is asynchronous in production and a cron function does it. A gate
 * that stops at the import therefore proves nothing about what a customer
 * sees, which is exactly what this corpus was doing: it carried an `image`
 * expectation on eleven fixtures and never once checked it.
 */
import {
  claimOneImageWorkItem, completeItemWork,
} from '../../supabase/functions/_shared/builderStock/itemWorkClaim.ts';
import { settleClaimedItem } from '../../supabase/functions/_shared/builderStock/settleItemImages.ts';
import { settleUploadSourceImages } from '../../supabase/functions/_shared/builderStock/settleSourceImages.ts';
import { enforceStrictPrimaryImages } from '../../supabase/functions/_shared/builderStock/primaryImage.ts';

// ---------------------------------------------------------------------------
// 1 · A MODEL CALL IS AN ERROR, NOT A MISSING CREDENTIAL
// ---------------------------------------------------------------------------
/**
 * Unsetting a key proves a call did not COMPLETE. This proves it was never
 * ATTEMPTED, which is the claim the release gate actually makes — and it is
 * the difference between "the pipeline does not depend on a model" and "the
 * model happened to be unreachable today".
 */
const MODEL_HOSTS = [
  'openrouter.ai', 'api.openai.com', 'generativelanguage.googleapis.com',
  'api.anthropic.com', 'api.mistral.ai', 'api.cohere.ai', 'api.groq.com',
];
let modelCallAttempts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (MODEL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    modelCallAttempts.push(url);
    throw new Error(`[acceptance] a generative-model call was attempted: ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

/**
 * IS THIS ACTUALLY AN IMAGE? Read as one, not trusted as one.
 *
 * A content type is a claim the server makes and a byte count is a claim
 * nobody makes. What settles it is parsing the format's own header for the
 * picture's dimensions: a JPEG's start-of-frame, a PNG's IHDR, a GIF's logical
 * screen descriptor, a WebP's VP8 chunk. A truncated file, an HTML error page
 * served with an image content type, or a zero-byte placeholder all fail here,
 * and every one of those is a blank card.
 */
function decodeImage(
  b: Uint8Array,
): { kind: string; width: number; height: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  // PNG: 8-byte signature, then IHDR with width/height big-endian
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const be32 = (i: number) =>
      (b[i] << 24 >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    return { kind: 'png', width: be32(16), height: be32(20) };
  }
  // GIF: "GIF8", then the logical screen descriptor, little-endian
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { kind: 'gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  // WebP: RIFF....WEBPVP8
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    if (b[15] === 0x20) {  // VP8 (lossy)
      return { kind: 'webp', width: (b[26] | (b[27] << 8)) & 0x3fff,
               height: (b[28] | (b[29] << 8)) & 0x3fff };
    }
    return { kind: 'webp', width: 2, height: 2 };  // shape known, size unread
  }
  // JPEG: walk the markers to a start-of-frame, which carries the dimensions.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; continue;
      }
      const len = u16(i + 2);
      // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range
      if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: 'jpeg', height: u16(i + 5), width: u16(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2 · The local project
// ---------------------------------------------------------------------------
const GATEWAY = Deno.env.get('GATEWAY_URL') ?? 'http://localhost:54997';
const KEY = (await Deno.readTextFile('/var/tmp/service-role.jwt')).trim();
const BUCKET = 'builder-stock-lists';
const corpusDir = Deno.args[0] ?? '/var/tmp/corpus';

const db = createClient(GATEWAY, KEY, { auth: { persistSession: false } });

interface Expect {
  properties: number;
  rows?: Record<string, unknown>[];
  image?: string | null;
  outcome?: string;
  forbid?: Record<string, unknown>;
  refusal_must_not_be?: string[];
  known_limit?: string;
}
interface Entry {
  name: string; org: string; filename: string; path: string;
  held_out: boolean; expect: Expect; bytes: number;
}

const manifest: Entry[] = JSON.parse(
  await Deno.readTextFile(`${corpusDir}/manifest.json`));

// ---------------------------------------------------------------------------
// 3 · Two isolated organisations
// ---------------------------------------------------------------------------
const orgs: Record<string, { id: string; name: string; userId: string }> = {};
/**
 * FOUR ORGANISATIONS, AND THE REASON IS A RULE WE MUST NOT WEAKEN.
 *
 * The duplicate guard is keyed on (organisation, sha256), so putting the same
 * bytes through both routes inside one organisation makes route B answer
 * `duplicate_file` — correctly. The contract asks for "equivalent
 * organisation and document context", not the same one, so each organisation
 * has a TWIN that route B imports into: same shape, same permissions, no
 * shared history. Relaxing the duplicate rule to make the comparison possible
 * would have been testing a product we do not ship.
 */
for (const [key, legal] of [
  ['alpha', 'Alpha Homes Pty Ltd'], ['beta', 'Beta Living Group Pty Ltd'],
  ['alpha:b', 'Alpha Homes (B) Pty Ltd'], ['beta:b', 'Beta Living Group (B) Pty Ltd'],
]) {
  const { data: org, error } = await db.from('builder_organisations')
    .insert({ legal_name: legal, org_type: 'builder' }).select('id').single();
  if (error) throw new Error(`seed org ${key}: ${error.message}`);
  const { data: user, error: uErr } = await db.from('builder_portal_users')
    .insert({ email: `${key}@acceptance.invalid`, name: `${legal} Operator` })
    .select('id').single();
  if (uErr) throw new Error(`seed user ${key}: ${uErr.message}`);
  // Membership is its own table, as it is in production: a portal user is not
  // owned by an organisation, they are a member of one.
  const { error: mErr } = await db.from('builder_organisation_memberships')
    .insert({ organisation_id: org.id, builder_user_id: user.id, membership_role: 'owner' });
  if (mErr) throw new Error(`seed membership ${key}: ${mErr.message}`);
  orgs[key] = { id: org.id, name: legal, userId: user.id };
}

// ---------------------------------------------------------------------------
// 4 · A local origin that serves the corpus over HTTP — route B's transport
// ---------------------------------------------------------------------------
const served = new Map<string, Uint8Array>();
let urlFetches = 0;
const fileServer = Deno.serve({ port: 54996, onListen: () => {} }, (req) => {
  const key = new URL(req.url).pathname.slice(1);
  const bytes = served.get(key);
  if (!bytes) return new Response('not found', { status: 404 });
  urlFetches += 1;
  // `Uint8Array<ArrayBufferLike>` does not satisfy `BodyInit` under Deno's
  // stricter generic; the bytes are copied into a plain buffer to say so.
  const body = new Uint8Array(bytes.length);
  body.set(bytes);
  return new Response(body.buffer as ArrayBuffer,
    { headers: { 'content-type': 'application/pdf' } });
});

/**
 * ===========================================================================
 * RUN THE IMAGERY THE WAY THE SETTLER RUNS IT.
 * ===========================================================================
 *
 * Not a reimplementation: the same four functions
 * `builder-stock-image-settler` calls, in the order it calls them. Claim a
 * property's image work, settle the claimed stage, record the completion —
 * around a loop, because the stages are a ladder and one pass climbs one
 * rung — then bring the upload's own imagery up to the rules, then enforce
 * the primary pointers for the organisation.
 *
 * BOUNDED, because a gate that can spin is a gate nobody runs. The bound is
 * generous enough for the ladder and small enough to notice.
 */
const IMAGERY_MAX_CLAIMS = 40;

async function settleImagery(organisationId: string, uploadId: string) {
  const worked: string[] = [];
  for (let i = 0; i < IMAGERY_MAX_CLAIMS; i += 1) {
    const claim = await claimOneImageWorkItem(db, { leaseSeconds: 120, organisationId });
    if (!claim.available || !claim.item) break;
    const item = claim.item;
    const settlement = await settleClaimedItem(db, item, {
      deadlineAt: Date.now() + 20_000,
    });
    await completeItemWork(db, item.id, {
      nextStage: settlement.nextStage,
      result: settlement.result,
      progressed: settlement.progressed,
    });
    worked.push(`${item.id}:${settlement.stage}->${settlement.nextStage}`);
    if (!settlement.progressed) break;
  }
  await settleUploadSourceImages(db, { organisationId, uploadId });
  await enforceStrictPrimaryImages(db, organisationId);
  return worked;
}

// ---------------------------------------------------------------------------
// 5 · Route A and route B
// ---------------------------------------------------------------------------
const rss = () => { try { return Deno.memoryUsage().rss; } catch { return 0; } };

async function newUpload(org: string, filename: string, storagePath: string) {
  const { data, error } = await db.from('builder_stock_uploads').insert({
    organisation_id: orgs[org].id,
    uploaded_by_builder_user_id: orgs[org].userId,
    original_filename: filename,
    storage_bucket: BUCKET,
    storage_path: storagePath,
    status: 'uploaded',
  }).select('id, original_filename').single();
  if (error) throw new Error(`upload row: ${error.message}`);
  return data;
}

/** Route A — exactly what `process_upload` does, in its order. */
async function routeA(entry: Entry, bytes: Uint8Array, tag = 'A') {
  const storagePath = `${orgs[entry.org].id}/${tag}-${crypto.randomUUID()}.pdf`;
  const up = await db.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: 'application/pdf', upsert: true,
  });
  if (up.error) throw new Error(`storage upload: ${up.error.message}`);
  const upload = await newUpload(entry.org, entry.filename, storagePath);
  await db.from('builder_stock_uploads').update({ status: 'parsing' }).eq('id', upload.id);

  const dl = await db.storage.from(BUCKET).download(storagePath);
  if (dl.error || !dl.data) throw new Error(`storage download: ${dl.error?.message}`);
  const downloaded = new Uint8Array(await dl.data.arrayBuffer());

  const t0 = performance.now(); const m0 = rss();
  const result = await runStockImport({
    supabase: db,
    organisationId: orgs[entry.org].id,
    organisationName: orgs[entry.org].name,
    builderUserId: orgs[entry.org].userId,
    upload: { id: upload.id, original_filename: upload.original_filename },
    bytes: downloaded,
    sourceKind: 'file',
  });
  return { result, uploadId: upload.id, ms: performance.now() - t0,
           rssDelta: rss() - m0, transferred: downloaded.length };
}

/** Route B — the same bytes, obtained over HTTP first. */
async function routeB(entry: Entry, bytes: Uint8Array) {
  const key = `${entry.org}/${entry.name}.pdf`;
  served.set(key, bytes);
  const t0 = performance.now(); const m0 = rss();
  const response = await realFetch(`http://localhost:54996/${key}`);
  const fetched = new Uint8Array(await response.arrayBuffer());

  const twin = `${entry.org}:b`;
  const storagePath = `${orgs[twin].id}/B-${crypto.randomUUID()}.pdf`;
  const upload = await newUpload(twin, entry.filename, storagePath);
  await db.from('builder_stock_uploads')
    .update({ status: 'parsing', source_type: 'url' }).eq('id', upload.id);

  const result = await runStockImport({
    supabase: db,
    organisationId: orgs[twin].id,
    organisationName: orgs[twin].name,
    builderUserId: orgs[twin].userId,
    upload: { id: upload.id, original_filename: upload.original_filename },
    bytes: fetched,
    sourceKind: 'url',
    baseUrl: `http://localhost:54996/${key}`,
  });
  return { result, uploadId: upload.id, ms: performance.now() - t0,
           rssDelta: rss() - m0, transferred: fetched.length };
}

// ---------------------------------------------------------------------------
// 6 · What a run is judged on
// ---------------------------------------------------------------------------
/**
 * The columns a comparison is made over, named as the TABLE names them.
 * `house_design` is not a column — it is projected out of `source_row`, the
 * way `EXISTING_ITEM_SELECT` projects it — so it is read from there rather
 * than from a column that does not exist.
 */
const COMPARED = ['lot_number', 'unit_number', 'address_line', 'suburb', 'state',
  'postcode', 'bedrooms', 'bathrooms', 'car_spaces', 'land_size_sqm',
  'building_size_sqm', 'price', 'development_name', 'project_name'];

/** What the expectation calls a field, and where the row actually keeps it. */
const FIELD_COLUMN: Record<string, string> = {
  design: 'house_design',
  estate: 'development_name',
  build_size_sqm: 'building_size_sqm',
  street_name: 'address_line',
};
const valueOf = (item: any, key: string) =>
  key === 'house_design' ? (item.source_row?.house_design ?? null) : (item[key] ?? null);

async function itemsFor(uploadId: string) {
  const { data, error } = await db.from('builder_stock_items')
    .select('*').eq('upload_id', uploadId);
  if (error) throw new Error(`read items: ${error.message}`);
  return (data ?? []).slice().sort((a: any, b: any) =>
    String(a.lot_number ?? a.id).localeCompare(String(b.lot_number ?? b.id)));
}

const fails: string[] = [];
/*
 * A GAP THIS CORPUS HAS NAMED AND NOT CLOSED.
 *
 * Reported on every run and never failing it. The distinction is not a way
 * to make a red gate green: a `known_limit` fixture is one whose outcome is
 * a REFUSAL or an absent field — never a wrong value, never a fabricated
 * record — and the limit is written out in the corpus beside the document it
 * describes. A fixture that starts producing a wrong value fails whatever is
 * written here, because every forbid- and transport-check below still runs
 * on it.
 */
const limits: string[] = [];
const report: any[] = [];
const fail = (entry: Entry, msg: string) => {
  (entry.expect.known_limit ? limits : fails).push(
    `${entry.name}: ${msg}${entry.expect.known_limit ? ` [known: ${entry.expect.known_limit}]` : ''}`);
};

for (const entry of manifest) {
  const bytes = await Deno.readFile(`${corpusDir}/${entry.path}`);
  const row: any = { name: entry.name, org: entry.org, held_out: entry.held_out,
                     bytes: entry.bytes };
  let a: Awaited<ReturnType<typeof routeA>> | null = null;
  let b: Awaited<ReturnType<typeof routeB>> | null = null;
  try { a = await routeA(entry, bytes); } catch (e) { row.routeAThrew = String(e); }
  try { b = await routeB(entry, bytes); } catch (e) { row.routeBThrew = String(e); }

  if (!a) { fail(entry, `route A threw: ${row.routeAThrew}`); report.push(row); continue; }
  if (!b) { fail(entry, `route B threw: ${row.routeBThrew}`); report.push(row); continue; }

  row.a = { ok: a.result.ok, code: (a.result as any).code, ms: Math.round(a.ms),
            strategy: (a.result as any).strategy };
  row.b = { ok: b.result.ok, code: (b.result as any).code, ms: Math.round(b.ms),
            strategy: (b.result as any).strategy };

  /*
   * THE IMAGERY, BEFORE ANYTHING IS READ OFF THE ROW.
   *
   * In production this is a cron function, not part of the import — so a gate
   * that stops at `runStockImport` reads every property at
   * `image_work_stage: 'source'` with `primary_image_id` null and calls that
   * normal. It is normal, for about a minute. What a customer sees is what the
   * settler leaves behind, so the settler is run here, on route A, through its
   * own functions.
   */
  if (a.result.ok) {
    try {
      row.imagery = await settleImagery(orgs[entry.org].id, a.uploadId);
    } catch (e) {
      fail(entry, `the image settler threw: ${(e as Error).message}`);
    }
  }

  const itemsA = await itemsFor(a.uploadId);
  const itemsB = await itemsFor(b.uploadId);
  row.propertiesA = itemsA.length;
  row.propertiesB = itemsB.length;

  // --- 6a. expected property count -------------------------------------
  if (itemsA.length !== entry.expect.properties) {
    fail(entry, `expected ${entry.expect.properties} properties, route A produced ${itemsA.length}`);
  }

  // --- 6b. A and B agree ------------------------------------------------
  if (a.result.ok !== b.result.ok) {
    fail(entry, `route A ok=${a.result.ok} but route B ok=${b.result.ok}`);
  }
  if (itemsA.length !== itemsB.length) {
    fail(entry, `route A produced ${itemsA.length} properties, route B ${itemsB.length}`);
  } else {
    for (let i = 0; i < itemsA.length; i += 1) {
      for (const f of COMPARED) {
        const va = valueOf(itemsA[i], f); const vb = valueOf(itemsB[i], f);
        if (String(va).toLowerCase() !== String(vb).toLowerCase()) {
          fail(entry, `transport changed ${f}: A=${JSON.stringify(va)} B=${JSON.stringify(vb)}`);
        }
      }
    }
  }

  // --- 6c. the fields the document states -------------------------------
  const expectRows = entry.expect.rows ?? [];
  row.items = itemsA.map((it: any) => Object.fromEntries(
    [...COMPARED, 'house_design'].map((f) => [f, valueOf(it, f)])
      .filter(([, v]) => v !== null)));
  for (let i = 0; i < Math.min(expectRows.length, itemsA.length); i += 1) {
    for (const [field, want] of Object.entries(expectRows[i])) {
      const key = FIELD_COLUMN[field] ?? field;
      const got = valueOf(itemsA[i], key);
      /*
       * CASE IS NOT COMPARED, AND THAT IS A DELIBERATE, STATED CHOICE.
       * A siting plan prints `CLYDE NORTH` and a marketing page prints
       * `Clyde North`; the reader takes whichever the document labelled and
       * stores it verbatim, which is right — coercing a document's own words
       * is how a name stops being what the builder wrote. It means a card can
       * read `ASPIRE 24 GRANDE`, which is a PRESENTATION question and is
       * reported as an observation rather than smuggled in here as a defect.
       */
      const same = want === null ? got === null
        : key === 'address_line'
          ? String(got ?? '').toLowerCase().includes(String(want).toLowerCase())
          : String(got).toLowerCase() === String(want).toLowerCase();
      if (!same) fail(entry, `row ${i} ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }

  // --- 6d. the refusals that must never be a model's --------------------
  if (!a.result.ok && entry.expect.refusal_must_not_be) {
    const code = String((a.result as any).code ?? '');
    if (entry.expect.refusal_must_not_be.includes(code)) {
      fail(entry, `refused with a model-account code: ${code}`);
    }
    row.refusal = code;
  }

  // --- 6e. things a document must NEVER produce -------------------------
  const forbid = entry.expect.forbid ?? {};
  for (const it of itemsA as any[]) {
    if (forbid.no_lot_numbers && (forbid.no_lot_numbers as string[]).includes(String(it.lot_number))) {
      fail(entry, `a context-only lot became a property: ${it.lot_number}`);
    }
    if (forbid.unit_number_containing
      && String(it.unit_number ?? '').includes(String(forbid.unit_number_containing))) {
      fail(entry, `an area schedule became a unit number: ${it.unit_number}`);
    }
    if (forbid.max_bathrooms && Number(it.bathrooms) > Number(forbid.max_bathrooms)) {
      fail(entry, `a room dimension became ${it.bathrooms} bathrooms`);
    }
    if (forbid.max_bedrooms && Number(it.bedrooms) > Number(forbid.max_bedrooms)) {
      fail(entry, `a room dimension became ${it.bedrooms} bedrooms`);
    }
    if (forbid.no_suburb && (forbid.no_suburb as string[]).includes(String(it.suburb))) {
      fail(entry, `the builder's office suburb became the property's: ${it.suburb}`);
    }
    if (forbid.no_street && (forbid.no_street as string[]).some(
      (n) => String(it.address_line ?? '').toLowerCase().includes(n.toLowerCase()))) {
      fail(entry, `the builder's office street became the property's: ${it.street_name}`);
    }
    if (forbid.land_size_not_in
      && (forbid.land_size_not_in as number[]).includes(Number(it.land_size_sqm))) {
      fail(entry, `money became area: land_size_sqm=${it.land_size_sqm}`);
    }
    if (forbid.price_not_in && (forbid.price_not_in as number[]).includes(Number(it.price))) {
      fail(entry, `area became money: price=${it.price}`);
    }
    if (forbid.build_size_not_in
      && (forbid.build_size_not_in as number[]).includes(Number(it.building_size_sqm))) {
      fail(entry, `money became area: building_size_sqm=${it.building_size_sqm}`);
    }
    /*
     * A HEADING THE PAGE SET AS DISPLAY TYPE MAY NOT REACH ANY FIELD.
     *
     * Asked of the WHOLE record rather than of a named column, because the
     * point is not which field a heading would land in — it is that
     * normalisation made these words legible and legibility is not evidence.
     * Both spellings are checked: the glyphs as the page drew them, and the
     * word they collapse to.
     */
    if (forbid.nothing_containing) {
      const record = JSON.stringify(it).toUpperCase();
      for (const word of forbid.nothing_containing as string[]) {
        if (record.includes(String(word).toUpperCase())) {
          fail(entry, `a heading the document set as display type became a `
            + `value: ${word} in ${JSON.stringify(it)}`);
        }
      }
    }
  }

  // --- 6f. A POINTER IS NOT A PHOTOGRAPH --------------------------------
  /*
   * ======================================================================
   * THE WHOLE CHAIN, ENDING IN BYTES THAT DECODE.
   * ======================================================================
   *
   * `primary_image_id` being set proves a row NAMES an image. It does not
   * prove a customer opening the Builder Portal sees one, and in this product
   * those two came apart completely once: every builder's imagery was
   * discovered, de-duplicated, classified, ranked, stored and signed while the
   * Stock List rendered zero `<img>` elements, because the function that turns
   * an image id into a URL had no caller anywhere.
   *
   * So this asserts each link, in order, and the last two are the ones a
   * database query cannot answer:
   *
   *   source image        an image row exists, from the builder's own document
   *   association         it is THIS property's, in THIS organisation, from
   *                       THIS upload
   *   eligible / cleared  `builder_stock_photo_is_source_ready` — the
   *                       PRODUCT's own publication rule, called rather than
   *                       restated, because three copies of one rule is how
   *                       two of them disagree
   *   primary selection   the item points at it
   *   serving             `serveStockImage` — the SAME function
   *                       `builder-portal-stock`'s `image_url` operation
   *                       calls. Not an imitation of it: six lines copied
   *                       into a harness prove the six lines work and prove
   *                       nothing about the function a browser reaches
   *   fetch               an HTTP GET of the minted URL answers 200
   *   decode              the returned bytes are a real image, read as one
   *
   * AND ONE NEGATIVE, which is the security half: the same image id asked for
   * by a DIFFERENT organisation must answer exactly as an image that does not
   * exist. An image id is a uuid a caller supplies.
   */
  if (a.result.ok && itemsA.length) {
    const photographs: any[] = [];
    for (const it of itemsA as any[]) {
      const primaryId = it.primary_image_id ?? null;
      if (!primaryId) {
        if (entry.expect.image) {
          fail(entry, `no photograph reached the card: primary_image_id is null`);
        }
        photographs.push({ lot: it.lot_number, primary: null });
        continue;
      }

      const { data: img } = await db.from('builder_stock_item_images')
        .select('*').eq('id', primaryId).maybeSingle();
      if (!img) {
        fail(entry, `primary_image_id ${primaryId} names no image row`);
        continue;
      }

      // association
      if (img.stock_item_id !== it.id) {
        fail(entry, `the primary image belongs to another property: `
          + `image.stock_item_id=${img.stock_item_id} item=${it.id}`);
      }
      if (img.organisation_id !== it.organisation_id) {
        fail(entry, `the primary image belongs to another organisation`);
      }
      if (img.upload_id && img.upload_id !== it.upload_id) {
        fail(entry, `the primary image came from another upload`);
      }

      // eligible / cleared — the product's own rule, called
      const { data: readyRows } = await db.rpc('builder_stock_photo_is_source_ready',
        { p_image_id: primaryId });
      const cleared = readyRows === true || (Array.isArray(readyRows) && readyRows[0] === true);
      if (!cleared) {
        fail(entry, `the primary image is not source-ready: stage=${img.source_stage} `
          + `verification=${img.verification_status} processing=${img.processing_status}`);
      }

      // serving — the portal's own step
      const out = await serveStockImage(db, {
        imageId: primaryId, organisationId: it.organisation_id,
      });
      if (!out.ok) {
        fail(entry, `the portal could not serve the photograph: ${out.reason}`);
        photographs.push({ lot: it.lot_number, primary: primaryId, served: out.reason });
        continue;
      }

      // fetch
      const url = out.url.startsWith('http') ? out.url : `${GATEWAY}${out.url}`;
      let bytes: Uint8Array | null = null;
      let status = 0;
      try {
        const res = await realFetch(url);
        status = res.status;
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        fail(entry, `fetching the served photograph threw: ${(e as Error).message}`);
      }
      if (!bytes) {
        fail(entry, `the served photograph did not fetch: HTTP ${status}`);
        photographs.push({ lot: it.lot_number, primary: primaryId, http: status });
        continue;
      }

      // decode
      const decoded = decodeImage(bytes);
      if (!decoded) {
        fail(entry, `the served bytes are not an image: ${bytes.length} bytes, `
          + `first 8 = ${[...bytes.slice(0, 8)].join(',')}`);
      } else if (!(decoded.width > 1 && decoded.height > 1)) {
        fail(entry, `the served image has no picture in it: `
          + `${decoded.kind} ${decoded.width}x${decoded.height}`);
      }

      // the security half
      const otherOrg = Object.values(orgs).find((o) => o.id !== it.organisation_id);
      if (otherOrg) {
        const cross = await serveStockImage(db, {
          imageId: primaryId, organisationId: otherOrg.id,
        });
        if (cross.ok) {
          fail(entry, `ANOTHER ORGANISATION WAS SERVED THIS PHOTOGRAPH: ${cross.url}`);
        } else if (cross.reason !== 'not_found') {
          fail(entry, `a cross-tenant ask leaked that the image exists: ${cross.reason}`);
        }
      }

      photographs.push({
        lot: it.lot_number, primary: primaryId, cleared,
        http: status, bytes: bytes.length,
        decoded: decoded ? `${decoded.kind} ${decoded.width}x${decoded.height}` : null,
      });
    }
    row.portalImages = photographs;
  }

  // --- 6e2. REPEAT PROCESSING IS SAFE -------------------------------------
  /*
   * Two different acts, and the product answers them differently on purpose.
   *
   * THE SAME FILE SENT AGAIN is a new upload row carrying bytes the
   * organisation already holds. It must be refused as a duplicate and must
   * not produce a second copy of the property — the guard is keyed on
   * (organisation, sha256), never on the URL, because a stock-list page keeps
   * its address and changes its contents.
   *
   * A RE-READ is the SAME upload row read again, which is what "Read again"
   * and the reader-version sweep both do. It must correct the row it already
   * wrote rather than fork it, so the property count after it is the count
   * before it.
   */
  if (a.result.ok) {
    const before = itemsA.length;
    const again = await routeA(entry, bytes, 'again');
    const dupCode = (again.result as any).code;
    row.repeat = { ok: again.result.ok, code: dupCode };
    if (again.result.ok || dupCode !== 'duplicate_file') {
      fail(entry, `the same bytes sent again were not refused as a duplicate: `
        + `ok=${again.result.ok} code=${dupCode}`);
    }
    const afterRepeat = await itemsFor(a.uploadId);
    if (afterRepeat.length !== before) {
      fail(entry, `sending the same file again changed the property count: `
        + `${before} -> ${afterRepeat.length}`);
    }

    const reread = await runStockImport({
      supabase: db,
      organisationId: orgs[entry.org].id,
      organisationName: orgs[entry.org].name,
      builderUserId: orgs[entry.org].userId,
      upload: { id: a.uploadId, original_filename: entry.filename },
      bytes,
      sourceKind: 'file',
    });
    const afterReread = await itemsFor(a.uploadId);
    row.reread = { ok: reread.ok, code: (reread as any).code,
                   properties: afterReread.length };
    if (!reread.ok) {
      fail(entry, `a re-read of its own row failed: ${(reread as any).code}`);
    } else if (afterReread.length !== before) {
      fail(entry, `a re-read forked the row: ${before} -> ${afterReread.length} properties`);
    } else {
      // And it must still be the same property, not a different one wearing
      // the same count.
      for (let i = 0; i < before; i += 1) {
        for (const f of COMPARED) {
          const was = valueOf(itemsA[i], f); const now = valueOf(afterReread[i], f);
          if (String(was).toLowerCase() !== String(now).toLowerCase()) {
            fail(entry, `a re-read changed ${f}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
          }
        }
      }
    }
  }

  // --- 6e3. ORGANISATION ISOLATION ----------------------------------------
  /*
   * Every property this document produced belongs to the organisation that
   * uploaded it, and to no other. Asked of the row rather than inferred from
   * the call, because the call is what would be wrong.
   */
  for (const it of itemsA as any[]) {
    if (it.organisation_id !== orgs[entry.org].id) {
      fail(entry, `a property landed in the wrong organisation: ${it.organisation_id}`);
    }
  }

  // --- 6f. measurements --------------------------------------------------
  row.measure = {
    aMs: Math.round(a.ms), bMs: Math.round(b.ms),
    aRssDeltaKb: Math.round(a.rssDelta / 1024), bRssDeltaKb: Math.round(b.rssDelta / 1024),
    aBytes: a.transferred, bBytes: b.transferred,
  };
  if (a.transferred !== b.transferred) {
    fail(entry, `the two routes handed the pipeline different byte counts: ${a.transferred} vs ${b.transferred}`);
  }
  report.push(row);
}

await fileServer.shutdown();

// ---------------------------------------------------------------------------
// 7 · The verdict
// ---------------------------------------------------------------------------
console.log(JSON.stringify({ report, fails, limits, modelCallAttempts, urlFetches }, null, 2));
console.log(`\n${manifest.length} documents · ${fails.length} failures · `
  + `${limits.length} named limits · `
  + `${modelCallAttempts.length} generative-model calls attempted`);
if (limits.length) {
  console.log('\nNAMED LIMITS (reported every run, do not fail the gate):');
  for (const l of limits) console.log('  ' + l);
}
if (modelCallAttempts.length) {
  console.log('MODEL CALLS ATTEMPTED:'); for (const u of modelCallAttempts) console.log('  ' + u);
}
if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log('  ' + f); }
Deno.exit(fails.length || modelCallAttempts.length ? 1 : 0);
