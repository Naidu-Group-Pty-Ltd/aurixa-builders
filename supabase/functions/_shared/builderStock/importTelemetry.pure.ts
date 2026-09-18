/**
 * BUILDER STOCK — WHAT AN IMPORT SAYS ABOUT ITSELF WHILE IT RUNS.
 *
 * This module exists because the last production incident took four rounds of
 * forensics to explain, and every round asked the same four questions of logs
 * that had never been written to answer them: which TAB was read, what became
 * of each ITEM, where a PDF was ELECTED and why the upload did not PUBLISH.
 * The facts were all knowable at the time and none was recorded, so the answer
 * had to be reconstructed from database state days later.
 *
 * FOUR RECORDS, ONE SHAPE. An upload, an item, a PDF election and a
 * publication attempt each compose a flat object of snake_case keys beside a
 * sentence, which is the convention the rest of Builder Stock already logs in.
 * Flat because a log aggregator indexes scalars and flattens nothing for you;
 * one module because four ad-hoc object literals at four call sites is how the
 * same field comes to be called `uploadId`, `upload`, `p_upload_id` and
 * `id` in one incident.
 *
 * THEY ARE EMITTED ON SUCCESS AS WELL AS FAILURE, which is the whole point.
 * The 47-property import that produced nothing visible did not fail anywhere;
 * every stage reported normal operation. A log that only speaks when something
 * throws cannot describe that, and it is the shape this repository has already
 * been bitten by.
 *
 * WHAT MAY NEVER TRAVEL. A bearer token, a signed URL's query, a credential of
 * any kind, and a customer's own details. `safeDetail` and `safeUrl` are the
 * only ways a caller-supplied string reaches a record, they are total (every
 * input produces a string), and `builderStockTelemetry.spec.ts` drives real
 * credentials through them. An organisation id and a stock item id are
 * opaque correlation identifiers and carry nothing about a person, which is
 * why they are the identifiers here and a builder's name and email are not.
 *
 * Pure: no IO, no clock, no network. The caller writes the line.
 */

/** Every record carries it, so one filter finds a whole import. */
export const TELEMETRY_PREFIX = '[builderStock]';

export type TelemetryValue = string | number | boolean | null;
export type TelemetryRecord = Record<string, TelemetryValue>;

/**
 * Anything that looks like a credential, gone before the string is stored.
 *
 * Deliberately a DENY-list applied to free text rather than a permit-list of
 * fields: the strings that reach here are provider messages and error bodies,
 * and a provider is free to quote the request it refused. `safeUrl` is the
 * permit-list version for the one case where the shape is known.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // `Authorization: Bearer …`, however it was spelled around.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // A JWT, anywhere — three base64url runs joined by dots.
  [/\beyJ[A-Za-z0-9._~+/=-]{10,}/g, '[redacted]'],
  // A credential named in a query string or a form body.
  [/\b(token|secret|signature|password|api[_-]?key|access[_-]?key)=[^&\s"']+/gi, '$1=[redacted]'],
  // Everything a presigned URL signs with.
  [/\bX-Amz-[A-Za-z-]+=[^&\s"']+/gi, 'X-Amz-[redacted]'],
  // An address with a credential in it, whatever the parameter is called.
  [/\b[Ss]ig(nature)?=[^&\s"']+/g, 'sig=[redacted]'],
];

/**
 * A caller-supplied string, made safe to write down.
 *
 * TOTAL BY CONSTRUCTION: null, undefined, a number, an Error and an object all
 * produce a string, because a telemetry helper that throws takes down the
 * operation it was describing — which is strictly worse than logging nothing.
 */
export function safeDetail(value: unknown, limit = 200): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : String((value as { message?: unknown })?.message ?? value);
  } catch {
    return '[unreadable]';
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, Math.max(0, limit));
}

