/**
 * Local development origins — and the one switch that admits them.
 *
 * `http://localhost:5173` and `http://localhost:8080` were hardcoded into three
 * separate allowlists: the credentialed-CORS list (`auth.ts`), the CSRF
 * origin check (`csrfGuard.ts`) and the Builder portal request guard
 * (`builderSessionToken.ts`). Every deployed function therefore trusted a
 * developer's laptop exactly as much as the production site.
 *
 * On its own that is not an open door — a page served from localhost is still a
 * different origin to the victim's browser session, and the Builder session
 * cookie is `SameSite=Lax`, so a hostile site cannot simply borrow it. What the
 * carve-out does remove is a layer: any malware, hostile extension or trivially
 * MITM-able plain-HTTP process able to serve a page on the victim's own
 * `localhost` inherits an origin that production has pre-declared trustworthy.
 * The portal gains nothing from that in production, so production should not
 * pay for it.
 *
 * The origins are not deleted — local development genuinely needs them, and a
 * developer who cannot log in will reach for something far worse than this
 * flag. They are made OPT-IN: set `ALLOW_LOCAL_DEV_ORIGINS=true` in a local or
 * preview environment and the two origins return; leave it unset — which is the
 * state of every deployed project, because nobody has ever set it — and they do
 * not.
 *
 * The flag is deliberately unset-means-off rather than unset-means-on: the
 * failure mode of the safe default is "a developer sets one environment
 * variable", and the failure mode of the unsafe default is silent and
 * permanent.
 */

const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:8080',
] as const;

/**
 * The local development origins, or none at all.
 *
 * Read through `globalThis` rather than `Deno.env` directly so the module is
 * importable from the Node/vitest test runs that exercise `csrfGuard` and
 * `builderSessionToken` as plain modules.
 */
export function localDevOrigins(): string[] {
  const flag = ((globalThis as any).Deno?.env?.get?.('ALLOW_LOCAL_DEV_ORIGINS') || '')
    .trim()
    .toLowerCase();
  return flag === 'true' ? [...LOCAL_DEV_ORIGINS] : [];
}

/** Exported for the regression tests, which assert on the exact spellings. */
export const LOCAL_DEV_ORIGIN_LIST: readonly string[] = LOCAL_DEV_ORIGINS;
