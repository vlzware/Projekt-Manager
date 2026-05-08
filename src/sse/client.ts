/**
 * Realtime invalidation event bus over the browser-native `EventSource`.
 *
 * Per ADR-0025 the client opens a single multiplexed SSE connection to
 * `/api/events`; consumers subscribe by event name, not by stream. The
 * payload is an invalidation hint (the server frame's `data` is unused
 * by handlers) — the consumer refetches via the gated read endpoint
 * after the handler fires.
 *
 * Lifecycle posture:
 *   - One EventSource per tab (ADR-0025 connection-model pin). All
 *     handlers, regardless of event name, share the same underlying
 *     connection. Opening a separate EventSource per handler would
 *     multiply server-side connections without any benefit.
 *   - Lazily created on first `onSseEvent` call; closed when the last
 *     subscriber unsubscribes. The next subscribe rebuilds it. This
 *     keeps the connection cost zero when no UI surface is mounted.
 *   - WHATWG `EventSource` reconnects on transport failure at the
 *     implementation-defined reconnection time the spec mandates
 *     (overridable by the server's `retry:` field, not used here);
 *     we do not implement reconnection.
 *   - Same-origin only — cookies ride along automatically. Do not
 *     pass `withCredentials: true` (it is for cross-origin only and
 *     causes a CORS preflight that the server is not configured for).
 */

const SSE_URL = '/api/events';

let source: EventSource | null = null;
const handlersByEvent = new Map<string, Set<() => void>>();
const listenersByEvent = new Map<string, (e: MessageEvent) => void>();

function ensureSource(): EventSource {
  if (source) return source;
  source = new EventSource(SSE_URL);
  // Re-attach DOM listeners to the newly created source for every
  // event name we already track. This handles the
  // close-on-last-unsubscribe → resubscribe sequence within the same
  // page lifetime.
  for (const eventName of handlersByEvent.keys()) {
    attachDomListener(source, eventName);
  }
  return source;
}

function attachDomListener(es: EventSource, eventName: string): void {
  if (listenersByEvent.has(eventName)) return;
  const listener = (): void => {
    const set = handlersByEvent.get(eventName);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h();
      } catch {
        /* a faulty handler must not poison the fan-out */
      }
    }
  };
  es.addEventListener(eventName, listener);
  listenersByEvent.set(eventName, listener);
}

function teardownIfIdle(): void {
  if (handlersByEvent.size > 0) return;
  if (!source) return;
  for (const [name, listener] of listenersByEvent) {
    source.removeEventListener(name, listener);
  }
  listenersByEvent.clear();
  source.close();
  source = null;
}

/**
 * Subscribe to a typed SSE event. The handler is called once per frame
 * the server emits with this event name. Returns an unsubscribe handle;
 * dropping the last handler closes the underlying connection.
 */
export function onSseEvent(name: string, handler: () => void): () => void {
  let set = handlersByEvent.get(name);
  if (!set) {
    set = new Set();
    handlersByEvent.set(name, set);
  }
  set.add(handler);

  const es = ensureSource();
  attachDomListener(es, name);

  return () => {
    const current = handlersByEvent.get(name);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      handlersByEvent.delete(name);
      const listener = listenersByEvent.get(name);
      if (listener && source) {
        source.removeEventListener(name, listener);
      }
      listenersByEvent.delete(name);
    }
    teardownIfIdle();
  };
}
