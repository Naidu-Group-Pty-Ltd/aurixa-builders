/**
 * `modelExtract.run()` EXECUTED, not read.
 *
 * The first version of this fix was covered by tests that read the source and
 * checked the right identifiers appeared in it. They passed, and they were
 * blind to a live defect: `classifyModelFailure(attempts, fallback)` only uses
 * its fallback when `attempts` is EMPTY, and the array returned beside a
 * successful `callLLM` is not empty — it holds the winning attempt. So both
 * "the model did not call the tool" and "the arguments were not the right
 * shape" reduced to `model_unavailable`, which is marked RETRYABLE, and the
 * builder would have been told to "try again shortly" about an answer that
 * would never change.
 *
 * Reading the file could not see that. Running it can. `callLLM` is the only
 * thing replaced — every rule under test is the real one.
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
  StockModelExtractionError,
} from '../../../supabase/functions/_shared/builderStock/modelExtractionFailure.pure';

const CONTEXT = { filename: 'LOT 315 - ENZO 8.5 LUCA - BROCHURE V002.pdf', organisationName: 'Enzo Homes' };
const BROCHURE = 'LOT 315, ENZO 8.5 LUCA. 4 bed, 2 bath. $863,850.';

/** What `callLLM` returns when a model answered. */
function answered(args: unknown, attempts = [
  { route: 'gateway', model_id: 'google/gemini-2.5-flash', ok: true, status: 200 },
]) {
  return {
    content: '',
    rawResponse: {},
    modelUsed: 'google/gemini-2.5-flash',
    routeUsed: 'gateway',
    toolCalls: [{ function: { name: 'record_stock_items', arguments: args } }],
    attempts,
  };
}

/** The `LLMError` shape the router throws once every step has failed. */
function routerThrew(attempts: unknown[]) {
  return Object.assign(new Error('[llmRouter] All models failed'), { status: 503, attempts });
}

const run = () => extractStockRowsFromText(BROCHURE, CONTEXT, { deadlineAt: Date.now() + 90_000 });

beforeEach(() => { callLLM.mockReset(); });

describe('a model that answered properly', () => {
  it('imports the property the brochure states', async () => {
    callLLM.mockResolvedValue(answered(JSON.stringify({
      items: [{ lot_number: '315', bedrooms: 4, bathrooms: 2, price: '$863,850' }],
    })));
    const result = await run();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ lot_number: '315', bedrooms: 4, price: '$863,850' });
    expect(result.modelUsed).toBe('google/gemini-2.5-flash');
  });

  it('a well-formed EMPTY answer yields no rows and does NOT throw', async () => {
    /*
     * The one case that must survive as "nothing": a model that read the
     * document and found no property. `runImport` turns this into
     * `no_properties_found`, which is the correct thing to say about it.
     */
    callLLM.mockResolvedValue(answered(JSON.stringify({ items: [] })));
    await expect(run()).resolves.toMatchObject({ rows: [] });
  });

  it('drops a non-object entry without failing the whole answer', async () => {
    callLLM.mockResolvedValue(answered(JSON.stringify({
      items: [{ lot_number: '315' }, null, 'not a property'],
    })));
    const result = await run();
    expect(result.rows).toEqual([{ lot_number: '315' }]);
  });
});

describe('an unusable answer is a typed failure, never zero rows', () => {
  /** The regression that the source-reading tests could not see. */
  const expectFailure = async (code: string) => {
    const error = await run().then(() => null, (e) => e);
    expect(error, 'should have thrown, not returned rows').toBeInstanceOf(StockModelExtractionError);
    expect(error.code).toBe(code);
    return error as StockModelExtractionError;
  };

  it('a missing tool call is model_missing_tool_call, NOT model_unavailable', async () => {
    callLLM.mockResolvedValue({
      ...answered('{}'), toolCalls: [{ function: { name: 'something_else', arguments: '{}' } }],
    });
    const error = await expectFailure('model_missing_tool_call');
    // It names the model that produced it rather than calling it an outage.
    expect(error.categories).toEqual(['ok']);
    expect(error.diagnosis).toContain('gateway/google/gemini-2.5-flash');
  });

  it('malformed tool arguments are model_invalid_response', async () => {
    callLLM.mockResolvedValue(answered('{"items": [ this is not json'));
    await expectFailure('model_invalid_response');
  });

  it('a MISSING items key is model_invalid_response', async () => {
    /*
     * Reachable, not theoretical: the router's `requireValidToolArguments`
     * only proves the arguments PARSE. Nothing there checks the schema, so a
     * well-formed `{}` passes the whole chain and arrives here.
     */
    callLLM.mockResolvedValue(answered('{}'));
    await expectFailure('model_invalid_response');
  });

  it('items of the wrong type is model_invalid_response', async () => {
    callLLM.mockResolvedValue(answered(JSON.stringify({ items: { lot: '315' } })));
    await expectFailure('model_invalid_response');
  });

  it('none of these ever resolves to rows', async () => {
    for (const args of ['{}', 'not json', JSON.stringify({ items: 7 })]) {
      callLLM.mockResolvedValue(answered(args));
      await expect(run(), `args=${args}`).rejects.toBeInstanceOf(StockModelExtractionError);
    }
  });
});

