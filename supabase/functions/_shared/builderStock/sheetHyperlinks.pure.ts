/**
 * BUILDER STOCK — A SPREADSHEET CELL CAN SAY "Brochure" AND MEAN A URL.
 *
 * A stock list kept in Google Sheets carries its documents as HYPERLINKS: the
 * cell displays a label — `Brochure`, `Masterplan`, `Stage 6 - POS` — and the
 * address lives underneath it. Every CSV export, Google's own included, writes
 * the displayed value and throws the target away. Measured on a real builder
 * list: five link-bearing columns, 119 rows, and ZERO plain-text URLs anywhere
 * in the tab. Read as CSV alone, not one property has a builder source for
 * stage 1 to follow, and the whole ladder starts at its second rung.
 *
 * XLSX keeps them. SheetJS surfaces one as `cell.l.Target` beside the
 * displayed `cell.v`, and a labelled cell with no link — `N/A` — carries none,
 * so the two are distinguishable rather than inferred.
 *
 *
 * MEMBERSHIP DOES NOT MOVE. THIS ONLY ADDS COLUMNS.
 *
 * The exact requested gid remains the only thing that says which properties
 * exist: its CSV supplies the rows, their order and their values, and this
 * appends a URL column beside each link-bearing one. No row is added, removed
 * or reordered — asserted here rather than promised, because a workbook export
 * is the WHOLE workbook and letting it near membership is how another tab's
 * rows become a builder's stock.
 *
 * WHICH WORKSHEET, THOUGH. An XLSX export contains every tab and nothing in it
 * records the gid, so the worksheet has to be identified by what it CONTAINS.
 * Position is not identity: the requested tab is routinely not the first, and
 * a workbook's sheet order is not the order the tabs were created in. So each
 * worksheet is scored against the proven CSV and exactly one must win
 * decisively. Zero matches means the links are unavailable and the import
 * proceeds on the CSV alone; an ambiguous match means the same, because
 * borrowing a near-identical tab's links is precisely the failure this exists
 * to prevent.
 *
 * Pure: no IO, no clock, no network.
 */

/** One worksheet as the caller read it out of the workbook. */
export interface WorkbookSheet {
  name: string;
  /** Visible values, row-major, exactly as the grid renders them. */
  values: (string | null)[][];
  /** `[row][col]` hyperlink targets, sparse. Absent where the cell has none. */
  links: (string | null)[][];
}

export type WorksheetMatch =
  | { ok: true; sheet: WorkbookSheet; score: number; headerRow: number }
  | { ok: false; reason: 'no_match' | 'ambiguous'; best: number; runnerUp: number };

/**
 * A cell as two grids can agree on it.
 *
 * A CSV export and an XLSX export of the same tab render the same value
 * slightly differently — thousands separators, a currency symbol, a trailing
 * space, casing in a heading. None of those is a different worksheet, and all
 * of them would break an equality test, so they are normalised away. Nothing
 * that could distinguish two REAL tabs is: digits, letters and their order all
 * survive.
 */
export function normaliseCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/[$,]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * How much of one row of the CSV a worksheet row reproduces, cell for cell.
 *
 * Empty CSV cells agree with everything, so they measure nothing.
 */
function rowAgreement(
  csvRow: string[],
  sheetRow: (string | null)[] | undefined,
  map?: ColumnMap,
): number {
  let compared = 0;
  let agreed = 0;
  for (let c = 0; c < csvRow.length; c += 1) {
    const want = normaliseCell(csvRow[c]);
    if (!want) continue;
    const sheetColumn = map ? map.sheetColumnFor[c] : c;
    // A column the two representations do not share measures nothing — see
    // `mapColumnsByHeader`: a hidden column is absent from one rendering and
    // present in the other, and counting it as disagreement failed real rows.
    if (sheetColumn === null || sheetColumn === undefined) continue;
    compared += 1;
    if (normaliseCell(sheetRow?.[sheetColumn]) === want) agreed += 1;
  }
  return compared === 0 ? 0 : agreed / compared;
}

