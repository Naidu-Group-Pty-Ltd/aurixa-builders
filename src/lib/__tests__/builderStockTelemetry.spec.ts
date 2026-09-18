/**
 * WHAT AN IMPORT SAYS ABOUT ITSELF, AND WHAT IT MUST NEVER SAY.
 *
 * THE DEFECT THESE PIN. The 17–18 September 2026 incident took four rounds of
 * forensics because the four questions a reader needed — which TAB, what
 * became of each ITEM, where a PDF was ELECTED, why the upload did not
 * PUBLISH — had no answer anywhere in the logs. Every stage had reported
 * normal operation, so nothing had been written down at all.
 *
 * The second half is the constraint that makes the first half safe: these
 * lines travel to a log aggregator, so a bearer token, a signed URL or a
 * customer's own details reaching one is a disclosure. The redaction is
 * exercised here against real credential shapes rather than asserted about.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  itemTelemetry,
  pdfTelemetry,
  publicationTelemetry,
  safeDetail,
  safeUrl,
  TELEMETRY_PREFIX,
  uploadTelemetry,
} from '../../../supabase/functions/_shared/builderStock/importTelemetry.pure';

const MODULE = join(process.cwd(),
  'supabase/functions/_shared/builderStock/importTelemetry.pure.ts');

describe('a credential never reaches a log line', () => {
  it('redacts a bearer token however it is spelled', () => {
    const line = safeDetail('refused: Authorization: Bearer sk-live-8fJ2kQ91xZvAbCdEfGh');
    expect(line).not.toContain('sk-live-8fJ2kQ91xZvAbCdEfGh');
    expect(line).toContain('[redacted]');
  });

  it('redacts a JWT wherever it appears in free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K';
    const line = safeDetail(`worker answered 401 for ${jwt} on retry`);
    expect(line).not.toContain(jwt);
    expect(line).toContain('[redacted]');
  });

  it('redacts a credential named in a query string or a body', () => {
    for (const secret of [
      'token=abc123DEF456',
      'api_key=live_9f8e7d6c',
      'X-Amz-Signature=9f86d081884c7d659a2feaa0c55ad015',
    ]) {
      const line = safeDetail(`GET /thing?${secret}&page=2 failed`);
      expect(line).not.toContain(secret.split('=')[1]);
      expect(line).toContain('[redacted]');
    }
  });

  it('drops the whole query of an address, because a signed URL IS the credential', () => {
    const signed = 'https://storage.example.com/bucket/lot810.pdf'
      + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafe&X-Amz-Expires=300';
    expect(safeUrl(signed)).toBe('https://storage.example.com/bucket/lot810.pdf');
  });

  it('keeps the host and the document, which is what a reader needs', () => {
    expect(safeUrl('https://docs.google.com/spreadsheets/d/abc/edit?gid=0#gid=0'))
      .toBe('https://docs.google.com/spreadsheets/d/abc/edit');
  });

  /*
   * TOTAL BY CONSTRUCTION. A telemetry helper that throws takes down the
   * operation it was describing, which is strictly worse than logging nothing.
   */
  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      null, undefined, 0, NaN, false, [], {}, new Error('boom'),
      { toString() { throw new Error('nope'); } },
    ];
    for (const value of hostile) {
      expect(() => safeDetail(value)).not.toThrow();
      expect(typeof safeDetail(value)).toBe('string');
      expect(() => safeUrl(value)).not.toThrow();
    }
  });

  it('bounds what it writes, so one provider body cannot fill a log', () => {
    expect(safeDetail('x'.repeat(10_000)).length).toBe(200);
    expect(safeDetail('x'.repeat(10_000), 40).length).toBe(40);
  });
});

