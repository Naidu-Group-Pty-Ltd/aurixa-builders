/**
 * Partner distribution — PRESENTATION ONLY.
 *
 * Phase 1 decides. This module renders that decision into the language a
 * compliance operator speaks, and it is pure so the translation can be tested
 * without a browser.
 *
 * Two rules govern everything here, and both are load-bearing:
 *
 * 1. **Nothing in this file decides anything.** There is no eligibility test,
 *    no route inference, no permission arithmetic. Every function takes a
 *    `DistributionReadiness` the server produced and returns words. If a
 *    caller cannot answer a question from that object, the answer is "not
 *    recorded" — never a guess. Re-deriving s 37A in React is precisely the
 *    two-truths bug the Passport architecture exists to prevent.
 *
 * 2. **No database vocabulary reaches the operator** (§8). Grant IDs,
 *    attestation IDs, `partner_org_id`, manifest rows and membership rows are
 *    the mechanism, not the message. The advanced governance surfaces
 *    (Compliance Sharing, partner administration) keep the technical view;
 *    this is the everyday one.
 *
 * A note on the evidence matrix. The engine returns two lists: `available`
 * (a canonical record supports it) and `unavailable` (the arrangement's scope
 * permits it but nothing supports it yet). A class in NEITHER list is one the
 * arrangement's scope does not reach — so it renders as "Not authorised",
 * which is a statement about authority and never about existence. Saying a
 * record "does not exist" when it is merely withheld would be a disclosure in
 * itself.
 */

/* ── the vocabularies, mirrored structurally ──────────────────────────────
   Imported as types from the shared engine so a change there is a type error
   here rather than a silent divergence. */
import type {
  DistributionBlocker,
  DistributionState,
  EvidenceClass,
} from './index';

export const EVIDENCE_CLASS_ORDER: EvidenceClass[] = [
  'IDENTITY_KYC_AVAILABLE',
  'VERIFICATION_DATA_AVAILABLE',
  'ADDRESS_EVIDENCE_AVAILABLE',
  'ENTITY_EVIDENCE_AVAILABLE',
  'OWNERSHIP_EVIDENCE_AVAILABLE',
  'AUTHORITY_EVIDENCE_AVAILABLE',
  'TRANSACTION_EVIDENCE_AVAILABLE',
];

/** §14 — the categories a compliance reader recognises. */
export const EVIDENCE_CATEGORY_LABEL: Record<EvidenceClass, string> = {
  IDENTITY_KYC_AVAILABLE: 'Identity & KYC',
  VERIFICATION_DATA_AVAILABLE: 'Verification',
  ADDRESS_EVIDENCE_AVAILABLE: 'Address',
  ENTITY_EVIDENCE_AVAILABLE: 'Entity',
  OWNERSHIP_EVIDENCE_AVAILABLE: 'Ownership & control',
  AUTHORITY_EVIDENCE_AVAILABLE: 'Authority to act',
  TRANSACTION_EVIDENCE_AVAILABLE: 'Transaction',
};

/* ── legal route ─────────────────────────────────────────────────────────
   A route is READ, never inferred. Finance is not reliance; solicitor is not
   reliance; builder/developer is not reliance. An unrecorded route is stated
   as unrecorded, because silently choosing one would change the legal basis
   on which a partner acts. */

export type LegalRouteCode =
  | 'reliance' | 'outsourced_cdd' | 'independent_cdd' | 'information_share_only';

export const ROUTE_LABEL: Record<LegalRouteCode, string> = {
  reliance: 'Section 37A reliance',
  outsourced_cdd: 'Outsourced CDD — written arrangement',
  independent_cdd: 'Independent CDD',
  information_share_only: 'Information sharing only',
};

