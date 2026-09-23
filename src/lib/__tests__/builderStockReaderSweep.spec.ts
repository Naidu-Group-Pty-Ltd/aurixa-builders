/**
 * A PARSER CORRECTION MUST REACH THE ROWS IT ALREADY WROTE.
 *
 * `pdfDeterministicRows.pure.ts` runs once, at import. Everything downstream is
 * frozen with it — the property's title, its configuration, its address, and,
 * because the cover election identifies pages by the row's own label, WHICH
 * PICTURE LEADS ITS CARD. So a fix reached every future upload and not one row
 * that already existed.
 *
 * MEASURED 21 SEPTEMBER 2026. `LOT 48 - EMBER - FLYER.pdf` imported at 12:02;
 * the fix for the defect it hit deployed at 12:22. The row kept
 * `unit_number = '115.30m 12.41sq'` — a floor-plan area schedule read as a
 * designation — so the card was titled "Unit 115.30m 12.41sq", and its own
 * facade render sat in storage `ready` and `source_supplied` with the role
 * `unknown`, because the poisoned label could name no cover page. Twenty
 * minutes of timing decided whether a row could heal.
 *
 * These tests pin the RULES, never the strings: what may be re-read, what is
 * refused, that a refusal is written down, and that the sweep is wired into the
 * one exit that decides whether the cron keeps running.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_PARSE_MS, ABANDONED_UPLOAD_MS, DETERMINISTIC_READER_VERSION,
  READER_SETTLED_VERSION_COLUMN, RE_READABLE_STATUSES,
  readerReReadRefusal, stampable,
} from '../../../supabase/functions/_shared/builderStock/readerVersion.pure';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const FILE_UPLOAD = {
  id: 'u1',
  status: 'complete',
  source_type: 'file',
  storage_bucket: 'stock-lists',
  storage_path: 'builder-stock/org/u1/flyer.pdf',
  deleted_at: null,
};

describe('what a reader sweep may act on', () => {
  it('re-reads a completed file upload', () => {
    expect(readerReReadRefusal(FILE_UPLOAD)).toBeNull();
  });

  it('re-reads every status that has been read at least once', () => {
    for (const status of ['complete', 'imported', 'enriching']) {
      expect(readerReReadRefusal({ ...FILE_UPLOAD, status })).toBeNull();
    }
  });

  /*
   * THIS EXPECTATION CHANGED, AND THE OLD ONE WAS HALF RIGHT.
   *
   * OLD: `readerReReadRefusal({status: 'uploaded'})` is `'status:uploaded'`,
   * under the rule "a cron tick may not decide to start importing a file the
   * builder's own import refused OR NEVER RAN".
   *
   * WHY IT WAS WRONG: those are two different cases and only the first is a
   * decision. A `failed` row carries a verdict a person was SHOWN, and a tick
   * that quietly re-imports overrules them. An `uploaded` row carries no
   * verdict at all — `add_upload` stored the bytes, the browser never called
   * `process_upload`, and nothing has ever looked at the file. Refusing it is
   * not declining to overrule anybody; it is leaving a customer's stock list
   * unimported for ever while every screen reports normal operation.
   *
   * EVIDENCE: measured 22 September 2026 in the acceptance gate's fault
   * matrix (case 8i, the browser closing the moment the upload is accepted).
   * Bytes stored, row at `uploaded`, eight sweep ticks, ZERO properties,
   * status unchanged. Nobody was coming. With the rule corrected the same
   * fixture imports on the first tick and its photograph reaches the card.
   *
   * NEW: a FRESH `uploaded` row is still refused, because a browser may be
   * about to import it — `upload_not_started`, which `stampable` refuses to
   * settle. Past `ABANDONED_UPLOAD_MS` the sweep adopts it, and
   * `settleReaderVersion` claims it conditionally so the two cannot collide.
   */
  it('leaves a fresh upload for the browser that is about to import it', () => {
    expect(readerReReadRefusal({
      ...FILE_UPLOAD, status: 'uploaded', created_at: new Date().toISOString(),
    })).toBe('upload_not_started');
  });

  it('adopts an upload nobody came back for', () => {
    expect(readerReReadRefusal({
      ...FILE_UPLOAD,
      status: 'uploaded',
      created_at: new Date(Date.now() - ABANDONED_UPLOAD_MS - 1_000).toISOString(),
    })).toBeNull();
  });

  /*
   * A row whose landing time cannot be read is treated as OLD, on the same
   * side `parse_in_flight` treats an unparseable start: the alternative is a
   * row nothing will ever adopt, which is the defect rather than a guard.
   */
  it('adopts an upload whose landing time cannot be read', () => {
    expect(readerReReadRefusal({ ...FILE_UPLOAD, status: 'uploaded' })).toBeNull();
    expect(readerReReadRefusal({
      ...FILE_UPLOAD, status: 'uploaded', created_at: 'not a date',
    })).toBeNull();
  });

  /*
   * AND IT IS NEVER SETTLED FROM THE REFUSAL. Stamping `upload_not_started`
   * would record this reader version against a file nothing read, and the
   * first pass would then never happen at all — the defect moved rather than
   * fixed. Same rule, same reason, as `parse_in_flight`.
   */
  it('never settles a row it only declined to start yet', () => {
    expect(stampable('upload_not_started')).toBe(false);
    expect(stampable('parse_in_flight')).toBe(false);
    expect(stampable('linked_source')).toBe(true);
  });

  /*
   * A FAILURE ABOUT THE DOCUMENT IS STILL NOT WORK. This used to read
   * `status:failed` for every failure, which was right while every failure
   * was alike. `Lot 37 - Miami 190 - Property Package.pdf` showed the cost:
   * written off because a model provider's ACCOUNT had no credit — nothing to
   * do with the file — and nothing would ever have looked at it again.
   */
  it('refuses a failure that was about the file', () => {
    for (const code of ['duplicate_file', 'unsupported_file_type', 'pdf_no_text_layer']) {
      expect(readerReReadRefusal({ ...FILE_UPLOAD, status: 'failed', error_code: code }))
        .toBe(`status:failed:${code}`);
    }
    expect(readerReReadRefusal({ ...FILE_UPLOAD, status: 'failed' }))
      .toBe('status:failed:unknown');
  });

  it('re-reads a failure that was ours', () => {
    for (const code of ['assisted_reader_refused', 'assisted_reader_timeout',
      'ai_budget_exhausted', 'processing_failed']) {
      expect(readerReReadRefusal({ ...FILE_UPLOAD, status: 'failed', error_code: code }))
        .toBeNull();
    }
  });

  /*
   * `failed` STAYS OUT AND `uploaded` CAME IN — see the expectation above for
   * why the two were never alike. `failed` is the one a person was shown.
   */
  it('never names a status it will not act on as re-readable', () => {
    expect(RE_READABLE_STATUSES.has('failed')).toBe(false);
    expect(RE_READABLE_STATUSES.has('uploaded')).toBe(true);
  });

  /*
   * A builder links a sheet BECAUSE they keep editing it, so reaching the link
   * again imports edits nobody asked to import — their decision, offered to
   * them in the portal. Re-reading the day-old SNAPSHOT instead is the defect
   * `49-re-importing-a-linked-stock-list.md` records.
   */
  it('refuses a linked source outright', () => {
    expect(readerReReadRefusal({
      ...FILE_UPLOAD, source_type: 'url', source_url: 'https://docs.google.com/x',
    })).toBe('linked_source');
  });

  it('refuses a deleted source before it looks at anything else', () => {
    expect(readerReReadRefusal({
      ...FILE_UPLOAD, status: 'complete', deleted_at: '2026-09-21T00:00:00Z',
    })).toBe('deleted');
  });

  it('refuses a source with no stored object', () => {
    expect(readerReReadRefusal({ ...FILE_UPLOAD, storage_path: '   ' }))
      .toBe('no_stored_object');
  });

  /*
   * A request killed on its resource limit leaves the row at `parsing` for
   * ever. Refusing it for ever would make the one status a re-read most needs
   * to repair the one status it can never touch.
   */
  it('declines a parse that is running and takes an abandoned one', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    const live = new Date(now - 60_000).toISOString();
    const abandoned = new Date(now - ABANDONED_PARSE_MS - 1_000).toISOString();
    expect(readerReReadRefusal(
      { ...FILE_UPLOAD, status: 'parsing', processing_started_at: live }, now,
    )).toBe('parse_in_flight');
    expect(readerReReadRefusal(
      { ...FILE_UPLOAD, status: 'parsing', processing_started_at: abandoned }, now,
    )).toBeNull();
  });
});

