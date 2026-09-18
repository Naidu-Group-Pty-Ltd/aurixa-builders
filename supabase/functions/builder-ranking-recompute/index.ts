/**
 * The ranking run — the only thing in the fleet that decides marketplace order.
 *
 * It reads the network's own tables, scores every active builder and every live
 * property through `builderRanking.pure.ts`, and writes the answer to
 * `builder_ranking_snapshots` / `builder_stock_item_ranks`. The write is what
 * travels: a trigger re-enqueues any property whose rank would change the page,
 * the outbox delivers it, and each clone's mirror converges. No clone computes
 * anything.
 *
 * WHY THIS IS AN EDGE FUNCTION AND NOT A pg_cron SQL JOB. `listing_quality` is
 * the share of a builder's stock carrying an image the marketplace would
 * actually draw, and that predicate is `isDisplayableSourceImage` — six
 * conditions plus a sanitised-derivative lookup plus an overlay clearance,
 * living in `primaryImage.ts` and improved four times. Rewriting it in SQL
 * would be a second implementation of a judgement this repository deliberately
 * keeps in one place, and the copy would drift the first time the original was
 * made better. So the scorer runs where that module already runs.
 *
 * FOUR THINGS IT WILL NOT DO.
 *
 * It will not write while the ranking is FROZEN. A freeze is an operator
 * saying the published order must stop moving, usually mid-incident; a run
 * that wrote anyway would be the second incident.
 *
 * It will not write a PARTIAL answer. Every read here goes through
 * `readAllRows`, which reports `failed` rather than handing back a truncated
 * page — the defect that once blanked eleven cards by reading 1,000 of 1,926
 * image rows as the whole set. A ranking computed from a truncated catalogue
 * would rank a builder on the stock that happened to fit in a page, so a
 * failed read abandons the whole run and leaves yesterday's answer standing.
 *
 * It will not invent a comparison. A price cohort below the floor produces
 * `not_measured`, never an average — and the floor counts DISTINCT BUILDERS,
 * because a cohort drawn from one builder's own stock compares them to
 * themselves. Today's network has one builder with live stock, so every cohort
 * is below the floor and price position is unmeasured on every property. That
 * is the correct answer, and it is the one this run produces.
 *
 * It will not remove stock. A suppression is recorded here as a placement, and
 * the marketplace's own ordering drops it; nothing in this run deletes, hides
 * or archives a property.
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import { readAllRows } from '../_shared/builderStock/pagedRead.ts';
import { rankImage } from '../_shared/builderStock/imagePriority.pure.ts';
import { sourceVerdictOutstanding } from '../_shared/builderStock/marketplaceEligibility.pure.ts';
import {
  BUILDER_RANKING_VERSION,
  MIN_COHORT_ITEMS,
  MIN_COHORT_ORGANISATIONS,
  builderBand,
  resolvePlacement,
  scoreBuilder,
  scoreItem,
  type BuilderFacts,
  type CommercialPlacement,
  type ItemFacts,
  type RankingOverride,
  type TenureSource,
} from '../_shared/builderStock/builderRanking.pure.ts';

const MAX_BODY_BYTES = 8 * 1024;
const DAY_MS = 86_400_000;

/** The fields a card draws, and therefore what "complete" means for one. */
const COMPLETENESS_FIELDS = [
  'address_line', 'suburb', 'state', 'postcode',
  'bedrooms', 'bathrooms', 'car_spaces', 'property_type',
  'land_size_sqm', 'building_size_sqm', 'expected_completion', 'description',
] as const;

