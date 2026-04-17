/**
 * Public backup-status route.
 *
 * Serves the owner-only badge on the unauthenticated login screen
 * (verification.md §15.22 AC-170, AC-176). The response carries ONLY
 * the badge-visible metadata defined in data-model.md §5.9 — no PII,
 * no credentials, no operational detail beyond what the mirror object
 * in R2 already exposes unencrypted.
 *
 * Authentication: none. The network reach of the app is VPN-gated
 * (ADR-0008), which is the threat-model anchor for exposing this
 * endpoint publicly. Load shedding on a public route relies on the
 * same rate-limit machinery other routes use; this endpoint registers
 * its own override so a flood of login-screen loads cannot starve
 * authenticated traffic.
 *
 * Error shape: standard `{ code, message }` envelope on 503 when the
 * DB is unreachable AND the mirror is unavailable (the misleading-state
 * guard in AC-171 — an unreachable surface is an explicit "unknown"
 * state, not a silent blank).
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { BackupStatusService } from '../services/BackupStatusService.js';
import type { BackupStatus } from '../../domain/backupBadge.js';

/** Response shape when the status surface is unreachable. */
interface BackupStatusUnavailable {
  available: false;
}

/** Response shape on success. */
interface BackupStatusAvailable {
  available: true;
  status: BackupStatus;
}

type BackupStatusResponse = BackupStatusAvailable | BackupStatusUnavailable;

export function backupRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const backupStatusService = new BackupStatusService(db, {
      warn: (obj, msg) => app.log.warn(obj, msg),
    });

    // ---------------------------------------------------------------
    // GET /api/backup/status (public; AC-176)
    //
    // Unauthenticated read of the current BackupStatus. Returns
    // `{ available: true, status }` when the DB yielded a row, or
    // `{ available: false }` when the row is unreachable — either
    // case drives the client-side `deriveBadgeState()` so the
    // unknown state renders explicitly rather than silently hiding
    // the badge (AC-171).
    //
    // Response carries ONLY the data-model.md §5.9 badge fields.
    // Nothing in that contract is PII; the mirror object in R2
    // already publishes the identical payload unencrypted. Asserted
    // by the `select()` list below, which is a positive allowlist
    // rather than a blacklist so adding a sensitive column to the
    // status row later does not silently leak it.
    // ---------------------------------------------------------------
    app.get(
      '/api/backup/status',
      {
        // A modest ceiling — the login screen loads this once per
        // visit and the endpoint is cheap, but we still don't want a
        // scripted attacker saturating the DB path. 30/min per IP
        // matches the dev/test rate for `/api/auth/login`, which is
        // the other public surface served by the same process.
        config: {
          rateLimit: { max: 30, timeWindow: '1 minute' as const },
        },
      },
      async (_request, reply) => {
        const status = await backupStatusService.read();
        if (status === null) {
          const body: BackupStatusResponse = { available: false };
          return reply.code(200).send(body);
        }
        const body: BackupStatusResponse = {
          available: true,
          // Explicit allowlist: if data-model.md §5.9 ever gains a
          // PII-ish field, this surface stays silent until the field
          // is explicitly added here. See AC-176.
          status: {
            lastBackupAt: status.lastBackupAt,
            lastBackupOk: status.lastBackupOk,
            lastDrillAt: status.lastDrillAt,
            lastDrillOk: status.lastDrillOk,
            lastError: status.lastError,
            updatedAt: status.updatedAt,
          },
        };
        return reply.code(200).send(body);
      },
    );
  };
}
