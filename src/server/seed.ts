/**
 * Seed data orchestrator for development and testing.
 *
 * Creates 21 customers, 19 projects across all 9 workflow states, and
 * 6 users (5 active + 1 inactive) with the default password defined in
 * `src/test/seedAssumptions.ts`. Dates are relative to the reference
 * moment captured at the start of this run — never hardcoded, never
 * module-load-time.
 *
 * Loader split (see data-model.md §7): users go through a direct-DB
 * path; customers / projects / project_workers go through `ImportService`
 * so every seed run exercises the public import contract.
 *
 * The production gate (`NODE_ENV === 'production'`) lives in
 * `src/server/start.ts` — this function is dev/test-only and trusts its
 * caller.
 */

import { sql } from 'drizzle-orm';

import type { Database } from './db/connection.js';
import { users } from './db/schema.js';
import { loadUsers } from './seed/users.js';
import { loadBusiness } from './seed/business.js';
import { loadNotificationRules } from './seed/notificationRules.js';
import { SEED_DEFAULT_PASSWORD } from '../test/seedAssumptions.js';

/**
 * Seed the database with sample data.
 *
 * Behavior depends on the `force` option:
 * - `force: false` (default) — skip if users already exist, preserving
 *   manual changes across dev server restarts.
 * - `force: true` — wipe all data and re-seed. Used by tests for a
 *   guaranteed clean slate, and via SEED=force when seed data changes.
 */
export async function seed(db: Database, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      console.log('Database already seeded — skipping. Set SEED=force to wipe and re-seed.');
      return;
    }
  }

  // Clear existing data atomically. Preserved verbatim from the
  // pre-refactor seed — the identical statement is part of AT-87's
  // implicit contract (tests rely on a truly empty slate).
  //
  // Notification rules and push subscriptions are NOT listed in the
  // TRUNCATE: notification_rule has no FK back to any table in the
  // wipe set, and CASCADE through users handles push_subscriptions.
  // The rule table is truncated separately below so the seed-supplied
  // v1 rule set lands cleanly even when notification_rule had prior
  // rows (force-reseed).
  //
  // `company_profile` is reseeded after the TRUNCATE: it has a FK
  // (`updated_by → users.id`), so `TRUNCATE … users CASCADE` empties it
  // as well. The singleton-row contract (data-model.md §5.17,
  // ADR-0026) says the row MUST exist before any read — re-insert with
  // `ON CONFLICT (singleton) DO NOTHING`, mirroring the baseline
  // migration's seed line.
  await db.execute(
    sql`TRUNCATE TABLE notification_rule, project_workers, sessions, projects, customers, users CASCADE`,
  );

  // Reference moment for every relative date downstream. Captured once so
  // the envelope's year prefix and relative offsets line up with each
  // other (a Dec 31 → Jan 1 rollover between user insert and project
  // insert would otherwise leave projects in next year's prefix).
  const now = new Date();

  await loadUsers(db);
  await loadBusiness(db, { now });
  await loadNotificationRules(db);

  // Restore the company_profile singleton row that the TRUNCATE
  // CASCADE above wiped. Default values land — mandatory fields
  // remain empty so the issuance gate (AC-289 /
  // COMPANY_PROFILE_REQUIRED) keeps firing until owner fills them
  // via `PUT /api/company-profile`. Matches the baseline migration
  // INSERT verbatim.
  await db.execute(
    sql`INSERT INTO "company_profile" DEFAULT VALUES ON CONFLICT ("singleton") DO NOTHING`,
  );

  console.warn(
    `⚠  Seed-Daten geladen. Alle Benutzer haben das Standardpasswort "${SEED_DEFAULT_PASSWORD}". ` +
      'Passwörter müssen vor Produktiveinsatz geändert werden.',
  );
}
