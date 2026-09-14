/**
 * Builder stock lists — decoding Notion's public page state.
 *
 * WHY THIS EXISTS. A published Notion page does not serve its content as
 * markup. The first HTML response is a 19 KB client-rendering shell: a
 * `<title>Notion</title>`, an empty `window.__notion_boot_data`, and script
 * tags. Every row of a stock list lives in a `recordMap` that the browser
 * fetches afterwards from Notion's own public, unauthenticated endpoints. So
 * `htmlSource.pure.ts` finding no table on a public Notion page is the
 * ORDINARY case and says nothing whatever about who may read the page.
 *
 * This module is the decoder for that `recordMap`: schema keys to column
 * names, rich-text arrays to plain strings, a collection's rows to a matrix.
 * The matrix then goes through `keyRowsByHeader` and `normaliseStockRow` like
 * every other source — there is no Notion-specific property schema anywhere
 * after this file.
 *
 * NO JAVASCRIPT IS EXECUTED. This reads JSON that Notion's public API
 * returned. `notionPublicContent.ts` is the half that does the (SSRF-guarded,
 * unauthenticated) retrieving; this half is pure so it can be tested against
 * captured production payloads.
 *
 * Pure: no imports, no IO, no clock.
 */

/** A `recordMap` as the public endpoints return it: table → id → wrapper. */
export type NotionRecordMap = Record<string, unknown>;

/**
 * The shape of the page we were pointed at, as far as the record map states
 * it. Every field is nullable because a record map is whatever the endpoint
 * chose to send, and guessing at a missing id is how the wrong collection gets
 * queried.
 */
export interface NotionPageShape {
  pageBlockId: string | null;
  blockType: string | null;
  collectionId: string | null;
  collectionViewId: string | null;
  spaceId: string | null;
  title: string | null;
  /**
   * The link named a view with `?v=` and this page does not have it.
   *
   * SAID RATHER THAN SUBSTITUTED. This used to fall through to `viewIds[0]`,
   * so a builder who linked one view could be served a different one — a
   * different set of properties — with nothing anywhere reporting it. Which
   * rows belong to a stock list is the one question an importer may never
   * guess at, so the caller fails the source read on this.
   */
  requestedViewMissing: boolean;
  /**
   * The view's OWN query — its filter, its sort, its grouping.
   *
   * A Notion view is a query over a collection, not a slice of it, and the
   * rows a reader sees are the rows that query returns. Querying the
   * collection with an empty query therefore reads the whole database
   * whenever the view filters, which is a different stock list from the one
   * the builder linked. Passed through verbatim: Notion already supplies the
   * canonical structure and re-deriving it would be a second, disagreeing
   * implementation of somebody else's filter language.
   *
   * IT IS ASSEMBLED FROM TWO PLACES, BECAUSE NOTION STORES IT IN TWO PLACES.
   * `query2` holds the filter set in the view's Filter menu;
   * `format.property_filters` holds the filter CHIPS above the table. Both
   * narrow what a reader sees and Notion applies them together, so reading
   * only `query2` reads a view the builder is not looking at — see
   * `viewMembershipQuery`.
   */
  viewQuery: Record<string, unknown> | null;
}

/**
 * Unwrap a record map entry.
 *
 * The endpoints disagree about depth — `loadCachedPageChunkV2` returns
 * `{ spaceId, value: { value: <record>, role } }` while older responses return
 * `{ role, value: <record> }` — so this descends through `value` until it
 * finds the object that carries an `id`, rather than assuming either shape.
 */
export function unwrapNotionRecord(entry: unknown): Record<string, unknown> | null {
  let node: unknown = entry;
  for (let depth = 0; depth < 4; depth++) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const record = node as Record<string, unknown>;
    if (typeof record.id === 'string') return record;
    if ('value' in record) { node = record.value; continue; }
    return null;
  }
  return null;
}

/** The `spaceId` a record map hangs on its entries, when it carries one. */
export function notionEntrySpaceId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const wrapper = entry as Record<string, unknown>;
  return typeof wrapper.spaceId === 'string' ? wrapper.spaceId : null;
}

function tableOf(recordMap: NotionRecordMap, name: string): Record<string, unknown> {
  const table = recordMap[name];
  return table && typeof table === 'object' && !Array.isArray(table)
    ? table as Record<string, unknown>
    : {};
}

