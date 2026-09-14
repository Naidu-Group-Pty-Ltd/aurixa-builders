-- Builder Stock List → Property Marketplace
--
-- One builder uploads a stock list; the properties it describes become
-- available in the Command Centre's Property Marketplace; a Command Centre
-- user selects one for a client; the builder that supplied it is activated.
--
-- Additive only. Every Builder Portal object from Phases 1-9 is reused
-- unchanged: `builder_organisations` owns the stock, `builder_portal_users`
-- uploads it, and a stock item LINKS to `builder_projects` / `builder_units`
-- rather than copying them. Nothing here duplicates the inventory model — a
-- stock item that resolves to a unit carries that unit's id and defers to it.
--
-- Four tables and no more:
--   builder_stock_uploads        the auditable import record (one per file)
--   builder_stock_items          the marketplace-exposed stock row
--   builder_stock_item_images    three enrichment stages, provenance kept apart
--   builder_stock_selections     the two-way link: item ↔ builder ↔ client
--
-- Access: an upload, an item, an image and a selection all name the
-- ORGANISATION. That column is the boundary the Builder Portal enforces on
-- every read and every write; a browser-supplied organisation id is never
-- consulted (see `builder-portal-stock`).

-- ===========================================================================
-- 0. Storage
-- ===========================================================================

-- The original uploaded document. Private: every read is a short-lived signed
-- URL issued by an edge function that re-resolves the caller's organisation.
-- 25 MB matches MAX_BUILDER_DOCUMENT_BYTES — a stock list is a schedule, not a
-- discovery bundle.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('builder-stock-lists', 'builder-stock-lists', false, 26214400)
ON CONFLICT (id) DO NOTHING;

