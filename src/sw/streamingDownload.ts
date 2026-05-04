/**
 * Service Worker — synthetic-URL streaming download bridge.
 *
 * Browsers cannot save a `ReadableStream<Uint8Array>` straight from JS to
 * disk: `URL.createObjectURL` only accepts a `Blob` (which buffers the
 * whole archive in memory), and `<a download href=…>` is captured at the
 * browser-chrome layer before the network request reaches the SW so the
 * anchor approach never touches the SW fetch handler. The canonical
 * workaround — used in production by Cryptomator Hub Web, Filen,
 * ProtonDrive, and the (now-unmaintained) `streamsaver.js` library — is
 * to register the stream with the page's Service Worker under a one-shot
 * key, then navigate a hidden iframe to a synthetic URL the SW
 * intercepts. The SW responds with `new Response(stream, …)` and the
 * browser pipes that response straight to disk via its native download
 * flow. Peak memory is bounded by the SW chunk queue plus the in-flight
 * upstream chunk — no whole-zip buffering.
 *
 * Flow:
 *   1. Page generates a UUID `key` and a `MessageChannel`, calls
 *      `navigator.serviceWorker.controller.postMessage(
 *        {type:'register-streaming-download', key, filename, contentType,
 *         stream},
 *        [stream, port2])` — the stream is transferred (not cloned), so
 *      the page loses its handle; `port2` is transferred to the SW so it
 *      can ACK once the iframe fetch arrives.
 *   2. SW stores the entry (stream + port) in `pendingStreams` keyed by
 *      `key`.
 *   3. Page navigates a hidden iframe to `/streaming-download/<key>`.
 *   4. SW intercepts the fetch (registered in `index.ts`), pulls the
 *      entry, deletes it (one-shot), posts
 *      `{type:'streaming-download-served', key}` on the stored port, and
 *      responds with a `Response` built around the transferred stream +
 *      `Content-Disposition` attachment header.
 *   5. Page receives the served-ACK on `port1` and treats the export as
 *      delivered to the browser's download flow. The actual save-to-disk
 *      continues asynchronously in the browser; cancellation in the page
 *      (e.g. user closes the dialog) propagates through the upstream
 *      stream's cancel handler.
 *
 * Lifecycle: the SW is normally kept alive while there are controlled
 * clients (the open tab) AND while there are in-flight `fetch` events.
 * If the SW is evicted between `postMessage` and the iframe fetch, the
 * download fails (404 from the handler — the entry isn't there) and the
 * page-side helper surfaces a timeout because the served-ACK never
 * arrives. The page-side timeout is the only authoritative signal that
 * the bridge actually delivered the bytes — without it the dialog could
 * report success while the user got nothing.
 *
 * Transferable streams: `ReadableStream` is transferable since
 * Chrome 87 / Firefox 113 / Safari 16.4 — universal in modern browsers
 * since 2023. Older browsers fail the `postMessage` call (the page-side
 * helper surfaces this as an explicit error), at which point a graceful
 * fallback is the caller's responsibility (none implemented today —
 * the export-all path requires modern browsers).
 */

/// <reference lib="webworker" />

interface PendingStream {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  contentType: string;
  /**
   * MessagePort the page transferred alongside the stream. The SW posts
   * `{type:'streaming-download-served', key}` on it inside
   * `handleStreamingDownloadRequest` so the page knows the bridge has
   * actually started serving. On unregister the port is closed without
   * an ACK so the page-side waiter rejects rather than hangs out the
   * timeout.
   */
  port: MessagePort;
}

/**
 * One-shot stream registry. Keys are UUIDs minted by the page-side
 * helper; entries are deleted on the first matching fetch (so a single
 * key can never be replayed) and on `unregister` messages (page-side
 * cleanup if the iframe fetch never happens, e.g. the user cancels
 * before the iframe is appended).
 */
const pendingStreams = new Map<string, PendingStream>();

export const STREAMING_DOWNLOAD_PREFIX = '/streaming-download/';

