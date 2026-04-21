/**
 * Push client — encapsulates browser-side push subscription plumbing.
 *
 * Responsibilities (spec ui/behavior.md §9.8, ui/index.md §8.7.2):
 *   - Feature detection (`serviceWorker` + `PushManager`).
 *   - Lazy service-worker registration on a user-initiated action. The
 *     worker is NEVER registered on app boot — spec §9.8 forbids it.
 *   - `Notification.requestPermission()` is called ONLY from inside a
 *     user-click handler (spec §9.8 "Auto-request on page load is
 *     forbidden"). This module exposes primitives; the caller is
 *     responsible for invoking them from a user-activation handler.
 *   - Subscribe / unsubscribe against the browser's push manager and
 *     forward the result to the self-scope server endpoints
 *     (api.md §14.2.10).
 *
 * VAPID public-key source: primary is `GET /api/push/vapid-public-key`
 * (api.md §14.2.10) at subscribe time — runtime fetch so the operator
 * only maintains `VAPID_PUBLIC_KEY` server-side. `VITE_VAPID_PUBLIC_KEY`
 * survives as an offline-dev fallback when the endpoint is unreachable
 * (e.g. `npm run dev:client` without the server). A missing or empty
 * key from both sources surfaces as the `notConfigured` branch in the
 * UI.
 */

import { pushApi } from '@/api/client';

const SERVICE_WORKER_PATH = '/sw.js';

/**
 * True when the runtime supports Web Push. Controls whether the opt-in
 * affordance is rendered at all (spec §9.8: iOS and feature-poor
 * browsers fall under the "unsupported" branch).
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Read the VAPID public key from the client-build env. Retained as a
 * fallback when the runtime endpoint (`GET /api/push/vapid-public-key`)
 * is unreachable — e.g. `npm run dev:client` without the server. The
 * endpoint is primary; operators only set this var for offline-dev
 * workflows.
 */
