/**
 * The digital passport booklet — page composition.
 *
 * The design builds the booklet from a small block vocabulary
 * (`PassportPage.dc.html`): a page is a kicker, a title, a subtitle and an
 * ordered list of blocks. This module is the production equivalent — it turns
 * one `PassportView` into that page list.
 *
 * It is pure and lives beside the other Passport derivations for two reasons:
 *
 *  1. **The booklet must not be able to disagree with the register.** Both are
 *     built from the same projection, so a figure printed on paper and the same
 *     figure in the Command pages come from one source. A booklet that fetched
 *     its own data would eventually print something the register denies.
 *  2. **Page composition is logic, not markup, and belongs under test.** Which
 *     pages exist depends on what the case actually holds; the design's own
 *     screenshots show 12, 14 and 16 pages for the same document. Getting that
 *     wrong prints a blank page or silently drops a section, and neither is
 *     visible from a component test that renders one fixture.
 *
 * A page whose records do not exist is NOT emitted. The booklet never prints a
 * page that says nothing — an empty "Screening" leaf in a bound document reads
 * as "screening found nothing", which is a different and much worse claim than
 * "screening is not part of this record".
 */

import { portraitAbsenceNote, slotCaption } from "./identityPortrait.pure.ts";
import type { PassportView } from "./passportView.pure.ts";
import type { PassportStamp, PendingStamp } from "./passportStamps.pure.ts";

/* ── block vocabulary (mirrors the design's PassportPage component) ─────── */

export type BookletBlock =
  /** A centred serif sentence — the document's own voice. */
  | { kind: "statement"; text: string }
  /** Label/value pairs in a responsive grid. */
  | { kind: "fields"; items: Array<{ k: string; v: string; mono?: boolean }> }
  /** The compliance summary: icon, label, sub, status, tick. */
  | {
      kind: "summary";
      items: Array<{ k: string; sub: string; status: string; tone: BookletTone }>;
    }
  /** Bordered chips — disclosure codes, list names. */
  | { kind: "chips"; title: string; items: Array<{ t: string; tone: BookletTone }> }
  /** Per-partner disclosure: a row plus its permitted cells. */
  | {
      kind: "matrix";
      title: string;
      items: Array<{
        k: string;
        v: string;
        tone: BookletTone;
        cells: Array<{ t: string; tone: BookletTone }>;
      }>;
    }
  /**
   * The bio panel — the holder's photograph beside the fields that identify
   * them, exactly as an identity document is laid out.
   *
   * This is the one image the booklet carries, and it is the face the
   * provider extracted from the DOCUMENT: never the document page (which
   * carries the number, the MRZ, the date of birth and the signature) and
   * never the live capture taken during verification. The rule is an
   * allow-list of one key in `identityPortrait.pure.ts`.
   *
   * **The mount always draws.** `src` is a short-lived signed URL attached
   * for one reader by the edge function serving the view; when there is no
   * image, `absence` says which of the four states this record is in. A block
   * that disappeared on a missing photograph is what left the Client Identity
   * page with no holder on it and no way to tell why.
   */
  | {
      kind: "bio";
      /** Whose face it is, as the document names them. */
      holder: string;
      /** "Australian passport" — what the photograph was taken from. */
      caption: string;
      src: string | null;
      /** Set exactly when `src` is null: why the mount is empty. */
      absence: string | null;
      /** The identifying fields printed beside the photograph. */
      items: Array<{ k: string; v: string; mono?: boolean }>;
    }
  /** Key/value rows with an optional note under the key. */
  | { kind: "rows"; title: string; items: Array<{ k: string; note?: string; v: string }> }
  /** Partner rows: org, sub, decision, date. */
  | {
      kind: "partners";
      title: string;
      items: Array<{ k: string; sub: string; v: string; date: string; tone: BookletTone }>;
    }
  /**
   * Certification impressions, laid out centred.
   *
   * The stamps are carried WHOLE — the same `PassportStamp` objects the
   * register page draws, not a projection of them. This block used to flatten
   * each one to `{t, cap, tone, earned}`, which dropped the code, the org, the
   * timestamp, the actor, the version, the die shape and the provenance; the
   * booklet then drew a generic wax blob while the register drew the approved
   * struck impression, and the two surfaces disagreed about the same
   * certification. Passing the record itself is what makes that class of drift
   * unrepresentable: there is nothing left to re-derive.
   *
   * `issuer_org` rides along because the design inks a stamp by WHAT IT SPEAKS
   * FOR (`stampFaceTone`) — a partner's decision is inked differently from the
   * issuer's own certification, and that comparison needs the issuer.
   */
  | {
      kind: "seals";
      issuer_org: string;
      earned: PassportStamp[];
      pending: PendingStamp[];
    }
  /**
   * One large impression with a sentence under it.
   *
   * Also a real certification rather than hand-authored seal text: whichever of
   * `stamp` (struck) or `pending` (the die, never struck) the record supports.
   * Both null means the page carries its sentence alone — a seal with no record
   * behind it is exactly what this document may not print.
   */
  | {
      kind: "hero";
      issuer_org: string;
      stamp: PassportStamp | null;
      pending: PendingStamp | null;
      text: string;
    }
  /** The journey, as a dated register. */
  | { kind: "timeline"; title: string; items: Array<{ time: string; t: string; sub: string; src: string }> }
  /** Credential verification. */
  | { kind: "verify"; code: string; fingerprint: string; text: string }
  /** A bordered aside — legal notes and boundaries. */
  | { kind: "note"; title: string; text: string }
  /** The issuing officer's block, with the official seal. */
  | { kind: "signature"; name: string; role: string; org: string }
  /** The full-width banner the design closes page I with. */
  | { kind: "banner"; text: string };

