/**
 * "We read that package and it names no image for this property."
 *
 * A successful inspection with a negative answer is KNOWLEDGE, and the repair
 * used to throw it away. Only a recovered image was ever written down, so the
 * next sweep could not tell a property whose package had already answered from
 * one nobody had looked at, and fetched and re-parsed the same document again
 * every five minutes for ever. Production upload f7e0d4d1 is 57 rows of exactly
 * that.
 *
 * The rule lives here, as a pure function over a stored record, for the same
 * reason the eligibility rule does: the settler and its tests must not be able
 * to hold different opinions about when an answer has gone stale.
 */

/** The only result this records. There is deliberately no vocabulary to grow. */
export const NO_DETERMINISTIC_IMAGE = 'no_deterministic_image' as const;

/**
 * WHY the answer is negative, which the result word alone could not say.
 *
 * `inspected` — we opened the source, read it, and it names no image for this
 * property. Knowledge about the document.
 *
 * `operational` — we could not open it, or opening it destroyed the worker.
 * Knowledge about US. It is recorded so the branch stops being retried this
 * version, and it must NEVER admit the online fallback: a timeout is not
 * exhaustion. See `suppliedEvidence.pure.ts`, which is the one reader of this
 * field.
 *
 * IT IS A REQUIRED ARGUMENT, not a defaulted one, for the reason the router's
 * `meterUsage` is: the two are one word apart at the call site and opposite in
 * consequence, so every writer has to say which it is out loud.
 */
import { RUNTIME_VERSION } from './runtimeVersion.pure.ts';

export type EvidenceExhaustion = 'inspected' | 'operational';

/**
 * WHAT KIND OF `inspected` FINDING THIS IS, when the reading earned a name.
 *
 * `detail` has always carried the sentence and a sentence is not a
 * classification: a screen that wanted to treat "this brochure is for another
 * property" differently from "this brochure carries no photograph" could only
 * match substrings of prose, which is a rule nobody can see and every
 * rewording breaks. So the one class a reader acts on differently gets a code.
 *
 * `identity_mismatch` — the document was read to the end and the page its
 * image would come from designates a DIFFERENT property. That is a data error
 * in the builder's own sheet and the only refusal in this vocabulary they can
 * fix in a minute.
 *
 * ITS ABSENCE IS THE NORMAL CASE, and every other `inspected` refusal keeps
 * exactly the wording it has today: a document with no photograph in it, a
 * cover of plans and graphics, a page that states nothing identifying at all.
 * Optional rather than a widened `exhaustion`, for the reason
 * `PackageOutcome.reason` is optional: `exhaustion` is read by
 * `suppliedEvidence.pure.ts` to decide whether a fallback may run, and a new
 * value there would change a decision. This field is read by nothing that
 * decides anything.
 */
export const DOCUMENT_IDENTITY_MISMATCH = 'identity_mismatch' as const;
export type DocumentFinding = typeof DOCUMENT_IDENTITY_MISMATCH;

export function isDocumentFinding(value: unknown): value is DocumentFinding {
  return value === DOCUMENT_IDENTITY_MISMATCH;
}

/**
 * What the document said about itself, for the sentence the reader is shown.
 *
 * `states` is the property identity the document designates INSTEAD of this
 * one — the lot, which is the one token that discriminates between an
 * estate's otherwise identical documents. `quote` is the page's own most
 * identifying lines, verbatim, so the builder recognises the file.
 *
 * NO DESIGN IS PARSED OUT OF THE DOCUMENT. Naming the product a brochure is
 * for would be a second identity judgement made with less evidence than the
 * one that just declined, and this module's whole safety rule is that it
 * judges nothing. The design the document names travels inside `quote`, in
 * the document's own words.
 */
export interface DocumentFindingEvidence {
  states: string;
  quote: string;
}

