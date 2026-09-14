import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";
import type { PartnerPortalAdapter, PartnerWorkspaceDto } from "./types";

const ROUTE_LABELS: Record<string, string> = {
  reliance: "Reliance under a written CDD arrangement",
  outsourced_cdd: "Outsourced customer due diligence",
  independent_cdd: "Independent customer due diligence",
  information_share_only: "Information sharing only",
};

const STATE_TONES: Record<string, string> = {
  current: "text-success",
  superseded: "text-warning",
  refresh_required: "text-warning",
  revoked: "text-destructive",
  expired: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

/** Matter reference, relationship role, legal route, attestation state,
 * limitations and the safe next action — the workspace at a glance. */
export function ComplianceSummaryCard({
  workspace, adapter,
}: { workspace: PartnerWorkspaceDto; adapter: PartnerPortalAdapter }) {
  const { link, attestation, attestation_state, limitations, next_action } = workspace;
  return (
    <Card data-testid="partner-compliance-summary">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          {adapter.workspaceTitle}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 text-xs">
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">{adapter.matterLabel}</dt>
            <dd className="font-medium">{adapter.formatReference(link)}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">{adapter.roleLabel}</dt>
            <dd className="font-medium">{link.relationship_role}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Basis of participation</dt>
            <dd className="font-medium">{ROUTE_LABELS[link.legal_route] ?? link.legal_route}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">Attestation</dt>
            <dd className="font-medium">
              {attestation ? (
                <>
                  v{attestation.version}
                  <span className="text-muted-foreground"> · </span>
                  <span className="truncate" title={attestation.sha256}>
                    sha {attestation.sha256.slice(0, 12)}…
                  </span>
                </>
              ) : "Not available"}
              {" "}
              <Badge variant="outline" className={STATE_TONES[attestation_state] ?? ""}>
                {attestation_state.replace(/_/g, " ")}
              </Badge>
            </dd>
          </div>
        </dl>
        {limitations.length > 0 && (
          <div className="text-xs">
            <span className="font-medium">Stated limitations: </span>
            <span className="text-muted-foreground">
              {limitations.map((l) => l.replace(/_/g, " ")).join("; ")}
            </span>
          </div>
        )}
        <div className="rounded-md border p-2 text-xs" role="status" data-testid="partner-next-action">
          <span className="font-medium">Current action: </span>
          {next_action.label}
        </div>
      </CardContent>
    </Card>
  );
}
