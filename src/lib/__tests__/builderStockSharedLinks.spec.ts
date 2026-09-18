/**
 * ONE ESTATE'S PICTURE IS NOT ONE HOUSE'S PHOTOGRAPH — pinned.
 *
 * THE DEFECT THESE PIN, measured on production upload `58010c95`
 * (18 September 2026) and reproduced over the live sheet. Ten rows of the
 * Harlow estate carry the SAME `Siting / Masterplan URL`. The guard that
 * refuses a shared link as estate collateral was in place and answered
 * `false` — not shared — for all ten, so the masterplan was stored as
 * `role: primary_property` on three properties at once, byte-identical
 * (sha `c041e379…`, 141,839 bytes), and each was then refused by the
 * marketplace measure as an `annotated_marketing_tile`. Three properties
 * ended with a stored image, no primary, and a stock list held for all 47.
 *
 * The count was ZERO, and for two independent reasons — either alone enough:
 *
 *   1. It was taken over `raw.unmapped`, off the rows `extractStockFile`
 *      returns. A raw extracted row has no `unmapped` property AT ALL: it is
 *      keyed by the source's own headers. `unmapped` is a field of the
 *      NORMALISED record. Measured: 0 of 48 rows carried one.
 *   2. The stored-row pass called `unmappedWithRecoveredLinks(null, row)`,
 *      which returns `{}` unless the row carries `recovered_link_columns` —
 *      written only by the authorised link recovery. A sheet whose targets
 *      were merged from the htmlview grid at import has none.
 *
 * So `(counts.get(url) ?? 0) > 1` was false for every link on every row of
 * every upload, and the guard had never once fired on this path.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  countBranchLinkRows,
  linkIsExclusiveToRow,
  linkSharedWithOtherRows,
} from '../../../supabase/functions/_shared/builderStock/sharedBranchLinks.pure';

const SHARED = 'supabase/functions/_shared/builderStock';
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const MASTERPLAN = 'https://drive.google.com/file/d/1RqyBqibSl1PS7XSZCPRZT4ZCaWpA8H_3/view?usp=drive_link';
const BROCHURE_801 = 'https://drive.google.com/file/d/1fG-hlBqYLNr3t74C7To6_XW8vNaCilLE/view?usp=drive_link';
const BROCHURE_809 = 'https://drive.google.com/file/d/17hoC8RtxbqqCC8tQoxCfVGtZ9kjnbZmw/view?usp=drive_link';

/**
 * A row EXACTLY as `extractStockFile` returns it: keyed by the builder's own
 * headers, with the link columns the hyperlink merge appended. This shape is
 * the whole defect — note there is no `unmapped` anywhere in it.
 */
const rawRow = (lot: string, design: string, brochure: string) => ({
  'Lot #': lot,
  Estate: 'Harlow',
  Location: 'Tarneit',
  'House Design': design,
  'Package Price': '$796,545',
  'Brochure URL': brochure,
  'Siting / Masterplan URL': MASTERPLAN,
});

const UPLOAD = [
  rawRow('801', 'Elara 18', BROCHURE_801),
  rawRow('809', 'VG18', BROCHURE_809),
  rawRow('810', 'Nex 20', 'https://drive.google.com/file/d/1dY8I5821mr8ZMhoSeEnFg2f2cXQHa5WR/view?usp=drive_link'),
];

describe('the shape that broke it', () => {
  /*
   * This is the assertion that makes the rest of the file meaningful: the
   * expression the pipeline used cannot read anything from the rows it was
   * given, so no arrangement of the rest could have made the guard work.
   */
  it('a raw extracted row carries no `unmapped` — the old expression read undefined', () => {
    for (const row of UPLOAD) {
      expect((row as { unmapped?: unknown }).unmapped).toBeUndefined();
    }
  });

  it('counting `raw.unmapped` over the whole upload yields an EMPTY map', () => {
    const legacy = new Map<string, number>();
    for (const row of UPLOAD) {
      const unmapped = (row as { unmapped?: Record<string, string> }).unmapped;
      for (const url of Object.values(unmapped ?? {})) {
        legacy.set(url, (legacy.get(url) ?? 0) + 1);
      }
    }
    expect(legacy.size).toBe(0);
    expect((legacy.get(MASTERPLAN) ?? 0) > 1).toBe(false);
  });
});

