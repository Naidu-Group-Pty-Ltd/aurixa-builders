-- ============================================================================
-- THE BUILDER RANKING — the network decides the order, once, for every clone.
--
-- The marketplace ordered by `created_at DESC` on every deployment. In a
-- multi-vendor marketplace that is not "no ranking": it is a ranking that
-- rewards whoever uploaded last, that no builder can be told, and that no
-- operator can defend. This migration gives the order a source, a record and a
-- set of instruments.
--
-- WHAT IS HERE AND WHAT IS DELIBERATELY NOT. The scoring ITSELF is not here.
-- It lives in `_shared/builderStock/builderRanking.pure.ts` and runs in
-- `builder-ranking-recompute`, for one reason that this platform has already
-- paid for twice: whether a photograph may be drawn on a card is decided by
-- `isDisplayableSourceImage` — six conditions, a sanitised-derivative lookup
-- and an overlay clearance — and `listing_quality` is exactly the share of a
-- builder's stock that passes it. Restating that predicate in SQL would create
-- a second implementation of a judgement this repository keeps in one place,
-- and the two would agree right up until one of them was improved.
--
-- So SQL holds the RECORD and the INSTRUMENTS:
--
--   builder_ranking_snapshots      what the last run concluded about a builder
--   builder_stock_item_ranks       and about each of their properties
--   builder_ranking_overrides      an operator's pin or suppression
--   builder_commercial_placements  a paid position, with its window
--   builder_ranking_state          the freeze, and when the last run finished
--
-- FOUR RULES ARE ENFORCED IN THE SCHEMA RATHER THAN TRUSTED TO CALLERS.
--
--   A merit score and a commercial placement are different columns on
--   different tables and no constraint, trigger or view ever adds one to the
--   other. A builder's `merit_score` stays a true statement about the builder
--   whatever they have paid for, which is what makes it something you can show
--   them and something an adviser's card can honestly label.
--
--   An override carries a reason, and the column is NOT NULL with a length
--   floor. An intervention nobody wrote down is indistinguishable from the
--   algorithm's own answer six months later, and this is the surface where
--   that distinction is the whole point.
--
--   An override LAPSES. `expires_at` defaults to 90 days out rather than to
--   NULL, because the failure mode here is not somebody setting a bad expiry —
--   it is a commercial arrangement from last spring quietly still shaping the
--   marketplace because nobody revisited it. A standing override is available
--   and must be asked for explicitly.
--
--   Suppression is never deletion. A suppressed builder's stock stays in every
--   table, keeps its rank row, and returns the moment the override lapses or is
--   revoked. Nothing here can destroy a listing.
-- ============================================================================

-- ===========================================================================
-- 1. What a builder is known to have been doing, beyond this network
-- ===========================================================================

/*
 * TENURE CANNOT BE READ FROM `created_at`.
 *
 * That column says when a builder joined the Builders Network. Measured 17 Sep
 * 2026, the network's two organisations joined on 4 Aug and 7 Sep of this year
 * and neither began trading then. Scoring a join date as "years operating"
 * would not be an approximation, it would be a fabrication — and it would make
 * every builder who ever joins permanently new.
 *
 * So tenure is DECLARED, and how it is known travels with it. A date read from
 * the ABR against the builder's own ABN is a fact and scores in full; a date
 * the builder typed is a claim and is capped below a verified one, so a claim
 * can never out-rank a checked fact. Neither present is `not_measured`, never
 * "new" — the same rule the join-request path already states about an ABN
 * match: it is a claim, not a grant.
 */