interface RegisterMessage {
  type: 'register-streaming-download';
  key: string;
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

interface UnregisterMessage {
  type: 'unregister-streaming-download';
  key: string;
}

type StreamingDownloadMessage = RegisterMessage | UnregisterMessage;

function isStreamingDownloadMessage(data: unknown): data is StreamingDownloadMessage {
  if (typeof data !== 'object' || data === null) return false;
  const t = (data as { type?: unknown }).type;
  return t === 'register-streaming-download' || t === 'unregister-streaming-download';
}

/**
 * Wire into the SW's `message` event. Idempotent registration, delete-
 * on-cancel. The handler validates message shape defensively — the SW
 * is single-instance and shared with `pushHandlers`, so foreign
 * messages must not throw or cross-contaminate.
 */
export function handleStreamingDownloadMessage(event: ExtendableMessageEvent): void {
  const data = event.data;
  if (!isStreamingDownloadMessage(data)) return;

  if (data.type === 'register-streaming-download') {
    // The first transferred port is the served-ACK channel. The
    // page-side helper always transfers exactly one port; a missing
    // port is a protocol violation we drop on the floor (don't crash
    // the SW, but don't register either — without the port the page
    // would hang waiting for an ACK that never comes).
    const port = event.ports[0];
    if (!port) return;
    pendingStreams.set(data.key, {
      stream: data.stream,
      filename: data.filename,
      contentType: data.contentType,
      port,
    });
    return;
  }
  // unregister-streaming-download: best-effort cleanup. If the page
  // already triggered the iframe fetch and the SW served the response,
  // the entry is gone — `delete` on a missing key is a no-op. Otherwise
  // close the port so the page-side served-ACK waiter rejects promptly
  // instead of waiting out the timeout.
  const stale = pendingStreams.get(data.key);
  if (stale) {
    stale.port.close();
    pendingStreams.delete(data.key);
  }
}

/**
 * Build the `Content-Disposition` header per RFC 6266 + RFC 5987:
 * ASCII-only `filename="…"` fallback for legacy parsers, plus the
 * percent-encoded UTF-8 `filename*=UTF-8''…` parameter for modern
 * browsers. Mirrors the server's `buildContentDisposition` in
 * `src/server/storage/client.ts` — kept inline rather than imported
 * because the SW bundle does NOT include server modules.
 */
function buildContentDisposition(fileName: string): string {
  // Strip control bytes, double quotes, and backslashes from the ASCII
  // fallback (they would break the quoted-string parser). Non-ASCII is
  // replaced with `_` in the fallback; the UTF-8 parameter carries the
  // real name.
  // eslint-disable-next-line no-control-regex
  const asciiFallback = fileName.replace(/[\x00-\x1F\x7F"\\]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  const utf8Encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Match-and-respond for `/streaming-download/<key>` requests. Returns
 * a `Response` from the registered upstream stream, or a 404 if the
 * key was never registered or has already been served. The entry is
 * deleted on every match (one-shot), so a re-fetch of the same URL
 * (e.g. user-initiated reload of the download tab) returns 404 rather
 * than re-streaming or hanging.
 *
 * Posts `{type:'streaming-download-served', key}` on the registered
 * served-ACK port BEFORE returning the Response. Posting before the
 * return makes the page-side waiter resolve as soon as the SW has
 * committed to serving — even if the upstream stream errors mid-body
 * later, the bridge itself reached the user's browser, which is what
 * the dialog needs to know to promote to "summary".
 *
 * Cache-Control is set to `no-store` so neither the browser HTTP cache
 * nor any intermediary stores the synthetic response. Same posture as
 * other pages serving sensitive cleartext.
 */
export function handleStreamingDownloadRequest(request: Request): Response {
  const url = new URL(request.url);
  const key = url.pathname.slice(STREAMING_DOWNLOAD_PREFIX.length);
  const entry = pendingStreams.get(key);
  if (!entry) {
    return new Response('streaming-download key not registered', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  pendingStreams.delete(key);

  // Notify the page that the bridge is serving. Closing the port
  // afterwards releases both endpoints so neither side leaks a live
  // MessagePort once the download starts.
  entry.port.postMessage({ type: 'streaming-download-served', key });
  entry.port.close();

  return new Response(entry.stream, {
    status: 200,
    headers: {
      'Content-Type': entry.contentType,
      'Content-Disposition': buildContentDisposition(entry.filename),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Test-only: clear the registry between tests. Not exported in the
 * production bundle's public API — only the `__tests__` paths import it.
 */
export function __resetForTests(): void {
  pendingStreams.clear();
}