/**
 * HOW ALIKE TWO EXPORTS OF ONE ROW HAVE TO BE.
 *
 * Not identical. `gviz` and the grid render the same tab independently and
 * disagree in the small: a trailing space, a date's month, a number's
 * separators. Demanding a whole row match exactly made the live document fail
 * to recognise ITSELF, which is why the original comparison was tolerant at
 * CELL level. That tolerance was right; only its assumption that a CSV row and
 * a worksheet row share an INDEX was wrong.
 */
export const ROW_MATCH_FLOOR = 0.9;

/**
 * Where each cell value occurs in the worksheet body.
 *
 * `column \u0000 value` -> the rows carrying it. Built once, this answers
 * "which rows look like this one" without comparing every CSV row against
 * every worksheet row — which on a large builder list would be millions of
 * comparisons inside an edge function.
 */
function cellIndex(
  sheet: WorkbookSheet, headerRow: number, width: number, map?: ColumnMap,
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let r = headerRow + 1; r < sheet.values.length; r += 1) {
    const row = sheet.values[r];
    if (!row) continue;
    for (let c = 0; c < width; c += 1) {
      // Keyed by the CSV's column, read from the sheet's — the map is what
      // lets a representation that omits hidden columns still answer for the
      // columns it does carry.
      const sheetColumn = map ? map.sheetColumnFor[c] : c;
      if (sheetColumn === null || sheetColumn === undefined) continue;
      const value = normaliseCell(row[sheetColumn]);
      if (!value) continue;
      const key = `${c}\u0000${value}`;
      const at = index.get(key);
      if (at) at.push(r); else index.set(key, [r]);
    }
  }
  return index;
}

/** The worksheet rows that best reproduce this CSV row, and how well. */
function candidatesFor(
  csvRow: string[], index: Map<string, number[]>, width: number, map?: ColumnMap,
): { best: number; compared: number; winners: number[] } {
  let compared = 0;
  const tally = new Map<number, number>();
  for (let c = 0; c < width; c += 1) {
    if (map && (map.sheetColumnFor[c] === null || map.sheetColumnFor[c] === undefined)) continue;
    const value = normaliseCell(csvRow[c]);
    if (!value) continue;
    compared += 1;
    for (const r of index.get(`${c}\u0000${value}`) ?? []) {
      tally.set(r, (tally.get(r) ?? 0) + 1);
    }
  }
  let best = 0;
  for (const n of tally.values()) if (n > best) best = n;
  const winners: number[] = [];
  for (const [r, n] of tally) if (n === best) winners.push(r);
  return { best, compared, winners };
}

/** A worksheet row must reproduce this much of the CSV header to BE the header. */
export const HEADER_MATCH_FLOOR = 0.7;

/**
 * WHICH SHEET COLUMN ANSWERS FOR WHICH CSV COLUMN.
 *
 * WHY POSITION IS NOT ENOUGH. The proven CSV and the link-bearing rendering
 * are two independent drawings of one tab, and they do not agree about
 * COLUMNS any more than they agree about rows: the htmlview grid renders only
 * VISIBLE columns, and the live VG stock list hides three (Rental Appraisal,
 * Rental Income, Rental Yield — CSV columns 18-20), so from `Status` onward
 * every htmlview cell sits three places left of its CSV twin. Compared
 * position-for-position, real rows lost 3-4 cells each, three of sixteen fell
 * under `ROW_MATCH_FLOOR`, the tab scored 0.8 against `MATCH_FLOOR` 0.95, and
 * the whole document refused to recognise itself — links and all.
 *
 * THE ANSWER IS NOT A LOWER FLOOR. The floors are what stop a brochure being
 * borrowed by the wrong row, and they stand. The answer is that COLUMNS ARE
 * IDENTIFIED BY THEIR HEADINGS the same way rows are identified by their
 * content: `Brochure V002` is `Brochure V002` in both renderings, wherever
 * each happens to draw it.
 *
 * THE MAP IS DETERMINISTIC AND FAILS CLOSED, column by column:
 *
 *   - a heading that appears EXACTLY ONCE on each side maps to its twin;
 *   - a heading duplicated on either side maps NOWHERE — two columns a
 *     heading cannot tell apart must not swap answers;
 *   - an empty CSV heading keeps its own index only while the sheet's heading
 *     there is empty too, because values under anonymous columns still have
 *     to be compared against SOMETHING and same-index is the only honest
 *     candidate;
 *   - anything else maps nowhere, and an unmapped column MEASURES NOTHING —
 *     it is excluded from row scoring entirely rather than counted against
 *     it, which is the whole correction.
 *
 * Where no header row can be found the map is identity, so every document
 * that matched before this existed matches identically after it.
 */
