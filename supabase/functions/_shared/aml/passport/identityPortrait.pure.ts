/**
 * The photograph on the identity document — and nothing else from it.
 *
 * ── What this is, and what it deliberately is not ─────────────────────
 * A Compliance Passport that proves an identity was verified, and shows no
 * face, is a certificate. The artefact this product is modelled on shows the
 * holder. So the booklet carries one image: **the portrait the provider
 * extracted from the identity document** — the face printed on the passport
 * or licence page.
 *
 * Three images exist in a standalone verification, and only one of them may
 * ever travel:
 *
 *   · `id_portrait` — the face crop the provider extracted from the DOCUMENT.
 *     It carries no document number, no MRZ, no date of birth, no address and
 *     no signature. This is the one.
 *   · `document_front` / `document_back` — the whole bio page as the customer
 *     photographed it. It carries every one of those. NPC holds it as
 *     evidence; it is staff-only and is never published to a Passport, a
 *     client or a partner.
 *   · `selfie` — the live capture taken during verification. Biometric media
 *     of the person, and out by the same rule that has always kept liveness
 *     measurements out of this document.
 *
 * The rule is an **allow-list of exactly one key**, not a deny-list over the
 * other two. A deny-list over a payload that gains a field later is how the
 * wrong image ships; `identityPortraitObject` returns the portrait or null,
 * and there is no argument that widens it.
 *
 * ── Why it is a descriptor here and a URL somewhere else ──────────────
 * This module is pure and does no I/O, and a signed storage URL is a bearer
 * credential with a lifetime. Putting one in a projection means it can be
 * persisted, cached, embedded in an attestation payload, or handed on after
 * it stops being the reader's to hold. So the view carries a DESCRIPTOR —
 * whether a portrait exists, which document it came off, when — and the edge
 * function that serves that view to a particular reader signs a short-lived
 * URL for that reader alone.
 */

/** The only capture key whose image may leave the verification record. */
export const DISCLOSABLE_CAPTURE_KEY = "id_portrait" as const;

/**
 * Capture keys that must never be published, named so a reader of this file
 * can see the decision rather than infer it from an absence.
 */
export const WITHHELD_CAPTURE_KEYS: readonly string[] = [
  "document_front", "document_back", "selfie",
];

/* ── Where the stored objects actually live ────────────────────────────
 *
 * A standalone verification's object list was written in TWO places:
 *
 *   · `outcome_detail.standalone_capture.objects` — the capture PLAN. It is
 *     what `readCapturePlan` reads, what `persistProgress` re-writes during
 *     processing, and what `aml-idv-retention` enumerates when it deletes.
 *     It is the authority.
 *   · `outcome_detail.standalone.capture_objects` — a copy folded into the
 *     evidence block at the end of a run.
 *
 * Every reader preferred the COPY (`sa.capture_objects ?? plan.objects`), and
 * the copy is written once and never updated. So a portrait added to the plan
 * after that block was composed was invisible to every surface: the object
 * was in storage, the plan named it, the retention job would have deleted it
 * on time — and the Passport still drew an empty frame, because it was
 * reading the older of two lists.
 *
 * Two rules follow, and they are the point of this function existing.
 *
 * **There is ONE reader.** `aml-reliance` and `aml-client-portal` each had
 * their own copy of the expression, in two places apiece, so "fix the order"
 * meant getting four edits right and staying right.
 *
 * **It MERGES rather than choosing.** The plan wins key by key, and the
 * legacy copy is a floor beneath it. Picking one list means a shape nobody
 * anticipated loses an object that exists; a union cannot.
 */
