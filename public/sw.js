/**
 * Service worker — push + notificationclick only.
 *
 * Scope is deliberately minimal (spec ui/behavior.md §9.8, task brief):
 *   - No fetch/caching strategy, no offline support.
 *   - No periodic sync, no background fetch.
 *   - No analytics, no telemetry, no third-party network calls.
 *
 * The worker only exists to make Web Push work — everything else is
 * out of scope for iteration 8 and would need its own ADR.
 */

// Activate immediately on first install so the user does not need a
// second page reload before push registration works.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Parse a push payload into `{ title, body, url }`. The server sends
 * JSON; if a push lands with no body or an unparseable body, fall back
 * to a generic notification so the user still sees *something*.
 */
function parsePayload(event) {
  const fallback = { title: 'Projekt-Manager', body: '', url: '/' };
  if (!event.data) return fallback;
  try {
    const data = event.data.json();
    return {
      title: typeof data.title === 'string' && data.title.length > 0 ? data.title : fallback.title,
      body: typeof data.body === 'string' ? data.body : fallback.body,
      url: typeof data.url === 'string' && data.url.length > 0 ? data.url : fallback.url,
    };
  } catch {
    const text = event.data.text();
    return { ...fallback, body: typeof text === 'string' ? text : '' };
  }
}

self.addEventListener('push', (event) => {
  const { title, body, url } = parsePayload(event);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Find a tab already showing the target path. If one exists, focus
      // it — do not redirect other open tabs. If none exists, open a new
      // window pointing at the target URL.
      const targetPath = new URL(targetUrl, self.location.origin).pathname;
      const match = allClients.find((c) => new URL(c.url).pathname === targetPath);
      if (match) {
        return match.focus();
      }
      return self.clients.openWindow(targetUrl);
    })(),
  );
});