export interface ColumnMap {
  /** For each CSV column index, the sheet column that answers for it, or null. */
  sheetColumnFor: (number | null)[];
  /** How many CSV columns found a sheet column. */
  mapped: number;
}

export function mapColumnsByHeader(csv: string[][], sheet: WorkbookSheet): ColumnMap {
  const width = (csv[0] ?? []).length;
  const identity: ColumnMap = {
    sheetColumnFor: Array.from({ length: width }, (_, c) => c),
    mapped: width,
  };

  const headerRow = locateHeaderRow(csv, sheet);
  if (headerRow < 0) return identity;
  const sheetHeader = sheet.values[headerRow] ?? [];

  const csvNames = (csv[0] ?? []).map((cell) => normaliseCell(cell));
  const sheetNames = sheetHeader.map((cell) => normaliseCell(cell));
  const countIn = (names: string[]) => {
    const counts = new Map<string, number>();
    for (const name of names) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  };
  const csvCounts = countIn(csvNames);
  const sheetCounts = countIn(sheetNames);

  const sheetColumnFor: (number | null)[] = [];
  let mapped = 0;
  for (let c = 0; c < width; c += 1) {
    const name = csvNames[c];
    if (!name) {
      const sameIndexEmpty = !sheetNames[c];
      sheetColumnFor.push(sameIndexEmpty ? c : null);
      if (sameIndexEmpty) mapped += 1;
      continue;
    }
    if (csvCounts.get(name) === 1 && sheetCounts.get(name) === 1) {
      sheetColumnFor.push(sheetNames.indexOf(name));
      mapped += 1;
      continue;
    }
    sheetColumnFor.push(null);
  }
  return { sheetColumnFor, mapped };
}

/**
 * WHERE THE HEADINGS ACTUALLY ARE — asked of content, never assumed.
 *
 * Row 0 is not the header, and on the document that proved this it is not even
 * close: the live stocklist opens with a banner and spacer rows and puts
 * `Lot #` on the EIGHTH row. Meanwhile `gviz` — the representation the import
 * proved the CSV from — compacts all of that away and reports the header as
 * its row 0. Two true readings of one tab, seven rows apart.
 *
 * Taking `values[0]` on faith produced empty headings, which produced no
 * headed rows, which applied no links and said nothing about why. So the
 * header is FOUND: the worksheet row that best reproduces the CSV's header
 * row, and only if it reproduces most of it.
 *
 * A banner cell merged into the heading is tolerated, because that is exactly
 * what `gviz` does to a two-row header — it reports
 * `"[VG] MASTER STOCKLIST - V002 Contract Type"` where the sheet holds
 * `"Contract Type"`. One disagreeing cell out of twenty-three must not lose
 * the header; twenty disagreeing cells must.
 */
