import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-role storage-state paths, written by `e2e/auth.setup.ts` and
 * consumed by specs via `test.use({ storageState: STORAGE_STATES.<role> })`.
 *
 * Kept in a plain module (not the `.setup.ts` file) because Playwright
 * rejects test-file → test-file imports. The `.setup.ts` pattern is
 * reserved for files that declare `setup(...)` tests.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.resolve(__dirname, '.auth');

export const STORAGE_STATES = {
  owner: path.join(AUTH_DIR, 'owner.json'),
  office: path.join(AUTH_DIR, 'office.json'),
  worker: path.join(AUTH_DIR, 'worker.json'),
  bookkeeper: path.join(AUTH_DIR, 'bookkeeper.json'),
} as const;

/** Default storage state — owner, most broadly-capable role. */
export const STORAGE_STATE = STORAGE_STATES.owner;
