import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RefreshCw, Ban, Clock } from "lucide-react";
import type { PartnerAttestationState } from "./types";

/**
 * Lifecycle banner for the attestation the partner is looking at. The
 * sensitive material-change reason NEVER appears here — the partner sees a
 * state and a safe next step, nothing about why.
 */
const STATES: Record<
  Exclude<PartnerAttestationState, "current">,
  { title: string; body: string; icon: typeof RefreshCw; tone: "default" | "destructive" }
> = {
  superseded: {
    title: "Attestation refreshed",
    body: "The issuing organisation has issued a newer attestation. Review the current version and re-record your organisation's determination.",
    icon: RefreshCw, tone: "default",
  },
  refresh_required: {
    title: "Refresh required",
    body: "Your recorded determination refers to an earlier attestation version. Review the current version and re-record your determination.",
    icon: RefreshCw, tone: "default",
  },
  revoked: {
    title: "Access revoked",
    body: "Access to this compliance information has been revoked. Contact the issuing organisation if you believe this is an error.",
    icon: Ban, tone: "destructive",
  },
  expired: {
    title: "Access expired",
    body: "Access to this compliance information has expired. Ask the issuing organisation to re-issue access if it is still required.",
    icon: Clock, tone: "default",
  },
  unavailable: {
    title: "No attestation available",
    body: "No compliance attestation is available for this matter yet. Your organisation may complete its own customer due diligence at any time.",
    icon: Clock, tone: "default",
  },
};

export function RefreshBanner({ state }: { state: PartnerAttestationState }) {
  if (state === "current") return null;
  const cfg = STATES[state];
  const Icon = cfg.icon;
  return (
    <Alert variant={cfg.tone === "destructive" ? "destructive" : "default"} role="status" data-testid="partner-refresh-banner">
      <Icon className="h-4 w-4" aria-hidden="true" />
      <AlertTitle className="text-sm">{cfg.title}</AlertTitle>
      <AlertDescription className="text-xs">{cfg.body}</AlertDescription>
    </Alert>
  );
}
