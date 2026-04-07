/**
 * Domain event bus for the service layer.
 *
 * Services emit typed events after a successful repository call so that
 * cross-cutting concerns (audit logging, email/WhatsApp notifications,
 * webhook fan-out, metrics, ...) can subscribe without polluting business
 * logic.
 *
 * Why a custom typed emitter and not Node's EventEmitter?
 *   - Node's EventEmitter is untyped: subscribers receive `any[]`. We get
 *     full type safety per event, including the payload shape.
 *   - We don't need any of EventEmitter's bells and whistles (once,
 *     prependListener, max-listener warnings, etc.). The minimal API is
 *     easier to reason about and to mock in tests.
 *   - Subscribers are async-aware: handlers may return promises and the
 *     emitter does NOT block on them — fire and forget by design, so a
 *     slow notification subscriber never delays an HTTP response. Errors
 *     in handlers are logged-and-swallowed so a broken subscriber cannot
 *     poison the request that emitted the event.
 *
 * Threading model: subscribers run after the repo write commits but before
 * the service method returns. They run in the same event loop tick (no
 * setImmediate), so subscribers see the new state immediately. The emitter
 * itself is process-local; replicate via an external broker (e.g. NATS)
 * if you ever want cross-process fan-out.
 *
 * Test contract: tests can call `clearAllSubscribers()` in beforeEach to
 * isolate state between cases.
 */

import type { ServiceLogger } from './Logger.js';

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface ProjectTransitionedEvent {
  projectId: string;
  fromStatus: string;
  toStatus: string;
  direction: 'forward' | 'backward';
  actorUserId: string;
  occurredAt: Date;
}

export interface ProjectDatesChangedEvent {
  projectId: string;
  actorUserId: string;
  occurredAt: Date;
  plannedStart: string | null | undefined;
  plannedEnd: string | null | undefined;
}

export interface DomainEventMap {
  'project.transitioned': ProjectTransitionedEvent;
  'project.dates_changed': ProjectDatesChangedEvent;
}

export type DomainEventName = keyof DomainEventMap;

export type Subscriber<E extends DomainEventName> = (
  event: DomainEventMap[E],
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

// The Set is intentionally typed as `Subscriber<DomainEventName>` (not the
// per-event narrow type) because the keyed-object-of-Sets approach defeats
// TypeScript's narrowing under generic E. The public `subscribe` function
// preserves type safety at the API boundary; the internal storage simply
// needs to hold the right callable shapes.
type AnySubscriber = Subscriber<DomainEventName>;
const subscribers: Map<DomainEventName, Set<AnySubscriber>> = new Map();

/**
 * Subscribe to a domain event. Returns an unsubscribe function so callers
 * can detach (essential for hot-reload and tests).
 */
export function subscribe<E extends DomainEventName>(
  event: E,
  handler: Subscriber<E>,
): () => void {
  let set = subscribers.get(event);
  if (!set) {
    set = new Set<AnySubscriber>();
    subscribers.set(event, set);
  }
  set.add(handler as AnySubscriber);
  return () => {
    set!.delete(handler as AnySubscriber);
  };
}

/**
 * Emit an event to all current subscribers. Errors thrown by subscribers are
 * logged via the supplied logger and swallowed — a broken subscriber must not
 * propagate failure to the request that emitted the event.
 *
 * Awaits subscribers in registration order. If any subscriber needs strict
 * fire-and-forget semantics, it should wrap its work in `setImmediate`
 * itself; the emitter does not impose that decision globally.
 */
export async function emit<E extends DomainEventName>(
  event: E,
  payload: DomainEventMap[E],
  log?: ServiceLogger,
): Promise<void> {
  const set = subscribers.get(event);
  if (!set || set.size === 0) return;

  for (const handler of set) {
    try {
      await (handler as Subscriber<E>)(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.info(
        { event, error: message },
        'event_subscriber_failed',
      );
    }
  }
}

/**
 * Test helper: detach every subscriber. Use in `beforeEach` so test state
 * does not leak between cases.
 */
export function clearAllSubscribers(): void {
  subscribers.clear();
}
