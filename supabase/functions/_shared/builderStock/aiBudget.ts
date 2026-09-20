/**
 * Builder stock — the ceiling, as the import path sees it.
 *
 * A thin port over the three Postgres functions that do the real work. The
 * arithmetic is in `aiBudget.pure.ts`; the atomicity is in the migration. This
 * file exists so `modelExtract` can be handed a budget it can test against,
 * rather than reaching for a database itself.
 *
 * FAIL CLOSED, ALWAYS. If the budget cannot be read or the reservation cannot
 * be taken — the table is missing, the RPC errors, the database is
 * unreachable — this refuses the call. A hard ceiling that opens when its own
 * accounting breaks is not a ceiling, and the failure it would cause is
 * spending money nobody authorised. The opposite failure, a brochure that does
 * not import until an operator looks, is recoverable and visible.
 */
import {
  BUILDER_STOCK_AGENT_KEY,
  BUILDER_STOCK_MONTHLY_CAP_MICROS,
} from './aiBudget.pure.ts';

export interface BudgetGrant {
  ok: true;
  reservationId: string;
  reservedMicros: number;
  remainingMicros: number;
}

export interface BudgetRefusal {
  ok: false;
  /** `exhausted` is the ceiling doing its job. `unavailable` is our fault. */
  reason: 'exhausted' | 'unavailable';
  remainingMicros: number;
  detail?: string;
}

export type BudgetDecision = BudgetGrant | BudgetRefusal;

/**
 * What `modelExtract` needs. Narrow on purpose: a fake in a test is four
 * lines, so the budget rules can be exercised without a database.
 */
export interface AiBudgetPort {
  reserve(args: {
    amountMicros: number;
    modelId?: string | null;
    route?: string | null;
  }): Promise<BudgetDecision>;
  settle(reservationId: string, actualMicros: number): Promise<void>;
  release(reservationId: string): Promise<void>;
}

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** PostgREST returns a set-returning function as an array of rows. */
const firstRow = (data: unknown): Record<string, unknown> | null => {
  if (Array.isArray(data)) return (data[0] ?? null) as Record<string, unknown> | null;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return null;
};

/**
 * The live budget, bound to one agent key and one monthly ceiling.
 *
 * `supabase` must be a service-role client: these RPCs are `SECURITY DEFINER`
 * and granted to `service_role` alone, because the budget is not a tenant's to
 * read or move.
 */
export function createAiBudget(
  supabase: any,
  options: { agentKey?: string; capMicros?: number } = {},
): AiBudgetPort {
  const agentKey = options.agentKey ?? BUILDER_STOCK_AGENT_KEY;
  const capMicros = options.capMicros ?? BUILDER_STOCK_MONTHLY_CAP_MICROS;

  return {
    async reserve({ amountMicros, modelId, route }) {
      try {
        const { data, error } = await supabase.rpc('ai_budget_reserve', {
          p_agent_key: agentKey,
          p_amount_micros: Math.max(Math.ceil(amountMicros), 0),
          p_cap_micros: capMicros,
          p_model_id: modelId ?? null,
          p_route: route ?? null,
        });
        if (error) {
          return {
            ok: false, reason: 'unavailable', remainingMicros: 0,
            detail: String(error.message ?? error).slice(0, 200),
          };
        }
        const row = firstRow(data);
        if (!row) {
          return { ok: false, reason: 'unavailable', remainingMicros: 0, detail: 'no row' };
        }
        if (row.granted !== true || !row.reservation_id) {
          return {
            ok: false, reason: 'exhausted', remainingMicros: num(row.remaining_micros),
          };
        }
        return {
          ok: true,
          reservationId: String(row.reservation_id),
          reservedMicros: Math.max(Math.ceil(amountMicros), 0),
          remainingMicros: num(row.remaining_micros),
        };
      } catch (e) {
        // Including a transport fault. Still closed.
        return {
          ok: false, reason: 'unavailable', remainingMicros: 0,
          detail: String((e as { message?: string })?.message ?? e).slice(0, 200),
        };
      }
    },

    /**
     * Best effort, and deliberately so: the money is already spent by the time
     * this runs, and throwing here would turn a completed extraction into a
     * failed import. A settle that does not land leaves the hold to be
     * reclaimed, which over-counts for ten minutes — the safe direction.
     */
    async settle(reservationId, actualMicros) {
      try {
        await supabase.rpc('ai_budget_settle', {
          p_reservation_id: reservationId,
          p_actual_micros: Math.max(Math.ceil(actualMicros), 0),
        });
      } catch (e) {
        console.warn('[builderStock] budget settle failed; hold will be reclaimed', {
          phase: 'ai_budget', reservation_id: reservationId,
          detail: String((e as { message?: string })?.message ?? e).slice(0, 160),
        });
      }
    },

    async release(reservationId) {
      try {
        await supabase.rpc('ai_budget_release', { p_reservation_id: reservationId });
      } catch (e) {
        console.warn('[builderStock] budget release failed; hold will be reclaimed', {
          phase: 'ai_budget', reservation_id: reservationId,
          detail: String((e as { message?: string })?.message ?? e).slice(0, 160),
        });
      }
    },
  };
}
