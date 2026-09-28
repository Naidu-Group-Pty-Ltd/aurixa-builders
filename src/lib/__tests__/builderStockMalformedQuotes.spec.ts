import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  malformedRecordWarnings,
  parseDelimited,
  parseDelimitedReport,
  sniffDelimiter,
  MALFORMED_ROWS_KEPT,
} from '../../../supabase/functions/_shared/builderStock/table.pure.ts';
import { extractStockFile } from '../../../supabase/functions/_shared/builderStock/extract.ts';
import { classifyStockFile } from '../../../supabase/functions/_shared/builderStock/fileTypes.pure.ts';
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure.ts';

/**
 * A STRAY QUOTATION MARK BREAKS ITS OWN ROW, AND NO OTHER.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Tier-0 audit, fixture
 * `scripts/ops/fixtures/tier0/neg/malformed.csv`): a CSV stock list whose
 * second line opened its price with a quotation mark and never closed it
 * imported ONE property — lot 701, whose `price_display` was
 * `$500,000,Available,PROOF ONLY T0-702,Kestrel Grove,702,3 Edg…`, 111
 * characters of the NEXT row — lost lot 702 entirely, and reported
 * `detected 1, failed 0`. The builder was told nothing.
 *
 * `parseDelimited` read that quote the way RFC 4180 says a quote is read: it
 * opens a quoted section, and a line break inside one does not end the record.
 * So one unpaired quote flips the quoting of everything after it. The reader
 * now recognises the two shapes only a broken row makes — the input ending
 * inside a quote, and a quoted section that crossed a line break and was then
 * closed somewhere that is not the end of a cell — takes the stray quote back
 * as an ordinary character, ends that record at its own line break, and
 * REPORTS it instead of returning it.
 *
 * Everything else is pinned byte for byte against the reader as it was before
 * the change (`legacyParseDelimited`, copied verbatim below): a multi-line
 * description cell, a `""` escape, CRLF, a BOM and a sloppy `"Stunning" home`
 * all occur in real exports, and none of them is a broken row.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'scripts', 'ops', 'fixtures', 'tier0');
const MALFORMED_FIXTURE = join(FIXTURES, 'neg', 'malformed.csv');

/*
 * THE READER AS IT WAS, copied verbatim from `table.pure.ts` before this
 * change, so "parses exactly as before" is a comparison rather than a claim.
 * It sniffs with the module's own `sniffDelimiter`, which the change leaves
 * alone.
 */
