-- ============================================================================
-- Self-registration and email verification (extraction plan §5).
--
-- The prime's portal is invite-only: an operator mints the account and the
-- invite token's acceptance proves the mailbox. The network is a product a
-- builder signs up FOR, so it gains the second door — and the second door is
-- what makes email verification a governance stage of its own.
--
-- Three shapes, three rules:
--
--  * `builder_portal_users.email_verified_at` — a timestamp, not a boolean,
--    because WHEN a mailbox was proven matters in an audit. Backfilled from
--    `invite_accepted_at`: accepting an invite token that travelled by email
--    IS a proof of the mailbox, and without the backfill every existing user
--    would be locked behind a verification nobody owed.
--
--  * `builder_email_verification_tokens` — its OWN table in the reset-token
--    shape (hash-only, expiry, single consumption), never the invite columns:
--    an invite is an operator's act with organisation bindings hanging off
--    it, and overloading it for self-service verification is how a
--    registration comes to look like an invitation nobody sent.
--
--  * `builder_org_join_requests` — the "existing organisation" path. A
--    registrant whose ABN matches an existing organisation NEVER auto-joins
--    (a domain or ABN match is a claim, not a grant); they get a pending
--    request an owner decides. One open request per (org, user), enforced
--    by a partial unique index rather than trusted to the application.
--
-- `builder_organisations.status` gains 'pending_verification': a
-- self-registered organisation awaiting vetting, distinct from
-- 'pending_activation' (operator-created, awaiting activation) because the
-- two states have different owners and different remedies.
-- ============================================================================

ALTER TABLE public.builder_portal_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

COMMENT ON COLUMN public.builder_portal_users.email_verified_at IS
  'When this user''s mailbox was proven — by verify-email token, invite acceptance, or password reset. NULL blocks the portal at governance stage email_verification_required.';

-- An accepted invite proved the mailbox on the day it was accepted.
UPDATE public.builder_portal_users
   SET email_verified_at = invite_accepted_at
 WHERE invite_accepted_at IS NOT NULL
   AND email_verified_at IS NULL;

-- Self-registered organisations arrive pending VETTING, not activation.
ALTER TABLE public.builder_organisations
  DROP CONSTRAINT IF EXISTS builder_organisations_status_check;
ALTER TABLE public.builder_organisations
  ADD CONSTRAINT builder_organisations_status_check
  CHECK (status = ANY (ARRAY[
    'pending_verification'::text,
    'pending_activation'::text,
    'active'::text,
    'suspended'::text,
    'closed'::text
  ]));

CREATE TABLE IF NOT EXISTS public.builder_email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL
    REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  -- Hash-only, like the reset token: a database leak yields nothing usable.
  token_hash text NOT NULL
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_email_verification_tokens_hash_key
  ON public.builder_email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS builder_email_verification_tokens_user_idx
  ON public.builder_email_verification_tokens (builder_user_id);

ALTER TABLE public.builder_email_verification_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS builder_email_verification_tokens_service
  ON public.builder_email_verification_tokens;
CREATE POLICY builder_email_verification_tokens_service
  ON public.builder_email_verification_tokens
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.builder_email_verification_tokens FROM anon, authenticated;
GRANT ALL ON public.builder_email_verification_tokens TO service_role;

CREATE TABLE IF NOT EXISTS public.builder_org_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  builder_user_id uuid NOT NULL
    REFERENCES public.builder_portal_users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined')),
  message text,
  decided_by uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A decision carries its stamp; a pending request carries none.
  CONSTRAINT builder_org_join_requests_decision_stamp
    CHECK ((status = 'pending') = (decided_at IS NULL))
);

-- One OPEN request per (organisation, registrant). History may hold many.
CREATE UNIQUE INDEX IF NOT EXISTS builder_org_join_requests_open_key
  ON public.builder_org_join_requests (organisation_id, builder_user_id)
  WHERE status = 'pending';

ALTER TABLE public.builder_org_join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS builder_org_join_requests_service
  ON public.builder_org_join_requests;
CREATE POLICY builder_org_join_requests_service
  ON public.builder_org_join_requests
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.builder_org_join_requests FROM anon, authenticated;
GRANT ALL ON public.builder_org_join_requests TO service_role;