/** The one-line explanation an operator needs beside the label. */
export const ROUTE_EXPLANATION: Record<LegalRouteCode, string> = {
  reliance:
    'The partner may rely on this Passport under section 37A. It remains responsible for its own AML/CTF obligations.',
  outsourced_cdd:
    'CDD is performed under a written arrangement on the partner’s behalf. The partner remains responsible for its own AML/CTF obligations.',
  independent_cdd:
    'The partner records its own independent CDD determination using the information it is authorised to see.',
  information_share_only:
    'Authorised information is shared for the transaction. This route creates no statutory reliance.',
};

export function routeLabel(route: string | null | undefined): string {
  if (!route) return 'Legal route not recorded';
  return ROUTE_LABEL[route as LegalRouteCode] ?? 'Legal route not recorded';
}

/**
 * §13 — the PARTNER-facing headline for the basis on which its organisation
 * may act, shown on the Passport strip in each portal.
 *
 * Deliberately not a generic "AML compliant" badge: that phrase asserts a
 * conclusion nobody reached and hides the only thing the partner needs to
 * know, which is what it is entitled to do with this record. An unrecognised
 * or absent route reports itself as unrecorded — it is never rounded to the
 * nearest route in either direction.
 */
export const ROUTE_HEADLINE: Record<LegalRouteCode, string> = {
  reliance: 'Section 37A reliance available',
  outsourced_cdd: 'Outsourced CDD — written arrangement',
  independent_cdd: 'Independent CDD',
  information_share_only: 'Information sharing only',
};

export function routeHeadline(route: string | null | undefined): string {
  if (!route) return 'Legal basis not recorded';
  return ROUTE_HEADLINE[route as LegalRouteCode] ?? 'Legal basis not recorded';
}

export function routeExplanation(route: string | null | undefined): string {
  if (!route) {
    return 'No legal route is recorded on this partner’s link to the matter, so nothing may be distributed under it yet.';
  }
  return (
    ROUTE_EXPLANATION[route as LegalRouteCode] ??
    'No legal route is recorded on this partner’s link to the matter, so nothing may be distributed under it yet.'
  );
}

/** Whether the route the SERVER recorded is a statutory reliance route. */
export function isRelianceRoute(route: string | null | undefined): boolean {
  return route === 'reliance' || route === 'outsourced_cdd';
}

/* ── blockers → what the operator must do ────────────────────────────────
   Each blocker gets a short business title and a next action. The engine
   already ships operator sentences in `messages`; these titles are the
   scannable form for a card, and the two are shown together rather than one
   replacing the other. */

export const BLOCKER_TITLE: Record<DistributionBlocker, string> = {
  PASSPORT_NOT_ISSUED: 'Passport not issued',
  PASSPORT_REFRESH_REQUIRED: 'Refresh outstanding',
  PASSPORT_SUSPENDED: 'Passport not current',
  PASSPORT_SUPERSEDED: 'Superseded version',
  PARTNER_LINK_REQUIRED: 'Partner not linked to this matter',
  PARTNER_CLASSIFICATION_REQUIRED: 'Partner not classified',
  PORTAL_MEMBERSHIP_REQUIRED: 'Portal not connected',
  CLIENT_SHARING_CONSENT_REQUIRED: 'Client sharing consent missing',
  CDD_ARRANGEMENT_REQUIRED: 'CDD arrangement required',
  ARRANGEMENT_ASSESSMENT_REQUIRED: 'Arrangement assessment required',
  ARRANGEMENT_REVIEW_OVERDUE: 'Arrangement review overdue',
  DISCLOSURE_CONFIGURATION_REQUIRED: 'Disclosure not configured',
  EVIDENCE_AVAILABILITY_INCOMPLETE: 'Evidence package incomplete',
  LEGAL_ROUTE_NOT_RECORDED: 'Legal route not recorded',
  DISTRIBUTION_NOT_ENABLED: 'Distribution not enabled',
};

/**
 * The two blockers the engine treats as reportable rather than fatal. Kept
 * here so a card can present them as advisories without re-deciding
 * readiness — `ready` is still the server's answer, never this list.
 */
export const ADVISORY_BLOCKERS: DistributionBlocker[] = [
  'DISCLOSURE_CONFIGURATION_REQUIRED',
  'EVIDENCE_AVAILABILITY_INCOMPLETE',
];

