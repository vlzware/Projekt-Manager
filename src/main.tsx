import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyBranding } from './styles/applyBranding';
import { startThemeRuntime } from './styles/themeRuntime';
import { initDebugConsole } from './initDebugConsole';
import { installAttachmentErrorListener } from './sw/installAttachmentErrorListener';
import { subscribeProjectStoresToSse } from './state/projectSseSubscription';
import './index.css';

// Order matters: applyBranding populates --brand-accent-* so the theme
// cascade resolves accent tokens correctly on the same frame. Both run
// before React mount, so in practice the ordering is a same-frame nuance.
applyBranding();
startThemeRuntime();
initDebugConsole();
// SW → SPA DOM-mirror bridge for binary attachment failure-mode
// signals (ui/project-detail.md §8.15.7, AC-244). Installs a
// BroadcastChannel listener that writes `data-sw-error-code` on the
// requesting `<img>` / `<iframe>` element when the SW decrypt handler
// emits one of the two pinned codes.
installAttachmentErrorListener();

// Cross-cutting `project_changed` SSE subscription (api.md §14.2.13,
// ADR-0025, AC-277). Page-lifetime subscription — both project stores
// refetch on every frame so any open project surface (kanban,
// calendar, detail, management list) reflects another session's
// mutation without manual reload.
subscribeProjectStoresToSse();

// Eager Service Worker registration. The SW intercepts
// `/encrypted-storage/*` requests (ADR-0024) and must be active
// before the SPA renders any `<img src="/encrypted-storage/...">`.
// Push opt-in surfaces failure on click via `pushClient`; first paint
// must not block on SW readiness, so the promise is fire-and-forget.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
