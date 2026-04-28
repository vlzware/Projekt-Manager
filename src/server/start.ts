/**
 * Production entry point.
 *
 * Boots the Fastify application, runs database migrations,
 * optionally seeds data, serves the static frontend, and starts listening.
 *
 * Executed via: node --import tsx src/server/start.ts
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { STRINGS } from '../config/strings.js';
import { buildApp } from './app.js';
import { bootstrapAdminIfEmpty } from './bootstrap.js';
import {
  assertAppServerEnv,
  assertProductionSafe,
  assertStoragePublicEndpointInProduction,
  validateEnvRuntime,
} from './config/env.js';
import { emitFeatureManifest } from './config/features.js';
import { createDatabase } from './db/connection.js';
import { probeHealth } from './health.js';
import { seed } from './seed.js';
import { deleteExpiredSessions } from './repositories/session.js';
import { startSessionReaper } from './session-reaper.js';
import { startAuditRetentionScheduler } from './audit-retention-scheduler.js';
import { startAttachmentOrphanReaperScheduler } from './attachment-orphan-reaper-scheduler.js';
import { startBulkDownloadReaperScheduler } from './bulk-download-reaper-scheduler.js';
import { setOperationalLogger as setAuditPublisherLogger } from './services/audit-publisher.js';
import { AUDIT_RETENTION } from '../config/auditRetention.js';
import { ATTACHMENT_CONFIG } from '../config/attachmentConfig.js';
import { STATE_KEYS } from '../config/stateConfig.js';
import { createStorageClient } from './storage/client.js';
import { assertStorageBucketSafe } from './storage/safety.js';
import { staticCacheControl } from './staticCache.js';

const HOST = '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, 'db/migrations');
const distFolder = path.resolve(__dirname, '../../dist');

/**
 * Verify that every `status` value in the projects table is present in
 * the configured workflow states. Refuses to start if orphaned statuses
 * exist — prevents silent data loss when states are removed or renamed
 * without a data migration.
 */
async function validateWorkflowStates(db: ReturnType<typeof createDatabase>['db']): Promise<void> {
  const validSet = new Set<string>(STATE_KEYS);
  const rows = await db.execute<{ status: string }>(
    sql`SELECT DISTINCT status FROM projects WHERE deleted = false`,
  );
  const orphaned = rows.rows.filter((r) => !validSet.has(r.status)).map((r) => r.status);
  if (orphaned.length > 0) {
    throw new Error(
      `Refusing to start: ${orphaned.length} project(s) have status values not in the current ` +
        `workflow configuration: ${orphaned.join(', ')}. Run a data migration to reassign these ` +
        `projects before changing the workflow states.`,
    );
  }
}

