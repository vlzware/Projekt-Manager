-- Create the auxiliary databases alongside the main one.
-- Runs only on first container init (empty data directory).
--
-- `projekt_manager_test`  — vitest integration suites
-- `projekt_manager_e2e`   — Playwright isolated environment. Without a
--   dedicated DB, E2E's `TRUNCATE CASCADE` in auth.setup.ts raced any
--   live developer session on the main DB, surfacing as "random"
--   visual / data-drift failures.
CREATE DATABASE projekt_manager_test;
CREATE DATABASE projekt_manager_e2e;
