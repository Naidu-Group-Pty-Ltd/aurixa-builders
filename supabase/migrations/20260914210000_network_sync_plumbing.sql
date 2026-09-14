-- ============================================================================
-- Network ↔ clone sync plumbing (extraction plan §6).
--
-- The mechanism is the clone's cross-portal outbox, mirrored: claiming by
-- rpc, exponential retry, terminal dead-lettering, and a privacy contract
-- that THROWS rather than filters. The provenance changes — the aggregate is
-- `builder_network`, the counterparty is a workspace connection, and the
-- transport is an HMAC-signed HTTP delivery to the clone's inbound door.
--
-- Rules carried from the plan:
--  * The stamp says WHETHER; a monotonic `source_version` says WHAT. The
--    stamp is stored WITH its scope, and the scope is the connection.
--  * A delivery is not an application: inbound events land in a ledger the
--    consumers converge from ("a webhook is not delivery; a sweep converges
--    the mirror"), idempotent by dedupe_key.
--  * Everything here is service-role-only. The portal reads connection state
--    through its function, never these tables.
-- ============================================================================

-- Where the network DELIVERS for this connection: the clone's
-- builder-network-inbound function (Phase 3 lands it clone-side). Nullable
-- because a connection exists before its transport is configured; the worker
-- treats a missing URL as "not yet deliverable", never as dead.
ALTER TABLE public.workspace_connections
  ADD COLUMN IF NOT EXISTS inbound_url text
    CHECK (inbound_url IS NULL OR inbound_url ~ '^https://');

COMMENT ON COLUMN public.workspace_connections.inbound_url IS
  'The clone-side builder-network-inbound endpoint this connection''s outbound deliveries POST to. Set when the clone registers its transport; NULL means queued deliveries wait.';

CREATE TABLE IF NOT EXISTS public.builder_network_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL
    REFERENCES public.workspace_connections(id) ON DELETE CASCADE,
  aggregate text NOT NULL DEFAULT 'builder_network',
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  -- Idempotency across the wire: the receiver stores this key, so a retry
  -- after a lost 200 cannot double-apply.
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_network_outbox_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT builder_network_outbox_delivery_stamp
    CHECK ((status <> 'delivered') OR (delivered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS builder_network_outbox_claim_idx
  ON public.builder_network_outbox (status, available_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS builder_network_outbox_connection_idx
  ON public.builder_network_outbox (connection_id);

CREATE TABLE IF NOT EXISTS public.builder_network_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL
    REFERENCES public.workspace_connections(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version bigint NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT builder_network_inbound_events_dedupe_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS builder_network_inbound_events_connection_idx
  ON public.builder_network_inbound_events (connection_id, received_at);
CREATE INDEX IF NOT EXISTS builder_network_inbound_events_unprocessed_idx
  ON public.builder_network_inbound_events (received_at)
  WHERE processed_at IS NULL;

-- One stamp per (connection, side). `side` is which direction the stamp
-- summarises, not who wrote it.
CREATE TABLE IF NOT EXISTS public.builder_network_stamps (
  connection_id uuid NOT NULL
    REFERENCES public.workspace_connections(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('inbound', 'outbound')),
  stamp jsonb NOT NULL,
  source_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, side)
);

ALTER TABLE public.builder_network_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_network_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_network_stamps ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_network_outbox', 'builder_network_inbound_events', 'builder_network_stamps'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_service ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
      t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- Atomic claim, the clone worker's idiom: SKIP LOCKED so two workers never
-- hold one event, a lock lease so a crashed worker's claims return, and
-- attempts bumped AT claim so the retry arithmetic cannot be skipped.
CREATE OR REPLACE FUNCTION public.builder_network_claim_outbox(
  _worker_id text,
  _limit integer DEFAULT 25
) RETURNS SETOF public.builder_network_outbox
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.builder_network_outbox o
     SET locked_at = now(),
         locked_by = _worker_id,
         attempts = o.attempts + 1
   WHERE o.id IN (
     SELECT c.id FROM public.builder_network_outbox c
      WHERE c.status = 'pending'
        AND c.available_at <= now()
        AND (c.locked_at IS NULL OR c.locked_at < now() - interval '10 minutes')
      ORDER BY c.created_at
      LIMIT greatest(1, least(_limit, 100))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.builder_network_claim_outbox(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_claim_outbox(text, integer) TO service_role;
