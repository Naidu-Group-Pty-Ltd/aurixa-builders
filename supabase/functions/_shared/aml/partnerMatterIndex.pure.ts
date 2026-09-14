/**
 * A partner's filing cabinet — the matters they hold a Passport on.
 *
 * ── What this is for ──────────────────────────────────────────────────
 * A partner accumulates Passports. A broker acts on many purchases, a
 * builder sells many lots, a conveyancer runs many matters, and every one of
 * them may carry a Compliance Passport from the issuing organisation. The
 * compliance page showed them as a row of chips labelled
 * **"Matter …6a5a49"** — the last six characters of a database identifier —
 * which names nothing a partner recognises and does not scale past about
 * four.
 *
 * This turns those links into a list a person can actually file by: what the
 * matter IS, whose record it is, and whether there is anything to read.
 *
 * ── The disclosure rule, which is the whole point ─────────────────────
 * **A partner is told whose record it is only where they may READ that
 * record.** The customer's name and the case reference are printed on page
 * one of the Passport itself, so naming them on a matter whose Passport is
 * disclosable discloses nothing new. Naming them on a matter where the
 * Passport is withheld — never shared, withdrawn, lapsed — WOULD be a new
 * disclosure, made by a list rather than by a decision.
 *
 * So a withheld row falls back to the partner's OWN reference (their purchase
 * file, their legal matter) and then to the date they were linked. It says
 * there is nothing to read yet; it does not say who it is about.
 *
 * Three rules carry it.
 *
 * **The label is the partner's own vocabulary first.** Their purchase file or
 * legal matter number is the thing they filed it under; the issuing
 * organisation's case reference is a foreign key to them. Where both exist,
 * theirs leads.
 *
 * **A search must match what is on screen.** The haystack is built from the
 * fields actually rendered, so a partner who can see a name can find it — and
 * a partner who cannot see it cannot search for it either, which is the same
 * disclosure rule applied to the search box.
 *
 * **Ordering is by usefulness, not by recency.** A matter with a readable
 * Passport comes before one waiting on the issuing organisation, which comes
 * before one that has ended. Within a group, most recently linked first.
 */

export type MatterPassportState =
  /** Readable now. */
  | "available"
  /** Readable, but the access expires soon. */
  | "expiring"
  /** Nothing has been shared on this matter yet. */
  | "not_shared"
  /** Shared and then withdrawn by the issuing organisation. */
  | "withdrawn"
  /** Access lapsed. */
  | "expired"
  /** Being refreshed after a material change. */
  | "updating"
  /** The link itself has ended. */
  | "ended";

export interface MatterLinkInput {
  id: string;
  relationship_role: string;
  legal_route: string;
  state: string;
  portal_type?: string | null;
  linked_at: string;
  ended_at?: string | null;
  purchase_file_id?: string | null;
  legal_matter_id?: string | null;
  /** Present ONLY when the Passport on this matter is disclosable. */
  subject_label?: string | null;
  case_reference?: string | null;
  passport_state?: MatterPassportState | null;
  /** When the current access lapses, where there is any. */
  expires_at?: string | null;
}

export interface MatterRow {
  id: string;
  /** The heading — the customer, or the partner's own reference. */
  title: string;
  /** One line under it. Never a duplicate of the title. */
  subtitle: string;
  state: MatterPassportState;
  /** Short, human, and only when it is worth saying. */
  stateLabel: string;
  /** Lower-cased text the search box matches against. */
  haystack: string;
  /** True when opening it will show a document. */
  readable: boolean;
  linkedAt: string;
}

export interface MatterIndexReading {
  rows: MatterRow[];
  /** How many carry a readable Passport right now. */
  readable: number;
  /** One line for the list header. A count, never a claim. */
  headline: string;
}

const STATE_LABEL: Record<MatterPassportState, string> = {
  available: "Passport available",
  expiring: "Expires soon",
  not_shared: "Nothing shared yet",
  withdrawn: "Access withdrawn",
  expired: "Access expired",
  updating: "Being updated",
  ended: "Link ended",
};

/** Worst-to-best is wrong here: MOST USEFUL first. */
const STATE_ORDER: MatterPassportState[] = [
  "available", "expiring", "updating", "not_shared", "expired", "withdrawn", "ended",
];

const shortRef = (value: string | null | undefined): string | null =>
  value ? `…${value.slice(-6)}` : null;

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  /* Day/Month/Year, pinned. An un-localed call takes the reader's machine,
     which for an Australian reporting entity's compliance date is how
     29/08 comes to read as 8/29 — see `src/lib/aml/displayDate.ts`. */
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-AU");
};

/** A role like `builder_developer` is a column name, not a word. */
export function roleWords(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function partnerMatterIndex(
  links: MatterLinkInput[],
  opts: { ownReferenceLabel?: string; query?: string } = {},
): MatterIndexReading {
  const ownLabel = opts.ownReferenceLabel ?? "Matter";

  const rows = links.map<MatterRow>((link) => {
    const state: MatterPassportState = link.ended_at || link.state !== "active"
      ? "ended"
      : link.passport_state ?? "not_shared";
    const readable = state === "available" || state === "expiring";

    /* The partner's own reference leads where it exists: it is what they
       filed the matter under, and the issuing organisation's case reference
       is a foreign key to them. */
    const ownRef = shortRef(link.legal_matter_id) ?? shortRef(link.purchase_file_id);

    /* The customer is named only where the record may be READ. On a withheld
       matter this list would otherwise disclose who it is about, which is a
       decision the list is not entitled to make. */
    const title = readable && link.subject_label
      ? link.subject_label
      : ownRef
        ? `${ownLabel} ${ownRef}`
        : `${ownLabel} linked ${fmtDate(link.linked_at)}`;

    const subtitleParts = [
      readable && link.case_reference ? link.case_reference : null,
      readable && ownRef ? `${ownLabel} ${ownRef}` : null,
      roleWords(link.relationship_role),
      state === "expiring" && link.expires_at ? `expires ${fmtDate(link.expires_at)}` : null,
    ].filter(Boolean) as string[];

    return {
      id: link.id,
      title,
      subtitle: subtitleParts.join(" · ") || `Linked ${fmtDate(link.linked_at)}`,
      state,
      stateLabel: STATE_LABEL[state],
      /* Built from what is RENDERED. A partner who cannot see a name cannot
         search for it either — the same disclosure rule, applied to the
         search box. */
      haystack: [title, ...subtitleParts].join(" ").toLowerCase(),
      readable,
      linkedAt: link.linked_at,
    };
  });

  const query = (opts.query ?? "").trim().toLowerCase();
  const filtered = query
    ? rows.filter((r) => r.haystack.includes(query))
    : rows;

  filtered.sort((a, b) => {
    const rank = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    return rank !== 0 ? rank : b.linkedAt.localeCompare(a.linkedAt);
  });

  const readable = rows.filter((r) => r.readable).length;
  const headline = rows.length === 0
    ? "No matters are shared with your organisation yet."
    : query
      ? `${filtered.length} of ${rows.length} match`
      : readable === 0
        ? `${rows.length} matter${rows.length === 1 ? "" : "s"} · none readable yet`
        : `${readable} Passport${readable === 1 ? "" : "s"} available of ${rows.length} matter${rows.length === 1 ? "" : "s"}`;

  return { rows: filtered, readable, headline };
}
