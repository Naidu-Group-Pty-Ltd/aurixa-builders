/**
 * BUILDER STOCK — ASK THE PDF WORKER TO DO THE WORK THAT DOES NOT FIT HERE.
 *
 * See `heavyWorkWire.pure.ts` for why the overlay repair and the Dropbox
 * folder read are done by the worker. This is the edge's half: where the
 * worker is configured it is asked, and what it answers is taken as the
 * answer; where it is NOT configured the edge does the work itself exactly as
 * it did before, so no deployment loses anything it had.
 *
 * A worker that could not be reached is never an answer about the picture or
 * the folder. The repair reports it as OPERATIONAL (the row is retried after
 * its cooldown and nothing is written about the picture) and the folder
 * reports `unreachable` (retried on the branch's own budget). Neither falls
 * back to doing the work here, because the work is here only where it does
 * not fit, and a fallback that kills the isolate is the failure this exists
 * to end.
 */
import { meteredFetch } from '../meteredFetch.ts';
import { RUNTIME_VERSION } from './runtimeVersion.pure.ts';
import { electionRoute } from './pdfElectionRoute.pure.ts';
import {
  FOLDER_PATH, HEAVY_WORK_TIMEOUT_MS, HERO_PATH, MAX_SANITIZE_BYTES, SANITIZE_PATH,
  WORK_CONTEXT_HEADER, WORK_OUTCOME_HEADER, decodeWorkDocument, encodeWorkDocument,
  type FolderWorkContext,
} from './heavyWorkWire.pure.ts';
import { sanitizeSourceImage, type SanitizeImageOptions, type SanitizeImageResult } from './sanitizeImage.ts';
import type { PackageOutcome } from './packageImages.ts';
import { planHeroFromBytes, type HeroPlanningResult } from './heroPlanning.ts';
import { validateHeroPlan } from './marketplaceHero.pure.ts';

function env(name: string): string {
  try {
    const deno = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno;
    if (deno?.env?.get) return String(deno.env.get(name) ?? '');
    const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return String(node?.env?.[name] ?? '');
  } catch {
    return '';
  }
}

/** The worker, when this deployment has one. The election's own rule decides. */
export function heavyWorkRoute(): { endpoint: string; token: string } | null {
  const route = electionRoute({
    runtimeVersion: RUNTIME_VERSION,
    endpoint: env('BUILDER_STOCK_PDF_WORKER_URL'),
    token: env('BUILDER_STOCK_PDF_WORKER_TOKEN'),
  });
  return route.kind === 'worker' ? { endpoint: route.endpoint, token: route.token } : null;
}

const operational = (detail: string): SanitizeImageResult => ({
  ok: false, reason: 'unusable_input', transformation: null, model: null,
  operational: true, detail,
});

/**
 * The repair the deterministic route may hand to a model. Only these two gate
 * refusals mean "a model could do what the arithmetic would smear"; see
 * `sanitizeSourceImage`.
 */
const GENERATIVE_CASES = new Set(['background_too_detailed', 'too_much_to_rebuild']);

/**
 * Repair a picture on the worker's deterministic route; where that route's
 * gates refuse and a model may be asked, the edge asks it exactly as before.
 */
export async function sanitizeWithCapacity(
  bytes: Uint8Array,
  options: SanitizeImageOptions = {},
): Promise<SanitizeImageResult> {
  const route = heavyWorkRoute();
  if (!route || options.edit) return await sanitizeSourceImage(bytes, options);
  if (!bytes.length || bytes.length > MAX_SANITIZE_BYTES) {
    return await sanitizeSourceImage(bytes, options);
  }

  const remote = await sanitizeOnWorker(bytes, options, route);
  if (remote.ok === false && !remote.operational && GENERATIVE_CASES.has(remote.reason)
    && options.allowGenerative !== false) {
    return await sanitizeSourceImage(bytes, options);
  }
  return remote;
}

async function sanitizeOnWorker(
  bytes: Uint8Array,
  options: SanitizeImageOptions,
  route: { endpoint: string; token: string },
): Promise<SanitizeImageResult> {
  let response: Response;
  try {
    response = await meteredFetch(`${route.endpoint}${SANITIZE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.token}`,
        'content-type': 'application/octet-stream',
        [WORK_CONTEXT_HEADER]: encodeWorkDocument(
          options.repairRegion ? { repairRegion: options.repairRegion } : {}),
      },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(HEAVY_WORK_TIMEOUT_MS),
    });
  } catch (error) {
    return operational(`the image worker could not be reached (${
      String((error as { name?: string })?.name ?? 'error')})`);
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* nothing held */ }
    return operational(`the image worker answered HTTP ${response.status}`);
  }
  const meta = decodeWorkDocument(response.headers.get(WORK_OUTCOME_HEADER)) as
    Record<string, unknown> | null;
  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    return operational('the image worker\'s answer could not be read');
  }
  if (!meta || typeof meta !== 'object' || typeof meta.ok !== 'boolean') {
    return operational('the image worker answered in a shape this deployment does not read');
  }
  if (meta.ok === true) {
    if (!body.length) return operational('the image worker answered a repair with no picture');
    return { ...(meta as object), bytes: body } as SanitizeImageResult;
  }
  const rejected = meta.rejected as { width?: unknown; height?: unknown } | undefined;
  const result = { ...(meta as object) } as Record<string, unknown>;
  delete result.rejected;
  if (rejected && body.length
    && typeof rejected.width === 'number' && typeof rejected.height === 'number') {
    result.rejected = { bytes: body, width: rejected.width, height: rejected.height };
  }
  return result as SanitizeImageResult;
}