describe('a refusal is an answer, not a skip', () => {
  /*
   * A queue whose refusals stayed outstanding would re-ask the same
   * unanswerable question every tick for ever — the liveness fault
   * `repairSourceImagesForUpload` was once held still by.
   */
  it('writes down every refusal that is about the upload', () => {
    for (const reason of ['deleted', 'linked_source', 'status:failed', 'no_stored_object']) {
      expect(stampable(reason)).toBe(true);
    }
  });

  it('never writes down a parse that is still running', () => {
    // Stamping it would record a version against a read we did not perform.
    expect(stampable('parse_in_flight')).toBe(false);
  });

  it('never writes down "no refusal"', () => {
    expect(stampable(null)).toBe(false);
  });
});

describe('the sweep', () => {
  const rows = (data: unknown[]) => {
    const chain: any = {
      select: () => chain, is: () => chain, lt: () => chain,
      order: () => chain, limit: () => chain, eq: () => chain,
      then: (resolve: any) => resolve({ data, error: null }),
    };
    return chain;
  };

  it('stamps a linked source without reading it, and never runs the import', async () => {
    const { settleReaderVersion } = await import(
      '../../../supabase/functions/_shared/builderStock/settleReaderVersion');
    const updates: Array<Record<string, unknown>> = [];
    const runImport = vi.fn();
    const db: any = {
      from: (table: string) => {
        if (table !== 'builder_stock_uploads') return rows([]);
        return {
          select: () => rows([{
            id: 'u-link', organisation_id: 'org', status: 'complete',
            source_type: 'url', source_url: 'https://docs.google.com/x',
            storage_bucket: 'b', storage_path: 'p', deleted_at: null,
            created_at: '2026-01-01',
          }]),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      },
      storage: { from: () => ({ download: () => { throw new Error('never'); } }) },
    };

    const outcome = await settleReaderVersion(db, {}, { runImport: runImport as any });
    expect(runImport).not.toHaveBeenCalled();
    expect(outcome.refused).toEqual([{ uploadId: 'u-link', reason: 'linked_source' }]);
    expect(updates).toEqual([
      { [READER_SETTLED_VERSION_COLUMN]: DETERMINISTIC_READER_VERSION },
    ]);
  });
  it('re-reads a file through the same import and stamps it afterwards', async () => {
    const { settleReaderVersion } = await import(
      '../../../supabase/functions/_shared/builderStock/settleReaderVersion');
    const updates: Array<Record<string, unknown>> = [];
    const runImport = vi.fn(async () => ({
      ok: true,
      strategy: 'pdf_deterministic',
      uploadStatus: 'enriching',
      summary: {
        detected: 1, imported: 0, updated: 1, failed: 0, failures: [],
        withSourceImage: 1, imageryOutstanding: false,
      },
      deterministicIgnored: ['HAVENWOOD'],
      deterministicPlacement: ['p1 r0 x36'],
    }));
    const db: any = {
      from: (table: string) => {
        if (table === 'builder_organisations') {
          return { select: () => ({ eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { trading_name: 'Mairandi' } }),
          }) }) };
        }
        if (table !== 'builder_stock_uploads') return rows([]);
        return {
          select: () => rows([{
            id: 'u-file', organisation_id: 'org', status: 'complete',
            source_type: 'file', uploaded_by_builder_user_id: 'builder-1',
            original_filename: 'LOT 48 - EMBER - FLYER.pdf',
            storage_bucket: 'stock-lists', storage_path: 'p/flyer.pdf',
            deleted_at: null, created_at: '2026-01-01',
          }]),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      },
      storage: {
        from: () => ({
          download: () => Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) },
            error: null,
          }),
        }),
      },
    };

    const outcome = await settleReaderVersion(db, {}, { runImport: runImport as any });

    expect(outcome.reread).toBe(1);
    expect(outcome.failed).toEqual([]);
    // The SAME bytes, as a file, attributed to the person who uploaded it.
    expect(runImport).toHaveBeenCalledTimes(1);
    const passed = (runImport.mock.calls[0] as any[])[0];
    expect(passed.sourceKind).toBe('file');
    expect(passed.upload).toEqual({
      id: 'u-file', original_filename: 'LOT 48 - EMBER - FLYER.pdf',
    });
    expect(passed.builderUserId).toBe('builder-1');

    // The counts and the unnamed lines are recorded; the STATUS is not, so a
    // settled list is never made to look busy by a sweep nobody asked for.
    const outcomeWrite = updates.find((patch) => 'records_updated' in patch)!;
    expect(outcomeWrite.records_updated).toBe(1);
    expect(outcomeWrite.error_detail).toEqual({
      deterministic_ignored: ['HAVENWOOD'],
      deterministic_placement: ['p1 r0 x36'],
    });
    expect(Object.keys(outcomeWrite)).not.toContain('status');

    // And the marker, so it leaves the queue.
    expect(updates).toContainEqual(
      { [READER_SETTLED_VERSION_COLUMN]: DETERMINISTIC_READER_VERSION });
  });

  /*
   * A read that FAILED is not a builder who has added nothing. The rows this
   * source already produced are live stock, and the sweep has learned nothing
   * about them — so the upload stays OUTSTANDING and a transient fault is
   * retried rather than being written down as settled.
   */
  it('leaves a failed read outstanding and writes nothing', async () => {
    const { settleReaderVersion } = await import(
      '../../../supabase/functions/_shared/builderStock/settleReaderVersion');
    const updates: Array<Record<string, unknown>> = [];
    const runImport = vi.fn(async () => ({
      ok: false, code: 'pdf_text_extraction_failed', message: 'nope',
    }));
    const db: any = {
      from: (table: string) => {
        if (table === 'builder_organisations') {
          return { select: () => ({ eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
          }) }) };
        }
        if (table !== 'builder_stock_uploads') return rows([]);
        return {
          select: () => rows([{
            id: 'u-file', organisation_id: 'org', status: 'complete',
            source_type: 'file', storage_bucket: 'b', storage_path: 'p',
            deleted_at: null, created_at: '2026-01-01',
          }]),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      },
      storage: {
        from: () => ({
          download: () => Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer) },
            error: null,
          }),
        }),
      },
    };

    const outcome = await settleReaderVersion(db, {}, { runImport: runImport as any });
    expect(outcome.reread).toBe(0);
    expect(outcome.failed).toEqual([
      { uploadId: 'u-file', reason: 'pdf_text_extraction_failed' },
    ]);
    expect(updates).toEqual([]);
  });

  /*
   * A VERDICT IS FINISHED; A FAULT IS NOT.
   *
   * The test above pins the fault half: an operational failure writes nothing
   * and stays outstanding, so a decoder that failed once is retried. These
   * pin the other half, which is what stopped `Lot 37 - Miami 190 - Property
   * Package.pdf` being re-read on every tick for ever — 1.9 MB downloaded and
   * parsed each time to reach the same answer.
   */
  const sweepOver = async (
    upload: Record<string, unknown>, result: Record<string, unknown>,
  ) => {
    const { settleReaderVersion } = await import(
      '../../../supabase/functions/_shared/builderStock/settleReaderVersion');
    const updates: Array<Record<string, unknown>> = [];
    const runImport = vi.fn(async () => result);
    const db: any = {
      from: (table: string) => {
        if (table === 'builder_organisations') {
          return { select: () => ({ eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
          }) }) };
        }
        if (table !== 'builder_stock_uploads') return rows([]);
        return {
          select: () => rows([upload]),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      },
      storage: {
        from: () => ({
          download: () => Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer) },
            error: null,
          }),
        }),
      },
    };
    const outcome = await settleReaderVersion(db, {}, { runImport: runImport as any });
    return { outcome, updates };
  };

  const SWEPT = {
    id: 'u-file', organisation_id: 'org', status: 'complete',
    source_type: 'file', storage_bucket: 'b', storage_path: 'p',
    deleted_at: null, created_at: '2026-01-01',
  };

  it('stamps the version when the re-read reached a verdict about the document', async () => {
    const { outcome, updates } = await sweepOver(SWEPT, {
      ok: false, code: 'no_properties_found', message: 'nothing to list',
    });
    expect(outcome.reread).toBe(0);
    expect(outcome.failed).toEqual([{ uploadId: 'u-file', reason: 'no_properties_found' }]);
    // The verdict is recorded and then the version is stamped: the row says
    // what this reader answered, and stops being outstanding.
    expect(updates[0]).toMatchObject({ error_code: 'no_properties_found' });
    expect(updates[1]).toEqual({ reader_settled_version: DETERMINISTIC_READER_VERSION });
  });

  it('replaces an error that was ours with the answer the document now gets', async () => {
    const { updates } = await sweepOver(
      { ...SWEPT, status: 'imported', error_code: 'assisted_reader_refused' },
      { ok: false, code: 'no_properties_found', message: 'nothing to list', detail: 'why' },
    );
    expect(updates[0]).toMatchObject({
      error_code: 'no_properties_found',
      error_message: 'nothing to list',
    });
    // And the status is NEVER touched: rows this source already produced are
    // live stock, which is the rule the failure branch is built on.
    expect(Object.keys(updates[0])).not.toContain('status');
    expect(updates[1]).toEqual({ reader_settled_version: DETERMINISTIC_READER_VERSION });
  });

  /*
   * AND IT REWRITES AN ERROR THAT WAS ALREADY ABOUT THE FILE TOO.
   *
   * The first version of this rule left those alone, on the argument that the
   * re-read had reached the same KIND of answer. Measured on the next deploy:
   * `Lot 37` was re-read at version 4 by a reader that no longer claims a
   * bullet glyph as an estate, and the row went on displaying the version-3
   * evidence — the stamp said 4 and the diagnosis said 3. A source is read
   * once per reader version, so this writes once per version and "churn" was
   * never the risk.
   */
  /*
   * AND A SUCCESSFUL RE-READ CLEARS THE REASON THE LAST ONE FAILED.
   *
   * Measured on the read that finally worked: `Lot 37` came back with one
   * property imported and the builder's photograph attached, and the row went
   * on carrying `error_code: no_properties_found` from the read before it,
   * because the status was `complete` rather than `failed`.
   */
  it('clears a stale error when the re-read imported, whatever the status said', async () => {
    const { updates } = await sweepOver(
      { ...SWEPT, status: 'complete', error_code: 'no_properties_found' },
      { ok: true, uploadStatus: 'enriching',
        summary: { detected: 1, imported: 1, updated: 0, failed: 0, failures: [] } },
    );
    expect(updates[0]).toMatchObject({
      error_code: null, error_message: null, records_imported: 1,
    });
    // A `complete` row is not pushed back to `enriching`: its rows are live.
    expect(Object.keys(updates[0])).not.toContain('status');
  });

  it('rewrites the recorded reason even where it already described the file', async () => {
    const { updates } = await sweepOver(
      { ...SWEPT, status: 'imported', error_code: 'pdf_no_text_layer' },
      { ok: false, code: 'no_properties_found', message: 'nothing to list', detail: 'fresh' },
    );
    expect(updates[0]).toMatchObject({
      error_code: 'no_properties_found',
      error_detail: { detail: 'fresh' },
    });
    expect(Object.keys(updates[0])).not.toContain('status');
    expect(updates[1]).toEqual({ reader_settled_version: DETERMINISTIC_READER_VERSION });
  });
});

