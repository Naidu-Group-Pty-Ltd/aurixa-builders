# HANDOFF: aurixa-builders, "Use brochure image" (2026-09-25)

Written when the user paused all work so they could continue in a new chat
from a different account. Everything below was true at the moment of the pause.
**Delete this file before opening any PR from this branch.**

- Repository: `Naidu-Group-Pty-Ltd/aurixa-builders`, branch `claude/busy-lovelace-8vf015`
- Production Supabase project ref: `htfluofznhxeumblwbww`
- Builder portal: https://builders.aurixasystems.com.au

---

## 1. Where things stand

| Item | State |
|---|---|
| Feature "Use brochure image" (confirm or undo a brochure on a *Brochure details don't match this property* notice) | **Merged**: [PR #106](https://github.com/Naidu-Group-Pty-Ltd/aurixa-builders/pull/106), squash `03a6d0f` on `main` |
| Migration `20260924120000_a_builder_may_say_a_brochure_is_theirs.sql` | **Applied in production**: deploy run 36012650778 logged `applied`. All functions deployed, including `builder-portal-stock` |
| PDF election worker (Cloudflare) | **Deployed**: run 36012650867. Live canary 39/39, including "a protocol-2 request is answered in protocol 2", "a request carrying a builder's confirmation is elected, answered in protocol 3", and "a confirmation it cannot vouch for is refused 400" |
| CI on `main` at `03a6d0f` | **Green**: run 36012650707 |
| Production proof tooling | **Committed and pushed, no PR**: `a39421a` on this branch (details in §3) |
| Live production proof | **FAILED, not diagnosed**: run 36013693485 (§2) |
| Final report to the user for this feature | **Not sent yet** (draft in §6) |
| Reader 23 | **On hold** by the user's decision. Local-only branch `r23-wip`, not on GitHub (§7) |

---

## 2. First priority: the failed live proof (NOT diagnosed)

Production-rollout run **36013693485** (phase `stock-confirmation-proof`, branch
`claude/busy-lovelace-8vf015`, head `a39421a`):

```
PASS  1: the proof builder is through governance, detached from every workspace — terms 200, onboarding 200
PASS  2: the stock list imported — HTTP 200, {"detected":3,"imported":3,"updated":0,"failed":0,"withSourceImage":0,"imageryOutstanding":false,"imageryDeferred":null,...}
FAIL  3: three properties, each read to a conclusion — lot 2046 source, lot 3158 source, lot 3185 source after 721 s
FAIL  the proof ran to its end — the properties did not settle; nothing further can be proved
PASS  cleanup: nothing of this run remains — orgs 0, users 0
```

All three imported properties stayed at `image_work_stage = 'source'` for the
proof's whole 12-minute window. Cleanup worked, so nothing from the run remains
in production. **The cause is not known.** Diagnose this before doing anything else.

### 2a. First rule out a live regression

The images settler is `supabase/functions/builder-stock-image-settler`. It is
driven by the minute tick, and #106 added reads to it: `builder_stock_identity_confirmations`
through `readStandingConfirmations`, and the organisation's listings through
`readListingsWithLots`, using `SIBLING_COLUMNS` with the
`house_design:source_row->>house_design` alias. If the settler now fails on
every run, **no organisation's imports get photos**. That would be a live
regression from #106 and needs fixing immediately.

Check with read-only SQL. The user's rule is read-only SQL only in production:
no manual edits and no data fixes.

```sql
-- Is new work being settled at all, across all organisations?
SELECT image_work_stage, count(*),
       max(updated_at) AS last_touched
  FROM public.builder_stock_items
 WHERE updated_at > now() - interval '2 days'
 GROUP BY 1 ORDER BY 1;

-- Items due but stuck (next attempt in the past, still in a working stage)
SELECT organisation_id, lot_number, image_work_stage, image_work_attempts,
       image_work_failures, image_work_next_attempt_at, image_work_claim_until
  FROM public.builder_stock_items
 WHERE image_work_stage NOT IN ('settled','failed')
 ORDER BY image_work_next_attempt_at NULLS FIRST LIMIT 50;

-- Is the minute tick running, and is it succeeding?
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
SELECT j.jobname, d.status, d.return_message, d.start_time
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 ORDER BY d.start_time DESC LIMIT 40;
```

Also read the edge-function logs for `builder-stock-image-settler` since the
#106 deploy at **2026-09-24 14:26 UTC**. Look for thrown errors and for
PostgREST 4xx on `builder_stock_identity_confirmations` or on the listings
select. With the Supabase MCP connected, `get_logs` / `query_logs` on the
project above works for this.

### 2b. If the settler is healthy, the problem is in the proof

Hypotheses, none of them verified:

- The proof's brochures are served from this project's own storage under signed
  links (`https://htfluofznhxeumblwbww.supabase.co/storage/v1/object/sign/...pdf?token=...`).
  Locally, `classifyBranch` calls such a link `document` and
  `isConfirmableBranch` returns `true`. The production fetch path (SSRF guard,
  proxy) was **not** proven on a link to the project's own host. Failures
  there would normally conclude a branch rather than leave it at `source`,
  though.
- New import rows may be scheduled for a later first attempt, or be filtered out
  of the tick (organisation state, `lifecycle_status`, an ordering or budget
  across a backlog). Check how `process_upload` sets `image_work_next_attempt_at`
  for a CSV row that has link columns.
- `imageryOutstanding:false` / `withSourceImage:0` in the import summary is
  expected when every image comes from a linked document, but confirm that.

**Before re-running, make the proof report its own failure.** On a settlement
timeout it should print, for each item, `image_work_*`, `source_provenance_result`,
and the tick's recent `cron.job_run_details`, *before* `cleanup()` deletes
everything. As written, the script only printed the stages.

Then re-run it. This is a manual dispatch:
`production-rollout.yml`, ref `claude/busy-lovelace-8vf015`, input
`phase = stock-confirmation-proof`. It takes up to ~36 minutes worst case,
with three 12-minute settle windows.

---

## 3. The proof tooling (commit `a39421a`, this branch, not merged)

- `scripts/ops/stock-confirmation-proof.mjs`: drives the live portal the way a
  builder's browser does (`${ORIGIN}/fn/<fn>` with `x-portal-request`). It
  works inside an organisation named `Smoke Rollout brochure-confirm <run>`,
  which is **detached from the network in the same transaction that creates
  it**. Steps:
  1. governance
  2. CSV import: rows 2046 (own brochure), 3158 (links the sibling's brochure),
     3185 (the sibling)
  3. wait for all three to settle; 3185's picture is 1200x760
  4. `get_stock_item` notes: 2046 `states:'Lot 2064'`, `confirmable:true`;
     3158 `confirmable:false`, `in_use_by:'Lot 3185 · Halo 24'`
  5. confirming 3158 answers 409 `brochure_in_use`, and nothing is recorded
  6. confirming 2046 puts its 1320x820 photo on the card, stamped with the
     confirmation id; the view reads `applied`
  7. undo clears the primary at once, the stamped images become `unavailable`,
     the confirmation is withdrawn, and the notice comes back with `confirmable:true`

  Cleanup deletes every row and storage object and asserts that nothing remains.
- `scripts/ops/fixtures/saltbush-lot-2046-own-brochure.pdf` (85,381 bytes,
  sha256 `9784159485b4a232b2971fc905ae4f624ee2c9f9ee1519e83326401b289b2db9`)
  and `saltbush-lot-3185-brochure.pdf` (81,605 bytes, sha256
  `8123d54b6ad48d6bcd8f0d40e3b72ac2205191e6d40a9b5a27a5bab054ce6259`).
  These are the acceptance gate's own invented SALTBUSH RISE documents, and no
  customer data is in them. They are regenerated byte for byte by
  `scripts/stock-acceptance/make-confirmation-proof-fixtures.py`, which uses
  reportlab `invariant=1`.
- `.github/workflows/production-rollout.yml`: adds the phase
  `stock-confirmation-proof` (docs block, `options`, and the `case` arm).

Once the proof passes: open a PR for this tooling (after deleting `HANDOFF.md`),
get CI green, merge, and then report to the user.

---

## 4. What #106 contains (for orientation)

- **Migration** `20260924120000`:
  - table `builder_stock_identity_confirmations` (service_role only; one
    standing confirmation per `(stock_item_id, document_reference)`)
  - `builder_stock_confirm_brochure_image(...)`: locks the item, refuses while
    a worker holds it (`busy`), is idempotent (`already`), re-validates that the
    stored branch is still `identity_mismatch` stating that lot, then requeues
    the item at stage `source`
  - `builder_stock_undo_brochure_image(...)`: in one transaction, withdraws the
    confirmation, sets stamped images `unavailable`, clears a primary that
    pointed at one, and requeues
- **IO**:
  - `supabase/functions/_shared/builderStock/brochureConfirmation.ts` (+ `.pure.ts`)
  - wiring in `negativeProvenance`, `sourceBranches`, `suppliedEvidence`,
    `pdfPrimaryImage`, `pdfElection*`, `pdfSourcePhoto`, `primaryImage`,
    `repairSourceImages`, `packageImages` and `settleItemImages`
  - every answer and image reached under a confirmation carries
    `identity_confirmation:{id, lot}`
  - nothing writes `source_provenance_result` on confirm or undo; a stamped
    record holds only while its confirmation stands
- **PDF wire**:
  - `PDF_ELECTION_PROTOCOL=3`, `OLDEST_PDF_ELECTION_PROTOCOL=2`
  - `electionProtocolFor(context)` returns 3 only when `confirmedLots` is non-empty
  - the worker answers in the protocol it was asked in, so the two deploy lanes
    can ship in either order
- **Portal**:
  - `builder-portal-stock` ops `confirm_brochure_image` / `undo_brochure_image`
    (permission `edit`, the same as "Add picture")
  - `decorateItems` projects `source_document_notes[].confirmable / in_use_by /
    stated_lot_listing / document_key` and `brochure_confirmations[]`, with
    states `pending | applied | not_applied | unreadable | unlinked`
- **UI**:
  - `src/components/builder-portal/BrochureConfirmation.tsx`
  - the button is "Use brochure image", with a confirmation dialog that names
    both identities and hints at transposed digits
  - an undo line is kept in reach
  - it is integrated in `BuilderStockList.tsx`
- **Docs**: `docs/builder-portal/56-a-builder-confirms-a-brochure-is-theirs.md`

**Real-data findings.** From forensics run 36011655998, read-only, on the real
stored brochures:
- **Lot 1447 · Nex 20** links **Lot 1744 · Cura 20B**'s file. It shows
  "This brochure belongs to Lot 1744 · Cura 20B…" and **no button**.
- **Lot 1037 · Vanta 20**'s own brochure, whose cover typo reads "Lot 1307",
  **is offered the button**. Replayed as if confirmed, its own photograph passes
  the display checks.

**Validation.** All of this was done before merging #106:
- unit suite 123 files / 2,464 tests
- full acceptance gate 78 fixtures / 0 fails / 15 identical limits / 0 model calls
- worker canary 44/44 in bundle mode and 39/39 live
- CPU profile unchanged
- edge typecheck, frontend typecheck, build and every static gate pass
- CI green

A confirmation is **not** an exemption from the display checks. The fixture's
first facade seed, 2046, was refused as an annotated marketing tile even when
confirmed, so the held-out fixture uses seed 2062.

---

## 5. The user's standing rules (carry these over verbatim)

- "DO NOT BREAK GOOGLE SHEETS / NOTION / URL IMPORT." "DO NOT REGRESS THE IMAGE SETTLER."
- "NO GENERATIVE AI. 0 OpenRouter, 0 Claude, 0 GPT. OCR stays Tesseract."
- "DO NOT INCREASE LIMITS AS THE FIX." "DO NOT USE THE MINUTE CRON AS STAGE TRANSPORT."
- "Do not put PDF parsing and expensive OCR/image work into the same isolate." "AN ISOLATE THAT PARSED A PDF DECODES NONE OF ITS PICTURES."
- Before shipping, run all of these: the full Builder Stock unit suite, the full
  acceptance corpus, the edge Deno typecheck, the frontend typecheck and build,
  the migration and static gates, and the CPU profile.
- "Do not merge until every CI check is green." / "Merge only when everything is green."
- Production proof is **the product doing the work**. No manual edits, and no SQL
  pushes or data fixes: **read-only SQL only**. Never modify customer data. Use
  only an isolated, network-detached proof organisation, and clean it up.
  Never mint sessions for real users.
- A held-out fixture enters the corpus **before** the code. Fixtures are
  invented and never carry personal contact details from customer documents.
- Never commit an incidental `supabase/functions/deno.lock` change.
- Develop only on `claude/busy-lovelace-8vf015`. If its PR is already merged,
  restart the branch from `main`.
- Interrupt the user only for destructive customer-data actions, new paid
  infrastructure, new credentials, security-policy changes or irreversible
  product decisions.
- This must be a permanent, global fix for every organisation and every future
  import, never a one-account patch.
- Reader 23 stays ON HOLD until the user decides.

---

## 6. Draft report to the user (not yet sent)

> "Use brochure image" is live. On a *Brochure details don't match this
> property* notice, the builder can now confirm that a brochure is theirs.
> A confirmation dialog names both lots and flags possibly swapped digits. The
> brochure's own photograph then goes through exactly the same display checks
> as any picture, and one click undoes it. The button is withheld where
> another live listing already uses that brochure's photograph for the lot it
> states. Lot 1447 · Nex 20 is told the file belongs to Lot 1744 · Cura 20B.
> Lot 1037 · Vanta 20 (cover typo "Lot 1307") is offered the button. PR #106;
> deploys verified; worker canary 39/39 live. *[Add the live proof result once
> it passes.]*

---

## 7. Environment notes for the new session

- `gh` is not available; use the GitHub MCP tools. `drive.google.com` and
  `esm.sh` are blocked from the container, so run production reads through the
  `production-rollout.yml` phases or the Supabase MCP (read-only).
- **Deploys** run on push to `main`:
  - `deploy-supabase-functions.yml` applies migrations (`scripts/ops/apply-migrations.mjs`)
    and then deploys every function
  - `deploy-pdf-worker.yml` deploys the Cloudflare worker, runs a canary before
    and after the deploy, then points Supabase at it
- **CI** (`ci.yml`) runs:
  - db baseline, verify-jwt, schema-refs and migration version/order checks
  - portal security and rate-limit coverage
  - `typecheck:edge`, `typecheck`, `npm test` and build
  - the worker build and `canary.mjs --heavy`

  There is no lint script and no acceptance gate in CI, so run the acceptance
  gate locally.
- **Acceptance gate (local)**. It needs Postgres 16 plus PostgREST; ports are
  54999 (pg), 54998 (PostgREST) and 54997 (gateway).
  - Full gate: `CORPUS=<dir> bash scripts/stock-acceptance/run.sh`
  - Focused gate: `ACCEPTANCE_DOCUMENTS_ONLY=1` with
    `scripts/stock-acceptance/harness.ts <corpus>`, after `stack-up.sh` and
    `build-database.mjs`. The old session's `mini-run.sh` did exactly that,
    plus it copied `assets/ocr/*` into `/var/tmp/acceptance-storage/builder-stock-lists/system/ocr/...`.
  - The CPU profile runs `scripts/stock-acceptance/cpu-profile.ts` over
    `/var/tmp/stress-corpus`, which `make-stress-corpus.py` generates.
- **Offline edge typecheck.** esm.sh is blocked, so the old session mapped each
  `https://esm.sh/<pkg>@<v>` import to `npm:<pkg>@<v>` in a copy of the deno
  config, and stubbed `deno.land/x/djwt` with local type declarations. Then:
  `deno check --config <that json> <files>`.
- `house_design` is **not a column**; select it as `house_design:source_row->>house_design`.
- **Reader 23 (on hold).** The branch `r23-wip` exists **only in the old
  container** (commits `10b0650` and `d128373` hold out fixtures, and `75c78e9`
  is WIP). It was never pushed, and the old session attached a `git bundle` of
  it to the chat for the user to keep. Do not start on it without the user's
  go-ahead.
