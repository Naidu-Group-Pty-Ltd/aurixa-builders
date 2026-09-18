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

/** Bumped when the shape below changes in a way the other end must notice. */
export const PDF_ELECTION_PROTOCOL = 1;

export const ELECTION_CONTEXT_HEADER = 'x-election-context';

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
  label: string;
  identifiedBy: 'folder_structure' | 'direct_link';
  design: string | null;
  identityHints: string[];
  documentName: string;
  url: string;
}

export function encodeElectionContext(context: {
  label: string;
  identifiedBy: 'folder_structure' | 'direct_link';
  design?: string | null;
  identityHints?: readonly string[] | null;
  documentName: string;
  url: string;
}): string {
  const wire: WireElectionContext = {
    protocol: PDF_ELECTION_PROTOCOL,
    label: context.label,
    identifiedBy: context.identifiedBy,
    design: context.design ?? null,
    identityHints: [...(context.identityHints ?? [])].filter(
      (hint): hint is string => typeof hint === 'string'),
    documentName: context.documentName,
    url: context.url,
  };
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
  if (Number(c.protocol) !== PDF_ELECTION_PROTOCOL) return null;
  if (typeof c.label !== 'string' || !c.label) return null;
  if (c.identifiedBy !== 'folder_structure' && c.identifiedBy !== 'direct_link') return null;
  if (typeof c.documentName !== 'string') return null;
  if (typeof c.url !== 'string') return null;
  return {
    protocol: PDF_ELECTION_PROTOCOL,
    label: c.label,
    identifiedBy: c.identifiedBy,
    design: typeof c.design === 'string' ? c.design : null,
    identityHints: Array.isArray(c.identityHints)
      ? c.identityHints.filter((hint): hint is string => typeof hint === 'string')
      : [],
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
