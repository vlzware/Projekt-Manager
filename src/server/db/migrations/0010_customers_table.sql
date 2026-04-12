-- Migration 0010: Add customers table, refactor projects to use customerId FK
-- This is a destructive migration — no data preservation needed (dev/test only).

-- 1. Create customers table
CREATE TABLE IF NOT EXISTS "customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255) NOT NULL,
  "phone" varchar(100),
  "email" varchar(255),
  "address" jsonb,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);

-- 2. Drop old JSONB columns from projects (customer, address)
ALTER TABLE "projects" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "projects" DROP COLUMN IF EXISTS "address";

-- 3. Add customerId FK and deleted flag to projects
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "customer_id" uuid;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted" boolean DEFAULT false NOT NULL;

-- 4. Add FK constraint (deferred — seed populates customers before projects)
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 5. Add index on customer_id
CREATE INDEX IF NOT EXISTS "idx_projects_customer_id" ON "projects" USING btree ("customer_id");

-- 6. Truncate projects so the NOT NULL constraint can be applied.
-- No real data exists — seed repopulates after migration.
TRUNCATE TABLE "project_workers", "projects" CASCADE;

-- 7. Make customer_id NOT NULL
ALTER TABLE "projects" ALTER COLUMN "customer_id" SET NOT NULL;
