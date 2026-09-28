# 67 — An invitation has a ceiling, and one answer

28 Sep 2026. Two findings on `builder-portal-invite`, fixed together because
both are about what one organisation's owner or administrator can do with that
door: send without bound, and learn from the answer whether an arbitrary
address already has a Builder Portal account.

## 1. The ceiling

`invite` and `resend` each mint a one-time token and send an email through the
mail provider every tenant shares. Nothing bounded them — the door sat in the
rate-limit gate's EXEMPT list on the reasoning that a ceiling would cap
onboarding rather than an attacker, and doc 65's review had already named the
gap (a caller could provoke provider failures at will).

**What is counted.** Both acts, and nothing else, against two buckets in the
shared limiter (`auth_rate_limits`, through `consumeAuthRateLimit` — the same
RPC, the same fallbacks and the same 429 as every other door):

| Bucket | Key | Ceiling |
|---|---|---|
| the person | `binv_user:<session user id>` | 40 an hour |
| the organisation | `binv_org:<active organisation id>` | 100 an hour |

The person is consumed first and the check stops at the first refusal, so an
administrator over their own ceiling spends none of the organisation's.

**Why those numbers.** Production held no genuine invitation history to fit
them to: every inviter in the activity log was a proof account (the busiest
sent 11 in one hour, one organisation 12) and the largest real organisation
had two members. So they are reasoned from the workflow — an owner onboarding
an office of about thirty in one sitting, with room for resends and typos; and
several administrators doing that together. The organisation's ceiling is also
the bound on what one tenant can spend of the shared provider, however many
administrators it appoints. The hour is the window every other email-sending
door here uses (forgot-password, register, accept-invite, verify-email).

**Why identity, not the address.** The caller is authenticated, and both keys
come from the server-validated session; the caller can choose neither. The
IP-first helpers exist for doors a stranger knocks on, where the address is the
only identity there is. Here an address key would be worse than redundant:
requests arrive through the portal's `/fn` proxy, and one that reaches the
function without the proxy's proof secret — or with no trusted address header
at all — shares a bucket with every other tenant, so one organisation's burst
would refuse everybody's invitations. The gate now enforces this:
`builder-portal-invite` must call `enforceSessionRateLimit` and may not call an
IP-first helper.

**Where it sits.** After the owner/administrator check, so a member cannot
spend the organisation's allowance on requests that were going to be refused;
before anything is looked up, written, minted or sent, so a refused request
leaves no account, membership, token, email or activity entry, and the 429
cannot vary with the address asked. The body is the shared one
(`{ error, retry_after_seconds }`); the function also sets `Retry-After`, which
the portal's proxy does not forward — it carries only `content-type` and
`set-cookie`, for every door alike.

## 2. The one answer

What `invite` answered depended on an account that may belong to somebody the
caller has never met:

| The address | Before | Now |
|---|---|---|
| brand new | `success, email_sent, expires_at` | `{"success":true}` |
| a pending invitee elsewhere | `success, email_sent, expires_at` | `{"success":true}` |
| already signs in | `success, email_sent` — **no `expires_at`** | `{"success":true}` |
| revoked by an operator | `success, email_sent: false` | `{"success":true}` |
| a case-variant race | `success, email_sent: false` | `{"success":true}` |

`expires_at`'s absence said "this address already has an account", and
`email_sent: false` beside a working provider said "and it was revoked".

Every success the invite action gives now goes through
`tenantInviteResponse({ inviteUrl })`, which has no parameter through which
anything else about the invitee could arrive. The one-time link is added only
where the deployment has no mail provider at all (`mayHandLinkToInviter`,
unchanged). Nothing about expiry changed: the token's expiry is still stored
and still refused at acceptance. Whether an email left is still recorded — in
the activity log's metadata, now for the access notice to an account that
already signs in as well as for invitations. No tenant can read that: the
log's RLS admits `service_role` alone (measured: `anon` and `authenticated`
see 0 of its 2,699 rows), no edge function reads it, and the one reader a
tenant reaches, `builder_visible_activity`, returns no metadata and admits no
`portal_user` entry, which is what every invitation is logged against.

`resend` keeps its shape. It reaches only the organisation's own waiting
invitees, and nothing in its answer depends on whether that person holds an
account anywhere else.

The portal's card no longer reads either field. Its message comes from the
link alone: "If <address> can be added to <organisation>, they'll get an email
about it", or, where there is no mail provider, the link to pass on.

## 3. What this does not close

Stated so nobody reads the response fix as more than it is.

- **The members list still separates them.** An address that already signs in
  is added as a live member at once, which is the owner's recorded decision —
  there is nothing for it to accept — so `list_members` then shows a member
  where a new address shows a pending invitation, and a revoked account shows
  nothing. Closing that means changing that decision, not this door.
- **With no mail provider**, the link's presence still separates "must set a
  password" from "need not". There the inviter is the only postman; withholding
  the link would stop the deployment inviting anybody. Production has a
  provider, so it never returns a link.
- **`resend`'s 409 `already_active`** tells an organisation that its own waiting
  invitee has since activated an account, which can only have happened through
  another organisation's invitation.
- **Response time** differs by path — a revoked account sends no email, so it
  answers sooner. Measured in production and recorded by the proof run.
- **A missing token pepper** makes new and pending addresses answer 503 while
  established ones answer 200 — a misconfiguration that also stops every
  invitation, so it cannot persist unnoticed.

## 4. How it is held

- `builderInviteRateLimit.spec.ts` — the keys, the budgets, the order, and
  where the handler checks: after the role gate, before the first write, mint,
  send or log, answered with the shared 429, never an IP-first helper.
- `builderInviteOracle.spec.ts` — every 2xx in the invite block is
  `tenantInviteResponse`, neither field is named in anything it answers, the
  evidence is still logged, expiry is still enforced at acceptance, and no
  tenant-facing reader returns those log entries or their metadata.
- Both specs failed on `main`: 8 of the oracle spec's 13, and the whole ceiling
  spec — 4 of its 15 still failing once its module existed, because the handler
  had no ceiling. Five mutants — the ceiling moved after a write, moved before
  the role gate, keyed on the address, `email_sent` restored to one answer,
  `expires_at` restored to another — were each caught.
- `check-auth-rate-limit-coverage.mjs` — the door is in its own class and must
  call `enforceSessionRateLimit` and no IP-first helper.
- `portal-access-proof.mjs` sections J and K, on the live deployment with
  disposable organisations only: three addresses of each of the four kinds
  answer the same bytes while the server handles them four different ways; the
  ceiling counts once per person and per organisation, admits a burst to 40 and
  refuses past it, leaves nothing behind when it refuses, holds for a second
  administrator once the organisation's allowance is spent, and leaves another
  organisation untouched. Every proof that invites removes its own buckets, and
  the cleanup audit counts any bucket naming an account or organisation that no
  longer exists.
