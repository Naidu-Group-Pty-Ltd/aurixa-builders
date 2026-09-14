/**
 * Shared brand configuration helper for edge functions.
 *
 * Reads dynamic brand identity from `global_report_settings` and provides
 * safe fallbacks so outbound emails and AI prompts continue working even if
 * settings are missing.
 *
 * ── Sender address safety: the contact address is not the sender ────────────
 *
 * These are two different questions and this file used to answer both with
 * one value:
 *
 *   • **Contact** — who a human should reply to. A tenant's own choice, shown
 *     in body copy and on generated documents. Any address at all is valid.
 *   • **Sender** — the address mail is actually handed to Resend as. Valid
 *     only if the API key in use is authorised for that DOMAIN; anything else
 *     is refused with `403 ... not verified` and nothing is delivered.
 *
 * Collapsing them broke every clone this platform provisions. A clone gets its
 * own Resend key, `sending_access`-scoped to its own verified domain
 * (`send.<clone-fqdn>`), written by Mission Control. Its
 * `global_report_settings` starts EMPTY, so `contact_details.email` was blank,
 * so the sender fell through to the `noreply@npcservices.com.au` below — the
 * prime's legacy address, which lives in a different Resend account and is
 * verified in the clone's account not at all. Every send answered 403:
 * password recovery, portal invites, appointment notifications. The domain was
 * registered, DNS-installed and verified the whole time; nothing ever named it
 * as the sender.
 *
 * So the sender is resolved from `RESEND_FROM_EMAIL` FIRST. Mission Control
 * writes that secret in the same Management API call that writes
 * `RESEND_API_KEY`, because the key and the one address it may send from are a
 * single credential — the same pairing rule `turnstileSiteKey.ts` applies to a
 * CAPTCHA widget. The environment wins over the database here precisely
 * because the key makes it the only value that can work.
 *
 * Nothing changes for the prime, which sets no `RESEND_FROM_EMAIL`: the sender
 * still resolves to `contact_details.email` and then to the legacy fallback,
 * exactly as before.
 */

// @ts-ignore Deno-only esm.sh import; not resolvable under Node type-checking.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface BrandConfig {
  /** Display brand name (e.g., "Acme Property Consulting") */
  companyName: string;
  /** UPPERCASE display variant for headings */
  companyNameUpper: string;
  /** Contact email — shown in body copy and on documents. NOT the sender. */
  contactEmail: string;
  /**
   * The address outbound mail is SENT from. Resolved from `RESEND_FROM_EMAIL`
   * where this deployment has its own domain-scoped key, otherwise from the
   * contact address. Its DOMAIN must be verified for the key in use.
   */
  senderEmail: string;
  /** Sender display+address: "Brand Name <email>" */
  fromHeader: string;
  /** Admin sender variant: "Brand Name Admin <email>" */
  fromHeaderAdmin: string;
  /** Notifications sender variant for portal emails */
  fromHeaderNotifications: string;
  /** Contact phone */
  contactPhone: string;
  /** Public website */
  contactWebsite: string;
  /** Mailing address */
  contactAddress: string;
  /** ABN/registration */
  abn: string;
}

// Hard fallbacks — only used when DB row is missing/empty.
// These intentionally point at the legacy verified Resend sender so
// existing flows never break before a new sender domain is verified.
const FALLBACK_COMPANY = 'Property Consulting';
const FALLBACK_EMAIL_NOREPLY = 'noreply@npcservices.com.au';
const FALLBACK_EMAIL_ADMIN = 'admin@npcservices.com.au';
const FALLBACK_EMAIL_NOTIFICATIONS = 'notifications@npcservices.com.au';
const FALLBACK_PHONE = '';
const FALLBACK_WEBSITE = '';
const FALLBACK_ADDRESS = '';
const FALLBACK_ABN = '';

/**
 * The deployment's own verified sender, written beside its Resend key.
 *
 * Read on every resolution rather than at module load: an edge function
 * instance outlives a secret update, and a stale sender is the failure this
 * whole file exists to stop. Shape-checked because an unparseable value must
 * fall through to the configured address rather than become a 422 on a
 * password reset.
 */
const ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function resendFromEmail(): string | null {
  try {
    const raw = Deno.env.get('RESEND_FROM_EMAIL')?.trim().toLowerCase();
    return raw && ADDRESS.test(raw) ? raw : null;
  } catch {
    // No Deno.env in a test harness — treat as unset.
    return null;
  }
}