export function locateHeaderRow(csv: string[][], sheet: WorkbookSheet): number {
  const header = csv[0] ?? [];
  if (!header.length) return -1;

  /*
   * TWO READINGS OF "REPRODUCES THE HEADER", AND THE BETTER ONE WINS PER ROW.
   *
   * Positional agreement is the original test and still the sharpest where
   * the two representations lay their columns out identically. But a
   * rendering that OMITS HIDDEN COLUMNS shifts everything after the gap, and
   * a heading two places left of where the CSV drew it is still the same
   * heading — so each row is also scored by CONTAINMENT: how many of the
   * CSV's uniquely-named headings appear anywhere in it. On the live VG list
   * the header row scores 0.727 positionally (three hidden columns and a
   * banner-merged first cell against it) and 0.818 by containment; a document
   * with one more hidden column would fall under the floor positionally while
   * containment barely moves. Both tests demand the same floor, and a row
   * that clears neither is still no header at all.
   */
  const names = header.map((cell) => normaliseCell(cell));
  const uniqueNames = names.filter((name, index) => name && names.indexOf(name) === index
    && names.lastIndexOf(name) === index);

  const containment = (row: (string | null)[] | undefined): number => {
    if (!uniqueNames.length || !row) return 0;
    const present = new Set(row.map((cell) => normaliseCell(cell)).filter(Boolean));
    let found = 0;
    for (const name of uniqueNames) if (present.has(name)) found += 1;
    return found / uniqueNames.length;
  };

  let bestRow = -1;
  let bestScore = 0;
  for (let r = 0; r < sheet.values.length; r += 1) {
    const score = Math.max(
      rowAgreement(header, sheet.values[r]),
      containment(sheet.values[r]),
    );
    if (score > bestScore) { bestScore = score; bestRow = r; }
  }
  return bestScore >= HEADER_MATCH_FLOOR ? bestRow : -1;
}

/**
 * WHICH WORKSHEET ROW IS THIS CSV ROW — by what it says, never by where it sits.
 *
 * The two representations do not agree about row NUMBERS and never did. `gviz`
 * drops blank rows; the sheet keeps them, and the live stocklist carries one
 * between Lot 605 and Lot 606. Under an index-for-index reading every property
 * below that blank row would take the NEXT one's brochure — which is the exact
 * failure this whole module exists to prevent, arriving through the back door.
 *
 * So a CSV row is paired with the worksheet row that SAYS THE SAME THING, and
 * only when exactly one does. Two identical rows — and this data has them, the
 * same lot listed twice — pair with nothing at all rather than with the first
 * or the nearest. A link that cannot be attributed beyond doubt is not applied.
 *
 * Returns, for each CSV row index, its worksheet row index or -1.
 */
export function alignWorksheetRows(csv: string[][], sheet: WorkbookSheet): number[] {
  const width = (csv[0] ?? []).length;
  const headerRow = locateHeaderRow(csv, sheet);
  const aligned = new Array<number>(csv.length).fill(-1);
  if (headerRow < 0) return aligned;
  aligned[0] = headerRow;

  // Columns are identified by their headings before rows are identified by
  // their content — see `mapColumnsByHeader` for the measured reason.
  const map = mapColumnsByHeader(csv, sheet);
  const index = cellIndex(sheet, headerRow, width, map);
  for (let r = 1; r < csv.length; r += 1) {
    const { best, compared, winners } = candidatesFor(csv[r] ?? [], index, width, map);
    if (!compared) continue;
    /*
     * ONE ROW, BEATING EVERY OTHER. Alike-enough is not sufficient: on a list
     * of near-identical products a dozen rows clear any floor, so the winner
     * has to be the STRICT maximum. A tie is two rows this data cannot tell
     * apart — the same lot listed twice, as this builder's sheet does — and
     * neither may lend its document to the other.
     */
    if (winners.length !== 1) continue;
    if (best < Math.ceil(compared * ROW_MATCH_FLOOR)) continue;
    aligned[r] = winners[0];
  }
  return aligned;
}

