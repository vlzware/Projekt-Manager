import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyBranding } from './styles/applyBranding';
import { startThemeRuntime } from './styles/themeRuntime';
import { initDebugConsole } from './initDebugConsole';
import { installAttachmentErrorListener } from './sw/installAttachmentErrorListener';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
