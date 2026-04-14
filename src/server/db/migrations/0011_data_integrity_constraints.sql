-- Migration 0011: Data integrity constraints
-- Adds defense-in-depth CHECK constraints and missing FK references
-- identified by the data integrity audit.

-- 1. CHECK: only valid workflow status values
ALTER TABLE "projects" ADD CONSTRAINT "projects_valid_status"
  CHECK (status IN (
    'anfrage', 'angebot', 'beauftragt', 'geplant', 'in_arbeit',
    'abnahme', 'rechnung_faellig', 'abgerechnet', 'erledigt'
  ));

-- 2. CHECK: planned_end must not be before planned_start
ALTER TABLE "projects" ADD CONSTRAINT "projects_end_not_before_start"
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start);

-- 3. FK: customers.created_by → users.id (SET NULL on delete)
--    Matches the pattern already used by projects.created_by.
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- 4. FK: customers.updated_by → users.id (SET NULL on delete)
ALTER TABLE "customers" ADD CONSTRAINT "customers_updated_by_users_id_fk"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
