import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSearchParams } from "react-router-dom";
import { FolderOpen, Info, Loader2 } from "lucide-react";
import type {
  PartnerLinkSummary, PartnerPortalAdapter, PartnerRecordsRequestView,
  PartnerSurfaceMode, PartnerWorkspaceClient, PartnerWorkspaceDirectory,
  PartnerWorkspaceDto,
} from "./types";
import type { PassportView } from "@/lib/aml/passport";
import { partnerWorkspacePanels } from "@/lib/aml/partnerSurface";
import { PartnerPassportPanel } from "./PartnerPassportPanel";
import { PartnerMatterList } from "./PartnerMatterList";
import { RefreshBanner } from "./RefreshBanner";
import { ComplianceSummaryCard } from "./ComplianceSummaryCard";
import { PartnerPassportStrip } from "./PartnerPassportStrip";
import { ProcedureEvidenceViewer } from "./ProcedureEvidenceViewer";
import { IndependentAssessmentForm } from "./IndependentAssessmentForm";
import { RecordsRequestBuilder } from "./RecordsRequestBuilder";
import { EvidenceDeliveriesPanel } from "./EvidenceDeliveriesPanel";
import { TaskDeadlineRail } from "./TaskDeadlineRail";
import { AuditReceiptPanel } from "./AuditReceiptPanel";
import { ClarificationChannel } from "./ClarificationChannel";
import { SupportEscalationPanel } from "./SupportEscalationPanel";

/**
 * THE shared Partner Compliance Workspace (Phase 4). All four portals mount
 * this one component; the adapter supplies wording and optional panels, the
 * client supplies the portal's own authenticated transport, and every
 * security decision stays on the server. There is deliberately no
 * portal-specific fork inside this tree.
 */