describe('a chain that failed carries the router’s own account', () => {
  it('the production failure — every model unconfigured — is model_unavailable', async () => {
    callLLM.mockRejectedValue(routerThrew([
      { route: 'gateway', model_id: 'google/gemini-2.5-flash', ok: false, error: 'provider_not_configured' },
      { route: 'gateway', model_id: 'google/gemini-3-flash-preview', ok: false, error: 'provider_not_configured' },
    ]));
    const error = await run().then(() => null, (e) => e);
    expect(error.code).toBe('model_unavailable');
    expect(error.attemptCount).toBe(2);
    expect(error.categories).toEqual(['unconfigured', 'unconfigured']);
  });

  it('an all-timeout chain is model_timeout', async () => {
    callLLM.mockRejectedValue(routerThrew([
      { route: 'gateway', model_id: 'a', ok: false, status: 504, error: 'provider_timeout' },
      { route: 'native', model_id: 'gpt-4o-mini', ok: false, status: 504, error: 'provider_timeout' },
    ]));
    await expect(run()).rejects.toMatchObject({ code: 'model_timeout' });
  });

  it('a mixture is infrastructure, not a timeout', async () => {
    callLLM.mockRejectedValue(routerThrew([
      { route: 'gateway', model_id: 'a', ok: false, status: 504, error: 'provider_timeout' },
      { route: 'native', model_id: 'gpt-4o-mini', ok: false, error: 'provider_not_configured' },
    ]));
    await expect(run()).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('a throw carrying no attempts still classifies, on the retryable side', async () => {
    callLLM.mockRejectedValue(new Error('something escaped the router'));
    await expect(run()).rejects.toMatchObject({ code: 'model_unavailable', attemptCount: 0 });
  });

  it('no diagnosis carries a provider body, a key or a URL', async () => {
    callLLM.mockRejectedValue(routerThrew([
      { route: 'gateway', model_id: 'a', ok: false, status: 401, error: 'provider_http_401' },
    ]));
    const error = await run().then(() => null, (e) => e);
    expect(error.diagnosis).not.toMatch(/api[_-]?key|bearer|https?:\/\//i);
  });
});

describe('the call the router is actually handed', () => {
  it('names the agent, demands the tool, and bounds one attempt', async () => {
    callLLM.mockResolvedValue(answered(JSON.stringify({ items: [] })));
    await run();
    const args = callLLM.mock.calls[0][0] as Record<string, unknown>;
    expect(args.agentKey).toBe('builder_stock_extraction');
    expect(args.requiredToolName).toBe('record_stock_items');
    expect(args.requireValidToolArguments).toBe(true);
    expect(args.temperature).toBe(0);
    // The whole-chain budget is the caller's; one attempt may not spend it all.
    expect(args.timeoutMs).toBe(40_000);
    expect(typeof args.deadlineAt).toBe('number');
    // Metering is left at its default — a forwarded key must never go unbilled.
    expect(args.meterUsage).toBeUndefined();
  });

  it('the brochure text reaches the model and the prompt still forbids invention', async () => {
    callLLM.mockResolvedValue(answered(JSON.stringify({ items: [] })));
    await run();
    const args = callLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(args.messages[0].role).toBe('system');
    expect(args.messages[0].content).toContain('NEVER invent a value');
    expect(args.messages[1].content).toContain(BROCHURE);
  });
});
