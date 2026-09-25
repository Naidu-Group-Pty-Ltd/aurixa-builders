/**
 * BUILDER STOCK — THE FIGURE READER.
 *
 * Reads owed properties' figures from their own brochures, one claimed
 * property at a time, until the budget runs out. See `documentFigures.ts` for
 * the work and `brochureFigures.pure.ts` for what a brochure may say.
 *
 * WHY A FUNCTION OF ITS OWN. The image settler is the most carefully tuned
 * path in this product, and nothing about which picture a card draws should
 * move because a figure is being read. So this is dispatched by its own
 * self-unscheduling tick (`builder_stock_document_figures_tick`), armed when a
 * property's image work settles, and shares no claim, lease or budget with
 * the ladder.
 *
 * SECURITY. Internal callers only, through the signed envelope
 * (`verifyInternal`), with the body bounded first. It holds a service-role
 * client and crosses organisations, so a portal session must never reach it.
 * It writes `document_figures` and fills only EMPTY figure columns, through
 * `record_builder_stock_document_figures`; it creates, deletes and publishes
 * nothing and touches no price, availability, image, status or linkage.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { readOwedDocumentFigures } from '../_shared/builderStock/documentFigures.ts';

const corsHeaders = createCorsHeaders();
const MAX_BODY_BYTES = 4 * 1024;
/** Wall clock for one invocation, well inside the edge ceiling. */
const BUDGET_MS = 100_000;
/** Each property costs a fetch, a worker read and at most a few recognitions. */
const MAX_ITEMS_PER_INVOCATION = 6;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.error;
  const gate = await verifyInternal(supabase, req, bounded.raw);
  if (!gate.ok) return json({ error: 'Forbidden' }, 403);

  const startedAt = Date.now();
  try {
    const run = await readOwedDocumentFigures(supabase, {
      maxItems: MAX_ITEMS_PER_INVOCATION,
      deadlineAt: startedAt + BUDGET_MS,
    });
    console.info('[builder-stock-figure-reader] tick', {
      read: run.read, filled: run.filled, ms: Date.now() - startedAt,
    });
    return json({ success: true, read: run.read, filled: run.filled });
  } catch (error) {
    console.error('[builder-stock-figure-reader] failed', {
      error: String((error as Error)?.message ?? error).slice(0, 300),
    });
    return json({ success: false, error: 'figure_read_failed' }, 500);
  }
});
