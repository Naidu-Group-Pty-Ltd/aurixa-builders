import { useMemo } from "react";
import { invokeBuilderFunction } from "@/lib/builderPortal";
import { PartnerComplianceWorkspace } from "@/components/partner-compliance";
import { builderPortalAdapter } from "@/components/partner-compliance/adapters";
import { makePartnerWorkspaceClient } from "@/lib/partnerWorkspaceClient";

/**
 * Builder / Developer Portal mount of the SHARED Partner Compliance
 * Workspace (Phase 5). One surface serves builder AND developer
 * organisations — the server accepts links of either portal type for a
 * builder session, and never infers a legal classification from the
 * portal. Cookie session only; the server re-derives the organisation from
 * the session's ACTIVE organisation and enforces every check again.
 */
export default function BuilderCompliance() {
  const client = useMemo(
    () => makePartnerWorkspaceClient(invokeBuilderFunction, "builder"),
    [],
  );

  /* No client-side gate. The server refuses every workspace operation on
     its own — flags, membership, organisation mapping, link scope — and says
     so in its own words, which the workspace renders. Gating here as well
     put a SECOND authority in front of it, and that authority was asking a
     question a partner cannot ask: `feature_flags` grants SELECT `TO
     authenticated`, a portal user's browser client is anon, and RLS filters
     rather than erroring. The page announced itself unavailable while the
     server was ready to serve it. */
  return (
    <div className="p-4 md:p-6">
      <PartnerComplianceWorkspace adapter={builderPortalAdapter} client={client} />
    </div>
  );
}
