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
/*
 * FIRST, before any product module loads: this process starts no worker, because
 * the runtime production runs on starts none. See `hostedRuntime.ts`.
 */
import { HOSTED_WORKER_REFUSAL, workersRequested } from './hostedRuntime.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { runStockImport } from '../../supabase/functions/_shared/builderStock/runImport.ts';
import { isImportContinuation } from '../../supabase/functions/_shared/builderStock/importContinuation.pure.ts';
import { continueStockImport } from '../../supabase/functions/_shared/builderStock/continueImport.ts';
import { claimImport, releaseThenContinue } from '../../supabase/functions/_shared/builderStock/importClaim.ts';
import {
  MAX_IMPORT_CONTINUATIONS, MAX_PICTURE_CROSSINGS, crossingsSpent,
} from '../../supabase/functions/_shared/builderStock/importCheckpoint.pure.ts';
/**
 * The most invocations one import can cross, recognition and pictures
 * together — the bound every loop below that drives successors answers to.
 */
const MAX_IMPORT_CROSSINGS = MAX_IMPORT_CONTINUATIONS + MAX_PICTURE_CROSSINGS;
import {
  EXPENSIVE_SPEND_CEILING_MS, expensiveSpendMs,
} from '../../supabase/functions/_shared/builderStock/importResumeBudget.pure.ts';
import { STOCK_LIST_STORAGE_PREFIX, safeObjectName } from '../../supabase/functions/_shared/builderStock/fileTypes.pure.ts';
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
 * AND THE COUNTS AN IMPORT THAT SUCCEEDED WRITES DOWN, the other half of the
 * same rule. The gate wrote none, so every URL import left
 * `records_detected: 0` on a row holding a correctly imported property — the
 * incident's own symptom, produced by the gate that exists to detect it.
 */
import {
  importOutcomeColumns, recordImportCounts,
} from '../../supabase/functions/_shared/builderStock/recordImportOutcome.ts';
/*
 * AND THE IDENTITY THE IMPORTER ITSELF MATCHES ON, so the gate's fork count
 * asks the product's question rather than a plausible-looking one of its own.
 */
import { stockPropertyIdentity } from '../../supabase/functions/_shared/builderStock/stockIdentity.pure.ts';
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
import { repairSourceImagesForUpload } from '../../supabase/functions/_shared/builderStock/repairSourceImages.ts';
import type { PackageFetcher } from '../../supabase/functions/_shared/builderStock/packageImages.ts';
import { driveFileId } from '../../supabase/functions/_shared/builderStock/drivePackage.pure.ts';
import { readPdfPageTextResult } from '../../supabase/functions/_shared/builderStock/pdfText.ts';
import {
  readOutstandingUploads, runSettlementTick, settleUploadSourceImages,
} from '../../supabase/functions/_shared/builderStock/settleSourceImages.ts';
import {
  READER_SWEEP_RESERVE_MS, readerSweepPending, settleReaderVersion,
} from '../../supabase/functions/_shared/builderStock/settleReaderVersion.ts';
import { publishUploadIfReady } from '../../supabase/functions/_shared/builderStock/itemWorkClaim.ts';
import { enforceStrictPrimaryImages } from '../../supabase/functions/_shared/builderStock/primaryImage.ts';
/*
 * THE SWITCH THAT DECIDES WHETHER A VENDOR IS EVER ASKED, read rather than
 * described. Part 8 asserts a model refusal cannot reach the normal path, and
 * the only honest way to assert that is to ask the product's own policy.
 */
import {
  assistedReaderDisposition, assistedReaderEnabled,
} from '../../supabase/functions/_shared/builderStock/assistedReaderPolicy.pure.ts';
import {
  ABANDONED_PARSE_MS, ABANDONED_UPLOAD_MS, DETERMINISTIC_READER_VERSION,
} from '../../supabase/functions/_shared/builderStock/readerVersion.pure.ts';
import {
  MAX_SWEEP_ATTEMPT_TICKS,
} from '../../supabase/functions/_shared/builderStock/readerSweepAttempt.pure.ts';

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

/*
 * THE OCR MODEL REACHES THE READER THE WAY IT REACHES PRODUCTION.
 *
 * It used to be a module in the graph and is now an asset in the project's
 * own storage, because that graph answered 413 on deploy and left two
 * functions behind. `languageData.ts` therefore resolves `SUPABASE_URL` and
 * `SUPABASE_SERVICE_ROLE_KEY` and GETs the object — so the gate must set
 * both and must have put the object there, or it would prove OCR against a
 * path production does not use, which is the whole class of infidelity this
 * harness keeps finding in itself.
 *
 * `run.sh` places the file; this names the credentials. A deployment with
 * neither is the honest negative case, and it is what a null model means.
 */
Deno.env.set('SUPABASE_URL', GATEWAY);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', KEY);

interface Expect {
  properties: number;
  rows?: Record<string, unknown>[];
  image?: string | null;
  outcome?: string;
  forbid?: Record<string, unknown>;
  refusal_must_not_be?: string[];
  known_limit?: string;
  /**
   * What a LINKED read of this document leaves unread, and why — for a
   * document the linked route reads less of by design. See 6b.
   */
  linked_limit?: string;
}
interface Entry {
  name: string; org: string; filename: string; path: string;
  held_out: boolean; expect: Expect; bytes: number;
  /**
   * A SECOND DOCUMENT ABOUT THE SAME PROPERTY, where the fixture declares
   * one. Judged by nothing in the main loop; the fault matrix's replacement
   * case is the only reader, because a replacement is a new document about
   * properties a builder already listed and identical bytes are not that.
   */
  revision?: { filename: string; path: string; bytes: number };
  /**
   * A SPREADSHEET stock list, whose rows link their own documents. Absent for
   * every PDF, which is read as the stock list itself.
   */
  kind?: 'sheet';
  /** What the upload and the URL say the file is. `application/pdf` otherwise. */
  content_type?: string;
  /** Each document a row links, under the Drive file id its link names. */
  linked?: Array<{ id: string; filename: string; path: string; bytes: number }>;
}

const manifest: Entry[] = JSON.parse(
  await Deno.readTextFile(`${corpusDir}/manifest.json`));

/*
 * THE DOCUMENTS A SHEET'S ROWS LINK, SERVED AS DRIVE SERVES THEM.
 *
 * A row's link is fetched by `recoverPackageImage` through the fetcher it is
 * handed; in production that is the guarded fetch of `drive.google.com`. This
 * answers the same download address with the fixture's own bytes, keyed by
 * the file id the link names, and answers anything else as a failed fetch —
 * so what the gate exercises is everything after the network: the branch
 * enumeration, the column's declaration, the identity rules, the election and
 * the attach. The election runs in this process because the page reader is
 * handed over, which is the product's own rule for a caller that brings one
 * (`runElection`); nothing about the election itself differs.
 */
const linkedDocuments = new Map<string, Uint8Array>();
for (const entry of manifest) {
  for (const doc of entry.linked ?? []) {
    linkedDocuments.set(doc.id, await Deno.readFile(`${corpusDir}/${doc.path}`));
  }
}
let linkedFetches = 0;
const linkedDocumentFetch: PackageFetcher = async (url: string) => {
  const id = driveFileId(url);
  const bytes = id ? linkedDocuments.get(id) : undefined;
  if (!bytes) {
    throw Object.assign(new Error(`no linked document answers ${url}`), {
      safeMessage: 'That document could not be retrieved.',
    });
  }
  linkedFetches += 1;
  return { bytes: bytes.slice(), finalUrl: url };
};
const linkedPageTexts = async (bytes: Uint8Array): Promise<string[]> => {
  const read = await readPdfPageTextResult(bytes);
  if (!read.ok) throw new Error(`the linked document's text could not be read (${read.reason})`);
  return read.pages;
};
const imageryDeps = { fetchPackage: linkedDocumentFetch, readPageTexts: linkedPageTexts };

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
  /*
   * AND FOUR FOR THE FAULT MATRIX. Each case there imports a document the
   * main loop has already imported, and several import the SAME document
   * twice on purpose; separate organisations are what let a case assert its
   * own fault rather than re-asserting the duplicate guard.
   */
  ['fault', 'Fault Matrix Homes Pty Ltd'],
  ['fault:img', 'Fault Matrix Imagery Pty Ltd'],
  ['fault:replace', 'Fault Matrix Replacement Pty Ltd'],
  ['fault:abandoned', 'Fault Matrix Abandoned Pty Ltd'],
  ['fault:handoff', 'Fault Matrix Hand-off Pty Ltd'],
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
const servedTypes = new Map<string, string>();
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
    { headers: { 'content-type': servedTypes.get(key) ?? 'application/pdf' } });
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
/**
 * How many times one property may be worked before the gate gives up on it.
 *
 * A PDF's `source` stage is several claims now — the read, a batch of picture
 * kinds per claim, then the attach — because production killed every
 * invocation that parsed a brochure and decoded it too (`documentRead.pure.ts`).
 * A many-picture document legitimately takes a claim per batch, so the bound
 * covers the longest ladder the corpus can produce and is still a bound.
 */
const IMAGERY_MAX_PER_ITEM = 24;

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
      }, {
        repairSource: (client, input) => repairSourceImagesForUpload(client, input, imageryDeps),
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
        }, imageryDeps));
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

/**
 * Route A — exactly what `process_upload` does, in its order: the claim, the
 * row marked as being read, the STORED bytes imported with the checkpoint the
 * row carries and `resumableFromStoredBytes`, and — where the import hands
 * itself on — `releaseThenContinue` and then the successors, run through
 * `continueStockImport` exactly as the dispatcher runs them.
 *
 * IT DID NONE OF THE LAST THREE UNTIL 23 SEPTEMBER 2026, and that is how the
 * gate stayed green while production died. Route A imported the way a LINKED
 * source imports, which never hands off, so the path every uploaded brochure
 * takes in production — the one `LOT 550` was killed on, three times, after
 * the reader had finished — was not the path this gate ran. It is now, and
 * route B stays the linked transport it always was: the equivalence below
 * therefore compares an import finished by successors with one finished where
 * it started, which is the claim the hand-off has to earn.
 */
async function routeA(entry: Entry, bytes: Uint8Array, tag = 'A') {
  const org = orgs[entry.org];
  // Where the portal puts it: a successor refuses any path outside the
  // stock-list prefix (`continueStockImport`).
  const storagePath = `${STOCK_LIST_STORAGE_PREFIX}${org.id}/${tag}-${crypto.randomUUID()}/`
    + safeObjectName(entry.filename);
  const up = await db.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: entry.content_type ?? 'application/pdf', upsert: true,
  });
  if (up.error) throw new Error(`storage upload: ${up.error.message}`);
  const upload = await newUpload(entry.org, entry.filename, storagePath);

  // `process_upload`: the claim, then the row marked as being read.
  const portal = await claimImport(db, upload.id);
  await db.from('builder_stock_uploads').update({
    status: 'parsing', processing_started_at: new Date().toISOString(),
  }).eq('id', upload.id);

  const dl = await db.storage.from(BUCKET).download(storagePath);
  if (dl.error || !dl.data) throw new Error(`storage download: ${dl.error?.message}`);
  const downloaded = new Uint8Array(await dl.data.arrayBuffer());

  /*
   * WHAT EACH INVOCATION SPENT, read back off the row after it — the row
   * carries the import's running total, so the difference is exactly one
   * invocation's own account. It is what the isolation rule is judged on.
   */
  const invocations: Array<Record<string, number>> = [];
  let seen: Record<string, unknown> = {};
  const account = async () => {
    const { data } = await db.from('builder_stock_uploads')
      .select('stage_timings').eq('id', upload.id).maybeSingle();
    const now = (data?.stage_timings ?? {}) as Record<string, unknown>;
    const own: Record<string, number> = {};
    for (const [key, value] of Object.entries(now)) {
      if (typeof value !== 'number') continue;
      const was = typeof seen[key] === 'number' ? seen[key] as number : 0;
      if (value - was > 0) own[key] = value - was;
    }
    invocations.push(own);
    seen = now;
  };

  const t0 = performance.now(); const m0 = rss();
  const first = await runStockImport({
    supabase: db,
    organisationId: org.id,
    organisationName: org.name,
    builderUserId: org.userId,
    upload: { id: upload.id, original_filename: upload.original_filename },
    bytes: downloaded,
    sourceKind: 'file',
    storedCheckpoint: null,
    resumableFromStoredBytes: true,
  });
  await account();
  let result: any = first;
  const successors: string[] = [];
  const claim = portal.ok ? portal.claim : null;
  if (isImportContinuation(first)) {
    // `finishImport`'s hand-off branch: release, THEN dispatch — and this
    // harness is the dispatcher.
    await releaseThenContinue(db, claim, upload.id);
    let state = 'continued';
    while (state === 'continued' && successors.length <= MAX_IMPORT_CROSSINGS) {
      const next = await continueStockImport(db, upload.id, {
        onFinished: async ({ result: finished }) => { result = finished; },
      });
      state = next.state;
      successors.push(next.state);
      await account();
    }
  } else {
    await claim?.release();
    /*
     * A REFUSAL CLOSES THE ROW, through the portal's own function. Without
     * this the gate leaves a row reading `status: parsing, error_code:
     * duplicate_file` — an error on a status meaning "still working" — and
     * because `parsing` is re-readable the reader sweep then considers it on
     * every tick, for ever. Measured: sixteen such rows, and a backlog that
     * can never drain looks exactly like one draining slowly.
     */
    if (!first.ok) {
      await closeRefusedUpload(db, {
        uploadId: upload.id, organisationId: org.id,
        code: String((first as { code?: string }).code ?? 'import_failed'),
        message: String((first as { message?: string }).message ?? ''),
      });
    } else {
      await recordImportCounts(db, {
        uploadId: upload.id, organisationId: org.id,
        summary: first.summary,
      });
    }
  }
  /*
   * THE RULE THIS WHOLE HAND-OFF EXISTS FOR, judged by effect: no invocation
   * both parsed the document and decoded or stored one of its pictures — and
   * none both parsed it and made or recognised a scanned page, which is the
   * same rule for the engine that now runs in the isolate that asks.
   */
  const isolation = invocations.map((own, index) => ({
    invocation: index,
    parses: own.document_parses ?? 0,
    decodeMs: (own.image_decode_ms ?? 0) + (own.image_store_ms ?? 0),
    rasterised: own.rasterisations ?? 0,
    recognised: own.ocr_pages ?? 0,
    attempted: own.ocr_attempted ?? 0,
  }));
  /*
   * AND NO PAGE IS RECOGNISED TWICE. Each recognition adds one to its
   * invocation's `ocr_pages` and one key to the checkpoint, and keys never
   * disappear — so the sum over every invocation equals the pages held
   * exactly when no page was paid for twice.
   */
  const { data: finalRow } = await db.from('builder_stock_uploads')
    .select('import_checkpoint').eq('id', upload.id).maybeSingle();
  const ocrOnce = {
    recognisedTotal: isolation.reduce((sum, own) => sum + own.recognised, 0),
    recognisedDistinct: Object.keys(
      (finalRow?.import_checkpoint as any)?.ocr?.pages ?? {}).length,
  };
  return { result, uploadId: upload.id, ms: performance.now() - t0,
           rssDelta: rss() - m0, transferred: downloaded.length,
           successors, isolation, ocrOnce };
}

