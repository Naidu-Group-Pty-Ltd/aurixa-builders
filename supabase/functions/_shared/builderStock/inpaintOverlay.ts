/**
 * Builder stock — asking OUR OWN worker to rebuild what a badge was covering.
 *
 * THE ONLY VISUAL INPUT IS THE BUILDER'S OWN FILE FOR THAT PROPERTY. Not a
 * reference photograph, not another facade, not a rendering of a house, not a
 * search result, not a stock image, not a second example of "what a roof looks
 * like". One image goes into each request — a square cut out of that property's
 * own primary image — with a mask marking the graphic to remove. There is no
 * conditioning image parameter anywhere in this file and there must never be
 * one.
 *
 * AND IT DOES NOT REGENERATE THE PICTURE. The worker's answer is used at the
 * mask and discarded everywhere else: `compositePatch` writes only where
 * `blendWeights` is non-zero, and `outsidePermittedRegionUnchanged` then checks
 * the whole frame against the bytes that came out of storage. A response that
 * came back re-lit, re-framed or with a different house on it changes nothing
 * outside the badge, because nothing outside the badge is ever read from it.
 *
 * THE WORKER IS PRIVATE AND OURS, AND THAT IS THE POINT OF THIS FILE'S
 * SECOND LIFE. The first version of this transport posted each patch to
 * OpenAI's image-edit endpoint on a forwarded vendor key — a per-image bill
 * on somebody else's credit, and a whole production outage the day that
 * account ran dry (the settler's log still documents the 429s). The endpoint
 * is now `cloudflare/builder-stock-image-worker/`, a Cloudflare Worker THIS
 * repository ships, which runs the repair on Cloudflare Workers AI through
 * the account's own AI binding: no third-party generative API, no Docker and
 * no server of any kind, and there is no OpenAI URL, key or model name
 * anywhere in the Builder Stock path — a test reads this file's source and
 * fails if one comes back. This transport sends an image and a mask and
 * nothing else; the instruction the model needs is a pinned constant in the
 * worker's own reviewed source (a request carrying one is refused), so there
 * is no instruction string here for anyone to soften and no way to ask for a
 * nicer house than the one that was photographed.
 *
 * WHAT THIS FILE MAY REFUSE, and every one of them is recorded rather than
 * swallowed: no worker configured, a worker that errors or times out, a
 * response that is not an image, an image that will not decode, a patch count
 * that says this is a marketing tile rather than a photograph, and a result
 * the gate rejects. In none of those cases does anything else become the
 * card's picture — and an unreachable worker is an OPERATIONAL fault the
 * settler retries, never a verdict about the photograph.
 *
 * The call still goes through `meteredFetch`, exactly as the WeasyPrint and
 * PDF-parse sidecars do: the service token is the workspace's own, so Mission
 * Control rates the usage at nothing, but the call is still visible in the
 * usage ledger instead of being untracked spend.
 */
import { meteredFetch } from '../meteredFetch.ts';
import { decodeFullRaster } from './sourceImageRaster.ts';
import { encodePng } from './rasterPng.ts';
import {
  blendWeights, compositePatch, cropMask, cropRgb, outsidePermittedRegionUnchanged,
  permittedShare, planInpaintPatches, resampleRgb,
} from './inpaintOverlay.pure.ts';
import { MAX_REPAIRED_SHARE } from './repairRegion.pure.ts';

/**
 * The model, named for the derivative record.
 *
 * The worker states what it actually ran in an `x-inpaint-model` header and
 * that value wins when present; this constant is the fallback, and the value
 * recorded when a test injects `edit`. It is the Cloudflare Workers AI
 * catalog's dedicated masked-inpainting model, pinned in the worker's own
 * source — run on Cloudflare's infrastructure through the AI binding, no
 * per-image vendor bill.
 */
export const INPAINT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-inpainting';
/**
 * What the worker works at, whatever it is sent.
 *
 * 512 is the inpainting model's own native edge, so a patch resampled to this
 * size goes through the model with no second resize on the other side. The
 * patch geometry is unchanged from the 1024 the previous endpoint imposed:
 * squares are still planned, merged and gated exactly as before, and only the
 * wire size moved.
 */
const EDGE = 512;
/** One request's ceiling. Four patches must fit inside the settler's budget. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Where the worker answers. Named here and nowhere else. */
const WORKER_INPAINT_PATH = '/v1/inpaint';

export type InpaintResult =
  | {
    ok: true;
    pixels: Uint8Array;
    width: number;
    height: number;
    repairedShare: number;
    regionsRemoved: number;
    model: string;
  }
  | {
    ok: false;
    reason: 'inpaint_unavailable' | 'inpaint_failed' | 'validation_failed'
      | 'nothing_to_remove' | 'too_many_regions' | 'uncoverable'
      | 'too_much_to_rebuild';
    detail: string;
  };

