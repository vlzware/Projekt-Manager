/**
 * Service Worker streaming-download bridge — unit tests.
 *
 * The module under test bridges a page-side `ReadableStream<Uint8Array>`
 * to a native browser download via a synthetic-URL fetch intercept
 * (Cryptomator/Filen/ProtonDrive pattern; see module header). Three
 * surfaces are exercised here:
 *
 *   - `handleStreamingDownloadMessage` — `register-streaming-download`
 *     populates the keyed registry (and stores the transferred port);
 *     `unregister-streaming-download` drops the entry and closes the
 *     port so the page-side served-ACK waiter rejects promptly; non-
 *     matching messages are ignored without throw.
 *   - `handleStreamingDownloadRequest` — returns 200 with the
 *     registered stream + Content-Disposition for a known key, drops
 *     the entry from the registry (one-shot), returns 404 for an
 *     unknown key, and 404 again on a re-request of the same key
 *     (entry already consumed).
 *   - Served-ACK handshake — when the page transferred a MessagePort
 *     alongside the stream, the request handler posts
 *     `{type:'streaming-download-served', key}` on it before returning
 *     the Response (so the page-side dialog can gate its summary
 *     transition on confirmed delivery rather than mere stream
 *     enqueue, fixing the evicted-SW silent-success case).
 *
 * vitest + jsdom does not host a real Service Worker lifecycle, so the
 * tests exercise the handler functions in isolation. The
 * `ExtendableMessageEvent` is not standard outside SW global, so the
 * input is shaped to satisfy the function signature without dragging
 * a polyfill in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  STREAMING_DOWNLOAD_PREFIX,
  __resetForTests,
  handleStreamingDownloadMessage,
  handleStreamingDownloadRequest,
} from '@/sw/streamingDownload';

beforeEach(() => {
  __resetForTests();
});

/**
 * Build a one-shot `ReadableStream<Uint8Array>` from a sequence of
 * chunks. Closes after the last chunk; cancellable. Used as the
 * upstream that the SW response wraps.
 */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/**
 * Drain a `ReadableStream<Uint8Array>` into a single Uint8Array. Used
 * to assert byte equality on the response body.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Build a minimal `ExtendableMessageEvent`-shaped object. The real
 * type carries way more fields (waitUntil, source, …) but the handler
 * under test only reads `data` and `ports`. `ports` defaults to an
 * empty array — that's what `event.ports` returns when no ports were
 * transferred. Cast through `unknown` so we don't have to fake a full
 * SW global.
 */
function messageEvent(data: unknown, ports: readonly MessagePort[] = []): ExtendableMessageEvent {
  return { data, ports } as unknown as ExtendableMessageEvent;
}

/**
 * Wait for the next message on a port, with a short safety timeout so
 * a bug doesn't hang the test runner. Resolves with the message data
 * on receipt; rejects on timeout. Closes the port either way so the
 * test doesn't leak open channels between cases.
 */
function nextPortMessage(port: MessagePort, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.close();
      reject(new Error(`nextPortMessage: no message within ${timeoutMs} ms`));
    }, timeoutMs);
    port.onmessage = (ev) => {
      clearTimeout(timer);
      port.close();
      resolve(ev.data);
    };
    port.start();
  });
}

/**
 * Register a stream with a freshly-minted MessageChannel — mirrors
 * what the page-side helper does when transferring `[stream, port2]`.
 * The SW retains `port2`; the test keeps `port1` for ACK assertions
 * (or discards it when the test only cares about request handling,
 * not the served-ACK).
 */
function registerWithPort(args: {
  key: string;
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}): MessagePort {
  const channel = new MessageChannel();
  handleStreamingDownloadMessage(
    messageEvent(
      {
        type: 'register-streaming-download',
        key: args.key,
        filename: args.filename,
        contentType: args.contentType,
        stream: args.stream,
      },
      [channel.port2],
    ),
  );
  return channel.port1;
}

describe('handleStreamingDownloadRequest — happy path', () => {
  it('responds 200 with the registered stream and Content-Disposition for a known key', async () => {
    const key = 'k-001';
    const body = new TextEncoder().encode('hello-streaming-world');
    const port1 = registerWithPort({
      key,
      filename: 'export.zip',
      contentType: 'application/zip',
      stream: streamOf(body),
    });

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    // Content-Disposition: ASCII fallback + RFC 5987 UTF-8 parameter.
    // Both halves should reference the filename.
    expect(res.headers.get('Content-Disposition')).toContain('filename="export.zip"');
    expect(res.headers.get('Content-Disposition')).toContain("filename*=UTF-8''export.zip");
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const drained = await drain(res.body!);
    expect(Array.from(drained)).toEqual(Array.from(body));
    port1.close();
  });

  it('handles UTF-8 filenames per RFC 5987 (umlauts encoded in the filename* parameter)', async () => {
    const key = 'k-utf8';
    const port1 = registerWithPort({
      key,
      filename: 'Vollständiger Export.zip',
      contentType: 'application/zip',
      stream: streamOf(new Uint8Array([1, 2, 3])),
    });

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    const cd = res.headers.get('Content-Disposition')!;
    // ASCII fallback strips non-ASCII to `_`. Real name lives in the
    // RFC 5987 parameter (percent-encoded UTF-8).
    expect(cd).toContain('filename="Vollst_ndiger Export.zip"');
    expect(cd).toContain("filename*=UTF-8''Vollst%C3%A4ndiger%20Export.zip");
    await drain(res.body!);
    port1.close();
  });

  it('strips control bytes, double-quotes, and backslashes from the ASCII fallback', async () => {
    const key = 'k-evil';
    const port1 = registerWithPort({
      key,
      // \x00 control + \x07 BEL + double-quote + backslash — all
      // would break the quoted-string parser if surfaced verbatim.
      filename: 'evil\x00\x07"\\.zip',
      contentType: 'application/zip',
      stream: streamOf(new Uint8Array([0])),
    });

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    const cd = res.headers.get('Content-Disposition')!;
    // The forbidden chars all collapse to `_`.
    expect(cd).toContain('filename="evil____.zip"');
    await drain(res.body!);
    port1.close();
  });
});