/**
 * A Notion rich-text value as plain text.
 *
 * The wire format is an array of segments, each `[text]` or
 * `[text, decorations]`. A mention is the sentinel `‣` carrying its real
 * value in the decorations — a date is recoverable, a user or page reference
 * is not, and an unrecoverable mention contributes nothing rather than a
 * stray bullet.
 */
export function notionTextValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';

  const parts: string[] = [];
  for (const segment of value) {
    if (typeof segment === 'string') { parts.push(segment); continue; }
    if (!Array.isArray(segment)) continue;
    const text = typeof segment[0] === 'string' ? segment[0] : '';
    // U+2023 is the sentinel Notion puts where a mention was. Escaped
    // rather than literal: the character is invisible in most editors.
    if (text === '\u2023') {
      parts.push(mentionText(Array.isArray(segment[1]) ? segment[1] : []));
      continue;
    }
    parts.push(text);
  }
  return parts.join('').replace(/\u00a0/g, ' ').trim();
}

function mentionText(decorations: unknown[]): string {
  for (const decoration of decorations) {
    if (!Array.isArray(decoration)) continue;
    if (decoration[0] !== 'd') continue;
    const date = decoration[1];
    if (!date || typeof date !== 'object') continue;
    const value = date as Record<string, unknown>;
    const start = typeof value.start_date === 'string' ? value.start_date : '';
    const end = typeof value.end_date === 'string' ? value.end_date : '';
    if (!start) continue;
    return end ? `${start} to ${end}` : start;
  }
  return '';
}

/** `30ccabf920108099b502d7ac23995def` → the dashed form Notion's API wants. */
export function toNotionUuid(raw: unknown): string | null {
  const compact = String(raw ?? '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return [
    compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16),
    compact.slice(16, 20), compact.slice(20),
  ].join('-');
}

function idFromSlug(slug: unknown): string | null {
  const compact = String(slug ?? '').replace(/-/g, '');
  const match = /([0-9a-fA-F]{32})$/.exec(compact);
  return match ? toNotionUuid(match[1]) : null;
}

/**
 * The page id to ask Notion about.
 *
 * The URL is preferred because it is what the builder actually linked to; the
 * markup's own `pageId` is the fallback for a site root, which carries no id
 * in its path. `?v=` is deliberately NOT read — that is the collection VIEW,
 * and querying it as a page returns nothing.
 */
export function extractNotionPageId(rawUrl: string, html?: string | null): string | null {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const fromPath = segments.length ? idFromSlug(segments[segments.length - 1]) : null;
    if (fromPath) return fromPath;
    const fromQuery = idFromSlug(url.searchParams.get('p'));
    if (fromQuery) return fromQuery;
  } catch {
    /* not a URL we can read; the markup may still name the page */
  }

  const embedded = /"pageId"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(String(html ?? ''));
  return embedded ? toNotionUuid(embedded[1]) : null;
}

/** The collection view named by `?v=` on the link, when there is one. */
export function preferredNotionViewId(rawUrl: string): string | null {
  try {
    return idFromSlug(new URL(rawUrl).searchParams.get('v'));
  } catch {
    return null;
  }
}

/**
 * What the record map says the page is.
 *
 * `collection_view_page` is a full-page database (the shape a stock list
 * almost always takes); `collection_view` is one embedded in a page. Either
 * way the collection and view ids are what `queryCollection` needs, and they
 * live in two places depending on the age of the block, so both are read.
 */
