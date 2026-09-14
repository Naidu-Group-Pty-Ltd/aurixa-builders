/**
 * Builder / Developer Portal client-side API wrapper.
 *
 * Modelled directly on `src/lib/solicitorPortal.ts`: cookie-authenticated edge
 * invocation using an HttpOnly portal-scoped session, so the Command Centre,
 * Client Portal, Finance Portal, Solicitor Portal and Builder Portal never
 * share a session.
 *
 * No function here takes a token argument, reads Web Storage, or sets an
 * authentication header. The session travels only as the
 * `__Host-builder_session_token` cookie, attached by `credentials: 'include'`.
 */

import type { PortalAcknowledgementKey } from './portalAgreement';

/**
 * NETWORK EDITION — the one deliberate difference from the prime's file.
 *
 * The prime's transport carried the Supabase URL and anon key into every
 * browser bundle and paid for it with a `SameSite=None` session cookie. Here
 * the API is SAME-ORIGIN: every call goes to `/fn/<name>` on
 * builders.aurixasystems.com.au, and one server route — allowlisting
 * function names explicitly, never a wildcard — forwards method, body and
 * cookies, injects the anon key server-side, and returns Set-Cookie
 * verbatim. The browser therefore holds NO Supabase credential of any kind,
 * `__Host-builder_session_token` moves to SameSite=Lax, and the
 * ambient-CSRF class disappears (enforceCsrf stays anyway — extraction plan
 * §1, "the /fn/* proxy").
 */
const FN_PATH_PREFIX = '/fn';


export interface BuilderPortalUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  job_title: string | null;
  has_accepted_terms: boolean;
  has_completed_onboarding: boolean;
  must_change_password: boolean;
  /** When the mailbox was proven; null gates the portal (network edition). */
  email_verified_at: string | null;
  current_terms_version: string | null;
  has_accepted_current_terms: boolean;
  has_completed_mandatory_onboarding: boolean;
}

export interface BuilderOrganisation {
  organisation_id: string;
  legal_name: string;
  trading_name: string | null;
  org_type: string;
  membership_role: string;
  is_primary: boolean;
}

export type BuilderPermissionMatrix = Record<
  string,
  { view: boolean; edit: boolean; delete: boolean }
>;

export type BuilderGovernanceReason =
  | 'auth_required'
  | 'email_verification_required'
  | 'password_rotation_required'
  | 'organisation_selection_required'
  | 'terms_acceptance_required'
  | 'onboarding_required'
  | null;

export interface BuilderSessionSnapshot {
  valid: boolean;
  user: BuilderPortalUser | null;
  organisations: BuilderOrganisation[];
  active_organisation: BuilderOrganisation | null;
  requires_organisation_selection: boolean;
  permissions: BuilderPermissionMatrix;
  governance: BuilderGovernanceReason;
  previous_seen_at: string | null;
}

export interface BuilderTermsVersion {
  id: string;
  version: string;
  title: string;
  content_markdown: string;
  /** SHA-256 of the text, shown on the consent wall and recorded with the acceptance. */
  document_hash?: string | null;
  effective_at: string;
}

export interface BuilderOnboardingStep {
  step_key: string;
  mandatory: boolean;
  completed_at: string | null;
}

export interface BuilderPortalError {
  message: string;
  code?: string;
  status?: number;
}

export interface BuilderInvokeResult<T> {
  data: T | null;
  error: BuilderPortalError | null;
}

/**
 * Single transport for every Builder Portal call.
 *
 * `credentials: 'include'` is what carries the session. There is deliberately no
 * parameter for a token: a caller cannot supply one even by mistake.
 */
