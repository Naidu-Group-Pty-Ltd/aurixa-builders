-- Builder Stock — authority for the Google Sheets hyperlink recovery callback.
--
--
-- WHY THIS TABLE EXISTS.
--
-- A Google Sheet whose owner has not enabled file export answers `/export`
-- with a sign-in page, and `/export` is the ONLY public representation that
-- carries a cell's link target. Measured against a live document: `/export`
-- (xlsx and csv) and `/pubhtml` all 401, while `gviz` in every output mode
-- returns the cell text with zero anchors and zero file ids. The brochure
-- address never reaches this product.
--
-- The recovery is performed elsewhere, by a Make scenario holding its own
-- authorised Google connection, which reads the same sheet and posts the
-- targets back. That callback is an inbound write path that decides what a
-- client sees on a property card, so the single most important property of
-- this design is:
--
--     THE CALLBACK CANNOT NAME ITS OWN AUTHORITY.
--
-- The body carries a request id and grid data. Which organisation, which
-- upload and therefore which properties may be touched are read from THIS
-- ROW, written by this product at the moment it asked. A caller who forges an
-- entire payload still cannot reach another organisation's stock, because
-- nothing in the payload is consulted to decide whose stock is reachable.
--
-- The row is also the replay guard: `consumed_at` makes a request single-use,
-- and `expires_at` makes a leaked id worthless after thirty minutes.
--
-- AUTHORISATION IS A ONE-TIME CAPABILITY, AND ONLY ITS HASH LIVES HERE.
--
-- Each request mints its own 256-bit token, sends it to Make, and stores the
-- SHA-256 of it in `callback_token_hash`. The plaintext is never written down,
-- so this table cannot leak anything that answers a request; and because the
-- token dies with the request, one sitting in a third party's execution log is
-- worth a single answer to a question already asked. That is what replaced a
-- long-lived secret held in two systems, which had to be distributed by hand
-- and was worth every future request for as long as it lived.

CREATE TABLE IF NOT EXISTS public.builder_stock_link_recovery_requests (
  -- The nonce. Unguessable, single-use, and the only thing the callback
  -- presents that this product will look up.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The authority. Never accepted from a callback; only ever written here.
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL
    REFERENCES public.builder_stock_uploads(id) ON DELETE CASCADE,

  -- What was asked for, so what comes back can be checked against it. BOTH are
  -- binding: an answer naming another document, or another tab of this one, is
  -- an answer to a different question and is refused rather than reconciled.
  spreadsheet_id text NOT NULL,
  gid text,

  -- SHA-256, lower-case hex, of the one-time callback token. NEVER the token.
  -- The constraint is a floor under that rule: a 64-character hex digest is
  -- the only thing this column can hold, so a plaintext token written here by
  -- mistake is rejected by the database rather than stored.
  callback_token_hash text NOT NULL
    CHECK (callback_token_hash ~ '^[0-9a-f]{64}$'),

  status text NOT NULL DEFAULT 'requested'
    CHECK (status = ANY (ARRAY[
      'requested'::text,   -- created, Make not yet answered
      'dispatched'::text,  -- Make accepted the webhook
      'fulfilled'::text,   -- a callback was applied
      'refused'::text,     -- a callback arrived and was rejected
      'failed'::text,      -- Make could not be reached
      'expired'::text      -- the window closed unanswered
    ])),

  -- Where the request came from. Diagnostics only; never authority.
  origin text NOT NULL DEFAULT 'import'
    CHECK (origin = ANY (ARRAY['import'::text, 'manual_refresh'::text])),

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,

  -- Minimal result metadata, for the portal and for verification.
  rows_returned integer NOT NULL DEFAULT 0,
  links_applied integer NOT NULL DEFAULT 0,
  properties_reopened integer NOT NULL DEFAULT 0,
  refusal_reason text
);

-- The callback looks a request up by id alone; the sweep reads by expiry.
CREATE INDEX IF NOT EXISTS builder_stock_link_recovery_open_idx
  ON public.builder_stock_link_recovery_requests (expires_at)
  WHERE consumed_at IS NULL;

-- The manual refresh rate limit reads the most recent request for an upload.
CREATE INDEX IF NOT EXISTS builder_stock_link_recovery_upload_idx
  ON public.builder_stock_link_recovery_requests (upload_id, created_at DESC);

/*
 * NOBODY BUT THE SERVER. This table is the authority the callback is checked
 * against, so a client that could read it could forge a callback, and a client
 * that could write it could grant itself authority over another organisation's
 * stock. RLS is enabled with NO policy at all: that denies every anon and
 * authenticated request outright, while the service role — which bypasses RLS
 * — continues to work. There is deliberately no builder-facing read.
 */
ALTER TABLE public.builder_stock_link_recovery_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_stock_link_recovery_requests FROM PUBLIC, anon, authenticated;


-- ── Why there is no per-organisation gate ───────────────────────────────────
/*
 * An earlier draft carried an internal allowlist, so the recovery ran only for
 * organisations somebody had opted in. The reasoning was budget: the path
 * spends a metered third-party allowance shared across every builder.
 *
 * It was the wrong trade. A Google Sheet whose link targets this product
 * cannot read is the SAME DEFECT whoever uploaded it, and gating the fix per
 * tenant means every other builder's brochures go on silently not arriving
 * until a human notices and adds a row. A fix that only works for the
 * organisation somebody remembered is not a fix; it is a support queue.
 *
 * What actually bounds the spend is narrowness and rate limiting, not a list
 * of approved tenants. `shouldRequestLinkRecovery` asks only for a Google
 * Sheet, only on the one reading that means the workbook never arrived, and
 * only where a webhook is configured at all; the manual refresh is capped at
 * one per upload per ten minutes on the server, and the callback is rate
 * limited per organisation on the authority it recovered.
 */
