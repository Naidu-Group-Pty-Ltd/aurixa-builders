# 65 — One invitation opens one organisation

Found by the client-readiness audit on 27 Sep 2026 and closed on 28 Sep. It was
the audit's one Critical finding and one of its two client-ready blockers.

## 1. The defect

The invite token lives on `builder_portal_users`, so it is a credential for an
**account**. The things it lights up are **memberships**, and those belong to
organisations. Nothing reconciled the two.

1. Organisation A's owner or administrator invites an address that is still a
   pending invitee of organisation B. `invite` re-mints the account's one
   token, replacing B's.
2. **Any** failure of the send hands the plaintext link back to A's
   administrator in the response. The audit reported that as near-certain
   because 110 of 110 invitations since 16 Sep had been refused; §4 records why
   that reading was wrong and what it actually measured. The defect does not
   depend on it — a bounced address, a provider outage or a rate limit reaches
   the same branch, and the link is the credential either way.
3. Accepting that link activated the **account**, and every membership it held
   came alive with it — B's too, up to `owner`. It also stamped
   `email_verified_at` with nobody having proved they hold the mailbox.

A second route reached the same place: claim an address first, and a later
invitation from another organisation lands on the attacker's account.

At the time it was found, production held **0 pending invitees across 6
accounts**, so nobody was exposed. It became exploitable the first time a
client organisation had a pending invitee — which is the first week of having
clients.

It was reproduced with disposable organisations only, and never against a
genuine record.

## 2. The rules

**A grant to an account that cannot sign in yet WAITS.** Its status is
`invited`, and acceptance promotes exactly the organisation whose token was
accepted. Every other organisation stays waiting until its own invitation is
accepted.

Nothing new enforces it. `builder_accessible_organisations` has always required
`status = 'active'`, so a waiting membership is invisible to session issue,
organisation selection and every authorisation check. The gate is one that
already existed, is already asserted by the access proof's role matrix, and did
not have to be trusted afresh.

**The token remembers its organisation.** `invite_token_organisation_id` is
written when a token is minted and cleared when it is spent. Acceptance scopes
on it rather than inferring a scope from the account's whole membership set,
which is the defect.

**A link is never handed to an organisation the address does not belong to.**
The one-time link is returned so an inviter can pass it on where mail is not
configured, and that convenience was the takeover's delivery mechanism. It is
withheld unless every membership the account holds is the caller's own
organisation. The refusal names no other organisation: a caller who may not
hold the link may not learn where else the address belongs. A read that
**failed** withholds it too — fail closed, rather than decide on missing
evidence.

**The acceptance form names one organisation.** It used to list every
organisation the address was pending in, to whoever held the link.

Three more things the rules had to get right, each found while making them:

- **A waiting seat must not be stuck for ever.** Adding a colleague who already
  signs in is not an invitation and mints nothing, so nothing would promote a
  membership an earlier invitation had left `invited`: the "you now have
  access" notice would promise access the portal refused. Re-granting promotes
  it — only from `invited`, never from `suspended`, which is an
  administrator's decision an invitation may not undo.

  **The same stranding was worse on the operator's own two doors**, and was
  found by looking for it there once it was fixed in the portal: an owner seat
  left waiting leaves an organisation with **no reachable owner and no surface
  able to repair it**, because the only other route in is an invitation from
  somebody inside it. Both doors promote now.

  Four call sites needed that rule, so it is written once
  (`promoteWaitingMembership` in `_shared/builderInvite.ts`) and none of them
  restates it. The spec pins it as the **defect** rather than as "no door
  updates a membership": revoking an invitation legitimately writes one
  directly, and a guard broad enough to forbid that would have to be relaxed
  for it and would then stop seeing the thing it is for. What no door may do is
  bring a membership **up** by hand.
- **A waiting membership is not one that ended.** It is not live, so the
  refusal explainer read it as `membership_ended` and told a pending invitee
  their access "has been withdrawn or has expired". `invitation_pending` is its
  own reading, before the ended case, precisely because it is not one.
- **Promotion happens after the single-use update**, which is the statement that
  decides the race. If promotion then fails, the account is active with nothing
  accessible: the session is refused and the existing "activated, not yet
  allowed in" branch explains it. That fails closed and a re-send recovers it.
  Promoting first would risk a live membership on an account that a different
  token later activates — the very thing this prevents.

An operator-created first owner answers to the same rule
(`builder-network-admin`, both doors). Left live while its account was pending,
an invitation accepted in some other organisation would have brought that owner
seat up with it.