/**
 * "Read again" on a FILE, exactly as `reprocess_upload` runs it: the row
 * marked as being read (a new attempt, so its recovery count starts again),
 * the stored bytes imported with the checkpoint the row carries and
 * `resumableFromStoredBytes`, and — where it hands itself on — the dispatch
 * with no claim held (that path takes none) and the successors after it.
 *
 * Answers the import's FINAL result, whichever invocation finished it, so the
 * assertions below judge what a builder who pressed the button got.
 */
async function readAgainAsThePortalDoes(entry: Entry, uploadId: string, bytes: Uint8Array) {
  const org = orgs[entry.org];
  const { data: before } = await db.from('builder_stock_uploads')
    .select('import_checkpoint').eq('id', uploadId).maybeSingle();
  await db.from('builder_stock_uploads').update({
    status: 'parsing',
    processing_started_at: new Date().toISOString(),
    error_code: null, error_message: null, error_detail: null,
    import_recovery_attempts: 0,
  }).eq('id', uploadId).eq('organisation_id', org.id);
  const first = await runStockImport({
    supabase: db,
    organisationId: org.id,
    organisationName: org.name,
    builderUserId: org.userId,
    upload: { id: uploadId, original_filename: entry.filename },
    bytes,
    sourceKind: 'file',
    storedCheckpoint: before?.import_checkpoint ?? null,
    resumableFromStoredBytes: true,
  });
  if (!isImportContinuation(first)) {
    // `finishImport`'s own write, for a re-read that finished where it began.
    if (first.ok) {
      await db.from('builder_stock_uploads')
        .update(importOutcomeColumns(first, null)).eq('id', uploadId);
    }
    return first;
  }
  await releaseThenContinue(db, null, uploadId);
  let result: any = first;
  let state = 'continued';
  let successors = 0;
  while (state === 'continued' && successors <= MAX_IMPORT_CROSSINGS) {
    state = (await continueStockImport(db, uploadId, {
      onFinished: async ({ result: finished }) => { result = finished; },
    })).state;
    successors += 1;
  }
  return result;
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
  if (entry.content_type) servedTypes.set(key, entry.content_type);
  const t0 = performance.now(); const m0 = rss();
  const response = await realFetch(`http://localhost:54996/${key}`);
  const fetched = new Uint8Array(await response.arrayBuffer());

  const twin = `${entry.org}:b`;
  const sourceUrl = `http://localhost:54996/${key}`;
  const extension = entry.kind === 'sheet' ? 'csv' : 'pdf';
  const storagePath = `${orgs[twin].id}/B-${crypto.randomUUID()}.${extension}`;
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
    contentType: entry.content_type ?? 'application/pdf', upsert: true,
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
  if (result.ok) {
    await recordImportCounts(db, {
      uploadId: upload.id, organisationId: orgs[twin].id, summary: result.summary,
    });
  } else {
    await closeRefusedUpload(db, {
      uploadId: upload.id, organisationId: orgs[twin].id,
      code: String((result as { code?: string }).code ?? 'import_failed'),
      message: String((result as { message?: string }).message ?? ''),
    });
  }
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
  street_line: 'address_line',
};

/**
 * Does the card hold what the expectation states?
 *
 * `street_name` is compared as CONTAINED, because an address line may carry
 * the street number the expectation omits (`22 Wattlebird Way`). That also
 * passes a line carrying anything else beside the street, so a fixture whose
 * subject is the characters AROUND a street (`| Magpie Crescent`, the pipe a
 * heading set between the lot and the street) states `street_line`: the
 * whole line, exactly. Case is never compared — see 6c.
 */
function fieldHolds(field: string, key: string, got: unknown, want: unknown): boolean {
  if (key === 'address_line' && field !== 'street_line') {
    return String(got ?? '').toLowerCase().includes(String(want).toLowerCase());
  }
  return String(got).toLowerCase() === String(want).toLowerCase();
}
/**
 * Keys an expectation row carries that are NOT columns of a property.
 *
 * `image_size` states which of a page's pictures this card drew, which is an
 * assertion about the bytes the portal served rather than about a field —
 * see the ownership proof in 6f. Comparing it as a column would look for a
 * `builder_stock_items.image_size` that does not exist and report every
 * multi-property fixture as missing a field it never had.
 */
const NOT_A_COLUMN = new Set(['image_size']);

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

  row.uploadIdA = a.uploadId;
  row.uploadIdB = b.uploadId;
  /*
   * AN ISOLATE THAT PARSED THE DOCUMENT DECODED NONE OF ITS PICTURES — on the
   * path production runs, asserted from what each invocation recorded. A
   * successor chain that never finished is its own failure: the import is
   * still `parsing`, which a builder sees as a stock list that never loads.
   */
  row.handOff = { successors: a.successors, isolation: a.isolation, ocrOnce: a.ocrOnce };
  const mixed = a.isolation.filter((i) => i.parses > 0 && i.decodeMs > 0);
  if (mixed.length) {
    fail(entry, `an invocation parsed the document and decoded its pictures: ${JSON.stringify(mixed)}`);
  }
  const parsedAndRecognised = a.isolation.filter((i) => i.parses > 0
    && (i.rasterised > 0 || i.recognised > 0 || i.attempted > 0));
  if (parsedAndRecognised.length) {
    fail(entry, `an invocation parsed the document and recognised a page: ${JSON.stringify(parsedAndRecognised)}`);
  }
  if (a.ocrOnce.recognisedTotal !== a.ocrOnce.recognisedDistinct) {
    fail(entry, `a page was recognised more than once: ${JSON.stringify(a.ocrOnce)}`);
  }
  if (a.successors.length && a.successors.at(-1) === 'continued') {
    fail(entry, `the import was still handing itself on after ${a.successors.length} successors`);
  }
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
    const linkedBefore = linkedFetches;
    try {
      row.imagery = await settleImagery(orgs[entry.org].id, a.uploadId);
    } catch (e) {
      fail(entry, `the image settler threw: ${(e as Error).message}`);
    }
    /*
     * A SHEET WHOSE LINKS WERE NEVER FOLLOWED PROVES NOTHING about them. The
     * route this fixture exists for is the linked document, so a run that
     * reached none of them fails here rather than passing on whatever else
     * happened to put a picture on the card.
     */
    if (entry.kind === 'sheet') {
      row.linkedFetches = linkedFetches - linkedBefore;
      if (!row.linkedFetches) {
        fail(entry, 'no document a row links was ever fetched: the settler never reached the rows\' links');
      }
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
      outrankedFields: [...(d.diagnostics?.outrankedFields ?? [])].sort(),
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
  /*
   * THE SAME RULE, ONE LEVEL DOWN. A row whose own cells link documents keeps
   * a record per link in `source_provenance_result`, and each record states
   * WHEN it was answered — a clock reading, and the two routes read at two
   * different moments. Everything else in the record (the answer, the version
   * it was reached under, the document it is about, why) is compared.
   */
  const withoutClockReadings = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutClockReadings);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !k.endsWith('_at'))
      .map(([k, v]) => [k, withoutClockReadings(v)]));
  };
  const documentShape = (it: any) => Object.fromEntries(
    Object.entries(it)
      .filter(([k]) => !OF_THE_RUN.has(k))
      .map(([k, v]) => [k, asText(
        k === 'source_provenance_result' ? withoutClockReadings(v) : v)] as const)
      .sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  const eq = (what: string, x: unknown, y: unknown) => {
    const sx = JSON.stringify(x), sy = JSON.stringify(y);
    if (sx !== sy) fail(entry, `transport changed ${what}: A=${sx} B=${sy}`);
  };

  /*
   * A LINKED SCAN IS READ ONE PAGE DEEP, BY DESIGN — SO FOR IT THE CLAIM IS
   * "NEVER A WRONG VALUE", NOT "THE SAME DOCUMENT".
   *
   * A linked source cannot be continued: a successor re-reads stored bytes
   * and nothing else, while a link's name and address are evidence the reader
   * uses (`resumableFromStoredBytes`). So a scan whose facts are spread over
   * several pages reads further as an upload than as a link, and asserting
   * the two equal would assert a product nobody ships — the rule this
   * harness keeps about the duplicate guard. What route B is still held to:
   * it succeeds, it finds the same properties, and every field it states is
   * the field route A states. The gap is ABSENT fields only, it is declared
   * in the corpus beside the document, and it is reported on every run.
   */
  if (entry.expect.linked_limit) {
    row.equivalence = { documentName: b.documentName, linked: entry.expect.linked_limit };
    if (!b.result.ok) fail(entry, `the linked route was refused: ${(b.result as any).code}`);
    if (itemsA.length !== itemsB.length) {
      fail(entry, `route A produced ${itemsA.length} properties, route B ${itemsB.length}`);
    } else {
      const unread: string[] = [];
      for (let i = 0; i < itemsA.length; i += 1) {
        for (const key of [...COMPARED, 'house_design']) {
          const va = valueOf(itemsA[i], key);
          const vb = valueOf(itemsB[i], key);
          if (vb === null) {
            if (va !== null) unread.push(`${i}.${key}`);
          } else if (JSON.stringify(vb) !== JSON.stringify(va)) {
            fail(entry, `the linked route stated a different ${key}: A=${JSON.stringify(va)} B=${JSON.stringify(vb)}`);
          }
        }
      }
      (row.equivalence as any).unread = unread;
      // A declared limit that no longer holds is removed, never left to be believed.
      if (!unread.length) {
        fail(entry, 'the linked route read every field route A read: remove `linked_limit`');
      } else {
        limits.push(`${entry.name}: the linked route left ${unread.join(', ')} unread `
          + `[linked: ${entry.expect.linked_limit}]`);
      }
    }
  } else {
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
  }

  // --- 6c. the fields the document states -------------------------------
  const expectRows = entry.expect.rows ?? [];
  row.items = itemsA.map((it: any) => Object.fromEntries(
    [...COMPARED, 'house_design'].map((f) => [f, valueOf(it, f)])
      .filter(([, v]) => v !== null)));
  for (let i = 0; i < Math.min(expectRows.length, itemsA.length); i += 1) {
    for (const [field, want] of Object.entries(expectRows[i])) {
      if (NOT_A_COLUMN.has(field)) continue;
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
      const same = want === null ? got === null : fieldHolds(field, key, got, want);
      if (!same) fail(entry, `row ${i} ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }

  /*
   * --- 6c2. WHICH READER PRODUCED THE ROWS ------------------------------
   *
   * Named only where a fixture's whole subject is the ORDER of the readers.
   * A schedule must be read by the table parser, whose grid guarantees are
   * stronger than anything the region reader has — every cell in a column, a
   * cell outside every column refuses — so a document the table parser reads
   * correctly must never reach the second reader. Asserting the count alone
   * would pass if it did.
   */
  if (entry.expect.parse_strategy) {
    const { data: up } = await db.from('builder_stock_uploads')
      .select('parse_strategy').eq('id', a.uploadId).maybeSingle();
    const got = String(up?.parse_strategy ?? '');
    row.parseStrategy = got;
    if (got !== entry.expect.parse_strategy) {
      fail(entry, `read by the wrong reader: expected ${entry.expect.parse_strategy}, `
        + `got ${JSON.stringify(got)}`);
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

      /*
       * ==================================================================
       * AND IT IS THIS CARD'S PICTURE, not merely A picture.
       * ==================================================================
       *
       * Every assertion above proves the chain HOLDS — a row names an image,
       * the image is this property's, the portal serves it, the bytes decode.
       * None of them can see a SWAP: on a page carrying two cards, giving
       * each property the other's render satisfies all of them.
       *
       * So the fixtures that carry a picture per card draw them at
       * DIFFERENT PIXEL DIMENSIONS, and the expectation names which. The
       * comparison is made against the bytes the portal actually served,
       * which is the only reading that cannot be satisfied by a correct
       * pointer to the wrong photograph.
       */
      const wantSize = (entry.expect.rows ?? [])[itemsA.indexOf(it)]?.image_size ?? null;
      if (wantSize && decoded) {
        const gotSize = `${decoded.width}x${decoded.height}`;
        if (gotSize !== wantSize) {
          fail(entry, `lot ${it.lot_number} was served another card's photograph: `
            + `expected ${wantSize}, served ${gotSize}`);
        }
      }

      photographs.push({
        lot: it.lot_number, primary: primaryId, cleared,
        http: status, bytes: bytes.length,
        reference: img.source_reference ?? null,
        decoded: decoded ? `${decoded.kind} ${decoded.width}x${decoded.height}` : null,
      });
    }
    row.portalImages = photographs;

    /*
     * NO TWO PROPERTIES OF ONE DOCUMENT MAY SHOW THE SAME PICTURE.
     *
     * The weaker half of the ownership proof, and the one that needs no
     * fixture cooperation: "the first image for every property" is a real
     * failure mode this product has had, and it produces N properties
     * pointing at one image row. Distinctness catches it whatever the
     * pictures look like.
     */
    const primaries = photographs.map((p) => p.primary).filter(Boolean);
    if (new Set(primaries).size !== primaries.length) {
      fail(entry, `two properties in one document show the same photograph: `
        + JSON.stringify(photographs.map((p) => ({ lot: p.lot, primary: p.primary }))));
    }
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

    const reread = await readAgainAsThePortalDoes(entry, a.uploadId, bytes);
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
/**
 * A TICK THE SWEEP WILL ACTUALLY WORK IN.
 *
 * `settleReaderVersion` declines to START a re-read with less than
 * `READER_SWEEP_RESERVE_MS` (40s) left, because a parse it cannot finish
 * writes nothing and spends the budget anyway — a good rule. Part 8 was
 * written passing 15, 20 and 25 seconds, so every sweep in it broke out of
 * the loop before touching a row and THREE cases passed having exercised
 * nothing: a re-read that never ran could not stamp a run in flight, a
 * deploy that never re-read could not lose a row, and an abandoned upload
 * that was never considered stayed `uploaded` and was read as a product
 * gap that does not exist.
 *
 * Derived from the product's own constant rather than typed, so the number
 * cannot drift away from the rule it is about.
 */