export function describeNotionPage(
  recordMap: NotionRecordMap,
  pageId?: string | null,
  preferredViewId?: string | null,
): NotionPageShape {
  const blocks = tableOf(recordMap, 'block');

  let entry = pageId ? blocks[pageId] : undefined;
  let blockId = pageId ?? null;
  if (!unwrapNotionRecord(entry)) {
    entry = undefined;
    blockId = null;
    for (const [id, candidate] of Object.entries(blocks)) {
      const record = unwrapNotionRecord(candidate);
      const type = record?.type;
      if (type === 'collection_view_page' || type === 'collection_view' || type === 'page') {
        entry = candidate;
        blockId = id;
        if (type !== 'page') break;
      }
    }
  }

  const block = unwrapNotionRecord(entry);
  if (!block) return blank();

  const format = (block.format && typeof block.format === 'object')
    ? block.format as Record<string, unknown> : {};
  const pointer = (format.collection_pointer && typeof format.collection_pointer === 'object')
    ? format.collection_pointer as Record<string, unknown> : {};

  const collectionId = typeof block.collection_id === 'string'
    ? block.collection_id
    : (typeof pointer.id === 'string' ? pointer.id : null);

  const viewIds = Array.isArray(block.view_ids)
    ? block.view_ids.filter((id): id is string => typeof id === 'string')
    : [];
  /*
   * AN EXPLICIT VIEW IS HONOURED OR THE READ FAILS — never quietly swapped.
   *
   * `?v=` on the link is the builder saying WHICH view is the stock list. A
   * fallback to `viewIds[0]` answers a question nobody asked and imports a
   * different set of properties; with no `?v=` there is no such instruction,
   * so the page's own first view is the documented default.
   */
  const requestedViewMissing = !!preferredViewId && !viewIds.includes(preferredViewId);
  const collectionViewId = preferredViewId
    ? (viewIds.includes(preferredViewId) ? preferredViewId : null)
    : (viewIds[0] ?? null);

  const viewRecord = collectionViewId
    ? unwrapNotionRecord(tableOf(recordMap, 'collection_view')[collectionViewId])
    : null;
  const viewQuery = viewMembershipQuery(viewRecord);

  const spaceId = typeof block.space_id === 'string' ? block.space_id
    : notionEntrySpaceId(entry)
    ?? (typeof pointer.spaceId === 'string' ? pointer.spaceId : null)
    ?? (typeof recordMap.spaceId === 'string' ? recordMap.spaceId : null);

  const properties = (block.properties && typeof block.properties === 'object')
    ? block.properties as Record<string, unknown> : {};
  const blockTitle = notionTextValue(properties.title);
  const collection = collectionId ? unwrapNotionRecord(tableOf(recordMap, 'collection')[collectionId]) : null;
  const collectionTitle = collection ? notionTextValue(collection.name) : '';

  return {
    pageBlockId: blockId,
    blockType: typeof block.type === 'string' ? block.type : null,
    collectionId,
    collectionViewId,
    spaceId,
    title: (collectionTitle || blockTitle || null),
    requestedViewMissing,
    viewQuery,
  };
}

/**
 * EVERYTHING THAT DECIDES WHICH ROWS A VIEW SHOWS, IN ONE QUERY.
 *
 * A Notion table view narrows its collection from two independent stores and
 * the reader sees the intersection:
 *
 *   collection_view.query2                  the view's Filter menu
 *   collection_view.format.property_filters the filter CHIPS above the table
 *
 * Reading only the first is reading a different view. Measured against a live
 * builder page: `query2` was `{ sort: [...] }` with no filter at all, while
 * `property_filters` carried two chips — a status and a state — and the
 * collection holds 23 rows where the page shows 18. Every one of the five the
 * page withholds was excluded by a chip. Nothing about that is particular to
 * that page: a chip is one click in Notion's toolbar and any builder may add
 * one at any time, on any column, at which point their stock list silently
 * stops being the list we import.
 *
 * THE CLAUSES TRAVEL VERBATIM. Each entry's inner `filter` is already exactly
 * one filter clause in Notion's own language — `{ property, filter }` — so it
 * is lifted, not translated. Re-deriving it was tried against the live
 * endpoint and is how you get a plausible-looking query that returns nothing:
 * a chip carrying several accepted values is an `enum_is` whose `value` is an
 * ARRAY, which no hand-written equivalent guessed correctly.
 *
 * AND, BECAUSE THAT IS WHAT THE PAGE DOES. Chips narrow the view's own filter
 * rather than widening it. A view with no chips is passed through completely
 * unchanged, so this can only ever remove rows the reader was not being shown.
 */