async function start(): Promise<void> {
  // --- Validate environment (fail fast before any I/O) ---
  // validateEnvRuntime() returns the typed Env and folds in dev-default
  // credential rejection; the cross-field guards below remain external
  // so start.ts keeps control of their order and the backup-runner
  // (which shares validateEnvRuntime) does not get the app-server-only
  // narrowing.
  const env = validateEnvRuntime();
  const isProduction = env.NODE_ENV === 'production';

  // --- Production safety checks ---
  // assertProductionSafe() lives in env.ts so it can be unit-tested directly
  // (see env.test.ts) — see ADR-0013 and consolidation review C-2/C-4.
  assertProductionSafe(env);
  // STORAGE_* are optional at schema level (the backup-runner CLI shares
  // the same validator but doesn't use MinIO); the app server cannot run
  // without them, so enforce here.
  assertAppServerEnv(env);
  // Refuse to start in production when the storage client would sign
  // presigned URLs against a container-only hostname — the browser
  // cannot resolve those, so every upload fails silently.
  assertStoragePublicEndpointInProduction(env);

  // Emit the boot-time feature manifest (AC-230) immediately after env
  // validation — operators see a single structured line listing every
  // optional feature's enabled/disabled state with reason. Order is
  // significant: the test pins emission AFTER validateEnvRuntime() so
  // the manifest never reports on an unverified env.
  emitFeatureManifest(env, {
    info: (ctx) => console.log(JSON.stringify(ctx)),
  });

  if (env.ALLOW_INSECURE_HTTP === 'true') {
    console.warn(
      'WARNING: ALLOW_INSECURE_HTTP=true — cookie Secure flag is OFF. ' +
        'Do not use with real users or real data. See docs/ops/http-only-evaluation.md.',
    );
  }

  const { db, pool } = createDatabase();

  // Run database migrations (idempotent — Drizzle tracks applied migrations)
  await migrate(db, { migrationsFolder });

  // Wire the post-commit audit publisher's failure-surface logger
  // (AC-183) BEFORE any mutate() call can dispatch. Bootstrap below
  // calls mutate(), which invokes the publisher; without a logger, a
  // throwing subscriber would be silently swallowed. No subscribers are
  // registered yet — #112 adds them — but the logger must already be
  // wired when the first dispatch happens.
  setAuditPublisherLogger({
    error: (payload) => console.error(payload),
  });

  // Seed data — never in production.
  // SEED=true  → seed only if database is empty (safe default for dev)
  // SEED=force → wipe and re-seed (when seed data structure changes)
  if (env.SEED === 'true' || env.SEED === 'force') {
    if (isProduction) {
      console.warn(
        'WARNING: SEED is set but NODE_ENV=production — skipping seed to protect production data.',
      );
    } else {
      await seed(db, { force: env.SEED === 'force' });
    }
  }

  // First-run admin bootstrap (ADR-0010 / issue #57). Runs AFTER migrate
  // and BEFORE app.listen — see AC-B7. Any thrown error propagates to the
  // start().catch(…) handler below, which exits non-zero.
  await bootstrapAdminIfEmpty(
    db,
    {
      username: env.BOOTSTRAP_ADMIN_USERNAME,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
      displayName: env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
    },
    { warn: (m) => console.warn(m), error: (m) => console.error(m) },
  );

  // Verify all project status values in the DB are known to the current
  // configuration. If a state was removed or renamed without migrating
  // existing projects, those projects become invisible and untransitionable.
  // Refuse to start rather than silently hiding data.
  await validateWorkflowStates(db);

  // Clean up expired sessions on startup
  const deleted = await deleteExpiredSessions(db);
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} expired sessions.`);
  }

  // Schedule periodic cleanup so long-running deployments don't accumulate
  // expired rows between restarts. Handle is captured for the graceful
  // shutdown hook below.
  const reaper = startSessionReaper({
    db,
    intervalMinutes: env.SESSION_CLEANUP_INTERVAL_MINUTES,
    logger: {
      info: (msg) => console.log(msg),
      error: (err, msg) => console.error(msg, err),
    },
  });

  // Schedule audit-log retention cleanup (AC-184). Default cadence is
  // daily (1440 min) — retention is a cleanup, not a latency-sensitive
  // sweep, and the DELETE rides the `audit_log_created_at_idx` so cost
  // stays flat. Window is the [C] default unless
  // `AUDIT_RETENTION_WINDOW_DAYS` is set.
  const auditRetention = startAuditRetentionScheduler({
    db,
    intervalMinutes: env.AUDIT_RETENTION_INTERVAL_MINUTES,
    windowDays: env.AUDIT_RETENTION_WINDOW_DAYS ?? AUDIT_RETENTION.windowDays,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  // Attachment orphan reaper (AC-213). Sweeps pending rows past the
  // TTL together with their backing storage objects. Default cadence
  // 5 min — tighter than audit retention because a stuck pending row
  // has a correlated storage object that needs cleanup before it
  // accretes.
  const attachmentStorageForReaper = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
  });

  // Boot-time bucket-safety probe (ADR-0022 / docs/ops/object-storage-provisioning.md).
  // Refuses to start on data-corruption-class drift (versioning off,
  // Object Lock not Compliance, lifecycle missing or with disallowed
  // actions, R > L). Runs before reapers so a misconfigured bucket
  // cannot accumulate side-effects.
  await assertStorageBucketSafe(attachmentStorageForReaper);

  const attachmentReaper = startAttachmentOrphanReaperScheduler({
    db,
    storage: attachmentStorageForReaper,
    intervalMinutes: env.ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES ?? 5,
    ttlMinutes:
      env.ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES ?? ATTACHMENT_CONFIG.orphanReaperTtlMinutes,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  // Bulk-download temp-zip reaper (#108). Storage-side ephemera are not
  // tracked in the DB, so this sibling sweeps `bulk-downloads/` by
  // LastModified age. Reuses the orphan-reaper TTL (`[C]` default
  // 15 min) because both values describe "staleness of a short-lived
  // storage artifact" — see `bulk-download-reaper.ts` header for the
  // TTL rationale.
  const bulkDownloadReaper = startBulkDownloadReaperScheduler({
    storage: attachmentStorageForReaper,
    intervalMinutes: env.ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES ?? 5,
    ttlMinutes:
      env.ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES ?? ATTACHMENT_CONFIG.orphanReaperTtlMinutes,
    logger: {
      info: (ctx, event) => console.log(event, ctx),
      error: (ctx, event) => console.error(event, ctx),
    },
  });

  const app = buildApp({ logger: true, db });

  // Storage client for the health probe. Instantiated once at startup and
  // reused across health requests. The existing routes do not use storage
  // yet (walking skeleton), but #48 still wants MinIO liveness surfaced by
  // /api/health so operational outages show up before they cascade.
  const storageClient = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
  });

  // Health-check endpoint (outside auth-guarded routes). Real probe — runs
  // a trivial DB query and a HeadBucket against MinIO. Returns 503 if
  // either check fails, so the Docker healthcheck, smoke-test scripts, and
  // any future load balancer all see the actual state of the app's
  // dependencies instead of a hard-coded `ok`. See #48.
  app.get('/api/health', async (_request, reply) => {
    const health = await probeHealth(pool, storageClient);
    const code = health.status === 'ok' ? 200 : 503;
    return reply.code(code).send(health);
  });

  // Serve the Vite-built frontend from dist/ (production).
  // In dev, Vite's dev server handles the frontend via proxy.
  if (existsSync(distFolder)) {
    await app.register(fastifyStatic, {
      root: distFolder,
      wildcard: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', staticCacheControl(filePath));
      },
    });

    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler((req, reply) => {
      if (!req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply
        .code(404)
        .send({ code: 'NOT_FOUND', message: STRINGS.errors.notFound(STRINGS.entities.resource) });
    });
  } else if (isProduction) {
    throw new Error(
      `dist/ not found at ${distFolder}. Run 'npm run build' before starting in production.`,
    );
  } else {
    app.setNotFoundHandler((_req, reply) => {
      reply
        .code(404)
        .send({ code: 'NOT_FOUND', message: STRINGS.errors.notFound(STRINGS.entities.resource) });
    });
  }

  // Graceful shutdown — registered before listen to avoid a window
  // where SIGTERM during startup causes an unclean exit.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      // Wait for any in-flight sweep so pool.end() isn't called under its feet.
      await Promise.all([
        reaper.stop(),
        auditRetention.stop(),
        attachmentReaper.stop(),
        bulkDownloadReaper.stop(),
      ]);
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }

  await app.listen({ port: env.PORT, host: HOST });
}

start().catch((err) => {
  console.error('Failed to start server:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