export function isAdvisory(b: DistributionBlocker): boolean {
  return ADVISORY_BLOCKERS.includes(b);
}

/* ── distribution state → operator wording ───────────────────────────────── */

export type StateTone = 'ok' | 'info' | 'warn' | 'bad' | 'na';

export const STATE_LABEL: Record<DistributionState, string> = {
  READY: 'Ready to share',
  ALREADY_CURRENT: 'Already current',
  NEW_VERSION_AVAILABLE: 'New version available',
  GRANT_EXPIRED: 'Access expired',
  GRANT_REVOKED: 'Access revoked',
  REFRESH_REQUIRED: 'Refresh required',
  ACTION_REQUIRED: 'Action required',
};

export const STATE_TONE: Record<DistributionState, StateTone> = {
  READY: 'ok',
  ALREADY_CURRENT: 'info',
  NEW_VERSION_AVAILABLE: 'warn',
  GRANT_EXPIRED: 'warn',
  GRANT_REVOKED: 'bad',
  REFRESH_REQUIRED: 'warn',
  ACTION_REQUIRED: 'warn',
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state as DistributionState] ?? 'Action required';
}

export function stateTone(state: string): StateTone {
  return STATE_TONE[state as DistributionState] ?? 'warn';
}

/* ── the readiness object, structurally ───────────────────────────────────
   Declared here rather than imported wholesale so the presentation layer
   depends on the FIELDS it reads and nothing more. */

export type ReadinessView = {
  partner: {
    org_id: string | null;
    org_name: string | null;
    portal_type: string | null;
    relationship_role: string | null;
    purpose: string | null;
    classification_status: string | null;
  };
  legal_route: string | null;
  passport: {
    attestation_id: string | null;
    version: number | null;
    payload_sha256: string | null;
    issued_at: string | null;
    state_code: string;
  };
  state: string;
  ready: boolean;
  blockers: DistributionBlocker[];
  messages: string[];
  reliance_code: string | null;
  evidence: {
    available: EvidenceClass[];
    unavailable: EvidenceClass[];
    delivery: 'available_now' | 'request_required' | 'none';
  };
  next_actions: string[];
};

/* ── portal naming ───────────────────────────────────────────────────────── */

export const PORTAL_LABEL: Record<string, string> = {
  finance: 'Finance Portal',
  solicitor: 'Solicitor / Conveyancer Portal',
  conveyancer: 'Solicitor / Conveyancer Portal',
  builder: 'Builder / Developer Portal',
  developer: 'Builder / Developer Portal',
  builder_developer: 'Builder / Developer Portal',
  client: 'Client Portal',
};

export function portalLabel(portal: string | null | undefined): string {
  if (!portal) return 'Portal not connected';
  return PORTAL_LABEL[portal] ?? `${portal.replace(/_/g, ' ')} portal`;
}

/* ── the readiness checklist on a partner card (§5) ───────────────────────
   Each row is a fact the SERVER established, expressed as a tick or an
   outstanding item. A row is "outstanding" only because a matching blocker is
   present — never because this file re-tested the condition. */

export type ChecklistRow = {
  label: string;
  value: string;
  tone: StateTone;
};

/** The blocker that makes each checklist row outstanding, if any. */
const ROW_BLOCKERS: Array<{ label: string; ok: string; blocker: DistributionBlocker }> = [
  { label: 'Portal connected', ok: 'Connected', blocker: 'PORTAL_MEMBERSHIP_REQUIRED' },
  { label: 'Partner classified', ok: 'Classified', blocker: 'PARTNER_CLASSIFICATION_REQUIRED' },
  { label: 'Partner linked to matter', ok: 'Linked', blocker: 'PARTNER_LINK_REQUIRED' },
  { label: 'Client sharing consent', ok: 'Recorded', blocker: 'CLIENT_SHARING_CONSENT_REQUIRED' },
];

