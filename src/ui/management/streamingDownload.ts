/**
 * Page-side helper for the Service-Worker synthetic-URL streaming
 * download bridge (`src/sw/streamingDownload.ts`).
 *
 * The caller passes a `ReadableStream<Uint8Array>` (e.g. the body of a
 * streaming zip archive) and a download filename; the helper hands the
 * stream to the SW under a one-shot key, navigates a hidden iframe to
 * the synthetic URL the SW intercepts, and waits for the SW to ACK that
 * it has started serving the response. The returned Promise resolves
 * once the served-ACK arrives (the bridge actually reached the
 * browser's download flow) and rejects if the ACK does not arrive
 * within `STREAMING_DOWNLOAD_ACK_TIMEOUT_MS` — the canonical "the SW
 * was evicted between postMessage and the iframe fetch" failure mode.
 * The `key` is exposed so callers can call
 * `unregisterStreamingDownload(key)` from a cancel path that runs while
 * the helper is still awaiting the ACK.
 *
 * Memory profile: peak is bounded by the SW chunk queue plus whatever
 * the upstream stream's producer holds in flight. No whole-archive
 * Blob materialisation, in contrast to the
 * `URL.createObjectURL(new Blob([...]))` pattern.
 *
 * Browser support: relies on transferable `ReadableStream` (Chrome 87+ /
 * Firefox 113+ / Safari 16.4+) and a controlling Service Worker. If the
 * page is loaded without an active SW (e.g. first-load before
 * registration completes, or a hard reload that bypassed the SW),
 * `streamingDownload` throws a clear error. Caller decides whether to
 * fall back or fail loudly.
 */

import { STREAMING_DOWNLOAD_PREFIX } from './streamingDownloadShared';

export interface StreamingDownloadInput {
  /** Body of the download — consumed lazily by the browser via the SW. */
  stream: ReadableStream<Uint8Array>;
  /** Filename suggested in the `Content-Disposition` header. */
  filename: string;
  /** MIME type of the body. Defaults to `application/octet-stream`. */
  contentType?: string;
}

export interface StreamingDownloadHandle {
  /** Resolves when the SW posts the served-ACK; rejects on timeout / port close. */
  served: Promise<void>;
  /**
   * Registry key the SW uses to look up the entry. Caller passes this
   * to `unregisterStreamingDownload` if the dialog is cancelled before
   * `served` resolves (the SW drops the entry, the page-side `served`
   * rejects via the closed port — no resource leak, no "phantom file
   * was saved" report).
   */
  key: string;
}

/**
 * Maximum time the page waits for the SW's served-ACK after
 * registering the stream and firing the iframe navigation. The iframe
 * GET reaches the SW's fetch handler in milliseconds on a healthy
 * worker; anything longer than ~30s realistically means the SW was
 * evicted between `postMessage` and the iframe nav (the registry entry
 * is gone, the iframe gets a 404 from the activated-but-fresh worker,
 * and the served-ACK never fires). 30s is a generous ceiling — long
 * enough not to false-positive on a slow `serviceWorker.ready` resolve
 * under heavy load, short enough that an evicted worker surfaces as a
 * dialog error in reasonable time. Constant rather than configurable:
 * this is an implementation safety bound, not a customer policy.
 */
export const STREAMING_DOWNLOAD_ACK_TIMEOUT_MS = 30_000;

/**
 * Trigger a streaming download via the controlling Service Worker.
 *
 * Throws if no SW is controlling the page — either the SW hasn't
 * registered yet, the page is in a tab the SW doesn't control, or the
 * runtime doesn't support transferable streams.
 *
 * Returns a handle whose `served` Promise resolves once the SW has
 * confirmed it is serving the iframe fetch. Callers MUST gate any
 * "download succeeded" UI on `served` resolving — until then the bytes
 * may have been enqueued into the transferred stream but never reached
 * the browser's download flow (e.g. SW evicted between postMessage and
 * iframe nav). The `key` field lets callers call
 * `unregisterStreamingDownload` from a cancel path while `served` is
 * still pending.
 */
