import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Scale } from "lucide-react";
import type { PartnerWorkspaceClient, PartnerWorkspaceDto } from "./types";
import { DETERMINATION_OUTCOMES } from "./types";

const OUTCOME_LABELS: Record<string, string> = {
  satisfied: "Satisfied — my organisation relies on these procedures",
  records_requested: "Records requested — more records are needed before deciding",
  independent_cdd_required: "Independent CDD required — my organisation will verify separately",
  not_satisfied: "Not satisfied — my organisation will not rely on these procedures",
};

/**
 * The partner's OWN determination. It is pinned server-side to the exact
 * attestation hash, requires the organisation's compliance role and an
 * explicit responsibility acknowledgement, and can never alter the
 * originating case. Historic determinations are append-only.
 */
export function IndependentAssessmentForm({
  workspace, client, onRecorded,
}: {
  workspace: PartnerWorkspaceDto;
  client: PartnerWorkspaceClient;
  onRecorded: () => void;
}) {
  const [outcome, setOutcome] = useState<string>("");
  const [basis, setBasis] = useState("");
  const [conditions, setConditions] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const res = await client.recordDetermination({
      linkId: workspace.link.id,
      outcome,
      decisionBasis: basis,
      conditions: conditions || undefined,
      responsibilityAcknowledged: acknowledged,
    });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    setOutcome(""); setBasis(""); setConditions(""); setAcknowledged(false);
    onRecorded();
  };

  const current = workspace.determination;

  return (
    <Card data-testid="partner-assessment-form">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-primary" aria-hidden="true" /> Your organisation's determination
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {current && (
          <div className="rounded-md border p-2">
            <span className="text-muted-foreground">Latest recorded: </span>
            <Badge variant="outline">{current.status.replace(/_/g, " ")}</Badge>
            {current.decided_at && (
              <span className="text-muted-foreground"> · {new Date(current.decided_at).toLocaleString('en-AU')}</span>
            )}
            {current.refresh_required && (
              <Badge variant="outline" className="text-warning ml-2">refresh required</Badge>
            )}
            <div className="text-muted-foreground mt-1">
              Previous determinations are preserved; recording a new one never rewrites history.
            </div>
          </div>
        )}

        <fieldset className="space-y-1.5">
          <legend className="font-medium">Outcome</legend>
          {DETERMINATION_OUTCOMES.map((o) => (
            <label key={o} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio" name="partner-determination-outcome" value={o}
                checked={outcome === o} onChange={() => setOutcome(o)}
                className="mt-0.5"
              />
              <span>{OUTCOME_LABELS[o]}</span>
            </label>
          ))}
        </fieldset>

        <div className="space-y-1">
          <Label htmlFor="partner-determination-basis">Decision basis</Label>
          <Textarea
            id="partner-determination-basis" value={basis}
            onChange={(e) => setBasis(e.target.value)}
            placeholder="The basis on which your organisation makes this determination…"
            rows={3}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="partner-determination-conditions">Conditions (optional)</Label>
          <Textarea
            id="partner-determination-conditions" value={conditions}
            onChange={(e) => setConditions(e.target.value)}
            placeholder="Any conditions your organisation attaches…"
            rows={2}
          />
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(v) => setAcknowledged(v === true)}
            aria-label="Responsibility acknowledgement"
          />
          <span>
            I acknowledge that my organisation remains responsible for its own AML/CTF
            compliance, including this determination.
          </span>
        </label>
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <Button size="sm" onClick={submit} disabled={busy || !outcome}>
          {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />}
          Record determination
        </Button>
      </CardContent>
    </Card>
  );
}
