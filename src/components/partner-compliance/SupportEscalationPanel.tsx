import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LifeBuoy } from "lucide-react";
import { Link } from "react-router-dom";
import type { PartnerPortalAdapter } from "./types";

/**
 * Two distinct routes, never blended: operational issues go to the issuing
 * organisation's operational team; compliance concerns go to the PARTNER'S
 * OWN compliance role. There is deliberately no shared "MLRO approval"
 * action — the two organisations' compliance decisions are separate.
 */
export function SupportEscalationPanel({ adapter }: { adapter: PartnerPortalAdapter }) {
  return (
    <Card data-testid="partner-support">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <LifeBuoy className="h-4 w-4 text-primary" aria-hidden="true" /> Support and escalation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div>
          <span className="font-medium">Operational issue </span>
          <span className="text-muted-foreground">
            (access, data, deadlines) —{" "}
            <Link to={adapter.support.operationalHref} className="underline underline-offset-2">
              {adapter.support.operationalLabel}
            </Link>
          </span>
        </div>
        <div>
          <span className="font-medium">Compliance concern </span>
          <span className="text-muted-foreground">
            — raise it with {adapter.support.complianceLabel}. Compliance decisions for your
            organisation are made by your organisation.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