/**
 * How much of the CSV this worksheet reproduces.
 *
 * CONTAINMENT, NOT COINCIDENCE OF ROW NUMBER. The question here is only
 * "is this the same tab", so a CSV row counts as reproduced when the worksheet
 * says something close enough to it SOMEWHERE below its header. Whether that
 * row's link may then be trusted is a different and stricter question,
 * answered by `alignWorksheetRows`, which additionally demands a single
 * unambiguous winner.
 *
 * Scoring by index was true of neither representation and made the live
 * document reproduce 0.22 of itself.
 */
export function worksheetScore(csv: string[][], sheet: WorkbookSheet): number {
  const width = (csv[0] ?? []).length;
  const headerRow = locateHeaderRow(csv, sheet);
  if (headerRow < 0) return 0;

  const map = mapColumnsByHeader(csv, sheet);
  const index = cellIndex(sheet, headerRow, width, map);
  let compared = 0;
  let agreed = 0;
  for (let r = 1; r < csv.length; r += 1) {
    const found = candidatesFor(csv[r] ?? [], index, width, map);
    if (!found.compared) continue;
    compared += 1;
    if (found.best >= Math.ceil(found.compared * ROW_MATCH_FLOOR)) agreed += 1;
  }
  // A tab that reproduces the header and has no data rows to check is not
  // evidence of anything; it scores on its header alone.
  if (compared === 0) return rowAgreement(csv[0] ?? [], sheet.values[headerRow], map);
  return agreed / compared;
}

/** A worksheet must reproduce almost all of the CSV to be the same tab. */
export const MATCH_FLOOR = 0.95;
/** …and beat every other worksheet by this much, or the answer is ambiguous. */
export const MATCH_MARGIN = 0.2;

/**
 * Which worksheet is the tab the gid named?
 *
 * NEVER BY POSITION. `SheetNames[0]` is not the requested tab, the workbook
 * carries no gid, and a sheet's index is not its identity. It is decided by
 * content, and it is decided decisively or not at all.
 */
