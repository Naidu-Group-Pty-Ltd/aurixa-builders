import type { PortalAcknowledgementKey } from '@/lib/portalAgreement';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  builderAcceptInvite,
  builderAcceptTerms,
  builderChangePassword,
  builderCompleteOnboarding,
  builderCurrentSession,
  builderLogin,
  builderLogout,
  builderSelectOrganisation,
  type BuilderGovernanceReason,
  type BuilderOrganisation,
  type BuilderPermissionMatrix,
  type BuilderPortalUser,
  BUILDER_IDENTITY_CHANNEL,
} from '@/lib/builderPortal';
import { setActingOrganisation } from '@/lib/builderActingOrganisation';

/**
 * Builder / Developer Portal authentication provider.
 *
 * Mirrors `useSolicitorPortalAuth`: state is never assumed from a login
 * response, it is always re-read through the cookie-backed verifier so
 * governance comes from the server. The provider is mounted only under
 * `/builder/*` and shares nothing with the Solicitor provider.
 */

interface BuilderPortalAuthContextType {
  user: BuilderPortalUser | null;
  organisations: BuilderOrganisation[];
  activeOrganisation: BuilderOrganisation | null;
  permissions: BuilderPermissionMatrix;
  governance: BuilderGovernanceReason;
  requiresOrganisationSelection: boolean;
  loading: boolean;
  previousSeenAt: string | null;
  signIn: (email: string, password: string, turnstileToken?: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<{ error?: string }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ error?: string }>;
  acceptTerms: (acknowledgements: PortalAcknowledgementKey[]) => Promise<{ error?: string }>;
  completeOnboarding: (stepKey?: string) => Promise<{ error?: string }>;
  selectOrganisation: (organisationId: string) => Promise<{ error?: string }>;
  refresh: () => Promise<void>;
  can: (permissionKey: string, level?: 'view' | 'edit' | 'delete') => boolean;
}

const BuilderPortalAuthContext = createContext<BuilderPortalAuthContextType | undefined>(undefined);

