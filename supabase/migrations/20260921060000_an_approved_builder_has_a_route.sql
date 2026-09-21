-- ===========================================================================
-- AN APPROVED BUILDER HAS A ROUTE, AND A BUILDER WITH NO ROUTE SAYS SO.
-- ===========================================================================
--
-- THE ROOT CAUSE, traced 21 Sep 2026 across both databases. A builder's stock
-- reaches a workspace through exactly one join:
--
--     JOIN workspace_connections c ON i.organisation_id = c.builder_organisation_id
--     WHERE c.state = 'active'
--
-- and NOTHING in this platform has ever created that row except an operator
-- calling `builder-network-admin.create_connection` by hand. Registration
-- does not. Approval does not. So every organisation approved after the first
-- was born unable to reach any workspace — and silently, because an empty
-- join inserts no events, raises no error and writes no operational row.
--
-- Measured, on this database, at the moment this was written:
--
--     organisation                      status   active stock   live conns
--     Bob The Builder Pty Ltd  484b9618  active            1             0
--     Mairandi Developers      dfdbff19  active            0             1
--     NPC Services             7a637853  active            0             0
--     XT                       ffbfa1be  active            0             0
--
-- The only builder with stock had no route; the only builder with a route had
-- no stock. It had happened twice before to two other organisations, and each
-- time the remedy applied was to re-point the single connection at whichever
-- builder was live that week — which fixes one builder by unfixing another.
--
-- IDENTITY WAS NEVER THE PROBLEM, and the audit is worth recording because it
-- says what NOT to change. `builder_organisations.id` is assigned once, at
-- creation, in exactly two code paths (`create_organisation` and the
-- self-service access request), both in one function. `legal_name` is UNIQUE,
-- so the similar names in production are separate legal entities rather than
-- duplicates: "Bob The Builder" is a CLOSED organisation and "Bob The Builder
-- Pty Ltd" is a later, active one. `builder_stock_items.organisation_id` is
-- set at import and never rewritten. Both schemas already admit many builders
-- per workspace — `workspace_connections_live_key` is unique on
-- (workspace_id, builder_organisation_id) WHERE state <> 'revoked'. Nothing
-- about the identity model needed fixing; the PROVISIONING did.
--
-- SO APPROVAL PROVISIONS THE ROUTE. Approving an organisation onto the
-- builders network is the act that says this builder may supply it — there is
-- no second authorisation question for a connection to ask, and inventing one
-- is what left the answer sitting in an operator's memory. When an
-- organisation becomes `active`, it gets a live connection to every
-- registered workspace, and its existing stock is backfilled by the same
-- trigger that has always run on activation.
--
-- THE TRANSPORT IS THE WORKSPACE'S, NOT THE BUILDER'S. The HMAC secret and
-- the inbound URL address a workspace's door; every connection this network
-- holds to one workspace shares them. So a second builder needs no new
-- credential — the material is copied from the workspace's existing
-- connection and nothing is minted, logged or carried. The FIRST connection
-- to a workspace remains an operator's act, correctly: that one is a new
-- trust relationship rather than a new builder inside an existing one, and a
-- workspace that has none yet is provisioned `invited` and SAYS so.
--
-- AND THE NEW ROUTE ANNOUNCES ITSELF over the route that already works —
-- `connection.authorised`, delivered on an existing connection, applied by
-- the receiver into its own table. That is why the receiver ships first.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- WHICH WORKSPACES A NEW BUILDER IS FANNED OUT TO, AND WHY NOT ALL OF THEM.
--
-- The first cut of this migration provisioned a connection to EVERY row in
-- `workspace_registry`, and that was wrong. Traced through the code rather
-- than assumed:
--
--   * `workspace_registry` is a DIRECTORY. Its columns are `mc_clone_id`,
--     `slug`, `display_name`, `last_asserted_at` — there is no state, no
--     scope, no entitlement and no approval anywhere on it, and
--     `upsert_workspace` writes a row whenever a clone asserts itself.
--     `builder-network-admin`'s own header calls it "the workspace
--     DIRECTORY (MC -> network per §6: registry upserts and connection
--     minting)".
--   * The AUTHORISATION is `workspace_connections`, and it is deliberately
--     two-party: an operator MINTS a connection per (workspace, builder),
--     and the invite code "travels operator -> builder out of band" for the
--     BUILDER to accept. A row in the directory is neither half of that.
--   * The registered clones are independent tenants — this fleet holds
--     several — so fanning every approved builder out to every directory row
--     is automatic cross-tenant stock disclosure. It is invisible today only
--     because one workspace is registered, and it would have become a real
--     leak the day a second one asserted itself.
--
-- So the entitlement this needed did not exist, and this adds the smallest
-- one that can express it rather than a second approval system:
-- `catalogue_access` on the directory row, defaulting to `per_builder` —
-- exactly today's behaviour, where each relationship is minted and accepted
-- one at a time. A workspace an operator has declared `whole_network`
-- receives every approved builder, and that declaration is what makes the
-- provisioning below automatic for it.
--
-- FAIL-CLOSED BY DEFAULT is the whole point: a clone that registers
-- tomorrow, or one nobody has decided about, is `per_builder` and receives
-- nothing it was not individually granted. Automatic provisioning must never
-- become automatic cross-tenant disclosure.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspace_registry
  ADD COLUMN IF NOT EXISTS catalogue_access text NOT NULL DEFAULT 'per_builder';