describe('the upload line answers "which worksheet"', () => {
  const base = { uploadId: 'up-1', organisationId: 'org-1', sourceKind: 'url' };

  it('records the tab and the authority it was decided on', () => {
    const line = uploadTelemetry({
      ...base, sheetGid: '0', sheetAuthority: 'first_visible', sheetTabCount: 2,
      strategy: 'delimited_table', detected: 47, imported: 47, updated: 0, failed: 0,
      outcome: 'imported',
    });
    expect(line.sheet_gid).toBe('0');
    expect(line.sheet_authority).toBe('first_visible');
    expect(line.properties_detected).toBe(47);
    expect(line.phase).toBe('import_upload');
  });

  /*
   * `assumed_first` is the reading that means nobody could tell us, and it is
   * the one an operator must be able to find — it is what the substituted
   * hidden worksheet looked like from inside the run.
   */
  it('keeps "assumed_first" distinguishable from a tab a switcher proved', () => {
    const guessed = uploadTelemetry({ ...base, sheetGid: '0', sheetAuthority: 'assumed_first' });
    const proven = uploadTelemetry({ ...base, sheetGid: '0', sheetAuthority: 'named_and_listed' });
    expect(guessed.sheet_authority).not.toBe(proven.sheet_authority);
  });

  it('carries the refusal code on a failed import and no builder-facing sentence', () => {
    const line = uploadTelemetry({ ...base, outcome: 'assisted_reader_unavailable' });
    expect(line.outcome).toBe('assisted_reader_unavailable');
    expect(Object.values(line).join(' ')).not.toMatch(/could not finish reading/i);
  });

  it('omits what the caller had nothing for rather than writing null noise', () => {
    const line = uploadTelemetry(base);
    expect('sheet_gid' in line).toBe(false);
    expect('properties_detected' in line).toBe(false);
    expect(line.upload_id).toBe('up-1');
  });

  it('identifies by opaque correlation ids and never by a person', () => {
    const line = uploadTelemetry({ ...base, strategy: 'delimited_table' });
    const keys = Object.keys(line).join(' ');
    for (const forbidden of ['email', 'name', 'phone', 'address', 'builder_user']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('the item line separates "we looked" from "we could not look"', () => {
  const base = { itemId: 'item-1', uploadId: 'up-1', lifecycle: 'staged' };

  it('names the exhaustion as operational when any source failed on our side', () => {
    const line = itemTelemetry({
      ...base, evidence: 'exhausted', exhaustion: 'operational',
      sourcesTotal: 3, sourcesInspected: 2, sourcesOperational: 1, sourcesOpen: 0,
    });
    expect(line.evidence_exhaustion).toBe('operational');
    expect(line.sources_operational).toBe(1);
  });

  it('names it inspected only where every source was actually read', () => {
    const line = itemTelemetry({
      ...base, evidence: 'exhausted', exhaustion: 'inspected',
      sourcesTotal: 3, sourcesInspected: 3, sourcesOperational: 0, sourcesOpen: 0,
    });
    expect(line.evidence_exhaustion).toBe('inspected');
  });

  /*
   * A pending row has exhausted nothing, and writing "inspected" of one is the
   * false sentence the whole field exists to make impossible.
   */
  it('writes no exhaustion at all for a row that is still working', () => {
    for (const state of ['pending', 'processing', 'found', 'retryable_failure', 'no_evidence']) {
      const line = itemTelemetry({ ...base, evidence: state, exhaustion: null });
      expect('evidence_exhaustion' in line).toBe(false);
    }
  });

  it('carries the lifecycle, so a held row is visibly held rather than missing', () => {
    expect(itemTelemetry({ ...base, lifecycle: 'staged' }).lifecycle_status).toBe('staged');
    expect(itemTelemetry({ ...base, lifecycle: 'active' }).lifecycle_status).toBe('active');
  });

  it('redacts a detail that quotes a credential back at us', () => {
    const line = itemTelemetry({ ...base, detail: 'fetch failed: Bearer sk-live-zzzTOPSECRET' });
    expect(String(line.detail)).not.toContain('sk-live-zzzTOPSECRET');
  });
});

describe('the pdf line says whose answer it is', () => {
  const base = { byteSize: 21_395_456, documentName: 'lot810.pdf' };

  /*
   * THE FIELD THE LAST INCIDENT TURNED ON. An operator reading "no image"
   * cannot otherwise tell a document that carries none from a worker we never
   * reached, and the two send them to opposite remedies.
   */
  it('marks an unreachable worker as NOT a verdict about the document', () => {
    const line = pdfTelemetry({
      ...base, route: 'no_capacity', outcome: 'unreachable', documentVerdict: false,
      detail: 'worker unconfigured',
    });
    expect(line.document_verdict).toBe(false);
    expect(line.election_route).toBe('no_capacity');
  });

  it('marks a worker verdict as a verdict', () => {
    const line = pdfTelemetry({
      ...base, route: 'worker', outcome: 'not_identified', documentVerdict: true,
    });
    expect(line.document_verdict).toBe(true);
  });

  it('records the route and the size side by side without either deciding the other', () => {
    for (const bytes of [1, 12, 20, 24].map((mb) => mb * 1024 * 1024)) {
      const line = pdfTelemetry({
        ...base, byteSize: bytes, route: 'worker', outcome: 'recovered',
        documentVerdict: true, role: 'primary_property',
      });
      expect(line.election_route).toBe('worker');
      expect(line.byte_size).toBe(bytes);
      expect(line.image_role).toBe('primary_property');
    }
  });

  it('writes the document address without its query', () => {
    const line = pdfTelemetry({
      ...base, documentUrl: 'https://cdn.example.com/a/lot810.pdf?token=SECRETVALUE',
      route: 'worker', outcome: 'recovered', documentVerdict: true,
    });
    expect(String(line.document_url)).not.toContain('SECRETVALUE');
    expect(line.document_url).toBe('https://cdn.example.com/a/lot810.pdf');
  });
});

describe('the publication line explains a refusal as plainly as a success', () => {
  it('records the blocking reason and the counts under it', () => {
    const line = publicationTelemetry({
      uploadId: 'up-1', available: true, published: false,
      reason: 'source_outstanding', promoted: 0, archived: 0, staged: 47, sourceOutstanding: 5,
    });
    expect(line.published).toBe(false);
    expect(line.blocked_reason).toBe('source_outstanding');
    expect(line.staged).toBe(47);
    expect(line.source_outstanding).toBe(5);
  });

  it('records a success with what it moved', () => {
    const line = publicationTelemetry({
      uploadId: 'up-1', available: true, published: true, promoted: 47, archived: 12, staged: 0,
    });
    expect(line.published).toBe(true);
    expect(line.promoted).toBe(47);
  });

  it('keeps deployment skew distinct from a refusal', () => {
    const skew = publicationTelemetry({ uploadId: 'up-1', available: false, published: false });
    expect(skew.publication_available).toBe(false);
    const refusal = publicationTelemetry({
      uploadId: 'up-1', available: true, published: false, reason: 'source_outstanding' });
    expect(refusal.publication_available).toBe(true);
  });
});

describe('the module itself', () => {
  const source = readFileSync(MODULE, 'utf8');
  /** The rules are about code, so the comments must not answer for it. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('is pure — no console, no fetch, no clock', () => {
    expect(code).not.toContain('console.');
    expect(code).not.toContain('fetch(');
    expect(code).not.toContain('Date.now');
  });

  it('is the one place the log prefix is spelled', () => {
    expect(TELEMETRY_PREFIX).toBe('[builderStock]');
  });

  it('routes every caller-supplied string through a redactor', () => {
    // Each record builder must reach `safeDetail` or `safeUrl` for its free
    // text; a field assigned straight from an input is how the next leak ships.
    for (const builder of ['uploadTelemetry', 'itemTelemetry', 'pdfTelemetry']) {
      const body = code.slice(code.indexOf(`export function ${builder}`));
      const end = body.indexOf('\nexport ');
      const fn = end > 0 ? body.slice(0, end) : body;
      if (/detail|documentName|documentUrl/.test(fn)) {
        expect(fn).toMatch(/safeDetail|safeUrl/);
      }
    }
  });
});
