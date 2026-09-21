/**
 * A WORKER KILL IS UNDETERMINED WHICHEVER DOOR IT COMES THROUGH.
 *
 * `invokeBuilderFunction` has carried that rule since 27 AUGUST 2026, when a
 * stock import was killed after committing the upload and every property in
 * it, the portal reported "Failed to fetch", and the builder imported the same
 * list again. It was installed on the rejected-`fetch` door only.
 *
 * On 21 SEPTEMBER 2026 the same kill arrived through the other one: the
 * platform answered FOR the dead worker with **546**, a real status with no
 * body, so the answer took the ordinary-refusal branch and the page drew
 * "The stock list could not be imported" over an import that had written its
 * property, its nine images and its own success line.
 */
import { describe, expect, it } from 'vitest';
import {
  bodyIsFunctionsOwn,
  isPlatformSilence,
  PLATFORM_SILENCE_STATUSES,
  UNDETERMINED_ANSWER_CODE,
} from '../builderPortalAnswer.pure';

describe('who answered', () => {
  it('reads a 546 with no body as the platform, not the function', () => {
    // The production answer: Supabase WORKER_LIMIT. `response.json()` fails,
    // so the body is null.
    expect(isPlatformSilence(546, null)).toBe(true);
  });

  it('reads the gateway codes the same way', () => {
    expect(isPlatformSilence(502, null)).toBe(true);
    expect(isPlatformSilence(504, null)).toBe(true);
  });

  /*
   * THE SECOND CONDITION IS WHAT KEEPS IT HONEST. A handler that answers with
   * its own `{ error, code }` has spoken for itself and must be reported as it
   * asked to be — the digit alone decides nothing.
   */
  it('lets a function that spoke for itself keep its own words', () => {
    expect(isPlatformSilence(502, { error: 'Upstream refused', code: 'upstream_refused' }))
      .toBe(false);
    expect(isPlatformSilence(546, { code: 'file_too_large' })).toBe(false);
  });

  it('never reads a plain server error as undetermined', () => {
    // A 500 is overwhelmingly this product's own handler failing and saying
    // so. Admitting it would turn every genuine server error into "we do not
    // know", which is worse than a plain refusal.
    expect(isPlatformSilence(500, null)).toBe(false);
    expect(PLATFORM_SILENCE_STATUSES).not.toContain(500);
  });

  it('never reads an ordinary refusal as undetermined', () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      expect(isPlatformSilence(status, null)).toBe(false);
    }
  });
});

describe('what counts as the function speaking', () => {
  it('accepts either field a handler here answers with', () => {
    expect(bodyIsFunctionsOwn({ error: 'That file is empty.' })).toBe(true);
    expect(bodyIsFunctionsOwn({ code: 'duplicate_file' })).toBe(true);
  });

  it('rejects everything that is not this function talking', () => {
    // A failed parse, the platform's own empty object, its HTML error page,
    // and a body whose fields are present but say nothing.
    expect(bodyIsFunctionsOwn(null)).toBe(false);
    expect(bodyIsFunctionsOwn({})).toBe(false);
    expect(bodyIsFunctionsOwn('<html>upstream error</html>')).toBe(false);
    expect(bodyIsFunctionsOwn([{ error: 'x' }])).toBe(false);
    expect(bodyIsFunctionsOwn({ error: '', code: '' })).toBe(false);
    expect(bodyIsFunctionsOwn({ error: 546 })).toBe(false);
  });
});

describe('the code the page already knows how to read', () => {
  /*
   * `reportImportFailure` branches on `transport_failed` to draw "This import
   * did not report back" instead of the destructive heading. A NEW code here
   * would need that page — and every other caller — edited to recognise it,
   * which is how one surface comes to warn about something another does not.
   */
  it('reuses the code the undetermined branch already keys on', () => {
    expect(UNDETERMINED_ANSWER_CODE).toBe('transport_failed');
  });
});

/*
 * AND THE TRANSPORT IS EXECUTED, NOT READ.
 *
 * The first version of this block asserted the ORDER of the guard against the
 * ordinary-refusal branch in the source — and a mutation that neutered the
 * guard (`if (false && isPlatformSilence(...))`) left that text exactly where
 * it was and passed. A source scan can see that a rule is written; only
 * running it can see that it is applied. This repository has paid for the
 * difference more than once: `builderPortalUiMounted.spec.ts` exists because
 * an unused export typechecks, lints and builds.
 */
describe('the transport applies it', () => {
  const answerWith = (status: number, body: unknown, ok = false) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return body;
      },
    })) as unknown as typeof globalThis.fetch;
    return () => { globalThis.fetch = original; };
  };

  it('reports a 546 with no body as undetermined, not as a failure', async () => {
    const restore = answerWith(546, undefined);
    try {
      const { invokeBuilderFunction } = await import('../builderPortal');
      const result = await invokeBuilderFunction('builder-portal-stock', {});
      expect(result.error?.code).toBe(UNDETERMINED_ANSWER_CODE);
      expect(
        result.error?.message,
        'the builder is told their import failed over one that committed',
      ).not.toContain('HTTP 546');
      expect(result.error?.status).toBe(546);
    } finally { restore(); }
  });

  it('keeps a function that spoke for itself saying what it said', async () => {
    const restore = answerWith(409, { error: 'This content has already been imported.', code: 'duplicate_file' });
    try {
      const { invokeBuilderFunction } = await import('../builderPortal');
      const result = await invokeBuilderFunction('builder-portal-stock', {});
      expect(result.error?.code).toBe('duplicate_file');
      expect(result.error?.message).toBe('This content has already been imported.');
    } finally { restore(); }
  });

  it('still reports a plain server error as a refusal', async () => {
    const restore = answerWith(500, undefined);
    try {
      const { invokeBuilderFunction } = await import('../builderPortal');
      const result = await invokeBuilderFunction('builder-portal-stock', {});
      expect(result.error?.code).toBeUndefined();
      expect(result.error?.message).toBe('HTTP 500');
    } finally { restore(); }
  });

  it('keeps the rule in the one shared transport', async () => {
    // Every Builder Portal call goes through `invokeBuilderFunction`, so the
    // rule reaches every call site without one of them being edited.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/lib/builderPortal.ts'), 'utf8');
    expect((source.match(/isPlatformSilence\(/g) ?? [])).toHaveLength(1);
  });
});
