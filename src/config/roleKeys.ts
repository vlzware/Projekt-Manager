/**
 * Role key catalog — single source for the server-accepted role set.
 *
 * Kept alongside `permissions.ts` so the role names referenced from
 * schema validators, notification-rule spec checks, and the UI role
 * selector share one list. Extending the matrix means extending this
 * array plus `ROLE_PERMISSIONS` in `permissions.ts`.
 */

import type { Role } from './permissions.js';

export const ROLE_KEYS: readonly Role[] = ['owner', 'office', 'worker', 'bookkeeper'] as const;
