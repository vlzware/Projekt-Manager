/**
 * Seed data assumptions — single source of truth for what tests expect
 * `src/server/seed.ts` to produce.
 *
 * This file is an "assumption contract" between the seed and the tests.
 * Every assertion that depends on a seeded value (username, displayName,
 * role, default password, ...) should reference one of these constants
 * rather than hardcoding the literal. A change to `seed.ts` then produces
 * a typed compiler error here — and through here in every consuming test —
 * instead of silently breaking runtime assertions across many files.
 *
 * When `seed.ts` changes:
 *   1. Update this file to match.
 *   2. Run the full test suite.
 *   3. Fix any test that legitimately depended on the old value.
 *
 * Do NOT loosen an assertion to avoid updating a constant. The constant is
 * a typed reference to the same value the seed produces — loosening hides
 * the coupling instead of surfacing it.
 *
 * Current source of truth: `src/server/seed.ts` (userRecords, line ~52).
 */

/**
 * Default password for every seeded user.
 *
 * The seed hashes this string via `hashPassword('changeme')` and assigns
 * the result to every userRecord. Tests that mutate a user's password
 * (e.g. AT-14 rotates `buero`'s password) must NOT reference this
 * constant after the mutation — the constant describes the seeded state,
 * not the live state.
 */
export const SEED_DEFAULT_PASSWORD = 'changeme';

/**
 * Seeded users, keyed by role/purpose. Each entry mirrors the shape of
 * `userRecords` in `src/server/seed.ts` for the fields tests care about:
 * username, displayName, roles, active.
 *
 * Keyed by semantic label (owner/office/worker1/...) rather than by
 * username so a test reads as "log in as the owner" rather than "log in
 * as 'inhaber'" — the username becomes an implementation detail.
 *
 * `as const` is load-bearing: it makes every string a literal type, so
 * a typo on a consuming site surfaces as a TypeScript error at edit time.
 */
export const SEED_USERS = {
  owner: {
    username: 'inhaber',
    displayName: 'Thomas Berger',
    roles: ['owner'],
    active: true,
  },
  office: {
    username: 'buero',
    displayName: 'Maria Schmidt',
    roles: ['office'],
    active: true,
  },
  worker1: {
    username: 'arbeiter1',
    displayName: 'Jan Nowak',
    roles: ['worker'],
    active: true,
  },
  worker2: {
    username: 'arbeiter2',
    displayName: 'Lukas Fischer',
    roles: ['worker'],
    active: true,
  },
  bookkeeper: {
    username: 'buchhalter',
    displayName: 'Petra Weiß',
    roles: ['bookkeeper'],
    active: true,
  },
  inactive: {
    username: 'deaktiviert',
    displayName: 'Ehemaliger Mitarbeiter',
    roles: ['worker'],
    active: false,
  },
} as const;
