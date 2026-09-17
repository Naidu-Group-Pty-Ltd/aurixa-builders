/**
 * `cloudflare:workers` under vitest.
 *
 * The worker's own modules are ordinary TypeScript and are worth testing as
 * such — the auth compare, the routing order, the lane, the wire shape. The
 * only thing standing between them and a Node test runner is this one runtime
 * module, so it is supplied rather than the worker being left untested.
 *
 * `DurableObject` here carries exactly what the real base class gives the
 * subclass and nothing more: the two constructor arguments. Anything the
 * worker relied on beyond that would pass here and fail in production, so the
 * stub stays this thin on purpose.
 */
export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