function legacyParseDelimited(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const sep = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === sep) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** A small seeded generator, so a failing case can be reproduced exactly. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RFC 4180, the way Excel, Sheets and `matrixToCsv` write it. */
function writeDelimited(matrix: string[][], sep: string, eol: string): string {
  const cell = (value: string) => (value.includes(sep) || /["\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value);
  return matrix.map((cells) => cells.map(cell).join(sep)).join(eol);
}

const HEADER = 'Stock Ref,Estate,Lot,Street Address,Suburb,State,Postcode,Design,Beds,Baths,Car,'
  + 'Land Size (m2),House Size (m2),Package Price,Status,Description';

describe('the measured defect — neg/malformed.csv, exactly as production received it', () => {
  const fixture = readFileSync(MALFORMED_FIXTURE, 'utf8');

  it('is the file the audit recorded', () => {
    expect(fixture).toBe(`${HEADER}\r\n`
      + 'T0-701,Kestrel Grove,701,1 Edge Road,Truganina,VIC,3029,Edge 1,3,2,2,300,150,'
      + '"$500,000,Available,PROOF ONLY\r\n'
      + 'T0-702,Kestrel Grove,702,3 Edge Road,Truganina,VIC,3029,Edge 2,3,2,2,300,150,'
      + '"$510,000",Available,PROOF ONLY\r\n');
  });

  it('does not merge the broken row into the one after it', () => {
    const rows = parseDelimited(fixture);
    expect(rows).toEqual([
      HEADER.split(','),
      ['T0-702', 'Kestrel Grove', '702', '3 Edge Road', 'Truganina', 'VIC', '3029', 'Edge 2',
        '3', '2', '2', '300', '150', '$510,000', 'Available', 'PROOF ONLY'],
    ]);
  });

  it('returns lot 702 intact, priced $510,000', () => {
    const [header, ...data] = parseDelimited(fixture);
    const lot702 = data.find((cells) => cells[0] === 'T0-702');
    expect(lot702).toBeDefined();
    expect(lot702![header.indexOf('Lot')]).toBe('702');
    expect(lot702![header.indexOf('Package Price')]).toBe('$510,000');
    expect(lot702!).toHaveLength(header.length);
  });

  it('never returns a cell carrying another row\'s text', () => {
    for (const cells of parseDelimited(fixture)) {
      for (const [column, cell] of cells.entries()) {
        expect(cell).not.toMatch(/[\r\n]/);
        if (column > 0) expect(cell).not.toMatch(/T0-70\d/);
      }
    }
  });

  it('reports lot 701 as malformed on line 2, and does not return it', () => {
    const report = parseDelimitedReport(fixture);
    expect(report.malformed).toEqual([{
      line: 2,
      preview: 'T0-701,Kestrel Grove,701,1 Edge Road,Truganina,VIC,3029,Edg…',
    }]);
    expect(report.malformed[0].preview.length).toBeLessThanOrEqual(60);
    expect(report.rows.some((cells) => cells[0] === 'T0-701')).toBe(false);
    expect(report.rows).toEqual(parseDelimited(fixture));
  });

  it('imports lot 702 through the real extraction and tells the builder about line 2', async () => {
    const bytes = new Uint8Array(readFileSync(MALFORMED_FIXTURE));
    const result = await extractStockFile(
      bytes, 'malformed.csv', classifyStockFile('malformed.csv', 'text/csv'));

    expect(result.strategy).toBe('delimited_table');
    expect(result.rows).toHaveLength(1);
    const record = normaliseStockRow(result.rows[0])!;
    expect([record.lot_number, record.price]).toEqual(['702', 510000]);
    expect(result.warnings).toEqual([
      'Line 2 could not be read: its quotation marks do not pair up, so its columns cannot be '
      + 'told apart. Correct the quotes in that row (it begins “T0-701,Kestrel Grove,701,1 Edge '
      + 'Road,Truganina,VIC,3029,Edg…”) and import the corrected list.',
    ]);
  });
});

describe('what was never broken reads exactly as before', () => {
  const cases: Record<string, string> = {
    'a multi-line quoted description (LF)':
      'Lot,Design,Description\n101,Aspen 25,"North-facing yard.\nStone benchtops.\n\nTwo living areas."\n102,Birch 22,Plain\n',
    'a multi-line quoted description (CRLF inside and between)':
      'Lot,Design,Description\r\n101,Aspen 25,"North-facing yard.\r\nStone benchtops."\r\n102,Birch 22,Plain\r\n',
    'a multi-line cell as the last thing in the file':
      'Lot,Description\n101,"one\ntwo"',
    '"" escapes, inside and at the edges of a cell':
      'Lot,Description,Note\n101,"He said ""sold"" twice","""quoted"""\n102,"12"" wide",""\n',
    'an empty quoted cell and a cell that is only an escaped quote':
      'Lot,A,B,C\n101,"","""",x\n',
    'CRLF line endings throughout':
      'Lot,Price,Status\r\n101,"$749,900",Available\r\n102,"$712,500",Sold\r\n',
    'a leading BOM':
      '﻿Lot,Price,Status\r\n101,"$749,900",Available\r\n',
    'a semicolon file':
      'Lot;Price;Status;Description\n101;$749,900;Available;"Café; north-facing"\n102;"$712;500";Sold;\n',
    'a tab file with a quoted multi-line cell':
      'Lot\tPrice\tDescription\n101\t$600,000\t"Line one\nLine two"\n102\t$612,500\tPlain\n',
    'a pipe file':
      'Lot|Price|Status\n101|$749,900|Available\n102|"a|b"|Sold\n',
    'blank lines and whitespace-only lines':
      '\n\nLot,Price\n\n101,$1\n   \n,,\n102,$2\n\n',
    'no trailing newline':
      'Lot,Price\n101,"$749,900"',
    'a lone carriage return inside a line':
      'Lot,Price\n10\r1,$1\n',
    'the sloppy one-line form "Stunning" home':
      'Lot,Description\n101,"Stunning" home\n102,Plain\n',
    'a quote that opens part-way through a cell and closes on the same line':
      'Lot,Description\n101,ab"cd"ef\n102,"x"y"z"\n',
    'a quoted cell closed by a quote followed by CR':
      'Lot,Description\n101,"one\ntwo"\r\n102,x\n',
    'an empty input': '',
    'only a BOM': '﻿',
  };

  for (const [name, input] of Object.entries(cases)) {
    it(name, () => {
      const report = parseDelimitedReport(input);
      expect(report.malformed).toEqual([]);
      expect(report.rows).toStrictEqual(legacyParseDelimited(input));
      expect(parseDelimited(input)).toStrictEqual(legacyParseDelimited(input));
      expect(parseDelimited(input, '\t')).toStrictEqual(legacyParseDelimited(input, '\t'));
    });
  }

  it('reads "Stunning" home as it always has', () => {
    expect(parseDelimitedReport('Lot,Description\n101,"Stunning" home\n')).toEqual({
      rows: [['Lot', 'Description'], ['101', 'Stunning home']],
      malformed: [],
      malformedTotal: 0,
    });
  });

  it('keeps the line breaks of a multi-line description cell', () => {
    expect(parseDelimited('Lot,Description\r\n101,"one\r\ntwo"\r\n')[1]).toEqual(['101', 'one\r\ntwo']);
  });

  /*
   * THE REAL FIXTURES. Every delimited file in the Tier-0 set is read, not a
   * list typed here, so a fixture added later is covered without anyone
   * remembering to add it. Three are excluded, each for a stated reason.
   */
  const NOT_WELL_FORMED: Record<string, string> = {
    'neg/malformed.csv': 'the defect itself',
    'neg/program.csv': 'an executable renamed .csv; refused as one before it is classified',
    'neg/workbook-named.csv': 'an .xlsx renamed .csv; its bytes classify it as a spreadsheet',
  };
  const delimitedFixtures = [
    ...readdirSync(FIXTURES),
    ...readdirSync(join(FIXTURES, 'neg')).map((name) => `neg/${name}`),
  ].filter((name) => /\.(csv|tsv|txt)$/i.test(name) && !(name in NOT_WELL_FORMED));

  it('finds the real delimited fixtures to compare', () => {
    expect(delimitedFixtures).toEqual(expect.arrayContaining([
      'csv-v1.csv', 'csv-v2.csv', 'tsv.tsv', 'txt.txt',
      'neg/duplicate-rows.csv', 'neg/long.csv', 'neg/unicode.csv', 'neg/unusual.csv',
    ]));
  });

  for (const name of delimitedFixtures) {
    it(`reads the real fixture ${name} byte for byte as before`, () => {
      const input = readFileSync(join(FIXTURES, name), 'utf8');
      const report = parseDelimitedReport(input);
      expect(report.malformed).toEqual([]);
      expect(report.rows).toStrictEqual(legacyParseDelimited(input));
    });
  }

  it('reads generated RFC 4180 files — quotes, separators, CR and LF in cells — as before', () => {
    const vocabulary = [
      'Kestrel Grove', 'T0-101', '$749,900', 'PROOF ONLY — not for sale.', 'He said "hi"',
      'North-facing\nyard', 'Café\r\nkitchen', 'a;b', 'x\ty', 'p|q', '', ' ', '12" wide',
      '3/14 Unusual Street', '"', '""', 'trailing\n', '\nleading',
    ];
    const random = seeded(20260928);
    for (let file = 0; file < 400; file += 1) {
      const sep = [',', ';', '\t', '|'][Math.floor(random() * 4)];
      const eol = random() < 0.5 ? '\n' : '\r\n';
      const width = 1 + Math.floor(random() * 6);
      const matrix = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        Array.from({ length: width }, () => vocabulary[Math.floor(random() * vocabulary.length)]));
      const bom = random() < 0.2 ? '﻿' : '';
      const trailing = random() < 0.5 ? eol : '';
      const input = bom + writeDelimited(matrix, sep, eol) + trailing;

      const report = parseDelimitedReport(input, sep);
      expect(report.malformed).toEqual([]);
      expect(report.rows).toStrictEqual(legacyParseDelimited(input, sep));
      /*
       * And through the sniffer — where it names the file's own separator.
       * Where it does not (a pipe file whose cells carry more commas than the
       * file has pipes), the file is being read with a separator it was not
       * written with, so it is not a well-formed file under that reading.
       */
      if (sniffDelimiter(input) === sep) {
        expect(parseDelimited(input)).toStrictEqual(legacyParseDelimited(input));
      }
    }
  });

  /*
   * THE INVARIANT, over arbitrary text: wherever nothing is reported, the
   * output IS the old output. Recovery is the only new behaviour, and it is
   * only ever taken where a record is also reported. The counts prove both
   * branches were exercised, so the property cannot pass vacuously.
   */
  it('returns exactly the old rows for any text in which it reports nothing', () => {
    const alphabet = ['a', 'b', ',', ';', '"', '"', '\n', '\r', ' '];
    const random = seeded(701702);
    let clean = 0;
    let reported = 0;
    for (let run = 0; run < 6000; run += 1) {
      const length = Math.floor(random() * 48);
      let input = '';
      for (let i = 0; i < length; i += 1) input += alphabet[Math.floor(random() * alphabet.length)];

      const report = parseDelimitedReport(input);
      const lines = input.split('\n').length;
      for (const { line, preview } of report.malformed) {
        expect(line).toBeGreaterThanOrEqual(1);
        expect(line).toBeLessThanOrEqual(lines);
        expect(preview.length).toBeLessThanOrEqual(60);
      }
      if (report.malformed.length) {
        reported += 1;
      } else {
        clean += 1;
        expect(report.rows).toStrictEqual(legacyParseDelimited(input));
      }
    }
    expect(clean).toBeGreaterThan(1000);
    expect(reported).toBeGreaterThan(1000);
  });
});

describe('an unterminated quote on the last row', () => {
  const head = 'Stock Ref,Lot,Package Price\nT0-1,1,"$500,000"\nT0-2,2,"$505,000"\n';

  it('is reported, and the rows before it are intact (with a final newline)', () => {
    const report = parseDelimitedReport(`${head}T0-3,3,"$510,000\n`);
    expect(report.rows).toEqual([
      ['Stock Ref', 'Lot', 'Package Price'],
      ['T0-1', '1', '$500,000'],
      ['T0-2', '2', '$505,000'],
    ]);
    expect(report.malformed).toEqual([{ line: 4, preview: 'T0-3,3,"$510,000' }]);
  });

  it('is reported, and the rows before it are intact (without one)', () => {
    const report = parseDelimitedReport(`${head}T0-3,3,"$510,000`);
    expect(report.rows).toHaveLength(3);
    expect(report.malformed).toEqual([{ line: 4, preview: 'T0-3,3,"$510,000' }]);
  });

  it('names the line the record STARTS on when it began with a real multi-line cell', () => {
    const report = parseDelimitedReport(
      'Lot,Description,Price\n1,"one\ntwo",$1\n2,"three\nfour","$5\n');
    expect(report.rows).toEqual([['Lot', 'Description', 'Price'], ['1', 'one\ntwo', '$1']]);
    expect(report.malformed).toEqual([{ line: 4, preview: '2,"three four","$5' }]);
  });
});

describe('several broken rows in one file', () => {
  it('reports both, and every good row survives', () => {
    const input = [
      HEADER,
      'T0-801,Kestrel Grove,801,1 Test Road,Truganina,VIC,3029,A,3,2,2,300,150,"$500,000",Available,Good one',
      'T0-802,Kestrel Grove,802,2 Test Road,Truganina,VIC,3029,B,3,2,2,300,150,"$501,000,Available,Broken one',
      'T0-803,Kestrel Grove,803,3 Test Road,Truganina,VIC,3029,C,3,2,2,300,150,"$502,000",Available,Good two',
      'T0-804,Kestrel Grove,804,4 Test Road,Truganina,VIC,3029,D,3,2,2,300,150,"$503,000,Available,Broken two',
      'T0-805,Kestrel Grove,805,5 Test Road,Truganina,VIC,3029,E,3,2,2,300,150,"$504,000",Available,Good three',
      '',
    ].join('\r\n');

    const report = parseDelimitedReport(input);
    expect(report.malformed.map(({ line }) => line)).toEqual([3, 5]);
    expect(report.rows.map((cells) => [cells[0], cells[13], cells[15]])).toEqual([
      ['Stock Ref', 'Package Price', 'Description'],
      ['T0-801', '$500,000', 'Good one'],
      ['T0-803', '$502,000', 'Good two'],
      ['T0-805', '$504,000', 'Good three'],
    ]);
    for (const cells of report.rows) expect(cells).toHaveLength(16);
  });

  it('recovers when every data row is broken, down to the last', () => {
    const input = 'Lot,Price,Status\n1,"$1,Available\n2,"$2,Available\n3,"$3,Available\n';
    const report = parseDelimitedReport(input);
    expect(report.rows).toEqual([['Lot', 'Price', 'Status']]);
    expect(report.malformed.map(({ line }) => line)).toEqual([2, 3, 4]);
  });

  it('recovers when the header itself is the broken row, without merging the data rows', () => {
    const report = parseDelimitedReport('Lot,"Price,Status\n1,"$1",Available\n2,"$2",Sold\n');
    expect(report.malformed.map(({ line }) => line)).toEqual([1]);
    expect(report.rows).toEqual([['1', '$1', 'Available'], ['2', '$2', 'Sold']]);
  });

  it('respects an explicit separator when deciding where a cell ends', () => {
    const report = parseDelimitedReport(
      'Lot\tPrice\tNote\n1\t"$1\tbroken\n2\t"$2"\tgood\n3\t"multi\nline"\tgood\n', '\t');
    expect(report.malformed.map(({ line }) => line)).toEqual([2]);
    expect(report.rows).toEqual([
      ['Lot', 'Price', 'Note'], ['2', '$2', 'good'], ['3', 'multi\nline', 'good']]);
  });

  /*
   * ONE STRAY QUOTE, ANYWHERE, IN ANY WELL-FORMED FILE: exactly that row is
   * reported and every other row reads as it would have without it. The quote
   * is placed after the last quote already on its row, and never directly
   * after one (`""` is an escape, not a stray), so it is always the row's own
   * mistake rather than a change to a cell the file had quoted. Every row ends
   * in a plain cell so there is always somewhere to put it.
   */
  it('confines a single stray quote to its own row in generated files', () => {
    const vocabulary = [
      'Kestrel Grove', 'T0-101', '$749,900', 'He said "hi"', 'North-facing\nyard',
      'Café\r\nkitchen', 'a;b', '', '12" wide', 'Plain', '7A',
    ];
    const random = seeded(28092026);
    for (let file = 0; file < 300; file += 1) {
      const sep = [',', ';', '\t'][Math.floor(random() * 3)];
      const eol = random() < 0.5 ? '\n' : '\r\n';
      const width = Math.floor(random() * 5);
      const matrix = Array.from({ length: 2 + Math.floor(random() * 8) }, (_, index) => [
        `R${index}`,
        ...Array.from({ length: width }, () => vocabulary[Math.floor(random() * vocabulary.length)]),
        `L${index}`,
      ]);
      const lines = matrix.map((cells) => writeDelimited([cells], sep, eol));
      const broken = Math.floor(random() * lines.length);
      const lastQuote = lines[broken].lastIndexOf('"');
      const from = lastQuote < 0 ? 0 : lastQuote + 2;
      const at = from + Math.floor(random() * (lines[broken].length - from + 1));
      const corrupted = lines.map((line, index) =>
        (index === broken ? `${line.slice(0, at)}"${line.slice(at)}` : line));
      const trailing = random() < 0.5 ? eol : '';
      const input = corrupted.join(eol) + trailing;

      const report = parseDelimitedReport(input, sep);
      const startLine = 1 + (corrupted.slice(0, broken).join(eol) + (broken ? eol : ''))
        .split('\n').length - 1;
      expect(report.malformed.map(({ line }) => line)).toEqual([startLine]);
      const withoutIt = lines.filter((_, index) => index !== broken).join(eol) + trailing;
      expect(report.rows).toStrictEqual(legacyParseDelimited(withoutIt, sep));
    }
  });

  it('always finishes, however many quotes are stray', () => {
    const good = 'T0-1,Kestrel Grove,1,"$500,000",Available';
    const bad = 'T0-2,Kestrel Grove,2,"$500,000,Available';
    const rows = Array.from({ length: 4000 }, (_, index) => (index % 3 === 1 ? bad : good));
    const report = parseDelimitedReport(`Stock Ref,Estate,Lot,Package Price,Status\n${rows.join('\n')}\n`);
    expect(report.malformedTotal).toBe(rows.filter((row) => row === bad).length);
    expect(report.malformed).toHaveLength(MALFORMED_ROWS_KEPT);
    expect(report.rows).toHaveLength(1 + rows.filter((row) => row === good).length);

    const quotesOnly = '"\n'.repeat(3000) + '"'.repeat(3001) + '\n"x\n'.repeat(3000);
    expect(() => parseDelimitedReport(quotesOnly)).not.toThrow();
  });
});

describe('the builder is told, once per row', () => {
  const record = (line: number) => ({ line, preview: `T0-${line},Kestrel Grove` });

  it('names the line and quotes the start of the row', () => {
    expect(malformedRecordWarnings([record(7)])).toEqual([
      'Line 7 could not be read: its quotation marks do not pair up, so its columns cannot be '
      + 'told apart. Correct the quotes in that row (it begins “T0-7,Kestrel Grove”) and import '
      + 'the corrected list.',
    ]);
  });

  it('says nothing when nothing was broken', () => {
    expect(malformedRecordWarnings([])).toEqual([]);
  });

  it('stops at ten rows and counts the rest in one more line', () => {
    const eleven = malformedRecordWarnings(Array.from({ length: 11 }, (_, index) => record(index + 2)));
    expect(eleven).toHaveLength(11);
    expect(eleven[10]).toBe('…and 1 more row could not be read for the same reason.');

    const twelve = malformedRecordWarnings(Array.from({ length: 12 }, (_, index) => record(index + 2)));
    expect(twelve).toHaveLength(11);
    expect(twelve.slice(0, 10).map((warning) => /^Line (\d+) /.exec(warning)?.[1]))
      .toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    expect(twelve[10]).toBe('…and 2 more rows could not be read for the same reason.');
    // Rendered as React keys on the import summary, so no two may be equal.
    expect(new Set(twelve).size).toBe(twelve.length);
  });

  it('reaches the extraction\'s warnings for every broken row, capped the same way', async () => {
    const good = (lot: number) => `T0-${lot},Kestrel Grove,${lot},"$500,000",Available`;
    const bad = (lot: number) => `T0-${lot},Kestrel Grove,${lot},"$500,000,Available`;
    const lines = ['Stock Ref,Estate,Lot,Package Price,Status'];
    for (let lot = 1; lot <= 12; lot += 1) lines.push(bad(lot), good(100 + lot));
    const bytes = new TextEncoder().encode(`${lines.join('\n')}\n`);

    const result = await extractStockFile(
      bytes, 'stock.csv', classifyStockFile('stock.csv', 'text/csv'));
    expect(result.rows.map((row) => row.Lot)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(101 + index)));
    expect(result.warnings).toHaveLength(11);
    expect(result.warnings[0]).toMatch(/^Line 2 could not be read: /);
    expect(result.warnings[9]).toMatch(/^Line 20 could not be read: /);
    expect(result.warnings[10]).toBe('…and 2 more rows could not be read for the same reason.');
  });

  it('does not warn about columns when the file was read as prose instead', async () => {
    const prose = 'Kestrel Grove release notes\nThe "Aspen 25 is our\nfavourite design this spring.\n';
    const result = await extractStockFile(
      new TextEncoder().encode(prose), 'notes.txt', classifyStockFile('notes.txt', 'text/plain'));
    expect(result.strategy).toBe('delimited_text');
    expect(result.warnings).toEqual(['No column headings were recognised, so the file was read as text.']);
  });
});

