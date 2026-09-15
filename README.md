# Aurixa Builders Network

The central multi-vendor Builder Portal at `builders.aurixasystems.com.au` —
one auth gateway, many builder organisations, and a connection graph back to
each Aurixa workspace. This repo is the Builder Portal **extracted** from the
per-clone NPC Property Dashboard: a builder's 40-unit development exists
once, not once per agency that sells it, so the portal leaves the clone and
becomes one platform that clones connect to.

The canonical plan lives in the prime:
`npc-property-dashbord/docs/builder-portal/45-network-extraction-plan.md`
(rev 2), with the measured boundary in doc 44. This README deliberately does
not restate it — two copies of a plan is how one goes stale.

## Trust model, in one paragraph

Mission Control is the trust anchor and nothing else. A workspace presents
its own `mck_*` key to MC (`builders:federate`, per-workspace opt-in) and
receives a five-minute signed assertion; this network verifies it **offline**
against MC's published JWKS (`/api/public/builders/jwks`). MC sits on the
token path about once an hour per workspace, never on the request path.
Deliveries in both directions are HMAC-SHA256 over the raw body with a
per-connection symmetric secret: **minted network-side at acceptance**,
handed out exactly once through the federated operator door
(`builder-network-admin` `provision_transport`, thereafter only
`rotate_transport`) for MC — which holds the clone's service credentials,
never this project's — to install clone-side, and cleared at rest on
revocation. Neither side ever holds the other's service-role key, and
connections are **access control, never agreement formation** — scopes are
unilateral, revocable grants.

## What exists now — the schema layer (Phase 2a)

| Artefact | What it is |
| --- | --- |
| `supabase/migrations/00000000000000_network_baseline.sql` | The consolidated baseline: the prime's 60-file builder corpus squashed to its end-state, entanglements settled, plus the connection graph. **Generated — never hand-edit.** |
| `scripts/db/reshape.sql` | The reviewable half of the squash: every boundary edit (E1–E6, terms, the document queue), each asserted by effect, shims dropped RESTRICT so a drop that succeeds *is* the proof nothing still hangs off the clone. |
| `scripts/db/build-baseline.mjs` | Rebuilds the baseline from a prime checkout: fixture → strict one-pass corpus replay → reshape → dump + seeds + provenance. |
| `scripts/db/baseline-check.mjs` | CI. Rebuilds from the baseline **alone** and must land on the identical catalog fingerprint, then re-proves the boundary, RLS-everywhere, seeds and scope vocabulary. |
| `docs/provenance/corpus/` | The 60 source migrations, verbatim — the *why* for every table, preserved rather than transcribed. `corpus-manifest.json` pins their hashes, the fixture's and the reshape's. |

```bash
# prove the baseline (needs local PostgreSQL 16; see the env contract in the script)
npm run db:baseline:check

# regenerate it after the prime's corpus or reshape.sql changes
npm run db:baseline:build -- --prime ../npc-property-dashbord
```

### Rules that carry the schema

- **The scoping root does not move.** `builder_organisations.id` was always
  the boundary; nothing here gains a `workspace_id` on a builder-owned table.
- **Every public table is RLS-enabled and closed.** The browser will hold no
  Supabase credential at all (the `/fn/*` proxy injects the anon key
  server-side); every read is an edge function holding the service role, and
  the check fails on any table where that stops being true.
- **A scope grant is a row with a foreign key**, not an array entry — a
  misspelled scope must be a write error, not an access decision that
  quietly never applies.
- **`connection_id` is nullable on transactions.** Builders build and sell
  without a workspace; NOT NULL would invent counterparties.
- **Announcements carry no client identity.** `remote_selection_ref` is an
  opaque uuid the workspace minted; the label is what the workspace chose to
  send. No `client_id`, no `internal_notes`, ever.

## What comes next (Phase 2b, same plan section)

The runtime: the 15 portal edge functions + 2 stock workers ported from the
prime, the new register/verify-email/connections/stamp/inbound/outbox
functions, the frontend with the drawing-set visual system, the `/fn/*`
same-origin proxy, per-deployment Turnstile, and the CI chain the prime
already runs (verify_jwt declarations, security checks, mounted-usage specs).
Then a new Supabase project, DNS via Mission Control's hosting rails, and the
Phase 3 clone-side mirror.

## Live deployment (provisioned 2026-09-14)

| Piece | Where | State |
|---|---|---|
| Supabase project | `htfluofznhxeumblwbww` (ap-southeast-2) | Schema live; catalog fingerprint `a9ca8213186ee3de…` verified byte-identical to the committed baseline proof |
| Migrations | `supabase/migrations/` | Applied by the database itself: fetched at a pinned commit, sha256-asserted before EXECUTE, ledger holds the canonical versions |
| Edge functions | `.github/workflows/deploy-supabase-functions.yml` | Ships all 25 on push; **deliberately RED until `SUPABASE_ACCESS_TOKEN` is a repo secret** — a green pretence is the failure the prime already paid for |
| Frontend + `/fn` proxy | Vercel project `aurixa-builders` (git-linked) | Previews per branch; production tracks `main`. Proxy needs `SUPABASE_URL` + `SUPABASE_ANON_KEY` project env vars and refuses by name without them |
| Operator console | Mission Control `/builders-network` | Federation-asserted calls to `builder-network-admin`; the NULL-clone `builders:operate` key row is the on/off switch |

Secrets this repo's workflows expect (Settings → Secrets → Actions):
`SUPABASE_ACCESS_TOKEN` (deploys), `NETWORK_SESSION_PEPPER` and
`NETWORK_INTERNAL_SECRET` (32+ random chars each; shipped to the project as
`SESSION_TOKEN_PEPPER` / `INTERNAL_EDGE_SECRET` only when present — an empty
write would blank a secret somebody set by hand). Vendor keys (Resend,
Turnstile) are set on the Supabase project directly and never live here.
