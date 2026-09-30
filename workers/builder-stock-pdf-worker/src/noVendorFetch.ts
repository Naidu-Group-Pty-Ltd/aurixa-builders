/**
 * THE WORKER CALLS NO VENDOR, AND THIS IS WHERE THAT IS ENFORCED.
 *
 * `meteredFetch` is how the edge reaches a billed vendor (a model, a search
 * API) and records the spend. Nothing the worker runs may do either: the
 * overlay repair runs here with `allowGenerative: false`, and an election or a
 * folder reading elects in this object rather than calling back out. So the
 * build replaces the module with this one, and a call that ever reached it
 * would fail loudly as an operational fault instead of spending on an account
 * this worker holds no key for.
 */
export async function meteredFetch(): Promise<Response> {
  throw new Error('the builder stock worker calls no vendor');
}
