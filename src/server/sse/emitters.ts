/**
 * Typed emit helpers for the SSE invalidation bus. One helper per
 * event name in the catalog (`src/config/sseEvents.ts`) so call sites
 * cannot misspell the wire string and cannot accidentally swap
 * payloads between event classes. Per architecture.md §11.13 emission
 * is post-commit only — every helper assumes the surrounding
 * transaction has already resolved.
 */

import { STORAGE_USAGE_CHANGED } from '../../config/sseEvents.js';
import { broadcast } from './bus.js';

/**
 * Broadcast `storage_usage_changed` (api.md §14.2.13). Emit AFTER the
 * surrounding transaction commits so a tx abort emits nothing
 * (verification.md AC-270, architecture.md §11.13).
 */
export function emitStorageUsageChanged(): void {
  broadcast(STORAGE_USAGE_CHANGED);
}
