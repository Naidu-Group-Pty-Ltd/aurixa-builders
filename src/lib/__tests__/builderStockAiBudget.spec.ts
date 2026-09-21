/**
 * The US$10 monthly ceiling on Builder Stock's assisted reader — RUN, not read.
 *
 * The ceiling's two halves are tested in two places on purpose. The ARITHMETIC
 * (what a hold is worth, what a settle commits) is pure and is exercised here.
 * The ATOMICITY — that two concurrent requests cannot each spend the same
 * dollar — lives in `ai_budget_reserve`'s single UPDATE and is exercised here
 * against a fake that models the same rule, plus against production in the
 * shipping report.
 *
 * The rule the whole file exists for: a deterministic import spends NOTHING,
 * and an exhausted month calls NOBODY.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const callLLM = vi.fn();
vi.mock('../../../supabase/functions/_shared/llmRouter.ts', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

// eslint-disable-next-line import/first
import {
  extractStockRowsFromText,
} from '../../../supabase/functions/_shared/builderStock/modelExtract';
// eslint-disable-next-line import/first
import {
  attemptCeilingMicros, attemptReachedProvider, attemptWasBillable, BUDGET_CHAIN,
  BUILDER_STOCK_AGENT_KEY, BUILDER_STOCK_MONTHLY_CAP_MICROS, BUILDER_STOCK_MONTHLY_CAP_USD,
  estimateTokens, messageChars, microsToUsd, OPENROUTER_MODEL_RATES, periodMonthKey,
  readReportedCostUsd, reservationMicrosFor, settleMicrosFor, usdToMicros,
} from '../../../supabase/functions/_shared/builderStock/aiBudget.pure';
// eslint-disable-next-line import/first
import type { AiBudgetPort } from '../../../supabase/functions/_shared/builderStock/aiBudget';

const CONTEXT = { filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf', organisationName: 'Enzo Homes' };
const BROCHURE = 'LOT 315, ENZO 8.5 LUCA. 4 bed, 2 bath. $863,850.';

/**
 * A budget that enforces the SAME rule the Postgres function does: the ceiling
 * test and the hold are one indivisible step. Modelling it here is what lets
 * the concurrency property be asserted without a database.
 */
function fakeBudget(capMicros = BUILDER_STOCK_MONTHLY_CAP_MICROS) {
  const state = { committed: 0, reserved: 0, cap: capMicros, calls: [] as number[] };
  const holds = new Map<string, number>();
  let n = 0;
  const port: AiBudgetPort = {
    async reserve({ amountMicros }) {
      state.calls.push(amountMicros);
      // ONE step: test and take, exactly as the UPDATE ... WHERE does.
      if (state.committed + state.reserved + amountMicros > state.cap) {
        return {
          ok: false, reason: 'exhausted',
          remainingMicros: Math.max(state.cap - state.committed - state.reserved, 0),
        };
      }
      state.reserved += amountMicros;
      const id = `res-${++n}`;
      holds.set(id, amountMicros);
      return {
        ok: true, reservationId: id, reservedMicros: amountMicros,
        remainingMicros: state.cap - state.committed - state.reserved,
      };
    },
    async settle(id, actual) {
      const held = holds.get(id); if (held === undefined) return;
      holds.delete(id);
      state.reserved -= held;
      state.committed += Math.min(actual, held);
    },
    async release(id) {
      const held = holds.get(id); if (held === undefined) return;
      holds.delete(id); state.reserved -= held;
    },
  };
  return { port, state };
}

const answered = (args: unknown, cost: number | null = 0.00125, attempts = [
  { route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: true, status: 200 },
]) => ({
  content: '', modelUsed: 'openai/gpt-5.6-luna', routeUsed: 'openrouter',
  rawResponse: cost === null ? { usage: {} } : { usage: { cost } },
  toolCalls: [{ function: { name: 'record_stock_items', arguments: args } }],
  attempts,
});

const ONE_PROPERTY = JSON.stringify({ items: [{ lot_number: '315', price: '$863,850' }] });

beforeEach(() => { callLLM.mockReset(); });