/*
 * FOUND BY THE INDEPENDENT REVIEW (28 September 2026), both reproduced here
 * before they were fixed.
 */
describe('what the review found', () => {
  it('reads a multi-line quoted cell followed by spaces before its separator, as the old reader did', () => {
    const input = 'Lot,Description,Price\n1,"Stunning home\nwith pool" ,500000\n2,Plain,510000\n';
    const report = parseDelimitedReport(input);
    expect(report.malformed).toEqual([]);
    expect(report.rows).toEqual([
      ['Lot', 'Description', 'Price'],
      ['1', 'Stunning home\nwith pool ', '500000'],
      ['2', 'Plain', '510000'],
    ]);
  });

  it('keeps the same reading for a tab-separated file, where a tab IS the separator', () => {
    const input = 'Lot\tDescription\tPrice\n1\t"Stunning home\nwith pool"\t500000\n';
    expect(parseDelimitedReport(input, '\t').rows).toEqual([
      ['Lot', 'Description', 'Price'],
      ['1', 'Stunning home\nwith pool', '500000'],
    ]);
  });

  it('holds a bounded record of broken rows however many a file carries, and still counts every one', () => {
    const lines = ['Lot,Description,Price'];
    for (let i = 0; i < 5000; i += 1) lines.push(`${i},"broken\nrow ${i}"x,1`);
    const report = parseDelimitedReport(`${lines.join('\n')}\n`);
    expect(report.malformed).toHaveLength(MALFORMED_ROWS_KEPT);
    expect(report.malformedTotal).toBeGreaterThanOrEqual(5000);
    const warnings = malformedRecordWarnings(report.malformed, report.malformedTotal);
    expect(warnings).toHaveLength(11);
    expect(warnings[10]).toBe(`…and ${report.malformedTotal - 10} more rows could not be read for the same reason.`);
  });
});
