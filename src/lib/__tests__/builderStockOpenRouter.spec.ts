/**
 * Builder Stock reads through OpenRouter, and through nothing else.
 *
 * The configuration lives in a migration rather than in code, so these assert
 * the migration — the artefact that actually reaches a deployment — and the
 * one place the budget restates the same chain. Two copies of one decision is
 * how the two come to disagree, so the second is checked against the first.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BUDGET_CHAIN, OPENROUTER_MODEL_RATES,
} from '../../../supabase/functions/_shared/builderStock/aiBudget.pure';

const MIGRATIONS = 'supabase/migrations';
const read = (p: string) => readFileSync(p, 'utf8');

/** The migration that sets the assignment, found by content not by name. */
/** Just the statement, with the explanatory header stripped off. */
const statementOf = (sql: string) => sql.slice(sql.indexOf('INSERT INTO'));

const routeMigration = (() => {
  const file = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .find((f) => read(`${MIGRATIONS}/${f}`).includes("'builder_stock_extraction'")
      && read(`${MIGRATIONS}/${f}`).includes('openrouter'));
  if (!file) throw new Error('no migration sets builder_stock_extraction to openrouter');
  return { file, sql: read(`${MIGRATIONS}/${file}`) };
})();

describe('the route is OpenRouter', () => {
  it('the assignment names the openrouter route', () => {
    const statement = statementOf(routeMigration.sql);
    expect(statement).toContain("'openrouter'");
    // The route column is set to it, not merely mentioned in prose.
    expect(statement).toMatch(/VALUES \([\s\S]*?'openrouter',/);
  });

  it('Luna is the primary model', () => {
    const statement = statementOf(routeMigration.sql);
    const luna = statement.indexOf("'openai/gpt-5.6-luna'");
    const gemini = statement.indexOf('google/gemini-3.8-flash');
    expect(luna).toBeGreaterThan(-1);
    expect(gemini).toBeGreaterThan(-1);
    // The primary sits in the VALUES list, before the fallback_chain literal.
    expect(luna).toBeLessThan(gemini);
  });

  it('Gemini 3.8 Flash is the ONLY fallback, and it is on openrouter too', () => {
    const chain = routeMigration.sql.match(/'\[\{[\s\S]*?\}\]'::jsonb/);
    expect(chain, 'fallback_chain literal not found').not.toBeNull();
    const parsed = JSON.parse(chain![0].replace(/'::jsonb$/, '').replace(/^'/, ''));
    expect(parsed).toEqual([{ route: 'openrouter', model_id: 'google/gemini-3.8-flash' }]);
  });

  it('temperature is 0 and the tool ceiling is preserved', () => {
    expect(routeMigration.sql).toMatch(/\n\s*0,\s*\n\s*8000,/);
  });

  it('the assignment never re-points a chain an operator chose themselves', () => {
    // Scoped to the gateway row this repository seeded.
    expect(routeMigration.sql).toContain("WHERE public.agent_model_assignments.route = 'gateway'");
  });
});

describe('Lovable is not in this path', () => {
  it('the assignment names no gateway route for the model or its fallback', () => {
    const parsedChain = JSON.parse(
      routeMigration.sql.match(/'\[\{[\s\S]*?\}\]'::jsonb/)![0]
        .replace(/'::jsonb$/, '').replace(/^'/, ''));
    for (const step of parsedChain) expect(step.route).toBe('openrouter');
    // The only 'gateway' in the file is the WHERE that retires it.
    const gatewayMentions = statementOf(routeMigration.sql).match(/'gateway'/g) ?? [];
    expect(gatewayMentions).toHaveLength(1);
  });

  it('no Builder Stock module names the Lovable key or its gateway host', () => {
    const dir = 'supabase/functions/_shared/builderStock';
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const code = read(`${dir}/${f}`);
      expect(code, `${f} names LOVABLE_API_KEY`).not.toContain('LOVABLE_API_KEY');
      expect(code, `${f} names the Lovable gateway host`).not.toContain('gateway.lovable.dev');
    }
  });

  it('the EXTRACTION path calls no provider directly — only the router', () => {
    /*
     * Scoped to the modules the assisted reader is made of. Builder Stock's
     * IMAGE ladder is a separate, pre-existing path with its own provider
     * (below); conflating the two would make this assertion either false or
     * meaningless.
     */
    for (const f of ['modelExtract.ts', 'runImport.ts', 'aiBudget.ts',
      'aiBudget.pure.ts', 'modelExtractionFailure.pure.ts', 'assistedReaderFailure.pure.ts']) {
      const code = read(`supabase/functions/_shared/builderStock/${f}`);
      for (const host of ['api.openai.com', 'api.anthropic.com', 'api.perplexity.ai',
        'generativelanguage.googleapis.com', 'openrouter.ai', 'gateway.lovable.dev']) {
        expect(code, `${f} calls ${host} directly`).not.toContain(host);
      }
      // The one way out is the shared router.
      if (f === 'modelExtract.ts') expect(code).toContain("from '../llmRouter.ts'");
    }
  });

  it('the image ladder’s own provider is UNTOUCHED and outside this budget', () => {
    /*
     * PRE-EXISTING, AND NOT WHAT THIS CHANGE GOVERNS. `images.ts` calls
     * Perplexity directly through `meteredFetch` as the internet-search stage
     * of the image ladder. It predates this work, it is metered to
     * `api_usage_log` like every other vendor call, and it is NOT covered by
     * the US$10 ceiling — that cap is scoped to `builder_stock_extraction`,
     * which is the reading of documents and not the finding of pictures.
     *
     * Pinned here so the distinction is deliberate rather than an oversight,
     * and so a future change cannot quietly fold one into the other.
     */
    const images = read('supabase/functions/_shared/builderStock/images.ts');
    expect(images).toContain('api.perplexity.ai');
    expect(images).toContain('meteredFetch');
    // It does not reach the extraction agent's budget or its agent key.
    expect(images).not.toContain('builder_stock_extraction');
    expect(images).not.toContain('ai_budget_reserve');
  });
});