export function viewMembershipQuery(
  viewRecord: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!viewRecord) return null;

  const raw = viewRecord.query2 ?? viewRecord.query ?? null;
  const query = (raw && typeof raw === 'object')
    ? { ...(raw as Record<string, unknown>) }
    : null;

  const format = (viewRecord.format && typeof viewRecord.format === 'object')
    ? viewRecord.format as Record<string, unknown> : {};
  const chips = Array.isArray(format.property_filters) ? format.property_filters : [];

  const clauses: Record<string, unknown>[] = [];
  for (const chip of chips) {
    if (!chip || typeof chip !== 'object') continue;
    const clause = (chip as Record<string, unknown>).filter;
    // A clause names the column it filters. Anything that does not is a shape
    // this function does not recognise, and inventing a reading of it would
    // be exactly the guess the whole module refuses to make.
    if (!clause || typeof clause !== 'object') continue;
    const named = clause as Record<string, unknown>;
    if (typeof named.property !== 'string' || !named.filter) continue;
    clauses.push(named);
  }

  if (clauses.length === 0) return query;

  const existing = query?.filter;
  const filters = (existing && typeof existing === 'object')
    ? [existing as Record<string, unknown>, ...clauses]
    : clauses;

  return { ...(query ?? {}), filter: { operator: 'and', filters } };
}

function blank(): NotionPageShape {
  return {
    pageBlockId: null, blockType: null, collectionId: null,
    collectionViewId: null, spaceId: null, title: null,
    requestedViewMissing: false, viewQuery: null,
  };
}

/** One column of a Notion database: its schema key and what it is called. */
export interface NotionColumn {
  key: string;
  name: string;
}

/**
 * The columns a reader of this page sees, in the order they see them.
 *
 * The VIEW decides, not the schema: a table view carries `table_properties`
 * with a `visible` flag, and a column the page hides is not part of the stock
 * list. Without a view — or without that format — the schema's own order is
 * used with the title column first, because the title is the row's name.
 */
export function notionCollectionColumns(
  recordMap: NotionRecordMap,
  collectionId: string,
  viewId?: string | null,
): NotionColumn[] {
  const collection = unwrapNotionRecord(tableOf(recordMap, 'collection')[collectionId]);
  const schema = (collection?.schema && typeof collection.schema === 'object')
    ? collection.schema as Record<string, unknown> : {};

  const nameFor = (key: string): string | null => {
    const definition = schema[key];
    if (!definition || typeof definition !== 'object') return null;
    const label = (definition as Record<string, unknown>).name;
    const text = typeof label === 'string' ? label.trim() : '';
    return text || key;
  };

  const columns: NotionColumn[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (seen.has(key)) return;
    const name = nameFor(key);
    if (name === null) return;
    seen.add(key);
    columns.push({ key, name });
  };

  const view = viewId ? unwrapNotionRecord(tableOf(recordMap, 'collection_view')[viewId]) : null;
  const format = (view?.format && typeof view.format === 'object')
    ? view.format as Record<string, unknown> : {};
  const tableProperties = Array.isArray(format.table_properties) ? format.table_properties : [];

  for (const entry of tableProperties) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (item.visible === false) continue;
    if (typeof item.property === 'string') push(item.property);
  }

  if (!columns.length) {
    if (schema.title) push('title');
    for (const key of Object.keys(schema)) push(key);
  }
  return columns;
}

/**
 * A collection's rows as a matrix, header row first, WITH the block id each
 * data row came from.
 *
 * `blockIds` is the order the view returned — the same order and the same
 * filtering a reader of the page sees — so a filtered view does not import
 * rows the page hides.
 *
 * `rowIds[i]` belongs to `matrix[i + 1]`. That pairing is the whole reason
 * this function exists next to `notionCollectionMatrix`: a Notion row OWNS its
 * cover and its attachments, and an import that keeps only the text has thrown
 * away the one thing that says which property a render depicts.
 */
export function notionCollectionTable(
  recordMap: NotionRecordMap,
  input: { collectionId: string; viewId?: string | null; blockIds?: string[] | null },
): { matrix: string[][]; rowIds: string[] } {
  const columns = notionCollectionColumns(recordMap, input.collectionId, input.viewId);
  if (!columns.length) return { matrix: [], rowIds: [] };

  const blocks = tableOf(recordMap, 'block');
  const ids = input.blockIds?.length
    ? input.blockIds
    : Object.keys(blocks).filter((id) => {
      const block = unwrapNotionRecord(blocks[id]);
      return block?.parent_id === input.collectionId && block?.type === 'page';
    });

  const matrix: string[][] = [columns.map((column) => column.name)];
  const rowIds: string[] = [];
  for (const id of ids) {
    const block = unwrapNotionRecord(blocks[id]);
    if (!block || block.alive === false) continue;
    const properties = (block.properties && typeof block.properties === 'object')
      ? block.properties as Record<string, unknown> : {};
    const cells = columns.map((column) => notionTextValue(properties[column.key]));
    if (cells.some((cell) => cell !== '')) {
      matrix.push(cells);
      rowIds.push(id);
    }
  }
  return matrix.length > 1 ? { matrix, rowIds } : { matrix: [], rowIds: [] };
}

