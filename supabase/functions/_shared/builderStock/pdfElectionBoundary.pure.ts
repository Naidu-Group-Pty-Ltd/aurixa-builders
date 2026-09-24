/**
 * BUILDER STOCK — THE WIRE BETWEEN THE SETTLER AND THE PDF WORKER.
 *
 * ONE MODULE, BOTH ENDS. The Edge client encodes with it and
 * `builder-stock-pdf-worker` decodes with it, so the two cannot disagree about
 * the contract. This repository has paid for the alternative more than once: a
 * rule written twice is a rule that drifts.
 *
 * WHAT CROSSES, AND WHAT DELIBERATELY DOES NOT. The bytes of one PDF and the
 * election context — a label, how the document came to be this property's, a
 * design, some estate names, a document name and its URL. That is all. No row
 * id, no organisation id, no upload id, no credential of any kind: the worker
 * computes and answers, and cannot act on a property even in principle because
 * it is never told which property row it is looking at.
 *
 * WHY THE DOCUMENT TRAVELS AS A RAW BODY. The Edge function already holds the
 * bytes — it fetched them through the guarded fetcher and applied the identity
 * rules — and base64 of a 14 MB brochure is about 19 MB and real CPU spent in
 * exactly the isolate that has none to spare. So the PDF is the request body
 * verbatim and the small context rides in a header. The ANSWER comes back as
 * JSON with the elected image base64-encoded, because that image is small (a
 * facade render, not the document) and decoding it costs the Edge almost
 * nothing.
 *
 * Pure: no IO, no clock, no network.
 */
import { PROVENANCE_VERSION } from './provenanceVersion.pure.ts';

/**
 * Bumped when the shape below changes in a way the other end must notice.
 *
 *   1  first release
 *   2  the context names the extractor version it asks under, and a worker
 *      built at any other version refuses it (see `provenanceVersion` below)
 *   3  the context may carry the lots a builder confirmed the document may
 *      designate for this property (see `confirmedLots` below)
 *
 * THE NEWEST THIS BUILD SPEAKS, NOT THE ONE EVERY REQUEST USES. The two ends
 * deploy on separate lanes, and a protocol bump that every request carried
 * would make every election in the gap between them a refusal. So a request
 * is asked under the LOWEST protocol that can carry it — see
 * `electionProtocolFor` — and a worker answers in the protocol it was asked
 * in. An election with no confirmation is therefore asked exactly as it was
 * under protocol 2, whichever lane deploys first; only a confirmed one needs
 * a worker that reads 3, and an older worker refuses it, which is a retry and
 * never a verdict.
 */
export const PDF_ELECTION_PROTOCOL = 3;

/** The oldest protocol this build still speaks. See `PDF_ELECTION_PROTOCOL`. */
export const OLDEST_PDF_ELECTION_PROTOCOL = 2;

/**
 * How many confirmed lots one election may carry. A confirmation names one
 * brochure's one stated lot, so one is the normal case; the bound exists so a
 * context cannot grow without limit in a header.
 */
export const MAX_CONFIRMED_LOTS = 4;

/**
 * The protocol a context is asked under: the lowest that can carry it. Any
 * context is accepted — one that names no confirmation is simply asked under
 * the oldest protocol, which is what makes this safe to call on every one.
 */
export function electionProtocolFor(context: object): number {
  const lots = (context as { confirmedLots?: unknown }).confirmedLots;
  return Array.isArray(lots) && lots.length ? PDF_ELECTION_PROTOCOL : OLDEST_PDF_ELECTION_PROTOCOL;
}

export const ELECTION_CONTEXT_HEADER = 'x-election-context';

