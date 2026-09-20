/**
 * The assisted stock reader: what failed, and what the builder is told.
 *
 * Every case here is drawn from one production failure — `LOT 315 - ENZO 8.5
 * LUCA - BROCHURE V002.pdf`, a 6.8 MB property brochure uploaded on
 * 20 September 2026, which `builder_stock_uploads` recorded as
 *
 *   error_code   assisted_reader_unavailable
 *   error_detail {"detail": "[llmRouter] All 2 models failed for
 *                 agent_key=builder_stock_extraction"}
 *
 * and put in front of the builder as "Its columns were not recognised as a
 * stock list … giving it column headings lets it import without assistance."
 *
 * The two properties this file exists to hold: an infrastructure failure never
 * reads as a finding about the document, and a document that has no columns is
 * never told to grow some.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  categoriseAttempt,
  classifyModelFailure,
  modelFailureFromRouterError,
  StockModelExtractionError,
  summariseAttempts,
  ROUTER_MISSING_TOOL_PREFIX,
  ROUTER_INVALID_ARGUMENTS_PREFIX,
  type RouterAttempt,
} from '../../../supabase/functions/_shared/builderStock/modelExtractionFailure.pure';
import {
  assistedReaderFailure,
  RETRYABLE_UPLOAD_ERROR_CODES,
  SOURCE_HAS_COLUMNS,
} from '../../../supabase/functions/_shared/builderStock/assistedReaderFailure.pure';

const SHARED = 'supabase/functions/_shared';
const read = (path: string) => readFileSync(path, 'utf8');

/** The attempt array the router builds when a gateway credential is absent. */
const UNCONFIGURED_CHAIN: RouterAttempt[] = [
  { route: 'gateway', model_id: 'google/gemini-2.5-flash', ok: false, error: 'provider_not_configured' },
  { route: 'gateway', model_id: 'google/gemini-3-flash-preview', ok: false, error: 'provider_not_configured' },
];

describe('what the router already knew and nobody read', () => {
  it('names the production failure as unavailable, not as a verdict on the brochure', () => {
    const diagnosis = classifyModelFailure(UNCONFIGURED_CHAIN);
    expect(diagnosis.code).toBe('model_unavailable');
    expect(diagnosis.attemptCount).toBe(2);
    expect(diagnosis.categories).toEqual(['unconfigured', 'unconfigured']);
  });

  it('a chain that only ran out of clock is a timeout', () => {
    const diagnosis = classifyModelFailure([
      { route: 'gateway', model_id: 'a', ok: false, status: 504, error: 'provider_timeout' },
      { route: 'gateway', model_id: 'b', ok: false, status: 504, error: 'deadline exceeded before attempt' },
    ]);
    expect(diagnosis.code).toBe('model_timeout');
  });

  it('a MIXTURE is infrastructure, never a timeout', () => {
    /*
     * Telling a builder to wait is only honest when waiting is what would
     * help. One model that hung beside one whose credential is missing is not
     * a slow day; it is a deployment that cannot reach its reader.
     */
    const diagnosis = classifyModelFailure([
      { route: 'gateway', model_id: 'a', ok: false, status: 504, error: 'provider_timeout' },
      { route: 'native', model_id: 'gpt-4o-mini', ok: false, error: 'provider_not_configured' },
    ]);
    expect(diagnosis.code).toBe('model_unavailable');
  });

  it('every model answering without the required tool call is its own code', () => {
    const diagnosis = classifyModelFailure([
      { route: 'gateway', model_id: 'a', ok: false, status: 422, error: `${ROUTER_MISSING_TOOL_PREFIX}: record_stock_items` },
      { route: 'gateway', model_id: 'b', ok: false, status: 422, error: `${ROUTER_MISSING_TOOL_PREFIX}: record_stock_items` },
    ]);
    expect(diagnosis.code).toBe('model_missing_tool_call');
  });

  it('unparseable tool arguments are an invalid response', () => {
    const diagnosis = classifyModelFailure([
      { route: 'gateway', model_id: 'a', ok: false, status: 422, error: `${ROUTER_INVALID_ARGUMENTS_PREFIX}: record_stock_items` },
    ]);
    expect(diagnosis.code).toBe('model_invalid_response');
  });

  it('a refused credential and a provider outage are told apart', () => {
    expect(categoriseAttempt({ status: 401, error: 'provider_http_401' })).toBe('refused');
    expect(categoriseAttempt({ status: 503, error: 'provider_http_503' })).toBe('unavailable');
  });

  it('an error carrying no attempts still classifies, on the retryable side', () => {
    const failure = modelFailureFromRouterError(new Error('something escaped the router'));
    expect(failure).toBeInstanceOf(StockModelExtractionError);
    expect(failure.code).toBe('model_unavailable');
    expect(failure.attemptCount).toBe(0);
  });

  it('the diagnosis carries routes and models and no provider body', () => {
    const line = summariseAttempts(UNCONFIGURED_CHAIN);
    expect(line).toContain('gateway/google/gemini-2.5-flash');
    expect(line).toContain('unconfigured');
    // `safeAttemptError` has already reduced the provider's words to a token;
    // nothing here may re-widen that.
    expect(line).not.toMatch(/api[_-]?key/i);
    expect(line).not.toMatch(/bearer/i);
  });
});

