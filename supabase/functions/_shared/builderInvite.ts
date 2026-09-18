/**
 * The one way a Builder Portal invite is minted.
 *
 * `builder-portal-invite` grew this first: a token of two UUIDs, stored only
 * as a peppered hash, expiring in a fixed window, delivered as a link to
 * `/builder/accept-invite`. `builder-network-admin` needs the same thing to
 * bootstrap a brand-new organisation's first owner, and a second copy of a
 * credential's shape is how the two come to disagree about the window, the
 * path, or — worst — whether the plaintext is ever stored.
 *
 * Two rules travel with it.
 *
 *  * **An unhashable token is never stored.** `hashSessionToken` returns null
 *    when the session pepper is unconfigured, and writing the token
 *    unpeppered would leave a credential at rest in a form that verifies
 *    itself. `mintBuilderInvite` returns null instead and the caller refuses.
 *
 *  * **The plaintext is returned exactly once and never persisted.** Only the
 *    hash reaches the database, so a link that is lost is re-minted rather
 *    than re-read — the same rule the network's connection invite codes and
 *    the Passport's grant links already answer to.
 */
import { hashSessionToken } from './sessionHash.ts';

/** How long an invite link stays good. One window, both callers. */
export const INVITE_EXPIRY_HOURS = 72;

/** Where a builder accepts one. */
export function builderAppBaseUrl(): string {
  return (Deno.env.get('APP_BASE_URL') || 'https://builders.aurixasystems.com.au').replace(/\/+$/, '');
}

export function inviteUrlFor(token: string): string {
  return `${builderAppBaseUrl()}/builder/accept-invite?token=${encodeURIComponent(token)}`;
}

export interface MintedInvite {
  /** Shown once to whoever is sending it. Never stored. */
  readonly token: string;
  /** What the database holds. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly url: string;
}

/**
 * Mint one. Null means the pepper is unconfigured — refuse, do not downgrade.
 */
export async function mintBuilderInvite(now: Date = new Date()): Promise<MintedInvite | null> {
  const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const tokenHash = await hashSessionToken(token);
  if (!tokenHash) return null;
  return {
    token,
    tokenHash,
    expiresAt: new Date(now.getTime() + INVITE_EXPIRY_HOURS * 3_600_000),
    url: inviteUrlFor(token),
  };
}