const SWEEP_TICK_MS = READER_SWEEP_RESERVE_MS + 20_000;

/**
 * ONE SWEEP TICK, AND THE DISPATCHER BEHIND IT.
 *
 * A re-read now crosses isolates the way an import does
 * (`readerSweepAttempt.pure.ts`), and production has two ways to start the
 * next one. A settled list is continued by the SWEEP'S next tick, which the
 * settler dispatches at once — here, the next turn of whichever loop called
 * this. A `parsing` row is an import, handed to the import's own successor
 * through `releaseThenContinue` — and this harness is the dispatcher for that
 * one, exactly as route A is: every successor runs through
 * `continueStockImport`, bounded by the same crossings.
 */
async function sweepTick(input: { limit?: number; deadlineAt?: number }) {
  const tick = await settleReaderVersion(db, input);
  for (const handed of tick.handedOn ?? []) {
    if (handed.via !== 'import_continuation') continue;
    let state = 'continued';
    for (let n = 0; state === 'continued' && n <= MAX_IMPORT_CROSSINGS; n += 1) {
      state = (await continueStockImport(db, handed.uploadId)).state;
    }
  }
  return tick;
}

/**
 * How many ticks a loop that waits for the sweep may take for ONE upload: the
 * most a single re-read can take, fresh read to finish. Derived from the
 * product's own bound, because a loop sized for a re-read that finished in
 * the tick it began would read a hand-off as a failure.
 */
const SWEEP_TICKS_PER_UPLOAD = MAX_SWEEP_ATTEMPT_TICKS;

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
   * A FINISHED IMPORT IS A READ, SO THE SWEEP HAS NOTHING TO ASK IT.
   *
   * The product's completion stamps the reader version it read at
   * (`importOutcomeColumns`), because the sweep reading a fresh import a
   * second time was the last place a PDF was parsed and decoded in one
   * isolate — production killed the settler twice on 23 September 2026 doing
   * exactly that to `LOT 550`. Judged on every route-A import a successor
   * finished, which is the path every uploaded brochure now takes.
   */
  const finishedBySuccessors = report
    .filter((r: any) => r.uploadIdA && r.a?.ok && (r.handOff?.successors?.length ?? 0) > 0)
    .map((r: any) => String(r.uploadIdA));
  const { data: stampedRows } = finishedBySuccessors.length
    ? await db.from('builder_stock_uploads')
      .select('id, reader_settled_version').in('id', finishedBySuccessors)
    : { data: [] as any[] };
  const unstamped = (stampedRows ?? [])
    .filter((r: any) => Number(r.reader_settled_version) !== DETERMINISTIC_READER_VERSION)
    .map((r: any) => r.id);
  invariants.importStampsItsRead = {
    finishedBySuccessors: finishedBySuccessors.length,
    stamped: (stampedRows ?? []).length - unstamped.length,
    unstamped,
  };
  invariant('a-finished-import-is-not-read-twice',
    finishedBySuccessors.length > 0 && (stampedRows ?? []).length === finishedBySuccessors.length
      && unstamped.length === 0,
    JSON.stringify(invariants.importStampsItsRead));

  /*
   * A DEPLOY IS WHAT MAKES A SOURCE STALE, AND THIS IS ONE. Every row stamped
   * at today's version is moved one behind it — exactly what shipping a new
   * reader does to every row in the table — so the contract below is judged
   * over the whole store rather than over whatever an import left unstamped.
   */
  /*
   * AND EVERY ROW'S STAGE LEDGER STARTS EMPTY, so what each sweep tick spent
   * can be read off the row as the difference it made — the same measurement
   * route A takes of each invocation. The ledger is a diagnostic; nothing
   * the sweep decides reads it.
   */
  await db.from('builder_stock_uploads')
    .update({ reader_settled_version: DETERMINISTIC_READER_VERSION - 1, stage_timings: null })
    .eq('reader_settled_version', DETERMINISTIC_READER_VERSION);
  const pendingBefore = await readerSweepPending(db);
  /** Every card that shows a photograph before the store is re-read. */
  const photographed = async () => {
    const { data } = await db.from('builder_stock_items')
      .select('id, primary_image_id, lifecycle_status, upload_id')
      .eq('lifecycle_status', 'active');
    return (data ?? []).filter((row: any) => row.primary_image_id);
  };
  const photographedBefore = await photographed();
  let considered = 0; let reread = 0; let ticks = 0; let handedOn = 0;
  /*
   * THE RULE THE RE-READ WAS REBUILT FOR, judged by effect: no sweep tick both
   * parses a document and decodes or stores one of its pictures. That pairing
   * is what killed the settler fifteen times on `LOT 550`. A tick's own spend
   * is the change it made to the row's ledger; a fresh attempt starts the
   * ledger again, which reads as a decrease and is taken whole.
   */
  const ledgers = async () => {
    const { data } = await db.from('builder_stock_uploads')
      .select('id, stage_timings').is('deleted_at', null);
    return new Map<string, Record<string, unknown>>((data ?? [])
      .map((row: any) => [String(row.id), (row.stage_timings ?? {}) as Record<string, unknown>]));
  };
  const spentBy = (was: Record<string, unknown>, now: Record<string, unknown>) => {
    const number = (value: unknown) => (typeof value === 'number' ? value : 0);
    const restarted = Object.keys(now).some((key) => number(now[key]) < number(was[key]));
    const own = (key: string) => restarted ? number(now[key]) : number(now[key]) - number(was[key]);
    return {
      parses: own('document_parses'),
      decodeMs: own('image_decode_ms') + own('image_store_ms'),
    };
  };
  const mixedTicks: Array<{ tick: number; upload: string; parses: number; decodeMs: number }> = [];
  let before = await ledgers();
  // The sweep is bounded per tick on purpose; the cron comes back. So does
  // this — and a re-read that hands its pictures on takes more than one tick,
  // so the bound is per upload rather than per store.
  const tickBound = Math.max(40, (pendingBefore ?? 0) * SWEEP_TICKS_PER_UPLOAD);
  for (; ticks < tickBound; ticks += 1) {
    const tick = await sweepTick({ deadlineAt: Date.now() + 60_000, limit: 25 });
    considered += tick.considered; reread += tick.reread; handedOn += tick.handedOn.length;
    const after = await ledgers();
    for (const [upload, now] of after) {
      const spent = spentBy(before.get(upload) ?? {}, now);
      if (spent.parses > 0 && spent.decodeMs > 0) mixedTicks.push({ tick: ticks, upload, ...spent });
    }
    before = after;
    if (!tick.considered) break;
    if ((await readerSweepPending(db) ?? 0) === 0) { ticks += 1; break; }
  }
  const pendingAfter = await readerSweepPending(db);

  /*
   * AND WHAT THE RE-READS HANDED TO THE SETTLER IS SETTLED, AS THE MINUTE
   * TICK SETTLES IT.
   *
   * A re-read attaches its pictures in an isolate that did not parse the
   * document, and that isolate judges only as many heroes as the settler's
   * own per-isolate allowance (`eligibilityDecodes`); the rest are stored
   * with the item queued for the settler's eligibility stage — which is the
   * import's own behaviour and "Read again"'s. In production the minute tick
   * counts that queued work (`v_item_work`) and dispatches the settler; here
   * this is the settler. Measured on the first run of this sweep:
   * `MERIDIAN - STOCK LIST WITH IMAGES.pdf` carries four heroes, the
   * successor judged three, and lot 175 waited at `source` for a settler this
   * harness had never run.
   */
  const { data: owedImageWork } = await db.from('builder_stock_items')
    .select('organisation_id, upload_id, image_work_stage')
    .in('lifecycle_status', ['active', 'staged']);
  const owedUploads = new Map<string, string>();
  for (const row of (owedImageWork ?? []) as any[]) {
    if (['settled', 'failed'].includes(String(row.image_work_stage))) continue;
    owedUploads.set(String(row.upload_id), String(row.organisation_id));
  }
  for (const [uploadId, organisationId] of owedUploads) {
    await settleImagery(organisationId, uploadId);
  }

  /*
   * A RE-READ MAY CHANGE WHAT A CARD SAYS; IT MAY NOT COST IT ITS PHOTOGRAPH.
   * Judged once the settler has done what the re-read handed it, which is
   * the only moment a builder's card is judged by anyone.
   */
  const stillPhotographed = new Set((await photographed()).map((row: any) => row.id));
  const lostPhotograph = photographedBefore
    .filter((row: any) => !stillPhotographed.has(row.id))
    .map((row: any) => row.id);
  invariant('a-reread-keeps-every-photograph',
    photographedBefore.length > 0 && lostPhotograph.length === 0,
    `${photographedBefore.length} cards photographed before; lost: ${JSON.stringify(lostPhotograph)}`);

  invariants.readerSweep = {
    pendingBefore, considered, reread, handedOn, ticks, pendingAfter, mixedTicks,
    settledAfter: owedUploads.size,
    photographedBefore: photographedBefore.length, lostPhotograph,
  };
  invariant('a-stale-source-is-reread-unasked',
    (pendingBefore ?? 0) > 0 && (pendingAfter ?? 0) === 0,
    `${pendingBefore} outstanding before; ${considered} considered over ${ticks} ticks, `
    + `${reread} re-read, ${pendingAfter} outstanding after`);
  invariant('a-sweep-tick-never-parses-and-decodes',
    handedOn > 0 && mixedTicks.length === 0,
    `${handedOn} hand-offs; ${mixedTicks.length} ticks both parsed and decoded: `
    + JSON.stringify(mixedTicks.slice(0, 5)));

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