interface StockRow {
  id: string;
  organisation_id: string;
  lifecycle_status: string;
  availability_status: string;
  price: number | null;
  price_display: string | null;
  state: string | null;
  suburb: string | null;
  property_type: string | null;
  bedrooms: number | null;
  primary_image_id: string | null;
  last_seen_at: string | null;
  manual_stats: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface ImageRow {
  id: string;
  source_stage: string;
  verification_status: string;
  processing_status: string;
  storage_path: string | null;
  external_url: string | null;
  source_detail: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
    if (!bounded.ok) return bounded.error;
    const gate = await verifyInternal(supabase, req, bounded.raw);
    if (!gate.ok) {
      console.warn('[builder-ranking-recompute] verifyInternal denied', {
        errorCode: (gate as { errorCode?: string }).errorCode,
      });
      return json({ error: 'Forbidden' }, 403);
    }

    const asOf = new Date().toISOString();

    // ---------------------------------------------------------------- freeze
    const { data: state, error: stateError } = await supabase
      .from('builder_ranking_state')
      .select('frozen, frozen_reason')
      .eq('id', true)
      .maybeSingle();
    if (stateError) {
      console.error('[builder-ranking-recompute] state unreadable', stateError.message);
      return json({ error: 'ranking_state_unreadable' }, 503);
    }
    if (state?.frozen) {
      // Recorded rather than silent: a frozen ranking that nobody can see is
      // frozen looks exactly like a scheduler that stopped running.
      await supabase.from('builder_ranking_state')
        .update({ last_run_at: asOf, last_run_error: 'skipped: ranking frozen' })
        .eq('id', true);
      return json({ skipped: 'frozen', reason: state.frozen_reason ?? null });
    }

    /*
     * ----------------------------------------------------------------- reads
     *
     * Every select below is ONE unbroken string literal, however long the line
     * runs. supabase-js resolves a query's row type by parsing that literal at
     * the type level, and `'a, ' + 'b'` widens to `string` — which it cannot
     * parse, so the row type falls back to `GenericStringError` and collides
     * with any concrete row interface. Wrapping these three selects across
     * lines is what failed the edge typecheck the first time this shipped, and
     * it fails silently for the reads typed `Record<string, any>`, because
     * `GenericStringError[]` is assignable to those.
     */
    const organisations = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_organisations')
        .select('id, status, abn, contact_email, contact_phone, established_on, abn_registered_on, abn_verified_at, reputation_score, reputation_recorded_at')
        .eq('status', 'active')
        .order('id', { ascending: true }),
    );
    if (organisations.failed) return abandon(supabase, asOf, 'organisations', organisations.error);

    const items = await readAllRows<StockRow>(
      () => supabase
        .from('builder_stock_items')
        .select('id, organisation_id, lifecycle_status, availability_status, price, price_display, state, suburb, property_type, bedrooms, bathrooms, car_spaces, land_size_sqm, building_size_sqm, address_line, postcode, expected_completion, description, primary_image_id, last_seen_at, manual_stats')
        .eq('lifecycle_status', 'active')
        .order('id', { ascending: true }),
    );
    if (items.failed) return abandon(supabase, asOf, 'stock items', items.error);

    const images = await readAllRows<ImageRow>(
      () => supabase
        .from('builder_stock_item_images')
        .select('id, source_stage, verification_status, processing_status, storage_path, external_url, source_detail')
        .order('id', { ascending: true }),
    );
    if (images.failed) return abandon(supabase, asOf, 'images', images.error);

