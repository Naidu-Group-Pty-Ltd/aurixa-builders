/**
 * ===========================================================================
 * THE LANGUAGE DATA IS FETCHED ONCE PER ISOLATE, FROM THIS PROJECT'S OWN
 * STORAGE, AND ITS ABSENCE IS A NAMED REFUSAL.
 * ===========================================================================
 *
 * `languageSource.pure.ts` carries why it is there rather than in the module
 * graph — a 413 on the deploy, measured, that left the two most important
 * functions on the previous build. This module is the reader.
 *
 * THREE RULES.
 *
 * ONCE PER ISOLATE, AND ONCE ONLY. The first invocation that meets a scan
 * downloads 2.95 MB and writes it to `/tmp`; every later one on the same
 * isolate stats the file and returns. `resolved` caches the ANSWER including
 * the negative one, so a deployment with no object does not re-download
 * nothing on every page of every document.
 *
 * WHAT ARRIVED IS CHECKED, NEVER TRUSTED. A truncated download and a wrong
 * object both produce an engine that reads badly rather than one that fails,
 * and a bad reading is the one outcome this subsystem must not produce. The
 * byte count is asserted against the measured constant, so anything else is
 * `null` — no model, no recognition, a scan refused honestly.
 *
 * NULL IS A REAL ANSWER. The caller has one: a document whose text could not
 * be recognised is a document with no text, which this pipeline already
 * refuses in words a builder can act on. It must never become a guess.
 */
import {
  languageBytesAreExpected, OCR_ASSET_BUCKET, OCR_LANGUAGE_KEY,
} from './languageSource.pure.ts';

/** Where the model is written, once per isolate. */
const LANG_DIR = '/tmp/ocr-lang';
const LANG_FILE = `${LANG_DIR}/eng.traineddata.gz`;

/** How long the download may take before the capability declines. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

let resolved: string | null | undefined;

/**
 * The project's own storage, read with the service role every edge function
 * already holds. No third party, no new credential, no outbound egress to
 * anywhere this deployment does not already talk to.
 */
async function downloadModel(): Promise<Uint8Array | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${url.replace(/\/+$/, '')}/storage/v1/object/${OCR_ASSET_BUCKET}/${OCR_LANGUAGE_KEY}`,
      {
        headers: { Authorization: `Bearer ${key}`, apikey: key },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      /*
       * A 404 is "this deployment has not shipped the model", which is a
       * configuration fact, and anything else is a fault. Both refuse, and
       * both say which in the log — an operator sent to re-run a deploy and
       * an operator sent to look at storage are different people.
       */
      console.warn('[builderStock] ocr model unavailable', {
        phase: 'ocr_language', status: response.status,
        bucket: OCR_ASSET_BUCKET, key: OCR_LANGUAGE_KEY,
      });
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.warn('[builderStock] ocr model could not be fetched', {
      phase: 'ocr_language',
      message: String((error as { message?: string })?.message ?? error).slice(0, 160),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The directory holding `eng.traineddata.gz`, or null where the model could
 * not be provided.
 */
export async function languageDataDirectory(): Promise<string | null> {
  if (resolved !== undefined) return resolved;
  try {
    // Already written by an earlier invocation on this isolate.
    const stat = await Deno.stat(LANG_FILE).catch(() => null);
    if (stat?.isFile && stat.size > 1_000_000) {
      resolved = LANG_DIR;
      return resolved;
    }

    const bytes = await downloadModel();
    if (!languageBytesAreExpected(bytes)) {
      if (bytes?.length) {
        // Reached something, and it is not what the thresholds were measured
        // against. Refusing is the only safe answer: a wrong model reads.
        console.warn('[builderStock] ocr model is not the measured one', {
          phase: 'ocr_language', bytes: bytes.length,
        });
      }
      resolved = null;
      return resolved;
    }
    await Deno.mkdir(LANG_DIR, { recursive: true });
    await Deno.writeFile(LANG_FILE, bytes!);
    resolved = LANG_DIR;
    return resolved;
  } catch {
    resolved = null;
    return resolved;
  }
}

/** For tests and the import log: can this deployment read a scan at all? */
export async function languageDataAvailable(): Promise<boolean> {
  return (await languageDataDirectory()) !== null;
}