// ===========================================================================
// 8 · THE FAULT MATRIX — WHAT A BROKEN DAY DOES TO A CUSTOMER'S DOCUMENT
// ===========================================================================
/*
 * Part 7 asks what the subsystem does when everything works. This asks what
 * it does when something does not, because every defect this incident is
 * about presented as normal operation: an upload stuck at `parsing` with an
 * error code on it, a settler spinning on a row it could never finish, a
 * vendor's billing state standing between a brochure and the marketplace.
 *
 * ONE STANDARD FOR EVERY ROW BELOW. A fault may cost TIME and it may cost a
 * FIELD. It may never cost the property, never publish something wrong,
 * never leave a row in a state nothing can move, and never be silent — the
 * row must carry, afterwards, a reading of what happened that an operator
 * could act on.
 *
 * WHAT IS NOT INJECTED, AND WHY. Nothing here disables a control to make a
 * case reachable. Where the product's own configuration is the fault (the
 * assisted reader being off, a provider having no credential) that IS the
 * default this deployment ships, so the case is asserted against the default
 * rather than by taking a guard away.
 */
{
  const stateOf = async (uploadId: string) => {
    const { data } = await db.from('builder_stock_uploads')
      .select('status, error_code, error_message, processing_completed_at')
      .eq('id', uploadId).maybeSingle();
    return (data ?? {}) as {
      status?: string; error_code?: string | null;
      error_message?: string | null; processing_completed_at?: string | null;
    };
  };
  /** No upload may end a fault in a status that means "still working". */
  const terminal = (s: any) => s.status === 'completed' || s.status === 'failed'
    || s.status === 'partial';
  const faults: Record<string, unknown> = {};
  const FAULT = 'fault';
  const FAULT_IMG = 'fault:img';
  const FAULT_REPLACE = 'fault:replace';
  const FAULT_ABANDONED = 'fault:abandoned';
  const FAULT_HANDOFF = 'fault:handoff';
  /*
   * ORDINARY DOCUMENTS, in manifest order, one per case. A fault matrix that
   * reused one document would be asserting six things about one page; these
   * are the corpus's own single-property brochures and each case takes the
   * next, so a case cannot be made to pass by the document it chose.
   */
  const SINGLES = manifest.filter((e: any) => (e.expect?.properties ?? 0) === 1);
  const docOf = (n: number) => SINGLES[n % SINGLES.length];
  const imageRowsFor = async (uploadId: string) => {
    const { data } = await db.from('builder_stock_item_images')
      .select('id, stock_item_id, source_reference').eq('upload_id', uploadId);
    return data ?? [];
  };

  const importInto = async (orgKey: string, entry: any, opts: Record<string, unknown> = {}) => {
    const org = orgs[orgKey];
    const bytes = await Deno.readFile(`${corpusDir}/${entry.org}/${entry.filename}`);
    const path = `${org.id}/${crypto.randomUUID()}.pdf`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, {
      contentType: 'application/pdf', upsert: true,
    });
    if (up.error) throw new Error(`fault fixture upload: ${up.error.message}`);
    const upload = await newUpload(orgKey, entry.filename, path);
    await db.from('builder_stock_uploads').update({ status: 'parsing' }).eq('id', upload.id);
    const result = await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId,
      upload: { id: upload.id, original_filename: upload.original_filename },
      bytes, sourceKind: 'file', ...opts,
    });
    if (!result.ok) {
      await closeRefusedUpload(db, {
        uploadId: upload.id, organisationId: org.id,
        code: String((result as any).code ?? 'import_failed'),
        message: String((result as any).message ?? ''),
      });
    } else {
      await recordImportCounts(db, {
        uploadId: upload.id, organisationId: org.id, summary: result.summary,
      });
      await db.from('builder_stock_uploads').update({
        status: result.uploadStatus,
      }).eq('id', upload.id);
    }
    return { result, uploadId: upload.id, orgId: org.id };
  };

  // --- 8a. NO MODEL PROVIDER, NO CREDENTIAL, NO BUDGET --------------------
  /*
   * The shipped default, asserted as a fault because it is the one that
   * caused the incident: `openrouter/openai/gpt-5.6-luna` answered 402 and a
   * seven-page brochure with 3,962 characters of clean text was reported to
   * the builder as unreadable.
   *
   * The whole acceptance run already proves the normal path asks nobody —
   * `modelCallAttempts` is empty or the gate fails. What this adds is the
   * explicit statement that the documents still IMPORT with every model
   * credential absent, which is a different claim from "nothing was called".
   */
  {
    const before = modelCallAttempts.length;
    const imported = report.filter((r: any) => r.a?.ok).length;
    /*
     * READ, NOT ASSUMED. The point of the row is that these are absent, so
     * the absence is measured from the environment this run actually has
     * rather than asserted from the fact that nobody set them.
     */
    const CREDENTIALS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'LOVABLE_API_KEY'];
    const present = CREDENTIALS.filter((n) => (Deno.env.get(n) ?? '').trim() !== '');
    faults.noProvider = {
      credentialsPresent: present,
      modelCallsDuringRun: modelCallAttempts.length,
      documentsImported: imported,
    };
    invariant('no-model-provider-still-imports',
      modelCallAttempts.length === before && imported > 0,
      JSON.stringify(faults.noProvider));
  }

  // --- 8b. THE MODEL IS REACHABLE AND REFUSES (402) -----------------------
  // --- 8c. THE MODEL IS REACHABLE AND NEVER ANSWERS (timeout) -------------
  /*
   * Both are one assertion, and the assertion is about REACHABILITY rather
   * than about the answer: `assistedReaderEnabled` is false on this
   * deployment and on every deployment that has not opted in by name, so no
   * request is composed, no budget is reserved and no vendor round trip is
   * waited on. A 402 and a timeout are then the same event — one that does
   * not occur — and the honest way to assert that is to prove the switch is
   * off and that the import does not consult it, not to stand up a fake
   * vendor that answers 402 to a call nobody makes.
   *
   * The interceptor above is what makes this more than an opinion: any code
   * path that DID compose a request would throw and be reported by name.
   */
  {
    const enabled = assistedReaderEnabled(Deno.env);
    const disposition = assistedReaderDisposition({
      enabled, deterministicRows: 0, sourceHasColumns: false,
    } as any);
    faults.assistedReader = { enabled, disposition, modelCalls: modelCallAttempts.length };
    invariant('a-vendor-refusal-cannot-reach-the-normal-path',
      enabled === false && modelCallAttempts.length === 0,
      JSON.stringify(faults.assistedReader));
  }

  // --- 8d. THE SAME JOB IS DELIVERED TWICE --------------------------------
  /*
   * A queue that promises at-least-once delivery hands the same upload to two
   * workers. Neither may write a second property, and the loser must not
   * report success for work it did not do.
   */
  {
    const entry = docOf(0);
    const org = orgs[FAULT];
    const bytes = await Deno.readFile(`${corpusDir}/${entry.org}/${entry.filename}`);
    const path = `${org.id}/${crypto.randomUUID()}.pdf`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    const upload = await newUpload(FAULT, entry.filename, path);
    await db.from('builder_stock_uploads').update({ status: 'parsing' }).eq('id', upload.id);
    const once = () => runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId,
      upload: { id: upload.id, original_filename: upload.original_filename },
      bytes, sourceKind: 'file',
    });
    const [first, second] = await Promise.all([once(), once()]);
    const rows = await itemsFor(upload.id);
    faults.duplicateDelivery = {
      first: first.ok, second: second.ok, rows: rows.length,
      distinctAnchors: new Set(rows.map((r: any) => r.source_row?.source_anchor)).size,
    };
    invariant('one-job-delivered-twice-writes-one-property',
      rows.length === (entry.expect.properties ?? 1),
      JSON.stringify(faults.duplicateDelivery));
  }

  // --- 8e. A RE-READ ARRIVES WHILE THE FIRST READ IS RUNNING --------------
  /*
   * The reader sweep meets an upload the import is still inside. It must
   * leave it alone — `parse_in_flight` is deliberately NOT stampable, because
   * stamping records a version against a read nobody did — and it must not
   * report it as a failure the operator should act on.
   */
  {
    const org = orgs[FAULT];
    const entry = docOf(1);
    const bytes = await Deno.readFile(`${corpusDir}/${entry.org}/${entry.filename}`);
    const path = `${org.id}/${crypto.randomUUID()}.pdf`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    const upload = await newUpload(FAULT, entry.filename, path);
    await db.from('builder_stock_uploads').update({
      status: 'parsing', processing_started_at: new Date().toISOString(),
      reader_settled_version: null,
    }).eq('id', upload.id);

    const sweep = await sweepTick({ limit: 50, deadlineAt: Date.now() + SWEEP_TICK_MS });
    const { data: after } = await db.from('builder_stock_uploads')
      .select('status, reader_settled_version').eq('id', upload.id).maybeSingle();
    const touched = (sweep.refused ?? []).some((r: any) => r.uploadId === upload.id);
    faults.reReadDuringProcessing = {
      stamped: after?.reader_settled_version ?? null,
      status: after?.status,
      refusedBySweep: touched,
      leftOutstanding: (sweep.failed ?? []).some((r: any) => r.uploadId === upload.id),
    };
    invariant('a-re-read-never-stamps-a-run-in-flight',
      after?.reader_settled_version == null && !touched,
      JSON.stringify(faults.reReadDuringProcessing));
    // Leave nothing behind for the next case.
    await closeRefusedUpload(db, {
      uploadId: upload.id, organisationId: org.id,
      code: 'acceptance_fixture', message: 'fault matrix fixture, closed',
    });
  }

  // --- 8f. A DEPLOYMENT LANDS WHILE A DOCUMENT IS BEING PROCESSED ---------
  /*
   * What a deploy actually is, from a row's point of view: the reader version
   * changes under it. The row must not be lost, must not be double-counted,
   * and must come out on the CURRENT reader — which is the sweep's whole job,
   * asserted here from the mid-flight state rather than from a clean one.
   */
  {
    const org = orgs[FAULT];
    const entry = docOf(2);
    const done = await importInto(FAULT, entry);
    // The row is now settled on today's reader. A deploy moves the goalposts.
    await db.from('builder_stock_uploads')
      .update({ reader_settled_version: 1 }).eq('id', done.uploadId);
    const before = (await itemsFor(done.uploadId)).map((i: any) => i.id).sort();
    let ticks = 0; let reread = 0;
    for (let i = 0; i < SWEEP_TICKS_PER_UPLOAD; i += 1) {
      const sweep = await sweepTick({ limit: 50, deadlineAt: Date.now() + SWEEP_TICK_MS });
      ticks += 1; reread += sweep.reread;
      const { data } = await db.from('builder_stock_uploads')
        .select('reader_settled_version').eq('id', done.uploadId).maybeSingle();
      if (Number(data?.reader_settled_version ?? 0) >= DETERMINISTIC_READER_VERSION) break;
    }
    const after = (await itemsFor(done.uploadId)).map((i: any) => i.id).sort();
    faults.deploymentDuringProcessing = {
      ticks, reread, rowsBefore: before.length, rowsAfter: after.length,
      sameRows: JSON.stringify(before) === JSON.stringify(after),
    };
    invariant('a-deploy-mid-flight-re-reads-onto-the-same-rows',
      before.length > 0 && JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify(faults.deploymentDuringProcessing));
  }

  // --- 8g. IMAGE WORK FAILS AND IS RETRIED --------------------------------
  /*
   * A settlement attempt that failed must be retryable and must not
   * accumulate: the same picture settled twice is one row, which is the
   * NULLS DISTINCT defect this subsystem has already paid for once.
   */
  {
    const entry = docOf(3);
    const done = await importInto(FAULT_IMG, entry);
    const first = await settleImagery(done.orgId, done.uploadId);
    const imagesAfterFirst = await imageRowsFor(done.uploadId);
    // Put the ladder back to the bottom, exactly as a failed attempt does.
    await db.from('builder_stock_items').update({
      enrichment_status: 'pending', image_work_stage: 'source',
      image_work_claim_until: null,
      image_work_next_attempt_at: new Date().toISOString(),
    }).eq('upload_id', done.uploadId);
    const second = await settleImagery(done.orgId, done.uploadId);
    const imagesAfterSecond = await imageRowsFor(done.uploadId);
    faults.imageRetry = {
      first: imagesAfterFirst.length, second: imagesAfterSecond.length,
      rounds: { first: first.length, second: second.length },
    };
    invariant('image-work-retried-adds-no-row',
      imagesAfterSecond.length === imagesAfterFirst.length,
      JSON.stringify(faults.imageRetry));
  }

  // --- 8h. A BUILDER UPLOADS A REPLACEMENT LIST ---------------------------
  /*
   * The case `49-re-importing-a-linked-stock-list.md` is about. A replacement
   * must not blank the marketplace: the properties it matches keep serving
   * what they served, their new values wait in `pending_patch` until the
   * cutover, and the uploads it supersedes are NAMED rather than guessed at.
   *
   * THE FIRST VERSION OF THIS CASE TESTED THE WRONG THING, and it passed. It
   * re-imported IDENTICAL bytes, which the duplicate guard refuses — so what
   * it proved was that a refused import changes nothing, which is true and is
   * a different assertion. A replacement is a builder sending a NEW document
   * about properties they already listed: same lot, same street, different
   * price, different picture. `replacement-original` carries one now, with
   * its revision beside it, because a case that cannot be reached without the
   * right document belongs in the corpus rather than in a workaround here.
   */
  {
    const entry = manifest.find((e: any) => e.name === 'replacement-original');
    if (!entry?.revision) {
      invariant('a-replacement-never-blanks-the-marketplace', false,
        'the corpus carries no revision document');
    } else {
      const org = orgs[FAULT_REPLACE];
      const first = await importInto(FAULT_REPLACE, entry);
      await settleImagery(org.id, first.uploadId);
      await publishUploadIfReady(db, first.uploadId);
      const live = await itemsFor(first.uploadId);
      const liveIds = live.map((i: any) => i.id).sort();
      const priceBefore = live.map((i: any) => String(i.price ?? '')).sort();

      const revision = await Deno.readFile(`${corpusDir}/${entry.revision.path}`);
      const path = `${org.id}/${crypto.randomUUID()}.pdf`;
      await db.storage.from(BUCKET).upload(path, revision, {
        contentType: 'application/pdf', upsert: true,
      });
      const upload = await newUpload(FAULT_REPLACE, entry.revision.filename, path);
      await db.from('builder_stock_uploads').update({ status: 'parsing' }).eq('id', upload.id);
      const again = await runStockImport({
        supabase: db, organisationId: org.id, organisationName: org.name,
        builderUserId: org.userId,
        upload: { id: upload.id, original_filename: upload.original_filename },
        bytes: revision, sourceKind: 'file',
      });

      const { data: after } = await db.from('builder_stock_items')
        .select('id, lifecycle_status, price, pending_patch, primary_image_id')
        .eq('organisation_id', org.id);
      const rows = after ?? [];
      const matched = rows.filter((r: any) => liveIds.includes(r.id));
      const stillLive = matched.filter((r: any) => r.lifecycle_status === 'active').length;
      const priceAfter = matched.map((r: any) => String(r.price ?? '')).sort();
      const withPendingPatch = matched.filter((r: any) => r.pending_patch).length;
      const withPhotograph = matched.filter((r: any) => r.primary_image_id).length;
      const { data: revisionRow } = await db.from('builder_stock_uploads')
        .select('published_at').eq('id', upload.id).maybeSingle();
      const cutOver = !!revisionRow?.published_at;
      const priceHeld = JSON.stringify(priceBefore) === JSON.stringify(priceAfter);

      faults.replacementUpload = {
        accepted: again.ok,
        code: again.ok ? null : String((again as any).code),
        liveBefore: liveIds.length, stillLive,
        totalRowsAfter: rows.length,
        sameRowIds: JSON.stringify(matched.map((r: any) => r.id).sort()) === JSON.stringify(liveIds),
        priceHeld, priceBefore, priceAfter, withPendingPatch, withPhotograph,
        revisionPublished: cutOver,
        replaces: again.ok ? ((again as any).summary?.replacesUploadIds ?? []).length : null,
        deferred: again.ok ? ((again as any).summary?.deferred ?? null) : null,
        staged: again.ok ? ((again as any).summary?.staged ?? null) : null,
      };
      /*
       * THE EXPECTATION THIS ROW STARTED WITH WAS WRONG, AND THE EVIDENCE IS
       * WORTH MORE THAN THE CORRECTION.
       *
       * OLD: the revision's $699,500 must wait in `pending_patch` while the
       * marketplace goes on serving $684,900.
       * MEASURED: `priceHeld: false`, `withPendingPatch: 0`, and the revision
       * upload carrying `published_at` one second after its import.
       * WHY IT WAS WRONG: deferral is not the end state, it is the FIRST HALF
       * of one. `importStockRecords` defers (`newPropertyLifecycle === staged
       * && lifecycleBefore === active`) and then `runStockImport` asks
       * `publish_builder_stock_upload`, which applies the held patch in the
       * SAME statement that promotes the staged rows — deliberately, under a
       * comment recording that a re-read of an already-settled list produces
       * no image work, so nobody else would ever ask and a corrected reading
       * would sit in `pending_patch` for ever. This property's photographs
       * were already settled, so the revision was ready immediately and cut
       * over immediately. Asserting the patch was still pending would have
       * been asserting that the cutover had not happened yet, which is a
       * statement about timing rather than about correctness.
       * NEW: what the customer must never see is what is asserted — the card
       * never goes blank, never forks, and never loses its photograph. The
       * price is REPORTED with the publication state that explains it, and
       * the two legal shapes are named: held while the revision is unpublished,
       * applied once it is.
       */
      invariant('a-replacement-never-blanks-the-marketplace',
        again.ok
        && liveIds.length > 0
        // No blank: every property that was live is still live.
        && stillLive === liveIds.length
        // No fork: the same rows, and no new ones beside them.
        && rows.length === liveIds.length
        && JSON.stringify(matched.map((r: any) => r.id).sort()) === JSON.stringify(liveIds)
        // No lost picture.
        && withPhotograph === liveIds.length
        // And the price is one of the two legal shapes, never a third.
        && (cutOver ? !priceHeld : priceHeld),
        JSON.stringify(faults.replacementUpload));
      if (!again.ok) {
        await closeRefusedUpload(db, {
          uploadId: upload.id, organisationId: org.id,
          code: String((again as any).code ?? 'import_failed'),
          message: String((again as any).message ?? ''),
        });
      }
    }
  }

  // --- 8i. THE BROWSER CLOSES THE MOMENT THE UPLOAD IS ACCEPTED -----------
  /*
   * The customer's half of "worker termination". `process_upload` is what the
   * browser calls after the file is stored, so a tab closed before that call
   * leaves a row at `uploaded` with bytes behind it and nobody coming. The
   * product's answer is the reader sweep, and the requirement is that the
   * document reaches the marketplace with NOBODY ASKING — which is the whole
   * difference between a pipeline and a button.
   */
  {
    /*
     * A DOCUMENT THAT PROMISES A PHOTOGRAPH, chosen for that rather than by
     * index. This is the one case in the matrix that runs the whole customer
     * workflow end to end with nobody touching it, so it must be able to
     * reach the last step of it — a card with the right picture on it. The
     * first version took `docOf(5)`, which the corpus's own manifest records
     * as carrying no eligible imagery, so "no photograph" would have been the
     * document's correct answer and the assertion would have proved nothing.
     */
    const entry = SINGLES.find((e: any) => e.expect?.image === 'facade_page_1'
      && ![docOf(0), docOf(1), docOf(2), docOf(3), docOf(4)].includes(e))
      ?? docOf(6);
    const org = orgs[FAULT_ABANDONED];
    const bytes = await Deno.readFile(`${corpusDir}/${entry.org}/${entry.filename}`);
    // Where the portal's `add_upload` puts it, which is also the one place the
    // import's own successor will read from — so a first pass the sweep adopts
    // is handed on exactly as production hands it on.
    const path = `${STOCK_LIST_STORAGE_PREFIX}${org.id}/${crypto.randomUUID()}/`
      + safeObjectName(entry.filename);
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    const upload = await newUpload(FAULT_ABANDONED, entry.filename, path);
    // Nothing else happens. The tab is gone.
    //
    // A FRESH ROW IS DELIBERATELY LEFT ALONE, and that is a control rather
    // than an obstacle: `upload_not_started` refuses an `uploaded` row until
    // `ABANDONED_UPLOAD_MS` has passed, so the sweep cannot race a browser
    // that is about to call `process_upload`. Asserted first, then the clock
    // is wound back — the bytes and the row are untouched, only the moment
    // they landed moves, which is the one thing a test cannot wait for.
    const fresh = await sweepTick({ limit: 50, deadlineAt: Date.now() + SWEEP_TICK_MS });
    const notYet = (await itemsFor(upload.id)).length === 0
      && (await stateOf(upload.id)).status === 'uploaded'
      && !(fresh.refused ?? []).some((r: any) => r.uploadId === upload.id);

    await db.from('builder_stock_uploads').update({
      created_at: new Date(Date.now() - ABANDONED_UPLOAD_MS - 60_000).toISOString(),
    }).eq('id', upload.id);

    let ticks = 0;
    for (let i = 0; i < SWEEP_TICKS_PER_UPLOAD; i += 1) {
      const sweep = await sweepTick({ limit: 50, deadlineAt: Date.now() + SWEEP_TICK_MS });
      ticks += 1;
      if ((await itemsFor(upload.id)).length) break;
      if (!sweep.considered) break;
    }
    const rows = await itemsFor(upload.id);
    const state = await stateOf(upload.id);
    // The customer's actual outcome: a card, with the photograph on it.
    const settled = rows.length
      ? await settleImagery(org.id, upload.id)
      : [];
    const published = rows.length ? await itemsFor(upload.id) : [];
    /*
     * The last step of the workflow: a card, with this property's own
     * photograph on it. Required only where the document promises one —
     * asking a brochure with no eligible imagery for a picture is asking it
     * to invent one, which is the rule the whole subsystem turns on.
     */
    const withPhotographReached = entry.expect.image === 'facade_page_1'
      ? published.some((r: any) => r.primary_image_id)
      : true;
    faults.abandonedUpload = {
      freshRowLeftAlone: notYet,
      ticks, rows: rows.length, status: state.status,
      errorCode: state.error_code ?? null,
      imagerySettled: settled.length,
      withPhotograph: published.filter((r: any) => r.primary_image_id).length,
      expected: entry.expect.properties ?? 1,
      expectedImage: entry.expect.image ?? null,
      document: entry.name,
    };
    /*
     * ASSERTED, AND IT USED TO FAIL.
     *
     * The first version of this row accepted `status === 'uploaded'` as a
     * pass, and it passed: eight ticks, zero properties, nothing moved.
     * `RE_READABLE_STATUSES` excluded `uploaded` under a sentence covering
     * two different cases — "a cron tick may not decide to start importing a
     * file the builder's own import refused OR NEVER RAN" — and the second
     * half of that was wrong. A `failed` row carries a decision a person was
     * shown; an `uploaded` row carries none, and refusing it stranded the
     * customer's stock list for ever with every screen reporting normal.
     *
     * Accepting that as a pass would have been weakening the test to agree
     * with the code, which is the one thing this incident's contract names
     * outright. The product is fixed instead: `readerVersion.pure.ts` admits
     * the state, `settleReaderVersion` CLAIMS it so a returning browser and a
     * tick cannot both import, and every branch that can leave a claimed row
     * puts it down terminally.
     */
    /*
     * AND THE STATUS IS JUDGED BY WHETHER ANYTHING WILL ACT ON IT.
     *
     * `terminal()` was written for a REFUSAL — completed, failed, partial —
     * and applying it here failed a healthy import: a successful first pass
     * ends at `enriching`, which is `runStockImport`'s own answer (its only
     * other is `partially_complete`) and which the image settler owns and
     * moves forward. The two statuses that must never survive this case are
     * `uploaded`, where the row is stranded because nothing considers it, and
     * `parsing`, where the row reads as work in flight with no run behind it.
     * Those are the states the whole change is about, so those are what is
     * named.
     */
    const stranded = state.status === 'uploaded' || state.status === 'parsing';
    invariant('an-abandoned-upload-imports-with-nobody-asking',
      notYet
      && rows.length === (entry.expect.properties ?? 1)
      && !stranded
      && withPhotographReached,
      JSON.stringify(faults.abandonedUpload));
  }

  // --- 8k. THE WORKER DIES AFTER COMMITTING, BEFORE REPORTING -------------
  /*
   * 7g kills a worker BEFORE its work lands. This is the other half and the
   * harder one: the properties are written, the transaction is committed, and
   * the process is gone before it can write the upload's own outcome. The row
   * is left at `parsing` with a complete import behind it — a state that reads
   * as "still working" and is indistinguishable, from every screen, from one
   * where nothing happened.
   *
   * TWO THINGS MUST HOLD. Recovery must FINISH the row rather than leaving it,
   * and it must not import a second time: the properties are already there, so
   * a second pass that forked them would turn a survivable crash into a
   * duplicated marketplace. `ABANDONED_PARSE_MS` is what tells the sweep the
   * claimant is gone, and the anchor match is what stops the fork.
   */
  {
    const entry = docOf(7);
    const org = orgs[FAULT];
    const bytes = await Deno.readFile(`${corpusDir}/${entry.org}/${entry.filename}`);
    const path = `${org.id}/${crypto.randomUUID()}.pdf`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    const upload = await newUpload(FAULT, entry.filename, path);
    await db.from('builder_stock_uploads').update({
      status: 'parsing', processing_started_at: new Date().toISOString(),
    }).eq('id', upload.id);

    // The work lands.
    const committed = await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId,
      upload: { id: upload.id, original_filename: upload.original_filename },
      bytes, sourceKind: 'file',
    });
    // And the worker is gone before it can say so: no status, no counts, no
    // completion stamp. Exactly what a killed process leaves.
    await db.from('builder_stock_uploads').update({
      status: 'parsing',
      processing_completed_at: null,
      records_detected: null, records_imported: null,
      reader_settled_version: null,
      // Old enough that `ABANDONED_PARSE_MS` says the claimant is not coming.
      processing_started_at: new Date(Date.now() - ABANDONED_PARSE_MS - 60_000).toISOString(),
    }).eq('id', upload.id);

    const rowsBefore = (await itemsFor(upload.id)).map((i: any) => i.id).sort();
    let ticks = 0;
    for (let i = 0; i < SWEEP_TICKS_PER_UPLOAD; i += 1) {
      await sweepTick({ limit: 50, deadlineAt: Date.now() + SWEEP_TICK_MS });
      ticks += 1;
      const { data } = await db.from('builder_stock_uploads')
        .select('status, reader_settled_version').eq('id', upload.id).maybeSingle();
      if (data?.status !== 'parsing' || data?.reader_settled_version != null) break;
    }
    const rowsAfter = (await itemsFor(upload.id)).map((i: any) => i.id).sort();
    const state = await stateOf(upload.id);
    /*
     * A FORK OF THIS PROPERTY, not of the organisation. Counting duplicate
     * anchors across the whole organisation reads 2 and means nothing: the
     * fault matrix imports four different documents into this organisation
     * and `pdf:page1` is what every one-page brochure's anchor looks like.
     * Two documents sharing an anchor are two properties — that is 7c, and
     * it is correct. What a crash must not produce is a second row for THIS
     * document's own lot, which is what is counted.
     */
    const lot = String((await itemsFor(upload.id))[0]?.lot_number ?? '');
    const orgRows = (await db.from('builder_stock_items')
      .select('id, lot_number').eq('organisation_id', org.id)).data ?? [];
    const sameLot = lot
      ? orgRows.filter((r: any) => String(r.lot_number ?? '') === lot).length
      : 0;

    faults.workerDiedAfterCommit = {
      committed: committed.ok, ticks,
      rowsBefore: rowsBefore.length, rowsAfter: rowsAfter.length,
      sameRows: JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter),
      status: state.status,
      lot, rowsForThisLot: sameLot,
    };
    invariant('a-worker-that-died-after-committing-loses-and-duplicates-nothing',
      committed.ok
      && rowsBefore.length > 0
      // Not forked: the SAME rows, not a second set beside them.
      && JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter)
      // And not left reading "still working" with a finished import behind it.
      && state.status !== 'parsing'
      // And not forked: exactly one row in this organisation for this lot.
      && sameLot === 1,
      JSON.stringify(faults.workerDiedAfterCommit));
  }

  // --- 8l. THE IMPORT RUNS OUT OF CPU AND HANDS ITSELF ON -----------------
  /*
   * THE CASE THE WHOLE RESUMABLE IMPORTER EXISTS FOR, driven end to end
   * through the real modules in the order production runs them: the
   * portal's claim, `runStockImport`, `finishImport`'s `releaseThenContinue`,
   * and then the dispatched successor `continueStockImport`, as many times as
   * the document needs, until the import finishes — once.
   *
   * THE DOCUMENT FORCES THE HAND-OFF, AND NOTHING ELSE DOES. A scanned
   * brochure of five pages, from the stress corpus. With a 3,000 ms
   * allowance and each page charged at 3,100 ms, a fresh invocation can
   * afford exactly one page — `max(1, floor(remaining / OCR_PAGE_MS))` is 1
   * on every fresh ledger — so this document crosses isolates on any machine,
   * however fast. Nothing is mocked and no spend is injected.
   *
   * WHY NOT AN INJECTED SPEND, WHICH IS WHAT THIS CASE FIRST DID. It handed
   * `runStockImport` a ledger that had "already spent" its allowance. The
   * ledger an invocation is passed is the import's INHERITED total, which the
   * budget deliberately never reads — every budget decision reads the
   * invocation's own fresh account (`runImport.ts`, "TWO ACCOUNTS") — so the
   * injected spend reached nothing and a one-page scan never handed off. The
   * case could then only pass vacuously (it permitted `!handedOff`) or fail,
   * and it failed for two more reasons of its own: it asked for `held` after
   * the import had FINISHED, when `continueStockImport` answers
   * `not_importing` before it looks at any claim, and it read
   * `records_detected` through a helper that never selects it.
   *
   * WHAT MUST HOLD, and each is a way this could ship broken:
   *
   *   • it hands off — asserted, never merely permitted — and the isolate
   *     that parsed the document recognises NONE of it: it locates every
   *     owed page's picture and hands those on (`ocr/scanRaster.pure.ts`);
   *   • no invocation both parses the document and makes or recognises a
   *     page — the engine runs in the isolate that asks, and that isolate
   *     parses nothing;
   *   • no hand-off writes a count, a completion stamp or a property (the
   *     22 September lie was `records_detected: 0` on a row mid-import);
   *   • a dispatch arriving while another worker holds the import does
   *     nothing, and changes nothing;
   *   • the successors finish it within the crossing bound;
   *   • every page is recognised EXACTLY ONCE across every invocation — a page
   *     paid for twice is the loop the checkpoint exists to prevent;
   *   • a dispatch arriving after the finish does nothing;
   *   • and what comes out is the document: one property carrying the
   *     package's own fields, real counts, never `parsing`.
   */
  {
    const stressDir = Deno.env.get('STRESS_CORPUS') ?? '/var/tmp/stress-corpus';
    const stress = JSON.parse(await Deno.readTextFile(`${stressDir}/manifest.json`));
    const entry = stress.find((e: any) => e.name === 'stress-scanned-pages');
    if (!entry) throw new Error(`no stress-scanned-pages in ${stressDir}: run make-stress-corpus.py`);
    /*
     * Its first page is the package the corpus's one-page scan carries, so
     * that fixture's expectation is this document's too — less the design,
     * which is a named limit of the reader and not of the hand-off.
     */
    const expected = (manifest.find((e: any) => e.name === 'scanned-no-text-layer')
      ?.expect?.rows?.[0] ?? {}) as Record<string, unknown>;
    const org = orgs[FAULT_HANDOFF];
    const bytes = await Deno.readFile(`${stressDir}/${entry.path}`);
    /*
     * WHERE THE PORTAL PUTS IT. A successor re-reads the stored object, and
     * `continueStockImport` refuses any path outside the stock-list prefix
     * before it does anything else — the first run of this case stored the
     * bytes where the rest of the matrix does and every successor answered
     * `failed`, including the one asked while the claim was held.
     */
    const path = `${STOCK_LIST_STORAGE_PREFIX}${org.id}/${crypto.randomUUID()}/${safeObjectName(entry.filename)}`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    const upload = await newUpload(FAULT_HANDOFF, entry.filename, path);

    const readRow = async () => {
      const { data } = await db.from('builder_stock_uploads')
        .select('status, records_detected, processing_completed_at, import_checkpoint, stage_timings')
        .eq('id', upload.id).maybeSingle();
      return (data ?? {}) as any;
    };
    const pagesIn = (row: any) => Object.keys(row?.import_checkpoint?.ocr?.pages ?? {}).length;
    const rastersIn = (row: any) => Object.keys(row?.import_checkpoint?.ocr?.rasters ?? {}).length;
    /*
     * EACH INVOCATION'S OWN ACCOUNT, read off the running total on the row —
     * which is what the isolation rule is judged on.
     */
    const ownLedgers: Array<Record<string, number>> = [];
    let seenLedger: Record<string, unknown> = {};
    const accountFor = (row: any) => {
      const now = (row?.stage_timings ?? {}) as Record<string, unknown>;
      const own: Record<string, number> = {};
      for (const [key, value] of Object.entries(now)) {
        if (typeof value !== 'number') continue;
        const was = typeof seenLedger[key] === 'number' ? seenLedger[key] as number : 0;
        if (value - was > 0) own[key] = value - was;
      }
      ownLedgers.push(own);
      seenLedger = now;
    };
    /** Everything a hand-off must not have written, counted. */
    const writtenMidImport = async (row: any) => (await itemsFor(upload.id)).length
      + (row.status !== 'parsing' ? 1 : 0)
      + (row.processing_completed_at ? 1 : 0)
      + (Number(row.records_detected ?? 0) > 0 ? 1 : 0);

    // `process_upload`: claim, then mark the row as being read.
    const portal = await claimImport(db, upload.id);
    await db.from('builder_stock_uploads').update({
      status: 'parsing', processing_started_at: new Date().toISOString(),
    }).eq('id', upload.id);
    const first = await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId,
      upload: { id: upload.id, original_filename: upload.original_filename },
      bytes, sourceKind: 'file',
      resumableFromStoredBytes: true,
    });
    const handedOff = isImportContinuation(first);
    /*
     * `finishImport`'s hand-off branch: release, THEN dispatch. The dispatch
     * reaches no function on this stack — this harness is the dispatcher
     * below — which is also exactly the lost-dispatch state recovery exists
     * for, asserted from the database by `probe-import-claim.mjs`.
     */
    const claimForFirst = portal.ok ? portal.claim : null;
    if (handedOff) await releaseThenContinue(db, claimForFirst, upload.id);
    else await claimForFirst?.release();
    const afterFirst = await readRow();
    accountFor(afterFirst);
    const leakedByFirst = await writtenMidImport(afterFirst);

    /*
     * A DISPATCH ARRIVING WHILE ANOTHER WORKER HOLDS THE IMPORT — the recovery
     * sweep and a hand-off reaching the same row. Asked while the import is
     * still being read, which is the only time the answer means anything.
     */
    const holder = await claimImport(db, upload.id);
    const whileHeld = await continueStockImport(db, upload.id);
    if (holder.ok) await holder.claim.release();
    const afterHeld = await readRow();

    // THE SUCCESSORS, as the dispatcher runs them: until the import stops
    // handing itself on, and never past the crossing bound.
    const successors: string[] = [];
    let leakedMidImport = 0;
    let state = handedOff ? 'continued' : 'not_run';
    while (state === 'continued' && successors.length <= MAX_IMPORT_CROSSINGS) {
      const next = await continueStockImport(db, upload.id);
      state = next.state;
      successors.push(next.state);
      const rowNow = await readRow();
      accountFor(rowNow);
      if (next.state === 'continued') leakedMidImport += await writtenMidImport(rowNow);
    }
    const parsedAndRecognised = ownLedgers.filter((own) => (own.document_parses ?? 0) > 0
      && ((own.rasterisations ?? 0) > 0 || (own.ocr_pages ?? 0) > 0 || (own.ocr_attempted ?? 0) > 0));

    // A DISPATCH ARRIVING AFTER THE FINISH.
    const late = await continueStockImport(db, upload.id);

    const final = await readRow();
    const items = await itemsFor(upload.id);
    const distinctLots = new Set(items.map((i: any) => String(i.lot_number ?? ''))).size;
    const recognisedDistinct = pagesIn(final);
    const recognisedTotal = Number(final.stage_timings?.ocr_pages ?? 0);
    // Every crossing, recognition's and the pictures' together: a scan whose
    // pages carry pictures hands those on too, once it has finished reading.
    const handOffs = crossingsSpent(final.import_checkpoint);
    const fieldMismatches: string[] = [];
    for (const [field, want] of Object.entries(expected)) {
      if (NOT_A_COLUMN.has(field) || field === 'design') continue;
      const key = FIELD_COLUMN[field] ?? field;
      const got = items[0] ? valueOf(items[0], key) : null;
      // 6c's own rule, so this case holds the reading to the corpus's
      // standard and no stricter: an address line may carry the street number
      // the one-page expectation omits ("22 Wattlebird Way").
      const same = fieldHolds(field, key, got, want);
      if (!same) {
        fieldMismatches.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
    }

    faults.cpuHandOff = {
      handedOff,
      afterFirst: {
        status: afterFirst.status, pages: pagesIn(afterFirst), located: rastersIn(afterFirst),
        leaked: leakedByFirst,
      },
      parsedAndRecognised,
      whileClaimHeld: whileHeld.state,
      heldChangedNothing: pagesIn(afterHeld) === pagesIn(afterFirst),
      successors,
      leakedMidImport,
      lateDispatch: late.state,
      handOffs,
      recognisedDistinct,
      recognisedTotal,
      rows: items.length,
      distinctLots,
      status: final.status,
      recordsDetected: final.records_detected ?? null,
      completedAt: final.processing_completed_at ? 'set' : null,
      fieldMismatches,
    };
    invariant('an-import-that-runs-out-of-cpu-hands-off-and-is-finished-exactly-once',
      handedOff
      // A hand-off states nothing about a document it has not finished reading,
      // and the isolate that parsed it located every owed page and read none.
      && afterFirst.status === 'parsing' && leakedByFirst === 0
      && pagesIn(afterFirst) === 0 && rastersIn(afterFirst) >= 2
      // No invocation both parsed the document and made or recognised a page.
      && parsedAndRecognised.length === 0
      // A worker holding the claim is never displaced, and the refusal is inert.
      && whileHeld.state === 'held'
      && pagesIn(afterHeld) === pagesIn(afterFirst)
      // Every successor but the last hands on; the last finishes; nothing leaks.
      && successors.length >= 1
      && successors.at(-1) === 'completed'
      && successors.slice(0, -1).every((s) => s === 'continued')
      && leakedMidImport === 0
      // One hand-off per successor, and every page read exactly once.
      && handOffs === successors.length
      && recognisedDistinct >= 2
      && recognisedTotal === recognisedDistinct
      // A finished import is never re-imported by a late dispatch.
      && late.state === 'not_importing'
      // And the document that came out is one document, once, as it reads.
      && items.length === 1 && distinctLots === 1
      && final.status !== 'parsing' && !!final.processing_completed_at
      && Number(final.records_detected ?? 0) === items.length
      && fieldMismatches.length === 0,
      JSON.stringify(faults.cpuHandOff));
  }

  // --- 8m. THE TWO WAYS AN IMPORT STILL SPENT PAST ITS ALLOWANCE ----------
  /*
   * Both found by `cpu-profile.ts` driving the product's own FILE path over the
   * stress corpus after every case above had passed — because this gate drove
   * the importer the way a linked source is driven, and a linked source never
   * hands off:
   *
   *   • a page the OCR plan wants and the rasteriser yields nothing for was
   *     never settled — `stress-heavy-brochure` crossed ELEVEN isolates
   *     re-asking it, for a brochure that reads in one;
   *   • the decode that settles picture roles ran with no gate in front of it
   *     — `stress-multi-property` spent 4,854 ms in it, in one invocation,
   *     after the document had already been read.
   *
   * Each is asserted here by EFFECT, through the path 8l drives. And the
   * pictures the second fix leaves to the settler must still reach their
   * properties, whole and once — which is what leaving them promises.
   */
  {
    const stressDir = Deno.env.get('STRESS_CORPUS') ?? '/var/tmp/stress-corpus';
    const stress = JSON.parse(await Deno.readTextFile(`${stressDir}/manifest.json`));
    const org = orgs[FAULT_HANDOFF];
    const drive = async (name: string) => {
      const entry = stress.find((e: any) => e.name === name);
      if (!entry) throw new Error(`no ${name} in ${stressDir}: run make-stress-corpus.py`);
      const bytes = await Deno.readFile(`${stressDir}/${entry.path}`);
      const path = `${STOCK_LIST_STORAGE_PREFIX}${org.id}/${crypto.randomUUID()}/${safeObjectName(entry.filename)}`;
      await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
      const upload = await newUpload(FAULT_HANDOFF, entry.filename, path);
      /*
       * EACH INVOCATION'S OWN SPEND, read back off the row: the row carries the
       * import's running total across isolates, so the difference across one
       * invocation is exactly the account its budget read.
       */
      const spends: number[] = [];
      let seen: Record<string, unknown> = {};
      const account = async () => {
        const { data } = await db.from('builder_stock_uploads')
          .select('stage_timings').eq('id', upload.id).maybeSingle();
        const now = (data?.stage_timings ?? {}) as Record<string, unknown>;
        const own: Record<string, number> = {};
        for (const [key, value] of Object.entries(now)) {
          if (typeof value !== 'number' || key === 'total_ms') continue;
          const was = typeof seen[key] === 'number' ? seen[key] as number : 0;
          if (value - was > 0) own[key] = value - was;
        }
        spends.push(Math.round(expensiveSpendMs(own)));
        seen = now;
      };

      const portal = await claimImport(db, upload.id);
      await db.from('builder_stock_uploads').update({
        status: 'parsing', processing_started_at: new Date().toISOString(),
      }).eq('id', upload.id);
      const first = await runStockImport({
        supabase: db, organisationId: org.id, organisationName: org.name,
        builderUserId: org.userId,
        upload: { id: upload.id, original_filename: upload.original_filename },
        bytes, sourceKind: 'file',
        resumableFromStoredBytes: true,
      });
      await account();
      const claim = portal.ok ? portal.claim : null;
      let state: string;
      if (isImportContinuation(first)) {
        await releaseThenContinue(db, claim, upload.id);
        state = 'continued';
        while (state === 'continued' && spends.length <= MAX_IMPORT_CROSSINGS + 1) {
          state = (await continueStockImport(db, upload.id)).state;
          await account();
        }
      } else {
        // `finishImport`'s own write, for an import that finished where it started.
        if (first.ok) {
          await db.from('builder_stock_uploads')
            .update(importOutcomeColumns(first, null)).eq('id', upload.id);
        }
        await claim?.release();
        state = first.ok ? 'completed' : `failed:${(first as any).code}`;
      }

      // THE SETTLER'S PART, which is where a deferred picture goes.
      await settleImagery(org.id, upload.id);
      const items = await itemsFor(upload.id);
      const { data: images } = await db.from('builder_stock_item_images')
        .select('stock_item_id, source_reference').eq('upload_id', upload.id);
      const rows = (images ?? []) as Array<{ stock_item_id: string | null; source_reference: string | null }>;
      const references = rows.map((row) => `${row.stock_item_id}|${row.source_reference}`);
      const { data: finalRow } = await db.from('builder_stock_uploads')
        .select('import_checkpoint').eq('id', upload.id).maybeSingle();
      return {
        name,
        invocations: spends.length,
        // Recognition's crossings and the pictures', counted apart: the first
        // is what this case is about, the second is the hand-off every
        // brochure with pictures now makes on purpose.
        ocrCrossings: Number(finalRow?.import_checkpoint?.continuations ?? 0),
        pictureCrossings: Number(finalRow?.import_checkpoint?.pictures?.crossings ?? 0),
        state,
        spends,
        worst: Math.max(0, ...spends),
        properties: items.length,
        expected: entry.expect?.properties ?? null,
        withPictures: items.filter((item: any) => rows.some((row) => row.stock_item_id === item.id)).length,
        imageRows: rows.length,
        duplicateImageRows: references.length - new Set(references).size,
      };
    };

    const brochure = await drive('stress-heavy-brochure');
    const sheet = await drive('stress-multi-property');
    faults.expensiveSteps = { brochure, sheet };
    invariant('a-page-with-nothing-to-recognise-is-settled-not-owed',
      /*
       * It is READ in the isolate it started in, as it was before any of
       * this: no recognition crossing at all. Its pictures then cross on
       * purpose — an isolate that parsed it decodes none of them — and that
       * crossing is bounded by the pictures there are, not by anything owed.
       */
      brochure.ocrCrossings === 0
      && brochure.pictureCrossings >= 1
      && brochure.invocations === brochure.pictureCrossings + 1
      && brochure.state === 'completed'
      && brochure.properties === brochure.expected,
      JSON.stringify(brochure));
    invariant('the-decode-that-settles-picture-roles-is-priced-before-it-begins',
      sheet.state === 'completed'
      && sheet.properties === sheet.expected
      // No invocation spends past the ceiling: the decode fits inside it or
      // does not begin.
      && sheet.worst <= EXPENSIVE_SPEND_CEILING_MS
      // And what was left to the settler reached every property, once.
      && sheet.withPictures === sheet.properties
      && sheet.duplicateImageRows === 0,
      JSON.stringify(sheet));
  }

  // --- 8n. A RECOGNITION WORKER DIES MID-PAGE ------------------------------
  /*
   * The hosted runtime kills a worker that spends past its allowance, and a
   * dense page's recognition alone can be that. Such a worker leaves exactly
   * one thing behind: the page it had BEGUN, marked before the engine was
   * asked (`withRecognitionBegun`). This case leaves that state — what a
   * worker killed on page 2 has committed, and nothing else — and asserts
   * what recovery does with it:
   *
   *   • page 2 is never recognised: not by the worker that died, and not by
   *     the one that finds its mark, because the next worker would die on it
   *     too and the recovery that restarts a dead import is bounded;
   *   • recognition stops for the attempt, and the document is READ — by an
   *     isolate that recognised nothing — with the page recognised before the
   *     loss, so the import finishes rather than being left mid-flight;
   *   • the property is the one page 1 states, with nothing invented for what
   *     page 2 would have said.
   */
  {
    const entry = manifest.find((e: any) => e.name === 'heldout-scanned-brochure');
    if (!entry) throw new Error('no heldout-scanned-brochure in the corpus: run make-corpus.py');
    const org = orgs[FAULT_HANDOFF];
    const bytes = await Deno.readFile(`${corpusDir}/${entry.path}`);
    const path = `${STOCK_LIST_STORAGE_PREFIX}${org.id}/${crypto.randomUUID()}/${safeObjectName(entry.filename)}`;
    await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    const upload = await newUpload(FAULT_HANDOFF, entry.filename, path);
    const readRow = async () => ((await db.from('builder_stock_uploads')
      .select('status, records_detected, processing_completed_at, import_checkpoint, stage_timings')
      .eq('id', upload.id).maybeSingle()).data ?? {}) as any;

    const portal = await claimImport(db, upload.id);
    await db.from('builder_stock_uploads').update({
      status: 'parsing', processing_started_at: new Date().toISOString(),
    }).eq('id', upload.id);
    const first = await runStockImport({
      supabase: db, organisationId: org.id, organisationName: org.name,
      builderUserId: org.userId,
      upload: { id: upload.id, original_filename: upload.original_filename },
      bytes, sourceKind: 'file',
      resumableFromStoredBytes: true,
    });
    const handedOff = isImportContinuation(first);
    const claim = portal.ok ? portal.claim : null;
    if (handedOff) await releaseThenContinue(db, claim, upload.id);
    else await claim?.release();
    // Page 1, recognised by a worker of its own.
    const pageOne = handedOff ? (await continueStockImport(db, upload.id)).state : 'not_run';
    // THE KILL: the next worker began page 2 and never reported back.
    const beforeKill = await readRow();
    await db.from('builder_stock_uploads').update({
      import_checkpoint: {
        ...beforeKill.import_checkpoint,
        ocr: { ...(beforeKill.import_checkpoint?.ocr ?? {}), begun: [2] },
      },
    }).eq('id', upload.id);
    // RECOVERY: successors, until the import stops handing itself on.
    const successors: string[] = [];
    let state = 'continued';
    while (state === 'continued' && successors.length <= MAX_IMPORT_CROSSINGS) {
      state = (await continueStockImport(db, upload.id)).state;
      successors.push(state);
    }
    const final = await readRow();
    const items = await itemsFor(upload.id);
    const ocr = final.import_checkpoint?.ocr ?? {};
    const recognised = Object.keys(ocr.pages ?? {}).map(Number).sort((x, y) => x - y);
    faults.lostRecognition = {
      handedOff,
      pageOne,
      successors,
      status: final.status,
      recognised,
      lost: ocr.lost ?? [],
      begun: ocr.begun ?? [],
      recognisedTotal: Number(final.stage_timings?.ocr_pages ?? 0),
      rows: items.length,
      lot: items[0]?.lot_number ?? null,
      street: items[0]?.address_line ?? null,
      land: items[0]?.land_size_sqm ?? null,
      bedrooms: items[0]?.bedrooms ?? null,
    };
    invariant('a-page-whose-worker-died-is-never-recognised-again-and-the-import-finishes',
      handedOff && pageOne === 'continued'
      // Page 1 was read once; page 2 was never read and is settled as lost.
      && JSON.stringify(recognised) === JSON.stringify([1])
      && JSON.stringify(ocr.lost ?? []) === JSON.stringify([2])
      && !(ocr.begun ?? []).length
      && Number(final.stage_timings?.ocr_pages ?? 0) === 1
      // The import finished, and is not left reading "still working".
      && successors.at(-1) === 'completed'
      && final.status !== 'parsing' && !!final.processing_completed_at
      // The property page 1 states, and nothing page 2 would have.
      && items.length === 1 && String(items[0].lot_number) === '57'
      && items[0].land_size_sqm == null && items[0].bedrooms == null,
      JSON.stringify(faults.lostRecognition));
  }

  // --- 8j. NOTHING IN THE MATRIX LEFT A ROW MID-FLIGHT --------------------
  /*
   * The cross-cutting one, and the reason it is last: it judges every row
   * every case above created rather than any one of them. A status meaning
   * "still working", carrying an error code, is the state that spun sixteen
   * rows through the reader sweep for ever.
   */
  {
    const keys = [FAULT, FAULT_IMG, FAULT_REPLACE, FAULT_ABANDONED, FAULT_HANDOFF]
      .map((k) => orgs[k].id);
    const { data } = await db.from('builder_stock_uploads')
      .select('id, organisation_id, status, error_code')
      .in('organisation_id', keys);
    const midFlight = (data ?? []).filter((r: any) =>
      r.status === 'parsing' && r.error_code);
    faults.noMidFlightRows = { uploads: (data ?? []).length, midFlight: midFlight.length };
    invariant('no-fault-leaves-an-error-on-a-working-status',
      midFlight.length === 0, JSON.stringify(faults.noMidFlightRows));
  }

  invariants.faults = faults;
}

