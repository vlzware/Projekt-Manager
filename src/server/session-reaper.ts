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
 * Sustained-failure handling: after three consecutive sweep failures the
 * reaper emits a single `session_reaper_sustained_failure` and then backs
 * off exponentially (skip 2, 4, 8, …, capped at 24 ticks) so a persistent
 * DB outage stops producing log noise every interval. A successful sweep
 * resets the state and emits `session_reaper_recovered`.
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

const SUSTAINED_FAILURE_CEILING = 3;
const MAX_BACKOFF_TICKS = 24;

export function startSessionReaper(opts: StartReaperOptions): SessionReaper {
  const intervalMs = opts.intervalMinutes * 60 * 1000;
  let currentSweep: Promise<void> | null = null;
  const state: SweepState = { consecutiveFailures: 0, ticksToSkip: 0 };

  const handle = setInterval(() => {
    if (currentSweep) return;
    if (state.ticksToSkip > 0) {
      state.ticksToSkip -= 1;
      return;
    }
    currentSweep = sweep(opts, state).finally(() => {
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

interface SweepState {
  consecutiveFailures: number;
  ticksToSkip: number;
}

async function sweep(opts: StartReaperOptions, state: SweepState): Promise<void> {
  try {
    const deleted = await deleteExpiredSessions(opts.db);
    if (state.consecutiveFailures >= SUSTAINED_FAILURE_CEILING) {
      opts.logger.info('session_reaper_recovered');
    }
    state.consecutiveFailures = 0;
    state.ticksToSkip = 0;
    if (deleted > 0) {
      opts.logger.info(`Cleaned up ${deleted} expired sessions.`);
    }
  } catch (err) {
    state.consecutiveFailures += 1;
    opts.logger.error(err, 'session_reaper_sweep_failed');
    if (state.consecutiveFailures === SUSTAINED_FAILURE_CEILING) {
      opts.logger.error(err, 'session_reaper_sustained_failure');
    }
    if (state.consecutiveFailures >= SUSTAINED_FAILURE_CEILING) {
      const exponent = state.consecutiveFailures - SUSTAINED_FAILURE_CEILING + 1;
      state.ticksToSkip = Math.min(2 ** exponent, MAX_BACKOFF_TICKS);
    }
  }
}