export function matchWorksheet(csv: string[][], sheets: WorkbookSheet[]): WorksheetMatch {
  const scored = (sheets ?? [])
    .map((sheet) => ({ sheet, score: worksheetScore(csv, sheet) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  const bestScore = best?.score ?? 0;
  const nextScore = runnerUp?.score ?? 0;

  if (!best || bestScore < MATCH_FLOOR) {
    return { ok: false, reason: 'no_match', best: bestScore, runnerUp: nextScore };
  }
  if (runnerUp && bestScore - nextScore < MATCH_MARGIN) {
    return { ok: false, reason: 'ambiguous', best: bestScore, runnerUp: nextScore };
  }
  /*
   * The header travels with the match. Everything downstream needs to know
   * where the headings are, and re-deriving that separately is how two callers
   * come to disagree about which row names the columns.
   */
  const headerRow = locateHeaderRow(csv, best.sheet);
  if (headerRow < 0) {
    return { ok: false, reason: 'no_match', best: bestScore, runnerUp: nextScore };
  }
  return { ok: true, sheet: best.sheet, score: bestScore, headerRow };
}

/** The suffix a resolved link column carries. */
export const LINK_COLUMN_SUFFIX = ' URL';

export interface HyperlinkMerge {
  matrix: string[][];
  /** Headings whose links were resolved, in the order they were added. */
  columnsAdded: string[];
  linksResolved: number;
}

/**
 * Put each row's own links beside it, and never beside another's.
 *
 * A link is read from the worksheet cell at THIS row and THIS column and
 * written into a new column on THIS row. There is no lookup by lot, by
 * address, by design or by anything else two rows could share — which is what
 * makes two products on one lot safe by construction rather than by a rule
 * that has to remember them.
 *
 * A column is added only where at least one row actually carries a link, so a
 * sheet of plain labels gains nothing and reads exactly as it did.
 */
export function mergeHyperlinkColumns(
  csv: string[][],
  sheet: WorkbookSheet,
): HyperlinkMerge {
  const header = csv[0] ?? [];
  const body = csv.slice(1);

  /*
   * WHICH WORKSHEET ROW EACH CSV ROW IS, decided by content. `r + 1` was never
   * that row: the two representations disagree about row numbers wherever the
   * sheet carries a banner or a blank, and every property below such a row
   * would otherwise be handed the NEXT one's document.
   */
  const aligned = alignWorksheetRows(csv, sheet);
  const map = mapColumnsByHeader(csv, sheet);
  const linkAt = (csvRow: number, column: number): string => {
    const worksheetRow = aligned[csvRow] ?? -1;
    if (worksheetRow < 0) return '';
    const sheetColumn = map.sheetColumnFor[column];
    if (sheetColumn === null || sheetColumn === undefined) return '';
    return sheet.links[worksheetRow]?.[sheetColumn] ?? '';
  };

  const linkColumns: number[] = [];
  for (let c = 0; c < header.length; c += 1) {
    const carries = body.some((_row, r) => !!linkAt(r + 1, c));
    if (carries) linkColumns.push(c);
  }
  if (!linkColumns.length) {
    return { matrix: csv.map((row) => [...row]), columnsAdded: [], linksResolved: 0 };
  }

  const added = linkColumns.map((c) => `${header[c] ?? `Column ${c + 1}`}${LINK_COLUMN_SUFFIX}`);
  const out: string[][] = [[...header, ...added]];
  let linksResolved = 0;

  for (let r = 0; r < body.length; r += 1) {
    const row = [...body[r]];
    for (const c of linkColumns) {
      const target = linkAt(r + 1, c);
      if (target) linksResolved += 1;
      row.push(target);
    }
    out.push(row);
  }

  return { matrix: out, columnsAdded: added, linksResolved };
}

/**
 * THE SAME MERGE FOR A WORKBOOK WE ALREADY HOLD.
 *
 * `mergeHyperlinkColumns` above aligns TWO representations — a proven CSV and
 * a workbook fetched separately — because for a Google Sheets URL those are
 * different documents and their row numbers disagree. A workbook a builder
 * UPLOADED has no such problem: the values and the link targets came out of
 * the same sheet in the same pass, so row `i` is row `i` and there is nothing
 * to align.
 *
 * What must not differ is the NAME. Both paths append `"<heading> URL"`, from
 * the one `LINK_COLUMN_SUFFIX`, because the column that comes out of this is
 * what `rowSourceBranches` later scans for an address — and a builder whose
 * brochure column is called `DOWNLOAD` must reach the same place whether they
 * pasted a Sheets link or dragged in the file.
 *
 * Three rules. A column is added only where SOME kept row carries a target,
 * so a sheet with no links is returned untouched. An existing key is never
 * overwritten — a builder who already has a `DOWNLOAD URL` column of their own
 * keeps what they wrote. And a row with no target gets the empty string rather
 * than being skipped, so every row has the same shape and a missing document
 * is a blank cell rather than an absent column.
 */
export function attachRowHyperlinks(input: {
  /** The keyed rows, as `keyRowsByHeader` produced them. */
  rows: Array<Record<string, unknown>>;
  /** Each kept row's index into the sheet, from the same call. */
  rowIndexes: number[];
  /** The header labels, index-aligned with the sheet's columns. */
  headers: string[];
  /** The sheet's own link targets, `links[row][column]`. */
  links: ReadonlyArray<ReadonlyArray<string | null>>;
}): { columnsAdded: string[]; linksResolved: number } {
  const { rows, rowIndexes, headers, links } = input;
  const targetAt = (position: number, column: number): string => {
    const sheetRow = rowIndexes[position] ?? -1;
    if (sheetRow < 0) return '';
    return links[sheetRow]?.[column] ?? '';
  };

  const columnsAdded: string[] = [];
  let linksResolved = 0;

  for (let column = 0; column < headers.length; column += 1) {
    const carries = rows.some((_row, position) => !!targetAt(position, column));
    if (!carries) continue;

    const name = `${headers[column] || `Column ${column + 1}`}${LINK_COLUMN_SUFFIX}`;
    // The builder's own column of that name wins. See rule three.
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, name))) continue;
    columnsAdded.push(name);

    rows.forEach((row, position) => {
      const target = targetAt(position, column);
      if (target) linksResolved += 1;
      row[name] = target;
    });
  }

  return { columnsAdded, linksResolved };
}