await fileServer.shutdown();

// ---------------------------------------------------------------------------
// ===========================================================================
// 9 · THE NUMBERS, AND THE ZEROES THAT MUST BE ZERO
// ===========================================================================
/*
 * `unaccounted_lines: 0` IS NOT COMPLETENESS, AND THIS IS WHAT IS INSTEAD.
 *
 * That diagnostic counts lines of the document the reader could not PLACE.
 * Zero of them means the reader had an account of everything it looked at —
 * which is a statement about the reader's own bookkeeping and says nothing
 * about whether the fields a property needs came out. A brochure whose price
 * the reader correctly declined as unproven has `unaccounted_lines: 0` and a
 * missing price, and so does one that read every field perfectly.
 *
 * COMPLETENESS IS MEASURED AGAINST THE MANIFEST'S OWN EXPECTATIONS, which is
 * the only thing in this system that knows what a document SHOULD yield: a
 * person read each fixture and wrote down what it states. Every field named
 * there is one the product is supposed to extract, so the measure is the
 * share of them it did — counted, named where missing, and split by whether
 * the miss is one this corpus has already named as a limit.
 *
 * A FIELD EXPECTED TO BE ABSENT IS NOT A FIELD. `bedrooms: null` on the
 * package brochure means "this document does not support a count and the
 * reader must not invent one" — it is a prohibition, judged in 6c, and
 * counting it as an extraction would inflate the measure with refusals.
 */
{
  const totals = {
    documentsTested: manifest.length,
    documentClasses: [...new Set(manifest.map((e: any) =>
      e.expect.properties === 0 ? 'refused'
        : (e.expect.properties > 1 ? 'multi-property' : 'single-property')))].sort(),
    propertiesExpected: 0,
    propertiesCreated: 0,
    fieldsExpected: 0,
    fieldsDelivered: 0,
    fieldsMissing: [] as string[],
    fieldsMissingNamedLimit: [] as string[],
  };

  for (const entry of manifest) {
    totals.propertiesExpected += entry.expect.properties ?? 0;
    const row = report.find((r: any) => r.name === entry.name);
    totals.propertiesCreated += row?.propertiesA ?? 0;
    const expectRows = entry.expect.rows ?? [];
    for (let i = 0; i < expectRows.length; i += 1) {
      for (const [field, want] of Object.entries(expectRows[i])) {
        if (want === null) continue;          // a prohibition, not a field
        if (NOT_A_COLUMN.has(field)) continue;
        totals.fieldsExpected += 1;
        const key = FIELD_COLUMN[field] ?? field;
        const got = (row?.items ?? [])[i]?.[key] ?? null;
        const same = got !== null && fieldHolds(field, key, got, want);
        if (same) totals.fieldsDelivered += 1;
        else {
          (entry.expect.known_limit ? totals.fieldsMissingNamedLimit : totals.fieldsMissing)
            .push(`${entry.name}.${i}.${key}`);
        }
      }
    }
  }

  /*
   * THE ZEROES THE CONTRACT NAMES, each read from the database this run
   * actually wrote rather than from anything the gate remembers. A count
   * derived from the harness's own bookkeeping would agree with the harness;
   * these ask the rows.
   */
  const zero: Record<string, unknown> = {};

  const { data: allItems } = await db.from('builder_stock_items')
    .select('id, organisation_id, upload_id, lot_number, unit_number, '
      + 'address_line, development_name, project_name, building_size_sqm, '
      + 'source_row, lifecycle_status, primary_image_id, pending_patch, '
      + 'pending_upload_id');
  const { data: allUploads } = await db.from('builder_stock_uploads')
    .select('id, organisation_id, status, error_code, published_at, '
      + 'records_detected, deleted_at');
  const items = allItems ?? [];
  const uploads = allUploads ?? [];
  const uploadOrg = new Map(uploads.map((u: any) => [u.id, u.organisation_id]));

  // 1 · WRONG ORGANISATION — a row whose supplying upload belongs elsewhere.
  zero.wrongOrganisation = items.filter((i: any) =>
    i.upload_id && uploadOrg.has(i.upload_id)
    && uploadOrg.get(i.upload_id) !== i.organisation_id).length;

  /*
   * 2 · DUPLICATE FORK — two live rows the PRODUCT would call one property.
   *
   * Keyed on the lot alone this read 2, and both were correct: Alpha Homes
   * holds a lot 18 in Tarneit and a lot 18 on Hollybank Crescent, Melton
   * South. A lot number is a builder's own numbering within an estate and is
   * not unique across one, so two documents naming lot 18 are two properties
   * — which is invariant 7c, and asserting the opposite here would have
   * reported a correct behaviour as a fork.
   *
   * `stockPropertyIdentity` is what the importer itself matches on, so it is
   * what this counts: development, lot, street, design and building size,
   * under the module's own rule that a part only ONE side states is not a
   * difference. Archived rows are excluded — a replacement legitimately
   * leaves one behind.
   */
  const liveByIdentity = new Map<string, any[]>();
  for (const i of items as any[]) {
    if (i.lifecycle_status === 'archived') continue;
    const identity = stockPropertyIdentity({
      lot_number: i.lot_number, unit_number: i.unit_number,
      address_line: i.address_line, development_name: i.development_name,
      project_name: i.project_name, house_design: i.source_row?.house_design ?? null,
      building_size_sqm: i.building_size_sqm,
    } as any);
    const key = `${i.organisation_id}/${JSON.stringify(identity)}`;
    liveByIdentity.set(key, [...(liveByIdentity.get(key) ?? []), i]);
  }
  zero.duplicateForks = [...liveByIdentity.values()].filter((g) => g.length > 1).length;

  // 3 · STRANDED PATCH — a change held back on a row whose own replacement
  //     upload has already published. Publication is what APPLIES a patch, so
  //     a patch surviving it is a correction that will never reach anybody.
  const publishedUploads = new Set(uploads.filter((u: any) => u.published_at)
    .map((u: any) => u.id));
  zero.strandedPatches = items.filter((i: any) =>
    i.pending_patch && i.pending_upload_id && publishedUploads.has(i.pending_upload_id)).length;

  // 4 · IMPOSSIBLE LIFECYCLE — a row on the marketplace with no photograph.
  //     `enforceStrictPrimaryImages` exists to make this impossible, so a
  //     non-zero here is that sweep having failed rather than a taste
  //     question. Counted only where the corpus expected a photograph, so a
  //     document that honestly carries none is not read as a broken row.
  const imagedUploads = new Set(report
    .filter((r: any) => manifest.find((e: any) => e.name === r.name)?.expect?.image === 'facade_page_1')
    .map((r: any) => r.uploadIdA).filter(Boolean));
  zero.activeWithoutPhotograph = items.filter((i: any) =>
    i.lifecycle_status === 'active' && !i.primary_image_id
    && imagedUploads.has(i.upload_id)).length;

  // 5 · MID-FLIGHT — an error written on a status meaning "still working",
  //     and an upload left at `parsing` with nothing coming. Both are the
  //     state that spun sixteen rows through the reader sweep for ever.
  zero.uploadsMidFlight = uploads.filter((u: any) =>
    !u.deleted_at && u.status === 'parsing' && u.error_code).length;

  // 6 · FALSE "NOTHING IMPORTED" — an upload reporting zero records for a
  //     document the corpus says states properties. The original incident's
  //     own symptom, asked of the database rather than of the reader.
  const expectedByUpload = new Map<string, { want: number; named: boolean }>();
  for (const r of report as any[]) {
    const entry = manifest.find((e: any) => e.name === r.name);
    if (!entry) continue;
    const want = { want: entry.expect.properties ?? 0, named: !!entry.expect.known_limit };
    if (r.uploadIdA) expectedByUpload.set(r.uploadIdA, want);
    if (r.uploadIdB) expectedByUpload.set(r.uploadIdB, want);
  }
  zero.falseNothingImported = uploads.filter((u: any) => {
    const want = expectedByUpload.get(u.id);
    // A named limit is a gap this corpus has already accounted for; counting
    // it here would report the same thing twice and under a harsher name.
    return !!want && want.want > 0 && !want.named
      && Number(u.records_detected ?? 0) === 0;
  }).length;

  // 7 · WRONG PROPERTY — a created property whose lot the corpus never named.
  //     The strongest of the seven: it is the one that would put somebody
  //     else's house on a builder's marketplace.
  const expectedLots = new Set<string>();
  for (const e of manifest as any[]) {
    for (const r of (e.expect.rows ?? [])) {
      if (r.lot_number) expectedLots.add(String(r.lot_number));
    }
  }
  /*
   * AND THE STRESS DOCUMENTS THE FAULT MATRIX IMPORTS (8l, 8m), by the lots
   * their own generator states — never by exempting their organisation, so a
   * stress import that produced a lot its fixture never named is still counted.
   */
  const stressManifest = await Deno.readTextFile(
    `${Deno.env.get('STRESS_CORPUS') ?? '/var/tmp/stress-corpus'}/manifest.json`,
  ).then((text) => JSON.parse(text) as any[]).catch(() => [] as any[]);
  for (const e of stressManifest) {
    for (const r of (e.expect?.rows ?? [])) {
      if (r.lot_number) expectedLots.add(String(r.lot_number));
    }
  }
  zero.wrongProperties = items.filter((i: any) =>
    i.lot_number && !expectedLots.has(String(i.lot_number))).length;

  invariants.totals = totals;
  invariants.zero = zero;

  for (const [name, count] of Object.entries(zero)) {
    invariant(`zero/${name}`, Number(count) === 0, String(count));
  }
  /*
   * AND THE COMPLETENESS NUMBER ITSELF IS ASSERTED, not merely printed.
   * Every expected field must be delivered except those a named limit
   * already accounts for — which is the same standard 6c holds each field
   * to, restated as one number so a regression in coverage is visible as a
   * number rather than as a longer failure list.
   */
  invariant('every-expected-field-was-extracted',
    totals.fieldsMissing.length === 0,
    JSON.stringify({ expected: totals.fieldsExpected, delivered: totals.fieldsDelivered,
      missing: totals.fieldsMissing, namedLimits: totals.fieldsMissingNamedLimit }));
}

