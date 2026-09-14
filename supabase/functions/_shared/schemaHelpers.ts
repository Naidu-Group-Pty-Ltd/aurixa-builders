/**
 * Shared zod building blocks for request schemas.
 *
 * Separate from `validate.ts` on purpose: that module declares a structural
 * `SchemaLike` interface specifically so it does not import zod, and that
 * should stay true. This one does import zod, and only the schema modules
 * depend on it.
 */
import { z } from 'npm:zod@3.25.76';

/**
 * An optional field, where a JSON `null` means "not supplied".
 *
 * ## Why this exists
 *
 * `z.string().optional()` accepts `undefined` and **rejects `null`**. In
 * TypeScript those are two different absences; over JSON they are the same one,
 * and which of them a caller sends is decided by how its form state happens to
 * be typed rather than by anything about the request.
 *
 * WP-27 put `.optional()` schemas in front of every pre-session endpoint. Every
 * login form in this product holds its CAPTCHA token as
 * `useState<string | null>(null)` and passes it through unconditionally, so the
 * body on the wire is `"turnstile_token": null`. Four of the five logins —
 * staff, client, finance and solicitor — started answering
 *
 *     400 {"error":"Invalid request","code":"invalid_body","fields":["turnstile_token"]}
 *
 * to every sign-in attempt. `builder-portal-login` survived only because
 * `src/lib/builderPortal.ts` happens to spread the key conditionally.
 *
 * The same shape was already live on the reporting path:
 * `generate-investment-report` sets `postcode` to `null` when an address has no
 * four-digit postcode and posts it to three locality services.
 *
 * ## The rule this encodes
 *
 * A validator placed in front of a handler inherits responsibility for
 * everything that handler used to tolerate. These endpoints never rejected a
 * null optional field — `turnstile_token` was not even read unless
 * `TURNSTILE_SECRET_KEY` was set — so the schema must not either.
 *
 * ## What it does NOT relax
 *
 * Only a literal `null` becomes `undefined`. Everything else is still checked:
 *
 *   {"password": {"$ne": null}}  -> still rejected (an object is not null)
 *   {"password": [null]}         -> still rejected
 *   {"password": 123}            -> still rejected
 *   {"password": "<600 chars>"}  -> still rejected
 *
 * That matters because operator injection is the reason these schemas exist,
 * and it arrives as an object, never as a bare null.
 *
 * `z.preprocess` rather than `.nullish()`: `.nullish()` widens the parsed type
 * to `T | null | undefined`, which would ripple through seventeen handlers that
 * currently destructure `T | undefined`. This keeps the parsed type exactly
 * what it was, so a null-tolerance fix stays a null-tolerance fix.
 */
export const optionalField = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema.optional());