export interface NegativeProvenanceResult {
  result: typeof NO_DETERMINISTIC_IMAGE;
  /** The extractor version that reached this answer. */
  provenance_version: number;
  /** The package this answer is ABOUT. */
  package_reference: string;
  /** The source row it was reached through, where the source names one. */
  source_anchor: string | null;
  /** Safe to surface: why the package named nothing. */
  detail: string;
  /** Whether this is knowledge about the document or about us. */
  exhaustion: EvidenceExhaustion;
  /**
   * The runtime that FAILED, stamped only by the writers that retire a branch
   * because WE could not process it — see `runtimeVersion.pure.ts`.
   *
   * Absent on every other answer, and that absence is load-bearing: it is what
   * makes a document's own answer, and a link that is simply not there,
   * untouched by a runtime bump. Records written before this field existed
   * carry no value and are inert for the same reason.
   */
  runtime_version?: number;
  /**
   * The class of this finding, where the reading earned one, and the
   * evidence the reader is shown with it. Present only on `inspected`
   * answers; absent everywhere else, which is the normal case.
   */
  finding?: DocumentFinding;
  finding_evidence?: DocumentFindingEvidence;
  /**
   * The confirmation this answer was reached under, where a builder had made
   * one. Absent on every other answer. See `identityConfirmationHolds`.
   */
  identity_confirmation?: IdentityConfirmationRef;
  checked_at: string;
}

/**
 * A builder's standing confirmation that one brochure is this property's.
 *
 * Recorded in `builder_stock_identity_confirmations` and read by the settler;
 * here it is only what a stored answer is compared against — which
 * confirmation, and the lot it lets the brochure designate.
 */
export interface IdentityConfirmationRef {
  id: string;
  lot: string;
}

/** Where a stored answer records the confirmation it was reached under. */
export const IDENTITY_CONFIRMATION_KEY = 'identity_confirmation' as const;

/** What the caller knows about the question it is currently asking. */
export interface ProvenanceQuestion {
  provenanceVersion: number;
  packageReference: string;
  sourceAnchor: string | null;
  /**
   * The runtime asking now. Compared ONLY against a stored
   * `runtime_version`, so it can reopen a failure we caused and can never
   * reopen an answer a document gave. See `runtimeVersion.pure.ts`.
   */
  runtimeVersion?: number;
  /**
   * The confirmation that holds for this branch NOW, if the builder has made
   * one. Absent everywhere a confirmation does not reach, which is every
   * branch but one a builder confirmed — so every existing answer is read
   * exactly as it always was. See `identityConfirmationHolds`.
   */
  identityConfirmation?: IdentityConfirmationRef | null;
}

/**
 * DOES A STORED ANSWER STILL ANSWER, GIVEN THE CONFIRMATION THAT HOLDS NOW?
 *
 * A confirmation changes the question a branch is asked, so it can reopen an
 * answer in exactly two ways and no others:
 *
 *   AN ANSWER REACHED UNDER A CONFIRMATION stands only while THAT
 *   confirmation does. The builder undoing it, or replacing it, means the
 *   answer was about a question nobody is asking any more — so the picture it
 *   delivered, or the refusal it recorded, is read again under whatever holds
 *   now.
 *
 *   THE REFUSAL THE BUILDER CONFIRMED AGAINST — the identity mismatch whose
 *   stated lot is the confirmed one — is reopened, because the builder has
 *   just answered the one thing it could not.
 *
 * Every other answer stands exactly as it did: a refusal that was never about
 * identity, a mismatch stating some OTHER lot, our own failures, and every
 * answer on every branch nobody confirmed. Absent evidence never reopens
 * anything; the stamp is compared as written.
 */
export function identityConfirmationHolds(
  stored: unknown,
  active: IdentityConfirmationRef | null | undefined,
): boolean {
  if (!stored || typeof stored !== 'object') return true;
  const record = stored as Record<string, unknown>;
  const stamp = record[IDENTITY_CONFIRMATION_KEY] as { id?: unknown } | null | undefined;
  if (stamp && typeof stamp === 'object') {
    return !!active && String(stamp.id ?? '') === active.id;
  }
  if (!active) return true;
  if (record.result !== NO_DETERMINISTIC_IMAGE || record.exhaustion !== 'inspected') return true;
  if (!isDocumentFinding(record.finding)) return true;
  const states = String(
    (record.finding_evidence as { states?: unknown } | undefined)?.states ?? '').trim();
  const match = /^lot\s+(\d{1,5})$/i.exec(states);
  return !(match && match[1] === active.lot);
}

/**
 * Build the record. Separate from the write so a test can assert the SHAPE
 * without a database, and so the settler cannot invent a field the reader
 * below does not compare.
 */