/** Read a Dropbox folder for one property on the worker. */
export async function recoverDropboxFolderOnWorker(
  context: FolderWorkContext,
  route: { endpoint: string; token: string },
): Promise<PackageOutcome> {
  // Every refusal built HERE is the worker's transport, never the folder's own
  // answer (that is relayed below as the worker sent it): ours, so a newer
  // runtime may re-ask it. See `recordPackageUnreachable`.
  const unreachable = (detail: string): PackageOutcome =>
    ({ status: 'unreachable', detail, cause: 'worker' } as PackageOutcome);
  let response: Response;
  try {
    response = await meteredFetch(`${route.endpoint}${FOLDER_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.token}`,
        'content-type': 'application/octet-stream',
        [WORK_CONTEXT_HEADER]: encodeWorkDocument(context),
      },
      signal: AbortSignal.timeout(HEAVY_WORK_TIMEOUT_MS + 30_000),
    });
  } catch {
    return unreachable('The folder reader could not be reached, so that Dropbox folder was not read.');
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* nothing held */ }
    return unreachable(`The folder reader answered HTTP ${response.status}, so that Dropbox folder was not read.`);
  }
  const meta = decodeWorkDocument(response.headers.get(WORK_OUTCOME_HEADER)) as
    Record<string, unknown> | null;
  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    return unreachable('The folder reader\'s answer could not be read.');
  }
  const status = meta?.status;
  if (status === 'recovered_photograph' || status === 'recovered') {
    const key = status === 'recovered' ? 'image' : 'photograph';
    const carried = meta?.[key] as Record<string, unknown> | undefined;
    if (!carried || typeof carried !== 'object' || !body.length) {
      return unreachable('The folder reader answered a picture with no picture.');
    }
    return { status, [key]: { ...carried, bytes: body } } as unknown as PackageOutcome;
  }
  if (status === 'not_identified' || status === 'unreachable') {
    return { ...(meta as object) } as PackageOutcome;
  }
  return unreachable('The folder reader answered in a shape this deployment does not read.');
}

/**
 * A HERO PLAN for these bytes — on the heavy-work worker where one is
 * configured, inline otherwise (local runs and tests). Presentation only:
 * every failure is an answer, `{ ok: false, operational: true }` for anything
 * about the worker rather than the picture, and none is ever thrown.
 *
 * The worker's plan is re-checked HERE by the same validator the planner
 * obeys, because a plan is a claim about pixels and this is the boundary a
 * malformed one would cross into the database.
 */
export type HeroPlanningAnswer = HeroPlanningResult | { ok: false; reason: 'worker'; operational: true; detail: string };

export async function planHeroWithCapacity(
  bytes: Uint8Array,
  options: { proof?: boolean } = {},
): Promise<HeroPlanningAnswer> {
  const route = heavyWorkRoute();
  if (!route) return await planHeroFromBytes(bytes, options);
  const failed = (detail: string): HeroPlanningAnswer => ({ ok: false, reason: 'worker', operational: true, detail });
  if (!bytes.length || bytes.length > MAX_SANITIZE_BYTES) return failed(`picture of ${bytes.length} bytes not sent`);
  let response: Response;
  try {
    response = await meteredFetch(`${route.endpoint}${HERO_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.token}`,
        'content-type': 'application/octet-stream',
        [WORK_CONTEXT_HEADER]: encodeWorkDocument(options.proof ? { proof: true } : {}),
      },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(HEAVY_WORK_TIMEOUT_MS),
    });
  } catch (error) {
    return failed(`the image worker could not be reached (${String((error as { name?: string })?.name ?? 'error')})`);
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* nothing held */ }
    return failed(`the image worker answered HTTP ${response.status}`);
  }
  const meta = decodeWorkDocument(response.headers.get(WORK_OUTCOME_HEADER)) as Record<string, unknown> | null;
  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    return failed('the image worker\'s answer could not be read');
  }
  if (!meta || typeof meta.ok !== 'boolean') return failed('the image worker answered in a shape this deployment does not read');
  if (meta.ok === false) return meta as unknown as HeroPlanningResult;
  if (!validateHeroPlan(meta.plan)) return failed('the image worker answered a plan that does not validate');
  const tile = meta.tile as { width?: unknown; height?: unknown } | null;
  const tileOk = tile && typeof tile.width === 'number' && typeof tile.height === 'number'
    && body.length === tile.width * tile.height * 3;
  return {
    ok: true, plan: meta.plan,
    tile: tileOk ? { width: tile!.width as number, height: tile!.height as number, pixels: body } : null,
  };
}
