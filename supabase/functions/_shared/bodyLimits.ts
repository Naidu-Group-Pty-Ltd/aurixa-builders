/**
 * Request-body size ceilings.
 *
 * A module with **no imports**, deliberately.
 *
 * These constants were in `validate.ts`, which imports `requestSecurity.ts`,
 * which imports `https://esm.sh/...` and `https://deno.land/x/...`. Deno
 * resolves those; Vite does not, so any `src/` unit test whose import graph
 * reached a schema module died at collection with
 *
 *     Only URLs with a scheme in: file and data are supported
 *
 * — a failure about the bundler, in a spec with nothing wrong with it. That is
 * the same class of breakage `vitest.config.ts`'s `denoNpmSpecifiers()` plugin
 * exists for, and it is why the schemas had no unit test when they took four of
 * the five logins down.
 *
 * Keeping the numbers here means `authBodySchemas.ts` depends on zod and two
 * dependency-free modules, so it can be imported and actually exercised from a
 * spec. Anything added to this file must keep it import-free.
 */

/**
 * Default ceiling when a call site does not name one. 256 KiB is well above
 * every JSON operation in this repo and well below anything that would cost
 * real memory in an isolate; a function with a genuinely larger payload (a
 * base64 upload, say) should pass its own and use `enforceBase64Limit`.
 */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/**
 * The ceiling for a body that carries a handful of short strings — a session
 * token, an action name, a set of credentials. 16 KiB is three orders of
 * magnitude more than any real one.
 */
export const SMALL_BODY_BYTES = 16 * 1024;