export function recordNoDeterministicImage(
  question: ProvenanceQuestion,
  detail: string,
  exhaustion: EvidenceExhaustion,
  now: () => Date = () => new Date(),
  /*
   * LAST, AND OPTIONAL, so every existing writer is untouched and none of
   * them can acquire a finding by accident. Refused outright on an
   * `operational` answer: a finding is knowledge about the builder's
   * document, and an answer about OUR failure has none to give.
   */
  finding?: { finding: DocumentFinding; evidence: DocumentFindingEvidence } | null,
): NegativeProvenanceResult {
  const record: NegativeProvenanceResult = {
    result: NO_DETERMINISTIC_IMAGE,
    provenance_version: question.provenanceVersion,
    package_reference: question.packageReference,
    source_anchor: question.sourceAnchor,
    // Bounded: this is written to a column read by operators, not a log sink.
    detail: String(detail ?? '').slice(0, 300),
    exhaustion,
    checked_at: now().toISOString(),
  };
  if (exhaustion === 'inspected' && finding && isDocumentFinding(finding.finding)) {
    record.finding = finding.finding;
    record.finding_evidence = {
      states: String(finding.evidence?.states ?? '').slice(0, 60),
      quote: String(finding.evidence?.quote ?? '').slice(0, 200),
    };
  }
  return withIdentityConfirmation(record, question.identityConfirmation);
}

/**
 * STAMP THE CONFIRMATION AN ANSWER WAS REACHED UNDER, and only where there
 * was one — every other answer is written byte for byte as before. The stamp
 * is what lets an undo reopen exactly the answers the confirmation produced.
 */
export function withIdentityConfirmation<T extends object>(
  record: T,
  confirmation: IdentityConfirmationRef | null | undefined,
): T {
  if (!confirmation) return record;
  return { ...record, [IDENTITY_CONFIRMATION_KEY]: { id: confirmation.id, lot: confirmation.lot } };
}

/**
 * Does a stored answer still answer the question being asked?
 *
 * FAIL OPEN IS THE SAFE DIRECTION HERE, and that is the opposite of the display
 * gate — deliberately. The worst case for this predicate is re-reading a
 * package we did not need to re-read, which costs one fetch. The worst case for
 * the other direction is a property that never gets its picture because a stale
 * answer suppressed the source for ever. So anything unrecognised, malformed or
 * merely different resolves to "ask again".
 *
 * Three things are compared, and each of them can independently reopen the
 * question:
 *
 *   VERSION — a `PROVENANCE_VERSION` bump means the extractor changed what it
 *   is capable of finding, so every negative answer it gave is stale by
 *   definition. `<` rather than `!==`: a record from a FUTURE version (a
 *   rollback, a restored snapshot) is not something this code may overrule.
 *
 *   PACKAGE — the answer is about a document. A builder who swaps package A for
 *   package B is asking a new question, and an answer about A must not suppress
 *   B.
 *
 *   ANCHOR — the same property reached through a different source row is a
 *   different question. Compared as written, with no normalisation: fuzzy
 *   matching here would silently suppress a real source.
 */
export function negativeProvenanceStillStands(
  stored: unknown,
  question: ProvenanceQuestion,
): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const record = stored as Partial<NegativeProvenanceResult>;

  if (record.result !== NO_DETERMINISTIC_IMAGE) return false;

  const version = Number(record.provenance_version);
  if (!Number.isFinite(version)) return false;
  if (version < question.provenanceVersion) return false;

  /*
   * AND WHETHER WE ARE STILL THE WORKER THAT FAILED.
   *
   * This predicate used to compare what the answer was and which extractor
   * version reached it, and never why we stopped — so a brochure we read
   * properly and a brochure that destroyed the worker stood on exactly the
   * same terms. That is the whole defect the runtime version exists to fix,
   * and this is the only place it is read.
   *
   * A stamp is present ONLY on a retirement we caused, so the comparison is
   * strictly a re-opening of our own failures: a document's own answer and a
   * dead link carry no stamp, fall straight past this, and keep standing
   * exactly as they did. See `runtimeVersion.pure.ts`.
   */
  if (record.runtime_version !== undefined && record.runtime_version !== null) {
    const runtime = Number(record.runtime_version);
    if (!Number.isFinite(runtime)) return false;
    if (runtime < Number(question.runtimeVersion ?? RUNTIME_VERSION)) return false;
  }

  if (typeof record.package_reference !== 'string') return false;
  if (record.package_reference !== question.packageReference) return false;

  // `null` and a missing key are the same statement — the source named no
  // anchor — so they must compare equal to a question that also names none.
  const storedAnchor = record.source_anchor ?? null;
  if (storedAnchor !== question.sourceAnchor) return false;

  // And whether the builder has since answered what this refusal could not,
  // or withdrawn the answer it was reached under. See the function above.
  if (!identityConfirmationHolds(record, question.identityConfirmation)) return false;

  return true;
}
