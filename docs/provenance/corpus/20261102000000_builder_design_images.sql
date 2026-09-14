-- ===========================================================================
-- Builder Stock — the render a builder supplies FOR A DESIGN
--
-- WHAT THIS SOLVES, MEASURED. On the one live source, thirteen of twenty-six
-- published properties attach no document at all: no brochure, no plan,
-- nothing for any reader to read. The image pipeline's own fallbacks then
-- found, for those rows, a Simonds display home, an ABC Homes display home and
-- the land developer's estate marketing — other builders' houses — and
-- correctly refused every one of them. So those thirteen cards were blank and
-- no amount of reading could change it: there was nothing to read.
--
-- The one party who certainly has the picture is the builder, and the product
-- gave them no way to hand it over. That is what this closes.
--
-- WHY A DESIGN AND NOT A PROPERTY. Those thirteen rows are three designs —
-- `DK 22B` on eleven of them, `DK 22A` and `DK 23B` on one each. A project
-- builder sells a catalogue: the same house on many lots, and one render per
-- design is the picture for every one of them. Three uploads cover thirteen
-- properties, and every future property stating those designs, for ever. The
-- per-property override exists beside this for the exceptions, and it is
-- deliberately the smaller half.
--
-- WHAT IT IS NOT. It is not a design registry this repository maintains, and
-- it holds no design this product invented: `design_key` is the builder's OWN
-- design name as their stock list states it, normalised, and a render can only
-- reach rows whose own `house_design` says the same thing. Nothing here
-- infers, matches loosely, or crosses an organisation.
--
-- ONE RENDER PER DESIGN PER ORGANISATION. Uploading again replaces it, which
-- is what a builder means by "use this one instead" — and it is why the
-- fan-out can be re-derived from this table at any time rather than being a
-- history nobody can reconcile.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.builder_design_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,

  -- The builder's own design name, normalised for comparison. Produced by
  -- `designImageKey` in `_shared/builderStock/builderSuppliedImage.pure.ts`,
  -- which refuses a name too generic to identify a design ("House", "18",
  -- "Single Storey") for the same reason `designIdentityIsDistinctive` does.
  design_key text NOT NULL,
  -- And as the builder wrote it, for anything a person reads.
  design_label text NOT NULL,

  storage_bucket text NOT NULL DEFAULT 'builder-stock-images',
  storage_path text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint,
  -- The bytes as stored, so a fan-out row can name exactly what it serves.
  sha256 text,

  uploaded_by_builder_user_id uuid,
  -- Null where the Command Centre supplied it on the builder's behalf, which
  -- is a different act and is recorded as one.
  uploaded_by_staff_user_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT builder_design_images_key_not_blank CHECK (btrim(design_key) <> ''),
  CONSTRAINT builder_design_images_label_not_blank CHECK (btrim(design_label) <> ''),
  CONSTRAINT builder_design_images_one_per_design UNIQUE (organisation_id, design_key)
);

CREATE INDEX IF NOT EXISTS builder_design_images_org_idx
  ON public.builder_design_images (organisation_id, design_key);

-- ---------------------------------------------------------------------------
-- Row level security — the same posture as the four tables beside it.
--
-- No `authenticated` policy: every read and every write goes through an edge
-- function holding the service role, which is where the organisation boundary
-- (Builder Portal) and the module permission (Command Centre) are enforced. A
-- direct client grant would bypass both.
-- ---------------------------------------------------------------------------
ALTER TABLE public.builder_design_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS builder_design_images_service ON public.builder_design_images;
CREATE POLICY builder_design_images_service ON public.builder_design_images
  AS PERMISSIVE FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.builder_design_images FROM anon, authenticated;
GRANT ALL ON public.builder_design_images TO service_role;