/**
 * An address as its origin and path, never its query.
 *
 * A signed storage URL IS a bearer credential with a lifetime — the same rule
 * the Passport's portrait answers to — so the query is dropped outright rather
 * than filtered. What a support engineer needs from a source address is which
 * host and which document, and both survive.
 */
export function safeUrl(value: unknown, limit = 160): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, limit);
  } catch {
    // Not an address. It is still a caller-supplied string.
    return safeDetail(value, limit);
  }
}

/** Drop the keys a caller had nothing for, so a line is what is known. */
function compact(record: Record<string, TelemetryValue | undefined>): TelemetryRecord {
  const out: TelemetryRecord = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
  return out;
}

export interface UploadTelemetry {
  uploadId: string;
  organisationId: string;
  /** `file` or `url` — how the bytes arrived, never the builder's filename. */
  sourceKind: string;
  /** The reading strategy that produced the rows, e.g. `delimited_table`. */
  strategy?: string | null;
  byteSize?: number | null;
  /** Which worksheet was read, and on whose authority. The 2026-09-17 defect. */
  sheetGid?: string | null;
  sheetAuthority?: string | null;
  sheetTabCount?: number | null;
  /** Whether the link layer was read, so a later absence can be explained. */
  linkDiscovery?: string | null;
  detected?: number | null;
  imported?: number | null;
  updated?: number | null;
  failed?: number | null;
  withSourceImage?: number | null;
  imageryOutstanding?: boolean | null;
  /** Set only where the import refused, and only with the safe code. */
  outcome?: string | null;
}

/**
 * ONE LINE PER IMPORT, carrying the tab decision.
 *
 * `sheet_gid` and `sheet_authority` are here because their absence is what the
 * incident cost most: production read a hidden worksheet, answered 200, and
 * left nothing anywhere saying which tab it had read. `assumed_first` in this
 * field is the reading that means nobody could tell us.
 */
export function uploadTelemetry(input: UploadTelemetry): TelemetryRecord {
  return compact({
    phase: 'import_upload',
    upload_id: input.uploadId,
    organisation_id: input.organisationId,
    source_kind: input.sourceKind,
    parse_strategy: input.strategy ?? undefined,
    byte_size: input.byteSize ?? undefined,
    sheet_gid: input.sheetGid ?? undefined,
    sheet_authority: input.sheetAuthority ?? undefined,
    sheet_tab_count: input.sheetTabCount ?? undefined,
    link_discovery: input.linkDiscovery ?? undefined,
    properties_detected: input.detected ?? undefined,
    properties_imported: input.imported ?? undefined,
    properties_updated: input.updated ?? undefined,
    properties_failed: input.failed ?? undefined,
    with_source_image: input.withSourceImage ?? undefined,
    imagery_outstanding: input.imageryOutstanding ?? undefined,
    outcome: input.outcome ?? undefined,
  });
}

export interface ItemTelemetry {
  itemId: string;
  uploadId?: string | null;
  lifecycle?: string | null;
  workStage?: string | null;
  /** `found` / `pending` / `processing` / `retryable_failure` / `exhausted` / … */
  evidence?: string | null;
  /**
   * `inspected` or `operational` — the distinction the whole release turns on.
   * Only ever set where the state is an exhaustion; `null` everywhere else,
   * because a pending row has exhausted nothing and saying "inspected" of one
   * is the false sentence this field exists to make impossible.
   */
  exhaustion?: string | null;
  /** The counts behind the state, so a reading can be checked rather than believed. */
  sourcesTotal?: number | null;
  sourcesInspected?: number | null;
  sourcesOperational?: number | null;
  sourcesOpen?: number | null;
  hasPrimaryImage?: boolean | null;
  attempts?: number | null;
  nextStage?: string | null;
  detail?: string | null;
}

/**
 * ONE LINE PER ITEM AS IT SETTLES.
 *
 * `evidence_exhaustion` is the field that separates "we looked and there is no
 * photograph" from "we never managed to look", which is the invariant this
 * release is built on. Recording them under one word is how the first
 * investigation concluded the builder had supplied nothing.
 */
