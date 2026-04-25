/**
 * Eruda mobile DevTools loader. Mounts a touch-friendly Console / Elements /
 * Network panel on the page so the phone-only bugs (layout collapse, touch
 * handlers, viewport quirks) are debuggable without a USB cable.
 *
 * Activation: `?debug=1` enables and persists in localStorage; `?debug=0`
 * disables and clears. Persistence matches the mobile workflow — type the
 * param once on the on-screen keyboard, then navigate freely. The URL
 * param is consumed via `history.replaceState` so a shared link never
 * carries the flag to another user.
 *
 * The import is dynamic so the ~100 KB Eruda chunk is fetched only when
 * activated; production users never download it. The promise is not
 * awaited — React boots in parallel and Eruda attaches as soon as it
 * loads. Messages emitted before attach are not captured; refresh after
 * activation if early-boot logs matter.
 */
export function initDebugConsole(): void {
  const url = new URL(window.location.href);
  const flag = url.searchParams.get('debug');
  if (flag !== null) {
    try {
      if (flag === '1') localStorage.setItem('debug', '1');
      else localStorage.removeItem('debug');
    } catch {
      // localStorage blocked (private mode / cookie restrictions) — the
      // URL value is still authoritative for this load.
    }
    url.searchParams.delete('debug');
    window.history.replaceState(null, '', url.toString());
  }
  let enabled = flag === '1';
  if (!enabled) {
    try {
      enabled = localStorage.getItem('debug') === '1';
    } catch {
      enabled = false;
    }
  }
  if (enabled) {
    void import('eruda').then(({ default: eruda }) => eruda.init());
  }
}
