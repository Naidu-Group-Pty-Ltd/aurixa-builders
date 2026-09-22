-- ============================================================================
-- AN UPSERT KEYED ON A NULLABLE COLUMN IS NOT AN UPSERT WHEN THE COLUMN IS NULL
-- ============================================================================
--
-- MEASURED 22 SEPTEMBER 2026 on the acceptance corpus, through the real image
-- settler. One upload, one document, TWO pictures — and seven image rows:
--
--   329f68b0  stock_item_id set     position 0  page1 FormXob.0bf9…  04:35:54.78
--   36ebcee6  stock_item_id NULL    position 1  page2 FormXob.2355…  04:35:54.79
--   399eadfe  stock_item_id NULL    position 0  page1 FormXob.0bf9…  04:35:55.40
--   05473376  stock_item_id NULL    position 1  page2 FormXob.2355…  04:35:55.40
--   c1eb6edb  stock_item_id NULL    position 0  page1 FormXob.0bf9…  04:35:55.80
--   9005804e  stock_item_id NULL    position 1  page2 FormXob.2355…  04:35:55.81
--   91a61172  stock_item_id NULL    position 1  page2 FormXob.2355…  04:35:56.42
--
-- Same bytes, same sha256, same storage path, six tenths of a second apart —
-- one row per settlement pass. Every repeat is UNATTACHED: an image row
-- belonging to no property, which is precisely the "hidden staged orphan" this
-- pipeline is not allowed to produce.
--
-- THE CAUSE IS ONE LINE OF SQL SEMANTICS. Every writer upserts with
--
--     onConflict: 'stock_item_id,source_stage,source_reference'
--
-- against `builder_stock_item_images_stage_ref_key`, which is a plain UNIQUE
-- index — and a UNIQUE index in PostgreSQL treats NULLs as DISTINCT unless it
-- says otherwise. So two rows holding (NULL, 'uploaded_document', 'page1:…')
-- do not conflict, `ON CONFLICT` has nothing to fire on, and the upsert
-- INSERTS. A write that was designed to be idempotent is idempotent for every
-- attributed image and for no unattributed one.
--
-- WHY NOT `NULLS NOT DISTINCT` ON THE EXISTING INDEX. Because it would make
-- (NULL, stage, reference) unique across the WHOLE TABLE, and
-- `source_reference` is a position inside a document — `page1:FormXob.<name>#4`.
-- Two different builders' uploads can produce the same reference, and merging
-- their rows would be a cross-upload collision: one organisation's picture
-- silently updating another's. That is a far worse defect than the one being
-- fixed.
--
-- So the unattached case gets its own key, on the column that actually scopes
-- it: the UPLOAD. An unattributed image belongs to exactly one upload by
-- construction, so (upload_id, source_stage, source_reference) is unique for
-- it, and the partial predicate keeps the index off every attributed row —
-- which keeps the existing key the only one that governs those.
--
-- The duplicates already written are removed here, oldest kept: the oldest row
-- for a given (upload, stage, reference) is the one every later pass was
-- trying to update. Nothing attributed is touched.
-- ============================================================================

-- 1 · Remove the orphans this defect accumulated, keeping the first of each.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY upload_id, source_stage, source_reference
           ORDER BY created_at, id
         ) AS seq
    FROM public.builder_stock_item_images
   WHERE stock_item_id IS NULL
)
DELETE FROM public.builder_stock_item_images AS im
 USING ranked
 WHERE im.id = ranked.id
   AND ranked.seq > 1;

-- 2 · And make the write that produced them idempotent.
--
-- `upload_id` is nullable on this table, so the predicate names it too: a row
-- with neither an item nor an upload has no scope to be unique within, and
-- including it would put every such row in one bucket.
CREATE UNIQUE INDEX IF NOT EXISTS builder_stock_item_images_unattached_key
    ON public.builder_stock_item_images (upload_id, source_stage, source_reference)
 WHERE stock_item_id IS NULL AND upload_id IS NOT NULL;

COMMENT ON INDEX public.builder_stock_item_images_unattached_key IS
  'The upsert key for an image not yet attributed to a property. The main key is (stock_item_id, source_stage, source_reference), and a UNIQUE index treats NULLs as distinct — so without this every unattributed write INSERTS and one document accumulates a row per settlement pass, each one an orphan. Partial on purpose: an attributed row is governed by the main key alone, and scoping by upload rather than globally keeps two builders'' identical page references from colliding.';