/** The matrix alone, for callers that do not need the row identity. */
export function notionCollectionMatrix(
  recordMap: NotionRecordMap,
  input: { collectionId: string; viewId?: string | null; blockIds?: string[] | null },
): string[][] {
  return notionCollectionTable(recordMap, input).matrix;
}

/**
 * Append the reserved anchor column, so each row carries its own block id
 * through the CSV snapshot and into the normaliser.
 *
 * The header cell is the literal `SOURCE_ANCHOR_HEADER`; the normaliser
 * recognises it and lifts it off the row rather than treating it as an
 * unmapped column, so it is never stored as a column we failed to understand
 * and never scores as a heading.
 */
export function withNotionRowAnchors(
  matrix: string[][],
  rowIds: string[],
  header: string,
): string[][] {
  if (matrix.length < 2) return matrix;
  return matrix.map((cells, index) => (
    index === 0 ? [...cells, header] : [...cells, `notion:${rowIds[index - 1] ?? ''}`]
  ));
}

/**
 * Every SIMPLE table on the page — the `table` / `table_row` blocks a builder
 * gets from Notion's "Table" block rather than from a database.
 *
 * Its cells are keyed by column id and ordered by `table_block_column_order`,
 * which is the only thing that says which column is which.
 */
export function notionSimpleTableMatrices(recordMap: NotionRecordMap): string[][][] {
  const blocks = tableOf(recordMap, 'block');
  const matrices: string[][][] = [];

  for (const entry of Object.values(blocks)) {
    const block = unwrapNotionRecord(entry);
    if (!block || block.type !== 'table') continue;

    const format = (block.format && typeof block.format === 'object')
      ? block.format as Record<string, unknown> : {};
    const order = Array.isArray(format.table_block_column_order)
      ? format.table_block_column_order.filter((id): id is string => typeof id === 'string')
      : [];
    const content = Array.isArray(block.content)
      ? block.content.filter((id): id is string => typeof id === 'string')
      : [];

    const matrix: string[][] = [];
    for (const rowId of content) {
      const row = unwrapNotionRecord(blocks[rowId]);
      if (!row || row.type !== 'table_row') continue;
      const properties = (row.properties && typeof row.properties === 'object')
        ? row.properties as Record<string, unknown> : {};
      const keys = order.length ? order : Object.keys(properties).sort();
      const cells = keys.map((key) => notionTextValue(properties[key]));
      if (cells.some((cell) => cell !== '')) matrix.push(cells);
    }
    if (matrix.length > 1) matrices.push(matrix);
  }
  return matrices;
}

// ---------------------------------------------------------------------------
// The builder's own imagery
// ---------------------------------------------------------------------------

/**
 * One asset a Notion row owns, exactly as the record map states it.
 *
 * `source` is Notion's own reference — `attachment:<id>:<name>` for a file
 * uploaded to Notion, an absolute URL for one hosted elsewhere. `blockId` is
 * the block it hangs on, and it is NOT decoration: Notion's public image
 * endpoint refuses to sign an attachment without being told which block claims
 * it, which is also what makes this deterministic rather than a guess.
 */
export interface NotionAssetRef {
  source: string;
  blockId: string;
  origin: 'page_cover' | 'file_property' | 'image_block' | 'link_property';
  /** The column the asset came out of, when it came out of one. */
  label: string | null;
}

/** Notion's own decorative gallery. Chosen from a menu, never of a property. */
const NOTION_STOCK_COVER_PREFIX = '/images/page-cover/';

/** Hosts whose URLs are signed and expire, so the proxy must re-sign them. */
const NOTION_FILE_HOST_PATTERN =
  /(^|\.)(secure\.notion-static\.com|file\.notion\.so|notion-static\.com|img\.notionusercontent\.com)$/i;

function isNotionHostedFileUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (NOTION_FILE_HOST_PATTERN.test(url.hostname)) return true;
    // `prod-files-secure.s3.us-west-2.amazonaws.com/<space>/<file>/<name>` and
    // the older `s3-us-west-2.amazonaws.com/secure.notion-static.com/…`.
    if (/amazonaws\.com$/i.test(url.hostname)) {
      return /prod-files-secure/i.test(url.hostname)
        || /secure\.notion-static\.com/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp|gif)$/i;

/** True for a reference whose NAME says it is an image we can display. */
function referenceLooksLikeImage(source: string): boolean {
  const name = source.startsWith('attachment:')
    ? source.split(':').slice(2).join(':')
    : source.split(/[?#]/)[0];
  return IMAGE_FILE_PATTERN.test(name);
}

/** Every `['a', url]` link carried by a Notion property value. */
function propertyLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const segment of value) {
    if (!Array.isArray(segment) || !Array.isArray(segment[1])) continue;
    for (const decoration of segment[1]) {
      if (!Array.isArray(decoration) || decoration[0] !== 'a') continue;
      const link = typeof decoration[1] === 'string' ? decoration[1] : '';
      if (link) out.push(link);
    }
  }
  return out;
}

/**
 * The imagery ONE database row owns.
 *
 * Four places, in the order a reader of the page would rank them:
 *
 *   1. the row page's COVER — which is where a stock list actually keeps the
 *      render, and where 25 of the 70 live properties had theirs while the
 *      import was reading the text beside it;
 *   2. a files/media property on the row — the wire format is a rich-text
 *      array whose visible text is the FILENAME and whose URL is hidden in the
 *      link decoration, which is exactly why flattening to text lost it;
 *   3. an image block inside the row's own page;
 *   4. a URL property that points straight at an image file.
 *
 * Every ref carries the block that owns it. Nothing here matches by count, by
 * order, or by name similarity: the record map already states the relationship
 * and a weaker one must never be substituted for it.
 */