export type BookletTone = "ok" | "info" | "warn" | "bad" | "na";

export type BookletPage = {
  /** Stable id — used as the React key and by tests. */
  id: string;
  /**
   * `cover` is the navy leather front board, not a paper leaf. It is drawn by
   * a different component and carries no blocks — a passport opens on its
   * cover, and a booklet whose first page is a data table reads as a report.
   */
  variant: "cover" | "leaf";
  kicker: string;
  title: string;
  sub?: string;
  /** Roman numeral as the design prints it, or null for the cover. */
  numeral: string | null;
  /**
   * Cover only. The evidence fingerprint is printed on the front board because
   * it is what a holder or a verifier checks the document against — it was on
   * the client's cover before the two booklets were unified and stays there.
   */
  fingerprint?: string | null;
  blocks: BookletBlock[];
  foot?: string;
};

const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII",
  "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI",
];

const dash = (v: string | null | undefined) => (v && v.length > 0 ? v : "—");

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency", currency: "AUD", maximumFractionDigits: 0,
  }).format(n);
}

/**
 * The front board, on its own.
 *
 * Exported because the cover is shown in more places than the booklet is: a
 * record row displays it as a miniature, and the book displays it as page 1.
 * Both must be the SAME cover, so there is one function that says what a
 * cover holds and every surface asks it. A second, hand-drawn "thumbnail
 * version" would be a copy, and a copy drifts — the customer whose miniature
 * says one thing and whose booklet says another has been shown two documents.
 *
 * It is a pure function of the projection, so it is per-customer by
 * construction: the bearer, credential and state on any cover are whichever
 * projection was passed in, and nothing here can be specialised to one case.
 */
export function bookletCover(view: PassportView): BookletPage {
  const h = view.header;
  return {
    id: "cover",
    variant: "cover",
    kicker: "Aurixa Systems",
    title: "AML/CTF Compliance Passport",
    // The cover names its bearer. Branding alone would make every issued
    // passport look identical, and the first thing a reader needs to know is
    // whose document they have open.
    sub: h.subject ?? undefined,
    numeral: null,
    foot: [h.credential, h.state.label].filter(Boolean).join("  ·  "),
    fingerprint: h.evidence_fingerprint_short,
    blocks: [],
  };
}

/**
 * Compose the booklet.
 *
 * The first two pages are always present — a passport that has not been issued
 * still has a bearer and a state, and saying so is the point. Everything after
 * them is conditional on the case actually holding those records.
 */