-- Enrichment imagery the server fetched itself (document media, Google
-- imagery). Stage 3 candidates are NOT stored here — an unverified internet
-- image is kept as a URL plus its provenance, never brought inside.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('builder-stock-images', 'builder-stock-images', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO NOTHING;

-- No storage policies: both buckets are reachable only through the service
-- role inside an edge function, which is where the organisation check lives.

-- ===========================================================================
-- 1. Uploads — the auditable import record
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_stock_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  uploaded_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,

  original_filename text NOT NULL CHECK (length(btrim(original_filename)) > 0),
  -- What the browser CLAIMED. The detected type is recorded separately,
  -- because a declared content-type is a claim by the uploader, not evidence.
  declared_content_type text,
  detected_content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  file_sha256 text,

  storage_bucket text NOT NULL DEFAULT 'builder-stock-lists',
  storage_path text NOT NULL,

  -- The staged lifecycle. A failure in enrichment lands on `partially_complete`
  -- and never on `failed`: the properties are imported and must stay.
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','parsing','imported','enriching','complete',
                      'partially_complete','failed')),
  parse_strategy text,

  records_detected integer NOT NULL DEFAULT 0,
  records_imported integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  records_failed integer NOT NULL DEFAULT 0,

  -- Per-stage image counts: { document: {ready, failed}, google: {...}, internet: {...} }
  image_stage_summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Two error fields on purpose. `error_message` is shown to the builder;
  -- `error_detail` is the internal diagnosis and is never returned to a
  -- portal caller.
  error_code text,
  error_message text,
  error_detail jsonb,

  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS builder_stock_uploads_org_idx
  ON public.builder_stock_uploads(organisation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_stock_uploads_status_idx
  ON public.builder_stock_uploads(status);

-- Duplicate-processing guard. The same bytes uploaded twice by the same
-- organisation is the common case (a builder re-sends last week's schedule),
-- and re-parsing it produces nothing new. The hash is computed server-side
-- from the stored object, never supplied by the browser.
CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_uploads_org_sha_key
  ON public.builder_stock_uploads(organisation_id, file_sha256)
  WHERE file_sha256 IS NOT NULL;

COMMENT ON TABLE public.builder_stock_uploads IS
  'One row per stock-list file a builder uploaded. The audit record of the import: who, what file, how many records, which stages succeeded.';
COMMENT ON COLUMN public.builder_stock_uploads.error_detail IS
  'Internal diagnosis. Never returned to a Builder Portal or Command Centre caller — error_message is the safe surface.';

-- ===========================================================================
-- 2. Stock items — the marketplace row
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The originating builder. This is the relationship the whole feature turns
  -- on and it is a foreign key, never a name.
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,

  -- The upload that last wrote this row, and the one that first created it.
  -- Both are kept: "which file did this come from" and "which file changed it"
  -- are different questions.
  upload_id uuid REFERENCES public.builder_stock_uploads(id) ON DELETE SET NULL,
  first_upload_id uuid REFERENCES public.builder_stock_uploads(id) ON DELETE SET NULL,
  created_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,

  -- The existing builder architecture, LINKED rather than copied. Both stay
  -- null when the stock list names a project the portal does not hold; the
  -- item is still complete, it simply has no unit behind it yet.
  builder_project_id uuid REFERENCES public.builder_projects(id) ON DELETE SET NULL,
  builder_unit_id uuid REFERENCES public.builder_units(id) ON DELETE SET NULL,

  -- The builder's own identifier for this stock line, when the file carries
  -- one. The most reliable dedupe key there is.
  external_reference text,

  development_name text,
  project_name text,
  address_line text,
  suburb text,
  state text CHECK (state IS NULL OR state IN ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')),
  postcode text CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  lot_number text,
  unit_number text,

  bedrooms numeric(4,1) CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 20),
  bathrooms numeric(4,1) CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 20),
  car_spaces numeric(4,1) CHECK (car_spaces IS NULL OR car_spaces BETWEEN 0 AND 20),
  property_type text CHECK (property_type IS NULL OR property_type IN
    ('house','townhouse','apartment','duplex','land','terrace','house_and_land','other')),
  land_size_sqm numeric(12,2) CHECK (land_size_sqm IS NULL OR land_size_sqm >= 0),
  building_size_sqm numeric(12,2) CHECK (building_size_sqm IS NULL OR building_size_sqm >= 0),

  price numeric(14,2) CHECK (price IS NULL OR price >= 0),
  -- What the file actually said, when it was not a number ("From $749,000",
  -- "POA"). Kept verbatim: inventing a number the document does not carry is
  -- the one thing normalisation must never do.
  price_display text,

  -- Sales state. Mirrors builder_units.availability_status and adds `sold`
  -- and `unknown`, which a spreadsheet routinely says and a unit row cannot.
  availability_status text NOT NULL DEFAULT 'available'
    CHECK (availability_status IN
      ('available','on_hold','reserved','contracted','sold','settled','withdrawn','unknown')),
  expected_completion text,
  description text,

  -- Lifecycle of the row itself, distinct from the property's availability.
  lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active','archived')),

  -- Image enrichment is staged and is allowed to fail without taking the
  -- property with it.
  enrichment_status text NOT NULL DEFAULT 'pending'
    CHECK (enrichment_status IN ('pending','enriching','complete','partial','failed')),
  enriched_at timestamptz,

  primary_image_id uuid,

  -- The normalised row exactly as it was read, for audit. Nothing reads it
  -- back into the product.
  source_row jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS builder_stock_items_org_idx
  ON public.builder_stock_items(organisation_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS builder_stock_items_upload_idx
  ON public.builder_stock_items(upload_id);
CREATE INDEX IF NOT EXISTS builder_stock_items_availability_idx
  ON public.builder_stock_items(availability_status);
CREATE INDEX IF NOT EXISTS builder_stock_items_unit_idx
  ON public.builder_stock_items(builder_unit_id) WHERE builder_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_stock_items_project_idx
  ON public.builder_stock_items(builder_project_id) WHERE builder_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS builder_stock_items_suburb_idx
  ON public.builder_stock_items(suburb);

-- ── Duplicate / update matching ────────────────────────────────────────────
-- Two keys, both conservative, both scoped to ONE organisation so two builders
-- can never collide:
--
--   1. the builder's own reference — reliable when present;
--   2. development + lot/unit — the only other pair that names one property
--      unambiguously, and only when BOTH halves are present.
--
-- Nothing fuzzy. An address alone is deliberately not a key: two townhouses on
-- one street address are two properties, and merging them is worse than
-- importing a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_items_org_reference_key
  ON public.builder_stock_items(organisation_id, lower(btrim(external_reference)))
  WHERE external_reference IS NOT NULL AND btrim(external_reference) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_items_org_development_unit_key
  ON public.builder_stock_items(
    organisation_id,
    lower(btrim(coalesce(development_name, project_name))),
    lower(btrim(coalesce(unit_number, lot_number))))
  WHERE coalesce(development_name, project_name) IS NOT NULL
    AND btrim(coalesce(development_name, project_name)) <> ''
    AND coalesce(unit_number, lot_number) IS NOT NULL
    AND btrim(coalesce(unit_number, lot_number)) <> '';

COMMENT ON TABLE public.builder_stock_items IS
  'Builder-supplied stock exposed in the Property Marketplace. Links to builder_projects / builder_units rather than copying them; organisation_id is the ownership boundary and is enforced server-side on every read.';

-- ===========================================================================
-- 3. Images — three sources, kept apart
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_stock_item_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: media found in a document that cannot be attributed to ONE
  -- property is kept against the upload rather than discarded, because source
  -- information is never deleted.
  stock_item_id uuid REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,
  upload_id uuid REFERENCES public.builder_stock_uploads(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,

  -- The three stages. Never merged: the UI has to be able to say where an
  -- image came from, and a Google forecourt is not a builder's render.
  source_stage text NOT NULL
    CHECK (source_stage IN ('uploaded_document','google_maps','internet_search')),
  -- What inside that stage: the object path, the maps product, the page found.
  source_reference text,
  source_provider text,
  source_page_url text,
  source_detail jsonb NOT NULL DEFAULT '{}'::jsonb,

  storage_bucket text,
  storage_path text,
  external_url text,
  content_type text,
  byte_size bigint,

  -- Stage 1 and 2 are tied to the property by construction. Stage 3 is a
  -- search result and is never presented as confirmed.
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('source_supplied','location_derived','unverified')),
  confidence numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','ready','unavailable','failed')),
  error_message text,

  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Bytes here, or a URL there. A row with neither is a stage that could not
  -- produce anything, and it must say so.
  CONSTRAINT builder_stock_item_images_has_a_source CHECK (
    processing_status <> 'ready'
    OR storage_path IS NOT NULL OR external_url IS NOT NULL),

  -- Re-running enrichment must REFRESH a stage rather than pile up duplicates,
  -- which the writers do with an upsert on exactly these three columns.
  --
  -- A plain table constraint, not a partial or expression index: PostgREST
  -- infers an `ON CONFLICT` target from the column list alone, and it cannot
  -- infer one whose definition carries a `WHERE` clause or a `coalesce()`. An
  -- index that reads better here would make every upsert fail with "no unique
  -- or exclusion constraint matching the ON CONFLICT specification".
  --
  -- Document media kept against the UPLOAD has a null `stock_item_id`, and
  -- Postgres treats nulls as distinct, so those rows never collide with each
  -- other. Every writer sets `source_reference`.
  CONSTRAINT builder_stock_item_images_stage_ref_key
    UNIQUE (stock_item_id, source_stage, source_reference)
);

CREATE INDEX IF NOT EXISTS builder_stock_item_images_item_idx
  ON public.builder_stock_item_images(stock_item_id, source_stage, position);
CREATE INDEX IF NOT EXISTS builder_stock_item_images_upload_idx
  ON public.builder_stock_item_images(upload_id);

ALTER TABLE public.builder_stock_items
  DROP CONSTRAINT IF EXISTS builder_stock_items_primary_image_fk;
ALTER TABLE public.builder_stock_items
  ADD CONSTRAINT builder_stock_items_primary_image_fk
  FOREIGN KEY (primary_image_id)
  REFERENCES public.builder_stock_item_images(id) ON DELETE SET NULL;

COMMENT ON TABLE public.builder_stock_item_images IS
  'Three-stage image enrichment. source_stage is never collapsed: an internet-search result keeps verification_status = unverified for ever, because nothing has confirmed it depicts this property.';

-- ===========================================================================
-- 4. Selections — the two-way link
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.builder_stock_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  stock_item_id uuid NOT NULL
    REFERENCES public.builder_stock_items(id) ON DELETE CASCADE,

  -- Copied from the item BY THE SERVER at selection time, so the builder side
  -- can be found by an index rather than a join through a mutable row, and so
  -- a later edit to the item cannot silently re-point an existing activation.
  organisation_id uuid NOT NULL
    REFERENCES public.builder_organisations(id) ON DELETE CASCADE,
  source_upload_id uuid REFERENCES public.builder_stock_uploads(id) ON DELETE SET NULL,
  originating_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  -- The development the property belongs to, when the portal holds one. Copied
  -- at selection time for the same reason the organisation is: an activation
  -- must keep naming the project it was made against.
  builder_project_id uuid REFERENCES public.builder_projects(id) ON DELETE SET NULL,

  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- The Command Centre user who made the selection. auth.users, as everywhere
  -- else in the internal schema.
  selected_by_user_id uuid NOT NULL,

  status text NOT NULL DEFAULT 'selected'
    CHECK (status IN ('selected','builder_acknowledged','progressed','completed','withdrawn')),

  selected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by_builder_user_id uuid
    REFERENCES public.builder_portal_users(id) ON DELETE SET NULL,
  withdrawn_at timestamptz,

  -- Command Centre only. Never returned to the Builder Portal.
  internal_notes text,
  -- What the builder is told, if anything beyond the fact of the selection.
  builder_reference text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS builder_stock_selections_item_idx
  ON public.builder_stock_selections(stock_item_id);
CREATE INDEX IF NOT EXISTS builder_stock_selections_org_idx
  ON public.builder_stock_selections(organisation_id, status);
CREATE INDEX IF NOT EXISTS builder_stock_selections_client_idx
  ON public.builder_stock_selections(client_id);
CREATE INDEX IF NOT EXISTS builder_stock_selections_actor_idx
  ON public.builder_stock_selections(selected_by_user_id);

-- One live selection per (property, client). A withdrawn one does not block a
-- fresh selection, and the withdrawn row stays for the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_selections_live_key
  ON public.builder_stock_selections(stock_item_id, client_id)
  WHERE status <> 'withdrawn';

COMMENT ON TABLE public.builder_stock_selections IS
  'The two-way link. A Command Centre user selects a builder property for a client; the originating organisation, uploader and source upload are resolved from the database at selection time and stored as foreign keys, never from anything the browser sent.';
COMMENT ON COLUMN public.builder_stock_selections.internal_notes IS
  'Command Centre private. The Builder Portal projection omits this column and every client column except the fact that a selection exists.';

-- ===========================================================================
-- 5. The organisation on a selection must be the item's organisation
--
-- The server already copies it, but a copy that can drift is not a boundary.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_enforce_stock_selection_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organisation_id INTO v_org
  FROM public.builder_stock_items WHERE id = NEW.stock_item_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STOCK_ITEM_NOT_FOUND',
      DETAIL='a selection must reference an existing stock item';
  END IF;
  IF NEW.organisation_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STOCK_SELECTION_ORG_MISMATCH',
      DETAIL='a selection must name the organisation that supplied the stock item';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_stock_selection_org ON public.builder_stock_selections;
CREATE TRIGGER trg_builder_stock_selection_org
  BEFORE INSERT OR UPDATE OF stock_item_id, organisation_id
  ON public.builder_stock_selections FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_stock_selection_org();

-- The same rule for an image: it belongs to its item's organisation.
CREATE OR REPLACE FUNCTION public.builder_enforce_stock_image_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  IF NEW.stock_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT organisation_id INTO v_org
  FROM public.builder_stock_items WHERE id = NEW.stock_item_id;
  IF v_org IS DISTINCT FROM NEW.organisation_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STOCK_IMAGE_ORG_MISMATCH',
      DETAIL='an image must name the organisation that owns its stock item';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_stock_image_org ON public.builder_stock_item_images;
CREATE TRIGGER trg_builder_stock_image_org
  BEFORE INSERT OR UPDATE OF stock_item_id, organisation_id
  ON public.builder_stock_item_images FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_stock_image_org();

-- A primary image must belong to the item it is primary for.
CREATE OR REPLACE FUNCTION public.builder_enforce_stock_primary_image()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_item uuid;
BEGIN
  IF NEW.primary_image_id IS NULL THEN RETURN NEW; END IF;
  SELECT stock_item_id INTO v_item
  FROM public.builder_stock_item_images WHERE id = NEW.primary_image_id;
  IF v_item IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='BUILDER_STOCK_PRIMARY_IMAGE_MISMATCH',
      DETAIL='the primary image must belong to this stock item';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_builder_stock_primary_image ON public.builder_stock_items;
CREATE TRIGGER trg_builder_stock_primary_image
  BEFORE INSERT OR UPDATE OF primary_image_id
  ON public.builder_stock_items FOR EACH ROW
  EXECUTE FUNCTION public.builder_enforce_stock_primary_image();

-- ===========================================================================
-- 6. updated_at
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.builder_stock_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_stock_uploads','builder_stock_items',
                           'builder_stock_item_images','builder_stock_selections'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_touch BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.builder_stock_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- ===========================================================================
-- 7. Activity log entity types
-- ===========================================================================
ALTER TABLE public.builder_portal_activity_log
  DROP CONSTRAINT IF EXISTS builder_portal_activity_log_entity_type_check;
ALTER TABLE public.builder_portal_activity_log
  ADD CONSTRAINT builder_portal_activity_log_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN
    ('organisation', 'portal_user', 'membership', 'membership_permissions', 'session',
     'development', 'project', 'project_party', 'project_access',
     'stage', 'building', 'lot', 'unit', 'unit_price', 'unit_hold',
     'reservation', 'allocation',
     'transaction', 'transaction_party', 'transaction_case_link',
     'construction_case', 'construction_stage', 'milestone',
     'progress_update', 'photograph',
     'variation', 'variation_approval', 'progress_claim',
     'inspection', 'defect', 'practical_completion', 'handover', 'warranty_claim',
     'document', 'document_version', 'document_grant',
     'conversation', 'message', 'task', 'task_assignment', 'notification',
     'organisation_settings', 'user_preferences',
     'rollout', 'rollout_approval',
     -- Added here. Everything above is the list as
     -- 20260810000000_builder_portal_release_control_plane.sql left it.
     'stock_upload', 'stock_item', 'stock_selection'));