ALTER TABLE public.workspace_registry
  DROP CONSTRAINT IF EXISTS workspace_registry_catalogue_access_check;
ALTER TABLE public.workspace_registry
  ADD CONSTRAINT workspace_registry_catalogue_access_check
  CHECK (catalogue_access IN ('per_builder', 'whole_network'));

COMMENT ON COLUMN public.workspace_registry.catalogue_access IS
  'per_builder (default): this workspace receives only builders an operator '
  'has minted a connection for and the builder has accepted. whole_network: '
  'the operator has declared that this workspace receives every approved '
  'builder, and connections for it are provisioned on approval.';

-- ---------------------------------------------------------------------------
-- A STOCK ITEM'S BUILDER IS AN INVARIANT.
--
-- The supplying organisation follows the item from upload to archive, and no
-- re-pointing of any connection may move it. Enforced at the row rather than
-- asserted in a test, because the whole class this migration closes was code
-- agreeing with itself while the database said nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_stock_organisation_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION
      'a stock item may not change builder (% -> %) — the supplying '
      'organisation is the item''s identity',
      OLD.organisation_id, NEW.organisation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

REVOKE EXECUTE ON FUNCTION public.builder_stock_organisation_is_immutable()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_stock_organisation_is_immutable()
  TO service_role;

DROP TRIGGER IF EXISTS trg_builder_stock_items_org_immutable ON public.builder_stock_items;
CREATE TRIGGER trg_builder_stock_items_org_immutable
  BEFORE UPDATE OF organisation_id ON public.builder_stock_items
  FOR EACH ROW EXECUTE FUNCTION public.builder_stock_organisation_is_immutable();