export function notionRowAssetRefs(
  recordMap: NotionRecordMap,
  rowId: string,
): NotionAssetRef[] {
  const blocks = tableOf(recordMap, 'block');
  const row = unwrapNotionRecord(blocks[rowId]);
  if (!row) return [];

  const refs: NotionAssetRef[] = [];
  const seen = new Set<string>();
  const push = (ref: NotionAssetRef) => {
    const key = `${ref.source}|${ref.blockId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  const format = (row.format && typeof row.format === 'object')
    ? row.format as Record<string, unknown> : {};
  const cover = typeof format.page_cover === 'string' ? format.page_cover.trim() : '';
  // A Notion gallery texture is a decoration the builder picked from a menu,
  // not a photograph of this property, so it is not source-supplied imagery.
  if (cover && !cover.startsWith(NOTION_STOCK_COVER_PREFIX)) {
    push({ source: cover, blockId: rowId, origin: 'page_cover', label: 'Page cover' });
  }

  const collectionId = typeof row.parent_id === 'string' ? row.parent_id : null;
  const collection = collectionId
    ? unwrapNotionRecord(tableOf(recordMap, 'collection')[collectionId])
    : null;
  const schema = (collection?.schema && typeof collection.schema === 'object')
    ? collection.schema as Record<string, unknown> : {};

  const properties = (row.properties && typeof row.properties === 'object')
    ? row.properties as Record<string, unknown> : {};

  for (const [key, value] of Object.entries(properties)) {
    const definition = schema[key];
    const type = (definition && typeof definition === 'object')
      ? String((definition as Record<string, unknown>).type ?? '') : '';
    const label = (definition && typeof definition === 'object')
      ? String((definition as Record<string, unknown>).name ?? key) : key;

    for (const link of propertyLinks(value)) {
      const isFileValue = type === 'file' || link.startsWith('attachment:')
        || isNotionHostedFileUrl(link);
      // A file property may hold a contract as easily as a render, and a URL
      // property usually points at a folder. Only something NAMED as an image
      // is treated as one; the bytes are checked again before anything is
      // stored.
      if (!referenceLooksLikeImage(link)) continue;
      push({
        source: link,
        blockId: rowId,
        origin: isFileValue ? 'file_property' : 'link_property',
        label,
      });
    }
  }

  // Blocks inside the row's own page. Present only when the page's chunk has
  // been loaded — an empty `content` means the row has no page body at all,
  // which is the ordinary case for a stock list and costs no request.
  const content = Array.isArray(row.content)
    ? row.content.filter((id): id is string => typeof id === 'string') : [];
  for (const childId of content) {
    const child = unwrapNotionRecord(blocks[childId]);
    if (!child) continue;
    const type = typeof child.type === 'string' ? child.type : '';
    if (type !== 'image' && type !== 'embed' && type !== 'bookmark') continue;

    const childProperties = (child.properties && typeof child.properties === 'object')
      ? child.properties as Record<string, unknown> : {};
    const childFormat = (child.format && typeof child.format === 'object')
      ? child.format as Record<string, unknown> : {};
    const source = notionTextValue(childProperties.source)
      || (typeof childFormat.display_source === 'string' ? childFormat.display_source : '');
    if (!source) continue;
    // An embed or a bookmark is a link to a page far more often than to a
    // file; it is taken only when it names an image outright.
    if (type !== 'image' && !referenceLooksLikeImage(source)) continue;
    push({ source, blockId: childId, origin: 'image_block', label: null });
  }

  return refs;
}

/**
 * The URL to actually fetch, for a reference the record map stated.
 *
 * NOTHING IS INVENTED HERE. `attachment:<id>:<name>` and every Notion-hosted
 * file go back through the SAME public image endpoint on the SAME host the
 * page was published on — the one a logged-out browser calls to render that
 * page — because those references are not URLs and the signed URLs they resolve
 * to expire within the hour. An asset hosted anywhere else is already a URL
 * and is used as it stands.
 */
export function notionAssetUrl(pageOrigin: string, ref: NotionAssetRef): string | null {
  let origin: string;
  try {
    origin = new URL(pageOrigin).origin;
  } catch {
    return null;
  }

  const source = ref.source.trim();
  if (!source) return null;

  if (source.startsWith('attachment:') || isNotionHostedFileUrl(source)) {
    const encoded = encodeURIComponent(source);
    return `${origin}/image/${encoded}?table=block&id=${ref.blockId}&cache=v2`;
  }

  if (/^https?:\/\//i.test(source)) return source;
  return null;
}

/** Block types whose `title` property is prose a reader sees. */
const TEXT_BLOCK_TYPES = new Set([
  'text', 'header', 'sub_header', 'sub_sub_header', 'bulleted_list',
  'numbered_list', 'to_do', 'toggle', 'quote', 'callout', 'code',
]);

/**
 * The page's readable prose, for the model-assisted path.
 *
 * Used only when neither a database nor a simple table produced rows — the
 * same fallback an ordinary web page gets, and under the same "never invent a
 * value" schema.
 */
export function notionReadableText(recordMap: NotionRecordMap, maxChars = 120_000): string {
  const blocks = tableOf(recordMap, 'block');
  const lines: string[] = [];

  for (const entry of Object.values(blocks)) {
    const block = unwrapNotionRecord(entry);
    if (!block) continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type !== 'page' && !TEXT_BLOCK_TYPES.has(type)) continue;
    const properties = (block.properties && typeof block.properties === 'object')
      ? block.properties as Record<string, unknown> : {};
    const text = notionTextValue(properties.title);
    if (text) lines.push(text);
  }

  return lines.join('\n').slice(0, maxChars);
}

/**
 * A matrix as RFC-4180 CSV.
 *
 * This is what gets snapshotted and what gets imported, so the two cannot
 * disagree about what was read: `parseDelimited` reads back exactly what this
 * writes, multi-line cells included.
 */
export function matrixToCsv(matrix: string[][]): string {
  return matrix
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

function csvCell(value: string): string {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Combine two record maps, table by table.
 *
 * The two public endpoints each answer half of a database: the chunk carries
 * the schema and the view, the collection query carries the rows. Merging them
 * means the decoder above sees one map and never has to know which half held
 * what. Later entries win; neither input is mutated.
 */
export function mergeNotionRecordMaps(
  first: NotionRecordMap,
  second: NotionRecordMap,
): NotionRecordMap {
  const out: NotionRecordMap = { ...first };
  for (const [table, records] of Object.entries(second)) {
    const existing = out[table];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)
      && records && typeof records === 'object' && !Array.isArray(records)) {
      out[table] = {
        ...existing as Record<string, unknown>,
        ...records as Record<string, unknown>,
      };
    } else {
      out[table] = records;
    }
  }
  return out;
}
