-- Migration 0013: Add users.theme_preference column (AC-115)
-- data-model.md §5.3, §5.7 — per-user theme preference with DB CHECK
-- as defense-in-depth against values outside {'light','dark','system'}.
-- Existing rows receive the documented default 'system' via the NOT NULL
-- DEFAULT; new rows without an explicit value inherit the same default.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "theme_preference" text DEFAULT 'system' NOT NULL;

ALTER TABLE "users" ADD CONSTRAINT "users_valid_theme_preference"
  CHECK ("theme_preference" IN ('light', 'dark', 'system'));