describe('the classifier and the router share one vocabulary', () => {
  it('the two strings the router composes are the two this module matches', () => {
    /*
     * These are the ROUTER'S OWN words, not a provider's — which is what makes
     * reading them safe. Two copies of one vocabulary in two files is how the
     * two ends drift, so this reads the router rather than trusting it.
     */
    const router = read(`${SHARED}/llmRouter.ts`);
    expect(router).toContain(`\`${ROUTER_MISSING_TOOL_PREFIX}: \${args.requiredToolName}\``);
    expect(router).toContain(`\`${ROUTER_INVALID_ARGUMENTS_PREFIX}: \${args.requiredToolName}\``);
    expect(router).toContain("error: 'deadline exceeded before attempt'");
    expect(router).toContain("return 'provider_timeout'");
    expect(router).toContain("return 'provider_not_configured'");
  });
});

describe('a brochure is never told to grow columns', () => {
  const documentKinds = ['pdf', 'image', 'word', 'richtext', 'presentation'] as const;

  it('no message drawn for a document kind mentions a column', () => {
    for (const kind of documentKinds) {
      for (const code of [
        'model_unavailable', 'model_timeout', 'model_invalid_response', 'model_missing_tool_call',
      ] as const) {
        const reading = assistedReaderFailure({ code, sourceKind: 'file', classificationKind: kind });
        expect(reading.message.toLowerCase(), `${kind}/${code}`).not.toContain('column');
        expect(reading.message.toLowerCase(), `${kind}/${code}`).not.toContain('heading');
        expect(reading.message.toLowerCase(), `${kind}/${code}`).not.toContain('spreadsheet');
        expect(reading.message.toLowerCase(), `${kind}/${code}`).not.toContain('per row');
      }
    }
  });

  it('the production case reads as our failure and offers a retry', () => {
    const reading = assistedReaderFailure({
      code: 'model_unavailable', sourceKind: 'file', classificationKind: 'pdf',
    });
    expect(reading.code).toBe('assisted_reader_unavailable');
    expect(reading.message).toBe(
      'We read that file, but the assisted property reader was temporarily unavailable.'
      + ' Try reading this source again shortly.');
    expect(reading.retryable).toBe(true);
    expect(reading.status).toBe(503);
  });

  it('a spreadsheet DOES keep the heading hint, because it is true of one', () => {
    const reading = assistedReaderFailure({
      code: 'model_unavailable', sourceKind: 'file', classificationKind: 'spreadsheet',
    });
    expect(reading.message).toContain('column headings');
    // …and the statement about us still leads it.
    expect(reading.message.indexOf('assisted property reader'))
      .toBeLessThan(reading.message.indexOf('column headings'));
  });

  it('an unclassified source is treated as a document', () => {
    const reading = assistedReaderFailure({ code: 'model_unavailable', sourceKind: 'url' });
    expect(reading.message.toLowerCase()).not.toContain('column');
  });

  it('each failure keeps a distinct, stable machine-readable code', () => {
    const code = (c: Parameters<typeof assistedReaderFailure>[0]['code']) =>
      assistedReaderFailure({ code: c, sourceKind: 'file', classificationKind: 'pdf' }).code;
    expect(code('model_unavailable')).toBe('assisted_reader_unavailable');
    expect(code('model_timeout')).toBe('assisted_reader_timeout');
    expect(code('model_invalid_response')).toBe('assisted_reader_invalid_response');
    expect(code('model_missing_tool_call')).toBe('assisted_reader_invalid_response');
  });

  it('an unusable answer promises no retry, because a retry cannot help', () => {
    const reading = assistedReaderFailure({
      code: 'model_invalid_response', sourceKind: 'file', classificationKind: 'pdf',
    });
    expect(reading.retryable).toBe(false);
    expect(reading.message).not.toContain('again shortly');
    expect(RETRYABLE_UPLOAD_ERROR_CODES).not.toContain(reading.code);
  });

  it('the retryable list is exactly the readings that say retryable', () => {
    /*
     * One list, two readers (this module and the portal's button). Derived
     * here rather than typed twice, so a new code cannot be added to one and
     * forgotten in the other.
     */
    const derived = (['model_unavailable', 'model_timeout', 'model_invalid_response',
      'model_missing_tool_call'] as const)
      .map((code) => assistedReaderFailure({ code, sourceKind: 'file', classificationKind: 'pdf' }))
      .filter((reading) => reading.retryable)
      .map((reading) => reading.code);
    expect([...new Set(derived)].sort()).toEqual([...RETRYABLE_UPLOAD_ERROR_CODES].sort());
  });

  it('the grid kinds are the ones the deterministic readers actually parse', () => {
    expect([...SOURCE_HAS_COLUMNS].sort()).toEqual(
      ['delimited', 'markup', 'opendocument', 'spreadsheet', 'structured']);
    for (const kind of documentKinds) expect(SOURCE_HAS_COLUMNS.has(kind)).toBe(false);
  });
});