describe('the count is taken over records, so a shared link is seen', () => {
  it('counts the estate masterplan on every row that carries it', () => {
    const counted = countBranchLinkRows({ rows: UPLOAD, expectedRows: UPLOAD.length });
    expect(counted.counts.get(MASTERPLAN)).toBe(3);
    expect(counted.coverage.counted).toBe(3);
  });

  it('refuses the shared masterplan and admits each row\'s own brochure', () => {
    const counted = countBranchLinkRows({ rows: UPLOAD, expectedRows: UPLOAD.length });
    expect(linkSharedWithOtherRows(counted, MASTERPLAN)).toBe(true);
    expect(linkIsExclusiveToRow(counted, MASTERPLAN)).toBe(false);
    expect(linkIsExclusiveToRow(counted, BROCHURE_801)).toBe(true);
    expect(linkIsExclusiveToRow(counted, BROCHURE_809)).toBe(true);
  });

  it('counts a row that arrives already normalised without re-normalising it', () => {
    const record = {
      lot_number: '801',
      unmapped: { 'Siting / Masterplan URL': MASTERPLAN, 'Brochure URL': BROCHURE_801 },
    };
    const counted = countBranchLinkRows({ rows: [record, ...UPLOAD], expectedRows: 4 });
    expect(counted.counts.get(MASTERPLAN)).toBe(4);
  });

  it('counts a stored row whose links live in `unmapped` rather than in recovered columns', () => {
    /*
     * The second hole, on its own. These rows have no `recovered_link_columns`,
     * which is the ordinary state for a sheet whose targets were merged at
     * import — and the old pass therefore contributed nothing for them.
     */
    const storedRowByItem = new Map<string, Record<string, unknown>>([
      ['item-a', { lot_number: '801', unmapped: { 'Siting / Masterplan URL': MASTERPLAN } }],
      ['item-b', { lot_number: '809', unmapped: { 'Siting / Masterplan URL': MASTERPLAN } }],
    ]);
    const counted = countBranchLinkRows({ rows: [], storedRowByItem, expectedRows: 2 });
    expect(counted.counts.get(MASTERPLAN)).toBe(2);
    expect(linkSharedWithOtherRows(counted, MASTERPLAN)).toBe(true);
  });

  it('still reads a recovered link column, which is the only place some targets exist', () => {
    const storedRowByItem = new Map<string, Record<string, unknown>>([
      ['item-a', {
        unmapped: { 'Brochure URL': BROCHURE_801 },
        recovered_link_columns: ['Brochure URL'],
      }],
    ]);
    const counted = countBranchLinkRows({ rows: [], storedRowByItem, expectedRows: 1 });
    expect(counted.counts.get(BROCHURE_801)).toBe(1);
  });
});

describe('it fails closed, because the failure it prevents is a wrong house', () => {
  it('treats every link as shared when nothing was counted', () => {
    const counted = countBranchLinkRows({ rows: [], expectedRows: 47 });
    expect(linkSharedWithOtherRows(counted, MASTERPLAN)).toBe(true);
    expect(linkSharedWithOtherRows(counted, BROCHURE_801)).toBe(true);
  });

  it('treats every link as shared when the rows do not cover the upload', () => {
    // One property settled in isolation must not be able to call its own
    // links exclusive on the strength of its own row alone.
    const partial = countBranchLinkRows({ rows: [UPLOAD[0]], expectedRows: 47 });
    expect(partial.counts.get(MASTERPLAN)).toBe(1);
    expect(linkIsExclusiveToRow(partial, MASTERPLAN)).toBe(false);
    expect(linkIsExclusiveToRow(partial, BROCHURE_801)).toBe(false);
  });

  it('admits exclusivity once the evidence covers the upload', () => {
    const whole = countBranchLinkRows({ rows: UPLOAD, expectedRows: UPLOAD.length });
    expect(linkIsExclusiveToRow(whole, BROCHURE_801)).toBe(true);
  });

  it('treats a URL the count never saw as shared', () => {
    const counted = countBranchLinkRows({ rows: UPLOAD, expectedRows: UPLOAD.length });
    expect(linkSharedWithOtherRows(counted, 'https://example.invalid/never-seen.pdf')).toBe(true);
  });

  it('accepts an unbounded count only when the caller states no expectation', () => {
    const counted = countBranchLinkRows({ rows: UPLOAD });
    expect(counted.coverage.expected).toBeNull();
    expect(linkIsExclusiveToRow(counted, BROCHURE_801)).toBe(true);
  });
});

