/**
 * A LINKED STOCK LIST CAN BE IMPORTED AGAIN WITHOUT DELETING IT.
 *
 * ## What happened
 *
 * `reprocess_upload` re-ran the parsers over the snapshot taken when a source
 * was first imported. For an uploaded FILE that is right — the bytes are the
 * builder's own and have not changed. For a LINKED sheet it is the opposite of
 * what the builder is asking for: they linked it because they keep editing it,
 * and re-reading the day-old copy reports "47 updated" having imported none of
 * their edits.
 *
 * So the only route that DID import a changed sheet was to delete the source
 * and add it back — and deleting archives every property that source supplies.
 * From `builder_portal_activity_log` on the network, 18–19 September 2026,
 * every row Mithruban Bupathy's own session wrote against Mairandi Developers:
 *
 *   18 Sep 09:41:29  builder_stock_source_deleted    {"archived": 47}
 *   18 Sep 09:41:46  builder_stock_url_source_added  {"host": "docs.google.com"}
 *   19 Sep 08:39:36  builder_stock_source_deleted    {"archived": 47}
 *   19 Sep 08:40:01  builder_stock_url_source_added  {"host": "docs.google.com"}
 *   19 Sep 09:23:44  builder_stock_source_deleted    {"archived": 47}
 *
 * Seventeen seconds, then twenty-five seconds. That is nobody removing stock;
 * it is a builder re-importing through the only door that worked. The third
 * one was not followed by an add, and 47 live properties have been archived
 * and off the Command Centre marketplace since.
 *
 * These tests pin the two halves of the fix: the naming that lets a builder
 * tell the two acts apart, and the edge function actually re-fetching rather
 * than re-reading. The second is asserted against the FUNCTION'S OWN SOURCE
 * because the behaviour lives in a Deno handler this suite cannot boot — and
 * a test that invents the handler is the failure mode this repository has
 * already paid for twice (the AML `.or()` double, and the ranking fallback
 * that watched for Postgres codes PostgREST never sends).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  describeRereadCounts, rereadNaming,
} from '../../../supabase/functions/_shared/builderStock/sourceReread.pure';

const root = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const STOCK_FN = 'supabase/functions/builder-portal-stock/index.ts';
const LINKED = 'supabase/functions/_shared/builderStock/linkedSource.ts';

describe('rereadNaming', () => {
  it('names the LINK as the source of the bytes for a linked stock list', () => {
    const naming = rereadNaming({ source_type: 'url' });
    expect(naming.kind).toBe('link');
    expect(naming.label).toMatch(/link/i);
    expect(naming.actionFor('tq.csv')).toContain('tq.csv');
    expect(naming.actionFor('tq.csv')).toMatch(/link/i);
  });

  it('names the FILE for an uploaded stock list, and says how to import a newer one', () => {
    const naming = rereadNaming({ source_type: 'file' });
    expect(naming.kind).toBe('file');
    expect(naming.label).toMatch(/file/i);
    // The one thing a file re-read genuinely cannot do, said rather than left
    // for the builder to discover by deleting the source.
    expect(naming.detail).toMatch(/new stock list/i);
  });

  it('never tells a builder the two acts are the same act', () => {
    const link = rereadNaming({ source_type: 'url' });
    const file = rereadNaming({ source_type: 'file' });
    for (const key of ['label', 'successTitle', 'failureTitle', 'detail'] as const) {
      expect(link[key], key).not.toBe(file[key]);
    }
    expect(link.actionFor('x')).not.toBe(file.actionFor('x'));
  });

  it('treats an unknown or absent source type as a file, which is the safe reading', () => {
    // A file re-read cannot reach the network and cannot replace live rows
    // from somewhere else. Guessing "link" on a row we cannot read would.
    for (const subject of [null, undefined, {}, { source_type: null }, { source_type: 'URL' }]) {
      expect(rereadNaming(subject as never).kind).toBe('file');
    }
  });

  it('never promises the import brought a change', () => {
    // `updated` counts rows the import WROTE, not rows that differ.
    for (const naming of [rereadNaming({ source_type: 'url' }), rereadNaming({})]) {
      expect(naming.detail).not.toMatch(/\bchanges? (were|was|have been) (imported|applied)\b/i);
    }
  });

  it('says what a re-fetch protects, because that is why it exists', () => {
    const naming = rereadNaming({ source_type: 'url' });
    expect(naming.detail).toMatch(/nothing was removed/i);
  });
});

describe('describeRereadCounts', () => {
  it('reports both counts', () => {
    expect(describeRereadCounts({ imported: 0, updated: 47 })).toBe('0 added, 47 updated.');
  });

  it('answers null where there is no summary, rather than inventing zeroes', () => {
    expect(describeRereadCounts(null)).toBeNull();
    expect(describeRereadCounts(undefined)).toBeNull();
  });

  it('reads a missing count as zero rather than NaN', () => {
    expect(describeRereadCounts({})).toBe('0 added, 0 updated.');
    expect(describeRereadCounts({ imported: null, updated: null })).toBe('0 added, 0 updated.');
  });
});

describe('the edge function re-fetches a linked source', () => {
  const source = read(STOCK_FN);

  it('reaches the link again through the SAME preparation the first import runs', () => {
    // Two implementations of "reach the link" is how a re-fetch comes to read
    // a Notion page differently from the import that accepted it.
    expect(source).toContain("from '../_shared/builderStock/linkedSource.ts'");
    const calls = source.match(/prepareLinkedStockSource\(/g) ?? [];
    expect(calls.length, 'import_url and reprocess_upload both call it').toBe(2);
  });

  it('branches on the source type inside reprocess_upload, ahead of the stored-bytes read', () => {
    const reprocess = source.slice(source.indexOf("operation === 'reprocess_upload'"));
    const branch = reprocess.indexOf('isLinkedSource');
    const download = reprocess.indexOf('.download(upload.storage_path)');
    expect(branch).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(branch, 'a link must never fall through to the stale snapshot')
      .toBeLessThan(download);
  });

  it('refuses a fetch that failed rather than falling back to the stale snapshot', () => {
    // The whole point: a sheet that has been unshared must say so and leave
    // the live rows alone, not hand back yesterday's copy under "updated".
    const reprocess = source.slice(source.indexOf("operation === 'reprocess_upload'"));
    const refusal = reprocess.indexOf('if (!refetched.ok)');
    const download = reprocess.indexOf('.download(upload.storage_path)');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(download);
    expect(reprocess.slice(refusal, refusal + 260))
      .toMatch(/error: refetched\.error, code: refetched\.code/);
  });

  it('does not mark the source as being read until the fetch has answered', () => {
    // Marking first parks a healthy list in "being read" on a fetch that
    // never returned anything to read.
    const reprocess = source.slice(source.indexOf("operation === 'reprocess_upload'"));
    const prepare = reprocess.indexOf('prepareLinkedStockSource(upload.source_url)');
    const mark = reprocess.indexOf('await markParsing(upload.id)');
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(mark);
  });

  it('imports the bytes it just fetched, as a url source', () => {
    const reprocess = source.slice(source.indexOf("operation === 'reprocess_upload'"));
    const linked = reprocess.slice(reprocess.indexOf('if (isLinkedSource)'));
    expect(linked).toContain('bytes: refetched.importBytes');
    expect(linked).toContain("sourceKind: 'url'");
    // Read from THIS fetch: a sheet whose export permissions were since fixed
    // must stop being stamped "we could not see the links".
    expect(linked).toContain('refetched.hyperlinks, refetched.hyperlinkMethod');
  });

  it('records the re-fetch as its own act in the builder’s history', () => {
    expect(source).toContain('builder_stock_source_refetched');
  });
});

describe('the preparation is where reaching a link lives', () => {
  const linked = read(LINKED);

  it('writes nothing — storage and the row belong to the caller', () => {
    expect(linked).not.toMatch(/\.from\('builder_stock_uploads'\)/);
    expect(linked).not.toMatch(/supabase\.storage/);
    expect(linked).not.toMatch(/\.insert\(|\.update\(|\.upsert\(/);
  });

  it('keeps every refusal the first import made, with its own code', () => {
    for (const code of [
      'source_unreachable', 'unsupported_source',
      'notion_not_public', 'notion_view_not_found',
    ]) {
      expect(linked, code).toContain(code);
    }
  });

  it('never logs the URL itself, only its host', () => {
    /*
     * A link a builder pasted can carry a token or a signature in its query
     * string, and a log line is the wrong place for either.
     *
     * READ AS A WHOLE CALL, not line by line. The first version of this test
     * tested only the line carrying `console.`, and a diagnostic object spans
     * many lines — so a mutant that added `source_url:` one line below the
     * call survived it. The assertion has to cover what the call actually
     * sends.
     */
    const calls: string[] = [];
    for (const match of linked.matchAll(/console\.(?:warn|error|info|log)\(/g)) {
      let depth = 0;
      let i = match.index! + match[0].length - 1;
      const from = i;
      for (; i < linked.length; i += 1) {
        if (linked[i] === '(') depth += 1;
        else if (linked[i] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push(linked.slice(from, i + 1));
    }
    expect(calls.length, 'the diagnostics this module writes').toBeGreaterThan(2);
    for (const call of calls) {
      expect(call, call.slice(0, 80)).not.toMatch(/\b(finalUrl|final_url|source_url|normalised\.url)\b/);
    }
    expect(linked).toMatch(/source_host: normalised\.host/);
  });
});