export async function invokeBuilderFunction<T = any>(
  functionName: string,
  body: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<BuilderInvokeResult<T>> {
  try {
    const response = await fetch(`${FN_PATH_PREFIX}/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Portal-Request': 'builder-portal',
      },
      credentials: 'include',
      signal: options.signal,
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        data,
        error: {
          message: (data as any)?.error || `HTTP ${response.status}`,
          code: (data as any)?.code,
          status: response.status,
        },
      };
    }
    return { data, error: null };
  } catch (error: any) {
    /**
     * THE REQUEST NEVER PRODUCED A RESPONSE, and the browser cannot say why.
     *
     * `fetch` rejects identically for an offline client, a DNS failure, a CORS
     * refusal and — the case this wording exists for — an edge worker KILLED
     * mid-request on its resource limit, which emits no body and no CORS
     * headers. The browser surfaces all of them as "Failed to fetch", which is
     * a statement about this tab and not about the server.
     *
     * That mattered in production on 27 Aug 2026: a stock import was killed
     * after it had already committed the upload and every property in it, the
     * portal reported "Failed to fetch", and the builder — reasonably reading
     * that as "nothing happened" — imported the same list again.
     *
     * So the message says what is actually known: the request did not
     * complete, and whether the work happened is UNDETERMINED. `abort` is
     * separated because that one the caller did on purpose.
     */
    const aborted = error?.name === 'AbortError';
    return {
      data: null,
      error: {
        message: aborted
          ? 'The request was cancelled.'
          : 'The server did not answer this request, so whether it completed is '
            + 'unknown. Refresh before trying again.',
        code: aborted ? 'request_aborted' : 'transport_failed',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export function builderLogin(email: string, password: string, turnstileToken?: string) {
  return invokeBuilderFunction('builder-portal-login', {
    email,
    password,
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
  });
}

export function builderLogout() {
  return invokeBuilderFunction('builder-portal-logout');
}

/** Restore the session after a page refresh. */
export function builderCurrentSession(options: { signal?: AbortSignal } = {}) {
  return invokeBuilderFunction<BuilderSessionSnapshot>('builder-portal-verify', {}, options);
}

export function builderValidateInvite(token: string) {
  return invokeBuilderFunction('builder-portal-accept-invite', { action: 'validate', token });
}

export function builderAcceptInvite(token: string, password: string) {
  return invokeBuilderFunction('builder-portal-accept-invite', { token, password });
}

/** Authenticated rotation. The server re-issues the cookie; nothing is stored here. */
export function builderChangePassword(currentPassword: string, newPassword: string) {
  return invokeBuilderFunction('builder-portal-change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export interface BuilderRegistrationInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  job_title?: string;
  organisation: {
    legal_name: string;
    trading_name?: string;
    org_type: 'developer' | 'builder' | 'builder_developer' | 'sales_representative';
    abn?: string;
    state?: string;
  };
  turnstileToken?: string;
}

/**
 * Self-registration (network edition). The server answers the same generic
 * 202 whether the address is fresh or already registered — the difference
 * happens in the mailbox — so a caller renders "check your inbox" and never
 * a verdict about the address.
 */
export function builderRegister(input: BuilderRegistrationInput) {
  const { turnstileToken, ...rest } = input;
  return invokeBuilderFunction('builder-portal-register', {
    ...rest,
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
  });
}

/** Consume an emailed verification token. No session needed. */
export function builderVerifyEmail(token: string) {
  return invokeBuilderFunction<{ success?: boolean; verified?: boolean; already_verified?: boolean; expired?: boolean }>(
    'builder-portal-verify-email', { token },
  );
}

/** Ask for a fresh verification email (signed-in, still-unverified caller). */
export function builderResendVerificationEmail() {
  return invokeBuilderFunction<{ success?: boolean; sent?: boolean; already_verified?: boolean }>(
    'builder-portal-verify-email', { action: 'resend' },
  );
}

/**
 * Invite a colleague into the ACTIVE organisation (the admin-plane lift).
 * Owner/administrator only — the server enforces; the card mirrors.
 */
export function builderInviteTeamMember(input: {
  name: string;
  email: string;
  membership_role?: string;
}) {
  return invokeBuilderFunction<{
    success?: boolean;
    email_sent?: boolean;
    expires_at?: string;
    invite_url?: string;
  }>('builder-portal-invite', { action: 'invite', ...input });
}

export function builderRequestPasswordReset(email: string) {
  return invokeBuilderFunction('builder-portal-forgot-password', { email });
}

export function builderVerifyResetCode(email: string, otp: string) {
  return invokeBuilderFunction('builder-portal-reset-password', { action: 'verify_otp', email, otp });
}

export function builderResetPassword(email: string, otp: string, newPassword: string) {
  return invokeBuilderFunction('builder-portal-reset-password', {
    email, otp, new_password: newPassword,
  });
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export function builderLoadGovernance() {
  return invokeBuilderFunction<{
    terms: BuilderTermsVersion | null;
    terms_accepted: boolean;
    steps: BuilderOnboardingStep[];
  }>('builder-portal-verify', { action: 'get_governance' });
}

/**
 * The acknowledgments the accepting person asserted travel with the acceptance:
 * they are contractual statements, and the agreement records them as
 * acknowledgment history. The server rejects an acceptance that is missing any
 * of them, so this argument is not advisory.
 */
export function builderAcceptTerms(acknowledgements: PortalAcknowledgementKey[]) {
  return invokeBuilderFunction('builder-portal-verify', {
    action: 'accept_current_terms',
    acknowledgements,
  });
}

export function builderCompleteOnboarding(stepKey?: string) {
  return invokeBuilderFunction<{ success: boolean; onboarding_complete: boolean }>('builder-portal-verify', {
    action: 'complete_onboarding',
    ...(stepKey ? { step_key: stepKey } : {}),
  });
}

// ---------------------------------------------------------------------------
// Organisations
//
// The list always comes from the server. Selecting one sends a REQUEST; the
// server re-verifies membership and holds the result on the session row, so a
// forged value cannot switch organisation.
// ---------------------------------------------------------------------------

export function builderSelectOrganisation(organisationId: string) {
  return invokeBuilderFunction<{ success: boolean; active_organisation: BuilderOrganisation }>(
    'builder-portal-verify',
    { action: 'select_organisation', organisation_id: organisationId },
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export function builderListSessions() {
  return invokeBuilderFunction('builder-portal-verify', { action: 'list_sessions' });
}

export function builderRevokeSession(sessionId: string) {
  return invokeBuilderFunction('builder-portal-verify', { action: 'revoke_session', session_id: sessionId });
}

export function builderRevokeOtherSessions() {
  return invokeBuilderFunction('builder-portal-verify', { action: 'revoke_other_sessions' });
}

/**
 * The cross-tab identity channel.
 *
 * `BroadcastChannel` rather than a `localStorage` key on purpose, and not only
 * to satisfy the portal's "no browser storage" rule: this signal PERSISTS
 * NOTHING. It carries `<builder_user_id>:<organisation_id>` to the tabs that
 * are open right now and leaves nothing behind for the next visitor to this
 * browser to read. The session itself stays in the HttpOnly
 * `__Host-builder_session_token` cookie, which JavaScript cannot read.
 *
 * It exists because that cookie is ONE name per origin, so signing into a
 * second builder account destroys the first tab's session without telling it.
 * See the listener in `useBuilderPortalAuth`.
 */
export const BUILDER_IDENTITY_CHANNEL = 'npc.builder.identity';