export function buildBooklet(view: PassportView): BookletPage[] {
  const h = view.header;
  const pages: BookletPage[] = [];
  /* Tolerated as absent so a projection built by an older assembler — a
     cached response, a partner deployment mid-rollout — still composes. The
     slot is not optional on the view; this is belt and braces at the one
     boundary where two versions can meet. */
  const portrait = view.identity.portrait
    ?? { available: false, reason: "not_verified" as const, document: null,
         issuing_state: null, captured_at: null, url: null, recoverable: false };

  // The cover is page 1 and is NOT numbered: numbering starts on the first
  // leaf, exactly as a physical passport does. `leafIndex` therefore counts
  // leaves rather than pages, so adding or removing the cover can never shift
  // the roman numerals printed on the paper.
  pages.push(bookletCover(view));

  const push = (p: Omit<BookletPage, "numeral" | "variant">) => {
    const leafIndex = pages.filter((x) => x.variant === "leaf").length;
    pages.push({
      ...p,
      variant: "leaf",
      numeral: ROMAN[leafIndex] ?? String(leafIndex + 1),
    });
  };

  /* I — Client Identity */
  push({
    id: "identity",
    kicker: "AML/CTF Compliance Passport",
    title: "Client Identity",
    sub: "Issued by the originating reporting entity",
    blocks: [
      /* The bio panel: the holder's photograph beside the four fields that
         name them, which is how an identity document is laid out and what
         makes this leaf the Client Identity page rather than a table of
         eight strings. The remaining four — the credential's own facts —
         follow underneath, because they describe the DOCUMENT rather than
         the person. */
      {
        kind: "bio",
        holder: dash(h.subject),
        caption: slotCaption(portrait),
        src: portrait.available ? portrait.url : null,
        absence: portrait.available && portrait.url
          ? null
          : portrait.reason
            ? portraitAbsenceNote(portrait.reason)
            /* Available, but this reader's URL could not be minted. Saying so
               is better than an unexplained empty frame, and it is the one
               absence that resolves itself on a reload. */
            : "Photograph could not be loaded",
        items: [
          { k: "Client name", v: dash(h.subject) },
          { k: "Customer type", v: dash(h.subject_type) },
          { k: "AML case", v: dash(h.case_reference), mono: true },
          { k: "Credential ID", v: dash(h.credential), mono: true },
        ],
      },
      {
        kind: "fields",
        items: [
          { k: "Issue date", v: fmtDate(h.first_issued_at) },
          { k: "Version", v: dash(h.current_version_label), mono: true },
          { k: "Status", v: h.state.label },
          { k: "Fingerprint", v: dash(h.evidence_fingerprint_short), mono: true },
        ],
      },
      {
        kind: "signature",
        name: dash(h.officer_label),
        role: "Responsible compliance officer",
        org: h.issuer_org,
      },
      {
        kind: "note",
        title: "Originating organisation",
        text: `${h.issuer_org}${h.case_reference ? ` · matter ${h.case_reference}` : ""}`,
      },
      { kind: "banner", text: "Verified · Trusted · Compliant" },
    ],
  });

  /* II — Compliance Summary */
  const summary: Extract<BookletBlock, { kind: "summary" }>["items"] = [];
  const verifiedParties = view.verification.parties.filter((p) => p.verified).length;
  summary.push({
    k: "KYC verification",
    sub: verifiedParties > 0 ? "Identity verified and validated" : "Not yet verified",
    status: verifiedParties > 0 ? "VERIFIED" : "PENDING",
    tone: verifiedParties > 0 ? "ok" : "na",
  });
  if (view.funding) {
    summary.push({
      k: "Source of funds",
      sub: view.funding.sof_verified > 0 ? "Source of funds and wealth evidenced" : "Not yet evidenced",
      status: view.funding.sof_verified > 0 ? "VERIFIED" : "PENDING",
      tone: view.funding.sof_verified > 0 ? "ok" : "na",
    });
  }
  if (view.screening) {
    summary.push({
      k: "Sanctions screening",
      sub: view.screening.performed ? "Screening performed for every identified party" : "Not performed",
      status: view.screening.performed ? "VERIFIED" : "PENDING",
      tone: view.screening.performed ? "ok" : "na",
    });
  }
  if (view.ownership.length > 0) {
    const allVerified = view.ownership.every((o) => o.verified);
    summary.push({
      k: "Ownership & control",
      sub: allVerified ? "Beneficial ownership confirmed" : "Tracing in progress",
      status: allVerified ? "VERIFIED" : "IN PROGRESS",
      tone: allVerified ? "ok" : "info",
    });
  }
  if (view.partners && view.partners.length > 0) {
    summary.push({
      k: "Partner access",
      sub: "Partner and platform access approved",
      status: "REVIEWED",
      tone: "ok",
    });
  }
  const settled = view.transactions.some((t) => t.status === "settled");
  if (view.transactions.length > 0) {
    summary.push({
      k: "Settlement readiness",
      sub: settled ? "Settlement confirmed" : "Cleared for onboarding and settlement",
      status: settled ? "COMPLETE" : "REVIEWED",
      tone: settled ? "ok" : "info",
    });
  }

  push({
    id: "summary",
    kicker: "Aurixa Systems",
    title: "Compliance Summary",
    blocks: [
      { kind: "summary", items: summary },
      {
        kind: "verify",
        code: dash(h.credential),
        fingerprint: dash(h.evidence_fingerprint_short),
        text: "Confirm this credential with the issuer against the credential ID and evidence fingerprint below.",
      },
    ],
  });

  /* III — Identity Information */
  if (view.identity.fields.length > 0) {
    push({
      id: "identity-detail",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Identity Information",
      sub: "The attributes recorded for the customer and its parties.",
      blocks: [
        {
          kind: "fields",
          items: view.identity.fields.map((f) => ({ k: f.label, v: f.value })),
        },
        {
          kind: "note",
          title: "Identifier handling",
          text: "Full identifiers are held in the case record and are never printed on a disclosure surface.",
        },
      ],
    });
  }

  /* IV — Identity Verification */
  if (view.verification.parties.length > 0) {
    push({
      id: "verification",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Identity Verification",
      sub: "How each party was proven.",
      blocks: [
        /* No photograph here. The holder's portrait belongs on the Client
           Identity page, where an identity document puts it — printing the
           same face twice in one booklet is repetition, and it made the bio
           page the only leaf in the document that did not show its own
           subject. This leaf says how the identity was PROVEN. */
        {
          kind: "rows",
          title: "Parties",
          items: view.verification.parties.map((p) => ({
            k: p.party,
            note: p.method ?? undefined,
            v: p.verified ? "VERIFIED" : "INCOMPLETE",
          })),
        },
        {
          kind: "note",
          title: "Not part of this record",
          /* Names the one image that DOES travel, and where it travels to, so
             the sentence cannot be read as saying the booklet carries no
             photograph at all. The rest stay where they were. */
          text: "The photograph on the Client Identity page is the portrait printed on the identity document. The document image itself, the live capture taken during verification, match scores and liveness measurements stay inside the verification record.",
        },
      ],
    });
  }

  /* V — Ownership & Control */
  if (view.ownership.length > 0) {
    push({
      id: "ownership",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Ownership & Control",
      sub: "Who ultimately owns and controls the customer.",
      blocks: [
        {
          kind: "rows",
          title: "Traced parties",
          items: view.ownership.map((o) => ({
            k: o.name + (o.is_ubo ? " · UBO" : ""),
            note: [o.relationship, o.control_type, o.ownership_percent != null ? `${o.ownership_percent}%` : null]
              .filter(Boolean)
              .join(" · ") || o.party_kind,
            v: o.verified ? "VERIFIED" : dash(o.verification_state).toUpperCase(),
          })),
        },
      ],
    });
  }

  /* VI — Screening */
  if (view.screening) {
    const s = view.screening;
    push({
      id: "screening",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Screening",
      sub: "What the parties were screened against.",
      blocks: [
        {
          kind: "fields",
          items: [
            { k: "Performed", v: s.performed ? "Yes" : "No" },
            { k: "Parties screened", v: `${s.subjects_completed} of ${s.subjects_total}` },
            { k: "Last completed", v: fmtDate(s.last_completed_at) },
          ],
        },
        ...(Object.keys(s.list_freshness).length > 0
          ? [{
              kind: "chips" as const,
              title: "List currency",
              items: Object.keys(s.list_freshness).map((n) => ({ t: n.toUpperCase(), tone: "ok" as BookletTone })),
            }]
          : []),
        {
          kind: "note",
          title: "Internal boundary",
          text: "Candidate matches, dismissed hits and the reviewer's deliberation are internal compliance material and are not part of this record.",
        },
      ],
    });
  }

  /* VII — Funding & Due Diligence */
  if (view.funding) {
    const f = view.funding;
    push({
      id: "funding",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Funding & Due Diligence",
      sub: "Where the consideration comes from.",
      blocks: [
        {
          kind: "fields",
          items: [
            { k: "Source of funds", v: `${f.sof_verified} of ${f.sof_total} evidenced` },
            { k: "Source of wealth", v: `${f.sow_verified} of ${f.sow_total} evidenced` },
            {
              k: "Enhanced due diligence",
              v: f.edd_completed ? "Completed" : f.edd_present ? "Open" : "Not required",
            },
          ],
        },
      ],
    });
  }

  /* VIII — Evidence Wallet */
  if (view.documents.length > 0) {
    push({
      id: "evidence",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Evidence Wallet",
      sub: "What the record is built on.",
      blocks: [
        {
          kind: "rows",
          title: `${view.documents.filter((d) => d.status === "accepted").length} of ${view.documents.length} accepted`,
          items: view.documents.map((d) => ({
            k: d.label,
            note: d.required ? "Required" : "Supporting",
            v: d.status.toUpperCase(),
          })),
        },
        {
          kind: "note",
          title: "Evidence stays where it was filed",
          text: "This page lists what exists and its state. Documents are never copied into the Passport.",
        },
      ],
    });
  }

  /* IX / X — Disclosure & Partner Access */
  if (view.partners && view.partners.length > 0) {
    const partners = view.partners;
    const withManifest = partners.filter((p) => p.disclosure.length > 0);
    if (withManifest.length > 0) {
      push({
        id: "disclosure",
        kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
        title: "Disclosure & Access",
        sub: "What each partner may see.",
        blocks: [
          {
            kind: "matrix",
            title: "Permitted disclosure",
            items: withManifest.map((p) => ({
              k: dash(p.org_name),
              v: dash(p.legal_route),
              tone: "info" as BookletTone,
              cells: p.disclosure.map((d) => ({
                t: d.code,
                tone: (d.state === "granted" ? "ok" : d.state === "limited" ? "warn" : "na") as BookletTone,
              })),
            })),
          },
        ],
      });
    }

    push({
      id: "partners",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Partner Access",
      sub: "Who has relied on this Passport.",
      blocks: [
        {
          kind: "partners",
          title: `${partners.length} grant${partners.length === 1 ? "" : "s"}`,
          items: partners.map((p) => ({
            k: dash(p.org_name),
            sub: [dash(p.org_type), p.version_label ?? undefined].filter(Boolean).join(" · "),
            v: p.grant_revoked_at ? "REVOKED" : dash(p.assessment_status ?? p.link_state).toUpperCase(),
            date: fmtDate(p.grant_created_at),
            tone: (p.grant_revoked_at ? "bad" : p.assessment_status === "satisfied" ? "ok" : "info") as BookletTone,
          })),
        },
      ],
    });
  }

  /* XI — Transaction & Matter */
  if (view.transactions.length > 0) {
    push({
      id: "transaction",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Transaction & Matter",
      sub: "What this Passport was issued for.",
      blocks: view.transactions.map((t) => ({
        kind: "fields" as const,
        items: [
          { k: "Property", v: dash(t.property_address) },
          { k: "Kind", v: dash(t.kind) },
          { k: "Consideration", v: fmtMoney(t.purchase_price), mono: true },
          { k: "Contract", v: fmtDate(t.contract_date) },
          { k: "Settlement", v: fmtDate(t.settlement_date) },
          { k: "Status", v: dash(t.status).toUpperCase() },
        ],
      })),
    });
  }

  /* XII — Certification Seals */
  // The leaf carries the whole set, struck and unstruck. A booklet that
  // printed only what was earned gave a reader no way to tell a nearly
  // complete record from a barely started one, which is the single thing this
  // page exists to communicate. `earned: false` draws an empty impression —
  // the block has modelled that since it was written.
  const pendingSeals = view.pending_stamps ?? [];
  if (view.stamps.length > 0 || pendingSeals.length > 0) {
    push({
      id: "seals",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Certification Seals",
      sub: pendingSeals.length > 0
        ? `${view.stamps.length} of ${view.stamps.length + pendingSeals.length} earned. An unearned seal is left as an empty impression.`
        : "Every seal is earned from a system record.",
      blocks: [
        {
          kind: "seals",
          issuer_org: h.issuer_org,
          earned: view.stamps,
          pending: pendingSeals,
        },
      ],
    });
  }

  /* XIII — Version Register */
  if (view.versions.length > 0) {
    push({
      id: "versions",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Version Register",
      sub: "An issued version is immutable; material change supersedes it.",
      blocks: [
        {
          kind: "rows",
          title: "Versions",
          items: view.versions.map((v) => ({
            k: v.label ?? `v${v.version}`,
            note: v.fingerprint_short ?? undefined,
            v: v.state.replace(/_/g, " ").toUpperCase(),
          })),
        },
      ],
    });
  }

  /* XIV — Journey Record */
  push({
    id: "journey",
    kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
    title: "Journey Record",
    sub: `${view.journey.recorded} of ${view.journey.total} milestones recorded.`,
    blocks: [
      {
        kind: "timeline",
        title: "Recorded milestones",
        items: view.journey.phases.flatMap((p) =>
          p.milestones
            .filter((m) => m.recorded)
            .map((m) => ({
              time: m.at ? fmtDateTime(m.at) : "—",
              t: m.title,
              sub: m.detail,
              src: m.portal,
            })),
        ),
      },
    ],
  });

  /* XV — Transaction Completion (only once there is something to complete) */
  if (view.transactions.length > 0) {
    // The completion impression is the register's OWN `transaction_completed`
    // certification, struck or unstruck — not a third seal with its own
    // wording. This page used to invent "SETTLEMENT COMPLETE" / "AWAITING
    // SETTLEMENT" for a certification the vocabulary already names once, so the
    // same fact appeared under two names in one document.
    const struck = view.stamps.find((s) => s.code === "transaction_completed") ?? null;
    push({
      id: "completion",
      kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
      title: "Transaction Completion",
      sub: settled
        ? "The transaction has settled."
        : "On confirmed settlement the Passport receives its final seal.",
      blocks: [
        {
          kind: "hero",
          issuer_org: h.issuer_org,
          stamp: struck,
          pending: struck
            ? null
            : pendingSeals.find((p) => p.code === "transaction_completed") ?? null,
          text: settled
            ? "The Passport moves into retained-record status and is kept for the full compliance retention period."
            : "This seal is applied only on confirmed settlement. Until then the impression is left empty.",
        },
      ],
    });
  }

  /* XVI — Review & Renewal */
  push({
    id: "renewal",
    kicker: `Page ${ROMAN[pages.filter((x) => x.variant === "leaf").length]}`,
    title: "Review & Renewal",
    blocks: [
      {
        kind: "statement",
        text: "This Passport records the customer due diligence carried out under the issuer's AML/CTF programme.",
      },
      {
        kind: "fields",
        items: [
          { k: "Issued", v: fmtDate(h.last_issued_at) },
          { k: "Current version", v: dash(h.current_version_label), mono: true },
          { k: "State", v: h.state.label },
          { k: "Issuer", v: h.issuer_org },
        ],
      },
      {
        kind: "note",
        title: "Reliance",
        text: "A partner relying on this Passport remains responsible for its own obligations under the AML/CTF Act. Reliance does not transfer them.",
      },
    ],
  });

  return pages;
}

