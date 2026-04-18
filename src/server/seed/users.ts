/**
 * Seed users loader — fixture shape validation + direct-DB insert.
 *
 * Users live outside the import envelope contract (data-model.md §5.8 /
 * §7; api.md §14.2.4), so the seed's user pass is a direct-DB path rather
 * than a call through `ImportService`. Parsing (`parseUsersFixture`) is
 * pure and filesystem-free so the unit path that asserts malformed input
 * rejects can feed literals in; `loadUsers` composes parse + hash +
 * insert on the bundled-at-build-time fixture.
 */
import { z } from 'zod';

import type { Database } from '../db/connection.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../password.js';
import { SEED_DEFAULT_PASSWORD } from '../../test/seedAssumptions.js';
// JSON import attribute — esbuild (build:server) and vitest both
// inline the fixture at build time, so there is no runtime fs access
// and no path-resolution dependency on the source-tree layout. The
// bundled `dist/server/start.js` used to crash with ENOENT on
// `/fixtures/seed-users.json` because `path.resolve(here, '../../../
// fixtures/…')` landed at the filesystem root under the flattened
// bundle layout; inlining sidesteps that class of bug entirely.
import rawFixture from '../../../fixtures/seed-users.json' with { type: 'json' };

// Cross-package import rationale: `SEED_DEFAULT_PASSWORD` is the single
// source of truth for the seeded password (see seedAssumptions.ts header).
// The dependency direction (server seed → test-layer constant) is
// accepted because the constant is the assertion contract the tests pin
// against; the seed producing a different value would be an integrity
// drift, not a separation-of-concerns issue.

/**
 * Fixture schema. `.strict()` refuses unknown keys so an accidentally
 * committed `passwordHash` / `createdAt` in the JSON fails loudly rather
 * than silently dropping. Roles are validated as a non-empty string array
 * — finer-grained role-value validation is the domain layer's job and is
 * exercised elsewhere; here we only guarantee the shape the INSERT needs.
 *
 * The `id` check is deliberately looser than Zod's `.uuid()` — the
 * fixture uses vanity-hex values like `11111111-...-111111111111` that
 * don't conform to RFC 4122 variant bits but are valid Postgres `uuid`
 * inputs. Postgres itself is the authoritative validator; this regex
 * only catches the obvious shape slip.
 */
const userFixtureSchema = z
  .object({
    id: z.guid(),
    username: z.string().min(1),
    displayName: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    email: z.email().nullable(),
    active: z.boolean(),
  })
  .strict();

const usersFixtureSchema = z.array(userFixtureSchema);

export type SeedUserFixture = z.infer<typeof userFixtureSchema>;

/**
 * Validate a raw fixture payload. Throws a `ZodError` on any shape
 * violation (missing required field, wrong type, unknown key, bad UUID,
 * empty roles array, malformed email). No filesystem, no DB — pure, so
 * the AT-88 unit path can exercise it with a literal value.
 *
 * ZodError is Zod's own typed error class (`instanceof ZodError`), which
 * satisfies AC-164's "typed validation error" without us minting a
 * project-specific subclass — adding one would be a new surface the
 * calling code would have to branch on with no integrity benefit.
 */
export function parseUsersFixture(raw: unknown): SeedUserFixture[] {
  return usersFixtureSchema.parse(raw);
}

/**
 * Seeded user IDs keyed by username — single source of truth for ID
 * references across seed modules. `business.ts` calls this to emit
 * `project_workers[].userId` values that resolve against the users
 * `loadUsers` will insert.
 *
 * The fixture is inlined at build time (JSON import attribute above),
 * so this is a cheap object lookup with no filesystem access. Lazy
 * caching avoids re-parsing on repeated calls.
 */
let _cachedSeededUserIds: Readonly<Record<string, string>> | undefined;
export function getSeededUserIds(): Readonly<Record<string, string>> {
  if (!_cachedSeededUserIds) {
    _cachedSeededUserIds = Object.freeze(
      Object.fromEntries(parseUsersFixture(rawFixture).map((u) => [u.username, u.id])),
    );
  }
  return _cachedSeededUserIds;
}

/**
 * Validate the bundled fixture, hash the shared default password once,
 * and insert every row with its fixture-pinned UUID.
 *
 * Direct-DB (not via `ImportService`) because users are outside the
 * envelope contract (data-model.md §5.8). The orchestrator guarantees
 * the table is empty when this runs.
 */
export async function loadUsers(db: Database): Promise<void> {
  const records = parseUsersFixture(rawFixture);

  // Hash once — bcrypt is expensive, and every seeded user shares the
  // same plaintext per the spec (data-model.md §7.2).
  const passwordHash = await hashPassword(SEED_DEFAULT_PASSWORD);

  await db.insert(users).values(
    records.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName,
      passwordHash,
      roles: r.roles,
      email: r.email,
      active: r.active,
    })),
  );
}