/** Rows that only make sense on a statutory reliance route. */
const RELIANCE_ROW_BLOCKERS: Array<{ label: string; ok: string; blocker: DistributionBlocker }> = [
  { label: 'CDD arrangement', ok: 'Active', blocker: 'CDD_ARRANGEMENT_REQUIRED' },
  { label: 'Arrangement assessment', ok: 'Current', blocker: 'ARRANGEMENT_ASSESSMENT_REQUIRED' },
  { label: 'Arrangement review', ok: 'Current', blocker: 'ARRANGEMENT_REVIEW_OVERDUE' },
];

export function readinessChecklist(r: ReadinessView): ChecklistRow[] {
  const has = (b: DistributionBlocker) => r.blockers.includes(b);
  const rows: ChecklistRow[] = ROW_BLOCKERS.map(({ label, ok, blocker }) => ({
    label,
    value: has(blocker) ? BLOCKER_TITLE[blocker] : ok,
    tone: has(blocker) ? ('warn' as StateTone) : ('ok' as StateTone),
  }));

  // Arrangement rows are shown for reliance routes, and shown as
  // "Not applicable" elsewhere — an information-share partner is not failing
  // an arrangement test, it is not taking one.
  for (const { label, ok, blocker } of RELIANCE_ROW_BLOCKERS) {
    if (!isRelianceRoute(r.legal_route)) {
      rows.push({ label, value: 'Not applicable', tone: 'na' });
    } else {
      rows.push({
        label,
        value: has(blocker) ? BLOCKER_TITLE[blocker] : ok,
        tone: has(blocker) ? 'warn' : 'ok',
      });
    }
  }

  rows.push({
    label: 'Passport',
    value: passportSummary(r),
    tone: passportTone(r),
  });
  rows.push({
    label: 'Evidence package',
    value: evidenceSummary(r),
    tone: r.evidence.available.length === 0 ? 'warn' : 'ok',
  });
  rows.push({
    label: 'Legal route',
    value: routeLabel(r.legal_route),
    tone: r.legal_route ? (isRelianceRoute(r.legal_route) ? 'ok' : 'info') : 'warn',
  });
  rows.push({
    label: 'Current distribution',
    value: distributionSummary(r),
    tone: stateTone(r.state),
  });
  return rows;
}

export function passportSummary(r: ReadinessView): string {
  if (!r.passport.version) return 'Not issued';
  const v = `v${r.passport.version}`;
  if (r.blockers.includes('PASSPORT_SUPERSEDED')) return `${v} · Superseded`;
  if (r.blockers.includes('PASSPORT_SUSPENDED')) return `${v} · Not current`;
  if (r.blockers.includes('PASSPORT_REFRESH_REQUIRED')) return `${v} · Refresh outstanding`;
  return `${v} · Current`;
}

function passportTone(r: ReadinessView): StateTone {
  if (!r.passport.version) return 'warn';
  if (
    r.blockers.includes('PASSPORT_SUPERSEDED') ||
    r.blockers.includes('PASSPORT_SUSPENDED') ||
    r.blockers.includes('PASSPORT_REFRESH_REQUIRED')
  ) return 'warn';
  return 'ok';
}

export function evidenceSummary(r: ReadinessView): string {
  const n = r.evidence.available.length;
  if (n === 0) return 'Nothing authorised yet';
  if (r.evidence.delivery === 'request_required') return `${n} categories · request required`;
  if (r.evidence.unavailable.length > 0) return `${n} categories · limited`;
  return `${n} categories · ready`;
}

export function distributionSummary(r: ReadinessView): string {
  switch (r.state) {
    case 'ALREADY_CURRENT': return 'Shared — current version';
    case 'NEW_VERSION_AVAILABLE': return 'Shared — earlier version';
    case 'GRANT_EXPIRED': return 'Shared — access expired';
    case 'GRANT_REVOKED': return 'Access revoked';
    case 'READY': return 'Not yet shared';
    default: return 'Not yet shared';
  }
}

