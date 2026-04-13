-- Migration 0012: Switch planned dates from timestamptz to date type
-- The spec says "No time zones — all dates are local calendar dates."
-- Using PostgreSQL `date` eliminates timezone ambiguity at the storage level.
-- No data loss: the time component was always midnight UTC.

ALTER TABLE "projects" ALTER COLUMN "planned_start" TYPE date USING planned_start::date;
ALTER TABLE "projects" ALTER COLUMN "planned_end" TYPE date USING planned_end::date;