describe('an unusable model answer is not an empty document', () => {
  const modelExtract = read(`${SHARED}/builderStock/modelExtract.ts`);

  it('a missing tool call throws instead of returning zero rows', () => {
    expect(modelExtract).toContain("'model_missing_tool_call'");
    expect(modelExtract).not.toContain('if (!call) return { rows: [], modelUsed: result.modelUsed };');
  });

  it('unparseable arguments and an absent items key both throw', () => {
    expect(modelExtract).toContain("'model_invalid_response'");
    expect(modelExtract).toContain('if (!Array.isArray(parsed.items))');
    // The old silent collapse, in both of its spellings.
    expect(modelExtract).not.toContain('return { rows: [], modelUsed: result.modelUsed };');
  });

  it('a WELL-FORMED empty answer still reports no properties', () => {
    /*
     * The one case that must NOT become a typed failure: a model that read the
     * document properly and found nothing in it. `items: []` passes the array
     * check and falls through to the ordinary row loop, which yields none —
     * and `no_properties_found` is the correct thing to say about that.
     */
    const loopAt = modelExtract.indexOf('for (const item of parsed.items.slice(0, 2000))');
    const guardAt = modelExtract.indexOf('if (!Array.isArray(parsed.items))');
    expect(guardAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(guardAt);
    expect(modelExtract).toContain('return { rows, modelUsed: result.modelUsed };');
  });

  it('the router error is classified once, at the call, not matched downstream', () => {
    expect(modelExtract).toContain('modelFailureFromRouterError(error)');
  });
});

describe('the import records why, and tells the builder something true', () => {
  const runImport = read(`${SHARED}/builderStock/runImport.ts`);

  it('the model call is still inside the guard, so no path escapes it', () => {
    const guardAt = runImport.indexOf('  try {\n    if (!rows.length');
    expect(guardAt).toBeGreaterThan(-1);
    expect(runImport.indexOf('extractStockRowsFromImages(')).toBeGreaterThan(guardAt);
    expect(runImport.indexOf('extractStockRowsFromText(')).toBeGreaterThan(guardAt);
  });

  it('the reading comes from the shared modules rather than a literal sentence', () => {
    expect(runImport).toContain('assistedReaderFailure({');
    expect(runImport).toContain('classificationKind: classification.kind');
    // The sentence that shipped to a brochure uploader.
    expect(runImport).not.toContain('Its columns were not recognised as');
    expect(runImport).not.toContain('the assisted reader could not be reached');
  });

  it('the zero-row branch answers to the same column rule', () => {
    expect(runImport).toContain('SOURCE_HAS_COLUMNS.has(classification.kind)');
  });

  it('the row keeps a structured diagnosis, not just a count of failures', () => {
    expect(runImport).toContain('detail: JSON.stringify({');
    expect(runImport).toContain('categories: failure.categories');
    expect(runImport).toContain('attempts: failure.attemptCount');
  });

  it('the log carries enough to diagnose without the builder document', () => {
    for (const field of [
      'upload_id', 'organisation_id', 'source_kind', 'classification',
      'extraction_strategy', 'text_extracted', 'text_length', 'page_count',
      'assisted_extraction_started', 'failure_code', 'attempt_categories',
    ]) expect(runImport).toContain(field);
  });

  it('the log carries no document content and no credential', () => {
    const logAt = runImport.indexOf('assisted reader failed');
    const block = runImport.slice(logAt, logAt + 1400);
    // A LENGTH is the fact worth having; the prose itself never travels.
    expect(block).toContain('text_length');
    expect(block).not.toMatch(/text:\s*extraction\.text/);
    expect(block).not.toContain('signed_url');
    expect(block).not.toContain('source_url');
  });

  it('one attempt may not spend the whole chain budget', () => {
    /*
     * 90 s of wall clock with a 60 s per-attempt ceiling left the fallback 30 s
     * — and only if the first model failed fast. Two 40 s attempts fit.
     */
    const extract = read(`${SHARED}/builderStock/modelExtract.ts`);
    const budget = Number(/MODEL_BUDGET_MS = ([\d_]+)/.exec(runImport)?.[1]?.replace(/_/g, ''));
    const attempt = Number(/MODEL_ATTEMPT_TIMEOUT_MS = ([\d_]+)/.exec(extract)?.[1]?.replace(/_/g, ''));
    expect(budget).toBeGreaterThan(0);
    expect(attempt).toBeGreaterThan(0);
    expect(attempt * 2).toBeLessThanOrEqual(budget);
  });
});

describe('the portal can try a failed read again', () => {
  it('the page offers a retry on exactly the retryable failures', () => {
    const page = read('src/pages/builder/BuilderStockList.tsx');
    expect(page).toContain('RETRYABLE_UPLOAD_ERROR_CODES.includes(String(upload.error_code ?? \'\'))');
    expect(page).toContain('canRetryFailure(upload) ?');
    expect(page).toContain('Read again');
  });

  it('it uses process_upload, which is the operation that accepts a failed row', () => {
    const queries = read('src/lib/builderStockQueries.ts');
    const hookAt = queries.indexOf('export function useRetryStockSource()');
    expect(hookAt).toBeGreaterThan(-1);
    expect(queries.slice(hookAt, hookAt + 500)).toContain("operation: 'process_upload'");
  });

  it('the server still accepts a failed row there, and refuses a live one', () => {
    const handler = read('supabase/functions/builder-portal-stock/index.ts');
    expect(handler).toContain("if (!['uploaded', 'failed'].includes(String(upload.status)))");
    // The duplicate guard must keep excluding the row from itself, or a retry
    // would report the source as a duplicate of the source.
    expect(read(`${SHARED}/builderStock/runImport.ts`)).toContain(".neq('id', upload.id)");
  });
});