/**
 * THE TARGET OF A CELL, HOWEVER THE BUILDER WROTE IT.
 *
 * A spreadsheet stores "this text points somewhere" two different ways, and
 * the reader only ever knew one of them.
 *
 *   the relationship   the cell carries a link record; SheetJS surfaces it as
 *                      `cell.l.Target`. This is what Sheets and Excel write
 *                      when somebody uses Insert > Link.
 *
 *   the formula        the cell IS `=HYPERLINK("…","Brochure")`. There is no
 *                      link record at all — the target is an argument inside
 *                      `cell.f`, and `cell.l` is null.
 *
 * Proved by round-trip through the reader this runtime already loads: a
 * relationship survives as `l.Target`, a HYPERLINK formula survives only as
 * `f`, and plain text carries neither. Reading just the first silently drops
 * every brochure a builder typed as a formula — which is an ordinary way to
 * write one, and indistinguishable on screen from the other.
 *
 * ONLY http(s) IS A SOURCE. A formula can name anything — a local file, an
 * anchor within the workbook, a mail link — and none of those is a document
 * this pipeline can open. Anything else answers null rather than being passed
 * downstream to fail later with a worse message.
 */
export function hyperlinkTargetOf(cell: {
  link?: string | null; formula?: string | null;
}): string | null {
  const relationship = typeof cell.link === 'string' ? cell.link.trim() : '';
  if (relationship && /^https?:\/\//i.test(relationship)) return relationship;

  const formula = typeof cell.formula === 'string' ? cell.formula : '';
  if (!formula) return null;

  /*
   * The first argument of the outermost HYPERLINK. Excel escapes a quote
   * inside a string by doubling it, so the capture runs to the first quote
   * that is not doubled and the pairs are collapsed afterwards.
   */
  const match = formula.match(/\bHYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i);
  if (!match) return null;
  const target = match[1].replace(/""/g, '"').trim();
  return /^https?:\/\//i.test(target) ? target : null;
}

/** What the import may honestly say about the links it did or did not get. */
export type HyperlinkAvailability =
  /** The workbook was read and this tab's links are on the rows. */
  | 'resolved'
  /**
   * The document refused to hand over the workbook at all. Every documented
   * public representation of a Sheet was probed and only `/export` carries
   * link targets, so a document that will not export cannot yield them by any
   * other route — and NOTHING is known about its links, not even whether it
   * has any.
   */
  | 'unavailable_source_export'
  /**
   * We GOT the file and could not make sense of it. Our problem rather than
   * the document's, kept separate because it points at a different remedy.
   */
  | 'unavailable_workbook_unreadable'
  /** The workbook was read and no worksheet is decisively this tab. */
  | 'unavailable_no_worksheet_match'
  /** Two worksheets are equally like this tab, so neither may lend its links. */
  | 'unavailable_ambiguous_worksheet'
  /** The workbook was read, the tab matched, and it carries no links. */
  | 'none_present';

/**
 * Whether stage 1 may be described as having seen this row's builder sources.
 *
 * A LABEL WHOSE TARGET WAS NEVER RESOLVED IS NOT AN ABSENT SOURCE. It is a
 * source nobody looked at, and calling the two the same is how a property gets
 * recorded as having no builder imagery when its package was one unread
 * hyperlink away. Only `resolved` and `none_present` are readings of the
 * SPREADSHEET; the rest are readings of our access to it.
 */
export function sourcesFullyEnumerable(availability: HyperlinkAvailability): boolean {
  return availability === 'resolved' || availability === 'none_present';
}
