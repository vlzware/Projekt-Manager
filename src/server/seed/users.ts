/**
 * Seed users loader — fixture shape validation + direct-DB insert.
 *
 * Users live outside the import envelope contract (data-model.md §5.8 /
 * §7; api.md §14.2.4), so the seed's user pass is a direct-DB path rather
 * than a call through `ImportService`. Parsing (`parseUsersFixture`) is
 * pure and filesystem-free so the unit path that asserts malformed input
 * rejects can feed literals in; `loadUsers` composes file read + parse +
 * hash + insert.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Database } from '../db/connection.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../password.js';
import { SEED_DEFAULT_PASSWORD } from '../../test/seedAssumptions.js';

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
 * Resolve the fixture path relative to this module so both dev runs
 * (tsx) and bundled runs (esbuild → dist/server) can locate it without
 * a process.cwd() dependency. The fixture lives outside src/ on purpose
 * so it is not caught by the tsconfig/tsc compile pass.
 */
function fixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/server/seed/users.ts → ../../../fixtures/seed-users.json
  return path.resolve(here, '../../../fixtures/seed-users.json');
}

/**
 * Seeded user IDs keyed by username — single source of truth for ID
 * references across seed modules. `business.ts` calls this to emit
 * `project_workers[].userId` values that resolve against the users
 * `loadUsers` will insert.
 *
 * Lazy (cached on first call) rather than module-load: the app bundle
 * imports this module transitively from `start.ts` even in production,
 * where the fixture file is not shipped with the image (fixtures are
 * dev/test artifacts, not production data). A module-load read would
 * crash every production startup with a misleading ENOENT before the
 * SEED-gate in start.ts even gets to decide. The fail-loud property
 * on malformed fixtures is preserved — the first call from a seed run
 * still throws synchronously.
 */
let _cachedSeededUserIds: Readonly<Record<string, string>> | undefined;
export function getSeededUserIds(): Readonly<Record<string, string>> {
  if (!_cachedSeededUserIds) {
    _cachedSeededUserIds = Object.freeze(
      Object.fromEntries(
        parseUsersFixture(JSON.parse(readFileSync(fixturePath(), 'utf8')) as unknown).map((u) => [
          u.username,
          u.id,
        ]),
      ),
    );
  }
  return _cachedSeededUserIds;
}

/**
 * Read `fixtures/seed-users.json`, validate, hash the shared default
 * password once, and insert every row with its fixture-pinned UUID.
 *
 * Direct-DB (not via `ImportService`) because users are outside the
 * envelope contract (data-model.md §5.8). The orchestrator guarantees
 * the table is empty when this runs.
 */
export async function loadUsers(db: Database): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(fixturePath(), 'utf8'));
  const records = parseUsersFixture(raw);

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
