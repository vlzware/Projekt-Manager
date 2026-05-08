/**
 * SSE client (`src/sse/client.ts`) — multiplexed `EventSource` over
 * `/api/events` with typed event subscriptions (ADR-0025). Unit-level
 * contracts:
 *
 *   1. First subscriber lazily opens the source; last unsubscribe
 *      closes it.
 *   2. Multiple subscribers to the same event share one DOM listener;
 *      the listener fans out to each registered handler.
 *   3. A frame arriving on event `X` does not call handlers for event
 *      `Y` (and vice versa).
 *   4. A handler that throws does not poison the fan-out — siblings
 *      registered under the same event still fire.
 *   5. After the underlying source enters CLOSED state (the spec's
 *      terminal state, reached on 401/404/malformed-content-type and
 *      similar unrecoverable responses), the next `onSseEvent()` call
 *      must build a fresh `EventSource` rather than `addEventListener`
 *      on the dead one. Without this guard a mid-stream session
 *      revocation produces a permanently silent client until full
 *      page reload — adjacent to the bootstrap-time 401 the
 *      auth-gated `useEffect` in `App.tsx` prevents.
 *
 * Lives under `src/state/__tests__/` so vitest's `unit` project picks
 * it up alongside the other SSE-aware unit tests
 * (`projectSseSubscription.test.ts`, `storageUsageStore.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = FakeEventSource.OPEN;
  closed = false;
  readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    constructorCallCount += 1;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: the fake records the latest constructed instance so tests can drive its readyState / dispatch path.
    lastEs = this;
  }

  addEventListener(name: string, handler: EventListener): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler);
  }

  removeEventListener(name: string, handler: EventListener): void {
    this.listeners.get(name)?.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Fan a frame out to every listener registered under `name`. */
  dispatch(name: string): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const h of [...set]) h({ type: name } as Event);
  }

  /**
   * Drive the source into the spec's terminal CLOSED state and fire
   * the `error` event the implementation would dispatch alongside it.
   * This is how a 401 mid-stream presents to the client.
   */
  failClosed(): void {
    this.readyState = FakeEventSource.CLOSED;
    const set = this.listeners.get('error');
    if (!set) return;
    for (const h of [...set]) h({ type: 'error' } as Event);
  }
}

let lastEs: FakeEventSource | null = null;
let constructorCallCount = 0;

beforeEach(() => {
  // The shared component-setup stub is intentionally inert (no
  // readyState transitions, no dispatch path); replace it for this
  // file's contract tests so we can drive the failure modes the
  // implementation guards against.
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  lastEs = null;
  constructorCallCount = 0;
  // Reset module state — the client holds module-level singletons
  // (cached source + handler maps).
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadClient(): Promise<typeof import('../../sse/client')> {
  return import('../../sse/client');
}

describe('sse/client — subscription lifecycle', () => {
  it('lazily creates one EventSource on first subscribe and closes it on last unsubscribe', async () => {
    const { onSseEvent } = await loadClient();

    expect(constructorCallCount).toBe(0);

    const off = onSseEvent('project_changed', () => {});
    expect(constructorCallCount).toBe(1);
    expect(lastEs!.closed).toBe(false);

    off();
    expect(lastEs!.closed).toBe(true);
  });

  it('shares one DOM listener across multiple handlers for the same event', async () => {
    const { onSseEvent } = await loadClient();

    const a = vi.fn();
    const b = vi.fn();
    onSseEvent('project_changed', a);
    onSseEvent('project_changed', b);

    // One Set, two members — the client attaches a single DOM listener
    // per event name, then fans out to all registered handlers.
    expect(lastEs!.listeners.get('project_changed')?.size).toBe(1);

    lastEs!.dispatch('project_changed');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not cross-fire handlers between distinct event names', async () => {
    const { onSseEvent } = await loadClient();

    const projectHandler = vi.fn();
    const storageHandler = vi.fn();
    onSseEvent('project_changed', projectHandler);
    onSseEvent('storage_usage_changed', storageHandler);

    lastEs!.dispatch('project_changed');
    expect(projectHandler).toHaveBeenCalledTimes(1);
    expect(storageHandler).not.toHaveBeenCalled();

    lastEs!.dispatch('storage_usage_changed');
    expect(storageHandler).toHaveBeenCalledTimes(1);
    expect(projectHandler).toHaveBeenCalledTimes(1);
  });

  it('a handler throwing does not poison the fan-out', async () => {
    const { onSseEvent } = await loadClient();

    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    onSseEvent('project_changed', a);
    onSseEvent('project_changed', b);

    expect(() => lastEs!.dispatch('project_changed')).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('sse/client — recovery from terminal-CLOSED state', () => {
  it('next subscribe after CLOSED creates a fresh EventSource', async () => {
    const { onSseEvent } = await loadClient();

    const handler1 = vi.fn();
    onSseEvent('project_changed', handler1);
    const firstEs = lastEs;
    expect(constructorCallCount).toBe(1);

    // Simulate the WHATWG terminal-error path: a 401 mid-stream lands
    // here. The implementation fires `error`, transitions readyState
    // to CLOSED, and stops reconnecting.
    firstEs!.failClosed();

    // A second subscribe AFTER the close. With a buggy ensureSource()
    // that returned the CLOSED cached source, the new handler would
    // attach to a dead listener set and never fire — the silent-broken
    // mode the auth-gating fix and this guard exist to prevent.
    const handler2 = vi.fn();
    onSseEvent('storage_usage_changed', handler2);

    expect(constructorCallCount).toBe(2);
    expect(lastEs).not.toBe(firstEs);

    // The fresh source must deliver to BOTH the previously-registered
    // handler (it never explicitly unsubscribed — the failure was
    // opaque to the consumer) and the newly-registered one. The client
    // re-attaches DOM listeners for every still-tracked event name on
    // recreate.
    lastEs!.dispatch('project_changed');
    expect(handler1).toHaveBeenCalledTimes(1);

    lastEs!.dispatch('storage_usage_changed');
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
