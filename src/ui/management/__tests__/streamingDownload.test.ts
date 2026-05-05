/**
 * Page-side streaming-download helper — unit tests.
 *
 * The module under test (`src/ui/management/streamingDownload.ts`) is
 * the page side of the SW streaming-download bridge. The SW side is
 * exercised in `src/sw/__tests__/streamingDownload.test.ts`; this file
 * pins the page-side handshake contract:
 *
 *   - `streamingDownload({stream, filename, contentType})` returns a
 *     handle whose `served` Promise resolves once the SW has posted
 *     `{type:'streaming-download-served', key}` on the transferred
 *     MessagePort. This is what gates the dialog's "summary"
 *     transition — without confirmed delivery the dialog must NOT
 *     report success (an evicted SW between postMessage and iframe
 *     fetch would leave the user with no file).
 *   - `served` rejects on `{type:'streaming-download-aborted', key}`
 *     (cancel beat the iframe fetch — the SW posts this before
 *     closing the port because port closure alone fires no event on
 *     the page side per WHATWG) or after
 *     `STREAMING_DOWNLOAD_ACK_TIMEOUT_MS` (the SW-eviction backstop,
 *     the only failure the protocol cannot signal in-band).
 *   - `unregisterStreamingDownload(key)` posts an unregister message
 *     to the controller; the SW's handler posts the abort message on
 *     the registered port, closes it, and drops the registry entry
 *     (the SW-side test pins the cleanup half).
 *
 * Test scaffolding: jsdom does not provide a real
 * `navigator.serviceWorker`. We stub `navigator.serviceWorker` with a
 * fake `controller` that captures `postMessage` calls and reads back
 * the transferred MessagePort, so the test can drive the served-ACK
 * (or deliberately not drive it, to assert the timeout path) end-to-
 * end through the helper's Promise plumbing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STREAMING_DOWNLOAD_ACK_TIMEOUT_MS,
  streamingDownload,
  unregisterStreamingDownload,
} from '../streamingDownload';

interface CapturedMessage {
  data: unknown;
  ports: MessagePort[];
}

interface FakeController {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
  captured: CapturedMessage[];
}

/**
 * Install a fake `navigator.serviceWorker` whose `controller`
 * captures every `postMessage` and the transferred port (if any). The
 * helper transfers `[stream, port2]`; the test reaches in for `port2`,
 * posts the served-ACK on it, and observes the helper's Promise
 * resolution.
 */
function installFakeController(): FakeController {
  const captured: CapturedMessage[] = [];
  const controller = {
    postMessage: (data: unknown, transfer?: Transferable[]) => {
      const ports: MessagePort[] = (transfer ?? []).filter(
        (t): t is MessagePort => t instanceof MessagePort,
      );
      captured.push({ data, ports });
    },
  };
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller,
      ready: Promise.resolve({}),
    },
  });
  return { postMessage: controller.postMessage, captured };
}

let originalServiceWorker: PropertyDescriptor | undefined;

beforeEach(() => {
  originalServiceWorker = Object.getOwnPropertyDescriptor(globalThis.navigator, 'serviceWorker');
});

afterEach(() => {
  vi.useRealTimers();
  if (originalServiceWorker) {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', originalServiceWorker);
  } else {
    // jsdom may not define it by default — drop the stub.
    delete (globalThis.navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  }
});

describe('streamingDownload — served-ACK handshake', () => {
  it('returns a handle whose served Promise resolves when the SW posts streaming-download-served', async () => {
    const fake = installFakeController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const handle = await streamingDownload({
      stream,
      filename: 'served.zip',
      contentType: 'application/zip',
    });

    // Helper transferred the SW-side port — pull it out so the test
    // can drive the ACK back to the page.
    expect(fake.captured).toHaveLength(1);
    const [{ ports }] = fake.captured;
    expect(ports).toHaveLength(1);
    const swPort = ports[0]!;

    // Simulate the SW posting the served-ACK.
    swPort.postMessage({ type: 'streaming-download-served', key: handle.key });
    swPort.close();

    await expect(handle.served).resolves.toBeUndefined();
  });

  it('served Promise rejects when the SW never ACKs (timeout)', async () => {
    vi.useFakeTimers();
    installFakeController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const handle = await streamingDownload({
      stream,
      filename: 'evicted.zip',
      contentType: 'application/zip',
    });

    // Attach the assertion BEFORE we advance the timer so the
    // rejection is wired up by the time the timer fires.
    const expectation = expect(handle.served).rejects.toThrow(
      `streamingDownload: SW did not ACK within ${STREAMING_DOWNLOAD_ACK_TIMEOUT_MS} ms`,
    );

    // Skip the registered iframe-removal timer too (also a setTimeout)
    // by running all pending timers.
    await vi.runAllTimersAsync();

    await expectation;
  });

  it('unregisterStreamingDownload posts the unregister message to the controlling SW', async () => {
    const fake = installFakeController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const handle = await streamingDownload({
      stream,
      filename: 'cancelled.zip',
      contentType: 'application/zip',
    });

    unregisterStreamingDownload(handle.key);

    // First message is the register; second is the unregister we just
    // fired. Order matters — the helper must register before the
    // dialog can decide to cancel.
    expect(fake.captured.length).toBeGreaterThanOrEqual(2);
    const last = fake.captured[fake.captured.length - 1]!;
    expect(last.data).toEqual({
      type: 'unregister-streaming-download',
      key: handle.key,
    });
  });

  it('served Promise rejects when the SW posts streaming-download-aborted (cancel-before-serve)', async () => {
    const fake = installFakeController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const handle = await streamingDownload({
      stream,
      filename: 'cancelled.zip',
      contentType: 'application/zip',
    });

    // Pull port2 out of the captured transfer list — that's the SW
    // side of the served-ACK channel. We simulate the SW receiving an
    // unregister request: it posts the abort message on port2 before
    // closing it.
    expect(fake.captured).toHaveLength(1);
    const [{ ports }] = fake.captured;
    expect(ports).toHaveLength(1);
    const swPort = ports[0]!;

    swPort.postMessage({ type: 'streaming-download-aborted', key: handle.key });
    swPort.close();

    // Page-side `served` rejects promptly (well within the 30s
    // timeout) — that's the contract that defeats the SW-cancel hang.
    await expect(handle.served).rejects.toThrow(/aborted before serving/);
  });
});
