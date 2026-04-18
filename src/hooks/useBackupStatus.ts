/**
 * Public backup-status fetcher for the unauthenticated login surface.
 *
 * Fetches `GET /api/backup/status` once on mount (AC-170 requires the
 * badge rendered on the login screen; AC-171 requires "Status unbekannt"
 * when the source is unreachable — never a silent absence). Not used
 * on the authenticated surface: the `/api/auth/me` response carries the
 * status for owner callers through `authStore.backupStatus` instead,
 * so this hook would otherwise double-fetch.
 *
 * Return shape:
 *   - `loading`       — initial mount, still waiting on the response.
 *   - `status`        — parsed `BackupStatus` when the server replied
 *                       `{ available: true, status }`.
 *   - `status === undefined` with `loading === false` — response was
 *                       `{ available: false }`, a 4xx/5xx, a malformed
 *                       body, or a network failure. The login view
 *                       passes `undefined` to `deriveBadgeState` so
 *                       the badge renders the `unknown` branch.
 *
 * No polling. A user reloading the page re-fetches naturally, and
 * the public rate-limit (30/min per IP) is sized around that cadence.
 */
import { useEffect, useState } from 'react';
import { backupApi } from '@/api/client';
import type { BackupStatus } from '@/domain/backupBadge';

interface UseBackupStatusResult {
  loading: boolean;
  status: BackupStatus | undefined;
}

export function useBackupStatus(): UseBackupStatusResult {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<BackupStatus | undefined>(undefined);

  useEffect(() => {
    // Effect may run twice under React 19 StrictMode in dev. The second
    // run overwrites the first; both are idempotent reads of the public
    // surface, and the response is memoryless, so a double fetch has no
    // observable effect beyond a single extra HTTP round-trip in dev.
    let cancelled = false;

    void (async () => {
      const result = await backupApi.status();
      if (cancelled) return;
      if (result.ok && result.data.available === true) {
        setStatus(result.data.status);
      } else {
        // { available: false }, network error, malformed body, 4xx/5xx —
        // all collapse to `undefined`, which `deriveBadgeState` reads as
        // the "Status unbekannt" branch. AC-171 forbids silent hiding, so
        // the caller must still render a badge on this branch.
        setStatus(undefined);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { loading, status };
}