    const uploads = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_stock_uploads')
        .select('id, organisation_id, created_at')
        .order('id', { ascending: true }),
    );
    if (uploads.failed) return abandon(supabase, asOf, 'stock uploads', uploads.error);

    const announcements = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_stock_selection_announcements')
        .select('id, organisation_id, status, created_at, acknowledged_at')
        .order('id', { ascending: true }),
    );
    if (announcements.failed) return abandon(supabase, asOf, 'announcements', announcements.error);

    /*
     * ONBOARDING AND TERMS ARE KEYED BY USER, NOT BY ORGANISATION.
     *
     * `builder_onboarding_steps.builder_user_id` and
     * `builder_terms_acceptances.builder_user_id` are people, and a builder
     * organisation is a set of them. So both are resolved through LIVE
     * memberships — a revoked member's completed steps say nothing about the
     * organisation today, and counting them would let a builder keep a
     * standing score on the back of somebody who left.
     */
    const memberships = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_organisation_memberships')
        .select('id, builder_user_id, organisation_id, revoked_at')
        .is('revoked_at', null)
        .order('id', { ascending: true }),
    );
    if (memberships.failed) return abandon(supabase, asOf, 'memberships', memberships.error);

    const onboarding = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_onboarding_steps')
        .select('id, builder_user_id, mandatory, completed_at')
        .order('id', { ascending: true }),
    );
    if (onboarding.failed) return abandon(supabase, asOf, 'onboarding steps', onboarding.error);

    const terms = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_terms_acceptances')
        .select('id, builder_user_id')
        .order('id', { ascending: true }),
    );
    if (terms.failed) return abandon(supabase, asOf, 'terms acceptances', terms.error);

    /*
     * DELIVERY IS REACHED THROUGH THE PROJECT, BECAUSE NOTHING IN IT KNOWS AN
     * ORGANISATION.
     *
     * `builder_defects` and `builder_warranty_claims` are keyed by
     * `construction_case_id`, and a case is keyed by `project_id` — only
     * `builder_projects.builder_organisation_id` names the builder. The chain
     * is walked here rather than guessed at: a defect attributed to the wrong
     * builder is worse than a defect nobody counted.
     *
     * All four of these tables held zero rows when this was written. They are
     * read anyway so the signal lights up on its own the day a builder
     * actually finishes a home, rather than the day somebody remembers to
     * come back and wire it.
     */
    const projects = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_projects')
        .select('id, builder_organisation_id, status, estimated_completion_date, actual_completion_date')
        .order('id', { ascending: true }),
    );
    if (projects.failed) return abandon(supabase, asOf, 'projects', projects.error);

    const cases = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_construction_cases')
        .select('id, project_id')
        .order('id', { ascending: true }),
    );
    if (cases.failed) return abandon(supabase, asOf, 'construction cases', cases.error);

    const defects = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_defects')
        .select('id, construction_case_id, status')
        .order('id', { ascending: true }),
    );
    if (defects.failed) return abandon(supabase, asOf, 'defects', defects.error);

    const warranties = await readAllRows<Record<string, any>>(
      () => supabase
        .from('builder_warranty_claims')
        .select('id, construction_case_id, status')
        .order('id', { ascending: true }),
    );
    if (warranties.failed) return abandon(supabase, asOf, 'warranty claims', warranties.error);

    const { data: overrideRows } = await supabase
      .from('builder_ranking_overrides')
      .select('organisation_id, kind, position, reason, expires_at')
      .is('revoked_at', null);
    const { data: placementRows } = await supabase
      .from('builder_commercial_placements')
      .select('organisation_id, tier, priority, starts_at, ends_at')
      .is('revoked_at', null);

    const overrides: RankingOverride[] = (overrideRows ?? []).map((row) => ({
      organisationId: row.organisation_id,
      kind: row.kind,
      position: row.position ?? null,
      reason: row.reason,
      expiresAt: row.expires_at ?? null,
    }));
    const placements: CommercialPlacement[] = (placementRows ?? []).map((row) => ({
      organisationId: row.organisation_id,
      tier: row.tier,
      priority: row.priority ?? 100,
      startsAt: row.starts_at ?? null,
      endsAt: row.ends_at ?? null,
    }));

    // ------------------------------------------------------------- indexing
    const imageById = new Map(images.rows.map((image) => [image.id, image]));
    const now = Date.parse(asOf);
    const daysSince = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const then = Date.parse(value);
      return Number.isFinite(then) ? (now - then) / DAY_MS : null;
    };

    /**
     * Displayable, pending, or neither — decided by the SAME module the card
     * uses. `rankImage` answers null for anything the marketplace would not
     * draw; `sourceVerdictOutstanding` separates "we have not judged this yet"
     * from "we judged it and it may not be shown", which is the difference
     * between a builder who has supplied nothing and one whose photograph is
     * still in the queue.
     */
    const imageStateFor = (item: StockRow): { displayable: boolean; pending: boolean } => {
      if (!item.primary_image_id) return { displayable: false, pending: false };
      const image = imageById.get(item.primary_image_id);
      if (!image) return { displayable: false, pending: false };
      if (rankImage(image as never)) return { displayable: true, pending: false };
      return { displayable: false, pending: sourceVerdictOutstanding(image.source_detail ?? {}) };
    };

    const completenessOf = (item: StockRow): number => {
      const stated = (item.manual_stats as { values?: Record<string, unknown> } | null)?.values ?? {};
      let present = 0;
      for (const field of COMPLETENESS_FIELDS) {
        const value = item[field] ?? (stated as Record<string, unknown>)[field];
        if (value !== null && value !== undefined && String(value).trim() !== '') present += 1;
      }
      // Price counts as stated when a figure OR an explicit "on application"
      // is there: withholding a price is a real commercial choice, and a
      // builder who says so is more complete than one who says nothing.
      const priced = item.price !== null || (item.price_display ?? '').trim() !== '';
      return (present + (priced ? 1 : 0)) / (COMPLETENESS_FIELDS.length + 1);
    };

    /**
     * Cohorts: state x property type x bedroom band, and a cohort only speaks
     * when enough DISTINCT BUILDERS are in it.
     */
    const cohortKey = (item: StockRow): string | null => {
      if (!item.state || !item.property_type || item.price === null) return null;
      const beds = item.bedrooms === null ? 'x' : String(Math.round(Number(item.bedrooms)));
      return `${item.state}|${item.property_type}|${beds}`;
    };
    const cohorts = new Map<string, { prices: number[]; organisations: Set<string> }>();
    for (const item of items.rows) {
      const key = cohortKey(item);
      if (!key) continue;
      const bucket = cohorts.get(key) ?? { prices: [], organisations: new Set<string>() };
      bucket.prices.push(Number(item.price));
      bucket.organisations.add(item.organisation_id);
      cohorts.set(key, bucket);
    }
    const cohortMedian = new Map<string, number>();
    for (const [key, bucket] of cohorts) {
      if (bucket.organisations.size < MIN_COHORT_ORGANISATIONS) continue;
      if (bucket.prices.length < MIN_COHORT_ITEMS) continue;
      const sorted = [...bucket.prices].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      cohortMedian.set(key, sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2);
    }
    const cohortRatioOf = (item: StockRow): number | null => {
      const key = cohortKey(item);
      if (!key) return null;
      const median = cohortMedian.get(key);
      if (!median || median <= 0 || item.price === null) return null;
      return Number(item.price) / median;
    };

    const groupCount = <T extends { organisation_id: string }>(rows: T[]) => {
      const out = new Map<string, T[]>();
      for (const row of rows) {
        const list = out.get(row.organisation_id) ?? [];
        list.push(row);
        out.set(row.organisation_id, list);
      }
      return out;
    };
    const itemsByOrg = groupCount(items.rows as unknown as { organisation_id: string }[]) as Map<string, StockRow[]>;
    const uploadsByOrg = groupCount(uploads.rows as { organisation_id: string; created_at: string }[]);
    const announcementsByOrg = groupCount(announcements.rows as { organisation_id: string; status: string; created_at: string; acknowledged_at: string | null }[]);

    // user -> organisation, from live memberships only.
    const orgOfUser = new Map<string, string>();
    for (const row of memberships.rows) orgOfUser.set(row.builder_user_id, row.organisation_id);
    const byOrgViaUser = <T extends { builder_user_id: string }>(rows: T[]) => {
      const out = new Map<string, T[]>();
      for (const row of rows) {
        const org = orgOfUser.get(row.builder_user_id);
        if (!org) continue;
        const list = out.get(org) ?? [];
        list.push(row);
        out.set(org, list);
      }
      return out;
    };
    const onboardingByOrg = byOrgViaUser(onboarding.rows as { builder_user_id: string; completed_at: string | null }[]);
    const termsByOrg = byOrgViaUser(terms.rows as { builder_user_id: string }[]);

    // construction case -> project -> builder organisation.
    const orgOfProject = new Map<string, string>();
    for (const row of projects.rows) {
      if (row.builder_organisation_id) orgOfProject.set(row.id, row.builder_organisation_id);
    }
    const orgOfCase = new Map<string, string>();
    for (const row of cases.rows) {
      const org = orgOfProject.get(row.project_id);
      if (org) orgOfCase.set(row.id, org);
    }
    const byOrgViaCase = <T extends { construction_case_id: string }>(rows: T[]) => {
      const out = new Map<string, T[]>();
      for (const row of rows) {
        const org = orgOfCase.get(row.construction_case_id);
        if (!org) continue;
        const list = out.get(org) ?? [];
        list.push(row);
        out.set(org, list);
      }
      return out;
    };
    const defectsByOrg = byOrgViaCase(defects.rows as { construction_case_id: string }[]);
    const warrantiesByOrg = byOrgViaCase(warranties.rows as { construction_case_id: string }[]);

    /*
     * A completion is a project that actually finished, and "on time" compares
     * its own two dates. A project with an actual date and no estimate is
     * counted as delivered and NOT counted as late — an absent forecast is a
     * record-keeping gap, and reading it as a missed deadline would punish a
     * builder for a field nobody filled in.
     */
    const completionsByOrg = new Map<string, { onTime: boolean }[]>();
    for (const project of projects.rows) {
      if (!project.builder_organisation_id || !project.actual_completion_date) continue;
      const estimated = project.estimated_completion_date
        ? Date.parse(project.estimated_completion_date) : null;
      const actual = Date.parse(project.actual_completion_date);
      const onTime = estimated === null || !Number.isFinite(estimated) || actual <= estimated;
      const list = completionsByOrg.get(project.builder_organisation_id) ?? [];
      list.push({ onTime });
      completionsByOrg.set(project.builder_organisation_id, list);
    }

    // ------------------------------------------------------------- scoring
    const snapshotRows: Record<string, unknown>[] = [];
    const itemRankRows: Record<string, unknown>[] = [];

    for (const org of organisations.rows) {
      const own = itemsByOrg.get(org.id) ?? [];
      const live = own.length;

      let withImage = 0;
      let completenessSum = 0;
      let knownAvailability = 0;
      let available = 0;
      let inCohort = 0;
      let ratioSum = 0;
      const states = new Set<string>();
      const suburbs = new Set<string>();
      let newestSeen: number | null = null;

      for (const item of own) {
        const image = imageStateFor(item);
        if (image.displayable) withImage += 1;
        completenessSum += completenessOf(item);
        if (item.availability_status && item.availability_status !== 'unknown') knownAvailability += 1;
        if (item.availability_status === 'available') available += 1;
        if (item.state) states.add(item.state);
        if (item.suburb) suburbs.add(item.suburb.toLowerCase());
        const ratio = cohortRatioOf(item);
        if (ratio !== null) { inCohort += 1; ratioSum += ratio; }
        const seen = daysSince(item.last_seen_at);
        if (seen !== null && (newestSeen === null || seen < newestSeen)) newestSeen = seen;
      }

      const orgUploads = uploadsByOrg.get(org.id) ?? [];
      const newestUpload = orgUploads.reduce<number | null>((best, row) => {
        const days = daysSince(row.created_at);
        if (days === null) return best;
        return best === null || days < best ? days : best;
      }, null);

      const orgAnnouncements = announcementsByOrg.get(org.id) ?? [];
      const acknowledged = orgAnnouncements.filter((a) => !!a.acknowledged_at);
      const ackHours = acknowledged
        .map((a) => (Date.parse(a.acknowledged_at as string) - Date.parse(a.created_at)) / 3_600_000)
        .filter((hours) => Number.isFinite(hours) && hours >= 0)
        .sort((a, b) => a - b);
      const outcomes = orgAnnouncements.filter((a) =>
        a.status === 'completed' || a.status === 'withdrawn');

      const orgOnboarding = onboardingByOrg.get(org.id) ?? [];
      const orgCompletions = completionsByOrg.get(org.id) ?? [];

      const tenure = tenureOf(org, now);

      const facts: BuilderFacts = {
        organisationId: org.id,
        catalogue: {
          liveItems: live,
          itemsWithDisplayableImage: withImage,
          itemsWithPrice: own.filter((i) => i.price !== null || (i.price_display ?? '').trim() !== '').length,
          meanFieldCompleteness: live ? completenessSum / live : 0,
          itemsWithKnownAvailability: knownAvailability,
          itemsAvailable: available,
          distinctStates: states.size,
          distinctSuburbs: suburbs.size,
          daysSinceLastUpload: newestUpload,
          daysSinceLastSeen: newestSeen,
        },
        activity: {
          activations: orgAnnouncements.length,
          activationsAcknowledged: acknowledged.length,
          medianAcknowledgementHours: ackHours.length
            ? ackHours[Math.floor(ackHours.length / 2)]
            : null,
          outcomes: outcomes.length,
          outcomesCompleted: outcomes.filter((a) => a.status === 'completed').length,
        },
        delivery: {
          completions: orgCompletions.length,
          completionsOnTime: orgCompletions.filter((row) => row.onTime).length,
          defects: (defectsByOrg.get(org.id) ?? []).length,
          warrantyClaims: (warrantiesByOrg.get(org.id) ?? []).length,
        },
        standing: {
          tenureYears: tenure.years,
          tenureSource: tenure.source,
          hasWellFormedAbn: /^[0-9]{11}$/.test(String(org.abn ?? '')),
          hasContactEmail: !!(org.contact_email ?? '').trim(),
          hasContactPhone: !!(org.contact_phone ?? '').trim(),
          termsAccepted: (termsByOrg.get(org.id) ?? []).length > 0,
          onboardingStepsTotal: orgOnboarding.length,
          onboardingStepsComplete: orgOnboarding.filter((s) => !!s.completed_at).length,
          reputationScore: org.reputation_score ?? null,
          reputationAgeDays: daysSince(org.reputation_recorded_at),
        },
        pricePosition: {
          itemsInCohort: inCohort,
          meanCohortRatio: inCohort ? ratioSum / inCohort : null,
        },
      };

      const builder = scoreBuilder(facts);
      const band = builderBand(builder.score);
      const placement = resolvePlacement(org.id, band, overrides, placements, asOf);

      snapshotRows.push({
        organisation_id: org.id,
        merit_score: builder.score,
        confidence: builder.confidence,
        measured_score: builder.measuredScore,
        band,
        signals: builder.signals,
        ranking_version: BUILDER_RANKING_VERSION,
        computed_at: asOf,
      });

      for (const item of own) {
        const image = imageStateFor(item);
        const itemFacts: ItemFacts = {
          itemId: item.id,
          organisationId: org.id,
          hasDisplayableImage: image.displayable,
          imagePending: image.pending,
          fieldCompleteness: completenessOf(item),
          availabilityStatus: item.availability_status ?? 'unknown',
          daysSinceSeen: daysSince(item.last_seen_at),
          cohortRatio: cohortRatioOf(item),
        };
        const scored = scoreItem(itemFacts);
        itemRankRows.push({
          stock_item_id: item.id,
          organisation_id: org.id,
          item_score: scored.score,
          confidence: scored.confidence,
          builder_score: builder.score,
          builder_confidence: builder.confidence,
          builder_band: band,
          placement_kind: placement.kind,
          placement_position: placement.position,
          placement_tier: placement.tier,
          disclose: placement.disclose,
          signals: scored.signals,
          ranking_version: BUILDER_RANKING_VERSION,
          computed_at: asOf,
        });
      }
    }

    // ------------------------------------------------------------- writing
    /*
     * ONE CALL, ONE TRANSACTION.
     *
     * Chunked upserts from here would leave half the fleet on this run's bands
     * and half on the previous run's the first time a chunk failed — an order
     * built from two different answers, with every individual row perfectly
     * well-formed and nothing to report it. `builder_ranking_apply` is a
     * plpgsql function, so both tables and the run stamp land together or not
     * at all.
     */
    const { error: applyError } = await supabase.rpc('builder_ranking_apply', {
      _snapshots: snapshotRows,
      _items: itemRankRows,
      _ranking_version: BUILDER_RANKING_VERSION,
      _computed_at: asOf,
    });
    if (applyError) return abandon(supabase, asOf, 'ranking apply', applyError);

    return json({
      success: true,
      organisations: snapshotRows.length,
      items: itemRankRows.length,
      ranking_version: BUILDER_RANKING_VERSION,
      computed_at: asOf,
    });
  } catch (error) {
    console.error('[builder-ranking-recompute] unhandled', error);
    return json({ error: 'ranking_run_failed' }, 500);
  }
});