describe('the pipeline asks this module and nothing else', () => {
  const repair = read(`${SHARED}/repairSourceImages.ts`)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no longer counts branch urls off a raw row\'s `unmapped`', () => {
    expect(repair).not.toContain('?.unmapped ?? null)');
    expect(repair).not.toContain('unmappedWithRecoveredLinks(null,');
  });

  it('decides exclusivity through the shared module', () => {
    expect(repair).toContain('linkSharedWithOtherRows');
    expect(repair).toContain('countBranchLinkRows');
  });
});

/**
 * AND THE SECOND FAILURE, WHICH IS A DIFFERENT DEFECT IN A DIFFERENT MODULE.
 *
 * Production banked each property's OWN brochure as
 * `no_deterministic_image / inspected` — a permanent document verdict — while
 * the same brochure elects a facade at `#page1:Im0` through the same election
 * with the same inputs. The refusal quoted page 1 accurately, which proves the
 * text was read and the cover page was found; what failed was the decode.
 *
 * `electFromPdfBytes` had one branch for every non-`textFree` miss, so a
 * starved raster step and a document with no cover photograph were written
 * down identically — and the banked entry carries no `runtime_version`, so
 * nothing short of a `PROVENANCE_VERSION` bump ever reopens it.
 */
describe('a failed decode is never banked as a document verdict', () => {
  const election = read(`${SHARED}/pdfElection.ts`)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('answers `unreachable` where a cover page was found and nothing decoded', () => {
    expect(election).toContain('selection.coverPages.length && !selection.assets.length');
    const branch = election.slice(
      election.indexOf('selection.coverPages.length && !selection.assets.length'));
    expect(branch.slice(0, 220)).toContain("status: 'unreachable'");
  });

  it('keeps the document verdict for a document that names no cover page', () => {
    // `coverSearchPages` returning nothing is decided from TEXT alone, with no
    // raster touched, so it is knowledge about the document and stays banked.
    expect(election).toContain("status: 'not_identified'");
  });

  it('the selection reports which pages it looked at, so the caller can tell them apart', () => {
    const photo = read(`${SHARED}/pdfSourcePhoto.ts`);
    expect(photo).toContain('coverPages: number[]');
    expect(photo).toContain('coverPages: searchPages');
    expect(photo).toContain('coverPages: []');
  });
});

describe('the two passes describe the same properties, so they merge by maximum', () => {
  const MP = MASTERPLAN;
  it('never double-counts a property present in both passes', () => {
    const rows = [rawRow('801', 'Elara 18', BROCHURE_801), rawRow('809', 'VG18', BROCHURE_809)];
    const storedRowByItem = new Map<string, Record<string, unknown>>([
      ['a', { unmapped: { 'Siting / Masterplan URL': MP, 'Brochure URL': BROCHURE_801 } }],
      ['b', { unmapped: { 'Siting / Masterplan URL': MP, 'Brochure URL': BROCHURE_809 } }],
    ]);
    const counted = countBranchLinkRows({ rows, storedRowByItem, expectedRows: 2 });
    // Summing would say four properties carry it on a two-property upload.
    expect(counted.counts.get(MP)).toBe(2);
    expect(counted.coverage.counted).toBe(2);
    expect(linkIsExclusiveToRow(counted, BROCHURE_801)).toBe(true);
  });

  it('still sees a link only the stored side carries', () => {
    const onlyStored = 'https://drive.google.com/file/d/only-on-the-stored-row/view';
    const counted = countBranchLinkRows({
      rows: [rawRow('801', 'Elara 18', BROCHURE_801)],
      storedRowByItem: new Map([['a', {
        unmapped: { 'Brochure URL': onlyStored },
        recovered_link_columns: ['Brochure URL'],
      }]]),
      expectedRows: 1,
    });
    expect(counted.counts.get(onlyStored)).toBe(1);
    expect(counted.counts.get(BROCHURE_801)).toBe(1);
  });
});
