/**
 * Page-side helper for the Service-Worker synthetic-URL streaming
 * download bridge (`src/sw/streamingDownload.ts`).
 *
 * The caller passes a `ReadableStream<Uint8Array>` (e.g. the body of a
 * streaming zip archive) and a download filename; the helper hands the
 * stream to the SW under a one-shot key, then triggers a download via a
 * synthetic anchor. Returns when the anchor click has been dispatched —
 * the actual save-to-disk happens asynchronously in the browser's
 * download flow and may continue after this function returns.
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

/**
 * Trigger a streaming download via the controlling Service Worker.
 *
 * Throws if no SW is controlling the page — either the SW hasn't
 * registered yet, the page is in a tab the SW doesn't control, or the
 * runtime doesn't support transferable streams.
 */
export async function streamingDownload(input: StreamingDownloadInput): Promise<void> {
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

  // Transfer the stream to the SW. The transferable list `[stream]`
  // makes this a true transfer, not a clone — the page loses its
  // handle to `stream` after this call. Throws on unsupported runtimes
  // (older Chromium, etc.).
  controller.postMessage(
    {
      type: 'register-streaming-download',
      key,
      filename,
      contentType,
      stream,
    },
    [stream as unknown as Transferable],
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
}

/**
 * Best-effort cleanup if the caller decides not to trigger the
 * download after registering the stream (e.g. user cancelled between
 * `register` and the anchor click — though `streamingDownload` does
 * both in one synchronous burst, this hook is reserved for callers
 * that split the two).
 */
export function unregisterStreamingDownload(key: string): void {
  navigator.serviceWorker?.controller?.postMessage({
    type: 'unregister-streaming-download',
    key,
  });
}