export function BuilderPortalAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<BuilderPortalUser | null>(null);
  const [organisations, setOrganisations] = useState<BuilderOrganisation[]>([]);
  const [activeOrganisation, setActiveOrganisation] = useState<BuilderOrganisation | null>(null);
  const [permissions, setPermissions] = useState<BuilderPermissionMatrix>({});
  const [governance, setGovernance] = useState<BuilderGovernanceReason>(null);
  const [requiresOrganisationSelection, setRequiresOrganisationSelection] = useState(false);
  const [previousSeenAt, setPreviousSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const queryClient = useQueryClient();
  /**
   * Who the cached builder data belongs to: `<builder_user_id>:<organisation_id>`.
   * A ref rather than state because nothing renders from it — it exists only to
   * notice a change.
   */
  const cachedIdentity = useRef<string | null>(null);

  /**
   * THROW AWAY EVERY CACHED ANSWER THAT BELONGED TO SOMEBODY ELSE.
   *
   * MEASURED 11 SEPTEMBER 2026, reported as "a stock list uploaded under Kopi
   * Jantan Builders can be seen from a Bob The Builder account", and seen in
   * Bob's own Stock Lists page.
   *
   * The server was not the leak: every builder-portal query narrows to the
   * session's organisation, the accessible set comes from a SECURITY DEFINER
   * function scoped to the user, all four stock tables are RLS service-role
   * only and both buckets are private. The leak is HERE. React Query caches
   * one builder's data under keys that name no builder —
   * `['builder','stock','uploads',1]` — and `signOut` cleared this hook's
   * React state and nothing else. So:
   *
   *   sign in as Kopi Jantan   → cache fills under that key
   *   sign out                 → cache untouched
   *   sign in as Bob           → the page mounts, reads the SAME key, and
   *                              renders Kopi Jantan's stock lists
   *
   * before the refetch replaces them. One builder's commercial data drawn in
   * another builder's portal.
   *
   * It is fixed at the identity rather than at the key because
   * `builderKeys` has forty-odd entries — projects, units, transactions,
   * construction, documents, conversations — and every one of them is
   * organisation-blind in exactly the same way. Purging on the identity covers
   * all of them, and covers every key anybody adds later, which keying them
   * one by one would not.
   */
  const forgetCachedTenant = useCallback(() => {
    cachedIdentity.current = null;
    queryClient.removeQueries({ queryKey: ['builder'] });
  }, [queryClient]);

  const clearAuthState = useCallback(() => {
    setUser(null);
    setOrganisations([]);
    setActiveOrganisation(null);
    setActingOrganisation(null);
    setPermissions({});
    setGovernance(null);
    setRequiresOrganisationSelection(false);
    setPreviousSeenAt(null);
    forgetCachedTenant();
  }, [forgetCachedTenant]);

  const checkSession = useCallback(async () => {
    const { data, error } = await builderCurrentSession();
    if (error || !data?.valid || !data.user) {
      clearAuthState();
    } else {
      /*
       * AND THE SAME PURGE WHEN THE IDENTITY MOVES WITHOUT A SIGN-OUT: a user
       * who belongs to two organisations switching between them, or a second
       * account signed into the same tab. The cached rows are the previous
       * tenant's either way.
       */
      const identity = `${data.user.id}:${data.active_organisation?.organisation_id ?? ''}`;
      const identityChanged = cachedIdentity.current !== null
        && cachedIdentity.current !== identity;
      if (identityChanged) {
        queryClient.removeQueries({ queryKey: ['builder'] });
      }
      cachedIdentity.current = identity;
      /*
       * ANNOUNCE WHO THIS TAB IS, EVERY TIME — NOT ONLY WHEN IT CHANGED.
       *
       * This used to be `if (identityChanged)`, and that guard had a hole
       * exactly where it mattered most. `identityChanged` requires
       * `cachedIdentity.current !== null`, which is never true on a tab that
       * has just mounted — so THE TAB YOU SIGN IN ON announced nothing, and
       * that is the one tab whose login replaced the single `__Host-` cookie
       * for every other tab in the browser.
       *
       * MEASURED 12 SEPTEMBER 2026: sign-in to the second organisation at
       * 06:18:24 in a fresh tab, no broadcast, and the first tab was still
       * listing the first organisation's stock when its delete button was
       * pressed at 06:20:12 and again at 06:20:17. Both were answered 404,
       * correctly, about a stock list the operator could see on the screen.
       *
       * So the post is unconditional now, and the RECEIVER does the
       * comparing — see the listener below. Storing nothing: the identity
       * reaches the tabs open right now and leaves no trace for the next
       * person to use this browser. The session stays in the HttpOnly cookie.
       *
       * Wrapped because `BroadcastChannel` is absent in a few environments,
       * and a portal without it must still work — focus and visibilitychange
       * cover that case on their own.
       */
      try {
        const channel = new BroadcastChannel(BUILDER_IDENTITY_CHANNEL);
        channel.postMessage(identity);
        channel.close();
      } catch { /* no BroadcastChannel — focus and visibility still apply */ }

      setUser(data.user);
      setOrganisations(data.organisations ?? []);
      setActiveOrganisation(data.active_organisation ?? null);
      // Per-tab, so a write carries the organisation THIS tab is showing.
      setActingOrganisation(data.active_organisation?.organisation_id ?? null);
      setPermissions(data.permissions ?? {});
      setGovernance(data.governance ?? null);
      setRequiresOrganisationSelection(!!data.requires_organisation_selection);
      setPreviousSeenAt(data.previous_seen_at ?? null);
    }
    setLoading(false);
  }, [clearAuthState, queryClient]);

  useEffect(() => { void checkSession(); }, [checkSession]);

  /**
   * A TAB MUST NOTICE THAT IT IS NO LONGER WHO IT THINKS IT IS.
   *
   * REPORTED AND CONFIRMED 12 SEPTEMBER 2026: a stock list uploaded from a tab
   * showing one organisation landed in a different one. Traced through
   * the audit log — Kopi session last used 01:19:04, a Bob login at 01:21:28,
   * the upload at 01:22:32 attributed to Bob — and the server was right every
   * step of the way.
   *
   * `__Host-builder_session_token` is ONE cookie name per origin, so two
   * builder accounts cannot be signed in at once: the second login destroys
   * the first token and replaces it. Every already-open tab then sends the new
   * account's credential on `credentials: 'include'` while still rendering the
   * old organisation's name, stock and chrome — because `checkSession` ran
   * only on mount, and nothing here listened for anything.
   *
   * The purge above fixes "sign out, sign in as somebody else, same tab". It
   * cannot see "two tabs, one cookie", because the stale tab never asks again.
   *
   * So it asks again: on a message from another tab (BroadcastChannel
   * delivers only to OTHER contexts, which is exactly the case that was
   * blind), and when this tab is focused or made visible — the moment before
   * a person reaches for a button in a tab they left open.
   */
  useEffect(() => {
    /*
     * `focus` fires on every alt-tab, and each one would otherwise be a
     * request. A short floor keeps a person moving between windows from
     * hammering the endpoint while still being far below the time it takes to
     * reach for a button — the case this exists for. A BROADCAST IS NEVER
     * THROTTLED: it means another tab has just changed identity, which is the
     * one signal that must always be acted on.
     */
    const FOCUS_RECHECK_FLOOR_MS = 3_000;
    let lastChecked = 0;
    const recheck = () => { lastChecked = Date.now(); void checkSession(); };
    const recheckThrottled = () => {
      if (Date.now() - lastChecked >= FOCUS_RECHECK_FLOOR_MS) recheck();
    };
    const onVisible = () => { if (!document.hidden) recheckThrottled(); };
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(BUILDER_IDENTITY_CHANNEL);
      /*
       * AGREEMENT IS SILENCE. Every tab now posts its identity on every
       * settled session read, so a tab that already agrees must do nothing —
       * otherwise each post triggers a re-check which posts again, and two
       * healthy tabs would talk to each other for ever.
       *
       * A message that DIFFERS is the signal this whole mechanism exists for:
       * another tab holds the cookie now, and this one is rendering somebody
       * else's organisation until it asks. That is never throttled.
       *
       * `BroadcastChannel` delivers only to OTHER contexts, so this can never
       * hear itself — the comparison is against the tab that posted.
       */
      channel.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string' && event.data === cachedIdentity.current) return;
        recheck();
      };
    } catch { channel = null; }
    window.addEventListener('focus', recheckThrottled);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      channel?.close();
      window.removeEventListener('focus', recheckThrottled);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkSession]);

  const signIn = useCallback(async (email: string, password: string, turnstileToken?: string) => {
    const { data, error } = await builderLogin(email, password, turnstileToken);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Login failed' };
    }
    // Re-read through the cookie-backed verifier so governance state always
    // comes from the server, never from login response defaults.
    await checkSession();
    return {};
  }, [checkSession]);

  const signOut = useCallback(async () => {
    try {
      await builderLogout();
    } catch {
      /* best effort — always clear locally */
    }
    clearAuthState();
  }, [clearAuthState]);

  const acceptInvite = useCallback(async (token: string, password: string) => {
    const { data, error } = await builderAcceptInvite(token, password);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Could not accept this invite' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const { data, error } = await builderChangePassword(currentPassword, newPassword);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Could not change your password' };
    }
    // The server rotated the cookie and revoked every other session. Re-read so
    // `must_change_password` comes back cleared from the server, not guessed here.
    await checkSession();
    return {};
  }, [checkSession]);

  // The four acknowledgments are contractual statements, and the server refuses
  // an acceptance that is missing any of them, so they travel with the call.
  const acceptTerms = useCallback(async (acknowledgements: PortalAcknowledgementKey[]) => {
    const { data, error } = await builderAcceptTerms(acknowledgements);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Could not record your acceptance' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const completeOnboarding = useCallback(async (stepKey?: string) => {
    const { data, error } = await builderCompleteOnboarding(stepKey);
    if (error || !data) {
      return { error: (data as any)?.error || error?.message || 'Could not complete onboarding' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const selectOrganisation = useCallback(async (organisationId: string) => {
    const { data, error } = await builderSelectOrganisation(organisationId);
    if (error || !data) {
      return { error: (data as any)?.error || error?.message || 'Could not switch organisation' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const refresh = useCallback(async () => { await checkSession(); }, [checkSession]);

  /**
   * Convenience read of the server-resolved matrix. This is a rendering aid,
   * never an authorization control — every request is re-authorised server-side.
   */
  const can = useCallback(
    (permissionKey: string, level: 'view' | 'edit' | 'delete' = 'view') =>
      permissions?.[permissionKey]?.[level] === true,
    [permissions],
  );

  const value = useMemo<BuilderPortalAuthContextType>(() => ({
    user, organisations, activeOrganisation, permissions, governance,
    requiresOrganisationSelection, loading, previousSeenAt,
    signIn, signOut, acceptInvite, changePassword, acceptTerms, completeOnboarding,
    selectOrganisation, refresh, can,
  }), [
    user, organisations, activeOrganisation, permissions, governance,
    requiresOrganisationSelection, loading, previousSeenAt,
    signIn, signOut, acceptInvite, changePassword, acceptTerms, completeOnboarding,
    selectOrganisation, refresh, can,
  ]);

  return (
    <BuilderPortalAuthContext.Provider value={value}>
      {children}
    </BuilderPortalAuthContext.Provider>
  );
}

export function useBuilderPortalAuth() {
  const context = useContext(BuilderPortalAuthContext);
  if (context === undefined) {
    throw new Error('useBuilderPortalAuth must be used within a BuilderPortalAuthProvider');
  }
  return context;
}
