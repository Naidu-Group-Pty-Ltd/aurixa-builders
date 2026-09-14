import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { Link } from "react-router-dom";
import type { PartnerPortalAdapter } from "./types";

/**
 * Matter-scoped clarification routes through the portal's EXISTING
 * messaging surface — reusing the portal's safe communication pattern
 * rather than opening a second channel that would need its own disclosure
 * controls. Origin internal notes never travel here; staff replies are
 * authored partner-safe on the origin side.
 */
export function ClarificationChannel({ adapter }: { adapter: PartnerPortalAdapter }) {
  return (
    <Card data-testid="partner-clarification">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" /> Clarification
    </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <p className="text-muted-foreground">
          Questions about this matter's compliance information go through your portal's existing
          secure messages, so the conversation stays scoped to the matter and your organisation.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to={adapter.support.operationalHref}>{adapter.support.operationalLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