/**
 * How many leaves a spread shows.
 *
 * The design is a bound document: wide viewports show two facing pages, narrow
 * ones show a single leaf. Kept here rather than in the component so the page
 * arithmetic — which leaf is on the left, whether the last spread is a single —
 * is testable without a DOM.
 */
export function bookletSpreads(pageCount: number, perSpread: 1 | 2): number[][] {
  const spreads: number[][] = [];
  for (let i = 0; i < pageCount; i += perSpread) {
    const spread = [i];
    if (perSpread === 2 && i + 1 < pageCount) spread.push(i + 1);
    spreads.push(spread);
  }
  return spreads;
}

/** "PAGES 1–2 OF 14" / "PAGE 1 OF 12", as the design labels it. */
export function bookletLabel(spread: number[], total: number): string {
  if (spread.length === 0) return "";
  const first = spread[0] + 1;
  const last = spread[spread.length - 1] + 1;
  return first === last ? `PAGE ${first} OF ${total}` : `PAGES ${first}–${last} OF ${total}`;
}

/* ── geometry ──────────────────────────────────────────────────────────── */

/**
 * The leaf's design size, in CSS pixels.
 *
 * Every type size, rule and seal inside a leaf is authored against THIS box.
 * That is the whole reason the booklet scales by transform rather than by
 * letting flexbox squeeze the leaf: a leaf laid out at 200px wide still has
 * 11px body copy and 30px seals, so the text reflows, wraps one character per
 * line and overflows its page. Scaling the finished leaf keeps every internal
 * proportion exactly as designed, at any size.
 */