ALTER TABLE public.builder_organisations
  ADD COLUMN IF NOT EXISTS established_on date,
  ADD COLUMN IF NOT EXISTS abn_registered_on date,
  ADD COLUMN IF NOT EXISTS abn_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reputation_score smallint,
  ADD COLUMN IF NOT EXISTS reputation_source text,
  ADD COLUMN IF NOT EXISTS reputation_note text,
  ADD COLUMN IF NOT EXISTS reputation_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS reputation_recorded_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'builder_organisations_reputation_range') THEN
    ALTER TABLE public.builder_organisations
      ADD CONSTRAINT builder_organisations_reputation_range
      CHECK (reputation_score IS NULL OR (reputation_score >= 0 AND reputation_score <= 100));
  END IF;
  -- A recorded standing that names no source and no date is an opinion with
  -- nobody's name on it. All three travel together or none of them do.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'builder_organisations_reputation_provenance') THEN
    ALTER TABLE public.builder_organisations
      ADD CONSTRAINT builder_organisations_reputation_provenance
      CHECK (
        reputation_score IS NULL
        OR (reputation_recorded_at IS NOT NULL
            AND reputation_source IS NOT NULL
            AND btrim(reputation_source) <> '')
      );
  END IF;
  -- An ABR verification stamp with no date verified nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'builder_organisations_abn_verification_pair') THEN
    ALTER TABLE public.builder_organisations
      ADD CONSTRAINT builder_organisations_abn_verification_pair
      CHECK (abn_verified_at IS NULL OR abn_registered_on IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.builder_organisations.established_on IS
  'When the builder says they began trading. A CLAIM: scored, but capped below a verified date so it can never out-rank one. Never inferred from created_at, which is when they joined this network.';
COMMENT ON COLUMN public.builder_organisations.abn_registered_on IS
  'ABN registration date as read from the Australian Business Register. A FACT: scores tenure in full once abn_verified_at is stamped.';
COMMENT ON COLUMN public.builder_organisations.reputation_score IS
  'An operator''s recorded standing for this builder, 0-100. Deliberately a recorded assessment with a source and a date rather than a computed metric: nothing in this platform observes a builder''s reputation, and inventing a number for it would be worse than admitting there is none. Ages out of the ranking after REPUTATION_MAX_AGE_DAYS.';

-- ===========================================================================
-- 2. The snapshot — what the last run concluded
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.builder_ranking_snapshots (
  organisation_id uuid PRIMARY KEY
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  /* 0-100, after the neutral blend. The number the bands are cut from. */
  merit_score numeric(5,2) NOT NULL,
  /* 0-1. The share of signal weight that was actually measured. */
  confidence numeric(5,4) NOT NULL,
  /* The weighted mean of measured signals alone, before the blend. NULL when nothing was measured. */
  measured_score numeric(5,2),
  /* 0 is best. Lower is better everywhere in this feature. */
  band smallint NOT NULL,
  /*
   * Every signal's reading, measured or not, with the evidence each was read
   * from. This is what lets a builder be told why they rank where they rank
   * without the answer being recomputed — and recomputing to explain is how an
   * explanation comes to differ from the decision it is explaining.
   */
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  ranking_version integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_ranking_snapshots_score_range
    CHECK (merit_score >= 0 AND merit_score <= 100),
  CONSTRAINT builder_ranking_snapshots_confidence_range
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT builder_ranking_snapshots_band_range
    CHECK (band >= 0 AND band <= 10),
  /* Shape asserted with key PRESENCE before key type: `->` on an absent key is
     SQL NULL, an `and` chain containing NULL is NULL, and a CHECK accepts NULL.
     See the manual_stats constraint that shipped broken for a day. */
  CONSTRAINT builder_ranking_snapshots_signals_shape
    CHECK (jsonb_typeof(signals) = 'object')
);

COMMENT ON TABLE public.builder_ranking_snapshots IS
  'One row per builder: what the last ranking run concluded, and the evidence it concluded it from. Written only by builder-ranking-recompute. A commercial placement never appears here — merit and money are two numbers and never one.';

CREATE TABLE IF NOT EXISTS public.builder_stock_item_ranks (
  stock_item_id uuid PRIMARY KEY
    REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  item_score numeric(5,2) NOT NULL,
  confidence numeric(5,4) NOT NULL,
  /* Copied from the builder's snapshot at compute time so one read serves a
     card: a clone must not have to join to know which band it is drawing. */
  builder_score numeric(5,2) NOT NULL,
  builder_confidence numeric(5,4) NOT NULL,
  builder_band smallint NOT NULL,
  placement_kind text NOT NULL DEFAULT 'organic',
  placement_position integer,
  placement_tier text,
  /*
   * Whether the card must carry a visible label.
   *
   * Computed here, once, rather than at each surface, so the prime, three
   * clones and the builder's own portal cannot disagree about whether a
   * position was bought. Never false for a promoted or pinned row — asserted
   * below, not merely intended.
   */
  disclose boolean NOT NULL DEFAULT false,
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  ranking_version integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builder_stock_item_ranks_kind_check
    CHECK (placement_kind IN ('organic', 'promoted', 'pinned', 'suppressed')),
  CONSTRAINT builder_stock_item_ranks_position_pairing
    CHECK ((placement_kind = 'pinned') = (placement_position IS NOT NULL)),
  CONSTRAINT builder_stock_item_ranks_tier_pairing
    CHECK ((placement_kind = 'promoted') = (placement_tier IS NOT NULL)),
  /* The disclosure rule, as a constraint rather than a convention. */
  CONSTRAINT builder_stock_item_ranks_disclosure
    CHECK (placement_kind NOT IN ('promoted', 'pinned') OR disclose = true),
  CONSTRAINT builder_stock_item_ranks_score_range
    CHECK (item_score >= 0 AND item_score <= 100)
);

CREATE INDEX IF NOT EXISTS builder_stock_item_ranks_org_idx
  ON public.builder_stock_item_ranks (organisation_id);
CREATE INDEX IF NOT EXISTS builder_stock_item_ranks_order_idx
  ON public.builder_stock_item_ranks (builder_band, item_score DESC);

-- ===========================================================================
-- 3. The instruments — an operator's pin, suppression and freeze
-- ===========================================================================

/*
 * THE DEFAULT EXPIRY IS NINETY DAYS AND THAT IS THE POINT.
 *
 * `expires_at` could default to NULL and let each caller decide. The failure
 * this defends against is not a badly chosen expiry — it is the pin nobody
 * chose to renew: a pilot arrangement, a dispute, a commercial trial, each
 * entirely reasonable when it was made and each still silently shaping the
 * marketplace two quarters later because removing it was nobody's job. A
 * standing override is still available; it has to be asked for, in words, by
 * passing an explicit null.
 */
CREATE TABLE IF NOT EXISTS public.builder_ranking_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  /* 1-based, and meant literally: "this builder sits at number one". */
  position integer,
  reason text NOT NULL,
  /* The Mission Control operator's subject claim. Never a builder's own user. */
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '90 days'),
  revoked_at timestamptz,
  revoked_by text,
  revoked_reason text,
  CONSTRAINT builder_ranking_overrides_kind_check
    CHECK (kind IN ('pin', 'suppress')),
  CONSTRAINT builder_ranking_overrides_position_pairing
    CHECK ((kind = 'pin') = (position IS NOT NULL)),
  CONSTRAINT builder_ranking_overrides_position_range
    CHECK (position IS NULL OR (position >= 1 AND position <= 500)),
  /* A reason is a sentence, not a keystroke. */
  CONSTRAINT builder_ranking_overrides_reason_written
    CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT builder_ranking_overrides_revocation_stamp
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

