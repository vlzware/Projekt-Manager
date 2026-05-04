/**
 * Service Worker streaming-download bridge — unit tests.
 *
 * The module under test bridges a page-side `ReadableStream<Uint8Array>`
 * to a native browser download via a synthetic-URL fetch intercept
 * (Cryptomator/Filen/ProtonDrive pattern; see module header). Two
 * surfaces are exercised here:
 *
 *   - `handleStreamingDownloadMessage` — `register-streaming-download`
 *     populates the keyed registry; `unregister-streaming-download`
 *     drops the entry; non-matching messages are ignored without throw.
 *   - `handleStreamingDownloadRequest` — returns 200 with the
 *     registered stream + Content-Disposition for a known key, drops
 *     the entry from the registry (one-shot), returns 404 for an
 *     unknown key, and 404 again on a re-request of the same key
 *     (entry already consumed).
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
 * type carries way more fields (waitUntil, source, ports, …) but the
 * handler under test only reads `data`. Cast through `unknown` so we
 * don't have to fake a full SW global.
 */
function messageEvent(data: unknown): ExtendableMessageEvent {
  return { data } as unknown as ExtendableMessageEvent;
}

describe('handleStreamingDownloadRequest — happy path', () => {
  it('responds 200 with the registered stream and Content-Disposition for a known key', async () => {
    const key = 'k-001';
    const body = new TextEncoder().encode('hello-streaming-world');
    handleStreamingDownloadMessage(
      messageEvent({
        type: 'register-streaming-download',
        key,
        filename: 'export.zip',
        contentType: 'application/zip',
        stream: streamOf(body),
      }),
    );

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
  });

  it('handles UTF-8 filenames per RFC 5987 (umlauts encoded in the filename* parameter)', async () => {
    const key = 'k-utf8';
    handleStreamingDownloadMessage(
      messageEvent({
        type: 'register-streaming-download',
        key,
        filename: 'Vollständiger Export.zip',
        contentType: 'application/zip',
        stream: streamOf(new Uint8Array([1, 2, 3])),
      }),
    );

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    const cd = res.headers.get('Content-Disposition')!;
    // ASCII fallback strips non-ASCII to `_`. Real name lives in the
    // RFC 5987 parameter (percent-encoded UTF-8).
    expect(cd).toContain('filename="Vollst_ndiger Export.zip"');
    expect(cd).toContain("filename*=UTF-8''Vollst%C3%A4ndiger%20Export.zip");
  });

  it('strips control bytes, double-quotes, and backslashes from the ASCII fallback', async () => {
    const key = 'k-evil';
    handleStreamingDownloadMessage(
      messageEvent({
        type: 'register-streaming-download',
        key,
        // \x00 control + \x07 BEL + double-quote + backslash — all
        // would break the quoted-string parser if surfaced verbatim.
        filename: 'evil\x00\x07"\\.zip',
        contentType: 'application/zip',
        stream: streamOf(new Uint8Array([0])),
      }),
    );

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    const cd = res.headers.get('Content-Disposition')!;
    // The forbidden chars all collapse to `_`.
    expect(cd).toContain('filename="evil____.zip"');
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
    handleStreamingDownloadMessage(
      messageEvent({
        type: 'register-streaming-download',
        key,
        filename: 'one.zip',
        contentType: 'application/zip',
        stream: streamOf(new Uint8Array([1, 2, 3])),
      }),
    );

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
  });

  it('unregister-streaming-download drops the entry before any fetch', () => {
    const key = 'k-drop';
    handleStreamingDownloadMessage(
      messageEvent({
        type: 'register-streaming-download',
        key,
        filename: 'gone.zip',
        contentType: 'application/zip',
        stream: streamOf(new Uint8Array([0])),
      }),
    );
    handleStreamingDownloadMessage(messageEvent({ type: 'unregister-streaming-download', key }));

    const res = handleStreamingDownloadRequest(
      new Request(`https://app.local${STREAMING_DOWNLOAD_PREFIX}${key}`),
    );
    expect(res.status).toBe(404);
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