export function captureObjectsFor(outcomeDetail: unknown): Record<string, unknown> | null {
  if (!outcomeDetail || typeof outcomeDetail !== "object") return null;
  const detail = outcomeDetail as Record<string, unknown>;

  const asObject = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

  const legacy = asObject(asObject(detail["standalone"])?.["capture_objects"]);
  const plan = asObject(asObject(detail["standalone_capture"])?.["objects"]);
  if (!legacy && !plan) return null;

  /* The plan last, so it wins. A null in the plan is a real answer — a
     document with no back — and must overwrite, which is why this is a
     spread rather than a "keep the first truthy value" merge. */
  return { ...(legacy ?? {}), ...(plan ?? {}) };
}

/** The backfill stamp, from the check's `outcome_detail`. */
export function backfillStampFor(outcomeDetail: unknown): unknown {
  if (!outcomeDetail || typeof outcomeDetail !== "object") return null;
  const store = (outcomeDetail as Record<string, unknown>)["standalone_capture"];
  if (!store || typeof store !== "object") return null;
  return (store as Record<string, unknown>)["portrait_backfill"] ?? null;
}

export interface CaptureObjectRef {
  bucket: string;
  path: string;
}

/**
 * The stored object for the document portrait, or null.
 *
 * Reads only `id_portrait`. A verification recorded before portraits were
 * stored simply has none, and every surface renders exactly as it did.
 */
export function identityPortraitObject(
  captureObjects: unknown,
): CaptureObjectRef | null {
  if (!captureObjects || typeof captureObjects !== "object") return null;
  const raw = (captureObjects as Record<string, unknown>)[DISCLOSABLE_CAPTURE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const bucket = String((raw as Record<string, unknown>).bucket ?? "");
  const path = String((raw as Record<string, unknown>).path ?? "");
  if (!bucket || !path) return null;
  // Belt and braces against a hand-edited `outcome_detail`: a path that
  // escapes its own prefix is not a portrait, whatever it is called.
  if (path.startsWith("/") || path.includes("..")) return null;
  return { bucket, path };
}

export type IdentityDocumentKind =
  | "passport" | "driver_licence" | "identity_card" | "residence_permit";

export interface IdentityPortraitDescriptor {
  /** True when a portrait is stored for this party. */
  available: true;
  /**
   * Which document the face was printed on, in NPC's own vocabulary.
   *
   * The document KIND is disclosable and its number is not: "verified against
   * an Australian passport" is the fact a relying party needs, and the
   * passport number is the credential they do not.
   */
  document: IdentityDocumentKind | null;
  /** ISO 3166-1 alpha-3 as the provider read it, or null. */
  issuing_state: string | null;
  /** When the verification that produced it completed. */
  captured_at: string | null;
  /**
   * Filled in by the edge function serving this view, for this reader, with
   * a short lifetime. Null in the projection itself — see the header.
   */
  url: string | null;
}

export interface PortraitFacts {
  captureObjects: unknown;
  documentChoice: string | null | undefined;
  issuingState: string | null | undefined;
  completedAt: string | null | undefined;
}

const DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "passport", "driver_licence", "identity_card", "residence_permit",
]);

/**
 * Describe the portrait for a party, or answer null.
 *
 * Null is the ordinary case for every verification recorded before this
 * existed, for a hosted-provider verification (where NPC deliberately holds
 * no copy of anything), and for any attempt whose portrait could not be
 * stored. Every surface must render unchanged on null — a Passport with no
 * portrait is the Passport this product has always produced.
 */
export function describeIdentityPortrait(
  facts: PortraitFacts,
): IdentityPortraitDescriptor | null {
  if (!identityPortraitObject(facts.captureObjects)) return null;
  const choice = String(facts.documentChoice ?? "").trim().toLowerCase();
  return {
    available: true,
    document: DOCUMENT_KINDS.has(choice) ? choice as IdentityDocumentKind : null,
    issuing_state: facts.issuingState ? String(facts.issuingState).toUpperCase() : null,
    captured_at: facts.completedAt ?? null,
    url: null,
  };
}

