import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileDown, Loader2 } from "lucide-react";
import type { PartnerWorkspaceClient, PartnerWorkspaceDto } from "./types";

/**
 * The partner's OWN audit receipt: its reliance activity, requests,
 * deliveries and determinations against this matter — exported as a JSON
 * download assembled server-side. It never contains the issuing
 * organisation's investigation or risk records.
 */
export function AuditReceiptPanel({
  workspace, client,
}: { workspace: PartnerWorkspaceDto; client: PartnerWorkspaceClient }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true); setError(null);
    const res = await client.getAuditReceipt(workspace.link.id);
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error?.message ?? "Receipt unavailable");
      return;
    }
    const blob = new Blob(
      [JSON.stringify(res.data.receipt, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compliance-receipt-${workspace.link.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card data-testid="partner-audit-receipt">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileDown className="h-4 w-4 text-primary" aria-hidden="true" /> Your audit receipt
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <p className="text-muted-foreground">
          Export your organisation's own record of this reliance relationship: attestation
          versions and hashes, access events, records requests, deliveries and your
          determinations. It contains your organisation's activity — never the issuing
          organisation's internal assessment.
        </p>
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <Button size="sm" variant="outline" onClick={download} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />}
          Export receipt (JSON)
        </Button>
      </CardContent>
    </Card>
  );
}
