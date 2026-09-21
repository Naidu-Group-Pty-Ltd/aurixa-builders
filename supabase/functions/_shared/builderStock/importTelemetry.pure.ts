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

/** Canonical field names, as one readable value. Never a document's words. */
function names(list: readonly string[] | null | undefined): string | undefined {
  return list && list.length ? list.join(',') : undefined;
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
  /**
   * WHY the document's pictures were left to the sweep, when they were.
   *
   * A flag cannot answer "why did this import take two passes" — the two
   * reasons send an operator to different places, one to the size ceiling and
   * one to a run that was slow for some other cause. See `importBudget.pure`.
   */
  imageryDeferred?: string | null;
  /** Set only where the import refused, and only with the safe code. */
  outcome?: string | null;
  /**
   * WHAT THE DETERMINISTIC READER MADE OF A PDF, ON A RUN THAT SUCCEEDED.
   *
   * These were logged only on the FAILURE path, which is exactly backwards
   * for the question that keeps being asked: a brochure imported, and three
   * of its fields are empty — why? `fieldsRead` says what was taken,
   * `disputedFields` says what the document contradicted itself about,
   * `visualOnlyFields` says what exists only as an icon, and `ignoredLines`
   * says how much of the page was furniture. Without them a missing field
   * is indistinguishable from a field the document never stated, and the
   * only way to tell was to obtain the PDF and run it by hand.
   *
   * Safe by construction: counts, status words and canonical field NAMES.
   * No value a document stated ever appears here.
   */
  deterministic?: {
    status?: string | null;
    reason?: string | null;
    fieldsRead?: string[] | null;
    disputedFields?: string[] | null;
    visualOnlyFields?: string[] | null;
    declinedFields?: string[] | null;
    /** `field:reader` for each field claimed — how, not just what. */
    readBy?: string[] | null;
    ignoredLines?: number | null;
    unaccountedLines?: number | null;
  } | null;
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
    imagery_deferred: input.imageryDeferred ?? undefined,
    outcome: input.outcome ?? undefined,
    deterministic_status: input.deterministic?.status ?? undefined,
    deterministic_reason: input.deterministic?.reason ?? undefined,
    /*
     * A list of canonical field NAMES travels as one comma-joined string,
     * because a telemetry value is a scalar here and a name is not a value
     * the document stated.
     */
    deterministic_fields: names(input.deterministic?.fieldsRead),
    deterministic_disputed: names(input.deterministic?.disputedFields),
    deterministic_visual_only: names(input.deterministic?.visualOnlyFields),
    deterministic_declined: names(input.deterministic?.declinedFields),
    deterministic_read_by: names(input.deterministic?.readBy),
    deterministic_ignored_lines: input.deterministic?.ignoredLines ?? undefined,
    deterministic_unaccounted_lines: input.deterministic?.unaccountedLines ?? undefined,
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
  /**
   * The refusal CODE where the election minted one, and nothing otherwise.
   *
   * It is the field that says which retry budget a refusal spent, which is
   * not readable from `election_outcome` — every one of them is `unreachable`
   * — and not safely readable from `detail`, which is prose. Without it a
   * two-attempt retirement and a six-attempt one are indistinguishable in the
   * production log, and this change could not be verified after it shipped.
   */
  reason?: string | null;
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
    election_reason: input.reason ?? undefined,
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