/** "Australian passport" — how the document reads under the portrait. */
export function portraitCaption(d: IdentityPortraitDescriptor): string {
  const DOCUMENT_LABEL: Record<IdentityDocumentKind, string> = {
    passport: "passport",
    driver_licence: "driver licence",
    identity_card: "identity card",
    residence_permit: "residence permit",
  };
  const document = d.document ? DOCUMENT_LABEL[d.document] : "identity document";
  const state = d.issuing_state === "AUS" ? "Australian"
    : d.issuing_state ? d.issuing_state : null;
  return state ? `${state} ${document}` : document;
}

/* ── The slot on the Client Identity page ──────────────────────────────
 *
 * A descriptor answers "is there a portrait?", and for the leaf that CARRIES
 * the photograph that is not enough. `describeIdentityPortrait` returns null
 * for several different situations, and the booklet's only way to render null
 * is to omit the block — so the bio page silently lost its holder and the
 * reader was left to guess whether the document simply has no face on it.
 *
 * That is the defect this closes. **The Client Identity page always shows the
 * mount**, and where there is no image it says which absence it is. An
 * absence with a reason is a document; an absence with no reason is a page
 * that looks broken.
 *
 * The reasons are deliberately about the RECORD and never about the customer:
 * nobody's identity is in question because a photograph was not retained.  */

export type PortraitAbsenceReason =
  /** No verification has passed for this party yet. */
  | "not_verified"
  /**
   * Verified, NPC holds the document page, and the portrait is on its way.
   *
   * Every verification completed before portraits were stored lands here for
   * one sweep. It is a TRANSIENT state, not a defect — the backfill below
   * fetches it without anybody asking.
   */
  | "pending_retrieval"
  /**
   * Verified through a provider that keeps the media. There is nothing of the
   * document on our side to show or to re-read, which is a deliberate
   * property of that integration rather than a fault.
   */
  | "provider_retains_media"
  /**
   * The document page was read and yielded no portrait.
   *
   * Distinct from `pending_retrieval` because it is FINAL, and a page that
   * goes on promising an image that will never arrive is worse than one that
   * says so. Nothing is retried: the read was paid for and made.
   */
  | "unavailable";

export interface IdentityPortraitSlot {
  /** True when an image exists and this reader may see it. */
  available: boolean;
  /** Why there is no image. Null exactly when `available` is true. */
  reason: PortraitAbsenceReason | null;
  document: IdentityDocumentKind | null;
  issuing_state: string | null;
  captured_at: string | null;
  /** Minted for one reader at the moment of service. See the header. */
  url: string | null;
}

/**
 * The stamp a completed backfill attempt leaves behind.
 *
 * Its presence — not its outcome — is what stops a second attempt. The read
 * is a PAID call, and this codebase's standing rule is that a paid call whose
 * outcome is known is never repeated: retrying on failure would spend against
 * the same unreadable document every minute, for ever.
 */
export interface PortraitBackfillStamp {
  attempted_at: string;
  outcome: string;
}

/** The stamp itself, from wherever the caller already holds it. */
export function parseBackfillStamp(raw: unknown): PortraitBackfillStamp | null {
  if (!raw || typeof raw !== "object") return null;
  const attemptedAt = String((raw as Record<string, unknown>).attempted_at ?? "");
  if (!attemptedAt) return null;
  return {
    attempted_at: attemptedAt,
    outcome: String((raw as Record<string, unknown>).outcome ?? "unknown"),
  };
}

/** The stamp, from the `standalone_capture` block it lives in. */
export function readBackfillStamp(captureStore: unknown): PortraitBackfillStamp | null {
  if (!captureStore || typeof captureStore !== "object") return null;
  return parseBackfillStamp((captureStore as Record<string, unknown>)["portrait_backfill"]);
}

/**
 * Is the document page this portrait was extracted from still ours to read?
 *
 * The single condition: a stored `document_front` and no `id_portrait`. It is
 * deliberately not expressed in terms of the provider — what makes the
 * re-read possible is holding the source image, and a rule about which vendor
 * was used would go stale the moment another one is added.
 */