/* ── the action a card offers (§5) ────────────────────────────────────────
   The verb changes with the route, because "Link & Share Passport" would
   misdescribe an information-only distribution. Whether the button is
   ENABLED is `r.ready` — the server's word, unmodified. */

export function primaryActionLabel(r: ReadinessView): string {
  if (r.state === 'ALREADY_CURRENT') return 'Already shared';
  if (!r.ready) return 'Resolve outstanding items';
  // Re-granting after a deliberate revocation is a different act from a first
  // share, and the button says so. An operator must never reinstate revoked
  // access believing they are sharing for the first time.
  if (r.state === 'GRANT_REVOKED') return 'Reinstate & share Passport';
  if (isRelianceRoute(r.legal_route)) return 'Link & Share Passport';
  if (r.legal_route === 'independent_cdd') return 'Share for independent CDD';
  return 'Share authorised Passport information';
}

export function canShare(r: ReadinessView): boolean {
  return r.ready && r.state !== 'ALREADY_CURRENT';
}

/**
 * Whether a partner belongs in a BULK "share with all eligible" action.
 *
 * Deliberately narrower than `canShare`: a grant that was revoked was revoked
 * on purpose, and sweeping it back up in a bulk action would reinstate access
 * somebody decided to withdraw — without the operator ever naming that
 * partner. Reinstatement stays a deliberate, single-partner act.
 *
 * This is the UI being STRICTER than the server, which is always permitted.
 * It is never the reverse: nothing here can make a partner shareable that the
 * server did not mark ready.
 */
export function isBulkEligible(r: ReadinessView): boolean {
  return canShare(r) && r.state !== 'GRANT_REVOKED';
}

/* ── the cross-partner matrix (§6) ────────────────────────────────────────
   A UX representation of canonical state. Every cell is read off a readiness
   object; nothing here encodes a permission. */

export type MatrixCellState = 'available' | 'unavailable' | 'not_authorised';

export const MATRIX_CELL_LABEL: Record<MatrixCellState, string> = {
  available: 'Shared',
  unavailable: 'Not available yet',
  not_authorised: 'Not authorised',
};

export function evidenceCellState(r: ReadinessView, cls: EvidenceClass): MatrixCellState {
  if (r.evidence.available.includes(cls)) return 'available';
  if (r.evidence.unavailable.includes(cls)) return 'unavailable';
  // Neither list: the arrangement's scope does not reach this class. This is a
  // statement about AUTHORITY, never about whether a record exists.
  return 'not_authorised';
}

export type MatrixRow = {
  label: string;
  cells: Array<{ orgId: string | null; value: string; tone: StateTone }>;
};

