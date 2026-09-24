/**
 * BUILDER STOCK — THE DISPLAY GATE'S OVERLAY READING, OVER EVERY STORED PICTURE.
 *
 * Read-only, evidence-producing. It answers the question a change to the
 * marketing-overlay detector has to answer before it ships: across every
 * picture this deployment has stored and measured, what does the strict type
 * pass convict, where does each convicted line of type sit, and which pictures
 * would a proposed rule about those lines judge differently?
 *
 * The rule it measures is the one the Lot 54 refusal (24 September 2026)
 * raised: a clean builder render convicted because the kerb and lawn edge
 * across its lower fifth read as a line of type. That run began at the
 * picture's own left edge. Type LAID OVER a photograph is set inside the
 * frame; a band of ink that runs into the frame is the picture's own
 * structure — a kerb, a horizon, a fence line — cut by the crop. So each
 * convicted run is classed as touching a side of the frame or inset, and a
 * picture whose every strict run touches a side is one the rule would change.
 *
 * WHAT IT PRINTS: one line per distinct picture (verdict now, runs and where
 * they sit, flat blocks and whether any is a brand colour, the faint pass),
 * and for every picture the rule would change, the picture itself as a PNG no
 * wider than 360 pixels, so each change is judged by looking at it.
 *
 * WRITES NOTHING. SELECT through the Management API and a storage GET per
 * picture, with the service key read from the same token and never printed.
 */
import {
  decodeThumbnailResult,
} from '../../supabase/functions/_shared/builderStock/sourceImageRaster.ts';
import {
  measureFaintOverlayText, measureFlatColourRegions, overlayTextBoxes, readMarketingOverlay,
} from '../../supabase/functions/_shared/builderStock/marketingOverlay.pure.ts';
import { promotionalRegions } from '../../supabase/functions/_shared/builderStock/overlayPlate.pure.ts';
import { encodePng } from '../../supabase/functions/_shared/builderStock/rasterPng.ts';

const PROJECT_REF = Deno.env.get('PROJECT_REF') || 'htfluofznhxeumblwbww';
const ACCESS_TOKEN = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set — nothing can be read.');
  Deno.exit(1);
}

async function sql(label: string, text: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text }),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`[${label}] query failed ${response.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

async function storageAuth(): Promise<{ base: string; headers: Record<string, string> }> {
  const keys = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  );
  if (!keys.ok) throw new Error(`api-keys: HTTP ${keys.status}`);
  const list = await keys.json() as Array<{ name?: string; type?: string; api_key?: string }>;
  const service = list.find((k) => k?.name === 'service_role' || k?.type === 'secret');
  if (!service?.api_key) throw new Error('api-keys: no service_role key in the response');
  return {
    base: `https://${PROJECT_REF}.supabase.co/storage/v1`,
    headers: { Authorization: `Bearer ${service.api_key}`, apikey: service.api_key },
  };
}

/** One row per distinct picture: the newest stored copy of each set of bytes. */
const pictures = await sql('stored pictures', `
  SELECT DISTINCT ON (coalesce(im.source_detail->>'stored_sha256', im.storage_path))
         im.id, im.storage_bucket, im.storage_path, im.created_at,
         im.source_detail->>'marketplace_eligibility_state' AS state,
         im.source_detail->>'marketplace_rejection_reason' AS reason,
         im.source_detail->>'role' AS role,
         coalesce(im.source_detail->>'stored_sha256', '') AS sha
    FROM public.builder_stock_item_images im
   WHERE im.processing_status = 'ready'
     AND im.storage_path IS NOT NULL
     AND im.source_detail ? 'marketplace_eligibility_state'
   ORDER BY coalesce(im.source_detail->>'stored_sha256', im.storage_path), im.created_at DESC`);

console.log(`OVERLAY AUDIT — ${pictures.length} distinct stored picture(s) with a display verdict\n`);
const storage = await storageAuth();

const pct = (value: number, of: number) => `${Math.round((value / of) * 1000) / 10}%`;
const tally = {
  read: 0, unreadable: 0, convicted: 0, convictedWithRuns: 0,
  runsTouching: 0, runsInset: 0, wouldChange: 0,
};
const changed: string[] = [];