export function PartnerComplianceWorkspace({
  adapter, client,
}: { adapter: PartnerPortalAdapter; client: PartnerWorkspaceClient }) {
  /* ── the deep link ──────────────────────────────────────────────────
     `?matter=<partner_case_link_id>` is what "View in your portal" on the
     emailed Passport link hands over. It is a DESTINATION and never an
     authority: the server re-derives this partner's organisation from their
     portal session, and a matter belonging to somebody else simply is not in
     the directory it returns — so an unrecognised value falls through to the
     ordinary selection rather than being an error. */
  const [searchParams] = useSearchParams();
  const requestedMatter = searchParams.get("matter");
  const [directory, setDirectory] = useState<PartnerWorkspaceDirectory | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<PartnerWorkspaceDto | null>(null);
  /* The Compliance Passport as the server built it for this partner, and why
     it is absent when it is. Neither is derived here. */
  const [passport, setPassport] = useState<PassportView | null>(null);
  const [passportAvailability, setPassportAvailability] =
    useState<{ code: string; message: string } | undefined>(undefined);
  /* What this page IS. The server decides; an older deployment that does not
     say reads as `full`, which is exactly how it behaved before. */
  const [surfaceMode, setSurfaceMode] = useState<PartnerSurfaceMode>("full");
  const [requests, setRequests] = useState<PartnerRecordsRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async () => {
    setLoading(true); setError(null);
    const res = await client.getDirectory();
    setLoading(false);
    if (res.error || !res.data) {
      setError(res.error?.message ?? "The compliance workspace is not available for your account.");
      return;
    }
    setDirectory(res.data);
    if (res.data.surface_mode) setSurfaceMode(res.data.surface_mode);
    const active = res.data.links.filter((l) => l.state === "active");
    /* A named matter wins, and it is checked against what the SERVER
       returned — never trusted as given. Falling back rather than erroring
       matters: a stale link in an old email must land the partner on their
       compliance page, not on a failure. */
    const named = requestedMatter
      ? res.data.links.find((l) => l.id === requestedMatter)
      : undefined;
    if (named) setSelectedLink(named.id);
    else if (active.length === 1) setSelectedLink(active[0].id);
  }, [client, requestedMatter]);

  const loadWorkspace = useCallback(async (linkId: string) => {
    setLoading(true); setError(null);
    const [w, r] = await Promise.all([
      client.getWorkspace(linkId),
      client.listRequests(linkId),
    ]);
    setLoading(false);
    if (w.error || !w.data) {
      setError(w.error?.message ?? "This matter is not available.");
      return;
    }
    setWorkspace(w.data.workspace);
    setPassport((w.data.passport as PassportView | null) ?? null);
    setPassportAvailability(w.data.passport_availability);
    if (w.data.surface_mode) setSurfaceMode(w.data.surface_mode);
    setRequests(r.data?.requests ?? []);
  }, [client]);

  useEffect(() => { loadDirectory(); }, [loadDirectory]);
  useEffect(() => {
    if (selectedLink) loadWorkspace(selectedLink);
    else { setWorkspace(null); setPassport(null); setPassportAvailability(undefined); }
  }, [selectedLink, loadWorkspace]);

  const refresh = useCallback(() => {
    if (selectedLink) loadWorkspace(selectedLink);
  }, [selectedLink, loadWorkspace]);

  /* Which panels this page draws. The adapter stays the CEILING — a mode can
     only ever subtract from what a portal already permitted — and the rule is
     the shared module the server derives the mode with, so the two cannot
     disagree about what `passport_only` means. */
  const panels = partnerWorkspacePanels(surfaceMode, adapter.panels);

  if (loading && !directory) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading compliance workspace…
      </div>
    );
  }

  if (error && !directory) {
    /* Safe closed state: no membership, the surface disabled, or no
       organisation mapping. The server's denial is already partner-safe, and
       it is now given a heading and a route out — a partner who followed
       "Open it in your Finance Portal" from an email and landed on one grey
       sentence has no idea whether the product is broken, whether they are
       in the wrong place, or what to do next. */
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3" data-testid="partner-compliance-workspace">
        <WorkspaceHeader adapter={adapter} />
        <Card>
          <CardContent className="space-y-2 py-6 text-sm">
            <p className="font-medium">This page is not available to your account yet</p>
            <p className="text-muted-foreground">{error}</p>
            <p className="text-xs text-muted-foreground">
              If you were sent a Compliance Passport link by email, that link still works and
              opens the same record without signing in. Your organisation&apos;s own AML/CTF
              obligations are unaffected either way.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    /* ── centred, and sized for the artefact on it ─────────────────────
       The page was a 3xl column pinned to the left of a 1900px viewport,
       with a booklet inside it — and then a 6xl one, which still left a
       third of a wide screen unused while the document it exists to show
       was drawn small enough that the reported complaint about this
       booklet, twice, was that the wording could not be read.

       Width here is READABILITY, not decoration. `bookletGeometry` fits the
       spread to the space it is given: two leaves side by side once the
       board is about 605px wide, and larger with every pixel after that, up
       to its 1.15 cap. Widening the container and lifting the standing
       banner off the top of the page are the same change — both hand space
       straight to the document. */
    <div className="mx-auto w-full max-w-[92rem] space-y-3" data-testid="partner-compliance-workspace">
      <WorkspaceHeader adapter={adapter} />

      <div className="grid gap-4 lg:grid-cols-[minmax(14rem,17rem)_minmax(0,1fr)] lg:items-start">
        {/* The filing cabinet. One row per matter, searchable, ordered by
            what can actually be opened — replacing a row of chips labelled
            with the last six characters of a database id. */}
        {directory && (
          <div className="lg:sticky lg:top-4">
            <PartnerMatterList
              links={directory.links as PartnerLinkSummary[]}
              ownReferenceLabel={adapter.ownReferenceLabel ?? adapter.matterLabel}
              selectedId={selectedLink}
              onSelect={setSelectedLink}
            />
          </div>
        )}

        <div className="min-w-0 space-y-3">

      {loading && directory && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </div>
      )}
      {error && directory && (
        <Card><CardContent className="py-4 text-sm text-muted-foreground">{error}</CardContent></Card>
      )}

      {workspace && !loading && (
        <>
          <RefreshBanner state={workspace.attestation_state} />
          {/* Phase 4: the Passport identity strip — presentation of data the
              workspace DTO already discloses; renders nothing pre-share. */}
          {panels.passportStrip && <PartnerPassportStrip workspace={workspace} adapter={adapter} />}
          {/* The DOCUMENT itself — the same record the issuing organisation
              holds, so this partner never has to repeat due diligence they
              are entitled to rely on. Drawn from the server's own partner
              projection; nothing here selects or relabels a page. */}
          {panels.passport && (
            <PartnerPassportPanel passport={passport} availability={passportAvailability} />
          )}
          {panels.summary && <ComplianceSummaryCard workspace={workspace} adapter={adapter} />}
          {panels.tasks && <TaskDeadlineRail workspace={workspace} adapter={adapter} />}
          {panels.procedures && <ProcedureEvidenceViewer workspace={workspace} />}
          {panels.determination && (
            <IndependentAssessmentForm workspace={workspace} client={client} onRecorded={refresh} />
          )}
          {panels.recordsRequests && (
            <RecordsRequestBuilder
              workspace={workspace} requests={requests} client={client} onSubmitted={refresh}
            />
          )}
          {panels.deliveries && (
            <EvidenceDeliveriesPanel workspace={workspace} client={client} />
          )}
          {panels.auditReceipt && (
            <AuditReceiptPanel workspace={workspace} client={client} />
          )}
          {panels.clarification && <ClarificationChannel adapter={adapter} />}
          {panels.support && <SupportEscalationPanel adapter={adapter} />}
        </>
      )}

        {/* Nothing selected, and something selectable: say which, rather
            than leaving the larger half of the page blank. */}
        {!workspace && !loading && directory && directory.links.length > 0 && !selectedLink && (
          <Card className="border-dashed">
            <CardContent className="flex min-h-[22rem] flex-col items-center justify-center gap-2 py-12 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground/50" aria-hidden />
              <p className="text-sm font-medium">Choose a matter to open its Compliance Passport</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {directory.links.length === 1
                  ? "One matter is shared with your organisation."
                  : `${directory.links.length} matters are shared with your organisation.`}{" "}
                Opening one shows the issuing organisation&apos;s completed customer due
                diligence for that customer.
              </p>
            </CardContent>
          </Card>
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * The page's own heading.
 *
 * ── Why there is no standing notice above it any more ─────────────────
 * Every portal used to open with a shield-iconed alert titled "Your
 * organisation remains responsible", carrying the fixed statutory wording
 * on every state of the page including the denial. It was reported as not
 * needed, and that reading is right for a reason worth writing down: a
 * partner reaches this page only after signing the written CDD arrangement
 * and giving the acknowledgements in it, so the banner restated something
 * already agreed, to the same organisation, on every visit.
 *
 * The statement itself is NOT gone, and could not be — it is on the
 * document. `PartnerPassportPanel` says it directly above the booklet, the
 * Passport's own reliance page carries it, and the independent-assessment
 * form still requires it to be acknowledged before a determination is
 * recorded. What has gone is the standing repetition, and with it about a
 * hundred pixels at the top of every partner's screen — which go to the
 * document, where they are worth something.
 *
 * The portal's own context (what this workspace does and does not claim
 * about that portal's organisations) is kept, behind a disclosure: closed
 * it costs nothing, and a partner who wants to know what the page is can
 * still find out without being told twice a day.
 */
function WorkspaceHeader({ adapter }: { adapter: PartnerPortalAdapter }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h1 className="text-lg font-semibold">{adapter.workspaceTitle}</h1>
      {adapter.responsibilityIntro && (
        <details className="group max-w-2xl text-xs" data-testid="partner-page-context">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <Info className="h-3.5 w-3.5" aria-hidden />
            About this page
          </summary>
          <p className="mt-1.5 text-muted-foreground">{adapter.responsibilityIntro}</p>
        </details>
      )}
    </div>
  );
}