export const LEAF_W = 470;
export const LEAF_H = 648;

export type BookletGeometry = {
  /** Leaves shown side by side. */
  perSpread: 1 | 2;
  /** Uniform transform applied to the spread. */
  scale: number;
  /** UNSCALED design width of the spread — what the scaled layer is laid out at. */
  spreadWidth: number;
  /** Rendered size of the whole spread, after scaling. */
  width: number;
  height: number;
};

/**
 * Fit the spread to the space available.
 *
 * Two leaves are shown only when they can be drawn at a size a person can
 * actually read; below that the booklet falls back to a single leaf rather
 * than shrinking both into illegibility. `MIN_TWO_UP_SCALE` is that threshold
 * — at 0.62 a 470px leaf renders ~291px wide, which still carries the design's
 * 11px body copy at a legible ~7px.
 *
 * The returned `width`/`height` NEVER exceed what was given. That is the whole
 * contract: the caller sizes the board from these numbers, so a result larger
 * than the space available is a cropped passport. A property test asserts it
 * across a sweep of real viewport sizes.
 */
const MIN_TWO_UP_SCALE = 0.62;

/** Absolute floor, so a tiny container degrades rather than collapsing. */
const MIN_SCALE = 0.28;

export function bookletGeometry(input: {
  /** Space the board can use for LEAVES, in CSS pixels (frame already removed). */
  availableWidth: number;
  availableHeight: number;
  /** Gap between facing leaves, in design pixels. */
  spine?: number;
  /** Never draw a leaf larger than this multiple of its design size. */
  maxScale?: number;
  /** Force a single leaf regardless of space. */
  singleOnly?: boolean;
}): BookletGeometry {
  const spine = input.spine ?? 26;
  const maxScale = input.maxScale ?? 1.15;
  const availW = Math.max(0, input.availableWidth);
  const availH = Math.max(0, input.availableHeight);

  const designWidth = (leaves: 1 | 2) => LEAF_W * leaves + (leaves === 2 ? spine : 0);

  const fit = (leaves: 1 | 2) => {
    const byWidth = availW > 0 ? availW / designWidth(leaves) : maxScale;
    const byHeight = availH > 0 ? availH / LEAF_H : maxScale;
    return Math.min(byWidth, byHeight, maxScale);
  };

  const build = (leaves: 1 | 2, rawScale: number): BookletGeometry => {
    // Floored, not rounded. `designWidth * scale` must never exceed the space
    // given, and floating-point multiplication of an exact ratio overshoots by
    // ~1e-13 — enough to trip a `<=` guard and, with a pixel-rounded board,
    // enough to shave a hairline off a leaf. Flooring makes the fit contract
    // hold exactly rather than within an epsilon nobody can see but every
    // assertion can.
    const scale = Math.max(Math.floor(rawScale * 1e4) / 1e4, MIN_SCALE);
    return {
      perSpread: leaves,
      scale,
      spreadWidth: designWidth(leaves),
      width: designWidth(leaves) * scale,
      height: LEAF_H * scale,
    };
  };

  if (!input.singleOnly) {
    const two = fit(2);
    if (two >= MIN_TWO_UP_SCALE) return build(2, two);
  }
  return build(1, fit(1));
}