/**
 * WHY A REFUSAL CARRIES A CODE AS WELL AS A SENTENCE.
 *
 * `unreachable` is one word covering two opposite kinds of failure, and the
 * retry budget cannot tell them apart. A sign-in wall, a 404, a rate limit, a
 * cold origin and a killed worker are all TRANSIENT — the same link may read
 * perfectly tomorrow, which is why `MAX_UNREACHABLE_ATTEMPTS` is six and why
 * it must stay six.
 *
 * `text_free_cover_not_elected` is not that. It means the document was
 * fetched whole, its text was read and every page came back empty, the
 * builder's own folder had already tied it to this one property so the
 * structural cover was licensed, a raster on that cover page WAS materialised
 * — proven, not assumed, by `coverRastersInspected` — and the cover rule
 * still elected nothing from it. Every step of that is a pure function of the
 * bytes. The same bytes answer the same way for ever, so retrying is spend
 * with no possible new outcome — measured on Lot 208 / `46 Satinwood Crescent
 * Donnybrook`, fourteen attempts across two imports, one verdict.
 *
 * A COVER PAGE WITH NOTHING DECODED IS EXPRESSLY NOT THIS. That is a starved
 * or failed raster step, it is a fact about us, and it keeps the generic
 * six.
 *
 * SO THE CODE TRAVELS, AND THE SENTENCE DOES NOT DECIDE ANYTHING. Retry
 * behaviour keys on this value and never on the prose, because prose is
 * rewritten for readability and a budget must not move when somebody fixes a
 * comma. The sentence stays exactly what it was, for the operator.
 *
 * ONLY THE ELECTION ITSELF MAY MINT IT. It is earned by reading the real
 * bytes to the end, so nothing on the calling side constructs it: see the
 * `unreachable()` helper in `pdfElectionClient.ts`, which cannot set it.
 */
export const TEXT_FREE_COVER_NOT_ELECTED = 'text_free_cover_not_elected' as const;

/**
 * Every refusal code this protocol speaks.
 *
 * A union of one, deliberately. There is no vocabulary to grow here: a second
 * code is a second retry budget, and each one has to be argued for from a
 * measurement the way this one was.
 */
export type ElectionRefusalReason = typeof TEXT_FREE_COVER_NOT_ELECTED;

/**
 * Is this value a code THIS deployment speaks?
 *
 * Used on the receiving side so an answer from a worker running ahead of us
 * cannot introduce a budget this build has never heard of. An unrecognised
 * code is simply absent, which lands the refusal on the generic allowance —
 * the conservative direction, because generic is the more patient one.
 */
export function isElectionRefusalReason(value: unknown): value is ElectionRefusalReason {
  return value === TEXT_FREE_COVER_NOT_ELECTED;
}

/**
 * The largest document that may cross.
 *
 * Lot 6706's 13.9 MB brochure is the largest measured in production. 32 MB
 * leaves room for the corpus to grow without letting an arbitrary upload
 * become a memory event at the far end.
 */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * How long the Edge waits for an answer.
 *
 * Inside `RECOVERY_DEADLINE_MS` (75 s) on purpose, so the branch deadline is
 * still the outer bound and this never becomes the thing that decides an
 * item's fate. A hung worker is answered rather than awaited.
 */
export const ELECTION_TIMEOUT_MS = 60_000;

export interface WireElectionContext {
  protocol: number;
  /**
   * THE EXTRACTOR VERSION THE CALLER WILL FILE THE ANSWER UNDER.
   *
   * The settler writes every answer with its own `PROVENANCE_VERSION`, and a
   * negative filed at the current version stands for ever — that is what
   * stops a document being re-read every lap. But the rules that PRODUCE the
   * answer run here, in a worker that deploys on its own lane and on its own
   * clock. So in the minutes between the Edge functions and this worker
   * shipping, a worker still running the previous cover rules could answer
   * "this document names no image", the new settler would file it at the new
   * version, and the property the new rules were written for would keep the
   * old refusal permanently — the fix deployed, and the one row it existed
   * for untouched.
   *
   * Measured risk, not a hypothetical: the two lanes are separate workflows,
   * `deploy-supabase-functions` and `deploy-pdf-worker`, and neither waits for
   * the other. So the version travels, and a worker built at any other
   * version refuses the request. A refusal is `unreachable` at the caller —
   * retried on its bounded budget and never written down as a verdict — so
   * the skew costs a retry, never an answer.
   */
  provenanceVersion: number;
  label: string;
  identifiedBy: 'folder_structure' | 'direct_link';
  design: string | null;
  identityHints: string[];
  /**
   * THE LOTS A BUILDER CONFIRMED, protocol 3 only and empty otherwise. Digits
   * and nothing else: a confirmation names a lot, never a row, an organisation
   * or a person, so the worker is still never told which property it is
   * looking at. A protocol-2 context cannot carry one — whatever it sends in
   * this field is dropped — because a worker asked under 2 was asked the
   * unconfirmed question and must answer that one.
   */
  confirmedLots: string[];
  documentName: string;
  url: string;
}

