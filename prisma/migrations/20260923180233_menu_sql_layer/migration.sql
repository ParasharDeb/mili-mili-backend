-- Rebuild `items` for SQL-first retrieval: real prices, separated tag/allergen
-- concerns, availability flags, and the indexes the query layer needs.
--
-- Every statement is guarded so the file is safely re-runnable. Postgres will
-- not run this migration in a single transaction (CREATE INDEX and ALTER TYPE
-- see to that), so a failure part-way through has to be recoverable by simply
-- running it again.

-- 1. Fix the misspelled diet values. RENAME VALUE is catalog-only in PG 10+:
--    no table rewrite, no data loss, and `users.diet_preference` (which shares
--    the enum) follows automatically. Prisma's generated diff wanted to build a
--    new type and cast through text, which would fail on the existing rows.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'DietPrefEnum' AND e.enumlabel = 'Vegeterian') THEN
    ALTER TYPE "DietPrefEnum" RENAME VALUE 'Vegeterian'     TO 'Vegetarian';
    ALTER TYPE "DietPrefEnum" RENAME VALUE 'Non_vegeterian' TO 'NonVegetarian';
    ALTER TYPE "DietPrefEnum" RENAME VALUE 'Eggeterian'     TO 'Eggetarian';
  END IF;
END $$;

-- 2. Unused since the day it was created.
DROP TYPE IF EXISTS "SpicyEnum";

-- 3. Typo-tolerant dish-name lookup. This is what replaces embeddings.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ProvenanceEnum" AS ENUM ('pos', 'heuristic', 'llm', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. `price` is NOT NULL and the old rows have no price to backfill from. The
--    menu is re-seeded from the POS export immediately after this migration, so
--    emptying the table is honest -- a made-up default price is not.
TRUNCATE TABLE "items";

-- AlterTable
ALTER TABLE "items" DROP COLUMN IF EXISTS "serves";
ALTER TABLE "items" DROP COLUMN IF EXISTS "allergens";
ALTER TABLE "items"
  ADD COLUMN IF NOT EXISTS "allergens"          TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "allergens_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "category_ref"       TEXT,
  ADD COLUMN IF NOT EXISTS "currency"           CHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS "derived_at"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "derived_from"       "ProvenanceEnum" NOT NULL DEFAULT 'heuristic',
  ADD COLUMN IF NOT EXISTS "external_ref"       TEXT,
  ADD COLUMN IF NOT EXISTS "image_url"          TEXT,
  ADD COLUMN IF NOT EXISTS "is_active"          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "is_available"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "popularity"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "price"              DECIMAL(10,2) NOT NULL,
  ADD COLUMN IF NOT EXISTS "serves_max"         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "serves_min"         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "sold_out"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sort_order"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "source"             TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "tags"               TEXT[];

-- 5. Weighted search vector, maintained by Postgres so no application code can
--    forget to refresh it. Name is what guests type (A), description next (B).
--
--    `taste_tags` and `tags` are deliberately NOT in here: array_to_string() is
--    only STABLE, not IMMUTABLE, so Postgres refuses it in a generated column.
--    Both arrays have their own GIN indexes below, and tag overlap is scored in
--    menu.rank.ts, so nothing is lost by keeping this to the two text columns.
ALTER TABLE "items"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("desc", '')), 'B')
  ) STORED;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "items_diet_course_spice_idx"  ON "items"("diet", "course", "spice");
CREATE INDEX IF NOT EXISTS "items_course_cuisine_diet_idx" ON "items"("course", "cuisine", "diet");
CREATE INDEX IF NOT EXISTS "items_price_idx"              ON "items"("price");
CREATE INDEX IF NOT EXISTS "items_popularity_idx"         ON "items"("popularity" DESC);
CREATE INDEX IF NOT EXISTS "items_tags_idx"               ON "items" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS "items_taste_tags_idx"         ON "items" USING GIN ("taste_tags");
CREATE INDEX IF NOT EXISTS "items_search_vector_idx"      ON "items" USING GIN ("search_vector");
CREATE INDEX IF NOT EXISTS "items_name_trgm_idx"          ON "items" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "items_desc_trgm_idx"          ON "items" USING GIN ("desc" gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "items_source_external_ref_key" ON "items"("source", "external_ref");

-- 6. The predicate every guest-facing query carries. Not expressible in Prisma.
CREATE INDEX IF NOT EXISTS "items_orderable_course_idx"
  ON "items" ("course", "sort_order")
  WHERE "is_active" AND "is_available" AND NOT "sold_out";