export interface InpaintInput {
  width: number;
  height: number;
  /** The builder's own pixels, RGB, at the size they were supplied. */
  pixels: Uint8Array;
  /** The grown overlay mask, at that same size. */
  mask: Uint8Array;
  /** Injected in tests. Production passes nothing and the real worker runs. */
  edit?: (image: Uint8Array, mask: Uint8Array) => Promise<Uint8Array | null>;
}

/**
 * An environment read that works under Deno and under the test runner.
 *
 * Deno first, because that is production; `process.env` second, so the
 * transport itself — which host is called, what is refused, what travels in
 * the request — is exercisable under vitest rather than only in an edge
 * deploy. Anything unreadable is '', which the caller reports as
 * `inpaint_unavailable`: fail closed, never fail loud.
 */
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

/**
 * Build the mask the worker wants: WHITE where the graphic is, BLACK where the
 * photograph must be left alone.
 *
 * This is the inpainting model's own convention, and it is deliberately not an
 * alpha channel: a mask a human opens during a debug reads exactly as what it
 * describes, and there is no colour channel for a decoder to misread.
 */
async function maskPng(patchMask: Uint8Array, size: number): Promise<Uint8Array | null> {
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const value = patchMask[i] ? 255 : 0;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value;
    rgb[i * 3 + 2] = value;
  }
  return await encodePng(rgb, { width: size, height: size, components: 3 });
}

/** A header value recorded as provenance: short, printable, or ignored. */
function reportedModel(headers: Headers): string | null {
  const raw = headers.get('x-inpaint-model');
  if (!raw) return null;
  const value = raw.trim().slice(0, 120);
  return /^[\w@:./+-]+$/.test(value) ? value : null;
}

/**
 * One call to the internal worker. Returns the patch's RGB pixels at `EDGE`,
 * or why not.
 *
 * `unavailable` is true only where the DEPLOYMENT has no worker at all — no
 * URL configured — which the caller reports as `inpaint_unavailable`. A worker
 * that is configured and cannot be reached, refuses, or answers nonsense is
 * `inpaint_failed`; the settler treats both as operational, so neither one is
 * ever written down as a verdict about the photograph.
 */
