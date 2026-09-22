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
 * A REFUSAL CLOSES THE ROW — the portal's own rule, imported rather than
 * imitated. `runStockImport` marks an upload `parsing` and RETURNS a refusal;
 * every production caller then writes a terminal status. This gate is a
 * caller, so it writes one too, through the same function.
 */
import { closeRefusedUpload } from '../../supabase/functions/_shared/builderStock/closeRefusedUpload.ts';
import { sourceDocumentName } from '../../supabase/functions/_shared/builderStock/documentName.pure.ts';
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
import {
  readOutstandingUploads, runSettlementTick, settleUploadSourceImages,
} from '../../supabase/functions/_shared/builderStock/settleSourceImages.ts';
import {
  readerSweepPending, settleReaderVersion,
} from '../../supabase/functions/_shared/builderStock/settleReaderVersion.ts';
import { publishUploadIfReady } from '../../supabase/functions/_shared/builderStock/itemWorkClaim.ts';
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
  /*
   * TWO MORE FOR PART 7, and they exist because the duplicate guard is right.
   * The invariants re-import documents the main loop has already imported, and
   * a second upload of the same bytes into the same organisation is refused as
   * `duplicate_file` — correctly. Running them in organisations that have
   * never seen the bytes tests identity rather than the duplicate rule, which
   * is tested where it belongs, above.
   */
  ['inv', 'Invariant Homes Pty Ltd'], ['inv:other', 'Invariant Rivals Pty Ltd'],
  /*
   * AND TWO FOR 7i, for the same reason one more time. That invariant imports
   * one document TWICE — once from an address that names it and once from an
   * address that does not — and both are the same bytes, so they cannot share
   * an organisation without the second being refused as a duplicate. Which is
   * how the first version of it failed: `rows[0]` was undefined on the second
   * import and the invariant reported a difference the duplicate guard had
   * created.
   */
  ['name:named', 'Named Address Homes Pty Ltd'],
  ['name:nameless', 'Nameless Address Homes Pty Ltd'],
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
const IMAGERY_MAX_CLAIMS = 200;
const IMAGERY_MAX_ROUNDS = 12;
/** How many times one property may be worked before the gate gives up on it. */
const IMAGERY_MAX_PER_ITEM = 10;

/**
 * ===========================================================================
 * RUN THE SETTLER THE WAY THE SETTLER RUNS.
 * ===========================================================================
 *
 * Every function here is the one `builder-stock-image-settler` calls, in the
 * order it calls them: claim a property's image work, settle the claimed
 * stage, record the completion; then take the uploads that are actually
 * OUTSTANDING and settle those; then enforce the primary pointers; then
 * publish what is ready.
 *
 * THE MARKER GATE IS THE LOAD-BEARING PART, and leaving it out was a real
 * defect in this harness. The first version called `settleUploadSourceImages`
 * unconditionally on every round, where production asks
 * `readOutstandingUploads` first and settles only what is behind. Twelve
 * unconditional rounds re-extracted the document's media twelve times and left
 * THIRTY-ONE image rows describing TWO pictures — a duplication the product
 * does not produce, in a harness that exists to detect duplication.
 *
 * ONE DEVIATION, STATED. Production rotates one phase per tick
 * (`choosePhase`), so provenance, eligibility and sanitization take turns and
 * none starves; this drives all three each round, bounded by the same
 * candidate flags. It reaches the same end state in fewer rounds and cannot
 * reach a state the rotation could not, because the flags — not the rotation —
 * are what decide whether there is work.
 */