export function portraitRecoverable(captureObjects: unknown): boolean {
  if (identityPortraitObject(captureObjects)) return false;
  if (!captureObjects || typeof captureObjects !== "object") return false;
  const front = (captureObjects as Record<string, unknown>)["document_front"];
  if (!front || typeof front !== "object") return false;
  const bucket = String((front as Record<string, unknown>).bucket ?? "");
  const path = String((front as Record<string, unknown>).path ?? "");
  return Boolean(bucket && path);
}

/**
 * Should the sweep read this check's document page?
 *
 * ONE attempt, ever. The stamp's presence is the whole guard — see
 * `PortraitBackfillStamp`.
 */
export function portraitBackfillCandidate(
  captureStore: unknown,
  captureObjects: unknown,
): boolean {
  if (readBackfillStamp(captureStore)) return false;
  return portraitRecoverable(captureObjects);
}

/** Whether a check whose stamp the caller already holds is still a candidate. */
export function backfillPending(
  backfillStamp: unknown,
  captureObjects: unknown,
): boolean {
  if (parseBackfillStamp(backfillStamp)) return false;
  return portraitRecoverable(captureObjects);
}

export interface PortraitSlotFacts extends PortraitFacts {
  /** False when no verification has passed for this party. */
  verified: boolean;
  /**
   * The backfill stamp, where one exists.
   *
   * Carried as a NAMED field rather than by handing the projection the whole
   * `outcome_detail` block: that is a provider payload, and this module's
   * rule throughout is that only the facts the portrait needs are lifted out
   * of it. Absent is the ordinary reading — "not attempted yet".
   */
  backfillStamp?: unknown;
}

/** The slot for the Client Identity page. Never null: the mount always draws. */
export function describeIdentityPortraitSlot(
  facts: PortraitSlotFacts,
): IdentityPortraitSlot {
  const present = describeIdentityPortrait(facts);
  if (present) return { ...present, reason: null };

  const choice = String(facts.documentChoice ?? "").trim().toLowerCase();
  const recoverable = portraitRecoverable(facts.captureObjects);
  const attempted = parseBackfillStamp(facts.backfillStamp);

  const reason: PortraitAbsenceReason = !facts.verified
    ? "not_verified"
    : !recoverable
      ? "provider_retains_media"
      /* Held the document, read it, got nothing. Final — and said as such,
         because a page that goes on promising an image that will never
         arrive is worse than one that admits there is none. */
      : attempted
        ? "unavailable"
        : "pending_retrieval";

  return {
    available: false,
    reason,
    document: DOCUMENT_KINDS.has(choice) ? choice as IdentityDocumentKind : null,
    issuing_state: facts.issuingState ? String(facts.issuingState).toUpperCase() : null,
    captured_at: facts.verified ? facts.completedAt ?? null : null,
    url: null,
  };
}

/**
 * What the mount says when it holds no photograph.
 *
 * One implementation, because the booklet, the client's copy and the
 * partner's are the same document and must not explain the same gap in three
 * different ways. Every line is about the RECORD — a photograph that was not
 * retained says nothing about the holder.
 */
export function portraitAbsenceNote(reason: PortraitAbsenceReason): string {
  switch (reason) {
    case "not_verified":
      return "Awaiting identity verification";
    case "pending_retrieval":
      return "Photograph is being retrieved from the identity document";
    case "provider_retains_media":
      return "Photograph held by the verification provider";
    case "unavailable":
      return "No photograph could be read from the identity document";
  }
}

/**
 * The caption under the mount, whether or not there is an image.
 *
 * `portraitCaption` needs a descriptor; a slot with no image still knows
 * which document was verified, and saying "Australian passport" under an
 * empty frame is more use to a reader than saying nothing.
 */
export function slotCaption(slot: IdentityPortraitSlot): string {
  return portraitCaption({
    available: true,
    document: slot.document,
    issuing_state: slot.issuing_state,
    captured_at: slot.captured_at,
    url: null,
  });
}