async function callWorker(
  imagePng: Uint8Array, maskBytes: Uint8Array,
): Promise<{ pixels: Uint8Array; model: string | null } | { error: string; unavailable?: boolean }> {
  const base = env('BUILDER_STOCK_IMAGE_WORKER_URL').trim().replace(/\/+$/, '');
  if (!base) {
    return {
      error: 'no internal image worker is configured for overlay inpainting',
      unavailable: true,
    };
  }
  // Quotes are stripped for the same reason the WeasyPrint client strips them:
  // a secret pasted into the dashboard with its quotes produces a bearer token
  // that is silently wrong.
  const token = env('BUILDER_STOCK_IMAGE_WORKER_TOKEN')
    .trim().replace(/^["']+|["']+$/g, '');

  const form = new FormData();
  form.append('image', new Blob([imagePng as unknown as BlobPart], { type: 'image/png' }),
    'image.png');
  form.append('mask', new Blob([maskBytes as unknown as BlobPart], { type: 'image/png' }),
    'mask.png');

  let response: Response;
  try {
    response = await meteredFetch(`${base}${WORKER_INPAINT_PATH}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, {
      secretName: 'BUILDER_STOCK_IMAGE_WORKER_TOKEN',
      feature: 'builder-stock/overlay-inpaint',
      metadata: { purpose: 'marketing_overlay_removal' },
    });
  } catch (error) {
    return { error: `the image worker could not be reached (${String(error).slice(0, 120)})` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      error: `the image worker refused the request (${response.status}) ${body.slice(0, 160)}`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { error: 'the image worker returned something that was not a result' };
  }
  const raster = await decodeFullRaster(bytes);
  if (!raster) return { error: 'the returned image could not be decoded' };
  // Whatever size came back, the patch is square and so is this.
  const pixels = raster.width === EDGE && raster.height === EDGE
    ? raster.pixels
    : resampleRgb(raster.pixels, raster.width, raster.height, EDGE, EDGE);
  return { pixels, model: reportedModel(response.headers) };
}

/**
 * Take the graphic off with the internal worker, patch by patch, or say why
 * not.
 *
 * The composite is cumulative across patches — each one is laid onto the result
 * of the last — and the gate runs ONCE at the end against the untouched
 * original, so a fault in any patch fails the whole repair. There is no partial
 * success: a photograph with one of its two badges removed still has marketing
 * on it, and serving it would be the exact defect this replaces.
 */
export async function inpaintOverlay(input: InpaintInput): Promise<InpaintResult> {
  const { width, height, pixels, mask } = input;
  if (width <= 0 || height <= 0 || pixels.length < width * height * 3
    || mask.length !== width * height) {
    return { ok: false, reason: 'validation_failed', detail: 'the image and its mask disagree' };
  }

  const { patches, tooMany, uncovered } = planInpaintPatches(mask, width, height);
  if (uncovered) {
    /*
     * A graphic no square patch can contain without leaving the frame — a
     * banner across the full width of a landscape photograph, say. Refused
     * rather than partly removed: the alternative is a picture with one badge
     * gone and one still on it, handed over as clean.
     */
    return {
      ok: false,
      reason: 'uncoverable',
      detail: 'the graphic cannot be isolated inside the picture without leaving part of it',
    };
  }
  if (tooMany) {
    return {
      ok: false,
      reason: 'too_many_regions',
      detail: 'the picture carries more separate graphics than a photograph with a badge on it',
    };
  }
  if (!patches.length) {
    return { ok: false, reason: 'nothing_to_remove', detail: 'the mask marks nothing' };
  }

  const weights = blendWeights(mask, width, height);

  /*
   * BARRIER B, AND IT IS CHECKED BEFORE THE FIRST MODEL CALL.
   *
   * `weights` is the whole of what the repair may write and the whole of what
   * the integrity gate below then skips, so it is the only honest measure of
   * how much photograph is at stake. Left unbounded it is also the way every
   * other guarantee here quietly empties: at full coverage
   * `outsidePermittedRegionUnchanged` compares no pixels at all and returns
   * `changed: 0`, which reads as a pass. The gate does not fail on a
   * whole-frame edit — it has nothing left to fail on.
   *
   * Refused here rather than after the fact for two reasons. Nothing is spent:
   * a request too large to be a badge never reaches Workers AI. And the answer
   * is deterministic in the picture's own geometry, so the settler records it
   * as a terminal `too_much_to_rebuild` and the row is not retried into the
   * same refusal for ever.
   *
   * WHAT THIS DOES NOT ESTABLISH: that the permitted set is the RIGHT set. A
   * wrong mask inside the ceiling passes here and passes the integrity gate,
   * which inspects only the pixels outside it. Correctness of the region is
   * `overlayPlate.pure.ts`'s burden — every plate held to its own text.
   */
  const permitted = permittedShare(weights, width, height);
  if (permitted > MAX_REPAIRED_SHARE) {
    return {
      ok: false,
      reason: 'too_much_to_rebuild',
      detail: `the repair would rebuild ${(permitted * 100).toFixed(1)}% of the picture, `
        + `and no repair may rebuild more than ${(MAX_REPAIRED_SHARE * 100).toFixed(0)}%`,
    };
  }

  let masked = 0;
  for (let i = 0; i < mask.length; i++) masked += mask[i];

  let model: string | null = null;
  let working = pixels;
  for (const patch of patches) {
    const patchPixels = cropRgb(working, width, patch, height);
    const patchMask = cropMask(mask, width, patch, height);

    const upPixels = resampleRgb(patchPixels, patch.size, patch.size, EDGE, EDGE);
    const upMask = new Uint8Array(EDGE * EDGE);
    for (let y = 0; y < EDGE; y++) {
      const sy = Math.min(patch.size - 1, Math.floor(y * patch.size / EDGE));
      for (let x = 0; x < EDGE; x++) {
        const sx = Math.min(patch.size - 1, Math.floor(x * patch.size / EDGE));
        upMask[y * EDGE + x] = patchMask[sy * patch.size + sx];
      }
    }

    let returned: Uint8Array | null = null;
    if (input.edit) {
      returned = await input.edit(upPixels, upMask);
      if (!returned) {
        return { ok: false, reason: 'inpaint_failed', detail: 'the image worker returned nothing' };
      }
    } else {
      const imagePng = await encodePng(upPixels, { width: EDGE, height: EDGE, components: 3 });
      const maskBytes = await maskPng(upMask, EDGE);
      if (!imagePng || !maskBytes) {
        return {
          ok: false, reason: 'inpaint_failed', detail: 'the request could not be encoded',
        };
      }
      const answer = await callWorker(imagePng, maskBytes);
      if ('error' in answer) {
        return {
          ok: false,
          reason: answer.unavailable ? 'inpaint_unavailable' : 'inpaint_failed',
          detail: answer.error,
        };
      }
      returned = answer.pixels;
      model = answer.model ?? model;
    }

    if (returned.length < EDGE * EDGE * 3) {
      return {
        ok: false, reason: 'inpaint_failed', detail: 'the returned patch was the wrong size',
      };
    }
    const down = resampleRgb(returned, EDGE, EDGE, patch.size, patch.size);
    working = compositePatch(working, width, height, patch, down, weights);
  }

  /*
   * THE GATE, against the bytes this began with rather than against the last
   * intermediate. See `outsidePermittedRegionUnchanged`: zero is the only
   * passing answer, and there is no tolerance to relax.
   */
  const gate = outsidePermittedRegionUnchanged(pixels, working, weights);
  if (!gate.ok) {
    return {
      ok: false,
      reason: 'validation_failed',
      detail: `${gate.changed} pixels outside the permitted area were altered`,
    };
  }
  if (working.length !== pixels.length) {
    return { ok: false, reason: 'validation_failed', detail: 'the frame size changed' };
  }

  return {
    ok: true,
    pixels: working,
    width,
    height,
    repairedShare: masked / (width * height),
    regionsRemoved: patches.length,
    model: model ?? INPAINT_MODEL,
  };
}