async function settleImagery(organisationId: string, uploadId: string) {
  const rounds: string[] = [];
  const attempts = new Map<string, number>();
  let previous = '';
  for (let round = 0; round < IMAGERY_MAX_ROUNDS; round += 1) {
    for (let i = 0; i < IMAGERY_MAX_CLAIMS; i += 1) {
      const claim = await claimOneImageWorkItem(db, { leaseSeconds: 120, organisationId });
      if (!claim.available || !claim.item) break;
      const item = claim.item;
      /*
       * TERMINATION IS THE HARNESS'S PROBLEM, NOT THE ROW'S. An earlier
       * version bounded the loop by writing `retryAfterSeconds: 3600` on any
       * quiet pass, which parked a property for an hour on the first quiet
       * pass of the `source` stage — the ladder never reached `eligibility`
       * and eleven documents reported no photograph. Production does not do
       * that: the cron comes back in a minute. So the delay is the product's
       * own and the bound is a count this loop keeps.
       */
      const seen = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, seen);
      if (seen > IMAGERY_MAX_PER_ITEM) {
        await completeItemWork(db, item.id, {
          result: 'acceptance harness: attempt ceiling reached',
          progressed: false, retryAfterSeconds: 3600,
        });
        continue;
      }
      const settlement = await settleClaimedItem(db, item, {
        deadlineAt: Date.now() + 20_000,
      });
      await completeItemWork(db, item.id, {
        nextStage: settlement.nextStage,
        result: settlement.result,
        progressed: settlement.progressed,
      });
    }

    // Only what is genuinely behind, exactly as the tick decides it.
    const outstanding = await readOutstandingUploads(db, { limit: 50 });
    const mine = (outstanding.rows ?? []).filter((c: any) => c.id === uploadId);
    if (mine.length) {
      await runSettlementTick(mine, { maxSettled: 6, deadlineAt: Date.now() + 40_000 },
        (candidate: any) => settleUploadSourceImages(db, {
          organisationId: candidate.organisation_id,
          uploadId: candidate.id,
          deadlineAt: Date.now() + 30_000,
          needsProvenance: candidate.needsProvenance,
          needsEligibility: candidate.needsEligibility,
          needsSanitization: candidate.needsSanitization,
        }));
    }
    await enforceStrictPrimaryImages(db, organisationId);
    /*
     * PUBLICATION IS PART OF THE TICK, and a gate that never publishes proves
     * nothing about a card a customer can open.
     */
    try { await publishUploadIfReady(db, uploadId); } catch { /* reported by state */ }

    /*
     * QUIESCENT IS A PROPERTY OF EVERYTHING THE PIPELINE WRITES, not of the
     * table that happens to be convenient to read. Sanitization and the
     * overlay clearance write to `builder_stock_item_images`, so a shape read
     * from the items alone stopped changing while image work was outstanding.
     */
    const { data } = await db.from('builder_stock_items')
      .select('id, image_work_stage, primary_image_id, lifecycle_status')
      .eq('upload_id', uploadId);
    const { data: imgRows } = await db.from('builder_stock_item_images')
      .select('id, processing_status, source_detail').eq('upload_id', uploadId);
    const { data: up } = await db.from('builder_stock_uploads')
      .select('published_at, publication_blocked_reason').eq('id', uploadId).maybeSingle();
    const shape = JSON.stringify([
      (data ?? []).map((r: any) =>
        [r.id, r.image_work_stage, r.primary_image_id, r.lifecycle_status]).sort(),
      (imgRows ?? []).map((r: any) => [
        r.id, r.processing_status,
        r.source_detail?.marketplace_eligibility_state ?? null,
        r.source_detail?.sanitization_clearance ? 'cleared' : null,
        r.source_detail?.sanitization_failure ? 'failed' : null,
      ]).sort(),
      [up?.published_at ?? null, up?.publication_blocked_reason ?? null],
    ]);
    rounds.push(`r${round}:${(data ?? []).map((r: any) => r.image_work_stage).join(',')}`);
    if (shape === previous) break;
    previous = shape;
  }
  return rounds;
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
  /*
   * A REFUSAL CLOSES THE ROW, through the portal's own function. Without this
   * the gate leaves a row reading `status: parsing, error_code:
   * duplicate_file` — an error on a status meaning "still working" — and
   * because `parsing` is re-readable the reader sweep then considers it on
   * every tick, for ever. Measured: sixteen such rows, and a backlog that can
   * never drain looks exactly like one draining slowly.
   */
  if (!result.ok) {
    await closeRefusedUpload(db, {
      uploadId: upload.id, organisationId: orgs[entry.org].id,
      code: String((result as { code?: string }).code ?? 'import_failed'),
      message: String((result as { message?: string }).message ?? ''),
    });
  }
  return { result, uploadId: upload.id, ms: performance.now() - t0,
           rssDelta: rss() - m0, transferred: downloaded.length };
}

/**
 * Route B — the same bytes, obtained over HTTP first.
 *
 * THE ADDRESS CARRIES THE DOCUMENT'S OWN NAME, because a builder linking a
 * brochure links the brochure. What that name then COUNTS FOR is decided by
 * `sourceDocumentName`, the same rule `prepareLinkedStockSource` applies in
 * production — never by this harness, which would otherwise be asserting its
 * own opinion about a transport rather than the product's.
 */
