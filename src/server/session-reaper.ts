/**
 * Periodic session cleanup.
 *
 * A setInterval-driven sweep that delegates to `deleteExpiredSessions`.
 * Extracted so the schedule plumbing can be unit-tested without booting
 * the HTTP server (see __tests__/session-reaper.test.ts).
 *
 * Error handling: the sweep callback must never propagate. A transient
 * DB error would otherwise bubble to Node's unhandled-rejection handler
 * and kill the process, defeating the whole point of a background reaper.
 *
 * Shutdown: `stop()` awaits any in-flight sweep so the pg pool isn't torn
 * down mid-query by the graceful-shutdown sequence in start.ts.
 */

import type { Database } from './db/connection.js';
import { deleteExpiredSessions } from './repositories/session.js';

export interface ReaperLogger {
  info: (msg: string) => void;
  error: (err: unknown, msg: string) => void;
}

export interface StartReaperOptions {
  db: Database;
  intervalMinutes: number;
  logger: ReaperLogger;
}

export interface SessionReaper {
  /** Cancel the interval and await any sweep already in flight. */
  stop: () => Promise<void>;
}

export function startSessionReaper(opts: StartReaperOptions): SessionReaper {
  const intervalMs = opts.intervalMinutes * 60 * 1000;
  let currentSweep: Promise<void> | null = null;

  const handle = setInterval(() => {
    if (currentSweep) return;
    currentSweep = sweep(opts).finally(() => {
      currentSweep = null;
    });
  }, intervalMs);
  // Don't keep the Node event loop alive just for this timer.
  handle.unref();

  return {
    stop: async () => {
      clearInterval(handle);
      if (currentSweep) await currentSweep;
    },
  };
}

async function sweep(opts: StartReaperOptions): Promise<void> {
  try {
    const deleted = await deleteExpiredSessions(opts.db);
    if (deleted > 0) {
      opts.logger.info(`Cleaned up ${deleted} expired sessions.`);
    }
  } catch (err) {
    opts.logger.error(err, 'session_reaper_sweep_failed');
  }
}