export function encodeElectionContext(context: {
  label: string;
  identifiedBy: 'folder_structure' | 'direct_link';
  design?: string | null;
  identityHints?: readonly string[] | null;
  confirmedLots?: readonly string[] | null;
  documentName: string;
  url: string;
}): string {
  const confirmedLots = [...(context.confirmedLots ?? [])];
  const protocol = electionProtocolFor({ confirmedLots });
  const wire: Record<string, unknown> = {
    protocol,
    provenanceVersion: PROVENANCE_VERSION,
    label: context.label,
    identifiedBy: context.identifiedBy,
    design: context.design ?? null,
    identityHints: [...(context.identityHints ?? [])].filter(
      (hint): hint is string => typeof hint === 'string'),
    documentName: context.documentName,
    url: context.url,
  };
  // Only where there is one: a protocol-2 context is byte-for-byte the
  // context every deployed worker already reads.
  if (confirmedLots.length) wire.confirmedLots = confirmedLots;
  // UTF-8 first: a builder's label carries em-dashes and accented names, and
  // `btoa` is Latin-1 only and THROWS on them.
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(wire)));
}

/**
 * NEVER GUESSED.
 *
 * An election run against the wrong property's label puts another house on a
 * client's card, which is the one failure this whole pipeline exists to
 * prevent. So anything the decoder cannot vouch for is refused rather than
 * defaulted, and the worker answers 400 rather than electing something.
 */
export function decodeElectionContext(raw: string | null | undefined): WireElectionContext | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(raw)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  const protocol = Number(c.protocol);
  if (protocol !== PDF_ELECTION_PROTOCOL && protocol !== OLDEST_PDF_ELECTION_PROTOCOL) return null;
  // Rules of a different version would answer a different question. See
  // `WireElectionContext.provenanceVersion`.
  if (Number(c.provenanceVersion) !== PROVENANCE_VERSION) return null;
  if (typeof c.label !== 'string' || !c.label) return null;
  if (c.identifiedBy !== 'folder_structure' && c.identifiedBy !== 'direct_link') return null;
  if (typeof c.documentName !== 'string') return null;
  if (typeof c.url !== 'string') return null;
  /*
   * A CONFIRMATION IS VOUCHED FOR OR THE CONTEXT IS REFUSED — never quietly
   * dropped under protocol 3. Electing without a confirmation the settler
   * asked under would answer the unconfirmed question and have it filed as
   * the confirmed one's answer.
   */
  let confirmedLots: string[] = [];
  if (protocol === PDF_ELECTION_PROTOCOL && c.confirmedLots !== undefined) {
    if (!Array.isArray(c.confirmedLots) || c.confirmedLots.length > MAX_CONFIRMED_LOTS) return null;
    if (!c.confirmedLots.every((lot) => typeof lot === 'string' && /^\d{1,5}$/.test(lot))) return null;
    confirmedLots = c.confirmedLots as string[];
  }
  return {
    protocol,
    provenanceVersion: PROVENANCE_VERSION,
    label: c.label,
    identifiedBy: c.identifiedBy,
    design: typeof c.design === 'string' ? c.design : null,
    identityHints: Array.isArray(c.identityHints)
      ? c.identityHints.filter((hint): hint is string => typeof hint === 'string')
      : [],
    confirmedLots,
    documentName: c.documentName,
    url: c.url,
  };
}

/**
 * CHUNKED, because the elected image is megabytes.
 *
 * `String.fromCharCode(...bytes)` spreads every byte as an argument and blows
 * the call stack somewhere in the low hundreds of thousands — Lot 6706's
 * elected render is 2,637,765 bytes.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