-- ---------------------------------------------------------------------------
-- PROVISION EVERY WORKSPACE ROUTE FOR ONE ORGANISATION.
--
-- Idempotent by construction: a live connection is left exactly as it is, so
-- this is safe to call on every approval, from a backfill, or twice in a row.
-- Returns how many connections it created.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_provision_connections(
  _organisation_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org record;
  v_workspace record;
  v_transport record;
  v_new_id uuid;
  v_version bigint;
  v_created integer := 0;
BEGIN
  SELECT id, legal_name, trading_name, status INTO v_org
  FROM public.builder_organisations WHERE id = _organisation_id;
  IF v_org.id IS NULL OR v_org.status <> 'active' THEN RETURN 0; END IF;

  -- ONLY the workspaces whose own declaration says they receive the whole
  -- network. A directory row is not an entitlement; `catalogue_access` is.
  FOR v_workspace IN
    SELECT w.id, w.slug FROM public.workspace_registry w
    WHERE w.catalogue_access = 'whole_network'
  LOOP
    -- A live connection already answers the question.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.workspace_connections c
      WHERE c.workspace_id = v_workspace.id
        AND c.builder_organisation_id = _organisation_id
        AND c.state <> 'revoked');

    -- The workspace's own transport, taken from any connection that already
    -- holds it. This is a COPY of addressing material, never a new secret.
    SELECT c.id, c.inbound_url, c.outbound_hmac_secret INTO v_transport
    FROM public.workspace_connections c
    WHERE c.workspace_id = v_workspace.id
      AND c.state = 'active'
      AND c.outbound_hmac_secret IS NOT NULL
      AND c.inbound_url IS NOT NULL
    ORDER BY c.accepted_at NULLS LAST
    LIMIT 1;

    -- THE ID IS MINTED FIRST, so the announcement can be queued AHEAD of the
    -- stock the connection's own INSERT trigger is about to backfill. The
    -- outbox drains in creation order, and a stock event addressed to a
    -- connection the receiver has not installed yet is refused and retried —
    -- correct, but a round trip bought for nothing.
    v_new_id := gen_random_uuid();

    IF v_transport.id IS NOT NULL THEN
      v_version := public.builder_network_next_outbound_version(v_transport.id);
      INSERT INTO public.builder_network_outbox(
        connection_id, event_type, dedupe_key, payload, source_version)
      VALUES (v_transport.id, 'connection.authorised',
              'connection.authorised:' || v_new_id,
              jsonb_build_object(
                'network_connection_id', v_new_id,
                'builder_organisation_id', _organisation_id,
                'legal_name', v_org.legal_name,
                'trading_name', v_org.trading_name,
                'state', 'active'),
              v_version)
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;

    INSERT INTO public.workspace_connections(
      id, workspace_id, builder_organisation_id, state, initiated_by,
      inbound_url, outbound_hmac_secret, accepted_at, hmac_provisioned_at)
    VALUES (
      v_new_id, v_workspace.id, _organisation_id,
      -- No transport yet means the workspace itself has never been bootstrapped.
      -- The connection is still recorded, as `invited`, so the state is a fact
      -- somebody can read rather than an absence nobody can.
      CASE WHEN v_transport.id IS NULL THEN 'invited' ELSE 'active' END,
      -- The CHECK admits 'workspace' or 'builder'; the network provisions on
      -- the WORKSPACE's behalf, which is what approval authorised.
      'workspace',
      v_transport.inbound_url, v_transport.outbound_hmac_secret,
      CASE WHEN v_transport.id IS NULL THEN NULL ELSE now() END,
      CASE WHEN v_transport.id IS NULL THEN NULL ELSE now() END);
    v_created := v_created + 1;

    INSERT INTO public.workspace_connection_events(
      connection_id, event_type, actor_side, detail)
    VALUES (v_new_id, 'connection_provisioned', 'platform',
            jsonb_build_object(
              'reason', 'organisation approved onto the network',
              'workspace_slug', v_workspace.slug,
              'transport', CASE WHEN v_transport.id IS NULL
                                THEN 'workspace_not_bootstrapped'
                                ELSE 'copied_from_workspace' END));

    IF v_transport.id IS NULL THEN
      INSERT INTO public.portal_operational_events(
        event_name, severity, request_id, actor_type, portal, success, metadata)
      VALUES ('builder_network_workspace_has_no_transport', 'warning',
              v_new_id::text, 'system', 'builder', false,
              jsonb_build_object('workspace_id', v_workspace.id,
                                 'workspace_slug', v_workspace.slug,
                                 'builder_organisation_id', _organisation_id));
      CONTINUE;
    END IF;

    -- The stock itself needs no call from here: the connection's own INSERT
    -- trigger backfills it. Asking twice would mint a second outbound version
    -- per item and send every property across the wire twice.
  END LOOP;

  RETURN v_created;
END $function$;