describe('the ceiling is US$10 a calendar month, for this agent alone', () => {
  it('the cap is stated once, in dollars and in micros, and they agree', () => {
    expect(BUILDER_STOCK_MONTHLY_CAP_USD).toBe(10);
    expect(BUILDER_STOCK_MONTHLY_CAP_MICROS).toBe(10_000_000);
    expect(microsToUsd(BUILDER_STOCK_MONTHLY_CAP_MICROS)).toBe(BUILDER_STOCK_MONTHLY_CAP_USD);
    expect(BUILDER_STOCK_AGENT_KEY).toBe('builder_stock_extraction');
  });

  it('money is integer micros, and rounds UP so a hold is never short', () => {
    expect(usdToMicros(0.001253)).toBe(1253);
    expect(usdToMicros(0.0000001)).toBe(1);
    expect(Number.isInteger(usdToMicros(0.1 + 0.2))).toBe(true);
  });

  it('the next calendar month is a different key, so the allowance is fresh', () => {
    expect(periodMonthKey(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-01');
    expect(periodMonthKey(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01');
    expect(periodMonthKey(new Date('2026-12-31T13:00:00Z'))).toBe('2026-12-01');
    expect(periodMonthKey(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
});

describe('a hold is the worst the whole chain could cost', () => {
  const inputTokens = estimateTokens(14_454);        // the production brochure
  const maxOutputTokens = 8000;

  it('covers BOTH models — primary and fallback share one cap', () => {
    const luna = attemptCeilingMicros('openai/gpt-5.6-luna', inputTokens, maxOutputTokens);
    const gemini = attemptCeilingMicros('google/gemini-3.8-flash', inputTokens, maxOutputTokens);
    const hold = reservationMicrosFor({ chain: BUDGET_CHAIN, inputTokens, maxOutputTokens });
    expect(hold).toBe(luna + gemini);
    // And the fallback is genuinely the dearer of the two, so it dominates.
    expect(gemini).toBeGreaterThan(luna);
  });

  it('an unknown model is held at the DEAREST rate, never at zero', () => {
    const unknown = attemptCeilingMicros('some/model-nobody-priced', inputTokens, maxOutputTokens);
    const dearest = Math.max(...Object.keys(OPENROUTER_MODEL_RATES)
      .map((m) => attemptCeilingMicros(m, inputTokens, maxOutputTokens)));
    expect(unknown).toBe(dearest);
    expect(unknown).toBeGreaterThan(0);
  });

  it('a one-model chain is still held for two attempts', () => {
    const hold = reservationMicrosFor({ chain: ['openai/gpt-5.6-luna'], inputTokens, maxOutputTokens });
    expect(hold).toBe(2 * attemptCeilingMicros('openai/gpt-5.6-luna', inputTokens, maxOutputTokens));
  });

  it('the hold leaves room for a real month of brochures', () => {
    const hold = reservationMicrosFor({ chain: BUDGET_CHAIN, inputTokens, maxOutputTokens });
    // Conservative by design, but not so conservative it refuses normal use.
    expect(Math.floor(BUILDER_STOCK_MONTHLY_CAP_MICROS / hold)).toBeGreaterThan(100);
  });
});

describe('settling books what was actually charged', () => {
  const inputTokens = 4466, maxOutputTokens = 8000;
  const base = { reservedMicros: 50_000, inputTokens, maxOutputTokens };

  it('uses OpenRouter’s own reported cost for the winning attempt', () => {
    const micros = settleMicrosFor({
      ...base, reportedCostUsd: 0.001253, winningModelId: 'openai/gpt-5.6-luna',
      attempts: [{ route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: true, status: 200 }],
    });
    expect(micros).toBe(1253);
  });

  it('a FALLBACK win also charges the failed primary that reached the provider', () => {
    /*
     * The router keeps no body for a step it moved past, so the primary's
     * tokens cannot be observed — but they were charged. Over-counting them is
     * the right direction; booking one model for a chain that ran two is not.
     */
    const micros = settleMicrosFor({
      ...base, reportedCostUsd: 0.004, winningModelId: 'google/gemini-3.8-flash',
      attempts: [
        { route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: false, status: 422,
          error: 'required tool call missing: record_stock_items' },
        { route: 'openrouter', model_id: 'google/gemini-3.8-flash', ok: true, status: 200 },
      ],
    });
    expect(micros).toBe(4000 + attemptCeilingMicros('openai/gpt-5.6-luna', inputTokens, maxOutputTokens));
  });

  it('an unconfigured chain reached nobody and is charged NOTHING', () => {
    expect(settleMicrosFor({
      ...base, reportedCostUsd: null, winningModelId: null,
      attempts: [
        { route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: false, error: 'provider_not_configured' },
        { route: 'openrouter', model_id: 'google/gemini-3.8-flash', ok: false, error: 'provider_not_configured' },
      ],
    })).toBe(0);
  });

  it('a provider that reported NO cost is charged the whole hold, not zero', () => {
    expect(settleMicrosFor({
      ...base, reportedCostUsd: null, winningModelId: 'openai/gpt-5.6-luna',
      attempts: [{ route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: true, status: 200 }],
    })).toBe(base.reservedMicros);
  });

  it('a settle can never commit more than was held', () => {
    expect(settleMicrosFor({
      ...base, reportedCostUsd: 999, winningModelId: 'openai/gpt-5.6-luna',
      attempts: [{ route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: true, status: 200 }],
    })).toBe(base.reservedMicros);
  });

  it('A REFUSAL COSTS NOTHING — the production 402, charged at zero', () => {
    /*
     * MEASURED 20 SEP 2026. The first OpenRouter call answered 402 (no credit
     * on the account) and the whole 43,277-micro hold was committed for a
     * request that ran no tokens. 231 of those would have emptied a US$10
     * month without a model ever being asked anything.
     */
    const refused402 = [{
      route: 'openrouter', model_id: 'openai/gpt-5.6-luna',
      ok: false, status: 402, error: 'provider_http_402',
    }];
    expect(settleMicrosFor({
      reservedMicros: 43_277, reportedCostUsd: null, winningModelId: null,
      attempts: refused402, inputTokens: 4466, maxOutputTokens: 8000,
    })).toBe(0);
  });

  it('every refusal status is unbillable; a real answer and a 5xx are not', () => {
    for (const status of [401, 402, 403, 429]) {
      expect(attemptWasBillable({ status, error: `provider_http_${status}` }),
        `${status} should not be billable`).toBe(false);
      // It still REACHED a provider — the two questions are different.
      expect(attemptReachedProvider({ status })).toBe(true);
    }
    expect(attemptWasBillable({ ok: true, status: 200 })).toBe(true);
    // A 500 may have run tokens before failing, so it stays chargeable.
    expect(attemptWasBillable({ status: 500, error: 'provider_http_500' })).toBe(true);
    // A 422 is a response the provider generated and charged for.
    expect(attemptWasBillable({ status: 422, error: 'required tool call missing: x' })).toBe(true);
    expect(attemptWasBillable({ error: 'provider_not_configured' })).toBe(false);
  });

  it('tells a charged attempt from one that never left the process', () => {
    expect(attemptReachedProvider({ ok: true, status: 200 })).toBe(true);
    expect(attemptReachedProvider({ status: 422, error: 'required tool call missing: x' })).toBe(true);
    expect(attemptReachedProvider({ status: 500, error: 'provider_http_500' })).toBe(true);
    expect(attemptReachedProvider({ error: 'provider_not_configured' })).toBe(false);
    expect(attemptReachedProvider({ error: 'deadline exceeded before attempt' })).toBe(false);
  });

  it('reads the cost OpenRouter returns, and only a sane one', () => {
    expect(readReportedCostUsd({ usage: { cost: 0.00125 } })).toBe(0.00125);
    expect(readReportedCostUsd({ usage: {} })).toBeNull();
    expect(readReportedCostUsd({ usage: { cost: -1 } })).toBeNull();
    expect(readReportedCostUsd({})).toBeNull();
    expect(readReportedCostUsd(null)).toBeNull();
  });
});

describe('the ceiling is enforced BEFORE any provider is called', () => {
  const run = (budget: AiBudgetPort) =>
    extractStockRowsFromText(BROCHURE, CONTEXT, { deadlineAt: Date.now() + 90_000, budget });

  it('an exhausted month calls NOBODY and is typed ai_budget_exhausted', async () => {
    const exhausted: AiBudgetPort = {
      reserve: async () => ({ ok: false, reason: 'exhausted', remainingMicros: 12 }),
      settle: async () => {}, release: async () => {},
    };
    const error = await run(exhausted).then(() => null, (e) => e);
    expect(error.code).toBe('model_budget_exhausted');
    // The whole point: no provider was reached, because none was asked.
    expect(callLLM).not.toHaveBeenCalled();
    expect(error.attemptCount).toBe(0);
  });

  it('a budget whose accounting is DOWN also calls nobody — fail closed', async () => {
    const broken: AiBudgetPort = {
      reserve: async () => ({ ok: false, reason: 'unavailable', remainingMicros: 0, detail: 'rpc down' }),
      settle: async () => {}, release: async () => {},
    };
    await expect(run(broken)).rejects.toMatchObject({ code: 'model_budget_exhausted' });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('a granted read calls the model once and settles the real cost', async () => {
    callLLM.mockResolvedValue(answered(ONE_PROPERTY, 0.001253));
    const { port, state } = fakeBudget();
    const result = await run(port);
    expect(result.rows).toHaveLength(1);
    expect(result.costUsd).toBe(0.001253);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(state.committed).toBe(1253);
    expect(state.reserved).toBe(0);          // the rest handed straight back
  });

  it('a failed chain that reached nobody gives the whole hold back', async () => {
    callLLM.mockRejectedValue(Object.assign(new Error('all failed'), {
      status: 503,
      attempts: [{ route: 'openrouter', model_id: 'openai/gpt-5.6-luna', ok: false, error: 'provider_not_configured' }],
    }));
    const { port, state } = fakeBudget();
    await expect(run(port)).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(state.committed).toBe(0);
    expect(state.reserved).toBe(0);
  });
});

describe('concurrency cannot walk through the ceiling', () => {
  it('ten simultaneous reads cannot spend more than the cap between them', async () => {
    /*
     * The defect this models: ten requests each read "spent so far", each see
     * room, and each spend. The fake reserves the way the Postgres UPDATE
     * does — test and take in one step — so the ones that do not fit are
     * refused rather than admitted.
     */
    const hold = reservationMicrosFor({
      chain: BUDGET_CHAIN, inputTokens: estimateTokens(14_454), maxOutputTokens: 8000,
    });
    const capForThree = hold * 3;            // room for exactly three holds
    const { port, state } = fakeBudget(capForThree);
    callLLM.mockResolvedValue(answered(ONE_PROPERTY, 0.001));

    const results = await Promise.all(Array.from({ length: 10 }, () =>
      extractStockRowsFromText(BROCHURE, CONTEXT, { deadlineAt: Date.now() + 90_000, budget: port })
        .then(() => 'ok' as const, (e) => e.code as string)));

    // Reservations are taken before any settle lands, so exactly three fit.
    expect(results.filter((r) => r === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r === 'model_budget_exhausted')).toHaveLength(7);
    expect(callLLM).toHaveBeenCalledTimes(3);
    expect(state.committed + state.reserved).toBeLessThanOrEqual(capForThree);
  });

  it('no sequence of reads can leave the month over its cap', async () => {
    const { port, state } = fakeBudget(50_000);
    callLLM.mockResolvedValue(answered(ONE_PROPERTY, 0.002));
    for (let i = 0; i < 40; i += 1) {
      await extractStockRowsFromText(BROCHURE, CONTEXT,
        { deadlineAt: Date.now() + 90_000, budget: port }).catch(() => undefined);
      expect(state.committed + state.reserved).toBeLessThanOrEqual(50_000);
    }
    expect(state.committed).toBeLessThanOrEqual(50_000);
  });
});

describe('the ceiling never charges a deterministic import', () => {
  it('the budget is only reachable from the two model branches', () => {
    /*
     * A CSV or workbook that parses returns rows and never enters the guard,
     * so it takes no hold and spends nothing. Asserted structurally because
     * the alternative is asserting it about a fixture.
     */
    const fs = require('node:fs') as typeof import('node:fs');
    const code = fs.readFileSync(
      'supabase/functions/_shared/builderStock/runImport.ts', 'utf8');
    /*
     * The guard moved: `!rows.length` became `disposition.consulted`, which
     * is false both where the document already yielded a record and where the
     * optional assisted reader is switched off. See the Lot 37 incident in
     * `assistedReaderPolicy.pure.ts`.
     */
    const guardAt = code.indexOf('if (!disposition.consulted) {');
    expect(guardAt).toBeGreaterThan(-1);
    /*
     * AND NOTHING IS NOW RESERVED WHERE NOTHING WILL BE SPENT. The port used
     * to be constructed unconditionally; an import that calls no model must
     * reserve no budget at all.
     */
    expect(code).toMatch(
      /const budget = disposition\.consulted \? createAiBudget\(supabase\) : null;/);
    // Every use of the budget sits inside the "deterministic found nothing" guard.
    for (const marker of ['budget: budget! }', 'budget: budget! },']) {
      let from = 0;
      for (;;) {
        const at = code.indexOf(marker, from);
        if (at === -1) break;
        expect(at, `budget used before the guard: ${marker}`).toBeGreaterThan(guardAt);
        from = at + 1;
      }
    }
    // And it is passed, not defaulted — a forgotten budget is a type error.
    const extract = fs.readFileSync(
      'supabase/functions/_shared/builderStock/modelExtract.ts', 'utf8');
    expect(extract).toContain('budget: AiBudgetPort;');
    expect(extract).not.toMatch(/budget\?\s*:/);
  });
});
