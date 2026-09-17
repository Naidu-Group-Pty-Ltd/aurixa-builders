/**
 * Stands in for a Deno `npm:` package this repository does not install.
 *
 * Some shared edge modules import a package the browser bundle has no use for
 * — `meteredFetch` imports `@supabase/supabase-js` purely to write a billing
 * row, behind a `Deno.env` check that is false under vitest. Installing the
 * client so that a test can import a module that never calls it would be
 * paying for a dependency to sit unused.
 *
 * So the specifier resolves here instead, and this deliberately EXPLODES on
 * use rather than returning a silent no-op: a test that genuinely reaches the
 * package gets a sentence naming the cause, where a null object would give it
 * a passing assertion about nothing.
 */
const explode = (property: string): never => {
  throw new Error(
    `[test] '${property}' was called on a Deno npm package this repository does not install. `
    + 'The module under test was expected to reach it only in the edge runtime. Either the test '
    + 'is exercising more than it meant to, or the package now needs to be a real devDependency.');
};

export default new Proxy({}, { get: (_t, p) => () => explode(String(p)) });
export const createClient = (): never => explode('createClient');
