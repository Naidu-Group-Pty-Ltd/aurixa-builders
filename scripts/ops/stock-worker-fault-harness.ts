/**
 * ===========================================================================
 * ONE SETTLER STEP, WITH THE WORKER REPLACED BY A FAULT.
 * ===========================================================================
 *
 * Driven by `stock-worker-fault-proof.mjs`, never run alone. It performs
 * exactly what `builder-stock-image-settler` does with a claimed item —
 * `settleClaimedItem(...)` then `completeItemWork(...)` with the same
 * arguments — using the SAME shared modules the edge function bundles, against
 * the production database, on ONE synthetic property the driver has already
 * leased to it. The only thing changed is where the heavy-work worker lives:
 * `BUILDER_STOCK_PDF_WORKER_URL` points at a local server that fails in the
 * way the driver names, so what is under test is everything downstream of the
 * worker's answer — the client's classification, the repair's bookkeeping, the
 * item ladder and the completion's backoff.
 *
 * The real client timeout (`HEAVY_WORK_TIMEOUT_MS`, 60 s) is NOT shortened
 * here: a hang waits for it exactly as production would.
 *
 * Usage metering is not configured in this process (no SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY in its environment), so the fault calls write no
 * usage rows. The client is given its credentials explicitly.
 *
 * Prints one line, `FAULT_RESULT {json}`. Never prints a credential.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { settleClaimedItem } from '../../supabase/functions/_shared/builderStock/settleItemImages.ts';
import { completeItemWork, type ClaimedItem } from '../../supabase/functions/_shared/builderStock/itemWorkClaim.ts';
import { newRepairBudget } from '../../supabase/functions/_shared/builderStock/settleImageSanitization.ts';
import {
  WORK_OUTCOME_HEADER, encodeWorkDocument,
} from '../../supabase/functions/_shared/builderStock/heavyWorkWire.pure.ts';

const FAULT = Deno.env.get('FAULT_MODE') ?? '';
const ITEM = JSON.parse(Deno.env.get('FAULT_CLAIMED_ITEM') ?? 'null') as ClaimedItem | null;
const CONCURRENT = Math.max(1, Number(Deno.env.get('FAULT_CONCURRENT') ?? '1') || 1);
const COMPLETE_TWICE = Deno.env.get('FAULT_COMPLETE_TWICE') === '1';
const MODES = new Set(['http500', 'http503', 'reset', 'hang', 'late', 'malformed', 'empty', 'html']);
if (!MODES.has(FAULT) || !ITEM?.id) {
  console.log(`FAULT_RESULT ${JSON.stringify({ error: 'bad invocation' })}`);
  Deno.exit(2);
}

let hits = 0;
let endpoint = '';
const healthyHeader = encodeWorkDocument({ ok: true, transformation: 'overlay_repair', model: null, width: 4, height: 3 });

if (FAULT === 'reset') {
  // A connection the worker drops the moment the request arrives.
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  endpoint = `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`;
  (async () => {
    for await (const conn of listener) {
      hits += 1;
      const buffer = new Uint8Array(1024);
      await conn.read(buffer).catch(() => null);
      try { conn.close(); } catch { /* already gone */ }
    }
  })();
} else {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
    hits += 1;
    await request.arrayBuffer().catch(() => null);
    switch (FAULT) {
      case 'http500': return new Response('worker exploded', { status: 500 });
      case 'http503': return new Response('service unavailable', { status: 503 });
      case 'html':
        return new Response('<!doctype html><title>Worker exceeded resource limits</title>',
          { status: 200, headers: { 'content-type': 'text/html' } });
      case 'malformed': return new Response('not the protocol', { status: 200 });
      case 'empty':
        return new Response(null, { status: 200, headers: { [WORK_OUTCOME_HEADER]: healthyHeader } });
      case 'hang':
        await new Promise(() => {});
        return new Response(null);
      case 'late':
        // A complete, well-formed repair — after the caller has stopped waiting.
        await new Promise((resolve) => setTimeout(resolve, 70_000));
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          { status: 200, headers: { [WORK_OUTCOME_HEADER]: healthyHeader } });
    }
    return new Response('unreachable mode', { status: 500 });
  });
  endpoint = `http://127.0.0.1:${server.addr.port}`;
}

Deno.env.set('BUILDER_STOCK_PDF_WORKER_URL', endpoint);
Deno.env.set('BUILDER_STOCK_PDF_WORKER_TOKEN', 'fault-proof-not-a-real-token');
Deno.env.delete('SUPABASE_URL');
Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');

const db = createClient(Deno.env.get('FAULT_SB_URL') ?? '', Deno.env.get('FAULT_SB_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } });

const startedAt = Date.now();
const settlements = await Promise.all(Array.from({ length: CONCURRENT }, () =>
  settleClaimedItem(db, ITEM, { deadlineAt: Date.now() + 140_000, repairBudget: newRepairBudget() })));
const completions: boolean[] = [];
for (const settlement of settlements) {
  const outcome = {
    nextStage: settlement.nextStage,
    result: settlement.result,
    error: settlement.error ?? null,
    retryAfterSeconds: 0,
    progressed: settlement.progressed,
    failed: settlement.failed === true,
  };
  completions.push((await completeItemWork(db, ITEM.id, outcome)).available);
  if (COMPLETE_TWICE) completions.push((await completeItemWork(db, ITEM.id, outcome)).available);
}
console.log(`FAULT_RESULT ${JSON.stringify({
  hits,
  ms: Date.now() - startedAt,
  completions,
  settlements: settlements.map((s) => ({
    stage: s.stage, nextStage: s.nextStage, progressed: s.progressed, failed: s.failed === true,
    result: s.result, error: s.error ?? null,
  })),
})}`);
Deno.exit(0);
