import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from '@/components/ui/search-input';
import { CheckCircle2, Clock, FolderOpen, MinusCircle, RefreshCw, Search } from "lucide-react";

import {
  partnerMatterIndex,
  type MatterLinkInput, type MatterPassportState, type MatterRow,
} from "@/lib/aml/partnerMatterIndex";

/**
 * The partner's filing cabinet.
 *
 * ── What this replaces ────────────────────────────────────────────────
 * A row of chips labelled **"Matter …6a5a49"** — the last six characters of
 * a database row id. It named nothing a partner recognises, it looked like a
 * stray tag rather than a control, and it does not survive a partner who has
 * ten matters, let alone fifty. A broker acts on many purchases, a builder
 * sells many lots, a conveyancer runs many matters, and each of them can
 * carry a Compliance Passport.
 *
 * ── What it is ────────────────────────────────────────────────────────
 * A searchable list, one row per matter, ordered by usefulness: readable
 * Passports first, then the ones waiting on the issuing organisation, then
 * the ones that have ended. Each row says what the matter is, whose record
 * it is where that may be said, and whether there is anything to open.
 *
 * ── The one rule it must not break ────────────────────────────────────
 * A partner is told whose record a matter is ONLY where they may read that
 * record. That is decided server-side — `subject_label` simply is not sent
 * for a withheld matter — so this component cannot leak it by rendering the
 * wrong field, and the search box cannot be used to probe for a name that is
 * not on screen.
 */

const STATE_STYLE: Record<MatterPassportState, { className: string; Icon: typeof CheckCircle2 }> = {
  available: { className: "border-success/40 text-success", Icon: CheckCircle2 },
  expiring: { className: "border-warning/40 text-warning", Icon: Clock },
  updating: { className: "border-warning/40 text-warning", Icon: RefreshCw },
  not_shared: { className: "border-border text-muted-foreground", Icon: Clock },
  expired: { className: "border-border text-muted-foreground", Icon: MinusCircle },
  withdrawn: { className: "border-border text-muted-foreground", Icon: MinusCircle },
  ended: { className: "border-border text-muted-foreground", Icon: MinusCircle },
};

export function PartnerMatterList({
  links, ownReferenceLabel, selectedId, onSelect,
}: {
  links: MatterLinkInput[];
  /** What this portal calls a matter: "File", "Contract", "Matter". */
  ownReferenceLabel: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const reading = useMemo(
    () => partnerMatterIndex(links, { ownReferenceLabel, query }),
    [links, ownReferenceLabel, query],
  );

  /* The search box earns its place only when there is enough to search.
     Below that it is furniture that pushes the list down. */
  const searchable = links.length > 5;

  return (
    <nav aria-label="Matters shared with your organisation" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <FolderOpen className="h-4 w-4 text-primary" aria-hidden />
          Your matters
        </h2>
        <span className="text-xs text-muted-foreground">{reading.headline}</span>
      </div>

      {searchable && (
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search by client, reference or role…"
          aria-label="Search your matters"
          className="h-8 text-xs"
          iconClassName="left-2.5 h-3.5 w-3.5"
        />
      )}

      {reading.rows.length === 0 ? (
        <p className="rounded-lg border border-border/60 px-3 py-4 text-xs text-muted-foreground">
          {query
            ? "No matter matches that search."
            : "When the issuing organisation links a matter to your organisation it appears here. Until then there is nothing to review, and your organisation's own processes are unaffected."}
        </p>
      ) : (
        <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
          {reading.rows.map((row) => (
            <MatterItem
              key={row.id}
              row={row}
              selected={selectedId === row.id}
              onSelect={() => onSelect(row.id)}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

function MatterItem({
  row, selected, onSelect,
}: {
  row: MatterRow; selected: boolean; onSelect: () => void;
}) {
  const style = STATE_STYLE[row.state];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors ${
          selected ? "bg-primary/10" : "hover:bg-muted/40"
        }`}
      >
        <style.Icon
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
            row.readable ? "text-success" : "text-muted-foreground"
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{row.title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{row.subtitle}</span>
        </span>
        {/* The status is worth a chip only when it is not the ordinary case:
            "Passport available" on every row is noise, and noise is what the
            operator-facing lists were criticised for. */}
        {row.state !== "available" && (
          <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-[10px] ${style.className}`}>
            {row.stateLabel}
          </Badge>
        )}
      </button>
    </li>
  );
}
