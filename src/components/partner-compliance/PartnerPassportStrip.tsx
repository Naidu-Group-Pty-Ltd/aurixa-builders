import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";
import { StampSeal } from "@/components/aml/passport/StampSeal";
import { shortFingerprint } from "@/lib/aml/passport";
import { routeExplanation, routeHeadline } from "@/lib/aml/passport/distributionPresentation.pure";
import type { PassportStamp } from "@/lib/aml/passport";
import type { PartnerPortalAdapter } from "./types";
import type { PartnerWorkspaceDto } from "../../../supabase/functions/_shared/aml/partnerWorkspace";

/**
 * The Passport identity strip for the shared partner workspace — Phase 4 of
 * the Passport programme.
 *
 * PRESENTATION ONLY. Everything rendered here is already in the workspace
 * DTO the partner lawfully receives (attestation version/hash/state, the
 * origin label, their own recorded determination): no new op, no new
 * disclosure, no adapter field participating in authorisation. When no
 * attestation has been shared the strip renders nothing — the workspace's
 * existing states carry that story.
 */

const STATE_PRESENTATION: Record<string, { label: string; className: string }> = {
  current: { label: "Current", className: "border-success/40 text-success" },
  superseded: { label: "Superseded — refresh available", className: "border-warning/40 text-warning" },
  refresh_required: { label: "Refresh required", className: "border-warning/40 text-warning" },
  revoked: { label: "Access revoked", className: "border-destructive/40 text-destructive" },
  expired: { label: "Access expired", className: "border-destructive/40 text-destructive" },
};

const PORTAL_STAMP: Record<string, { code: PassportStamp["code"]; title: string }> = {
  finance: { code: "reliance_accepted_finance", title: "FINANCE RELIANCE ACCEPTED" },
  solicitor_conveyancer: { code: "reliance_accepted_solicitor", title: "SOLICITOR RELIANCE ACCEPTED" },
  builder: { code: "reliance_accepted_builder", title: "BUILDER / DEVELOPER RELIANCE ACCEPTED" },
  developer: { code: "reliance_accepted_builder", title: "BUILDER / DEVELOPER RELIANCE ACCEPTED" },
};

export function PartnerPassportStrip({
  workspace, adapter,
}: { workspace: PartnerWorkspaceDto; adapter: PartnerPortalAdapter }) {
  const att = workspace.attestation;
  if (!att) return null;

  const state = STATE_PRESENTATION[workspace.attestation_state] ?? null;
  const det = workspace.determination;
  const satisfied = det?.status === "satisfied" && det.decided_at;
  const portalStamp = PORTAL_STAMP[workspace.link.portal_type] ?? null;

  const decisionStamp: PassportStamp | null = satisfied && portalStamp
    ? {
        code: portalStamp.code,
        title: portalStamp.title,
        org: workspace.partner.organisation_legal_name,
        portal: adapter.workspaceTitle,
        actor: null,
        at: det!.decided_at!,
        version: att.version,
        shape: "seal",
        tone: "blue",
        source: { kind: "aml.independent_assessments", id: null },
        client_safe: true,
      }
    : null;

  return (
    <section
      aria-label="Compliance Passport"
      className="passport-scope passport-cover relative flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl px-5 py-4"
    >
      <ShieldCheck className="h-6 w-6 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-64">
        <div className="font-serif text-sm font-semibold uppercase tracking-[0.18em]">
          AML/CTF Compliance Passport
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-90">
          <span>Issued by {workspace.origin.organisation_label}</span>
          <span className="font-mono">v{att.version}</span>
          {att.issued_at ? <span>{new Date(att.issued_at).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" })}</span> : null}
          {shortFingerprint(att.sha256) ? (
            <span className="font-mono" title={att.sha256}>{shortFingerprint(att.sha256)}</span>
          ) : null}
        </div>
        {/* The legal basis, stated. A partner must never have to infer whether
            it may rely, and a generic blanket-approval label would say nothing
            about the basis on which this organisation is entitled to act. The
            route is already in the DTO this portal lawfully receives; naming it
            discloses nothing new and is read, never derived here. */}
        <div className="mt-1.5 text-xs opacity-90">
          <span className="font-semibold uppercase tracking-[0.12em]">
            {routeHeadline(workspace.link.legal_route)}
          </span>
          <span className="ml-2 opacity-90">{routeExplanation(workspace.link.legal_route)}</span>
        </div>
        {det?.refresh_required ? (
          <p className="mt-1.5 text-xs opacity-90">
            Your recorded decision responds to an earlier version — review the current Passport before relying further.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-4">
        {state ? (
          <Badge variant="outline" className={state.className}>{state.label}</Badge>
        ) : null}
        {decisionStamp ? <StampSeal stamp={decisionStamp} size="sm" /> : null}
      </div>
    </section>
  );
}