describe('the sweep is wired where the cron can still reach it', () => {
  const settler = read('supabase/functions/builder-stock-image-settler/index.ts');
  const sweep = read('supabase/functions/_shared/builderStock/settleReaderVersion.ts');

  it('runs inside the settler', () => {
    expect(settler).toMatch(/await settleReaderVersion\(supabase, \{ deadlineAt \}\)/);
  });

  /*
   * The migration's cron unschedules itself on `complete: true`. Reporting a
   * quiet deployment complete while sources are still behind the current
   * reader retires the job that performs the sweep — the identical fault this
   * function's own header records for the per-item queue.
   */
  it('never reports complete while a source is behind the reader', () => {
    expect(settler).toMatch(/complete: readerOutstanding === 0/);
    expect(settler).not.toMatch(/\n\s*complete: true,\n\s*deploymentReady: true, eligibilityTarget/);
  });

  /*
   * A re-read parses a document and decodes every raster it keeps — the work
   * that killed this worker at ~16s and again at ~20s on two other paths. The
   * sweep converges over TICKS, never by widening this number.
   */
  it('takes at most one source per tick and reserves time to finish it', () => {
    expect(sweep).toMatch(/const MAX_REREADS_PER_TICK = 1;/);
    expect(sweep).toMatch(/Date\.now\(\) \+ READER_SWEEP_RESERVE_MS > deadlineAt\) break;/);
  });

  /*
   * A read that FAILED is not a builder who has added nothing. The rows this
   * source already produced are live stock; writing `failed` over a healthy
   * list is the defect `49-re-importing-a-linked-stock-list.md` records.
   *
   * THIS EXPECTATION CHANGED TOO, AND NARROWLY.
   *
   * OLD: the sweep's source contains no `status: '<literal>'` at all.
   * WHY IT NEEDED CHANGING: the sweep now writes `status: 'parsing'` in ONE
   * place — the claim that adopts an abandoned `uploaded` row, which must be
   * conditional and atomic or a returning browser and a tick both import the
   * same file. That write is on a row with NO LIST BEHIND IT, which is the
   * opposite of what this rule protects.
   * NEW: the two statuses that would overwrite an existing list are still
   * forbidden outright, and `parsing` is permitted only in a write whose own
   * predicate is `uploaded` — so the guard is pinned rather than the absence.
   */
  it('never invents a status for an existing list', () => {
    expect(sweep).not.toMatch(/status: '(failed|complete|enriching)'/);
  });

  /*
   * AND THE CLAIM IS CONDITIONAL, WHICH IS THE WHOLE GUARD. An unconditional
   * update would take a row a browser had just taken, and two imports of one
   * file is the duplicate fork this subsystem must never produce.
   */
  it('claims an abandoned upload conditionally or not at all', () => {
    const claims = sweep.match(/status: 'parsing'/g) ?? [];
    expect(claims).toHaveLength(1);
    expect(sweep).toMatch(/\.eq\('status', 'uploaded'\)/);
  });

  /*
   * AND EVERY WAY OUT OF A CLAIMED ROW PUTS IT DOWN. A claimed row left at
   * `parsing` is re-readable, so the next tick claims nothing (it is no
   * longer `uploaded`), reads it as an ordinary re-read, and the status never
   * becomes terminal — the stranded state, reintroduced by the fix for it.
   * Three exits: the object is gone, the import refused, the run threw.
   */
  it('puts down every claimed row it cannot finish', () => {
    expect(sweep).toMatch(/import \{ closeRefusedUpload \}/);
    expect((sweep.match(/if \(firstPass\) \{/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  /*
   * THE ONE TRANSITION THAT MUST WRITE ONE. A row stamped `failed` for a
   * reason that was ours, re-read successfully, would otherwise hide a real
   * import behind a stale error. Bounded to exactly that: any other prior
   * status writes no status at all.
   */
  it('clears a failure only where the row said failed and the read succeeded', () => {
    expect(sweep).toMatch(/statusBefore === 'failed'/);
    expect(sweep).toMatch(/status: result\.uploadStatus/);
    expect(sweep).toMatch(/error_code: null, error_message: null/);
  });
});

describe('the marker exists in the schema', () => {
  const migration = read(
    'supabase/migrations/20260921133000_a_parser_correction_must_reach_the_rows_it_already_wrote.sql');

  it('adds the column the module names', () => {
    expect(migration).toContain(`add column if not exists ${READER_SETTLED_VERSION_COLUMN}`);
  });

  /*
   * The settlement tick unschedules itself when it has nothing to do, and on a
   * deployment where every image marker was current it has already done so.
   * A new kind of work must re-arm the job that performs it, or the column
   * sits NULL for ever.
   */
  it('re-arms the job that performs the sweep', () => {
    expect(migration).toContain('ensure_builder_stock_settlement_scheduled()');
  });
});

/*
 * ===========================================================================
 * A COMPLETED IMPORT IS A READ — AND THE ONE READ STILL MADE IN ONE ISOLATE
 * IS FENCED UNTIL IT IS NOT.
 * ===========================================================================
 *
 * MEASURED in `function_logs`: the image settler was killed twelve times
 * between 10:09:06 and 10:35:07 on 22 September 2026, and three more times on
 * 23 September (05:40:08, 05:43:07, 05:45:08). Every kill was the reader
 * sweep re-reading `LOT 550 - ENZO 8.5 MODERN- BROCHURE V002.pdf`, or a copy
 * of it, after its import. The sweep stamped the version and nothing else
 * did, so every new upload was read a second time: inline, parse and decode
 * in one isolate, the shape the import was rebuilt to avoid. `importOutcomeColumns` now stamps the version an
 * import read at, which removes that second read for every new upload.
 *
 * What it does NOT remove is the sweep's own reason to exist: raising
 * `DETERMINISTIC_READER_VERSION` makes every stored source outstanding, and
 * the sweep re-reads each one with `runStockImport` inline and without
 * `resumableFromStoredBytes`. LOT 550 is killed there. A kill writes nothing,
 * so the row stays outstanding with no attempt bound; the sweep takes the
 * oldest outstanding row first, one per quiet tick, and `readerSweepPending`
 * holds the cron open — so the settler would die on every quiet tick and no
 * row behind that one would ever be re-read. Both series above ended only
 * when one attempt happened to fit (10:38:07 and 05:48:07). Recorded in
 * `docs/builder-portal/54-what-the-importer-spends.md` §11.4.
 *
 * So the version stays where every production row was stamped until the
 * sweep's re-read crosses isolates the way the import does. This test is the
 * fence, not the fix: it fails the change that would make the outage, with
 * the reason, rather than letting the next reader ship it.
 */
describe('a completed import is a read, and the inline re-read is fenced', () => {
  const summary = { detected: 1, imported: 1, updated: 0, failed: 0, failures: [] };

  it('the completion write stamps the reader version the import read at', async () => {
    const { importOutcomeColumns } = await import(
      '../../../supabase/functions/_shared/builderStock/recordImportOutcome');
    const columns = importOutcomeColumns({ uploadStatus: 'enriching', summary }, null);
    expect(columns[READER_SETTLED_VERSION_COLUMN]).toBe(DETERMINISTIC_READER_VERSION);
  });

  it('a failed import stamps nothing: nothing was learned about the document', async () => {
    const { importFailureColumns } = await import(
      '../../../supabase/functions/_shared/builderStock/recordImportOutcome');
    expect(importFailureColumns('processing_failed', 'x'))
      .not.toHaveProperty(READER_SETTLED_VERSION_COLUMN);
  });

  it('both completions spread those columns, so neither can leave a fresh import outstanding', () => {
    expect(read('supabase/functions/builder-portal-stock/index.ts'))
      .toContain('importOutcomeColumns(result, sourceNotice)');
    expect(read('supabase/functions/_shared/builderStock/continueImport.ts'))
      .toContain('importOutcomeColumns(result, null)');
  });

  it('the reader version is not raised while the sweep still re-reads in one isolate', () => {
    const sweep = read('supabase/functions/_shared/builderStock/settleReaderVersion.ts');
    const reReadsInline = !/resumableFromStoredBytes\s*:\s*true/.test(sweep);
    if (!reReadsInline) return;
    expect(
      DETERMINISTIC_READER_VERSION,
      'Raising the reader version re-reads every stored PDF inside the image '
      + 'settler, parse and decode in one isolate — LOT 550 is killed there and '
      + 'blocks the sweep. Make the sweep re-read across isolates first; see '
      + 'docs/builder-portal/54-what-the-importer-spends.md §11.4.',
    ).toBe(13);
  });
});