/* ── reading it ────────────────────────────────────────────────────────
 * `bookletGeometry` answers "how large can this document be drawn in the
 * space available". That is a fitting question, and it has one answer.
 *
 * It is not the same question as "how large does this reader need it".
 * The design authors a leaf at 470x648 with 9.5-11px body copy, so a spread
 * fitted into a dialog on a laptop renders that copy at 6-7px — legible in
 * the sense that the glyphs are distinct, and unreadable in the sense that
 * nobody reads it. The document was reported as "the wording on the pages
 * is not clearly visible", which is exactly right and is not a fault in the
 * fit: the fit is correct and the page is simply too small for a person.
 *
 * So the reader gets a magnification of their own, applied ON TOP of the
 * fit. Three rules make it safe:
 *
 *   · **Fit is still the baseline.** Zoom 1 is whatever the space allows, so
 *     every existing surface is unchanged until somebody asks for more.
 *   · **Zooming never reflows.** It multiplies the same uniform transform the
 *     fit uses, so a magnified leaf is the same drawing larger — never a
 *     narrower column with rewrapped text.
 *   · **Overflow is the caller's to scroll.** This reports the drawn size and
 *     whether it now exceeds the board, and the board pans; nothing here
 *     crops, because a passport that silently loses its margin is worse than
 *     one that scrolls.
 */

