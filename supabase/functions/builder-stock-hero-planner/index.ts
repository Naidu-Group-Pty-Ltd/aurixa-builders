/**
 * builder-stock-hero-planner — the Marketplace Hero Standard's own function.
 *
 * ISOLATED ON PURPOSE. Hero planning is presentation: it decides how a card
 * FRAMES a picture the stock pipeline has already chosen, judged and served.
 * So it is not a phase of the image settler and holds none of its claims,
 * leases or queues — it runs on its own clock (`builder-stock-hero-planner-
 * 10min`), and a failure here, of any kind, leaves every card drawn exactly as
 * before and every property exactly as published. See
 * `_shared/builderStock/settleMarketplaceHero.ts`.
 *
 * Signed internal callers only (`verifyInternal`). Every answer is counts and
 * storage paths: no picture, no address and no customer field is returned.
 *
 *   plan      (default) plan what is owed, a few pictures a tick
 *   census    where every candidate stands, per organisation and lifecycle
 *   evaluate  plan a slice FRESH and store nothing — aggregate numbers only
 *   proof     the private before/after sheet (`heroProof.ts`)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { createCorsHeaders } from '../_shared/auth.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import {
  heroStanding, readHeroCandidates, readServedBytes, settleMarketplaceHero, type HeroStanding,
} from '../_shared/builderStock/settleMarketplaceHero.ts';
import { drawHeroProof } from '../_shared/builderStock/heroProof.ts';
import { planHeroWithCapacity } from '../_shared/builderStock/heavyWorkClient.ts';
import { heroPlanOfImage, servedObjectOf } from '../_shared/builderStock/primaryImage.ts';
import { HERO_PLAN_VERSION, type HeroPlan } from '../_shared/builderStock/marketplaceHero.pure.ts';

const corsHeaders = createCorsHeaders();
const BUDGET_MS = 110_000;
const MAX_BODY_BYTES = 4 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

/** Aggregate numbers over a set of plans — the only shape that leaves. */
function summarise(plans: HeroPlan[]) {
  const by = { original: 0, crop: 0, fit: 0 } as Record<string, number>;
  const reasons: Record<string, number> = {};
  let cropArea = 0, cropped = 0, shareSum = 0, shareN = 0, inTarget = 0;
  for (const plan of plans) {
    by[plan.mode] += 1;
    for (const reason of plan.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (plan.mode === 'crop') { cropped += 1; cropArea += plan.measures.cropAreaShare; }
    if (plan.measures.focalWidthShare !== null) {
      shareSum += plan.measures.focalWidthShare; shareN += 1;
      if (plan.measures.focalWidthShare >= 0.55 && plan.measures.focalWidthShare <= 0.9) inTarget += 1;
    }
  }
  return {
    analysed: plans.length, by_mode: by, reasons,
    rejected_because_subject_would_be_cut: (reasons.subject_wider_than_frame ?? 0)
      + (reasons.subject_taller_than_frame ?? 0) + (reasons.subject_does_not_fit_frame ?? 0),
    mean_crop_area_share: cropped ? Math.round((cropArea / cropped) * 1000) / 1000 : null,
    mean_focal_width_share: shareN ? Math.round((shareSum / shareN) * 1000) / 1000 : null,
    focal_share_in_55_90: inTarget,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.error;
  const gate = await verifyInternal(supabase, req, bounded.raw);
  if (!gate.ok) return json({ error: 'Forbidden' }, 403);

  let body: Record<string, unknown> = {};
  try { body = bounded.raw ? JSON.parse(bounded.raw) : {}; } catch { body = {}; }
  const operation = String(body.operation ?? 'plan');
  const includeArchived = body.include_archived === true;
  const deadlineAt = Date.now() + BUDGET_MS;

  try {
    if (operation === 'census') {
      const groups = await readHeroCandidates(supabase, { includeArchived });
      const now = Date.now();
      const rows: Record<string, Record<HeroStanding | 'items' | 'images' | 'primaries_planned', number>> = {};
      const modes: Record<string, number> = {};
      for (const { item, images } of groups) {
        const key = `${String(item.organisation_id).slice(0, 8)}:${item.lifecycle_status}`;
        const row = rows[key] ??= {
          items: 0, images: 0, primaries_planned: 0,
          planned: 0, owed: 0, cooling_down: 0, exhausted: 0, no_fingerprint: 0,
        };
        row.items += 1;
        for (const image of images) {
          row.images += 1;
          row[heroStanding(image, now)] += 1;
          if (image.id === item.primary_image_id) {
            const plan = heroPlanOfImage(image as never);
            if (plan) { row.primaries_planned += 1; modes[plan.mode] = (modes[plan.mode] ?? 0) + 1; }
          }
        }
      }
      return json({ success: true, operation, version: HERO_PLAN_VERSION, by_organisation: rows, primary_modes: modes });
    }

    if (operation === 'evaluate') {
      const offset = Math.max(0, Number(body.offset ?? 0) || 0);
      const limit = Math.max(1, Math.min(25, Number(body.limit ?? 12) || 12));
      const groups = (await readHeroCandidates(supabase, { includeArchived }))
        .filter(({ item }) => !body.lifecycle || item.lifecycle_status === body.lifecycle)
        .slice(offset, offset + limit);
      const plans: HeroPlan[] = [];
      let failed = 0, stoppedForTime = false, derivative = 0;
      for (const { images } of groups) {
        if (Date.now() > deadlineAt) { stoppedForTime = true; break; }
        const served = await readServedBytes(supabase, images[0]);
        if (served.ok === false) { failed += 1; continue; }
        const answer = await planHeroWithCapacity(served.bytes);
        if (answer.ok === false) { failed += 1; continue; }
        if (servedObjectOf(images[0] as never).object === 'derivative') derivative += 1;
        plans.push(answer.plan);
      }
      return json({ success: true, operation, offset, limit, stored: false, failed, derivative,
        stopped_for_time: stoppedForTime, ...summarise(plans) });
    }

    if (operation === 'proof') {
      const proof = await drawHeroProof(supabase, {
        includeArchived, deadlineAt,
        perCategory: Number(body.per_category ?? 2) || 2,
        maxRows: Number(body.max_rows ?? 12) || 12,
        maxDecodes: Number(body.max_decodes ?? 40) || 40,
      });
      return json({ success: true, operation, ...proof });
    }

    if (operation === 'summary') {
      // The stored plans of the live cards, as aggregate numbers.
      const groups = await readHeroCandidates(supabase, { includeArchived });
      const plans = groups.map(({ images }) => heroPlanOfImage(images[0] as never)).filter(Boolean) as HeroPlan[];
      return json({ success: true, operation, cards: groups.length, ...summarise(plans) });
    }

    const outcome = await settleMarketplaceHero(supabase, {
      limit: Number(body.limit ?? 8) || 8, deadlineAt, includeArchived,
      organisationId: typeof body.organisation_id === 'string' ? body.organisation_id : null,
    });
    console.log('[builder-stock-hero-planner] tick', { ...outcome });
    return json({ success: true, operation: 'plan', ...outcome });
  } catch (error) {
    // Presentation never fails loudly into the pipeline; it says what it could not do.
    console.warn('[builder-stock-hero-planner] did not finish', {
      operation, message: String((error as Error)?.message ?? error).slice(0, 200),
    });
    return json({ success: false, operation, error: 'hero planning did not finish' }, 503);
  }
});