export function getVapidPublicKeyFromBuildEnv(): string | null {
  const raw = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

/**
 * Runtime VAPID public-key resolution. Primary source is the server
 * endpoint (single source of truth — the operator sets `VAPID_PUBLIC_
 * KEY` once, server-side). Fallback is the build-time Vite env so an
 * offline-dev workflow without the backend still renders a functional
 * opt-in affordance. Returns `null` when neither source yields a key,
 * triggering the `notConfigured` UI branch.
 *
 * Not cached in-module — the browser's HTTP cache (5-minute max-age
 * set by the endpoint) is the cache layer. Re-fetching per
 * subscribe-attempt keeps the key fresh across deploys without
 * needing an explicit invalidation path.
 */
export async function resolveVapidPublicKey(): Promise<string | null> {
  try {
    const response = await fetch('/api/push/vapid-public-key', {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (response.ok) {
      const body = (await response.json()) as { vapidPublicKey?: unknown };
      if (typeof body.vapidPublicKey === 'string' && body.vapidPublicKey.length > 0) {
        return body.vapidPublicKey;
      }
      // Endpoint says null → server is explicit that push is not
      // configured. Do NOT fall back to the build env in this case;
      // that would invite split-brain (client subscribed to a key the
      // server does not hold, every push silently dropped).
      if (body.vapidPublicKey === null) {
        return null;
      }
    }
  } catch {
    // Network / CORS / parse failure — fall through to the build-env
    // fallback so offline-dev workflows still work.
  }
  return getVapidPublicKeyFromBuildEnv();
}

/**
 * Decode a URL-safe base64 VAPID public key into a fresh `ArrayBuffer`.
 * `pushManager.subscribe` types `applicationServerKey` as `BufferSource`
 * over a plain `ArrayBuffer`, so returning a `Uint8Array` backed by
 * `ArrayBufferLike` (which can include `SharedArrayBuffer`) is rejected
 * under strict TS. Building the buffer directly avoids the
 * ArrayBufferLike → ArrayBuffer narrowing issue.
 */
function urlBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Encode an `ArrayBuffer` returned by the browser push API to the URL-
 * safe base64 string the server-side push library (and data-model.md
 * §5.12) expects.
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; ++i) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Register the service worker if it is not already registered, and
 * return the `ServiceWorkerRegistration` handle. No-op on re-entry:
 * `navigator.serviceWorker.register()` is idempotent by spec — a second
 * call with the same script URL resolves to the existing registration.
 *
 * MUST be called from a user-click handler (spec §9.8).
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  // Wait for the worker to be ready so a subsequent `pushManager.subscribe`
  // call always sees an active service worker.
  return navigator.serviceWorker.ready.then(() => registration);
}

/**
 * Read the current push subscription for this browser, if any. Returns
 * `null` when the worker has not yet been registered OR when no
 * subscription is active. Used by the UI to decide whether to render
 * the opt-in affordance or the unsubscribe affordance.
 */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export interface PushSubscribeOutcome {
  ok: boolean;
  /** Machine-readable code for the UI to branch on. */
  reason?:
    | 'unsupported'
    | 'not-configured'
    | 'permission-denied'
    | 'permission-dismissed'
    | 'server-error';
  /** German-language error message when `ok === false`. */
  message?: string;
}

/**
 * Full opt-in flow: request permission, register the service worker,
 * subscribe to the browser's push manager, forward the subscription to
 * the server. MUST be invoked from a user-click handler — spec §9.8.
 *
 * Ordering note: we call `Notification.requestPermission()` BEFORE
 * validating the VAPID key. The spec (§9.8, AC-201) is that the
 * permission prompt fires only inside a user-click handler — i.e. the
 * user action is a prerequisite for the prompt. Skipping the prompt
 * because the server is not yet configured would silently swallow the
 * user's intent and hide the real failure. The user still sees the
 * browser's permission UI exactly once per click, regardless of whether
 * the round-trip to the server ultimately succeeds.
 */
export async function subscribeToPush(): Promise<PushSubscribeOutcome> {
  if (!isPushSupported()) {
    return { ok: false, reason: 'unsupported' };
  }

  // User-initiated permission request (spec §9.8). A browser that
  // already has `permission === 'denied'` returns that value without a
  // prompt; the caller is expected to hide the affordance in that case,
  // but we still branch defensively.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    return { ok: false, reason: 'permission-denied' };
  }
  if (permission !== 'granted') {
    // 'default' — user dismissed the prompt without a decision.
    return { ok: false, reason: 'permission-dismissed' };
  }

  const vapid = await resolveVapidPublicKey();
  if (!vapid) {
    return { ok: false, reason: 'not-configured' };
  }

  const registration = await ensureServiceWorker();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(vapid),
  });

  const p256dhBuffer = subscription.getKey('p256dh');
  const authBuffer = subscription.getKey('auth');
  if (!p256dhBuffer || !authBuffer) {
    // Browser returned a subscription without key material — we cannot
    // forward anything meaningful to the server. Roll back.
    await subscription.unsubscribe().catch(() => undefined);
    return { ok: false, reason: 'server-error' };
  }

  const result = await pushApi.subscribe({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: arrayBufferToBase64Url(p256dhBuffer),
      auth: arrayBufferToBase64Url(authBuffer),
    },
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  });

  if (!result.ok) {
    // Server rejected the subscription (e.g., VALIDATION_ERROR). Roll
    // back the browser-side subscription so the UI stays consistent —
    // leaving an orphan browser subscription without a server row would
    // permanently hide the opt-in affordance on this device.
    await subscription.unsubscribe().catch(() => undefined);
    return { ok: false, reason: 'server-error', message: result.error.message };
  }

  return { ok: true };
}

/**
 * Tear down the local subscription for this device and notify the
 * server. Keeps the service worker registered (the user may opt in
 * again) — spec ui/index.md §8.7.2 "Gerät abmelden" scope.
 *
 * Throws on server error so the caller (PushSubscriptionControls
 * handleUnsubscribe) can catch and show the AC-205 error notification.
 * The browser-side subscription is revoked first so the browser stops
 * forwarding pushes even if the server call fails; the server row is
 * reconciled on the next successful unsubscribe or via dispatch-time
 * pruning (api.md §14.2.10 idempotent DELETE).
 */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  // Revoke locally first.
  await subscription.unsubscribe().catch(() => undefined);
  const result = await pushApi.unsubscribeByEndpoint(endpoint);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}
