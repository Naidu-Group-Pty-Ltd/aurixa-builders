import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FolderLock, Loader2 } from "lucide-react";
import type { PartnerRecordsRequestView, PartnerWorkspaceClient, PartnerWorkspaceDto } from "./types";
import { REQUESTABLE_RECORD_CLASSES } from "./types";

const STATUS_TONES: Record<string, string> = {
  submitted: "text-warning",
  under_review: "text-warning",
  approved: "text-success",
  partly_approved: "text-success",
  delivered: "text-success",
  denied: "text-destructive",
  expired: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};

/**
 * Controlled records request builder. Only the closed record-class
 * catalogue is selectable — there is no free-text record field, so a
 * partner can never name a table, path or column. The in-scope /
 * requires-review distinction is informational; approval is always an
 * origin decision and nothing is auto-delivered.
 */
export function RecordsRequestBuilder({
  workspace, requests, client, onSubmitted,
}: {
  workspace: PartnerWorkspaceDto;
  requests: PartnerRecordsRequestView[];
  client: PartnerWorkspaceClient;
  onSubmitted: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rationale, setRationale] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availability = new Set(workspace.record_availability ?? []);
  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const submit = async () => {
    setBusy(true); setError(null);
    const res = await client.requestRecords({
      linkId: workspace.link.id,
      recordCodes: [...selected],
      rationale,
      dueAt: dueAt || undefined,
    });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    setSelected(new Set()); setRationale(""); setDueAt("");
    onSubmitted();
  };

  return (
    <Card data-testid="partner-records-request">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FolderLock className="h-4 w-4 text-primary" aria-hidden="true" /> Request underlying records
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <fieldset className="space-y-1.5">
          <legend className="font-medium">Record classes</legend>
          {Object.entries(REQUESTABLE_RECORD_CLASSES).map(([code, entry]) => (
            <label key={code} className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={selected.has(code)}
                onCheckedChange={() => toggle(code)}
                aria-label={entry.label}
              />
              <span className="flex-1">
                {entry.label}{" "}
                <Badge variant="outline" className={availability.has(code) ? "text-success" : "text-warning"}>
                  {availability.has(code) ? "within arrangement scope" : "requires origin review"}
                </Badge>
              </span>
            </label>
          ))}
          <p className="text-muted-foreground">
            Other record families are not available through this channel. Nothing is delivered
            automatically — every request is reviewed by the issuing organisation.
          </p>
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor="partner-request-rationale">Why the records are necessary</Label>
          <Textarea
            id="partner-request-rationale" value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="The compliance necessity for these records…" rows={2}
          />
        </div>
        <div className="space-y-1 max-w-[220px]">
          <Label htmlFor="partner-request-due">Needed by (optional)</Label>
          <Input
            id="partner-request-due" type="date" value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <Button size="sm" onClick={submit} disabled={busy || selected.size === 0}>
          {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />}
          Submit request
        </Button>

        {requests.length > 0 && (
          <div className="border-t pt-2 space-y-1.5">
            <div className="font-medium">Your requests</div>
            <ul className="space-y-1.5">
              {requests.map((r) => (
                <li key={r.id} className="rounded-md border p-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={STATUS_TONES[r.status] ?? ""}>
                      {r.status.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-muted-foreground">
                      {new Date(r.requested_at).toLocaleDateString('en-AU')}
                    </span>
                    {r.due_at && <span className="text-muted-foreground">· needed by {r.due_at}</span>}
                  </div>
                  <div className="text-muted-foreground">
                    {r.requested_record_codes.map((c) =>
                      REQUESTABLE_RECORD_CLASSES[c]?.label ?? c).join(" · ")}
                  </div>
                  {r.origin_response_message && (
                    <div>
                      <span className="font-medium">Response: </span>
                      {r.origin_response_message}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