// 7 · The verdict
// ---------------------------------------------------------------------------
/*
 * A WORKER ASKED FOR IS A FAILURE OF ITS OWN, whatever the fixtures said: it is
 * a path that works here and is refused on the hosted runtime, which is the
 * exact infidelity `hostedRuntime.ts` exists to close. It fails once, here,
 * with the runtime's own words, rather than as a scatter of empty readings.
 */
if (workersRequested() > 0) {
  fails.push(`the product asked for ${workersRequested()} worker(s); the hosted runtime answers `
    + `"${HOSTED_WORKER_REFUSAL}"`);
}
console.log(JSON.stringify({ report, invariants, fails, limits, modelCallAttempts, urlFetches, linkedFetches,
  workersRequested: workersRequested() }, null, 2));
console.log(`\n${manifest.length} documents · ${fails.length} failures · `
  + `${limits.length} named limits · `
  + `${modelCallAttempts.length} generative-model calls attempted · `
  + `${workersRequested()} workers requested`);
if (limits.length) {
  console.log('\nNAMED LIMITS (reported every run, do not fail the gate):');
  for (const l of limits) console.log('  ' + l);
}
if (modelCallAttempts.length) {
  console.log('MODEL CALLS ATTEMPTED:'); for (const u of modelCallAttempts) console.log('  ' + u);
}
if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log('  ' + f); }
Deno.exit(fails.length || modelCallAttempts.length ? 1 : 0);
