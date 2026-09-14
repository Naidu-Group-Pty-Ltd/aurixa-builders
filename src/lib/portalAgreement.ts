/**
 * The Portal Access, Confidentiality, Privacy and AML/CTF Compliance Passport
 * Agreement, as it appears to a partner organisation in any portal.
 *
 * One agreement, one set of acknowledgments, three portals. The document itself
 * lives in `portal_terms_versions`, one row per portal so each carries its own
 * version, hash and acceptance history — but the text is the same text, and the
 * acknowledgments below are the same four everywhere. Solicitors, builders and
 * finance partners are all "the Partner Organisation" in that document; giving
 * each portal its own wording would mean three agreements drifting apart under
 * one name, which is the failure this module exists to prevent.
 *
 * The wording is the agreement's own. It is duplicated here rather than parsed
 * out of the stored Markdown because these four are the interface contract:
 * every `*-portal-verify` function refuses an acceptance that does not assert
 * all four keys and stores the asserted keys as the acknowledgment history.
 * Changing a key here without changing `REQUIRED_TERMS_ACKNOWLEDGEMENTS` in
 * `supabase/functions/_shared/portalAgreement.ts` locks every partner out of
 * every portal, which is why both lists carry this note. Changing the *wording*
 * is a change to the agreement: publish a new terms version, do not edit this
 * in place.
 *
 * A fifth acknowledgment, "Independent AML/CTF responsibility", was withdrawn by
 * the operator in version 2026-08-07. Only the tick box went: section 9 of the
 * agreement still puts assessing, approving, recording and re-checking reliance
 * on the Partner Organisation, and section 7 still makes statutory reliance
 * conditional. Do not reinstate the key here without publishing a terms version
 * whose text carries the acknowledgment again.
 */
export const PORTAL_TERMS_ACKNOWLEDGEMENTS = [
  {
    key: 'global_confidentiality_privacy',
    heading: 'Global confidentiality and privacy',
    statement:
      'I acknowledge that all information made available through the Portal is confidential and may include personal, sensitive, commercially confidential or legally privileged information. I agree that my organisation will access, use, protect and disclose that information only for an authorised client, transaction and lawful professional purpose.',
  },
  {
    key: 'authority_binding_acceptance',
    heading: 'Authority and binding acceptance',
    statement:
      'I confirm that I am authorised to accept this Agreement and legally bind the Partner Organisation identified above. I agree that my electronic acceptance will constitute execution of this Agreement on behalf of the Partner Organisation.',
  },
  {
    key: 'portal_access',
    heading: 'Portal access',
    statement:
      'I agree that the Partner Organisation will access and use the Portal only for authorised matters and will comply with the Portal access, privacy, confidentiality, security and audit requirements set out in this Agreement.',
  },
  {
    key: 'binding_amlctf_arrangement',
    heading: 'Binding AML/CTF arrangement',
    statement:
      'I acknowledge and agree that, where the applicable eligibility and legislative requirements are satisfied, this Agreement is intended to constitute a binding customer due-diligence agreement or arrangement between the Originating Organisation and Partner Organisation for the purposes of section 37A of the AML/CTF Act and section 6-29 of the AML/CTF Rules.',
  },
] as const;

export type PortalAcknowledgementKey = (typeof PORTAL_TERMS_ACKNOWLEDGEMENTS)[number]['key'];

/**
 * The same four acknowledgments, written for the LINK channel.
 *
 * A partner outside the three portals is never given a portal account: they
 * receive one time-limited link to a Compliance Passport. Asking them to
 * acknowledge obligations about a Portal they have no access to is both
 * confusing and, for the conduct clauses, meaningless — so the statements
 * under the first and third keys describe what is actually granted.
 *
 * The KEYS are deliberately identical. They are internal identifiers, not
 * prose: the server's required-acknowledgment check, every stored
 * acceptance and all three portals are untouched by this. Only the words a
 * direct partner reads and assents to change, and those words are the ones
 * printed on their executed agreement.
 */
export const DIRECT_TERMS_ACKNOWLEDGEMENTS = [
  {
    key: 'global_confidentiality_privacy',
    heading: 'Global confidentiality and privacy',
    statement:
      'I acknowledge that all information made available through the Compliance Passport Link is confidential and may include personal, sensitive, commercially confidential or legally privileged information. I agree that my organisation will access, use, protect and disclose that information only for an authorised client, transaction and lawful professional purpose.',
  },
  {
    key: 'authority_binding_acceptance',
    heading: 'Authority and binding acceptance',
    statement:
      'I confirm that I am authorised to accept this Agreement and legally bind the Partner Organisation identified above. I agree that my electronic acceptance will constitute execution of this Agreement on behalf of the Partner Organisation.',
  },
  {
    key: 'portal_access',
    heading: 'Compliance Passport Link access',
    statement:
      'I acknowledge that access is provided as a single, time-limited link rather than a portal account, that the link is itself the credential and must not be forwarded outside authorised personnel, and that it will expire — ordinarily after 90 days — unless a replacement is issued.',
  },
  {
    key: 'binding_amlctf_arrangement',
    heading: 'Binding AML/CTF arrangement',
    statement:
      'I acknowledge and agree that, where the applicable eligibility and legislative requirements are satisfied, this Agreement is intended to constitute a binding customer due-diligence agreement or arrangement between the Originating Organisation and Partner Organisation for the purposes of section 37A of the AML/CTF Act and section 6-29 of the AML/CTF Rules.',
  },
] as const;

/** The link channel's own notice, naming the instrument it actually is. */
export const DIRECT_AGREEMENT_ACCEPTANCE_NOTICE =
  'By proceeding, you confirm that you are authorised to bind the Partner Organisation and accept this '
  + 'AML/CTF Compliance Passport Link Agreement on its behalf. Statutory reliance is available only where '
  + 'the applicable eligibility, assessment, information-access and record-keeping requirements are '
  + 'satisfied — completing your own independent customer due diligence remains available at any time.';

export const DIRECT_AGREEMENT_TITLE = 'AML/CTF Compliance Passport Link Agreement';

/** The agreement's own notice, shown immediately above the accept button. */
export const PORTAL_AGREEMENT_ACCEPTANCE_NOTICE =
  'By proceeding, you confirm that you are authorised to bind the Partner Organisation and accept this '
  + 'Portal Access, Confidentiality, Privacy and AML/CTF Compliance Passport Agreement on its behalf. '
  + 'Statutory reliance is available only where the applicable eligibility, assessment, information-access '
  + 'and record-keeping requirements are satisfied.';

/** The label the agreement itself names in section 1. */
export const PORTAL_AGREEMENT_ACCEPT_LABEL = 'Accept Binding Agreement & Continue';

export const PORTAL_AGREEMENT_TITLE =
  'Portal Access, Confidentiality, Privacy and AML/CTF Compliance Passport Agreement';

/** A terms version as every portal's `get_governance` returns it. */
export interface PortalTermsVersion {
  title: string;
  version: string;
  content_markdown: string;
  document_hash?: string | null;
}