A token minted before this rule carries no organisation. It is honoured only
where the account holds exactly one organisation, so nothing else can come
alive with it, and refused where it spans several rather than guessed.
Production held no such token when this shipped.

## 3. Proof

- `supabase/functions/_shared/builderInviteScope.pure.ts` holds the rules;
  `src/lib/__tests__/builderInviteScope.spec.ts` tests them without a database
  and reads the handlers' source to assert each one asks the module rather than
  restating it.
- `src/lib/__tests__/builderAccessDenial.spec.ts`: the pending reading, and
  that a revoked membership still reads as ended.
- Production-rollout phase `email-delivery-proof` settles §4's diagnosis from
  the database and drives one invitation and one password reset to a mailbox the
  operator supplies.
- Production-rollout phase `portal-access-proof`, section **I**: the whole
  attack on the live deployment with disposable organisations — B invites, A
  invites the same address, the link is withheld, the form names one
  organisation, acceptance activates A, **B is untouched**, the issued session
  reaches A and no other, selecting B is refused 403 by the server, and B can
  still add them itself afterwards so nobody is stranded.
- Migration `20260928090000` adds the status and the column and changes no
  existing row.
- The guards were each shown to FAIL on the defect before being trusted: a
  hand-written unscoped `status: 'active'` in the acceptance handler fails three
  of them, and the whole file passes once it is put back. One assertion had to be
  renegotiated in the process, and it is the more useful half — it read
  `.eq('organisation_id'` in the acceptance handler, which is a statement about
  where the promotion happened to be WRITTEN rather than about what it does, so
  moving the statement into the shared helper broke it while the behaviour was
  unchanged, and a leftover copy would have kept it green.

## 4. The other blocker, and why it made this one live

A failed send is what put the one-time link in the inviting administrator's
hands, so the two findings were reported together. **The first explanation
offered for the failures was wrong**, and the way it was wrong is the more
useful half of this section.

The audit read *"110 of 110 invitations since 16 Sep were refused, each logged
`Resend refused the send 422`"* and concluded the sender must be unverified:
`global_report_settings` is empty on this deployment, so the tenant's
configured address is absent. That reasoning skipped the rule
`brand-config.ts` states in its own header — **`RESEND_FROM_EMAIL` is resolved
FIRST**, ahead of any setting — and
`deploy-supabase-functions.yml` has been setting it to
`noreply@send.builders.aurixasystems.com.au` on every deploy, whose domain is
verified in the account this project's key belongs to. So the sender was never
the fault.

What the failures actually have in common is the **recipient**. Every one of
them was a proof-suite invitation to `@example.com` or `@smoke.example` —
reserved names that no mail system will ever deliver to and that Resend refuses
at the API. Two sends to real mailboxes, the access-request invitations of
18 Sep 2026, were **accepted**: `builder_access_requests.invite_sent` is
written only from a response the provider answered 2xx to.

So the corpus proved nothing either way, in both directions. **An instrument
that can only send to a reserved domain cannot measure delivery**, and 110
refusals from one are not evidence of a broken configuration any more than they
are evidence of a working one.

Three things follow.

- **Nothing about the provider or the credentials needs changing.** The
  configuration question this blocker raised is closed by measurement, not by
  an edit.
- **The diagnosis is now made by the instrument, not by an opinion.** The
  `email-delivery-proof` phase counts the recipient KIND of every invitation
  ever sent — in the database, so no address is selected and no real domain is
  named — and asserts that no refusal ever went to a recipient that could have
  received it, and that a real mailbox has been accepted. A deleted account is
  itself evidence of a disposable one: `builder_portal_activity_log` has no
  foreign key to the user (its own comment: the audit trail outlives the
  records it describes), so the invitation rows survive a proof run's cleanup
  while the accounts do not, and no real account is ever deleted here.
- **A refusal now says what it was.** Both send sites logged the status and
  nothing else — and the reset site discarded the response entirely, so a reset
  email that never left could not be told from one that did, on a door that
  answers generically by design and therefore has the operational log as its
  only witness. Each now records the provider's own message and the sender it
  tried, and **never the recipient**: a refusal is a fact about this
  deployment's configuration, not about a customer.

The one thing measurement cannot supply is a mailbox. The provider accepting a
send is not a mailbox receiving it, and nothing in this repository can assert
the second. That is why the phase takes one address the operator controls, in
the environment rather than in the source, prints only its domain, and refuses
a reserved name up front — because a pass against one would reproduce the very
blind spot it exists to close.
