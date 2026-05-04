/**
 * Service Worker entry — single bundled artifact at `/sw.js`.
 *
 * Three surfaces in one worker:
 *   - Push + notificationclick (pushHandlers.ts) — Web Push, iter-8.
 *   - Synthetic-origin fetch intercept on `/encrypted-storage/*`
 *     (decryptHandler.ts) — binary attachment e2e, iter-9, ADR-0024
 *     §Service-Worker decryption.
 *   - Synthetic-URL streaming download intercept on
 *     `/streaming-download/*` (streamingDownload.ts) — bridges a
 *     page-side `ReadableStream<Uint8Array>` to a native browser
 *     download, iter-9 export-all (#162). Pattern is the same as
 *     Cryptomator Hub Web / Filen / ProtonDrive — no whole-archive
 *     buffering.
 *
 * Lifecycle: skipWaiting + clients.claim so a freshly-deployed SW
 * controls open tabs without a second reload — same behavior as the
 * iter-8 standalone worker.
 */

/// <reference lib="webworker" />

import { handleEncryptedStorageRequest } from './decryptHandler';
import { handlePush, handleNotificationClick } from './pushHandlers';
import {
  STREAMING_DOWNLOAD_PREFIX,
  handleStreamingDownloadMessage,
  handleStreamingDownloadRequest,
} from './streamingDownload';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/encrypted-storage/')) {
    event.respondWith(handleEncryptedStorageRequest(event.request));
    return;
  }
  if (url.pathname.startsWith(STREAMING_DOWNLOAD_PREFIX)) {
    event.respondWith(handleStreamingDownloadRequest(event.request));
    return;
  }
});

self.addEventListener('message', handleStreamingDownloadMessage);

self.addEventListener('push', handlePush);
self.addEventListener('notificationclick', handleNotificationClick);