/* One LIVE override of each kind per builder. History may hold many. */
CREATE UNIQUE INDEX IF NOT EXISTS builder_ranking_overrides_live_key
  ON public.builder_ranking_overrides (organisation_id, kind)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS builder_ranking_overrides_org_idx
  ON public.builder_ranking_overrides (organisation_id, created_at DESC);

COMMENT ON TABLE public.builder_ranking_overrides IS
  'Mission Control''s pins and suppressions. An override never rewrites a computed score — it sits beside it, so the score stays true and the intervention stays visible as an intervention. Revoking keeps the row: a register of who moved the marketplace and why is the reason this table exists.';

CREATE TABLE IF NOT EXISTS public.builder_commercial_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  tier text NOT NULL,
  /* Lower sorts first among promoted builders. */
  priority integer NOT NULL DEFAULT 100,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  /* What this placement is, in the operator's own words — the contract, the
     arrangement, the trial. Read back on every review of the marketplace. */
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text,
  CONSTRAINT builder_commercial_placements_tier_check
    CHECK (tier IN ('partner', 'premium', 'featured')),
  CONSTRAINT builder_commercial_placements_window
    CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT builder_commercial_placements_priority_range
    CHECK (priority >= 1 AND priority <= 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_commercial_placements_live_key
  ON public.builder_commercial_placements (organisation_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.builder_commercial_placements IS
  'A bought position. Adds NO points to a merit score — it selects a placement band above the organic order, capped at MAX_PROMOTED_SLOTS and labelled on the card. Kept separate from the snapshot so a builder''s merit score can be shown to them without being a lie, and so an adviser can see what moved a listing.';

/*
 * THE FREEZE — one row, and a state that recompute reads before it writes.
 *
 * It exists because every automated ranking eventually has a day where it is
 * wrong in production and the fix is not ready. Freezing holds the last
 * published order still; it does not fall back to an arbitrary one, because a
 * marketplace that reshuffles the moment something goes wrong is a second
 * incident on top of the first.
 */
CREATE TABLE IF NOT EXISTS public.builder_ranking_state (
  id boolean PRIMARY KEY DEFAULT true,
  frozen boolean NOT NULL DEFAULT false,
  frozen_reason text,
  frozen_by text,
  frozen_at timestamptz,
  last_run_at timestamptz,
  last_run_organisations integer,
  last_run_items integer,
  last_run_error text,
  ranking_version integer NOT NULL DEFAULT 1,
  CONSTRAINT builder_ranking_state_singleton CHECK (id),
  CONSTRAINT builder_ranking_state_freeze_stamp
    CHECK ((NOT frozen) OR (frozen_reason IS NOT NULL AND frozen_by IS NOT NULL AND frozen_at IS NOT NULL))
);

INSERT INTO public.builder_ranking_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 4. RLS — service role only, like every table of this plane
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'builder_ranking_snapshots',
    'builder_stock_item_ranks',
    'builder_ranking_overrides',
    'builder_commercial_placements',
    'builder_ranking_state'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role '
      || 'USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
      t || '_service', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- ===========================================================================
-- 5. The rank travels — the payload composer gains a `rank` block
-- ===========================================================================

/*
 * A clone sorts on what it was sent and computes nothing.
 *
 * That is the whole architecture in one line, and it is why this block is on
 * the item payload rather than being derived at the other end. A clone's mirror
 * is a PARTIAL view — it holds the stock of the builders it is connected to and
 * no others — so a clone computing its own order would not merely produce a
 * different answer from its siblings, it would produce a wrong one, ranking
 * builders against a cohort that is missing most of the market.
 *
 * `rank` is composed key by key like every other block that crosses this
 * boundary. No signal evidence travels: the breakdown is an operator's and a
 * builder's to read, network-side, and a clone has no surface for it.
 */
CREATE OR REPLACE FUNCTION public.builder_network_compose_stock_item_payload(_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_i public.builder_stock_items;
  v_org record;
  v_img public.builder_stock_item_images;
  v_image jsonb := NULL;
  v_rank public.builder_stock_item_ranks;
  v_rank_block jsonb := NULL;
BEGIN
  SELECT * INTO v_i FROM public.builder_stock_items WHERE id = _item_id;
  IF v_i.id IS NULL THEN RETURN NULL; END IF;

  SELECT legal_name, trading_name INTO v_org
  FROM public.builder_organisations WHERE id = v_i.organisation_id;

  IF v_i.primary_image_id IS NOT NULL THEN
    SELECT * INTO v_img FROM public.builder_stock_item_images WHERE id = v_i.primary_image_id;
    IF v_img.id IS NOT NULL
       AND v_img.source_stage = 'uploaded_document'
       AND v_img.verification_status = 'source_supplied'
       AND v_img.processing_status = 'ready'
    THEN
      v_image := jsonb_build_object(
        'id', v_img.id,
        'source_stage', v_img.source_stage,
        'verification_status', v_img.verification_status,
        'processing_status', v_img.processing_status,
        'content_type', v_img.content_type,
        'byte_size', v_img.byte_size,
        'position', 0,
        'source_detail', jsonb_strip_nulls(jsonb_build_object(
          'role',                          v_img.source_detail->'role',
          'role_evidence_level',           v_img.source_detail->'role_evidence_level',
          'stored_sha256',                 v_img.source_detail->'stored_sha256',
          'provenance_version',            v_img.source_detail->'provenance_version',
          'marketplace_measured',          v_img.source_detail->'marketplace_measured',
          'marketplace_measured_sha256',   v_img.source_detail->'marketplace_measured_sha256',
          'marketplace_display_eligible',  v_img.source_detail->'marketplace_display_eligible',
          'marketplace_eligibility_state', v_img.source_detail->'marketplace_eligibility_state',
          'marketplace_rejection_reason',  v_img.source_detail->'marketplace_rejection_reason',
          'marketplace_eligibility_version', v_img.source_detail->'marketplace_eligibility_version',
          'sanitized_derivative',          v_img.source_detail->'sanitized_derivative',
          'sanitization_clearance',        v_img.source_detail->'sanitization_clearance')));
    END IF;
  END IF;

  -- The rank block. Absent until the first run has scored this property, and
  -- absent is the one state the clone must handle gracefully: a mirror with no
  -- rank sorts exactly as it did before this feature, newest first, rather
  -- than collapsing to a single band.
  SELECT * INTO v_rank FROM public.builder_stock_item_ranks WHERE stock_item_id = _item_id;
  IF v_rank.stock_item_id IS NOT NULL THEN
    v_rank_block := jsonb_build_object(
      'item_score', v_rank.item_score,
      'item_confidence', v_rank.confidence,
      'builder_score', v_rank.builder_score,
      'builder_confidence', v_rank.builder_confidence,
      'builder_band', v_rank.builder_band,
      'placement_kind', v_rank.placement_kind,
      'placement_position', v_rank.placement_position,
      'placement_tier', v_rank.placement_tier,
      'disclose', v_rank.disclose,
      'ranking_version', v_rank.ranking_version,
      'computed_at', v_rank.computed_at);
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', v_i.id,
    'organisation_id', v_i.organisation_id,
    'upload_id', v_i.upload_id,
    'first_upload_id', v_i.first_upload_id,
    'created_by_builder_user_id', v_i.created_by_builder_user_id,
    'external_reference', v_i.external_reference,
    'development_name', v_i.development_name,
    'project_name', v_i.project_name,
    'address_line', v_i.address_line,
    'suburb', v_i.suburb,
    'state', v_i.state,
    'postcode', v_i.postcode,
    'lot_number', v_i.lot_number,
    'unit_number', v_i.unit_number,
    'bedrooms', v_i.bedrooms,
    'bathrooms', v_i.bathrooms,
    'car_spaces', v_i.car_spaces,
    'property_type', v_i.property_type,
    'land_size_sqm', v_i.land_size_sqm,
    'building_size_sqm', v_i.building_size_sqm,
    'price', v_i.price,
    'price_display', v_i.price_display,
    'availability_status', v_i.availability_status,
    'expected_completion', v_i.expected_completion,
    'description', v_i.description,
    'lifecycle_status', v_i.lifecycle_status,
    'enrichment_status', v_i.enrichment_status,
    'image_work_stage', v_i.image_work_stage,
    'house_design', v_i.source_row->>'house_design',
    'manual_stats', CASE WHEN v_i.manual_stats IS NULL THEN NULL ELSE
      jsonb_strip_nulls(jsonb_build_object(
        'bedrooms',          v_i.manual_stats->'bedrooms',
        'bathrooms',         v_i.manual_stats->'bathrooms',
        'car_spaces',        v_i.manual_stats->'car_spaces',
        'building_size_sqm', v_i.manual_stats->'building_size_sqm',
        'land_size_sqm',     v_i.manual_stats->'land_size_sqm')) END,
    'item_created_at', v_i.created_at,
    'item_updated_at', v_i.updated_at,
    'organisation', jsonb_build_object(
      'id', v_i.organisation_id,
      'legal_name', v_org.legal_name,
      'trading_name', v_org.trading_name),
    'primary_image', v_image,
    'rank', v_rank_block));
END $function$;

-- ===========================================================================
-- 6. A changed rank is news; a jittered one is not
-- ===========================================================================

/*
 * RE-ENQUEUE ON A RANK THAT WOULD CHANGE THE PAGE, AND ONLY THEN.
 *
 * The naive trigger — announce every rank write — sends one event per property
 * per run. At today's 43 properties on an hourly schedule that is 1,032 events
 * a day to say almost nothing, and every one of them costs a delivery, a
 * signature and a convergence sweep. The same idiom the selection producer
 * already uses ("only a status movement is news on UPDATE") applies: what a
 * clone can SEE is the band, the placement and the order, so a change to any of
 * those travels, and a score that drifted by less than the threshold does not.
 *
 * The threshold is on the ITEM score because that is what orders a page inside
 * a band. Two points was chosen against the observed spread: item scores across
 * the live catalogue occupy roughly a 25-point range, so two points is under a
 * tenth of it — small enough that a real reordering always crosses it, large
 * enough that a freshness decay ticking over a day boundary does not.
 */
CREATE OR REPLACE FUNCTION public.builder_network_rank_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.builder_band IS NOT DISTINCT FROM OLD.builder_band
     AND NEW.placement_kind IS NOT DISTINCT FROM OLD.placement_kind
     AND NEW.placement_position IS NOT DISTINCT FROM OLD.placement_position
     AND NEW.placement_tier IS NOT DISTINCT FROM OLD.placement_tier
     AND NEW.disclose IS NOT DISTINCT FROM OLD.disclose
     AND abs(NEW.item_score - OLD.item_score) < 2.0
  THEN
    RETURN NEW;
  END IF;
  PERFORM public.builder_network_enqueue_stock_item(NEW.stock_item_id);
  RETURN NEW;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_network_rank_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_builder_network_rank_sync ON public.builder_stock_item_ranks;
CREATE TRIGGER trg_builder_network_rank_sync
  AFTER INSERT OR UPDATE ON public.builder_stock_item_ranks
  FOR EACH ROW EXECUTE FUNCTION public.builder_network_rank_changed();


-- ===========================================================================
-- 7. The apply — both tables, one transaction
-- ===========================================================================

/*
 * A RUN LANDS WHOLE OR NOT AT ALL.
 *
 * The recompute could upsert its rows in chunks from the edge function, and
 * that would be correct right up to the first chunk that fails: half the
 * builders would carry this run's bands and half the previous run's, and the
 * marketplace would be ordered by two different answers at once. Nothing would
 * report it, because every individual row would be perfectly well-formed.
 *
 * A plpgsql function is a single transaction, so handing it both sets makes
 * the write atomic without the edge function needing a transaction it cannot
 * open over PostgREST. The two statements are set-based rather than row loops:
 * 43 properties today, and no reason to be linear in the number of builders.
 */
CREATE OR REPLACE FUNCTION public.builder_ranking_apply(
  _snapshots jsonb,
  _items jsonb,
  _ranking_version integer,
  _computed_at timestamptz
)
RETURNS TABLE (organisations integer, items integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_orgs integer := 0;
  v_items integer := 0;
BEGIN
  IF jsonb_typeof(_snapshots) <> 'array' OR jsonb_typeof(_items) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RANKING_APPLY_BAD_SHAPE';
  END IF;

  INSERT INTO public.builder_ranking_snapshots AS t (
    organisation_id, merit_score, confidence, measured_score, band,
    signals, ranking_version, computed_at)
  SELECT s.organisation_id, s.merit_score, s.confidence, s.measured_score, s.band,
         COALESCE(s.signals, '{}'::jsonb), _ranking_version, _computed_at
  FROM jsonb_to_recordset(_snapshots) AS s(
    organisation_id uuid, merit_score numeric, confidence numeric,
    measured_score numeric, band smallint, signals jsonb)
  ON CONFLICT (organisation_id) DO UPDATE SET
    merit_score = EXCLUDED.merit_score,
    confidence = EXCLUDED.confidence,
    measured_score = EXCLUDED.measured_score,
    band = EXCLUDED.band,
    signals = EXCLUDED.signals,
    ranking_version = EXCLUDED.ranking_version,
    computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_orgs = ROW_COUNT;

  INSERT INTO public.builder_stock_item_ranks AS t (
    stock_item_id, organisation_id, item_score, confidence,
    builder_score, builder_confidence, builder_band,
    placement_kind, placement_position, placement_tier, disclose,
    signals, ranking_version, computed_at)
  SELECT i.stock_item_id, i.organisation_id, i.item_score, i.confidence,
         i.builder_score, i.builder_confidence, i.builder_band,
         i.placement_kind, i.placement_position, i.placement_tier, i.disclose,
         COALESCE(i.signals, '{}'::jsonb), _ranking_version, _computed_at
  FROM jsonb_to_recordset(_items) AS i(
    stock_item_id uuid, organisation_id uuid, item_score numeric, confidence numeric,
    builder_score numeric, builder_confidence numeric, builder_band smallint,
    placement_kind text, placement_position integer, placement_tier text,
    disclose boolean, signals jsonb)
  ON CONFLICT (stock_item_id) DO UPDATE SET
    organisation_id = EXCLUDED.organisation_id,
    item_score = EXCLUDED.item_score,
    confidence = EXCLUDED.confidence,
    builder_score = EXCLUDED.builder_score,
    builder_confidence = EXCLUDED.builder_confidence,
    builder_band = EXCLUDED.builder_band,
    placement_kind = EXCLUDED.placement_kind,
    placement_position = EXCLUDED.placement_position,
    placement_tier = EXCLUDED.placement_tier,
    disclose = EXCLUDED.disclose,
    signals = EXCLUDED.signals,
    ranking_version = EXCLUDED.ranking_version,
    computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_items = ROW_COUNT;

  UPDATE public.builder_ranking_state
  SET last_run_at = _computed_at,
      last_run_organisations = v_orgs,
      last_run_items = v_items,
      last_run_error = NULL,
      ranking_version = _ranking_version
  WHERE id = true;

  RETURN QUERY SELECT v_orgs, v_items;
END $fn$;

REVOKE ALL ON FUNCTION public.builder_ranking_apply(jsonb, jsonb, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_ranking_apply(jsonb, jsonb, integer, timestamptz)
  TO service_role;

-- ===========================================================================
-- 8. The schedule
-- ===========================================================================

/*
 * HOURLY, AND NOT MORE OFTEN.
 *
 * Nothing this ranking reads moves faster than that: a stock list is uploaded
 * at most a few times a week, an activation is acknowledged in hours, and
 * tenure moves once a year. A tighter schedule would buy no freshness and
 * would spend an outbox delivery per property per run on saying so.
 *
 * The recompute is an edge function rather than SQL because the scoring lives
 * in the pure module — see this migration's header.
 */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'builder-ranking-recompute-hourly') THEN
      PERFORM cron.schedule(
        'builder-ranking-recompute-hourly',
        '7 * * * *',
        $job$SELECT public.cron_invoke_signed_function('builder-ranking-recompute', '{}'::jsonb, 'pg_cron');$job$
      );
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- 9. Post-migration assertions — asserted by effect, never by configuration
-- ===========================================================================
DO $$
DECLARE
  v_ok boolean;
BEGIN
  /*
   * ASSERTED BY EFFECT, NEVER BY CONFIGURATION — the rule this repository
   * already applies to the retention purge, the verification self-test and the
   * JSONB shape constraint that shipped accepting anything for a day. Reading
   * `pg_constraint` would prove a constraint was DECLARED; only writing a row
   * proves it BITES.
   *
   * Each probe runs only where there is a real row to build it from. An
   * `INSERT ... SELECT` over an empty table inserts nothing, raises nothing,
   * and would send the RAISE below off on a fresh database — an assertion that
   * fails where there is nothing to assert is a migration that cannot be
   * applied to a new environment.
   */
  IF EXISTS (SELECT 1 FROM public.builder_stock_items) THEN
    BEGIN
      INSERT INTO public.builder_stock_item_ranks(
        stock_item_id, organisation_id, item_score, confidence,
        builder_score, builder_confidence, builder_band,
        placement_kind, placement_tier, disclose, ranking_version)
      SELECT i.id, i.organisation_id, 50, 0.5, 50, 0.5, 2, 'promoted', 'partner', false, 1
      FROM public.builder_stock_items i LIMIT 1;
      RAISE EXCEPTION
        'POST-MIGRATION FAILURE: a promoted placement was accepted with disclose = false';
    EXCEPTION
      WHEN check_violation THEN NULL;   -- the constraint bit, which is the pass
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM public.builder_organisations) THEN
    BEGIN
      INSERT INTO public.builder_ranking_overrides(
        organisation_id, kind, position, reason, created_by)
      SELECT o.id, 'pin', 1, 'x', 'assertion'
      FROM public.builder_organisations o LIMIT 1;
      RAISE EXCEPTION
        'POST-MIGRATION FAILURE: a pin was accepted with a one-character reason';
    EXCEPTION
      WHEN check_violation THEN NULL;
    END;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'builder_network_compose_stock_item_payload'
      AND position('''rank''' IN pg_get_functiondef(p.oid)) > 0
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION
      'POST-MIGRATION FAILURE: the payload composer does not carry a rank block';
  END IF;
END $$;