describe('the budget and the assignment describe the same chain', () => {
  it('BUDGET_CHAIN is exactly the migration’s primary plus its fallback', () => {
    const fallback = JSON.parse(
      routeMigration.sql.match(/'\[\{[\s\S]*?\}\]'::jsonb/)![0]
        .replace(/'::jsonb$/, '').replace(/^'/, ''))
      .map((s: { model_id: string }) => s.model_id);
    expect(BUDGET_CHAIN).toEqual(['openai/gpt-5.6-luna', ...fallback]);
  });

  it('every model in the chain has a rate, so no hold is sized by guesswork', () => {
    for (const model of BUDGET_CHAIN) {
      expect(OPENROUTER_MODEL_RATES[model], `no rate for ${model}`).toBeDefined();
      expect(OPENROUTER_MODEL_RATES[model].inputPerM).toBeGreaterThan(0);
      expect(OPENROUTER_MODEL_RATES[model].outputPerM).toBeGreaterThan(0);
    }
  });
});

describe('the ceiling exists in the database, not only in the application', () => {
  const budgetMigration = (() => {
    const file = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
      .find((f) => read(`${MIGRATIONS}/${f}`).includes('ai_budget_reserve'));
    if (!file) throw new Error('no migration creates ai_budget_reserve');
    return read(`${MIGRATIONS}/${file}`);
  })();

  it('the decision and the hold are ONE statement', () => {
    // The ceiling test lives in the UPDATE's WHERE clause, which is what makes
    // concurrent callers serialise on the row rather than race each other.
    expect(budgetMigration).toMatch(
      /UPDATE public\.ai_spend_budgets[\s\S]*?WHERE[\s\S]*?committed_micros \+ b\.reserved_micros \+ p_amount_micros <= b\.cap_micros/);
  });

  it('the month is derived, so nothing has to run to reset it', () => {
    expect(budgetMigration).toContain("date_trunc('month', now() AT TIME ZONE 'utc')");
    expect(budgetMigration).toContain('PRIMARY KEY (agent_key, period_month)');
  });

  it('an abandoned hold is reclaimed rather than eating the month', () => {
    expect(budgetMigration).toContain('ai_budget_reclaim_expired');
    expect(budgetMigration).toContain("state = 'expired'");
  });

  it('a settle can never commit more than it held', () => {
    expect(budgetMigration).toContain('LEAST(GREATEST(p_actual_micros, 0), amount_micros)');
  });

  it('the budget is service-role only', () => {
    expect(budgetMigration).toContain('REVOKE ALL ON public.ai_spend_budgets FROM anon, authenticated');
    expect(budgetMigration).toContain('GRANT ALL ON public.ai_spend_budgets TO service_role');
    expect(budgetMigration).toContain('ENABLE ROW LEVEL SECURITY');
  });
});

describe('the existing usage ledger was extended, not replaced', () => {
  it('the router books the provider’s own reported cost when there is one', () => {
    const router = read('supabase/functions/_shared/llmRouter.ts');
    expect(router).toContain('extractReportedCostUsd');
    expect(router).toContain('cost_estimate_usd: reportedCostUsd');
    expect(router).toContain("cost_source: 'provider_reported'");
    // Still the same one ledger call.
    expect(router.match(/await logApiUsage\(/g) ?? []).toHaveLength(1);
  });

  it('the two new model ids are priced in the existing estimator', () => {
    const log = read('supabase/functions/_shared/logApiUsage.ts');
    expect(log).toContain("'openai/gpt-5.6-luna'");
    expect(log).toContain("'google/gemini-3.8-flash'");
  });

  it('no second billing table was created for this', () => {
    const budgetFiles = readdirSync(MIGRATIONS)
      .filter((f) => read(`${MIGRATIONS}/${f}`).includes('ai_spend_budgets'));
    expect(budgetFiles).toHaveLength(1);
    const sql = read(`${MIGRATIONS}/${budgetFiles[0]}`);
    // The ceiling table answers "may this call happen"; api_usage_log remains
    // the record of what was spent. The budget must not shadow it.
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS public.api_usage_log');
  });
});