-- ===========================================================================
-- 8. RLS and grants — deny by default
--
-- No `authenticated` policy exists on any of the four tables. Every read and
-- every write goes through an edge function holding the service role, which is
-- where the organisation boundary (Builder Portal) and the module permission
-- plus feature flag (Command Centre) are enforced. A direct client grant would
-- bypass both.
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_stock_uploads','builder_stock_items',
                           'builder_stock_item_images','builder_stock_selections'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON public.%I', t, t);
    EXECUTE format($p$CREATE POLICY %I_service ON public.%I
      AS PERMISSIVE FOR ALL TO service_role
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')$p$, t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- ===========================================================================
-- 9. Builder permission key — stock
--
-- Stock is inventory the builder is offering, so it rides the existing
-- `inventory` permission key rather than inventing a parallel one. Nothing to
-- seed: `builder_role_permission_defaults` already carries `inventory` for
-- every membership role.
-- ===========================================================================

-- ===========================================================================
-- 10. The Property Marketplace feature toggle
--
-- Server-side state, in the table the rest of the product already uses. OFF on
-- arrival: a deployment that has never uploaded a stock list should not grow a
-- new empty tab in the Property Marketplace on deploy day.
-- ===========================================================================
INSERT INTO public.feature_flags(key, value, description)
VALUES (
  'builder_stock_marketplace',
  '{"enabled":false}'::jsonb,
  'Show Builder Stock in Property Marketplace. Read by the Listings page to render the tab and re-checked server-side by builder-stock-marketplace on every operation — hiding the tab is convenience, the server check is the control.'
)
ON CONFLICT (key) DO NOTHING;
