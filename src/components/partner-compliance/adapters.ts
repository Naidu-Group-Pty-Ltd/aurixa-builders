import type { PartnerPortalAdapter } from "./types";

/**
 * Portal policy adapters (Phase 5). Presentation and context ONLY: wording,
 * reference formatting, optional panels, support routing. No adapter field
 * participates in authorisation — the server derives organisation, link and
 * disclosure from the session regardless of what an adapter says.
 */

export const financePortalAdapter: PartnerPortalAdapter = {
  portalType: "finance",
  workspaceTitle: "Client compliance",
  matterLabel: "Purchase file",
  ownReferenceLabel: "File",
  roleLabel: "Lender / broker role",
  formatReference: (l) =>
    l.purchase_file_id ? `File …${l.purchase_file_id.slice(-6)}` : `Matter …${l.id.slice(-6)}`,
  responsibilityIntro:
    "This workspace complements — and never replaces — your existing funding information and evidence workflow with the issuing organisation.",
  panels: {
    procedures: true, determination: true, recordsRequests: true,
    deliveries: true, auditReceipt: true, clarification: true,
  },
  support: {
    operationalLabel: "Message the team",
    operationalHref: "/finance/messages",
    complianceLabel: "your organisation's compliance officer",
  },
};

/** One surface serves builder AND developer organisations: the Builder /
 * Developer Portal. Regulatory status is never assumed from the portal —
 * whether a builder or developer is a reporting entity for a given
 * transaction is recorded configuration, and with nothing recorded the
 * route defaults to independent CDD / information sharing. */
export const builderPortalAdapter: PartnerPortalAdapter = {
  portalType: "builder",
  workspaceTitle: "Purchaser compliance",
  matterLabel: "Sale / contract",
  ownReferenceLabel: "Contract",
  roleLabel: "Organisation role",
  formatReference: (l) =>
    l.purchase_file_id ? `Contract …${l.purchase_file_id.slice(-6)}` : `Matter …${l.id.slice(-6)}`,
  responsibilityIntro:
    "Whether your organisation has its own AML/CTF obligations for this transaction depends on the designated services it actually provides — that classification is recorded with your compliance advisers, never assumed from this portal.",
  panels: {
    procedures: true, determination: true, recordsRequests: true,
    deliveries: true, auditReceipt: true, clarification: true,
  },
  support: {
    operationalLabel: "Message the team",
    operationalHref: "/builder/messages",
    complianceLabel: "your organisation's compliance role",
  },
};

/**
 * Standalone Developer Portal adapter — DEFINED, NOT MOUNTED. No Developer
 * Portal application, authentication or organisation model exists in this
 * repository; developer-type organisations are served through the Builder /
 * Developer surface above. This adapter exists so a future standalone
 * portal has a contract to mount, and it fails closed until then: there is
 * no route, no session source, and the server accepts no "developer"
 * surface. Do not invent one.
 */
export const developerPortalAdapter: PartnerPortalAdapter = {
  portalType: "developer",
  workspaceTitle: "Purchaser compliance",
  matterLabel: "Lot / contract",
  ownReferenceLabel: "Contract",
  roleLabel: "Vendor / seller role",
  formatReference: (l) =>
    l.purchase_file_id ? `Contract …${l.purchase_file_id.slice(-6)}` : `Matter …${l.id.slice(-6)}`,
  responsibilityIntro:
    "Whether your organisation has its own AML/CTF obligations for this sale depends on the designated services it actually provides — that classification is recorded with your compliance advisers, never assumed from this portal.",
  panels: {
    procedures: true, determination: true, recordsRequests: true,
    deliveries: true, auditReceipt: true, clarification: true,
  },
  support: {
    operationalLabel: "Contact the issuing organisation",
    operationalHref: "/",
    complianceLabel: "your organisation's compliance role",
  },
};

export const solicitorPortalAdapter: PartnerPortalAdapter = {
  portalType: "solicitor_conveyancer",
  workspaceTitle: "Client verification",
  matterLabel: "Matter",
  ownReferenceLabel: "Matter",
  roleLabel: "Acting role",
  formatReference: (l) =>
    l.legal_matter_id ? `Matter …${l.legal_matter_id.slice(-6)}`
      : l.purchase_file_id ? `File …${l.purchase_file_id.slice(-6)}` : `Matter …${l.id.slice(-6)}`,
  responsibilityIntro:
    "Your practice's professional CDD decision is its own. Privileged advice, internal notes and client communications stay inside your practice — only the structured determinations you record here cross the portal boundary.",
  panels: {
    procedures: true, determination: true, recordsRequests: true,
    deliveries: true, auditReceipt: true,
    // Solicitor clarification stays inside the practice's existing
    // matter-scoped communications, mounted from the matter page.
    clarification: false,
  },
  support: {
    operationalLabel: "Message the team",
    operationalHref: "/solicitor/messages",
    complianceLabel: "your practice's compliance principal",
  },
};