describe('handleStreamingDownloadRequest — registry semantics', () => {
  it('returns 404 for an unregistered key', () => {
    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}never-registered`),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('one-shot — a second request for the same key returns 404 (entry consumed on first match)', async () => {
    const key = 'k-once';
    const port1 = registerWithPort({
      key,
      filename: 'one.zip',
      contentType: 'application/zip',
      stream: streamOf(new Uint8Array([1, 2, 3])),
    });

    const first = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(first.status).toBe(200);
    // Drain so the reader's promise settles cleanly before the second
    // request — not strictly necessary for the assertion but matches
    // realistic ordering.
    await drain(first.body!);

    const second = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(second.status).toBe(404);
    port1.close();
  });

  it('unregister-streaming-download drops the entry before any fetch', () => {
    const key = 'k-drop';
    const port1 = registerWithPort({
      key,
      filename: 'gone.zip',
      contentType: 'application/zip',
      stream: streamOf(new Uint8Array([0])),
    });
    handleStreamingDownloadMessage(messageEvent({ type: 'unregister-streaming-download', key }));

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(res.status).toBe(404);
    port1.close();
  });
});

describe('handleStreamingDownloadRequest — served-ACK handshake', () => {
  it('posts {type:"streaming-download-served", key} on the registered port before returning the Response', async () => {
    const key = 'k-ack';
    const channel = new MessageChannel();
    handleStreamingDownloadMessage(
      messageEvent(
        {
          type: 'register-streaming-download',
          key,
          filename: 'served.zip',
          contentType: 'application/zip',
          stream: streamOf(new Uint8Array([1, 2, 3])),
        },
        [channel.port2],
      ),
    );

    // Set up the listener BEFORE the request handler fires so the
    // test sees the message synchronously enqueued by the handler.
    const ackPromise = nextPortMessage(channel.port1);

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(res.status).toBe(200);

    const ack = await ackPromise;
    expect(ack).toEqual({ type: 'streaming-download-served', key });

    // Drain so the response stream's reader settles cleanly.
    await drain(res.body!);
  });

  it('does not post on the port for an unknown key (no entry, nothing to ACK)', async () => {
    // No registration on this side — we just pass a port the handler
    // could never see (it lives in the test) to confirm a 404 doesn't
    // somehow synthesise a phantom ACK.
    const channel = new MessageChannel();
    let received: unknown = null;
    channel.port1.onmessage = (ev) => {
      received = ev.data;
    };
    channel.port1.start();

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}never-registered`),
    );
    expect(res.status).toBe(404);

    // Give the microtask + macrotask queues a turn — if a phantom
    // post happened, it would be visible here.
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toBeNull();
    channel.port1.close();
  });

  it('drops a register message that did not transfer a port (protocol violation — no ACK channel, would hang)', () => {
    const key = 'k-no-port';
    expect(() =>
      handleStreamingDownloadMessage(
        messageEvent({
          type: 'register-streaming-download',
          key,
          filename: 'no-port.zip',
          contentType: 'application/zip',
          stream: streamOf(new Uint8Array([7])),
        }),
      ),
    ).not.toThrow();

    // The entry was NOT registered — a fetch returns 404 rather than
    // serving a stream the page can never know was served.
    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(res.status).toBe(404);
  });

  it('unregister closes the registered port so the page-side served-ACK waiter rejects promptly', async () => {
    const key = 'k-cancel';
    const channel = new MessageChannel();
    // Capture port1 close via the matching Promise: when port2 is
    // closed by the SW, port1 stops receiving messages — the most
    // robust signal in the test environment is to assert that no ACK
    // arrives AND the registry entry is gone (so a subsequent fetch
    // returns 404 rather than serving phantom bytes).
    handleStreamingDownloadMessage(
      messageEvent(
        {
          type: 'register-streaming-download',
          key,
          filename: 'cancelled.zip',
          contentType: 'application/zip',
          stream: streamOf(new Uint8Array([0])),
        },
        [channel.port2],
      ),
    );

    let received: unknown = null;
    channel.port1.onmessage = (ev) => {
      received = ev.data;
    };
    channel.port1.start();

    handleStreamingDownloadMessage(messageEvent({ type: 'unregister-streaming-download', key }));

    // No served-ACK should ever land — the handler closed port2
    // without posting, and the entry is gone from the registry.
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toBeNull();

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(res.status).toBe(404);
    channel.port1.close();
  });
});

describe('handleStreamingDownloadMessage — defensive shape validation', () => {
  it('ignores messages with an unknown type without throwing', () => {
    expect(() =>
      handleStreamingDownloadMessage(messageEvent({ type: 'something-else', key: 'k' })),
    ).not.toThrow();
    // Registry should still be empty — no entry was added.
    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}k`),
    );
    expect(res.status).toBe(404);
  });

  it('ignores non-object payloads without throwing', () => {
    expect(() => handleStreamingDownloadMessage(messageEvent(null))).not.toThrow();
    expect(() => handleStreamingDownloadMessage(messageEvent('hello'))).not.toThrow();
    expect(() => handleStreamingDownloadMessage(messageEvent(42))).not.toThrow();
  });

  it('ignores unregister of a never-registered key without throwing', () => {
    expect(() =>
      handleStreamingDownloadMessage(
        messageEvent({ type: 'unregister-streaming-download', key: 'never' }),
      ),
    ).not.toThrow();
  });
});