export function buildMatrix(partners: ReadinessView[]): MatrixRow[] {
  const cell = (value: string, tone: StateTone, p: ReadinessView) =>
    ({ orgId: p.partner.org_id, value, tone });

  const rows: MatrixRow[] = [
    {
      label: 'Portal',
      cells: partners.map((p) => cell(portalLabel(p.partner.portal_type), 'info', p)),
    },
    {
      label: 'Partner linked',
      cells: partners.map((p) =>
        p.blockers.includes('PARTNER_LINK_REQUIRED')
          ? cell('Not linked', 'warn', p)
          : cell('Linked', 'ok', p)),
    },
    {
      label: 'Portal connected',
      cells: partners.map((p) =>
        p.blockers.includes('PORTAL_MEMBERSHIP_REQUIRED')
          ? cell('Not connected', 'warn', p)
          : cell('Connected', 'ok', p)),
    },
    {
      label: 'Passport',
      cells: partners.map((p) => cell(passportSummary(p), passportTone(p), p)),
    },
    {
      label: 'Arrangement',
      cells: partners.map((p) =>
        !isRelianceRoute(p.legal_route)
          ? cell('Not applicable', 'na', p)
          : p.blockers.includes('CDD_ARRANGEMENT_REQUIRED')
            ? cell('Required', 'warn', p)
            : cell('Active', 'ok', p)),
    },
    {
      label: 'Assessment',
      cells: partners.map((p) =>
        !isRelianceRoute(p.legal_route)
          ? cell('Not applicable', 'na', p)
          : p.blockers.includes('ARRANGEMENT_ASSESSMENT_REQUIRED') ||
            p.blockers.includes('ARRANGEMENT_REVIEW_OVERDUE')
            ? cell('Required', 'warn', p)
            : cell('Current', 'ok', p)),
    },
  ];

  for (const cls of EVIDENCE_CLASS_ORDER) {
    rows.push({
      label: EVIDENCE_CATEGORY_LABEL[cls],
      cells: partners.map((p) => {
        const s = evidenceCellState(p, cls);
        return cell(
          MATRIX_CELL_LABEL[s],
          s === 'available' ? 'ok' : s === 'unavailable' ? 'warn' : 'na',
          p,
        );
      }),
    });
  }

  rows.push({
    label: 'Legal route',
    cells: partners.map((p) =>
      cell(routeLabel(p.legal_route), p.legal_route ? (isRelianceRoute(p.legal_route) ? 'ok' : 'info') : 'warn', p)),
  });
  rows.push({
    label: 'Distribution',
    cells: partners.map((p) => cell(stateLabel(p.state), stateTone(p.state), p)),
  });

  return rows;
}

/* ── share results (§7 step 7) ────────────────────────────────────────────
   A bulk operation reports EVERY partner individually. A shared outcome names
   the route it was shared under, because "Shared" alone loses the legal basis
   the operator just chose. */

export type ShareOutcome = {
  partner_org_id: string | null;
  state: string;
  shared: boolean;
  code?: string | null;
  note?: string | null;
  grant_id?: string | null;
  attestation_version?: number | null;
};

export function outcomeLabel(o: ShareOutcome, route: string | null | undefined): string {
  if (o.shared) {
    if (route === 'reliance') return 'Shared — section 37A reliance';
    if (route === 'outsourced_cdd') return 'Shared — outsourced CDD';
    if (route === 'independent_cdd') return 'Shared — independent CDD';
    if (route === 'information_share_only') return 'Shared — information only';
    return 'Shared';
  }
  if (o.state === 'ALREADY_CURRENT') return 'Already current';
  if (o.code === 'grant_write_failed') return 'Failed';
  if (o.state === 'GRANT_REVOKED') return 'Blocked — access revoked';
  return 'Action required';
}

export function outcomeTone(o: ShareOutcome): StateTone {
  if (o.shared) return 'ok';
  if (o.state === 'ALREADY_CURRENT') return 'info';
  if (o.code === 'grant_write_failed' || o.state === 'GRANT_REVOKED') return 'bad';
  return 'warn';
}

/* ── partner discovery (§4) ──────────────────────────────────────────────
   A partner reaches this surface because a canonical link resolved it. A
   transaction that names a firm in free text resolves to NOTHING, and the
   honest answer is to say a mapping is required — never to mint an
   organisation from a string. */

export type UnresolvedParty = {
  name: string;
  role: string | null;
};

export function unresolvedPartyNotice(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? 'One party named on this matter has not been matched to a partner organisation. Resolve the mapping in partner administration before it can receive anything.'
    : `${count} parties named on this matter have not been matched to partner organisations. Resolve their mappings in partner administration before they can receive anything.`;
}

/* ── summary line ─────────────────────────────────────────────────────────── */

export function summaryLine(s: {
  total: number; ready: number; already_current: number; blocked: number;
}): string {
  if (s.total === 0) return 'No partner organisations are linked to this matter yet.';
  const parts: string[] = [];
  if (s.ready > 0) parts.push(`${s.ready} ready to share`);
  if (s.already_current > 0) parts.push(`${s.already_current} already current`);
  if (s.blocked > 0) parts.push(`${s.blocked} needing action`);
  return parts.join(' · ') || 'Nothing to distribute yet.';
}