-- An operator's instrument and a trigger's, never a browser's. CREATE grants
-- EXECUTE to PUBLIC and this project's default privileges grant it to `anon`
-- and `authenticated` directly, so all three are closed; the activation
-- trigger reaches it as the definer and needs no grant of its own.
REVOKE EXECUTE ON FUNCTION public.builder_network_provision_connections(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_network_provision_connections(uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- APPROVAL IS THE AUTHORISATION, so approval provisions the route.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_organisation_activated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    PERFORM public.builder_network_provision_connections(NEW.id);
  END IF;
  RETURN NEW;
END $function$;

-- A trigger function is invoked by the DML that fires it rather than called,
-- so the browser roles are closed. service_role keeps EXECUTE because this
-- deployment's baseline proof asserts the service role has not lost it on any
-- schema-owned function — a lock-out that passed the first half of that proof
-- and failed the second is exactly what it exists to catch.
REVOKE EXECUTE ON FUNCTION public.builder_organisation_activated()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_organisation_activated() TO service_role;

DROP TRIGGER IF EXISTS trg_builder_organisation_activated ON public.builder_organisations;
CREATE TRIGGER trg_builder_organisation_activated
  AFTER INSERT OR UPDATE OF status ON public.builder_organisations
  FOR EACH ROW EXECUTE FUNCTION public.builder_organisation_activated();

-- ---------------------------------------------------------------------------
-- A CONNECTION THAT ARRIVES ACTIVE BACKFILLS TOO.
--
-- The activation trigger only ever watched UPDATE, because until now every
-- connection was born `invited` and accepted later. One provisioned straight
-- to `active` would have queued nothing until its builder next touched a row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_connection_activated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.state = 'active'
     AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'active') THEN
    PERFORM public.builder_network_backfill_stock_sync(NEW.id);
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_builder_network_connection_activated ON public.workspace_connections;
CREATE TRIGGER trg_builder_network_connection_activated
  AFTER INSERT OR UPDATE OF state ON public.workspace_connections
  FOR EACH ROW EXECUTE FUNCTION public.builder_network_connection_activated();

-- ---------------------------------------------------------------------------
-- A ROUTE THAT MATCHED NOTHING IS A FACT, NOT A SILENCE.
--
-- `builder_network_enqueue_stock_item` composed a payload and found no
-- connection for the item's organisation — and returned 0 as though nothing
-- had happened. That is the exact shape of this whole defect, so it now
-- records itself. Rate-limited to one row per organisation per hour, because
-- an unrouted builder editing a stock list would otherwise write a row per
-- keystroke and a flood is its own kind of silence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.builder_network_enqueue_stock_item(_item_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conn record;
  v_payload jsonb;
  v_version bigint;
  v_count integer := 0;
  v_item record;
BEGIN
  v_payload := public.builder_network_compose_stock_item_payload(_item_id);
  IF v_payload IS NULL THEN RETURN 0; END IF;
  FOR v_conn IN
    SELECT c.id
    FROM public.workspace_connections c
    JOIN public.builder_stock_items i ON i.organisation_id = c.builder_organisation_id
    WHERE i.id = _item_id AND c.state = 'active'
  LOOP
    v_version := public.builder_network_next_outbound_version(v_conn.id);
    INSERT INTO public.builder_network_outbox(
      connection_id, event_type, dedupe_key, payload, source_version)
    VALUES (v_conn.id, 'stock.item.upserted',
            'stock.item:' || v_conn.id || ':' || _item_id || ':' || v_version,
            v_payload, v_version)
    ON CONFLICT (dedupe_key) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    SELECT i.organisation_id, i.lifecycle_status INTO v_item
    FROM public.builder_stock_items i WHERE i.id = _item_id;
    IF v_item.lifecycle_status = 'active' AND NOT EXISTS (
      SELECT 1 FROM public.portal_operational_events e
      WHERE e.event_name = 'builder_network_stock_has_no_route'
        AND e.metadata->>'builder_organisation_id' = v_item.organisation_id::text
        AND e.occurred_at > now() - interval '1 hour')
    THEN
      INSERT INTO public.portal_operational_events(
        event_name, severity, request_id, actor_type, portal, success, metadata)
      VALUES ('builder_network_stock_has_no_route', 'critical',
              _item_id::text, 'system', 'builder', false,
              jsonb_build_object(
                'builder_organisation_id', v_item.organisation_id,
                'stock_item_id', _item_id,
                'active_stock_count', (
                  SELECT count(*) FROM public.builder_stock_items x
                  WHERE x.organisation_id = v_item.organisation_id
                    AND x.lifecycle_status = 'active'),
                'reason', 'no_authorised_connection'));
    END IF;
  END IF;

  RETURN v_count;
END $function$;

-- ---------------------------------------------------------------------------
-- WHAT EVERY BUILDER'S DISTRIBUTION ACTUALLY LOOKS LIKE.
--
-- A view, not a table anybody writes: a written state is one more thing that
-- can disagree with the rows it describes, which is the failure this whole
-- migration exists to end. Queryable from production, one row per active
-- organisation, whether or not it has a route.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.builder_network_sync_state
WITH (security_invoker = true) AS
SELECT
  o.id                                       AS builder_organisation_id,
  COALESCE(o.trading_name, o.legal_name)     AS builder_label,
  o.status                                   AS organisation_status,
  (SELECT count(*) FROM public.builder_stock_items i
    WHERE i.organisation_id = o.id AND i.lifecycle_status = 'active')
                                             AS active_stock_count,
  (SELECT count(*) FROM public.workspace_connections c
    WHERE c.builder_organisation_id = o.id AND c.state = 'active')
                                             AS authorised_destinations,
  (SELECT count(*) FROM public.workspace_connections c
    WHERE c.builder_organisation_id = o.id AND c.state = 'invited')
                                             AS pending_destinations,
  (SELECT count(*) FROM public.builder_network_outbox b
    JOIN public.workspace_connections c ON c.id = b.connection_id
    WHERE c.builder_organisation_id = o.id AND b.status = 'pending')
                                             AS events_queued,
  (SELECT count(*) FROM public.builder_network_outbox b
    JOIN public.workspace_connections c ON c.id = b.connection_id
    WHERE c.builder_organisation_id = o.id AND b.status = 'dead')
                                             AS events_dead,
  (SELECT max(b.delivered_at) FROM public.builder_network_outbox b
    JOIN public.workspace_connections c ON c.id = b.connection_id
    WHERE c.builder_organisation_id = o.id)  AS last_delivered_at,
  CASE
    WHEN o.status <> 'active'                                      THEN 'organisation_inactive'
    WHEN (SELECT count(*) FROM public.workspace_connections c
           WHERE c.builder_organisation_id = o.id AND c.state = 'active') = 0
         AND (SELECT count(*) FROM public.builder_stock_items i
               WHERE i.organisation_id = o.id AND i.lifecycle_status = 'active') > 0
                                                                   THEN 'no_authorised_connection'
    WHEN (SELECT count(*) FROM public.workspace_connections c
           WHERE c.builder_organisation_id = o.id AND c.state = 'active') = 0
                                                                   THEN 'awaiting_connection'
    WHEN (SELECT count(*) FROM public.builder_network_outbox b
           JOIN public.workspace_connections c ON c.id = b.connection_id
           WHERE c.builder_organisation_id = o.id AND b.status = 'dead') > 0
                                                                   THEN 'delivery_failed'
    WHEN (SELECT count(*) FROM public.builder_network_outbox b
           JOIN public.workspace_connections c ON c.id = b.connection_id
           WHERE c.builder_organisation_id = o.id AND b.status = 'pending') > 0
                                                                   THEN 'syncing'
    ELSE 'synced'
  END                                        AS sync_state
FROM public.builder_organisations o;

COMMENT ON VIEW public.builder_network_sync_state IS
  'One row per builder organisation: active stock, authorised destinations, '
  'queued and dead events, and the distribution state derived from them. '
  'no_authorised_connection is the state that used to be silent.';

-- ---------------------------------------------------------------------------
-- AND THE BUILDERS THAT ARE ALREADY APPROVED GET THEIR ROUTES NOW.
--
-- Exactly what the trigger would have done had it existed when each was
-- approved. It creates connections and never moves one: an organisation that
-- already holds a live connection is skipped, so no builder's route is taken
-- to give another builder one.
-- ---------------------------------------------------------------------------
-- THE ONE-TIME DECLARATION, for the workspaces an operator has ALREADY put
-- on the builders network through the two-party ceremony. A workspace holding
-- a live connection has been minted for and accepted by a builder; declaring
-- it whole-network records the intent the product owner has stated for it,
-- and it cannot reach a clone that has never been connected. Every clone that
-- registers after this is `per_builder` and receives nothing it was not
-- individually granted.
UPDATE public.workspace_registry w
   SET catalogue_access = 'whole_network', updated_at = now()
 WHERE w.catalogue_access = 'per_builder'
   AND EXISTS (
     SELECT 1 FROM public.workspace_connections c
     WHERE c.workspace_id = w.id AND c.state <> 'revoked');

DO $$
DECLARE v_org record; v_made integer; v_total integer := 0;
BEGIN
  FOR v_org IN
    SELECT id FROM public.builder_organisations WHERE status = 'active' ORDER BY created_at
  LOOP
    v_made := public.builder_network_provision_connections(v_org.id);
    v_total := v_total + v_made;
  END LOOP;
  RAISE NOTICE 'builder network: provisioned % connection(s)', v_total;
END $$;