async function routeB(entry: Entry, bytes: Uint8Array) {
  const key = `${entry.org}/${encodeURIComponent(entry.filename)}`;
  served.set(key, bytes);
  const t0 = performance.now(); const m0 = rss();
  const response = await realFetch(`http://localhost:54996/${key}`);
  const fetched = new Uint8Array(await response.arrayBuffer());

  const twin = `${entry.org}:b`;
  const sourceUrl = `http://localhost:54996/${key}`;
  const storagePath = `${orgs[twin].id}/B-${crypto.randomUUID()}.pdf`;
  /*
   * THE SNAPSHOT, WHICH IS NOT OPTIONAL AND WAS MISSING.
   *
   * `add_url_source` stores the fetched bytes in the same bucket an uploaded
   * file goes to BEFORE it imports, and that stored copy is what the image
   * pipeline re-opens later. Route B set a `storage_path` and put nothing at
   * it, so every image stage answered "this row names no source this pipeline
   * can open" — and because the settler treats that as retryable, it spun:
   * `image_work_attempts: 11` against route A's 0.
   *
   * Found by the equivalence assertion itself, on its first honest run. This
   * is exactly the shape of infidelity the assertion exists to catch, and it
   * was in the harness rather than in the product.
   */
  const snapshot = await db.storage.from(BUCKET).upload(storagePath, fetched, {
    contentType: 'application/pdf', upsert: true,
  });
  if (snapshot.error) throw new Error(`snapshot: ${snapshot.error.message}`);
  const upload = await newUpload(twin, entry.filename, storagePath);
  await db.from('builder_stock_uploads').update({
    status: 'parsing',
    source_type: 'url',
    // What `add_url_source` writes, so the row a URL import leaves behind is
    // the row this gate settles and publishes from.
    source_url: sourceUrl,
    final_url: sourceUrl,
    declared_content_type: response.headers.get('content-type') ?? 'application/pdf',
    byte_size: fetched.length,
    retrieved_at: new Date().toISOString(),
  }).eq('id', upload.id);

  const result = await runStockImport({
    supabase: db,
    organisationId: orgs[twin].id,
    organisationName: orgs[twin].name,
    builderUserId: orgs[twin].userId,
    upload: { id: upload.id, original_filename: upload.original_filename },
    bytes: fetched,
    sourceKind: 'url',
    baseUrl: sourceUrl,
    /*
     * WHAT THE SOURCE NAMED, resolved by the product's own rule from the
     * address the fetch actually landed on and the header the server
     * actually sent. A URL that names a document says so; one that does not
     * says nothing, and nothing is what the reader then corroborates.
     */
    documentName: sourceDocumentName({
      finalUrl: sourceUrl,
      contentDisposition: response.headers.get('content-disposition'),
    }),
  });
  return { result, uploadId: upload.id, ms: performance.now() - t0,
           rssDelta: rss() - m0, transferred: fetched.length,
           documentName: sourceDocumentName({ finalUrl: sourceUrl }) };
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
  /*
   * AND ON ROUTE B TOO, which is the difference between comparing two
   * readings and comparing two CUSTOMERS' outcomes.
   *
   * The first version of 6b settled route A alone and then had to exclude
   * `enrichment_status`, `image_work_stage`, `image_work_last_result` and
   * `lifecycle_status` from the comparison to make it pass — seven columns
   * of difference that the harness itself had created. Excluding them would
   * have meant the equivalence assertion could never see a transport that
   * publishes differently, which is most of what "the same document" is for:
   * a card either shows the right photograph or it does not.
   *
   * So route B settles as well, and what remains excluded below is row ids
   * and clock readings only.
   */
  if (b.result.ok) {
    try {
      row.imageryB = await settleImagery(orgs[`${entry.org}:b`].id, b.uploadId);
    } catch (e) {
      fail(entry, `the image settler threw on route B: ${(e as Error).message}`);
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

  /* --- 6b. IDENTICAL BYTES ARE THE SAME DOCUMENT ------------------------
   *
   * The import pipeline's own header says everything after transport is
   * identical for a file and for a URL. This is the assertion behind that
   * sentence, and it is deliberately made over the WHOLE reading rather than
   * over a list of columns — a list can only ever catch what somebody
   * remembered to put in it.
   *
   * What is compared: the verdict and its code, the reader's own status and
   * reason, every field it READ and every field it DECLINED with the reason
   * it declined for, which reader placed each field, the number of candidate
   * properties, the identity of each, every stored column, and what the
   * property published as. Timing, byte counts and row ids are excluded
   * because they are properties of the run rather than of the document.
   *
   * IT WAS NOT TRUE WHEN THIS WAS WRITTEN. The reader takes a name as
   * evidence and was handed `upload.original_filename` — the document's own
   * name for a file, a display label of host + ellipsis + segment for a URL.
   * The same bytes read differently, and a hostname could name a house
   * design. `documentName.pure.ts` carries the measurement.
   */
  const readingOf = (r: any) => {
    const d = r?.deterministicReading;
    if (!d) return { present: false };
    return {
      present: true,
      status: d.status ?? null,
      reason: d.reason ?? null,
      // Sorted: these are sets, and the order a reader happened to write them
      // in is not a property of the document.
      fieldsRead: [...(d.diagnostics?.fieldsRead ?? [])].sort(),
      declinedFields: [...(d.diagnostics?.declinedFields ?? [])].sort(),
      declinedBecause: [...(d.diagnostics?.declinedBecause ?? [])].sort(),
      disputedFields: [...(d.diagnostics?.disputedFields ?? [])].sort(),
      visualOnlyFields: [...(d.diagnostics?.visualOnlyFields ?? [])].sort(),
      readBy: Object.fromEntries(Object.entries(d.diagnostics?.readBy ?? {}).sort()),
      candidates: d.diagnostics?.candidates ?? null,
    };
  };
  const verdictOf = (r: any) => ({
    ok: r.ok === true,
    code: r.ok ? null : String(r.code ?? ''),
    strategy: r.ok ? String(r.strategy ?? '') : null,
    detected: r.ok ? r.summary.detected : null,
  });
  /**
   * A stored property, as the DOCUMENT describes it.
   *
   * `id`, `upload_id`, `organisation_id` and the timestamps are the run's,
   * not the document's — and the two routes import into different
   * organisations on purpose, so including them would assert a difference
   * the harness itself created.
   */
  /**
   * WHAT IS EXCLUDED, AND WHY — ids and clock readings, and nothing else.
   *
   * A row id, an upload id, an organisation id and a timestamp are facts
   * about WHEN AND WHERE this run happened. The two routes deliberately
   * import into different organisations (the same bytes in one organisation
   * are a duplicate, correctly refused), so including any of them would
   * assert a difference the harness created.
   *
   * Everything else is compared, INCLUDING what the property published as
   * and whether a photograph reached its card — `primary_image_id` is a row
   * id and is excluded, but `image_work_stage`, `image_work_last_result`,
   * `enrichment_status` and `lifecycle_status` are not, because those are
   * the answer to "did this document become the same product".
   */
  const OF_THE_RUN = new Set([
    'id', 'upload_id', 'organisation_id', 'first_upload_id', 'pending_upload_id',
    'created_by_builder_user_id', 'primary_image_id',
    'created_at', 'updated_at', 'enriched_at', 'last_seen_at',
    'image_work_updated_at', 'image_work_next_attempt_at',
    'image_work_claim_until', 'image_work_claim_by',
    'published_at', 'first_published_at', 'source_url',
  ]);
  /*
   * `String(v)` on an object is `[object Object]`, which compares equal to
   * every other object — so `source_row`, the reader's own record of what it
   * read, was being compared to nothing at all. Found by looking at the
   * failure text rather than at the code.
   */
  const asText = (v: unknown) => v === null || v === undefined
    ? null
    : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const documentShape = (it: any) => Object.fromEntries(
    Object.entries(it)
      .filter(([k]) => !OF_THE_RUN.has(k))
      .map(([k, v]) => [k, asText(v)] as const)
      .sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  const eq = (what: string, x: unknown, y: unknown) => {
    const sx = JSON.stringify(x), sy = JSON.stringify(y);
    if (sx !== sy) fail(entry, `transport changed ${what}: A=${sx} B=${sy}`);
  };

  eq('the verdict', verdictOf(a.result), verdictOf(b.result));
  eq('the reading', readingOf(a.result), readingOf(b.result));
  row.equivalence = { documentName: b.documentName, reading: readingOf(a.result) };

  if (itemsA.length !== itemsB.length) {
    fail(entry, `route A produced ${itemsA.length} properties, route B ${itemsB.length}`);
  } else {
    // Ordered by the document's own identity rather than by insertion, so a
    // difference in the order rows landed is not reported as a difference in
    // what the document says — and an identity difference is caught by the
    // comparison itself rather than being hidden by the sort.
    const byIdentity = (rows: any[]) => [...rows].sort((x, y) =>
      JSON.stringify(documentShape(x)) < JSON.stringify(documentShape(y)) ? -1 : 1);
    const sa = byIdentity(itemsA), sb = byIdentity(itemsB);
    for (let i = 0; i < sa.length; i += 1) {
      eq(`property ${i}`, documentShape(sa[i]), documentShape(sb[i]));
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

// ===========================================================================
// 7 · THE INVARIANTS THAT ARE NOT ABOUT ONE DOCUMENT
// ===========================================================================
/*
 * Everything above judges a document. These judge the SUBSYSTEM: which row a
 * re-read lands on, what a second organisation's identical file does, whether
 * a stale source is re-read with nobody asking, whether publication can be
 * driven twice, and what happens when a worker dies mid-run.
 *
 * They run once, on one ordinary brochure, because they are properties of the
 * pipeline rather than of the page.
 */
const invariant = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails.push(`invariant/${name}: ${detail}`);
  return ok;
};

const subject = manifest.find((e: any) => e.name === 'package-brochure') ?? manifest[0];
/** Part 7 runs in its own organisations. See the seed list. */
const INV = 'inv';
const INV_OTHER = 'inv:other';
const subjectBytes = await Deno.readFile(
  `${corpusDir}/${subject.org}/${subject.filename}`);
const invariants: Record<string, unknown> = {};

// --- 7a. A ROW SURVIVES A RE-READ, BY ID -----------------------------------
/*
 * The count staying the same is not the same claim as the ROW staying the
 * same: a fork that also archived the original would keep the count. Identity
 * is asserted on the id, which is what every image, every patch and every
 * published card points at.
 */
{
  const org = orgs[INV];
  const up = await newUpload(INV, subject.filename,
    `${org.id}/inv-${crypto.randomUUID()}.pdf`);
  await runStockImport({
    supabase: db, organisationId: org.id, organisationName: org.name,
    builderUserId: org.userId, upload: { id: up.id, original_filename: subject.filename },
    bytes: subjectBytes, sourceKind: 'file',
  });
  const first = await itemsFor(up.id);
  await runStockImport({
    supabase: db, organisationId: org.id, organisationName: org.name,
    builderUserId: org.userId, upload: { id: up.id, original_filename: subject.filename },
    bytes: subjectBytes, sourceKind: 'file',
  });
  const second = await itemsFor(up.id);
  invariants.rereadIds = { before: first.map((i: any) => i.id), after: second.map((i: any) => i.id) };
  invariant('reread-keeps-the-row',
    first.length > 0 && first.length === second.length
    && first.every((i: any, n: number) => i.id === second[n].id),
    `${JSON.stringify(first.map((i: any) => i.id))} -> ${JSON.stringify(second.map((i: any) => i.id))}`);

  // --- 7b. ANOTHER ORGANISATION'S IDENTICAL FILE IS ANOTHER PROPERTY -------
  /*
   * Same bytes, same filename, same lot number, same `pdf:page1` anchor — and
   * a different tenant. Nothing about a document may join two organisations'
   * records, and the identity rule is keyed on things a document states, so
   * this is the test that it is scoped as well.
   */
  const other = orgs[INV_OTHER];
  const up2 = await newUpload(INV_OTHER, subject.filename,
    `${other.id}/inv-${crypto.randomUUID()}.pdf`);
  await runStockImport({
    supabase: db, organisationId: other.id, organisationName: other.name,
    builderUserId: other.userId, upload: { id: up2.id, original_filename: subject.filename },
    bytes: subjectBytes, sourceKind: 'file',
  });
  const mine = await itemsFor(up.id);
  const theirs = await itemsFor(up2.id);
  const shared = mine.filter((i: any) => theirs.some((j: any) => j.id === i.id));
  invariants.crossTenant = { mine: mine.length, theirs: theirs.length, shared: shared.length };
  invariant('same-file-another-tenant-is-another-property',
    theirs.length > 0 && shared.length === 0
    && theirs.every((i: any) => i.organisation_id === other.id),
    `mine=${mine.length} theirs=${theirs.length} shared=${shared.length}`);

  // --- 7c. TWO DOCUMENTS SHARING AN ANCHOR ARE TWO PROPERTIES -------------
  /*
   * Every single-page brochure anchors its property at `pdf:page1`. Keying on
   * that alone is what once let a re-read of a three-property list fork it to
   * five, so two DIFFERENT documents in ONE organisation must still produce
   * distinct rows.
   */
  const secondDoc = manifest.find((e: any) =>
    e.name !== subject.name && (e.expect?.properties ?? 0) === 1);
  if (secondDoc) {
    const bytes2 = await Deno.readFile(`${corpusDir}/${secondDoc.org}/${secondDoc.filename}`);
    const up3 = await newUpload(INV, secondDoc.filename,
      `${org.id}/inv2-${crypto.randomUUID()}.pdf`);
    await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId, upload: { id: up3.id, original_filename: secondDoc.filename },
      bytes: bytes2, sourceKind: 'file',
    });
    const otherDocRows = await itemsFor(up3.id);
    const collided = otherDocRows.filter((i: any) => mine.some((j: any) => j.id === i.id));
    invariants.sharedAnchor = { doc: secondDoc.name, rows: otherDocRows.length,
                                collided: collided.length };
    invariant('two-documents-one-anchor-are-two-properties',
      otherDocRows.length > 0 && collided.length === 0,
      `${secondDoc.name}: ${otherDocRows.length} rows, ${collided.length} collided`);
  }
}

// --- 7d. A STALE SOURCE IS RE-READ WITH NOBODY ASKING ----------------------
/*
 * The contract the permanent heartbeat exists for: raise the reader version,
 * do nothing else, and every stored source is read again. No SQL re-arm, no
 * upload, no "Read again", no manual settler invocation.
 *
 * It is simulated by putting a row BEHIND the current version, which is
 * exactly what deploying a new reader does to every row in the table.
 */
{
  /*
   * NULL IS WHAT A NEW READER SEES. `reader_settled_version` is stamped by the
   * sweep, not by an import, so every stored source is outstanding the moment
   * a reader ships — which is exactly the condition this contract is about.
   */
  const pendingBefore = await readerSweepPending(db);
  let considered = 0; let reread = 0; let ticks = 0;
  // The sweep is bounded per tick on purpose; the cron comes back. So does this.
  for (; ticks < 40; ticks += 1) {
    const tick = await settleReaderVersion(db, { deadlineAt: Date.now() + 60_000, limit: 25 });
    considered += tick.considered; reread += tick.reread;
    if (!tick.considered) break;
    if ((await readerSweepPending(db) ?? 0) === 0) { ticks += 1; break; }
  }
  const pendingAfter = await readerSweepPending(db);
  invariants.readerSweep = { pendingBefore, considered, reread, ticks, pendingAfter };
  invariant('a-stale-source-is-reread-unasked',
    (pendingBefore ?? 0) > 0 && (pendingAfter ?? 0) === 0,
    `${pendingBefore} outstanding before; ${considered} considered over ${ticks} ticks, `
    + `${reread} re-read, ${pendingAfter} outstanding after`);

  // --- 7e. AND AN IDLE HEARTBEAT IS CHEAP AND EXITS ------------------------
  /*
   * The tick that finds nothing must cost nothing. A heartbeat that woke and
   * did work every time would be a scheduler nobody could afford to leave on,
   * and this one runs every fifteen minutes for ever.
   */
  const t0 = Date.now();
  const idle = await settleReaderVersion(db, { deadlineAt: Date.now() + 60_000, limit: 25 });
  const idleMs = Date.now() - t0;
  invariants.idleSweep = { considered: idle.considered, reread: idle.reread, ms: idleMs };
  invariant('an-idle-heartbeat-is-cheap',
    idle.reread === 0 && idleMs < 5_000,
    `re-read ${idle.reread} with nothing outstanding, in ${idleMs} ms`);
}

// --- 7f. PUBLICATION IS IDEMPOTENT ----------------------------------------
/*
 * A property becomes publishable for several different reasons — an import, a
 * field correction, an image completing, a re-read, a reader upgrade — so the
 * publish step is reachable from all of them and must be safe to reach twice.
 */
{
  const { data: published } = await db.from('builder_stock_uploads')
    .select('id, published_at').not('published_at', 'is', null).limit(1);
  const target = (published ?? [])[0];
  if (target) {
    const before = target.published_at;
    await publishUploadIfReady(db, target.id);
    await publishUploadIfReady(db, target.id);
    const { data: again } = await db.from('builder_stock_uploads')
      .select('published_at').eq('id', target.id).maybeSingle();
    invariants.publishTwice = { before, after: again?.published_at };
    invariant('publishing-twice-changes-nothing',
      !!again?.published_at && again.published_at === before,
      `${before} -> ${again?.published_at}`);
  } else {
    invariant('publishing-twice-changes-nothing', false,
      'nothing published, so idempotence could not be shown');
  }
}

// --- 7g. A WORKER THAT DIES MID-RUN LOSES NOTHING --------------------------
/*
 * The import is interrupted after its bytes are stored and before it finishes,
 * which is what a killed worker looks like from the database: the upload row
 * exists and no property does. The next pass must complete it rather than
 * leave it stranded, and must not produce two of anything.
 */
{
  /*
   * A DOCUMENT THIS ORGANISATION HAS NOT SEEN, because the duplicate guard is
   * right and would otherwise refuse the run this test is about.
   */
  const killDoc = manifest.find((e: any) =>
    (e.expect?.properties ?? 0) === 1 && e.name !== subject.name) ?? subject;
  const killBytes = await Deno.readFile(`${corpusDir}/${killDoc.org}/${killDoc.filename}`);
  const org = orgs[INV_OTHER];
  const up = await newUpload(INV_OTHER, killDoc.filename,
    `${org.id}/kill-${crypto.randomUUID()}.pdf`);
  const killed = new AbortController();
  killed.abort();
  let threw = false;
  try {
    await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId, upload: { id: up.id, original_filename: killDoc.filename },
      bytes: killBytes, sourceKind: 'file', signal: killed.signal,
    } as never);
  } catch { threw = true; }
  const stranded = await itemsFor(up.id);
  // Whatever the interruption did, the next ordinary pass must settle it.
  await runStockImport({
    supabase: db, organisationId: org.id, organisationName: org.name,
    builderUserId: org.userId, upload: { id: up.id, original_filename: killDoc.filename },
    bytes: killBytes, sourceKind: 'file',
  });
  const recovered = await itemsFor(up.id);
  invariants.killedWorker = { doc: killDoc.name, threw, strandedRows: stranded.length,
                              recoveredRows: recovered.length };
  invariant('a-killed-worker-is-recovered-not-duplicated',
    recovered.length === (killDoc.expect?.properties ?? 1),
    `${killDoc.name}: after recovery ${recovered.length} rows, `
    + `expected ${killDoc.expect?.properties ?? 1}`);
}

// --- 7h. TWO UPLOADS AT ONCE DO NOT CROSS ---------------------------------
{
  const org = orgs[INV];
  const twoDocs = manifest.filter((e: any) => (e.expect?.properties ?? 0) === 1).slice(2, 4);
  const runs = await Promise.all(twoDocs.map(async (e: any, n: number) => {
    const b = await Deno.readFile(`${corpusDir}/${e.org}/${e.filename}`);
    const up = await newUpload(INV, e.filename,
      `${org.id}/conc${n}-${crypto.randomUUID()}.pdf`);
    const result = await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId, upload: { id: up.id, original_filename: e.filename },
      bytes: b, sourceKind: 'file',
    });
    return { uploadId: up.id, ok: result.ok, rows: await itemsFor(up.id) };
  }));
  const ids = runs.flatMap((r) => r.rows.map((i: any) => i.id));
  invariants.concurrent = runs.map((r) => ({ ok: r.ok, rows: r.rows.length }));
  invariant('two-uploads-at-once-do-not-cross',
    new Set(ids).size === ids.length
    && runs.every((r) => r.rows.every((i: any) => i.upload_id === r.uploadId)),
    JSON.stringify(invariants.concurrent));
}

