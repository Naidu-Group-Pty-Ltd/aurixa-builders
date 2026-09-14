/**
 * The platform's own mark — what a clone shows when its brand settings are empty.
 *
 * Named in ONE place because three surfaces reach for it (the tab icon, the
 * apple-touch tile, and the desktop notification shade) and a literal at each
 * end is how three ends drift. `index.html` declares the same path for the
 * pre-hydration paint; `platformBrand.spec.ts` asserts the two agree, because
 * a mismatch means the tab flickers from one mark to another on every load.
 *
 * ## Why this exists as a module rather than a default argument
 *
 * `BrandProvider` used to write the tenant's favicon and then `return` early
 * when there was none:
 *
 *     const favicon = getBrandAssetSrc(settings, 'favicon');
 *     if (!favicon) return;
 *
 * That is correct on a first load — the static `<link>` in `index.html` is
 * already the platform mark — and wrong the moment a tenant CLEARS their
 * favicon: the href written by the previous render stays on the element, so
 * the tab keeps showing a mark the workspace no longer has, until a full
 * reload. Reverting needs something to revert TO, which is this.
 */

/**
 * The Aurixa Systems emblem. Must match the `<link rel="icon">` in `index.html`.
 *
 * Its own file, and deliberately not the one beside it. `aurixa-notification-*`
 * serves FOUR jobs — this fallback, the apple-touch tile, the desktop
 * notification icon (`AURIXA_NOTIFICATION_ICON`) and the `og:image` social
 * card — so replacing the artwork in place would have changed a clone's push
 * notifications and its link previews to make its tab icon right. The favicon
 * is the only slot this mark was given, so it is the only slot it occupies.
 *
 * It carries ALPHA rather than a ground, which the notification asset does not:
 * a tab strip is light or dark by the reader's theme, and a transparent mark
 * composites onto either, where an opaque dark tile reads as a dark square on a
 * light strip.
 */
export const PLATFORM_FAVICON = '/brand/aurixa-favicon-192.png';

/**
 * The same mark at tile size, for iOS home screens.
 *
 * This slot used to hold `/icons/apple-touch-icon.png`, which is not an icon:
 * it is the NPC email-signature BANNER letterboxed into a square, and at any
 * size the OS renders it legibly it carries a named individual, their title,
 * their email and their personal mobile number. On a clone handed to a client
 * with no brand of their own, adding the app to a phone put another business's
 * director on that phone's home screen.
 *
 * The 512 rather than the 192: this is fetched only when somebody adds the app
 * to their home screen, never on the page-load path, and iOS draws it at up to
 * 540 device pixels on a 3x display — so the larger file costs nothing where it
 * is not wanted and is sharp where it is.
 */
export const PLATFORM_APPLE_TOUCH_ICON = '/brand/aurixa-notification-512.png';

/**
 * The mark to paint for a workspace, given whatever its brand settings resolve
 * to. Never returns null: an unbranded clone is an Aurixa deployment, not a
 * deployment with no identity.
 */
export function faviconFor(brandFavicon: string | null | undefined): string {
  const trimmed = brandFavicon?.trim();
  return trimmed ? trimmed : PLATFORM_FAVICON;
}

/** The apple-touch tile, on the same rule. */
export function appleTouchIconFor(brandFavicon: string | null | undefined): string {
  const trimmed = brandFavicon?.trim();
  return trimmed ? trimmed : PLATFORM_APPLE_TOUCH_ICON;
}