export function itemTelemetry(input: ItemTelemetry): TelemetryRecord {
  return compact({
    phase: 'import_item',
    stock_item_id: input.itemId,
    upload_id: input.uploadId ?? undefined,
    lifecycle_status: input.lifecycle ?? undefined,
    image_work_stage: input.workStage ?? undefined,
    evidence_state: input.evidence ?? undefined,
    evidence_exhaustion: input.exhaustion ?? undefined,
    sources_total: input.sourcesTotal ?? undefined,
    sources_inspected: input.sourcesInspected ?? undefined,
    sources_operational: input.sourcesOperational ?? undefined,
    sources_open: input.sourcesOpen ?? undefined,
    has_primary_image: input.hasPrimaryImage ?? undefined,
    attempts: input.attempts ?? undefined,
    next_stage: input.nextStage ?? undefined,
    detail: input.detail ? safeDetail(input.detail) : undefined,
  });
}

export interface PdfTelemetry {
  /** The document, by size and name — never its signed address. */
  documentName?: string | null;
  documentUrl?: string | null;
  byteSize: number;
  /** `worker` / `no_capacity` / `in_process`, from `electionRoute`. */
  route: string;
  /** `recovered` / `not_identified` / `unreachable`, from the election. */
  outcome: string;
  /**
   * TRUE where the answer is about the DOCUMENT, false where it is about US.
   * The single most important field in this module: it is what a reader needs
   * to know whether a builder has a problem or Aurixa does.
   */
  documentVerdict: boolean;
  role?: string | null;
  durationMs?: number | null;
  httpStatus?: number | null;
  detail?: string | null;
}

/**
 * ONE LINE PER PDF ELECTION, saying where it ran and whose fault a miss is.
 *
 * `document_verdict` is derived by the caller from the outcome rather than
 * re-derived here, because the caller is the boundary that knows whether the
 * worker actually read the bytes — and this module must not become a second
 * opinion on a question `pdfElectionClient` answers by construction.
 */
export function pdfTelemetry(input: PdfTelemetry): TelemetryRecord {
  return compact({
    phase: 'pdf_election',
    document_name: input.documentName ? safeDetail(input.documentName, 120) : undefined,
    document_url: input.documentUrl ? safeUrl(input.documentUrl) : undefined,
    byte_size: input.byteSize,
    election_route: input.route,
    election_outcome: input.outcome,
    document_verdict: input.documentVerdict,
    image_role: input.role ?? undefined,
    duration_ms: input.durationMs ?? undefined,
    http_status: input.httpStatus ?? undefined,
    detail: input.detail ? safeDetail(input.detail) : undefined,
  });
}

export interface PublicationTelemetry {
  uploadId: string;
  available: boolean;
  published: boolean;
  /** The server's own word for what is still owed. */
  reason?: string | null;
  promoted?: number | null;
  archived?: number | null;
  staged?: number | null;
  sourceOutstanding?: number | null;
}

/**
 * ONE LINE PER PUBLICATION ATTEMPT, INCLUDING THE REFUSALS.
 *
 * Refusing is the NORMAL answer — a caller asks after every settled item — so
 * this is the record that would have shown, on the day, that 47 properties
 * were staged and held rather than lost. `published: false` with a reason is
 * the healthy reading and is written as plainly as the success.
 */
export function publicationTelemetry(input: PublicationTelemetry): TelemetryRecord {
  return compact({
    phase: 'publication',
    upload_id: input.uploadId,
    publication_available: input.available,
    published: input.published,
    blocked_reason: input.reason ?? undefined,
    promoted: input.promoted ?? undefined,
    archived: input.archived ?? undefined,
    staged: input.staged ?? undefined,
    source_outstanding: input.sourceOutstanding ?? undefined,
  });
}
