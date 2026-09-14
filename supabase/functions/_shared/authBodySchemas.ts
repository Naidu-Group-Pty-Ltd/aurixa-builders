/**
 * WP-27: request schemas for the pre-session (`public-auth`) endpoints.
 *
 * ## Why this class next
 *
 * WP-24 bounded the nine `public` data services. The 31 functions classified
 * `public-auth` in `SECURITY_REGISTRY.json` are the next ring out and, on the
 * measure that matters here, were no better off: **every one of the 27 that
 * reads a body read it with a bare `await req.json()`**. No size limit, and
 * either a TypeScript type *assertion* — which checks nothing at runtime — or
 * nothing at all.
 *
 * These are login, forgot-password, reset-password, accept-invite and verify,
 * across four portals plus the staff console. They are reachable with no
 * session and no cookie, by anyone, which is the entire point of them. An
 * unbounded read on an endpoint that needs no credential is the same
 * memory-pressure vector WP-24 closed on the data services, and there are three
 * times as many of these.
 *
 * ## What these schemas do and deliberately do not do
 *
 * They check the **types** of the fields each handler destructures, and nothing
 * else.
 *
 * Not `.strict()`, unlike `publicServiceSchemas.ts`. A locality lookup that
 * receives an unknown key is a caller sending something the endpoint does not
 * implement, and saying so is useful. A *login form* that receives an unknown
 * key is a client one deploy ahead of the server, and rejecting it locks people
 * out of the product. The blast radius of strictness is not the same in the two
 * places, so the setting is not either.
 *
 * Every field is `optionalField(...)`. Presence is still the handler's business:
 * `client-portal-login` answers `{ error: 'Email and password are required' }`
 * and four different clients read that string. Moving the presence check in here
 * would change that to `invalid_body` and break them for no security gain —
 * a missing password was never the risk. A password that arrives as
 * `{"$ne": null}` was, and that is what these reject.
 *
 * `optionalField` rather than `.optional()`, and that distinction took four of
 * the five logins down for real: `.optional()` accepts `undefined` and REJECTS
 * `null`, while every login form here holds its CAPTCHA token as
 * `useState<string | null>(null)` and sends it unconditionally. Read
 * `_shared/schemaHelpers.ts` before adding a field.
 *
 * Bounds are generous on purpose. 320 characters is the RFC 5321 maximum for an
 * address; bcrypt ignores everything past 72 bytes but rejecting a long
 * passphrase teaches people to pick shorter ones.
 */
import { z } from 'npm:zod@3.25.76';
import { SMALL_BODY_BYTES } from './bodyLimits.ts';
import { optionalField } from './schemaHelpers.ts';

/**
 * 16 KiB.
 *
 * An auth body is five short strings. This is three orders of magnitude more
 * than any real one and still small enough that an unauthenticated caller
 * cannot use it to make the runtime work.
 *
 * The same value as `SMALL_BODY_BYTES`, re-exported under a name that says
 * which class of endpoint it is for — the call sites below read better for it,
 * and if the two ever need to diverge the seam is already here.
 */
export const AUTH_MAX_BODY_BYTES = SMALL_BODY_BYTES;

const emailField = z.string().max(320);
const passwordField = z.string().max(512);
const tokenField = z.string().max(512);
/**
 * Turnstile tokens are documented as "up to 2048 characters" and Cloudflare
 * explicitly reserves the right to grow them, so the 512 bound above rejected
 * real tokens as `invalid_body` and locked every login out. Bounded generously
 * instead — the point of the check is that it is a *string*, not a length.
 */
const turnstileTokenField = z.string().max(4096);
const actionField = z.string().max(64);

/**
 * `{ email, password, turnstile_token }` — the four portal logins.
 *
 * The `turnstile_token` type check is the one with teeth: it is forwarded to
 * Cloudflare's siteverify, and a non-string there was previously the caller's
 * choice.
 */
export const PortalLoginRequest = z.object({
  email: optionalField(emailField),
  password: optionalField(passwordField),
  turnstile_token: optionalField(turnstileTokenField),
});

/** `{ username, password, turnstile_token }` — the staff console login. */
export const StaffLoginRequest = z.object({
  username: optionalField(z.string().max(256)),
  password: optionalField(passwordField),
  turnstile_token: optionalField(turnstileTokenField),
});

/** `{ email }` — forgot-password, all four portals. */
export const ForgotPasswordRequest = z.object({
  email: optionalField(emailField),
});

/**
 * `{ action, email, otp, new_password }` — reset-password, all four portals.
 *
 * `otp` is bounded hard. It is a short numeric code compared against a stored
 * value, and there is no length at which a longer one becomes meaningful.
 */
export const ResetPasswordRequest = z.object({
  action: optionalField(actionField),
  email: optionalField(emailField),
  otp: optionalField(z.string().max(32)),
  new_password: optionalField(passwordField),
});

/** `{ action, token, password }` — accept-invite, all four portals. */
export const AcceptInviteRequest = z.object({
  action: optionalField(actionField),
  token: optionalField(tokenField),
  password: optionalField(passwordField),
});
