import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import type {
  PartnerEvidenceAccess, PartnerWorkspaceClient, PartnerWorkspaceDto,
} from "./types";

/**
 * Delivered evidence (Stage B): the shared panel behind adapter.panels
 * .deliveries, identical across all four portals.
 *
 * Rules this panel keeps:
 *  - metadata always; the OBJECT only after the server approves a fresh,
 *    short-lived access request with a recorded retrieval reason;
 *  - nothing auto-opens; the link renders once, labelled with its expiry,
 *    and is never stored anywhere;
 *  - revoked / expired / unavailable deliveries show a text status (never
 *    colour alone) and NO active access control;
 *  - a transport without getEvidenceAccess renders no access control at
 *    all — the panel fails closed to metadata-only.
 */
export function EvidenceDeliveriesPanel({
  workspace, client,
}: { workspace: PartnerWorkspaceDto; client: PartnerWorkspaceClient }) {
  const deliveries = (workspace.deliveries ?? []) as Array<{
    id: string; record_code: string; safe_label: string;
    delivered_at: string; expires_at: string; revoked_at: string | null;
    available: boolean;
  }>;
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<Record<string, PartnerEvidenceAccess>>({});

  if (deliveries.length === 0) return null;
  const canRequestAccess = typeof client.getEvidenceAccess === "function";

  const requestAccess = async (deliveryId: string) => {
    if (!client.getEvidenceAccess) return;
    setBusy(true); setError(null);
    const res = await client.getEvidenceAccess({
      linkId: workspace.link.id, deliveryId, retrievalReason: reason.trim(),
    });
    setBusy(false);
    if (res.error || !res.data?.access) {
      setError(res.error?.message ?? "Access could not be granted.");
      return;
    }
    setAccess((prev) => ({ ...prev, [deliveryId]: res.data!.access }));
    setOpenFor(null); setReason("");
  };

  const stateOf = (d: (typeof deliveries)[number]) =>
    d.revoked_at ? "revoked" : !d.available ? "expired" : "available";

  return (
    <Card data-testid="evidence-deliveries-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Delivered records</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Records the issuing organisation has approved for your organisation.
          Opening a document requires a recorded reason and issues short-lived
          access — links expire within minutes and are not stored.
        </p>
        <ul className="space-y-2">
          {deliveries.map((d) => {
            const state = stateOf(d);
            const granted = access[d.id];
            const stillValid = granted && new Date(granted.expires_at).getTime() > Date.now();
            return (
              <li key={d.id} className="rounded-md border border-border p-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{d.safe_label}</span>
                  <Badge variant="outline" className={
                    state === "available" ? "text-success"
                      : state === "revoked" ? "text-destructive" : "text-muted-foreground"
                  }>
                    {state}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    delivered {new Date(d.delivered_at).toLocaleDateString('en-AU')}
                    {" · "}access until {new Date(d.expires_at).toLocaleDateString('en-AU')}
                  </span>
                </div>

                {state !== "available" && (
                  <p className="text-xs text-muted-foreground">
                    {state === "revoked"
                      ? "Access to this record has been withdrawn by the issuing organisation."
                      : "Access to this record has expired. Ask the issuing organisation to re-issue it if still required."}
                  </p>
                )}

                {state === "available" && canRequestAccess && !stillValid && openFor !== d.id && (
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => { setOpenFor(d.id); setError(null); }}
                    aria-label={`Request temporary access to ${d.safe_label}`}>
                    Request temporary access
                  </Button>
                )}

                {state === "available" && openFor === d.id && (
                  <form
                    className="space-y-2"
                    onSubmit={(e) => { e.preventDefault(); requestAccess(d.id); }}
                  >
                    <label className="block text-xs text-muted-foreground" htmlFor={`reason-${d.id}`}>
                      Why do you need this document now? (recorded in the access log)
                    </label>
                    <Textarea id={`reason-${d.id}`} value={reason} rows={2}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="At least 10 characters…" />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" type="submit" disabled={busy || reason.trim().length < 10}>
                        {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />}
                        Request access
                      </Button>
                      <Button size="sm" type="button" variant="ghost" disabled={busy}
                        onClick={() => { setOpenFor(null); setReason(""); setError(null); }}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {stillValid && (
                  <p role="status" className="text-xs">
                    <a href={granted.url} target="_blank" rel="noopener noreferrer"
                      className="underline underline-offset-2 font-medium">
                      Open {granted.filename}
                    </a>
                    <span className="text-muted-foreground">
                      {" — access expires at "}
                      {new Date(granted.expires_at).toLocaleTimeString('en-AU')}
                      {". The link is not stored; request access again if it lapses."}
                    </span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" className="text-xs text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