async function showPicture(view: { width: number; height: number; pixels: Uint8Array }) {
  const scale = Math.min(1, 360 / view.width);
  const width = Math.max(1, Math.round(view.width * scale));
  const height = Math.max(1, Math.round(view.height * scale));
  const small = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(view.width - 1, Math.floor(x / scale));
      const sy = Math.min(view.height - 1, Math.floor(y / scale));
      const from = (sy * view.width + sx) * 3;
      small.set(view.pixels.subarray(from, from + 3), (y * width + x) * 3);
    }
  }
  const png = await encodePng(small, { width, height, components: 3 });
  if (!png) return;
  let binary = '';
  for (const byte of png) binary += String.fromCharCode(byte);
  console.log(`    picture ${width}x${height} png base64 BEGIN`);
  console.log(btoa(binary));
  console.log('    picture END');
}

for (const row of pictures) {
  const path = String(row.storage_path);
  const bucket = String(row.storage_bucket || 'builder-stock-images');
  const response = await fetch(
    `${storage.base}/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`,
    { headers: storage.headers },
  );
  const tag = `${String(row.sha || row.id).slice(0, 10)} ${String(row.state)}${row.reason ? `/${row.reason}` : ''}`;
  if (!response.ok) {
    tally.unreadable += 1;
    console.log(`- ${tag}: storage HTTP ${response.status}`);
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoded = await decodeThumbnailResult(bytes);
  if (!decoded.ok) {
    tally.unreadable += 1;
    console.log(`- ${tag}: could not decode (${decoded.reason})`);
    continue;
  }
  tally.read += 1;
  const view = decoded.thumbnail;
  const verdict = readMarketingOverlay(view);
  const runs = overlayTextBoxes(view);
  const blocks = measureFlatColourRegions(view).regions;
  const promotional = promotionalRegions(view, blocks.map((b) => b.box));
  const touching = runs.filter((r) => r.left <= 0 || r.right >= view.width - 1);
  const inset = runs.length - touching.length;
  if (verdict.annotated) tally.convicted += 1;
  if (verdict.annotated && runs.length) tally.convictedWithRuns += 1;
  tally.runsTouching += touching.length;
  tally.runsInset += inset;

  /*
   * THE RULE UNDER MEASUREMENT: a run that reaches a side of the frame is not
   * type. The picture's conviction changes only where every strict run
   * touches a side; what would decide it then is the clearance, which needs
   * no brand-coloured block and no faint line.
   */
  const affected = verdict.annotated && runs.length > 0 && inset === 0;
  const faint = affected ? measureFaintOverlayText(view) : { lineCount: 0 };
  const outcome = !affected
    ? 'unchanged'
    : blocks.length === 0 && faint.lineCount === 0
      ? 'would read CLEAN (no run, no block)'
      : promotional.length > 0
        ? 'still refused (a brand-colour block)'
        : faint.lineCount > 0
          ? 'still refused (faint type)'
          : 'would CLEAR (neutral blocks only)';
  const runText = runs.map((r) =>
    `[x ${pct(r.left, view.width)}–${pct(r.right + 1, view.width)} `
    + `y ${pct(r.top, view.height)}–${pct(r.bottom + 1, view.height)}`
    + `${r.left <= 0 || r.right >= view.width - 1 ? ' TOUCHES' : ''}]`).join(' ');
  console.log(`- ${tag}: annotated=${verdict.annotated} runs=${runs.length} (${touching.length} touching)`
    + ` blocks=${blocks.length} promotional=${promotional.length} → ${outcome}`
    + (runText ? `\n    runs ${runText}` : ''));
  if (affected) {
    tally.wouldChange += outcome.startsWith('would') ? 1 : 0;
    changed.push(`${tag} → ${outcome}`);
    await showPicture(view);
  }
}

console.log('\nSUMMARY');
console.log(`  pictures read ${tally.read}, unreadable ${tally.unreadable}`);
console.log(`  convicted ${tally.convicted}, of which with strict runs ${tally.convictedWithRuns}`);
console.log(`  strict runs touching a side ${tally.runsTouching}, inset ${tally.runsInset}`);
console.log(`  pictures whose verdict the rule would change: ${tally.wouldChange}`);
for (const line of changed) console.log(`    ${line}`);
console.log('\noverlay audit complete (read-only; nothing was written).');
