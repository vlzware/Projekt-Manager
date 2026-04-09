/**
 * Pure-function tests for the event bus. Runs under the integration project
 * (per vitest.config.ts) even though it doesn't touch the DB — the
 * .unit.test.ts naming was misleading, so the file is now just events.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  subscribe,
  emit,
  clearAllSubscribers,
  type ProjectTransitionedEvent,
} from '../services/events.js';

beforeEach(() => {
  clearAllSubscribers();
});

describe('events — subscribe / emit', () => {
  it('delivers an event to a single subscriber', async () => {
    const handler = vi.fn();
    subscribe('project.transitioned', handler);

    const payload: ProjectTransitionedEvent = {
      projectId: 'p1',
      fromStatus: 'geplant',
      toStatus: 'in_arbeit',
      direction: 'forward',
      actorUserId: 'u1',
      occurredAt: new Date('2026-04-07T12:00:00Z'),
    };
    await emit('project.transitioned', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('delivers to multiple subscribers in registration order', async () => {
    const calls: string[] = [];
    subscribe('project.transitioned', () => {
      calls.push('first');
    });
    subscribe('project.transitioned', () => {
      calls.push('second');
    });

    await emit('project.transitioned', {
      projectId: 'p1',
      fromStatus: 'a',
      toStatus: 'b',
      direction: 'forward',
      actorUserId: 'u1',
      occurredAt: new Date(),
    });

    expect(calls).toEqual(['first', 'second']);
  });

  it('does nothing when there are no subscribers', async () => {
    await expect(
      emit('project.transitioned', {
        projectId: 'p1',
        fromStatus: 'a',
        toStatus: 'b',
        direction: 'forward',
        actorUserId: 'u1',
        occurredAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it('returns an unsubscribe function that detaches the handler', async () => {
    const handler = vi.fn();
    const unsubscribe = subscribe('project.transitioned', handler);

    unsubscribe();

    await emit('project.transitioned', {
      projectId: 'p1',
      fromStatus: 'a',
      toStatus: 'b',
      direction: 'forward',
      actorUserId: 'u1',
      occurredAt: new Date(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates subscribers per event name', async () => {
    const transitionHandler = vi.fn();
    const datesHandler = vi.fn();
    subscribe('project.transitioned', transitionHandler);
    subscribe('project.dates_changed', datesHandler);

    await emit('project.transitioned', {
      projectId: 'p1',
      fromStatus: 'a',
      toStatus: 'b',
      direction: 'forward',
      actorUserId: 'u1',
      occurredAt: new Date(),
    });

    expect(transitionHandler).toHaveBeenCalledTimes(1);
    expect(datesHandler).not.toHaveBeenCalled();
  });

  it('awaits async subscribers before resolving emit', async () => {
    let resolved = false;
    subscribe('project.transitioned', async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });

    await emit('project.transitioned', {
      projectId: 'p1',
      fromStatus: 'a',
      toStatus: 'b',
      direction: 'forward',
      actorUserId: 'u1',
      occurredAt: new Date(),
    });

    expect(resolved).toBe(true);
  });
});

describe('events — error isolation', () => {
  it('does not let a failing subscriber break other subscribers', async () => {
    const good1 = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good2 = vi.fn();

    subscribe('project.transitioned', good1);
    subscribe('project.transitioned', bad);
    subscribe('project.transitioned', good2);

    await expect(
      emit('project.transitioned', {
        projectId: 'p1',
        fromStatus: 'a',
        toStatus: 'b',
        direction: 'forward',
        actorUserId: 'u1',
        occurredAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    expect(good1).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
    expect(good2).toHaveBeenCalled();
  });

  it('logs the error via the supplied logger when a subscriber throws', async () => {
    // Audit-trail loss must surface as error-level, not info-level, so it
    // shows up in alert pipelines instead of disappearing into request noise.
    const logger = { info: vi.fn(), error: vi.fn() };
    subscribe('project.transitioned', () => {
      throw new Error('subscriber-error');
    });

    await emit(
      'project.transitioned',
      {
        projectId: 'p1',
        fromStatus: 'a',
        toStatus: 'b',
        direction: 'forward',
        actorUserId: 'u1',
        occurredAt: new Date(),
      },
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'project.transitioned',
        error: 'subscriber-error',
      }),
      'event_subscriber_failed',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('also catches async (rejected promise) errors from subscribers', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const after = vi.fn();
    subscribe('project.transitioned', async () => {
      await Promise.reject(new Error('async-boom'));
    });
    subscribe('project.transitioned', after);

    await emit(
      'project.transitioned',
      {
        projectId: 'p1',
        fromStatus: 'a',
        toStatus: 'b',
        direction: 'forward',
        actorUserId: 'u1',
        occurredAt: new Date(),
      },
      logger,
    );

    expect(logger.error).toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
  });
});

describe('events — clearAllSubscribers', () => {
  it('removes every subscriber across all event names', async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe('project.transitioned', a);
    subscribe('project.dates_changed', b);

    clearAllSubscribers();

    await emit('project.transitioned', {
      projectId: 'p1',
      fromStatus: 'a',
      toStatus: 'b',
      direction: 'forward',
      actorUserId: 'u1',
      occurredAt: new Date(),
    });
    await emit('project.dates_changed', {
      projectId: 'p1',
      actorUserId: 'u1',
      occurredAt: new Date(),
      plannedStart: '2026-05-01',
      plannedEnd: null,
    });

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});