export async function streamingDownload(
  input: StreamingDownloadInput,
): Promise<StreamingDownloadHandle> {
  const { stream, filename, contentType = 'application/octet-stream' } = input;

  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    throw new Error('streamingDownload: navigator.serviceWorker not available');
  }

  // `controller` is the SW currently in charge of this client. If null,
  // the SW exists in the registration but isn't yet controlling this
  // tab (e.g. first navigation in a fresh SW lifecycle). `ready`
  // resolves once a SW has activated for this scope; we then re-read
  // `controller`. If still null after `ready`, this client genuinely
  // has no controller (hard-reload bypass) and we cannot stream.
  let controller = navigator.serviceWorker.controller;
  if (!controller) {
    await navigator.serviceWorker.ready;
    controller = navigator.serviceWorker.controller;
  }
  if (!controller) {
    throw new Error('streamingDownload: no controlling Service Worker');
  }

  // One-shot key. UUIDs are unguessable enough that an attacker cannot
  // race the legitimate fetch: the entry is deleted on first match,
  // so a guessed key would either find the legitimate stream (already
  // served) or 404 (server cleared it after serve).
  const key =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // MessageChannel for the served-ACK. We keep `port1` here (page side)
  // and transfer `port2` to the SW alongside the stream. The SW posts
  // `{type:'streaming-download-served', key}` on port2 inside its
  // fetch handler; we listen on port1 and resolve `served` on receipt.
  // If the SW closes the port without an ACK (e.g. unregister), `port1`
  // surfaces a `messageerror`-equivalent close — we treat that as a
  // rejection so the dialog doesn't hang.
  const channel = new MessageChannel();
  const port1 = channel.port1;

  let resolveServed!: () => void;
  let rejectServed!: (err: Error) => void;
  const served = new Promise<void>((res, rej) => {
    resolveServed = res;
    rejectServed = rej;
  });

  // Single-fire timeout. Cleared on resolve / reject so the page-side
  // listener doesn't hold a phantom timer past the dialog close.
  const timeoutId = setTimeout(() => {
    port1.close();
    rejectServed(
      new Error(`streamingDownload: SW did not ACK within ${STREAMING_DOWNLOAD_ACK_TIMEOUT_MS} ms`),
    );
  }, STREAMING_DOWNLOAD_ACK_TIMEOUT_MS);

  port1.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { type?: unknown; key?: unknown } | null;
    if (
      data !== null &&
      typeof data === 'object' &&
      data.type === 'streaming-download-served' &&
      data.key === key
    ) {
      clearTimeout(timeoutId);
      port1.close();
      resolveServed();
    }
  };
  // `messageerror` fires when the channel receives a message that
  // can't be deserialised — defensive only; close+reject so the waiter
  // doesn't hang on a malformed payload.
  port1.onmessageerror = () => {
    clearTimeout(timeoutId);
    port1.close();
    rejectServed(new Error('streamingDownload: SW served-ACK channel error'));
  };
  // Some implementations require an explicit `start` to begin
  // delivering messages when using the `onmessage` setter pattern.
  // It's a no-op when `onmessage` already implicitly started the port,
  // so it's safe to call unconditionally.
  port1.start();

  // Transfer the stream and the SW-side port to the SW. The
  // transferable list `[stream, port2]` makes both true transfers, not
  // clones — the page loses its handle to `stream` and to `port2`
  // after this call. Throws on unsupported runtimes (older Chromium,
  // etc.).
  controller.postMessage(
    {
      type: 'register-streaming-download',
      key,
      filename,
      contentType,
      stream,
    },
    [stream as unknown as Transferable, channel.port2],
  );

  // Hidden iframe navigation — NOT an `<a download>` click. The
  // critical difference: `<a download>` triggers the browser's
  // download-capture path BEFORE the network request reaches the SW
  // (the click intent is handled at the chrome layer, not the
  // network layer). An iframe navigation issues a real GET, the SW
  // intercepts via `respondWith`, and the response's
  // `Content-Disposition: attachment; filename="…"` header is what
  // makes the browser save the body as a download. This is the
  // streamsaver / Cryptomator / Filen pattern; the anchor approach
  // does not work for SW-bridged streams.
  //
  // The iframe is appended to the body and removed after a short
  // delay to give the browser time to start the download.
  // `display: none` keeps it visually invisible; the browser still
  // performs the navigation.
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = `${STREAMING_DOWNLOAD_PREFIX}${key}`;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 1000);

  return { served, key };
}

/**
 * Best-effort cleanup if the caller decides to abandon a download
 * after registering the stream — e.g. the user clicks Abbrechen while
 * the page-side helper is still awaiting the SW's served-ACK. The SW
 * drops the registry entry and closes the served-ACK port, which
 * surfaces on the page as the `served` Promise rejecting (cleaned up
 * synchronously on the page-side timeout path too).
 */
export function unregisterStreamingDownload(key: string): void {
  navigator.serviceWorker?.controller?.postMessage({
    type: 'unregister-streaming-download',
    key,
  });
}
