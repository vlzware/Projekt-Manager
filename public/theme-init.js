/*
 * Pre-paint theme restoration — runs before the module graph boots so a
 * returning user with a saved 'dark' preference does not see a flash of
 * the default light scheme.
 *
 * Kept as a standalone 'self'-origin file (not an inline <script>) so the
 * Content Security Policy (src/server/app.ts: scriptSrc 'self') permits
 * it without an 'unsafe-inline' allowance, nonce injection, or hash
 * plumbing. See index.html for the load order.
 *
 * Intentionally import-free and duplicates the resolver in
 * src/styles/themeRuntime.ts so this file can ship as static JS that
 * runs synchronously on the pre-JS frame.
 */
(function () {
  try {
    var raw = window.localStorage.getItem('theme-preference');
    var pref = raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
    var scheme =
      pref === 'light'
        ? 'light'
        : pref === 'dark'
          ? 'dark'
          : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';
    if (scheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts;
    // falling through leaves the default (light) scheme in place.
  }
})();
