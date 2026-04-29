import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyBranding } from './styles/applyBranding';
import { startThemeRuntime } from './styles/themeRuntime';
import { initDebugConsole } from './initDebugConsole';
import './index.css';

// Order matters: applyBranding populates --brand-accent-* so the theme
// cascade resolves accent tokens correctly on the same frame. Both run
// before React mount, so in practice the ordering is a same-frame nuance.
applyBranding();
startThemeRuntime();
initDebugConsole();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
