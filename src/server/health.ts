/**
 * Health probe for the /api/health endpoint.
 *
 * Before #48 the endpoint returned `{status:'ok'}` unconditionally — a DB
 * outage, a MinIO outage, or a broken storage bucket would all be invisible
 * until the container actually died. This module adds liveness probes for
 * the two external dependencies the app cannot function without.
 *
 * Each probe runs in parallel via Promise.allSettled so a slow or failing
 * check on one dependency does not block the other. The caller decides the
 * HTTP status code — 200 when both checks report `ok`, 503 otherwise.
 */

import type pg from 'pg';
import type { StorageClient } from './storage/client.js';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  checks: {
    db: 'ok' | 'fail';
    storage: 'ok' | 'fail';
  };
}

export async function probeHealth(pool: pg.Pool, storage: StorageClient): Promise<HealthStatus> {
  const [dbResult, storageResult] = await Promise.allSettled([
    pool.query('SELECT 1'),
    storage.ping(),
  ]);

  const checks = {
    db: dbResult.status === 'fulfilled' ? ('ok' as const) : ('fail' as const),
    storage: storageResult.status === 'fulfilled' ? ('ok' as const) : ('fail' as const),
  };

  const status: HealthStatus['status'] =
    checks.db === 'ok' && checks.storage === 'ok' ? 'ok' : 'degraded';

  return { status, checks };
}
