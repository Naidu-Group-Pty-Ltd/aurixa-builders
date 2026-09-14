import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileSearch } from "lucide-react";
import type { PartnerWorkspaceDto } from "./types";

/**
 * Structured procedure facts, exactly as the manifest-controlled DTO
 * delivered them. This viewer renders ONLY `workspace.procedures` — it has
 * no other data source, so it cannot show more than the server disclosed.
 * Underlying documents are never downloadable here; approved deliveries
 * appear in the deliveries panel as metadata only.
 */
export function ProcedureEvidenceViewer({ workspace }: { workspace: PartnerWorkspaceDto }) {
  const procedures = workspace.procedures as {
    customer_identification?: {
      parties?: Array<Record<string, unknown>>;
      consents_held?: Array<Record<string, unknown>>;
      sections_submitted?: number;
    };
    screening?: {
      performed?: boolean;
      last_performed_at?: string | null;
      list_freshness?: Record<string, string>;
    };
    service_readiness?: boolean;
  } | null;

  if (!procedures) {
    return (
      <Card data-testid="partner-procedures">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileSearch className="h-4 w-4 text-primary" aria-hidden="true" /> Procedures performed
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          No procedure detail is available to view right now. When a current attestation and
          disclosure authority exist, the procedures performed by the issuing organisation appear
          here.
        </CardContent>
      </Card>
    );
  }

  const parties = procedures.customer_identification?.parties ?? [];
  const consents = procedures.customer_identification?.consents_held ?? [];
  const screening = procedures.screening;

  return (
    <Card data-testid="partner-procedures">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-primary" aria-hidden="true" /> Procedures performed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div>
          <div className="font-medium mb-1">Identity procedures</div>
          {parties.length === 0 ? (
            <div className="text-muted-foreground">No party procedures disclosed.</div>
          ) : (
            <ul className="space-y-1">
              {parties.map((p, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span>{String(p.party ?? "Party")}</span>
                  <Badge variant="outline" className={p.verified ? "text-success" : "text-muted-foreground"}>
                    {p.verified ? "verified" : "not verified"}
                  </Badge>
                  {p.method != null && (
                    <span className="text-muted-foreground">{String(p.method).replace(/_/g, " ")}</span>
                  )}
                  {p.completed_at != null && (
                    <span className="text-muted-foreground">
                      {new Date(String(p.completed_at)).toLocaleDateString('en-AU')}
                    </span>
                  )}
                  {p.document_type != null && (
                    <span className="text-muted-foreground">{String(p.document_type).replace(/_/g, " ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {screening && (
          <div>
            <div className="font-medium mb-1">Screening procedure</div>
            <div className="text-muted-foreground">
              {screening.performed ? "Screening performed" : "Screening not yet performed"}
              {screening.last_performed_at &&
                ` · last run ${new Date(screening.last_performed_at).toLocaleDateString('en-AU')}`}
            </div>
            {screening.list_freshness && Object.keys(screening.list_freshness).length > 0 && (
              <div className="text-muted-foreground">
                Lists: {Object.entries(screening.list_freshness).map(([code, at]) =>
                  `${code.toUpperCase()} ${new Date(at).toLocaleDateString('en-AU')}`).join(" · ")}
              </div>
            )}
          </div>
        )}
        {consents.length > 0 && (
          <div>
            <div className="font-medium mb-1">Consents and notices held</div>
            <div className="text-muted-foreground">
              {consents.map((c) => `${String(c.code ?? "").replace(/_/g, " ")} (v${String(c.version ?? "")})`).join(" · ")}
            </div>
          </div>
        )}
        <p className="text-muted-foreground">
          These are statements of procedures performed by the issuing organisation. Underlying
          records are available only through a controlled records request.
        </p>
      </CardContent>
    </Card>
  );
}
