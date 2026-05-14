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
import { loadInvoices } from './seed/invoices.js';
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
  //
  // `invoice_sequence` is reset so a force-reseed gets clean
  // `RE-YYYY-0001` numbering. The cascade from `projects` already
  // empties `invoices`, but the sequence table has no FK and would
  // otherwise carry forward the high-water mark of every prior run.
  await db.execute(
    sql`TRUNCATE TABLE notification_rule, project_workers, sessions, projects, customers, users, invoice_sequence CASCADE`,
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
  // CASCADE above wiped. The seed ships a COMPLETE profile so the
  // dev / E2E happy path can issue invoices without manual setup
  // — the invoice issuance gate (AC-289 / COMPANY_PROFILE_REQUIRED)
  // expects every mandatory field populated. Owner can still edit
  // via `PUT /api/company-profile` (ui/daten.md §8.11.4). The
  // baseline migration's empty defaults remain the production
  // posture; the seed overrides them for the test fixture.
  // The INSERT lists only the columns the fixture pins; the UPDATE
  // clause mirrors the same column set so a re-seed over an existing
  // row (force re-seed) overwrites exactly what the fixture asserts and
  // leaves every other column at whatever the row already carried.
  // `accent_color`, `footer_text`, and `logo_binary_descriptor_id` are
  // intentionally absent: the fixture does not pin them, and the column
  // defaults from the baseline migration are the right resting state
  // (no accent override, no footer text, no logo).
  await db.execute(sql`
    INSERT INTO "company_profile"
      ("company_name", "address", "tax_id", "ust_id", "iban", "default_tax_mode")
    VALUES (
      'Maler Berger GmbH',
      '{"street":"Werkstr. 1","zip":"10115","city":"Berlin"}'::jsonb,
      '111/222/33333',
      'DE123456789',
      'DE12 1000 0000 1234 5678 90',
      'standard'
    )
    ON CONFLICT ("singleton") DO UPDATE SET
      "company_name" = EXCLUDED."company_name",
      "address" = EXCLUDED."address",
      "tax_id" = EXCLUDED."tax_id",
      "ust_id" = EXCLUDED."ust_id",
      "iban" = EXCLUDED."iban",
      "default_tax_mode" = EXCLUDED."default_tax_mode"
  `);

  // Invoices land last because issuance pulls live snapshots from
  // `users`, `customers`, `projects`, and the `company_profile`
  // singleton — every dependency must already be seeded. The loader
  // exercises the public `InvoiceService` surface end-to-end (draft →
  // issue → optional cancel + reissue), so it mints real factur-x XML,
  // real rendered PDFs, real binary descriptors, and real audit rows.
  await loadInvoices(db, { now });

  console.warn(
    `⚠  Seed-Daten geladen. Alle Benutzer haben das Standardpasswort "${SEED_DEFAULT_PASSWORD}". ` +
      'Passwörter müssen vor Produktiveinsatz geändert werden.',
  );
}
