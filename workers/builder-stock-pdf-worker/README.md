# builder-stock-pdf-worker

Runs the Builder Stock heavy PDF election on Cloudflare, because it does not
fit on Supabase Edge.

## Why it exists

Per-execution Supabase telemetry, 8 September 2026: a thirteen-property cold
start killed the settler thirteen times and **every kill was `reason:
CPUTime`** — successful executions ending at 1,828 ms of CPU or less, killed
ones at 2,031 ms or more, against a 2,000 ms limit. Memory peaked at 108 MB of
256, so memory was never the constraint. Reading a heavy brochure and electing
its image is indivisible and costs about 2.4 s. It does not fit, and no
scheduling rule makes it fit.

So the work moved. `RUNTIME_VERSION` is 4 and `WORKER_RUNTIME_VERSION` is 3, so
`electionRoute` already sends every heavy document here.

## The rule that governs this directory

**There is one election, and it is not in this directory.**

`src/pdfElection.do.ts` imports `electFromPdfBytes` and
`readPdfPageTextResult` from `supabase/functions/_shared/builderStock/` — the
same modules the Supabase path runs. How PDF text is read, which image is
elected, what counts as evidence, how roles are assigned and what provenance
means are defined once, over there.

What this directory is therefore allowed to contain is a front door, a queue, a
size check and the translation of an outcome into the wire shape. `build.mjs`
**fails the build** if the bundle does not contain the shared election, so a
worker carrying its own private copy of the algorithm cannot ship by accident.

## The one thing the build rewrites, and why it is not a code change

`pdfText.ts` loads its reader with `import('https://esm.sh/unpdf@0.12.1')`.
That is correct for Deno and it is the only line in the shared election a
Worker cannot execute — Workers resolve no modules at runtime.

The tempting fix is to edit that import. It must not be edited: the shared
modules are shared, and a conditional import would be a second answer to "how
is a PDF's text read" living in the one file whose header exists to say there
is only one. So `build.mjs` rewrites the specifier **at build time** to the npm
package the URL names, pinned to the same version, and refuses to build if the
two ever name different versions. `pdfText.ts` is byte-identical on both sides.

## Proving it

```bash
npm install
npm run build                  # asserts the shared election is what got bundled
node scripts/canary.mjs --heavy
```

The canary loads `dist/index.js` — the exact bytes wrangler uploads — stubs the
one Workers-only module, and puts a real brochure through the real front door.
It checks the bearer door, the routing order, the refusal of an unvouchable
context, and then a full election: that an image came out, that its reference
names the document that was sent, that provenance states the page and method,
that **the returned bytes hash to the provenance they are filed under**, and
that the role is `primary_property` rather than a floorplan or a map. With
`--heavy` it generates an 8 MB twelve-page document and elects that too.

`--url https://…` runs the same checks over the wire. That is what the deploy
workflow uses as its gate before any Supabase secret is pointed at a new
deployment.

### Typechecking

This directory has no `tsconfig.json`, deliberately. Its two source files are
already in the repository's `npm run typecheck` program — the spec imports
them, so tsc follows them and checks them strictly against the
`cloudflare:workers` declaration in `src/types/edgeRuntimeModules.d.ts`. The
shared election is checked separately and strictly by `npm run typecheck:edge`,
under Deno, which is the runtime its types are written for.

A third program here would not add coverage. It would re-check shared Deno
modules against Cloudflare's globals and fail on `Deno.env` and on Deno's
`TextDecoder` options in `fetchSource.ts`, `packageImages.ts` and
`meteredFetch.ts` — none of which the worker runs, because the worker reaches
them only through type-only imports.

The Edge side of the same contract is tested in
`src/lib/__tests__/builderStockPdfWorker.spec.ts`, whose central invariant is
that the client **cannot construct `not_identified`** — every boundary failure
is `unreachable`, because a verdict is banked and suppresses a source until a
version bump, while an access fact retries.

## Deploying

`.github/workflows/deploy-pdf-worker.yml`, on pushes to `main` that touch this
directory or the shared election. It builds, canaries the bundle, deploys,
sets the worker's half of the shared bearer, **waits for that bearer to be the
one the worker actually compares against**, canaries the live URL, and only
then sets `BUILDER_STOCK_PDF_WORKER_URL` and `BUILDER_STOCK_PDF_WORKER_TOKEN`
on the Supabase project. The order is the point: the moment those two secrets
exist, every heavy brochure is routed here.

The waiting step is `scripts/await-token.mjs`, and it exists because of a
measured race. In run 35204922096 the same bearer was accepted and rejected
within 300 ms of itself: this worker already held a *different* value for
`BUILDER_STOCK_PDF_WORKER_TOKEN` from an earlier deployment, so an isolate
that had not yet seen the new secret compared against the old one and answered
**401**, not 503. `/health` cannot detect that — it is unauthenticated and
reports only that *some* token exists — so the gate is an authenticated
`POST /v1/nope`, which the front door can answer 404 for only if the token
matched, and which runs no election. It requires a streak of consecutive
acceptances and **fails the run** if the new token never goes live, so it can
never turn a permanent 401 into a pass.

Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`BUILDER_STOCK_PDF_WORKER_TOKEN`, `SUPABASE_ACCESS_TOKEN`.

## What was here before this directory existed

A worker of this name has been deployed on Cloudflare since 8 September 2026,
built from a working tree that was never committed. Its bundle names its
sources `../../supabase/functions/_shared/…`, which is how we know. Sixteen of
the twenty-four shared modules in it are byte-identical to a rebuild from this
directory; the other eight are **stale** — `pdfElection.ts`,
`pdfPrimaryImage.pure.ts`, `pdfText.ts`, `rasterPng.ts`, `webpLossless.ts` and
`webpLossy.ts` have all changed in `main` since, including the inflate ceiling
added by the security hardening in `0e7250f`.

That is the reason a worker gets a source directory, a build that asserts what
it contains, a canary, and a workflow: an uncommitted deploy is a second copy
of the algorithm that nobody can see drifting.