/**
 * Decide the from-address for a send.
 *
 * Exported so the rule is stated once and can be asserted directly: the
 * environment's verified sender wins, then the tenant's configured address,
 * then the legacy fallback passed by the caller.
 */
export function resolveSenderEmail(configuredEmail: string, legacyFallback: string): string {
  return resendFromEmail() ?? (configuredEmail.trim() || legacyFallback);
}

let _cached: BrandConfig | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute — long enough to cover a single AI report run, short enough to pick up admin edits quickly

function buildFallback(): BrandConfig {
  // The sender is resolved even here. A failed settings read on a clone must
  // not silently reinstate the prime's address, which is the one address that
  // deployment provably cannot send from.
  const sender = resolveSenderEmail('', FALLBACK_EMAIL_NOREPLY);
  const senderAdmin = resendFromEmail() ?? FALLBACK_EMAIL_ADMIN;
  const senderNotif = resendFromEmail() ?? FALLBACK_EMAIL_NOTIFICATIONS;
  return {
    companyName: FALLBACK_COMPANY,
    companyNameUpper: FALLBACK_COMPANY.toUpperCase(),
    contactEmail: FALLBACK_EMAIL_ADMIN,
    senderEmail: sender,
    fromHeader: `${FALLBACK_COMPANY} <${sender}>`,
    fromHeaderAdmin: `${FALLBACK_COMPANY} Admin <${senderAdmin}>`,
    fromHeaderNotifications: `${FALLBACK_COMPANY} <${senderNotif}>`,
    contactPhone: FALLBACK_PHONE,
    contactWebsite: FALLBACK_WEBSITE,
    contactAddress: FALLBACK_ADDRESS,
    abn: FALLBACK_ABN,
  };
}

/**
 * Fetch brand config from `global_report_settings`. Cached in-memory for 60s
 * to amortise across AI multi-call workflows.
 */
export async function getBrandConfig(supabase?: SupabaseClient): Promise<BrandConfig> {
  // Serve from cache if fresh
  const now = Date.now();
  if (_cached && now - _cachedAt < CACHE_TTL_MS) {
    return _cached;
  }

  try {
    const client = supabase ?? createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await client
      .from('global_report_settings')
      .select('setting_key, setting_value')
      .eq('setting_key', 'contact_details')
      .maybeSingle();

    if (error || !data?.setting_value) {
      const fb = buildFallback();
      _cached = fb;
      _cachedAt = now;
      return fb;
    }

    const cd = data.setting_value as Record<string, string>;
    const company = (cd.company_name || '').trim() || FALLBACK_COMPANY;
    const email = (cd.email || '').trim();

    // Sender address selection — the deployment's verified sender first, then
    // the configured contact address, then the legacy fallback. See the header.
    const noreplyAddr = resolveSenderEmail(email, FALLBACK_EMAIL_NOREPLY);
    const adminAddr = resolveSenderEmail(email, FALLBACK_EMAIL_ADMIN);
    const notifAddr = resolveSenderEmail(email, FALLBACK_EMAIL_NOTIFICATIONS);

    const cfg: BrandConfig = {
      companyName: company,
      companyNameUpper: company.toUpperCase(),
      // Unchanged: the CONTACT address stays the tenant's own, whatever the
      // deployment sends as. A reader is told who to talk to, not which
      // mailbox the transport happened to use.
      contactEmail: email || FALLBACK_EMAIL_ADMIN,
      senderEmail: noreplyAddr,
      fromHeader: `${company} <${noreplyAddr}>`,
      fromHeaderAdmin: `${company} Admin <${adminAddr}>`,
      fromHeaderNotifications: `${company} <${notifAddr}>`,
      contactPhone: (cd.phone || '').trim() || FALLBACK_PHONE,
      contactWebsite: (cd.website || '').trim() || FALLBACK_WEBSITE,
      contactAddress: (cd.address || '').trim() || FALLBACK_ADDRESS,
      abn: (cd.abn || '').trim() || FALLBACK_ABN,
    };

    _cached = cfg;
    _cachedAt = now;
    return cfg;
  } catch (e) {
    console.error('[brand-config] Failed to load brand config, using fallback:', e);
    return buildFallback();
  }
}

/** Force-clear the cache. Call after admin updates contact details. */
export function clearBrandConfigCache(): void {
  _cached = null;
  _cachedAt = 0;
}