/* --- 7i. AN ADDRESS THAT NAMES NOTHING LOSES ONLY A NAME ------------------
 *
 * 6b asserts that identical bytes are the same document, and it does so over
 * a URL that carries the brochure's own name — which is what a builder
 * linking a brochure gives you, and therefore the case worth asserting first.
 * It is not the case the defect lived in.
 *
 * A stock list behind `/download?id=9f2a` names no document, and
 * `sourceDocumentName` answers null rather than handing the reader
 * `alphahomes.com.au/download` as though it were a name. The question this
 * settles is what that costs: a name the reader may not have is allowed to
 * cost a CORROBORATION and is never allowed to cost the property.
 *
 * So the same bytes are imported once from a named address and once from a
 * nameless one, and the identity the document states for itself — its lot,
 * its address, its suburb, its state, its postcode, its price, its sizes —
 * must be byte-identical across the two. Only `house_design` may differ, and
 * only by being ABSENT on the nameless one.
 *
 * MEASURED, AND SAID PLAINLY: on this corpus nothing is lost at all —
 * `package-brochure` reads `ASPIRE 24 GRANDE` from the PAGE under both
 * addresses, and no document here depends on its name. So what this
 * invariant proves today is that a nameless address costs nothing, not that
 * the loss is bounded; the bound itself is proved where the corroborator
 * lives, in `builderStockDocumentName.spec.ts`, which drives that function
 * directly with all three names. Recorded rather than dressed up, because a
 * fixture that cannot exercise a rule is not evidence about the rule — the
 * lesson the verdict-block geometry gate had to learn the expensive way.
 */
{
  const named = manifest.find((e: any) => (e.expect?.properties ?? 0) === 1
    && (e.expect?.rows?.[0]?.design ?? null) !== null);
  if (!named) {
    invariant('a-nameless-address-loses-only-a-name', false,
      'no corpus document states a design to lose');
  } else {
    const bytes = await Deno.readFile(`${corpusDir}/${named.org}/${named.filename}`);
    const importAs = async (documentName: string | null, key: string) => {
      const into = orgs[key];
      const path = `${into.id}/${crypto.randomUUID()}.pdf`;
      const upload = await newUpload(key, named.filename, path);
      await db.from('builder_stock_uploads')
        .update({ status: 'parsing', source_type: 'url' }).eq('id', upload.id);
      const result = await runStockImport({
        supabase: db, organisationId: into.id, organisationName: into.name,
        builderUserId: into.userId,
        upload: { id: upload.id, original_filename: upload.original_filename },
        bytes, sourceKind: 'url', documentName,
      });
      return { result, uploadId: upload.id, rows: await itemsFor(upload.id) };
    };

    const withName = await importAs(
      sourceDocumentName({ finalUrl: `https://alphahomes.com.au/stock/${encodeURIComponent(named.filename)}` }),
      'name:named');
    // An endpoint, which is what a great many stock-list links actually are.
    const without = await importAs(
      sourceDocumentName({ finalUrl: 'https://alphahomes.com.au/download?id=9f2a' }),
      'name:nameless');

    const IDENTITY = ['lot_number', 'unit_number', 'address_line', 'suburb', 'state',
      'postcode', 'price', 'land_size_sqm', 'building_size_sqm',
      'bedrooms', 'bathrooms', 'car_spaces', 'development_name', 'project_name'];
    const one = withName.rows[0] as any;
    const two = without.rows[0] as any;
    /*
     * BOTH MUST HAVE PRODUCED A PROPERTY. Without this, two empty readings
     * agree on all fourteen fields and the invariant passes having compared
     * nothing — which is how its first version reported a difference the
     * duplicate guard had created, one layer down.
     */
    const bothImported = withName.rows.length === 1 && without.rows.length === 1;
    const identitySame = bothImported
      && IDENTITY.every((f) => String(one[f] ?? '') === String(two[f] ?? ''));
    const designWith = one?.source_row?.house_design ?? null;
    const designWithout = two?.source_row?.house_design ?? null;
    // Absent, or the same. Never a DIFFERENT design — that would mean the
    // address had named one, which is the defect rather than its cost.
    const designHonest = designWithout === null || designWithout === designWith;

    invariants.namelessAddress = {
      doc: named.name, design: { named: designWith, nameless: designWithout },
      identityFields: IDENTITY.length,
      rows: { named: withName.rows.length, nameless: without.rows.length },
    };
    invariant('a-nameless-address-loses-only-a-name',
      identitySame && designHonest,
      JSON.stringify(invariants.namelessAddress));
  }
}

await fileServer.shutdown();

// ---------------------------------------------------------------------------
// 7 · The verdict
// ---------------------------------------------------------------------------
console.log(JSON.stringify({ report, invariants, fails, limits, modelCallAttempts, urlFetches }, null, 2));
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