/**
 * Tenure, and which of three things it is known by.
 *
 * `created_at` is never one of them. It records a network join, and reading it
 * as trading history would make every builder permanently new and would put a
 * number on something nobody measured.
 */
function tenureOf(
  org: Record<string, any>,
  now: number,
): { years: number | null; source: TenureSource } {
  const years = (value: string | null | undefined): number | null => {
    if (!value) return null;
    const then = Date.parse(value);
    if (!Number.isFinite(then)) return null;
    return (now - then) / (365.25 * DAY_MS);
  };
  if (org.abn_verified_at && org.abn_registered_on) {
    const verified = years(org.abn_registered_on);
    if (verified !== null) return { years: verified, source: 'abr_verified' };
  }
  const declared = years(org.established_on);
  if (declared !== null) return { years: declared, source: 'declared' };
  return { years: null, source: 'none' };
}

/**
 * A run that could not read everything writes NOTHING and says why.
 *
 * Half a ranking is worse than yesterday's: the builders whose rows made it
 * would be ranked against a catalogue missing the ones that did not.
 */
async function abandon(
  supabase: SupabaseClient,
  asOf: string,
  what: string,
  cause: unknown,
): Promise<Response> {
  const detail = cause instanceof Error
    ? cause.message
    : typeof (cause as { message?: string })?.message === 'string'
    ? (cause as { message: string }).message
    : String(cause ?? 'unknown');
  const reason = `${what}: ${detail}`;
  console.error('[builder-ranking-recompute] abandoned', reason);
  await supabase.from('builder_ranking_state')
    .update({ last_run_at: asOf, last_run_error: `abandoned: ${reason}` })
    .eq('id', true);
  return new Response(
    JSON.stringify({ error: 'ranking_run_abandoned', reason }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}