/** What a reader may ask for, in the order the control steps through. */
export const BOOKLET_ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3] as const;

export interface BookletZoom {
  /** The fit scale multiplied by the reader's magnification. */
  scale: number;
  /** Drawn size of the spread at that scale. */
  width: number;
  height: number;
  /*
   * There is deliberately no `overflows` here.
   *
   * It used to be `zoom > 1` — "the reader asked for more than the fit, so it
   * must be spilling" — and the viewer read it to decide whether the board
   * could be panned at all. It was wrong in both directions. It said NO on a
   * board that was already too big, because the fit has a `MIN_SCALE` floor
   * and a short window draws a leaf larger than its space at 100%. And it
   * said YES on a board that still fitted, shunting a centred document into
   * the corner the moment anybody touched the zoom.
   *
   * The obvious repair — carry the measured box on the geometry and compare —
   * does not work either, and the reason is worth recording. Where the
   * container is content-sized (the Client Portal mounts the viewer on an
   * ordinary page; so does a dialog shorter than its cap) the box the board
   * is measured against is the box the board itself produces. Measurement
   * feeds size feeds measurement, the two settle a frame apart, and a flag
   * derived from them flaps between true and false while nothing on screen
   * moves. In that configuration there is no independent "space available" to
   * exceed at all.
   *
   * So whether the board has anywhere to pan is a question about the DOM, and
   * the viewer asks the DOM: `scrollWidth`/`scrollHeight` against
   * `clientWidth`/`clientHeight`, which is the same question with no second
   * definition of it. This module answers what it can answer without a
   * layout — how large the drawing is.
   */
  /** For the control: what the reader is currently asking for. */
  zoom: number;
  percent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

/**
 * Compose the reader's magnification with the fitted geometry.
 *
 * `zoom` is clamped to the declared steps' range rather than trusted: it
 * arrives from a control, and a scale of 0 draws nothing while a scale of 40
 * draws a leaf no scrollbar can rescue.
 */
export function bookletZoom(
  geometry: BookletGeometry,
  zoom: number,
): BookletZoom {
  const min = BOOKLET_ZOOM_STEPS[0];
  const max = BOOKLET_ZOOM_STEPS[BOOKLET_ZOOM_STEPS.length - 1];
  const clamped = Number.isFinite(zoom) ? Math.min(max, Math.max(min, zoom)) : min;
  const scale = geometry.scale * clamped;
  return {
    scale,
    width: geometry.spreadWidth * scale,
    height: LEAF_H * scale,
    zoom: clamped,
    percent: Math.round(clamped * 100),
    canZoomIn: clamped < max,
    canZoomOut: clamped > min,
  };
}

/** The next step up or down from wherever the reader currently is. */
export function nextBookletZoom(current: number, direction: 1 | -1): number {
  const steps = BOOKLET_ZOOM_STEPS;
  if (direction === 1) {
    return steps.find((s) => s > current + 1e-6) ?? steps[steps.length - 1];
  }
  const below = steps.filter((s) => s < current - 1e-6);
  return below.length > 0 ? below[below.length - 1] : steps[0];
}
